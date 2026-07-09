import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { StreamableHTTPTransport } from '@hono/mcp'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebSocket, WebSocketServer } from 'ws'
import { CdpConnectionImpl } from './cdp/connection-impl.js'
import { BrowserSession } from './browser/session.js'
import {
  BROWSER_STATE_RESOURCE_URI,
  BrowserStateEvents,
  type BrowserStateEvent,
  type BrowserStateEventReason,
} from './browser/state-events.js'
import {
  ChromeExtensionBridge,
  type BridgeCommand,
  type BridgeCommandResult,
  type BridgeStateSnapshot,
} from './browser/chrome-extension-bridge.js'
import { createBrowserMcpServer } from './mcp/mcp-server.js'
import { launchChrome } from './chrome-launch.js'
import type { ServerConfig, BackendMode } from './config.js'

/**
 * Detect backend mode by probing the CDP connection for BrowserOS-specific methods.
 *
 * The /json/version "Browser" field is unreliable because BrowserOS builds may
 * not apply the BRANDING file at compile time, causing it to report "Chrome/xxx"
 * even on BrowserOS. Instead, we probe the live CDP connection:
 *
 *   Browser.getTabs  — a BrowserOS custom CDP domain method.
 *   If it succeeds → BrowserOS; if it errors (method not found) → standard Chrome.
 *
 * As a fallback, we also check the Browser string for "BrowserOS" (covers builds
 * that DID apply the BRANDING file).
 */
async function detectBackend(
  cdp: CdpConnectionImpl,
  browserString: string | undefined,
): Promise<'browseros' | 'chrome'> {
  // Fast path: if the BRANDING file was applied, the Browser field contains "BrowserOS"
  if (browserString?.toLowerCase().includes('browseros')) {
    return 'browseros'
  }

  // Probe: try a BrowserOS-specific CDP method
  try {
    await cdp.Browser.getTabs({ includeHidden: true })
    return 'browseros'
  } catch {
    // Method not found → standard Chrome
    return 'chrome'
  }
}

/**
 * Create and start the HTTP+SSE MCP server.
 */
