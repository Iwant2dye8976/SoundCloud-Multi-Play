(() => {
  'use strict';

  const MSG_SOURCE = 'sc-multiplay';
  let nextReqId = 1;
  const pending = new Map();
  let saveQueue = Promise.resolve();

  function withSaveLock(fn) {
    const run = () => (navigator?.locks?.request ? navigator.locks.request('sc-multiplay-save', fn) : fn());
    saveQueue = saveQueue.then(run, run);
    return saveQueue;
  }

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

  function sendPendingResume(pendingResume) {
    window.postMessage(
      {
        source: MSG_SOURCE,
        type: 'SET_PENDING_RESUME',
        pendingResume: pendingResume || null
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

  function isContextValid() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== MSG_SOURCE) return;
    if (!isContextValid()) return;
    const { type, requestId, payload } = event.data;

    if (type === 'RESPONSE' && pending.has(requestId)) {
      const resolve = pending.get(requestId);
      pending.delete(requestId);
      resolve(payload);
      return;
    }

    if (type === 'SAVE_PROGRESS') {
      const { trackUrl, remove, clearAll, entry, lastPlayed } = event.data;
      withSaveLock(async () => {
        if (!isContextValid()) return;
        try {
          // Read latest storage inside lock so concurrent tabs don't clobber a newer track's removal
          const { savedProgress = {}, lastPlayed: storedLastPlayed = null } =
            await chrome.storage.local.get(['savedProgress', 'lastPlayed']);
          let nextProgress = { ...savedProgress };
          let nextLastPlayed = lastPlayed !== undefined ? lastPlayed : storedLastPlayed;

          if (clearAll) {
            nextProgress = {};
            nextLastPlayed = null;
          } else if (trackUrl) {
            if (remove) {
              delete nextProgress[trackUrl];
              if (nextLastPlayed?.trackUrl === trackUrl) {
                nextLastPlayed = null;
              }
            } else if (entry) {
              // Keep only the single latest played song
              nextProgress = { [trackUrl]: entry };
            }
          }

          const entries = Object.entries(nextProgress);
          const pruned = entries.length <= 1
            ? nextProgress
            : Object.fromEntries(
                entries
                  .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
                  .slice(0, 1)
              );

          await chrome.storage.local.set({
            savedProgress: pruned,
            lastPlayed: nextLastPlayed || null
          });
        } catch {
          // Ignore if extension context was invalidated
        }
      });
      return;
    }

    if (type === 'CLEAR_PENDING_RESUME') {
      try {
        chrome.storage.local.remove('pendingResume');
      } catch {
        // Ignore if extension context was invalidated
      }
      return;
    }

    if (type === 'MAIN_READY') {
      init();
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
      } else if (message?.type === 'CANCEL_DOWNLOAD') {
        const downloadState = await requestMainWorld('CANCEL_DOWNLOAD');
        sendResponse({ ok: true, downloadState });
      } else if (message?.type === 'PLAY_ON_PAGE') {
        const state = await requestMainWorld('PLAY_ON_PAGE', {
          targetUrl: message.targetUrl || '',
          timeSec: message.timeSec,
          requestedAt: message.requestedAt
        });
        sendResponse({ ok: true, state });
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

  async function init() {
    if (!isContextValid()) return;
    try {
      const {
        enabled = true,
        savedProgress = {},
        lastPlayed = null,
        pendingResume = null
      } = await chrome.storage.local.get(['enabled', 'savedProgress', 'lastPlayed', 'pendingResume']);
      sendEnabledState(enabled);
      sendProgressData(savedProgress, lastPlayed);
      if (pendingResume) {
        sendPendingResume(pendingResume);
      }
    } catch {
      // Ignore if extension context was invalidated
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !isContextValid()) return;
    if (changes.enabled) {
      sendEnabledState(Boolean(changes.enabled.newValue));
    }
    if (changes.savedProgress || changes.lastPlayed) {
      (async () => {
        if (!isContextValid()) return;
        try {
          const { savedProgress = {}, lastPlayed = null } =
            await chrome.storage.local.get(['savedProgress', 'lastPlayed']);
          sendProgressData(savedProgress, lastPlayed);
        } catch {
          // Ignore if extension context was invalidated
        }
      })();
    }
    if (changes.pendingResume) {
      sendPendingResume(changes.pendingResume.newValue || null);
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) init();
  });

  init();
})();
