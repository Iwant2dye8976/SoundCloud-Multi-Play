'use strict';

const toggleEl = document.getElementById('toggle');
const statusCardEl = document.getElementById('status-card');
const statusTextEl = document.getElementById('status-text');
const tabsBarEl = document.getElementById('tabs-bar');

const emptyStateEl = document.getElementById('empty-state');
const emptyMessageEl = document.getElementById('empty-message');
const resumeCardEl = document.getElementById('resume-card');
const resumeTitleEl = document.getElementById('resume-title');
const resumeTimeEl = document.getElementById('resume-time');
const resumeBtn = document.getElementById('resume-btn');
const clearResumeBtn = document.getElementById('clear-resume-btn');
const openScBtn = document.getElementById('open-sc-btn');
const playerContentEl = document.getElementById('player-content');

const artworkEl = document.getElementById('artwork');
const artworkFallbackEl = document.getElementById('artwork-fallback');
const trackTitleEl = document.getElementById('track-title');
const trackTitleTextEl = document.getElementById('track-title-text');
const trackTitleCloneEl = document.getElementById('track-title-clone');
const trackArtistEl = document.getElementById('track-artist');
const focusTabBtn = document.getElementById('focus-tab-btn');

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

const btnCopy = document.getElementById('btn-copy');
const copyTextEl = document.getElementById('copy-text');
const iconCopyLink = btnCopy.querySelector('.icon-copy-link');
const iconCopyDone = btnCopy.querySelector('.icon-copy-done');

const btnDownload = document.getElementById('btn-download');
const downloadFillEl = document.getElementById('download-fill');
const downloadTextEl = document.getElementById('download-text');

const lanCardEl = document.getElementById('lan-card');
const lanStatusEl = document.getElementById('lan-status');
const lanToggleEl = document.getElementById('lan-toggle');
const lanBodyEl = document.getElementById('lan-body');
const lanPairingEl = document.getElementById('lan-pairing');
const lanQrSvgEl = document.getElementById('lan-qr-svg');
const lanPinEl = document.getElementById('lan-pin');
const lanUrlBtn = document.getElementById('lan-url-btn');
const lanUrlTextEl = document.getElementById('lan-url-text');
const lanOfflineEl = document.getElementById('lan-offline');
const lanOfflineTextEl = document.getElementById('lan-offline-text');
const lanCopySetupBtn = document.getElementById('lan-copy-setup-btn');
const lanRetryBtn = document.getElementById('lan-retry-btn');

let activeTabId = null;
let activeWindowId = null;
let selectedTabId = null;
let lastTabsRenderKey = '';
let lastRenderedTrackUrl = '';
let lastRenderedTrackTitle = '';
let lastLanQrUrl = '';
let lanUrlCopyTimer = null;
let lanSetupCopyTimer = null;
let latestLanUrl = '';
let latestExtId = '';
let refreshSeq = 0;
const tabStatesById = new Map();
let isDraggingSeek = false;
let seekLockUntil = 0;
let lastKeySeekAt = 0;
let isDraggingVolume = false;
let latestState = null;
let lastPlayedInfo = null;
let activeDoneId = null;
let dismissedDoneId = null;
let fadeHoldTimer = null;
let fadeSwapTimer = null;
let copyResetTimer = null;
let titleCopyResetTimer = null;

