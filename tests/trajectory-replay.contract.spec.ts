import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_CREDENTIAL_API_KEY } from '../src/openai-compatible/pi-ai-bridge.js'
import { TOOL_RESULT_AUDIO_NOTE, toolResultAudioLabel } from '../src/openai-compatible/wire.js'
import { apply as applyReadAudio, inject as readAudioInject } from '../src/read-audio-tool.js'
import { createAgentHarness, eventually, loadStoredSession } from './fixtures/dsh-harness.js'
import { chatCompletionsProfile, mountAudioRoutes } from './fixtures/pi-ai-route.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

/**
 * Replays the audio-relevant skeleton of a real DSH 0.1.1 Web session
 * (tests/fixtures/trajectories/read-audio-subagents.json) through the
 * real DSH 0.2 Agent, Subagent, ToolRuntime, read_audio, and Chat Completions
 * route stack. The model is a fake `globalThis.fetch` that answers SSE from the
 * fixture after classifying each request body by agent; no request leaves the
 * process.
 */

// ---------------------------------------------------------------------------
// Fixture

interface ToolCallSpec {
  id: string
  name: string
  arguments: Record<string, unknown>
}

type Step =
  | { source: string; toolCalls: ToolCallSpec[]; text?: never }
  | { source: string; text: string; toolCalls?: never }

type ChildKey = 'blind' | 'alignment'

interface Trajectory {
  audio: { path: string; sampleRateHz: number; channels: number; bitsPerSample: 16; frames: number }
  main: {
    turns: Array<{ source: string; user: string; steps: Step[] }>
    inboxReplies: Array<{ source: string; child: ChildKey; notice: Notice; text: string }>
  }
  children: Record<ChildKey, { spawnedBy: string; label: string; steps: Step[] }>
}

type Notice = 'agent-message' | 'subagent-settled'

const FIXTURE_PATH = new URL('./fixtures/trajectories/read-audio-subagents.json', import.meta.url)
const MAIN_ID = SessionId('read-audio-subagents-main')
const CHILD_KEYS: readonly ChildKey[] = ['blind', 'alignment']

/** Replace `{{workspace}}` (and any extra placeholder) in every string of a fixture value. */
function resolvePlaceholders<T>(value: T, replacements: Record<string, string>): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
    if (typeof item !== 'string') return item
    let output = item
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      output = output.split(placeholder).join(replacement)
    }
    return output
  }) as T
}

async function loadTrajectory(workspace: string): Promise<Trajectory> {
  const raw = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Trajectory
  return resolvePlaceholders(raw, { '{{workspace}}': workspace })
}

// ---------------------------------------------------------------------------
// Chat Completions wire shapes

interface WirePart {
  type: string
  text?: string
  input_audio?: { data: string; format: string }
}

interface WireMessage {
  role: string
  content?: string | WirePart[] | null
  tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}

interface WireBody {
  model: string
  messages: WireMessage[]
  tools?: unknown[]
}

type AgentKey = 'main' | ChildKey

interface RecordedRequest {
  agent: AgentKey
  url: string
  headers: Headers
  raw: string
  body: WireBody
}

function textsOf(message: WireMessage): string[] {
  const content = message.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
}

function audioPartsOf(message: WireMessage): WirePart[] {
  return Array.isArray(message.content) ? message.content.filter(part => part.type === 'input_audio') : []
}

function audioCount(body: WireBody): number {
  return body.messages.reduce((count, message) => count + audioPartsOf(message).length, 0)
}

/** The user messages after the last assistant message: what woke this step. */
function trailingUserMessages(body: WireBody): WireMessage[] {
  const lastAssistant = body.messages.findLastIndex(message => message.role === 'assistant')
  return body.messages.slice(lastAssistant + 1).filter(message => message.role === 'user')
}

