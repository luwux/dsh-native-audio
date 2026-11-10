import { createHash } from 'node:crypto'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  LlmError,
  offloadedImageText,
  type AssistantMessage,
  type ContentBlock,
  type GenerateOptions,
  type ModelMessageSource,
  type ReplayEnvelope,
  type ToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type { AudioAttachmentStore } from '../service.js'
import type { AudioAttachmentRef } from '../types.js'
import {
  geminiFileName,
  geminiFileUri,
  type GeminiAudioUpload,
} from './files.js'

/** Gemini's documented maximum total inline request size: 20 MB. */
export const GEMINI_INLINE_REQUEST_MAX_BYTES = 20_000_000

export interface GeminiInlineData {
  mimeType: 'audio/wav' | 'image/png' | 'image/jpeg' | 'image/webp'
  data: string
}

export interface GeminiFileData {
  mimeType: 'audio/wav'
  fileUri: string
}

export interface GeminiFunctionCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface GeminiFunctionResponse {
  id: string
  name: string
  response: Record<string, unknown>
}

export type GeminiPart = {
  text: string
  thought?: boolean
  thoughtSignature?: string
  partMetadata?: Record<string, unknown>
} | {
  inlineData: GeminiInlineData
} | {
  fileData: GeminiFileData
} | {
  functionCall: GeminiFunctionCall
  thought?: boolean
  thoughtSignature?: string
  partMetadata?: Record<string, unknown>
} | {
  functionResponse: GeminiFunctionResponse
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description: string
      parametersJsonSchema: Record<string, unknown>
    }>
  }>
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
    stopSequences?: string[]
    thinkingConfig?: { thinkingLevel?: GeminiThinkingLevel; includeThoughts?: true }
  }
}

/** One durable AudioBlock occurrence and its exact inline wire coordinate. */
export interface GeminiAudioReceipt {
  occurrence: number
  /** Index of the user or tool-result message in `GenerateOptions.messages`. */
  messageIndex: number
  /** Index of the AudioBlock inside that message's content. */
  blockIndex: number
  contentIndex: number
  partIndex: number
  attachmentId: string
  mediaType: 'audio/wav'
  sourceBytes: number
  transport: 'inline' | 'files'
  inlineBase64Bytes?: number
  providerFileName?: string
  providerFileUri?: string
  sha256: string
}

export interface SerializedGeminiRequest {
  body: GeminiGenerateContentRequest
  bodyText: string
  utf8Bytes: number
  audioReceipts: GeminiAudioReceipt[]
  audioUploads: GeminiAudioUpload[]
}

export type GeminiAudioTransport = {
  kind: 'inline'
} | {
  kind: 'files'
  baseUrl: string
  credentialNamespace: string
}

export type GeminiReplayBlock = {
  type: 'text' | 'reasoning' | 'tool-call'
  nativeContentIndex: number
  nativePartIndex: number
  thought?: boolean
  thoughtSignature?: string
  partMetadata?: Record<string, unknown>
}

export interface GeminiReplayResponse {
  kind: 'gemini-generate-content'
  version: 1
  provider: string
  model: string
  finishReason: 'STOP' | 'MAX_TOKENS'
  responseId?: string
  modelVersion?: string
}

interface GeminiReplayState {
  response: GeminiReplayResponse
  blocks: GeminiReplayBlock[]
}

type AudioReader = Pick<AudioAttachmentStore, 'readAudio'>
type ImageReader = Pick<AttachmentStore, 'readImage'>

function invalidRequest(message: string, cause?: unknown): never {
  throw new LlmError(`Gemini request is invalid: ${message}`, 'INVALID_REQUEST',
    cause === undefined ? undefined : { cause })
}

function unsupported(message: string): never {
  throw new LlmError(`Gemini cannot represent ${message}`, 'UNSUPPORTED_CONTENT')
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid Gemini replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return invalidReplay(`${context} ${key} must be a string`)
  return value
}

function optionalBoolean(
  object: Record<string, unknown>,
  key: string,
  context: string,
): boolean | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') return invalidReplay(`${context} ${key} must be a boolean`)
  return value
}

function optionalObject(
  object: Record<string, unknown>,
  key: string,
  context: string,
): Record<string, unknown> | undefined {
  const value = object[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) return invalidReplay(`${context} ${key} must be an object`)
  return value
}

function safeIndex(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidReplay(`${context} must be a non-negative safe integer`)
  }
  return value as number
}

