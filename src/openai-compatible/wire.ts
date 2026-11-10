import { randomUUID } from 'node:crypto'
import { LlmError, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AudioAttachmentStore } from '../service.js'

const MARKER_PREFIX = '\uE000dsh-native-audio:'
const MARKER_SUFFIX = '\uE001'
const MARKER_PATTERN = /\uE000dsh-native-audio:([0-9a-f-]+):(\d+)\uE001/gu

/**
 * Where a Chat Completions route puts AudioBlock from tool result messages.
 * `user-message` keeps tool messages text-only and repeats the audio in one
 * user message after the run of tool messages; `tool-message` sends
 * `input_audio` parts inside the tool message itself.
 */
export type ToolResultAudioPlacement = 'user-message' | 'tool-message'

export const DEFAULT_TOOL_RESULT_AUDIO: ToolResultAudioPlacement = 'user-message'

/**
 * Text that replaces each tool-result audio position under `user-message`
 * placement, on a new line when the preceding tool text does not end in
 * whitespace.
 */
export const TOOL_RESULT_AUDIO_NOTE = '[audio attached in the next user message]'

/** Label that introduces one tool call's audio in the follow-up user message. */
export function toolResultAudioLabel(toolCallId: string): string {
  return `Audio returned by tool call ${toolCallId}:`
}

interface MaterializedAudio {
  marker: string
  occurrence: number
  messageIndex: number
  blockIndex: number
  sourceRole: 'user' | 'tool'
  attachmentId: string
  sourceBytes: number
  data: string
}

interface PreparedRequest {
  entries: MaterializedAudio[]
  toolResultAudio: ToolResultAudioPlacement
}

export interface OpenAICompatibleAudioReceipt {
  occurrence: number
  messageIndex: number
  blockIndex: number
  /** DSH message role that held the AudioBlock. */
  sourceRole: 'user' | 'tool'
  /**
   * Wire location: inside user content, inside the tool message, or inside
   * the user message inserted after a run of tool messages.
   */
  placement: 'user-content' | 'tool-message' | 'tool-followup'
  wireMessageIndex: number
  contentPartIndex: number
  attachmentId: string
  mediaType: 'audio/wav'
  sourceBytes: number
  inlineBase64Bytes: number
}

export interface PreparedOpenAICompatibleAudio {
  options: GenerateOptions
  release(): void
}

export interface PatchedOpenAICompatiblePayload {
  payload: unknown
  audioReceipts: OpenAICompatibleAudioReceipt[]
}

export interface OpenAICompatibleAudioPrepareOptions {
  /** Placement for tool result audio in this request; defaults to `user-message`. */
  toolResultAudio?: ToolResultAudioPlacement
}

type Segment = { kind: 'text'; text: string } | { kind: 'audio'; entry: MaterializedAudio }

function invalid(message: string): never {
  // DSH's pi-ai error classifier maps errors thrown from onPayload by message text;
  // "invalid request" keeps the INVALID_REQUEST code on that path.
  throw new LlmError(`OpenAI-compatible audio payload is an invalid request: ${message}`, 'INVALID_REQUEST')
}

