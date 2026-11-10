import {
  BlockAssembler,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  GeminiGenerateContentAdapter,
  type GeminiFetch,
  type GeminiGenerateContentRequest,
  type GeminiRequestCapture,
} from '../src/gemini/index.js'
import { prepareAudioFile } from '../src/store.js'
import type { AudioAttachmentLimits, StoredAudioAttachment } from '../src/types.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const audioLimits: AudioAttachmentLimits = {
  maxAudioBytes: 1_000_000,
  maxAudiosPerMessage: 8,
  maxMessageAudioBytes: 2_000_000,
  mediaTypes: ['audio/wav'],
}

function audioFixture(): StoredAudioAttachment {
  const prepared = prepareAudioFile({
    data: syntheticWav({ bitsPerSample: 16, sampleRateHz: 48_000, channels: 2 }),
    mediaType: 'audio/wav',
  }, audioLimits)
  return { ref: prepared.ref, data: prepared.data }
}

function streamBytes(value: string, widths: readonly number[] = [1, 3, 2, 5]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0
      let index = 0
      while (offset < bytes.length) {
        const width = widths[index % widths.length] ?? 1
        controller.enqueue(bytes.slice(offset, Math.min(offset + width, bytes.length)))
        offset += width
        index += 1
      }
      controller.close()
    },
  })
}

function sseResponse(events: readonly unknown[]): Response {
  const wire = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n'
  return new Response(streamBytes(wire), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'google-gemini',
    model: 'gemini-3-flash-preview',
    messages,
  }
}

