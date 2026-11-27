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

let activeTabId = null;
let activeWindowId = null;
let selectedTabId = null;
let lastTabsRenderKey = '';
let lastRenderedTrackUrl = '';
let lastRenderedTrackTitle = '';
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
  btnDownload.classList.remove('done', 'error', 'fading-out');
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
    btnDownload.disabled = true;
    downloadFillEl.style.width = `${state.progress || 0}%`;
    downloadTextEl.textContent = `Downloading ${state.progress || 0}%...`;
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
      btnDownload.classList.remove('error');
      btnDownload.classList.add('done');
      downloadFillEl.style.width = '100%';
      downloadTextEl.textContent = state.filename ? `Saved ${state.filename}` : 'Downloaded';
      scheduleDownloadFadeOut(doneId);
    }
  } else if (state.status === 'error') {
    clearDownloadFadeTimers();
    activeDoneId = null;
    btnDownload.classList.remove('done', 'fading-out');
    btnDownload.disabled = false;
    btnDownload.classList.add('error');
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

function renderTabsBar(tabs, currentTabId) {
  if (!tabs || tabs.length < 2) {
    if (lastTabsRenderKey !== '') {
      lastTabsRenderKey = '';
      tabsBarEl.classList.add('hidden');
      tabsBarEl.replaceChildren();
    }
    return;
  }

  const renderKey = `${currentTabId}|${tabs
    .map((t) => `${t.id}:${t.audible ? 1 : 0}:${t.title || ''}`)
    .join('\u0001')}`;
  if (renderKey === lastTabsRenderKey) return;
  lastTabsRenderKey = renderKey;

  tabsBarEl.classList.remove('hidden');
  const nodes = tabs.map((tab, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-chip';
    if (tab.id === currentTabId) btn.classList.add('active');
    if (tab.audible) btn.classList.add('audible');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab.id === currentTabId));

    const dot = document.createElement('span');
    dot.className = 'tab-chip-dot';
    const label = document.createElement('span');
    label.className = 'tab-chip-text';
    const cleanTitle = (tab.title || '').replace(/\s*\|\s*Listen online.*$/i, '').replace(/^Stream\s+/i, '').trim();
    label.textContent = cleanTitle || `Tab ${index + 1}`;
    btn.title = tab.title || `SoundCloud Tab ${index + 1}`;

    btn.append(dot, label);
    btn.addEventListener('click', () => {
      selectedTabId = tab.id;
      resetCopyButton();
      refreshState();
    });
    return btn;
  });

  tabsBarEl.replaceChildren(...nodes);
}

async function findSoundCloudTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
  if (!tabs || tabs.length === 0) {
    renderTabsBar([], null);
    return null;
  }

  let chosen = null;
  if (selectedTabId !== null) {
    chosen = tabs.find((t) => t.id === selectedTabId) || null;
  }
  if (!chosen) {
    chosen = tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs[0];
  }
  selectedTabId = chosen.id;
  renderTabsBar(tabs, chosen.id);
  return chosen;
}

async function sendToSoundCloudTab(message) {
  const tab = await findSoundCloudTab();
  if (!tab) {
    activeTabId = null;
    activeWindowId = null;
    return null;
  }
  activeTabId = tab.id;
  activeWindowId = tab.windowId;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null;
  }
}

async function refreshState() {
  const [{ lastPlayed = null }, res] = await Promise.all([
    chrome.storage.local.get('lastPlayed'),
    sendToSoundCloudTab({ type: 'GET_PLAYER_STATE' })
  ]);
  lastPlayedInfo = lastPlayed;
  renderPlayerState(res?.state || null);
}

async function sendCommand(command, value) {
  const res = await sendToSoundCloudTab({ type: 'PLAYER_COMMAND', command, value });
  if (res?.state) renderPlayerState(res.state);
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
    triggerDownload();
  }
});

async function init() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  updateToggleUI(enabled);
  await refreshState();
  setInterval(refreshState, 500);
}

init();
