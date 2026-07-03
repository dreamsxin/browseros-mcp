import { z } from 'zod'

export const browserContextIdSchema = z.string()

export const pageInfoSchema = z.object({
  page: z.number().int(),
  targetId: z.string(),
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
  isActive: z.boolean(),
  isLoading: z.boolean(),
  loadProgress: z.number(),
  isPinned: z.boolean(),
  isHidden: z.boolean(),
  windowId: z.number().int().optional(),
  index: z.number().int().optional(),
  groupId: z.string().optional(),
  browserContextId: browserContextIdSchema.optional(),
})

export const pageListEntrySchema = z.object({
  page: z.number().int(),
  url: z.string(),
  title: z.string().optional(),
})

export const windowBoundsSchema = z.object({
  left: z.number().optional(),
  top: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  windowState: z
    .enum(['normal', 'minimized', 'maximized', 'fullscreen'])
    .optional(),
})

export const windowInfoSchema = z.object({
  windowId: z.number().int(),
  windowType: z.enum([
    'normal',
    'popup',
    'app',
    'devtools',
    'app_popup',
    'picture_in_picture',
  ]),
  bounds: windowBoundsSchema,
  isActive: z.boolean(),
  isVisible: z.boolean(),
  tabCount: z.number().int(),
  activeTabId: z.number().int().optional(),
  browserContextId: browserContextIdSchema.optional(),
})

export const tabGroupWithPagesSchema = z.object({
  groupId: z.string(),
  windowId: z.number().int(),
  title: z.string(),
  color: z.string(),
  collapsed: z.boolean(),
  pageIds: z.array(z.number().int()),
})

export const screenshotAnnotationBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export const screenshotAnnotationSchema = z.object({
  ref: z.string(),
  number: z.number().int(),
  role: z.string(),
  name: z.string().optional(),
  box: screenshotAnnotationBoxSchema,
})

export const snapshotStructuredSchema = z.object({
  snapshot: z.string(),
  path: z.string().optional(),
  contentLength: z.number().int().optional(),
  tokenEstimate: z.number().int().optional(),
  writtenToFile: z.boolean().optional(),
  outputWriteFailed: z.boolean().optional(),
  error: z.string().optional(),
})

export const diffStructuredSchema = z.object({
  changed: z.boolean(),
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  urlChanged: z.boolean().optional(),
  beforeUrl: z.string().optional(),
  afterUrl: z.string().optional(),
  diff: z.string().optional(),
  snapshot: z.string().optional(),
  truncated: z.boolean().optional(),
  tokenEstimate: z.number().int().optional(),
  path: z.string().optional(),
  contentLength: z.number().int().optional(),
  writtenToFile: z.boolean().optional(),
  outputWriteFailed: z.boolean().optional(),
  error: z.string().optional(),
})
