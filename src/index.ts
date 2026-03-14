import { EventEmitter } from "node:events";
import { join } from "node:path";
import { throttle } from "throttle-debounce";
import { screen } from "electron";
import {
  BrowserWindow,
  Rectangle,
  BrowserWindowConstructorOptions,
} from "electron";
const lib: AddonExports = require("node-gyp-build")(join(__dirname, ".."));

interface AddonExports {
  start(
    overlayWindowId: Buffer | undefined,
    targetWindowTitle: string,
    cb: (e: any) => void,
  ): void;

  activateOverlay(): void;
  focusTarget(): void;
  screenshot(): Buffer;
}

enum EventType {
  EVENT_ATTACH = 1,
  EVENT_FOCUS = 2,
  EVENT_BLUR = 3,
  EVENT_DETACH = 4,
  EVENT_FULLSCREEN = 5,
  EVENT_MOVERESIZE = 6,
  EVENT_INPUT_ENTER = 7,
}

export interface AttachEvent {
  // Linux/X11 contract: these bounds are authoritative physical X11
  // virtual-desktop pixels (integers). They are directly comparable with
  // global mouse hook coordinates (e.g. uiohook) without CSS/DIP conversion.
  // On Windows/macOS, existing platform behavior is unchanged.
  hasAccess: boolean | undefined;
  isFullscreen: boolean | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FullscreenEvent {
  isFullscreen: boolean;
}

export interface MoveresizeEvent {
  // Linux/X11 contract: these bounds are authoritative physical X11
  // virtual-desktop pixels (integers). They are directly comparable with
  // global mouse hook coordinates (e.g. uiohook) without CSS/DIP conversion.
  // On Windows/macOS, existing platform behavior is unchanged.
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AttachOptions {
  // Whether the Window has a title bar. We adjust the overlay to not cover it
  hasTitleBarOnMac?: boolean;
}

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

export const OVERLAY_WINDOW_OPTS: BrowserWindowConstructorOptions = {
  fullscreenable: true,
  skipTaskbar: !isLinux,
  frame: false,
  show: false,
  transparent: true,
  // let Chromium to accept any size changes from OS
  resizable: !isLinux,
  // disable shadow for Mac OS
  hasShadow: !isMac,
  // float above all windows on Mac OS
  alwaysOnTop: isMac,
};

class OverlayControllerGlobal {
  private isInitialized = false;
  private electronWindow?: BrowserWindow;
  // Exposed so that apps can get the current bounds of the target.
  // Linux/X11: values come from authoritative X11 geometry and are physical
  // virtual-desktop pixels (integer x/y/width/height). Compare directly with
  // global mouse hooks like uiohook; no CSS/DIP conversion is applied.
  // Windows: stores a screen physical rect and is converted to DIP only when
  // applying bounds to Electron via screen.screenToDipRect.
  targetBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  targetHasFocus = false;
  // Used on Windows/Mac to prevent spurious hide() during focus transitions.
  // Not used on Linux (uiohook handles keyboard routing without focus changes).
  private focusNext: "overlay" | "target" | undefined;
  // The height of a title bar on a standard window. Only measured on Mac
  private macTitleBarHeight = 0;
  private attachOptions: AttachOptions = {};

  readonly events = new EventEmitter();

  private setIgnoreMouseEvents(ignore: boolean) {
    this.electronWindow?.setIgnoreMouseEvents(ignore);
  }

