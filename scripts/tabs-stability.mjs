#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const DEFAULTS = {
  cdpPort: 9333,
  mcpPort: 3100,
  mcpHost: '127.0.0.1',
  iterations: 5,
  startupTimeoutMs: 20_000,
  bridgeTimeoutMs: 20_000,
  waitTimeoutMs: 10_000,
}

const args = parseArgs(process.argv.slice(2))
const config = {
  cdpPort: intArg('cdp-port', DEFAULTS.cdpPort),
  mcpPort: intArg('mcp-port', DEFAULTS.mcpPort),
  mcpHost: stringArg('mcp-host', DEFAULTS.mcpHost),
  mcpUrl: stringArg('mcp-url', ''),
  iterations: intArg('iterations', DEFAULTS.iterations),
  startupTimeoutMs: intArg('startup-timeout-ms', DEFAULTS.startupTimeoutMs),
  bridgeTimeoutMs: intArg('bridge-timeout-ms', DEFAULTS.bridgeTimeoutMs),
  waitTimeoutMs: intArg('wait-timeout-ms', DEFAULTS.waitTimeoutMs),
  startServer: !flag('no-start-server'),
  requireBridge: !flag('allow-no-bridge'),
  keepTabs: flag('keep-tabs'),
  verbose: flag('verbose'),
}
config.mcpUrl ||= `http://${config.mcpHost}:${config.mcpPort}/mcp`
const baseUrl = new URL(config.mcpUrl)
const healthUrl = new URL('/health', baseUrl).toString()

let serverProcess
let client
const createdPages = new Set()
const runId = `mcp-tabs-stability-${Date.now()}-${Math.random().toString(16).slice(2)}`
const summary = {
  runId,
  created: 0,
  closed: 0,
  iterations: 0,
  checks: 0,
  failures: [],
}

process.on('SIGINT', async () => {
  console.error('\nInterrupted, cleaning up...')
  await cleanup()
  process.exit(130)
})

try {
  await ensureServer()
  await waitForHealth()
  await waitForBridgeIfRequired()
  await connectMcp()
  await smokeTools()
  await runStabilityLoop()
  await cleanup()
  console.log(`\nPASS tabs stability (${summary.iterations} iterations, ${summary.checks} checks)`)
} catch (error) {
  summary.failures.push(error instanceof Error ? error.message : String(error))
  console.error('\nFAIL tabs stability')
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  await cleanup()
  process.exitCode = 1
} finally {
  if (summary.failures.length > 0 || config.verbose) {
    console.error('\nSummary:')
    console.error(JSON.stringify(summary, null, 2))
  }
}

async function ensureServer() {
  const existing = await fetchHealth().catch(() => null)
  if (existing?.status === 'ok') {
    log(`Using existing MCP server at ${healthUrl}`)
    return
  }
  if (!config.startServer) {
    throw new Error(`MCP server is not reachable at ${healthUrl}`)
  }

  const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
  const childArgs = [
    tsxCli,
    'src/cli.ts',
    '--backend',
    'chrome',
    '--cdp-port',
    String(config.cdpPort),
    '--mcp-port',
    String(config.mcpPort),
  ]
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  serverProcess = child

  child.stdout.on('data', (chunk) => {
    if (config.verbose) process.stdout.write(`[mcp stdout] ${chunk}`)
  })
  child.stderr.on('data', (chunk) => {
    if (config.verbose) process.stderr.write(`[mcp stderr] ${chunk}`)
  })
  child.on('exit', (code, signal) => {
    if (!child.killed && code !== 0) {
      console.error(`MCP server exited unexpectedly: code=${code} signal=${signal}`)
    }
  })

  log(`Started MCP server: ${process.execPath} ${childArgs.join(' ')}`)
}