function formatTime(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

function updateToggleUI(enabled) {
  toggleEl.checked = enabled;
  statusCardEl.classList.toggle('disabled', !enabled);
  statusTextEl.textContent = enabled
    ? 'Multi-play active'
    : 'Bypass paused';
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

function clearDownloadFadeTimers() {
  clearTimeout(fadeHoldTimer);
  clearTimeout(fadeSwapTimer);
  fadeHoldTimer = null;
  fadeSwapTimer = null;
}

function resetDownloadButtonToIdle() {
  clearDownloadFadeTimers();
  btnDownload.disabled = false;
  btnDownload.classList.remove('downloading', 'done', 'error', 'fading-out');
  btnDownload.title = 'Download playing track (D)';
  downloadFillEl.style.width = '0%';
  downloadTextEl.textContent = 'Download track';
}

function scheduleDownloadFadeOut(doneId) {
  if (activeDoneId === doneId || dismissedDoneId === doneId) return;
  activeDoneId = doneId;
  clearDownloadFadeTimers();

  fadeHoldTimer = setTimeout(() => {
    btnDownload.classList.add('fading-out');
    fadeSwapTimer = setTimeout(() => {
      dismissedDoneId = doneId;
      activeDoneId = null;
      btnDownload.classList.remove('done');
      downloadFillEl.style.width = '0%';
      downloadTextEl.textContent = 'Download track';
      btnDownload.disabled = false;
      requestAnimationFrame(() => {
        btnDownload.classList.remove('fading-out');
      });
    }, 320);
  }, 2200);
}

function renderDownloadState(dl) {
  const state = dl || { status: 'idle', progress: 0, error: '', filename: '', id: 0 };

  if (state.status === 'downloading') {
    clearDownloadFadeTimers();
    activeDoneId = null;
    btnDownload.classList.remove('done', 'error', 'fading-out');
    btnDownload.classList.add('downloading');
    btnDownload.disabled = false;
    btnDownload.title = 'Click to cancel download';
    downloadFillEl.style.width = `${state.progress || 0}%`;
    downloadTextEl.textContent = `Downloading ${state.progress || 0}% (Cancel)`;
  } else if (state.status === 'done') {
    const doneId = state.id || state.filename || 'done';
    if (dismissedDoneId === doneId) {
      if (!btnDownload.classList.contains('fading-out')) {
        resetDownloadButtonToIdle();
      }
      return;
    }
    if (!btnDownload.classList.contains('fading-out')) {
      btnDownload.disabled = false;
      btnDownload.classList.remove('downloading', 'error');
      btnDownload.classList.add('done');
      btnDownload.title = 'Download playing track (D)';
      downloadFillEl.style.width = '100%';
      downloadTextEl.textContent = state.filename ? `Saved ${state.filename}` : 'Downloaded';
      scheduleDownloadFadeOut(doneId);
    }
  } else if (state.status === 'error') {
    clearDownloadFadeTimers();
    activeDoneId = null;
    btnDownload.classList.remove('downloading', 'done', 'fading-out');
    btnDownload.disabled = false;
    btnDownload.classList.add('error');
    btnDownload.title = 'Download playing track (D)';
    downloadFillEl.style.width = '0%';
    downloadTextEl.textContent = state.error || 'Download failed — retry';
  } else {
    if (!btnDownload.classList.contains('fading-out')) {
      resetDownloadButtonToIdle();
    }
  }
}

function resetTrackTitleSlide() {
  if (!trackTitleEl) return;
  trackTitleEl.classList.remove('is-sliding');
  trackTitleEl.style?.removeProperty?.('--slide-duration');
  if (trackTitleCloneEl) trackTitleCloneEl.textContent = '';
}

function updateTrackTitleSlide() {
  if (!trackTitleEl || !trackTitleTextEl) return;
  const titleText = trackTitleTextEl.textContent || '';
  if (!titleText || titleText === '—' || playerContentEl.classList.contains('hidden')) {
    resetTrackTitleSlide();
    return;
  }

  const hadSliding = trackTitleEl.classList.contains('is-sliding');
  if (hadSliding) {
    trackTitleEl.classList.remove('is-sliding');
  }

  const viewportWidth = trackTitleEl.clientWidth || 0;
  const textWidth = trackTitleEl.scrollWidth || 0;

  if (viewportWidth <= 0 || textWidth <= viewportWidth + 1) {
    resetTrackTitleSlide();
    return;
  }

  const loopDistance = textWidth + 36;
  const scrollSec = loopDistance / 34;
  const totalSec = Math.max(4, Math.min(36, scrollSec / 0.94));
  trackTitleEl.style.setProperty('--slide-duration', `${totalSec.toFixed(2)}s`);
  if (trackTitleCloneEl && trackTitleCloneEl.textContent !== titleText) {
    trackTitleCloneEl.textContent = titleText;
  }

  if (hadSliding) {
    void trackTitleEl.offsetWidth;
  }
  trackTitleEl.classList.add('is-sliding');
}

function renderPlayerState(state) {
  latestState = state;
  const nextTrackUrl = state?.hasTrack ? normalizeTrackUrl(state.trackUrl) : '';
  if (nextTrackUrl !== lastRenderedTrackUrl) {
    lastRenderedTrackUrl = nextTrackUrl;
    resetCopyButton();
  }
  if (!state || !state.hasTrack) {
    lastRenderedTrackTitle = '';
    resetTrackTitleSlide();
    emptyStateEl.classList.remove('hidden');
    playerContentEl.classList.add('hidden');
    emptyMessageEl.textContent = activeTabId
      ? 'Start playing a track on SoundCloud to control or download it here.'
      : 'No SoundCloud tab is open.';
    openScBtn.textContent = activeTabId ? 'Go to SoundCloud Tab' : 'Open SoundCloud';

    if (lastPlayedInfo && lastPlayedInfo.trackUrl && lastPlayedInfo.timeSec >= 5) {
      resumeCardEl.classList.remove('hidden');
      resumeTitleEl.textContent = lastPlayedInfo.title || 'Last played track';
      resumeTitleEl.title = lastPlayedInfo.title || '';
      resumeTimeEl.textContent = `${formatTime(lastPlayedInfo.timeSec)} / ${formatTime(lastPlayedInfo.durationSec)}`;
    } else {
      resumeCardEl.classList.add('hidden');
    }
    return;
  }

  emptyStateEl.classList.add('hidden');
  playerContentEl.classList.remove('hidden');

  const nextTitle = state.title || 'Unknown Track';
  if (nextTitle !== lastRenderedTrackTitle) {
    lastRenderedTrackTitle = nextTitle;
    trackTitleTextEl.textContent = nextTitle;
    trackTitleEl.title = state.title || '';
    updateTrackTitleSlide();
  }
  trackArtistEl.textContent = state.artist || 'SoundCloud';
  trackArtistEl.title = state.artist || '';

  if (state.artworkUrl) {
    if (artworkEl.src !== state.artworkUrl) artworkEl.src = state.artworkUrl;
    artworkEl.classList.remove('hidden');
    artworkFallbackEl.classList.add('hidden');
  } else {
    artworkEl.classList.add('hidden');
    artworkFallbackEl.classList.remove('hidden');
  }

  iconPlay.classList.toggle('hidden', state.isPlaying);
  iconPause.classList.toggle('hidden', !state.isPlaying);

  btnShuffle.classList.toggle('active', Boolean(state.shuffle));
  btnRepeat.classList.toggle('active', state.repeat !== 'none');
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
    timePassedEl.textContent = state.currentTimeText || '0:00';
  }
  timeDurationEl.textContent = state.durationText || '0:00';

  renderDownloadState(state.downloadState);
}

function normalizeTrackUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url), 'https://soundcloud.com');
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${parsed.protocol}//${host}${path}`;
  } catch {
    return String(url).split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
  }
}