function completionResponse(model: string, delta: Record<string, unknown>, finishReason: 'stop' | 'tool_calls'): Response {
  const events = [
    {
      id: 'offline-trajectory-replay',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }],
    },
    {
      id: 'offline-trajectory-replay',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    },
  ]
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function stepResponse(model: string, step: Step): Response {
  if (step.text !== undefined) return completionResponse(model, { content: step.text }, 'stop')
  return completionResponse(model, {
    tool_calls: step.toolCalls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  }, 'tool_calls')
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const PARENT_GUIDANCE = /Your parent agent id is "([^"]+)"/u

/**
 * Fake Chat Completions endpoint. Each request is classified by its first
 * user text (the Main user prompt or a child's delegated prompt) and answered
 * from that agent's scripted steps. After Main's scripted turns, Main answers
 * the newest child notice that woke it. Children are held until Main's step
 * after the delegation has reached the transport, so that step sees only the
 * two tool results, as in the recorded session.
 */
class TrajectoryEndpoint {
  readonly requests: RecordedRequest[] = []
  readonly errors: string[] = []
  /** Child id → fixture key, learned from Main's `started subagent <id>` tool results. */
  readonly childIds = new Map<string, ChildKey>()
  /** Child notices Main has seen in any request, as `<child>:<notice>`. */
  readonly noticesSeen = new Set<string>()
  private readonly mainSteps: Step[]
  private readonly childSteps: Record<ChildKey, Step[]>
  private readonly childrenReleased = deferred()
  private readonly releaseAfterMainSteps: number
  private mainServed = 0

  constructor(private readonly trajectory: Trajectory, private readonly model: string) {
    this.mainSteps = trajectory.main.turns.flatMap(turn => turn.steps)
    this.childSteps = { blind: [...trajectory.children.blind.steps], alignment: [...trajectory.children.alignment.steps] }
    const delegation = this.mainSteps.findIndex(step =>
      step.toolCalls?.some(call => call.name === 'subagent') === true)
    this.releaseAfterMainSteps = delegation + 1
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    try {
      const url = input instanceof Request ? input.url : String(input)
      const raw = String(init?.body)
      const body = JSON.parse(raw) as WireBody
      const agent = this.classify(body)
      this.requests.push({ agent, url, headers: new Headers(init?.headers), raw, body })
      return agent === 'main' ? this.answerMain(body) : await this.answerChild(agent, body)
    } catch (error) {
      this.errors.push(String(error))
      throw error
    }
  }

  ofAgent(agent: AgentKey): RecordedRequest[] {
    return this.requests.filter(request => request.agent === agent)
  }

  private classify(body: WireBody): AgentKey {
    const userTexts = body.messages.filter(message => message.role === 'user').flatMap(textsOf)
    if (userTexts.some(text => text.startsWith(this.trajectory.main.turns[0]!.user))) return 'main'
    for (const key of CHILD_KEYS) {
      const prompt = this.delegatedPrompt(key)
      if (userTexts.some(text => text.startsWith(prompt))) return key
    }
    throw new Error('fake endpoint: request matches no agent in the trajectory')
  }

  private delegatedPrompt(key: ChildKey): string {
    const spawnedBy = this.trajectory.children[key].spawnedBy
    const call = this.mainSteps.flatMap(step => step.toolCalls ?? []).find(candidate => candidate.id === spawnedBy)
    const prompt = call?.arguments['prompt']
    if (typeof prompt !== 'string') throw new Error(`fixture has no subagent prompt for ${key}`)
    return prompt
  }

