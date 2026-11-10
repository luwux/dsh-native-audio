import type { AudioAttachmentId } from './brand.js'
import type {} from '@deepseek-ai/dsh-llm'

export type { AudioAttachmentId } from './brand.js'

/** Audio formats accepted by the first durable attachment path. */
export type AudioMediaType = 'audio/wav'

/** PCM container widths accepted by the first durable attachment path. */
export type PcmContainerBits = 8 | 16 | 24 | 32

/** Durable, serializable reference to one immutable WAV object. */
export interface AudioAttachmentRef {
  /** Opaque content-addressed identifier; never a path or bearer URL. */
  attachmentId: AudioAttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: AudioMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Version one accepts only integer linear PCM. */
  encoding: 'pcm'
  sampleRateHz: number
  channels: number
  bitsPerSample: PcmContainerBits
  /** Equals bitsPerSample for classic PCM WAV. */
  validBitsPerSample: number
  /** Present for WAVE_FORMAT_EXTENSIBLE; zero is meaningful. */
  channelMask?: number
  /** Exact data byte length divided by block alignment. */
  sampleFrames: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Deployment-resolved limits used by upload and store admission. */
export interface AudioAttachmentLimits {
  maxAudioBytes: number
  maxAudiosPerMessage: number
  maxMessageAudioBytes: number
  mediaTypes: readonly AudioMediaType[]
}

/** Base64-encoded audio upload accompanying one wire request. */
export interface EncodedAudioAttachment {
  mediaType: AudioMediaType
  /** Canonical base64 encoding of the WAV bytes. */
  data: string
  name?: string
}

/** Request to validate and durably commit one audio object. */
export interface SaveAudioAttachment {
  data: Uint8Array
  mediaType: AudioMediaType
  name?: string
}

/** Stored WAV bytes returned after reference and digest verification. */
export interface StoredAudioAttachment {
  ref: AudioAttachmentRef
  data: Uint8Array
}

/** One durable audio content part, mirroring DSH's singular ImageBlock. */
export interface AudioBlock {
  type: 'audio'
  attachment: AudioAttachmentRef
}

/** Derive duration without storing a rounded floating-point fact in the ref. */
export function audioDurationSeconds(
  ref: Pick<AudioAttachmentRef, 'sampleFrames' | 'sampleRateHz'>,
): number {
  return ref.sampleFrames / ref.sampleRateHz
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    audio: AudioBlock
  }

  interface ModelModalityMap {
    audio: 'audio'
  }
}
