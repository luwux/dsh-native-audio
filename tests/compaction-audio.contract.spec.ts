import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import {
  createAssistantMessage,
  createUserMessage,
  type ContentBlock,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it } from 'vitest'
import type { AudioAttachmentRef } from '../src/index.js'
import { createAgentHarness, loadStoredSession, ScriptedAdapter } from './fixtures/dsh-harness.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const PROVIDER = 'compaction-fixture'
const MODEL = 'offline-model'
const SESSION = SessionId('audio-compaction-contract')

class DeterministicCompaction extends BasicCompactionEngine {
  readonly inputs: Array<{ readonly messages: readonly Message[] }> = []

  override async summarize(
    input: { readonly messages: readonly Message[] },
    _agent: Agent,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    this.inputs.push(input)
    const summary: ContentBlock[] = [{ type: 'text', text: 'older audio review compacted' }]
    return {
      summary,
      rawOutput: summary,
      provider: PROVIDER,
      model: MODEL,
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  }
}

function audioIds(refs: readonly AudioAttachmentRef[], messages: readonly Message[]): string[] {
  const allowed = new Set(refs.map(ref => String(ref.attachmentId)))
  return messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'audio' && allowed.has(String(block.attachment.attachmentId))
      ? [String(block.attachment.attachmentId)]
      : []))
}

/** Real Agent stack with the token meter, the compaction subclass, and a model route that is never called. */
async function createHarness(home: string): Promise<{ ctx: Context; compaction: DeterministicCompaction }> {
  const ctx = await createAgentHarness({
    home,
    before: async (harnessCtx) => {
      await harnessCtx.plugin(TokenMeter)
      await harnessCtx.plugin(DeterministicCompaction, { auto: false })
    },
  })
  // An empty script fails the test on any model call.
  ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter([]))
  return { ctx, compaction: ctx.compaction as DeterministicCompaction }
}

/** Append one closed single-step turn holding one user audio prompt and one assistant answer. */
function appendAudioTurn(session: Session, turn: number, ref: AudioAttachmentRef, prompt: string, answer: string) {
  session.append('turn/start', { turn })
  const user = session.append('user/message', createUserMessage({
    content: [
      { type: 'audio', attachment: ref },
      { type: 'text', text: prompt },
    ],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', {
      header: { config: { provider: PROVIDER, model: MODEL } },
      reason: 'initial',
    })
  }
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: answer }],
      source: { provider: PROVIDER, model: MODEL },
    }),
  }, { surfaceOp: 'append' }).seq
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { user, assistant }
}

describe('DSH 0.2 compaction policy for durable audio blocks', () => {
  let home: string | undefined
  let contexts: Context[] = []

  afterEach(async () => {
    const ownedContexts = contexts
    const ownedHome = home
    contexts = []
    home = undefined
    for (const ctx of ownedContexts.reverse()) await ctx.fiber.dispose()
    if (ownedHome !== undefined) await rm(ownedHome, { recursive: true, force: true })
  })

  it('replaces selected-span audio but preserves retained-tail audio through persistence and cold resume', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-compaction-'))
    const harness = await createHarness(home)
    contexts.push(harness.ctx)
    // An AgentLoop-created Session owns a persistence write handle; every append below is stored.
    const agent = await harness.ctx.agentLoop.create(SESSION, { provider: PROVIDER, model: MODEL })
    const session = agent.session

    const oldBytes = syntheticWav({ bitsPerSample: 16, sampleRateHz: 48_000, channels: 2 })
    const retainedBytes = syntheticWav({
      format: 'extensible',
      bitsPerSample: 24,
      sampleRateHz: 48_000,
      channels: 2,
      channelMask: 3,
    })
    const oldRef = await harness.ctx.audioAttachments.saveAudio({
      data: oldBytes,
      mediaType: 'audio/wav',
      name: 'old-review.wav',
    })
    const retainedRef = await harness.ctx.audioAttachments.saveAudio({
      data: retainedBytes,
      mediaType: 'audio/wav',
      name: 'current-review.wav',
    })

    const selected = appendAudioTurn(session, 1, oldRef, 'Evaluate the obsolete render.', 'The obsolete render was too bright.')
    appendAudioTurn(session, 2, retainedRef, 'Evaluate the current render.', 'The current render is balanced.')
    // compactRegion is the automatic-compaction entry point and must run inside an open turn.
    session.append('turn/start', { turn: 3 })

    await harness.compaction.compactRegion(selected.user, selected.assistant, agent, new AbortController().signal)

    expect(harness.compaction.inputs).toHaveLength(1)
    expect(audioIds([oldRef, retainedRef], harness.compaction.inputs[0]!.messages)).toEqual([
      String(oldRef.attachmentId),
    ])
    expect(audioIds([oldRef, retainedRef], session.deriveMessages())).toEqual([
      String(retainedRef.attachmentId),
    ])
    expect(session.deriveMessages().flatMap(message => message.content).some(block =>
      block.type === 'text' && block.text === 'older audio review compacted')).toBe(true)

    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await harness.ctx.sessions.flush(session)
    const stored = await loadStoredSession(harness.ctx.sessionPersistence, SESSION)
    expect(stored.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ]))
    await harness.ctx.fiber.dispose()
    contexts = []

    const cold = await createHarness(home)
    contexts.push(cold.ctx)
    const resumed = await cold.ctx.agents.resume({ resumeSessionId: SESSION })
    try {
      expect(audioIds([oldRef, retainedRef], resumed.agent.session.deriveMessages())).toEqual([
        String(retainedRef.attachmentId),
      ])
      const retained = await cold.ctx.audioAttachments.readAudio(retainedRef)
      expect(Buffer.from(retained.data)).toEqual(Buffer.from(retainedBytes))
    } finally {
      await resumed.dispose()
    }
  }, 15_000)
})