  private answerMain(body: WireBody): Response {
    this.learnChildIds(body)
    this.recordNotices(body)
    const step = this.mainSteps[this.mainServed]
    if (step !== undefined) {
      this.mainServed += 1
      if (this.mainServed > this.releaseAfterMainSteps) this.childrenReleased.resolve()
      return stepResponse(this.model, step)
    }
    const woke = trailingUserMessages(body).flatMap(message => this.noticesIn(message))
    const latest = woke.at(-1)
    if (latest === undefined) throw new Error('fake endpoint: Main step after the script has no child notice')
    const reply = this.trajectory.main.inboxReplies.find(candidate =>
      candidate.child === latest.child && candidate.notice === latest.notice)
    if (reply === undefined) throw new Error(`fake endpoint: no Main reply for ${latest.child} ${latest.notice}`)
    return completionResponse(this.model, { content: reply.text }, 'stop')
  }

  private async answerChild(key: ChildKey, body: WireBody): Promise<Response> {
    await this.childrenReleased.promise
    const step = this.childSteps[key].shift()
    if (step === undefined) throw new Error(`fake endpoint: ${key} script exhausted`)
    if (step.toolCalls === undefined) return stepResponse(this.model, step)
    const parentId = body.messages
      .filter(message => message.role === 'user')
      .flatMap(textsOf)
      .map(text => PARENT_GUIDANCE.exec(text)?.[1])
      .find(id => id !== undefined)
    return stepResponse(this.model, resolvePlaceholders(step, parentId === undefined ? {} : { '{{parentAgentId}}': parentId }))
  }

  private learnChildIds(body: WireBody): void {
    for (const message of body.messages) {
      if (message.role !== 'tool' || message.tool_call_id === undefined) continue
      const key = CHILD_KEYS.find(candidate => this.trajectory.children[candidate].spawnedBy === message.tool_call_id)
      const id = textsOf(message).join('').match(/^started subagent (\S+)$/u)?.[1]
      if (key !== undefined && id !== undefined) this.childIds.set(id, key)
    }
  }

  private noticesIn(message: WireMessage): Array<{ child: ChildKey; notice: Notice }> {
    const text = textsOf(message).join('')
    for (const [id, child] of this.childIds) {
      if (text.startsWith(`Agent ${id} sent a message: `)) return [{ child, notice: 'agent-message' }]
      if (text.startsWith(`Background subagent ${id} finished`)) return [{ child, notice: 'subagent-settled' }]
    }
    return []
  }

