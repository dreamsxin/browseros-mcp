import { randomUUID } from 'node:crypto'
import type { Bounds, WindowInfo, WindowType } from '../cdp/generated/domains/browser'
import type { BookmarkNode } from '../cdp/generated/domains/bookmarks'
import type { HistoryEntry } from '../cdp/generated/domains/history'
import type { TabGroup } from './tab-groups'

export interface BridgeTab {
  tabId: number
  targetId?: string
  windowId: number
  index: number
  url?: string
  title?: string
  active?: boolean
  pinned?: boolean
  hidden?: boolean
  status?: 'loading' | 'complete'
  groupId?: number
}

export interface BridgeWindow {
  windowId: number
  type?: string
  focused?: boolean
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen'
  tabCount?: number
  activeTabId?: number
  bounds?: Bounds
}

export interface BridgeTabGroup {
  groupId: number
  windowId: number
  title?: string
  color?: string
  collapsed?: boolean
  tabIds?: number[]
}

export interface BridgeStateSnapshot {
  sequence?: number
  browserId?: string
  tabs?: BridgeTab[]
  windows?: BridgeWindow[]
  groups?: BridgeTabGroup[]
}

export interface BridgeCommand {
  id: string
  type: string
  payload?: Record<string, unknown>
}

export type BridgeCommandSender = (command: BridgeCommand) => boolean

