(() => {
  'use strict';

  const MSG_SOURCE = 'sc-multiplay';
  let nextReqId = 1;
  const pending = new Map();

  function sendEnabledState(enabled) {
    window.postMessage(
      { source: MSG_SOURCE, type: 'SET_ENABLED', enabled },
      '*'
    );
  }

  function sendProgressData(savedProgress, lastPlayed) {
    window.postMessage(
      {
        source: MSG_SOURCE,
        type: 'SET_SAVED_PROGRESS',
        savedProgress: savedProgress || {},
        lastPlayed: lastPlayed || null
      },
      '*'
    );
  }

  function requestMainWorld(type, extra = {}) {
    const requestId = nextReqId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, 120000);

      pending.set(requestId, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });

      window.postMessage({ source: MSG_SOURCE, type, requestId, ...extra }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== MSG_SOURCE) return;
    const { type, requestId, payload } = event.data;

    if (type === 'RESPONSE' && pending.has(requestId)) {
      const resolve = pending.get(requestId);
      pending.delete(requestId);
      resolve(payload);
      return;
    }

    if (type === 'SAVE_PROGRESS') {
      chrome.storage.local.set({
        savedProgress: event.data.savedProgress || {},
        lastPlayed: event.data.lastPlayed || null
      });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message?.type === 'GET_PLAYER_STATE') {
        const state = await requestMainWorld('GET_PLAYER_STATE');
        sendResponse({ ok: true, state });
      } else if (message?.type === 'PLAYER_COMMAND') {
        const state = await requestMainWorld('PLAYER_COMMAND', {
          command: message.command,
          value: message.value
        });
        sendResponse({ ok: true, state });
      } else if (message?.type === 'DOWNLOAD_TRACK') {
        const downloadState = await requestMainWorld('DOWNLOAD_TRACK');
        sendResponse({ ok: true, downloadState });
      } else if (message?.type === 'PLAY_ON_PAGE') {
        const state = await requestMainWorld('PLAY_ON_PAGE');
        sendResponse({ ok: true, state });
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

  async function init() {
    const { enabled = true, savedProgress = {}, lastPlayed = null } =
      await chrome.storage.local.get(['enabled', 'savedProgress', 'lastPlayed']);
    sendEnabledState(enabled);
    sendProgressData(savedProgress, lastPlayed);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.enabled) {
      sendEnabledState(Boolean(changes.enabled.newValue));
    }
    if (changes.savedProgress || changes.lastPlayed) {
      (async () => {
        const { savedProgress = {}, lastPlayed = null } =
          await chrome.storage.local.get(['savedProgress', 'lastPlayed']);
        sendProgressData(savedProgress, lastPlayed);
      })();
    }
  });

  init();
})();
