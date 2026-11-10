import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { isAudioFileName } from './audio-conversion.js'
import { AudioAttachmentId } from './brand.js'
import type { AudioAttachmentRef } from './types.js'
import { audioDurationSeconds } from './types.js'

export const AUDIO_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['audio/wav'], required: true },
    bytes: { type: 'integer', required: true },
    encoding: { type: 'string', enum: ['pcm'], required: true },
    sampleRateHz: { type: 'integer', required: true },
    channels: { type: 'integer', required: true },
    bitsPerSample: { type: 'integer', enum: [8, 16, 24, 32], required: true },
    validBitsPerSample: { type: 'integer', required: true },
    channelMask: { type: 'integer' },
    sampleFrames: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

/** Canonical value returned by `read_audio`. */
export interface AudioReadValue {
  readonly path: string
  readonly audio: {
    readonly attachmentId: string
    readonly mediaType: 'audio/wav'
    readonly bytes: number
    readonly encoding: 'pcm'
    readonly sampleRateHz: number
    readonly channels: number
    readonly bitsPerSample: 8 | 16 | 24 | 32
    readonly validBitsPerSample: number
    readonly channelMask?: number
    readonly sampleFrames: number
    readonly name?: string
  }
}

/** Rebuild the durable ref carried by the model-facing AudioBlock. */
export function audioRefFromValue(audio: AudioReadValue['audio']): AudioAttachmentRef {
  return {
    attachmentId: AudioAttachmentId(audio.attachmentId),
    mediaType: audio.mediaType,
    bytes: audio.bytes,
    encoding: audio.encoding,
    sampleRateHz: audio.sampleRateHz,
    channels: audio.channels,
    bitsPerSample: audio.bitsPerSample,
    validBitsPerSample: audio.validBitsPerSample,
    sampleFrames: audio.sampleFrames,
    ...(audio.channelMask === undefined ? {} : { channelMask: audio.channelMask }),
    ...(audio.name === undefined ? {} : { name: audio.name }),
  }
}

/** Project one filesystem read into explanatory text and the audio itself. */
export function audioReadContent(value: AudioReadValue): ContentBlock[] {
  const ref = audioRefFromValue(value.audio)
  return [
    {
      type: 'text',
      text: `<path>${value.path}</path>\n<type>audio</type>\n<content>\n`
        + `${ref.mediaType} PCM audio, ${audioDurationSeconds(ref).toFixed(3)} seconds, `
        + `${ref.sampleRateHz} Hz, ${ref.channels} channel(s), ${ref.bitsPerSample}-bit, ${ref.bytes} bytes\n</content>`,
    },
    { type: 'audio', attachment: ref },
  ]
}

/** Services required by the model-facing local audio reader. */
export const inject = ['tools', 'audioAttachments', 'workingDirectory']

/** Register a read-image-style tool that attaches one local audio file to its tool result as PCM WAV. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read_audio',
    description: 'Read a local audio file (WAV, AIFF, MP3, FLAC, M4A, AAC, Ogg, Opus) and return the audio itself to the current audio-capable model. '
      + 'Use this when the user gives a path to audio that must be heard or analyzed.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Absolute path, or a path relative to the session working directory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          audio: AUDIO_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => audioReadContent(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<AudioReadValue> {
      if (args.file_path.trim() === '') throw new Error('file_path must be a non-empty string')
      if (!isAudioFileName(args.file_path)) {
        throw new Error(`cannot read "${args.file_path}": read_audio only accepts audio file paths`)
      }
      const cwd = exec.agent === undefined
        ? process.cwd()
        : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const filePath = isAbsolute(args.file_path) ? resolve(args.file_path) : resolve(cwd, args.file_path)
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error(`cannot read "${args.file_path}": path is not a regular file`)
      if (info.size > ctx.audioAttachments.audioLimits.maxAudioBytes) {
        throw new Error(`cannot read "${args.file_path}": audio exceeds the configured byte limit`)
      }
      const source = new Uint8Array(await readFile(filePath, { signal: exec.signal }))
      const ref = await ctx.audioAttachments.saveAudio({
        data: await ctx.audioAttachments.convertToPcmWav(source, exec.signal),
        mediaType: 'audio/wav',
        name: basename(filePath),
      })
      return {
        path: filePath,
        audio: {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          encoding: ref.encoding,
          sampleRateHz: ref.sampleRateHz,
          channels: ref.channels,
          bitsPerSample: ref.bitsPerSample,
          validBitsPerSample: ref.validBitsPerSample,
          sampleFrames: ref.sampleFrames,
          ...(ref.channelMask === undefined ? {} : { channelMask: ref.channelMask }),
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read audio ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
