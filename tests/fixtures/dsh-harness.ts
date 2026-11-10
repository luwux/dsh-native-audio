import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalAudioAttachmentStore } from '../../src/index.js'

/**
 * `ctx.workingDirectory` without the stock service's filesystem and system-prompt
 * dependencies. Directories follow `set()` and otherwise the Session header.
 */
export class FixtureWorkingDirectory extends Service {
  private readonly directories = new WeakMap<Session, string>()

  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  get(session: Session): string {
    return this.directories.get(session) ?? session.header.cwd ?? process.cwd()
  }

  async ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return this.get(agent.session)
  }

  async set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const cwd = resolve(this.get(agent.session), path)
    this.directories.set(agent.session, cwd)
    return cwd
  }
}

/**
 * Concrete `ctx.sessionQuery` for continuable cold resume. The continuation
 * manager uses only the engine's real `observeSession`; the search faces the
 * abstract engine leaves to a backend (such as `dsh-session-query-sqlite`)
 * are not configured in these suites.
 */
export class PointReadSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Read one stored Session's header and complete event log through a read handle. */
export async function loadStoredSession(
  persistence: SessionPersistence,
  id: SessionId,
): Promise<{ header: SessionHeader; inheritedEventCount: number; events: readonly SessionEvent[] }> {
  const handle = await persistence.open(id, 'read')
  try {
    return {
      header: handle.header,
      inheritedEventCount: handle.inheritedEventCount,
      events: (await handle.read()).events,
    }
  } finally {
    await handle.close()
  }
}

/** Poll until `predicate` holds, failing after ten seconds. */
export async function eventually(description: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`)
    await delay(10)
  }
}

/**
 * Reject every step of a stand-in parent. Each child settlement wakes its
 * parent; these suites script model calls for child turns only.
 */
export function parkParent(ctx: Context, parent: Agent): void {
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent
    ? { kind: 'reject' as const }
    : next())
}

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** One scripted model call: chunks to stream, or a call held until its signal aborts. */
export type ScriptEntry = StreamChunk[] | 'hold-until-abort'

/** Records every loop-built request and answers from a script; it has no network path. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  aborted = 0
  private readonly started: Array<() => void> = []

  constructor(private readonly script: ScriptEntry[], private readonly contextWindow = 16_384) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  /** Resolve once request number `count` (1-based) has reached the adapter. */
  async whenRequested(count: number): Promise<void> {
    await eventually(`model request ${count}`, () => this.requests.length >= count)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error(`ScriptedAdapter: script exhausted at call ${this.requests.length}`)
    if (entry === 'hold-until-abort') {
      await new Promise<never>((_resolve, reject) => {
        const signal = options.signal
        const abort = (): void => {
          this.aborted += 1
          reject(signal?.reason)
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
      return
    }
    for (const chunk of entry) yield chunk
  }
}

export interface HarnessOptions {
  /** Harness home holding audio attachments, session logs, and stored files. */
  home: string
  /** Deployment persona rendered into every Agent's system prompt. */
  persona?: string
  /** Plugins mounted after the audio store and persistence, before AgentLoop. */
  before?: (ctx: Context) => Promise<void>
}

/**
 * Real DSH 0.2 Agent stack for the native-audio contract suites: LLM runtime,
 * Session store and projections, system prompt, tools, Agent registry and
 * loop, JSONL persistence, the local file/image attachment store and the
 * local WAV store under `home`, the point-read Session query, a fixture
 * working directory, and
 * SubagentRuntime with the in-process spawn provider named `spawn`.
 */
export async function createAgentHarness(options: HarnessOptions): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: options.persona ?? 'Deterministic offline native-audio contract test.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalAttachmentStore, { dshHome: options.home })
  await ctx.plugin(LocalAudioAttachmentStore, { dshHome: options.home })
  await ctx.plugin(JsonlSessionPersistence, { root: join(options.home, 'sessions'), compression: 'none' })
  await ctx.plugin(PointReadSessionQuery)
  await ctx.plugin(FixtureWorkingDirectory)
  await options.before?.(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  return ctx
}
