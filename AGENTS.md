# AGENTS.md

Guidance for coding agents working in `C:\soundcloud` (**SoundCloud Multi-Play**, a Manifest V3 Chrome extension with zero build step and zero runtime dependencies).

## Architecture

- **[manifest.json](manifest.json)**: MV3 manifest (`storage`, `tabs`, host `*://*.soundcloud.com/*`). No background service worker; injects two content scripts at `document_start` and serves `popup/popup.html` as `action.default_popup`.
- **[content-main.js](content-main.js)** (`world: "MAIN"`):
  - Intercepts SoundCloud multi-device/tab stop signals across `EventSource` (`/tsub/subscribe`), `XMLHttpRequest` / `fetch` (`/tpub/publish`), and `Storage.prototype.setItem` / `storage` events (`trinity-broadcast`) when `enabled` is true.
  - Reads SoundCloud DOM & `navigator.mediaSession` state, executes playback/seek/volume/social commands, handles resume-on-load/navigation (`pendingResume`, `maybeRestoreProgress`), and downloads HLS/progressive streams (`startTrackDownload`).
- **[content-bridge.js](content-bridge.js)** (`world: "ISOLATED"`):
  - Bridges `window.postMessage` (`source: 'sc-multiplay'`) with `chrome.storage.local` and `chrome.runtime.onMessage` from the popup.
  - Serializes `SAVE_PROGRESS` writes with `withSaveLock` (`navigator.locks.request('sc-multiplay-save', ...)`).
- **[popup/popup.html](popup/popup.html)**, **[popup/popup.css](popup/popup.css)**, **[popup/popup.js](popup/popup.js)**:
  - 348px-wide dark mini-player popup polling the selected SoundCloud tab every 500ms (`refreshState()`), with multi-tab switching, sliding marquee track title, seek/volume sliders, social actions, download progress, and keyboard shortcuts.
- **[tests/extension.test.js](tests/extension.test.js)**:
  - Uses Node's built-in `node:test`, `node:assert/strict`, and `node:vm` to run `content-main.js`, `content-bridge.js`, and `popup/popup.js` against mocked DOM/Chrome APIs.

## Verification

Run the test suite after any code change:

```sh
node --test tests/extension.test.js
```

There is no bundler or build step. Manual browser verification requires reloading the unpacked extension in `chrome://extensions` and refreshing any open `soundcloud.com` tab.

## Key Invariants & Conventions

- **Manifest V3 & CSP**: Keep all scripts external (`<script src="...">`), attach listeners with `addEventListener`, use `async`/`await`, and never inject HTML strings (`innerHTML`) — use `textContent`, `createElement`, and `replaceChildren`.
- **World boundary**: `content-main.js` cannot call `chrome.*` APIs. Pass messages strictly via `window.postMessage` with `source: 'sc-multiplay'` and verify `event.source === window` on receipt.
- **Single-track progress saving**:
  - `savedProgress` and `lastPlayed` store only the **single latest track** (`pruneSavedProgress` caps at 1 entry; `content-bridge.js` replaces rather than accumulates entries).
  - Playing a different track (`state.isPlaying`, respecting active `pendingResume`), reaching the end (`sec >= dur - 5`), or triggering Next (`runPlayerCommand('next')`, `.skipControl__next` clicks, or MediaSession `nexttrack`) resets the saved play time and clears `lastPlayed`.
- **500ms popup polling**: `renderPlayerState()` and `renderTabsBar()` run every 500ms. Guard DOM/animation updates with diff keys (`lastTabsRenderKey`, `lastRenderedTrackUrl`, `lastRenderedTrackTitle`) so animations and user interactions do not reset on polls.
- **Motion & browser support**: Targeting modern Chrome (MV3). For requested UI motion like the sliding title (`track-title-slide`), keep animations compositor-only (`translate`) and slow down via `@media (prefers-reduced-motion: reduce)` rather than disabling completely if reduced motion is active on Windows.
- **Keep tests, version, and docs in sync**: Update `elementsById` in `tests/extension.test.js` whenever adding/renaming IDs in `popup/popup.html`, keep [README.md](README.md) and [README.vi.md](README.vi.md) aligned when user-facing behavior changes, and bump `"version"` in [manifest.json](manifest.json) (SemVer: patch for fixes, minor for new features/behavior changes) after extension changes.
