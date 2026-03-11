# electron-overlay-window

[![](https://img.shields.io/npm/v/electron-overlay-window/latest?color=CC3534&label=electron-overlay-window&logo=npm&labelColor=212121)](https://www.npmjs.com/package/electron-overlay-window)

Library for creating overlay windows, intended to complement Electron.

Responsible for:
  - Finding target window by title
  - Keeping position and size of overlay window with target in sync
  - Emits lifecycle events

![npm run demo:electron](https://i.imgur.com/Ej190zc.gif)

Important notes:
  - You can initialize library only once (Electron window must never die, and title by which target window is searched cannot be changed)
  - You can have only one overlay window
  - Found target window remains "valid" even if its title has changed
  - Correct behavior is guaranteed only for top-level windows *(A top-level window is a window that is not a child window, or has no parent window (which is the same as having the "desktop window" as a parent))*
  - X11: library relies on EWHM, more specifically `_NET_ACTIVE_WINDOW`, `_NET_WM_STATE_FULLSCREEN`, `_NET_WM_NAME`

Supported backends:
  - Windows (7 - 10)
  - Linux (X11)

Recommended dev utils
- Windows: AccEvent (accevent.exe) and Inspect Object (inspect.exe) from Windows SDK
- X11: xwininfo, xprop, xev


## Linux/X11 geometry contract

For Linux/X11, `attach` and `moveresize` event bounds are exported in **authoritative X11 virtual-desktop physical pixels** (`x`, `y`, `width`, `height` integers).

This means downstream apps should:
- compare these bounds directly with global mouse hook coordinates (for example, from `uiohook`), and
- avoid Chromium renderer coordinates like `window.screenX/screenY` for hit-testing/activation logic on multi-monitor X11/XWayland setups.

No CSS/DIP conversion is applied to Linux/X11 bounds on this API path.

### Optional diagnostics

Set `OVERLAY_WINDOW_DEBUG_GEOMETRY=1` to emit low-noise native logs at:
- hook start,
- attach export,
- moveresize export.

Each line includes geometry source, unit space, and exported bounds.

