import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { PersonalFeedInputError, PersonalFeedStorageError } from '../errors.ts'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { InteractionOptions, InteractionReply } from '../interaction.ts'
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
const interactionReason = z.enum(['interaction_unavailable', 'interaction_declined', 'interaction_cancelled', 'interaction_timeout'])
const feedLimitation = z.enum(['partial_observation', 'material_insufficient', 'judgement_incomplete'])
const feedOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('one_link'),
    url: z.string().url(),
    limitations: z.array(feedLimitation).min(1).refine(value => new Set(value).size === value.length).optional(),
  }).strict(),
  z.object({ status: z.literal('business_empty') }).strict(),
  z.object({
    status: z.literal('incomplete'),
    stage: z.enum(['context_observation', 'personal_context', 'source_window', 'judgement_execution', 'conflict', 'shutdown']),
    reason: z.union([z.enum(['observation_failed', 'partial_observation', 'material_insufficient', 'exploration_not_ready']), interactionReason]).optional(),
  }).strict(),
]).superRefine(checkReason)
const requestOutput = feedOutput
const observeOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), appliedCount: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('ignored') }).strict(),
  z.object({ status: z.literal('already_observed') }).strict(),
  z.object({ status: z.literal('incomplete'), stage: z.enum(['context_observation', 'conflict']), reason: interactionReason.optional() }).strict(),
]).superRefine(checkReason)
const feedbackOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pass') }).strict(),
  z.object({ status: z.literal('completed') }).strict(),
  z.object({ status: z.literal('discarded') }).strict(),
  z.object({ status: z.literal('needs_input'), question: z.string().min(1) }).strict(),
  z.object({ status: z.literal('incomplete'), stage: z.enum(['feedback_interpretation', 'feedback_commit', 'conflict']), reason: interactionReason.optional() }).strict(),
]).superRefine(checkReason)
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

/** Create an MCP server for one in-memory protocol connection. */
export function createPersonalFeedMcpServer(options: {
  readonly application: PersonalFeedApplicationPort
  readonly toolTimeoutMs: number
  readonly logger?: SafeLogger
  readonly track: <T>(task: Promise<T>, abort: AbortController) => Promise<T>
  readonly terminateRequest?: (requestId: string | number) => void
  readonly releaseRequest?: (requestId: string | number) => void
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
    description: '观察用户直接表达的长期兴趣或已有认识；必要问答在本次调用内完成，不自行再请求 Feed。',
    inputSchema: z.object({ currentText }).strict(),
    outputSchema: observeOutput,
    invoke: (input, context) => options.application.observeContext({
      currentText: input.currentText,
    }, context),
  })
  register(server, options, 'process_feedback', {
    description: '处理用户对 Feed 的反馈；必要问答在本次调用内完成。',
    inputSchema: z.object({
      currentText,
      referenceText,
    }).strict(),
    outputSchema: feedbackOutput,
    invoke: (input, context) => options.application.processFeedback({
      currentText: input.currentText,
      ...(input.referenceText === undefined ? {} : { referenceText: input.referenceText }),
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
    readonly invoke: (input: Input, context: InteractionOptions & { signal: AbortSignal }) => Promise<unknown>
  },
): void {
  server.registerTool(operation, {
    description: definition.description,
    inputSchema: definition.inputSchema,
  }, async (input, extra) => {
    const started = performance.now()
    const requestId = randomUUID()
    const abort = new AbortController()
    let timedOut = false
    let rejectDeadline: ((reason: Error) => void) | undefined
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
    const transportTermination = operation === 'record_feedback' || operation === 'list_saved'
    const timeout = setTimeout(() => {
      timedOut = true
      const reason = new DOMException('tool timeout', 'TimeoutError')
      abort.abort(reason)
      if (transportTermination) options.terminateRequest?.(extra.requestId)
      rejectDeadline?.(reason)
    }, options.toolTimeoutMs)
    const onClientAbort = () => {
      abort.abort(extra.signal.reason)
      rejectDeadline?.(extra.signal.reason instanceof Error ? extra.signal.reason : new Error('client cancelled'))
    }
    extra.signal.addEventListener('abort', onClientAbort, { once: true })
    if (extra.signal.aborted) onClientAbort()
    try {
      const header = extra.requestInfo?.headers['personal-feed-mode']
      if (header !== undefined && header !== 'background' && header !== 'interactive') throw new PersonalFeedInputError('invalid interaction mode')
      const mode = header ?? 'background'
      const ask = async (question: string, signal: AbortSignal): Promise<InteractionReply> => {
        const combined = AbortSignal.any([signal, abort.signal])
        if (combined.aborted) return { action: timedOut ? 'timeout' : 'cancel' }
        if (!server.server.getClientCapabilities()?.elicitation?.form) return { action: 'unavailable' }
        const remaining = Math.max(1, options.toolTimeoutMs - (performance.now() - started))
        try {
          const reply = await server.server.elicitInput({
            mode: 'form', message: question,
            requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: '回答', minLength: 1, maxLength: 100_000 } }, required: ['answer'] },
          }, { relatedRequestId: extra.requestId, signal: combined, timeout: remaining })
          if (reply.action !== 'accept') return { action: reply.action }
          const text = reply.content?.answer
          if (typeof text !== 'string' || text.trim().length === 0 || text.length > 100_000) throw new PersonalFeedInputError('invalid answer')
          return { action: 'accept', text }
        } catch (error) {
          if (combined.aborted) return { action: timedOut ? 'timeout' : 'cancel' }
          if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return { action: 'timeout' }
          if (error instanceof PersonalFeedInputError) throw error
          if (error instanceof McpError && error.code === ErrorCode.InvalidParams) throw new PersonalFeedInputError('invalid answer')
          return { action: 'unavailable' }
        }
      }
      const task = definition.invoke(input as Input, { signal: abort.signal, mode, ask })
      const tracked = options.track(task, abort)
      const untrustedResult = await Promise.race([tracked, deadline])
      const structuredContent = definition.outputSchema.parse(untrustedResult) as Record<string, unknown>
      safeLog(options.logger, {
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
    } catch (error) {
      if (transportTermination && !(error instanceof PersonalFeedInputError) && !(error instanceof PersonalFeedStorageError)) {
        options.terminateRequest?.(extra.requestId)
      }
      safeLog(options.logger, {
        operation,
        requestId,
        result: 'error',
        resultCategory: abort.signal.aborted ? 'cancelled_or_timeout' : 'handler_error',
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      })
      const fallback = !(error instanceof PersonalFeedInputError) && !(error instanceof PersonalFeedStorageError)
        ? incompleteFallback(operation, timedOut ? 'interaction_timeout' : extra.signal.aborted ? 'interaction_cancelled' : undefined)
        : undefined
      if (fallback !== undefined) return {
        content: [{ type: 'text' as const, text: humanText(operation, 'incomplete', fallback) }],
        structuredContent: fallback,
      }
      return {
        isError: true,
        content: [{ type: 'text' as const, text: 'Personal Feed 本次调用未完成。' }],
      }
    } finally {
      clearTimeout(timeout)
      extra.signal.removeEventListener('abort', onClientAbort)
      options.releaseRequest?.(extra.requestId)
    }
  })
}

function safeLog(logger: SafeLogger | undefined, event: Parameters<SafeLogger>[0]): void {
  try { logger?.(event) } catch { /* Diagnostics cannot change tool results. */ }
}

function checkReason(output: { status: string; stage?: string | undefined; reason?: string | undefined }, context: z.RefinementCtx): void {
  if (output.reason === undefined) return
  const allowed = output.reason.startsWith('interaction_')
    ? ['context_observation', 'personal_context', 'feedback_interpretation', 'shutdown'].includes(output.stage ?? '')
    : output.reason === 'exploration_not_ready' ? output.stage === 'judgement_execution' : output.stage === 'source_window'
  if (output.status !== 'incomplete' || !allowed) context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid reason for stage', path: ['reason'] })
}

function incompleteFallback(
  operation: typeof PERSONAL_FEED_TOOL_NAMES[number],
  reason?: 'interaction_cancelled' | 'interaction_timeout',
): Record<string, unknown> | undefined {
  const stage = operation === 'request' ? 'shutdown'
    : operation === 'observe_context' ? 'context_observation'
      : operation === 'process_feedback' ? 'feedback_interpretation' : undefined
  return stage === undefined ? undefined : Object.freeze({
    status: 'incomplete',
    stage,
    ...(reason === undefined ? {} : { reason }),
  })
}

function humanText(operation: string, status: string, output: Record<string, unknown>): string {
  return [resultText(operation, status, output), typeof output.question === 'string' ? output.question : ''].filter(Boolean).join('\n')
}

const INCOMPLETE_STAGE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  context_observation: 'Personal Feed 对本次信息的理解未完成。',
  personal_context: 'Personal Feed 的个人信息准备未完成。',
  source_window: 'Personal Feed 的来源观察未完成。',
  judgement_execution: 'Personal Feed 对内容是否符合条件的判断未完成。',
  conflict: 'Personal Feed 的信息状态发生冲突，本次处理未完成。',
  shutdown: 'Personal Feed 本次请求已中止，处理未完成。',
  feedback_interpretation: 'Personal Feed 对本次反馈的理解未完成。',
  feedback_commit: 'Personal Feed 对本次反馈的保存未完成。',
})

