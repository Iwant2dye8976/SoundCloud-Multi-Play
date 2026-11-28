'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_MAIN_SRC = fs.readFileSync(path.join(ROOT, 'content-main.js'), 'utf8');
const CONTENT_BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'content-bridge.js'), 'utf8');
const POPUP_SRC = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');
const BACKGROUND_SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      if (force === undefined) {
        if (set.has(name)) set.delete(name);
        else set.add(name);
      } else if (force) {
        set.add(name);
      } else {
        set.delete(name);
      }
    },
    contains: (name) => set.has(name)
  };
}

function createFakeElement(tag = 'div', opts = {}) {
  const attrs = new Map(Object.entries(opts.attrs || {}));
  const listeners = new Map();
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    id: opts.id || '',
    type: opts.type || '',
    value: opts.value ?? '',
    disabled: Boolean(opts.disabled),
    checked: Boolean(opts.checked),
    href: opts.href || '',
    title: opts.title || '',
    src: '',
    textContent: opts.textContent || '',
    classList: createClassList(opts.classes || []),
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
      removeProperty(k) {
        delete this[k];
      }
    },
    children,
    setAttribute(k, v) {
      attrs.set(k, String(v));
      if (k === 'href') el.href = String(v);
    },
    getAttribute(k) {
      return attrs.has(k) ? attrs.get(k) : null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(evt) {
      const event = { target: el, preventDefault() {}, ...evt };
      for (const fn of [...(listeners.get(evt.type) || [])]) {
        fn(event);
      }
      return true;
    },
    click() {
      el.dispatchEvent({ type: 'click' });
    },
    append(...nodes) {
      children.push(...nodes);
    },
    replaceChildren(...nodes) {
      el.replaceChildrenCalls = (el.replaceChildrenCalls || 0) + 1;
      children.length = 0;
      children.push(...nodes);
    },
    querySelector(sel) {
      return opts.queryMap?.[sel] || null;
    },
    getBoundingClientRect() {
      return opts.rect || { left: 0, top: 0, width: 200, height: 10 };
    },
    closest() {
      return null;
    }
  };
  return el;
}

function createTimerHarness() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { fn, delay, isInterval: false });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { fn, delay, isInterval: true });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    flushTimeouts(minDelay = 0) {
      for (const [id, entry] of [...timers.entries()]) {
        if (!entry.isInterval && entry.delay >= minDelay) {
          timers.delete(id);
          entry.fn();
        }
      }
    },
    runIntervals() {
      for (const entry of [...timers.values()]) {
        if (entry.isInterval) entry.fn();
      }
    }
  };
}

function loadContentMainHarness() {
  const timers = createTimerHarness();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const postedMessages = [];

  const playEl = createFakeElement('button', { classes: ['playControl', 'playing'] });
  const nextEl = createFakeElement('button', { classes: ['skipControl__next'] });
  nextEl.closest = (sel) => (sel === '.skipControl__next' ? nextEl : null);
  const titleSpan = createFakeElement('span', { textContent: 'Track A' });
  const titleEl = createFakeElement('a', {
    href: 'https://soundcloud.com/artist/track-a?si=abc',
    attrs: { href: 'https://soundcloud.com/artist/track-a?si=abc', title: 'Track A' },
    queryMap: { 'span[aria-hidden="true"]': titleSpan }
  });
  const artistEl = createFakeElement('a', { textContent: 'Artist A' });
  const progressWrap = createFakeElement('div', {
    attrs: { 'aria-valuenow': '42', 'aria-valuemax': '300' },
    rect: { left: 0, top: 0, width: 1000, height: 10 }
  });
  const durationEl = createFakeElement('span', { textContent: '5:00' });
  const wrapperEvents = [];
  const origDispatch = progressWrap.dispatchEvent;
  progressWrap.dispatchEvent = (evt) => {
    wrapperEvents.push(evt);
    return origDispatch(evt);
  };

  const elementsBySelector = {
    '.playControl': playEl,
    '.skipControl__next': nextEl,
    '.playbackSoundBadge__titleLink': titleEl,
    '.playbackSoundBadge__lightLink': artistEl,
    '.playbackTimeline__progressWrapper': progressWrap,
    '.playbackTimeline__duration span:last-child': durationEl
  };

  const registeredHandlers = {};
  let latestPositionState = null;

  const docObj = {
    readyState: 'complete',
    visibilityState: 'visible',
    hasFocus: () => true,
    querySelector: (sel) => elementsBySelector[sel] || null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      documentListeners.get(type)?.delete(fn);
    },
    dispatchEvent: () => true
  };

  const winObj = {
    location: { origin: 'https://soundcloud.com', href: 'https://soundcloud.com/artist/track-a' },
    postMessage(data) {
      postedMessages.push(data);
    },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
    EventSource: undefined,
    XMLHttpRequest: function XHR() {},
    fetch: async () => new Response('{}'),
    AbortController,
    DOMException,
    queueMicrotask,
    navigator: {
      mediaSession: {
        setActionHandler(action, handler) {
          registeredHandlers[action] = handler;
        },
        setPositionState(state) {
          latestPositionState = state;
        }
      }
    },
    Storage: { prototype: { setItem() {} } },
    HTMLMediaElement: { prototype: { play: () => Promise.resolve() } },
    MouseEvent: function MouseEvent(type, init) {
      return { type, ...init };
    },
    URL,
    PopStateEvent: function PopStateEvent(type) {
      return { type };
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    performance: { getEntriesByType: () => [] }
  };
  winObj.window = winObj;
  winObj.document = docObj;
  winObj.self = winObj;

  vm.createContext(winObj);
  winObj.window = vm.runInContext('this', winObj);
  vm.runInContext(CONTENT_MAIN_SRC, winObj);

  function sendBridgeMessage(msg) {
    postedMessages.length = 0;
    const evt = { source: winObj.window, data: { source: 'sc-multiplay', ...msg } };
    for (const fn of [...(windowListeners.get('message') || [])]) {
      fn(evt);
    }
    const resp = postedMessages.find((m) => m.type === 'RESPONSE');
    return resp ? resp.payload : null;
  }

  return {
    winObj,
    timers,
    playEl,
    nextEl,
    titleEl,
    titleSpan,
    progressWrap,
    durationEl,
    wrapperEvents,
    postedMessages,
    registeredHandlers,
    documentListeners,
    sendBridgeMessage,
    getLatestPositionState: () => latestPositionState
  };
}

