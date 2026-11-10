import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  CredentialProvider,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import {
  LlmRuntime,
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter, type PiAiModelProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalAudioAttachmentStore from '../src/index.js'
import {
  NO_CREDENTIAL_API_KEY,
  OpenAICompatibleAudioPayloadBridge,
  installAudioBridge,
  type OpenAICompatibleRequestCapture,
} from '../src/openai-compatible/index.js'
import { TOOL_RESULT_AUDIO_NOTE, toolResultAudioLabel } from '../src/openai-compatible/wire.js'
import PiAiAudioPlugin, { Config, ROUTE_AUDIO_ENTRY_ID, type Options } from '../src/pi-ai-audio-plugin.js'
import { plainOptions } from '../src/volatile.js'
import { chatCompletionsProfile, mountAudioRoutes, type AudioRoute } from './fixtures/pi-ai-route.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const ROUTE = 'offline-omni'
const REMOTE_URL = 'https://offline.invalid/v1'
const LOOPBACK_URL = 'http://127.0.0.1:9/v1'
const KEY_ENV = 'DSH_NATIVE_AUDIO_OFFLINE_ROUTE_KEY'
const MODEL: PiAiModelProfile = { id: 'omni', name: 'Omni', input: ['text'] }
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const contexts: Context[] = []
const homes: string[] = []
let originalFetch: typeof globalThis.fetch | undefined

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  if (originalFetch !== undefined) globalThis.fetch = originalFetch
  originalFetch = undefined
  vi.unstubAllEnvs()
})

const parseConfig = Config as unknown as (options: Options) => Config

/** Credential service fake that answers `resolve` from a fixed map. */
class FakeCredentials extends CredentialProvider {
  static values = new Map<string, string>()
  readonly resolved: string[] = []

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    this.resolved.push(ref)
    const value = FakeCredentials.values.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }

  override describe(): never { throw new Error('unused') }
  override set(): never { throw new Error('unused') }
  override unset(): never { throw new Error('unused') }
  override readRecord(): never { throw new Error('unused') }
  override describeRecord(): never { throw new Error('unused') }
  override listRecords(): never { throw new Error('unused') }
  override modifyRecord(): never { throw new Error('unused') }
  override deleteRecord(): never { throw new Error('unused') }
}

async function host(options: { credentials?: boolean } = {}): Promise<Context> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-pi-ai-route-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(LocalAudioAttachmentStore, { dshHome: home })
  if (options.credentials === true) await ctx.plugin(FakeCredentials)
  return ctx
}

async function hostWithRoutes(routes: Record<string, AudioRoute>): Promise<Context> {
  const ctx = await host()
  await mountAudioRoutes(ctx, routes)
  return ctx
}

function remoteRoute(audio: AudioRoute['audio'] = {}, models = [MODEL]): AudioRoute {
  vi.stubEnv(KEY_ENV, 'offline-key')
  return { profile: chatCompletionsProfile(REMOTE_URL, models, KEY_ENV), audio }
}

