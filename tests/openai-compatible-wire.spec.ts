import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  OpenAICompatibleAudioPayloadBridge,
  type OpenAICompatibleAudioReceipt,
} from '../src/openai-compatible/index.js'
import {
  TOOL_RESULT_AUDIO_NOTE,
  toolResultAudioLabel,
  type ToolResultAudioPlacement,
} from '../src/openai-compatible/wire.js'
import { prepareAudioFile } from '../src/store.js'
import type { AudioAttachmentLimits, StoredAudioAttachment } from '../src/types.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const limits: AudioAttachmentLimits = {
  maxAudioBytes: 1_000_000,
  maxAudiosPerMessage: 4,
  maxMessageAudioBytes: 2_000_000,
  mediaTypes: ['audio/wav'],
}

const PROVIDER = 'offline-openai-compatible'
const MODEL = 'offline-audio-model'
const MARKER_TEXT = 'dsh-native-audio:'

function fixture(sampleRateHz = 48_000): StoredAudioAttachment {
  const prepared = prepareAudioFile({
    data: syntheticWav({ sampleRateHz, channels: 2, bitsPerSample: 24 }),
    mediaType: 'audio/wav',
  }, limits)
  return { ref: prepared.ref, data: prepared.data }
}

function base64(stored: StoredAudioAttachment): string {
  return Buffer.from(stored.data).toString('base64')
}

function inputAudio(stored: StoredAudioAttachment) {
  return { type: 'input_audio', input_audio: { data: base64(stored), format: 'wav' } }
}

/** Store fake that serves each fixture by attachment id. */
function storeOf(...fixtures: StoredAudioAttachment[]) {
  const byId = new Map(fixtures.map(stored => [String(stored.ref.attachmentId), stored]))
  return vi.fn(async (ref: StoredAudioAttachment['ref']): Promise<StoredAudioAttachment> => {
    const stored = byId.get(String(ref.attachmentId))
    if (stored === undefined) throw new Error('unknown fixture')
    return stored
  })
}

function textOf(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : [])
}

type WireMessage = Record<string, unknown>
type WirePayload = { messages: WireMessage[] }

/**
 * Serialize prepared text-only messages the way DSH `PiAiAdapter` and pi-ai's
 * openai-completions provider do: a message's text blocks are concatenated
 * into one string, assistant tool calls become `tool_calls`, and each tool
 * result becomes one `tool` message.
 */
function piAiPayload(messages: GenerateOptions['messages']): WirePayload {
  return {
    messages: messages.map((message): WireMessage => {
      switch (message.role) {
        case 'user':
          return { role: 'user', content: textOf(message.content).join('') }
        case 'assistant':
          return {
            role: 'assistant',
            content: null,
            tool_calls: message.content.flatMap(block => block.type === 'tool-call'
              ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }]
              : []),
          }
        case 'tool':
          return { role: 'tool', content: textOf(message.content).join(''), tool_call_id: message.toolCallId }
        default:
          return { role: message.role, content: textOf(message.content).join('') }
      }
    }),
  }
}

function toolCall(...ids: string[]) {
  return createAssistantMessage({
    content: ids.map(id => ({ type: 'tool-call' as const, id: ToolCallId(id), name: 'listen', arguments: '{}' })),
    source: { provider: PROVIDER, model: MODEL },
  })
}

function toolResult(id: string, content: ContentBlock[]) {
  return createToolResultMessage({ callId: ToolCallId(id), content, isError: false })
}