/** Validate adapter-private metadata before it can affect a later provider request. */
export function readGeminiReplayState(value: unknown): GeminiReplayState {
  if (!isRecord(value)) return invalidReplay('expected a replay envelope')
  const rawResponse = value['response']
  if (!isRecord(rawResponse)) return invalidReplay('expected a response object')
  if (rawResponse['kind'] !== 'gemini-generate-content') return invalidReplay('unknown state kind')
  if (rawResponse['version'] !== 1) {
    return invalidReplay(`unsupported version ${String(rawResponse['version'])}`)
  }
  for (const key of ['provider', 'model'] as const) {
    if (typeof rawResponse[key] !== 'string' || rawResponse[key].length === 0) {
      return invalidReplay(`${key} must be a non-empty string`)
    }
  }
  if (rawResponse['finishReason'] !== 'STOP' && rawResponse['finishReason'] !== 'MAX_TOKENS') {
    return invalidReplay('finishReason must be STOP or MAX_TOKENS')
  }
  const rawBlocks = value['blocks']
  if (!Array.isArray(rawBlocks)) return invalidReplay('blocks must be an array')
  const blocks = rawBlocks.map((rawBlock, index): GeminiReplayBlock => {
    if (!isRecord(rawBlock)) return invalidReplay(`block ${index} must be an object`)
    const type = rawBlock['type']
    if (type !== 'text' && type !== 'reasoning' && type !== 'tool-call') {
      return invalidReplay(`block ${index} has an unknown type`)
    }
    const thought = optionalBoolean(rawBlock, 'thought', `block ${index}`)
    if (type === 'reasoning' && thought !== true) {
      return invalidReplay(`block ${index} reasoning metadata must set thought=true`)
    }
    if (type === 'text' && thought === true) {
      return invalidReplay(`block ${index} text metadata cannot set thought=true`)
    }
    const thoughtSignature = optionalString(rawBlock, 'thoughtSignature', `block ${index}`)
    const partMetadata = optionalObject(rawBlock, 'partMetadata', `block ${index}`)
    return {
      type,
      nativeContentIndex: safeIndex(rawBlock['nativeContentIndex'], `block ${index} nativeContentIndex`),
      nativePartIndex: safeIndex(rawBlock['nativePartIndex'], `block ${index} nativePartIndex`),
      ...(thought === undefined ? {} : { thought }),
      ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
      ...(partMetadata === undefined ? {} : { partMetadata }),
    }
  })
  return {
    response: {
      kind: 'gemini-generate-content',
      version: 1,
      provider: rawResponse['provider'] as string,
      model: rawResponse['model'] as string,
      finishReason: rawResponse['finishReason'],
      ...optionalString(rawResponse, 'responseId', 'response') === undefined
        ? {}
        : { responseId: rawResponse['responseId'] as string },
      ...optionalString(rawResponse, 'modelVersion', 'response') === undefined
        ? {}
        : { modelVersion: rawResponse['modelVersion'] as string },
    },
    blocks,
  }
}

function parseToolArguments(raw: string, context: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    return invalidRequest(`${context} arguments are not valid JSON`, error)
  }
  if (!isRecord(value)) return invalidRequest(`${context} arguments must be a JSON object`)
  return value
}

