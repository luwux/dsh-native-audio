import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, createUserMessage, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import FileIngress, { attachFileAudio, type SkippedAudioFile } from '../src/file-ingress.js'
import { LocalAudioAttachmentStore } from '../src/index.js'
import { apply as applyReadAudio, inject as readAudioInject } from '../src/read-audio-tool.js'
import {
  FixtureWorkingDirectory,
  createAgentHarness,
  eventually,
  loadStoredSession,
  parkParent,
  ScriptedAdapter,
  textResponse,
} from './fixtures/dsh-harness.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const PROVIDER = 'recording'
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

async function encodeMp3(directory: string, name: string): Promise<string> {
  const source = join(directory, `${name}.source.wav`)
  const output = join(directory, name)
  await writeFile(source, syntheticWav({ sampleRateHz: 44_100, channels: 1, frames: 44_100 }))
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', source, '-c:a', 'libmp3lame', output])
  return output
}

async function executeReadAudio(ctx: Context, callId: string, filePath: string): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId(callId), name: 'read_audio', arguments: JSON.stringify({ file_path: filePath }) }],
  })
  expect(batch.results.map(entry => entry.callId)).toEqual([ToolCallId(callId)])
  return batch.results[0]!.result
}

function blockTypes(content: readonly ContentBlock[] | undefined): string[] {
  return content?.map(block => block.type) ?? []
}

/** The durable `user/message` events whose content holds a file block. */
function fileMessages(events: readonly SessionEvent[]): UserMessage[] {
  return events.flatMap(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'file')
    ? [event.data]
    : [])
}

function requestAudioCount(request: GenerateOptions | undefined): number {
  return request?.messages.reduce((count, message) =>
    count + message.content.filter(block => block.type === 'audio').length, 0) ?? 0
}

