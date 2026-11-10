import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  GEMINI_INLINE_REQUEST_MAX_BYTES,
  GEMINI_THINKING_LEVELS,
  GeminiFileCache,
  GeminiGenerateContentAdapter,
  type GeminiAdvertisedModel,
  type GeminiThinkingLevel,
} from './gemini/index.js'
import { plainOptions, type PlainOptions } from './volatile.js'

export const name = 'dsh-native-audio-gemini'
export const inject = ['llm', 'audioAttachments']

/** Provider route kept distinct from Pi's Google route. */
export const GEMINI_AUDIO_PROVIDER = 'google-gemini-audio'
/** Profile entry id the bundle patch gives this plugin; Settings forms address the entry by it. */
export const GEMINI_AUDIO_ENTRY_ID = 'llm-google-gemini-audio'
export const DEFAULT_GEMINI_API_KEY_ENV = 'GEMINI_API_KEY'
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

export const DEFAULT_GEMINI_MODELS: readonly GeminiAdvertisedModel[] = Object.freeze([
  Object.freeze({
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'General multimodal Gemini model with native audio understanding.',
    thinkingLevels: Object.freeze([...GEMINI_THINKING_LEVELS]),
  }),
])

/** Parsed plugin Config; every field is a live Settings reference. */
export interface Config {
  /** Credential reference, never the API key value itself. */
  apiKeyEnv: Volatile<string>
  /** Gemini Developer API origin. */
  baseURL: Volatile<string | undefined>
  /** Exact UTF-8 limit for the final inline JSON request. */
  maxInlineRequestBytes: Volatile<number>
  /** Audio wire mode. Files uploads once and reuses the stable provider file URI. */
  audioTransport: Volatile<'inline' | 'files'>
  /** Request Gemini thought summaries, shown as Harness reasoning blocks. */
  includeThoughts: Volatile<boolean>
  /** Advisory model catalog shown by DSH model selectors. */
  models: Volatile<GeminiAdvertisedModel[]>
}

/** Plain values accepted by the resolver and by programmatic composition. */
export type Options = PlainOptions<Config>

const thinkingLevel: z<GeminiThinkingLevel> = z.union([...GEMINI_THINKING_LEVELS])

// The schema output is a mutable copy of the readonly catalog entry.
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  thinkingLevels: z.array(thinkingLevel),
  defaultThinkingLevel: thinkingLevel,
}) as unknown as z<GeminiAdvertisedModel>

export const Config: z<Options, Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_GEMINI_API_KEY_ENV).volatile(),
  baseURL: z.string().volatile(),
  maxInlineRequestBytes: z.number().step(1).min(1).default(GEMINI_INLINE_REQUEST_MAX_BYTES).volatile(),
  audioTransport: z.union(['inline', 'files']).default('files').volatile(),
  includeThoughts: z.boolean().default(true).volatile(),
  models: z.array(catalogModel).default(DEFAULT_GEMINI_MODELS.map(model => ({
    ...model,
    ...(model.thinkingLevels === undefined ? {} : { thinkingLevels: [...model.thinkingLevels] }),
  }))).volatile(),
}) as unknown as z<Options, Config>

interface ResolvedConfig {
  apiKeyEnv: ReturnType<typeof credentialRef>
  baseURL: string
  maxInlineRequestBytes: number
  audioTransport: 'inline' | 'files'
  includeThoughts: boolean
  models: GeminiAdvertisedModel[]
}

function resolveModels(models: readonly GeminiAdvertisedModel[] | undefined): GeminiAdvertisedModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_GEMINI_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('dsh-native-audio: Gemini model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`dsh-native-audio: duplicate Gemini model "${model.id}"`)
    seen.add(model.id)
    const levels = model.thinkingLevels === undefined ? undefined : [...new Set(model.thinkingLevels)]
    if (model.defaultThinkingLevel !== undefined && levels?.includes(model.defaultThinkingLevel) !== true) {
      throw new Error(
        `dsh-native-audio: Gemini model "${model.id}" default thinking level must be one of its thinkingLevels`,
      )
    }
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(levels === undefined ? {} : { thinkingLevels: levels }),
      ...(model.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: model.defaultThinkingLevel }),
    }
  })
}

