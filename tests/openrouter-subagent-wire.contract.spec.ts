import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TOOL_RESULT_AUDIO_NOTE, toolResultAudioLabel, type ToolResultAudioPlacement } from '../src/openai-compatible/wire.js'
import { apply as applyReadAudio, inject as readAudioInject } from '../src/read-audio-tool.js'
import {
  createAgentHarness,
  eventually,
  loadStoredSession,
  parkParent,
} from './fixtures/dsh-harness.js'
import { mountAudioRoutes } from './fixtures/pi-ai-route.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const TEST_KEY_ENV = 'DSH_NATIVE_AUDIO_OFFLINE_OPENROUTER_KEY'
const TEST_KEY = 'offline-contract-key-not-a-secret'
const MODEL = 'google/gemini-3.7-flash'
const OPENROUTER_ROUTE = 'openrouter'

let ctx: Context | undefined
let home: string | undefined
let originalFetch: typeof globalThis.fetch | undefined
let originalKey: string | undefined

afterEach(async () => {
  const ownedContext = ctx
  const ownedHome = home
  ctx = undefined
  home = undefined
  try {
    await ownedContext?.fiber.dispose()
  } finally {
    if (ownedHome !== undefined) await rm(ownedHome, { recursive: true, force: true })
    if (originalFetch !== undefined) globalThis.fetch = originalFetch
    originalFetch = undefined
    if (originalKey === undefined) delete process.env[TEST_KEY_ENV]
    else process.env[TEST_KEY_ENV] = originalKey
    originalKey = undefined
  }
})

type Delta = Record<string, unknown>

function completionResponse(delta: Delta, finishReason: 'stop' | 'tool_calls'): Response {
  const events = [
    {
      id: 'offline-openrouter-subagent',
      object: 'chat.completion.chunk',
      created: 0,
      model: MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }],
    },
    {
      id: 'offline-openrouter-subagent',
      object: 'chat.completion.chunk',
      created: 0,
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    },
  ]
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Fake OpenRouter Chat Completions endpoint answering each call from `answers` in order. */
function installFakeOpenRouter(answers: Array<() => Response>) {
  originalFetch = globalThis.fetch
  originalKey = process.env[TEST_KEY_ENV]
  process.env[TEST_KEY_ENV] = TEST_KEY
  const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = []
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init })
    const answer = answers.shift()
    if (answer === undefined) throw new Error('fake OpenRouter script exhausted')
    return answer()
  })
  globalThis.fetch = fetch as typeof globalThis.fetch
  return { fetch, calls }
}

async function bootOpenRouter(
  withReadAudio = false,
  model: string = MODEL,
  toolResultAudio?: ToolResultAudioPlacement,
) {
  ctx = await createAgentHarness({
    home: home!,
    persona: 'Offline OpenRouter native-audio wire contract.',
    before: async (harnessCtx) => {
      await mountAudioRoutes(harnessCtx, {
        [OPENROUTER_ROUTE]: {
          profile: { apiKeyEnv: TEST_KEY_ENV, models: [{ id: model, input: ['text', 'image'] }] },
          audio: toolResultAudio === undefined ? {} : { toolResultAudio },
        },
      })
      if (withReadAudio) {
        await harnessCtx.plugin({ name: 'read-audio', inject: [...readAudioInject], apply: applyReadAudio })
      }
    },
  })
  return ctx
}