function resultText(operation: string, status: string, output: Record<string, unknown>): string {
  if (status === 'business_empty') return '暂时没有符合条件的 Personal Feed 内容。'
  if (status === 'needs_input') return ''
  if (status === 'one_link') {
    const limitationText = Array.isArray(output.limitations) ? output.limitations.map(item => ({
      partial_observation: '部分来源未完成观察',
      material_insufficient: '部分正文不足',
      judgement_incomplete: '部分内容判断未完成',
    })[String(item)]).filter((item): item is string => item !== undefined).join('；') : ''
    return `Personal Feed 已选出一条内容：${String(output.url)}${limitationText === '' ? '' : `\n限制：${limitationText}。`}`
  }
  if (status === 'incomplete' && output.stage === 'source_window') {
    if (output.reason === 'observation_failed') return 'Personal Feed 获取来源失败，本次未完成。'
    if (output.reason === 'partial_observation') return 'Personal Feed 仅完成部分来源观察，本次未完成。'
    if (output.reason === 'material_insufficient') return 'Personal Feed 来源正文不足，无法完成判断。'
  }
  if (status === 'incomplete' && output.reason === 'exploration_not_ready') {
    return '当前候选未找到推荐，后续陌生方向探索尚未就绪。'
  }
  if (status === 'incomplete' && output.reason === 'interaction_unavailable') return '当前客户端无法完成表单问答，本次处理未完成。'
  if (status === 'incomplete' && output.reason === 'interaction_declined') return '本次表单未取得回答，处理未完成。'
  if (status === 'incomplete' && output.reason === 'interaction_cancelled') return '本次处理已取消，未完成。'
  if (status === 'incomplete' && output.reason === 'interaction_timeout') return '本次处理已超时，未完成。'
  if (status === 'incomplete') return INCOMPLETE_STAGE_TEXT[String(output.stage)] ?? 'Personal Feed 本次处理未完成。'
  if (operation === 'list_saved') return `已返回 ${Array.isArray(output.items) ? output.items.length : 0} 条收藏。`
  return `Personal Feed 结果：${status}。`
}