function bodyOf(capture: GeminiRequestCapture | undefined): GeminiGenerateContentRequest {
  if (capture === undefined) throw new Error('missing request capture')
  return JSON.parse(capture.bodyText) as GeminiGenerateContentRequest
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

describe('GeminiGenerateContentAdapter', () => {
  it('keeps text split across SSE events in one Harness block', async () => {
    const adapter = new GeminiGenerateContentAdapter({
      fetch: vi.fn(async () => sseResponse([
        { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '| File | Result |\n' }] } }] },
        { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '| --- | --- |\n| sample-' }] } }] },
        { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'b.wav | **clear** |' }] } }] },
        { candidates: [{ index: 0, finishReason: 'STOP' }] },
      ])),
      resolveCredential: vi.fn(async () => ({ apiKey: 'offline-key', ref: 'test.apiKey' })),
      audioAttachments: { readAudio: vi.fn(async () => { throw new Error('unexpected') }) },
    })
    const user = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Compare the files.' }],
    })

    const chunks = await collect(adapter.stream(request([user])))
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    expect(assembler.blocks()).toEqual([{
      type: 'text',
      text: '| File | Result |\n| --- | --- |\n| sample-b.wav | **clear** |',
    }])
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      replayState: {
        blocks: [{ type: 'text', nativeContentIndex: 0, nativePartIndex: 0 }],
      },
    })
  })

  it('uses the exact SSE endpoint and replays streamed Gemini 3 part metadata through tool results', async () => {
    const stored = audioFixture()
    const initialUser = createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'Inspect both regions.' },
        { type: 'audio', attachment: stored.ref },
        { type: 'audio', attachment: stored.ref },
      ],
    })
    const scripted = [
      sseResponse([
        {
          responseId: 'response-tools',
          modelVersion: 'gemini-3-flash-preview-001',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [
                {
                  text: 'I will inspect both.',
                  thought: true,
                  thoughtSignature: 'thinking-signature',
                  partMetadata: { providerLane: 'reasoning' },
                },
                {
                  functionCall: { id: 'call-a', name: 'inspect', args: { region: 'A' } },
                  thoughtSignature: 'function-signature',
                },
                { functionCall: { id: 'call-b', name: 'inspect', args: { region: 'B' } } },
              ],
            },
          }],
        },
        {
          candidates: [{ index: 0, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 10,
            cachedContentTokenCount: 4,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 5,
          },
        },
      ]),
      sseResponse([
        {
          responseId: 'response-text',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [
                { text: 'Done.' },
                { text: '', thoughtSignature: 'final-empty-part-signature' },
              ],
            },
          }],
        },
        {
          candidates: [{ index: 0, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2 },
        },
      ]),
    ]
    const fetchCalls: Array<{ input: string | URL; init: RequestInit | undefined }> = []
    const fetch: GeminiFetch = vi.fn(async (input, init) => {
      fetchCalls.push({ input, init })
      const response = scripted[fetchCalls.length - 1]
      if (response === undefined) throw new Error('recording fetch script exhausted')
      return response
    })
    const order: string[] = []
    const captures: GeminiRequestCapture[] = []
    const readAudio = vi.fn(async (): Promise<StoredAudioAttachment> => stored)
    const resolveCredential = vi.fn(async () => {
      order.push('credential')
      return { apiKey: 'offline-test-key', ref: 'tests.gemini.apiKey' }
    })
    const adapter = new GeminiGenerateContentAdapter({
      fetch,
      resolveCredential,
      audioAttachments: { readAudio },
      captureRequest: capture => {
        order.push('capture')
        captures.push(capture)
      },
    })

    const firstChunks = await collect(adapter.stream(request([initialUser])))

    expect(order.slice(0, 2)).toEqual(['capture', 'credential'])
    expect(String(fetchCalls[0]?.input)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse',
    )
    const firstHeaders = new Headers(fetchCalls[0]?.init?.headers)
    expect(firstHeaders.get('x-goog-api-key')).toBe('offline-test-key')
    expect(firstHeaders.get('content-type')).toBe('application/json')
    expect(firstHeaders.get('accept')).toBe('text/event-stream')
    expect(firstHeaders.get('user-agent')).toContain('deepseek-harness/')
    expect(String(fetchCalls[0]?.input)).not.toContain('offline-test-key')
    expect(fetchCalls[0]?.init?.method).toBe('POST')
    expect(fetchCalls[0]?.init?.body).toBe(captures[0]?.bodyText)
    expect(readAudio).toHaveBeenCalledTimes(2)
    expect(captures[0]?.audioReceipts).toHaveLength(2)
    expect(captures[0]?.audioReceipts.map(receipt => receipt.occurrence)).toEqual([0, 1])
    const firstBody = bodyOf(captures[0])
    const inlineParts = firstBody.contents[0]?.parts.filter(part => 'inlineData' in part) ?? []
    expect(inlineParts).toHaveLength(2)
    for (const part of inlineParts) {
      if (!('inlineData' in part)) continue
      expect(new Uint8Array(Buffer.from(part.inlineData.data, 'base64'))).toEqual(stored.data)
    }

    const firstUsage = firstChunks.find(chunk => chunk.type === 'usage')
    expect(firstUsage).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 6,
        outputTokens: 8,
        cacheReadTokens: 4,
        reasoningTokens: 5,
      },
    })
    const firstFinish = firstChunks.at(-1)
    expect(firstFinish).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    if (firstFinish?.type !== 'finish') throw new Error('missing finish')
    expect(firstFinish.replayState).toEqual({
      response: {
        kind: 'gemini-generate-content',
        version: 1,
        provider: 'google-gemini',
        model: 'gemini-3-flash-preview',
        finishReason: 'STOP',
        responseId: 'response-tools',
        modelVersion: 'gemini-3-flash-preview-001',
      },
      blocks: [
        {
          type: 'reasoning', nativeContentIndex: 0, nativePartIndex: 0, thought: true,
          thoughtSignature: 'thinking-signature', partMetadata: { providerLane: 'reasoning' },
        },
        {
          type: 'tool-call', nativeContentIndex: 0, nativePartIndex: 1,
          thoughtSignature: 'function-signature',
        },
        { type: 'tool-call', nativeContentIndex: 0, nativePartIndex: 2 },
      ],
    })

    const assembler = new BlockAssembler()
    for (const chunk of firstChunks) assembler.push(chunk)
    const replayState = assembler.replayState
    if (replayState === undefined) throw new Error('missing assembled replay state')
    const assistant = createAssistantMessage({
      content: assembler.blocks(),
      source: { provider: 'google-gemini', model: 'gemini-3-flash-preview', replayState },
    })
    const resultA = createToolResultMessage({
      callId: ToolCallId('call-a'), content: [{ type: 'text', text: 'A is clean' }], isError: false,
    })
    const resultB = createToolResultMessage({
      callId: ToolCallId('call-b'), content: [{ type: 'text', text: 'B clips' }], isError: false,
    })

    const secondChunks = await collect(adapter.stream(request([
      initialUser,
      assistant,
      resultA,
      resultB,
    ])))

    const secondBody = bodyOf(captures[1])
    expect(secondBody.contents[1]).toEqual({
      role: 'model',
      parts: [
        {
          text: 'I will inspect both.', thought: true, thoughtSignature: 'thinking-signature',
          partMetadata: { providerLane: 'reasoning' },
        },
        {
          functionCall: { id: 'call-a', name: 'inspect', args: { region: 'A' } },
          thoughtSignature: 'function-signature',
        },
        { functionCall: { id: 'call-b', name: 'inspect', args: { region: 'B' } } },
      ],
    })
    expect(secondBody.contents.slice(2)).toEqual([
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call-a', name: 'inspect', response: { output: 'A is clean' },
          },
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call-b', name: 'inspect', response: { output: 'B clips' },
          },
        }],
      },
    ])
    expect(secondChunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        blocks: [
          { type: 'text', nativeContentIndex: 0, nativePartIndex: 0 },
          {
            type: 'text', nativeContentIndex: 0, nativePartIndex: 1,
            thoughtSignature: 'final-empty-part-signature',
          },
        ],
      },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(resolveCredential).toHaveBeenCalledTimes(2)
  })

  it('advertises configured thinking levels as model reasoning efforts', async () => {
    const adapter = new GeminiGenerateContentAdapter({
      fetch: vi.fn<GeminiFetch>(),
      resolveCredential: vi.fn(async () => ({ apiKey: 'unused', ref: 'unused' })),
      audioAttachments: { readAudio: vi.fn(async () => { throw new Error('unexpected') }) },
      models: [
        { id: 'leveled', name: 'Leveled', thinkingLevels: ['low', 'high'], defaultThinkingLevel: 'high' },
        { id: 'undefaulted', thinkingLevels: ['minimal', 'medium'] },
        { id: 'empty-levels', thinkingLevels: [] },
        { id: 'plain' },
      ],
    })

    await expect(adapter.resolveModel('google-gemini', 'leveled')).resolves.toEqual({
      provider: 'google-gemini',
      id: 'leveled',
      name: 'Leveled',
      inputModalities: ['text', 'audio'],
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'high',
      },
    })
    await expect(adapter.resolveModel('google-gemini', 'undefaulted')).resolves.toMatchObject({
      reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'medium', name: 'Medium' }] },
    })
    expect((await adapter.resolveModel('google-gemini', 'undefaulted')).reasoning)
      .not.toHaveProperty('defaultEffort')
    for (const model of ['empty-levels', 'plain', 'unlisted-model']) {
      expect(await adapter.resolveModel('google-gemini', model)).not.toHaveProperty('reasoning')
    }
  })

  it('checks reasoning effort against the advertised levels before capture and sends thinkingLevel', async () => {
    const captures: GeminiRequestCapture[] = []
    const fetch = vi.fn<GeminiFetch>(async () => sseResponse([
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] } }] },
      { candidates: [{ index: 0, finishReason: 'STOP' }] },
    ]))
    const resolveCredential = vi.fn(async () => ({ apiKey: 'offline-key', ref: 'test.apiKey' }))
    const adapter = new GeminiGenerateContentAdapter({
      fetch,
      resolveCredential,
      audioAttachments: { readAudio: vi.fn(async () => { throw new Error('unexpected') }) },
      models: [{ id: 'leveled', thinkingLevels: ['low', 'high'] }],
      captureRequest: capture => { captures.push(capture) },
    })
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'think' }] })

    for (const [model, effort] of [['leveled', 'medium'], ['leveled', 'max'], ['unlisted', 'max']] as const) {
      await expect(collect(adapter.stream({
        ...request([user]),
        model,
        reasoningEffort: ReasoningEffortId(effort),
      }))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    }
    expect(captures).toHaveLength(0)
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    await collect(adapter.stream({ ...request([user]), model: 'leveled', reasoningEffort: ReasoningEffortId('high') }))
    await collect(adapter.stream({ ...request([user]), model: 'unlisted', reasoningEffort: ReasoningEffortId('minimal') }))
    await collect(adapter.stream({ ...request([user]), model: 'leveled' }))
    expect(captures.map(capture => bodyOf(capture).generationConfig)).toEqual([
      { thinkingConfig: { thinkingLevel: 'high' } },
      { thinkingConfig: { thinkingLevel: 'minimal' } },
      undefined,
    ])
  })

  it('requests thought summaries only when includeThoughts is enabled', async () => {
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'think' }] })
    const bodies: GeminiGenerateContentRequest[] = []
    for (const includeThoughts of [true, false, undefined]) {
      const adapter = new GeminiGenerateContentAdapter({
        fetch: async () => sseResponse([
          { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'plan', thought: true }] } }] },
          { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
        ]),
        resolveCredential: async () => ({ apiKey: 'offline-key', ref: 'test.apiKey' }),
        audioAttachments: { readAudio: vi.fn(async () => { throw new Error('unexpected') }) },
        ...(includeThoughts === undefined ? {} : { includeThoughts }),
        captureRequest: capture => { bodies.push(bodyOf(capture)) },
      })
      const chunks = await collect(adapter.stream({ ...request([user]), reasoningEffort: ReasoningEffortId('low') }))
      const assembler = new BlockAssembler()
      for (const chunk of chunks) assembler.push(chunk)
      expect(assembler.blocks()).toEqual([
        { type: 'reasoning', text: 'plan' },
        { type: 'text', text: 'answer' },
      ])
    }
    expect(bodies.map(body => body.generationConfig)).toEqual([
      { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } },
      { thinkingConfig: { thinkingLevel: 'low' } },
      { thinkingConfig: { thinkingLevel: 'low' } },
    ])
  })

  it('enforces the final JSON cap and cancellation before capture, credentials, or transport', async () => {
    const captureRequest = vi.fn()
    const resolveCredential = vi.fn(async () => ({ apiKey: 'unused', ref: 'unused' }))
    const fetch = vi.fn<GeminiFetch>()
    const adapter = new GeminiGenerateContentAdapter({
      fetch,
      resolveCredential,
      audioAttachments: { readAudio: vi.fn(async () => { throw new Error('unexpected') }) },
      maxInlineRequestBytes: 40,
      captureRequest,
    })
    const user = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: '这个 JSON 肯定超过四十字节' }],
    })

    await expect(collect(adapter.stream(request([user])))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(captureRequest).not.toHaveBeenCalled()
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(collect(adapter.stream({ ...request([user]), signal: controller.signal })))
      .rejects.toThrow('caller stopped')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps provider HTTP errors and in-band terminal safety failures without retrying', async () => {
    const httpFetch: GeminiFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'rate limit reached' },
    }), {
      status: 429,
      headers: { 'retry-after': '2', 'x-goog-request-id': 'request-429' },
    }))
    const base = {
      resolveCredential: vi.fn(async () => ({ apiKey: 'offline-key', ref: 'test.apiKey' })),
      audioAttachments: { readAudio: vi.fn(async () => { throw new Error('unexpected') }) },
    }
    const httpAdapter = new GeminiGenerateContentAdapter({ ...base, fetch: httpFetch })
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
    let error: unknown
    try {
      await collect(httpAdapter.stream(request([user])))
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      code: 'RATE_LIMIT',
      failure: {
        status: 429,
        providerRetryAfterMs: 2_000,
        requestId: 'request-429',
      },
    })
    expect(httpFetch).toHaveBeenCalledTimes(1)

    const safetyAdapter = new GeminiGenerateContentAdapter({
      ...base,
      fetch: vi.fn(async () => sseResponse([
        { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] },
        {
          candidates: [{ index: 0, finishReason: 'SAFETY', finishMessage: 'blocked output' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
        },
      ])),
    })
    const chunks: StreamChunk[] = await collect(safetyAdapter.stream(request([user])))
    expect(chunks.at(-2)).toEqual({
      type: 'usage', usage: { inputTokens: 3, outputTokens: 1 },
    })
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'Gemini stopped generation: SAFETY: blocked output',
          code: 'GEMINI_SAFETY',
        },
      },
    })
  })
})

