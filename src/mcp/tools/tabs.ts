import { z } from 'zod'
import { defineTool, errorResult, textResult } from './framework'
import { pageInfoSchema, pageListEntrySchema } from './output-schemas'

const ACTIONS = [
  'list',
  'active',
  'new',
  'close',
  'activate',
  'move',
  'duplicate',
  'pin',
  'unpin',
] as const

export const tabs = defineTool({
  name: 'tabs',
  description:
    'Manage browser tabs: list open pages, get the current active page, open, close, focus, move, duplicate, pin, or unpin a page. Use the returned page id with snapshot/act/navigate.',
  input: z.object({
    action: z.enum(ACTIONS).default('list'),
    url: z
      .string()
      .optional()
      .describe('URL for action="new" (defaults to about:blank).'),
    background: z
      .boolean()
      .default(true)
      .describe('Open without stealing focus for action="new".'),
    hidden: z
      .boolean()
      .default(false)
      .describe('Create in a hidden window for action="new".'),
    page: z
      .number()
      .int()
      .optional()
      .describe('Page id for close, activate, move, duplicate, pin, or unpin. action="active" does not take a page id.'),
    windowId: z
      .number()
      .int()
      .optional()
      .describe('Destination window id for action="move".'),
    index: z
      .number()
      .int()
      .optional()
      .describe('Destination tab index for action="move". Omit to move to the end.'),
  }),
  output: z.object({
    action: z.enum(ACTIONS),
    pages: z.array(pageListEntrySchema).optional(),
    page: z.union([pageInfoSchema, z.number().int()]).optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (args, ctx) => {
    switch (args.action) {
      case 'list': {
        const pages = await ctx.session.pages.list()
        const lines = pages.map(formatPageLine)
        return textResult(lines.join('\n') || '(no open pages)', {
          action: 'list',
          pages: pages.map((p) => ({
            page: p.pageId,
            tabId: p.tabId,
            url: p.url,
            title: p.title,
            isActive: p.isActive,
            isPinned: p.isPinned,
            isHidden: p.isHidden,
            ...(p.windowId !== undefined && { windowId: p.windowId }),
            ...(p.index !== undefined && { index: p.index }),
            ...(p.groupId !== undefined && { groupId: p.groupId }),
          })),
        })
      }
      case 'active': {
        const page = await ctx.session.pages.getActive()
        if (!page) {
          return errorResult('tabs active: no active page found.')
        }
        return textResult(`Active page: ${formatPageLine(page)}`, {
          action: 'active',
          page: structuredPage(page),
        })
      }
      case 'new': {
        const page = await ctx.session.pages.newPage(
          args.url ?? 'about:blank',
          {
            background: args.background,
            hidden: args.hidden,
            windowId: ctx.defaultWindowId,
            tabGroupId: ctx.defaultTabGroupId,
          },
        )
        return textResult(`opened page ${page}`, { action: 'new', page })
      }
      case 'close': {
        if (args.page === undefined) {
          return errorResult('tabs close: page is required.')
        }
        await ctx.session.pages.close(args.page)
        return textResult(`closed page ${args.page}`, {
          action: 'close',
          page: args.page,
        })
      }
      case 'activate': {
        if (args.page === undefined) {
          return errorResult('tabs activate: page is required.')
        }
        const page = await ctx.session.pages.activate(args.page)
        return textResult(`activated page ${page.pageId}: ${formatPageLine(page)}`, {
          action: 'activate',
          page: structuredPage(page),
        })
      }
      case 'move': {
        if (args.page === undefined) {
          return errorResult('tabs move: page is required.')
        }
        const page = await ctx.session.pages.move(args.page, {
          ...(args.windowId !== undefined && { windowId: args.windowId }),
          ...(args.index !== undefined && { index: args.index }),
        })
        return textResult(`moved page ${page.pageId}: ${formatPageLine(page)}`, {
          action: 'move',
          page: structuredPage(page),
        })
      }
      case 'duplicate': {
        if (args.page === undefined) {
          return errorResult('tabs duplicate: page is required.')
        }
        const page = await ctx.session.pages.duplicate(args.page)
        return textResult(`duplicated page ${args.page} as page ${page.pageId}: ${formatPageLine(page)}`, {
          action: 'duplicate',
          page: structuredPage(page),
        })
      }
      case 'pin': {
        if (args.page === undefined) {
          return errorResult('tabs pin: page is required.')
        }
        const page = await ctx.session.pages.setPinned(args.page, true)
        return textResult(`pinned page ${page.pageId}: ${formatPageLine(page)}`, {
          action: 'pin',
          page: structuredPage(page),
        })
      }
      case 'unpin': {
        if (args.page === undefined) {
          return errorResult('tabs unpin: page is required.')
        }
        const page = await ctx.session.pages.setPinned(args.page, false)
        return textResult(`unpinned page ${page.pageId}: ${formatPageLine(page)}`, {
          action: 'unpin',
          page: structuredPage(page),
        })
      }
      default:
        return errorResult('tabs: unsupported action.')
    }
  },
})

function formatPageLine(page: { pageId: number; url: string; title?: string }) {
  return `[${page.pageId}] ${page.url}${page.title ? ` (${page.title})` : ''}`
}

function structuredPage(page: {
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
  groupId?: string
  browserContextId?: string
}) {
  return {
    page: page.pageId,
    targetId: page.targetId,
    tabId: page.tabId,
    url: page.url,
    title: page.title,
    isActive: page.isActive,
    isLoading: page.isLoading,
    loadProgress: page.loadProgress,
    isPinned: page.isPinned,
    isHidden: page.isHidden,
    ...(page.windowId !== undefined && { windowId: page.windowId }),
    ...(page.index !== undefined && { index: page.index }),
    ...(page.groupId !== undefined && { groupId: page.groupId }),
    ...(page.browserContextId !== undefined && { browserContextId: page.browserContextId }),
  }
}
