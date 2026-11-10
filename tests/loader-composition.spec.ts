import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackedFixture {
  stageDir: string
}

interface LoaderReport {
  configurableProviders: string[]
  defaultExport: string
  disposed: boolean
  entries: Array<{ id: string; name: string }>
  mounted: string[]
  volatileModels: string[]
  inputModalities: string[]
  models: string[]
  routeModels: string[]
  providers: string[]
  removed: boolean
  serviceName: string
  selfUrl: string
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const helperPath = join(repoRoot, 'scripts', 'test-packed-package.mjs')
const reportPrefix = 'DSH_NATIVE_AUDIO_LOADER_REPORT '

const loaderProgram = String.raw`
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import yaml from 'js-yaml'

class WorkingDirectoryStub extends Service {
  constructor(ctx) {
    super(ctx, 'workingDirectory')
  }
}

class EmptyAttachmentStore extends AttachmentStore {
  constructor(ctx) {
    super(ctx)
    this.imageLimits = {
      maxImageBytes: 1000000, maxImageDimension: 4096, maxImagePixels: 16000000,
      maxImagesPerMessage: 4, maxMessageImageBytes: 4000000, mediaTypes: ['image/png'],
    }
  }
  async validateImage() {}
  async saveImage() { throw new Error('unexpected image save') }
  async readImage() { throw new Error('unexpected image read') }
}

const packageUrl = pathToFileURL(process.cwd() + sep)
const patchUrl = new URL('cordis.patch.yml', packageUrl)
const patchText = await readFile(patchUrl, 'utf8')
const patches = yaml.load(patchText, { schema: entryListSchema })
assert.deepEqual(patches, [{
  insert: [
    { id: 'native-audio', name: 'dsh-native-audio' },
    { id: 'llm-google-gemini-audio', name: 'dsh-native-audio/gemini-plugin' },
    { id: 'native-audio-routes', name: 'dsh-native-audio/pi-ai-audio-plugin' },
    { id: 'native-audio-read-tool', name: 'dsh-native-audio/read-audio-tool' },
    { id: 'native-audio-file-ingress', name: 'dsh-native-audio/file-ingress' },
  ],
}])

const warnings = []
const entries = applyEntryPatches([], patches, (message, ...args) => {
  warnings.push([message, ...args])
})
assert.deepEqual(warnings, [])
assert.deepEqual(entries, [
  { id: 'native-audio', name: 'dsh-native-audio' },
  { id: 'llm-google-gemini-audio', name: 'dsh-native-audio/gemini-plugin' },
  { id: 'native-audio-routes', name: 'dsh-native-audio/pi-ai-audio-plugin' },
  { id: 'native-audio-read-tool', name: 'dsh-native-audio/read-audio-tool' },
  { id: 'native-audio-file-ingress', name: 'dsh-native-audio/file-ingress' },
])

const selfUrl = import.meta.resolve('dsh-native-audio')
assert.equal(selfUrl, new URL('lib/index.js', packageUrl).href)
const pluginModule = await import('dsh-native-audio')
assert.equal(typeof pluginModule.default, 'function')
const geminiPluginUrl = import.meta.resolve('dsh-native-audio/gemini-plugin')
assert.equal(geminiPluginUrl, new URL('lib/gemini-plugin.js', packageUrl).href)
const geminiPluginModule = await import('dsh-native-audio/gemini-plugin')
assert.equal(typeof geminiPluginModule.apply, 'function')
const routeAudioPluginUrl = import.meta.resolve('dsh-native-audio/pi-ai-audio-plugin')
assert.equal(routeAudioPluginUrl, new URL('lib/pi-ai-audio-plugin.js', packageUrl).href)
const routeAudioPluginModule = await import('dsh-native-audio/pi-ai-audio-plugin')
assert.equal(typeof routeAudioPluginModule.apply, 'function')
const readAudioToolModule = await import('dsh-native-audio/read-audio-tool')
assert.equal(typeof readAudioToolModule.apply, 'function')
const fileIngressModule = await import('dsh-native-audio/file-ingress')
assert.equal(typeof fileIngressModule.apply, 'function')

const ctx = new Context()
// Cordis' executable host initializes this inherited loader coordinate before
// mounting Loader; Loader's EntryTree constructor reads it before applying the
// plugin Config override (the same ordering used by @deepseek-ai/cordis/bin.js).
ctx.baseUrl = patchUrl.href
let report
try {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(EmptyAttachmentStore)
  await ctx.plugin(WorkingDirectoryStub)
  const llm = ctx.get('llm')
  assert.ok(llm, 'LlmRuntime service must be mounted')
  const loaderFiber = await ctx.plugin(Loader, { baseUrl: patchUrl.href })
  const loader = ctx.get('loader')
  assert.ok(loader, 'Loader service must be mounted')
  assert.ok(loader.internal, 'Loader must use the requested Node internal resolver')

  try {
    await loader.root.update(structuredClone(entries.slice(0, 1)))
    await loader.await()
    await loader.root.update(structuredClone(entries))
    await loader.await()
  } catch (error) {
    let current = error
    while (current instanceof Error) {
      process.stderr.write((current.stack ?? current.message) + '\n')
      current = current.cause
    }
    throw error
  }

  const entry = loader.resolve('native-audio')
  assert.equal(entry.fiber?.runtime?.callback, pluginModule.default)
  const firstService = ctx.get('audioAttachments')
  assert.ok(firstService instanceof pluginModule.default)
  // Root test code did not declare the audioAttachments injection; the public
  // unscoped observation seam is ctx.get(). Direct property access is reserved
  // for an injected plugin context and returns a traceable proxy, not identity.
  assert.equal(firstService.name, 'audioAttachments')
  assert.deepEqual(llm.listProviders(), [
    { id: 'google-gemini-audio', name: 'Google Gemini Native Audio' },
  ])
  const configurable = llm.listConfigurableProviders()
  assert.deepEqual(JSON.parse(JSON.stringify(configurable)), [
    {
      provider: 'google-gemini-audio',
      displayName: 'Google Gemini Native Audio',
      settingsNs: 'llm-google-gemini-audio',
      settingsPath: [],
    },
  ])
  const mounted = {}
  for (const { id } of entries) {
    const fiber = loader.resolve(id).fiber
    mounted[id] = fiber !== undefined && fiber.uid !== null && fiber.runtime !== undefined
  }
  assert.deepEqual(mounted, Object.fromEntries(entries.map(({ id }) => [id, true])))
  assert.equal(loader.resolve('native-audio-file-ingress').fiber.runtime.callback, fileIngressModule.apply)
  assert.ok(ctx.get('tools').schemas().some(schema => schema.name === 'read_audio'))
  const models = await llm.listModels('google-gemini-audio')
  assert.deepEqual(JSON.parse(JSON.stringify(models)), [{
    provider: 'google-gemini-audio',
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'General multimodal Gemini model with native audio understanding.',
    inputModalities: ['text', 'image', 'audio'],
  }])
  const resolvedGemini = await llm.resolveModelInfo('google-gemini-audio', 'gemini-3.8-flash')
  assert.deepEqual(resolvedGemini.reasoning.efforts.map(effort => effort.id), ['minimal', 'low', 'medium', 'high'])

  // A volatile-only config edit commits into the running fiber; the next
  // catalog query observes it without remounting or re-registering the route.
  const geminiEntry = loader.resolve('llm-google-gemini-audio')
  const geminiFiber = geminiEntry.fiber
  let routeChanges = 0
  const stopCounting = ctx.on('llm/adapters-updated', () => { routeChanges += 1 })
  await geminiEntry.update({
    config: { models: [{ id: 'volatile-audio-model', thinkingLevels: ['high'], defaultThinkingLevel: 'high' }] },
  })
  await loader.await()
  assert.equal(geminiEntry.fiber, geminiFiber)
  assert.equal(routeChanges, 0)
  const updatedModels = await llm.listModels('google-gemini-audio')
  assert.deepEqual(updatedModels.map(model => model.id), ['volatile-audio-model'])
  const updatedInfo = await llm.resolveModelInfo('google-gemini-audio', 'volatile-audio-model')
  assert.deepEqual(JSON.parse(JSON.stringify(updatedInfo.reasoning)), {
    efforts: [{ id: 'high', name: 'High' }],
    defaultEffort: 'high',
  })
  await geminiEntry.update({ config: undefined })
  await loader.await()
  stopCounting()
  assert.deepEqual((await llm.listModels('google-gemini-audio')).map(model => model.id), ['gemini-3.8-flash'])

  // A stock llm-pi-ai entry outside the bundle patch owns the route; the bundle's
  // audio entry switches audio on for it, and removing the entry releases only that route.
  const piAiEntry = {
    id: 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: {
      providers: {
        'local-omni': {
          displayName: 'Local Omni',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          models: [{ id: 'qwen3-omni', name: 'Qwen3 Omni (local)' }],
        },
      },
    },
  }
  const withAudioOn = entries.map(entry => entry.id === 'native-audio-routes'
    ? { ...entry, config: { routes: { 'local-omni': {} } } }
    : entry)
  await loader.root.update(structuredClone([...withAudioOn, piAiEntry]))
  await loader.await()
  assert.deepEqual(llm.listProviders().map(provider => provider.id), [
    'google-gemini-audio',
    'local-omni',
  ])
  const routeModels = await llm.listModels('local-omni')
  assert.deepEqual(routeModels.map(model => [model.id, model.inputModalities]), [
    ['qwen3-omni', ['text', 'audio']],
  ])
  await loader.root.update(structuredClone(entries))
  await loader.await()
  assert.deepEqual(llm.listProviders().map(provider => provider.id), ['google-gemini-audio'])

  // Removing only the provider row releases its route and directory while the
  // attachment service remains mounted.
  await loader.root.update(structuredClone(entries.slice(0, 1)))
  await loader.await()
  const retainedService = ctx.get('audioAttachments')
  assert.ok(retainedService instanceof pluginModule.default)
  assert.deepEqual(llm.listProviders(), [])
  assert.deepEqual(llm.listConfigurableProviders(), [])

  // Removing the remaining row releases the service as well.
  await loader.root.update([])
  await loader.await()
  assert.equal(ctx.get('audioAttachments'), undefined)
  assert.equal(ctx.registry.has(pluginModule.default), false)

  await loader.root.update(structuredClone(entries))
  await loader.await()
  const secondService = ctx.get('audioAttachments')
  assert.ok(secondService instanceof pluginModule.default)
  assert.equal(secondService === firstService, false)
  assert.deepEqual(llm.listProviders().map(provider => provider.id), ['google-gemini-audio'])

  await loaderFiber.dispose()
  assert.equal(ctx.get('loader'), undefined)
  assert.equal(ctx.get('audioAttachments'), undefined)
  assert.equal(ctx.registry.has(pluginModule.default), false)
  assert.deepEqual(llm.listProviders(), [])
  assert.deepEqual(llm.listConfigurableProviders(), [])

  report = {
    configurableProviders: ['google-gemini-audio'],
    defaultExport: pluginModule.default.name,
    disposed: true,
    entries,
    mounted: Object.keys(mounted),
    volatileModels: updatedModels.map(model => model.id),
    inputModalities: [...(models[0]?.inputModalities ?? [])],
    models: models.map(model => model.id),
    routeModels: routeModels.map(model => model.id),
    providers: ['google-gemini-audio'],
    removed: true,
    serviceName: firstService.name,
    selfUrl,
  }
} finally {
  await ctx.fiber.dispose()
}

process.stdout.write('${reportPrefix}' + JSON.stringify(report) + '\n')
`

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_offline: 'true',
        npm_config_update_notifier: 'false',
      },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const result = error as { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = result.stdout?.toString().trim()
    const stderr = result.stderr?.toString().trim()
    const detail = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
      .filter(Boolean)
      .join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`, { cause: error })
  }
}

describe('DSH 0.2 Loader composition', () => {
  it('parses the real bundle patch and owns the default-export service lifecycle', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-native-audio-loader-'))
    try {
      const packed = JSON.parse(run(process.execPath, [
        helperPath,
        '--repo-root', repoRoot,
        '--work-dir', join(tempRoot, 'build-and-pack'),
      ], repoRoot)) as PackedFixture

      await symlink(
        join(repoRoot, 'node_modules'),
        join(packed.stageDir, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )

      const output = run(process.execPath, [
        '--expose-internals',
        '--input-type=module',
        '--eval', loaderProgram,
      ], packed.stageDir, {
        DSH_HOME: join(tempRoot, 'dsh-home'),
      })
      const reportLine = output
        .split(/\r?\n/u)
        .find(line => line.startsWith(reportPrefix))
      expect(reportLine, output).toBeDefined()

      const report = JSON.parse(reportLine!.slice(reportPrefix.length)) as LoaderReport
      expect(report).toEqual({
        configurableProviders: ['google-gemini-audio'],
        defaultExport: 'LocalAudioAttachmentStore',
        disposed: true,
        entries: [
          { id: 'native-audio', name: 'dsh-native-audio' },
          { id: 'llm-google-gemini-audio', name: 'dsh-native-audio/gemini-plugin' },
          { id: 'native-audio-routes', name: 'dsh-native-audio/pi-ai-audio-plugin' },
          { id: 'native-audio-read-tool', name: 'dsh-native-audio/read-audio-tool' },
          { id: 'native-audio-file-ingress', name: 'dsh-native-audio/file-ingress' },
        ],
        mounted: [
          'native-audio',
          'llm-google-gemini-audio',
          'native-audio-routes',
          'native-audio-read-tool',
          'native-audio-file-ingress',
        ],
        volatileModels: ['volatile-audio-model'],
        inputModalities: ['text', 'image', 'audio'],
        models: ['gemini-3.8-flash'],
        routeModels: ['qwen3-omni'],
        providers: ['google-gemini-audio'],
        removed: true,
        serviceName: 'audioAttachments',
        selfUrl: new URL('lib/index.js', pathToFileURL(`${await realpath(packed.stageDir)}/`)).href,
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
