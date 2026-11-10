# OpenAI-compatible 音频 route

Source: `src/openai-compatible/`, `src/pi-ai-audio-plugin.ts`, `src/client/`

本页拥有 stock `llm-pi-ai` route 上的原生音频：`dsh-native-audio/openai-compatible` 导出的 `installAudioBridge()` 与 `input_audio` payload bridge，保存“哪些 route 开了音频”的 `dsh-native-audio/pi-ai-audio-plugin`，以及 Models 页卡片上的开关（`./client`）。Route 本身的 endpoint、协议、模型目录、credential、compat、HTTP、SSE、tool/reasoning replay、usage、retry 与错误映射都属于 DSH `llm-pi-ai`、pi-ai 和官方 OpenAI SDK，不属于本页。音频经 [`audioAttachments`](audio-attachments.md) 读取。为什么搬进 `llm-pi-ai` 见 [0011](../decisions/0011-chat-completions-audio-on-llm-pi-ai.md)，为什么用薄 bridge 见 [0003](../decisions/0003-provider-wire-paths.md)，tool result 音频投影的理由见 [0009](../decisions/0009-chat-completions-tool-result-audio.md)。

## 开关

- Provider 在 Models 页按普通方式添加和编辑（目录 provider 或“自定义模型 API”），写入 `llm-pi-ai.providers`。音频设置不在那里，因为 `llm-pi-ai` 的 `input` schema 拒绝 `audio`。
- Bundle entry `native-audio-routes`（plugin name `dsh-native-audio-pi-ai`，inject `llm` 与 `audioAttachments`）的 volatile Config 是 `routes: { <route id>: { toolResultAudio } }`。键存在即该 route 开启音频；`toolResultAudio` 取 `user-message`（缺省）或 `tool-message`。
- 开启的 route 在 [route guard](audio-attachments.md#route-guard) 注册，`listModels`、`resolveModelInfo` 与 `prepareCall` 给它的所有模型追加 `audio` 输入。`loader/volatile-update` 时同步 guard，不重新注册 route；已运行的 adapter 在下一次请求读取当前值。
- 删除 provider 不清除 `routes` 中的键；同 id 重新添加时音频仍是开启状态。

## 卡片

- `./client` 是 Web client module（`package.json` 的 `dsh.client`，`scripts/build-client.mjs` 用 `ts.transpileModule` 输出 lazy factory 格式的 `lib/client.js`），只依赖宿主提供的 `react`、`react/jsx-runtime` 与 `dsh-client-ui-primitives`。
- 它在官方 keyed slot `settings.models.provider-card` 上注册两张卡片：key `llm-pi-ai` 显示“原生音频输入”开关，开启后显示“工具返回的音频”两档，经 `configForms.get('native-audio-routes')` 写入上述 Config；key `llm-google-gemini-audio` 显示 Gemini API key 输入，经 `remote.credentials.set` 保存（见 [Gemini](gemini-provider.md)）。
- 开关在已保存的 provider 和目录 provider 的添加草稿上显示。“自定义模型 API”的草稿不派发这个 slot，要点“创建提供商”后才出现开关。
- 音频是 route 级开关，不是 `图片` 旁边的逐模型勾选：`ModelInputTypes` 把 `['text','image']` 写死且没有 slot。

## Bridge 安装

- 每个注册到 `ctx.llm` 的 `PiAiAdapter` 实例在 plugin apply 和 `llm/adapters-updated` 时安装一次 `installAudioBridge()`，随 plugin fiber 卸载；卸载恢复 stock 行为。
- DSH 没有这里的公开 seam，所以读取私有字段 `LlmRuntime.adapters` 与 `PiAiAdapter.config`，替换 `config.profiles` 与 `config.resolveApiKey`，并在实例上替换 `stream`、`prepareCall`、`listModels`、`resolveModel`。名字变化由 typecheck 发现，行为变化由 [`pi-ai-audio-route.spec.ts`](../../tests/pi-ai-audio-route.spec.ts) 对照固定的 DSH 版本发现。
- `config.profiles` 返回按来源 Map 缓存的包装：每条 route 的 `piProvider.stream` 与 `streamSimple` 只在 pi-ai Context 含音频 marker 时才加 `onPayload`。
- 不含音频的请求直接走 stock 代码。含音频的请求在 route 关闭音频时报 `UNSUPPORTED_CONTENT`；模型 `api` 不是 `openai-completions` 时也报 `UNSUPPORTED_CONTENT`。
- 所有请求都经 `LlmRuntime.adapterStream`，所以 FileBlock 投影、图片投影和 tool 更新投影先于 bridge 完成。

## Credential

- Key 解析属于 `llm-pi-ai`。stock 解析没有结果且 route 的 `baseURL` 主机是 `localhost`、`127.0.0.1` 或 `[::1]` 时，bridge 返回固定 Bearer 占位值 `dsh-native-audio-no-credential`（导出为 `NO_CREDENTIAL_API_KEY`），因为 pi-ai 的 Chat Completions 实现没有 key 就不发请求。
- 非 loopback 地址没有 key 时保持 stock 行为：不发请求，以 `PI_AI_ERROR` 结束。

## Bridge 行为

- 在 DSH Pi context converter 之前，bridge 从 store 读取 user 与 tool 消息中的每个 AudioBlock，并用每次请求唯一（`randomUUID`）的私有文本 marker 占住它的位置，使 stock converter 不会跳过它。assistant、system 或 developer 消息中的 AudioBlock 在读取该 block 字节前报 `UNSUPPORTED_CONTENT`。调用方在读取音频期间中止时，请求以 `ABORTED` 结束。
- pi-ai 构造完整 Chat Completions payload 后，bridge 在其公开 `onPayload` hook 中处理 marker。User 消息中的 marker 原位替换为 `{ type: 'input_audio', input_audio: { data, format: 'wav' } }`，字符串 content 变为 part 数组，text part 的其他字段保留。
- Tool 消息中的 marker 按 route 的 `toolResultAudio` 投影：
  - `user-message`：tool 消息仍只有文本，每个 marker 替换为 `[audio attached in the next user message]`；marker 前的工具文本不以空白结尾时，说明文本前加一个换行。在连续 tool 消息之后插入一条 user 消息，按 tool 消息顺序为每个含音频的 tool call 写一段 `Audio returned by tool call <tool_call_id>:` 文本，后跟该 call 的 `input_audio` part。含音频但没有 `tool_call_id` 的 tool 消息报 `INVALID_REQUEST`。
  - `tool-message`：tool 消息的 content 变为 text part 与 `input_audio` part 按原顺序组成的数组。
- 两种投影只取决于 Session history 与本次请求 route 的 `toolResultAudio`，不含请求 id 或时间；设置不变时，同一段 history 在后续请求中序列化为相同的 wire 消息。切换 route 或修改该设置会改变已有 tool result 的 wire 形状。
- DSH Pi context converter 把一条 tool result 消息的 text block 直接拼接（没有分隔符），pi-ai 再把它作为字符串 content 写入 tool 消息，marker 留在该字符串中，所以 `user-message` 的说明文本由 bridge 自己换行。模型声明 `image` 时，pi-ai 把 tool result 中的图片放进连续 tool 消息之后的一条 user 消息；bridge 的音频 user 消息插在 tool 消息与这条图片消息之间。上游行为见 [上游契约](../upstream-contract.md#音频闭环所依赖的发布源码-owner)。
- 每个 occurrence 生成一条 receipt：`occurrence`、源 `messageIndex`/`blockIndex`、`sourceRole`（`user` 或 `tool`）、`placement`（`user-content`、`tool-message` 或 `tool-followup`）、`wireMessageIndex`、`contentPartIndex`、`attachmentId`、`mediaType`、`sourceBytes` 与 `inlineBase64Bytes`，按 wire 位置排序。`installAudioBridge()` 的 `captureRequest` 收到它们与最终 body；bundle plugin 不传这个选项。
- pi-ai 构造 payload 之前，bridge 从 pi-ai Context 中记下本次请求出现的 marker。不属于任何已准备请求的 marker 形文本按普通文本保留。属于本次请求的 marker 格式错误、occurrence 不存在，或出现次数不为一（包括某个请求的 marker 在 payload 中全部消失）时报 `INVALID_REQUEST`；错误从 pi-ai `onPayload` 抛出，经 DSH pi-ai 错误分类后仍以 `INVALID_REQUEST` 结束请求，不发出 HTTP 请求。

## 已知限制

- 依赖上面列出的私有字段，所以只保证 `engines.dsh` 固定的 DSH 版本。
- “OpenAI-compatible”不代表统一音频标准；bridge 只适用于明确接受 `/chat/completions`、multipart user content 与 `input_audio` 的 endpoint。开关不探测模型能力，对不能听音频的模型开启时，错误或静默丢弃由 endpoint 决定。
- 音频和放置方式按 route 设置，同一 route 的模型共用。两个模型需要不同放置时，声明两条 route。
- `tool-message` 只应为经真实请求证明能听到 tool 消息音频的模型开启：只渲染 tool 文本的 endpoint 会静默丢弃音频，响应中看不出错误。
- `user-message` 模式下模型在 user 角色中收到工具音频，来源只由标签文本说明；该模式要求 endpoint 接受 tool 消息之后紧跟 user 消息。
- OpenRouter 可能把一个声明音频输入的模型路由到丢弃 `input_audio` 的 provider，响应仍是 200，模型照常作答；2026-10-14 `xiaomi/mimo-v2.6-flash` 经 DeepInfra 即如此（[证据](../research/2026-10-14-chat-completions-web-acceptance.md#openrouter-把-mimo-路由到丢弃音频的-provider)）。
- 每次请求都把 history 中每个音频 occurrence 内联为 base64，没有文件上传或 URL 引用 transport。
- 未开启音频的 route 和其他 adapter 遇到音频由 [route guard](audio-attachments.md#route-guard) 拒绝，错误文字指向 Models 页的开关。