test('content-main isolates mediaPositionState per track and clears on null reset', () => {
  const h = loadContentMainHarness();

  h.winObj.navigator.mediaSession.setPositionState({ duration: 300, position: 42, playbackRate: 1 });
  const trackAState = h.sendBridgeMessage({ type: 'GET_PLAYER_STATE', requestId: 1 });
  assert.equal(trackAState.durationSec, 300);
  assert.ok(trackAState.currentTimeSec >= 42 && trackAState.currentTimeSec < 43);

  // Switch track DOM before SoundCloud sends a new setPositionState call
  h.titleEl.setAttribute('href', 'https://soundcloud.com/artist/track-b');
  h.titleSpan.textContent = 'Track B';
  h.progressWrap.setAttribute('aria-valuemax', '150');
  h.progressWrap.setAttribute('aria-valuenow', '10');

  const trackBState = h.sendBridgeMessage({ type: 'GET_PLAYER_STATE', requestId: 2 });
  assert.equal(trackBState.durationSec, 150);
  assert.equal(trackBState.currentTimeSec, 10);

  // Set position state on Track B, then reset via setPositionState(null)
  h.winObj.navigator.mediaSession.setPositionState({ duration: 150, position: 25, playbackRate: 1 });
  assert.equal(h.sendBridgeMessage({ type: 'GET_PLAYER_STATE', requestId: 3 }).durationSec, 150);

  h.winObj.navigator.mediaSession.setPositionState(null);
  assert.equal(h.getLatestPositionState(), null);
  h.progressWrap.setAttribute('aria-valuemax', '180');
  h.progressWrap.setAttribute('aria-valuenow', '5');

  const afterReset = h.sendBridgeMessage({ type: 'GET_PLAYER_STATE', requestId: 4 });
  assert.equal(afterReset.durationSec, 180);
  assert.equal(afterReset.currentTimeSec, 5);
});

test('content-main seekDelta uses seekto handler with stacked targets and falls back cleanly without seekforward loops', () => {
  const h = loadContentMainHarness();
  h.progressWrap.setAttribute('aria-valuenow', '20');
  h.progressWrap.setAttribute('aria-valuemax', '200');

  const seekToCalls = [];
  const seekForwardCalls = [];
  h.winObj.navigator.mediaSession.setActionHandler('seekto', (details) => seekToCalls.push(details));
  h.winObj.navigator.mediaSession.setActionHandler('seekforward', (details) => seekForwardCalls.push(details));

  h.sendBridgeMessage({ type: 'PLAYER_COMMAND', command: 'seekDelta', value: 10, requestId: 1 });
  h.sendBridgeMessage({ type: 'PLAYER_COMMAND', command: 'seekDelta', value: 10, requestId: 2 });

  assert.deepEqual(JSON.parse(JSON.stringify(seekToCalls)), [{ seekTime: 30 }, { seekTime: 40 }]);
  assert.equal(seekForwardCalls.length, 0);

  // Without seekto, seekDelta should fall back to progress ratio click using the stacked target
  h.winObj.navigator.mediaSession.setActionHandler('seekto', null);
  h.wrapperEvents.length = 0;
  h.sendBridgeMessage({ type: 'PLAYER_COMMAND', command: 'seekDelta', value: -15, requestId: 3 });
  assert.equal(seekForwardCalls.length, 0);
  assert.equal(h.wrapperEvents[0].type, 'mousedown');
  // targetSec was 40 - 15 = 25 out of 200 -> clientX = (25/200) * 1000 = 125
  assert.equal(h.wrapperEvents[0].clientX, 125);
});

