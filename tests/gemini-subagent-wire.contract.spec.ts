import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GeminiPlugin, { GEMINI_AUDIO_PROVIDER } from '../src/gemini-plugin.js'
import type { GeminiGenerateContentRequest } from '../src/gemini/index.js'
import { apply as applyReadAudio, inject as readAudioInject } from '../src/read-audio-tool.js'
import {
  createAgentHarness,
  eventually,
  loadStoredSession,
  parkParent,
} from './fixtures/dsh-harness.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const TEST_KEY_ENV = 'DSH_NATIVE_AUDIO_OFFLINE_GEMINI_KEY'
const TEST_KEY = 'offline-contract-key-not-a-secret'
const PERSONA = 'Offline native-audio wire contract persona.'
const STREAM_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'

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

type GeminiResponsePart = { text: string } | { functionCall: { id: string; name: string; args: object } }

function sseResponse(parts: GeminiResponsePart[]): Response {
  const event = {
    responseId: 'offline-subagent-response',
    modelVersion: 'gemini-3.8-flash-offline-fixture',
    candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5 },
  }
  return new Response(`data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

interface FetchCall {
  input: string | URL
  init: RequestInit | undefined
}

/**
 * Fake Gemini Developer API: Files metadata/upload endpoints plus
 * `streamGenerateContent`, which answers each call from `answers` in order.
 */
function installFakeGemini(answers: GeminiResponsePart[][]) {
  originalFetch = globalThis.fetch
  originalKey = process.env[TEST_KEY_ENV]
  process.env[TEST_KEY_ENV] = TEST_KEY
  const calls: FetchCall[] = []
  const state: { remoteFile?: Record<string, unknown>; uploadName?: string; uploadedBytes?: Uint8Array } = {}
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init })
    const url = String(input)
    if (init?.method === 'GET' && url.includes('/v1beta/files/')) {
      return state.remoteFile === undefined
        ? new Response('', { status: 404 })
        : new Response(JSON.stringify(state.remoteFile), { status: 200 })
    }
    if (url.endsWith('/upload/v1beta/files')) {
      const body = JSON.parse(String(init?.body)) as { file: { name: string } }
      state.uploadName = body.file.name
      return new Response('', {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.test/gemini-subagent' },
      })
    }
    if (url === 'https://upload.test/gemini-subagent') {
      const uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer())
      state.uploadedBytes = uploaded
      const sha256 = createHash('sha256').update(uploaded).digest('hex')
      state.remoteFile = {
        name: state.uploadName,
        mimeType: 'audio/wav',
        sizeBytes: String(uploaded.byteLength),
        expirationTime: '2099-01-01T00:00:00Z',
        sha256Hash: Buffer.from(sha256, 'utf8').toString('base64'),
        uri: `https://generativelanguage.googleapis.com/v1beta/${state.uploadName}`,
        state: 'ACTIVE',
      }
      return new Response(JSON.stringify({ file: state.remoteFile }), { status: 200 })
    }
    if (url.includes(':streamGenerateContent')) {
      const answer = answers.shift()
      if (answer === undefined) throw new Error('fake Gemini script exhausted')
      return sseResponse(answer)
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  globalThis.fetch = fetch as typeof globalThis.fetch
  const streamBodies = (): GeminiGenerateContentRequest[] => calls
    .filter(call => String(call.input).includes(':streamGenerateContent'))
    .map(call => JSON.parse(String(call.init?.body)) as GeminiGenerateContentRequest)
  return { fetch, calls, state, streamBodies }
}

async function bootGemini(options: { audioTransport?: 'inline' | 'files'; withReadAudio?: boolean } = {}) {
  ctx = await createAgentHarness({
    home: home!,
    persona: PERSONA,
    before: async (harnessCtx) => {
      await harnessCtx.plugin(GeminiPlugin, {
        apiKeyEnv: TEST_KEY_ENV,
        ...(options.audioTransport === undefined ? {} : { audioTransport: options.audioTransport }),
      })
      if (options.withReadAudio === true) {
        await harnessCtx.plugin({ name: 'read-audio', inject: [...readAudioInject], apply: applyReadAudio })
      }
    },
  })
  return ctx
}

