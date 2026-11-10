import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId,
  assertUsableApiKey,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmModelReasoningInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AudioAttachmentStore } from '../service.js'
import { GeminiFileCache, geminiCredentialNamespace } from './files.js'
import { parseSseJson } from './sse.js'
import {
  GEMINI_INLINE_REQUEST_MAX_BYTES,
  geminiReplayEnvelope,
  serializeGeminiRequest,
  type GeminiAudioReceipt,
  type GeminiAudioTransport,
  type GeminiFunctionCall,
  type GeminiGenerateContentRequest,
  type GeminiPart,
  type GeminiReplayBlock,
  type GeminiReplayResponse,
  type GeminiThinkingLevel,
} from './wire.js'

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
const PACKAGE_NAME = 'dsh-native-audio'

export interface GeminiCredential {
  apiKey: string
  /** Non-secret setting or credential-store coordinate used in diagnostics. */
  ref: string
}

export type GeminiCredentialResolver = (
  provider: string,
  signal?: AbortSignal,
) => GeminiCredential | Promise<GeminiCredential>

/** Required transport seam. The adapter deliberately has no implicit global fetch. */
export type GeminiFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface GeminiRequestCapture {
  url: string
  body: GeminiGenerateContentRequest
  bodyText: string
  utf8Bytes: number
  audioReceipts: readonly GeminiAudioReceipt[]
}

export interface GeminiAdvertisedModel {
  id: string
  name?: string
  description?: string
  /** Selectable Gemini `thinkingLevel` values in display order; empty or absent hides the effort selector. */
  thinkingLevels?: readonly GeminiThinkingLevel[]
  /** Level sent when the caller selects none; absent leaves Gemini's own default. */
  defaultThinkingLevel?: GeminiThinkingLevel
}

const THINKING_LEVEL_NAMES: Readonly<Record<GeminiThinkingLevel, string>> = Object.freeze({
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
})

function reasoningInfo(model: GeminiAdvertisedModel | undefined): LlmModelReasoningInfo | undefined {
  const levels = model?.thinkingLevels
  if (levels === undefined || levels.length === 0) return undefined
  return {
    efforts: levels.map(level => ({ id: ReasoningEffortId(level), name: THINKING_LEVEL_NAMES[level] })),
    ...(model?.defaultThinkingLevel === undefined
      ? {}
      : { defaultEffort: ReasoningEffortId(model.defaultThinkingLevel) }),
  }
}

export interface GeminiGenerateContentAdapterOptions {
  fetch: GeminiFetch
  resolveCredential: GeminiCredentialResolver
  audioAttachments: Pick<AudioAttachmentStore, 'readAudio'>
  imageAttachments?: Pick<AttachmentStore, 'readImage'>
  provider?: string
  providerName?: string
  baseUrl?: string
  maxInlineRequestBytes?: number
  audioTransport?: 'inline' | 'files'
  fileCache?: GeminiFileCache
  models?: readonly GeminiAdvertisedModel[]
  /** Request thought summaries so Gemini reasoning streams as Harness reasoning blocks. */
  includeThoughts?: boolean
  /** Secret-free final-wire observation, invoked before credential resolution and fetch. */
  captureRequest?: (capture: GeminiRequestCapture) => void | Promise<void>
}

interface ResponseState {
  candidateSeen: boolean
  blockSeen: boolean
  toolCallSeen: boolean
  finishReason?: string
  finishMessage?: string
  promptBlockReason?: string
  usage?: TokenUsage
  responseId?: string
  modelVersion?: string
}

type GeminiTextPart = Extract<GeminiPart, { text: string }>