function getTabChipMeta(tab, index) {
  const tabState = tabStatesById.get(tab.id);
  const isAudible = Boolean(tab.audible || tabState?.isPlaying);
  const stateLabel = tabState?.hasTrack && tabState.title ? tabState.title : '';
  const cleanPageTitle = (tab.title || '')
    .replace(/\s*\|\s*Listen online.*$/i, '')
    .replace(/^Stream\s+/i, '')
    .trim();
  const labelText = stateLabel || cleanPageTitle || `Tab ${index + 1}`;
  const tooltipText = tabState?.hasTrack && tabState.title
    ? (tabState.artist ? `${tabState.artist} — ${tabState.title}` : tabState.title)
    : (tab.title || `SoundCloud Tab ${index + 1}`);
  return { isAudible, labelText, tooltipText };
}

function renderTabsBar(tabs, currentTabId) {
  if (!tabs || tabs.length < 2) {
    if (lastTabsRenderKey !== '') {
      lastTabsRenderKey = '';
      tabsBarEl.classList.add('hidden');
      tabsBarEl.replaceChildren();
    }
    return;
  }

  const metas = tabs.map((tab, index) => getTabChipMeta(tab, index));
  const renderKey = `${currentTabId}|${tabs
    .map((t, i) => `${t.id}:${metas[i].isAudible ? 1 : 0}:${metas[i].labelText}`)
    .join('\u0001')}`;
  if (renderKey === lastTabsRenderKey) return;
  lastTabsRenderKey = renderKey;

  tabsBarEl.classList.remove('hidden');
  const nodes = tabs.map((tab, index) => {
    const { isAudible, labelText, tooltipText } = metas[index];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-chip';
    if (tab.id === currentTabId) btn.classList.add('active');
    if (isAudible) btn.classList.add('audible');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab.id === currentTabId));

    const dot = document.createElement('span');
    dot.className = 'tab-chip-dot';
    const label = document.createElement('span');
    label.className = 'tab-chip-text';
    label.textContent = labelText;
    btn.title = tooltipText;

    btn.append(dot, label);
    btn.addEventListener('click', () => {
      selectedTabId = tab.id;
      try {
        chrome.storage?.session?.set?.({ selectedTabId: tab.id });
      } catch {
        // Ignore if session storage is unavailable
      }
      resetCopyButton();
      refreshState();
    });
    return btn;
  });

  tabsBarEl.replaceChildren(...nodes);
}