function sse(events: unknown[]): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function completionResponse(): Response {
  const chunk = { id: 'offline', object: 'chat.completion.chunk', created: 0, model: MODEL.id }
  return sse([
    { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Heard clearly.' }, finish_reason: null }] },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    },
  ])
}

function toolResponse(): Response {
  const chunk = { id: 'offline-tool', object: 'chat.completion.chunk', created: 0, model: MODEL.id }
  return sse([
    {
      ...chunk,
      choices: [{
        index: 0,
        delta: {
          reasoning_content: 'I should inspect the render.',
          tool_calls: [{
            index: 0,
            id: 'call-inspect',
            type: 'function',
            function: { name: 'inspect_render', arguments: '{"region":"chorus"}' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    },
  ])
}

function installFakeEndpoint(respond: () => Response = completionResponse) {
  originalFetch = globalThis.fetch
  const calls: Array<{ input: string; init: RequestInit | undefined }> = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init })
    return respond()
  })
  globalThis.fetch = fetch as typeof globalThis.fetch
  return { fetch, calls }
}

interface WireMessage {
  role: string
  content: string | Array<Record<string, unknown>>
  tool_call_id?: string
}

function wireBody(call: { init: RequestInit | undefined } | undefined): { messages: WireMessage[]; tools?: unknown } {
  return JSON.parse(String(call?.init?.body)) as { messages: WireMessage[]; tools?: unknown }
}

function authorization(call: { init: RequestInit | undefined } | undefined): string | null {
  return new Headers(call?.init?.headers).get('authorization')
}

async function collect(values: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const value of values) chunks.push(value)
  return chunks
}

function failureOf(chunks: readonly StreamChunk[]): unknown {
  const finish = chunks.at(-1)
  return finish?.type === 'finish' && finish.reason.kind === 'error' ? finish.reason.failure : undefined
}

function registeredAudioProviders(ctx: Context): ReadonlyMap<string, number> {
  const service = ctx.get('audioAttachments') as unknown as { audioProviders: ReadonlyMap<string, number> }
  return service.audioProviders
}

async function saveWav(ctx: Context) {
  const data = syntheticWav({ sampleRateHz: 48_000, channels: 2, bitsPerSample: 16 })
  return { data, ref: await ctx.get('audioAttachments')!.saveAudio({ data, mediaType: 'audio/wav', name: 'clip.wav' }) }
}

async function saveImage(ctx: Context): Promise<ImageAttachmentRef> {
  return ctx.get('attachments')!.saveImage({ data: PNG_1X1, mediaType: 'image/png' })
}

function textRequest(provider = ROUTE): GenerateOptions {
  return {
    provider,
    model: MODEL.id,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
  }
}

function piAiAdapter(ctx: Context): PiAiAdapter {
  const registrations = ctx.get('llm')!['adapters'] as ReadonlyMap<string, { adapter: unknown }>
  const adapter = [...registrations.values()].map(entry => entry.adapter).find(item => item instanceof PiAiAdapter)
  if (adapter === undefined) throw new Error('no pi-ai adapter registered')
  return adapter as PiAiAdapter
}

function audioHistory(
  provider: string,
  ref: Awaited<ReturnType<typeof saveWav>>['ref'],
): GenerateOptions {
  return {
    provider,
    model: MODEL.id,
    messages: [
      createSystemMessage('Listen before answering.'),
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'render it' }] }),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('render-call'), name: 'render', arguments: '{}' }],
        source: { provider, model: MODEL.id },
      }),
      createToolResultMessage({
        callId: ToolCallId('render-call'),
        content: [{ type: 'text', text: 'Rendered.' }, { type: 'audio', attachment: ref }],
        isError: false,
      }),
    ],
  }
}