interface PendingTextBlock {
  index: number
  nativePartIndex: number
  blockType: 'text' | 'reasoning'
  part: GeminiTextPart
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(message: string, cause?: unknown): never {
  throw new LlmError(`Gemini response is malformed: ${message}`, 'MALFORMED_RESPONSE',
    cause === undefined ? undefined : { cause })
}

function safeCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return malformed(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

/** Map cumulative Gemini usage to DSH's disjoint cache and reasoning fields. */
export function mapGeminiUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) return malformed('usageMetadata must be an object')
  const prompt = safeCount(value['promptTokenCount'], 'promptTokenCount') ?? 0
  const cached = safeCount(value['cachedContentTokenCount'], 'cachedContentTokenCount')
  const candidates = safeCount(value['candidatesTokenCount'], 'candidatesTokenCount') ?? 0
  const thoughts = safeCount(value['thoughtsTokenCount'], 'thoughtsTokenCount')
  if ((cached ?? 0) > prompt) return malformed('cachedContentTokenCount exceeds promptTokenCount')
  const output = candidates + (thoughts ?? 0)
  if (!Number.isSafeInteger(output)) return malformed('output token count is not a safe integer')
  return {
    inputTokens: prompt - (cached ?? 0),
    outputTokens: output,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(thoughts === undefined ? {} : { reasoningTokens: thoughts }),
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000
  const date = Date.parse(value)
  const delay = date - Date.now()
  return Number.isFinite(date) && delay > 0 ? delay : undefined
}

function providerCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status === 413) return 'INVALID_REQUEST'
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status >= 400 && status < 500) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return 'GEMINI_API_ERROR'
}

function requestId(response: Response): ReturnType<typeof ProviderRequestId> | undefined {
  const value = response.headers.get('x-goog-request-id') ?? response.headers.get('x-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

async function httpError(response: Response): Promise<LlmError> {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    // The status remains authoritative even when the error body cannot be read.
  }
  let message = raw.trim()
  let providerStatus = ''
  if (message !== '') {
    try {
      const parsed: unknown = JSON.parse(message)
      if (isRecord(parsed) && isRecord(parsed['error'])) {
        const error = parsed['error']
        if (typeof error['message'] === 'string') message = error['message']
        if (typeof error['status'] === 'string') providerStatus = error['status']
      }
    } catch {
      // A non-JSON provider body is still useful diagnostic text.
    }
  }
  if (message === '') message = `Gemini returned HTTP ${response.status}`
  const detail = `${providerStatus} ${message}`
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
  const id = requestId(response)
  return new LlmError(message, providerCode(response.status, detail), {
    status: response.status,
    ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
    ...(id === undefined ? {} : { requestId: id }),
  })
}

function inBandError(value: unknown): LlmError {
  if (!isRecord(value)) return new LlmError('Gemini returned an in-band error', 'GEMINI_API_ERROR')
  const status = safeCount(value['code'], 'error.code')
  const message = typeof value['message'] === 'string' && value['message'].length > 0
    ? value['message']
    : 'Gemini returned an in-band error'
  const detail = `${String(value['status'] ?? '')} ${message}`
  return new LlmError(message, providerCode(status ?? 500, detail),
    status === undefined || status < 100 || status > 599 ? undefined : { status })
}

function optionalResponseString(
  state: ResponseState,
  key: 'responseId' | 'modelVersion',
  value: unknown,
): void {
  if (value === undefined) return
  if (typeof value !== 'string') malformed(`${key} must be a string`)
  if (state[key] !== undefined && state[key] !== value) malformed(`${key} changed during one stream`)
  state[key] = value
}

function partMetadata(raw: Record<string, unknown>, context: string): {
  thought?: boolean
  thoughtSignature?: string
  partMetadata?: Record<string, unknown>
} {
  const thought = raw['thought']
  if (thought !== undefined && typeof thought !== 'boolean') malformed(`${context}.thought must be a boolean`)
  const signature = raw['thoughtSignature']
  if (signature !== undefined && typeof signature !== 'string') {
    malformed(`${context}.thoughtSignature must be a string`)
  }
  const metadata = raw['partMetadata']
  if (metadata !== undefined && !isRecord(metadata)) malformed(`${context}.partMetadata must be an object`)
  return {
    ...(thought === undefined ? {} : { thought }),
    ...(signature === undefined ? {} : { thoughtSignature: signature }),
    ...(metadata === undefined ? {} : { partMetadata: metadata }),
  }
}

function responseFunctionCall(value: unknown, context: string): GeminiFunctionCall {
  if (!isRecord(value)) return malformed(`${context}.functionCall must be an object`)
  const id = value['id']
  const name = value['name']
  const args = value['args']
  if (typeof id !== 'string' || id.length === 0) {
    return malformed(`${context}.functionCall.id must be a non-empty string`)
  }
  if (typeof name !== 'string' || name.length === 0) {
    return malformed(`${context}.functionCall.name must be a non-empty string`)
  }
  if (args !== undefined && !isRecord(args)) return malformed(`${context}.functionCall.args must be an object`)
  return { id, name, args: args ?? {} }
}

function responsePart(
  value: unknown,
  context: string,
): { part: GeminiPart; blockType: 'text' | 'reasoning' | 'tool-call'; call?: GeminiFunctionCall } {
  if (!isRecord(value)) return malformed(`${context} must be an object`)
  const allowed = new Set(['text', 'functionCall', 'thought', 'thoughtSignature', 'partMetadata'])
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) return malformed(`${context} contains unsupported field "${unknown}"`)
  const hasText = Object.hasOwn(value, 'text')
  const hasCall = Object.hasOwn(value, 'functionCall')
  if (Number(hasText) + Number(hasCall) !== 1) {
    return malformed(`${context} must contain exactly one supported data field`)
  }
  const metadata = partMetadata(value, context)
  if (hasText) {
    if (typeof value['text'] !== 'string') return malformed(`${context}.text must be a string`)
    return {
      part: { text: value['text'], ...metadata },
      blockType: metadata.thought === true ? 'reasoning' : 'text',
    }
  }
  const call = responseFunctionCall(value['functionCall'], context)
  return { part: { functionCall: call, ...metadata }, blockType: 'tool-call', call }
}

