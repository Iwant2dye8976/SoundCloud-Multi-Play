'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = 3847;
const MAX_WS_PAYLOAD = 1024 * 1024; // 1 MiB safety limit

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function isPrivateLanIpv4(addr) {
  if (!addr) return false;
  if (addr.startsWith('192.168.') || addr.startsWith('10.')) return true;
  if (addr.startsWith('172.')) {
    const second = Number(addr.split('.')[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

function getLanIpAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const info of addrs) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      const isVirtual = /vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker|Loopback/i.test(name);
      candidates.push({
        address: info.address,
        score: (isPrivateLanIpv4(info.address) ? 10 : 1) - (isVirtual ? 5 : 0)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || '127.0.0.1';
}

function isLoopbackAddress(remoteAddress) {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

function generatePin() {
  return String(crypto.randomInt(100000, 1000000));
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function encodeWsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, data]);
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buffer.length) break;
      const bigLen = buffer.readBigUInt64BE(cursor);
      if (bigLen > BigInt(MAX_WS_PAYLOAD)) {
        throw new Error('WebSocket payload exceeds limit');
      }
      payloadLen = Number(bigLen);
      cursor += 8;
    }

    if (payloadLen > MAX_WS_PAYLOAD) {
      throw new Error('WebSocket payload exceeds limit');
    }

    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + payloadLen > buffer.length) break;

    let payload = buffer.subarray(cursor + maskLen, cursor + maskLen + payloadLen);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    frames.push({ fin, opcode, payload });
    offset = cursor + maskLen + payloadLen;
  }

  return {
    frames,
    remaining: buffer.subarray(offset)
  };
}

function createWsClient(socket, onMessage, onClose) {
  let recvBuffer = Buffer.alloc(0);
  let textChunks = [];
  let closed = false;

  const client = {
    sendJson(obj) {
      if (closed || socket.destroyed) return;
      try {
        socket.write(encodeWsFrame(JSON.stringify(obj), 0x1));
      } catch {
        // Ignore write errors on closing sockets
      }
    },
    ping() {
      if (closed || socket.destroyed) return;
      try {
        socket.write(encodeWsFrame(Buffer.alloc(0), 0x9));
      } catch {
        // Ignore
      }
    },
    close(code = 1000) {
      if (closed) return;
      closed = true;
      try {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(code, 0);
        socket.write(encodeWsFrame(buf, 0x8));
      } catch {
        // Ignore
      }
      socket.end();
      onClose();
    }
  };

  socket.on('data', (chunk) => {
    recvBuffer = Buffer.concat([recvBuffer, chunk]);
    let parsed;
    try {
      parsed = parseWsFrames(recvBuffer);
    } catch {
      client.close(1009);
      return;
    }
    recvBuffer = parsed.remaining;

    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        client.close(1000);
        return;
      }
      if (frame.opcode === 0x9) {
        if (!closed && !socket.destroyed) {
          socket.write(encodeWsFrame(frame.payload, 0xa));
        }
        continue;
      }
      if (frame.opcode === 0xa) {
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        textChunks.push(frame.payload);
        if (frame.fin) {
          const text = Buffer.concat(textChunks).toString('utf8');
          textChunks = [];
          try {
            const msg = JSON.parse(text);
            onMessage(msg);
          } catch {
            // Ignore malformed JSON messages
          }
        }
      }
    }
  });

  socket.on('close', () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  });

  socket.on('error', () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  });

  return client;
}

function rejectUpgrade(socket, statusCode, message) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
  } catch {
    // Ignore
  }
  socket.destroy();
}

function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return false;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n')
  );
  return true;
}

