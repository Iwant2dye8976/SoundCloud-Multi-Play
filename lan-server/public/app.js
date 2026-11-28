'use strict';

const connPillEl = document.getElementById('conn-pill');
const connTextEl = document.getElementById('conn-text');
const btnDisconnect = document.getElementById('btn-disconnect');

const pinViewEl = document.getElementById('pin-view');
const pinFormEl = document.getElementById('pin-form');
const pinInputEl = document.getElementById('pin-input');
const pinErrorEl = document.getElementById('pin-error');
const btnScanQr = document.getElementById('btn-scan-qr');
const qrFileInputEl = document.getElementById('qr-file-input');
const qrScannerEl = document.getElementById('qr-scanner');
const qrVideoEl = document.getElementById('qr-video');
const btnScanCancel = document.getElementById('btn-scan-cancel');

const remoteViewEl = document.getElementById('remote-view');
const playUrlFormEl = document.getElementById('play-url-form');
const playUrlInputEl = document.getElementById('play-url-input');
const playUrlErrorEl = document.getElementById('play-url-error');
const tabsBarEl = document.getElementById('tabs-bar');
const emptyStateEl = document.getElementById('empty-state');
const emptyMessageEl = document.getElementById('empty-message');
const resumeCardEl = document.getElementById('resume-card');
const resumeTitleEl = document.getElementById('resume-title');
const resumeTimeEl = document.getElementById('resume-time');
const resumeBtn = document.getElementById('resume-btn');
const clearResumeBtn = document.getElementById('clear-resume-btn');
const playerContentEl = document.getElementById('player-content');

const artworkEl = document.getElementById('artwork');
const artworkFallbackEl = document.getElementById('artwork-fallback');
const trackTitleEl = document.getElementById('track-title');
const trackArtistEl = document.getElementById('track-artist');

const progressRangeEl = document.getElementById('progress-range');
const timePassedEl = document.getElementById('time-passed');
const timeDurationEl = document.getElementById('time-duration');

const btnShuffle = document.getElementById('btn-shuffle');
const btnPrev = document.getElementById('btn-prev');
const btnBack10 = document.getElementById('btn-back10');
const btnPlay = document.getElementById('btn-play');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const btnFwd10 = document.getElementById('btn-fwd10');
const btnNext = document.getElementById('btn-next');
const btnRepeat = document.getElementById('btn-repeat');
const repeatBadgeEl = document.getElementById('repeat-badge');

const btnMute = document.getElementById('btn-mute');
const iconVol = document.getElementById('icon-vol');
const iconMuted = document.getElementById('icon-muted');
const volumeRangeEl = document.getElementById('volume-range');
const volumeValueEl = document.getElementById('volume-value');

const btnLike = document.getElementById('btn-like');
const likeTextEl = document.getElementById('like-text');
const iconHeartOutline = btnLike.querySelector('.icon-heart-outline');
const iconHeartSolid = btnLike.querySelector('.icon-heart-solid');

const btnFollow = document.getElementById('btn-follow');
const followTextEl = document.getElementById('follow-text');
const iconFollowAdd = btnFollow.querySelector('.icon-follow-add');
const iconFollowCheck = btnFollow.querySelector('.icon-follow-check');

let ws = null;
let activePin = '';
let reconnectTimer = null;
let manualDisconnect = false;
let extConnected = false;
let latestState = null;
let lastTabsKey = '';
let isDraggingSeek = false;
let seekLockUntil = 0;
let isDraggingVolume = false;
let volumeSendTimer = null;
let qrStream = null;
let qrScanTimer = null;

function setConnectionStatus(kind, text) {
  connPillEl.className = `conn-pill ${kind || ''}`.trim();
  connTextEl.textContent = text;
}

