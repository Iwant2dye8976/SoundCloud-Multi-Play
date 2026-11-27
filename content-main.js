(() => {
  'use strict';

  const MSG_SOURCE = 'sc-multiplay';
  const TRINITY_SUB_RE = /\/tsub\/subscribe\b/i;
  const TRINITY_PUB_RE = /\/tpub\/publish\b/i;
  let enabled = true;
  let capturedClientId = '';
  let downloadSeq = 0;
  let downloadResetTimer = null;
  let downloadState = { status: 'idle', progress: 0, error: '', filename: '', id: 0 };
  let savedProgress = {};
  let savedProgressLoaded = false;
  let lastPlayed = null;
  const restoredTracks = new Set();
  const restoreSeekAttempts = new Map();
  let lastSavedSignature = '';
  let suppressedSaveTrackUrl = '';
  let suppressedSaveUntil = 0;
  let pendingResume = null;
  let pendingSeekTargetSec = 0;
  let pendingSeekUntil = 0;
  const mediaSessionHandlers = {};
  let mediaPositionState = null;
  let mediaPositionUpdatedAt = 0;

  // 0. Capture SoundCloud's MediaSession handlers (same API used by Edge/Chrome Media Control Center)
  if (navigator.mediaSession) {
    const ms = navigator.mediaSession;
    if (typeof ms.setActionHandler === 'function') {
      const origSetActionHandler = ms.setActionHandler.bind(ms);
      ms.setActionHandler = function (action, handler) {
        if (handler) {
          mediaSessionHandlers[action] = handler;
        } else {
          delete mediaSessionHandlers[action];
        }
        const wrappedHandler =
          action === 'nexttrack' && typeof handler === 'function'
            ? function (...args) {
                resetSavedOnNext();
                return handler.apply(this, args);
              }
            : handler;
        return origSetActionHandler(action, wrappedHandler);
      };
    }
    if (typeof ms.setPositionState === 'function') {
      const origSetPositionState = ms.setPositionState.bind(ms);
      ms.setPositionState = function (state) {
        if (state && typeof state === 'object') {
          const trackHref = document.querySelector('.playbackSoundBadge__titleLink')?.href || '';
          mediaPositionState = {
            trackUrl: normalizeTrackUrl(trackHref),
            duration: Number(state.duration) || 0,
            position: Number(state.position) || 0,
            playbackRate: Number(state.playbackRate) || 1
          };
          mediaPositionUpdatedAt = Date.now();
        } else {
          mediaPositionState = null;
        }
        return origSetPositionState(state);
      };
    }
  }
  let resumeAttemptCount = 0;
  let lastResumeClickAt = 0;
  let resumeRetryTimer = null;
  let waitingForUserGesture = false;
  const RESUME_TTL_MS = 30000;
  const MAX_RESUME_CLICKS = 15;

  function normalizeTrackUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(String(url), location.origin);
      const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
      return `${parsed.protocol}//${host}${path}`;
    } catch {
      return String(url).split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
    }
  }

  function captureClientIdFromUrl(url) {
    if (!url || !String(url).includes('client_id=')) return;
    try {
      const parsed = new URL(String(url), location.origin);
      if (!parsed.hostname.endsWith('soundcloud.com')) return;
      const cid = parsed.searchParams.get('client_id');
      if (cid) capturedClientId = cid;
    } catch {
      // Ignore malformed URLs
    }
  }

  function findClientId() {
    if (capturedClientId) return capturedClientId;
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].name.includes('client_id=')) {
          captureClientIdFromUrl(entries[i].name);
          if (capturedClientId) return capturedClientId;
        }
      }
    } catch {
      // Ignore performance API errors
    }
    return '';
  }

  function isTrinityStopPayload(raw) {
    if (!raw) return false;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const action = parsed && parsed.action;
      return typeof action === 'string' && action.toUpperCase().replace(/-/g, '_') === 'STOP';
    } catch {
      return false;
    }
  }

  function isTrinityBroadcastStop(key, newValue) {
    if (!key || !String(key).includes('trinity-broadcast') || !newValue) return false;
    try {
      const parsed = JSON.parse(newValue);
      if (!parsed) return false;
      if (
        (parsed.event === 'banana-bus-action' || parsed.event === 'action') &&
        typeof parsed.data === 'string' &&
        parsed.data.toUpperCase().replace(/-/g, '_') === 'STOP'
      ) {
        return true;
      }
      if (parsed.event === 'banana-bus-data' && isTrinityStopPayload(parsed.data)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // 1. Filter out "stop" actions on SoundCloud's Trinity SSE stream (tsub/subscribe)
  const OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    class WrappedEventSource extends OrigEventSource {
      constructor(url, eventSourceInitDict) {
        if (eventSourceInitDict !== undefined) {
          super(url, eventSourceInitDict);
        } else {
          super(url);
        }

        if (!TRINITY_SUB_RE.test(String(url))) return;

        let userOnMessage = null;
        const listenerMap = new WeakMap();
        const origAdd = EventTarget.prototype.addEventListener.bind(this);
        const origRemove = EventTarget.prototype.removeEventListener.bind(this);

        Object.defineProperty(this, 'onmessage', {
          configurable: true,
          enumerable: true,
          get() {
            return userOnMessage;
          },
          set(fn) {
            if (userOnMessage && listenerMap.has(userOnMessage)) {
              origRemove('message', listenerMap.get(userOnMessage));
            }
            userOnMessage = typeof fn === 'function' ? fn : null;
            if (userOnMessage) {
              const targetFn = userOnMessage;
              const wrapped = (event) => {
                if (enabled && isTrinityStopPayload(event.data)) return;
                return targetFn.call(this, event);
              };
              listenerMap.set(targetFn, wrapped);
              origAdd('message', wrapped);
            }
          }
        });

        this.addEventListener = function (type, listener, options) {
          if (type === 'message' && typeof listener === 'function') {
            let wrapped = listenerMap.get(listener);
            if (!wrapped) {
              wrapped = (event) => {
                if (enabled && isTrinityStopPayload(event.data)) return;
                return listener.call(this, event);
              };
              listenerMap.set(listener, wrapped);
            }
            return origAdd(type, wrapped, options);
          }
          return origAdd(type, listener, options);
        };

        this.removeEventListener = function (type, listener, options) {
          if (type === 'message' && listener && listenerMap.has(listener)) {
            return origRemove(type, listenerMap.get(listener), options);
          }
          return origRemove(type, listener, options);
        };
      }
    }

    window.EventSource = WrappedEventSource;
  }

  // 2. Stub tpub/publish and passively capture client_id from API requests
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  const xhrUrlMap = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url) {
    const urlStr = String(url);
    xhrUrlMap.set(this, urlStr);
    captureClientIdFromUrl(urlStr);
    return origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const url = xhrUrlMap.get(this);
    if (enabled && url && TRINITY_PUB_RE.test(url)) {
      const xhr = this;
      Object.defineProperties(xhr, {
        readyState: { configurable: true, get: () => 4 },
        status: { configurable: true, get: () => 200 },
        statusText: { configurable: true, get: () => 'OK' },
        responseText: { configurable: true, get: () => '{}' },
        response: { configurable: true, get: () => '{}' }
      });
      setTimeout(() => {
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new ProgressEvent('load'));
        xhr.dispatchEvent(new ProgressEvent('loadend'));
      }, 0);
      return;
    }
    return origXHRSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      captureClientIdFromUrl(url);
      if (enabled && TRINITY_PUB_RE.test(url)) {
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json' }
          })
        );
      }
      return origFetch.apply(this, arguments);
    };
  }

  // 3. Block localStorage trinity-broadcast "stop" propagation between same-browser tabs
  const origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (enabled && isTrinityBroadcastStop(key, value)) {
      return;
    }
    return origSetItem.apply(this, arguments);
  };

  window.addEventListener(
    'storage',
    (event) => {
      if (enabled && isTrinityBroadcastStop(event.key, event.newValue)) {
        event.stopImmediatePropagation();
      }
    },
    true
  );

  // 4. Player state reader, controls, seeking, and track downloader
  function parseTimeStr(str) {
    if (!str) return 0;
    const clean = str.trim().replace(/^-/, '');
    const parts = clean.split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
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

  function extractArtworkUrl() {
    const span = document.querySelector('.playbackSoundBadge__avatar span[style]');
    if (!span) return '';
    const bg = span.style.backgroundImage || '';
    const match = bg.match(/url\(["']?([^"')]+)["']?\)/i);
    return match ? match[1] : '';
  }

  function getPlayerState() {
    const playEl = document.querySelector('.playControl');
    const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
    const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
    const progressWrap = document.querySelector('.playbackTimeline__progressWrapper');
    const timePassedEl = document.querySelector('.playbackTimeline__timePassed span:last-child');
    const durationEl = document.querySelector('.playbackTimeline__duration span:last-child');
    const shuffleEl = document.querySelector('.shuffleControl');
    const repeatEl = document.querySelector('.repeatControl');
    const volEl = document.querySelector('.volume__button');
    const volSlider = document.querySelector('.volume__sliderWrapper[role="slider"]');
    const likeEl = document.querySelector('.playbackSoundBadge__like');
    const followEl = document.querySelector('.playbackSoundBadge__follow');

    const hasTrack = Boolean(
      titleEl &&
      titleEl.getAttribute('href') &&
      playEl &&
      !playEl.classList.contains('disabled')
    );

    const visibleTitle =
      titleEl?.querySelector('span[aria-hidden="true"]')?.textContent?.trim() ||
      titleEl?.getAttribute('title')?.trim() ||
      '';

    const ariaNow = Number(progressWrap?.getAttribute('aria-valuenow'));
    const ariaMax = Number(progressWrap?.getAttribute('aria-valuemax'));
    const timePassedText = timePassedEl?.textContent?.trim() || '0:00';
    const durationRawText = durationEl?.textContent?.trim() || '0:00';
    const isPlaying = Boolean(playEl?.classList.contains('playing'));

    let currentTimeSec = Number.isFinite(ariaNow) && ariaNow >= 0
      ? ariaNow
      : parseTimeStr(timePassedText);
    let durationSec = Number.isFinite(ariaMax) && ariaMax > 0
      ? ariaMax
      : parseTimeStr(durationRawText);

    const currentTrackNorm = normalizeTrackUrl(titleEl?.href);
    const hasMatchingMediaPos = Boolean(
      mediaPositionState &&
      mediaPositionState.duration > 0 &&
      (!mediaPositionState.trackUrl || !currentTrackNorm || mediaPositionState.trackUrl === currentTrackNorm)
    );
    if (hasMatchingMediaPos) {
      durationSec = mediaPositionState.duration;
      const elapsed = isPlaying
        ? ((Date.now() - mediaPositionUpdatedAt) / 1000) * (mediaPositionState.playbackRate || 1)
        : 0;
      const msPos = Math.min(durationSec, Math.max(0, mediaPositionState.position + elapsed));
      if (Math.abs(msPos - currentTimeSec) <= 3 || !Number.isFinite(ariaNow)) {
        currentTimeSec = msPos;
      }
    }

    let repeatMode = 'none';
    if (repeatEl?.classList.contains('m-one')) repeatMode = 'one';
    else if (repeatEl?.classList.contains('m-all')) repeatMode = 'all';

    const volVal = Number(volSlider?.getAttribute('aria-valuenow'));

    return {
      hasTrack,
      isPlaying: Boolean(playEl?.classList.contains('playing')),
      title: visibleTitle,
      artist: artistEl?.textContent?.trim() || '',
      trackUrl: titleEl?.href || '',
      artworkUrl: extractArtworkUrl(),
      currentTimeSec,
      durationSec,
      currentTimeText: formatTime(currentTimeSec),
      durationText: formatTime(durationSec),
      shuffle: Boolean(shuffleEl?.classList.contains('m-shuffling')),
      repeat: repeatMode,
      muted: Boolean(
        document.querySelector('.volume')?.classList.contains('muted') ||
        volEl?.classList.contains('muted')
      ),
      volume: Number.isFinite(volVal) ? volVal : 1,
      liked: Boolean(likeEl?.classList.contains('sc-button-selected')),
      following: Boolean(followEl?.classList.contains('sc-button-selected')),
      canLike: Boolean(likeEl && !likeEl.disabled && !likeEl.classList.contains('disabled')),
      canFollow: Boolean(followEl && !followEl.disabled && !followEl.classList.contains('disabled')),
      downloadState: { ...downloadState }
    };
  }

  function seekToRatio(ratio) {
    const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
    const player = window.__sc_players?.current;
    if (player && typeof player.seek === 'function') {
      const durMs = typeof player.getDuration === 'function'
        ? player.getDuration()
        : getPlayerState().durationSec * 1000;
      if (durMs > 0) {
        player.seek(Math.round(clamped * durMs));
        return true;
      }
    }

    const wrapper = document.querySelector('.playbackTimeline__progressWrapper');
    if (!wrapper) return false;
    const rect = wrapper.getBoundingClientRect();
    if (!rect.width) return false;

    const clientX = rect.left + clamped * rect.width;
    const clientY = rect.top + rect.height / 2;

    wrapper.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    }));
    wrapper.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    }));
    document.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    }));
    return true;
  }

  function setVolumeLevel(level) {
    const clamped = Math.min(1, Math.max(0, Number(level)));
    if (Number.isNaN(clamped)) return false;

    const volRoot = document.querySelector('.volume');
    const wrapper = document.querySelector('.volume__sliderWrapper');
    const bg = document.querySelector('.volume__sliderBackground');
    if (!wrapper || !bg) return false;

    const wasExpanded = volRoot ? volRoot.classList.contains('expanded') : true;
    if (volRoot && !wasExpanded) {
      volRoot.classList.add('expanded');
    }

    const rect = bg.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + 4 + (1 - clamped) * rect.height;

    wrapper.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    }));
    document.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    }));

    if (volRoot && !wasExpanded) {
      volRoot.classList.remove('expanded');
    }
    return true;
  }

  function runPlayerCommand(cmd, value) {
    switch (cmd) {
      case 'togglePlay':
        document.querySelector('.playControl')?.click();
        break;
      case 'prev':
        document.querySelector('.skipControl__previous')?.click();
        break;
      case 'next':
        resetSavedOnNext();
        document.querySelector('.skipControl__next')?.click();
        break;
      case 'toggleShuffle':
        document.querySelector('.shuffleControl')?.click();
        break;
      case 'toggleRepeat':
        document.querySelector('.repeatControl')?.click();
        break;
      case 'toggleMute':
        document.querySelector('.volume__button')?.click();
        break;
      case 'toggleLike':
        document.querySelector('.playbackSoundBadge__like')?.click();
        break;
      case 'toggleFollow':
        document.querySelector('.playbackSoundBadge__follow')?.click();
        break;
      case 'setVolume':
        setVolumeLevel(value);
        break;
      case 'seekRatio': {
        const st = getPlayerState();
        if (st.trackUrl) restoredTracks.add(normalizeTrackUrl(st.trackUrl));
        seekToRatio(value);
        setTimeout(persistCurrentProgress, 150);
        break;
      }
      case 'seekDelta': {
        const state = getPlayerState();
        const delta = Number(value || 0);
        if (state.durationSec > 0) {
          if (state.trackUrl) restoredTracks.add(normalizeTrackUrl(state.trackUrl));
          const now = Date.now();
          const baseSec = now < pendingSeekUntil ? pendingSeekTargetSec : state.currentTimeSec;
          const targetSec = Math.min(state.durationSec, Math.max(0, baseSec + delta));
          pendingSeekTargetSec = targetSec;
          pendingSeekUntil = now + 1200;

          const player = window.__sc_players?.current;
          if (player && typeof player.seek === 'function') {
            player.seek(Math.round(targetSec * 1000));
          } else if (typeof mediaSessionHandlers.seekto === 'function') {
            mediaSessionHandlers.seekto({ seekTime: targetSec });
          } else {
            seekToRatio(targetSec / state.durationSec);
          }
          setTimeout(persistCurrentProgress, 150);
        }
        break;
      }
      default:
        break;
    }
    return getPlayerState();
  }

  function pruneSavedProgress(map) {
    const entries = Object.entries(map || {});
    if (entries.length <= 1) return map;
    entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    return Object.fromEntries(entries.slice(0, 1));
  }

  function resetSavedProgress(targetUrl, suppressMs = 0) {
    const cleanTarget = normalizeTrackUrl(targetUrl);
    if (!cleanTarget) return;
    if (suppressMs > 0) {
      suppressedSaveTrackUrl = cleanTarget;
      suppressedSaveUntil = Date.now() + suppressMs;
    }

    const hadEntry = Boolean(savedProgress[cleanTarget]);
    const hadLast = normalizeTrackUrl(lastPlayed?.trackUrl) === cleanTarget;
    if (!hadEntry && !hadLast) return;

    delete savedProgress[cleanTarget];
    if (hadLast) lastPlayed = null;
    lastSavedSignature = `${cleanTarget}:reset`;
    restoredTracks.delete(cleanTarget);
    restoreSeekAttempts.delete(cleanTarget);

    window.postMessage(
      {
        source: MSG_SOURCE,
        type: 'SAVE_PROGRESS',
        trackUrl: cleanTarget,
        remove: true,
        entry: null,
        lastPlayed: null
      },
      '*'
    );
  }

  function resetSavedOnNext() {
    const state = getPlayerState();
    const curUrl = normalizeTrackUrl(state.trackUrl);
    if (curUrl) {
      suppressedSaveTrackUrl = curUrl;
      suppressedSaveUntil = Date.now() + 3000;
    }
    const urls = new Set(Object.keys(savedProgress));
    const lastNorm = normalizeTrackUrl(lastPlayed?.trackUrl);
    if (lastNorm) urls.add(lastNorm);
    for (const url of urls) {
      resetSavedProgress(url, url === curUrl ? 3000 : 0);
    }
  }

  function persistCurrentProgress() {
    const state = getPlayerState();
    if (!state.hasTrack || !state.trackUrl) return;

    const cleanUrl = normalizeTrackUrl(state.trackUrl);
    if (!cleanUrl) return;

    const pendingTarget =
      pendingResume && Date.now() - pendingResume.requestedAt <= RESUME_TTL_MS
        ? pendingResume.trackUrl
        : '';
    if (state.isPlaying && (!pendingTarget || pendingTarget === cleanUrl)) {
      const staleUrls = new Set(Object.keys(savedProgress));
      const lastNorm = normalizeTrackUrl(lastPlayed?.trackUrl);
      if (lastNorm) staleUrls.add(lastNorm);
      for (const staleUrl of staleUrls) {
        if (staleUrl && staleUrl !== cleanUrl) {
          resetSavedProgress(staleUrl);
        }
      }
    }

    if (state.durationSec <= 15) return;

    const sec = Math.floor(state.currentTimeSec);
    const dur = Math.floor(state.durationSec);

    if (suppressedSaveTrackUrl === cleanUrl && Date.now() < suppressedSaveUntil) {
      return;
    }

    if (sec >= dur - 5) {
      resetSavedProgress(cleanUrl);
      return;
    }

    if (sec >= 5) {
      const prev = savedProgress[cleanUrl];
      const sig = `${cleanUrl}:${sec}:1`;
      if (!prev || Math.abs(prev.timeSec - sec) >= 2 || normalizeTrackUrl(lastPlayed?.trackUrl) !== cleanUrl) {
        const entry = {
          timeSec: sec,
          durationSec: dur,
          title: state.title,
          artist: state.artist,
          artworkUrl: state.artworkUrl,
          updatedAt: Date.now()
        };
        savedProgress = { [cleanUrl]: entry };
        lastPlayed = {
          trackUrl: cleanUrl,
          ...entry
        };
        lastSavedSignature = sig;
        window.postMessage(
          {
            source: MSG_SOURCE,
            type: 'SAVE_PROGRESS',
            trackUrl: cleanUrl,
            remove: false,
            entry,
            lastPlayed
          },
          '*'
        );
      }
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isExcludedPlayButton(el) {
    return Boolean(
      el.closest('.playControls, .playbackSoundBadge, .relatedSounds, .soundList, .queue, .sidebarModule')
    );
  }

  function findPagePlayButton() {
    const selectors = [
      '.fullHero .playButton',
      '.fullHero .sc-button-play',
      '.listenHero .sc-button-play',
      '.soundTitle__playButton .sc-button-play',
      '.soundTitle__playButton button',
      '.listenEngagement .playButton',
      '.sc-button-play.playButton',
      '[data-testid="play-button"]'
    ];
    for (const sel of selectors) {
      const candidates = document.querySelectorAll(sel);
      for (const el of candidates) {
        if (
          !el.disabled &&
          !el.classList.contains('disabled') &&
          !isExcludedPlayButton(el) &&
          isElementVisible(el)
        ) {
          return el;
        }
      }
    }
    return null;
  }

  function isButtonPlayingOrLoading(el) {
    if (!el) return false;
    if (el.classList.contains('sc-button-pause') || el.classList.contains('sc-button-buffering')) {
      return true;
    }
    const title = (el.getAttribute('title') || '').trim().toLowerCase();
    const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    return title === 'pause' || label === 'pause' || title === 'buffering' || label === 'buffering';
  }

  function detachResumeGestureListeners() {
    waitingForUserGesture = false;
    document.removeEventListener('pointerdown', onUserGestureForResume, true);
    document.removeEventListener('keydown', onUserGestureForResume, true);
    window.removeEventListener('focus', onTabFocusForResume);
    document.removeEventListener('visibilitychange', onTabFocusForResume);
  }

  function onUserGestureForResume() {
    detachResumeGestureListeners();
    if (pendingResume) {
      lastResumeClickAt = 0;
      processPendingResume();
    }
  }

  function onTabFocusForResume() {
    if (document.visibilityState === 'visible' && document.hasFocus() && pendingResume && waitingForUserGesture) {
      onUserGestureForResume();
    }
  }

  function handleAutoplayBlocked() {
    if (!pendingResume || waitingForUserGesture) return;
    waitingForUserGesture = true;
    clearTimeout(resumeRetryTimer);
    resumeRetryTimer = null;
    document.addEventListener('pointerdown', onUserGestureForResume, { capture: true, once: true });
    document.addEventListener('keydown', onUserGestureForResume, { capture: true, once: true });
    if (!document.hasFocus() || document.visibilityState !== 'visible') {
      window.addEventListener('focus', onTabFocusForResume, { once: true });
      document.addEventListener('visibilitychange', onTabFocusForResume, { once: true });
    }
  }

  async function watchMediaPlayPromise(promise) {
    try {
      await promise;
    } catch (err) {
      if (err && err.name === 'NotAllowedError' && pendingResume) {
        handleAutoplayBlocked();
      }
    }
  }

  const origMediaPlay = HTMLMediaElement.prototype.play;
  if (origMediaPlay) {
    HTMLMediaElement.prototype.play = function () {
      const result = origMediaPlay.apply(this, arguments);
      if (result && typeof result.then === 'function') {
        watchMediaPlayPromise(result);
      }
      return result;
    };
  }

  let staleHeroBtn = null;
  let staleHeroClearAt = 0;

  function clearPendingResume(notifyBridge = true) {
    pendingResume = null;
    resumeAttemptCount = 0;
    lastResumeClickAt = 0;
    staleHeroBtn = null;
    staleHeroClearAt = 0;
    detachResumeGestureListeners();
    clearTimeout(resumeRetryTimer);
    resumeRetryTimer = null;
    if (notifyBridge) {
      window.postMessage({ source: MSG_SOURCE, type: 'CLEAR_PENDING_RESUME' }, '*');
    }
  }

  function scheduleResumeRetry(delayMs = 250) {
    clearTimeout(resumeRetryTimer);
    resumeRetryTimer = setTimeout(processPendingResume, delayMs);
  }

  function processPendingResume() {
    if (!pendingResume) return;

    const now = Date.now();
    if (now - pendingResume.requestedAt > RESUME_TTL_MS) {
      clearPendingResume(true);
      return;
    }

    const targetNorm = pendingResume.trackUrl;
    if (normalizeTrackUrl(location.href) !== targetNorm) {
      return;
    }

    const state = getPlayerState();
    const stateTrackNorm = normalizeTrackUrl(state.trackUrl);
    const isTargetLoaded = state.hasTrack && stateTrackNorm === targetNorm;

    if (isTargetLoaded && state.isPlaying) {
      maybeRestoreProgress();
      if (pendingResume.timeSec >= 5 && !restoredTracks.has(targetNorm)) {
        scheduleResumeRetry(250);
        return;
      }
      clearPendingResume(true);
      return;
    }

    if (waitingForUserGesture) {
      return;
    }

    if (document.visibilityState !== 'visible') {
      scheduleResumeRetry(150);
      return;
    }

    const heroPlay = findPagePlayButton();
    const barPlay = document.querySelector('.playControl');
    const heroIsLoadingOrPlaying = isButtonPlayingOrLoading(heroPlay);

    if (staleHeroBtn && heroPlay === staleHeroBtn && now < staleHeroClearAt) {
      scheduleResumeRetry(200);
      return;
    }
    staleHeroBtn = null;

    if (!heroIsLoadingOrPlaying && now - lastResumeClickAt >= 1000) {
      if (resumeAttemptCount >= MAX_RESUME_CLICKS) {
        clearPendingResume(true);
        return;
      }

      if (isTargetLoaded && barPlay && !barPlay.classList.contains('disabled') && !barPlay.classList.contains('playing')) {
        if (document.readyState !== 'loading') resumeAttemptCount += 1;
        lastResumeClickAt = now;
        barPlay.click();
      } else if (heroPlay && !heroPlay.classList.contains('sc-button-disabled')) {
        if (document.readyState !== 'loading') resumeAttemptCount += 1;
        lastResumeClickAt = now;
        heroPlay.click();
      }
    }

    scheduleResumeRetry(250);
  }

  function ensurePendingProgressEntry() {
    if (!pendingResume || pendingResume.timeSec < 5) return;
    const existing = savedProgress[pendingResume.trackUrl];
    if (!existing || existing.timeSec < 5) {
      savedProgress = {
        [pendingResume.trackUrl]: {
          timeSec: Math.floor(pendingResume.timeSec),
          durationSec: 0,
          title: '',
          artist: '',
          artworkUrl: '',
          updatedAt: Date.now()
        }
      };
    }
  }

  function startPendingResume(resumeObj) {
    if (!resumeObj || !resumeObj.trackUrl) {
      clearPendingResume(false);
      return;
    }
    const age = Date.now() - (Number(resumeObj.requestedAt) || 0);
    if (age > RESUME_TTL_MS) {
      clearPendingResume(true);
      return;
    }

    const targetNorm = normalizeTrackUrl(resumeObj.trackUrl);
    if (!targetNorm || normalizeTrackUrl(location.href) !== targetNorm) {
      return;
    }

    const incomingRequestedAt = Number(resumeObj.requestedAt) || Date.now();
    if (
      pendingResume &&
      pendingResume.trackUrl === targetNorm &&
      pendingResume.requestedAt === incomingRequestedAt
    ) {
      return;
    }

    pendingResume = {
      trackUrl: targetNorm,
      timeSec: Number(resumeObj.timeSec) || 0,
      requestedAt: incomingRequestedAt
    };
    resumeAttemptCount = 0;
    lastResumeClickAt = 0;
    detachResumeGestureListeners();
    restoredTracks.delete(targetNorm);
    restoreSeekAttempts.delete(targetNorm);
    ensurePendingProgressEntry();

    processPendingResume();
  }

  function maybeRestoreProgress() {
    if (!savedProgressLoaded && !pendingResume) return;

    const state = getPlayerState();
    if (!state.hasTrack || !state.isPlaying || !state.trackUrl || state.durationSec <= 15) return;

    const cleanUrl = normalizeTrackUrl(state.trackUrl);
    if (restoredTracks.has(cleanUrl)) return;

    const entry = savedProgress[cleanUrl];
    if (!entry || entry.timeSec < 5 || entry.timeSec >= state.durationSec - 5) {
      restoredTracks.add(cleanUrl);
      restoreSeekAttempts.delete(cleanUrl);
      return;
    }

    if (state.currentTimeSec <= 4) {
      const attempts = restoreSeekAttempts.get(cleanUrl) || 0;
      if (attempts >= 3) {
        restoredTracks.add(cleanUrl);
        restoreSeekAttempts.delete(cleanUrl);
        return;
      }

      restoredTracks.add(cleanUrl);
      restoreSeekAttempts.set(cleanUrl, attempts + 1);
      const ratio = entry.timeSec / state.durationSec;

      setTimeout(() => {
        const cur = getPlayerState();
        if (cur.hasTrack && normalizeTrackUrl(cur.trackUrl) === cleanUrl && cur.currentTimeSec <= 4) {
          const ok = seekToRatio(ratio);
          setTimeout(() => {
            const after = getPlayerState();
            if (
              after.hasTrack &&
              after.isPlaying &&
              normalizeTrackUrl(after.trackUrl) === cleanUrl &&
              after.currentTimeSec <= 4 &&
              (restoreSeekAttempts.get(cleanUrl) || 0) < 3
            ) {
              restoredTracks.delete(cleanUrl);
              if (ok) maybeRestoreProgress();
            } else {
              restoreSeekAttempts.delete(cleanUrl);
            }
          }, 500);
        } else {
          restoreSeekAttempts.delete(cleanUrl);
        }
      }, 350);
    } else {
      restoredTracks.add(cleanUrl);
      restoreSeekAttempts.delete(cleanUrl);
    }
  }

  setInterval(() => {
    maybeRestoreProgress();
    const state = getPlayerState();
    if (state.hasTrack && state.isPlaying) {
      persistCurrentProgress();
    }
  }, 1500);

  window.addEventListener('pagehide', persistCurrentProgress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persistCurrentProgress();
    }
  });
  document.addEventListener(
    'click',
    (event) => {
      if (event.target?.closest?.('.skipControl__next')) {
        resetSavedOnNext();
      }
    },
    true
  );

  function sanitizeFilename(name) {
    return (name || 'soundcloud-track')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
  }

  function rankTranscodings(transcodings) {
    if (!Array.isArray(transcodings) || transcodings.length === 0) return [];
    const full = transcodings.filter((t) => !t.snipped);
    const pool = full.length > 0 ? full : transcodings;

    const score = (t) => {
      const proto = t.format?.protocol || '';
      const mime = (t.format?.mime_type || '').toLowerCase();
      const preset = (t.preset || '').toLowerCase();
      if (mime === 'audio/mpegurl' || preset.startsWith('abr')) return 99;
      if (proto === 'progressive' && mime.startsWith('audio/mpeg')) return 1;
      if (proto === 'progressive') return 2;
      if (proto === 'hls' && mime.startsWith('audio/mpeg')) return 3;
      if (proto === 'hls' && mime.includes('mp4') && preset.includes('160')) return 4;
      if (proto === 'hls' && mime.includes('mp4')) return 5;
      if (proto === 'hls') return 6;
      return 10;
    };

    return [...pool].sort((a, b) => score(a) - score(b));
  }

  function parseM3U8(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let initUrl = null;
    const segments = [];

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MAP:')) {
        const match = line.match(/URI="([^"]+)"/);
        if (match) {
          initUrl = new URL(match[1], baseUrl).href;
        }
      } else if (!line.startsWith('#')) {
        segments.push(new URL(line, baseUrl).href);
      }
    }

    return { initUrl, segments };
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function downloadProgressive(streamUrl, baseName) {
    const res = await origFetch(streamUrl);
    if (!res.ok) throw new Error(`Stream download failed (${res.status})`);

    const contentLength = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !contentLength) {
      const buf = await res.arrayBuffer();
      const filename = `${baseName}.mp3`;
      triggerBlobDownload(new Blob([buf], { type: 'audio/mpeg' }), filename);
      return filename;
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      downloadState.progress = Math.min(99, Math.round((received / contentLength) * 100));
    }

    const filename = `${baseName}.mp3`;
    triggerBlobDownload(new Blob(chunks, { type: 'audio/mpeg' }), filename);
    return filename;
  }

  async function downloadHLS(m3u8Url, mimeType, baseName) {
    const m3u8Res = await origFetch(m3u8Url);
    if (!m3u8Res.ok) throw new Error(`Playlist fetch failed (${m3u8Res.status})`);
    const m3u8Text = await m3u8Res.text();

    const { initUrl, segments } = parseM3U8(m3u8Text, m3u8Url);
    if (segments.length === 0) throw new Error('No audio segments found in playlist');

    const total = segments.length + (initUrl ? 1 : 0);
    let completed = 0;
    const buffers = new Array(total);

    const fetchPart = async (url, index) => {
      const partRes = await origFetch(url);
      if (!partRes.ok) throw new Error(`Segment fetch failed (${partRes.status})`);
      buffers[index] = await partRes.arrayBuffer();
      completed += 1;
      downloadState.progress = Math.min(99, Math.round((completed / total) * 100));
    };

    let offset = 0;
    if (initUrl) {
      await fetchPart(initUrl, 0);
      offset = 1;
    }

    const CONCURRENCY = 4;
    for (let i = 0; i < segments.length; i += CONCURRENCY) {
      const batch = segments
        .slice(i, i + CONCURRENCY)
        .map((segUrl, j) => fetchPart(segUrl, offset + i + j));
      await Promise.all(batch);
    }

    const isMp4 = Boolean(initUrl) || (mimeType && mimeType.includes('mp4')) || segments[0].includes('.m4s');
    const isMp3 = !isMp4 && ((mimeType && mimeType.includes('mpeg')) || segments[0].includes('.mp3'));
    const ext = isMp4 ? 'm4a' : isMp3 ? 'mp3' : 'ts';
    const blobType = isMp4 ? 'audio/mp4' : isMp3 ? 'audio/mpeg' : 'video/mp2t';
    const filename = `${baseName}.${ext}`;

    triggerBlobDownload(new Blob(buffers, { type: blobType }), filename);
    return filename;
  }

  async function startTrackDownload() {
    if (downloadState.status === 'downloading') return { ...downloadState };

    clearTimeout(downloadResetTimer);
    const seq = ++downloadSeq;

    const state = getPlayerState();
    if (!state.hasTrack || !state.trackUrl) {
      downloadState = { status: 'error', progress: 0, error: 'No track is currently playing', filename: '', id: seq };
      return { ...downloadState };
    }

    const clientId = findClientId();
    if (!clientId) {
      downloadState = { status: 'error', progress: 0, error: 'Missing SoundCloud client_id — play a track first', filename: '', id: seq };
      return { ...downloadState };
    }

    downloadState = { status: 'downloading', progress: 2, error: '', filename: '', id: seq };

    try {
      const cleanUrl = state.trackUrl.split('?')[0];
      const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(cleanUrl)}&client_id=${encodeURIComponent(clientId)}`;
      const trackRes = await origFetch(resolveUrl);
      if (!trackRes.ok) throw new Error(`Failed to resolve track (${trackRes.status})`);
      const track = await trackRes.json();

      const candidates = rankTranscodings(track.media?.transcodings);
      if (candidates.length === 0) throw new Error('No downloadable stream available for this track');

      let chosenTranscoding = null;
      let streamData = null;
      let lastStatus = 0;

      for (const candidate of candidates) {
        const streamMetaUrl = new URL(candidate.url);
        streamMetaUrl.searchParams.set('client_id', clientId);
        if (track.track_authorization) {
          streamMetaUrl.searchParams.set('track_authorization', track.track_authorization);
        }

        const streamRes = await origFetch(streamMetaUrl.href);
        if (!streamRes.ok) {
          lastStatus = streamRes.status;
          continue;
        }
        const json = await streamRes.json();
        if (json?.url) {
          chosenTranscoding = candidate;
          streamData = json;
          break;
        }
      }

      if (!chosenTranscoding || !streamData?.url) {
        throw new Error(`Failed to fetch stream URL (${lastStatus || 'unavailable'})`);
      }

      const rawName = state.artist && !state.title.toLowerCase().includes(state.artist.toLowerCase())
        ? `${state.artist} - ${state.title}`
        : state.title || track.title;
      const baseName = sanitizeFilename(rawName);

      let filename;
      if (chosenTranscoding.format?.protocol === 'progressive') {
        filename = await downloadProgressive(streamData.url, baseName);
      } else {
        filename = await downloadHLS(streamData.url, chosenTranscoding.format?.mime_type || '', baseName);
      }

      downloadState = { status: 'done', progress: 100, error: '', filename, id: seq };
      downloadResetTimer = setTimeout(() => {
        if (downloadState.id === seq && downloadState.status === 'done') {
          downloadState = { status: 'idle', progress: 0, error: '', filename: '', id: seq };
        }
      }, 3000);
    } catch (err) {
      downloadState = {
        status: 'error',
        progress: 0,
        error: err?.message || 'Download failed',
        filename: '',
        id: seq
      };
    }

    return { ...downloadState };
  }

  // Bridge RPC handler (communicates with content-bridge.js)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== MSG_SOURCE) return;
    const { type, requestId, command, value } = event.data;

    if (type === 'SET_ENABLED') {
      enabled = Boolean(event.data.enabled);
      return;
    }

    if (type === 'SET_SAVED_PROGRESS') {
      const incoming = event.data.savedProgress || {};
      savedProgress = pruneSavedProgress({ ...incoming });
      ensurePendingProgressEntry();
      savedProgressLoaded = true;
      lastPlayed = event.data.lastPlayed || null;
      maybeRestoreProgress();
      return;
    }

    if (type === 'SET_PENDING_RESUME') {
      startPendingResume(event.data.pendingResume || null);
      return;
    }

    if (type === 'PLAY_ON_PAGE') {
      const targetUrl = normalizeTrackUrl(event.data.targetUrl || location.href);
      const resumeObj = {
        trackUrl: targetUrl,
        timeSec: Number(event.data.timeSec) || 0,
        requestedAt: Number(event.data.requestedAt) || Date.now()
      };

      const curUrl = normalizeTrackUrl(location.href);
      if (targetUrl && curUrl !== targetUrl) {
        const state = getPlayerState();
        const isLoadedInBar = state.hasTrack && normalizeTrackUrl(state.trackUrl) === targetUrl;
        if (!isLoadedInBar) {
          staleHeroBtn = findPagePlayButton();
          staleHeroClearAt = Date.now() + 1800;
          try {
            const parsed = new URL(targetUrl);
            history.pushState({}, '', parsed.pathname + parsed.search);
            window.dispatchEvent(new PopStateEvent('popstate'));
          } catch {
            // Ignore URL parse error
          }
          setTimeout(() => {
            if (normalizeTrackUrl(location.href) !== targetUrl) {
              location.assign(targetUrl);
            } else {
              startPendingResume(resumeObj);
            }
          }, 350);
          window.postMessage(
            { source: MSG_SOURCE, type: 'RESPONSE', requestId, payload: getPlayerState() },
            '*'
          );
          return;
        }
      }

      startPendingResume(resumeObj);
      window.postMessage(
        { source: MSG_SOURCE, type: 'RESPONSE', requestId, payload: getPlayerState() },
        '*'
      );
      return;
    }

    if (type === 'GET_PLAYER_STATE') {
      window.postMessage(
        { source: MSG_SOURCE, type: 'RESPONSE', requestId, payload: getPlayerState() },
        '*'
      );
      return;
    }

    if (type === 'PLAYER_COMMAND') {
      const payload = runPlayerCommand(command, value);
      window.postMessage(
        { source: MSG_SOURCE, type: 'RESPONSE', requestId, payload },
        '*'
      );
      return;
    }

    if (type === 'DOWNLOAD_TRACK') {
      (async () => {
        const payload = await startTrackDownload();
        window.postMessage(
          { source: MSG_SOURCE, type: 'RESPONSE', requestId, payload },
          '*'
        );
      })();
    }
  });

  window.postMessage({ source: MSG_SOURCE, type: 'MAIN_READY' }, '*');
})();
