**English** | [Tiếng Việt](README.vi.md)

# SoundCloud Multi-Play

A Manifest V3 Chrome extension that keeps SoundCloud playing across tabs and devices, paired with a mini-player popup for playback controls, progress saving, and track downloading.

## Features

- **Multi-location playback bypass** — Keeps SoundCloud playing even when you start playback in another browser tab or on another device (`"Paused because you started playing on another device."`). Can be toggled on or off from the popup (with an `OFF` badge on the extension icon when paused).
- **Mini-player controls & seekable progress bar** — View the playing track's artwork, sliding marquee title (click to copy `"Artist - Title"`), artist, and elapsed/total time, scrub directly to any position, and switch between multiple SoundCloud tabs.
- **Global & popup keyboard shortcuts** — Control Play/Pause, Next, Previous, and Like globally from any tab (customizable at `chrome://extensions/shortcuts`), plus full keyboard shortcuts inside the popup.
- **Volume & mute control** — Adjust SoundCloud's volume slider (`0%–100%`) or mute/unmute from the popup.
- **Like & Follow** — Like the playing track or follow its artist directly from the popup.
- **Track downloader** — Download the currently playing track (`.m4a` AAC or `.mp3` when provided by SoundCloud) with live progress, timeout/retry protection, and click-to-cancel support.
- **Save & resume progress** — Automatically saves your playback position for the latest track, resets it when you play a new song, skip, or finish the track, and lets you resume from the popup.

## Global Shortcuts

| Default Key | Action |
| --- | --- |
| `Alt` + `Shift` + `P` | Play / Pause |
| `Alt` + `Shift` + `N` | Next track |
| `Alt` + `Shift` + `B` | Previous track |
| `Alt` + `Shift` + `L` | Like / Unlike track |

## Keyboard Shortcuts (Popup)

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / Pause |
| `←` / `→` | Seek −10s / +10s |
| `Shift` + `←` / `J` | Previous track |
| `Shift` + `→` | Next track |
| `↑` / `↓` | Volume +5% / −5% |
| `M` | Mute / Unmute |
| `S` | Toggle Shuffle |
| `R` | Cycle Repeat |
| `L` | Like / Unlike track |
| `F` | Follow / Unfollow artist |
| `C` | Copy song link |
| `D` | Download playing track |

## Installation (Load Unpacked)

1. Open `chrome://extensions` in Chrome (or a Chromium-based browser such as Edge or Brave).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `C:\soundcloud` folder.
4. Open or refresh `https://soundcloud.com`.

## Project Structure

```text
soundcloud/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # MV3 service worker for global shortcuts and OFF badge
├── content-main.js        # MAIN-world hooks, player bridge, downloader, progress sync
├── content-bridge.js      # ISOLATED-world bridge for chrome.storage and popup messaging
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── popup/
    ├── popup.html         # Extension popup markup
    ├── popup.css          # Dark mini-player styling
    └── popup.js           # Popup UI logic, shortcuts, and tab communication
```

## Permissions

- `storage` — Stores the bypass toggle state and saved track playback positions locally in `chrome.storage.local`.
- `tabs` — Finds active SoundCloud tabs to query player state, send playback commands, or focus/open SoundCloud.
- `*://*.soundcloud.com/*` — Injects the content scripts on SoundCloud pages.
