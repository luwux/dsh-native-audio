import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { LlmRuntime, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GeminiPlugin, {
  Config,
  DEFAULT_GEMINI_API_KEY_ENV,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODELS,
  GEMINI_AUDIO_ENTRY_ID,
  GEMINI_AUDIO_PROVIDER,
  resolveGeminiPluginConfig,
  type Options,
} from '../src/gemini-plugin.js'
import { GEMINI_INLINE_REQUEST_MAX_BYTES } from '../src/gemini/index.js'
import LocalAudioAttachmentStore from '../src/index.js'
import { plainOptions } from '../src/volatile.js'

const contexts: Context[] = []
let originalFetch: typeof globalThis.fetch | undefined

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (originalFetch !== undefined) globalThis.fetch = originalFetch
  originalFetch = undefined
  vi.unstubAllEnvs()
})

const ALL_LEVEL_EFFORTS = [
  { id: 'minimal', name: 'Minimal' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

/**
 * `Config` types the parsed references; callers and the Loader pass plain
 * values, which the schema turns into references before `apply` runs.
 */
const parseConfig = Config as unknown as (options: Options) => Config

async function host(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalAudioAttachmentStore, { dshHome: '/tmp/dsh-native-audio-plugin-test' })
  return ctx
}

/** Mount the plugin as a Loader entry so config edits take the Loader's volatile path. */
async function mountEntry(ctx: Context, config: Options) {
  await ctx.plugin(Loader)
  ctx.loader.builtins['gemini-audio'] = GeminiPlugin
  const options = { id: GEMINI_AUDIO_ENTRY_ID, name: 'cordis:gemini-audio', config }
  const id = await ctx.loader.create(options)
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  return entry
}

function sseResponse(text: string): Response {
  const events = [
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] },
    { candidates: [{ index: 0, finishReason: 'STOP' }] },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(values: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const value of values) chunks.push(value)
  return chunks
}

