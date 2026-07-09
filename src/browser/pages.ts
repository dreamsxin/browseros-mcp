import type { ProtocolApi } from '../cdp/generated/protocol-api'
import { logger } from './logger'
import {
  type CdpConnection,
  EXCLUDED_URL_PREFIXES,
  type SessionId,
} from '../cdp/connection'
import { bridgeInstallMessage, type BridgeTab, type ChromeExtensionBridge } from './chrome-extension-bridge'

/**
 * Backend mode determines which CDP domains are used for tab/page management.
 *   - 'browseros': Uses Browser.getTabs, Browser.createTab, etc. (custom CDP domains)
 *   - 'chrome':    Uses Target.getTargets, Target.createTarget, etc. (standard CDP)
 */
export type BackendMode = 'browseros' | 'chrome'

export interface PageInfo {
  pageId: number
  targetId: string
  tabId: number
  url: string
  title: string
  isActive: boolean
  isLoading: boolean
  loadProgress: number
  isPinned: boolean
  isHidden: boolean
  windowId?: number
  index?: number
  browserContextId?: string
  groupId?: string
}

type TabInfo = Omit<PageInfo, 'pageId'>
type WindowInfo = {
  windowId: number
  isVisible: boolean
  isActive: boolean
}

export interface PageSession {
  targetId: string
  sessionId: string
  session: ProtocolApi
  url: string
}

export interface PageManagerHooks {
  onSessionAttached?: (
    session: ProtocolApi,
    pageId: number,
    sessionId: string,
  ) => Promise<void>
  onPageDetached?: (pageId: number) => void
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Owns the stable pageId registry and its attached CDP tab sessions.
 *
 * Supports both BrowserOS (custom Browser.* CDP domains) and standard Chrome
 * (Target.* CDP domain). The mode is set at construction time.
 */
export class PageManager {
  private readonly pages = new Map<number, PageInfo>()
  private readonly sessions = new Map<string, SessionId>()
  private connectionEpoch: number
  private nextPageId = 1
  private hiddenWindowId?: number

  constructor(
    private readonly cdp: CdpConnection,
    private readonly hooks: PageManagerHooks = {},
    private readonly backend: BackendMode = 'browseros',
    private readonly bridge?: ChromeExtensionBridge,
  ) {
    this.connectionEpoch = cdp.connectionEpoch()
  }

  /** Reconcile the registry with the browser's live tabs (upsert + drop vanished). */
  async list(): Promise<PageInfo[]> {
    await this.ensureConnected()

    if (this.backend === 'browseros') {
      return this.listBrowserOS()
    }
    return this.listChrome()
  }

  // ── BrowserOS mode: uses Browser.getTabs ──

  private async listBrowserOS(): Promise<PageInfo[]> {
    const result = await this.cdp.Browser.getTabs({ includeHidden: true })
    const tabs = (result.tabs as TabInfo[]).filter(
      (tab) => !EXCLUDED_URL_PREFIXES.some((prefix) => tab.url.startsWith(prefix)),
    )

    const seen = new Set<string>()
    for (const tab of tabs) {
      seen.add(tab.targetId)
      const existing = this.findByTarget(tab.targetId) ?? this.findByTab(tab.tabId)
      if (existing) {
        if (existing.targetId !== tab.targetId) {
          this.sessions.delete(existing.targetId)
        }
        Object.assign(existing, tab, { windowId: tab.windowId ?? existing.windowId })
      } else {
        const pageId = this.nextPageId++
        this.pages.set(pageId, { pageId, ...tab })
      }
    }

    for (const [pageId, info] of this.pages) {
      if (!seen.has(info.targetId)) {
        this.pages.delete(pageId)
        this.sessions.delete(info.targetId)
        this.hooks.onPageDetached?.(pageId)
      }
    }

    return this.sortForVisualOrder([...this.pages.values()])
  }

  // ── Standard Chrome mode: uses Target.getTargets ──

