'use strict';

const COMMAND_MAP = {
  'toggle-play': 'togglePlay',
  'next-track': 'next',
  'prev-track': 'prev',
  'like-track': 'toggleLike'
};

const LAN_DEFAULT_PORT = 3847;
const LAN_ALARM_NAME = 'lan-keepalive';
const NATIVE_HOST_NAME = 'com.soundcloud.multiplay.lan';

let lanWs = null;
let lanServerInfo = null;
let lanMobileCount = 0;
let lanStateTimer = null;
let lanReconnectTimer = null;
let lanReconnectDelay = 1500;
let lanSelectedTabId = null;
let nativePort = null;
let nativeError = '';
let nativeAttempted = false;

async function syncActionBadge() {
  try {
    const { enabled = true } = await chrome.storage.local.get('enabled');
    await chrome.action.setBadgeBackgroundColor({ color: '#71717a' });
    await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  } catch {
    // Ignore badge errors if action API is unavailable
  }
}

async function getPreferredTabId() {
  let preferredId = lanSelectedTabId;
  try {
    if (chrome.storage?.session) {
      const { selectedTabId = null } = await chrome.storage.session.get('selectedTabId');
      if (selectedTabId !== null) preferredId = selectedTabId;
    }
  } catch {
    // Ignore session storage unavailability
  }
  return preferredId;
}

async function pickTargetSoundCloudTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
  if (!tabs || tabs.length === 0) return null;

  const preferredId = await getPreferredTabId();

  return (
    tabs.find((t) => t.audible) ||
    (preferredId !== null ? tabs.find((t) => t.id === preferredId) : null) ||
    tabs.find((t) => t.active) ||
    tabs[0]
  );
}

async function pickLanTargetAndTabs() {
  const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
  if (!tabs || tabs.length === 0) return { tabs: [], chosen: null };

  const preferredId = await getPreferredTabId();
  let chosen = null;
  if (preferredId !== null) {
    chosen = tabs.find((t) => t.id === preferredId) || null;
  }
  if (!chosen) {
    chosen = tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs[0];
  }
  return { tabs, chosen };
}

function formatTabLabel(tab, state, index) {
  if (state?.hasTrack && state.title) return state.title;
  const clean = (tab.title || '')
    .replace(/\s*\|\s*Listen online.*$/i, '')
    .replace(/^Stream\s+/i, '')
    .trim();
  return clean || `Tab ${index + 1}`;
}

function sendLanJson(obj) {
  if (lanWs && lanWs.readyState === 1) {
    try {
      lanWs.send(JSON.stringify(obj));
    } catch {
      // Ignore send errors
    }
  }
}

function stopLanStatePolling() {
  if (lanStateTimer) {
    if (typeof clearInterval === 'function') clearInterval(lanStateTimer);
    lanStateTimer = null;
  }
}

function startLanStatePolling() {
  if (lanStateTimer || typeof setInterval !== 'function') return;
  lanStateTimer = setInterval(() => {
    if (lanMobileCount > 0 && lanWs && lanWs.readyState === 1) {
      pushPlayerState();
    } else {
      stopLanStatePolling();
    }
  }, 500);
}

async function pushPlayerState() {
  if (!lanWs || lanWs.readyState !== 1) return;
  try {
    const [{ lastPlayed = null }, { tabs, chosen }] = await Promise.all([
      chrome.storage.local.get('lastPlayed'),
      pickLanTargetAndTabs()
    ]);
    if (!chosen) {
      sendLanJson({
        type: 'STATE_UPDATE',
        selectedTabId: null,
        tabs: [],
        state: null,
        lastPlayed
      });
      return;
    }

    let chosenState = null;
    try {
      const resp = await chrome.tabs.sendMessage(chosen.id, { type: 'GET_PLAYER_STATE' });
      chosenState = resp?.state || null;
    } catch {
      chosenState = null;
    }

    const tabSummaries = tabs.map((tab, index) => ({
      id: tab.id,
      audible: Boolean(tab.audible || (tab.id === chosen.id && chosenState?.isPlaying)),
      label: formatTabLabel(tab, tab.id === chosen.id ? chosenState : null, index)
    }));

    sendLanJson({
      type: 'STATE_UPDATE',
      selectedTabId: chosen.id,
      tabs: tabSummaries,
      state: chosenState,
      lastPlayed
    });
  } catch {
    // Ignore transient tab query errors
  }
}

function normalizeTrackUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url), 'https://soundcloud.com');
    const host = parsed.hostname.replace(/^(www|m)\./i, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${parsed.protocol}//${host}${path}`;
  } catch {
    return String(url).split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
  }
}

async function resolveSoundCloudUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    return '';
  }
  if (!/^https?:$/i.test(parsed.protocol) || !/(^|\.)soundcloud\.com$/i.test(parsed.hostname)) {
    return '';
  }
  if (parsed.hostname.toLowerCase() === 'on.soundcloud.com' && typeof fetch === 'function') {
    try {
      const res = await fetch(parsed.href, { method: 'GET', redirect: 'follow' });
      if (res?.url) {
        const finalParsed = new URL(res.url);
        if (finalParsed.hostname.toLowerCase() !== 'on.soundcloud.com' && /(^|\.)soundcloud\.com$/i.test(finalParsed.hostname)) {
          return finalParsed.href;
        }
      }
      const html = await res.text();
      const metaMatch =
        html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["'](https?:\/\/[^"']+)["']/i) ||
        html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["'](https?:\/\/[^"']+)["']/i) ||
        html.match(/https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[a-zA-Z0-9_.\-/]+/i);
      if (metaMatch) return metaMatch[1] || metaMatch[0];
    } catch {
      // Fall back to original URL if shortlink resolution fails
    }
  }
  return parsed.href;
}

async function playUrlOnSoundCloud(rawUrl, timeSec = 0, clearSaved = false) {
  const targetUrl = await resolveSoundCloudUrl(rawUrl);
  if (!targetUrl) return;

  const cleanUrl = normalizeTrackUrl(targetUrl);
  const pendingResume = {
    trackUrl: cleanUrl,
    timeSec: Number(timeSec) || 0,
    requestedAt: Date.now(),
    allowHidden: true
  };
  const storagePatch = clearSaved
    ? { pendingResume, savedProgress: {}, lastPlayed: null }
    : { pendingResume };

  const { chosen } = await pickLanTargetAndTabs();
  if (chosen) {
    await chrome.storage.local.set(storagePatch);
    let delivered = false;
    try {
      const resp = await chrome.tabs.sendMessage(chosen.id, {
        type: 'PLAY_ON_PAGE',
        targetUrl: cleanUrl,
        timeSec: pendingResume.timeSec,
        requestedAt: pendingResume.requestedAt,
        allowHidden: true
      });
      delivered = Boolean(resp?.ok);
    } catch {
      delivered = false;
    }
    if (delivered) {
      try {
        await chrome.tabs.update(chosen.id, { active: true });
      } catch {
        // Ignore tab activation errors
      }
    } else {
      await chrome.tabs.update(chosen.id, { url: targetUrl, active: true });
    }
  } else {
    await chrome.storage.local.set(storagePatch);
    await chrome.tabs.create({ url: targetUrl, active: true });
  }
  await pushPlayerState();
}