export async function createHttpServer(config: ServerConfig): Promise<void> {
  const dbg = (...args: unknown[]) => {
    if (config.debug) console.error('[browser-control-mcp:debug]', ...args)
  }

  // 1. Optional: auto-launch Chrome
  if (config.autoLaunch) {
    await launchChrome(config.cdpPort, config.chromePath, {
      ...(config.chromeUserDataDir && { userDataDir: config.chromeUserDataDir }),
      ...(config.chromeExtensionPath && { extensionPath: config.chromeExtensionPath }),
    })
  }

  // 2. Connect to CDP
  const cdp = new CdpConnectionImpl({
    port: config.cdpPort,
    host: config.cdpHost,
    maxRetries: config.cdpMaxRetries,
    retryDelay: config.cdpRetryDelay,
    fetchTimeout: config.cdpFetchTimeout,
  })
  await cdp.connect()
  console.error(`[browser-control-mcp] Connected to CDP on port ${config.cdpPort}`)
  dbg(`CDP versionInfo:`, JSON.stringify(cdp.versionInfo, null, 2))

  // 3. Resolve backend mode (narrow to 'browseros' | 'chrome' — 'auto' is resolved here)
  let backend: 'browseros' | 'chrome'
  if (config.backend === 'auto') {
    backend = await detectBackend(cdp, cdp.versionInfo?.Browser)
    console.error(`[browser-control-mcp] Auto-detected backend: ${backend}`)
  } else {
    backend = config.backend
    console.error(`[browser-control-mcp] Backend mode: ${backend}`)
  }
  dbg(`Browser: ${cdp.versionInfo?.Browser ?? 'unknown'}`)
  const browserStr = cdp.versionInfo?.Browser
  dbg(`Detection: ${browserStr?.toLowerCase().includes('browseros') ? 'BRANDING match' : 'CDP probe (Browser.getTabs)'}`)

  const extensionBridge = new ChromeExtensionBridge()

  // 4. Create BrowserSession with backend mode
  const session = new BrowserSession(cdp, {
    backend,
    chromeExtensionBridge: extensionBridge,
  })
  const browserState = new BrowserStateEvents()
  dbg('BrowserSession created')

  let pendingStateReason: BrowserStateEventReason | null = null
  let stateBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleStateBroadcast = (reason: BrowserStateEventReason) => {
    pendingStateReason = reason
    if (stateBroadcastTimer) return
    stateBroadcastTimer = setTimeout(() => {
      stateBroadcastTimer = null
      const emitReason = pendingStateReason ?? reason
      pendingStateReason = null
      browserState.emitSnapshot(emitReason, session)
        .then((event) => broadcastBrowserStateEvent(event))
        .catch((error) => dbg('[browser-state] emit failed', error instanceof Error ? error.message : String(error)))
    }, 100)
  }

  await cdp.Target.setDiscoverTargets({ discover: true }).catch((error) => {
    dbg('[browser-state] Target.setDiscoverTargets failed', error instanceof Error ? error.message : String(error))
  })
  cdp.Target.on('targetCreated', (event) => {
    if (event.targetInfo.type === 'page') scheduleStateBroadcast('tabs')
  })
  cdp.Target.on('targetDestroyed', () => scheduleStateBroadcast('tabs'))
  cdp.Target.on('targetInfoChanged', (event) => {
    if (event.targetInfo.type === 'page') scheduleStateBroadcast('tabs')
  })

  // 5. HTTP server (Hono) — supports both Streamable HTTP and SSE transports
  const app = new Hono()

  // ── Chrome extension bridge endpoints ────────────────────────────────
  app.post('/extension/hello', async (c) => {
    const body = await readJsonObject(c.req)
    const browserId = typeof body.browserId === 'string' ? body.browserId : undefined
    return c.json(extensionBridge.hello(browserId))
  })

  app.post('/extension/state', async (c) => {
    const body = (await c.req.json()) as BridgeStateSnapshot
    const health = extensionBridge.updateState(body)
    scheduleStateBroadcast('extension')
    return c.json(health)
  })

  app.get('/extension/health', (c) => c.json(extensionBridge.health()))

  app.get('/extension/commands', async (c) => {
    extensionBridge.heartbeat()
    const timeoutParam = Number(new URL(c.req.url).searchParams.get('timeoutMs'))
    const timeoutMs = Number.isFinite(timeoutParam)
      ? Math.max(0, Math.min(timeoutParam, 25_000))
      : 25_000
    const command = await extensionBridge.pollCommand(timeoutMs)
    if (!command) return c.json({ command: null })
    return c.json({ command })
  })

  app.post('/extension/commands/:id/result', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json()) as BridgeCommandResult
    const accepted = extensionBridge.completeCommand(id, body)
    return c.json({ accepted })
  })

  // Factory: create a fresh McpServer (one transport per server instance)
  const createMcpServer = () => createBrowserMcpServer({
    name: config.serverName,
    title: config.serverTitle,
    version: config.serverVersion,
    browserSession: session,
    browserState,
    ...(config.defaultWindowId !== undefined && { defaultWindowId: config.defaultWindowId }),
    ...(config.defaultTabGroupId !== undefined && { defaultTabGroupId: config.defaultTabGroupId }),
    registration: {
      browserState,
      onToolExecuted: (event) => {
        if (!event.success) return
        if (['tabs', 'windows', 'tab_groups'].includes(event.tool_name)) {
          scheduleStateBroadcast(
            event.tool_name === 'tabs'
              ? 'tabs'
              : event.tool_name === 'windows'
                ? 'windows'
                : 'tabGroups',
          )
        }
      },
    },
  })

  // ── Streamable HTTP transport (/mcp) ──────────────────────────────────
  // Multi-session support: each client gets its own McpServer + transport pair.
  const httpSessions = new Map<string, { server: McpServer; transport: StreamableHTTPTransport }>()
  const sseSessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>()
  const broadcastBrowserStateEvent = async (event: BrowserStateEvent): Promise<void> => {
    const servers = [
      ...[...httpSessions.values()].map((entry) => entry.server),
      ...[...sseSessions.values()].map((entry) => entry.server),
    ]
    await Promise.allSettled(
      servers.map(async (server) => {
        await Promise.allSettled([
          server.server.sendResourceUpdated({ uri: BROWSER_STATE_RESOURCE_URI }),
          server.sendLoggingMessage({
            level: 'info',
            logger: 'browser-state',
            data: event,
          }),
        ])
      }),
    )
  }

  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id')
    dbg(`[streamable-http] ${c.req.method} /mcp${sessionId ? ' session=' + sessionId : ' (new)'}`)

    // Existing session — reuse the stored server + transport
    if (sessionId) {
      const entry = httpSessions.get(sessionId)
      if (entry) {
        const response = await entry.transport.handleRequest(c)
        // Clean up on session termination (DELETE)
        if (c.req.method === 'DELETE') {
          await entry.server.close()
          httpSessions.delete(sessionId)
          dbg(`[streamable-http] Session closed: ${sessionId}`)
        }
        return response
      }
      dbg(`[streamable-http] Session not found: ${sessionId}`)
      return c.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
        404,
      )
    }

    // New session — create a fresh McpServer + transport, connect them,
    // and let the transport assign a session ID during initialization.
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => randomUUID(),
    })
    const server = createMcpServer()
    await server.connect(transport)
    const response = await transport.handleRequest(c)

    if (transport.sessionId) {
      httpSessions.set(transport.sessionId, { server, transport })
      dbg(`[streamable-http] Session created: ${transport.sessionId}`)
    }

    return response
  })

  // ── Stateless Streamable HTTP transport (/mcp/stateless) ─────────────
  // Mirrors BrowserOS's newer per-request transport shape. This avoids
  // sharing MCP transport state across requests while preserving /mcp for
  // clients that expect session IDs.
  app.all('/mcp/stateless', async (c) => {
    dbg(`[streamable-http:stateless] ${c.req.method} /mcp/stateless`)

    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    const server = createMcpServer()

    try {
      await server.connect(transport)
      return await transport.handleRequest(c)
    } finally {
      await transport.close()
      await server.close()
    }
  })

  // ── Legacy SSE transport (/sse + /messages) ──────────────────────────
  // The MCP Inspector's "SSE" mode uses this transport.
  // Flow: GET /sse opens stream → POST /messages?sessionId=xxx sends messages.
  app.get('/sse', async (c) => {
    const outgoing = (c.env as { outgoing: ServerResponse }).outgoing
    dbg('[sse] New SSE connection')

    const transport = new SSEServerTransport('/messages', outgoing)
    const server = createMcpServer()
    // server.connect() calls transport.start() which writes SSE headers + endpoint event.
    await server.connect(transport)

    // Wrap onclose to also clean up our session map.
    // (server.connect sets onclose, so we must wrap after connect)
    const origClose = transport.onclose
    transport.onclose = () => {
      origClose?.()
      sseSessions.delete(transport.sessionId)
      server.close()
      dbg(`[sse] Session closed: ${transport.sessionId}`)
    }

    sseSessions.set(transport.sessionId, { server, transport })
    dbg(`[sse] Session created: ${transport.sessionId}`)

    // SSEServerTransport.start() was already called by server.connect().
    // Tell @hono/node-server not to write another response.
    return new Response(null, { headers: { 'x-hono-already-sent': 'true' } })
  })

  app.post('/messages', async (c) => {
    const url = new URL(c.req.url)
    const sessionId = url.searchParams.get('sessionId')
    dbg(`[sse] POST /messages session=${sessionId ?? '(missing)'}`)

    if (!sessionId) {
      return c.json({ error: 'Missing sessionId query parameter' }, 400)
    }

    const entry = sseSessions.get(sessionId)
    if (!entry) {
      dbg(`[sse] Session not found: ${sessionId}`)
      return c.json({ error: 'Session not found' }, 404)
    }

    // Read the JSON-RPC message body via Hono (avoids stream conflicts with
    // @hono/node-server), then hand it to the SSE transport for processing.
    const body = await c.req.json()
    try {
      await entry.transport.handleMessage(body)
    } catch (err) {
      dbg(`[sse] Message error: ${err instanceof Error ? err.message : String(err)}`)
      return c.json({ error: 'Invalid message' }, 400)
    }
    // 202 Accepted — actual response will arrive via the SSE stream
    return c.json({ status: 'accepted' }, 202)
  })

  // Health check endpoint
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      cdp: cdp.isConnected(),
      backend,
      browser: cdp.versionInfo?.Browser ?? 'unknown',
      extensionBridge: extensionBridge.health(),
      sessions: { streamableHttp: httpSessions.size, sse: sseSessions.size },
    }),
  )

  // 6. Start listening
  const nodeServer = serve({ fetch: app.fetch, port: config.mcpPort }, (info) => {
    console.error(`[browser-control-mcp] MCP server listening on http://localhost:${info.port}`)
    console.error(`  Streamable HTTP:  http://localhost:${info.port}/mcp`)
    console.error(`  Stateless HTTP:   http://localhost:${info.port}/mcp/stateless`)
    console.error(`  SSE:              http://localhost:${info.port}/sse`)
    console.error(`  Extension WS:     ws://localhost:${info.port}/extension/ws`)
    console.error(`  Health check:     http://localhost:${info.port}/health`)
    if (config.debug) {
      console.error(`  Debug:            enabled`)
      console.error(`  Backend:          ${backend}`)
      console.error(`  CDP:              ${config.cdpHost}:${config.cdpPort}`)
    }
  })
  const extensionWsServer = setupExtensionWebSocket(
    nodeServer,
    extensionBridge,
    dbg,
    () => scheduleStateBroadcast('extension'),
  )

  // 7. Graceful shutdown
  const shutdown = async () => {
    extensionBridge.setCommandSender(undefined)
    extensionWsServer.close()
    for (const { server, transport } of httpSessions.values()) {
      await transport.close()
      await server.close()
    }
    httpSessions.clear()
    for (const { server, transport } of sseSessions.values()) {
      await transport.close()
      await server.close()
    }
    sseSessions.clear()
    await cdp.disconnect()
    dbg('All sessions closed, CDP disconnected')
  }

  process.on('SIGINT', async () => {
    console.error('[browser-control-mcp] Shutting down...')
    await shutdown()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.error('[browser-control-mcp] Received SIGTERM, shutting down...')
    await shutdown()
    process.exit(0)
  })
}

