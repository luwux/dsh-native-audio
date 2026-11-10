import type { ContentBlock, ModelModality } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { AudioBlock } from '../src/index.js'

describe('DSH audio declarations', () => {
  it('widens ContentBlock and ModelModality through declaration merging', () => {
    const block: AudioBlock = {
      type: 'audio',
      attachment: {
        attachmentId: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as never,
        mediaType: 'audio/wav',
        bytes: 48,
        encoding: 'pcm',
        sampleRateHz: 48000,
        channels: 1,
        bitsPerSample: 16,
        validBitsPerSample: 16,
        sampleFrames: 1,
      },
    }
    const content: ContentBlock = block
    const modality: ModelModality = 'audio'

    expect(content).toBe(block)
    expect(modality).toBe('audio')
  })
})
