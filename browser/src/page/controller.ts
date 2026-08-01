import { BrowserWindow, screen } from "electron";
import type { WebContents } from "electron";
import type {
  EngineKeyEvent,
  PastedImage,
  PointerEvent,
  Surface,
  WheelEvent,
} from "pixel-react";
import { normalizeUrl, urlHost } from "../url";
import { cursorShapeFor } from "./cursor";
import { DevtoolsWindow } from "./devtools";
import type { DevtoolsAction } from "./devtools";
import type { DevtoolsDock } from "pixel-store";
import { FaviconCache } from "./favicon";
import { frameRate } from "./frame-rate";
import { PageInput } from "./input";
import { offscreenMode, offscreenPreferences } from "./offscreen";
import { presentBitmap, presentTexture } from "./paint";
import { PopupWindow } from "./popup";
import { cssSize, initialBrowserState } from "./types";
import type {
  BrowserLifecycleEvent,
  BrowserState,
  BrowserSurfaceLayout,
  DeviceSpec,
} from "./types";
import { scaleZoom, stepZoom } from "./zoom";
import type { ZoomDirection } from "./zoom";

export interface BrowserAgentFrame {
  id: string;
  parentId: string | null;
  url: string;
  origin: string;
}

export type BrowserAgentFrameLifecycle =
  | { type: "attached"; frameId: string; parentId: string }
  | { type: "navigated"; frameId: string; parentId: string; url: string; origin: string }
  | { type: "detached"; frameId: string };

export type BrowserAgentEvent =
  | {
      type: "console";
      data: {
        level: "verbose" | "info" | "warning" | "error";
        message: string;
        line: number;
        sourceId: string;
      };
    }
  | {
      type: "page.error";
      data:
        | {
            kind: "load";
            code: number;
            description: string;
            url: string;
            mainFrame: boolean;
          }
        | {
            kind: "renderer";
            reason: string;
            exitCode: number;
          };
    }
  | {
      type: "download";
      data: {
        downloadId: string;
        url: string;
        filename: string;
        path: string;
        receivedBytes: number;
        totalBytes: number;
        state: "progressing" | "done" | "failed";
        mimeType: string;
      };
    }
  | {
      type: "dialog";
      data: {
        dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
        message: string;
        url: string;
        defaultPrompt?: string;
        handled: "dismissed";
      };
    };

export class BrowserController {
  readonly surface: Surface;
  private readonly popupSurface: Surface;
  private readonly devtoolsSurface: Surface;
  private readonly window: BrowserWindow;
  private readonly onState: (state: BrowserState) => void;
  private readonly renderScale: number;
  private layout: BrowserSurfaceLayout;
  private state: BrowserState;
  private stopped = false;
  private contentFocused = false;
  private readonly input: PageInput;
  private readonly partition: string | null;
  private readonly cwd: string;
  private background: string;
  private pendingPopupSize: { width: number; height: number } | null = null;
  private findText = "";
  private readonly favicons = new FaviconCache();
  private faviconSeq = 0;
  private cdpAttached = false;
  private readonly frameContexts = new Map<string, number>();
  private cachedTargetId: string | null = null;
  private emitHandlers = new Map<string, (data: unknown) => void>();
  private dialogInterceptorReady: Promise<void> | null = null;
  private dialogInterceptorInstalled = false;
  private device: DeviceSpec | null = null;
  private defaultUserAgent = "";
  private readonly onDisplayChange = () => {
    if (this.stopped) return;
    this.window.webContents.setFrameRate(this.visible ? frameRate() : 4);
  };
  private visible = true;
  private wholeSurfaceNext = true;
  cursorShape = "default";
  onCursorChange: ((shape: string) => void) | null = null;
  onOpenTab: ((url: string, activate: boolean) => void) | null = null;
  popup: PopupWindow | null = null;
  onPopupChange: (() => void) | null = null;
  devtools: DevtoolsWindow | null = null;
  devtoolsFocused = false;
  onDevtoolsChange: (() => void) | null = null;
  onDevtoolsAction: ((action: DevtoolsAction) => void) | null = null;
  onContextMenu: ((params: Electron.ContextMenuParams) => void) | null = null;
  onLifecycleEvent: ((event: BrowserLifecycleEvent) => void) | null = null;
  onFrameLifecycle: ((event: BrowserAgentFrameLifecycle) => void) | null = null;
  onAgentEvent: ((event: BrowserAgentEvent) => void) | null = null;