async function waitForHealth() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < config.startupTimeoutMs) {
    const health = await fetchHealth().catch(() => null)
    if (health?.status === 'ok' && health.cdp === true) {
      assert(health.backend === 'chrome', `Expected backend=chrome, got ${health.backend}`)
      log(`MCP health ok: backend=${health.backend}, browser=${health.browser}`)
      return health
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for MCP health at ${healthUrl}`)
}

async function waitForBridgeIfRequired() {
  const startedAt = Date.now()
  let lastHealth
  while (Date.now() - startedAt < config.bridgeTimeoutMs) {
    lastHealth = await fetchHealth().catch(() => null)
    const bridge = lastHealth?.extensionBridge
    if (bridge?.connected && bridge.tabs > 0) {
      log(`Extension bridge connected: tabs=${bridge.tabs}, windows=${bridge.windows}, groups=${bridge.groups}, seq=${bridge.sequence}`)
      return
    }
    if (!config.requireBridge) {
      console.warn('Extension bridge is not connected; continuing because --allow-no-bridge was set.')
      return
    }
    await delay(500)
  }

  throw new Error(
    [
      'Extension bridge is not connected or has no tab state.',
      `Health: ${JSON.stringify(lastHealth?.extensionBridge ?? null)}`,
      'Open the bridge extension options page and make sure it points at this MCP port.',
      `Expected MCP port: ${config.mcpPort}`,
    ].join('\n'),
  )
}

async function connectMcp() {
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl))
  client = new Client(
    { name: 'tabs-stability-test', version: '0.1.0' },
    { capabilities: {} },
  )
  await client.connect(transport)
  const tools = await client.listTools()
  const toolNames = new Set(tools.tools.map((tool) => tool.name))
  for (const required of ['browser_state', 'tabs']) {
    assert(toolNames.has(required), `MCP tool missing: ${required}`)
  }
  log(`Connected MCP client, tools=${tools.tools.length}`)
}

async function smokeTools() {
  const health = await fetchHealth()
  assert(health.extensionBridge?.connected === true || !config.requireBridge, 'Bridge not connected in health response')

  const state = await browserStateGet()
  assert(state.snapshot, 'browser_state get did not return a snapshot')
  assert(state.snapshot.backend === 'chrome', `Expected browser_state backend=chrome, got ${state.snapshot.backend}`)

  await waitForStablePages('initial tabs list', (pages) => {
    assert(pages.length > 0, 'tabs list returned no pages')
  })
}

async function runStabilityLoop() {
  for (let i = 0; i < config.iterations; i += 1) {
    console.log(`\nIteration ${i + 1}/${config.iterations}`)

    const url = `https://example.invalid/${runId}/${i}`
    let beforeSeq = await currentSeq()
    const opened = await callTool('tabs', {
      action: 'new',
      url,
      background: true,
    })
    const page = readPageId(opened.structuredContent?.page)
    createdPages.add(page)
    summary.created += 1
    await waitForStateAfter(beforeSeq, 'tabs new')
    let pages = await waitForStablePages('after tabs new', (currentPages) => {
      const openedPage = requirePage(currentPages, page, 'new page')
      assertBridgePage(openedPage, 'new page')
    })
    let openedPage = requirePage(pages, page, 'new page')

    beforeSeq = await currentSeq()
    const activated = await callTool('tabs', { action: 'activate', page })
    await waitForStateAfter(beforeSeq, 'tabs activate')
    const activePage = readStructuredPage(activated.structuredContent?.page)
    assert(activePage.page === page, `activate returned page ${activePage.page}, expected ${page}`)
    pages = await waitForStablePages('after tabs activate', (currentPages) => {
      const current = requirePage(currentPages, page, 'activated page')
      assert(current.isActive === true, `Page ${page} is not active after activate`)
    })

    beforeSeq = await currentSeq()
    await callTool('tabs', { action: 'pin', page })
    await waitForStateAfter(beforeSeq, 'tabs pin')
    pages = await waitForStablePages('after tabs pin', (currentPages) => {
      const current = requirePage(currentPages, page, 'pinned page')
      assert(current.isPinned === true, `Page ${page} is not pinned after pin`)
    })

    beforeSeq = await currentSeq()
    await callTool('tabs', { action: 'unpin', page })
    await waitForStateAfter(beforeSeq, 'tabs unpin')
    pages = await waitForStablePages('after tabs unpin', (currentPages) => {
      const current = requirePage(currentPages, page, 'unpinned page')
      assert(current.isPinned === false, `Page ${page} is still pinned after unpin`)
    })
    openedPage = requirePage(pages, page, 'unpinned page')

    const sameWindow = pages.filter((candidate) => candidate.windowId === openedPage.windowId)
    const targetIndex = sameWindow.length > 1 ? sameWindow.length - 1 : 0
    beforeSeq = await currentSeq()
    await callTool('tabs', {
      action: 'move',
      page,
      windowId: openedPage.windowId,
      index: targetIndex,
    })
    await waitForStateAfter(beforeSeq, 'tabs move')
    pages = await waitForStablePages('after tabs move', (currentPages) => {
      const current = requirePage(currentPages, page, 'moved page')
      assertBridgePage(current, 'moved page')
    })

    beforeSeq = await currentSeq()
    const duplicated = await callTool('tabs', { action: 'duplicate', page })
    const duplicatePage = readStructuredPage(duplicated.structuredContent?.page).page
    createdPages.add(duplicatePage)
    summary.created += 1
    await waitForStateAfter(beforeSeq, 'tabs duplicate')
    await waitForStablePages('after tabs duplicate', (currentPages) => {
      const duplicate = requirePage(currentPages, duplicatePage, 'duplicate page')
      assertBridgePage(duplicate, 'duplicate page')
    })

    await closeCreatedPage(duplicatePage)
    await closeCreatedPage(page)
    summary.iterations += 1
  }
}