function formatTime(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

function setProgressVisual(pct) {
  const clamped = Math.min(100, Math.max(0, pct));
  progressRangeEl.style.setProperty('--progress', `${clamped}%`);
}

function setVolumeVisual(pct) {
  const clamped = Math.round(Math.min(100, Math.max(0, pct)));
  volumeRangeEl.style.setProperty('--vol', `${clamped}%`);
  volumeValueEl.textContent = `${clamped}%`;
}

function showPinView(errorMsg = '') {
  pinViewEl.classList.remove('hidden');
  remoteViewEl.classList.add('hidden');
  btnDisconnect.classList.add('hidden');
  if (errorMsg) {
    pinErrorEl.textContent = errorMsg;
    pinErrorEl.classList.remove('hidden');
  } else {
    pinErrorEl.classList.add('hidden');
  }
}

function showRemoteView() {
  stopQrScanner();
  pinViewEl.classList.add('hidden');
  remoteViewEl.classList.remove('hidden');
  btnDisconnect.classList.remove('hidden');
  pinErrorEl.classList.add('hidden');
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendCommand(command, value) {
  sendWs({ type: 'PLAYER_COMMAND', command, value });
}

function renderTabs(tabs, selectedTabId) {
  if (!Array.isArray(tabs) || tabs.length < 2) {
    if (lastTabsKey !== '') {
      lastTabsKey = '';
      tabsBarEl.classList.add('hidden');
      tabsBarEl.replaceChildren();
    }
    return;
  }

  const key = `${selectedTabId}|${tabs.map((t) => `${t.id}:${t.audible ? 1 : 0}:${t.label}`).join('\u0001')}`;
  if (key === lastTabsKey) return;
  lastTabsKey = key;

  tabsBarEl.classList.remove('hidden');
  const chips = tabs.map((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-chip';
    if (tab.id === selectedTabId) btn.classList.add('active');
    if (tab.audible) btn.classList.add('audible');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab.id === selectedTabId));

    const dot = document.createElement('span');
    dot.className = 'tab-chip-dot';
    const label = document.createElement('span');
    label.className = 'tab-chip-text';
    label.textContent = tab.label || `Tab ${tab.id}`;

    btn.append(dot, label);
    btn.addEventListener('click', () => {
      sendWs({ type: 'SELECT_TAB', tabId: tab.id });
    });
    return btn;
  });
  tabsBarEl.replaceChildren(...chips);
}

function getHighResArtworkUrl(url) {
  if (!url) return '';
  return String(url).replace(
    /-(large|t50x50|t120x120|t200x200|t300x300)(\.[a-z0-9]+)(\?.*)?$/i,
    '-t500x500$2$3'
  );
}

function renderState(state, lastPlayed = null) {
  latestState = state;
  if (!state || !state.hasTrack) {
    emptyStateEl.classList.remove('hidden');
    playerContentEl.classList.add('hidden');
    emptyMessageEl.textContent = extConnected
      ? 'Start playing a track on SoundCloud to control it here.'
      : 'Waiting for Chrome extension connection...';
    if (resumeCardEl) {
      if (lastPlayed && lastPlayed.trackUrl && lastPlayed.timeSec >= 5) {
        resumeCardEl.classList.remove('hidden');
        resumeTitleEl.textContent = lastPlayed.title || 'Last played track';
        resumeTimeEl.textContent = `${formatTime(lastPlayed.timeSec)} / ${formatTime(lastPlayed.durationSec)}`;
      } else {
        resumeCardEl.classList.add('hidden');
      }
    }
    return;
  }

  emptyStateEl.classList.add('hidden');
  playerContentEl.classList.remove('hidden');

  trackTitleEl.textContent = state.title || 'Unknown Track';
  trackArtistEl.textContent = state.artist || 'SoundCloud';

  const hiResArt = getHighResArtworkUrl(state.artworkUrl);
  if (hiResArt) {
    if (artworkEl.src !== hiResArt) artworkEl.src = hiResArt;
    artworkEl.classList.remove('hidden');
    artworkFallbackEl.classList.add('hidden');
  } else {
    artworkEl.classList.add('hidden');
    artworkFallbackEl.classList.remove('hidden');
  }

  iconPlay.classList.toggle('hidden', Boolean(state.isPlaying));
  iconPause.classList.toggle('hidden', !state.isPlaying);

  btnShuffle.classList.toggle('active', Boolean(state.shuffle));
  btnRepeat.classList.toggle('active', state.repeat && state.repeat !== 'none');
  repeatBadgeEl.classList.toggle('hidden', state.repeat !== 'one');

  iconVol.classList.toggle('hidden', Boolean(state.muted));
  iconMuted.classList.toggle('hidden', !state.muted);
  btnMute.classList.toggle('active', Boolean(state.muted));

  if (!isDraggingVolume) {
    const volPct = state.muted ? 0 : Math.round((state.volume ?? 1) * 100);
    volumeRangeEl.value = String(volPct);
    setVolumeVisual(volPct);
  }

  const liked = Boolean(state.liked);
  btnLike.classList.toggle('active', liked);
  btnLike.disabled = !state.canLike;
  likeTextEl.textContent = liked ? 'Liked' : 'Like';
  iconHeartOutline.classList.toggle('hidden', liked);
  iconHeartSolid.classList.toggle('hidden', !liked);

  const following = Boolean(state.following);
  btnFollow.classList.toggle('active', following);
  btnFollow.disabled = !state.canFollow;
  followTextEl.textContent = following ? 'Following' : 'Follow';
  iconFollowAdd.classList.toggle('hidden', following);
  iconFollowCheck.classList.toggle('hidden', !following);

  if (!isDraggingSeek && Date.now() > seekLockUntil) {
    const ratio = state.durationSec > 0 ? state.currentTimeSec / state.durationSec : 0;
    const val = Math.round(Math.min(1, Math.max(0, ratio)) * 10000);
    progressRangeEl.value = String(val);
    setProgressVisual(val / 100);
    timePassedEl.textContent = state.currentTimeText || formatTime(state.currentTimeSec);
  }
  timeDurationEl.textContent = state.durationText || formatTime(state.durationSec);
}