  constructor(
    surface: Surface,
    popupSurface: Surface,
    devtoolsSurface: Surface,
    layout: BrowserSurfaceLayout,
    initialUrl: string,
    cwd: string,
    background: string,
    visible: boolean,
    partition: string | null,
    onState: (state: BrowserState) => void,
  ) {
    this.partition = partition;
    this.cwd = cwd;
    this.surface = surface;
    this.popupSurface = popupSurface;
    this.devtoolsSurface = devtoolsSurface;
    this.background = background;
    this.visible = visible;
    this.layout = layout;
    this.onState = onState;
    this.renderScale = browserRenderScale(layout);
    this.state = initialBrowserState(initialUrl);
    const size = this.contentSize(layout);
    this.window = new BrowserWindow({
      width: size.width,
      height: size.height,
      useContentSize: true,
      show: false,
      frame: false,
      paintWhenInitiallyHidden: true,
      acceptFirstMouse: true,
      skipTaskbar: true,
      fullscreenable: false,
      resizable: false,
      webPreferences: {
        ...(partition ? { partition } : {}),
        offscreen: offscreenPreferences(this.renderScale),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        disableDialogs: false,
        backgroundThrottling: false,
      },
    });
    this.input = new PageInput({
      contents: () => this.window.webContents,
      scale: () => this.layout.scale,
      focus: () => this.focusContent(),
      cdp: async (method, params) => {
        await this.attachCdp();
        return this.cdp(method, params);
      },
    });
    this.window.webContents.setFrameRate(frameRate());
    screen.on("display-added", this.onDisplayChange);
    screen.on("display-removed", this.onDisplayChange);
    screen.on("display-metrics-changed", this.onDisplayChange);
    this.defaultUserAgent = this.window.webContents.getUserAgent();
    this.window.webContents.on("paint", (event, dirtyRect, image) => {
      if (event.texture) {
        if (presentTexture(this.surface, event.texture, this.wholeSurfaceNext)) {
          this.wholeSurfaceNext = false;
        }
      } else {
        presentBitmap(this.surface, image, dirtyRect);
      }
    });
    this.window.webContents.on("did-start-loading", () => {
      this.dialogInterceptorReady = null;
      this.dialogInterceptorInstalled = false;
      this.updateState({ loading: true });
      this.onLifecycleEvent?.({ type: "load", loading: true, url: this.state.url });
    });
    this.window.webContents.on("did-stop-loading", () => {
      this.updateNavigation(false);
      this.onLifecycleEvent?.({ type: "load", loading: false, url: this.state.url });
      void this.installDialogInterceptor().catch(() => {});
    });
    this.window.webContents.on("did-navigate", (_event, url) => {
      if (urlHost(url) !== urlHost(this.state.url)) this.updateState({ favicon: null });
      this.updateNavigation(false, url);
      this.onLifecycleEvent?.({ type: "navigation", url, inPage: false });
    });
    this.window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      this.emitAgentEvent({
        type: "console",
        data: { level: consoleLevel(level), message, line, sourceId },
      });
    });
    this.window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (errorCode === -3) return;
        this.emitAgentEvent({
          type: "page.error",
          data: {
            kind: "load",
            code: errorCode,
            description: errorDescription,
            url: validatedURL,
            mainFrame: isMainFrame,
          },
        });
      },
    );
    this.window.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      this.emitAgentEvent({
        type: "page.error",
        data: { kind: "renderer", reason: details.reason, exitCode: details.exitCode },
      });
    });
    this.window.webContents.on("page-favicon-updated", (_event, favicons) => {
      void this.loadFavicon(favicons);
    });
    this.window.webContents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) {
        this.updateNavigation(this.state.loading, url);
        this.onLifecycleEvent?.({ type: "navigation", url, inPage: true });
      }
    });
    this.window.webContents.on("page-title-updated", (_event, title) => {
      this.updateState({ title });
    });
    this.window.webContents.on("cursor-changed", (_event, type) => {
      const shape = cursorShapeFor(type);
      if (shape === this.cursorShape) return;
      this.cursorShape = shape;
      this.onCursorChange?.(shape);
    });
    this.window.webContents.on("context-menu", (_event, params) => {
      this.onContextMenu?.(params);
    });
    this.window.webContents.on("found-in-page", (_event, result) => {
      this.updateState({
        findMatches: { active: result.activeMatchOrdinal, total: result.matches },
      });
    });
    this.window.webContents.setWindowOpenHandler(({ url, disposition, features }) => {
      const wantsTab = disposition === "foreground-tab" || disposition === "background-tab";
      if (wantsTab && this.onOpenTab) {
        this.onOpenTab(url, disposition === "foreground-tab");
        return { action: "deny" };
      }
      if (disposition === "new-window") {
        const size = this.popupSize(features);
        this.pendingPopupSize = size;
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: size.width,
            height: size.height,
            useContentSize: true,
            show: false,
            frame: false,
            skipTaskbar: true,
            fullscreenable: false,
            resizable: false,
            webPreferences: {
              ...(this.partition ? { partition: this.partition } : {}),
              offscreen: { useSharedTexture: false, deviceScaleFactor: this.renderScale },
              sandbox: true,
              nodeIntegration: false,
              contextIsolation: true,
              disableDialogs: true,
              backgroundThrottling: false,
            },
          },
        };
      }
      void this.window.webContents.loadURL(url);
      return { action: "deny" };
    });
    this.window.webContents.on("did-create-window", (child) => this.adoptPopup(child));
    void this.window.loadURL(normalizeUrl(initialUrl, cwd));
    this.onState(this.state);
  }

  resize(layout: BrowserSurfaceLayout, options?: { keepFrame?: boolean }) {
    if (
      this.layout.x === layout.x &&
      this.layout.y === layout.y &&
      this.layout.width === layout.width &&
      this.layout.height === layout.height &&
      this.layout.scale === layout.scale
    ) {
      return;
    }
    this.layout = layout;
    // why keep frame?
    if (!options?.keepFrame) this.surface.clear();
    const size = this.contentSize(layout);
    this.window.setContentSize(size.width, size.height, false);
  }

  navigate(value: string) {
    void this.window.webContents.loadURL(normalizeUrl(value, this.cwd));
  }

  back(): boolean {
    if (!this.window.webContents.navigationHistory.canGoBack()) return false;
    this.window.webContents.navigationHistory.goBack();
    return true;
  }

  forward(): boolean {
    if (!this.window.webContents.navigationHistory.canGoForward()) return false;
    this.window.webContents.navigationHistory.goForward();
    return true;
  }

  reload(bypassCache = false) {
    if (this.state.loading) this.window.webContents.stop();
    else if (bypassCache) this.window.webContents.reloadIgnoringCache();
    else this.window.webContents.reload();
  }

  reloadDocument(bypassCache = false) {
    if (bypassCache) this.window.webContents.reloadIgnoringCache();
    else this.window.webContents.reload();
  }

  zoom(direction: ZoomDirection): number {
    const factor = stepZoom(this.window.webContents, direction);
    this.updateState({ zoom: factor });
    return factor;
  }

  scaleZoom(ratio: number): number {
    const factor = scaleZoom(this.window.webContents, ratio);
    this.updateState({ zoom: factor });
    return factor;
  }

  osPid(): number {
    return this.window.webContents.getOSProcessId();
  }

  async fingerprint(): Promise<number | null> {
    if (this.stopped) return null;
    try {
      await this.attachCdp();
      const result = (await this.cdp("Runtime.evaluate", {
        expression: "performance.timeOrigin",
        returnByValue: true,
      })) as { result?: { value?: number } };
      return typeof result.result?.value === "number" ? result.result.value : null;
    } catch {
      return null;
    }
  }

  async targetId(): Promise<string | null> {
    if (this.cachedTargetId) return this.cachedTargetId;
    if (this.stopped) return null;
    try {
      await this.attachCdp();
      const info = (await this.cdp("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      this.cachedTargetId = info.targetInfo?.targetId ?? null;
    } catch {
      this.cachedTargetId = null;
    }
    return this.cachedTargetId;
  }

  async attachCdp(): Promise<void> {
    if (this.cdpAttached) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      if (method === "Page.frameAttached") {
        const frameId = (params as { frameId?: string }).frameId;
        const parentId = (params as { parentFrameId?: string }).parentFrameId;
        if (frameId && parentId) this.onFrameLifecycle?.({ type: "attached", frameId, parentId });
      } else if (method === "Page.frameNavigated") {
        this.frameContexts.clear();
        const frame = (params as { frame?: { id?: string; parentId?: string; url?: string; securityOrigin?: string } }).frame;
        if (frame?.id && frame.parentId) {
          this.onFrameLifecycle?.({
            type: "navigated",
            frameId: frame.id,
            parentId: frame.parentId,
            url: frame.url ?? "",
            origin: frame.securityOrigin ?? "",
          });
        }
      } else if (method === "Page.frameDetached") {
        this.frameContexts.clear();
        const frameId = (params as { frameId?: string }).frameId;
        if (frameId) this.onFrameLifecycle?.({ type: "detached", frameId });
      } else if (method === "Page.javascriptDialogOpening") {
        const dialog = params as {
          type?: "alert" | "confirm" | "prompt" | "beforeunload";
          message?: string;
          url?: string;
          defaultPrompt?: string;
        };
        this.emitAgentEvent({
          type: "dialog",
          data: {
            dialogType: dialog.type ?? "alert",
            message: dialog.message ?? "",
            url: dialog.url ?? "",
            ...(dialog.defaultPrompt === undefined ? {} : { defaultPrompt: dialog.defaultPrompt }),
            handled: "dismissed",
          },
        });
        void this.cdp("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
      }
      if (method !== "Runtime.bindingCalled") return;
      const call = params as { name: string; payload: string };
      if (call.name !== "__pixelEmit") return;
      try {
        const message = JSON.parse(call.payload) as { channel: string; data: unknown };
        this.emitHandlers.get(message.channel)?.(message.data);
      } catch {}
    });
    await this.cdp("Runtime.enable");
    await this.cdp("Runtime.addBinding", { name: "__pixelEmit" });
    await this.cdp("Page.enable");
    await this.emulateColorScheme();
  }

  async setBackground(background: string): Promise<void> {
    this.background = background;
    await this.emulateColorScheme();
  }

  private async emulateColorScheme(): Promise<void> {
    if (!this.cdpAttached) return;
    const n = parseInt(this.background.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    await this.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
    });
  }

  private async installDialogInterceptor(): Promise<void> {
    if (this.dialogInterceptorInstalled) return;
    if (!this.dialogInterceptorReady) {
      this.dialogInterceptorReady = (async () => {
        await this.attachCdp();
        await this.window.webContents.executeJavaScript(agentDialogInterceptorScript(), true);
        this.dialogInterceptorInstalled = true;
      })().catch((error) => {
        this.dialogInterceptorReady = null;
        throw error;
      });
    }
    await this.dialogInterceptorReady;
  }

  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.window.webContents.debugger.sendCommand(method, params) as Promise<
      Record<string, unknown>
    >;
  }

  onEmit(channel: string, handler: ((data: unknown) => void) | null) {
    if (handler) this.emitHandlers.set(channel, handler);
    else this.emitHandlers.delete(channel);
  }

  ownsWebContents(contents: WebContents): boolean {
    return this.window.webContents === contents;
  }

  emitAgentEvent(event: BrowserAgentEvent): void {
    if (!this.stopped) this.onAgentEvent?.(event);
  }

  async runJs(source: string): Promise<unknown> {
    await this.installDialogInterceptor();
    return this.window.webContents.executeJavaScript(source, true);
  }

  async agentFrames(): Promise<readonly BrowserAgentFrame[]> {
    await this.attachCdp();
    const result = (await this.cdp("Page.getFrameTree")) as { frameTree?: CdpFrameTree };
    const frames: BrowserAgentFrame[] = [];
    const visit = (tree: CdpFrameTree, parentId: string | null) => {
      frames.push({
        id: tree.frame.id,
        parentId,
        url: tree.frame.url,
        origin: tree.frame.securityOrigin,
      });
      for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
    };
    if (result.frameTree) visit(result.frameTree, null);
    return frames;
  }

  async runJsInFrame(frameId: string, source: string): Promise<unknown> {
    await this.installDialogInterceptor();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        let contextId = this.frameContexts.get(frameId);
        if (contextId === undefined) {
          const world = (await this.cdp("Page.createIsolatedWorld", {
            frameId,
            worldName: "terminal-browser-agent",
            grantUniveralAccess: true,
          })) as { executionContextId?: number };
          if (typeof world.executionContextId !== "number") throw new Error(`no execution context for frame ${frameId}`);
          contextId = world.executionContextId;
          this.frameContexts.set(frameId, contextId);
        }
        const result = (await this.cdp("Runtime.evaluate", {
          expression: source,
          contextId,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (!result.exceptionDetails) return result.result?.value;
        const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "frame evaluation failed";
        if (!/context|frame/i.test(detail) || attempt === 1) throw new Error(detail);
        this.frameContexts.delete(frameId);
      } catch (error) {
        if (attempt === 1 || !/context|frame/i.test(error instanceof Error ? error.message : String(error))) throw error;
        this.frameContexts.delete(frameId);
      }
    }
    throw new Error(`frame evaluation failed for ${frameId}`);
  }

  find(text: string) {
    this.findText = text;
    if (!text) {
      this.stopFind();
      return;
    }
    this.window.webContents.findInPage(text);
  }

  findNext(forward: boolean) {
    if (!this.findText) return;
    this.window.webContents.findInPage(this.findText, { forward, findNext: true });
  }

  stopFind() {
    this.findText = "";
    this.window.webContents.stopFindInPage("clearSelection");
    this.updateState({ findMatches: null });
  }

  focusContent() {
    this.blurDevtools();
    if (this.contentFocused) return;
    this.window.focus();
    /**
     * web contents, oh
     */
    this.window.webContents.focus();
    this.contentFocused = true;
    void this.setFocusEmulation(true).catch(() => {});
  }

  openDevtools(layout: BrowserSurfaceLayout, dock: DevtoolsDock) {
    if (this.devtools) return;
    const devtools = new DevtoolsWindow(
      this.window.webContents,
      this.devtoolsSurface,
      layout,
      dock,
      this.background,
      this.renderScale,
      (action) => this.onDevtoolsAction?.(action),
      () => {
        if (this.devtools !== devtools) return;
        this.devtools = null;
        this.devtoolsFocused = false;
        this.onDevtoolsChange?.();
      },
    );
    devtools.onCursorChange = () => this.onCursorChange?.(devtools.cursorShape);
    devtools.setVisible(this.visible);
    this.devtools = devtools;
    this.onDevtoolsChange?.();
  }

  closeDevtools() {
    this.devtools?.close();
  }

  focusDevtools() {
    if (this.devtoolsFocused || !this.devtools) return;
    this.blurContent();
    this.devtoolsFocused = true;
    this.devtools.focus();
  }

  blurDevtools() {
    if (!this.devtoolsFocused) return;
    this.devtoolsFocused = false;
    this.devtools?.blur();
  }

  inspect(x: number, y: number) {
    this.window.webContents.inspectElement(Math.round(x), Math.round(y));
  }

  selectionText() {
    return this.input.selectionText();
  }

  cut() {
    this.input.cut();
  }

  blurContent() {
    if (!this.contentFocused) return;
    this.input.releaseKeys();
    this.window.blurWebView();
    this.contentFocused = false;
    void this.setFocusEmulation(false).catch(() => {});
  }

  private async setFocusEmulation(enabled: boolean) {
    await this.attachCdp();
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled });
  }

  pointer(event: PointerEvent) {
    this.input.pointer(event);
  }

  wheel(event: WheelEvent) {
    this.input.wheel(event);
  }

  key(event: EngineKeyEvent) {
    this.input.key(event);
  }

  paste(text: string) {
    this.input.paste(text);
  }

  pasteImage(image: PastedImage) {
    this.input.pasteImage(image);
  }

  setActive(active: boolean) {
    if (!active) this.blurContent();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.popup?.close();
    this.devtools?.close();
    screen.off("display-added", this.onDisplayChange);
    screen.off("display-removed", this.onDisplayChange);
    screen.off("display-metrics-changed", this.onDisplayChange);
    this.onLifecycleEvent = null;
    this.onFrameLifecycle = null;
    this.onAgentEvent = null;
    this.emitHandlers.clear();
    this.surface.close();
    this.window.destroy();
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.popup?.setVisible(visible);
    this.devtools?.setVisible(visible);
    if (visible) {
      this.window.webContents.setFrameRate(frameRate());
      this.window.webContents.invalidate();
    } else {
      this.window.webContents.setFrameRate(4);
    }
  }

  private contentSize(layout: BrowserSurfaceLayout) {
    if (this.device) return { width: this.device.width, height: this.device.height };
    return cssSize(layout.width, layout.height, layout.scale);
  }

  setDevice(spec: DeviceSpec | null) {
    if (spec?.userAgent === this.device?.userAgent) return;
    this.device = spec;
    this.surface.clear();
    const size = this.contentSize(this.layout);
    this.window.setContentSize(size.width, size.height, false);
    if (spec) {
      this.window.webContents.setUserAgent(spec.userAgent);
      this.window.webContents.enableDeviceEmulation({
        screenPosition: "mobile",
        screenSize: { width: spec.width, height: spec.height },
        viewSize: { width: spec.width, height: spec.height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        scale: 1,
      });
    } else {
      this.window.webContents.disableDeviceEmulation();
      this.window.webContents.setUserAgent(this.defaultUserAgent);
    }
    this.window.webContents.reload();
  }

  private async loadFavicon(urls: string[]) {
    const seq = ++this.faviconSeq;
    const file = await this.favicons.resolve(urls).catch(() => null);
    if (file && seq === this.faviconSeq) this.updateState({ favicon: file });
  }

  private updateNavigation(loading: boolean, url = this.window.webContents.getURL()) {
    this.updateState({
      url,
      loading,
      canGoBack: this.window.webContents.navigationHistory.canGoBack(),
      canGoForward: this.window.webContents.navigationHistory.canGoForward(),
      zoom: this.window.webContents.getZoomFactor(),
    });
  }

  private updateState(update: Partial<BrowserState>) {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }

  private adoptPopup(child: Electron.BrowserWindow) {
    this.popup?.close();
    const size = this.pendingPopupSize ?? { width: 480, height: 360 };
    this.pendingPopupSize = null;
    const popup = new PopupWindow(
      child,
      this.popupSurface,
      size,
      this.renderScale,
      () => this.layout.scale,
      () => this.onPopupChange?.(),
      () => {
        if (this.popup === popup) this.popup = null;
        this.onPopupChange?.();
      },
    );
    this.popup = popup;
    this.onPopupChange?.();
  }

  private popupSize(features: string): { width: number; height: number } {
    const requested = (name: string) => {
      const match = features.match(new RegExp(`${name}=(\\d+)`));
      return match ? Number(match[1]) : 0;
    };
    const content = this.contentSize(this.layout);
    const clamp = (value: number, fallback: number, max: number) =>
      Math.max(280, Math.min(value || fallback, max));
    return {
      width: clamp(requested("width"), Math.round(content.width * 0.62), Math.round(content.width * 0.85)),
      height: clamp(requested("height"), Math.round(content.height * 0.68), Math.round(content.height * 0.8)),
    };
  }
}

