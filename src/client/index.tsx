// Spec: docs/specs/openai-compatible-provider.md
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { Button, Input, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { useId, useState, useSyncExternalStore, type CSSProperties } from 'react'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    nativeAudio: keyof typeof en
  }
}

const NS = 'nativeAudio'
const ROUTE_AUDIO_NS = 'native-audio-routes'
const PI_AI_NS = 'llm-pi-ai'
const GEMINI_NS = 'llm-google-gemini-audio'
const GEMINI_KEY_REF = 'GEMINI_API_KEY'

export const en = {
  audioLabel: 'Native audio input',
  audioHint: 'Send audio to this provider\'s models as Chat Completions input_audio. Turn on only for models that can hear it.',
  placementLabel: 'Audio returned by tools',
  placementUser: 'Next user message',
  placementTool: 'Tool message',
  keyLabel: 'API key',
  keySave: 'Save',
  keySet: 'Stored; enter a new key to replace it.',
  keyMissing: 'Stored on this computer, or set GEMINI_API_KEY before launching.',
  keyFailed: 'The key was not saved: {message}',
} as const

export const zh: Record<keyof typeof en, string> = {
  audioLabel: '原生音频输入',
  audioHint: '把音频以 Chat Completions input_audio 发给这个提供商的模型。只对能听音频的模型开启。',
  placementLabel: '工具返回的音频',
  placementUser: '放进下一条 user 消息',
  placementTool: '放进 tool 消息',
  keyLabel: 'API 密钥',
  keySave: '保存',
  keySet: '已保存；输入新密钥可替换。',
  keyMissing: '保存在本机，也可以在启动前设置 GEMINI_API_KEY。',
  keyFailed: '密钥没有保存：{message}',
}

type Translate = (key: keyof typeof en, values?: Record<string, string>) => string
type Placement = 'user-message' | 'tool-message'
interface RouteAudioSection { routes?: Record<string, { toolResultAudio?: Placement }> }

const areaStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0', fontSize: 13,
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const hintStyle: CSSProperties = { fontSize: 12, opacity: 0.65 }

/** The settings write that turns audio on or off for one route, or changes its placement. */
export function routeAudioOps(
  provider: string,
  next: { enabled: boolean; toolResultAudio: Placement },
): Parameters<ConfigForm<RouteAudioSection>['mutate']>[0] {
  const path = ['routes', provider]
  return next.enabled
    ? [{ op: 'set', path, value: { toolResultAudio: next.toolResultAudio } }]
    : [{ op: 'unset', path }]
}

function RouteAudioCard({ provider, form, t }: ProviderCardExtrasOwnerProps & { form: ConfigForm<RouteAudioSection>; t: Translate }) {
  const snapshot = useSyncExternalStore(l => form.subscribe(l), () => form.getSnapshot())
  const id = useId()
  const route = snapshot.value?.routes?.[provider.provider]
  const enabled = route !== undefined
  const placement = route?.toolResultAudio ?? 'user-message'
  const disabled = snapshot.status !== 'ready'
  return (
    <div style={areaStyle} data-testid="native-audio-switch">
      <div style={rowStyle}>
        <span>{t('audioLabel')}</span>
        <Switch
          checked={enabled}
          disabled={disabled}
          label={t('audioLabel')}
          onChange={(next) => {
            void form.mutate(routeAudioOps(provider.provider, { enabled: next, toolResultAudio: placement }))
          }}
        />
      </div>
      <span style={hintStyle}>{t('audioHint')}</span>
      {enabled
        ? (
          <div style={rowStyle}>
            <span>{t('placementLabel')}</span>
            <SegmentedControl<Placement>
              id={id}
              label={t('placementLabel')}
              value={placement}
              options={[
                { value: 'user-message', label: t('placementUser') },
                { value: 'tool-message', label: t('placementTool') },
              ]}
              onChange={(next) => {
                void form.mutate(routeAudioOps(provider.provider, { enabled: true, toolResultAudio: next }))
              }}
            />
          </div>
        )
        : null}
    </div>
  )
}

function GeminiKeyCard({ keyConfigured, storeKey, t }: ProviderCardExtrasOwnerProps & {
  storeKey: (value: string) => Promise<string | undefined>
  t: Translate
}) {
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<string | undefined>()
  const save = async (): Promise<void> => {
    const message = await storeKey(draft.trim())
    setFailure(message)
    if (message === undefined) setDraft('')
  }
  return (
    <div style={areaStyle} data-testid="native-audio-gemini-key">
      <div style={rowStyle}>
        <Input
          type="password"
          autoComplete="off"
          aria-label={t('keyLabel')}
          placeholder={t('keyLabel')}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <Button disabled={draft.trim() === ''} onClick={() => { void save() }}>{t('keySave')}</Button>
      </div>
      <span style={hintStyle}>
        {failure === undefined ? t(keyConfigured ? 'keySet' : 'keyMissing') : t('keyFailed', { message: failure })}
      </span>
    </div>
  )
}

export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/** Seat the native-audio controls on the Models page's provider cards. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'native audio copy')
  const form = ctx.configForms.get<RouteAudioSection>(ROUTE_AUDIO_NS)
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: PI_AI_NS,
    locale: NS,
    inject: () => ({ form }),
  }, RouteAudioCard))
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: GEMINI_NS,
    locale: NS,
    inject: () => ({
      storeKey: async (value: string) => {
        const response = await ctx.remote.credentials.set(GEMINI_KEY_REF, value)
        return response.ok ? undefined : response.error.message
      },
    }),
  }, GeminiKeyCard))
}
