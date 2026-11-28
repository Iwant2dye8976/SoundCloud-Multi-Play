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
- **LAN mobile remote** — Control playback, seek, volume, shuffle/repeat, Like/Follow, and SoundCloud tabs from any phone on the same Wi-Fi/LAN via a zero-dependency companion server with PIN + QR code pairing.

## LAN Mobile Remote

### Option A — Automatic start/stop from the extension (recommended, Windows)

1. Click **Copy setup** inside the extension popup (works from any folder and auto-locates your extension path), or run from any directory:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\soundcloud\lan-server\install-native-host.ps1"
   ```
2. Reload the extension in `chrome://extensions`.
3. Toggle **LAN Mobile Remote** on in the popup — Chrome now starts and stops the companion server automatically in the background with no terminal needed. Scan the QR code (or open the LAN URL and enter the 6-digit PIN) on your phone.

*(To remove the auto-start registration and `sc-remote` CLI shim later, run `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\soundcloud\lan-server\uninstall-native-host.ps1"`.)*

### Option B — Manual start (from any directory)

After running the setup script once, you can start the server from any folder with:
```sh
sc-remote
```
Or directly via Node:
```sh
node "C:\soundcloud\lan-server\server.js"
```

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
├── lan-server/
│   ├── server.js          # Zero-dependency Node.js HTTP + WebSocket LAN bridge
│   └── public/            # Mobile web remote UI (HTML, CSS, JS)
└── popup/
    ├── popup.html         # Extension popup markup
    ├── popup.css          # Dark mini-player styling
    ├── popup.js           # Popup UI logic, shortcuts, LAN pairing, and tab communication
    └── qr.js              # Zero-dependency SVG QR code generator
```

## Permissions

- `storage` — Stores the bypass toggle state, LAN remote preferences, and saved track playback positions locally in `chrome.storage.local`.
- `tabs` — Finds active SoundCloud tabs to query player state, send playback commands, or focus/open SoundCloud.
- `alarms` — Keeps the MV3 service worker WebSocket bridge alive when LAN Mobile Remote is enabled.
- `nativeMessaging` — Lets Chrome automatically start and stop the local LAN companion server when LAN Mobile Remote is toggled on/off.
- `*://*.soundcloud.com/*` — Injects the content scripts on SoundCloud pages.
