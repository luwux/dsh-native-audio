import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Whether one message's content contains a durable native-audio occurrence. */
export function contentHasAudio(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'audio')
}

/** Whether one complete provider request contains native-audio content. */
export function requestHasAudio(options: Pick<GenerateOptions, 'messages'>): boolean {
  return options.messages.some(message => contentHasAudio(message.content))
}

function rejectUnsupportedAudio(provider: string): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `Native audio is off for provider route "${provider}". Turn on "Native audio input" on its card in Settings > Models, or pick a model that has it on.`,
      'UNSUPPORTED_CONTENT',
    )
  })()
}

/**
 * Prevent stock text/image serializers from silently dropping AudioBlock.
 *
 * The allowlist names routes whose adapters own an audited audio serializer.
 * Provider adapters still repeat their exact-model and role checks at their
 * final wire boundary; this listener protects requests routed elsewhere.
 */
export function installAudioRouteGuard(
  ctx: Context,
  allowedProviders: Pick<ReadonlySet<string>, 'has'>,
): () => void {
  return ctx.on('llm/stream', (options, next) => {
    if (!requestHasAudio(options) || allowedProviders.has(options.provider)) return next()
    return rejectUnsupportedAudio(options.provider)
  }, { global: true, prepend: true })
}