async function cleanup() {
  if (client) {
    try {
      await client.close()
    } catch {
      // ignore
    }
    client = undefined
  }

  if (!config.keepTabs && createdPages.size > 0 && client) {
    // This branch is intentionally unreachable because client is closed above.
  }

  if (!config.keepTabs && createdPages.size > 0) {
    try {
      await connectMcp()
      for (const page of [...createdPages].reverse()) {
        await closeCreatedPage(page).catch(() => {})
      }
      await client.close().catch(() => {})
      client = undefined
    } catch {
      // best-effort cleanup only
    }
  }

  if (serverProcess) {
    serverProcess.kill()
    serverProcess = undefined
  }
}

async function closeCreatedPage(page) {
  if (!createdPages.has(page)) return
  const beforeSeq = await currentSeq().catch(() => undefined)
  const result = await callTool('tabs', { action: 'close', page }).catch((error) => {
    log(`cleanup close page ${page} ignored: ${error.message}`)
    return null
  })
  if (result) {
    createdPages.delete(page)
    summary.closed += 1
    if (beforeSeq !== undefined) {
      await waitForStateAfter(beforeSeq, `tabs close ${page}`).catch((error) => {
        log(`state wait after close ignored: ${error.message}`)
      })
    }
  }
}

async function callTool(name, toolArgs) {
  const result = await client.callTool(
    { name, arguments: toolArgs },
    undefined,
    { timeout: config.waitTimeoutMs + 5_000 },
  )
  if (result.isError) {
    throw new Error(`${name} ${JSON.stringify(toolArgs)} failed: ${textOf(result)}`)
  }
  return result
}

async function browserStateGet() {
  return callTool('browser_state', { action: 'get' }).then((result) => result.structuredContent)
}

async function currentSeq() {
  const state = await browserStateGet()
  assert(Number.isInteger(state?.snapshot?.seq), 'browser_state snapshot seq is missing')
  return state.snapshot.seq
}

async function waitForStateAfter(seq, label) {
  const result = await callTool('browser_state', {
    action: 'wait',
    sinceSeq: seq,
    timeoutMs: config.waitTimeoutMs,
  })
  const event = result.structuredContent?.event
  assert(event && event.seq > seq, `${label}: browser_state did not advance after seq ${seq}`)
  log(`${label}: state seq ${seq} -> ${event.seq} (${event.reason})`)
  return event
}

async function listPages() {
  const result = await callTool('tabs', { action: 'list' })
  const pages = result.structuredContent?.pages
  assert(Array.isArray(pages), 'tabs list did not return pages[]')
  return pages
}

async function waitForStablePages(label, validate) {
  const deadline = Date.now() + config.waitTimeoutMs
  let lastError
  let lastPages = []
  while (Date.now() < deadline) {
    try {
      const pages = await listPages()
      lastPages = pages
      assertBridgePageFields(pages)
      assertVisualOrder(pages)
      assertActiveState(pages)
      validate?.(pages)
      return pages
    } catch (error) {
      lastError = error
      await delay(250)
    }
  }
  throw new Error(
    [
      `${label}: tabs list did not stabilize within ${config.waitTimeoutMs}ms`,
      lastError instanceof Error ? lastError.message : String(lastError),
      formatPages(lastPages),
    ].join('\n'),
  )
}