test('content-main only keeps latest saved track and resets on new song, track end, or next', () => {
  const h = loadContentMainHarness();
  h.sendBridgeMessage({ type: 'SET_SAVED_PROGRESS', savedProgress: {}, lastPlayed: null });

  // Play Track A at 45s / 200s -> saves Track A
  h.titleEl.setAttribute('href', 'https://soundcloud.com/artist/track-a');
  h.titleSpan.textContent = 'Track A';
  h.progressWrap.setAttribute('aria-valuenow', '45');
  h.progressWrap.setAttribute('aria-valuemax', '200');
  h.postedMessages.length = 0;
  h.timers.runIntervals();

  let saveMsg = h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS');
  assert.ok(saveMsg);
  assert.equal(saveMsg.trackUrl, 'https://soundcloud.com/artist/track-a');
  assert.equal(saveMsg.remove, false);
  assert.equal(saveMsg.entry.timeSec, 45);
  assert.equal(saveMsg.lastPlayed.trackUrl, 'https://soundcloud.com/artist/track-a');

  // Listening to a new track (Track B at 1s < 5s) resets Track A's saved play time immediately
  h.titleEl.setAttribute('href', 'https://soundcloud.com/artist/track-b');
  h.titleSpan.textContent = 'Track B';
  h.progressWrap.setAttribute('aria-valuenow', '1');
  h.progressWrap.setAttribute('aria-valuemax', '180');
  h.postedMessages.length = 0;
  h.timers.runIntervals();

  saveMsg = h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS');
  assert.ok(saveMsg);
  assert.equal(saveMsg.trackUrl, 'https://soundcloud.com/artist/track-a');
  assert.equal(saveMsg.remove, true);
  assert.equal(saveMsg.lastPlayed, null);

  // Track B reaches 25s -> saved as the single latest track
  h.progressWrap.setAttribute('aria-valuenow', '25');
  h.postedMessages.length = 0;
  h.timers.runIntervals();
  saveMsg = h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS');
  assert.equal(saveMsg.trackUrl, 'https://soundcloud.com/artist/track-b');
  assert.equal(saveMsg.remove, false);
  assert.equal(saveMsg.entry.timeSec, 25);

  // Reaching end of Track B (176s / 180s) resets Track B's saved play time
  h.progressWrap.setAttribute('aria-valuenow', '176');
  h.postedMessages.length = 0;
  h.timers.runIntervals();
  saveMsg = h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS');
  assert.equal(saveMsg.trackUrl, 'https://soundcloud.com/artist/track-b');
  assert.equal(saveMsg.remove, true);
  assert.equal(saveMsg.lastPlayed, null);

  // Save Track C at 30s, then trigger Next -> resets Track C immediately and suppresses stale re-save
  h.titleEl.setAttribute('href', 'https://soundcloud.com/artist/track-c');
  h.titleSpan.textContent = 'Track C';
  h.progressWrap.setAttribute('aria-valuenow', '30');
  h.progressWrap.setAttribute('aria-valuemax', '220');
  h.timers.runIntervals();

  h.postedMessages.length = 0;
  h.sendBridgeMessage({ type: 'PLAYER_COMMAND', command: 'next', requestId: 10 });
  saveMsg = h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS');
  assert.ok(saveMsg);
  assert.equal(saveMsg.trackUrl, 'https://soundcloud.com/artist/track-c');
  assert.equal(saveMsg.remove, true);
  assert.equal(saveMsg.lastPlayed, null);

  // Interval tick right after Next (before DOM switches) does not re-save Track C
  h.postedMessages.length = 0;
  h.timers.runIntervals();
  assert.equal(h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS'), undefined);
});

test('content-main detects track change via setPositionState and supports download cancel', async () => {
  const h = loadContentMainHarness();
  h.sendBridgeMessage({ type: 'SET_SAVED_PROGRESS', savedProgress: {}, lastPlayed: null });

  h.titleEl.setAttribute('href', 'https://soundcloud.com/artist/track-x');
  h.titleSpan.textContent = 'Track X';
  h.progressWrap.setAttribute('aria-valuenow', '40');
  h.progressWrap.setAttribute('aria-valuemax', '200');
  h.timers.runIntervals();

  // Switch to Track Y and fire setPositionState without waiting for the 1500ms interval
  h.titleEl.setAttribute('href', 'https://soundcloud.com/artist/track-y');
  h.titleSpan.textContent = 'Track Y';
  h.progressWrap.setAttribute('aria-valuenow', '1');
  h.postedMessages.length = 0;
  h.winObj.navigator.mediaSession.setPositionState({ duration: 180, position: 1, playbackRate: 1 });
  await new Promise((r) => setTimeout(r, 5));

  const resetMsg = h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS');
  assert.ok(resetMsg);
  assert.equal(resetMsg.trackUrl, 'https://soundcloud.com/artist/track-x');
  assert.equal(resetMsg.remove, true);

  // Cancel download when idle is a no-op and returns idle state
  const cancelResp = h.sendBridgeMessage({ type: 'CANCEL_DOWNLOAD', requestId: 99 });
  assert.equal(cancelResp.status, 'idle');
});

test('background syncs OFF badge and dispatches global commands to target tab', async () => {
  const storageLocal = { enabled: false };
  const storageSession = { selectedTabId: 202 };
  const badgeTexts = [];
  const sentToTabs = [];
  const listeners = { installed: [], startup: [], storage: [], commands: [] };

  const bgContext = {
    chrome: {
      storage: {
        local: {
          async get() {
            return { ...storageLocal };
          }
        },
        session: {
          async get() {
            return { ...storageSession };
          }
        },
        onChanged: {
          addListener(fn) {
            listeners.storage.push(fn);
          }
        }
      },
      action: {
        async setBadgeBackgroundColor() {},
        async setBadgeText(info) {
          badgeTexts.push(info.text);
        }
      },
      tabs: {
        async query() {
          return [
            { id: 201, audible: false, active: false },
            { id: 202, audible: true, active: false }
          ];
        },
        async sendMessage(tabId, msg) {
          sentToTabs.push([tabId, msg]);
        }
      },
      runtime: {
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onStartup: { addListener: (fn) => listeners.startup.push(fn) }
      },
      commands: {
        onCommand: { addListener: (fn) => listeners.commands.push(fn) }
      }
    }
  };

  vm.runInNewContext(BACKGROUND_SRC, bgContext);
  listeners.installed[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(badgeTexts.at(-1), 'OFF');

  storageLocal.enabled = true;
  listeners.storage[0]({ enabled: { newValue: true } }, 'local');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(badgeTexts.at(-1), '');

  await listeners.commands[0]('toggle-play');
  await listeners.commands[0]('next-track');
  assert.deepEqual(JSON.parse(JSON.stringify(sentToTabs)), [
    [202, { type: 'PLAYER_COMMAND', command: 'togglePlay' }],
    [202, { type: 'PLAYER_COMMAND', command: 'next' }]
  ]);
});

test('content-bridge keeps only the latest saved track across concurrent tabs and prunes legacy entries', async () => {
  const storage = { enabled: true, savedProgress: { 'https://soundcloud.com/a/one': { timeSec: 40, updatedAt: 100 } }, lastPlayed: null };
  const onStorageChanged = new Set();
  const locks = new Map();
  const sharedNavigator = {
    locks: {
      request(name, fn) {
        const prev = locks.get(name) || Promise.resolve();
        const next = prev.then(() => fn(), () => fn());
        locks.set(name, next);
        return next;
      }
    }
  };

  function createBridgeTab() {
    const windowListeners = new Map();
    const timers = createTimerHarness();
    const winObj = {
      navigator: sharedNavigator,
      chrome: {
        runtime: { id: 'ext-id', onMessage: { addListener() {} } },
        storage: {
          local: {
            async get(keys) {
              if (typeof keys === 'string') return { [keys]: storage[keys] };
              const out = {};
              for (const k of keys) out[k] = storage[k];
              return out;
            },
            async set(patch) {
              Object.assign(storage, patch);
            },
            async remove(key) {
              delete storage[key];
            }
          },
          onChanged: {
            addListener(fn) {
              onStorageChanged.add(fn);
            }
          }
        }
      },
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(fn);
      },
      postMessage() {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    };
    vm.createContext(winObj);
    winObj.window = vm.runInContext('this', winObj);
    vm.runInContext(CONTENT_BRIDGE_SRC, winObj);
    return {
      sendSave(data) {
        const evt = { source: winObj.window, data: { source: 'sc-multiplay', type: 'SAVE_PROGRESS', ...data } };
        for (const fn of windowListeners.get('message') || []) fn(evt);
      }
    };
  }

  const tabA = createBridgeTab();
  const tabB = createBridgeTab();

  // Wait for initial init() reads
  await new Promise((r) => setTimeout(r, 15));

  // Concurrent updates from both tabs without waiting for cross-tab sync
  tabA.sendSave({
    trackUrl: 'https://soundcloud.com/a/two',
    remove: false,
    entry: { timeSec: 55, updatedAt: 200 },
    lastPlayed: { trackUrl: 'https://soundcloud.com/a/two', timeSec: 55 }
  });
  tabB.sendSave({
    trackUrl: 'https://soundcloud.com/a/three',
    remove: false,
    entry: { timeSec: 75, updatedAt: 300 },
    lastPlayed: { trackUrl: 'https://soundcloud.com/a/three', timeSec: 75 }
  });

  await new Promise((r) => setTimeout(r, 25));

  assert.equal(storage.savedProgress['https://soundcloud.com/a/one'], undefined);
  assert.equal(storage.savedProgress['https://soundcloud.com/a/two'], undefined);
  assert.equal(storage.savedProgress['https://soundcloud.com/a/three'].timeSec, 75);
  assert.equal(Object.keys(storage.savedProgress).length, 1);

  // Removal deletes the targeted track and clears matching lastPlayed
  storage.lastPlayed = { trackUrl: 'https://soundcloud.com/a/three', timeSec: 75 };
  tabA.sendSave({ trackUrl: 'https://soundcloud.com/a/three', remove: true, entry: null, lastPlayed: null });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(Object.keys(storage.savedProgress).length, 0);
  assert.equal(storage.lastPlayed, null);

  // Legacy >1 entries prune down to the 1 newest on save
  for (let i = 0; i < 10; i++) {
    storage.savedProgress[`https://soundcloud.com/a/bulk-${i}`] = { timeSec: 20, updatedAt: i };
  }
  tabB.sendSave({ trackUrl: 'https://soundcloud.com/a/newest', remove: false, entry: { timeSec: 12, updatedAt: 9999 }, lastPlayed: null });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(Object.keys(storage.savedProgress).length, 1);
  assert.ok(storage.savedProgress['https://soundcloud.com/a/newest']);
  assert.equal(storage.savedProgress['https://soundcloud.com/a/bulk-0'], undefined);
});

test('popup focuses tab window, avoids redundant tabsBar rebuilds, resets copy errors, and releases stuck volume drag', async () => {
  const timers = createTimerHarness();
  const windowListeners = new Map();

  const btnLike = createFakeElement('button', {
    id: 'btn-like',
    queryMap: {
      '.icon-heart-outline': createFakeElement('svg'),
      '.icon-heart-solid': createFakeElement('svg')
    }
  });
  const btnFollow = createFakeElement('button', {
    id: 'btn-follow',
    queryMap: {
      '.icon-follow-add': createFakeElement('svg'),
      '.icon-follow-check': createFakeElement('svg')
    }
  });
  const btnCopy = createFakeElement('button', {
    id: 'btn-copy',
    queryMap: {
      '.icon-copy-link': createFakeElement('svg'),
      '.icon-copy-done': createFakeElement('svg')
    }
  });

  const elementsById = {
    toggle: createFakeElement('input', { id: 'toggle', type: 'checkbox' }),
    'status-card': createFakeElement('div'),
    'status-text': createFakeElement('span'),
    'tabs-bar': createFakeElement('div'),
    'empty-state': createFakeElement('div'),
    'empty-message': createFakeElement('p'),
    'resume-card': createFakeElement('div'),
    'resume-title': createFakeElement('div'),
    'resume-time': createFakeElement('div'),
    'resume-btn': createFakeElement('button'),
    'clear-resume-btn': createFakeElement('button'),
    'open-sc-btn': createFakeElement('button'),
    'player-content': createFakeElement('div'),
    artwork: createFakeElement('img'),
    'artwork-fallback': createFakeElement('div'),
    'track-title': createFakeElement('div'),
    'track-title-marquee': createFakeElement('span'),
    'track-title-text': createFakeElement('span'),
    'track-title-clone': createFakeElement('span'),
    'track-artist': createFakeElement('div'),
    'focus-tab-btn': createFakeElement('button'),
    'progress-range': createFakeElement('input', { id: 'progress-range', value: '0' }),
    'time-passed': createFakeElement('span'),
    'time-duration': createFakeElement('span'),
    'btn-shuffle': createFakeElement('button'),
    'btn-prev': createFakeElement('button'),
    'btn-back10': createFakeElement('button'),
    'btn-play': createFakeElement('button'),
    'icon-play': createFakeElement('svg'),
    'icon-pause': createFakeElement('svg'),
    'btn-fwd10': createFakeElement('button'),
    'btn-next': createFakeElement('button'),
    'btn-repeat': createFakeElement('button'),
    'repeat-badge': createFakeElement('span'),
    'btn-mute': createFakeElement('button'),
    'icon-vol': createFakeElement('svg'),
    'icon-muted': createFakeElement('svg'),
    'volume-range': createFakeElement('input', { id: 'volume-range', value: '100' }),
    'volume-value': createFakeElement('span'),
    'btn-like': btnLike,
    'like-text': createFakeElement('span'),
    'btn-follow': btnFollow,
    'follow-text': createFakeElement('span'),
    'btn-copy': btnCopy,
    'copy-text': createFakeElement('span', { textContent: 'Copy link' }),
    'btn-download': createFakeElement('button'),
    'download-fill': createFakeElement('div'),
    'download-text': createFakeElement('span', { textContent: 'Download track' }),
    'lan-card': createFakeElement('section'),
    'lan-status': createFakeElement('span'),
    'lan-toggle': createFakeElement('input', { id: 'lan-toggle', type: 'checkbox' }),
    'lan-body': createFakeElement('div'),
    'lan-pairing': createFakeElement('div'),
    'lan-qr-svg': createFakeElement('svg'),
    'lan-pin': createFakeElement('span'),
    'lan-url-btn': createFakeElement('button'),
    'lan-url-text': createFakeElement('span'),
    'lan-offline': createFakeElement('div'),
    'lan-offline-text': createFakeElement('p'),
    'lan-copy-setup-btn': createFakeElement('button'),
    'lan-retry-btn': createFakeElement('button')
  };

  let mockState = {
    hasTrack: true,
    isPlaying: true,
    title: 'Song One',
    artist: 'Artist One',
    trackUrl: 'https://soundcloud.com/a/one?in=mix',
    currentTimeSec: 30,
    durationSec: 120,
    currentTimeText: '0:30',
    durationText: '2:00',
    repeat: 'none',
    muted: false,
    volume: 0.8
  };

  const tabUpdates = [];
  const windowUpdates = [];
  const copiedTexts = [];
  const sentMessages = [];
  let shouldRejectClipboard = true;
  let closed = false;

  const popupContext = {
    document: {
      getElementById: (id) => elementsById[id],
      createElement: (tag) => createFakeElement(tag),
      addEventListener() {}
    },
    window: null,
    navigator: {
      clipboard: {
        async writeText(text) {
          if (shouldRejectClipboard) throw new Error('clipboard blocked');
          copiedTexts.push(text);
        }
      }
    },
    chrome: {
      storage: {
        local: {
          async get() {
            return { enabled: true, lastPlayed: null };
          },
          async set() {}
        }
      },
      tabs: {
        async query() {
          return [
            { id: 101, windowId: 55, audible: true, active: false, title: 'Stream Song One | Listen online' },
            { id: 102, windowId: 56, audible: false, active: true, title: 'Discover' }
          ];
        },
        async sendMessage(tabId, msg) {
          sentMessages.push([tabId, msg]);
          if (msg?.type === 'CANCEL_DOWNLOAD') {
            return { ok: true, downloadState: { status: 'idle', progress: 0, error: '', filename: '', id: 1 } };
          }
          if (tabId === 102) {
            return { ok: true, state: { hasTrack: false } };
          }
          return { ok: true, state: { ...mockState } };
        },
        async update(tabId, props) {
          tabUpdates.push([tabId, props]);
        }
      },
      windows: {
        async update(winId, props) {
          windowUpdates.push([winId, props]);
        }
      }
    },
    URL,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    requestAnimationFrame: (fn) => fn(),
    close() {
      closed = true;
    }
  };
  popupContext.window = {
    close: popupContext.close,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    }
  };

  vm.runInNewContext(POPUP_SRC, popupContext);
  await new Promise((r) => setTimeout(r, 15));

  // Finding 5: second identical refreshState poll does not rebuild tabsBar DOM
  const tabsBar = elementsById['tabs-bar'];
  assert.equal(tabsBar.replaceChildrenCalls, 1);
  const firstChip = tabsBar.children[0];
  await popupContext.refreshState();
  assert.equal(tabsBar.replaceChildrenCalls, 1);
  assert.equal(tabsBar.children[0], firstChip);

  // Finding 4: focusTabBtn focuses both tab and window
  elementsById['focus-tab-btn'].click();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(JSON.parse(JSON.stringify(tabUpdates)), [[101, { active: true }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(windowUpdates)), [[55, { focused: true }]]);
  assert.equal(closed, true);

  // Finding 4: openScBtn also focuses window
  tabUpdates.length = 0;
  windowUpdates.length = 0;
  elementsById['open-sc-btn'].click();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(JSON.parse(JSON.stringify(tabUpdates)), [[101, { active: true }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(windowUpdates)), [[55, { focused: true }]]);

  // Finding 6: failed clipboard copy shows 'Copy failed' then resets after 1800ms
  btnCopy.click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(elementsById['copy-text'].textContent, 'Copy failed');
  timers.flushTimeouts(1800);
  assert.equal(elementsById['copy-text'].textContent, 'Copy link');

  // Finding 6: successful copy resets immediately when switching tracks
  shouldRejectClipboard = false;
  btnCopy.click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(elementsById['copy-text'].textContent, 'Copied!');
  mockState = { ...mockState, trackUrl: 'https://soundcloud.com/a/two' };
  await popupContext.refreshState();
  assert.equal(elementsById['copy-text'].textContent, 'Copy link');
  assert.equal(btnCopy.classList.contains('copied'), false);

  // Finding 9: pointerup clears isDraggingVolume so muted sync updates slider
  const volRange = elementsById['volume-range'];
  volRange.value = '65';
  volRange.dispatchEvent({ type: 'input' });
  for (const fn of windowListeners.get('pointerup') || []) fn({ type: 'pointerup' });
  mockState = { ...mockState, muted: true, volume: 0.65 };
  await popupContext.refreshState();
  assert.equal(volRange.value, '0');

  // Song title sliding: activates when overflowing, stays active across polls, and resets on short title
  const trackTitle = elementsById['track-title'];
  const trackTitleText = elementsById['track-title-text'];
  const trackTitleClone = elementsById['track-title-clone'];
  trackTitle.clientWidth = 180;
  trackTitle.scrollWidth = 340;

  const longTitle = 'A Very Long SoundCloud Track Title That Needs Sliding Marquee';
  mockState = { ...mockState, title: longTitle };
  await popupContext.refreshState();
  assert.equal(trackTitleText.textContent, longTitle);
  assert.equal(trackTitleClone.textContent, longTitle);
  assert.equal(trackTitle.classList.contains('is-sliding'), true);
  assert.ok(trackTitle.style['--slide-duration']);

  // Polling with the same title preserves sliding state
  await popupContext.refreshState();
  assert.equal(trackTitle.classList.contains('is-sliding'), true);

  // Switching to a short title disables sliding and clears clone
  trackTitle.scrollWidth = 110;
  mockState = { ...mockState, title: 'Short' };
  await popupContext.refreshState();
  assert.equal(trackTitleText.textContent, 'Short');
  assert.equal(trackTitleClone.textContent, '');
  assert.equal(trackTitle.classList.contains('is-sliding'), false);

  // Clicking #track-title copies "Artist - Title" and shows copied state
  copiedTexts.length = 0;
  trackTitle.click();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(copiedTexts[0], 'Artist One - Short');
  assert.equal(trackTitle.classList.contains('copied'), true);

  // Clicking download while downloading sends CANCEL_DOWNLOAD
  mockState = { ...mockState, downloadState: { status: 'downloading', progress: 42, error: '', filename: '', id: 5 } };
  await popupContext.refreshState();
  assert.equal(elementsById['btn-download'].classList.contains('downloading'), true);
  sentMessages.length = 0;
  elementsById['btn-download'].click();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sentMessages.some(([, m]) => m.type === 'CANCEL_DOWNLOAD'));
  assert.equal(elementsById['btn-download'].classList.contains('downloading'), false);

  // Copy setup button generates a path-independent PowerShell command
  copiedTexts.length = 0;
  shouldRejectClipboard = false;
  popupContext.renderLanState({
    lanEnabled: true,
    connected: false,
    mobileCount: 0,
    serverInfo: null,
    nativeError: 'Specified native messaging host not found.',
    extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });
  elementsById['lan-copy-setup-btn'].click();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(copiedTexts[0].includes('powershell -NoProfile -ExecutionPolicy Bypass -File'));
  assert.ok(copiedTexts[0].includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.ok(copiedTexts[0].includes('install-native-host.ps1'));
});

test('content-main preserves saved progress across long pauses, stale media position, remaining-time UI, and idle resets', () => {
  const h = loadContentMainHarness();
  h.sendBridgeMessage({ type: 'SET_SAVED_PROGRESS', savedProgress: {}, lastPlayed: null });

  // Play Track A to 90s / 240s so savedProgress and restoredTracks are populated
  h.titleEl.setAttribute('href', 'https://soundcloud.com/artist/track-a');
  h.titleSpan.textContent = 'Track A';
  h.progressWrap.setAttribute('aria-valuenow', '90');
  h.progressWrap.setAttribute('aria-valuemax', '240');
  h.winObj.navigator.mediaSession.setPositionState({ duration: 240, position: 90, playbackRate: 1 });
  h.timers.runIntervals();

  let saveMsg = h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS');
  assert.ok(saveMsg);
  assert.equal(saveMsg.entry.timeSec, 90);

  // Pause Track A (playbackRate: 0) and simulate leaving it idle for 2 hours
  h.playEl.classList.remove('playing');
  h.winObj.navigator.mediaSession.setPositionState({ duration: 240, position: 90, playbackRate: 0 });
  const vmDate = vm.runInContext('Date', h.winObj);
  const realDateNow = vmDate.now;
  let fakeNow = realDateNow();
  vmDate.now = () => fakeNow;
  try {
    fakeNow += 2 * 60 * 60 * 1000;

    // Even if aria-valuenow is missing/empty and hidden fires, stale mediaPositionState must not extrapolate to end
    h.progressWrap.setAttribute('aria-valuenow', '');
    h.postedMessages.length = 0;
    for (const fn of h.documentListeners.get('visibilitychange') || []) {
      h.winObj.document.visibilityState = 'hidden';
      fn({});
    }
    assert.equal(h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS' && m.remove), undefined);

    // If paused track drops to 0:00 while idle and user later presses Play, restore seeks back to 90s
    h.progressWrap.setAttribute('aria-valuenow', '0');
    h.winObj.document.visibilityState = 'visible';
    h.timers.runIntervals(); // sees paused at 0s, allows re-restore
    h.playEl.classList.add('playing');
    h.wrapperEvents.length = 0;
    h.timers.runIntervals();
    h.timers.flushTimeouts(350);
    assert.equal(h.wrapperEvents[0]?.type, 'mousedown');
    // 90 / 240 * 1000 = 375
    assert.equal(h.wrapperEvents[0]?.clientX, 375);

    // Manual prev click keeps track at 0:00 instead of bouncing back to 90s
    h.progressWrap.setAttribute('aria-valuenow', '1');
    h.sendBridgeMessage({ type: 'PLAYER_COMMAND', command: 'prev', requestId: 50 });
    h.wrapperEvents.length = 0;
    h.timers.runIntervals();
    h.timers.flushTimeouts(350);
    assert.equal(h.wrapperEvents.length, 0);

    // Remaining-time display (e.g. "-1:10") without aria-valuemax or mediaPositionState does not trigger end-of-track reset
    h.winObj.navigator.mediaSession.setPositionState(null);
    h.progressWrap.setAttribute('aria-valuemax', '');
    h.durationEl.textContent = '-1:10';
    h.progressWrap.setAttribute('aria-valuenow', '90');
    h.playEl.classList.remove('playing');
    h.postedMessages.length = 0;
    for (const fn of h.documentListeners.get('visibilitychange') || []) {
      h.winObj.document.visibilityState = 'hidden';
      fn({});
    }
    assert.equal(h.postedMessages.find((m) => m.type === 'SAVE_PROGRESS' && m.remove), undefined);
  } finally {
    vmDate.now = realDateNow;
  }
});

test('content-bridge removal of a stale track does not clear lastPlayed for a newer track', async () => {
  const storage = {
    enabled: true,
    savedProgress: { 'https://soundcloud.com/a/active': { timeSec: 55, updatedAt: 200 } },
    lastPlayed: { trackUrl: 'https://soundcloud.com/a/active', timeSec: 55, updatedAt: 200 }
  };
  const windowListeners = new Map();
  const timers = createTimerHarness();
  const winObj = {
    navigator: {},
    chrome: {
      runtime: { id: 'ext-id', onMessage: { addListener() {} } },
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: storage[keys] };
            const out = {};
            for (const k of keys) out[k] = storage[k];
            return out;
          },
          async set(patch) {
            Object.assign(storage, patch);
          },
          async remove(key) {
            delete storage[key];
          }
        },
        onChanged: { addListener() {} }
      }
    },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    postMessage() {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  };
  vm.createContext(winObj);
  winObj.window = vm.runInContext('this', winObj);
  vm.runInContext(CONTENT_BRIDGE_SRC, winObj);
  await new Promise((r) => setTimeout(r, 15));

  const evt = {
    source: winObj.window,
    data: {
      source: 'sc-multiplay',
      type: 'SAVE_PROGRESS',
      trackUrl: 'https://soundcloud.com/a/old',
      remove: true,
      entry: null,
      lastPlayed: null
    }
  };
  for (const fn of windowListeners.get('message') || []) fn(evt);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(storage.lastPlayed.trackUrl, 'https://soundcloud.com/a/active');
  assert.equal(storage.savedProgress['https://soundcloud.com/a/active'].timeSec, 55);
});

test('popup/qr generates valid QR matrix with finder patterns for LAN pairing URL', () => {
  const qrSrc = fs.readFileSync(path.join(ROOT, 'popup', 'qr.js'), 'utf8');
  const ctx = {
    TextEncoder,
    Uint8Array,
    globalThis: null
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(qrSrc, ctx);

  const matrix = ctx.scQr.createQrMatrix('http://192.168.1.42:3847/?pin=123456');
  assert.ok(Array.isArray(matrix));
  const size = matrix.length;
  assert.ok(size >= 29 && size <= 37);
  // Top-left finder pattern center (3,3) and border (0,0) must be dark (1)
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[3][3], 1);
  assert.equal(matrix[1][1], 0);
  // Top-right and bottom-left finder centers
  assert.equal(matrix[3][size - 4], 1);
  assert.equal(matrix[size - 4][3], 1);
});

test('background LAN bridge connects, relays commands, and responds to LAN_GET_STATUS', async () => {
  const storageLocal = {
    enabled: true,
    lanEnabled: true,
    lanPort: 3999,
    savedProgress: { 'https://soundcloud.com/a/old': { timeSec: 45, updatedAt: 100 } },
    lastPlayed: { trackUrl: 'https://soundcloud.com/a/old', timeSec: 45, durationSec: 180 }
  };
  const sentToTabs = [];
  const createdAlarms = [];
  const wsSent = [];
  const wsListeners = new Map();
  const nativeHostsConnected = [];
  let nativeMsgListener = null;
  let messageListener = null;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
    }
    addEventListener(type, fn) {
      if (!wsListeners.has(type)) wsListeners.set(type, new Set());
      wsListeners.get(type).add(fn);
    }
    send(data) {
      wsSent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
    }
  }

  const bgContext = {
    URL,
    WebSocket: FakeWebSocket,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: storageLocal[keys] };
            if (Array.isArray(keys)) {
              const out = {};
              for (const k of keys) out[k] = storageLocal[k];
              return out;
            }
            return { ...storageLocal };
          },
          async set(patch) {
            Object.assign(storageLocal, patch);
          }
        },
        session: {
          async get() { return { selectedTabId: 301 }; },
          async set() {}
        },
        onChanged: { addListener() {} }
      },
      action: {
        async setBadgeBackgroundColor() {},
        async setBadgeText() {}
      },
      alarms: {
        create(name, opts) { createdAlarms.push([name, opts]); },
        clear() {},
        onAlarm: { addListener() {} }
      },
      tabs: {
        async query() {
          return [{ id: 301, audible: true, active: true, url: 'https://soundcloud.com/discover', title: 'Track X' }];
        },
        async sendMessage(tabId, msg) {
          sentToTabs.push([tabId, msg]);
          return { ok: true, state: { hasTrack: true, isPlaying: true, title: 'Track X' } };
        },
        async update() {}
      },
      runtime: {
        id: 'ext-test-id',
        connectNative(name) {
          nativeHostsConnected.push(name);
          return {
            onMessage: { addListener(fn) { nativeMsgListener = fn; } },
            onDisconnect: { addListener() {} },
            postMessage() {},
            disconnect() {}
          };
        },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: {
          addListener(fn) { messageListener = fn; }
        }
      },
      commands: {
        onCommand: { addListener() {} }
      }
    }
  };

  vm.runInNewContext(BACKGROUND_SRC, bgContext);
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(createdAlarms[0]?.[0], 'lan-keepalive');
  assert.deepEqual(nativeHostsConnected, ['com.soundcloud.multiplay.lan']);
  nativeMsgListener({ type: 'NATIVE_READY', alreadyRunning: false, lanIp: '192.168.1.5', port: 3999, pin: '654321', url: 'http://192.168.1.5:3999/?pin=654321', shortUrl: 'http://192.168.1.5:3999' });

  // Simulate SERVER_INFO and PLAYER_COMMAND from companion server
  for (const fn of wsListeners.get('message') || []) {
    fn({ data: JSON.stringify({ type: 'SERVER_INFO', lanIp: '192.168.1.5', port: 3999, pin: '654321', url: 'http://192.168.1.5:3999/?pin=654321', shortUrl: 'http://192.168.1.5:3999', mobileCount: 0 }) });
  }
  for (const fn of wsListeners.get('message') || []) {
    fn({ data: JSON.stringify({ type: 'PLAYER_COMMAND', command: 'togglePlay' }) });
  }
  await new Promise((r) => setTimeout(r, 15));

  assert.deepEqual(JSON.parse(JSON.stringify(sentToTabs)), [
    [301, { type: 'PLAYER_COMMAND', command: 'togglePlay' }]
  ]);
  assert.ok(wsSent.some((m) => m.type === 'STATE_UPDATE' && m.state?.title === 'Track X'));

  // Verify LAN_GET_STATUS returns cached serverInfo
  const statusResp = await new Promise((resolve) => {
    messageListener({ type: 'LAN_GET_STATUS' }, {}, resolve);
  });
  assert.equal(statusResp.ok, true);
  assert.equal(statusResp.connected, true);
  assert.equal(statusResp.serverInfo.pin, '654321');

  // PLAY_URL clears savedProgress and lastPlayed
  for (const fn of wsListeners.get('message') || []) {
    fn({ data: JSON.stringify({ type: 'PLAY_URL', url: 'https://soundcloud.com/artist/new-track' }) });
  }
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(JSON.parse(JSON.stringify(storageLocal.savedProgress)), {});
  assert.equal(storageLocal.lastPlayed, null);
  assert.equal(storageLocal.pendingResume.trackUrl, 'https://soundcloud.com/artist/new-track');
});

test('content-main finds and clicks MUI Play button inside shadowRoot on PLAY_ON_PAGE', () => {
  const h = loadContentMainHarness();
  h.playEl.classList.remove('playing');
  h.titleEl.setAttribute('href', '');
  h.winObj.getComputedStyle = () => ({ display: 'inline-flex', visibility: 'visible' });
  let muiClicked = false;
  const muiBtn = createFakeElement('button', {
    classes: ['MuiButtonBase-root', 'MuiButton-root'],
    attrs: { 'aria-label': 'Play' }
  });
  muiBtn.addEventListener('click', () => {
    muiClicked = true;
  });

  const shadowHost = createFakeElement('div');
  shadowHost.shadowRoot = {
    querySelectorAll: (sel) => (sel.includes('MuiButtonBase-root') || sel.includes('aria-label="Play"') ? [muiBtn] : [])
  };

  h.winObj.document.querySelectorAll = (sel) => (sel === '*' ? [shadowHost] : []);
  h.sendBridgeMessage({
    type: 'PLAY_ON_PAGE',
    targetUrl: 'https://soundcloud.com/artist/track-a',
    timeSec: 0,
    requestedAt: Date.now(),
    allowHidden: true
  });

  assert.equal(muiClicked, true);
});
