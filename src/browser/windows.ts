import type { WindowInfo } from '../cdp/generated/domains/browser'
import type { CdpConnection } from '../cdp/connection'
import type { BackendMode } from './pages'

export type { WindowInfo }

export interface SetWindowVisibilityResult {
  window: WindowInfo
  replaced: boolean
  previousWindowId: number
  newWindowId: number
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const UNSUPPORTED = (method: string): Error =>
  new Error(
    `Window management (${method}) is not supported on standard Chrome. ` +
    'This capability requires BrowserOS custom CDP domains (Browser.getWindows, etc.).',
  )

/**
 * Wraps BrowserOS window CDP commands for browser-core callers and tools.
 *
 * In 'browseros' mode: full functionality via Browser.getWindows/createWindow/etc.
 * In 'chrome' mode: all methods throw UnsupportedError (standard Chrome has no window management CDP).
 */
export class WindowManager {
  constructor(
    private readonly cdp: CdpConnection,
    private readonly backend: BackendMode = 'browseros',
  ) {}

  async list(): Promise<WindowInfo[]> {
    if (this.backend === 'chrome') return []
    await this.ensureConnected()
    const result = await this.cdp.Browser.getWindows()
    return result.windows as WindowInfo[]
  }

  async create(opts?: { hidden?: boolean }): Promise<WindowInfo> {
    if (this.backend === 'chrome') throw UNSUPPORTED('create')
    await this.ensureConnected()
    const result = await this.cdp.Browser.createWindow({ hidden: opts?.hidden ?? false })
    return result.window as WindowInfo
  }

  async close(windowId: number): Promise<void> {
    if (this.backend === 'chrome') throw UNSUPPORTED('close')
    await this.ensureConnected()
    await this.cdp.Browser.closeWindow({ windowId })
  }

  async activate(windowId: number): Promise<void> {
    if (this.backend === 'chrome') throw UNSUPPORTED('activate')
    await this.ensureConnected()
    await this.cdp.Browser.activateWindow({ windowId })
  }

  async setVisibility(
    windowId: number,
    opts: { visible: boolean; activate?: boolean },
  ): Promise<SetWindowVisibilityResult> {
    if (this.backend === 'chrome') throw UNSUPPORTED('setVisibility')
    await this.ensureConnected()
    const result = await this.cdp.Browser.setWindowVisibility({
      windowId,
      visible: opts.visible,
      ...(opts.activate !== undefined && { activate: opts.activate }),
    })
    return {
      ...result,
      newWindowId: result.window.windowId,
    } as SetWindowVisibilityResult
  }

  private async ensureConnected(): Promise<void> {
    if (!this.cdp.isConnected()) {
      const deadline = Date.now() + 5000
      while (!this.cdp.isConnected() && Date.now() < deadline) {
        await delay(50)
      }
      if (!this.cdp.isConnected()) throw new Error('CDP not connected')
    }
  }
}
