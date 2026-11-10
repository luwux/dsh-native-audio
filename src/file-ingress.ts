import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { freezeMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { isAudioFileName } from './audio-conversion.js'
import { AudioAttachmentError, isAudioAdmissionError } from './error.js'
import type { AudioAttachmentStore } from './service.js'
import type { AudioAttachmentRef } from './types.js'

export const name = 'dsh-native-audio-file-ingress'
export const inject = ['attachments', 'audioAttachments']

export interface Config {}

export const Config: z<Config> = z.object({})

type FileReader = Pick<AttachmentStore, 'readFileStream'>
type AudioWriter = Pick<AudioAttachmentStore, 'audioLimits' | 'convertToPcmWav' | 'saveAudios'>

/** One audio file left as a plain file because conversion or audio admission refused it. */
export interface SkippedAudioFile {
  file: FileAttachmentRef
  error: unknown
}

async function readFileBytes(files: FileReader, ref: FileAttachmentRef, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of files.readFileStream(ref, signal)) {
    chunks.push(chunk)
    length += chunk.byteLength
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Follow each admissible audio FileBlock in user content with an AudioBlock:
 * the same bytes for a PCM WAV, a converted WAV for anything else. The FileBlock
 * stays in place, so the model also receives the saved path and stock clients
 * keep rendering the file card.
 *
 * Audio limits apply per message to the WAV sizes: files beyond
 * `maxAudiosPerMessage`, above `maxAudioBytes`, beyond `maxMessageAudioBytes`,
 * or that cannot become a PCM WAV remain plain files and are reported through
 * `onSkip`. Content that already carries an AudioBlock is returned unchanged.
 */
export async function attachFileAudio(
  content: readonly ContentBlock[],
  files: FileReader,
  audio: AudioWriter,
  options: { signal?: AbortSignal; onSkip?: (skipped: SkippedAudioFile) => void } = {},
): Promise<readonly ContentBlock[]> {
  if (content.some(block => block.type === 'audio')) return content
  if (!content.some(block => block.type === 'file' && isAudioFileName(block.attachment.name))) return content
  const limits = audio.audioLimits
  const next: ContentBlock[] = []
  let count = 0
  let totalBytes = 0
  for (const block of content) {
    next.push(block)
    if (block.type !== 'file' || !isAudioFileName(block.attachment.name)) continue
    const file = block.attachment
    if (count >= limits.maxAudiosPerMessage
      || file.bytes > limits.maxAudioBytes
      || totalBytes + file.bytes > limits.maxMessageAudioBytes) {
      options.onSkip?.({ file, error: new Error('audio limits exceeded') })
      continue
    }
    const data = await readFileBytes(files, file, options.signal)
    options.signal?.throwIfAborted()
    let ref: AudioAttachmentRef | undefined
    try {
      const wav = await audio.convertToPcmWav(data, options.signal)
      if (totalBytes + wav.byteLength > limits.maxMessageAudioBytes) {
        throw new AudioAttachmentError('Message audio exceeds the configured aggregate byte limit.', 'AUDIOS_TOO_LARGE')
      }
      ;[ref] = await audio.saveAudios([{ data: wav, mediaType: 'audio/wav', name: file.name }])
    } catch (error) {
      if (!isAudioAdmissionError(error)) throw error
      options.onSkip?.({ file, error })
      continue
    }
    if (ref === undefined) continue
    count += 1
    totalBytes += ref.bytes
    next.push({ type: 'audio', attachment: ref })
  }
  return next.length === content.length ? content : next
}

/** Rewrite one user message, preserving its identity and source. */
async function withFileAudio(
  message: UserMessage,
  files: FileReader,
  audio: AudioWriter,
  signal: AbortSignal,
  onSkip: (skipped: SkippedAudioFile) => void,
): Promise<UserMessage> {
  const content = await attachFileAudio(message.content, files, audio, { signal, onSkip })
  return content === message.content ? message : freezeMessage({ ...message, content })
}

/**
 * Give every Agent native audio for audio files the stock composer uploads.
 * The rewrite runs in `agent/pre-step`, so the durable `user/message` already
 * carries the AudioBlock that later requests, compaction, and replay read.
 */
export function apply(ctx: Context): void {
  const onSkip = ({ file, error }: SkippedAudioFile): void => {
    ctx.logger.warn('dsh-native-audio: kept %s as a plain file: %s', file.name,
      error instanceof Error ? error.message : String(error))
  }
  ctx.on('agent/pre-step', async ({ signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const messages = await Promise.all(decision.messages.map(message => withFileAudio(
      message, ctx.attachments, ctx.audioAttachments, signal, onSkip,
    )))
    return messages.every((message, index) => message === decision.messages[index])
      ? decision
      : { ...decision, messages }
  }, { global: true })
}

export default { name, inject, Config, apply }
