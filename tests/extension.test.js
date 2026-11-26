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
    }
  };
}

function loadContentMainHarness() {
  const timers = createTimerHarness();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const postedMessages = [];

  const playEl = createFakeElement('button', { classes: ['playControl', 'playing'] });
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
  const wrapperEvents = [];
  const origDispatch = progressWrap.dispatchEvent;
  progressWrap.dispatchEvent = (evt) => {
    wrapperEvents.push(evt);
    return origDispatch(evt);
  };

  const elementsBySelector = {
    '.playControl': playEl,
    '.playbackSoundBadge__titleLink': titleEl,
    '.playbackSoundBadge__lightLink': artistEl,
    '.playbackTimeline__progressWrapper': progressWrap
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
    titleEl,
    titleSpan,
    progressWrap,
    wrapperEvents,
    postedMessages,
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

test('content-bridge merges SAVE_PROGRESS writes per track across concurrent tabs and caps at 50 entries', async () => {
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

  assert.ok(storage.savedProgress['https://soundcloud.com/a/one']);
  assert.equal(storage.savedProgress['https://soundcloud.com/a/two'].timeSec, 55);
  assert.equal(storage.savedProgress['https://soundcloud.com/a/three'].timeSec, 75);

  // Removal deletes only the targeted track
  tabA.sendSave({ trackUrl: 'https://soundcloud.com/a/two', remove: true, entry: null, lastPlayed: storage.lastPlayed });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(storage.savedProgress['https://soundcloud.com/a/two'], undefined);
  assert.equal(storage.savedProgress['https://soundcloud.com/a/three'].timeSec, 75);

  // Seeding >50 entries prunes down to 50 newest
  for (let i = 0; i < 55; i++) {
    storage.savedProgress[`https://soundcloud.com/a/bulk-${i}`] = { timeSec: 20, updatedAt: i };
  }
  tabB.sendSave({ trackUrl: 'https://soundcloud.com/a/newest', remove: false, entry: { timeSec: 12, updatedAt: 9999 }, lastPlayed: null });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(Object.keys(storage.savedProgress).length, 50);
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
    'download-text': createFakeElement('span', { textContent: 'Download track' })
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
        async writeText() {
          if (shouldRejectClipboard) throw new Error('clipboard blocked');
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
        async sendMessage() {
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
});