async function querySoundCloudTabs(shouldRender = true) {
  const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
  if (!tabs || tabs.length === 0) {
    tabStatesById.clear();
    renderTabsBar([], null);
    return { tabs: [], chosen: null };
  }

  let chosen = null;
  if (selectedTabId !== null) {
    chosen = tabs.find((t) => t.id === selectedTabId) || null;
  }
  if (!chosen) {
    chosen = tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs[0];
  }
  selectedTabId = chosen.id;
  if (shouldRender) {
    renderTabsBar(tabs, chosen.id);
  }
  return { tabs, chosen };
}

async function findSoundCloudTab() {
  const { chosen } = await querySoundCloudTabs(true);
  return chosen;
}

async function sendToSoundCloudTab(message, shouldRenderTabs = true) {
  const { chosen } = await querySoundCloudTabs(shouldRenderTabs);
  if (!chosen) {
    activeTabId = null;
    activeWindowId = null;
    return null;
  }
  activeTabId = chosen.id;
  activeWindowId = chosen.windowId;
  try {
    return await chrome.tabs.sendMessage(chosen.id, message);
  } catch {
    return null;
  }
}

async function refreshState() {
  const seq = ++refreshSeq;
  const [{ lastPlayed = null }, { tabs, chosen }] = await Promise.all([
    chrome.storage.local.get('lastPlayed'),
    querySoundCloudTabs(false)
  ]);
  if (seq !== refreshSeq) return;

  if (!chosen) {
    activeTabId = null;
    activeWindowId = null;
    lastPlayedInfo = lastPlayed;
    renderPlayerState(null);
    return;
  }

  activeTabId = chosen.id;
  activeWindowId = chosen.windowId;

  const targetTabs = tabs.length >= 2 ? tabs : [chosen];
  const responses = await Promise.all(
    targetTabs.map(async (t) => {
      try {
        return await chrome.tabs.sendMessage(t.id, { type: 'GET_PLAYER_STATE' });
      } catch {
        return null;
      }
    })
  );
  if (seq !== refreshSeq) return;

  const activeIds = new Set(tabs.map((t) => t.id));
  for (const existingId of tabStatesById.keys()) {
    if (!activeIds.has(existingId)) tabStatesById.delete(existingId);
  }
  targetTabs.forEach((t, idx) => {
    tabStatesById.set(t.id, responses[idx]?.state || null);
  });

  renderTabsBar(tabs, chosen.id);
  lastPlayedInfo = lastPlayed;
  renderPlayerState(tabStatesById.get(chosen.id) || null);
}