interface CdpFrameTree {
  frame: {
    id: string;
    url: string;
    securityOrigin: string;
  };
  childFrames?: CdpFrameTree[];
}

function consoleLevel(level: number): "verbose" | "info" | "warning" | "error" {
  const levels = ["verbose", "info", "warning", "error"] as const;
  return levels[level] ?? "info";
}

function agentDialogInterceptorScript(): string {
  return `(() => {
    const installed = "__terminalBrowserAgentDialogsInstalled";
    if (window[installed]) return;
    Object.defineProperty(window, installed, { value: true });
    const emit = (dialogType, message, defaultPrompt) => {
      const binding = window.__pixelEmit;
      if (typeof binding !== "function") return;
      try {
        binding(JSON.stringify({
          channel: "terminal-browser.agent",
          data: {
            event: "dialog",
            data: {
              dialogType,
              message: String(message ?? ""),
              url: location.href,
              ...(defaultPrompt === undefined ? {} : { defaultPrompt: String(defaultPrompt) }),
              handled: "dismissed",
            },
          },
        }));
      } catch {}
    };
    window.alert = (message) => { emit("alert", message); };
    window.confirm = (message) => { emit("confirm", message); return false; };
    window.prompt = (message, defaultPrompt) => { emit("prompt", message, defaultPrompt); return null; };
  })()`;
}

function browserRenderScale(layout: BrowserSurfaceLayout) {
  const explicit = Number(process.env.TERMINAL_BROWSER_RENDER_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(0.5, Math.min(2, explicit));
  }
  const quality = process.platform === "linux" && offscreenMode() === "bitmap" ? 1.25 : 1;
  const preferred = Math.min(2, Math.max(1, layout.scale * quality));
  const maxPixels = Number(process.env.TERMINAL_BROWSER_MAX_PIXELS ?? 0);
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return preferred;
  const cssPixels = layout.width * layout.height / (layout.scale * layout.scale);
  return Math.max(0.5, Math.min(preferred, Math.sqrt(maxPixels / cssPixels)));
}
