'use strict';

const COMMAND_MAP = {
  'toggle-play': 'togglePlay',
  'next-track': 'next',
  'prev-track': 'prev',
  'like-track': 'toggleLike'
};

async function syncActionBadge() {
  try {
    const { enabled = true } = await chrome.storage.local.get('enabled');
    await chrome.action.setBadgeBackgroundColor({ color: '#71717a' });
    await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  } catch {
    // Ignore badge errors if action API is unavailable
  }
}

async function pickTargetSoundCloudTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.soundcloud.com/*' });
  if (!tabs || tabs.length === 0) return null;

  let preferredId = null;
  try {
    if (chrome.storage?.session) {
      const { selectedTabId = null } = await chrome.storage.session.get('selectedTabId');
      preferredId = selectedTabId;
    }
  } catch {
    preferredId = null;
  }

  return (
    tabs.find((t) => t.audible) ||
    (preferredId !== null ? tabs.find((t) => t.id === preferredId) : null) ||
    tabs.find((t) => t.active) ||
    tabs[0]
  );
}

chrome.runtime.onInstalled.addListener(() => {
  syncActionBadge();
});

chrome.runtime.onStartup.addListener(() => {
  syncActionBadge();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.enabled) {
    syncActionBadge();
  }
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
