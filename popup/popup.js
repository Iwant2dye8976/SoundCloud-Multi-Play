'use strict';

const toggleEl = document.getElementById('toggle');
const statusCardEl = document.getElementById('status-card');
const statusTextEl = document.getElementById('status-text');

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
const trackArtistEl = document.getElementById('track-artist');
const focusTabBtn = document.getElementById('focus-tab-btn');

const progressRangeEl = document.getElementById('progress-range');
const timePassedEl = document.getElementById('time-passed');
const timeDurationEl = document.getElementById('time-duration');

const btnShuffle = document.getElementById('btn-shuffle');
const btnPrev = document.getElementById('btn-prev');
const btnPlay = document.getElementById('btn-play');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
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

const btnDownload = document.getElementById('btn-download');
const downloadFillEl = document.getElementById('download-fill');
const downloadTextEl = document.getElementById('download-text');

let activeTabId = null;
let isDraggingSeek = false;
let isDraggingVolume = false;
let latestState = null;
let lastPlayedInfo = null;
let activeDoneId = null;
let dismissedDoneId = null;
let fadeHoldTimer = null;
let fadeSwapTimer = null;

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

function renderPlayerState(state) {
  latestState = state;
  if (!state || !state.hasTrack) {
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

  trackTitleEl.textContent = state.title || 'Unknown Track';
  trackTitleEl.title = state.title || '';
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

  if (!isDraggingSeek) {
    const ratio = state.durationSec > 0 ? state.currentTimeSec / state.durationSec : 0;
    const val = Math.round(Math.min(1, Math.max(0, ratio)) * 1000);
    progressRangeEl.value = String(val);
    setProgressVisual(val / 10);
    timePassedEl.textContent = state.currentTimeText || '0:00';
  }
  timeDurationEl.textContent = state.durationText || '0:00';

  renderDownloadState(state.downloadState);
}

async function findSoundCloudTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
  if (!tabs || tabs.length === 0) return null;
  const audible = tabs.find((t) => t.audible);
  if (audible) return audible;
  const active = tabs.find((t) => t.active);
  return active || tabs[0];
}

async function sendToSoundCloudTab(message) {
  const tab = await findSoundCloudTab();
  if (!tab) {
    activeTabId = null;
    return null;
  }
  activeTabId = tab.id;
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
    await chrome.tabs.update(activeTabId, { active: true });
    window.close();
  } else {
    await chrome.tabs.create({ url: 'https://soundcloud.com/discover' });
    window.close();
  }
});

resumeBtn.addEventListener('click', async () => {
  if (!lastPlayedInfo?.trackUrl) return;
  const tab = await findSoundCloudTab();
  const targetClean = lastPlayedInfo.trackUrl.split('?')[0];
  const tabClean = tab?.url ? tab.url.split('?')[0] : '';

  if (tab && tabClean === targetClean) {
    await chrome.tabs.update(tab.id, { active: true });
    await sendToSoundCloudTab({ type: 'PLAY_ON_PAGE' });
  } else if (tab) {
    await chrome.tabs.update(tab.id, { url: lastPlayedInfo.trackUrl, active: true });
  } else {
    await chrome.tabs.create({ url: lastPlayedInfo.trackUrl });
  }
  window.close();
});

clearResumeBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ savedProgress: {}, lastPlayed: null });
  lastPlayedInfo = null;
  resumeCardEl.classList.add('hidden');
});

focusTabBtn.addEventListener('click', async () => {
  if (activeTabId) {
    await chrome.tabs.update(activeTabId, { active: true });
    window.close();
  }
});

btnShuffle.addEventListener('click', () => sendCommand('toggleShuffle'));
btnPrev.addEventListener('click', () => sendCommand('prev'));
btnPlay.addEventListener('click', () => sendCommand('togglePlay'));
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
btnDownload.addEventListener('click', triggerDownload);

progressRangeEl.addEventListener('input', () => {
  isDraggingSeek = true;
  const val = Number(progressRangeEl.value);
  setProgressVisual(val / 10);
  if (latestState?.durationSec > 0) {
    timePassedEl.textContent = formatTime((val / 1000) * latestState.durationSec);
  }
});

progressRangeEl.addEventListener('change', async () => {
  const ratio = Number(progressRangeEl.value) / 1000;
  await sendCommand('seekRatio', ratio);
  isDraggingSeek = false;
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
    sendCommand('seekDelta', -10);
  } else if (e.code === 'ArrowRight' && e.shiftKey) {
    e.preventDefault();
    sendCommand('seekDelta', 10);
  } else if (e.code === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
    e.preventDefault();
    sendCommand('prev');
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    sendCommand('next');
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    sendCommand('toggleLike');
    setTimeout(refreshState, 350);
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    sendCommand('toggleFollow');
    setTimeout(refreshState, 350);
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