function sameOptionalMetadata(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined || JSON.stringify(left) === JSON.stringify(right)
}

function canContinueTextBlock(current: PendingTextBlock, next: GeminiTextPart, blockType: 'text' | 'reasoning'): boolean {
  return current.blockType === blockType
    && sameOptionalMetadata(current.part.thought, next.thought)
    && sameOptionalMetadata(current.part.thoughtSignature, next.thoughtSignature)
    && sameOptionalMetadata(current.part.partMetadata, next.partMetadata)
}

function appendTextPart(current: PendingTextBlock, next: GeminiTextPart): void {
  current.part = {
    text: current.part.text + next.text,
    ...(current.part.thought ?? next.thought) === undefined
      ? {}
      : { thought: current.part.thought ?? next.thought },
    ...(current.part.thoughtSignature ?? next.thoughtSignature) === undefined
      ? {}
      : { thoughtSignature: current.part.thoughtSignature ?? next.thoughtSignature },
    ...(current.part.partMetadata ?? next.partMetadata) === undefined
      ? {}
      : { partMetadata: current.part.partMetadata ?? next.partMetadata },
  }
}

function replayMetadata(
  type: GeminiReplayBlock['type'],
  contentIndex: number,
  nativePartIndex: number,
  part: GeminiPart,
): GeminiReplayBlock {
  if ('inlineData' in part || 'fileData' in part || 'functionResponse' in part) {
    return malformed('response replay received a request-only part')
  }
  return {
    type,
    nativeContentIndex: contentIndex,
    nativePartIndex,
    ...part.thought === undefined ? {} : { thought: part.thought },
    ...part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature },
    ...part.partMetadata === undefined ? {} : { partMetadata: part.partMetadata },
  }
}