function assertBridgePageFields(pages) {
  for (const page of pages) {
    assertBridgePage(page, `page ${page.page}`)
  }
}

function assertBridgePage(page, label) {
  assert(Number.isInteger(page.page), `${label}: page id missing`)
  assert(Number.isInteger(page.tabId), `${label}: tabId missing; extension state is not complete`)
  assert(Number.isInteger(page.windowId), `${label}: windowId missing; extension state is not complete`)
  assert(Number.isInteger(page.index), `${label}: index missing; extension state is not complete`)
  assert(typeof page.isActive === 'boolean', `${label}: isActive missing`)
  assert(typeof page.isPinned === 'boolean', `${label}: isPinned missing`)
  assert(typeof page.isHidden === 'boolean', `${label}: isHidden missing`)
}

function assertVisualOrder(pages) {
  const grouped = new Map()
  for (const page of pages) {
    if (!Number.isInteger(page.windowId) || !Number.isInteger(page.index)) continue
    const group = grouped.get(page.windowId) ?? []
    group.push(page)
    grouped.set(page.windowId, group)
  }

  for (const [windowId, group] of grouped) {
    for (let i = 1; i < group.length; i += 1) {
      assert(
        group[i - 1].index <= group[i].index,
        `Window ${windowId} visual order is not sorted: page ${group[i - 1].page} index=${group[i - 1].index}, page ${group[i].page} index=${group[i].index}`,
      )
    }
    const seen = new Set()
    for (const page of group) {
      assert(!seen.has(page.index), `Window ${windowId} has duplicate tab index ${page.index}`)
      seen.add(page.index)
    }
  }
  summary.checks += 1
}

function assertActiveState(pages) {
  const active = pages.filter((page) => page.isActive)
  assert(active.length >= 1, 'No page has isActive=true; extension active state is stale')
  const activeByWindow = new Map()
  for (const page of active) {
    const count = activeByWindow.get(page.windowId) ?? 0
    activeByWindow.set(page.windowId, count + 1)
  }
  for (const [windowId, count] of activeByWindow) {
    assert(count === 1, `Window ${windowId} has ${count} active tabs`)
  }
  summary.checks += 1
}

function requirePage(pages, pageId, label) {
  const page = pages.find((candidate) => candidate.page === pageId)
  assert(page, `${label}: page ${pageId} not found in tabs list`)
  return page
}

function formatPages(pages) {
  if (!pages?.length) return '(no pages)'
  return pages
    .map((page) =>
      [
        `page=${page.page}`,
        `tab=${page.tabId}`,
        `win=${page.windowId}`,
        `idx=${page.index}`,
        page.isActive ? 'active' : '',
        page.isPinned ? 'pinned' : '',
        page.isHidden ? 'hidden' : '',
        page.url,
      ].filter(Boolean).join(' '),
    )
    .join('\n')
}

function readPageId(value) {
  if (Number.isInteger(value)) return value
  if (value && Number.isInteger(value.page)) return value.page
  throw new Error(`Could not read page id from ${JSON.stringify(value)}`)
}

function readStructuredPage(value) {
  assert(value && typeof value === 'object', `Expected structured page object, got ${JSON.stringify(value)}`)
  assert(Number.isInteger(value.page), `Structured page object is missing page: ${JSON.stringify(value)}`)
  return value
}

async function fetchHealth() {
  const response = await fetch(healthUrl)
  if (!response.ok) throw new Error(`health HTTP ${response.status}`)
  return response.json()
}

function textOf(result) {
  return result.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n') ?? ''
}

function assert(condition, message) {
  summary.checks += 1
  if (!condition) throw new Error(message)
}

function log(message) {
  if (config.verbose) console.log(message)
}

function parseArgs(argv) {
  const parsed = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      parsed.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      parsed.set(body, next)
      i += 1
    } else {
      parsed.set(body, true)
    }
  }
  return parsed
}

function flag(name) {
  return args.get(name) === true || args.get(name) === 'true'
}

function stringArg(name, fallback) {
  const value = args.get(name)
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function intArg(name, fallback) {
  const value = args.get(name)
  if (value === undefined || value === true) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}
