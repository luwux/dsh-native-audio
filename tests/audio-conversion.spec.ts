import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAudioFileName, toPcmWav } from '../src/audio-conversion.js'
import { parseWav } from '../src/wav.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const LIMITS = { maxBytes: 10 * 1024 * 1024, ffmpegPath: 'ffmpeg' }

describe('audio conversion', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-native-audio-conversion-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function encode(name: string, args: readonly string[]): Promise<Uint8Array> {
    const source = join(directory, 'source.wav')
    const output = join(directory, name)
    await writeFile(source, syntheticWav({ sampleRateHz: 44_100, channels: 2, frames: 44_100 }))
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', source, ...args, output])
    return new Uint8Array(await readFile(output))
  }

  it('names audio files by extension, case-insensitively', () => {
    for (const name of ['a.wav', 'a.WAVE', 'a.aif', 'a.aiff', 'a.aifc', 'a.mp3', 'a.flac', 'a.m4a', 'a.aac', 'a.ogg', 'a.oga', 'a.opus']) {
      expect(isAudioFileName(name), name).toBe(true)
    }
    for (const name of ['a.txt', 'wav', 'a.wav.txt', 'a.mp4', 'a.m3u8']) {
      expect(isAudioFileName(name), name).toBe(false)
    }
  })

  it('returns PCM WAV as the same bytes without running a converter', async () => {
    const wav = syntheticWav({ bitsPerSample: 24, classicFmtBytes: 40 })

    await expect(toPcmWav(wav, { maxBytes: 1, ffmpegPath: join(directory, 'absent') })).resolves.toBe(wav)
  })

  it('reports a missing converter', async () => {
    await expect(toPcmWav(new TextEncoder().encode('mp3?'), { ...LIMITS, ffmpegPath: join(directory, 'absent') }))
      .rejects.toMatchObject({ code: 'AUDIO_CONVERTER_MISSING' })
  })

  it.skipIf(!hasFfmpeg)('converts every accepted container to 16-bit PCM at its own rate and channels', async () => {
    const inputs: Array<[string, readonly string[]]> = [
      ['float.wav', ['-c:a', 'pcm_f32le']],
      ['take.aiff', []],
      ['take.mp3', ['-c:a', 'libmp3lame']],
      ['take.flac', []],
      ['take.m4a', ['-c:a', 'aac']],
      ['take.ogg', ['-c:a', 'flac']],
    ]
    for (const [name, args] of inputs) {
      const wav = await toPcmWav(await encode(name, args), LIMITS)
      expect(parseWav(wav), name).toMatchObject({ encoding: 'pcm', sampleRateHz: 44_100, channels: 2, bitsPerSample: 16 })
    }
  }, 30_000)

  it.skipIf(!hasFfmpeg)('produces the same bytes for the same input', async () => {
    const mp3 = await encode('take.mp3', ['-c:a', 'libmp3lame'])

    expect(await toPcmWav(mp3, LIMITS)).toEqual(await toPcmWav(mp3, LIMITS))
  })

  it.skipIf(!hasFfmpeg)('refuses output above the byte limit', async () => {
    const mp3 = await encode('take.mp3', ['-c:a', 'libmp3lame'])

    await expect(toPcmWav(mp3, { ...LIMITS, maxBytes: 1024 })).rejects.toMatchObject({ code: 'AUDIO_TOO_LARGE' })
  })

  it.skipIf(!hasFfmpeg)('refuses bytes that are not audio', async () => {
    await expect(toPcmWav(new TextEncoder().encode('not a RIFF/WAVE stream'), LIMITS))
      .rejects.toMatchObject({ code: 'AUDIO_CONVERSION_FAILED' })
  })

  it.skipIf(!hasFfmpeg)('does not follow a playlist disguised as audio', async () => {
    const target = join(directory, 'private.wav')
    await writeFile(target, syntheticWav())
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${target}\n#EXT-X-ENDLIST\n`

    await expect(toPcmWav(new TextEncoder().encode(playlist), LIMITS))
      .rejects.toMatchObject({ code: 'AUDIO_CONVERSION_FAILED' })
    const concat = `ffconcat version 1.0\nfile '${target}'\n`
    await expect(toPcmWav(new TextEncoder().encode(concat), LIMITS))
      .rejects.toMatchObject({ code: 'AUDIO_CONVERSION_FAILED' })
  })

  it.skipIf(!hasFfmpeg)('stops converting when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller left'))
    const mp3 = await encode('take.mp3', ['-c:a', 'libmp3lame'])

    await expect(toPcmWav(mp3, { ...LIMITS, signal: controller.signal })).rejects.toThrow('caller left')
  })
})