async function sendCommand(command, value) {
  const seq = ++refreshSeq;
  const res = await sendToSoundCloudTab({ type: 'PLAYER_COMMAND', command, value });
  if (seq === refreshSeq && res?.state) {
    if (activeTabId !== null) tabStatesById.set(activeTabId, res.state);
    renderPlayerState(res.state);
  }
}

async function copyTrackTitle() {
  const title = latestState?.title || '';
  if (!title) return;
  const artist = latestState?.artist || '';
  const text = artist && !title.toLowerCase().includes(artist.toLowerCase())
    ? `${artist} - ${title}`
    : title;
  try {
    await navigator.clipboard.writeText(text);
    clearTimeout(titleCopyResetTimer);
    trackTitleEl.classList.add('copied');
    trackTitleEl.title = 'Copied title!';
    titleCopyResetTimer = setTimeout(() => {
      trackTitleEl.classList.remove('copied');
      trackTitleEl.title = latestState?.title || '';
    }, 1200);
  } catch {
    // Ignore clipboard failure
  }
}

function resetCopyButton() {
  clearTimeout(copyResetTimer);
  copyResetTimer = null;
  btnCopy.classList.remove('copied');
  iconCopyLink.classList.remove('hidden');
  iconCopyDone.classList.add('hidden');
  copyTextEl.textContent = 'Copy link';
}

async function copySongLink() {
  const url = latestState?.trackUrl ? latestState.trackUrl.split('?')[0] : '';
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    resetCopyButton();
    btnCopy.classList.add('copied');
    iconCopyLink.classList.add('hidden');
    iconCopyDone.classList.remove('hidden');
    copyTextEl.textContent = 'Copied!';
    copyResetTimer = setTimeout(resetCopyButton, 1800);
  } catch {
    resetCopyButton();
    copyTextEl.textContent = 'Copy failed';
    copyResetTimer = setTimeout(resetCopyButton, 1800);
  }
}

async function triggerDownload() {
  if (btnDownload.classList.contains('downloading')) {
    const res = await sendToSoundCloudTab({ type: 'CANCEL_DOWNLOAD' });
    renderDownloadState(res?.downloadState || { status: 'idle' });
    return;
  }
  renderDownloadState({ status: 'downloading', progress: 2 });
  const res = await sendToSoundCloudTab({ type: 'DOWNLOAD_TRACK' });
  if (res?.downloadState) {
    renderDownloadState(res.downloadState);
  } else {
    renderDownloadState({ status: 'error', error: 'Reload SoundCloud tab and retry' });
  }
}

toggleEl.addEventListener('change', async () => {
  const enabled = toggleEl.checked;
  await chrome.storage.local.set({ enabled });
  updateToggleUI(enabled);
});

openScBtn.addEventListener('click', async () => {
  if (activeTabId) {
    await focusTabAndWindow(activeTabId, activeWindowId);
    window.close();
  } else {
    await chrome.tabs.create({ url: 'https://soundcloud.com/discover' });
    window.close();
  }
});

async function focusTabAndWindow(tabId, windowId, updateProps = { active: true }) {
  const tasks = [chrome.tabs.update(tabId, updateProps)];
  if (windowId !== undefined) {
    tasks.push((async () => {
      try {
        await chrome.windows.update(windowId, { focused: true });
      } catch {
        // Ignore window focus errors
      }
    })());
  }
  await Promise.all(tasks);
}