function userText(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function request(messages: Message[]): GenerateOptions {
  return { provider: PROVIDER, model: MODEL, messages }
}

/** Prepare, serialize like pi-ai, and patch one request with the ids the adapter passes. */
async function roundTrip(
  options: GenerateOptions,
  readAudio: ReturnType<typeof storeOf>,
  toolResultAudio?: ToolResultAudioPlacement,
  edit: (payload: WirePayload) => void = () => {},
): Promise<{ payload: WirePayload; audioReceipts: OpenAICompatibleAudioReceipt[] }> {
  const bridge = new OpenAICompatibleAudioPayloadBridge()
  const prepared = await bridge.prepare(
    options,
    { readAudio },
    toolResultAudio === undefined ? {} : { toolResultAudio },
  )
  try {
    const expected = bridge.requestIdsIn({ messages: prepared.options.messages })
    const payload = piAiPayload(prepared.options.messages)
    edit(payload)
    const patched = bridge.patch(payload, expected)
    return { payload: patched.payload as WirePayload, audioReceipts: patched.audioReceipts }
  } finally {
    prepared.release()
  }
}

function receiptSummary(receipts: ReadonlyArray<Record<string, unknown>>) {
  return receipts.map(receipt => ({
    occurrence: receipt['occurrence'],
    messageIndex: receipt['messageIndex'],
    blockIndex: receipt['blockIndex'],
    sourceRole: receipt['sourceRole'],
    placement: receipt['placement'],
    wireMessageIndex: receipt['wireMessageIndex'],
    contentPartIndex: receipt['contentPartIndex'],
  }))
}

describe('OpenAI-compatible audio payload bridge', () => {
  it('changes only AudioBlock positions into input_audio parts', async () => {
    const stored = fixture()
    const readAudio = vi.fn(async (): Promise<StoredAudioAttachment> => stored)
    const options: GenerateOptions = {
      provider: PROVIDER,
      model: MODEL,
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'before ' },
          { type: 'audio', attachment: stored.ref },
          { type: 'text', text: ' between ' },
          { type: 'audio', attachment: stored.ref },
          { type: 'text', text: ' after' },
        ],
      })],
    }
    const bridge = new OpenAICompatibleAudioPayloadBridge()
    const prepared = await bridge.prepare(options, { readAudio })
    const markerText = prepared.options.messages[0]?.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (markerText === undefined) throw new Error('missing marker text')

    const patched = bridge.patch({ messages: [{ role: 'user', content: markerText }] })

    expect(readAudio).toHaveBeenCalledTimes(2)
    expect(patched.payload).toEqual({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before ' },
          inputAudio(stored),
          { type: 'text', text: ' between ' },
          inputAudio(stored),
          { type: 'text', text: ' after' },
        ],
      }],
    })
    expect(receiptSummary(patched.audioReceipts as never)).toEqual([
      {
        occurrence: 0,
        messageIndex: 0,
        blockIndex: 1,
        sourceRole: 'user',
        placement: 'user-content',
        wireMessageIndex: 0,
        contentPartIndex: 1,
      },
      {
        occurrence: 1,
        messageIndex: 0,
        blockIndex: 3,
        sourceRole: 'user',
        placement: 'user-content',
        wireMessageIndex: 0,
        contentPartIndex: 3,
      },
    ])
    prepared.release()
  })

  it('sends tool result audio inside the tool message under tool-message placement', async () => {
    const stored = fixture()
    const readAudio = storeOf(stored)
    const patched = await roundTrip(request([
      userText('listen'),
      toolCall('listen-call'),
      toolResult('listen-call', [{ type: 'text', text: 'Rendered clip.' }, { type: 'audio', attachment: stored.ref }]),
    ]), readAudio, 'tool-message')

    expect(readAudio).toHaveBeenCalledTimes(1)
    expect(patched.payload['messages']).toEqual([
      { role: 'user', content: 'listen' },
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'tool',
        tool_call_id: 'listen-call',
        content: [{ type: 'text', text: 'Rendered clip.' }, inputAudio(stored)],
      },
    ])
    expect(receiptSummary(patched.audioReceipts as never)).toEqual([{
      occurrence: 0,
      messageIndex: 2,
      blockIndex: 1,
      sourceRole: 'tool',
      placement: 'tool-message',
      wireMessageIndex: 2,
      contentPartIndex: 1,
    }])
    expect(patched.audioReceipts[0]).toMatchObject({
      attachmentId: String(stored.ref.attachmentId),
      mediaType: 'audio/wav',
      sourceBytes: stored.data.byteLength,
      inlineBase64Bytes: base64(stored).length,
    })
  })

  it('moves tool result audio into one labeled user message after the tool run by default', async () => {
    const stored = fixture()
    const readAudio = storeOf(stored)
    const patched = await roundTrip(request([
      userText('listen'),
      toolCall('listen-call'),
      toolResult('listen-call', [{ type: 'text', text: 'Rendered clip.' }, { type: 'audio', attachment: stored.ref }]),
    ]), readAudio)

    expect(patched.payload['messages']).toEqual([
      { role: 'user', content: 'listen' },
      expect.objectContaining({ role: 'assistant' }),
      { role: 'tool', tool_call_id: 'listen-call', content: `Rendered clip.\n${TOOL_RESULT_AUDIO_NOTE}` },
      {
        role: 'user',
        content: [{ type: 'text', text: toolResultAudioLabel('listen-call') }, inputAudio(stored)],
      },
    ])
    expect(toolResultAudioLabel('listen-call')).toBe('Audio returned by tool call listen-call:')
    expect(TOOL_RESULT_AUDIO_NOTE).toBe('[audio attached in the next user message]')
    expect(receiptSummary(patched.audioReceipts as never)).toEqual([{
      occurrence: 0,
      messageIndex: 2,
      blockIndex: 1,
      sourceRole: 'tool',
      placement: 'tool-followup',
      wireMessageIndex: 3,
      contentPartIndex: 1,
    }])
  })

  it('labels each audio-bearing call once, in tool order, in a single follow-up for the run', async () => {
    const first = fixture(48_000)
    const second = fixture(44_100)
    const third = fixture(32_000)
    const userAudio = fixture(16_000)
    const readAudio = storeOf(first, second, third, userAudio)
    const patched = await roundTrip(request([
      userText('listen to all three'),
      toolCall('call-a', 'call-b', 'call-c'),
      toolResult('call-a', [
        { type: 'text', text: 'Two takes.' },
        { type: 'audio', attachment: first.ref },
        { type: 'audio', attachment: second.ref },
      ]),
      toolResult('call-b', [{ type: 'text', text: 'No audio here.' }]),
      toolResult('call-c', [{ type: 'audio', attachment: third.ref }]),
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Compare with mine: ' }, { type: 'audio', attachment: userAudio.ref }],
      }),
    ]), readAudio)

    expect(patched.payload['messages']).toEqual([
      { role: 'user', content: 'listen to all three' },
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'tool',
        tool_call_id: 'call-a',
        content: `Two takes.\n${TOOL_RESULT_AUDIO_NOTE}\n${TOOL_RESULT_AUDIO_NOTE}`,
      },
      { role: 'tool', tool_call_id: 'call-b', content: 'No audio here.' },
      { role: 'tool', tool_call_id: 'call-c', content: TOOL_RESULT_AUDIO_NOTE },
      {
        role: 'user',
        content: [
          { type: 'text', text: toolResultAudioLabel('call-a') },
          inputAudio(first),
          inputAudio(second),
          { type: 'text', text: toolResultAudioLabel('call-c') },
          inputAudio(third),
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Compare with mine: ' }, inputAudio(userAudio)] },
    ])
    expect(receiptSummary(patched.audioReceipts as never)).toEqual([
      {
        occurrence: 0,
        messageIndex: 2,
        blockIndex: 1,
        sourceRole: 'tool',
        placement: 'tool-followup',
        wireMessageIndex: 5,
        contentPartIndex: 1,
      },
      {
        occurrence: 1,
        messageIndex: 2,
        blockIndex: 2,
        sourceRole: 'tool',
        placement: 'tool-followup',
        wireMessageIndex: 5,
        contentPartIndex: 2,
      },
      {
        occurrence: 2,
        messageIndex: 4,
        blockIndex: 0,
        sourceRole: 'tool',
        placement: 'tool-followup',
        wireMessageIndex: 5,
        contentPartIndex: 4,
      },
      {
        occurrence: 3,
        messageIndex: 5,
        blockIndex: 1,
        sourceRole: 'user',
        placement: 'user-content',
        wireMessageIndex: 6,
        contentPartIndex: 1,
      },
    ])
  })

  it('replaces only the marker inside surrounding tool text', async () => {
    const stored = fixture()
    const readAudio = storeOf(stored)
    const history = request([
      toolCall('inline-call'),
      toolResult('inline-call', [{ type: 'audio', attachment: stored.ref }]),
    ])
    const surround = (payload: WirePayload) => {
      const tool = payload.messages[1]!
      tool['content'] = `before ${String(tool['content'])} after`
    }

    const followup = await roundTrip(history, readAudio, 'user-message', surround)
    expect(followup.payload['messages']).toMatchObject([
      { role: 'assistant' },
      { role: 'tool', tool_call_id: 'inline-call', content: `before ${TOOL_RESULT_AUDIO_NOTE} after` },
      { role: 'user', content: [{ type: 'text', text: toolResultAudioLabel('inline-call') }, inputAudio(stored)] },
    ])

    const inTool = await roundTrip(history, readAudio, 'tool-message', surround)
    expect(inTool.payload['messages']).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'tool',
        tool_call_id: 'inline-call',
        content: [{ type: 'text', text: 'before ' }, inputAudio(stored), { type: 'text', text: ' after' }],
      },
    ])
    expect(inTool.audioReceipts.map(receipt => receipt.contentPartIndex)).toEqual([1])
  })

  it('puts the audio follow-up directly after the tool run, ahead of pi-ai\'s image follow-up', async () => {
    const stored = fixture()
    const readAudio = storeOf(stored)
    const imageFollowup = {
      role: 'user',
      content: [
        { type: 'text', text: 'Attached image(s) from tool result:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }
    const history = request([
      toolCall('render-call', 'shot-call'),
      toolResult('render-call', [{ type: 'text', text: 'Rendered.' }, { type: 'audio', attachment: stored.ref }]),
      toolResult('shot-call', [{ type: 'text', text: 'Screenshot.' }]),
    ])
    const withImages = (payload: WirePayload) => {
      payload.messages.push(structuredClone(imageFollowup))
    }

    const followup = await roundTrip(history, readAudio, 'user-message', withImages)
    expect((followup.payload['messages'] as WireMessage[]).map(message => message['role']))
      .toEqual(['assistant', 'tool', 'tool', 'user', 'user'])
    expect((followup.payload['messages'] as WireMessage[])[3]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: toolResultAudioLabel('render-call') }, inputAudio(stored)],
    })
    expect((followup.payload['messages'] as WireMessage[])[4]).toEqual(imageFollowup)
    expect(followup.audioReceipts.map(receipt => receipt.wireMessageIndex)).toEqual([3])

    const inTool = await roundTrip(history, readAudio, 'tool-message', withImages)
    expect((inTool.payload['messages'] as WireMessage[]).map(message => message['role']))
      .toEqual(['assistant', 'tool', 'tool', 'user'])
    expect((inTool.payload['messages'] as WireMessage[])[3]).toEqual(imageFollowup)
  })

  it.each(['user-message', 'tool-message'] as const)(
    'serializes the same history to the same wire messages on every request (%s)',
    async (placement) => {
      const first = fixture(48_000)
      const second = fixture(44_100)
      const readAudio = storeOf(first, second)
      const history = request([
        userText('render twice'),
        toolCall('round-1'),
        toolResult('round-1', [{ type: 'text', text: 'First render.' }, { type: 'audio', attachment: first.ref }]),
        toolCall('round-2'),
        toolResult('round-2', [{ type: 'text', text: 'Second render.' }, { type: 'audio', attachment: second.ref }]),
      ])

      const once = await roundTrip(history, readAudio, placement)
      const again = await roundTrip(history, readAudio, placement)

      expect(again.payload).toEqual(once.payload)
      expect(again.audioReceipts).toEqual(once.audioReceipts)
      expect(JSON.stringify(once.payload)).not.toContain(MARKER_TEXT)
      const roles = (once.payload['messages'] as WireMessage[]).map(message => message['role'])
      expect(roles).toEqual(placement === 'user-message'
        ? ['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user']
        : ['user', 'assistant', 'tool', 'assistant', 'tool'])
      expect(once.audioReceipts.map(receipt => receipt.wireMessageIndex))
        .toEqual(placement === 'user-message' ? [3, 6] : [2, 4])
    },
  )

  it('requires tool_call_id on a tool message whose audio moves to the follow-up', async () => {
    const stored = fixture()
    const readAudio = storeOf(stored)
    const history = request([
      toolCall('listen-call'),
      toolResult('listen-call', [{ type: 'audio', attachment: stored.ref }]),
    ])

    await expect(roundTrip(history, readAudio, 'user-message', (payload) => {
      delete payload.messages[1]!['tool_call_id']
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('tool message with audio has no tool_call_id'),
    })
    await expect(roundTrip(history, readAudio, 'user-message', (payload) => {
      payload.messages[1]!['tool_call_id'] = ''
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    // Tool-message placement keeps pi-ai's tool message as is and needs no label.
    await expect(roundTrip(history, readAudio, 'tool-message', (payload) => {
      delete payload.messages[1]!['tool_call_id']
    })).resolves.toMatchObject({ audioReceipts: [{ placement: 'tool-message' }] })
  })

  it.each(['user-message', 'tool-message'] as const)(
    'rejects a dropped, fully dropped, or duplicated marker (%s)',
    async (placement) => {
      const first = fixture(48_000)
      const second = fixture(44_100)
      const readAudio = storeOf(first, second)
      const history = request([
        toolCall('listen-call'),
        toolResult('listen-call', [
          { type: 'audio', attachment: first.ref },
          { type: 'audio', attachment: second.ref },
        ]),
      ])
      const markers = (payload: WirePayload) =>
        String(payload.messages[1]!['content']).match(/\uE000dsh-native-audio:[^\uE001]+\uE001/gu) ?? []

      await expect(roundTrip(history, readAudio, placement, (payload) => {
        expect(markers(payload)).toHaveLength(2)
        payload.messages[1]!['content'] = markers(payload)[0]
      })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('audio occurrence 1 was not preserved exactly once'),
      })
      await expect(roundTrip(history, readAudio, placement, (payload) => {
        payload.messages[1]!['content'] = 'every marker dropped'
      })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('audio occurrence 0 was not preserved exactly once'),
      })
      await expect(roundTrip(history, readAudio, placement, (payload) => {
        const [marker] = markers(payload)
        payload.messages[1]!['content'] = `${String(payload.messages[1]!['content'])}${marker}`
      })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('audio occurrence 0 was not preserved exactly once'),
      })
    },
  )

  it('keeps marker-shaped text from no prepared request as ordinary text', async () => {
    const stored = fixture()
    const readAudio = storeOf(stored)
    const foreign = '\uE000dsh-native-audio:00000000-0000-0000-0000-000000000000:0\uE001'

    const textOnly = await roundTrip(request([userText(`quoted ${foreign}`)]), readAudio)
    expect(textOnly.payload.messages).toEqual([{ role: 'user', content: `quoted ${foreign}` }])

    const withAudio = await roundTrip(request([
      userText(`quoted ${foreign}`),
      toolCall('listen-call'),
      toolResult('listen-call', [{ type: 'text', text: `log ${foreign}` }, { type: 'audio', attachment: stored.ref }]),
    ]), readAudio, 'user-message')
    expect(withAudio.payload.messages[0]).toEqual({ role: 'user', content: `quoted ${foreign}` })
    expect(withAudio.payload.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'listen-call',
      content: `log ${foreign}\n${TOOL_RESULT_AUDIO_NOTE}`,
    })
    expect(withAudio.audioReceipts.map(receipt => receipt.placement)).toEqual(['tool-followup'])
  })

  it('rejects audio in an assistant message before reading attachment bytes', async () => {
    const stored = fixture()
    const readAudio = storeOf(stored)
    const bridge = new OpenAICompatibleAudioPayloadBridge()
    const options = request([
      userText('listen'),
      createAssistantMessage({
        content: [{ type: 'audio', attachment: stored.ref }],
        source: { provider: PROVIDER, model: MODEL },
      }),
    ])

    for (const toolResultAudio of ['user-message', 'tool-message'] as const) {
      await expect(bridge.prepare(options, { readAudio }, { toolResultAudio })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CONTENT',
        message: expect.stringContaining('audio in an assistant message'),
      })
    }
    expect(readAudio).not.toHaveBeenCalled()
  })

  it('returns audio-free requests unchanged, including tool messages', async () => {
    const readAudio = vi.fn()
    const bridge = new OpenAICompatibleAudioPayloadBridge()
    const options: GenerateOptions = {
      provider: PROVIDER,
      model: MODEL,
      messages: [createToolResultMessage({
        callId: ToolCallId('text-call'),
        content: [{ type: 'text', text: 'plain result' }],
        isError: false,
      })],
    }
    const prepared = await bridge.prepare(options, { readAudio })
    expect(prepared.options).toBe(options)
    expect(readAudio).not.toHaveBeenCalled()
    prepared.release()
  })
})