async function handleLanMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SERVER_INFO') {
    lanServerInfo = {
      lanIp: msg.lanIp,
      port: msg.port,
      pin: msg.pin,
      url: msg.url,
      shortUrl: msg.shortUrl
    };
    lanMobileCount = Number(msg.mobileCount || 0);
    if (lanMobileCount > 0) {
      startLanStatePolling();
      await pushPlayerState();
    }
    return;
  }

  if (msg.type === 'MOBILE_COUNT') {
    lanMobileCount = Number(msg.mobileCount || 0);
    if (lanMobileCount > 0) {
      startLanStatePolling();
      await pushPlayerState();
    } else {
      stopLanStatePolling();
    }
    return;
  }

  if (msg.type === 'GET_STATE') {
    await pushPlayerState();
    return;
  }

  if (msg.type === 'SELECT_TAB') {
    const nextTabId = Number(msg.tabId);
    if (!Number.isFinite(nextTabId)) return;
    lanSelectedTabId = nextTabId;
    try {
      await chrome.storage?.session?.set?.({ selectedTabId: nextTabId });
    } catch {
      // Ignore session storage errors
    }
    await pushPlayerState();
    return;
  }

  if (msg.type === 'PLAY_URL' && msg.url) {
    await playUrlOnSoundCloud(msg.url, 0, true);
    return;
  }

  if (msg.type === 'RESUME_LAST_PLAYED') {
    const { lastPlayed = null } = await chrome.storage.local.get('lastPlayed');
    if (lastPlayed?.trackUrl) {
      await playUrlOnSoundCloud(lastPlayed.trackUrl, lastPlayed.timeSec || 0);
    }
    return;
  }

  if (msg.type === 'CLEAR_LAST_PLAYED') {
    await chrome.storage.local.set({ savedProgress: {}, lastPlayed: null, pendingResume: null });
    await pushPlayerState();
    return;
  }

  if (msg.type === 'PLAYER_COMMAND' && msg.command) {
    const { chosen } = await pickLanTargetAndTabs();
    if (!chosen) return;
    try {
      const resp = await chrome.tabs.sendMessage(chosen.id, {
        type: 'PLAYER_COMMAND',
        command: msg.command,
        value: msg.value
      });
      if (resp?.state) {
        const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
        sendLanJson({
          type: 'STATE_UPDATE',
          selectedTabId: chosen.id,
          tabs: (tabs || []).map((t, i) => ({
            id: t.id,
            audible: Boolean(t.audible || (t.id === chosen.id && resp.state.isPlaying)),
            label: formatTabLabel(t, t.id === chosen.id ? resp.state : null, i)
          })),
          state: resp.state
        });
      }
    } catch {
      // Ignore if content script is not ready
    }
  }
}

function disconnectNativeHost() {
  if (nativePort) {
    const port = nativePort;
    nativePort = null;
    try {
      port.postMessage({ type: 'SHUTDOWN' });
    } catch {
      // Ignore
    }
    try {
      port.disconnect();
    } catch {
      // Ignore
    }
  }
}

function ensureNativeHost(lanPort) {
  if (nativePort || nativeAttempted) return;
  if (typeof chrome.runtime?.connectNative !== 'function') return;

  nativeAttempted = true;
  nativeError = '';

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;

    port.onMessage?.addListener((msg) => {
      if (nativePort !== port || !msg || typeof msg !== 'object') return;
      if (msg.type === 'NATIVE_READY') {
        nativeError = '';
        if (!msg.alreadyRunning && msg.url) {
          lanServerInfo = {
            lanIp: msg.lanIp,
            port: msg.port,
            pin: msg.pin,
            url: msg.url,
            shortUrl: msg.shortUrl
          };
        }
        connectLanWs(lanPort);
      } else if (msg.type === 'NATIVE_ERROR') {
        nativeError = msg.error || 'Native host failed to start';
      }
    });

    port.onDisconnect?.addListener(() => {
      if (nativePort !== port) return;
      const errMsg = chrome.runtime?.lastError?.message || '';
      nativePort = null;
      if (errMsg) nativeError = errMsg;
    });
  } catch (err) {
    nativePort = null;
    nativeError = err?.message || 'Native host unavailable';
  }
}

function disconnectLan() {
  if (lanReconnectTimer && typeof clearTimeout === 'function') {
    clearTimeout(lanReconnectTimer);
  }
  lanReconnectTimer = null;
  stopLanStatePolling();
  lanMobileCount = 0;
  lanServerInfo = null;
  nativeAttempted = false;
  nativeError = '';
  disconnectNativeHost();
  if (lanWs) {
    const ws = lanWs;
    lanWs = null;
    try {
      ws.close();
    } catch {
      // Ignore
    }
  }
}

