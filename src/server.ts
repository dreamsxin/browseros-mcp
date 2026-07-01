import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { StreamableHTTPTransport } from '@hono/mcp'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CdpConnectionImpl } from './cdp/connection-impl.js'
import { BrowserSession } from './browser/session.js'
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
    if (config.debug) console.error('[browseros-mcp:debug]', ...args)
  }

  // 1. Optional: auto-launch Chrome
  if (config.autoLaunch) {
    await launchChrome(config.cdpPort, config.chromePath)
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
  console.error(`[browseros-mcp] Connected to CDP on port ${config.cdpPort}`)
  dbg(`CDP versionInfo:`, JSON.stringify(cdp.versionInfo, null, 2))

  // 3. Resolve backend mode (narrow to 'browseros' | 'chrome' — 'auto' is resolved here)
  let backend: 'browseros' | 'chrome'
  if (config.backend === 'auto') {
    backend = await detectBackend(cdp, cdp.versionInfo?.Browser)
    console.error(`[browseros-mcp] Auto-detected backend: ${backend}`)
  } else {
    backend = config.backend
    console.error(`[browseros-mcp] Backend mode: ${backend}`)
  }
  dbg(`Browser: ${cdp.versionInfo?.Browser ?? 'unknown'}`)
  const browserStr = cdp.versionInfo?.Browser
  dbg(`Detection: ${browserStr?.toLowerCase().includes('browseros') ? 'BRANDING match' : 'CDP probe (Browser.getTabs)'}`)

  // 4. Create BrowserSession with backend mode
  const session = new BrowserSession(cdp, { backend })
  dbg('BrowserSession created')

  // 5. HTTP server (Hono) — supports both Streamable HTTP and SSE transports
  const app = new Hono()

  // Factory: create a fresh McpServer (one transport per server instance)
  const createMcpServer = () => createBrowserMcpServer({
    name: config.serverName,
    title: config.serverTitle,
    version: config.serverVersion,
    browserSession: session,
    ...(config.defaultWindowId !== undefined && { defaultWindowId: config.defaultWindowId }),
    ...(config.defaultTabGroupId !== undefined && { defaultTabGroupId: config.defaultTabGroupId }),
  })

  // ── Streamable HTTP transport (/mcp) ──────────────────────────────────
  // Multi-session support: each client gets its own McpServer + transport pair.
  const httpSessions = new Map<string, { server: McpServer; transport: StreamableHTTPTransport }>()

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

  // ── Legacy SSE transport (/sse + /messages) ──────────────────────────
  // The MCP Inspector's "SSE" mode uses this transport.
  // Flow: GET /sse opens stream → POST /messages?sessionId=xxx sends messages.
  const sseSessions = new Map<string, { server: McpServer; transport: SSEServerTransport }>()

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
      sessions: { streamableHttp: httpSessions.size, sse: sseSessions.size },
    }),
  )

  // 6. Start listening
  serve({ fetch: app.fetch, port: config.mcpPort }, (info) => {
    console.error(`[browseros-mcp] MCP server listening on http://localhost:${info.port}`)
    console.error(`  Streamable HTTP:  http://localhost:${info.port}/mcp`)
    console.error(`  SSE:              http://localhost:${info.port}/sse`)
    console.error(`  Health check:     http://localhost:${info.port}/health`)
    if (config.debug) {
      console.error(`  Debug:            enabled`)
      console.error(`  Backend:          ${backend}`)
      console.error(`  CDP:              ${config.cdpHost}:${config.cdpPort}`)
    }
  })

  // 7. Graceful shutdown
  const shutdown = async () => {
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
    console.error('[browseros-mcp] Shutting down...')
    await shutdown()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.error('[browseros-mcp] Received SIGTERM, shutting down...')
    await shutdown()
    process.exit(0)
  })
}