describe('real DSH 0.2 Subagent to OpenRouter final-wire contract', () => {
  it('puts a durable WAV prompt in input_audio without inheriting Main history', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-openrouter-subagent-'))
    const openrouter = installFakeOpenRouter([
      () => completionResponse({ content: 'The offline render is balanced.' }, 'stop'),
    ])
    const ctx = await bootOpenRouter()

    const parent = await ctx.agentLoop.create(SessionId('openrouter-wire-parent'), {
      provider: OPENROUTER_ROUTE,
      model: MODEL,
    })
    parkParent(ctx, parent)

    const parentSentinel = 'PARENT_MUST_NOT_REACH_OPENROUTER_WIRE_7c43f0'
    parent.session.append('turn/start', { turn: 0 })
    parent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: parentSentinel }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    const wav = syntheticWav({
      format: 'extensible',
      bitsPerSample: 24,
      sampleRateHz: 48_000,
      channels: 2,
      channelMask: 3,
    })
    const ref = await ctx.audioAttachments.saveAudio({
      data: wav,
      mediaType: 'audio/wav',
      name: 'subagent-openrouter-wire.wav',
    })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'offline OpenRouter audio wire',
      request: {
        parent,
        prompt: [
          { type: 'text', text: 'Evaluate only this render.' },
          { type: 'audio', attachment: ref },
        ],
      },
      signal: new AbortController().signal,
    })

    await eventually('child final wire and activation release', () =>
      openrouter.calls.length === 1 && ctx.agents.get(started.childId) === undefined)

    expect(openrouter.fetch).toHaveBeenCalledTimes(1)
    expect(String(openrouter.calls[0]?.input)).toBe('https://openrouter.ai/api/v1/chat/completions')
    const headers = new Headers(openrouter.calls[0]?.init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`)
    expect(headers.get('user-agent')).toContain('deepseek-harness/')
    const body = JSON.parse(String(openrouter.calls[0]?.init?.body)) as {
      messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
    }
    expect(JSON.stringify(body)).not.toContain(parentSentinel)
    expect(JSON.stringify(body)).not.toContain('dsh-native-audio:')
    expect(body.messages[0]?.role).toBe('system')
    const user = body.messages.find(message => message.role === 'user'
      && Array.isArray(message.content)
      && message.content.some(part => part['type'] === 'input_audio'))
    if (user === undefined || !Array.isArray(user.content)) {
      throw new Error('OpenRouter final wire did not contain multipart user content with audio')
    }
    expect(user.content[0]).toEqual({ type: 'text', text: 'Evaluate only this render.' })
    const audio = user.content[1] as { input_audio?: { data?: string; format?: string } } | undefined
    expect(audio?.input_audio?.format).toBe('wav')
    expect(new Uint8Array(Buffer.from(audio?.input_audio?.data ?? '', 'base64'))).toEqual(wav)

    const persisted = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(persisted.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'audio'
        && block.attachment.attachmentId === ref.attachmentId))).toBe(true)
  }, 20_000)

  it.each([
    { model: 'qwen/qwen3.8-omni-flash', placement: 'tool-message' },
    { model: 'google/gemini-3.7-flash', placement: 'user-message' },
  ] as const)('sends a child read_audio result for $model with $placement placement', async ({ model, placement }) => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-openrouter-read-'))
    const wavPath = join(home, 'tool-render.wav')
    const wav = syntheticWav({ sampleRateHz: 44_100, channels: 2, bitsPerSample: 16 })
    await writeFile(wavPath, wav)
    const openrouter = installFakeOpenRouter([
      () => completionResponse({
        tool_calls: [{
          index: 0,
          id: 'read-audio-1',
          type: 'function',
          function: { name: 'read_audio', arguments: JSON.stringify({ file_path: wavPath }) },
        }],
      }, 'tool_calls'),
      () => completionResponse({ content: 'The tool render is balanced.' }, 'stop'),
    ])
    const ctx = await bootOpenRouter(true, model, placement)

    const parent = await ctx.agentLoop.create(SessionId(`openrouter-read-parent-${placement}`), {
      provider: OPENROUTER_ROUTE,
      model,
    })
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'offline OpenRouter read_audio wire',
      request: { parent, prompt: [{ type: 'text', text: `Listen to ${wavPath}.` }] },
      signal: new AbortController().signal,
    })
    await eventually('child tool turn and activation release', () =>
      openrouter.calls.length === 2 && ctx.agents.get(started.childId) === undefined)

    expect(openrouter.fetch).toHaveBeenCalledTimes(2)
    type WireMessage = {
      role: string
      content: string | Array<Record<string, unknown>> | null
      tool_call_id?: string
      tool_calls?: Array<{ id: string; function: { name: string } }>
    }
    const [first, second] = openrouter.calls.map(call => JSON.parse(String(call.init?.body)) as {
      model: string
      messages: WireMessage[]
    })
    if (first === undefined || second === undefined) throw new Error('expected two OpenRouter requests')
    expect(first.model).toBe(model)
    expect(second.model).toBe(model)
    expect(JSON.stringify(first)).not.toContain('input_audio')
    const secondText = JSON.stringify(second)
    expect(secondText).not.toContain('dsh-native-audio:')
    expect(secondText).not.toContain('\uE000')

    const callIndex = second.messages.findIndex(message => message.role === 'assistant'
      && message.tool_calls?.some(call => call.id === 'read-audio-1' && call.function.name === 'read_audio'))
    expect(callIndex).toBeGreaterThanOrEqual(0)
    const tool = second.messages[callIndex + 1]
    expect(tool?.role).toBe('tool')
    expect(tool?.tool_call_id).toBe('read-audio-1')

    const audioParts: Array<Record<string, unknown>> = []
    if (placement === 'tool-message') {
      if (!Array.isArray(tool?.content)) throw new Error('tool message content is not multipart')
      expect(tool.content.map(part => part['type'])).toEqual(['text', 'input_audio'])
      expect(String(tool.content[0]?.['text'])).toContain('audio/wav PCM audio')
      audioParts.push(tool.content[1]!)
      // The tool message ends the history; no user message repeats the audio.
      expect(second.messages.slice(callIndex + 2)).toEqual([])
    } else {
      expect(typeof tool?.content).toBe('string')
      expect(tool?.content).toContain('audio/wav PCM audio')
      expect(tool?.content).toContain(TOOL_RESULT_AUDIO_NOTE)
      expect(second.messages.slice(callIndex + 2)).toHaveLength(1)
      const followup = second.messages[callIndex + 2]
      expect(followup?.role).toBe('user')
      if (!Array.isArray(followup?.content)) throw new Error('follow-up user message is not multipart')
      expect(followup.content[0]).toEqual({ type: 'text', text: toolResultAudioLabel('read-audio-1') })
      expect(followup.content.map(part => part['type'])).toEqual(['text', 'input_audio'])
      audioParts.push(followup.content[1]!)
    }
    expect(second.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part['type'] === 'input_audio')
      : [])).toEqual(audioParts)
    const audio = audioParts[0] as { input_audio?: { data?: string; format?: string } }
    expect(audio.input_audio?.format).toBe('wav')
    expect(new Uint8Array(Buffer.from(audio.input_audio?.data ?? '', 'base64'))).toEqual(wav)

    const persisted = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const toolResult = persisted.events.find(event => event.type === 'tool/result')
    expect(toolResult?.type === 'tool/result'
      && toolResult.data.message.content.map(block => block.type)).toEqual(['text', 'audio'])
    const turnEnd = persisted.events.findLast(event => event.type === 'turn/end')
    expect(turnEnd?.data).toMatchObject({ reason: { kind: 'completed' } })
    expect(persisted.events.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text'
        && block.text === 'The tool render is balanced.'))).toBe(true)
  }, 20_000)
})