it('serializes stored image and audio bytes in one Gemini request and advertises image input', async () => {
  const { AttachmentId } = await import('@deepseek-ai/dsh-attachment')
  const image = { attachmentId: AttachmentId('offline-image'), mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
  const audio = audioFixture()
  const captures: GeminiRequestCapture[] = []
  const adapter = new GeminiGenerateContentAdapter({
    fetch: async () => sseResponse([{ candidates: [{ index: 0, finishReason: 'STOP' }] }]),
    resolveCredential: async () => ({ apiKey: 'offline', ref: 'test' }),
    audioAttachments: { readAudio: async () => audio },
    imageAttachments: { readImage: async () => ({ ref: image, data: new Uint8Array([1, 2, 3]) }) },
    captureRequest: value => { captures.push(value) },
  })
  await collect(adapter.stream(request([createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'image', attachment: image }, { type: 'audio', attachment: audio.ref },
  ] })])))
  expect(bodyOf(captures[0]).contents[0]?.parts).toEqual([
    { inlineData: { mimeType: 'image/png', data: 'AQID' } },
    { inlineData: { mimeType: 'audio/wav', data: Buffer.from(audio.data).toString('base64') } },
  ])
  expect((await adapter.resolveModel('google-gemini', 'test')).inputModalities).toEqual(['text', 'image', 'audio'])
})