describe('real DSH 0.2 Subagent to Gemini final-wire contract', () => {
  it('materializes a durable WAV prompt in the fake transport request without inheriting Main history', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-gemini-subagent-'))
    const gemini = installFakeGemini([[{ text: 'The offline render is balanced.' }]])
    const ctx = await bootGemini()

    const parent = await ctx.agentLoop.create(SessionId('gemini-wire-parent'), {
      provider: GEMINI_AUDIO_PROVIDER,
      model: 'gemini-3.8-flash',
    })
    parkParent(ctx, parent)

    const parentSentinel = 'PARENT_MUST_NOT_REACH_GEMINI_WIRE_7c43f0'
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
      name: 'subagent-wire.wav',
    })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'offline Gemini audio wire',
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
      gemini.streamBodies().length === 1 && ctx.agents.get(started.childId) === undefined)

    // Files transport: metadata miss, resumable upload start, upload finalize, then generation.
    expect(gemini.fetch).toHaveBeenCalledTimes(4)
    expect(String(gemini.calls[3]?.input)).toBe(STREAM_URL)
    const headers = new Headers(gemini.calls[3]?.init?.headers)
    expect(headers.get('x-goog-api-key')).toBe(TEST_KEY)
    const [body] = gemini.streamBodies()
    if (body === undefined) throw new Error('Gemini final wire was not sent')
    expect(JSON.stringify(body)).not.toContain(parentSentinel)
    // The loop's leading system-role message becomes Gemini's systemInstruction.
    expect(body.systemInstruction?.parts.map(part => part.text).join('')).toContain(PERSONA)
    expect(JSON.stringify(body.contents)).not.toContain(PERSONA)
    const audioContents = body.contents.filter(content =>
      content.parts.some(part => 'fileData' in part))
    expect(audioContents).toHaveLength(1)
    expect(audioContents[0]?.role).toBe('user')
    expect(audioContents[0]?.parts[0]).toEqual({ text: 'Evaluate only this render.' })
    const audioPart = audioContents[0]?.parts[1]
    if (audioPart === undefined || !('fileData' in audioPart)) {
      throw new Error('Gemini final wire did not contain the expected fileData part')
    }
    expect(audioPart.fileData.mimeType).toBe('audio/wav')
    expect(audioPart.fileData.fileUri).toBe(gemini.state.remoteFile?.['uri'])
    expect(gemini.state.uploadedBytes).toEqual(wav)

    const persisted = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(persisted.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'audio'
        && block.attachment.attachmentId === ref.attachmentId))).toBe(true)
  }, 20_000)

  it('sends a child read_audio result as functionResponse followed by the audio part in one user content', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-gemini-read-'))
    const wavPath = join(home, 'tool-render.wav')
    const wav = syntheticWav({ sampleRateHz: 44_100, channels: 2, bitsPerSample: 16 })
    await writeFile(wavPath, wav)
    const gemini = installFakeGemini([
      [{ functionCall: { id: 'read-audio-1', name: 'read_audio', args: { file_path: wavPath } } }],
      [{ text: 'The tool render is balanced.' }],
    ])
    const ctx = await bootGemini({ audioTransport: 'inline', withReadAudio: true })

    const parent = await ctx.agentLoop.create(SessionId('gemini-read-parent'), {
      provider: GEMINI_AUDIO_PROVIDER,
      model: 'gemini-3.8-flash',
    })
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'offline Gemini read_audio wire',
      request: { parent, prompt: [{ type: 'text', text: `Listen to ${wavPath}.` }] },
      signal: new AbortController().signal,
    })

    await eventually('child tool turn and activation release', () =>
      gemini.streamBodies().length === 2 && ctx.agents.get(started.childId) === undefined)

    // Inline transport never touches the Files API.
    expect(gemini.calls.every(call => String(call.input) === STREAM_URL)).toBe(true)
    const [first, second] = gemini.streamBodies()
    if (first === undefined || second === undefined) throw new Error('expected two Gemini requests')
    expect(first.tools?.[0]?.functionDeclarations.map(tool => tool.name)).toContain('read_audio')
    expect(first.systemInstruction?.parts.map(part => part.text).join('')).toContain(PERSONA)
    expect(second.systemInstruction).toEqual(first.systemInstruction)

    const callIndex = second.contents.findIndex(content =>
      content.role === 'model' && content.parts.some(part => 'functionCall' in part))
    expect(callIndex).toBeGreaterThanOrEqual(0)
    const resultContent = second.contents[callIndex + 1]
    expect(resultContent?.role).toBe('user')
    expect(resultContent?.parts).toHaveLength(2)
    const [response, audio] = resultContent!.parts
    if (response === undefined || !('functionResponse' in response)) {
      throw new Error('tool result content does not start with functionResponse')
    }
    expect(response.functionResponse.id).toBe('read-audio-1')
    expect(response.functionResponse.name).toBe('read_audio')
    expect(JSON.stringify(response.functionResponse.response)).toContain('audio/wav PCM audio')
    if (audio === undefined || !('inlineData' in audio)) {
      throw new Error('functionResponse is not followed by the inline audio part')
    }
    expect(audio.inlineData.mimeType).toBe('audio/wav')
    expect(new Uint8Array(Buffer.from(audio.inlineData.data, 'base64'))).toEqual(wav)

    const persisted = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const toolResult = persisted.events.find(event => event.type === 'tool/result')
    expect(toolResult?.type === 'tool/result'
      && toolResult.data.message.content.map(block => block.type)).toEqual(['text', 'audio'])
  }, 20_000)
})
