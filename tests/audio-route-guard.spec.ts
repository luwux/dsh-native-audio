import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ToolCallId,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { contentHasAudio, installAudioRouteGuard, requestHasAudio } from '../src/audio-route-guard.js'
import type { AudioAttachmentRef } from '../src/types.js'

const ref: AudioAttachmentRef = {
  attachmentId: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as never,
  mediaType: 'audio/wav',
  bytes: 48,
  encoding: 'pcm',
  sampleRateHz: 48000,
  channels: 1,
  bitsPerSample: 16,
  validBitsPerSample: 16,
  sampleFrames: 1,
}

class CountingAdapter extends LlmAdapter {
  calls = 0

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

function request(provider: string, role: 'user' | 'tool' = 'user'): GenerateOptions {
  const audio = { type: 'audio' as const, attachment: ref }
  return {
    provider,
    model: 'test-model',
    messages: [role === 'tool'
      ? createToolResultMessage({ callId: ToolCallId('call-1'), content: [audio], isError: false })
      : createUserMessage({ content: [audio], source: { kind: 'user' } })],
  }
}

describe('native-audio route guard', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    const owned = ctx
    ctx = undefined
    await owned?.fiber.dispose()
  })

  it('rejects user and tool-message audio before a stock route adapter runs', async () => {
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CountingAdapter()
    ctx.llm.registerAdapter(['stock'], adapter)
    installAudioRouteGuard(ctx, new Set(['native']))

    for (const options of [request('stock'), request('stock', 'tool')]) {
      await expect(collect(ctx.llm.stream(options))).rejects.toMatchObject({
        code: 'UNSUPPORTED_CONTENT',
      })
    }
    expect(adapter.calls).toBe(0)
  })

  it('passes audio only to an explicitly allowed route', async () => {
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CountingAdapter()
    ctx.llm.registerAdapter(['native'], adapter)
    installAudioRouteGuard(ctx, new Set(['native']))

    const chunks = await collect(ctx.llm.stream(request('native')))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(adapter.calls).toBe(1)
  })

  it('detects audio blocks in every message role and lets audio-free requests reach stock routes', async () => {
    expect(contentHasAudio([{ type: 'text', text: 'no audio' }])).toBe(false)
    expect(contentHasAudio([{ type: 'text', text: 'clip' }, { type: 'audio', attachment: ref }])).toBe(true)
    expect(requestHasAudio(request('stock'))).toBe(true)
    expect(requestHasAudio(request('stock', 'tool'))).toBe(true)

    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new CountingAdapter()
    ctx.llm.registerAdapter(['stock'], adapter)
    installAudioRouteGuard(ctx, new Set(['native']))
    const textOnly: GenerateOptions = {
      provider: 'stock',
      model: 'test-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }
    expect(requestHasAudio(textOnly)).toBe(false)
    const chunks = await collect(ctx.llm.stream(textOnly))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(adapter.calls).toBe(1)
  })
})
