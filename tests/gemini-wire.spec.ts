import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  offloadedImageText,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  GEMINI_THINKING_LEVELS,
  isGeminiThinkingLevel,
  readGeminiReplayState,
  serializeGeminiRequest,
  type GeminiReplayResponse,
} from '../src/gemini/index.js'
import { prepareAudioFile } from '../src/store.js'
import type { AudioAttachmentLimits, StoredAudioAttachment } from '../src/types.js'
import { syntheticWav } from './fixtures/synthetic-wav.js'

const limits: AudioAttachmentLimits = {
  maxAudioBytes: 1_000_000,
  maxAudiosPerMessage: 8,
  maxMessageAudioBytes: 2_000_000,
  mediaTypes: ['audio/wav'],
}

function audioFixture(): StoredAudioAttachment {
  const prepared = prepareAudioFile({
    data: syntheticWav({ bitsPerSample: 24, sampleRateHz: 48_000, channels: 2 }),
    mediaType: 'audio/wav',
  }, limits)
  return { ref: prepared.ref, data: prepared.data }
}

function options(messages: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'google-gemini',
    model: 'gemini-3-flash-preview',
    messages,
  }
}

describe('Gemini request serialization', () => {
  it('materializes every ordered WAV occurrence with one receipt and byte-identical base64', async () => {
    const stored = audioFixture()
    const readAudio = vi.fn(async (): Promise<StoredAudioAttachment> => stored)
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '先听 A。' },
        { type: 'audio', attachment: stored.ref },
        { type: 'audio', attachment: stored.ref },
      ],
    })
    const request: GenerateOptions = {
      ...options([message]),
      system: 'You are the Music agent.',
      tools: [{
        name: 'mark_section',
        description: 'Mark one time range.',
        parameters: {
          type: 'object',
          properties: { start: { type: 'number' } },
          required: ['start'],
          additionalProperties: false,
        },
      }],
      temperature: 0.2,
      maxTokens: 321,
      stop: ['END'],
    }

    const serialized = await serializeGeminiRequest(request, { readAudio })

    expect(readAudio).toHaveBeenCalledTimes(2)
    expect(serialized.audioReceipts).toHaveLength(2)
    expect(serialized.audioReceipts.map(receipt => ({
      occurrence: receipt.occurrence,
      blockIndex: receipt.blockIndex,
      contentIndex: receipt.contentIndex,
      partIndex: receipt.partIndex,
      attachmentId: receipt.attachmentId,
    }))).toEqual([
      { occurrence: 0, blockIndex: 1, contentIndex: 0, partIndex: 1, attachmentId: stored.ref.attachmentId },
      { occurrence: 1, blockIndex: 2, contentIndex: 0, partIndex: 2, attachmentId: stored.ref.attachmentId },
    ])
    const parts = serialized.body.contents[0]?.parts ?? []
    for (const part of parts.slice(1)) {
      expect('inlineData' in part).toBe(true)
      if (!('inlineData' in part)) continue
      expect(part.inlineData.mimeType).toBe('audio/wav')
      expect(new Uint8Array(Buffer.from(part.inlineData.data, 'base64'))).toEqual(stored.data)
    }
    expect(serialized.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'You are the Music agent.' }] },
      tools: [{
        functionDeclarations: [{
          name: 'mark_section',
          description: 'Mark one time range.',
          parametersJsonSchema: {
            type: 'object',
            required: ['start'],
            additionalProperties: false,
          },
        }],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 321,
        stopSequences: ['END'],
      },
    })
    expect(serialized.utf8Bytes).toBe(Buffer.byteLength(serialized.bodyText, 'utf8'))

    await expect(serializeGeminiRequest(request, { readAudio }, serialized.utf8Bytes - 1))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(serializeGeminiRequest(request, { readAudio }, serialized.utf8Bytes))
      .resolves.toMatchObject({ utf8Bytes: serialized.utf8Bytes })
  })

  it('replays function-call thought signatures in their original native parts and correlates responses', async () => {
    const response: GeminiReplayResponse = {
      kind: 'gemini-generate-content',
      version: 1,
      provider: 'google-gemini',
      model: 'gemini-3-flash-preview',
      finishReason: 'STOP',
      responseId: 'response-1',
    }
    const assistant = createAssistantMessage({
      content: [
        { type: 'tool-call', id: ToolCallId('call-a'), name: 'inspect', arguments: '{"bar":1}' },
        { type: 'tool-call', id: ToolCallId('call-b'), name: 'inspect', arguments: '{"bar":2}' },
      ],
      source: {
        provider: 'google-gemini',
        model: 'gemini-3-flash-preview',
        replayState: {
          response,
          blocks: [
            {
              type: 'tool-call',
              nativeContentIndex: 0,
              nativePartIndex: 0,
              thoughtSignature: 'signature-a',
            },
            { type: 'tool-call', nativeContentIndex: 0, nativePartIndex: 1 },
          ],
        },
      },
    })
    const resultA = createToolResultMessage({
      callId: ToolCallId('call-a'),
      content: [{ type: 'text', text: 'first result' }],
      isError: false,
    })
    const resultB = createToolResultMessage({
      callId: ToolCallId('call-b'),
      content: [{ type: 'text', text: 'failed result' }],
      isError: true,
    })
    const readAudio = vi.fn()

    const serialized = await serializeGeminiRequest(options([
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect' }] }),
      assistant,
      resultA,
      resultB,
    ]), { readAudio })

    expect(serialized.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'inspect' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'call-a', name: 'inspect', args: { bar: 1 } },
            thoughtSignature: 'signature-a',
          },
          { functionCall: { id: 'call-b', name: 'inspect', args: { bar: 2 } } },
        ],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call-a',
            name: 'inspect',
            response: { output: 'first result' },
          },
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call-b',
            name: 'inspect',
            response: { error: 'failed result' },
          },
        }],
      },
    ])
    expect(readAudio).not.toHaveBeenCalled()
  })

  it('fails closed on same-provider assistant messages without replay metadata', async () => {
    const readAudio = vi.fn()
    const missingReplay = createAssistantMessage({
      content: [{ type: 'text', text: 'model text' }],
      source: { provider: 'google-gemini', model: 'gemini-3-flash-preview' },
    })
    await expect(serializeGeminiRequest(options([missingReplay]), { readAudio }))
      .rejects.toMatchObject({ code: 'INVALID_REPLAY_STATE' })
    expect(readAudio).not.toHaveBeenCalled()
  })

  it('sends tool-message audio as a sibling part of the functionResponse content', async () => {
    const stored = audioFixture()
    const readAudio = vi.fn(async (): Promise<StoredAudioAttachment> => stored)
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('audio-result'), name: 'listen', arguments: '{}' }],
      source: {
        provider: 'google-gemini',
        model: 'gemini-3-flash-preview',
        replayState: {
          response: {
            kind: 'gemini-generate-content', version: 1, provider: 'google-gemini',
            model: 'gemini-3-flash-preview', finishReason: 'STOP',
          },
          blocks: [{
            type: 'tool-call', nativeContentIndex: 0, nativePartIndex: 0,
            thoughtSignature: 'required',
          }],
        },
      },
    })
    const toolAudio = createToolResultMessage({
      callId: ToolCallId('audio-result'),
      content: [
        { type: 'text', text: 'Local WAV attached.' },
        { type: 'audio', attachment: stored.ref },
      ],
      isError: false,
    })
    const serialized = await serializeGeminiRequest(options([assistant, toolAudio]), { readAudio })
    expect(serialized.body.contents).toHaveLength(2)
    expect(serialized.body.contents[1]).toMatchObject({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'audio-result',
            name: 'listen',
            response: { output: 'Local WAV attached.' },
          },
        },
        { inlineData: { mimeType: 'audio/wav' } },
      ],
    })
    const audioPart = serialized.body.contents[1]?.parts[1]
    expect(audioPart !== undefined && 'inlineData' in audioPart
      ? new Uint8Array(Buffer.from(audioPart.inlineData.data, 'base64'))
      : undefined).toEqual(stored.data)
    expect(readAudio).toHaveBeenCalledTimes(1)
    expect(serialized.audioReceipts).toEqual([expect.objectContaining({
      occurrence: 0,
      messageIndex: 1,
      blockIndex: 1,
      contentIndex: 1,
      partIndex: 1,
      attachmentId: stored.ref.attachmentId,
      transport: 'inline',
    })])
    expect(serialized.audioReceipts[0]).not.toHaveProperty('nestedBlockIndex')
  })

  it('rejects tool messages that do not answer a preceding function call or disagree with their source', async () => {
    const readAudio = vi.fn()
    const orphan = createToolResultMessage({
      callId: ToolCallId('missing'),
      content: [{ type: 'text', text: 'orphan' }],
      isError: false,
    })
    await expect(serializeGeminiRequest(options([orphan]), { readAudio }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    const mismatched = { ...orphan, source: { kind: 'tool' as const, callId: ToolCallId('other') } }
    await expect(serializeGeminiRequest(options([mismatched]), { readAudio }))
      .rejects.toThrow('does not match its message source')
  })

  it('maps a leading system message to systemInstruction and later system messages to user text', async () => {
    const readAudio = vi.fn()
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
    const leading = createSystemMessage('You are the Music agent.')
    const later = createSystemMessage('Tempo changed to 128 BPM.')

    const loopBuilt = await serializeGeminiRequest(options([leading, user, later]), { readAudio })
    expect(loopBuilt.body.systemInstruction).toEqual({ parts: [{ text: 'You are the Music agent.' }] })
    expect(loopBuilt.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ text: 'Tempo changed to 128 BPM.' }] },
    ])

    const explicit = await serializeGeminiRequest({
      ...options([leading, user]),
      system: 'Explicit system prompt.',
    }, { readAudio })
    expect(explicit.body.systemInstruction).toEqual({ parts: [{ text: 'Explicit system prompt.' }] })
    expect(explicit.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'You are the Music agent.' }] },
      { role: 'user', parts: [{ text: 'hello' }] },
    ])

    const empty = await serializeGeminiRequest(
      options([createSystemMessage(''), user, createSystemMessage('')]),
      { readAudio },
    )
    expect(empty.body).not.toHaveProperty('systemInstruction')
    expect(empty.body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
    expect(readAudio).not.toHaveBeenCalled()
  })

  it('rejects developer messages because the Gemini route declares no tool-update mode', async () => {
    const developer = createDeveloperMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'tools changed' }],
    })
    await expect(serializeGeminiRequest(options([
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
      developer,
    ]), { readAudio: vi.fn() })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('sends the stock offloaded-image placeholder text without reading image bytes', async () => {
    const image: ImageAttachmentRef = {
      attachmentId: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' as never,
      mediaType: 'image/png',
      bytes: 64,
      width: 8,
      height: 8,
      name: 'score.png',
    }
    const readImage = vi.fn()
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('shot'), name: 'screenshot', arguments: '{}' }],
      source: {
        provider: 'google-gemini',
        model: 'gemini-3-flash-preview',
        replayState: {
          response: {
            kind: 'gemini-generate-content', version: 1, provider: 'google-gemini',
            model: 'gemini-3-flash-preview', finishReason: 'STOP',
          },
          blocks: [{ type: 'tool-call', nativeContentIndex: 0, nativePartIndex: 0 }],
        },
      },
    })
    const serialized = await serializeGeminiRequest(options([
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: image, offloaded: true }],
      }),
      assistant,
      createToolResultMessage({
        callId: ToolCallId('shot'),
        content: [{ type: 'image', attachment: image, offloaded: true }],
        isError: false,
      }),
    ]), { readAudio: vi.fn() }, undefined, undefined, { readImage })
    const placeholder = offloadedImageText(image)
    expect(serialized.body.contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'look' }, { text: placeholder }],
    })
    expect(serialized.body.contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { id: 'shot', name: 'screenshot', response: { output: '(no output)' } } },
        { text: placeholder },
      ],
    })
    expect(readImage).not.toHaveBeenCalled()
  })

  it('maps reasoning effort to thinkingConfig.thinkingLevel and adds includeThoughts only on request', async () => {
    const readAudio = vi.fn()
    const base = options([
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'think' }] }),
    ])
    expect(GEMINI_THINKING_LEVELS).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(isGeminiThinkingLevel('medium')).toBe(true)
    expect(isGeminiThinkingLevel('max')).toBe(false)

    for (const level of GEMINI_THINKING_LEVELS) {
      const serialized = await serializeGeminiRequest(
        { ...base, reasoningEffort: ReasoningEffortId(level) },
        { readAudio },
      )
      expect(serialized.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: level } })
    }

    const plain = await serializeGeminiRequest(base, { readAudio })
    expect(plain.body).not.toHaveProperty('generationConfig')
    const thoughtsOff = await serializeGeminiRequest(
      base, { readAudio }, undefined, undefined, undefined, { includeThoughts: false },
    )
    expect(thoughtsOff.body).not.toHaveProperty('generationConfig')
    const thoughtsOnly = await serializeGeminiRequest(
      base, { readAudio }, undefined, undefined, undefined, { includeThoughts: true },
    )
    expect(thoughtsOnly.body.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } })
    const both = await serializeGeminiRequest(
      { ...base, reasoningEffort: ReasoningEffortId('low'), temperature: 0.5 },
      { readAudio }, undefined, undefined, undefined, { includeThoughts: true },
    )
    expect(both.body.generationConfig).toEqual({
      temperature: 0.5,
      thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
    })

    await expect(serializeGeminiRequest(
      { ...base, reasoningEffort: ReasoningEffortId('max') },
      { readAudio },
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('validates replay envelopes before trusting their block metadata', () => {
    expect(() => readGeminiReplayState({
      response: {
        kind: 'gemini-generate-content',
        version: 1,
        provider: 'google-gemini',
        model: 'gemini-3',
        finishReason: 'STOP',
      },
      blocks: [{ type: 'reasoning', nativeContentIndex: 0, nativePartIndex: 0 }],
    })).toThrow('invalid Gemini replay state')
  })
})