/** Resolve one detached request generation from the plugin's current option values. */
export function resolveGeminiPluginConfig(ctx: Context, config: Options): ResolvedConfig {
  const maxInlineRequestBytes = config.maxInlineRequestBytes ?? GEMINI_INLINE_REQUEST_MAX_BYTES
  if (!Number.isSafeInteger(maxInlineRequestBytes) || maxInlineRequestBytes <= 0) {
    throw new Error('dsh-native-audio: maxInlineRequestBytes must be a positive safe integer')
  }
  const baseURL = config.baseURL
    ?? (launchEnvironmentOf(ctx).get('GEMINI_BASE_URL')?.value || undefined)
    ?? DEFAULT_GEMINI_BASE_URL
  if (baseURL.length === 0) throw new Error('dsh-native-audio: Gemini baseURL must be non-empty')
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_GEMINI_API_KEY_ENV),
    baseURL,
    maxInlineRequestBytes,
    audioTransport: config.audioTransport ?? 'files',
    includeThoughts: config.includeThoughts ?? true,
    models: resolveModels(config.models),
  }
}

/**
 * One registered adapter whose per-operation delegate snapshots live settings.
 * In-flight streams keep their starting endpoint/catalog/limits, while the next
 * operation observes a committed settings change without a route gap.
 */
class ReloadableGeminiAdapter extends LlmAdapter {
  constructor(private readonly snapshot: () => GeminiGenerateContentAdapter) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.snapshot().providerInfo(provider)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.snapshot().listModels(provider)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.snapshot().resolveModel(provider, model, signal)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    // Bind model metadata and dispatch to one settings generation.
    const delegate = this.snapshot()
    return {
      model: await delegate.resolveModel(provider, model, signal),
      stream: options => delegate.stream(options),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.snapshot().stream(options)
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = (): ResolvedConfig => resolveGeminiPluginConfig(ctx, plainOptions(config))
  const fileCache = new GeminiFileCache()

  // Fail loudly at composition time for an invalid entry, just like DSH's
  // first-party adapters. Later Settings edits are re-judged per operation.
  resolved()

  const adapter = new ReloadableGeminiAdapter(() => {
    const connection = resolved()
    const imageAttachments = ctx.get('attachments')
    return new GeminiGenerateContentAdapter({
      provider: GEMINI_AUDIO_PROVIDER,
      providerName: 'Google Gemini Native Audio',
      baseUrl: connection.baseURL,
      maxInlineRequestBytes: connection.maxInlineRequestBytes,
      audioTransport: connection.audioTransport,
      includeThoughts: connection.includeThoughts,
      fileCache,
      models: connection.models,
      audioAttachments: ctx.audioAttachments,
      ...(imageAttachments === undefined ? {} : { imageAttachments }),
      fetch: (input, init) => globalThis.fetch(input, init),
      resolveCredential: async () => {
        const ref = connection.apiKeyEnv
        const credentials = ctx.get('credentials')
        if (credentials !== undefined) {
          const hit = await credentials.resolve(ref)
          if (hit !== undefined) return { apiKey: hit.value, ref }
        } else {
          const ambient = launchEnvironmentOf(ctx).get(ref)
          if (ambient !== undefined && ambient.value.length > 0) {
            return { apiKey: ambient.value, ref }
          }
        }
        throw new LlmError(
          `dsh-native-audio: no API key for provider route "${GEMINI_AUDIO_PROVIDER}"; store ${ref}`
          + ` through the credentials service or export ${ref} in the launching environment`,
          'MISSING_CREDENTIAL',
        )
      },
    })
  })

  ctx.llm.registerConfigurableProviders([{
    provider: GEMINI_AUDIO_PROVIDER,
    displayName: 'Google Gemini Native Audio',
    settingsNs: ctx.fiber.entry?.options.id ?? GEMINI_AUDIO_ENTRY_ID,
    settingsPath: [],
  }])
  ctx.llm.registerAdapter([GEMINI_AUDIO_PROVIDER], adapter)
  ctx.effect(
    () => ctx.audioAttachments.registerAudioProvider(GEMINI_AUDIO_PROVIDER),
    `register native-audio provider ${GEMINI_AUDIO_PROVIDER}`,
  )
  ctx.on('loader/volatile-update', () => {
    try {
      resolved()
    } catch (error) {
      ctx.logger.warn(error)
    }
  })
}

export default { name, inject, Config, apply }
