import { readFile } from 'node:fs/promises'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'
import * as FileIngress from '../src/file-ingress.js'
import { GEMINI_AUDIO_ENTRY_ID } from '../src/gemini-plugin.js'
import * as PiAiAudioPlugin from '../src/pi-ai-audio-plugin.js'

interface Manifest {
  name: string
  dsh: Record<string, unknown> & { bundle: { patch: string } }
  exports: Record<string, unknown>
  files: string[]
  scripts: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface YamlModule {
  load(text: string, options: { schema: typeof entryListSchema }): unknown
}

// js-yaml ships no declarations; the string specifier keeps the import untyped.
const JS_YAML: string = 'js-yaml'

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Manifest
}

describe('bundle manifest', () => {
  it('inserts the store, the Gemini route, the pi-ai audio switch, the read tool, and WAV file ingress', async () => {
    const pkg = await manifest()
    const yaml = (await import(JS_YAML) as { default: YamlModule }).default
    const patch = yaml.load(
      await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
      { schema: entryListSchema },
    )

    expect(pkg.name).toBe('dsh-native-audio')
    expect(pkg.dsh.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(patch).toEqual([{
      insert: [
        { id: 'native-audio', name: 'dsh-native-audio' },
        { id: GEMINI_AUDIO_ENTRY_ID, name: 'dsh-native-audio/gemini-plugin' },
        { id: PiAiAudioPlugin.ROUTE_AUDIO_ENTRY_ID, name: 'dsh-native-audio/pi-ai-audio-plugin' },
        { id: 'native-audio-read-tool', name: 'dsh-native-audio/read-audio-tool' },
        { id: 'native-audio-file-ingress', name: 'dsh-native-audio/file-ingress' },
      ],
    }])
    expect(GEMINI_AUDIO_ENTRY_ID).toBe('llm-google-gemini-audio')
    expect(PiAiAudioPlugin.ROUTE_AUDIO_ENTRY_ID).toBe('native-audio-routes')
  })

  it('publishes ESM host exports and one browser module for the provider card', async () => {
    const pkg = await manifest()
    expect(Object.keys(pkg.exports)).toEqual([
      '.',
      './types',
      './gemini',
      './gemini-plugin',
      './openai-compatible',
      './read-audio-tool',
      './file-ingress',
      './package.json',
      './pi-ai-audio-plugin',
      './client',
    ])
    expect(pkg.exports['./client']).toEqual({ default: './lib/client.js' })
    expect(pkg.dsh['client']).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-api-remotes',
      ],
    })
    const runtimeDependencies = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
    expect(runtimeDependencies.filter(name => /^@deepseek-ai\/dsh-(client|settings|typert|web)|^react/u.test(name))).toEqual([])
  })

  it('names the file-ingress plugin and its attachment-service dependencies', () => {
    expect(FileIngress.name).toBe('dsh-native-audio-file-ingress')
    expect(FileIngress.inject).toEqual(['attachments', 'audioAttachments'])
    expect(FileIngress.default).toMatchObject({ name: FileIngress.name, inject: FileIngress.inject })
  })

  it('names the pi-ai audio plugin and its service dependencies', () => {
    expect(PiAiAudioPlugin.name).toBe('dsh-native-audio-pi-ai')
    expect(PiAiAudioPlugin.inject).toEqual(['llm', 'audioAttachments'])
    expect(PiAiAudioPlugin.default).toMatchObject({
      name: PiAiAudioPlugin.name,
      inject: PiAiAudioPlugin.inject,
      Config: PiAiAudioPlugin.Config,
      apply: PiAiAudioPlugin.apply,
    })
  })
})