resumeBtn.addEventListener('click', async () => {
  if (!lastPlayedInfo?.trackUrl) return;
  const targetClean = normalizeTrackUrl(lastPlayedInfo.trackUrl);
  if (!targetClean) return;

  resumeBtn.disabled = true;
  const pendingResume = {
    trackUrl: targetClean,
    timeSec: Number(lastPlayedInfo.timeSec) || 0,
    requestedAt: Date.now()
  };

  try {
    const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
    const matchingTab = tabs.find((t) => normalizeTrackUrl(t.pendingUrl || t.url) === targetClean);
    const tab = matchingTab || await findSoundCloudTab();

    if (tab) {
      await chrome.storage.local.set({ pendingResume });

      let delivered = false;
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, {
          type: 'PLAY_ON_PAGE',
          targetUrl: targetClean,
          timeSec: pendingResume.timeSec,
          requestedAt: pendingResume.requestedAt
        });
        delivered = Boolean(resp?.ok);
      } catch {
        delivered = false;
      }

      if (delivered) {
        await focusTabAndWindow(tab.id, tab.windowId, { active: true });
      } else if (matchingTab) {
        await focusTabAndWindow(tab.id, tab.windowId, { active: true });
        await chrome.tabs.reload(tab.id);
      } else {
        await focusTabAndWindow(tab.id, tab.windowId, { url: lastPlayedInfo.trackUrl, active: true });
      }
    } else {
      await chrome.storage.local.set({ pendingResume });
      await chrome.tabs.create({ url: lastPlayedInfo.trackUrl });
    }
    window.close();
  } catch {
    resumeBtn.disabled = false;
  }
});

clearResumeBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ savedProgress: {}, lastPlayed: null, pendingResume: null });
  lastPlayedInfo = null;
  resumeCardEl.classList.add('hidden');
});

focusTabBtn.addEventListener('click', async () => {
  if (activeTabId) {
    await focusTabAndWindow(activeTabId, activeWindowId);
    window.close();
  }
});

btnShuffle.addEventListener('click', () => sendCommand('toggleShuffle'));
btnPrev.addEventListener('click', () => sendCommand('prev'));
btnBack10.addEventListener('click', () => triggerStepSeek(-10));
btnPlay.addEventListener('click', () => sendCommand('togglePlay'));
btnFwd10.addEventListener('click', () => triggerStepSeek(10));
btnNext.addEventListener('click', () => sendCommand('next'));
btnRepeat.addEventListener('click', () => sendCommand('toggleRepeat'));
btnMute.addEventListener('click', () => sendCommand('toggleMute'));
btnLike.addEventListener('click', async () => {
  await sendCommand('toggleLike');
  setTimeout(refreshState, 350);
});
btnFollow.addEventListener('click', async () => {
  await sendCommand('toggleFollow');
  setTimeout(refreshState, 350);
});
btnCopy.addEventListener('click', copySongLink);
trackTitleEl.addEventListener('click', copyTrackTitle);
btnDownload.addEventListener('click', triggerDownload);

progressRangeEl.addEventListener('input', () => {
  isDraggingSeek = true;
  const val = Number(progressRangeEl.value);
  setProgressVisual(val / 100);
  if (latestState?.durationSec > 0) {
    timePassedEl.textContent = formatTime((val / 10000) * latestState.durationSec);
  }
});

progressRangeEl.addEventListener('change', async () => {
  const ratio = Number(progressRangeEl.value) / 10000;
  seekLockUntil = Date.now() + 700;
  isDraggingSeek = false;
  await sendCommand('seekRatio', ratio);
});

const releaseActiveDrags = () => {
  isDraggingSeek = false;
  isDraggingVolume = false;
};
window.addEventListener('pointerup', releaseActiveDrags);
window.addEventListener('pointercancel', releaseActiveDrags);
progressRangeEl.addEventListener('blur', () => {
  isDraggingSeek = false;
});
volumeRangeEl.addEventListener('blur', () => {
  isDraggingVolume = false;
});

let volumeSendTimer = null;
volumeRangeEl.addEventListener('input', () => {
  isDraggingVolume = true;
  const pct = Number(volumeRangeEl.value);
  setVolumeVisual(pct);
  clearTimeout(volumeSendTimer);
  volumeSendTimer = setTimeout(() => {
    sendCommand('setVolume', pct / 100);
  }, 40);
});

volumeRangeEl.addEventListener('change', async () => {
  clearTimeout(volumeSendTimer);
  const pct = Number(volumeRangeEl.value);
  await sendCommand('setVolume', pct / 100);
  isDraggingVolume = false;
});