function terminalReason(state: ResponseState, model: string): StreamChunk & { type: 'finish' } {
  const reason = state.finishReason
  if (reason === undefined) {
    if (!state.candidateSeen) {
      return {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: state.promptBlockReason === undefined
              ? `Gemini model "${model}" returned no candidate`
              : `Gemini blocked the prompt: ${state.promptBlockReason}`,
            code: state.promptBlockReason === undefined ? 'GEMINI_NO_CANDIDATE' : 'GEMINI_PROMPT_BLOCKED',
          },
        },
      }
    }
    throw new LlmError('Gemini SSE ended without a candidate finishReason', 'STREAM_CLOSED')
  }
  if (reason === 'STOP') {
    if (!state.blockSeen) {
      return {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `Gemini model "${model}" completed with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        },
      }
    }
    return { type: 'finish', reason: { kind: state.toolCallSeen ? 'tool-calls' : 'stop' } }
  }
  if (reason === 'MAX_TOKENS') return { type: 'finish', reason: { kind: 'max-tokens' } }
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: state.finishMessage === undefined
          ? `Gemini stopped generation: ${reason}`
          : `Gemini stopped generation: ${reason}: ${state.finishMessage}`,
        code: `GEMINI_${reason}`,
      },
    },
  }
}

function modelPath(model: string): string {
  if (model.length === 0 || model.trim() !== model || /[/?#]/.test(model)) {
    throw new LlmError(`Gemini model id "${model}" is not a valid path segment`, 'INVALID_REQUEST')
  }
  return encodeURIComponent(model)
}

/** Direct Gemini Developer API GenerateContent adapter with injected I/O seams. */
export class GeminiGenerateContentAdapter extends LlmAdapter {
  readonly provider: string
  private readonly providerName: string
  private readonly baseUrl: string
  private readonly maxInlineRequestBytes: number
  private readonly audioTransport: 'inline' | 'files'
  private readonly fileCache: GeminiFileCache
  private readonly models: readonly GeminiAdvertisedModel[]

  constructor(private readonly options: GeminiGenerateContentAdapterOptions) {
    super()
    this.provider = options.provider ?? 'google-gemini'
    this.providerName = options.providerName ?? 'Google Gemini'
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.maxInlineRequestBytes = options.maxInlineRequestBytes ?? GEMINI_INLINE_REQUEST_MAX_BYTES
    this.audioTransport = options.audioTransport ?? 'inline'
    this.fileCache = options.fileCache ?? new GeminiFileCache()
    this.models = options.models === undefined ? [] : [...options.models]
  }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider !== this.provider) {
      throw new LlmError(`Gemini adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return { id: provider, name: this.providerName }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    return this.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: this.options.imageAttachments === undefined
        ? ['text', 'audio'] as const : ['text', 'image', 'audio'] as const,
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    this.providerInfo(provider)
    modelPath(model)
    const advertised = this.models.find(candidate => candidate.id === model)
    const reasoning = reasoningInfo(advertised)
    return {
      provider,
      id: model,
      name: advertised?.name ?? model,
      ...(advertised?.description === undefined ? {} : { description: advertised.description }),
      inputModalities: this.options.imageAttachments === undefined
        ? ['text', 'audio'] : ['text', 'image', 'audio'],
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  /** An advertised model accepts only its configured levels; unlisted model ids accept any Gemini level. */
  private assertThinkingLevel(options: GenerateOptions): void {
    if (options.reasoningEffort === undefined) return
    const levels = this.models.find(candidate => candidate.id === options.model)?.thinkingLevels
    if (levels === undefined) return
    if (!(levels as readonly string[]).includes(String(options.reasoningEffort))) {
      throw new LlmError(
        `Gemini model "${options.model}" does not offer reasoning effort "${String(options.reasoningEffort)}"`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.providerInfo(options.provider)
    const model = modelPath(options.model)
    let apiKey: string | undefined
    let audioTransport: GeminiAudioTransport = { kind: 'inline' }
    if (this.audioTransport === 'files') {
      const credential = await this.options.resolveCredential(options.provider, options.signal)
      const ref = typeof credential.ref === 'string' && credential.ref.length > 0
        ? credential.ref
        : 'the configured Gemini credential'
      apiKey = assertUsableApiKey(credential.apiKey, PACKAGE_NAME, ref)
      audioTransport = {
        kind: 'files',
        baseUrl: this.baseUrl,
        credentialNamespace: geminiCredentialNamespace(apiKey),
      }
    }
    this.assertThinkingLevel(options)
    const serialized = await serializeGeminiRequest(
      options,
      this.options.audioAttachments,
      this.maxInlineRequestBytes,
      audioTransport,
      this.options.imageAttachments,
      { includeThoughts: this.options.includeThoughts === true },
    )
    const url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`
    await this.options.captureRequest?.({
      url,
      body: serialized.body,
      bodyText: serialized.bodyText,
      utf8Bytes: serialized.utf8Bytes,
      audioReceipts: serialized.audioReceipts,
    })
    options.signal?.throwIfAborted()
    if (apiKey === undefined) {
      const credential = await this.options.resolveCredential(options.provider, options.signal)
      const ref = typeof credential.ref === 'string' && credential.ref.length > 0
        ? credential.ref
        : 'the configured Gemini credential'
      apiKey = assertUsableApiKey(credential.apiKey, PACKAGE_NAME, ref)
    }
    if (this.audioTransport === 'files') {
      await this.fileCache.ensureAll(serialized.audioUploads, {
        fetch: this.options.fetch,
        baseUrl: this.baseUrl,
        apiKey,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    }
    let response: Response
    try {
      response = await this.options.fetch(url, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: serialized.bodyText,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      throw new LlmError('Gemini transport failed', 'TRANSPORT', { cause: error })
    }
    options.signal?.throwIfAborted()
    if (!response.ok) throw await httpError(response)
    if (response.body === null) throw new LlmError('Gemini response has no body', 'MALFORMED_RESPONSE')

    const state: ResponseState = { candidateSeen: false, blockSeen: false, toolCallSeen: false }
    const replayBlocks: GeminiReplayBlock[] = []
    const callIds = new Set<string>()
    let blockIndex = 0
    let nativePartIndex = 0
    let pendingText: PendingTextBlock | undefined
    for await (const event of parseSseJson(response.body, options.signal)) {
      if (!isRecord(event)) malformed('SSE JSON value must be an object')
      if (event['error'] !== undefined) throw inBandError(event['error'])
      optionalResponseString(state, 'responseId', event['responseId'])
      optionalResponseString(state, 'modelVersion', event['modelVersion'])
      if (event['usageMetadata'] !== undefined) state.usage = mapGeminiUsage(event['usageMetadata'])
      if (event['promptFeedback'] !== undefined) {
        if (!isRecord(event['promptFeedback'])) malformed('promptFeedback must be an object')
        const reason = event['promptFeedback']['blockReason']
        if (reason !== undefined && typeof reason !== 'string') malformed('promptFeedback.blockReason must be a string')
        if (typeof reason === 'string') state.promptBlockReason = reason
      }
      const candidates = event['candidates']
      if (candidates === undefined) continue
      if (!Array.isArray(candidates)) malformed('candidates must be an array')
      if (candidates.length > 1) {
        throw new LlmError('Gemini returned multiple candidates; this adapter supports candidate 0 only', 'UNSUPPORTED_RESPONSE')
      }
      const candidate = candidates[0]
      if (candidate === undefined) continue
      if (!isRecord(candidate)) malformed('candidate 0 must be an object')
      state.candidateSeen = true
      const candidateIndex = candidate['index']
      if (candidateIndex !== undefined && candidateIndex !== 0) malformed('candidate index must be 0')
      if (candidate['finishReason'] !== undefined) {
        if (typeof candidate['finishReason'] !== 'string') malformed('finishReason must be a string')
        if (state.finishReason !== undefined && state.finishReason !== candidate['finishReason']) {
          malformed('finishReason changed during one stream')
        }
        state.finishReason = candidate['finishReason']
      }
      if (candidate['finishMessage'] !== undefined) {
        if (typeof candidate['finishMessage'] !== 'string') malformed('finishMessage must be a string')
        state.finishMessage = candidate['finishMessage']
      }
      const content = candidate['content']
      if (content === undefined) continue
      if (!isRecord(content)) malformed('candidate content must be an object')
      if (content['role'] !== undefined && content['role'] !== 'model') {
        malformed(`candidate content role must be "model", got "${String(content['role'])}"`)
      }
      const parts = content['parts']
      if (!Array.isArray(parts)) malformed('candidate content.parts must be an array')
      for (const [eventPartIndex, rawPart] of parts.entries()) {
        const translated = responsePart(rawPart, `candidate part ${eventPartIndex}`)
        if (translated.blockType === 'text' || translated.blockType === 'reasoning') {
          if (!('text' in translated.part)) malformed('translated text part lost text')
          if (eventPartIndex === 0
            && pendingText !== undefined
            && canContinueTextBlock(pendingText, translated.part, translated.blockType)) {
            appendTextPart(pendingText, translated.part)
            yield translated.blockType === 'text'
              ? { type: 'text-delta', index: pendingText.index, text: translated.part.text }
              : { type: 'reasoning-delta', index: pendingText.index, text: translated.part.text }
            continue
          }
          if (pendingText !== undefined) {
            replayBlocks.push(replayMetadata(
              pendingText.blockType,
              0,
              pendingText.nativePartIndex,
              pendingText.part,
            ))
            yield {
              type: 'block-end',
              index: pendingText.index,
              block: { type: pendingText.blockType, text: pendingText.part.text },
            }
          }
          const currentIndex = blockIndex
          blockIndex += 1
          pendingText = {
            index: currentIndex,
            nativePartIndex,
            blockType: translated.blockType,
            part: translated.part,
          }
          nativePartIndex += 1
          state.blockSeen = true
          yield { type: 'block-start', index: currentIndex, blockType: translated.blockType }
          yield translated.blockType === 'text'
            ? { type: 'text-delta', index: currentIndex, text: translated.part.text }
            : { type: 'reasoning-delta', index: currentIndex, text: translated.part.text }
          continue
        }
        if (pendingText !== undefined) {
          replayBlocks.push(replayMetadata(
            pendingText.blockType,
            0,
            pendingText.nativePartIndex,
            pendingText.part,
          ))
          yield {
            type: 'block-end',
            index: pendingText.index,
            block: { type: pendingText.blockType, text: pendingText.part.text },
          }
          pendingText = undefined
        }
        const currentIndex = blockIndex
        blockIndex += 1
        state.blockSeen = true
        replayBlocks.push(replayMetadata(
          translated.blockType,
          0,
          nativePartIndex,
          translated.part,
        ))
        nativePartIndex += 1
        yield { type: 'block-start', index: currentIndex, blockType: translated.blockType }
        const call = translated.call
        if (call === undefined) malformed('translated tool-call part lost its functionCall')
        if (callIds.has(call.id)) malformed(`duplicate functionCall id "${call.id}"`)
        callIds.add(call.id)
        state.toolCallSeen = true
        const argumentsText = JSON.stringify(call.args)
        yield {
          type: 'tool-call-delta',
          index: currentIndex,
          id: ToolCallId(call.id),
          name: call.name,
          argumentsDelta: argumentsText,
        }
        yield {
          type: 'block-end',
          index: currentIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(call.id),
            name: call.name,
            arguments: argumentsText,
          },
        }
      }
    }

    if (pendingText !== undefined) {
      replayBlocks.push(replayMetadata(
        pendingText.blockType,
        0,
        pendingText.nativePartIndex,
        pendingText.part,
      ))
      yield {
        type: 'block-end',
        index: pendingText.index,
        block: { type: pendingText.blockType, text: pendingText.part.text },
      }
    }

    if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
    const finish = terminalReason(state, options.model)
    if (finish.reason.kind === 'stop'
      || finish.reason.kind === 'tool-calls'
      || finish.reason.kind === 'max-tokens') {
      const responseReplay: GeminiReplayResponse = {
        kind: 'gemini-generate-content',
        version: 1,
        provider: options.provider,
        model: options.model,
        finishReason: state.finishReason as 'STOP' | 'MAX_TOKENS',
        ...(state.responseId === undefined ? {} : { responseId: state.responseId }),
        ...(state.modelVersion === undefined ? {} : { modelVersion: state.modelVersion }),
      }
      yield { ...finish, replayState: geminiReplayEnvelope(responseReplay, replayBlocks) }
      return
    }
    yield finish
  }
}

export default GeminiGenerateContentAdapter