async function readJsonObject(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    if (typeof body === 'object' && body !== null) {
      return body as Record<string, unknown>
    }
  } catch {
    // Treat an empty or invalid hello body as anonymous.
  }
  return {}
}

function setupExtensionWebSocket(
  nodeServer: ReturnType<typeof serve>,
  bridge: ChromeExtensionBridge,
  dbg: (...args: unknown[]) => void,
  onStateChanged?: () => void,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  let activeSocket: WebSocket | null = null

  nodeServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/extension/ws') return

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  wss.on('connection', (ws) => {
    dbg('[extension-ws] connected')
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.close(1000, 'replaced by a newer bridge connection')
    }
    activeSocket = ws

    const send = (message: unknown): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify(message))
      return true
    }

    bridge.setCommandSender((command: BridgeCommand) =>
      send({ type: 'command', command }),
    )

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as Record<string, unknown>
        const type = message.type
        if (type === 'hello') {
          const browserId = typeof message.browserId === 'string' ? message.browserId : undefined
          send({ type: 'hello', health: bridge.hello(browserId) })
          send({ type: 'sync' })
          return
        }
        if (type === 'ping') {
          const browserId = typeof message.browserId === 'string' ? message.browserId : undefined
          send({ type: 'pong', health: bridge.heartbeat(browserId) })
          return
        }
        if (type === 'state') {
          const snapshot = isRecord(message.snapshot)
            ? (message.snapshot as unknown as BridgeStateSnapshot)
            : (message as unknown as BridgeStateSnapshot)
          send({ type: 'health', health: bridge.updateState(snapshot) })
          onStateChanged?.()
          return
        }
        if (type === 'commandResult') {
          const commandId = typeof message.commandId === 'string' ? message.commandId : ''
          const result: BridgeCommandResult = {
            ok: message.ok === true,
            result: message.result,
            error: typeof message.error === 'string' ? message.error : undefined,
          }
          send({
            type: 'commandResultAck',
            commandId,
            accepted: bridge.completeCommand(commandId, result),
          })
          return
        }
        send({ type: 'error', error: `Unknown message type: ${String(type)}` })
      } catch (error) {
        send({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })

    ws.on('close', () => {
      dbg('[extension-ws] closed')
      if (activeSocket === ws) {
        activeSocket = null
        bridge.setCommandSender(undefined)
      }
    })

    ws.on('error', (error) => {
      dbg('[extension-ws] error', error instanceof Error ? error.message : String(error))
    })

    send({ type: 'hello', health: bridge.heartbeat() })
    send({ type: 'sync' })
  })

  return wss
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