  private recordNotices(body: WireBody): void {
    for (const message of body.messages) {
      if (message.role !== 'user') continue
      for (const { child, notice } of this.noticesIn(message)) this.noticesSeen.add(`${child}:${notice}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Routes

const TEST_KEY_ENV = 'DSH_NATIVE_AUDIO_OFFLINE_TRAJECTORY_KEY'
const TEST_KEY = 'offline-trajectory-key-not-a-secret'
const OPENROUTER_ROUTE = 'openrouter'

interface RouteCase {
  name: string
  provider: string
  model: string
  placement: 'tool-message' | 'user-message'
  url: string
  authorization: string
  mount: (ctx: Context) => PromiseLike<unknown>
}

const ROUTES: readonly RouteCase[] = [
  {
    name: 'OpenRouter qwen/qwen3.8-omni-flash (tool-message)',
    provider: OPENROUTER_ROUTE,
    model: 'qwen/qwen3.8-omni-flash',
    placement: 'tool-message',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    authorization: `Bearer ${TEST_KEY}`,
    mount: ctx => mountAudioRoutes(ctx, {
      [OPENROUTER_ROUTE]: {
        profile: { apiKeyEnv: TEST_KEY_ENV, models: [{ id: 'qwen/qwen3.8-omni-flash', input: ['text', 'image'] }] },
        audio: { toolResultAudio: 'tool-message' },
      },
    }),
  },
  {
    name: 'OpenRouter google/gemini-3.7-flash (user-message)',
    provider: OPENROUTER_ROUTE,
    model: 'google/gemini-3.7-flash',
    placement: 'user-message',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    authorization: `Bearer ${TEST_KEY}`,
    mount: ctx => mountAudioRoutes(ctx, {
      [OPENROUTER_ROUTE]: {
        profile: { apiKeyEnv: TEST_KEY_ENV, models: [{ id: 'google/gemini-3.7-flash', input: ['text', 'image'] }] },
        audio: {},
      },
    }),
  },
  {
    name: 'generic local-omni qwen3-omni-30b-a3b-instruct-bf16 (user-message, no credential)',
    provider: 'local-omni',
    model: 'qwen3-omni-30b-a3b-instruct-bf16',
    placement: 'user-message',
    url: 'http://127.0.0.1:7777/v1/chat/completions',
    authorization: `Bearer ${NO_CREDENTIAL_API_KEY}`,
    mount: ctx => mountAudioRoutes(ctx, {
      'local-omni': {
        profile: chatCompletionsProfile('http://127.0.0.1:7777/v1', [{ id: 'qwen3-omni-30b-a3b-instruct-bf16' }]),
        audio: {},
      },
    }),
  },
]

// ---------------------------------------------------------------------------
// Assertions

function decode(part: WirePart | undefined): Uint8Array {
  expect(part?.type).toBe('input_audio')
  expect(part?.input_audio?.format).toBe('wav')
  return new Uint8Array(Buffer.from(part?.input_audio?.data ?? '', 'base64'))
}

/**
 * Assert the request's projection of one read_audio result and return the
 * serialized wire messages that carry it, for cache-prefix comparison.
 */
function assertReadAudioPlacement(
  body: WireBody,
  toolCallId: string,
  placement: RouteCase['placement'],
  wav: Uint8Array,
  readAudioText: string,
): string[] {
  const toolIndex = body.messages.findIndex(message => message.role === 'tool' && message.tool_call_id === toolCallId)
  const tool = body.messages[toolIndex]
  if (tool === undefined) throw new Error(`request has no tool message for ${toolCallId}`)
  if (placement === 'tool-message') {
    const parts = tool.content
    if (!Array.isArray(parts)) throw new Error('tool-message placement must use multipart tool content')
    expect(parts.map(part => part.type)).toEqual(['text', 'input_audio'])
    expect(parts[0]).toEqual({ type: 'text', text: readAudioText })
    expect(decode(parts[1])).toEqual(wav)
    return [JSON.stringify(tool)]
  }
  // DSH joins a tool message's text blocks with no separator; the bridge puts the note on its own line.
  expect(tool.content).toBe(`${readAudioText}\n${TOOL_RESULT_AUDIO_NOTE}`)
  // The follow-up user message comes right after the run of tool messages.
  let followupIndex = toolIndex + 1
  while (body.messages[followupIndex]?.role === 'tool') followupIndex += 1
  const followup = body.messages[followupIndex]
  expect(followup?.role).toBe('user')
  const parts = followup?.content
  if (!Array.isArray(parts)) throw new Error('user-message placement must insert a multipart user message')
  expect(parts.map(part => part.type)).toEqual(['text', 'input_audio'])
  expect(parts[0]).toEqual({ type: 'text', text: toolResultAudioLabel(toolCallId) })
  expect(decode(parts[1])).toEqual(wav)
  return [JSON.stringify(tool), JSON.stringify(followup)]
}

function readAudioCallOf(steps: readonly Step[]): string {
  const call = steps.flatMap(step => step.toolCalls ?? []).find(candidate => candidate.name === 'read_audio')
  if (call === undefined) throw new Error('fixture agent has no read_audio call')
  return call.id
}

function toolResultTypes(events: readonly SessionEvent[], callId: string): string[] | undefined {
  for (const event of events) {
    if (event.type === 'tool/result' && event.data.message.toolCallId === callId) {
      return event.data.message.content.map(block => block.type)
    }
  }
  return undefined
}

function turnEndKinds(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

// ---------------------------------------------------------------------------
// Suite

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

async function runTurn(main: Agent, endpoint: TrajectoryEndpoint, text: string): Promise<void> {
  const before = endpoint.ofAgent('main').length
  main.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await eventually(`Main request for "${text.slice(0, 20)}"`, () => endpoint.ofAgent('main').length > before)
  await main.whenIdle()
}

describe('real-trajectory replay: Main read_audio and two read_audio subagents over Chat Completions', () => {
  it.each(ROUTES)('$name', async (route) => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-audio-trajectory-'))
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const trajectory = await loadTrajectory(workspace)
    const wav = syntheticWav({
      sampleRateHz: trajectory.audio.sampleRateHz,
      channels: trajectory.audio.channels,
      bitsPerSample: trajectory.audio.bitsPerSample,
      frames: trajectory.audio.frames,
    })
    await writeFile(join(workspace, trajectory.audio.path), wav)

    const endpoint = new TrajectoryEndpoint(trajectory, route.model)
    originalFetch = globalThis.fetch
    originalKey = process.env[TEST_KEY_ENV]
    process.env[TEST_KEY_ENV] = TEST_KEY
    globalThis.fetch = endpoint.fetch as typeof globalThis.fetch

    const harness = await createAgentHarness({
      home,
      persona: 'Offline trajectory replay of a native-audio Web session.',
      before: async (harnessCtx) => {
        await route.mount(harnessCtx)
        await harnessCtx.plugin({ name: 'read-audio', inject: [...readAudioInject], apply: applyReadAudio })
      },
    })
    ctx = harness
    // The stock model-facing delegation tools, as a DSH 0.2 Web profile mounts them.
    await harness.plugin(ToolSubagent, { provider: 'spawn' })
    await harness.plugin(ToolSubagentControl)

    const main = await harness.agentLoop.create(MAIN_ID, { provider: route.provider, model: route.model }, { cwd: workspace })
    for (const turn of trajectory.main.turns) await runTurn(main, endpoint, turn.user)

    await eventually('both children settled and every child notice reached Main', () =>
      endpoint.childIds.size === 2
      && [...endpoint.childIds.keys()].every(id => harness.agents.get(SessionId(id)) === undefined)
      && CHILD_KEYS.every(child => endpoint.noticesSeen.has(`${child}:agent-message`)
        && endpoint.noticesSeen.has(`${child}:subagent-settled`)))
    await main.whenIdle()
    await harness.sessions.flush(main.session)

    expect(endpoint.errors).toEqual([])

    // Transport: every request went to the route's endpoint with its credential and no internal marker.
    for (const request of endpoint.requests) {
      expect(request.url).toBe(route.url)
      expect(request.headers.get('authorization')).toBe(route.authorization)
      expect(request.body.model).toBe(route.model)
      expect(request.raw).not.toContain('dsh-native-audio:')
      expect(request.raw).not.toContain('\\ue000')
      expect(request.raw).not.toContain('')
    }

    const audioPath = join(workspace, trajectory.audio.path)
    const readAudioText = `<path>${audioPath}</path>\n<type>audio</type>\n<content>\n`
      + `audio/wav PCM audio, ${(trajectory.audio.frames / trajectory.audio.sampleRateHz).toFixed(3)} seconds, `
      + `${trajectory.audio.sampleRateHz} Hz, ${trajectory.audio.channels} channel(s), ${trajectory.audio.bitsPerSample}-bit, `
      + `${wav.byteLength} bytes\n</content>`
    const readAudioCalls: Record<AgentKey, string> = {
      main: readAudioCallOf(trajectory.main.turns.flatMap(turn => turn.steps)),
      blind: readAudioCallOf(trajectory.children.blind.steps),
      alignment: readAudioCallOf(trajectory.children.alignment.steps),
    }
    for (const agent of ['main', ...CHILD_KEYS] as const) {
      const requests = endpoint.ofAgent(agent)
      const callId = readAudioCalls[agent]
      const first = requests.findIndex(request => request.body.messages.some(message =>
        message.role === 'tool' && message.tool_call_id === callId))
      expect(first, `${agent} request after read_audio`).toBeGreaterThan(0)
      // Before read_audio returned, the agent's requests carried no audio.
      for (const request of requests.slice(0, first)) expect(audioCount(request.body)).toBe(0)

      const audioMessages = assertReadAudioPlacement(requests[first]!.body, callId, route.placement, wav, readAudioText)
      for (const [offset, request] of requests.slice(first).entries()) {
        // One read_audio per agent: exactly one audio part in every later request.
        expect(audioCount(request.body), `${agent} request ${first + offset} audio count`).toBe(1)
        const serialized = request.body.messages.map(message => JSON.stringify(message))
        for (const message of audioMessages) expect(serialized).toContain(message)
      }

      // Prompt-cache prefix: each request of an agent extends the previous one's messages unchanged.
      for (let index = 1; index < requests.length; index += 1) {
        const previous = requests[index - 1]!.body
        const next = requests[index]!.body
        expect(next.messages.length, `${agent} request ${index} grows`).toBeGreaterThan(previous.messages.length)
        expect(
          next.messages.slice(0, previous.messages.length).map(message => JSON.stringify(message)),
          `${agent} request ${index} keeps request ${index - 1} as its prefix`,
        ).toEqual(previous.messages.map(message => JSON.stringify(message)))
        expect(JSON.stringify(next.tools), `${agent} request ${index} tools`).toBe(JSON.stringify(previous.tools))
      }
    }

    // Children start fresh: no Main user text, Main read_audio call, or Main answer in their history.
    const mainOnly = [
      ...trajectory.main.turns.map(turn => turn.user),
      readAudioCalls.main,
      trajectory.main.turns[0]!.steps.at(-1)!.text!,
    ]
    for (const child of CHILD_KEYS) {
      expect(endpoint.ofAgent(child).length).toBe(trajectory.children[child].steps.length)
      for (const request of endpoint.ofAgent(child)) {
        for (const sentinel of mainOnly) expect(request.raw).not.toContain(JSON.stringify(sentinel).slice(1, -1))
      }
    }

    // Main heard both children: each report through send_message. Because each child's last
    // tool call is that send_message, the settlement notice omits its closing text (DSH 0.2.2).
    const mainUserTexts = endpoint.ofAgent('main')
      .flatMap(request => request.body.messages)
      .filter(message => message.role === 'user')
      .map(message => textsOf(message).join(''))
    for (const [childId, child] of endpoint.childIds) {
      const [, report, closing] = trajectory.children[child].steps
      const message = report?.toolCalls?.[0]?.arguments['message']
      expect(mainUserTexts).toContain(`Agent ${childId} sent a message: ${String(message)}`)
      const notices = [...new Set(mainUserTexts.filter(text => text.startsWith(`Background subagent ${childId} finished`)))]
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain('It sent you a message just before finishing, so its closing message is omitted.')
      expect(notices[0]).not.toContain(closing!.text!)
    }

    // Durable Session logs keep the AudioBlock in each read_audio tool result; every turn completed.
    const mainLog = await loadStoredSession(harness.sessionPersistence, MAIN_ID)
    expect(toolResultTypes(mainLog.events, readAudioCalls.main)).toEqual(['text', 'audio'])
    expect(turnEndKinds(mainLog.events).length).toBeGreaterThanOrEqual(trajectory.main.turns.length + 1)
    expect(new Set(turnEndKinds(mainLog.events))).toEqual(new Set(['completed']))
    for (const [childId, child] of endpoint.childIds) {
      const childLog = await loadStoredSession(harness.sessionPersistence, SessionId(childId))
      expect(childLog.header.cwd).toBe(workspace)
      expect(toolResultTypes(childLog.events, readAudioCalls[child])).toEqual(['text', 'audio'])
      expect(turnEndKinds(childLog.events)).toEqual(['completed'])
    }
  }, 30_000)
})
