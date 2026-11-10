import type { Context } from '@deepseek-ai/cordis'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import PiAiAudioPlugin from '../../src/pi-ai-audio-plugin.js'
import type { ToolResultAudioPlacement } from '../../src/openai-compatible/wire.js'

export interface AudioRoute {
  /** The `llm-pi-ai` route as the Models page writes it. */
  profile: PiAiProviderProfile
  /** Audio settings as the provider card writes them; absent leaves audio off. */
  audio?: { toolResultAudio?: ToolResultAudioPlacement }
}

/** Stock `llm-pi-ai` routes plus the bundle's audio plugin, in bundle order. */
export async function mountAudioRoutes(ctx: Context, routes: Record<string, AudioRoute>): Promise<void> {
  await ctx.plugin(PiAi, {
    providers: Object.fromEntries(Object.entries(routes).map(([route, { profile }]) => [route, profile])),
  })
  await ctx.plugin(PiAiAudioPlugin, {
    routes: Object.fromEntries(Object.entries(routes)
      .filter(([, { audio }]) => audio !== undefined)
      .map(([route, { audio }]) => [route, audio!])),
  })
}

/** A hand-declared Chat Completions route, as the custom provider form creates it. */
export function chatCompletionsProfile(
  baseURL: string,
  models: NonNullable<PiAiProviderProfile['models']>,
  apiKeyEnv?: string,
): PiAiProviderProfile {
  return { api: 'openai-completions', baseURL, models, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) }
}