function connectLanWs(lanPort) {
  if (typeof WebSocket === 'undefined') return;
  if (lanWs && (lanWs.readyState === 0 || lanWs.readyState === 1)) return;

  if (lanReconnectTimer && typeof clearTimeout === 'function') {
    clearTimeout(lanReconnectTimer);
  }
  lanReconnectTimer = null;

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${lanPort}/ext`);
    lanWs = socket;

    socket.addEventListener('open', () => {
      if (lanWs !== socket) return;
      lanReconnectDelay = 1500;
    });

    socket.addEventListener('message', (event) => {
      if (lanWs !== socket) return;
      try {
        const msg = JSON.parse(event.data);
        handleLanMessage(msg);
      } catch {
        // Ignore malformed JSON
      }
    });

    socket.addEventListener('close', async () => {
      if (lanWs !== socket) return;
      lanWs = null;
      lanServerInfo = null;
      stopLanStatePolling();
      try {
        const { lanEnabled: stillEnabled = false } = await chrome.storage.local.get('lanEnabled');
        if (stillEnabled && typeof setTimeout === 'function') {
          lanReconnectTimer = setTimeout(syncLanConnection, lanReconnectDelay);
          lanReconnectDelay = Math.min(10000, Math.round(lanReconnectDelay * 1.5));
        }
      } catch {
        // Ignore
      }
    });

    socket.addEventListener('error', () => {
      // Close event handles cleanup and backoff reconnect
    });
  } catch {
    lanWs = null;
  }
}

async function syncLanConnection() {
  let lanEnabled = false;
  let lanPort = LAN_DEFAULT_PORT;
  try {
    const stored = await chrome.storage.local.get(['lanEnabled', 'lanPort']);
    lanEnabled = Boolean(stored.lanEnabled);
    lanPort = Number(stored.lanPort) || LAN_DEFAULT_PORT;
  } catch {
    return;
  }

  if (!lanEnabled) {
    disconnectLan();
    try {
      await chrome.alarms?.clear?.(LAN_ALARM_NAME);
    } catch {
      // Ignore
    }
    return;
  }

  try {
    chrome.alarms?.create?.(LAN_ALARM_NAME, { periodInMinutes: 0.5 });
  } catch {
    // Ignore
  }

  ensureNativeHost(lanPort);
  connectLanWs(lanPort);
}

chrome.runtime.onInstalled.addListener(() => {
  syncActionBadge();
  syncLanConnection();
});

chrome.runtime.onStartup.addListener(() => {
  syncActionBadge();
  syncLanConnection();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.enabled) {
    syncActionBadge();
  }
  if (changes.lanEnabled || changes.lanPort) {
    disconnectLan();
    syncLanConnection();
  }
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === LAN_ALARM_NAME) {
    syncLanConnection();
  }
});

chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  if (message?.type === 'LAN_GET_STATUS') {
    (async () => {
      const { lanEnabled = false, lanPort = LAN_DEFAULT_PORT } = await chrome.storage.local.get([
        'lanEnabled',
        'lanPort'
      ]);
      if (lanEnabled) {
        await syncLanConnection();
      }
      sendResponse({
        ok: true,
        lanEnabled: Boolean(lanEnabled),
        lanPort: Number(lanPort) || LAN_DEFAULT_PORT,
        connected: Boolean(lanWs && lanWs.readyState === 1),
        mobileCount: lanMobileCount,
        serverInfo: lanServerInfo,
        nativeConnected: Boolean(nativePort),
        nativeError: nativeError || '',
        extensionId: chrome.runtime?.id || ''
      });
    })();
    return true;
  }

  if (message?.type === 'LAN_RECONNECT') {
    (async () => {
      disconnectLan();
      await syncLanConnection();
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (commandName) => {
  const playerCommand = COMMAND_MAP[commandName];
  if (!playerCommand) return;

  const tab = await pickTargetSoundCloudTab();
  if (!tab) return;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'PLAYER_COMMAND',
      command: playerCommand
    });
  } catch {
    // Ignore if content script is not ready on that tab
  }
});

syncLanConnection();
