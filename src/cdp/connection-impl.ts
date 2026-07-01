import { WebSocket } from 'ws'
import {
  createProtocolApi,
  type RawOn,
  type RawSend,
} from './create-api.js'
import type { ProtocolApi } from './generated/protocol-api.js'
import type { CdpConnection, SessionId } from './connection.js'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CdpVersion {
  webSocketDebuggerUrl: string
  Browser?: string
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const
const LOOPBACK_HOST_SET = new Set<string>([...LOOPBACK_HOSTS, '::1'])

const CDP_CONNECT_TIMEOUT = 10_000
const CDP_REQUEST_TIMEOUT = 30_000
const CDP_KEEPALIVE_INTERVAL = 30_000
const CDP_KEEPALIVE_TIMEOUT = 5_000
const CDP_CONNECT_MAX_RETRIES = 10
const CDP_RECONNECT_MAX_RETRIES = 5
const CDP_RECONNECT_DELAY = 2_000

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function normalizeHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed === '::1') return '[::1]'
  return trimmed
}

function hostForUrl(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host
  return host.includes(':') ? `[${host}]` : host
}

function hostForUrlHostname(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

export interface CdpConnectionImplConfig {
  port: number
  host?: string
  maxRetries?: number
  retryDelay?: number
  fetchTimeout?: number
  /** Throw on reconnect failure instead of silently giving up (default: false) */
  throwOnReconnectFailure?: boolean
}

// Declaration merging: CdpConnectionImpl gains all ProtocolApi domain properties
// at runtime via Object.assign(this, createProtocolApi(...))
interface CdpConnectionImpl extends ProtocolApi {}

/**
 * CDP WebSocket client implementing the CdpConnection interface.
 *
 * Adapted from BrowserOS's CdpBackend, but uses the `ws` package (instead of
 * Bun's native WebSocket) and replaces Bun.sleep with setTimeout-based delay.
 * Does NOT call process.exit on reconnect failure — throws instead.
 */
class CdpConnectionImpl implements CdpConnection {
  private port: number
  private configuredHost: string | null = null
  private preferredHost: string | null = null
  private ws: WebSocket | null = null
  private messageId = 0
  private pending = new Map<number, PendingRequest>()
  private connected = false
  private epoch = 0
  private disconnecting = false
  private reconnecting = false
  private reconnectRequested = false
  private eventHandlers = new Map<string, ((params: unknown) => void)[]>()
  private sessionEventHandlers = new Map<
    string,
    ((params: unknown, sessionId: string) => void)[]
  >()
  private sessionCache = new Map<string, ProtocolApi>()
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private maxRetries: number
  private retryDelay: number
  private fetchTimeout: number
  private throwOnReconnectFailure: boolean
  /** Last fetched /json/version response (for backend detection) */
  versionInfo: CdpVersion | null = null

  constructor(config: CdpConnectionImplConfig) {
    this.port = config.port
    this.configuredHost = config.host ? normalizeHost(config.host) : null
    this.maxRetries = config.maxRetries ?? CDP_CONNECT_MAX_RETRIES
    this.retryDelay = config.retryDelay ?? CDP_RECONNECT_DELAY
    this.fetchTimeout = config.fetchTimeout ?? CDP_CONNECT_TIMEOUT
    this.throwOnReconnectFailure = config.throwOnReconnectFailure ?? false

    const rawSend: RawSend = (method, params) => this.rawSend(method, params)
    const rawOn: RawOn = (event, handler) => this.rawOn(event, handler)
    Object.assign(this, createProtocolApi(rawSend, rawOn))
  }

  async connect(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.attemptConnect()
        this.startKeepalive()
        return
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (attempt < this.maxRetries) {
          console.error(
            `[cdp] Connection attempt ${attempt}/${this.maxRetries} failed: ${msg}. Retrying...`,
          )
          await delay(this.retryDelay)
        } else {
          throw new Error(`CDP connection failed after ${this.maxRetries} attempts: ${msg}`)
        }
      }
    }
  }

  private async attemptConnect(): Promise<void> {
    const { host, version } = await this.discoverVersion()
    this.versionInfo = version
    const wsUrl = this.resolveWebSocketUrl(version.webSocketDebuggerUrl, host)

    return new Promise<void>((resolve, reject) => {
      let opened = false
      let settled = false

      const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 })
      const connectTimeout = setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* ignore */ }
        reject(new Error(`CDP WebSocket connect timeout after ${CDP_CONNECT_TIMEOUT}ms`))
      }, CDP_CONNECT_TIMEOUT)

      ws.on('open', () => {
        if (settled) return
        settled = true
        clearTimeout(connectTimeout)
        opened = true
        this.ws = ws
        this.connected = true
        this.epoch += 1
        this.disconnecting = false
        resolve()
      })

      ws.on('error', (err) => {
        if (!opened && !settled) {
          settled = true
          clearTimeout(connectTimeout)
          reject(new Error(`CDP WebSocket error: ${err.message}`))
        }
      })

      ws.on('close', () => {
        clearTimeout(connectTimeout)
        if (this.ws !== ws) return
        this.connected = false
        this.ws = null
        if (opened) this.handleUnexpectedClose()
      })

      ws.on('message', (data: { toString: () => string }) => {
        this.handleMessage(data.toString())
      })
    })
  }

  private getDiscoveryHosts(): string[] {
    const configuredHost = this.configuredHost
    const explicitRemote =
      configuredHost !== null &&
      !LOOPBACK_HOST_SET.has(configuredHost)
    if (explicitRemote) return [configuredHost]

    const hosts = configuredHost
      ? [configuredHost, ...LOOPBACK_HOSTS]
      : [...LOOPBACK_HOSTS]
    const ordered = this.preferredHost
      ? [this.preferredHost, ...hosts]
      : hosts
    return [...new Set(ordered)]
  }

  private async discoverVersion(): Promise<{ host: string; version: CdpVersion }> {
    const failures: string[] = []

    for (const host of this.getDiscoveryHosts()) {
      try {
        const version = await this.fetchVersionFromHost(host)
        this.preferredHost = host
        return { host, version }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        failures.push(`${host}: ${msg}`)
      }
    }

    throw new Error(`CDP /json/version failed on all configured hosts (${failures.join('; ')})`)
  }

  private async fetchVersionFromHost(host: string): Promise<CdpVersion> {
    const response = await fetch(`http://${hostForUrl(host)}:${this.port}/json/version`, {
      signal: AbortSignal.timeout(this.fetchTimeout),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const version = (await response.json()) as Partial<CdpVersion>
    if (typeof version.webSocketDebuggerUrl !== 'string') {
      throw new Error('Missing webSocketDebuggerUrl')
    }
    return { webSocketDebuggerUrl: version.webSocketDebuggerUrl, Browser: version.Browser }
  }

  private resolveWebSocketUrl(wsUrl: string, host: string): string {
    try {
      const parsed = new URL(wsUrl)
      parsed.hostname = hostForUrlHostname(host)
      return parsed.toString()
    } catch {
      return wsUrl
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.keepaliveTimer = setInterval(async () => {
      if (!this.ws || !this.connected || this.disconnecting) return
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.rawSend('Browser.getVersion'),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('keepalive timeout')), CDP_KEEPALIVE_TIMEOUT)
          }),
        ])
        clearTimeout(timeoutId)
      } catch {
        clearTimeout(timeoutId)
        console.error('[cdp] Keepalive failed, connection may be dead')
        this.handleDeadConnection()
      }
    }, CDP_KEEPALIVE_INTERVAL)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private handleDeadConnection(): void {
    if (this.disconnecting || this.reconnecting) return
    this.stopKeepalive()
    if (this.ws) {
      try { this.ws.close() } catch { /* dead */ }
      this.ws = null
    }
    this.connected = false
    this.handleUnexpectedClose()
  }

  private handleUnexpectedClose(): void {
    if (this.disconnecting) return
    this.stopKeepalive()
    this.rejectPendingRequests()

    if (this.reconnecting) {
      this.reconnectRequested = true
      return
    }

    console.error('[cdp] WebSocket closed unexpectedly, attempting reconnection...')
    this.reconnecting = true
    this.reconnectRequested = false
    this.reconnectLoop().finally(() => { this.reconnecting = false })
  }

  private async reconnectLoop(): Promise<void> {
    do {
      this.reconnectRequested = false
      const reconnected = await this.reconnectWithRetries()
      if (!reconnected) return
    } while (!this.disconnecting && (this.reconnectRequested || !this.connected))
  }

  private rejectPendingRequests(): void {
    const error = new Error('CDP connection lost')
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  private async reconnectWithRetries(): Promise<boolean> {
    for (let attempt = 1; attempt <= CDP_RECONNECT_MAX_RETRIES; attempt++) {
      if (this.disconnecting) return false
      try {
        await delay(CDP_RECONNECT_DELAY)
        await this.attemptConnect()
        this.startKeepalive()
        console.error('[cdp] Reconnected successfully')
        return true
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[cdp] Reconnection attempt ${attempt}/${CDP_RECONNECT_MAX_RETRIES} failed: ${msg}`)
      }
    }

    if (this.throwOnReconnectFailure) {
      throw new Error(`CDP reconnection failed after ${CDP_RECONNECT_MAX_RETRIES} attempts`)
    }
    console.error(`[cdp] Reconnection failed after ${CDP_RECONNECT_MAX_RETRIES} attempts`)
    return false
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true
    this.stopKeepalive()
    if (this.ws) {
      this.ws.close()
      this.ws = null
      this.connected = false
    }
    this.rejectPendingRequests()
  }

  isConnected(): boolean {
    return this.connected
  }

  connectionEpoch(): number {
    return this.epoch
  }

  session(sessionId: SessionId): ProtocolApi {
    let cached = this.sessionCache.get(sessionId)
    if (!cached) {
      cached = createProtocolApi(
        (method, params) => this.rawSend(method, params, sessionId),
        (event, handler) => this.rawOn(event, handler),
      )
      this.sessionCache.set(sessionId, cached)
    }
    return cached
  }

  async rawSend(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: SessionId,
  ): Promise<unknown> {
    return this.sendRawMessage(method, params ?? {}, sessionId)
  }

  async rawSendJson(
    method: string,
    paramsJson: string,
    sessionId?: SessionId,
  ): Promise<unknown> {
    JSON.parse(paramsJson) // validate
    return this.sendRawMessage(method, paramsJson, sessionId)
  }

  private async sendRawMessage(
    method: string,
    params: Record<string, unknown> | string,
    sessionId?: SessionId,
  ): Promise<unknown> {
    if (!this.ws || !this.connected) {
      throw new Error('CDP not connected')
    }

    const id = ++this.messageId
    const messageJson =
      typeof params === 'string'
        ? this.rawMessageJson(id, method, params, sessionId)
        : JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })

    const ws = this.ws
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP request timeout: ${method} (id=${id})`))
      }, CDP_REQUEST_TIMEOUT)

      this.pending.set(id, { resolve, reject, timer })

      try {
        ws.send(messageJson)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        const msg = err instanceof Error ? err.message : String(err)
        reject(new Error(`CDP send failed: ${msg}`))
        this.handleDeadConnection()
      }
    })
  }

  private rawMessageJson(
    id: number,
    method: string,
    paramsJson: string,
    sessionId?: SessionId,
  ): string {
    const fields = [
      `"id":${id}`,
      `"method":${JSON.stringify(method)}`,
      `"params":${paramsJson}`,
    ]
    if (sessionId) fields.push(`"sessionId":${JSON.stringify(sessionId)}`)
    return `{${fields.join(',')}}`
  }

  private rawOn(event: string, handler: (params: unknown) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, [])
    }
    this.eventHandlers.get(event)!.push(handler)
    return () => {
      const list = this.eventHandlers.get(event)
      if (list) {
        const idx = list.indexOf(handler)
        if (idx !== -1) list.splice(idx, 1)
      }
    }
  }

  onSessionEvent(
    event: string,
    handler: (params: unknown, sessionId: string) => void,
  ): () => void {
    if (!this.sessionEventHandlers.has(event)) {
      this.sessionEventHandlers.set(event, [])
    }
    this.sessionEventHandlers.get(event)!.push(handler)
    return () => {
      const list = this.sessionEventHandlers.get(event)
      if (list) {
        const idx = list.indexOf(handler)
        if (idx !== -1) list.splice(idx, 1)
      }
    }
  }

  private handleMessage(data: string): void {
    const message = JSON.parse(data) as {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: { message: string; code: number }
      sessionId?: string
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) {
          pending.reject(new Error(`CDP error: ${message.error.message}`))
        } else {
          pending.resolve(message.result)
        }
      }
    } else if (message.method) {
      const handlers = this.eventHandlers.get(message.method)
      if (handlers) {
        for (const handler of handlers) handler(message.params)
      }
      if (message.sessionId) {
        const sessionHandlers = this.sessionEventHandlers.get(message.method)
        if (sessionHandlers) {
          for (const handler of sessionHandlers) handler(message.params, message.sessionId)
        }
      }
    }
  }
}

export { CdpConnectionImpl }