  constructor() {
    this.events.on("attach", (e: AttachEvent) => {
      this.targetHasFocus = true;
      if (this.electronWindow) {
        this.setIgnoreMouseEvents(true);
        this.electronWindow.showInactive();
        // On Linux, native restack (xcb_configure_window sibling stacking)
        // places the overlay just above the game window. Other windows the
        // user brings forward naturally sit above both.
        if (!isLinux) {
          this.electronWindow.setAlwaysOnTop(true, "screen-saver");
        }
      }
      if (e.isFullscreen !== undefined) {
        this.handleFullscreen(e.isFullscreen);
      }
      this.targetBounds = e;
      this.updateOverlayBounds();
    });

    this.events.on("fullscreen", (e: FullscreenEvent) => {
      this.handleFullscreen(e.isFullscreen);
    });

    this.events.on("detach", () => {
      this.targetHasFocus = false;
      this.electronWindow?.hide();
    });

    const dispatchMoveresize = throttle(
      34 /* 30fps */,
      this.updateOverlayBounds.bind(this),
    );

    this.events.on("moveresize", (e: MoveresizeEvent) => {
      this.targetBounds = e;
      dispatchMoveresize();
    });

    this.events.on("blur", () => {
      this.targetHasFocus = false;

      if (isLinux) {
        // Game lost focus. Hide unless we're in the middle of activating
        // the overlay (focusNext === 'overlay'), which causes a transient
        // blur because override-redirect focus sets _NET_ACTIVE_WINDOW to None.
        if (this.focusNext !== "overlay") {
          this.electronWindow?.hide();
        }
        return;
      }
      if (
        this.electronWindow &&
        (isMac ||
          (this.focusNext !== "overlay" && !this.electronWindow.isFocused()))
      ) {
        this.electronWindow.hide();
      }
    });

    this.events.on("focus", () => {
      this.focusNext = undefined;
      this.targetHasFocus = true;

      if (this.electronWindow) {
        this.setIgnoreMouseEvents(true);
        if (isLinux) {
          // Native X11 focus handling already restacks the overlay above the
          // game before emitting EVENT_FOCUS. Do not call activateOverlay()
          // here: that path assigns X11 input focus to the overlay and can
          // steal keyboard input from the game on initial attach.
          if (!this.electronWindow.isVisible()) {
            this.electronWindow.showInactive();
          }
        } else if (!this.electronWindow.isVisible()) {
          this.electronWindow.showInactive();
          this.electronWindow.setAlwaysOnTop(true, "screen-saver");
        }
      }
    });
  }

  private async handleFullscreen(isFullscreen: boolean) {
    if (!this.electronWindow) return;

    if (isMac) {
      // On Mac, only a single app can be fullscreen, so we can't go
      // fullscreen. We get around it by making it display on all workspaces,
      // based on code from:
      // https://github.com/electron/electron/issues/10078#issuecomment-754105005
      this.electronWindow.setVisibleOnAllWorkspaces(isFullscreen, {
        visibleOnFullScreen: true,
      });
      if (isFullscreen) {
        const display = screen.getPrimaryDisplay();
        this.electronWindow.setBounds(display.bounds);
      } else {
        // Set it back to `lastBounds` as set before fullscreen
        this.updateOverlayBounds();
      }
    }
  }

  private updateOverlayBounds() {
    let lastBounds = this.adjustBoundsForMacTitleBar(this.targetBounds);
    if (lastBounds.width === 0 || lastBounds.height === 0) return;
    if (!this.electronWindow) return;

    if (process.platform === "win32") {
      lastBounds = screen.screenToDipRect(
        this.electronWindow,
        this.targetBounds,
      );
    } else if (isLinux) {
      // Native X11 layer reports physical pixel bounds. Electron's setBounds()
      // expects DIP coordinates. Convert using the display's scale factor.
      const display = screen.getDisplayNearestPoint({
        x: lastBounds.x,
        y: lastBounds.y,
      });
      const scale = display.scaleFactor || 1;
      if (scale !== 1) {
        lastBounds = {
          x: Math.round(lastBounds.x / scale),
          y: Math.round(lastBounds.y / scale),
          width: Math.round(lastBounds.width / scale),
          height: Math.round(lastBounds.height / scale),
        };
      }
    }
    this.electronWindow.setBounds(lastBounds);

    // if moved to screen with different DPI, 2nd call to setBounds will correctly resize window
    // dipRect must be recalculated as well
    if (process.platform === "win32") {
      lastBounds = screen.screenToDipRect(
        this.electronWindow,
        this.targetBounds,
      );
      this.electronWindow.setBounds(lastBounds);
    }
  }