  private async listChrome(): Promise<PageInfo[]> {
    const result = await this.cdp.Target.getTargets()
    const targets = result.targetInfos
      .filter((t) => t.type === 'page')
      .filter((t) => !EXCLUDED_URL_PREFIXES.some((prefix) => t.url.startsWith(prefix)))

    const seen = new Set<string>()
    for (const target of targets) {
      seen.add(target.targetId)
      const bridgeTab = this.bridge?.getTabByTarget(target.targetId)
      const existing = this.findByTarget(target.targetId)
      if (existing) {
        Object.assign(existing, this.chromeTabInfo(target, existing.pageId, bridgeTab, existing))
      } else {
        const pageId = this.nextPageId++
        const tab = this.chromeTabInfo(target, pageId, bridgeTab)
        this.pages.set(pageId, { pageId, ...tab })
      }
    }

    for (const [pageId, info] of this.pages) {
      if (!seen.has(info.targetId)) {
        this.pages.delete(pageId)
        this.sessions.delete(info.targetId)
        this.hooks.onPageDetached?.(pageId)
      }
    }

    return this.sortForVisualOrder([...this.pages.values()])
  }

  getInfo(pageId: number): PageInfo | undefined {
    return this.pages.get(pageId)
  }

  getTabId(pageId: number): number | undefined {
    return this.pages.get(pageId)?.tabId
  }

  /** Resolve a pageId to its attached CDP session, listing pages first if unseen. */
  async getSession(pageId: number): Promise<PageSession> {
    const reconnected = await this.ensureConnected()
    let info = this.pages.get(pageId)
    if (!info || reconnected) {
      await this.list()
      info = this.pages.get(pageId)
    }
    if (!info) {
      throw new Error(`Unknown page ${pageId}. List pages to see what is open.`)
    }
    const sessionId = await this.attach(info.targetId, pageId)
    return {
      targetId: info.targetId,
      sessionId,
      session: this.cdp.session(sessionId),
      url: info.url,
    }
  }

  getAttachedSession(pageId: number): ProtocolApi | null {
    const info = this.pages.get(pageId)
    if (!info) return null
    const sessionId = this.sessions.get(info.targetId)
    return sessionId ? this.cdp.session(sessionId) : null
  }

  async getActive(): Promise<PageInfo | null> {
    await this.ensureConnected()

    if (this.backend === 'browseros') {
      const result = await this.cdp.Browser.getActiveTab()
      if (!result.tab) return null
      await this.list()
      const tab = result.tab as TabInfo
      return this.findByTarget(tab.targetId) ?? null
    }

    if (this.bridge?.hasUsableState()) {
      await this.list()
      const active = [...this.pages.values()].find((page) => page.isActive)
      if (active) return active
    }

    // Standard Chrome without the extension bridge: no "active tab" CDP command, return first page
    await this.list()
    const first = [...this.pages.values()][0]
    return first ?? null
  }

  async getActiveSessionForWindow(windowId: number): Promise<PageSession> {
    await this.ensureConnected()

    if (this.backend === 'browseros') {
      const result = await this.cdp.Browser.getActiveTab({ windowId })
      const tab = result.tab as TabInfo | undefined
      if (!tab) throw new Error(`No active tab in window ${windowId}`)
      const pageId = await this.ensurePageIdForTarget(tab.targetId)
      const sessionId = await this.attach(tab.targetId, pageId)
      return {
        targetId: tab.targetId,
        sessionId,
        session: this.cdp.session(sessionId),
        url: tab.url,
      }
    }

    // Standard Chrome: no window concept, degrade to first page
    await this.list()
    const first = [...this.pages.values()][0]
    if (!first) throw new Error(`No active tab in window ${windowId}`)
    const sessionId = await this.attach(first.targetId, first.pageId)
    return {
      targetId: first.targetId,
      sessionId,
      session: this.cdp.session(sessionId),
      url: first.url,
    }
  }

