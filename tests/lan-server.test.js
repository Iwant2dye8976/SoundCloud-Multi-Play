'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const { createLanServer, encodeWsFrame, parseWsFrames } = require('../lan-server/server');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    }).on('error', reject);
  });
}

function connectRawWs(port, reqPath) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key
      }
    });

    req.on('upgrade', (res, socket, head) => {
      let buf = Buffer.alloc(0);
      const messages = [];
      const waiters = [];

      const processChunk = (chunk) => {
        if (!chunk || !chunk.length) return;
        buf = Buffer.concat([buf, chunk]);
        const { frames, remaining } = parseWsFrames(buf);
        buf = remaining;
        for (const frame of frames) {
          if (frame.opcode === 0x1) {
            const msg = JSON.parse(frame.payload.toString('utf8'));
            if (waiters.length > 0) {
              waiters.shift()(msg);
            } else {
              messages.push(msg);
            }
          }
        }
      };

      socket.on('data', processChunk);
      processChunk(head);

      resolve({
        socket,
        sendJson(obj) {
          const payload = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          const len = payload.length;
          let header;
          if (len < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x81;
            header[1] = 0x80 | len;
          } else {
            header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
          }
          const masked = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
          socket.write(Buffer.concat([header, mask, masked]));
        },
        nextMessage(timeoutMs = 2000) {
          if (messages.length > 0) return Promise.resolve(messages.shift());
          return new Promise((resMsg, rejMsg) => {
            const timer = setTimeout(() => rejMsg(new Error('WS message timeout')), timeoutMs);
            waiters.push((m) => {
              clearTimeout(timer);
              resMsg(m);
            });
          });
        },
        close() {
          socket.destroy();
        }
      });
    });

    req.on('response', (res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

test('lan-server serves mobile UI, exposes /api/info on localhost, and relays WS messages with PIN auth', async (t) => {
  const lan = createLanServer({ host: '127.0.0.1', port: 0, pin: '424242', lanIp: '192.168.1.50' });
  const info = await lan.start();
  t.after(() => new Promise((r) => lan.server.close(r)));

  const htmlRes = await httpGet(`http://127.0.0.1:${info.port}/`);
  assert.equal(htmlRes.statusCode, 200);
  assert.ok(htmlRes.body.includes('SoundCloud Remote'));

  const infoRes = await httpGet(`http://127.0.0.1:${info.port}/api/info`);
  assert.equal(infoRes.statusCode, 200);
  const parsedInfo = JSON.parse(infoRes.body);
  assert.equal(parsedInfo.pin, '424242');
  assert.equal(parsedInfo.lanIp, '192.168.1.50');

  // Invalid PIN must be rejected with HTTP 401
  await assert.rejects(
    () => connectRawWs(info.port, '/mobile?pin=000000'),
    /HTTP 401/
  );

  // Connect extension and mobile client
  const extWs = await connectRawWs(info.port, '/ext');
  t.after(() => extWs.close());

  const serverInfoMsg = await extWs.nextMessage();
  assert.equal(serverInfoMsg.type, 'SERVER_INFO');
  assert.equal(serverInfoMsg.pin, '424242');

  const mobileWs = await connectRawWs(info.port, '/mobile?pin=424242');
  t.after(() => mobileWs.close());

  const extStatusMsg = await mobileWs.nextMessage();
  assert.equal(extStatusMsg.type, 'EXT_STATUS');
  assert.equal(extStatusMsg.connected, true);

  const countMsg = await extWs.nextMessage();
  assert.equal(countMsg.type, 'MOBILE_COUNT');
  assert.equal(countMsg.mobileCount, 1);

  const getStateMsg = await extWs.nextMessage();
  assert.equal(getStateMsg.type, 'GET_STATE');

  // Extension sends state update -> mobile receives it
  extWs.sendJson({
    type: 'STATE_UPDATE',
    selectedTabId: 10,
    tabs: [{ id: 10, audible: true, label: 'Demo Track' }],
    state: { hasTrack: true, isPlaying: true, title: 'Demo Track' }
  });
  const stateUpdate = await mobileWs.nextMessage();
  assert.equal(stateUpdate.type, 'STATE_UPDATE');
  assert.equal(stateUpdate.state.title, 'Demo Track');

  // Mobile sends PLAYER_COMMAND -> extension receives it
  mobileWs.sendJson({ type: 'PLAYER_COMMAND', command: 'next' });
  const cmdMsg = await extWs.nextMessage();
  assert.deepEqual(cmdMsg, { type: 'PLAYER_COMMAND', command: 'next' });
});

test('encodeWsFrame and parseWsFrames round-trip medium payloads', () => {
  const text = 'x'.repeat(300);
  const frame = encodeWsFrame(text, 0x1);
  const { frames, remaining } = parseWsFrames(frame);
  assert.equal(remaining.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), text);
});

test('lan-server --native emits length-prefixed NATIVE_READY over stdout and exits on stdin close', async (t) => {
  const serverPath = path.resolve(__dirname, '..', 'lan-server', 'server.js');
  const child = spawn(process.execPath, [serverPath, '--native'], {
    env: { ...process.env, PORT: '0', SC_LAN_PIN: '778899' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => {
    if (!child.killed) child.kill();
  });

  const readyMsg = await new Promise((resolve, reject) => {
    let outBuf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('Timed out waiting for NATIVE_READY')), 3000);
    child.stdout.on('data', (chunk) => {
      outBuf = Buffer.concat([outBuf, chunk]);
      if (outBuf.length >= 4) {
        const len = outBuf.readUInt32LE(0);
        if (outBuf.length >= 4 + len) {
          clearTimeout(timer);
          resolve(JSON.parse(outBuf.subarray(4, 4 + len).toString('utf8')));
        }
      }
    });
    child.on('error', reject);
  });

  assert.equal(readyMsg.type, 'NATIVE_READY');
  assert.equal(readyMsg.pin, '778899');
  assert.ok(readyMsg.port > 0);

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.stdin.end();
  });
  assert.equal(exitCode, 0);
});

test('qr-decode decodes pairing QR image generated by popup/qr', () => {
  const qrSrc = fs.readFileSync(path.resolve(__dirname, '..', 'popup', 'qr.js'), 'utf8');
  const decodeSrc = fs.readFileSync(path.resolve(__dirname, '..', 'lan-server', 'public', 'qr-decode.js'), 'utf8');
  const ctx = { TextEncoder, TextDecoder, Uint8Array, Int32Array, globalThis: null };
  ctx.globalThis = ctx;
  vm.runInNewContext(qrSrc, ctx);
  vm.runInNewContext(decodeSrc, ctx);

  const payload = 'http://192.168.1.50:3847/?pin=654321';
  const matrix = ctx.scQr.createQrMatrix(payload);
  const size = matrix.length;
  const quiet = 4;
  const scale = 6;
  const imgSize = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(imgSize * imgSize * 4);
  rgba.fill(255);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy;
          const x = (c + quiet) * scale + dx;
          const idx = (y * imgSize + x) * 4;
          rgba[idx] = 14;
          rgba[idx + 1] = 14;
          rgba[idx + 2] = 16;
          rgba[idx + 3] = 255;
        }
      }
    }
  }

  const decoded = ctx.scQrDecode.decodeQrFromImageData(rgba, imgSize, imgSize);
  assert.equal(decoded, payload);
});
