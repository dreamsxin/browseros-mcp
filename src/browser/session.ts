import type { CdpConnection } from '../cdp/connection'
import { Input } from './core/input/input'
import { Navigation } from './core/navigation'
import { FrameRegistry } from './core/observer/frames'
import { Observer } from './core/observer/observer'
import { PageManager, type PageManagerHooks, type BackendMode } from './pages'
import {
  captureScreenshotWithAnnotations,
  type ScreenshotCaptureOptions,
  type ScreenshotCaptureResult,
} from './core/screenshot'
import { WindowManager } from './windows'

export interface BrowserSessionHooks extends PageManagerHooks {}

export interface BrowserSessionOptions {
  hooks?: BrowserSessionHooks
  /** Backend mode: 'browseros' (custom CDP domains) or 'chrome' (standard CDP) */
  backend?: BackendMode
}

/** Coordinates page registry, observation, input, navigation, and raw CDP access. */
export class BrowserSession {
  readonly pages: PageManager
  readonly windows: WindowManager
  private readonly frames: FrameRegistry
  private readonly observers = new Map<number, Observer>()
  readonly backend: BackendMode

  constructor(
    private readonly connection: CdpConnection,
    options: BrowserSessionOptions = {},
  ) {
    const { hooks = {}, backend = 'browseros' } = options
    this.backend = backend
    this.frames = new FrameRegistry(connection)
    this.windows = new WindowManager(connection, backend)
    this.pages = new PageManager(
      connection,
      {
        ...hooks,
        onSessionAttached: async (session, pageId, sessionId) => {
          await this.frames.registerPage(session, pageId, sessionId)
          await hooks.onSessionAttached?.(session, pageId, sessionId)
        },
        onPageDetached: (pageId) => {
          this.observers.delete(pageId)
          this.frames.unregisterPage(pageId)
          hooks.onPageDetached?.(pageId)
        },
      },
      backend,
    )
    this.connection.Target.on('detachedFromTarget', (params) => {
      if (params.sessionId) this.pages.detachSession(params.sessionId)
    })
  }

  /** Per-page observation (snapshot + diff), created lazily and cached. */
  observe(pageId: number): Observer {
    let observer = this.observers.get(pageId)
    if (!observer) {
      observer = new Observer(this.pages, this.frames, pageId)
      this.observers.set(pageId, observer)
    }
    return observer
  }

  /** The action layer (click/fill/type/...) for a page, sharing its observation refs. */
  input(pageId: number): Input {
    return new Input(this.observe(pageId), this.pages, pageId)
  }

  /** Navigation (url/back/forward/reload) for a page. */
  nav(pageId: number): Navigation {
    return new Navigation(this.pages, pageId)
  }

  /** Captures a page screenshot, optionally overlaying current snapshot refs. */
  async screenshot(
    pageId: number,
    options: ScreenshotCaptureOptions = {},
  ): Promise<ScreenshotCaptureResult> {
    const { session } = await this.pages.getSession(pageId)
    return captureScreenshotWithAnnotations({
      pageSession: session,
      observer: this.observe(pageId),
      options,
    })
  }

  /** Raw CDP escape hatch for `run` code, e.g. cdp("Page.navigate", { url }). */
  async cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    return this.connection.rawSend(method, params ?? {}, sessionId)
  }

  /** Raw CDP escape hatch that sends already-validated JSON params verbatim. */
  async cdpJson(
    method: string,
    paramsJson: string,
    sessionId?: string,
  ): Promise<unknown> {
    return this.connection.rawSendJson(method, paramsJson, sessionId)
  }

  /** Page-scoped raw CDP for CLI/run callers that start from a BrowserOS page id. */
  async cdpJsonForPage(
    pageId: number,
    method: string,
    paramsJson: string,
  ): Promise<unknown> {
    const { sessionId } = await this.pages.getSession(pageId)
    return this.connection.rawSendJson(method, paramsJson, sessionId)
  }

  isConnected(): boolean {
    return this.connection.isConnected()
  }

  async dispose(): Promise<void> {}
}