  async refresh(pageId: number): Promise<PageInfo | undefined> {
    await this.ensureConnected()
    let info = this.pages.get(pageId)
    if (!info) {
      await this.list()
      info = this.pages.get(pageId)
    }
    if (!info) return undefined

    if (this.backend === 'browseros') {
      try {
        const result = await this.cdp.Browser.getTabInfo({ tabId: info.tabId })
        const tab = result.tab as TabInfo
        const updated: PageInfo = { ...info, ...tab, windowId: tab.windowId ?? info.windowId }
        this.pages.set(pageId, updated)
        return updated
      } catch {
        await this.list()
        return this.pages.get(pageId)
      }
    }

    // Standard Chrome: use Target.getTargets to find the target and merge bridge state when available
    const result = await this.cdp.Target.getTargets()
    const target = result.targetInfos.find((t) => t.targetId === info!.targetId)
    if (target) {
      const updated: PageInfo = {
        ...info,
        ...this.chromeTabInfo(target, info.pageId, this.bridge?.getTabByTarget(target.targetId), info),
      }
      this.pages.set(pageId, updated)
      return updated
    }
    await this.list()
    return this.pages.get(pageId)
  }

  async resolveTabIds(tabIds: number[]): Promise<Map<number, number>> {
    await this.list()
    const tabToPage = new Map<number, number>()
    for (const info of this.pages.values()) {
      if (tabIds.includes(info.tabId)) tabToPage.set(info.tabId, info.pageId)
    }
    return tabToPage
  }

  async newPage(
    url: string,
    opts?: {
      background?: boolean
      hidden?: boolean
      windowId?: number
      tabGroupId?: string
    },
  ): Promise<number> {
    await this.ensureConnected()

    if (this.backend === 'browseros') {
      return this.newPageBrowserOS(url, opts)
    }
    return this.newPageChrome(url, opts)
  }

  private async newPageBrowserOS(
    url: string,
    opts?: { background?: boolean; hidden?: boolean; windowId?: number; tabGroupId?: string },
  ): Promise<number> {
    const windowId = await this.resolveWindowIdForNewPage(opts)
    const created = await this.cdp.Browser.createTab({
      url,
      ...(opts?.background !== undefined && { background: opts.background }),
      ...(windowId !== undefined && { windowId }),
    })
    const tabId = (created.tab as TabInfo).tabId

    let tab: TabInfo | undefined
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        tab = (await this.cdp.Browser.getTabInfo({ tabId })).tab as TabInfo
        if (!tab.isLoading || tab.loadProgress >= 1) break
      } catch { /* keep polling */ }
      await delay(100)
    }
    if (!tab) throw new Error(`Tab ${tabId} not found after creation`)