describe('Gemini Cordis plugin face', () => {
  it('registers one audio-capable configurable route and releases it with its fiber', async () => {
    const ctx = await host()

    const fiber = await ctx.plugin(GeminiPlugin, ({}))
    const llm = ctx.get('llm')
    expect(llm).toBeDefined()
    expect(llm!.listProviders()).toEqual([{
      id: GEMINI_AUDIO_PROVIDER,
      name: 'Google Gemini Native Audio',
    }])
    expect(llm!.listConfigurableProviders()).toEqual([{
      provider: GEMINI_AUDIO_PROVIDER,
      displayName: 'Google Gemini Native Audio',
      settingsNs: GEMINI_AUDIO_ENTRY_ID,
      settingsPath: [],
    }])
    await expect(llm!.listModels(GEMINI_AUDIO_PROVIDER)).resolves.toEqual([{
      provider: GEMINI_AUDIO_PROVIDER,
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      description: 'General multimodal Gemini model with native audio understanding.',
      inputModalities: ['text', 'audio'],
    }])
    await expect(llm!.resolveModelInfo(GEMINI_AUDIO_PROVIDER, 'gemini-3.8-flash')).resolves.toMatchObject({
      id: 'gemini-3.8-flash',
      reasoning: { efforts: ALL_LEVEL_EFFORTS },
    })

    await fiber.dispose()
    expect(llm!.listProviders()).toEqual([])
    expect(llm!.listConfigurableProviders()).toEqual([])
    expect(ctx.get('audioAttachments')).toBeDefined()
  })

  it('parses every Config field as a volatile reference with thinking-level and includeThoughts defaults', () => {
    const parsed = parseConfig({})
    for (const value of Object.values(parsed)) {
      expect(typeof (value as { get?: unknown }).get).toBe('function')
    }
    expect(plainOptions(parsed)).toEqual({
      apiKeyEnv: DEFAULT_GEMINI_API_KEY_ENV,
      maxInlineRequestBytes: GEMINI_INLINE_REQUEST_MAX_BYTES,
      audioTransport: 'files',
      includeThoughts: true,
      models: [{
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        description: 'General multimodal Gemini model with native audio understanding.',
        thinkingLevels: ['minimal', 'low', 'medium', 'high'],
      }],
    })
    expect(DEFAULT_GEMINI_MODELS[0]?.thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(() => parseConfig({ models: [{ id: 'bad', thinkingLevels: ['max' as never] }] })).toThrow()
  })

  it('resolves plain options with defaults and rejects invalid values', async () => {
    const ctx = await host()
    vi.stubEnv('GEMINI_BASE_URL', undefined)
    expect(resolveGeminiPluginConfig(ctx, {})).toEqual({
      apiKeyEnv: DEFAULT_GEMINI_API_KEY_ENV,
      baseURL: DEFAULT_GEMINI_BASE_URL,
      maxInlineRequestBytes: GEMINI_INLINE_REQUEST_MAX_BYTES,
      audioTransport: 'files',
      includeThoughts: true,
      models: [{
        id: 'gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        description: 'General multimodal Gemini model with native audio understanding.',
        thinkingLevels: ['minimal', 'low', 'medium', 'high'],
      }],
    })
    expect(resolveGeminiPluginConfig(ctx, {
      apiKeyEnv: 'OFFLINE_GEMINI_KEY',
      baseURL: 'https://offline.invalid',
      audioTransport: 'inline',
      includeThoughts: false,
      models: [{ id: 'leveled', thinkingLevels: ['low', 'low', 'high'], defaultThinkingLevel: 'high' }],
    })).toMatchObject({
      apiKeyEnv: 'OFFLINE_GEMINI_KEY',
      baseURL: 'https://offline.invalid',
      audioTransport: 'inline',
      includeThoughts: false,
      models: [{ id: 'leveled', thinkingLevels: ['low', 'high'], defaultThinkingLevel: 'high' }],
    })

    expect(() => resolveGeminiPluginConfig(ctx, {
      models: [{ id: 'leveled', thinkingLevels: ['low'], defaultThinkingLevel: 'high' }],
    })).toThrow('default thinking level must be one of its thinkingLevels')
    expect(() => resolveGeminiPluginConfig(ctx, {
      models: [{ id: 'unleveled', defaultThinkingLevel: 'low' }],
    })).toThrow('default thinking level must be one of its thinkingLevels')
    expect(() => resolveGeminiPluginConfig(ctx, { models: [{ id: 'dup' }, { id: 'dup' }] }))
      .toThrow('duplicate Gemini model "dup"')
    expect(() => resolveGeminiPluginConfig(ctx, { maxInlineRequestBytes: 0 }))
      .toThrow('maxInlineRequestBytes')
    expect(() => resolveGeminiPluginConfig(ctx, { baseURL: '' })).toThrow('baseURL')
  })

  it('fails composition for an invalid default thinking level', async () => {
    const ctx = await host()
    const fiber = ctx.plugin(GeminiPlugin, ({
      models: [{ id: 'leveled', thinkingLevels: ['low'], defaultThinkingLevel: 'high' }],
    }))
    await expect(fiber).rejects.toThrow('default thinking level must be one of its thinkingLevels')
    expect(ctx.get('llm')!.listProviders()).toEqual([])
  })

  it('applies Loader volatile updates to the next model query and request without remounting', async () => {
    const ctx = await host()
    vi.stubEnv('OFFLINE_GEMINI_KEY', 'fake-offline-key')
    const urls: string[] = []
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      return sseResponse('ok')
    }) as typeof globalThis.fetch
    const entry = await mountEntry(ctx, {
      apiKeyEnv: 'OFFLINE_GEMINI_KEY',
      baseURL: 'https://first.offline.invalid',
      audioTransport: 'inline',
      models: [{ id: 'initial-audio-model', name: 'Initial Audio Model' }],
    })
    const fiber = entry.fiber
    const llm = ctx.get('llm')!
    expect(llm.listConfigurableProviders()).toEqual([{
      provider: GEMINI_AUDIO_PROVIDER,
      displayName: 'Google Gemini Native Audio',
      settingsNs: GEMINI_AUDIO_ENTRY_ID,
      settingsPath: [],
    }])
    await expect(llm.listModels(GEMINI_AUDIO_PROVIDER)).resolves.toMatchObject([
      { id: 'initial-audio-model', inputModalities: ['text', 'audio'] },
    ])
    expect(await llm.resolveModelInfo(GEMINI_AUDIO_PROVIDER, 'initial-audio-model'))
      .not.toHaveProperty('reasoning')

    const request = {
      provider: GEMINI_AUDIO_PROVIDER,
      model: 'next-audio-model',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
    }
    await collect(llm.stream({ ...request, model: 'initial-audio-model' }))
    let routeChanges = 0
    ctx.on('llm/adapters-updated', () => { routeChanges += 1 })

    await entry.update({
      config: {
        apiKeyEnv: 'OFFLINE_GEMINI_KEY',
        baseURL: 'https://next.offline.invalid',
        audioTransport: 'inline',
        models: [{ id: 'next-audio-model', thinkingLevels: ['low', 'high'], defaultThinkingLevel: 'low' }],
      },
    })
    expect(entry.fiber).toBe(fiber)
    await expect(llm.listModels(GEMINI_AUDIO_PROVIDER)).resolves.toMatchObject([{ id: 'next-audio-model' }])
    await expect(llm.resolveModelInfo(GEMINI_AUDIO_PROVIDER, 'next-audio-model')).resolves.toMatchObject({
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'low',
      },
    })
    await collect(llm.stream(request))
    expect(urls).toEqual([
      'https://first.offline.invalid/v1beta/models/initial-audio-model:streamGenerateContent?alt=sse',
      'https://next.offline.invalid/v1beta/models/next-audio-model:streamGenerateContent?alt=sse',
    ])
    expect(routeChanges).toBe(0)

    // A schema-invalid edit is refused by the Loader and leaves the live values in place.
    await entry.update({ config: { maxInlineRequestBytes: 0 } })
    expect(entry.fiber).toBe(fiber)
    expect(routeChanges).toBe(0)
    await expect(llm.listModels(GEMINI_AUDIO_PROVIDER)).resolves.toMatchObject([{ id: 'next-audio-model' }])

    // Removing the entry releases the route and is observed as a route change.
    await ctx.loader.remove(GEMINI_AUDIO_ENTRY_ID)
    expect(routeChanges).toBeGreaterThan(0)
    expect(llm.listProviders()).toEqual([])
    expect(llm.listConfigurableProviders()).toEqual([])
  })
})
