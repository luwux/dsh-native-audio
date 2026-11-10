import { describe, expect, it } from 'vitest'
import { parseWav } from '../src/index.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

describe('parseWav', () => {
  it('derives PCM metadata without changing the bytes', () => {
    const wav = syntheticWav({ sampleRateHz: 8000, channels: 2, frames: 80 })
    const before = wav.slice()

    expect(parseWav(wav)).toEqual({
      mediaType: 'audio/wav',
      encoding: 'pcm',
      sampleRateHz: 8000,
      channels: 2,
      bitsPerSample: 16,
      validBitsPerSample: 16,
      sampleFrames: 80,
    })
    expect(wav).toEqual(before)
  })

  it('accepts classic PCM whose fmt chunk carries extra bytes, as Ableton factory samples do', () => {
    const wav = syntheticWav({ sampleRateHz: 44100, bitsPerSample: 24, classicFmtBytes: 40 })

    expect(parseWav(wav)).toMatchObject({ encoding: 'pcm', sampleRateHz: 44100, bitsPerSample: 24, validBitsPerSample: 24 })
  })

  it('accepts Live-shaped classic PCM24 with unknown padded chunks', () => {
    const wav = syntheticWav({
      sampleRateHz: 48000,
      channels: 2,
      frames: 48,
      bitsPerSample: 24,
      junkBeforeFormat: true,
      listBeforeData: true,
    })

    expect(parseWav(wav)).toEqual({
      mediaType: 'audio/wav',
      encoding: 'pcm',
      sampleRateHz: 48000,
      channels: 2,
      bitsPerSample: 24,
      validBitsPerSample: 24,
      sampleFrames: 48,
    })
  })

  it('accepts WAVE_FORMAT_EXTENSIBLE PCM24 used by Live resampling exports', () => {
    const wav = syntheticWav({
      sampleRateHz: 48000,
      channels: 2,
      frames: 48,
      bitsPerSample: 24,
      format: 'extensible',
      validBitsPerSample: 24,
      channelMask: 3,
      listBeforeData: true,
    })

    expect(parseWav(wav)).toEqual({
      mediaType: 'audio/wav',
      encoding: 'pcm',
      sampleRateHz: 48000,
      channels: 2,
      bitsPerSample: 24,
      validBitsPerSample: 24,
      channelMask: 3,
      sampleFrames: 48,
    })
  })

  it('rejects IEEE-float WAV until a provider contract requires it', () => {
    const wav = syntheticWav()
    new DataView(wav.buffer).setUint16(20, 0x0003, true)

    expect(() => parseWav(wav)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO' }),
    )
  })

  it('rejects bytes that are not a RIFF/WAVE container', () => {
    expect(() => parseWav(new Uint8Array(44))).toThrowError(
      expect.objectContaining({ code: 'AUDIO_TYPE_MISMATCH' }),
    )
  })

  it('rejects a truncated data chunk', () => {
    const wav = syntheticWav()
    const truncated = wav.subarray(0, wav.byteLength - 1)
    const view = new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength)
    view.setUint32(4, truncated.byteLength - 8, true)

    expect(() => parseWav(truncated)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO' }),
    )
  })
})
