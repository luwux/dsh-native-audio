# dsh-native-audio

[中文](README.zh.md)

`dsh-native-audio` is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that lets audio-capable models hear audio natively. Audio reaches the model in three ways: files you drop into the Web composer, files the agent reads with the `read_audio` tool, and audio returned to subagents, which can call `read_audio` themselves or receive audio in their prompt. There is no speech-to-text step: the model request carries the audio itself, and the audio stays in the session history for later turns.

## Requirements

- DSH `0.2.2-rc.1` exactly (`engines.dsh` in `package.json`). The plugin depends on DSH internals, so each release names the DSH versions it was verified against; DSH refuses to install it on any other version.
- Node.js `^22.19.0 || >=24.0.0`.
- `ffmpeg` on `PATH`, only for input that is not PCM WAV (AIFF, MP3, FLAC, M4A, AAC, Ogg, Opus, or floating-point WAV). Integer PCM WAV works without it.
- A model that accepts audio input, reached through one of the routes described below.

## Install

```bash
dsh plugin --profile web add dsh-native-audio
```

Then restart DSH. `web` is the profile the plugin is verified on; the settings switch is a Web client module.

The package ships a DSH bundle patch (`cordis.patch.yml`) that adds five entries to the profile: the audio store, the Gemini route, the per-provider audio switch, the `read_audio` tool, and composer file ingress. It also ships a Web client module that adds the audio controls to the Models settings page.

## Quick start

1. Start DSH Web and open **Settings > Models**.
2. Add or pick a provider the normal way: a catalog provider such as OpenRouter, or a custom model API such as a local llama.cpp server or any other OpenAI-compatible endpoint. Loopback endpoints (`localhost`, `127.0.0.1`, `[::1]`) need no API key.
3. Turn on **Native audio input** on that provider's card. For a custom model API, the switch appears after you click create.
4. Pick a model from that provider that can hear audio.
5. Drop, paste, or attach an audio file in the composer, or ask the agent to listen to a file in the workspace, for example "Listen to `clips/take-2.wav` and describe it."

If a session contains audio and the selected model's provider does not have audio turned on, the request fails before it is sent, with an error that points to the switch.

## How it works

- The plugin adds an `audio` content block to DSH messages and a durable, content-addressed audio store under the DSH home (`audio-attachments/v1`). The store keeps PCM WAV bytes unchanged; other formats are converted to PCM WAV with `ffmpeg` before they are stored. Sessions persist only a reference to the stored audio, so it is still there when a session is reopened.
- A file dropped into the composer is uploaded as an ordinary DSH file attachment. Before the agent handles that message, the plugin adds an audio block after the file, so the model receives both the file path and the audio. The stock composer itself does not understand audio.
- `read_audio` takes a `file_path` (absolute, or relative to the session working directory) and returns a tool result that holds a text description and the audio block.
- On Chat Completions routes, the plugin rides on DSH's stock `llm-pi-ai` adapter and writes each audio block as an `input_audio` part. Audio returned by a tool goes either into a follow-up user message right after the tool messages (the default) or into the tool message itself. You choose per provider under **Audio returned by tools** on the card; use the tool-message option only for models you have confirmed can hear audio there.
- A separate Gemini route (`google-gemini-audio`, shown as "Google Gemini Native Audio") calls the native Gemini API. By default it uploads each clip once through the Files API and reuses the reference. It needs `GEMINI_API_KEY` in the launch environment or a key entered on its card.

## Writing a tool that returns audio

A DSH plugin that injects `audioAttachments` can save audio and return it from its own tool, the same way `read_audio` does:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from 'dsh-native-audio' // adds ctx.audioAttachments
import { AUDIO_VALUE_SCHEMA, audioRefFromValue } from 'dsh-native-audio/read-audio-tool'

export const inject = ['tools', 'audioAttachments']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'play_preview',
    description: 'Return the current preview as audio.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { audio: AUDIO_VALUE_SCHEMA } },
      render: (_args, value) => [
        { type: 'text', text: 'Preview audio:' },
        { type: 'audio', attachment: audioRefFromValue(value.audio) },
      ],
    },
    async execute(_args, exec) {
      const data = await ctx.audioAttachments.convertToPcmWav(await loadPreview(), exec.signal)
      const audio = await ctx.audioAttachments.saveAudio({ data, mediaType: 'audio/wav', name: 'preview.wav' })
      return { audio }
    },
  }))
}
```

`loadPreview()` stands for your own code that produces audio bytes. `convertToPcmWav()` returns PCM WAV unchanged and converts anything else with `ffmpeg`. The [consumer guide](docs/consumer-guide.md) (Chinese) also shows how to put saved audio into a user message or a subagent prompt.

## Known limitations

- Audio is a switch per provider, not a checkbox per model. All models of a provider share the switch and the tool-audio placement; declare two providers if two models need different settings.
- On a custom model API, the switch appears only after the provider is created.
- The Chat Completions bridge reads private DSH fields, so each release supports only the DSH versions listed in `engines.dsh`. A new DSH release needs a new release of this package.
- On Chat Completions routes, every audio clip in the history is re-sent inline as base64 on every request. There is no file upload or URL transport.
- The switch does not probe model capability. OpenRouter can route a model that declares audio input to an upstream provider that silently drops the audio; the response is still a normal answer.
- Audio in MCP tool results is not passed through: DSH's MCP client replaces it with a text placeholder.
- There is no in-app audio player. Attached audio shows as a stock file card in the composer and in history.

## Documentation

The detailed documentation is in Chinese:

- [README.zh.md](README.zh.md): package overview in Chinese.
- [docs/consumer-guide.md](docs/consumer-guide.md): bundle entries, configuration, and programmatic use.
- [docs/architecture.md](docs/architecture.md): how the subsystems fit together.
- [docs/specs/README.md](docs/specs/README.md): one page per subsystem, with current behavior and known limitations.

## License

MIT, see [LICENSE](LICENSE). `src/store.ts` adapts code from DeepSeek Harness under its MIT license; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
