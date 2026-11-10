// Spec: docs/specs/openai-compatible-provider.md
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import z from '@deepseek-ai/schemastery'
import { installAudioBridge } from './openai-compatible/pi-ai-bridge.js'
import { DEFAULT_TOOL_RESULT_AUDIO, type ToolResultAudioPlacement } from './openai-compatible/wire.js'

export const name = 'dsh-native-audio-pi-ai'
export const inject = ['llm', 'audioAttachments']

/** Settings namespace and bundle entry id; the browser switch writes here. */
export const ROUTE_AUDIO_ENTRY_ID = 'native-audio-routes'

export interface RouteAudioConfig {
  toolResultAudio?: ToolResultAudioPlacement
}

export interface Options {
  /** Provider routes with native audio on, keyed by `llm-pi-ai` route id. */
  routes?: Record<string, RouteAudioConfig>
}

export interface Config {
  routes: Volatile<Record<string, RouteAudioConfig>>
}

export const Config: z<Options, Config> = z.object({
  routes: z.dict(z.object({
    toolResultAudio: z.union(['user-message', 'tool-message']).default(DEFAULT_TOOL_RESULT_AUDIO),
  })).default({}).volatile(),
}) as unknown as z<Options, Config>

/** The stock pi-ai adapters currently registered, one per mounted `llm-pi-ai` entry. */
function piAiAdapters(llm: LlmRuntime): Set<PiAiAdapter> {
  const adapters = new Set<PiAiAdapter>()
  // DSH lists routes but not their adapters, so this reads the private registry.
  const registrations = llm['adapters'] as ReadonlyMap<string, { adapter: unknown }>
  for (const { adapter } of registrations.values()) {
    if (adapter instanceof PiAiAdapter) adapters.add(adapter)
  }
  return adapters
}

/**
 * Give `llm-pi-ai` routes a native-audio switch. The routes themselves stay
 * entirely in `llm-pi-ai` settings; this plugin only holds which of them have
 * audio on and bridges those through the stock adapter.
 */
export function apply(ctx: Context, config: Config): void {
  const bridges = new Map<PiAiAdapter, () => void>()
  const guardAllowances = new Map<string, () => void>()

  const syncBridges = (): void => {
    const current = piAiAdapters(ctx.llm)
    for (const [adapter, uninstall] of bridges) {
      if (current.has(adapter)) continue
      uninstall()
      bridges.delete(adapter)
    }
    for (const adapter of current) {
      if (bridges.has(adapter)) continue
      bridges.set(adapter, installAudioBridge(adapter, {
        audioAttachments: ctx.audioAttachments,
        routeAudio: (provider) => {
          const route = config.routes.get()[provider]
          return route === undefined
            ? undefined
            : { toolResultAudio: route.toolResultAudio ?? DEFAULT_TOOL_RESULT_AUDIO }
        },
      }))
    }
  }

  const syncGuard = (): void => {
    const routes = config.routes.get()
    for (const [route, revoke] of guardAllowances) {
      if (route in routes) continue
      revoke()
      guardAllowances.delete(route)
    }
    for (const route of Object.keys(routes)) {
      if (!guardAllowances.has(route)) guardAllowances.set(route, ctx.audioAttachments.registerAudioProvider(route))
    }
  }

  ctx.effect(() => {
    syncBridges()
    syncGuard()
    return () => {
      for (const uninstall of bridges.values()) uninstall()
      bridges.clear()
      for (const revoke of guardAllowances.values()) revoke()
      guardAllowances.clear()
    }
  }, 'native audio on pi-ai routes')
  ctx.on('llm/adapters-updated', syncBridges)
  ctx.on('loader/volatile-update', syncGuard)
}

export default { name, inject, Config, apply }
