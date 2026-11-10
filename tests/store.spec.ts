import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  admitEncodedAudios,
  LocalAudioAttachmentStore,
} from '../src/index.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const roots: string[] = []

async function dshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-audio-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('LocalAudioAttachmentStore', () => {
  it('publishes byte-identical content-addressed WAV and verifies reads', async () => {
    const store = new LocalAudioAttachmentStore(new Context(), { dshHome: await dshHome() })
    const wav = syntheticWav()
    const ref = await store.saveAudio({ data: wav, mediaType: 'audio/wav', name: 'C:\\private\\clip.wav' })
    const sha256 = createHash('sha256').update(wav).digest('hex')

    expect(ref).toEqual({
      attachmentId: `sha256:${sha256}`,
      mediaType: 'audio/wav',
      bytes: wav.byteLength,
      sampleRateHz: 8000,
      channels: 1,
      bitsPerSample: 16,
      validBitsPerSample: 16,
      sampleFrames: 80,
      encoding: 'pcm',
      name: 'clip.wav',
    })
    await expect(store.readAudio(ref)).resolves.toEqual({ ref, data: wav })
    expect(new Uint8Array(await readFile(store.audioHostPath(ref)))).toEqual(wav)
  })

  it('validates every batch member before publishing any reference', async () => {
    const store = new LocalAudioAttachmentStore(new Context(), { dshHome: await dshHome() })
    const wav = syntheticWav()

    await expect(store.saveAudios([
      { data: wav, mediaType: 'audio/wav' },
      { data: new Uint8Array(44), mediaType: 'audio/wav' },
    ])).rejects.toMatchObject({ code: 'AUDIO_TYPE_MISMATCH' })

    await expect(readFile(store.audioHostPath({
      attachmentId: `sha256:${createHash('sha256').update(wav).digest('hex')}` as never,
      mediaType: 'audio/wav',
      bytes: wav.byteLength,
      sampleRateHz: 8000,
      channels: 1,
      bitsPerSample: 16,
      validBitsPerSample: 16,
      sampleFrames: 80,
      encoding: 'pcm',
    }))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts canonical base64 and rejects non-canonical input', async () => {
    const store = new LocalAudioAttachmentStore(new Context(), { dshHome: await dshHome() })
    const wav = syntheticWav()
    const [ref] = await admitEncodedAudios(store, [{
      mediaType: 'audio/wav',
      data: Buffer.from(wav).toString('base64'),
    }])

    expect(ref?.bytes).toBe(wav.byteLength)
    await expect(admitEncodedAudios(store, [{ mediaType: 'audio/wav', data: ' Zm9v' }]))
      .rejects.toMatchObject({ code: 'INVALID_AUDIO_BASE64' })
  })

  it('fails closed when a stored object no longer matches its digest', async () => {
    const store = new LocalAudioAttachmentStore(new Context(), { dshHome: await dshHome() })
    const ref = await store.saveAudio({ data: syntheticWav(), mediaType: 'audio/wav' })
    const path = store.audioHostPath(ref)
    await chmod(path, 0o600)
    await writeFile(path, syntheticWav({ frames: 160 }))

    await expect(store.readAudio(ref)).rejects.toEqual(
      expect.objectContaining({ code: 'ATTACHMENT_CORRUPT' }),
    )
    await chmod(dirname(path), 0o700)
  })
})
