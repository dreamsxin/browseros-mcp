/**
 * Server configuration — supports both BrowserOS and standard Chrome backends.
 *
 * The `backend` option determines which CDP domains are used:
 *   - 'browseros': Uses BrowserOS custom CDP domains (Browser.getTabs, Browser.getWindows, etc.)
 *   - 'chrome':    Uses standard Chrome CDP domains (Target.getTargets, Target.createTarget, etc.)
 *   - 'auto':      Probes the connected browser to detect BrowserOS vs standard Chrome
 */

export type BackendMode = 'browseros' | 'chrome' | 'auto'

export interface ServerConfig {
  /** Chrome/BrowserOS CDP remote debugging port (default: 9222) */
  cdpPort: number
  /** CDP host address (default: 127.0.0.1) */
  cdpHost: string
  /** MCP HTTP server port (default: 3000) */
  mcpPort: number
  /** Browser backend mode (default: 'auto') */
  backend: BackendMode
  /** Chrome executable path (optional, for auto-launch) */
  chromePath?: string
  /** Whether to auto-launch Chrome (default: false) */
  autoLaunch: boolean
  /** MCP server name (default: "browseros-mcp") */
  serverName: string
  /** MCP server title (default: "BrowserOS MCP") */
  serverTitle: string
  /** MCP server version (default: "0.1.0") */
  serverVersion: string
  /** Default window ID for new pages (BrowserOS mode only) */
  defaultWindowId?: number
  /** Default tab group ID for new pages (BrowserOS mode only) */
  defaultTabGroupId?: string
  /** Max retries for CDP connection (default: 10) */
  cdpMaxRetries: number
  /** Retry delay in ms (default: 1000) */
  cdpRetryDelay: number
  /** HTTP fetch timeout in ms (default: 5000) */
  cdpFetchTimeout: number
  /** Enable verbose debug logging (default: false) */
  debug: boolean
}

export const DEFAULT_CONFIG: ServerConfig = {
  cdpPort: 9222,
  cdpHost: '127.0.0.1',
  mcpPort: 3000,
  backend: 'auto',
  autoLaunch: false,
  serverName: 'browseros-mcp',
  serverTitle: 'BrowserOS MCP',
  serverVersion: '0.1.0',
  cdpMaxRetries: 10,
  cdpRetryDelay: 1000,
  cdpFetchTimeout: 5000,
  debug: false,
}

const BACKEND_MODES = new Set<BackendMode>(['browseros', 'chrome', 'auto'])

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function parseInteger(value: unknown, name: string): number {
  const number = Number(value)
  if (!Number.isInteger(number)) {
    throw new Error(`${name} must be an integer.`)
  }
  return number
}

function parsePort(value: unknown, name: string): number {
  const port = parseInteger(value, name)
  if (port < 1 || port > 65535) {
    throw new Error(`${name} must be between 1 and 65535.`)
  }
  return port
}

function parseBackend(value: unknown, name: string): BackendMode {
  const backend = String(value)
  if (!BACKEND_MODES.has(backend as BackendMode)) {
    throw new Error(`${name} must be one of: browseros, chrome, auto.`)
  }
  return backend as BackendMode
}

function validateConfig(config: ServerConfig): ServerConfig {
  parsePort(config.cdpPort, 'cdpPort')
  parsePort(config.mcpPort, 'mcpPort')
  parseBackend(config.backend, 'backend')
  if (!config.cdpHost.trim()) throw new Error('cdpHost must not be empty.')
  if (!config.serverName.trim()) throw new Error('serverName must not be empty.')
  if (!config.serverTitle.trim()) throw new Error('serverTitle must not be empty.')
  if (!config.serverVersion.trim()) throw new Error('serverVersion must not be empty.')
  if (config.defaultWindowId !== undefined) {
    parseInteger(config.defaultWindowId, 'defaultWindowId')
  }
  if (!Number.isInteger(config.cdpMaxRetries) || config.cdpMaxRetries < 1) {
    throw new Error('cdpMaxRetries must be a positive integer.')
  }
  if (!Number.isFinite(config.cdpRetryDelay) || config.cdpRetryDelay < 0) {
    throw new Error('cdpRetryDelay must be a non-negative number.')
  }
  if (!Number.isFinite(config.cdpFetchTimeout) || config.cdpFetchTimeout < 1) {
    throw new Error('cdpFetchTimeout must be a positive number.')
  }
  return config
}

/**
 * Parse CLI arguments into a partial ServerConfig.
 */
export function configFromArgs(args: Record<string, unknown>): Partial<ServerConfig> {
  const config: Partial<ServerConfig> = {}

  if (isPresent(args['cdp-port'])) config.cdpPort = parsePort(args['cdp-port'], '--cdp-port')
  if (isPresent(args['cdp-host'])) config.cdpHost = String(args['cdp-host'])
  if (isPresent(args['mcp-port'])) config.mcpPort = parsePort(args['mcp-port'], '--mcp-port')
  if (isPresent(args['backend'])) config.backend = parseBackend(args['backend'], '--backend')
  if (isPresent(args['chrome-path'])) config.chromePath = String(args['chrome-path'])
  if (args['auto-launch']) config.autoLaunch = true
  if (isPresent(args['name'])) config.serverName = String(args['name'])
  if (isPresent(args['title'])) config.serverTitle = String(args['title'])
  if (isPresent(args['version'])) config.serverVersion = String(args['version'])
  if (isPresent(args['window-id'])) config.defaultWindowId = parseInteger(args['window-id'], '--window-id')
  if (isPresent(args['tab-group-id'])) config.defaultTabGroupId = String(args['tab-group-id'])
  if (args['debug']) config.debug = true

  return config
}

/**
 * Parse environment variables (BROWSEROS_MCP_* prefix) into a partial ServerConfig.
 */
export function configFromEnv(): Partial<ServerConfig> {
  const config: Partial<ServerConfig> = {}
  const env = process.env

  if (env.BROWSEROS_MCP_CDP_PORT) config.cdpPort = parsePort(env.BROWSEROS_MCP_CDP_PORT, 'BROWSEROS_MCP_CDP_PORT')
  if (env.BROWSEROS_MCP_CDP_HOST) config.cdpHost = env.BROWSEROS_MCP_CDP_HOST
  if (env.BROWSEROS_MCP_MCP_PORT) config.mcpPort = parsePort(env.BROWSEROS_MCP_MCP_PORT, 'BROWSEROS_MCP_MCP_PORT')
  if (env.BROWSEROS_MCP_BACKEND) config.backend = parseBackend(env.BROWSEROS_MCP_BACKEND, 'BROWSEROS_MCP_BACKEND')
  if (env.BROWSEROS_MCP_CHROME_PATH) config.chromePath = env.BROWSEROS_MCP_CHROME_PATH
  if (env.BROWSEROS_MCP_AUTO_LAUNCH === '1') config.autoLaunch = true
  if (env.BROWSEROS_MCP_SERVER_NAME) config.serverName = env.BROWSEROS_MCP_SERVER_NAME
  if (env.BROWSEROS_MCP_SERVER_VERSION) config.serverVersion = env.BROWSEROS_MCP_SERVER_VERSION
  if (env.BROWSEROS_MCP_DEBUG === '1' || env.BROWSEROS_MCP_DEBUG === 'true') config.debug = true

  return config
}

/**
 * Merge configs with priority: CLI args > env vars > defaults.
 */
export function resolveConfig(
  args: Record<string, unknown> = {},
): ServerConfig {
  return validateConfig({
    ...DEFAULT_CONFIG,
    ...configFromEnv(),
    ...configFromArgs(args),
  })
}
