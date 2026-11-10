import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import type { AudioAttachmentRef } from '../src/index.js'
import { apply as applyReadAudio, inject as readAudioInject } from '../src/read-audio-tool.js'
import {
  createAgentHarness,
  eventually,
  loadStoredSession,
  parkParent,
  ScriptedAdapter,
  textResponse,
  toolCallResponse,
} from './fixtures/dsh-harness.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const PROVIDER = 'recording'

function eventAudioIds(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => {
    if (event.type !== 'user/message') return []
    return event.data.content.flatMap(block => block.type === 'audio'
      ? [String(block.attachment.attachmentId)]
      : [])
  })
}

function requestAudioIds(request: GenerateOptions | undefined): string[] {
  return request?.messages.flatMap(message => message.content.flatMap(block => block.type === 'audio'
    ? [String(block.attachment.attachmentId)]
    : [])) ?? []
}

function requestText(request: GenerateOptions | undefined): string {
  return request?.messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'text' ? [block.text] : [])).join('\n') ?? ''
}

function extensibleWav(): Uint8Array {
  return syntheticWav({ format: 'extensible', bitsPerSample: 24, sampleRateHz: 48_000, channels: 2, channelMask: 3 })
}

describe('DSH 0.2 public Session and continuable-subagent contract', () => {
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

  async function boot(adapter: ScriptedAdapter, prefix: string) {
    home = await mkdtemp(join(tmpdir(), prefix))
    ctx = await createAgentHarness({ home })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    ctx.effect(() => ctx!.audioAttachments.registerAudioProvider(PROVIDER), 'register offline audio provider')
    const parent = await ctx.agentLoop.create(SessionId(`${prefix}parent`), { provider: PROVIDER, model: 'scripted-model' })
    parkParent(ctx, parent)
    return { ctx, parent }
  }

  it('persists AudioBlock in the child session and cold-resumes it into the next child request', async () => {
    const adapter = new ScriptedAdapter([textResponse('first-answer'), textResponse('second-answer')])
    const { ctx, parent } = await boot(adapter, 'dsh-native-audio-contract-')

    // Main history holds a sentinel that a fresh spawn child must not inherit.
    const parentSentinel = 'PARENT_ONLY_SENTINEL_71ee782d'
    parent.session.append('turn/start', { turn: 0 })
    parent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: parentSentinel }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    expect(parent.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text === parentSentinel))).toBe(true)
    expect(adapter.requests).toHaveLength(0)

    const firstRef = await ctx.audioAttachments.saveAudio({
      data: syntheticWav({ bitsPerSample: 24, sampleRateHz: 48_000, channels: 2 }),
      mediaType: 'audio/wav',
      name: '/private/render/first.wav',
    })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'listen to first render',
      request: {
        parent,
        prompt: [
          { type: 'audio', attachment: firstRef },
          { type: 'text', text: 'Evaluate the first render.' },
        ],
      },
      signal: new AbortController().signal,
    })

    await eventually('first child turn and activation release', () =>
      adapter.requests.length >= 1 && ctx.agents.get(started.childId) === undefined)
    expect(requestAudioIds(adapter.requests[0])).toEqual([String(firstRef.attachmentId)])
    expect(requestText(adapter.requests[0])).not.toContain(parentSentinel)
    expect(adapter.requests[0]?.messages[0]?.role).toBe('system')

    const firstStored = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(eventAudioIds(firstStored.events)).toEqual([String(firstRef.attachmentId)])
    expect(firstStored.header.parentSession).toBe(parent.id)
    expect(firstStored.header.isSeeded).toBe(false)
    expect(firstStored.inheritedEventCount).toBe(0)
    expect(firstStored.header.origin).toBe('subagent')

    const secondRef: AudioAttachmentRef = await ctx.audioAttachments.saveAudio({
      data: extensibleWav(),
      mediaType: 'audio/wav',
      name: '/private/render/second.wav',
    })
    // The child has no live Activation, so this message cold-resumes it from persistence.
    await ctx.subagents.sendMessage(parent, started.childId, [
      { type: 'audio', attachment: secondRef },
      { type: 'text', text: 'Now evaluate the replacement render.' },
    ], { signal: new AbortController().signal })

    await eventually('cold-resumed child turn and activation release', () =>
      adapter.requests.length >= 2 && ctx.agents.get(started.childId) === undefined)
    expect(requestAudioIds(adapter.requests[1])).toEqual([
      String(firstRef.attachmentId),
      String(secondRef.attachmentId),
    ])
    expect(requestText(adapter.requests[1])).not.toContain(parentSentinel)

    const secondStored = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(eventAudioIds(secondStored.events)).toEqual([
      String(firstRef.attachmentId),
      String(secondRef.attachmentId),
    ])
  }, 15_000)

  it('preserves a resident audio message across interrupt and resumes it on the next waking send', async () => {
    const adapter = new ScriptedAdapter(['hold-until-abort', textResponse('followup-after-interrupt')])
    const { ctx, parent } = await boot(adapter, 'dsh-native-audio-resident-')

    const firstRef = await ctx.audioAttachments.saveAudio({
      data: syntheticWav({ bitsPerSample: 24, sampleRateHz: 48_000, channels: 2 }),
      mediaType: 'audio/wav',
      name: 'resident-first.wav',
    })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'resident audio child',
      request: {
        parent,
        prompt: [
          { type: 'audio', attachment: firstRef },
          { type: 'text', text: 'Begin the first resident review.' },
        ],
      },
      signal: new AbortController().signal,
    })
    await adapter.whenRequested(1)
    expect(ctx.agents.get(started.childId)?.status).toBe('running')

    const secondRef = await ctx.audioAttachments.saveAudio({
      data: extensibleWav(),
      mediaType: 'audio/wav',
      name: 'resident-followup.wav',
    })
    // A running child admits the message at its next step boundary.
    await ctx.subagents.sendMessage(parent, started.childId, [
      { type: 'audio', attachment: secondRef },
      { type: 'text', text: 'Review this replacement after the interrupted turn.' },
    ], { signal: new AbortController().signal })

    ctx.subagents.interrupt(started.childId, { kind: 'ancestor', agent: parent })
    await eventually('resident child interrupt', () => adapter.aborted === 1)
    const child = ctx.agents.get(started.childId)
    expect(child).toBeDefined()
    await child!.whenIdle()
    // Interrupt parks unclaimed inbox work instead of deleting or re-running it.
    // sendMessage records the sender as a relay and prefixes its attribution text.
    expect(child!.inbox.nextStep).toHaveLength(1)
    expect(child!.inbox.nextStep[0]?.source).toEqual({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: parent.id,
    })
    expect(child!.inbox.nextStep[0]?.content.map(block => block.type)).toEqual(['text', 'audio', 'text'])
    expect(adapter.requests).toHaveLength(1)

    // A later waking send resumes the parked FIFO in the same Activation.
    await ctx.subagents.sendMessage(parent, started.childId, [
      { type: 'text', text: 'Resume the preserved FIFO after the interrupt.' },
    ], { signal: new AbortController().signal })
    await adapter.whenRequested(2)

    expect(requestAudioIds(adapter.requests[0])).toEqual([String(firstRef.attachmentId)])
    expect(requestAudioIds(adapter.requests[1])).toEqual([
      String(firstRef.attachmentId),
      String(secondRef.attachmentId),
    ])
    expect(requestText(adapter.requests[1])).toContain('Resume the preserved FIFO after the interrupt.')
  }, 15_000)

  it('lets a child call the real read_audio tool and sends its AudioBlock in the next child request', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-child-read-'))
    const wavPath = join(home, 'child-render.wav')
    const wav = syntheticWav({ sampleRateHz: 44_100, channels: 2, bitsPerSample: 24 })
    await writeFile(wavPath, wav)
    const adapter = new ScriptedAdapter([
      toolCallResponse('read-audio-1', 'read_audio', { file_path: wavPath }),
      textResponse('heard-it'),
    ])

    ctx = await createAgentHarness({
      home,
      before: async (harnessCtx) => {
        await harnessCtx.plugin({ name: 'read-audio', inject: [...readAudioInject], apply: applyReadAudio })
      },
    })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    ctx.effect(() => ctx!.audioAttachments.registerAudioProvider(PROVIDER), 'register offline audio provider')
    const parent = await ctx.agentLoop.create(SessionId('read-audio-parent'), { provider: PROVIDER, model: 'scripted-model' })
    parkParent(ctx, parent)

    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      delivery: 'parent',
      label: 'read a render path',
      request: { parent, prompt: [{ type: 'text', text: `Listen to ${wavPath}.` }] },
      signal: new AbortController().signal,
    })
    await eventually('child tool turn and activation release', () =>
      adapter.requests.length >= 2 && ctx!.agents.get(started.childId) === undefined)

    expect(adapter.requests[0]?.tools?.some(tool => tool.name === 'read_audio')).toBe(true)
    expect(requestAudioIds(adapter.requests[0])).toEqual([])
    const toolMessage = adapter.requests[1]?.messages.find(message => message.role === 'tool')
    if (toolMessage?.role !== 'tool') throw new Error('second child request has no tool message')
    expect(String(toolMessage.toolCallId)).toBe('read-audio-1')
    expect(toolMessage.source).toEqual({ kind: 'tool', callId: toolMessage.toolCallId })
    expect(toolMessage.isError).not.toBe(true)
    expect(toolMessage.content.map(block => block.type)).toEqual(['text', 'audio'])
    const audio = toolMessage.content[1]
    if (audio?.type !== 'audio') throw new Error('tool message has no AudioBlock')
    expect(audio.attachment).toMatchObject({
      mediaType: 'audio/wav',
      sampleRateHz: 44_100,
      channels: 2,
      bitsPerSample: 24,
      name: 'child-render.wav',
    })
    const stored = await ctx.audioAttachments.readAudio(audio.attachment)
    expect(Buffer.from(stored.data)).toEqual(Buffer.from(wav))

    const persisted = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const toolResult = persisted.events.find(event => event.type === 'tool/result')
    expect(toolResult?.type === 'tool/result'
      && toolResult.data.message.content.some(block => block.type === 'audio'
        && block.attachment.attachmentId === audio.attachment.attachmentId)).toBe(true)
  }, 15_000)

  it('resolves a relative read_audio path against the working directory the Session switched to', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-working-directory-'))
    const switched = join(home, 'switched')
    await mkdir(switched)
    const wav = syntheticWav({ sampleRateHz: 44_100, channels: 2, bitsPerSample: 24 })
    await writeFile(join(switched, 'relative.wav'), wav)
    const adapter = new ScriptedAdapter([
      toolCallResponse('read-audio-relative', 'read_audio', { file_path: 'relative.wav' }),
      textResponse('heard-it'),
    ])
    ctx = await createAgentHarness({
      home,
      before: async (harnessCtx) => {
        await harnessCtx.plugin({ name: 'read-audio', inject: [...readAudioInject], apply: applyReadAudio })
      },
    })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    ctx.effect(() => ctx!.audioAttachments.registerAudioProvider(PROVIDER), 'register offline audio provider')
    const agent = await ctx.agentLoop.create(SessionId('read-audio-relative'), { provider: PROVIDER, model: 'scripted-model' }, { cwd: home })
    await ctx.workingDirectory.set(agent, switched)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Listen to relative.wav.' }], source: { kind: 'user' } }))
    await eventually('tool turn', () => adapter.requests.length >= 2)

    const toolMessage = adapter.requests[1]?.messages.find(message => message.role === 'tool')
    if (toolMessage?.role !== 'tool') throw new Error('second request has no tool message')
    expect(toolMessage.isError).not.toBe(true)
    const audio = toolMessage.content.find(block => block.type === 'audio')
    if (audio?.type !== 'audio') throw new Error('tool message has no AudioBlock')
    const stored = await ctx.audioAttachments.readAudio(audio.attachment)
    expect(Buffer.from(stored.data)).toEqual(Buffer.from(wav))
  }, 15_000)
})
