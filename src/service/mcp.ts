import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import type { PersonalFeedApplicationPort, SafeLogger } from './contracts.ts'

export const PERSONAL_FEED_TOOL_NAMES = Object.freeze([
  'request',
  'observe_context',
  'process_feedback',
  'record_feedback',
  'list_saved',
] as const)

const currentText = z.string().min(1).max(100_000)
const referenceText = z.string().min(1).max(16_000).optional()
const requestOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('one_link'), url: z.string().url() }).strict(),
  z.object({ status: z.literal('business_empty') }).strict(),
  z.object({
    status: z.literal('incomplete'),
    stage: z.enum(['context_observation', 'personal_context', 'source_window', 'judgement_execution', 'conflict', 'shutdown']),
  }).strict(),
])
const observeOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), appliedCount: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('ignored') }).strict(),
  z.object({ status: z.literal('already_observed') }).strict(),
  z.object({ status: z.literal('incomplete'), stage: z.enum(['context_observation', 'conflict']) }).strict(),
])
const feedbackOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pass') }).strict(),
  z.object({ status: z.literal('completed') }).strict(),
  z.object({ status: z.literal('discarded') }).strict(),
  z.object({
    status: z.literal('needs_input'),
    question: z.string().min(1),
    continuationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  }).strict(),
  z.object({ status: z.literal('incomplete'), stage: z.enum(['feedback_interpretation', 'feedback_commit', 'conflict']) }).strict(),
])
const recordOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved') }).strict(),
  z.object({ status: z.literal('unsaved') }).strict(),
  z.object({ status: z.literal('already_saved') }).strict(),
  z.object({ status: z.literal('already_unsaved') }).strict(),
])
const savedItem = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  note: z.string().optional(),
  savedAt: z.string(),
}).strict()
const listOutput = z.object({ status: z.literal('completed'), items: z.array(savedItem) }).strict()

type OutputSchema = z.ZodType<Record<string, unknown>>

/** Create a fresh MCP server for one stateless Streamable HTTP request. */
export function createPersonalFeedMcpServer(options: {
  readonly application: PersonalFeedApplicationPort
  readonly toolTimeoutMs: number
  readonly logger?: SafeLogger
  readonly track: <T>(operation: string, task: Promise<T>, abort: AbortController) => Promise<T>
}): McpServer {
  const server = new McpServer(
    { name: 'personal-feed', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  register(server, options, 'request', {
    description: '根据当前用户原文请求一条 Personal Feed；同一调用已处理本轮语境，不要再调用 observe_context。',
    inputSchema: z.object({ currentText }).strict(),
    outputSchema: requestOutput,
    invoke: (input, context) => options.application.request(input, context),
  })
  register(server, options, 'observe_context', {
    description: '仅当当前用户原文直接表达长期兴趣或已有认识时观察上下文。',
    inputSchema: z.object({ currentText }).strict(),
    outputSchema: observeOutput,
    invoke: (input, context) => options.application.observeContext(input, context),
  })
  register(server, options, 'process_feedback', {
    description: '处理用户对 Feed 的反馈；如果需要追问，原样传回 continuationToken。',
    inputSchema: z.object({
      currentText,
      referenceText,
      continuationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
    }).strict(),
    outputSchema: feedbackOutput,
    invoke: (input, context) => options.application.processFeedback({
      currentText: input.currentText,
      ...(input.referenceText === undefined ? {} : { referenceText: input.referenceText }),
      ...(input.continuationToken === undefined ? {} : { continuationToken: input.continuationToken }),
    }, context),
  })
  register(server, options, 'record_feedback', {
    description: '只记录收藏或取消收藏，不代替喜欢或不喜欢反馈。',
    inputSchema: z.object({
      operation: z.enum(['save', 'unsave']),
      url: z.string().url(),
      title: z.string().max(1_000).optional(),
      note: z.string().max(2_000).optional(),
    }).strict(),
    outputSchema: recordOutput,
    invoke: (input, context) => options.application.recordFeedback({
      operation: input.operation,
      url: input.url,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.note === undefined ? {} : { note: input.note }),
    }, context),
  })
  register(server, options, 'list_saved', {
    description: '列出当前仍为 saved 状态的条目。',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
    outputSchema: listOutput,
    invoke: (input, context) => options.application.listSaved(
      input.limit === undefined ? {} : { limit: input.limit },
      context,
    ),
  })
  return server
}

export async function connectMcpServer(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport)
}

function register<Input extends Record<string, unknown>>(
  server: McpServer,
  options: Parameters<typeof createPersonalFeedMcpServer>[0],
  operation: typeof PERSONAL_FEED_TOOL_NAMES[number],
  definition: {
    readonly description: string
    readonly inputSchema: z.ZodType<Input>
    readonly outputSchema: OutputSchema
    readonly invoke: (input: Input, context: { signal: AbortSignal }) => Promise<unknown>
  },
): void {
  server.registerTool(operation, {
    description: definition.description,
    inputSchema: definition.inputSchema,
  }, async (input, extra) => {
    const started = performance.now()
    const requestId = randomUUID()
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(new Error('tool timeout')), options.toolTimeoutMs)
    const onClientAbort = () => abort.abort(extra.signal.reason)
    extra.signal.addEventListener('abort', onClientAbort, { once: true })
    try {
      const task = definition.invoke(input as Input, { signal: abort.signal })
      const untrustedResult = await options.track(operation, task, abort)
      const structuredContent = definition.outputSchema.parse(untrustedResult) as Record<string, unknown>
      options.logger?.({
        operation,
        requestId,
        result: 'success',
        resultCategory: String(structuredContent.status),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      })
      return {
        content: [{ type: 'text' as const, text: humanText(operation, String(structuredContent.status), structuredContent) }],
        structuredContent,
      }
    } catch {
      options.logger?.({
        operation,
        requestId,
        result: 'error',
        resultCategory: abort.signal.aborted ? 'cancelled_or_timeout' : 'handler_error',
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      })
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'Personal Feed 本次调用未完成。' }],
      }
    } finally {
      clearTimeout(timeout)
      extra.signal.removeEventListener('abort', onClientAbort)
    }
  })
}

function humanText(operation: string, status: string, output: Record<string, unknown>): string {
  if (status === 'business_empty') return '暂时没有符合条件的 Personal Feed 内容。'
  if (status === 'needs_input') return typeof output.question === 'string' ? output.question : '需要你补充信息。'
  if (status === 'one_link') return `Personal Feed 已选出一条内容：${String(output.url)}`
  if (status === 'incomplete') return `Personal Feed 在 ${String(output.stage)} 阶段未完成。`
  if (operation === 'list_saved') return `已返回 ${Array.isArray(output.items) ? output.items.length : 0} 条收藏。`
  return `Personal Feed 结果：${status}。`
}
