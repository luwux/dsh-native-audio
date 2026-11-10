import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'

/** Plain current values of a Config whose fields are Settings references. */
export type PlainOptions<C> = {
  [K in keyof C]?: C[K] extends Volatile<infer T> ? Exclude<VolatileSnapshot<T>, undefined> : C[K]
}

function isReference(value: unknown): value is Volatile<unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Read the current value behind every reference of a parsed Config. Plain
 * values pass through, so programmatic callers may supply either form.
 */
export function plainOptions<C extends object>(config: C | PlainOptions<C>): PlainOptions<C> {
  const entries = Object.entries(config).flatMap(([key, value]) => {
    const current: unknown = isReference(value) ? value.get() : value
    return current === undefined ? [] : [[key, current] as const]
  })
  return Object.fromEntries(entries) as PlainOptions<C>
}
