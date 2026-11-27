import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findBrowserExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function run() {
  const browserPath = findBrowserExecutable();
  if (!browserPath) {
    console.log('Skipping Chrome smoke check: no Chromium executable found.');
    return;
  }

  const popupDir = path.join(ROOT, 'popup');
  const html = fs.readFileSync(path.join(popupDir, 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(popupDir, 'popup.css'), 'utf8');
  const js = fs.readFileSync(path.join(popupDir, 'popup.js'), 'utf8');

  const mockScript = `<script>
window.__copied = [];
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (t) => { window.__copied.push(t); } }
});
window.__mockTitle = 'A Very Long SoundCloud Song Title That Must Slide Smoothly Inside The Popup';
window.chrome = {
  storage: { local: { async get() { return { enabled: true, lastPlayed: null }; }, async set() {} } },
  tabs: {
    async query() { return [{ id: 1, windowId: 1, audible: true, active: true, title: 'Test' }]; },
    async sendMessage() {
      return {
        ok: true,
        state: {
          hasTrack: true,
          isPlaying: true,
          title: window.__mockTitle,
          artist: 'Smoke Artist',
          trackUrl: 'https://soundcloud.com/a/b',
          currentTimeSec: 15,
          durationSec: 180,
          currentTimeText: '0:15',
          durationText: '3:00',
          repeat: 'none',
          muted: false,
          volume: 1
        }
      };
    }
  }
};
</script>`;

  const testHtml = html.replace('<script src="popup.js"></script>', `${mockScript}\n<script src="popup.js"></script>`);
  const server = http.createServer((req, res) => {
    if (req.url === '/popup.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(testHtml);
    } else if (req.url === '/popup.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(css);
    } else if (req.url === '/popup.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(js);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-smoke-'));

  const chrome = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--window-size=400,600',
    `http://127.0.0.1:${port}/popup.html`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools startup timeout')), 10000);
      chrome.stderr.on('data', (chunk) => {
        const m = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });

    const targets = await (await fetch(wsUrl.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
    const pageTarget = targets.find((t) => t.url.includes('popup.html')) || targets[0];
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));

    let msgId = 1;
    const cdp = (method, params = {}) => new Promise((resolve) => {
      const id = msgId++;
      const onMsg = (ev) => {
        const data = JSON.parse(ev.data);
        if (data.id === id) {
          ws.removeEventListener('message', onMsg);
          resolve(data.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await new Promise((r) => setTimeout(r, 700));
    const initial = (await cdp('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const title = document.getElementById('track-title');
        const marquee = document.getElementById('track-title-marquee');
        return {
          isSliding: title.classList.contains('is-sliding'),
          left: marquee.getBoundingClientRect().left,
          animCount: marquee.getAnimations().length
        };
      })()`
    })).result.value;

    assert.equal(initial.isSliding, true, 'Long title must activate is-sliding');
    assert.ok(initial.animCount >= 1, 'Marquee animation must be attached');

    await new Promise((r) => setTimeout(r, 2800));
    const moved = (await cdp('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const title = document.getElementById('track-title');
        const marquee = document.getElementById('track-title-marquee');
        title.click();
        return {
          left: marquee.getBoundingClientRect().left,
          copied: window.__copied,
          hasCopiedClass: title.classList.contains('copied')
        };
      })()`
    })).result.value;

    assert.ok(moved.left < initial.left, `Expected marquee to slide left (${moved.left} < ${initial.left})`);
    await new Promise((r) => setTimeout(r, 50));
    const afterCopy = (await cdp('Runtime.evaluate', {
      returnByValue: true,
      expression: `({ copied: window.__copied, hasCopiedClass: document.getElementById('track-title').classList.contains('copied') })`
    })).result.value;
    assert.equal(afterCopy.copied[0], 'Smoke Artist - A Very Long SoundCloud Song Title That Must Slide Smoothly Inside The Popup');
    assert.equal(afterCopy.hasCopiedClass, true);

    await cdp('Runtime.evaluate', {
      awaitPromise: true,
      expression: `window.__mockTitle = 'Short'; refreshState();`
    });
    const shortRes = (await cdp('Runtime.evaluate', {
      returnByValue: true,
      expression: `document.getElementById('track-title').classList.contains('is-sliding')`
    })).result.value;
    assert.equal(shortRes, false, 'Short title must not slide');

    ws.close();
    console.log('Chrome popup smoke check passed.');
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    server.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Ignore locked temp profile files on Windows
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
