import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

interface ClientExports {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
  routeAudioOps: (provider: string, next: { enabled: boolean; toolResultAudio: string }) => unknown
}

const script = fileURLToPath(new URL('../scripts/build-client.mjs', import.meta.url))

/** Build the bundle and evaluate it as the host's client module loader does. */
async function loadBundle(): Promise<{ id: string; required: string[]; exports: ClientExports }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-audio-client-'))
  try {
    const output = join(dir, 'client.js')
    execFileSync(process.execPath, [script, output])
    let loaded: { id: string; factory: (require: (id: string) => unknown) => ClientExports } | undefined
    runInNewContext(await readFile(output, 'utf8'), {
      window: { __ModuleLoader__: { load: (module: typeof loaded) => { loaded = module } } },
    })
    const required: string[] = []
    const stub = (id: string): unknown => {
      required.push(id)
      return new Proxy({ __esModule: true }, { get: (target, key) => key in target ? target[key as never] : vi.fn() })
    }
    return { id: loaded!.id, required, exports: loaded!.factory(stub) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('provider card client module', () => {
  it('is a lazy factory module using only host-provided externals', async () => {
    const bundle = await loadBundle()
    expect(bundle.id).toBe('dsh-native-audio')
    expect([...new Set(bundle.required)].filter(id => !/^(react|react\/jsx-runtime|@deepseek-ai\/dsh-client-ui-primitives)$/u.test(id)))
      .toEqual([])
    expect(bundle.exports.inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.credentials'])
  })

  it('writes the switch as presence of the route under routes', async () => {
    const { exports } = await loadBundle()
    expect(exports.routeAudioOps('local-omni', { enabled: true, toolResultAudio: 'tool-message' })).toEqual([
      { op: 'set', path: ['routes', 'local-omni'], value: { toolResultAudio: 'tool-message' } },
    ])
    expect(exports.routeAudioOps('local-omni', { enabled: false, toolResultAudio: 'tool-message' })).toEqual([
      { op: 'unset', path: ['routes', 'local-omni'] },
    ])
  })

  it('registers on the official provider-card slot for pi-ai and Gemini cards only', async () => {
    const { exports } = await loadBundle()
    const registered: Array<{ name: string; key: string }> = []
    const forms: string[] = []
    exports.apply({
      effect: (setup: () => unknown) => setup(),
      locale: new Proxy({}, { get: () => vi.fn() }),
      configForms: { get: (ns: string) => { forms.push(ns); return {} } },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (spec: { name: string; key: string }) => { registered.push(spec) },
      },
      remote: { credentials: { set: vi.fn() } },
    })
    expect(forms).toEqual(['native-audio-routes'])
    expect(registered.map(spec => [spec.name, spec.key])).toEqual([
      ['settings.models.provider-card', 'llm-pi-ai'],
      ['settings.models.provider-card', 'llm-google-gemini-audio'],
    ])
  })
})