describe('native audio on a stock llm-pi-ai route', () => {
  it('sends byte-identical WAV input_audio and leaves streaming, usage and capacity with pi-ai', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await hostWithRoutes({
      [ROUTE]: remoteRoute({}, [{ ...MODEL, contextWindow: 128_000, maxTokens: 8_192 }]),
    })
    const { data, ref } = await saveWav(ctx)

    const chunks = await collect(ctx.get('llm')!.stream({
      provider: ROUTE,
      model: MODEL.id,
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Evaluate this render: ' }, { type: 'audio', attachment: ref }],
      })],
    }))

    expect(endpoint.calls.map(call => call.input)).toEqual([`${REMOTE_URL}/chat/completions`])
    expect(authorization(endpoint.calls[0])).toBe('Bearer offline-key')
    const user = wireBody(endpoint.calls[0]).messages.find(message => message.role === 'user')
    expect(user?.content).toEqual([
      { type: 'text', text: 'Evaluate this render: ' },
      { type: 'input_audio', input_audio: { data: Buffer.from(data).toString('base64'), format: 'wav' } },
    ])
    expect(String(endpoint.calls[0]?.init?.body)).not.toContain('dsh-native-audio:')
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Heard clearly.' })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await expect(ctx.get('llm')!.resolveModelInfo(ROUTE, MODEL.id)).resolves.toMatchObject({
      context: { contextWindow: 128_000 },
      inputModalities: ['text', 'audio'],
    })
  })

  it('keeps tool and reasoning request and stream behavior with pi-ai', async () => {
    const endpoint = installFakeEndpoint(toolResponse)
    const ctx = await hostWithRoutes({
      [ROUTE]: remoteRoute({}, [{
        ...MODEL,
        reasoningEfforts: { off: null, high: 'high' },
      }]),
    })
    const { ref } = await saveWav(ctx)

    const chunks = await collect(ctx.get('llm')!.stream({
      provider: ROUTE,
      model: MODEL.id,
      reasoningEffort: ReasoningEffortId('high'),
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'audio', attachment: ref }] })],
      tools: [{
        name: 'inspect_render',
        description: 'Inspect one render region.',
        parameters: {
          type: 'object',
          properties: { region: { type: 'string' } },
          required: ['region'],
          additionalProperties: false,
        },
      }],
    }))

    expect(wireBody(endpoint.calls[0]).tools).toMatchObject([{ type: 'function', function: { name: 'inspect_render' } }])
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'I should inspect the render.' })
    expect(chunks).toContainEqual({
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'call-inspect', name: 'inspect_render', arguments: '{"region":"chorus"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('places tool result audio by the route setting, defaulting to a follow-up user message', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await hostWithRoutes({
      'in-tool': remoteRoute({ toolResultAudio: 'tool-message' }),
      'in-user': remoteRoute({ toolResultAudio: 'user-message' }),
      'by-default': remoteRoute({}),
    })
    const { data, ref } = await saveWav(ctx)
    const audioData = Buffer.from(data).toString('base64')

    for (const provider of ['in-tool', 'in-user', 'by-default']) {
      const chunks = await collect(ctx.get('llm')!.stream(audioHistory(provider, ref)))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    }

    const inTool = wireBody(endpoint.calls[0]).messages
    expect(inTool.find(message => message.role === 'tool')).toMatchObject({
      tool_call_id: 'render-call',
      content: [
        { type: 'text', text: 'Rendered.' },
        { type: 'input_audio', input_audio: { data: audioData, format: 'wav' } },
      ],
    })
    expect(inTool.at(-1)?.role).toBe('tool')

    for (const call of endpoint.calls.slice(1)) {
      const { messages } = wireBody(call)
      const toolIndex = messages.findIndex(message => message.role === 'tool')
      expect(messages[toolIndex]).toMatchObject({
        tool_call_id: 'render-call',
        content: `Rendered.\n${TOOL_RESULT_AUDIO_NOTE}`,
      })
      expect(messages.slice(toolIndex + 1)).toEqual([{
        role: 'user',
        content: [
          { type: 'text', text: toolResultAudioLabel('render-call') },
          { type: 'input_audio', input_audio: { data: audioData, format: 'wav' } },
        ],
      }])
    }
  })

  it('keeps a file block projected to text next to its audio through the real runtime', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute() })
    const { data, ref } = await saveWav(ctx)
    const file = await ctx.get('attachments')!.saveFile({ data, name: 'clip.wav' })

    const chunks = await collect(ctx.get('llm')!.stream({
      provider: ROUTE,
      model: MODEL.id,
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'file', attachment: file }, { type: 'audio', attachment: ref }],
      })],
    }))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const user = wireBody(endpoint.calls[0]).messages.find(message => message.role === 'user')
    const parts = user?.content as Array<Record<string, unknown>>
    expect(parts.map(part => part['type'])).toEqual(['text', 'input_audio'])
    expect(JSON.stringify(parts[0])).toContain('clip.wav')
  })

  it('leaves a request without audio to the stock path', async () => {
    const endpoint = installFakeEndpoint()
    const patch = vi.spyOn(OpenAICompatibleAudioPayloadBridge.prototype, 'patch')
    const prepare = vi.spyOn(OpenAICompatibleAudioPayloadBridge.prototype, 'prepare')
    try {
      const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute() })
      const chunks = await collect(ctx.get('llm')!.stream(textRequest()))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(endpoint.calls).toHaveLength(1)
      expect(prepare).not.toHaveBeenCalled()
      expect(patch).not.toHaveBeenCalled()
    } finally {
      patch.mockRestore()
      prepare.mockRestore()
    }
  })

  it('tells the user how to turn audio on when the route has it off, before transport', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await hostWithRoutes({ [ROUTE]: { profile: remoteRoute().profile } })
    const { ref } = await saveWav(ctx)

    await expect(collect(ctx.get('llm')!.stream({
      provider: ROUTE,
      model: MODEL.id,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'audio', attachment: ref }] })],
    }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: expect.stringContaining('Settings > Models'),
    })
    expect(endpoint.fetch).not.toHaveBeenCalled()
    await expect(ctx.get('llm')!.listModels(ROUTE)).resolves.toMatchObject([{ inputModalities: ['text'] }])
  })

  it('refuses audio on a route model that does not speak Chat Completions', async () => {
    const endpoint = installFakeEndpoint()
    vi.stubEnv(KEY_ENV, 'offline-key')
    const ctx = await hostWithRoutes({
      [ROUTE]: {
        profile: { api: 'openai-responses', baseURL: REMOTE_URL, apiKeyEnv: KEY_ENV, models: [MODEL] },
        audio: {},
      },
    })
    const { ref } = await saveWav(ctx)

    const chunks = await collect(ctx.get('llm')!.stream({
      provider: ROUTE,
      model: MODEL.id,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'audio', attachment: ref }] })],
    }))

    expect(failureOf(chunks)).toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: expect.stringContaining('openai-responses'),
    })
    expect(endpoint.fetch).not.toHaveBeenCalled()
  })

  it('rejects assistant-message audio before reading it or reaching transport', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute({ toolResultAudio: 'tool-message' }) })
    const { ref } = await saveWav(ctx)
    const readAudio = vi.spyOn(ctx.get('audioAttachments')!, 'readAudio')

    const chunks = await collect(ctx.get('llm')!.stream({
      provider: ROUTE,
      model: MODEL.id,
      messages: [
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'render it' }] }),
        createAssistantMessage({
          content: [{ type: 'audio', attachment: ref }],
          source: { provider: ROUTE, model: MODEL.id },
        }),
      ],
    }))

    expect(failureOf(chunks)).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(readAudio).not.toHaveBeenCalled()
    expect(endpoint.fetch).not.toHaveBeenCalled()
  })

  it('reports a payload that lost an audio occurrence as INVALID_REQUEST', async () => {
    const endpoint = installFakeEndpoint()
    const patch = OpenAICompatibleAudioPayloadBridge.prototype.patch
    // pi-ai never drops user content; simulate it to reach the bridge's exactly-once check.
    const spy = vi.spyOn(OpenAICompatibleAudioPayloadBridge.prototype, 'patch').mockImplementation(
      function (this: OpenAICompatibleAudioPayloadBridge, payload, expected) {
        for (const message of (payload as { messages: Array<Record<string, unknown>> }).messages) {
          if (message['role'] === 'user') message['content'] = 'audio dropped'
        }
        return patch.call(this, payload, expected)
      },
    )
    try {
      const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute() })
      const { ref } = await saveWav(ctx)
      const chunks = await collect(ctx.get('llm')!.stream({
        provider: ROUTE,
        model: MODEL.id,
        messages: [createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Listen: ' }, { type: 'audio', attachment: ref }],
        })],
      }))
      expect(failureOf(chunks)).toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('audio occurrence 0 was not preserved exactly once'),
      })
      expect(endpoint.fetch).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('reports an abort while reading audio as ABORTED', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute() })
    const { ref } = await saveWav(ctx)
    const controller = new AbortController()
    const store = ctx.get('audioAttachments')!
    const read = store.readAudio.bind(store)
    vi.spyOn(store, 'readAudio').mockImplementation(async (...args) => {
      const stored = await read(...args)
      controller.abort(new Error('caller stopped'))
      return stored
    })

    const chunks = await collect(ctx.get('llm')!.stream({
      provider: ROUTE,
      model: MODEL.id,
      signal: controller.signal,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'audio', attachment: ref }] })],
    }))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: expect.stringMatching(/aborted|error/u) } })
    expect(endpoint.fetch).not.toHaveBeenCalled()
  })

  it('reports each sent request and its audio receipts to captureRequest', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await hostWithRoutes({ [ROUTE]: { profile: remoteRoute().profile } })
    ctx.get('audioAttachments')!.registerAudioProvider(ROUTE)
    const captures: OpenAICompatibleRequestCapture[] = []
    const uninstall = installAudioBridge(piAiAdapter(ctx), {
      audioAttachments: ctx.get('audioAttachments')!,
      routeAudio: () => ({ toolResultAudio: 'user-message' }),
      captureRequest: (capture) => { captures.push(capture) },
    })
    const { ref } = await saveWav(ctx)

    await collect(ctx.get('llm')!.stream(audioHistory(ROUTE, ref)))
    uninstall()

    expect(captures).toHaveLength(1)
    expect(captures[0]).toMatchObject({
      url: `${REMOTE_URL}/chat/completions`,
      bodyText: endpoint.calls[0]?.init?.body,
      audioReceipts: [{ sourceRole: 'tool', placement: 'tool-followup', contentPartIndex: 1 }],
    })
    expect(captures[0]?.utf8Bytes).toBe(Buffer.byteLength(String(endpoint.calls[0]?.init?.body), 'utf8'))
  })

  describe('image input', () => {
    const SEES_AND_HEARS: PiAiModelProfile = { ...MODEL, input: ['text', 'image'] }

    it('sends user image and audio together when the model declares image input', async () => {
      const endpoint = installFakeEndpoint()
      const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute({}, [SEES_AND_HEARS]) })
      const { ref } = await saveWav(ctx)
      const image = await saveImage(ctx)

      await collect(ctx.get('llm')!.stream({
        provider: ROUTE,
        model: MODEL.id,
        messages: [createUserMessage({
          source: { kind: 'user' },
          content: [
            { type: 'image', attachment: image },
            { type: 'audio', attachment: ref },
            { type: 'text', text: 'Do these match?' },
          ],
        })],
      }))

      const user = wireBody(endpoint.calls[0]).messages.find(message => message.role === 'user')
      const parts = user?.content as Array<Record<string, unknown>>
      const types = parts.map(part => part['type'])
      expect(types.indexOf('image_url')).toBeGreaterThanOrEqual(0)
      expect(types.indexOf('image_url')).toBeLessThan(types.indexOf('input_audio'))
      expect(JSON.stringify(parts)).toContain('Do these match?')
      await expect(ctx.get('llm')!.listModels(ROUTE)).resolves.toMatchObject([
        { inputModalities: ['text', 'image', 'audio'] },
      ])
    })

    it.each([
      ['user-message', ['tool', 'user', 'user']],
      ['tool-message', ['tool', 'user']],
    ] as const)('places a tool result with image and audio for %s', async (toolResultAudio, roles) => {
      const endpoint = installFakeEndpoint()
      const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute({ toolResultAudio }, [SEES_AND_HEARS]) })
      const { ref } = await saveWav(ctx)
      const image = await saveImage(ctx)
      const callId = ToolCallId('call-1')

      await collect(ctx.get('llm')!.stream({
        provider: ROUTE,
        model: MODEL.id,
        messages: [
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compare.' }] }),
          createAssistantMessage({
            content: [{ type: 'tool-call', id: callId, name: 'read_media', arguments: '{}' }],
            source: { provider: ROUTE, model: MODEL.id },
          }),
          createToolResultMessage({
            callId,
            isError: false,
            content: [
              { type: 'text', text: 'read' },
              { type: 'image', attachment: image },
              { type: 'audio', attachment: ref },
            ],
          }),
        ],
      }))

      const { messages } = wireBody(endpoint.calls[0])
      const after = messages.slice(messages.findIndex(message => message.role === 'tool'))
      expect(after.map(message => message.role)).toEqual(roles)
      expect(JSON.stringify(after.at(-1))).toContain('image_url')
      const audioIndex = after.findIndex(message => JSON.stringify(message).includes('input_audio'))
      expect(after[audioIndex]?.role).toBe(toolResultAudio === 'tool-message' ? 'tool' : 'user')
      expect(JSON.stringify(after.slice(0, audioIndex))).not.toContain('image_url')
    })

    it('keeps a model without image input from sending images', async () => {
      const endpoint = installFakeEndpoint()
      const ctx = await hostWithRoutes({ [ROUTE]: remoteRoute() })
      const image = await saveImage(ctx)

      await expect(ctx.get('llm')!.listModels(ROUTE)).resolves.toMatchObject([{ inputModalities: ['text', 'audio'] }])
      await collect(ctx.get('llm')!.stream({
        provider: ROUTE,
        model: MODEL.id,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] })],
      }))
      expect(JSON.stringify(endpoint.calls[0]?.init?.body ?? '')).not.toContain('image_url')
    })
  })

  describe('credentials', () => {
    const keyless = (baseURL: string): AudioRoute => ({
      profile: chatCompletionsProfile(baseURL, [MODEL]),
      audio: {},
    })

    it.each(['http://127.0.0.1:9/v1', 'http://localhost:9/v1', 'http://[::1]:9/v1'])(
      'sends the placeholder key to the keyless loopback endpoint %s',
      async (baseURL) => {
        const endpoint = installFakeEndpoint()
        const ctx = await hostWithRoutes({ [ROUTE]: keyless(baseURL) })
        const { ref } = await saveWav(ctx)

        const chunks = await collect(ctx.get('llm')!.stream({
          provider: ROUTE,
          model: MODEL.id,
          messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'audio', attachment: ref }] })],
        }))

        expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
        expect(authorization(endpoint.calls[0])).toBe(`Bearer ${NO_CREDENTIAL_API_KEY}`)
      },
    )

    it('never sends the placeholder key to a remote endpoint', async () => {
      const endpoint = installFakeEndpoint()
      const ctx = await hostWithRoutes({ [ROUTE]: keyless(REMOTE_URL) })

      const chunks = await collect(ctx.get('llm')!.stream(textRequest()))

      expect(failureOf(chunks)).toMatchObject({ code: 'PI_AI_ERROR', message: expect.stringContaining('API key') })
      expect(endpoint.fetch).not.toHaveBeenCalled()
    })

    it('uses the configured key on loopback instead of the placeholder', async () => {
      const endpoint = installFakeEndpoint()
      vi.stubEnv(KEY_ENV, 'offline-launch-env-key')
      const ctx = await hostWithRoutes({
        [ROUTE]: { profile: chatCompletionsProfile(LOOPBACK_URL, [MODEL], KEY_ENV), audio: {} },
      })

      await collect(ctx.get('llm')!.stream(textRequest()))

      expect(authorization(endpoint.calls[0])).toBe('Bearer offline-launch-env-key')
    })

    it('resolves apiKeyEnv through the credentials service when one is mounted', async () => {
      FakeCredentials.values = new Map([[KEY_ENV, 'offline-credential-service-key']])
      const endpoint = installFakeEndpoint()
      vi.stubEnv(KEY_ENV, 'ignored-launch-env-key')
      const ctx = await host({ credentials: true })
      await mountAudioRoutes(ctx, {
        [ROUTE]: { profile: chatCompletionsProfile(REMOTE_URL, [MODEL], KEY_ENV), audio: {} },
      })

      await collect(ctx.get('llm')!.stream(textRequest()))

      expect(authorization(endpoint.calls[0])).toBe('Bearer offline-credential-service-key')
      expect((ctx.get('credentials') as FakeCredentials).resolved).toContain(KEY_ENV)
    })
  })
})