function triggerStepSeek(deltaSec) {
  if (!latestState?.hasTrack) return;
  const now = Date.now();
  if (now - lastKeySeekAt < 180) return;
  lastKeySeekAt = now;
  seekLockUntil = now + 700;
  if (latestState.durationSec > 0) {
    const targetSec = Math.min(latestState.durationSec, Math.max(0, (latestState.currentTimeSec || 0) + deltaSec));
    latestState.currentTimeSec = targetSec;
    const val = Math.round((targetSec / latestState.durationSec) * 10000);
    progressRangeEl.value = String(val);
    setProgressVisual(val / 100);
    timePassedEl.textContent = formatTime(targetSec);
  }
  sendCommand('seekDelta', deltaSec);
}

document.addEventListener('keydown', (e) => {
  if (!latestState?.hasTrack) return;
  if (e.target && e.target.tagName === 'INPUT' && e.target !== progressRangeEl && e.target !== volumeRangeEl) return;

  if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    sendCommand('togglePlay');
  } else if (e.code === 'ArrowUp') {
    e.preventDefault();
    const cur = latestState.muted ? 0 : (latestState.volume ?? 1);
    const next = Math.min(1, Math.round((cur + 0.05) * 100) / 100);
    setVolumeVisual(next * 100);
    volumeRangeEl.value = String(Math.round(next * 100));
    sendCommand('setVolume', next);
  } else if (e.code === 'ArrowDown') {
    e.preventDefault();
    const cur = latestState.muted ? 0 : (latestState.volume ?? 1);
    const next = Math.max(0, Math.round((cur - 0.05) * 100) / 100);
    setVolumeVisual(next * 100);
    volumeRangeEl.value = String(Math.round(next * 100));
    sendCommand('setVolume', next);
  } else if (e.code === 'ArrowLeft' && e.shiftKey) {
    e.preventDefault();
    sendCommand('prev');
  } else if (e.code === 'ArrowRight' && e.shiftKey) {
    e.preventDefault();
    sendCommand('next');
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    triggerStepSeek(-10);
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    triggerStepSeek(10);
  } else if (e.key === 'j' || e.key === 'J') {
    e.preventDefault();
    sendCommand('prev');
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    sendCommand('toggleLike');
    setTimeout(refreshState, 350);
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    sendCommand('toggleFollow');
    setTimeout(refreshState, 350);
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    copySongLink();
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    sendCommand('toggleMute');
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    sendCommand('toggleShuffle');
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    sendCommand('toggleRepeat');
  } else if (e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    if (!btnDownload.classList.contains('downloading')) {
      triggerDownload();
    }
  }
});

async function pollLoop() {
  await Promise.all([refreshState(), refreshLanStatus()]);
  setTimeout(pollLoop, 500);
}

