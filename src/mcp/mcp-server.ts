import type { BrowserSession } from '../browser/session'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  BROWSER_AUTOMATION_PROMPT_DESCRIPTION,
  BROWSER_AUTOMATION_PROMPT_NAME,
  BROWSER_AUTOMATION_PROMPT_TITLE,
  BROWSER_MCP_INSTRUCTIONS,
  buildBrowserAutomationPrompt,
} from './mcp-prompt'
import {
  type BrowserToolDefaults,
  type BrowserToolRegistrationOptions,
  registerBrowserTools,
} from './register'

export interface BrowserMcpServerOptions extends BrowserToolDefaults {
  name: string
  title: string
  version: string
  browserSession: BrowserSession
  instructions?: string
  registration?: BrowserToolRegistrationOptions
}

/** Creates a BrowserOS MCP server with only the shared browser tool surface. */
export function createBrowserMcpServer(
  options: BrowserMcpServerOptions,
): McpServer {
  const server = new McpServer(
    {
      name: options.name,
      title: options.title,
      version: options.version,
    },
    {
      capabilities: { logging: {} },
      instructions: options.instructions ?? BROWSER_MCP_INSTRUCTIONS,
    },
  )

  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {}
  })

  server.registerPrompt(
    BROWSER_AUTOMATION_PROMPT_NAME,
    {
      title: BROWSER_AUTOMATION_PROMPT_TITLE,
      description: BROWSER_AUTOMATION_PROMPT_DESCRIPTION,
      argsSchema: {
        task: z
          .string()
          .optional()
          .describe('Optional browser task to include in the prompt.'),
      },
    },
    ({ task }) => ({
      description: BROWSER_AUTOMATION_PROMPT_DESCRIPTION,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: buildBrowserAutomationPrompt(task),
          },
        },
      ],
    }),
  )

  registerBrowserTools(
    server,
    options.browserSession,
    {
      defaultWindowId: options.defaultWindowId,
      defaultTabGroupId: options.defaultTabGroupId,
    },
    options.registration,
    options.browserSession.backend,
  )

  return server
}