describe('pi-ai audio plugin', () => {
  it('parses routes as a volatile reference and rejects an unknown placement', () => {
    const parsed = parseConfig({ routes: { [ROUTE]: {} } })
    expect(typeof (parsed.routes as { get?: unknown }).get).toBe('function')
    expect(plainOptions(parsed)).toEqual({ routes: { [ROUTE]: { toolResultAudio: 'user-message' } } })
    expect(plainOptions(parseConfig({}))).toEqual({ routes: {} })
    expect(() => parseConfig({ routes: { [ROUTE]: { toolResultAudio: 'system-message' as never } } })).toThrow()
  })

  it('allows audio only on enabled routes and restores the stock adapter with its fiber', async () => {
    const ctx = await host()
    await ctx.plugin(PiAi, {
      providers: {
        on: remoteRoute().profile,
        off: remoteRoute().profile,
      },
    })
    const adapter = piAiAdapter(ctx)
    const fiber = await ctx.plugin(PiAiAudioPlugin, { routes: { on: {} } })
    const llm = ctx.get('llm')!

    expect(registeredAudioProviders(ctx).get('on')).toBe(1)
    expect(registeredAudioProviders(ctx).has('off')).toBe(false)
    await expect(llm.listModels('on')).resolves.toMatchObject([{ inputModalities: ['text', 'audio'] }])
    await expect(llm.listModels('off')).resolves.toMatchObject([{ inputModalities: ['text'] }])
    expect(Object.hasOwn(adapter, 'stream')).toBe(true)

    await fiber.dispose()
    expect(registeredAudioProviders(ctx).has('on')).toBe(false)
    expect(Object.hasOwn(adapter, 'stream')).toBe(false)
    await expect(llm.listModels('on')).resolves.toMatchObject([{ inputModalities: ['text'] }])
    expect(ctx.get('audioAttachments')).toBeDefined()
  })

  it('applies the provider card switch without remounting or re-registering routes', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await host()
    await ctx.plugin(PiAi, { providers: { [ROUTE]: remoteRoute().profile } })
    await ctx.plugin(Loader)
    ctx.loader.builtins['pi-ai-audio'] = PiAiAudioPlugin
    const options = { id: ROUTE_AUDIO_ENTRY_ID, name: 'cordis:pi-ai-audio', config: { routes: {} } }
    const entry = ctx.loader.resolve(await ctx.loader.create(options))
    await entry.fiber!.await()
    const fiber = entry.fiber
    const llm = ctx.get('llm')!
    const { ref } = await saveWav(ctx)
    const audioRequest: GenerateOptions = {
      provider: ROUTE,
      model: MODEL.id,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'audio', attachment: ref }] })],
    }
    let routeChanges = 0
    ctx.on('llm/adapters-updated', () => { routeChanges += 1 })

    await expect(collect(llm.stream(audioRequest))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(endpoint.calls).toHaveLength(0)

    await entry.update({ config: { routes: { [ROUTE]: { toolResultAudio: 'tool-message' } } } })
    expect(entry.fiber).toBe(fiber)
    expect(routeChanges).toBe(0)
    expect(registeredAudioProviders(ctx).get(ROUTE)).toBe(1)
    await expect(llm.listModels(ROUTE)).resolves.toMatchObject([{ inputModalities: ['text', 'audio'] }])
    expect((await collect(llm.stream(audioRequest))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(endpoint.calls).toHaveLength(1)
    await collect(llm.stream(audioHistory(ROUTE, ref)))
    expect(wireBody(endpoint.calls[1]).messages.at(-1)?.role).toBe('tool')

    await entry.update({ config: { routes: {} } })
    expect(entry.fiber).toBe(fiber)
    expect(registeredAudioProviders(ctx).has(ROUTE)).toBe(false)
    await expect(collect(llm.stream(audioRequest))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(endpoint.calls).toHaveLength(2)
  })

  it('bridges an llm-pi-ai entry mounted after the plugin, and a route added to it later', async () => {
    const endpoint = installFakeEndpoint()
    const ctx = await host()
    await ctx.plugin(Loader)
    ctx.loader.builtins['pi-ai'] = PiAi
    await ctx.plugin(PiAiAudioPlugin, { routes: { first: {}, second: {} } })
    const options = { id: 'llm-pi-ai', name: 'cordis:pi-ai', config: { providers: { first: remoteRoute().profile } } }
    const entry = ctx.loader.resolve(await ctx.loader.create(options))
    await entry.fiber!.await()
    const llm = ctx.get('llm')!
    const { ref } = await saveWav(ctx)
    const audioRequest = (provider: string): GenerateOptions => ({
      provider,
      model: MODEL.id,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'audio', attachment: ref }] })],
    })

    expect((await collect(llm.stream(audioRequest('first')))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })

    await entry.update({ config: { providers: { first: remoteRoute().profile, second: remoteRoute().profile } } })
    expect((await collect(llm.stream(audioRequest('second')))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })

    expect(endpoint.calls).toHaveLength(2)
    for (const call of endpoint.calls) expect(JSON.stringify(wireBody(call))).toContain('input_audio')
  })
})