    if (opts?.tabGroupId) {
      try {
        await this.cdp.Browser.addTabsToGroup({ groupId: opts.tabGroupId, tabIds: [tabId] })
        tab = (await this.cdp.Browser.getTabInfo({ tabId })).tab as TabInfo
      } catch (error) {
        logger.warn('Failed to add new page to default tab group', {
          tabGroupId: opts.tabGroupId,
          tabId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const pageId = this.nextPageId++
    this.pages.set(pageId, { pageId, ...tab, url: tab.url || url })
    return pageId
  }

  private async newPageChrome(
    url: string,
    opts?: { background?: boolean; windowId?: number },
  ): Promise<number> {
    if (this.bridge?.isConnected()) {
      const tab = await this.bridge.createTab({
        url,
        background: opts?.background,
        ...(opts?.windowId !== undefined && { windowId: opts.windowId }),
      })
      const pageId = this.nextPageId++
      const targetId = tab.targetId
      if (!targetId) {
        await this.list()
        const found = this.findByTab(tab.tabId)
        if (found) return found.pageId
        throw new Error('Extension created a tab, but no CDP targetId has been reported yet.')
      }
      const page = this.pageInfoFromBridgeTab(pageId, tab, targetId, url)
      this.pages.set(pageId, page)
      return pageId
    }

    // Standard Chrome: Target.createTarget
    // Note: hidden/windowId/tabGroupId are not supported on standard Chrome
    const result = await this.cdp.Target.createTarget({ url })
    const targetId = result.targetId

    const pageId = this.nextPageId++
    const tab: TabInfo = {
      targetId,
      tabId: pageId,
      url,
      title: '',
      isActive: !opts?.background,
      isLoading: true,
      loadProgress: 0,
      isPinned: false,
      isHidden: false,
    }
    this.pages.set(pageId, { pageId, ...tab })
    return pageId
  }

  private async resolveWindowIdForNewPage(opts?: {
    hidden?: boolean
    windowId?: number
  }): Promise<number | undefined> {
    if (!opts?.hidden) {
      if (opts?.windowId !== undefined) return opts.windowId
      return undefined
    }

    const windows = (await this.cdp.Browser.getWindows()).windows as WindowInfo[]
    if (opts.windowId !== undefined) {
      const targetWindow = windows.find((w) => w.windowId === opts.windowId)
      if (targetWindow && !targetWindow.isVisible) {
        this.hiddenWindowId = targetWindow.windowId
        return targetWindow.windowId
      }
      if (targetWindow?.isVisible) {
        logger.warn('Requested hidden page target window is visible, creating a new hidden window instead', { requestedWindowId: opts.windowId })
      }
      const hiddenWindow = await this.cdp.Browser.createWindow({ hidden: true })
      this.hiddenWindowId = (hiddenWindow.window as WindowInfo).windowId
      return this.hiddenWindowId
    }

    if (this.hiddenWindowId !== undefined) {
      const cachedWindow = windows.find((w) => w.windowId === this.hiddenWindowId)
      if (cachedWindow && !cachedWindow.isVisible) return cachedWindow.windowId
      this.hiddenWindowId = undefined
    }

    const hiddenWindow = await this.cdp.Browser.createWindow({ hidden: true })
    this.hiddenWindowId = (hiddenWindow.window as WindowInfo).windowId
    return this.hiddenWindowId
  }

  async close(pageId: number): Promise<void> {
    const info = this.pages.get(pageId)
    if (!info) throw new Error(`Unknown page ${pageId}.`)

    if (this.backend === 'browseros') {
      await this.cdp.Browser.closeTab({ tabId: info.tabId })
    } else if (this.bridge?.isConnected()) {
      await this.bridge.closeTab(info.tabId)
    } else {
      await this.cdp.Target.closeTarget({ targetId: info.targetId })
    }

    this.pages.delete(pageId)
    this.sessions.delete(info.targetId)
    this.hooks.onPageDetached?.(pageId)
  }

  async show(
    pageId: number,
    opts?: { windowId?: number; index?: number; activate?: boolean },
  ): Promise<PageInfo> {
    await this.ensureConnected()
    const info = (await this.refresh(pageId)) ?? this.requireInfo(pageId)

    if (this.backend === 'browseros') {
      if (!info.isHidden) {
        throw new Error(`Page ${pageId} is already visible.`)
      }
      const result = await this.cdp.Browser.showTab({
        tabId: info.tabId,
        ...(opts?.windowId !== undefined && { windowId: opts.windowId }),
        ...(opts?.index !== undefined && { index: opts.index }),
        ...(opts?.activate !== undefined && { activate: opts.activate }),
      })
      return this.updateFromTab(pageId, result.tab as TabInfo)
    }

    // Standard Chrome: use the extension bridge when available, otherwise Target.activateTarget
    if (info.isHidden) info.isHidden = false
    if (this.bridge?.isConnected()) {
      await this.bridge.activateTab(info.tabId)
    } else {
      try {
        await this.cdp.Target.activateTarget({ targetId: info.targetId })
      } catch { /* some Chrome versions reject this for browser-level targets */ }
    }
    this.pages.set(pageId, info)
    return info
  }

  async activate(pageId: number): Promise<PageInfo> {
    await this.ensureConnected()
    const info = (await this.refresh(pageId)) ?? this.requireInfo(pageId)

    if (this.backend === 'browseros') {
      await this.cdp.Browser.activateTab({ tabId: info.tabId })
      await this.list()
      return this.markActive(pageId, this.findByTab(info.tabId) ?? info)
    }

    if (this.bridge?.isConnected()) {
      const tab = await this.bridge.activateTab(info.tabId)
      return this.markActive(pageId, this.tabInfoFromBridgeTab(tab, info.targetId, info.url))
    }

    try {
      await this.cdp.Target.activateTarget({ targetId: info.targetId })
    } catch { /* some Chrome versions reject this for browser-level targets */ }
    return this.markActive(pageId, info)
  }

  async move(
    pageId: number,
    opts?: { windowId?: number; index?: number },
  ): Promise<PageInfo> {
    await this.ensureConnected()
    const info = (await this.refresh(pageId)) ?? this.requireInfo(pageId)

    if (this.backend === 'browseros') {
      const result = await this.cdp.Browser.moveTab({
        tabId: info.tabId,
        ...(opts?.windowId !== undefined && { windowId: opts.windowId }),
        ...(opts?.index !== undefined && { index: opts.index }),
      })
      return this.updateFromTab(pageId, result.tab as TabInfo)
    }

    if (!this.bridge?.isConnected()) {
      throw new Error(bridgeInstallMessage())
    }
    const tab = await this.bridge.moveTab(info.tabId, opts)
    return this.updateFromTab(pageId, this.tabInfoFromBridgeTab(tab, info.targetId, info.url))
  }

  async duplicate(pageId: number): Promise<PageInfo> {
    await this.ensureConnected()
    const info = (await this.refresh(pageId)) ?? this.requireInfo(pageId)

    if (this.backend === 'browseros') {
      const result = await this.cdp.Browser.duplicateTab({ tabId: info.tabId })
      return this.upsertFromTab(result.tab as TabInfo)
    }

    if (!this.bridge?.isConnected()) {
      throw new Error(bridgeInstallMessage())
    }
    const tab = await this.bridge.duplicateTab(info.tabId)
    if (!tab.targetId) throw new Error('Extension did not report targetId for duplicated tab.')
    return this.upsertFromTab(this.tabInfoFromBridgeTab(tab, tab.targetId, tab.url ?? info.url))
  }

  async setPinned(pageId: number, pinned: boolean): Promise<PageInfo> {
    await this.ensureConnected()
    const info = (await this.refresh(pageId)) ?? this.requireInfo(pageId)

    if (this.backend === 'browseros') {
      const result = pinned
        ? await this.cdp.Browser.pinTab({ tabId: info.tabId })
        : await this.cdp.Browser.unpinTab({ tabId: info.tabId })
      return this.updateFromTab(pageId, result.tab as TabInfo)
    }

    if (!this.bridge?.isConnected()) {
      throw new Error(bridgeInstallMessage())
    }
    const tab = await this.bridge.pinTab(info.tabId, pinned)
    return this.updateFromTab(pageId, this.tabInfoFromBridgeTab(tab, info.targetId, info.url))
  }

  detachSession(sessionId: SessionId): void {
    for (const [targetId, sid] of this.sessions) {
      if (sid === sessionId) {
        this.sessions.delete(targetId)
        return
      }
    }
  }

  private async attach(targetId: string, pageId: number): Promise<SessionId> {
    await this.ensureConnected()
    const cached = this.sessions.get(targetId)
    if (cached) return cached

    const { sessionId } = await this.cdp.Target.attachToTarget({
      targetId,
      flatten: true,
    })
    const session = this.cdp.session(sessionId)
    await Promise.all([
      session.Page.enable(),
      session.DOM.enable(),
      session.Runtime.enable(),
      session.Accessibility.enable(),
    ])
    this.sessions.set(targetId, sessionId)
    await this.hooks.onSessionAttached?.(session, pageId, sessionId)
    return sessionId
  }

  private async ensureConnected(): Promise<boolean> {
    if (!this.cdp.isConnected()) {
      await this.waitForConnection()
    }
    const epoch = this.cdp.connectionEpoch()
    if (epoch !== this.connectionEpoch) {
      this.sessions.clear()
      this.hiddenWindowId = undefined
      this.connectionEpoch = epoch
      return true
    }
    return false
  }

  private async waitForConnection(): Promise<void> {
    const deadline = Date.now() + 5000
    while (!this.cdp.isConnected() && Date.now() < deadline) {
      await delay(50)
    }
    if (!this.cdp.isConnected()) throw new Error('CDP not connected')
  }

  private async ensurePageIdForTarget(targetId: string): Promise<number> {
    const existing = this.findByTarget(targetId)
    if (existing) return existing.pageId
    await this.list()
    const found = this.findByTarget(targetId)
    if (found) return found.pageId
    throw new Error(`Could not resolve pageId for target ${targetId}`)
  }

  private findByTarget(targetId: string): PageInfo | undefined {
    for (const info of this.pages.values()) {
      if (info.targetId === targetId) return info
    }
    return undefined
  }

  private findByTab(tabId: number): PageInfo | undefined {
    for (const info of this.pages.values()) {
      if (info.tabId === tabId) return info
    }
    return undefined
  }

  private requireInfo(pageId: number): PageInfo {
    const info = this.pages.get(pageId)
    if (!info) throw new Error(`Unknown page ${pageId}. List pages to see what is open.`)
    return info
  }

  private updateFromTab(pageId: number, tab: TabInfo): PageInfo {
    const info = this.requireInfo(pageId)
    const updated: PageInfo = { ...info, ...tab, windowId: tab.windowId ?? info.windowId }
    this.pages.set(pageId, updated)
    return updated
  }

  private upsertFromTab(tab: TabInfo): PageInfo {
    const existing = this.findByTarget(tab.targetId) ?? this.findByTab(tab.tabId)
    if (existing) return this.updateFromTab(existing.pageId, tab)
    const pageId = this.nextPageId++
    const page: PageInfo = { pageId, ...tab }
    this.pages.set(pageId, page)
    return page
  }

  private markActive(pageId: number, tab: TabInfo): PageInfo {
    const existing = this.requireInfo(pageId)
    const updated: PageInfo = {
      ...existing,
      ...tab,
      isActive: true,
      windowId: tab.windowId ?? existing.windowId,
    }
    for (const [otherPageId, other] of this.pages) {
      if (otherPageId !== pageId && other.windowId === updated.windowId) {
        this.pages.set(otherPageId, { ...other, isActive: false })
      }
    }
    this.pages.set(pageId, updated)
    return updated
  }

  private chromeTabInfo(
    target: { targetId: string; url: string; title: string; browserContextId?: string },
    pageId: number,
    bridgeTab?: BridgeTab,
    existing?: PageInfo,
  ): TabInfo {
    return {
      targetId: target.targetId,
      tabId: bridgeTab?.tabId ?? existing?.tabId ?? pageId,
      url: bridgeTab?.url ?? target.url,
      title: bridgeTab?.title ?? target.title,
      isActive: bridgeTab?.active ?? existing?.isActive ?? false,
      isLoading: bridgeTab?.status === 'loading',
      loadProgress: bridgeTab?.status === 'loading' ? 0 : 1,
      isPinned: bridgeTab?.pinned ?? existing?.isPinned ?? false,
      isHidden: bridgeTab?.hidden ?? existing?.isHidden ?? false,
      ...(bridgeTab?.windowId !== undefined && { windowId: bridgeTab.windowId }),
      ...(bridgeTab?.index !== undefined && { index: bridgeTab.index }),
      ...(bridgeTab?.groupId !== undefined && bridgeTab.groupId >= 0 && { groupId: String(bridgeTab.groupId) }),
      ...(target.browserContextId !== undefined && { browserContextId: target.browserContextId }),
    }
  }

  private pageInfoFromBridgeTab(
    pageId: number,
    tab: BridgeTab,
    targetId: string,
    fallbackUrl: string,
  ): PageInfo {
    return {
      pageId,
      ...this.tabInfoFromBridgeTab(tab, targetId, fallbackUrl),
    }
  }

  private tabInfoFromBridgeTab(tab: BridgeTab, targetId: string, fallbackUrl: string): TabInfo {
    return {
      targetId,
      tabId: tab.tabId,
      url: tab.url ?? fallbackUrl,
      title: tab.title ?? '',
      isActive: tab.active ?? false,
      isLoading: tab.status === 'loading',
      loadProgress: tab.status === 'loading' ? 0 : 1,
      isPinned: tab.pinned ?? false,
      isHidden: tab.hidden ?? false,
      windowId: tab.windowId,
      index: tab.index,
      ...(tab.groupId !== undefined && tab.groupId >= 0 && { groupId: String(tab.groupId) }),
    }
  }

  private sortForVisualOrder(pages: PageInfo[]): PageInfo[] {
    return pages.sort((a, b) => {
      const hidden = Number(a.isHidden) - Number(b.isHidden)
      if (hidden !== 0) return hidden

      const window = compareOptionalNumber(a.windowId, b.windowId)
      if (window !== 0) return window

      const index = compareOptionalNumber(a.index, b.index)
      if (index !== 0) return index

      return a.pageId - b.pageId
    })
  }
}

function compareOptionalNumber(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a - b
}
