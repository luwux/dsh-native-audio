import { AudioAttachmentError } from './error.js'
import type { AudioMediaType, PcmContainerBits } from './types.js'

const RIFF_HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length))
}

function invalid(message: string): never {
  throw new AudioAttachmentError(message, 'INVALID_AUDIO')
}

/** Metadata derived from a complete, internally consistent WAV container. */
export interface WavMetadata {
  mediaType: AudioMediaType
  encoding: 'pcm'
  sampleRateHz: number
  channels: number
  bitsPerSample: PcmContainerBits
  validBitsPerSample: number
  channelMask?: number
  sampleFrames: number
}

const PCM_SUBFORMAT_GUID = new Uint8Array([
  0x01, 0x00, 0x00, 0x00,
  0x00, 0x00,
  0x10, 0x00,
  0x80, 0x00,
  0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
])

function equalBytes(data: Uint8Array, offset: number, expected: Uint8Array): boolean {
  return expected.every((byte, index) => data[offset + index] === byte)
}

function pcmBits(value: number): PcmContainerBits {
  if (value === 8 || value === 16 || value === 24 || value === 32) return value
  return invalid(`PCM WAV bit depth ${value} is not supported.`)
}

/**
 * Parse the WAV container subset accepted by version one.
 *
 * Accepted input is little-endian RIFF/WAVE with one classic or extensible
 * integer-PCM fmt chunk followed by one complete top-level data chunk. Unknown
 * RIFF chunks and bytes after the classic 16-byte format, which Ableton factory
 * samples carry, are skipped. Bytes are never decoded, normalized, or rewritten.
 */
export function parseWav(data: Uint8Array): WavMetadata {
  if (data.byteLength < RIFF_HEADER_BYTES) invalid('WAV data is too short for a RIFF header.')
  if (ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WAVE') {
    throw new AudioAttachmentError('Declared WAV data is not a RIFF/WAVE container.', 'AUDIO_TYPE_MISMATCH')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(4, true) !== data.byteLength - 8) invalid('RIFF size does not match the encoded WAV bytes.')

  let format: {
    encoding: 'pcm'
    sampleRateHz: number
    channels: number
    bitsPerSample: PcmContainerBits
    validBitsPerSample: number
    channelMask?: number
    blockAlign: number
    byteRate: number
  } | undefined
  let dataBytes: number | undefined
  let offset = RIFF_HEADER_BYTES

  while (offset < data.byteLength) {
    if (offset + CHUNK_HEADER_BYTES > data.byteLength) invalid('WAV ends inside a chunk header.')
    const id = ascii(data, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + CHUNK_HEADER_BYTES
    const end = body + size
    if (end > data.byteLength) invalid(`WAV ${id} chunk exceeds the encoded bytes.`)

    if (id === 'fmt ') {
      if (format !== undefined) invalid('WAV contains more than one fmt chunk.')
      if (size < 16) invalid('WAV fmt chunk is shorter than the base format.')
      const formatCode = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const sampleRateHz = view.getUint32(body + 4, true)
      const byteRate = view.getUint32(body + 8, true)
      const blockAlign = view.getUint16(body + 12, true)
      const bitsPerSample = pcmBits(view.getUint16(body + 14, true))
      if (channels === 0 || sampleRateHz === 0) invalid('WAV channels and sample rate must be positive.')
      let validBitsPerSample: number
      let channelMask: number | undefined
      if (formatCode === 0x0001) {
        validBitsPerSample = bitsPerSample
      } else if (formatCode === 0xfffe) {
        if (size !== 40 || view.getUint16(body + 16, true) !== 22) {
          invalid('Extensible PCM WAV fmt chunk must contain its 22-byte extension.')
        }
        validBitsPerSample = view.getUint16(body + 18, true)
        channelMask = view.getUint32(body + 20, true)
        if (!equalBytes(data, body + 24, PCM_SUBFORMAT_GUID)) {
          invalid('Extensible WAV subformat is not integer PCM.')
        }
        if (validBitsPerSample === 0 || validBitsPerSample > bitsPerSample) {
          invalid('Extensible WAV valid bit depth is inconsistent.')
        }
      } else {
        invalid(`WAV format code ${formatCode} is not supported.`)
      }
      const expectedBlockAlign = channels * (bitsPerSample / 8)
      if (blockAlign !== expectedBlockAlign || byteRate !== sampleRateHz * expectedBlockAlign) {
        invalid('WAV fmt byte rate or block alignment is inconsistent.')
      }
      format = {
        encoding: 'pcm',
        sampleRateHz,
        channels,
        bitsPerSample,
        validBitsPerSample,
        ...(channelMask === undefined ? {} : { channelMask }),
        blockAlign,
        byteRate,
      }
    } else if (id === 'data') {
      if (format === undefined) invalid('WAV data chunk appears before its fmt chunk.')
      if (dataBytes !== undefined) invalid('WAV contains more than one data chunk.')
      dataBytes = size
    }

    offset = end + (size % 2)
    if (offset > data.byteLength) invalid('WAV chunk padding exceeds the encoded bytes.')
  }

  if (format === undefined) invalid('WAV is missing its fmt chunk.')
  if (dataBytes === undefined) invalid('WAV is missing its data chunk.')
  if (dataBytes === 0) invalid('WAV contains no audio frames.')
  if (dataBytes % format.blockAlign !== 0) invalid('WAV data does not contain complete sample frames.')
  const sampleFrames = dataBytes / format.blockAlign
  return {
    mediaType: 'audio/wav',
    encoding: format.encoding,
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    validBitsPerSample: format.validBitsPerSample,
    ...(format.channelMask === undefined ? {} : { channelMask: format.channelMask }),
    sampleFrames,
  }
}
