/**
 * browseros-mcp — Standalone Browser Automation MCP Server
 *
 * Supports both BrowserOS and standard Chrome via CDP.
 *
 * @example
 * ```ts
 * import { createHttpServer, resolveConfig } from 'browseros-mcp'
 *
 * const config = resolveConfig({ backend: 'auto', cdpPort: 9222, mcpPort: 3000 })
 * await createHttpServer(config)
 * ```
 *
 * @module browseros-mcp
 */

export { createHttpServer } from './server.js'
export { resolveConfig, DEFAULT_CONFIG, configFromArgs, configFromEnv } from './config.js'
export type { ServerConfig, BackendMode } from './config.js'

export { CdpConnectionImpl } from './cdp/connection-impl.js'
export type { CdpConnectionImplConfig } from './cdp/connection-impl.js'
export type { CdpConnection, SessionId } from './cdp/connection.js'

export { BrowserSession } from './browser/session.js'
export type { BrowserSessionOptions, BrowserSessionHooks } from './browser/session.js'

export { createBrowserMcpServer } from './mcp/mcp-server.js'
export type { BrowserMcpServerOptions } from './mcp/mcp-server.js'
export {
  BROWSER_AUTOMATION_PROMPT_DESCRIPTION,
  BROWSER_AUTOMATION_PROMPT_NAME,
  BROWSER_AUTOMATION_PROMPT_TITLE,
  BROWSER_MCP_INSTRUCTIONS,
  buildBrowserAutomationPrompt,
} from './mcp/mcp-prompt.js'

export { launchChrome } from './chrome-launch.js'