function connectWebSocket(pin) {
  clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }

  activePin = pin;
  manualDisconnect = false;
  let openedOnce = false;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/mobile?pin=${encodeURIComponent(pin)}`;
  setConnectionStatus('waiting', 'Connecting...');

  const socket = new WebSocket(url);
  ws = socket;

  socket.addEventListener('open', () => {
    openedOnce = true;
    sessionStorage.setItem('scLanPin', pin);
    showRemoteView();
    setConnectionStatus('waiting', 'Waiting for extension...');
    sendWs({ type: 'GET_STATE' });
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'EXT_STATUS') {
      extConnected = Boolean(msg.connected);
      if (extConnected) {
        setConnectionStatus('connected', 'Connected to PC');
      } else {
        setConnectionStatus('waiting', 'Enable LAN Remote in Chrome popup');
        renderState(null);
      }
      return;
    }

    if (msg.type === 'STATE_UPDATE') {
      extConnected = true;
      setConnectionStatus('connected', 'Connected to PC');
      renderTabs(msg.tabs || [], msg.selectedTabId);
      renderState(msg.state || null, msg.lastPlayed || null);
    }
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    ws = null;
    if (manualDisconnect) return;

    if (!openedOnce) {
      sessionStorage.removeItem('scLanPin');
      setConnectionStatus('error', 'Authentication failed');
      showPinView('Invalid PIN or server rejected connection.');
      return;
    }

    setConnectionStatus('waiting', 'Reconnecting...');
    reconnectTimer = setTimeout(() => {
      if (!manualDisconnect && activePin) {
        connectWebSocket(activePin);
      }
    }, 2000);
  });
}

pinFormEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = pinInputEl.value.trim();
  if (!/^\d{4,12}$/.test(pin)) {
    pinErrorEl.textContent = 'Enter a valid numeric PIN.';
    pinErrorEl.classList.remove('hidden');
    return;
  }
  connectWebSocket(pin);
});

function extractPinFromQrValue(rawValue) {
  const text = String(rawValue || '').trim();
  if (/^\d{4,12}$/.test(text)) return text;
  try {
    const parsed = new URL(text);
    const pin = parsed.searchParams.get('pin') || '';
    if (/^\d{4,12}$/.test(pin)) return pin;
  } catch {
    // Not a URL
  }
  return '';
}

function stopQrScanner() {
  clearTimeout(qrScanTimer);
  qrScanTimer = null;
  if (qrStream) {
    for (const track of qrStream.getTracks()) track.stop();
    qrStream = null;
  }
  if (qrVideoEl) qrVideoEl.srcObject = null;
  qrScannerEl?.classList.add('hidden');
}

async function startLiveQrScanner() {
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  qrStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false
  });
  qrVideoEl.srcObject = qrStream;
  await qrVideoEl.play();
  qrScannerEl.classList.remove('hidden');
  pinErrorEl.classList.add('hidden');

  const scanFrame = async () => {
    if (!qrStream) return;
    try {
      const codes = await detector.detect(qrVideoEl);
      for (const code of codes) {
        const pin = extractPinFromQrValue(code.rawValue);
        if (pin) {
          stopQrScanner();
          pinInputEl.value = pin;
          connectWebSocket(pin);
          return;
        }
      }
    } catch {
      // Ignore single-frame detection errors
    }
    qrScanTimer = setTimeout(scanFrame, 250);
  };
  scanFrame();
}

async function decodeQrFromFile(file) {
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const bitmap = await createImageBitmap(file);
      try {
        const codes = await detector.detect(bitmap);
        for (const code of codes) {
          const pin = extractPinFromQrValue(code.rawValue);
          if (pin) return pin;
        }
      } finally {
        bitmap.close?.();
      }
    } catch {
      // Fall through to pure-JS decoder
    }
  }

  if (!globalThis.scQrDecode?.decodeQrFromImageData) return '';

  const imgUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = imgUrl;
    });
    const maxDim = 720;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(21, Math.round((img.naturalWidth || 1) * scale));
    const h = Math.max(21, Math.round((img.naturalHeight || 1) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const decoded = globalThis.scQrDecode.decodeQrFromImageData(imgData.data, w, h);
    return extractPinFromQrValue(decoded);
  } finally {
    URL.revokeObjectURL(imgUrl);
  }
}

btnScanQr?.addEventListener('click', async () => {
  if ('BarcodeDetector' in window && window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
    try {
      await startLiveQrScanner();
      return;
    } catch {
      stopQrScanner();
    }
  }

  // Works on HTTP LAN for both Android and iOS via native camera capture
  qrFileInputEl?.click();
});

btnScanCancel?.addEventListener('click', stopQrScanner);

qrFileInputEl?.addEventListener('change', async () => {
  const file = qrFileInputEl.files?.[0];
  qrFileInputEl.value = '';
  if (!file) return;

  try {
    const pin = await decodeQrFromFile(file);
    if (pin) {
      pinErrorEl.classList.add('hidden');
      pinInputEl.value = pin;
      connectWebSocket(pin);
      return;
    }
    pinErrorEl.textContent = 'No valid pairing QR code found in photo. Try a closer, clear shot.';
    pinErrorEl.classList.remove('hidden');
  } catch {
    pinErrorEl.textContent = 'Could not decode QR code from photo.';
    pinErrorEl.classList.remove('hidden');
  }
});

btnDisconnect.addEventListener('click', () => {
  manualDisconnect = true;
  clearTimeout(reconnectTimer);
  sessionStorage.removeItem('scLanPin');
  activePin = '';
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  setConnectionStatus('', 'Enter PIN to connect');
  showPinView();
});

btnShuffle.addEventListener('click', () => sendCommand('toggleShuffle'));
btnPrev.addEventListener('click', () => sendCommand('prev'));
btnBack10.addEventListener('click', () => sendCommand('seekDelta', -10));
btnPlay.addEventListener('click', () => sendCommand('togglePlay'));
btnFwd10.addEventListener('click', () => sendCommand('seekDelta', 10));
btnNext.addEventListener('click', () => sendCommand('next'));
btnRepeat.addEventListener('click', () => sendCommand('toggleRepeat'));
btnMute.addEventListener('click', () => sendCommand('toggleMute'));
btnLike.addEventListener('click', () => sendCommand('toggleLike'));
btnFollow.addEventListener('click', () => sendCommand('toggleFollow'));

resumeBtn?.addEventListener('click', () => sendWs({ type: 'RESUME_LAST_PLAYED' }));
clearResumeBtn?.addEventListener('click', () => sendWs({ type: 'CLEAR_LAST_PLAYED' }));

playUrlFormEl?.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = playUrlInputEl.value.trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  const isSc = parsed && /^https?:$/i.test(parsed.protocol) && /(^|\.)soundcloud\.com$/i.test(parsed.hostname);
  if (!isSc) {
    playUrlErrorEl.classList.remove('hidden');
    return;
  }
  playUrlErrorEl.classList.add('hidden');
  sendWs({ type: 'PLAY_URL', url: parsed.href });
  playUrlInputEl.value = '';
  playUrlInputEl.blur();
});

progressRangeEl.addEventListener('input', () => {
  isDraggingSeek = true;
  const val = Number(progressRangeEl.value);
  setProgressVisual(val / 100);
  if (latestState?.durationSec > 0) {
    timePassedEl.textContent = formatTime((val / 10000) * latestState.durationSec);
  }
});

progressRangeEl.addEventListener('change', () => {
  const ratio = Number(progressRangeEl.value) / 10000;
  seekLockUntil = Date.now() + 700;
  isDraggingSeek = false;
  sendCommand('seekRatio', ratio);
});

volumeRangeEl.addEventListener('input', () => {
  isDraggingVolume = true;
  const pct = Number(volumeRangeEl.value);
  setVolumeVisual(pct);
  clearTimeout(volumeSendTimer);
  volumeSendTimer = setTimeout(() => {
    sendCommand('setVolume', pct / 100);
  }, 60);
});

volumeRangeEl.addEventListener('change', () => {
  clearTimeout(volumeSendTimer);
  const pct = Number(volumeRangeEl.value);
  sendCommand('setVolume', pct / 100);
  isDraggingVolume = false;
});

const releaseDrags = () => {
  isDraggingSeek = false;
  isDraggingVolume = false;
};
window.addEventListener('pointerup', releaseDrags);
window.addEventListener('pointercancel', releaseDrags);

(function init() {
  const params = new URLSearchParams(location.search);
  const urlPin = params.get('pin');
  const savedPin = sessionStorage.getItem('scLanPin');

  if (urlPin) {
    history.replaceState(null, '', '/');
    pinInputEl.value = urlPin;
    connectWebSocket(urlPin);
  } else if (savedPin) {
    pinInputEl.value = savedPin;
    connectWebSocket(savedPin);
  } else {
    showPinView();
  }
})();