function unsupported(message: string): never {
  throw new LlmError(`OpenAI-compatible audio payload cannot represent ${message}`, 'UNSUPPORTED_CONTENT')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextPart(value: unknown): value is Record<string, unknown> & { type: 'text'; text: string } {
  return isRecord(value) && value['type'] === 'text' && typeof value['text'] === 'string'
}

function markerOf(requestId: string, occurrence: number): string {
  return `${MARKER_PREFIX}${requestId}:${occurrence}${MARKER_SUFFIX}`
}

function audioPart(entry: MaterializedAudio): Record<string, unknown> {
  return { type: 'input_audio', input_audio: { data: entry.data, format: 'wav' } }
}

/**
 * Bridge DSH AudioBlock through pi-ai's text/image-only Context and replace it
 * at pi-ai's documented final-payload hook. All HTTP, SSE, tool, reasoning,
 * usage, retry, and error behavior stays owned by the stock pi-ai adapter.
 *
 * User audio becomes `input_audio` in place. Tool result audio follows the
 * request's {@link ToolResultAudioPlacement}. Both projections depend only on
 * the history, so the same history serializes to the same wire messages in
 * every request.
 */
export class OpenAICompatibleAudioPayloadBridge {
  private readonly requests = new Map<string, PreparedRequest>()

  async prepare(
    options: GenerateOptions,
    audioAttachments: Pick<AudioAttachmentStore, 'readAudio'>,
    prepareOptions: OpenAICompatibleAudioPrepareOptions = {},
  ): Promise<PreparedOpenAICompatibleAudio> {
    options.signal?.throwIfAborted()
    const toolResultAudio = prepareOptions.toolResultAudio ?? DEFAULT_TOOL_RESULT_AUDIO
    const requestId = randomUUID()
    const entries: MaterializedAudio[] = []
    const messages = [] as GenerateOptions['messages']

    for (const [messageIndex, message] of options.messages.entries()) {
      const content: ContentBlock[] = []
      let changed = false
      for (const [blockIndex, block] of message.content.entries()) {
        if (block.type !== 'audio') {
          content.push(block)
          continue
        }
        const sourceRole = message.role
        if (sourceRole !== 'user' && sourceRole !== 'tool') {
          return unsupported(`audio in ${sourceRole === 'assistant' ? 'an' : 'a'} ${sourceRole} message`)
        }
        const stored = await audioAttachments.readAudio(block.attachment, options.signal)
        options.signal?.throwIfAborted()
        const occurrence = entries.length
        const marker = markerOf(requestId, occurrence)
        entries.push({
          marker,
          occurrence,
          messageIndex,
          blockIndex,
          sourceRole,
          attachmentId: String(block.attachment.attachmentId),
          sourceBytes: stored.data.byteLength,
          data: Buffer.from(stored.data).toString('base64'),
        })
        content.push({ type: 'text', text: marker })
        changed = true
      }
      messages.push(changed ? { ...message, content } as typeof message : message)
    }

    if (entries.length === 0) return { options, release() {} }
    this.requests.set(requestId, { entries, toolResultAudio })
    let active = true
    return {
      options: { ...options, messages },
      release: () => {
        if (!active) return
        active = false
        this.requests.delete(requestId)
      },
    }
  }

  /**
   * Ids of prepared requests whose markers appear in a pi-ai Context. Pass
   * them to {@link patch} so a payload that lost every marker of a request
   * fails instead of silently dropping its audio.
   */
  requestIdsIn(context: unknown): Set<string> {
    const ids = new Set<string>()
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        for (const match of value.matchAll(MARKER_PATTERN)) {
          if (match[1] !== undefined && this.requests.has(match[1])) ids.add(match[1])
        }
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      if (!isRecord(value)) return
      // Image `data` holds base64 and never carries a marker.
      for (const [key, item] of Object.entries(value)) if (key !== 'data') visit(item)
    }
    visit(isRecord(context) ? context['messages'] : undefined)
    return ids
  }

  /**
   * Replace markers in pi-ai's final Chat Completions payload. Every request
   * named in `expectedRequestIds`, and every request whose marker appears in
   * the payload, must have each audio occurrence exactly once.
   */
  patch(payload: unknown, expectedRequestIds: Iterable<string> = []): PatchedOpenAICompatiblePayload {
    if (!isRecord(payload) || !Array.isArray(payload['messages'])) {
      return invalid('pi-ai payload has no messages array')
    }
    const seen = new Map<string, number>()
    const requestIds = new Set<string>(expectedRequestIds)
    const receipts: OpenAICompatibleAudioReceipt[] = []

    const segments = (text: string): Segment[] => {
      const result: Segment[] = []
      let cursor = 0
      MARKER_PATTERN.lastIndex = 0
      for (const match of text.matchAll(MARKER_PATTERN)) {
        const offset = match.index
        const requestId = match[1]
        const occurrence = Number(match[2])
        if (offset === undefined || requestId === undefined || !Number.isSafeInteger(occurrence)) {
          return invalid('malformed internal audio marker')
        }
        const request = this.requests.get(requestId)
        // Marker-shaped text from no prepared request is ordinary history text.
        if (request === undefined) continue
        const entry = request.entries[occurrence]
        if (entry === undefined || entry.marker !== match[0]) {
          return invalid('unknown internal audio marker occurrence')
        }
        if (offset > cursor) result.push({ kind: 'text', text: text.slice(cursor, offset) })
        result.push({ kind: 'audio', entry })
        requestIds.add(requestId)
        seen.set(entry.marker, (seen.get(entry.marker) ?? 0) + 1)
        cursor = offset + match[0].length
      }
      if (cursor < text.length) result.push({ kind: 'text', text: text.slice(cursor) })
      return result
    }

    const receipt = (
      entry: MaterializedAudio,
      placement: OpenAICompatibleAudioReceipt['placement'],
      wireMessageIndex: number,
      contentPartIndex: number,
    ): OpenAICompatibleAudioReceipt => ({
      occurrence: entry.occurrence,
      messageIndex: entry.messageIndex,
      blockIndex: entry.blockIndex,
      sourceRole: entry.sourceRole,
      placement,
      wireMessageIndex,
      contentPartIndex,
      attachmentId: entry.attachmentId,
      mediaType: 'audio/wav',
      sourceBytes: entry.sourceBytes,
      inlineBase64Bytes: Buffer.byteLength(entry.data, 'ascii'),
    })

    /** Split text parts at markers into text and `input_audio` parts, keeping text-part fields. */
    const multipart = (
      content: string | unknown[],
      placement: 'user-content' | 'tool-message',
      wireMessageIndex: number,
    ): { parts: unknown[]; changed: boolean } => {
      const source: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
      const parts: unknown[] = []
      let changed = false
      for (const part of source) {
        if (!isTextPart(part)) {
          parts.push(part)
          continue
        }
        const pieces = segments(part.text)
        if (!pieces.some(piece => piece.kind === 'audio')) {
          parts.push(part)
          continue
        }
        changed = true
        for (const piece of pieces) {
          if (piece.kind === 'text') {
            parts.push({ ...part, type: 'text', text: piece.text })
            continue
          }
          receipts.push(receipt(piece.entry, placement, wireMessageIndex, parts.length))
          parts.push(audioPart(piece.entry))
        }
      }
      return { parts, changed }
    }

    const output: unknown[] = []
    let followup: unknown[] = []
    let followupReceipts: OpenAICompatibleAudioReceipt[] = []
    const flushFollowup = (): void => {
      if (followup.length === 0) return
      const wireMessageIndex = output.length
      for (const pending of followupReceipts) pending.wireMessageIndex = wireMessageIndex
      output.push({ role: 'user', content: followup })
      followup = []
      followupReceipts = []
    }

    for (const value of payload['messages']) {
      const role = isRecord(value) ? value['role'] : undefined
      if (role !== 'tool') flushFollowup()
      if (!isRecord(value) || (role !== 'user' && role !== 'tool')) {
        output.push(value)
        continue
      }
      const content = value['content']
      if (typeof content !== 'string' && !Array.isArray(content)) {
        output.push(value)
        continue
      }
      if (role === 'user') {
        const { parts, changed } = multipart(content, 'user-content', output.length)
        if (changed) value['content'] = parts
        output.push(value)
        continue
      }

      const textParts = typeof content === 'string' ? [content] : content.filter(isTextPart).map(part => part.text)
      const placement = textParts
        .flatMap(text => [...text.matchAll(MARKER_PATTERN)])
        .map(match => match[1] === undefined ? undefined : this.requests.get(match[1])?.toolResultAudio)
        .find(found => found !== undefined)
      if (placement === undefined) {
        output.push(value)
        continue
      }

      if (placement === 'tool-message') {
        value['content'] = multipart(content, 'tool-message', output.length).parts
        output.push(value)
        continue
      }

      const toolCallId = value['tool_call_id']
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        return invalid('tool message with audio has no tool_call_id')
      }
      let labeled = false
      const noteText = (text: string): string => {
        let result = ''
        for (const piece of segments(text)) {
          if (piece.kind === 'text') {
            result += piece.text
            continue
          }
          if (!labeled) {
            followup.push({ type: 'text', text: toolResultAudioLabel(toolCallId) })
            labeled = true
          }
          // The inserted message's index is known only when the tool-message run ends.
          const pending = receipt(piece.entry, 'tool-followup', -1, followup.length)
          followupReceipts.push(pending)
          receipts.push(pending)
          followup.push(audioPart(piece.entry))
          // DSH joins text blocks without a separator; keep the note on its own line.
          if (result.length > 0 && !/\s$/u.test(result)) result += '\n'
          result += TOOL_RESULT_AUDIO_NOTE
        }
        return result
      }
      value['content'] = typeof content === 'string'
        ? noteText(content)
        : content.map(part => isTextPart(part) ? { ...part, text: noteText(part.text) } : part)
      output.push(value)
    }
    flushFollowup()
    payload['messages'] = output

    for (const requestId of requestIds) {
      const request = this.requests.get(requestId)
      if (request === undefined) return invalid('audio request expired during payload patching')
      for (const entry of request.entries) {
        if (seen.get(entry.marker) !== 1) {
          return invalid(`audio occurrence ${entry.occurrence} was not preserved exactly once`)
        }
      }
    }

    receipts.sort((left, right) => left.wireMessageIndex - right.wireMessageIndex
      || left.contentPartIndex - right.contentPartIndex)
    return { payload, audioReceipts: receipts }
  }
}