function nativePart(
  block: ContentBlock,
  replay: GeminiReplayBlock,
  index: number,
): GeminiPart {
  if (replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`)
  const metadata = {
    ...(replay.thought === undefined ? {} : { thought: replay.thought }),
    ...(replay.thoughtSignature === undefined ? {} : { thoughtSignature: replay.thoughtSignature }),
    ...(replay.partMetadata === undefined ? {} : { partMetadata: replay.partMetadata }),
  }
  switch (block.type) {
    case 'text': return { text: block.text, ...metadata }
    case 'reasoning': return { text: block.text, ...metadata }
    case 'tool-call': return {
      functionCall: {
        id: String(block.id),
        name: block.name,
        args: parseToolArguments(block.arguments, `assistant tool call ${String(block.id)}`),
      },
      ...metadata,
    }
    default: return invalidReplay(`block ${index} has an unsupported Harness type`)
  }
}

function replayAssistant(message: AssistantMessage, source: ModelMessageSource): GeminiContent[] {
  if (source.replayState === undefined) return invalidReplay('same-provider assistant is missing metadata')
  const state = readGeminiReplayState(source.replayState)
  if (state.response.provider !== source.provider) return invalidReplay('provider does not match assistant source')
  if (state.response.model !== source.model) return invalidReplay('model does not match assistant source')
  if (state.blocks.length !== message.content.length) {
    return invalidReplay('block count does not match assistant content')
  }
  const contents: GeminiContent[] = []
  let lastNativeContentIndex: number | undefined
  let lastNativePartIndex: number | undefined
  for (const [index, block] of message.content.entries()) {
    const replay = state.blocks[index]
    if (replay === undefined) return invalidReplay(`block ${index} metadata is missing`)
    if (lastNativeContentIndex !== undefined && replay.nativeContentIndex < lastNativeContentIndex) {
      return invalidReplay(`block ${index} native content order regressed`)
    }
    if (replay.nativeContentIndex !== lastNativeContentIndex) {
      contents.push({ role: 'model', parts: [] })
      lastNativeContentIndex = replay.nativeContentIndex
      lastNativePartIndex = undefined
    }
    if (lastNativePartIndex !== undefined && replay.nativePartIndex <= lastNativePartIndex) {
      return invalidReplay(`block ${index} native part order did not advance`)
    }
    lastNativePartIndex = replay.nativePartIndex
    const content = contents.at(-1)
    if (content === undefined) return invalidReplay(`block ${index} has no native content group`)
    content.parts.push(nativePart(block, replay, index))
  }
  return contents
}

function foreignAssistant(message: AssistantMessage): GeminiContent {
  const parts: GeminiPart[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      return unsupported(`foreign assistant block type "${String(block.type)}"`)
    }
    parts.push({ text: block.text })
  }
  if (parts.length === 0) return unsupported('an empty assistant message')
  return { role: 'model', parts }
}

function rememberToolCalls(message: AssistantMessage, names: Map<string, string>): void {
  for (const block of message.content) {
    if (block.type !== 'tool-call') continue
    const id = String(block.id)
    if (id.length === 0 || block.name.length === 0) invalidRequest('assistant tool calls need non-empty ids and names')
    const previous = names.get(id)
    if (previous !== undefined && previous !== block.name) {
      invalidRequest(`tool call id "${id}" names both "${previous}" and "${block.name}"`)
    }
    names.set(id, block.name)
  }
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'audio' || block.type === 'image') continue
    if (block.type !== 'text') return unsupported(`tool-result block type "${String(block.type)}"`)
    text += block.text
  }
  return text || '(no output)'
}

function toolResultPart(
  message: ToolResultMessage,
  names: ReadonlyMap<string, string>,
): GeminiPart {
  const id = String(message.toolCallId)
  if (message.source.kind !== 'tool' || String(message.source.callId) !== id) {
    return invalidRequest(`tool result ${id} does not match its message source`)
  }
  const name = names.get(id)
  if (name === undefined) return invalidRequest(`tool result ${id} has no preceding function call`)
  const output = toolResultText(message.content)
  return {
    functionResponse: {
      id,
      name,
      response: message.isError === true ? { error: output } : { output },
    },
  }
}

function assertStoredAudio(
  requested: AudioAttachmentRef,
  stored: Awaited<ReturnType<AudioReader['readAudio']>>,
): void {
  if (String(stored.ref.attachmentId) !== String(requested.attachmentId)
    || stored.ref.mediaType !== requested.mediaType
    || stored.ref.bytes !== requested.bytes
    || stored.data.byteLength !== requested.bytes) {
    invalidRequest(`audio attachment ${String(requested.attachmentId)} did not read back exactly`)
  }
}

function assertAudioReference(value: unknown): asserts value is AudioAttachmentRef {
  if (!isRecord(value)
    || typeof value['attachmentId'] !== 'string'
    || value['attachmentId'].length === 0
    || value['mediaType'] !== 'audio/wav'
    || !Number.isSafeInteger(value['bytes'])
    || (value['bytes'] as number) < 0) {
    invalidRequest('audio block has an invalid durable attachment reference')
  }
}

/** Request-wide state shared by every materialized part. */
interface PartContext {
  audio: AudioReader
  images: ImageReader | undefined
  signal: AbortSignal | undefined
  receipts: GeminiAudioReceipt[]
  uploads: Map<string, GeminiAudioUpload>
  transport: GeminiAudioTransport
}

async function materializeAudioPart(
  refValue: unknown,
  coordinate: Pick<GeminiAudioReceipt, 'messageIndex' | 'blockIndex' | 'contentIndex' | 'partIndex'>,
  context: PartContext,
): Promise<GeminiPart> {
  const { audio, signal, receipts, uploads, transport } = context
  if (isRecord(refValue) && refValue['mediaType'] !== 'audio/wav') {
    return unsupported(`audio MIME type "${String(refValue['mediaType'])}"`)
  }
  assertAudioReference(refValue)
  const stored = await audio.readAudio(refValue, signal)
  signal?.throwIfAborted()
  assertStoredAudio(refValue, stored)
  const source = Buffer.from(stored.data)
  const sha256 = createHash('sha256').update(source).digest('hex')
  let part: GeminiPart
  let transportReceipt: Pick<
    GeminiAudioReceipt,
    'transport' | 'inlineBase64Bytes' | 'providerFileName' | 'providerFileUri'
  >
  if (transport.kind === 'inline') {
    const data = source.toString('base64')
    const decoded = Buffer.from(data, 'base64')
    if (!source.equals(decoded)) invalidRequest(`inline encoding changed audio ${String(refValue.attachmentId)}`)
    part = { inlineData: { mimeType: 'audio/wav', data } }
    transportReceipt = { transport: 'inline', inlineBase64Bytes: Buffer.byteLength(data, 'ascii') }
  } else {
    const fileName = geminiFileName(sha256, transport.credentialNamespace)
    const fileUri = geminiFileUri(transport.baseUrl, fileName)
    part = { fileData: { mimeType: 'audio/wav', fileUri } }
    if (!uploads.has(fileName)) {
      uploads.set(fileName, {
        attachment: refValue,
        data: stored.data,
        fileName,
        fileUri,
        sha256,
      })
    }
    transportReceipt = { transport: 'files', providerFileName: fileName, providerFileUri: fileUri }
  }
  receipts.push({
    occurrence: receipts.length,
    ...coordinate,
    attachmentId: String(refValue.attachmentId),
    mediaType: 'audio/wav',
    sourceBytes: source.byteLength,
    ...transportReceipt,
    sha256,
  })
  return part
}

async function materializeImagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  context: PartContext,
): Promise<GeminiPart> {
  // Offload is a durable Session decision; every route sends the same placeholder text.
  if (block.offloaded === true) return { text: offloadedImageText(block.attachment) }
  const { images, signal } = context
  if (images === undefined) return unsupported('images without an attachment store')
  const stored = await images.readImage(block.attachment, signal)
  signal?.throwIfAborted()
  const mimeType = stored.ref.mediaType
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
    return unsupported(`image media type ${mimeType}; use PNG, JPEG, or WebP`)
  }
  return { inlineData: { mimeType, data: Buffer.from(stored.data).toString('base64') } }
}

/**
 * Gemini answers a function call with one user content whose first part is the
 * `functionResponse`; image and audio results follow as sibling parts so the
 * model receives the media natively in the same turn.
 */
async function toolResultParts(
  message: ToolResultMessage,
  names: ReadonlyMap<string, string>,
  messageIndex: number,
  contentIndex: number,
  context: PartContext,
): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [toolResultPart(message, names)]
  for (const [blockIndex, block] of message.content.entries()) {
    context.signal?.throwIfAborted()
    if (block.type === 'image') {
      parts.push(await materializeImagePart(block, context))
      continue
    }
    if (block.type !== 'audio') continue
    parts.push(await materializeAudioPart(
      block.attachment,
      { messageIndex, blockIndex, contentIndex, partIndex: parts.length },
      context,
    ))
  }
  return parts
}

async function userParts(
  content: readonly ContentBlock[],
  messageIndex: number,
  contentIndex: number,
  context: PartContext,
): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = []
  for (const [blockIndex, block] of content.entries()) {
    context.signal?.throwIfAborted()
    switch (block.type) {
      case 'text':
        parts.push({ text: block.text })
        break
      case 'image':
        parts.push(await materializeImagePart(block, context))
        break
      case 'audio':
        parts.push(await materializeAudioPart(
          block.attachment,
          { messageIndex, blockIndex, contentIndex, partIndex: parts.length },
          context,
        ))
        break
      default:
        return unsupported(`user block type "${String(block.type)}"`)
    }
  }
  if (parts.length === 0) return unsupported('an empty user message')
  return parts
}

function systemText(content: readonly ContentBlock[]): string {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return unsupported(`system block type "${String(block.type)}"`)
    text += block.text
  }
  return text
}

/** Gemini `thinkingLevel` values accepted as DSH reasoning effort ids. */
export const GEMINI_THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high'] as const)
export type GeminiThinkingLevel = typeof GEMINI_THINKING_LEVELS[number]

/** Whether one opaque reasoning effort id names a Gemini thinking level. */
export function isGeminiThinkingLevel(value: string): value is GeminiThinkingLevel {
  return (GEMINI_THINKING_LEVELS as readonly string[]).includes(value)
}

/** Request options owned by the Gemini route rather than by `GenerateOptions`. */
export interface GeminiWireOptions {
  /** Ask Gemini for thought summaries, which stream as Harness reasoning blocks. */
  includeThoughts?: boolean
}

function generationConfig(
  options: GenerateOptions,
  wire: GeminiWireOptions,
): GeminiGenerateContentRequest['generationConfig'] {
  const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  if (effort !== undefined && !isGeminiThinkingLevel(effort)) {
    throw new LlmError(
      `Gemini reasoning effort "${effort}" is not a Gemini thinking level`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  const thinking = {
    ...(effort === undefined ? {} : { thinkingLevel: effort }),
    ...(wire.includeThoughts === true ? { includeThoughts: true as const } : {}),
  }
  const config: NonNullable<GeminiGenerateContentRequest['generationConfig']> = {
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stopSequences: [...options.stop] }),
    ...(Object.keys(thinking).length === 0 ? {} : { thinkingConfig: thinking }),
  }
  return Object.keys(config).length === 0 ? undefined : config
}

/**
 * Materialize the exact JSON body used by the direct REST adapter.
 * Audio is dereferenced once per occurrence; no attachment-id deduplication is
 * allowed because receipts and wire positions are occurrence based.
 *
 * `options.system` takes the system instruction when defined; otherwise a
 * leading system-role message supplies it. Any other system-role message
 * becomes user text in place, matching the DSH pi-ai route. Developer
 * messages never reach this route because it declares no tool-update mode.
 */
export async function serializeGeminiRequest(
  options: GenerateOptions,
  audio: AudioReader,
  maxRequestBytes = GEMINI_INLINE_REQUEST_MAX_BYTES,
  transport: GeminiAudioTransport = { kind: 'inline' },
  images?: ImageReader,
  wire: GeminiWireOptions = {},
): Promise<SerializedGeminiRequest> {
  options.signal?.throwIfAborted()
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    invalidRequest('maxRequestBytes must be a positive safe integer')
  }
  const contents: GeminiContent[] = []
  const audioUploads = new Map<string, GeminiAudioUpload>()
  const context: PartContext = {
    audio,
    images,
    signal: options.signal,
    receipts: [],
    uploads: audioUploads,
    transport,
  }
  const toolNames = new Map<string, string>()
  let system = options.system
  for (const [messageIndex, message] of options.messages.entries()) {
    options.signal?.throwIfAborted()
    switch (message.role) {
      case 'system': {
        const text = systemText(message.content)
        if (messageIndex === 0 && options.system === undefined) {
          system = text.length === 0 ? undefined : text
        } else if (text.length > 0) {
          contents.push({ role: 'user', parts: [{ text }] })
        }
        break
      }
      case 'assistant':
        if (message.source.kind === 'model' && message.source.provider === options.provider) {
          contents.push(...replayAssistant(message, message.source))
        } else {
          contents.push(foreignAssistant(message))
        }
        rememberToolCalls(message, toolNames)
        break
      case 'tool': {
        const contentIndex = contents.length
        contents.push({
          role: 'user',
          parts: await toolResultParts(message, toolNames, messageIndex, contentIndex, context),
        })
        break
      }
      case 'user': {
        const contentIndex = contents.length
        contents.push({
          role: 'user',
          parts: await userParts(message.content, messageIndex, contentIndex, context),
        })
        break
      }
      default:
        return unsupported(`history role "${String(message.role)}"`)
    }
  }
  if (contents.length === 0) invalidRequest('contents must not be empty')
  const tools = options.tools === undefined || options.tools.length === 0
    ? undefined
    : [{
        functionDeclarations: options.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      }]
  const config = generationConfig(options, wire)
  const body: GeminiGenerateContentRequest = {
    contents,
    ...(system === undefined ? {} : { systemInstruction: { parts: [{ text: system }] } }),
    ...(tools === undefined ? {} : { tools }),
    ...(config === undefined ? {} : { generationConfig: config }),
  }
  let bodyText: string
  try {
    bodyText = JSON.stringify(body)
  } catch (error) {
    return invalidRequest('request fields are not lossless JSON', error)
  }
  const utf8Bytes = Buffer.byteLength(bodyText, 'utf8')
  if (utf8Bytes > maxRequestBytes) {
    throw new LlmError(
      `Gemini request is ${utf8Bytes} UTF-8 bytes, exceeding the ${maxRequestBytes}-byte limit`,
      'INVALID_REQUEST',
    )
  }
  return {
    body,
    bodyText,
    utf8Bytes,
    audioReceipts: context.receipts,
    audioUploads: [...audioUploads.values()],
  }
}

/** Helper used by response translation to build block-aligned replay state. */
export function geminiReplayEnvelope(
  response: GeminiReplayResponse,
  blocks: readonly GeminiReplayBlock[],
): ReplayEnvelope {
  return { response, blocks: [...blocks] }
}