function createLanServer(options = {}) {
  const host = options.host || '0.0.0.0';
  const envPort = process.env.PORT !== undefined && process.env.PORT !== ''
    ? Number(process.env.PORT)
    : DEFAULT_PORT;
  const port = options.port ?? (Number.isFinite(envPort) ? envPort : DEFAULT_PORT);
  const pin = String(options.pin || process.env.SC_LAN_PIN || generatePin());
  const publicDir = options.publicDir || PUBLIC_DIR;
  const lanIp = options.lanIp || getLanIpAddress();

  let extClient = null;
  let lastStateUpdate = null;
  const mobileClients = new Set();

  function getServerInfo() {
    const addr = server.address();
    const activePort = typeof addr === 'object' && addr ? addr.port : port;
    return {
      lanIp,
      port: activePort,
      pin,
      url: `http://${lanIp}:${activePort}/?pin=${pin}`,
      shortUrl: `http://${lanIp}:${activePort}`,
      extConnected: Boolean(extClient),
      mobileCount: mobileClients.size
    };
  }

  function broadcastToMobile(msg) {
    for (const client of mobileClients) {
      client.sendJson(msg);
    }
  }

  function notifyExtMobileCount() {
    if (extClient) {
      extClient.sendJson({
        type: 'MOBILE_COUNT',
        mobileCount: mobileClients.size
      });
    }
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://localhost');

    if (reqUrl.pathname === '/api/info') {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Localhost only' }));
        return;
      }
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      };
      const origin = String(req.headers.origin || '');
      if (origin.startsWith('chrome-extension://')) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(getServerInfo()));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    const relPath = reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname.replace(/^\/+/, '');
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(publicDir, safePath);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    });
  });

  server.on('upgrade', (req, socket) => {
    const reqUrl = new URL(req.url || '/', 'http://localhost');

    if (reqUrl.pathname === '/ext') {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      if (!acceptUpgrade(req, socket)) return;

      if (extClient) {
        const old = extClient;
        extClient = null;
        old.close(1000);
      }

      const client = createWsClient(
        socket,
        (msg) => {
          if (msg?.type === 'STATE_UPDATE') {
            lastStateUpdate = msg;
            broadcastToMobile(msg);
          } else if (msg?.type === 'PING') {
            client.sendJson({ type: 'PONG' });
          }
        },
        () => {
          if (extClient === client) {
            extClient = null;
            broadcastToMobile({ type: 'EXT_STATUS', connected: false });
          }
        }
      );

      extClient = client;
      client.sendJson({ type: 'SERVER_INFO', ...getServerInfo() });
      broadcastToMobile({ type: 'EXT_STATUS', connected: true });
      if (mobileClients.size > 0) {
        client.sendJson({ type: 'GET_STATE' });
      }
      return;
    }

    if (reqUrl.pathname === '/mobile') {
      const providedPin = reqUrl.searchParams.get('pin') || '';
      if (!timingSafeEqualStr(providedPin, pin)) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      if (!acceptUpgrade(req, socket)) return;

      const client = createWsClient(
        socket,
        (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'PING') {
            client.sendJson({ type: 'PONG' });
            return;
          }
          if (
            msg.type === 'PLAYER_COMMAND' ||
            msg.type === 'SELECT_TAB' ||
            msg.type === 'PLAY_URL' ||
            msg.type === 'RESUME_LAST_PLAYED' ||
            msg.type === 'CLEAR_LAST_PLAYED' ||
            msg.type === 'GET_STATE'
          ) {
            if (extClient) {
              extClient.sendJson(msg);
            } else {
              client.sendJson({ type: 'EXT_STATUS', connected: false });
            }
          }
        },
        () => {
          mobileClients.delete(client);
          notifyExtMobileCount();
        }
      );

      mobileClients.add(client);
      notifyExtMobileCount();
      client.sendJson({ type: 'EXT_STATUS', connected: Boolean(extClient) });
      if (lastStateUpdate) {
        client.sendJson(lastStateUpdate);
      }
      if (extClient) {
        extClient.sendJson({ type: 'GET_STATE' });
      }
      return;
    }

    rejectUpgrade(socket, 404, 'Not Found');
  });

  const pingTimer = setInterval(() => {
    if (extClient) extClient.ping();
    for (const m of mobileClients) m.ping();
  }, 20000);
  pingTimer.unref();

  const origClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(pingTimer);
    if (extClient) extClient.close(1001);
    for (const m of [...mobileClients]) m.close(1001);
    return origClose(cb);
  };

  return {
    server,
    host,
    port,
    pin,
    lanIp,
    getServerInfo,
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(getServerInfo()));
      });
    }
  };
}

function writeNativeMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function attachNativeStdin(onDisconnect) {
  let stdinBuf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    stdinBuf = Buffer.concat([stdinBuf, chunk]);
    while (stdinBuf.length >= 4) {
      const msgLen = stdinBuf.readUInt32LE(0);
      if (msgLen > MAX_WS_PAYLOAD) {
        onDisconnect();
        return;
      }
      if (stdinBuf.length < 4 + msgLen) break;
      const raw = stdinBuf.subarray(4, 4 + msgLen).toString('utf8');
      stdinBuf = stdinBuf.subarray(4 + msgLen);
      try {
        const msg = JSON.parse(raw);
        if (msg?.type === 'SHUTDOWN') {
          onDisconnect();
          return;
        }
      } catch {
        // Ignore malformed native input
      }
    }
  });
  process.stdin.on('end', onDisconnect);
  process.stdin.on('close', onDisconnect);
  process.stdin.resume();
}

if (require.main === module) {
  const isNativeMode = process.argv.includes('--native');
  const instance = createLanServer();

  if (isNativeMode) {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      instance.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    };

    let addrRetries = 0;
    attachNativeStdin(shutdown);
    instance.server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        if (addrRetries < 6) {
          addrRetries += 1;
          setTimeout(() => {
            if (!shuttingDown) {
              instance.start().then((info) => {
                writeNativeMessage({ type: 'NATIVE_READY', alreadyRunning: false, ...info });
              });
            }
          }, 250);
          return;
        }
        writeNativeMessage({ type: 'NATIVE_READY', alreadyRunning: true, port: instance.port });
        return;
      }
      writeNativeMessage({ type: 'NATIVE_ERROR', error: err?.message || 'Server error' });
      shutdown();
    });

    instance.start().then((info) => {
      writeNativeMessage({ type: 'NATIVE_READY', alreadyRunning: false, ...info });
    });
  } else {
    instance.start().then((info) => {
      console.log('');
      console.log('  SoundCloud Multi-Play LAN Remote Server');
      console.log('  ---------------------------------------');
      console.log(`  LAN URL : ${info.shortUrl}`);
      console.log(`  Pairing : ${info.url}`);
      console.log(`  PIN     : ${info.pin}`);
      console.log('');
      console.log('  Keep this terminal open while controlling from mobile.');
      console.log('');
    });
  }
}

module.exports = {
  createLanServer,
  getLanIpAddress,
  encodeWsFrame,
  parseWsFrames,
  writeNativeMessage
};
