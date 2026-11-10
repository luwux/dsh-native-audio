import type { Volatile } from '@deepseek-ai/cordis'
import type {
  ContentBlock,
  ContentBlockMap,
  ModelModality,
  ModelModalityMap,
  ToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  AudioAttachmentIdType,
  AudioAttachmentRef,
  AudioBlock,
} from 'dsh-native-audio'
import type { AudioBlock as AudioBlockFromTypesExport } from 'dsh-native-audio/types'
import type {
  GeminiAdvertisedModel,
  GeminiGenerateContentAdapterOptions,
  GeminiRequestCapture,
  GeminiThinkingLevel,
  GeminiWireOptions,
} from 'dsh-native-audio/gemini'
import type {
  Config as GeminiPluginConfig,
  Options as GeminiPluginOptions,
} from 'dsh-native-audio/gemini-plugin'
import type {
  AudioBridgeOptions,
  OpenAICompatibleRequestCapture,
} from 'dsh-native-audio/openai-compatible'
import type {
  Config as PiAiAudioPluginConfig,
  Options as PiAiAudioPluginOptions,
} from 'dsh-native-audio/pi-ai-audio-plugin'
import type { AudioReadValue } from 'dsh-native-audio/read-audio-tool'
import type { SkippedAudioFile } from 'dsh-native-audio/file-ingress'

const attachment: AudioAttachmentRef = {
  attachmentId: 'sha256:packed-consumer-fixture' as unknown as AudioAttachmentIdType,
  mediaType: 'audio/wav',
  bytes: 48,
  encoding: 'pcm',
  sampleRateHz: 48_000,
  channels: 2,
  bitsPerSample: 24,
  validBitsPerSample: 24,
  sampleFrames: 1,
}

const audioBlock: AudioBlock = { type: 'audio', attachment }
const blockFromSubpath: AudioBlockFromTypesExport = audioBlock
const blockFromMergedMap: ContentBlockMap['audio'] = audioBlock
const extractedAudioBlock: Extract<ContentBlock, { type: 'audio' }> = audioBlock
const contentBlock: ContentBlock = audioBlock
const toolContent: ToolResultMessage['content'] = [audioBlock]
const modality: ModelModality = 'audio'
const modalityFromMergedMap: ModelModalityMap['audio'] = 'audio'
const adapterOptions = null as unknown as GeminiGenerateContentAdapterOptions
const capture = null as unknown as GeminiRequestCapture
const thinkingLevel: GeminiThinkingLevel = 'medium'
const wireOptions: GeminiWireOptions = { includeThoughts: true }
const advertised: GeminiAdvertisedModel = {
  id: 'gemini-3.8-flash',
  thinkingLevels: ['minimal', 'low', 'medium', 'high'],
  defaultThinkingLevel: thinkingLevel,
}
const pluginOptions: GeminiPluginOptions = {
  apiKeyEnv: 'GEMINI_API_KEY',
  includeThoughts: false,
  models: [advertised],
}
const pluginConfig = null as unknown as GeminiPluginConfig
const includeThoughtsRef: Volatile<boolean> = pluginConfig.includeThoughts
const bridgeOptions = null as unknown as AudioBridgeOptions
const openAICompatibleCapture = null as unknown as OpenAICompatibleRequestCapture
const piAiAudioPluginOptions: PiAiAudioPluginOptions = {
  routes: {
    'local-omni': {},
    openrouter: { toolResultAudio: 'tool-message' },
  },
}
const piAiAudioPluginConfig = null as unknown as PiAiAudioPluginConfig
const piAiAudioRoutesRef: Volatile<Record<string, { toolResultAudio?: 'user-message' | 'tool-message' }>> = piAiAudioPluginConfig.routes
const readValue = null as unknown as AudioReadValue
const skipped = null as unknown as SkippedAudioFile

void [
  blockFromSubpath,
  blockFromMergedMap,
  extractedAudioBlock,
  contentBlock,
  toolContent,
  modality,
  modalityFromMergedMap,
  adapterOptions,
  capture,
  wireOptions,
  pluginOptions,
  includeThoughtsRef,
  bridgeOptions,
  openAICompatibleCapture,
  piAiAudioPluginOptions,
  piAiAudioRoutesRef,
  readValue,
  skipped,
]