describe('WAV file ingress and read_audio', () => {
  let ctx: Context | undefined
  let home: string | undefined

  afterEach(async () => {
    const ownedContext = ctx
    const ownedHome = home
    ctx = undefined
    home = undefined
    try {
      await ownedContext?.fiber.dispose()
    } finally {
      if (ownedHome !== undefined) await rm(ownedHome, { recursive: true, force: true })
    }
  })

  async function boot(adapter: ScriptedAdapter, prefix: string): Promise<Context> {
    home = await mkdtemp(join(tmpdir(), prefix))
    const harness = await createAgentHarness({
      home,
      before: async (harnessCtx) => { await harnessCtx.plugin(FileIngress) },
    })
    ctx = harness
    harness.llm.registerAdapter([PROVIDER], adapter)
    harness.effect(() => harness.audioAttachments.registerAudioProvider(PROVIDER), 'register offline audio provider')
    return harness
  }

  it('follows a Main user WAV file with an AudioBlock of the same bytes in the durable message and request', async () => {
    const adapter = new ScriptedAdapter([textResponse('heard the upload')])
    const ctx = await boot(adapter, 'dsh-native-audio-ingress-main-')
    const wav = syntheticWav({ sampleRateHz: 48_000, channels: 1, bitsPerSample: 16 })
    const file = await ctx.attachments.saveFile({ data: wav, name: 'render.wav' })

    const main = await ctx.agentLoop.create(SessionId('ingress-main'), { provider: PROVIDER, model: 'scripted-model' })
    const prompt = createUserMessage({
      content: [
        { type: 'text', text: 'Describe this upload.' },
        { type: 'file', attachment: file },
      ],
      source: { kind: 'user' },
    })
    main.followup(prompt)
    await adapter.whenRequested(1)
    await main.whenIdle()
    await ctx.sessions.flush(main.session)

    const [durable] = fileMessages((await loadStoredSession(ctx.sessionPersistence, main.id)).events)
    expect(durable?.id).toBe(prompt.id)
    expect(durable?.source).toEqual({ kind: 'user' })
    expect(blockTypes(durable?.content)).toEqual(['text', 'file', 'audio'])
    expect(durable?.content[1]).toEqual({ type: 'file', attachment: file })
    const audio = durable?.content[2]
    if (audio?.type !== 'audio') throw new Error('durable message has no AudioBlock')
    expect(audio.attachment).toMatchObject({ mediaType: 'audio/wav', bytes: wav.byteLength, name: 'render.wav' })
    const stored = await ctx.audioAttachments.readAudio(audio.attachment)
    expect(Buffer.from(stored.data)).toEqual(Buffer.from(wav))

    // LlmRuntime projects the FileBlock to its handle text before the adapter; the AudioBlock follows it.
    const user = adapter.requests[0]?.messages.find(message => message.id === prompt.id)
    expect(blockTypes(user?.content)).toEqual(['text', 'text', 'audio'])
    const handle = user?.content[1]
    expect(handle?.type === 'text' && handle.text).toContain('File "render.wav"')
    expect(user?.content[2]).toEqual(audio)
  }, 15_000)

  it('follows a WAV file in a subagent prompt with an AudioBlock in the child message and request', async () => {
    const adapter = new ScriptedAdapter([textResponse('child heard the upload')])
    const ctx = await boot(adapter, 'dsh-native-audio-ingress-child-')
    const wav = syntheticWav({ sampleRateHz: 44_100, channels: 2, bitsPerSample: 24 })
    const file = await ctx.attachments.saveFile({ data: wav, name: 'delegated.wav' })

    const parent = await ctx.agentLoop.create(SessionId('ingress-parent'), { provider: PROVIDER, model: 'scripted-model' })
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'listen to a delegated upload',
      request: {
        parent,
        prompt: [
          { type: 'text', text: 'Evaluate the delegated upload.' },
          { type: 'file', attachment: file },
        ],
      },
      signal: new AbortController().signal,
    })
    await eventually('child turn and activation release', () =>
      adapter.requests.length >= 1 && ctx.agents.get(started.childId) === undefined)

    const [durable] = fileMessages((await loadStoredSession(ctx.sessionPersistence, started.childId)).events)
    expect(blockTypes(durable?.content).slice(-2)).toEqual(['file', 'audio'])
    const audio = durable?.content.at(-1)
    if (audio?.type !== 'audio') throw new Error('child message has no AudioBlock')
    expect(audio.attachment).toMatchObject({ sampleRateHz: 44_100, channels: 2, bitsPerSample: 24, name: 'delegated.wav' })
    const user = adapter.requests[0]?.messages.find(message => message.id === durable?.id)
    expect(user?.content.at(-1)).toEqual(audio)
    expect(requestAudioCount(adapter.requests[0])).toBe(1)
  }, 15_000)

  it('keeps a non-WAV file and an unparseable WAV file as plain files', async () => {
    const adapter = new ScriptedAdapter([textResponse('read the notes')])
    const ctx = await boot(adapter, 'dsh-native-audio-ingress-plain-')
    const notes = await ctx.attachments.saveFile({ data: new TextEncoder().encode('mix notes'), name: 'notes.txt' })
    const broken = await ctx.attachments.saveFile({
      data: new TextEncoder().encode('not a RIFF/WAVE stream'),
      name: 'broken.wav',
    })

    const main = await ctx.agentLoop.create(SessionId('ingress-plain'), { provider: PROVIDER, model: 'scripted-model' })
    const fileBlock = (attachment: FileAttachmentRef) => ({ type: 'file' as const, attachment })
    const prompt = createUserMessage({
      content: [{ type: 'text', text: 'Read these.' }, fileBlock(notes), fileBlock(broken)],
      source: { kind: 'user' },
    })
    main.followup(prompt)
    await adapter.whenRequested(1)
    await main.whenIdle()
    await ctx.sessions.flush(main.session)

    const [durable] = fileMessages((await loadStoredSession(ctx.sessionPersistence, main.id)).events)
    expect(durable?.content).toEqual(prompt.content)
    expect(requestAudioCount(adapter.requests[0])).toBe(0)
  }, 15_000)

  it.skipIf(!hasFfmpeg)('follows an uploaded MP3 with an AudioBlock of its converted WAV', async () => {
    const adapter = new ScriptedAdapter([textResponse('heard the mp3')])
    const ctx = await boot(adapter, 'dsh-native-audio-ingress-mp3-')
    const mp3 = await readFile(await encodeMp3(home!, 'take.mp3'))
    const upload = await ctx.attachments.saveFile({ data: new Uint8Array(mp3), name: 'take.mp3' })

    const main = await ctx.agentLoop.create(SessionId('ingress-mp3'), { provider: PROVIDER, model: 'scripted' })
    main.followup(createUserMessage({
      content: [{ type: 'text', text: 'Listen.' }, { type: 'file', attachment: upload }],
      source: { kind: 'user' },
    }))
    await adapter.whenRequested(1)
    await main.whenIdle()
    await ctx.sessions.flush(main.session)

    const [durable] = fileMessages((await loadStoredSession(ctx.sessionPersistence, main.id)).events)
    expect(blockTypes(durable?.content)).toEqual(['text', 'file', 'audio'])
    expect(durable?.content[2]).toMatchObject({
      type: 'audio',
      attachment: { mediaType: 'audio/wav', sampleRateHz: 44_100, channels: 1, bitsPerSample: 16, name: 'take.mp3' },
    })
    expect(requestAudioCount(adapter.requests[0])).toBe(1)
  }, 15_000)

  it.skipIf(!hasFfmpeg)('reads a local MP3 path as a converted WAV AudioBlock', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-read-mp3-'))
    const filePath = await encodeMp3(home, 'sample-c.mp3')
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalAudioAttachmentStore, { dshHome: home })
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin({ inject: [...readAudioInject], apply: applyReadAudio })

    const result = await executeReadAudio(ctx, 'read-audio-mp3', filePath)

    expect(result.isError).toBe(false)
    expect(result.content[1]).toMatchObject({
      type: 'audio',
      attachment: { mediaType: 'audio/wav', sampleRateHz: 44_100, bitsPerSample: 16, name: 'sample-c.mp3' },
    })
  })

  it('leaves an oversized upload as a plain file without reading or converting it', async () => {
    const attachment = { name: 'long.mp3', bytes: 2048 } as FileAttachmentRef
    const content: ContentBlock[] = [{ type: 'file', attachment }]
    const untouched = (): never => { throw new Error('must not touch an oversized file') }
    const skipped: SkippedAudioFile[] = []

    const result = await attachFileAudio(
      content,
      { readFileStream: untouched },
      {
        audioLimits: { maxAudioBytes: 1024, maxAudiosPerMessage: 4, maxMessageAudioBytes: 4096, mediaTypes: ['audio/wav'] },
        convertToPcmWav: untouched,
        saveAudios: untouched,
      },
      { onSkip: value => skipped.push(value) },
    )

    expect(result).toBe(content)
    expect(skipped.map(value => value.file.name)).toEqual(['long.mp3'])
  })

  it('returns oversized audio from read_audio as a tool error', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-read-large-'))
    const wavPath = join(home, 'large.wav')
    await writeFile(wavPath, syntheticWav({ frames: 8_000 }))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalAudioAttachmentStore, { dshHome: home, maxAudioBytes: 1024 })
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin({ inject: [...readAudioInject], apply: applyReadAudio })

    const result = await executeReadAudio(ctx, 'read-audio-large', wavPath)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('exceeds the configured byte limit')
  })

  it.skipIf(!hasFfmpeg)('returns a compressed file that decodes above the limit as a tool error', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-read-large-mp3-'))
    const mp3Path = await encodeMp3(home, 'large.mp3')
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalAudioAttachmentStore, { dshHome: home, maxAudioBytes: 32 * 1024 })
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin({ inject: [...readAudioInject], apply: applyReadAudio })

    const result = await executeReadAudio(ctx, 'read-audio-large-mp3', mp3Path)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('exceeds the configured byte limit')
  })

  it('reports a missing converter through read_audio', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-read-missing-'))
    const filePath = join(home, 'sample-d.mp3')
    await writeFile(filePath, new TextEncoder().encode('not audio'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalAudioAttachmentStore, { dshHome: home, ffmpegPath: join(home, 'no-such-ffmpeg') })
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin({ inject: [...readAudioInject], apply: applyReadAudio })

    const result = await executeReadAudio(ctx, 'read-audio-missing', filePath)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires ffmpeg')
  })

  it('reads a local neutral WAV path and returns text plus a durable AudioBlock', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-read-'))
    const filePath = join(home, 'sample-b.wav')
    const wav = syntheticWav({ sampleRateHz: 44_100, channels: 2, bitsPerSample: 24 })
    await writeFile(filePath, wav)
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalAudioAttachmentStore, { dshHome: home })
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin({ inject: [...readAudioInject], apply: applyReadAudio })

    const result = await executeReadAudio(ctx, 'read-audio-contract', filePath)

    expect(result.isError).toBe(false)
    expect(blockTypes(result.content)).toEqual(['text', 'audio'])
    expect(result.content[1]).toMatchObject({
      type: 'audio',
      attachment: {
        mediaType: 'audio/wav',
        sampleRateHz: 44_100,
        channels: 2,
        bitsPerSample: 24,
        name: 'sample-b.wav',
      },
    })
  })
})