async function fetchLocalServerInfo(port = 3847) {
  if (typeof fetch !== 'function') return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderLanState({ lanEnabled, connected, mobileCount, serverInfo, nativeError, extensionId }) {
  if (!lanCardEl || !lanToggleEl) return;
  if (extensionId) latestExtId = extensionId;
  lanToggleEl.checked = Boolean(lanEnabled);
  lanCardEl.classList.toggle('connected', Boolean(lanEnabled && connected));
  lanCardEl.classList.toggle('offline', Boolean(lanEnabled && !connected));

  if (!lanEnabled) {
    lanStatusEl.textContent = 'Off';
    lanBodyEl.classList.add('hidden');
    lanPairingEl.classList.add('hidden');
    lanOfflineEl.classList.add('hidden');
    return;
  }

  lanBodyEl.classList.remove('hidden');

  if (serverInfo && serverInfo.url) {
    lanStatusEl.textContent = mobileCount > 0
      ? `${mobileCount} connected`
      : (connected ? 'Ready' : 'Server detected');
    lanPairingEl.classList.remove('hidden');
    lanOfflineEl.classList.add('hidden');
    lanPinEl.textContent = serverInfo.pin || '—';
    latestLanUrl = serverInfo.shortUrl || serverInfo.url;
    if (!lanUrlBtn.classList.contains('copied')) {
      lanUrlTextEl.textContent = latestLanUrl;
    }
    if (lastLanQrUrl !== serverInfo.url) {
      lastLanQrUrl = serverInfo.url;
      try {
        globalThis.scQr?.renderQrSvg?.(lanQrSvgEl, serverInfo.url);
      } catch {
        // Ignore QR render errors
      }
    }
  } else {
    lanStatusEl.textContent = 'Server offline';
    lanPairingEl.classList.add('hidden');
    lanOfflineEl.classList.remove('hidden');
    if (lanOfflineTextEl) {
      lanOfflineTextEl.textContent = nativeError
        ? 'Auto-start not installed. Copy & run the one-time setup command in PowerShell, or run node lan-server/server.js.'
        : 'Starting LAN server... or run node lan-server/server.js manually.';
    }
    lastLanQrUrl = '';
  }
}

async function refreshLanStatus() {
  if (!lanToggleEl) return;
  try {
    const { lanEnabled = false, lanPort = 3847 } = await chrome.storage.local.get(['lanEnabled', 'lanPort']);
    if (!lanEnabled) {
      renderLanState({ lanEnabled: false, connected: false, mobileCount: 0, serverInfo: null });
      return;
    }

    let status = null;
    try {
      status = await chrome.runtime?.sendMessage?.({ type: 'LAN_GET_STATUS' });
    } catch {
      status = null;
    }

    let serverInfo = status?.serverInfo || null;
    if (!serverInfo) {
      serverInfo = await fetchLocalServerInfo(lanPort);
    }

    renderLanState({
      lanEnabled: true,
      connected: Boolean(status?.connected || serverInfo?.extConnected),
      mobileCount: Number(status?.mobileCount ?? serverInfo?.mobileCount ?? 0),
      serverInfo,
      nativeError: status?.nativeError || '',
      extensionId: status?.extensionId || chrome.runtime?.id || ''
    });
  } catch {
    // Ignore transient storage/runtime errors
  }
}

lanToggleEl?.addEventListener('change', async () => {
  const lanEnabled = lanToggleEl.checked;
  await chrome.storage.local.set({ lanEnabled });
  await refreshLanStatus();
});

function buildInstallSetupCommand(extId) {
  const idArg = extId ? ` -ExtensionId ${extId}` : '';
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "lan-server\\install-native-host.ps1"${idArg}`;
}

lanCopySetupBtn?.addEventListener('click', async () => {
  const extId = latestExtId || chrome.runtime?.id || '';
  const cmd = buildInstallSetupCommand(extId);
  try {
    await navigator.clipboard.writeText(cmd);
    clearTimeout(lanSetupCopyTimer);
    lanCopySetupBtn.textContent = 'Copied!';
    lanSetupCopyTimer = setTimeout(() => {
      lanCopySetupBtn.textContent = 'Copy setup';
    }, 1500);
  } catch {
    // Ignore clipboard failure
  }
});

lanRetryBtn?.addEventListener('click', async () => {
  try {
    await chrome.runtime?.sendMessage?.({ type: 'LAN_RECONNECT' });
  } catch {
    // Ignore
  }
  await refreshLanStatus();
});

lanUrlBtn?.addEventListener('click', async () => {
  if (!latestLanUrl) return;
  try {
    await navigator.clipboard.writeText(latestLanUrl);
    clearTimeout(lanUrlCopyTimer);
    lanUrlBtn.classList.add('copied');
    lanUrlTextEl.textContent = 'Copied URL!';
    lanUrlCopyTimer = setTimeout(() => {
      lanUrlBtn.classList.remove('copied');
      lanUrlTextEl.textContent = latestLanUrl;
    }, 1500);
  } catch {
    // Ignore clipboard failure
  }
});

async function init() {
  const { enabled = true, lanEnabled = false } = await chrome.storage.local.get(['enabled', 'lanEnabled']);
  updateToggleUI(enabled);
  if (lanToggleEl) lanToggleEl.checked = Boolean(lanEnabled);
  await pollLoop();
}

init();
