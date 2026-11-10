import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import NativeAudioPlugin, {
  LocalAudioAttachmentStore,
  audioDurationSeconds as rootAudioDurationSeconds,
} from 'dsh-native-audio'
import { audioDurationSeconds as typesAudioDurationSeconds } from 'dsh-native-audio/types'
import {
  GEMINI_THINKING_LEVELS,
  GeminiGenerateContentAdapter,
} from 'dsh-native-audio/gemini'
import GeminiPlugin, {
  GEMINI_AUDIO_ENTRY_ID,
  GEMINI_AUDIO_PROVIDER,
} from 'dsh-native-audio/gemini-plugin'
import { NO_CREDENTIAL_API_KEY, installAudioBridge } from 'dsh-native-audio/openai-compatible'
import PiAiAudioPlugin, { ROUTE_AUDIO_ENTRY_ID } from 'dsh-native-audio/pi-ai-audio-plugin'
import { apply as applyReadAudio } from 'dsh-native-audio/read-audio-tool'
import FileIngress, { attachFileAudio } from 'dsh-native-audio/file-ingress'

assert.equal(NativeAudioPlugin, LocalAudioAttachmentStore)
assert.equal(rootAudioDurationSeconds({ sampleFrames: 24_000, sampleRateHz: 48_000 }), 0.5)
assert.equal(typesAudioDurationSeconds({ sampleFrames: 96_000, sampleRateHz: 48_000 }), 2)
assert.equal(typeof GeminiGenerateContentAdapter, 'function')
assert.deepEqual(GEMINI_THINKING_LEVELS, ['minimal', 'low', 'medium', 'high'])
assert.equal(GeminiPlugin.name, 'dsh-native-audio-gemini')
assert.equal(GEMINI_AUDIO_PROVIDER, 'google-gemini-audio')
assert.equal(GEMINI_AUDIO_ENTRY_ID, 'llm-google-gemini-audio')
assert.equal(typeof installAudioBridge, 'function')
assert.equal(NO_CREDENTIAL_API_KEY, 'dsh-native-audio-no-credential')
assert.equal(PiAiAudioPlugin.name, 'dsh-native-audio-pi-ai')
assert.deepEqual(PiAiAudioPlugin.inject, ['llm', 'audioAttachments'])
assert.equal(ROUTE_AUDIO_ENTRY_ID, 'native-audio-routes')
assert.equal(typeof applyReadAudio, 'function')
assert.equal(FileIngress.name, 'dsh-native-audio-file-ingress')
assert.equal(typeof attachFileAudio, 'function')

// Every published export resolves to its declared file and imports cleanly.
const manifestUrl = new URL(import.meta.resolve('dsh-native-audio/package.json'))
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const resolved = {}
for (const [subpath, target] of Object.entries(manifest.exports)) {
  const specifier = subpath === '.' ? 'dsh-native-audio' : `dsh-native-audio/${subpath.slice(2)}`
  const url = import.meta.resolve(specifier)
  const file = typeof target === 'string' ? target : target.default
  assert.equal(url, new URL(file, manifestUrl).href, specifier)
  // The client module runs in the browser's module loader, not under Node.
  if (subpath === './package.json' || subpath === './client') {
    resolved[specifier] = url
    continue
  }
  if (typeof target !== 'string') {
    await readFile(new URL(target.types, manifestUrl))
  }
  const namespace = await import(specifier)
  assert.ok(Object.keys(namespace).length > 0, `${specifier} has exports`)
  resolved[specifier] = url
}

process.stdout.write(`${JSON.stringify(resolved)}\n`)