interface PendingCommand {
  command: BridgeCommand
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BridgeCommandResult {
  ok: boolean
  result?: unknown
  error?: string
}

export interface BridgeHealth {
  connected: boolean
  lastSeenAt?: number
  ageMs?: number
  sequence: number
  browserId?: string
  pendingCommands: number
  tabs: number
  windows: number
  groups: number
}

const BRIDGE_STALE_MS = 60_000
const COMMAND_TIMEOUT_MS = 10_000

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export class ChromeExtensionBridge {
  private browserId?: string
  private sequence = 0
  private lastSeenAt = 0
  private readonly tabsById = new Map<number, BridgeTab>()
  private readonly targetToTab = new Map<string, number>()
  private readonly windowsById = new Map<number, BridgeWindow>()
  private readonly groupsById = new Map<number, BridgeTabGroup>()
  private readonly pendingCommands = new Map<string, PendingCommand>()
  private commandWaiters: (() => void)[] = []
  private commandSender?: BridgeCommandSender

  hello(browserId?: string): BridgeHealth {
    this.touch(browserId)
    return this.health()
  }

  heartbeat(browserId?: string): BridgeHealth {
    this.touch(browserId)
    return this.health()
  }

  setCommandSender(sender?: BridgeCommandSender): void {
    this.commandSender = sender
  }

  updateState(snapshot: BridgeStateSnapshot): BridgeHealth {
    this.touch(snapshot.browserId)
    if (typeof snapshot.sequence === 'number') this.sequence = snapshot.sequence

    if (snapshot.tabs) {
      this.tabsById.clear()
      this.targetToTab.clear()
      for (const tab of snapshot.tabs) {
        this.tabsById.set(tab.tabId, tab)
        if (tab.targetId) this.targetToTab.set(tab.targetId, tab.tabId)
      }
    }

    if (snapshot.windows) {
      this.windowsById.clear()
      for (const window of snapshot.windows) {
        this.windowsById.set(window.windowId, window)
      }
    }

    if (snapshot.groups) {
      this.groupsById.clear()
      for (const group of snapshot.groups) {
        this.groupsById.set(group.groupId, group)
      }
    }

    this.normalizeActiveTabs()
    return this.health()
  }

  health(): BridgeHealth {
    const connected = this.isConnected()
    return {
      connected,
      ...(this.lastSeenAt > 0 && {
        lastSeenAt: this.lastSeenAt,
        ageMs: Date.now() - this.lastSeenAt,
      }),
      sequence: this.sequence,
      ...(this.browserId && { browserId: this.browserId }),
      pendingCommands: this.pendingCommands.size,
      tabs: this.tabsById.size,
      windows: this.windowsById.size,
      groups: this.groupsById.size,
    }
  }

  isConnected(): boolean {
    return this.lastSeenAt > 0 && Date.now() - this.lastSeenAt <= BRIDGE_STALE_MS
  }

  hasUsableState(): boolean {
    return this.isConnected() && this.tabsById.size > 0
  }

  hasSnapshot(): boolean {
    return this.lastSeenAt > 0
  }

  getTabByTarget(targetId: string): BridgeTab | undefined {
    const tabId = this.targetToTab.get(targetId)
    return tabId === undefined ? undefined : this.tabsById.get(tabId)
  }

  getTab(tabId: number): BridgeTab | undefined {
    return this.tabsById.get(tabId)
  }

  listTabs(): BridgeTab[] {
    return [...this.tabsById.values()].sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId
      return a.index - b.index
    })
  }

  listWindows(): WindowInfo[] {
    return [...this.windowsById.values()]
      .sort((a, b) => a.windowId - b.windowId)
      .map((window) => this.toWindowInfo(window))
  }

  listGroups(): TabGroup[] {
    return [...this.groupsById.values()]
      .sort((a, b) => a.windowId - b.windowId || a.groupId - b.groupId)
      .map((group) => ({
        groupId: String(group.groupId),
        windowId: group.windowId,
        title: group.title ?? '',
        color: group.color ?? 'grey',
        collapsed: group.collapsed ?? false,
        tabIds: group.tabIds ?? this.tabsForGroup(group.groupId).map((tab) => tab.tabId),
      }))
  }

  async pollCommand(timeoutMs = 25_000): Promise<BridgeCommand | null> {
    const existing = this.nextCommand()
    if (existing) return existing

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs)
      this.commandWaiters.push(() => {
        clearTimeout(timeout)
        resolve()
      })
    })

    return this.nextCommand()
  }

  completeCommand(commandId: string, result: BridgeCommandResult): boolean {
    const pending = this.pendingCommands.get(commandId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pendingCommands.delete(commandId)
    if (result.ok) {
      this.mergeStateFromCommandResult(result.result)
      pending.resolve(result.result)
    } else {
      pending.reject(new Error(result.error ?? 'Extension command failed'))
    }
    return true
  }

  async createTab(params: {
    url: string
    background?: boolean
    windowId?: number
  }): Promise<BridgeTab> {
    const result = await this.enqueueCommand('tabs.create', {
      url: params.url,
      active: params.background === undefined ? true : !params.background,
      ...(params.windowId !== undefined && { windowId: params.windowId }),
    })
    await delay(100)
    const tabId = this.extractTabId(result)
    const tab = tabId === undefined ? undefined : await this.waitForTab(tabId, true)
    if (!tab) throw new Error('Extension did not report the created tab.')
    return tab
  }

  async closeTab(tabId: number): Promise<void> {
    await this.enqueueCommand('tabs.close', { tabId })
  }

  async activateTab(tabId: number): Promise<BridgeTab> {
    await this.enqueueCommand('tabs.activate', { tabId })
    await delay(100)
    const tab = this.tabsById.get(tabId)
    if (!tab) throw new Error(`Extension did not report activated tab ${tabId}.`)
    return tab
  }

  async moveTab(tabId: number, opts?: { windowId?: number; index?: number }): Promise<BridgeTab> {
    await this.enqueueCommand('tabs.move', {
      tabId,
      ...(opts?.windowId !== undefined && { windowId: opts.windowId }),
      ...(opts?.index !== undefined && { index: opts.index }),
    })
    await delay(100)
    const tab = this.tabsById.get(tabId)
    if (!tab) throw new Error(`Extension did not report moved tab ${tabId}.`)
    return tab
  }

  async duplicateTab(tabId: number): Promise<BridgeTab> {
    const result = await this.enqueueCommand('tabs.duplicate', { tabId })
    const duplicateTabId = this.extractTabId(result)
    const tab = duplicateTabId === undefined ? undefined : await this.waitForTab(duplicateTabId, true)
    if (!tab) throw new Error(`Extension did not report duplicated tab ${tabId}.`)
    return tab
  }

  async pinTab(tabId: number, pinned: boolean): Promise<BridgeTab> {
    await this.enqueueCommand('tabs.pin', { tabId, pinned })
    await delay(100)
    const tab = this.tabsById.get(tabId)
    if (!tab) throw new Error(`Extension did not report pinned state for tab ${tabId}.`)
    return tab
  }

  async createWindow(opts?: { hidden?: boolean }): Promise<WindowInfo> {
    if (opts?.hidden) {
      throw new Error('Hidden windows are only supported by BrowserOS.')
    }
    const result = await this.enqueueCommand('windows.create', {})
    await delay(100)
    const windowId = this.extractWindowId(result)
    const window = windowId === undefined ? undefined : this.windowsById.get(windowId)
    if (!window) throw new Error('Extension did not report the created window.')
    return this.toWindowInfo(window)
  }

  async closeWindow(windowId: number): Promise<void> {
    await this.enqueueCommand('windows.close', { windowId })
  }

  async activateWindow(windowId: number): Promise<void> {
    await this.enqueueCommand('windows.activate', { windowId })
  }

  async setWindowVisibility(
    windowId: number,
    opts: { visible: boolean; activate?: boolean },
  ): Promise<WindowInfo> {
    await this.enqueueCommand('windows.setVisibility', { windowId, ...opts })
    await delay(100)
    const window = this.windowsById.get(windowId)
    if (!window) throw new Error(`Extension did not report window ${windowId}.`)
    return this.toWindowInfo(window)
  }

  async createTabGroup(params: { tabIds: number[]; title?: string }): Promise<TabGroup> {
    const result = await this.enqueueCommand('tabGroups.create', params)
    await delay(100)
    const groupId = this.extractGroupId(result)
    const group = groupId === undefined ? undefined : this.groupsById.get(groupId)
    if (!group) throw new Error('Extension did not report the created tab group.')
    return this.toTabGroup(group)
  }

  async addTabsToGroup(params: { groupId: string; tabIds: number[] }): Promise<TabGroup> {
    const groupId = this.parseGroupId(params.groupId)
    await this.enqueueCommand('tabGroups.add', { groupId, tabIds: params.tabIds })
    await delay(100)
    const group = this.groupsById.get(groupId)
    if (!group) throw new Error(`Extension did not report tab group ${groupId}.`)
    return this.toTabGroup(group)
  }

  async updateTabGroup(params: {
    groupId: string
    title?: string
    color?: string
    collapsed?: boolean
  }): Promise<TabGroup> {
    const groupId = this.parseGroupId(params.groupId)
    await this.enqueueCommand('tabGroups.update', {
      groupId,
      ...(params.title !== undefined && { title: params.title }),
      ...(params.color !== undefined && { color: params.color }),
      ...(params.collapsed !== undefined && { collapsed: params.collapsed }),
    })
    await delay(100)
    const group = this.groupsById.get(groupId)
    if (!group) throw new Error(`Extension did not report tab group ${groupId}.`)
    return this.toTabGroup(group)
  }

  async removeTabsFromGroup(tabIds: number[]): Promise<void> {
    await this.enqueueCommand('tabGroups.ungroup', { tabIds })
  }

  async closeTabGroup(groupIdText: string): Promise<void> {
    const groupId = this.parseGroupId(groupIdText)
    const tabIds = this.groupsById.get(groupId)?.tabIds ?? this.tabsForGroup(groupId).map((tab) => tab.tabId)
    await this.enqueueCommand('tabGroups.close', { groupId, tabIds })
  }

  async listBookmarks(folderId?: string): Promise<BookmarkNode[]> {
    const result = await this.enqueueCommand('bookmarks.list', {
      ...(folderId !== undefined && { folderId }),
    })
    return readArrayResult<BookmarkNode>(result, 'nodes')
  }

  async searchBookmarks(query: string, maxResults?: number): Promise<BookmarkNode[]> {
    const result = await this.enqueueCommand('bookmarks.search', {
      query,
      ...(maxResults !== undefined && { maxResults }),
    })
    return readArrayResult<BookmarkNode>(result, 'results')
  }

  async createBookmark(params: {
    title: string
    url?: string
    parentId?: string
    index?: number
  }): Promise<BookmarkNode> {
    const result = await this.enqueueCommand('bookmarks.create', params)
    return readObjectResult<BookmarkNode>(result, 'node')
  }

  async updateBookmark(params: {
    id: string
    title?: string
    url?: string
  }): Promise<BookmarkNode> {
    const result = await this.enqueueCommand('bookmarks.update', params)
    return readObjectResult<BookmarkNode>(result, 'node')
  }

  async moveBookmark(params: {
    id: string
    parentId?: string
    index?: number
  }): Promise<BookmarkNode> {
    const result = await this.enqueueCommand('bookmarks.move', params)
    return readObjectResult<BookmarkNode>(result, 'node')
  }

  async removeBookmark(id: string): Promise<void> {
    await this.enqueueCommand('bookmarks.remove', { id })
  }

  async searchHistory(params: {
    query: string
    maxResults?: number
    startTime?: number
    endTime?: number
  }): Promise<HistoryEntry[]> {
    const result = await this.enqueueCommand('history.search', params)
    return readArrayResult<HistoryEntry>(result, 'entries')
  }

  async getRecentHistory(maxResults?: number): Promise<HistoryEntry[]> {
    const result = await this.enqueueCommand('history.recent', {
      ...(maxResults !== undefined && { maxResults }),
    })
    return readArrayResult<HistoryEntry>(result, 'entries')
  }

  async deleteHistoryUrl(url: string): Promise<void> {
    await this.enqueueCommand('history.deleteUrl', { url })
  }

  async deleteHistoryRange(startTime: number, endTime: number): Promise<void> {
    await this.enqueueCommand('history.deleteRange', { startTime, endTime })
  }

  private touch(browserId?: string): void {
    this.lastSeenAt = Date.now()
    if (browserId) this.browserId = browserId
  }

  private mergeStateFromCommandResult(result: unknown): void {
    if (!isRecord(result)) return

    if (Array.isArray(result.tabs)) {
      const seenTabIds = new Set<number>()
      for (const item of result.tabs) {
        if (!isBridgeTabLike(item)) continue
        const existing = this.tabsById.get(item.tabId)
        const tab = {
          ...existing,
          ...item,
          targetId: item.targetId ?? existing?.targetId,
        }
        this.tabsById.set(tab.tabId, tab)
        seenTabIds.add(tab.tabId)
        if (tab.targetId) this.targetToTab.set(tab.targetId, tab.tabId)
      }
      for (const tabId of [...this.tabsById.keys()]) {
        if (!seenTabIds.has(tabId)) {
          const removed = this.tabsById.get(tabId)
          this.tabsById.delete(tabId)
          if (removed?.targetId) this.targetToTab.delete(removed.targetId)
        }
      }
    }

    if (Array.isArray(result.windows)) {
      this.windowsById.clear()
      for (const item of result.windows) {
        if (isBridgeWindowLike(item)) this.windowsById.set(item.windowId, item)
      }
    }

    if (Array.isArray(result.groups)) {
      this.groupsById.clear()
      for (const item of result.groups) {
        if (isBridgeTabGroupLike(item)) this.groupsById.set(item.groupId, item)
      }
    }

    this.normalizeActiveTabs()
  }

  private normalizeActiveTabs(): void {
    const tabsByWindow = new Map<number, BridgeTab[]>()
    for (const tab of this.tabsById.values()) {
      const tabs = tabsByWindow.get(tab.windowId) ?? []
      tabs.push(tab)
      tabsByWindow.set(tab.windowId, tabs)
    }

    for (const [windowId, tabs] of tabsByWindow) {
      tabs.sort((a, b) => a.index - b.index)
      const window = this.windowsById.get(windowId)
      const activeTabId =
        window?.activeTabId ??
        tabs.find((tab) => tab.active)?.tabId ??
        tabs[0]?.tabId
      for (const tab of tabs) {
        this.tabsById.set(tab.tabId, {
          ...tab,
          active: tab.tabId === activeTabId,
        })
      }
    }
  }

  private async enqueueCommand<T = unknown>(
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isConnected()) {
      throw new Error(bridgeInstallMessage())
    }

    const id = randomUUID()
    const command = { id, type, payload }
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        reject(new Error(`Extension command timed out: ${type}`))
      }, COMMAND_TIMEOUT_MS)
      this.pendingCommands.set(id, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
    })
    if (!this.commandSender?.(command)) {
      this.wakeCommandWaiters()
    }
    return promise
  }

  private async waitForTab(tabId: number, requireTarget = false): Promise<BridgeTab | undefined> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const tab = this.tabsById.get(tabId)
      if (tab && (!requireTarget || tab.targetId)) return tab
      await delay(100)
    }
    return this.tabsById.get(tabId)
  }

  private nextCommand(): BridgeCommand | null {
    const pending = this.pendingCommands.values().next().value as PendingCommand | undefined
    return pending?.command ?? null
  }

  private wakeCommandWaiters(): void {
    const waiters = this.commandWaiters
    this.commandWaiters = []
    for (const wake of waiters) wake()
  }

  private toWindowInfo(window: BridgeWindow): WindowInfo {
    const activeTab = this.listTabs().find((tab) => tab.windowId === window.windowId && tab.active)
    return {
      windowId: window.windowId,
      windowType: this.toWindowType(window.type),
      bounds: window.bounds ?? {
        windowState: window.state,
      },
      isActive: window.focused ?? false,
      isVisible: window.state !== 'minimized',
      tabCount: window.tabCount ?? this.listTabs().filter((tab) => tab.windowId === window.windowId).length,
      activeTabId: window.activeTabId ?? activeTab?.tabId,
    }
  }

  private toWindowType(type: string | undefined): WindowType {
    if (type === 'popup') return 'popup'
    if (type === 'app') return 'app'
    if (type === 'devtools') return 'devtools'
    return 'normal'
  }

  private toTabGroup(group: BridgeTabGroup): TabGroup {
    return {
      groupId: String(group.groupId),
      windowId: group.windowId,
      title: group.title ?? '',
      color: group.color ?? 'grey',
      collapsed: group.collapsed ?? false,
      tabIds: group.tabIds ?? this.tabsForGroup(group.groupId).map((tab) => tab.tabId),
    }
  }

  private tabsForGroup(groupId: number): BridgeTab[] {
    return this.listTabs().filter((tab) => tab.groupId === groupId)
  }

  private parseGroupId(groupId: string): number {
    const parsed = Number(groupId)
    if (!Number.isInteger(parsed)) throw new Error(`Invalid Chrome tab group id: ${groupId}`)
    return parsed
  }

  private extractTabId(result: unknown): number | undefined {
    if (isRecord(result) && typeof result.tabId === 'number') return result.tabId
    if (isRecord(result) && isRecord(result.tab) && typeof result.tab.id === 'number') return result.tab.id
    if (isRecord(result) && typeof result.id === 'number') return result.id
    return undefined
  }

  private extractWindowId(result: unknown): number | undefined {
    if (isRecord(result) && typeof result.windowId === 'number') return result.windowId
    if (isRecord(result) && isRecord(result.window) && typeof result.window.id === 'number') return result.window.id
    if (isRecord(result) && typeof result.id === 'number') return result.id
    return undefined
  }

  private extractGroupId(result: unknown): number | undefined {
    if (isRecord(result) && typeof result.groupId === 'number') return result.groupId
    if (isRecord(result) && isRecord(result.group) && typeof result.group.id === 'number') return result.group.id
    if (typeof result === 'number') return result
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBridgeTabLike(value: unknown): value is BridgeTab {
  return isRecord(value) &&
    typeof value.tabId === 'number' &&
    typeof value.windowId === 'number' &&
    typeof value.index === 'number'
}

function isBridgeWindowLike(value: unknown): value is BridgeWindow {
  return isRecord(value) && typeof value.windowId === 'number'
}

function isBridgeTabGroupLike(value: unknown): value is BridgeTabGroup {
  return isRecord(value) &&
    typeof value.groupId === 'number' &&
    typeof value.windowId === 'number'
}

function readArrayResult<T>(value: unknown, key: string): T[] {
  if (isRecord(value) && Array.isArray(value[key])) return value[key] as T[]
  return []
}

function readObjectResult<T>(value: unknown, key: string): T {
  if (isRecord(value) && isRecord(value[key])) return value[key] as T
  throw new Error(`Extension command did not return ${key}.`)
}

export function bridgeInstallMessage(): string {
  return (
    'Standard Chrome CDP does not expose the complete tab/window/tab-group model. ' +
    'Install and enable the Browser Control MCP Bridge extension, then grant tabs, tabGroups, and debugger permissions.'
  )
}
