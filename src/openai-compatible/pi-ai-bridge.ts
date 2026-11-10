import {
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { PiAiAdapter, PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { requestHasAudio } from '../audio-route-guard.js'
import type { AudioAttachmentStore } from '../service.js'
import {
  OpenAICompatibleAudioPayloadBridge,
  type OpenAICompatibleAudioReceipt,
  type PreparedOpenAICompatibleAudio,
  type ToolResultAudioPlacement,
} from './wire.js'

/**
 * Bearer value for a keyless loopback endpoint such as llama-server: pi-ai's
 * Chat Completions implementation refuses to send a request without a key.
 */
export const NO_CREDENTIAL_API_KEY = 'dsh-native-audio-no-credential'

const CHAT_COMPLETIONS_API = 'openai-completions'
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface OpenAICompatibleRequestCapture {
  url: string
  body: unknown
  bodyText: string
  utf8Bytes: number
  audioReceipts: readonly OpenAICompatibleAudioReceipt[]
}

export interface RouteAudioSettings {
  toolResultAudio: ToolResultAudioPlacement
}

export interface AudioBridgeOptions {
  audioAttachments: Pick<AudioAttachmentStore, 'readAudio'>
  /** Current audio settings of one route; `undefined` while audio is off for it. */
  routeAudio: (provider: string) => RouteAudioSettings | undefined
  captureRequest?: (capture: OpenAICompatibleRequestCapture) => void | Promise<void>
}

type Profiles = ReadonlyMap<string, ResolvedPiAiProviderProfile>
type Provider = NonNullable<ResolvedPiAiProviderProfile['piProvider']>
type StreamOptions = NonNullable<Parameters<Provider['stream']>[2]>
type SimpleStreamOptions = NonNullable<Parameters<Provider['streamSimple']>[2]>

function isLoopbackEndpoint(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false
  try {
    return LOOPBACK_HOSTS.has(new URL(baseURL).hostname)
  } catch {
    return false
  }
}

function withPayloadBridge(
  provider: Provider,
  bridge: OpenAICompatibleAudioPayloadBridge,
  capture: AudioBridgeOptions['captureRequest'],
): Provider {
  const augment = <T extends StreamOptions | SimpleStreamOptions>(
    options: T | undefined,
    requestIds: ReadonlySet<string>,
    baseUrl: string,
  ): T => ({
    ...(options ?? {}),
    onPayload: async (payload, model) => {
      const patched = bridge.patch(payload, requestIds)
      const replacement = await options?.onPayload?.(patched.payload, model)
      const body = replacement ?? patched.payload
      const bodyText = JSON.stringify(body)
      await capture?.({
        url: `${baseUrl.replace(/\/+$/u, '')}/chat/completions`,
        body,
        bodyText,
        utf8Bytes: Buffer.byteLength(bodyText, 'utf8'),
        audioReceipts: patched.audioReceipts,
      })
      return body
    },
  }) as T
  const wrapped: Provider = Object.create(Object.getPrototypeOf(provider) as object) as Provider
  Object.assign(wrapped, provider, {
    stream: (model, context, options) => {
      const requestIds = bridge.requestIdsIn(context)
      return provider.stream(model, context, requestIds.size === 0 ? options : augment(options, requestIds, model.baseUrl))
    },
    streamSimple: (model, context, options) => {
      const requestIds = bridge.requestIdsIn(context)
      return provider.streamSimple(model, context, requestIds.size === 0 ? options : augment(options, requestIds, model.baseUrl))
    },
  } satisfies Pick<Provider, 'stream' | 'streamSimple'>)
  return wrapped
}

/**
 * Teach one stock `PiAiAdapter` to send AudioBlock as `input_audio`, keeping
 * every other responsibility (routes, credentials, compat, replay, images, SSE)
 * with that adapter. A request without audio reaches the stock code unchanged.
 *
 * DSH offers no seam here, so this reads the private `PiAiAdapter.config` and
 * replaces the adapter's methods on this instance. TypeScript checks only that
 * the private name still exists; the offline suite proves its behavior against
 * the pinned DSH version.
 * @returns the disposer restoring the stock behavior.
 */
export function installAudioBridge(adapter: PiAiAdapter, options: AudioBridgeOptions): () => void {
  const bridge = new OpenAICompatibleAudioPayloadBridge()
  const config = adapter['config'] as { -readonly [K in keyof PiAiAdapterOptions]: PiAiAdapterOptions[K] }
  const { profiles: stockProfiles, resolveApiKey: stockResolveApiKey } = config
  const { stream: stockStream, prepareCall: stockPrepareCall, listModels: stockListModels, resolveModel: stockResolveModel } = adapter

  let memo: { source: Profiles; wrapped: Profiles } | undefined
  config.profiles = () => {
    const source = stockProfiles()
    if (memo?.source === source) return memo.wrapped
    const wrapped: Profiles = new Map([...source].map(([route, profile]) => [route, profile.piProvider === undefined
      ? profile
      : { ...profile, piProvider: withPayloadBridge(profile.piProvider, bridge, options.captureRequest) }]))
    memo = { source, wrapped }
    return wrapped
  }
  config.resolveApiKey = async (provider, profile) => {
    const key = await stockResolveApiKey(provider, profile)
    return key === undefined && isLoopbackEndpoint(profile.baseURL) ? NO_CREDENTIAL_API_KEY : key
  }

  const assertChatCompletions = (provider: string, model: string): void => {
    const api = stockProfiles().get(provider)?.piProvider?.getModels().find(candidate => candidate.id === model)?.api
    if (api !== undefined && api !== CHAT_COMPLETIONS_API) {
      throw new LlmError(
        `Native audio on provider route "${provider}" needs the Chat Completions protocol; model "${model}" speaks ${api}.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }

  async function * withAudio(
    request: GenerateOptions,
    stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const route = options.routeAudio(request.provider)
    if (route === undefined) {
      throw new LlmError(`Native audio is off for provider route "${request.provider}".`, 'UNSUPPORTED_CONTENT')
    }
    assertChatCompletions(request.provider, request.model)
    let prepared: PreparedOpenAICompatibleAudio | undefined
    try {
      prepared = await bridge.prepare(request, options.audioAttachments, { toolResultAudio: route.toolResultAudio })
      yield * stream(prepared.options)
    } catch (error: unknown) {
      if (request.signal?.aborted) {
        throw new LlmError('OpenAI-compatible request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      prepared?.release()
    }
  }
  const dispatch = (
    request: GenerateOptions,
    stream: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> => requestHasAudio(request) ? withAudio(request, stream) : stream(request)

  const withAudioModality = <T extends LlmModelInfo | LlmResolvedModelInfo>(provider: string, model: T): T =>
    options.routeAudio(provider) === undefined || model.inputModalities?.includes('audio') === true
      ? model
      : { ...model, inputModalities: [...model.inputModalities ?? ['text'], 'audio'] }

  adapter.stream = request => dispatch(request, stockRequest => stockStream.call(adapter, stockRequest))
  adapter.prepareCall = async (provider, model, signal) => {
    const call = await stockPrepareCall.call(adapter, provider, model, signal)
    return { model: withAudioModality(provider, call.model), stream: request => dispatch(request, call.stream) }
  }
  adapter.listModels = async (provider) => {
    const models = await stockListModels.call(adapter, provider)
    return models.map(model => withAudioModality(provider, model))
  }
  adapter.resolveModel = async (provider, model, signal) =>
    withAudioModality(provider, await stockResolveModel.call(adapter, provider, model, signal))

  return () => {
    config.profiles = stockProfiles
    config.resolveApiKey = stockResolveApiKey
    Reflect.deleteProperty(adapter, 'stream')
    Reflect.deleteProperty(adapter, 'prepareCall')
    Reflect.deleteProperty(adapter, 'listModels')
    Reflect.deleteProperty(adapter, 'resolveModel')
  }
}