  private handler(e: unknown) {
    switch ((e as { type: EventType }).type) {
      case EventType.EVENT_ATTACH:
        this.events.emit("attach", e);
        break;
      case EventType.EVENT_FOCUS:
        this.events.emit("focus", e);
        break;
      case EventType.EVENT_BLUR:
        this.events.emit("blur", e);
        break;
      case EventType.EVENT_DETACH:
        this.events.emit("detach", e);
        break;
      case EventType.EVENT_FULLSCREEN:
        this.events.emit("fullscreen", e);
        break;
      case EventType.EVENT_MOVERESIZE:
        this.events.emit("moveresize", e);
        break;
      case EventType.EVENT_INPUT_ENTER:
        this.events.emit("input-enter");
        break;
    }
  }

  /**
   * Create a dummy window to calculate the title bar height on Mac. We use
   * the title bar height to adjust the size of the overlay to not overlap
   * the title bar. This helps Mac match the behaviour on Windows/Linux.
   */
  private calculateMacTitleBarHeight() {
    const testWindow = new BrowserWindow({
      width: 400,
      height: 300,
      webPreferences: {
        nodeIntegration: true,
      },
      show: false,
    });
    const fullHeight = testWindow.getSize()[1];
    const contentHeight = testWindow.getContentSize()[1];
    this.macTitleBarHeight = fullHeight - contentHeight;
    testWindow.close();
  }

  /** If we're on a Mac, adjust the bounds to not overlap the title bar */
  private adjustBoundsForMacTitleBar(bounds: Rectangle) {
    if (!isMac || !this.attachOptions.hasTitleBarOnMac) {
      return bounds;
    }

    const newBounds: Rectangle = {
      ...bounds,
      y: bounds.y + this.macTitleBarHeight,
      height: bounds.height - this.macTitleBarHeight,
    };
    return newBounds;
  }

  activateOverlay() {
    if (!this.electronWindow) {
      throw new Error("You are using the library in tracking mode");
    }
    this.focusNext = "overlay";
    this.setIgnoreMouseEvents(false);
    if (isLinux) {
      // Ensure the overlay is visible (may have been hidden on blur).
      if (!this.electronWindow.isVisible()) {
        this.electronWindow.showInactive();
      }
      // Restack above game, then focus to receive mouse clicks.
      // focus() on an override-redirect window sets _NET_ACTIVE_WINDOW to None,
      // which triggers a transient blur — guarded by focusNext above.
      // Keyboard dismissal is still handled by uiohook, not before-input-event.
      lib.activateOverlay();
      this.electronWindow.focus();
    } else {
      this.electronWindow.focus();
    }
  }

  focusTarget() {
    this.focusNext = "target";
    this.setIgnoreMouseEvents(true);
    lib.focusTarget();
  }

  attachByTitle(
    electronWindow: BrowserWindow | undefined,
    targetWindowTitle: string,
    options: AttachOptions = {},
  ) {
    if (this.isInitialized) {
      throw new Error("Library can be initialized only once.");
    } else {
      this.isInitialized = true;
    }
    this.electronWindow = electronWindow;

    this.electronWindow?.on("blur", () => {
      // On Linux, stacking order handles visibility — don't hide on blur.
      if (isLinux) return;
      if (!this.targetHasFocus && this.focusNext !== "target") {
        this.electronWindow!.hide();
      }
    });

    this.electronWindow?.on("focus", () => {
      this.focusNext = undefined;
    });

    this.attachOptions = options;
    if (isMac) {
      this.calculateMacTitleBarHeight();
    }

    lib.start(
      this.electronWindow?.getNativeWindowHandle(),
      targetWindowTitle,
      this.handler.bind(this),
    );
  }

  // buffer suitable for use in `nativeImage.createFromBitmap`
  screenshot(): Buffer {
    if (process.platform !== "win32") {
      throw new Error("Not implemented on your platform.");
    }
    return lib.screenshot();
  }
}

export const OverlayController = new OverlayControllerGlobal();
