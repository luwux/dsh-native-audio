import { createHash } from 'node:crypto'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  GeminiFileCache,
  GeminiGenerateContentAdapter,
  geminiCredentialNamespace,
  geminiFileName,
  geminiFileUri,
  type GeminiGenerateContentRequest,
} from '../src/gemini/index.js'
import { prepareAudioFile } from '../src/store.js'
import type { AudioAttachmentLimits, StoredAudioAttachment } from '../src/types.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const limits: AudioAttachmentLimits = {
  maxAudioBytes: 1_000_000,
  maxAudiosPerMessage: 4,
  maxMessageAudioBytes: 2_000_000,
  mediaTypes: ['audio/wav'],
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

function response(): Response {
  const value = [
    `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'heard' }] } }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ candidates: [{ index: 0, finishReason: 'STOP' }] })}\r\n\r\n`,
    'data: [DONE]\r\n\r\n',
  ].join('')
  return new Response(value, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('Gemini Files audio transport', () => {
  it('uploads immutable audio once and reuses the same file URI across requests and a cold cache', async () => {
    const prepared = prepareAudioFile({
      data: syntheticWav({ bitsPerSample: 16, sampleRateHz: 48_000, channels: 2 }),
      mediaType: 'audio/wav',
    }, limits)
    const stored: StoredAudioAttachment = { ref: prepared.ref, data: prepared.data }
    const sha256 = createHash('sha256').update(stored.data).digest('hex')
    const apiKey = 'offline-key'
    const credentialNamespace = geminiCredentialNamespace(apiKey)
    const fileName = geminiFileName(sha256, credentialNamespace)
    expect(geminiFileName(sha256, geminiCredentialNamespace('replacement-key'))).not.toBe(fileName)
    const fileUri = geminiFileUri('https://generativelanguage.googleapis.com', fileName)
    const resource = {
      name: fileName,
      mimeType: 'audio/wav',
      sizeBytes: String(stored.data.byteLength),
      expirationTime: '2099-01-01T00:00:00Z',
      sha256Hash: Buffer.from(sha256, 'utf8').toString('base64'),
      uri: fileUri,
      state: 'ACTIVE',
    }
    const requests: Array<{ input: string; init: RequestInit | undefined }> = []
    let remoteExists = false
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      requests.push({ input: url, init })
      if (url === fileUri && init?.method === 'GET') {
        return remoteExists
          ? new Response(JSON.stringify(resource), { status: 200 })
          : new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 })
      }
      if (url.endsWith('/upload/v1beta/files')) {
        return new Response('', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload.test/session-1' },
        })
      }
      if (url === 'https://upload.test/session-1') {
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(stored.data)
        remoteExists = true
        return new Response(JSON.stringify({ file: resource }), { status: 200 })
      }
      if (url.includes(':streamGenerateContent')) return response()
      throw new Error(`unexpected fetch ${url}`)
    })
    const request: GenerateOptions = {
      provider: 'google-gemini-audio',
      model: 'gemini-3.8-flash',
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'Describe this clip.' },
          { type: 'audio', attachment: stored.ref },
        ],
      })],
    }
    const createAdapter = (fileCache: GeminiFileCache) => new GeminiGenerateContentAdapter({
      provider: 'google-gemini-audio',
      audioTransport: 'files',
      fileCache,
      fetch,
      resolveCredential: async () => ({ apiKey, ref: 'test.apiKey' }),
      audioAttachments: { readAudio: async () => stored },
    })

    const resident = createAdapter(new GeminiFileCache())
    await collect(resident.stream(request))
    await collect(resident.stream(request))
    await collect(createAdapter(new GeminiFileCache()).stream(request))

    const starts = requests.filter(call => call.input.endsWith('/upload/v1beta/files'))
    const uploads = requests.filter(call => call.input === 'https://upload.test/session-1')
    const metadata = requests.filter(call => call.input === fileUri)
    const generations = requests.filter(call => call.input.includes(':streamGenerateContent'))
    expect(starts).toHaveLength(1)
    expect(uploads).toHaveLength(1)
    expect(metadata).toHaveLength(2)
    expect(generations).toHaveLength(3)
    for (const generation of generations) {
      const body = JSON.parse(String(generation.init?.body)) as GeminiGenerateContentRequest
      expect(body.contents[0]?.parts[1]).toEqual({ fileData: { mimeType: 'audio/wav', fileUri } })
      expect(String(generation.init?.body)).not.toContain(Buffer.from(stored.data).toString('base64'))
    }
  })
})

it('isolates cancellation between callers and aborts transport when every waiter leaves', async () => {
  const prepared = prepareAudioFile({ data: syntheticWav({ bitsPerSample: 16, sampleRateHz: 48_000, channels: 2 }), mediaType: 'audio/wav' }, limits)
  const sha256 = createHash('sha256').update(prepared.data).digest('hex')
  const fileName = geminiFileName(sha256, geminiCredentialNamespace('offline'))
  const fileUri = geminiFileUri('https://files.test', fileName)
  const upload = { attachment: prepared.ref, data: prepared.data, sha256, fileName, fileUri }
  const resource = { name: fileName, uri: fileUri, mimeType: 'audio/wav', sizeBytes: String(prepared.data.byteLength), expirationTime: '2099-01-01T00:00:00Z', sha256Hash: Buffer.from(sha256, 'utf8').toString('base64'), state: 'ACTIVE' }
  const calls: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = []
  const fetch = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal as AbortSignal
    calls.push({ signal, resolve })
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const cache = new GeminiFileCache()
  const options = { fetch, baseUrl: 'https://files.test', apiKey: 'offline' }
  const first = new AbortController()
  const second = new AbortController()
  const a = cache.ensure(upload, { ...options, signal: first.signal })
  const b = cache.ensure(upload, { ...options, signal: second.signal })
  first.abort(new Error('first cancelled'))
  await expect(a).rejects.toThrow('first cancelled')
  expect(calls).toHaveLength(1)
  expect(calls[0]!.signal.aborted).toBe(false)
  calls[0]!.resolve(new Response(JSON.stringify(resource)))
  await expect(b).resolves.toMatchObject({ fileUri })

  const cold = new GeminiFileCache()
  const last = new AbortController()
  const c = cold.ensure(upload, { ...options, signal: last.signal })
  last.abort(new Error('last cancelled'))
  await expect(c).rejects.toThrow('last cancelled')
  expect(calls[1]!.signal.aborted).toBe(true)
  const d = cold.ensure(upload, options)
  expect(calls).toHaveLength(3)
  calls[2]!.resolve(new Response(JSON.stringify(resource)))
  await expect(d).resolves.toMatchObject({ fileUri })
})
