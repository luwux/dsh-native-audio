import { Context, Service } from '@deepseek-ai/cordis'
import { toPcmWav } from './audio-conversion.js'
import { installAudioRouteGuard } from './audio-route-guard.js'
import { AudioAttachmentError } from './error.js'
import type {
  AudioAttachmentLimits,
  AudioAttachmentRef,
  SaveAudioAttachment,
  StoredAudioAttachment,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    audioAttachments: AudioAttachmentStore
  }
}

/** Immutable audio attachment service. */
export abstract class AudioAttachmentStore extends Service {
  private readonly audioProviders = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'audioAttachments')
    installAudioRouteGuard(ctx, this.audioProviders)
  }

  abstract readonly audioLimits: AudioAttachmentLimits

  /** Executable that {@link convertToPcmWav} runs for input that is not PCM WAV. */
  protected get ffmpegPath(): string {
    return 'ffmpeg'
  }

  abstract validateAudio(input: SaveAudioAttachment): Promise<void>

  /**
   * Return PCM WAV bytes ready for {@link saveAudio}. PCM WAV input comes back
   * unchanged; other audio is converted, and failure is an admission error.
   */
  convertToPcmWav(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    return toPcmWav(data, {
      maxBytes: this.audioLimits.maxAudioBytes,
      ffmpegPath: this.ffmpegPath,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /** Allow one provider route to receive AudioBlock while its plugin is active. */
  registerAudioProvider(provider: string): () => void {
    this.audioProviders.set(provider, (this.audioProviders.get(provider) ?? 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      const count = this.audioProviders.get(provider)
      if (count === undefined || count <= 1) this.audioProviders.delete(provider)
      else this.audioProviders.set(provider, count - 1)
    }
  }

  protected validateAudioBatch(inputs: readonly SaveAudioAttachment[]): void {
    const { maxAudiosPerMessage, maxMessageAudioBytes, mediaTypes } = this.audioLimits
    if (inputs.length > maxAudiosPerMessage) {
      throw new AudioAttachmentError('Audio batch exceeds the configured audio-count limit.', 'TOO_MANY_AUDIOS')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageAudioBytes) {
      throw new AudioAttachmentError('Audio batch exceeds the configured aggregate byte limit.', 'AUDIOS_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AudioAttachmentError(
          `Audio type ${input.mediaType} is not accepted by this deployment.`,
          'UNSUPPORTED_AUDIO_TYPE',
        )
      }
    }
  }

  async saveAudios(inputs: readonly SaveAudioAttachment[]): Promise<readonly AudioAttachmentRef[]> {
    this.validateAudioBatch(inputs)
    for (const input of inputs) await this.validateAudio(input)
    const refs: AudioAttachmentRef[] = []
    for (const input of inputs) refs.push(await this.saveAudio(input))
    return refs
  }

  abstract saveAudio(input: SaveAudioAttachment): Promise<AudioAttachmentRef>

  abstract readAudio(ref: AudioAttachmentRef, signal?: AbortSignal): Promise<StoredAudioAttachment>

  audioHostPath(ref: AudioAttachmentRef): string | undefined {
    void ref
    return undefined
  }
}

export default AudioAttachmentStore
