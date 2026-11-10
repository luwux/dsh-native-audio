import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { AudioAttachmentStore } from './service.js'
import type {
  AudioAttachmentLimits,
  AudioAttachmentRef,
  SaveAudioAttachment,
  StoredAudioAttachment,
} from './types.js'
import {
  audioObjectPath,
  commitPreparedAudioFile,
  prepareAudioFile,
  readAudioFile,
  saveAudioFile,
} from './store.js'

export { AudioAttachmentId } from './brand.js'
export { admitEncodedAudios } from './admission.js'
export { AudioAttachmentError, isAudioAdmissionError } from './error.js'
export type { AudioAdmissionErrorCode, AudioAttachmentErrorCode } from './error.js'
export { AudioAttachmentStore } from './service.js'
export { parseWav } from './wav.js'
export type { WavMetadata } from './wav.js'
export { audioObjectPath, commitPreparedAudioFile, prepareAudioFile, readAudioFile, saveAudioFile }
export type { PreparedAudioFile } from './store.js'
export type {
  AudioAttachmentId as AudioAttachmentIdType,
  AudioAttachmentLimits,
  AudioAttachmentRef,
  AudioBlock,
  AudioMediaType,
  EncodedAudioAttachment,
  SaveAudioAttachment,
  StoredAudioAttachment,
  PcmContainerBits,
} from './types.js'
export { audioDurationSeconds } from './types.js'
export { contentHasAudio, installAudioRouteGuard, requestHasAudio } from './audio-route-guard.js'

export const DEFAULT_MAX_AUDIO_BYTES = 50 * 1024 * 1024
export const DEFAULT_MAX_AUDIOS_PER_MESSAGE = 4
export const DEFAULT_MAX_MESSAGE_AUDIO_BYTES = 100 * 1024 * 1024

export interface Config {
  /** Explicit harness home; omitted follows DSH_HOME, then ~/.dsh. */
  dshHome?: string
  maxAudioBytes?: number
  maxAudiosPerMessage?: number
  maxMessageAudioBytes?: number
  /** Executable that converts non-PCM audio to WAV; defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string
}

/** Local byte-preserving WAV attachment store; conversion runs before bytes reach it. */
export class LocalAudioAttachmentStore extends AudioAttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxAudioBytes: z.number().step(1).min(1).default(DEFAULT_MAX_AUDIO_BYTES),
    maxAudiosPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_AUDIOS_PER_MESSAGE),
    maxMessageAudioBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_AUDIO_BYTES),
    ffmpegPath: z.string().default('ffmpeg'),
  })

  readonly root: string
  readonly audioLimits: AudioAttachmentLimits
  private readonly configuredFfmpegPath: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.configuredFfmpegPath = config.ffmpegPath ?? 'ffmpeg'
    this.root = resolve(join(resolveDshHome(config.dshHome), 'audio-attachments', 'v1'))
    this.audioLimits = Object.freeze({
      maxAudioBytes: config.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES,
      maxAudiosPerMessage: config.maxAudiosPerMessage ?? DEFAULT_MAX_AUDIOS_PER_MESSAGE,
      maxMessageAudioBytes: config.maxMessageAudioBytes ?? DEFAULT_MAX_MESSAGE_AUDIO_BYTES,
      mediaTypes: Object.freeze(['audio/wav'] as const),
    })
  }

  protected override get ffmpegPath(): string {
    return this.configuredFfmpegPath
  }

  async validateAudio(input: SaveAudioAttachment): Promise<void> {
    prepareAudioFile(input, this.audioLimits)
  }

  override async saveAudios(
    inputs: readonly SaveAudioAttachment[],
  ): Promise<readonly AudioAttachmentRef[]> {
    this.validateAudioBatch(inputs)
    const prepared = inputs.map(input => prepareAudioFile(input, this.audioLimits))
    const refs: AudioAttachmentRef[] = []
    for (const audio of prepared) refs.push(await commitPreparedAudioFile(this.root, audio))
    return refs
  }

  async saveAudio(input: SaveAudioAttachment): Promise<AudioAttachmentRef> {
    return saveAudioFile(this.root, input, this.audioLimits)
  }

  async readAudio(ref: AudioAttachmentRef, signal?: AbortSignal): Promise<StoredAudioAttachment> {
    return readAudioFile(this.root, ref, signal)
  }

  override audioHostPath(ref: AudioAttachmentRef): string {
    return audioObjectPath(this.root, ref)
  }
}

export default LocalAudioAttachmentStore
