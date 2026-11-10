# 0009: Chat Completions route 按模型投影 tool result 音频，并提供通用 OpenAI-compatible route

- Status: Accepted；投影规则仍有效，按模型目录设置和 `route.ts`、通用 plugin 被 [0011](0011-chat-completions-audio-on-llm-pi-ai.md) 取代
- Date: 2026-10-14

## Context

`read_audio` 在 tool result 消息中返回 AudioBlock。OpenAI Chat Completions 规范只允许 `input_audio` 出现在 user content 中，tool 消息只定义文本，所以 OpenRouter route 原先在读取字节前以 `UNSUPPORTED_CONTENT` 拒绝 tool result 音频，Agent 经该 route 调用 `read_audio` 时 turn 以错误结束。一个 endpoint 收到 tool 消息中的 `input_audio` 后可能拒绝请求、返回 200 却在模板中丢掉音频，或者让模型真正听到；只看 HTTP 状态无法区分后两种。

2026-10-08 的真实请求（[证据](../research/2026-10-08-chat-completions-tool-audio-probe.md)）显示：经 OpenRouter，`qwen/qwen3.8-omni-flash`、`mistralai/voxtral-small-24b-2507` 与 `xiaomi/mimo-v2.6-flash` 都能听到 tool 消息中的 `input_audio`，同一音频放在紧随 tool 消息的 user 消息中也都能听到。同日用户决定不把 provider 层换成 Vercel AI SDK，继续维护本仓库的 bridge。2026-10-14 用户要求按模型开启 tool 消息音频、其余模型改用 user 消息投影，并准备用本机 Qwen3-Omni（本地 llama-server）验收，这需要一个不绑定 OpenRouter 的 route。

## Decision

Chat Completions bridge 按模型目录字段 `toolResultAudio` 投影 tool result 消息中的 AudioBlock：

- `user-message`（默认）：tool 消息保留文本，每个音频位置替换为固定文本 `[audio attached in the next user message]`；在连续 tool 消息之后插入一条 user 消息，按 tool 消息顺序为每个含音频的 tool call 写一段 `Audio returned by tool call <tool_call_id>:` 文本，后跟该 call 的 `input_audio` part。
- `tool-message`：tool 消息的 content 变为 text part 与 `input_audio` part 按原顺序组成的数组。

两种投影只取决于 Session history 与本次请求模型的 `toolResultAudio`，不含请求 id 或时间；模型与目录不变时，同一段 history 在后续请求中序列化结果相同，provider 的 prompt cache 前缀不会被打断。默认值选 `user-message`，因为它只依赖 user content 中的 `input_audio`，这是任何音频 route 的前提；`tool-message` 只为经真实请求证明模型听到了音频内容的模型开启。

Route 生命周期（settings 快照、credential 解析、provider 注册与 route guard 注册）由 `src/openai-compatible/route.ts` 拥有。新增 `dsh-native-audio/openai-compatible-plugin`：provider id、显示名、base URL、可选 credential 与模型目录都由 profile entry 配置，可以指向本地 llama-server、vLLM 或其他实现 `input_audio` 的 endpoint；它不在 bundle patch 中默认挂载。OpenRouter plugin 是同一 route 实现的预设。（注：`src/openai-compatible/route.ts` 与这个通用 plugin 已按 [0011](0011-chat-completions-audio-on-llm-pi-ai.md) 删除。）

本决定取代 [0003](0003-provider-wire-paths.md) 中的两点：工具返回的音频只有 Gemini route 能听到；只注册 OpenRouter 一条 Chat Completions route。

## Alternatives

**保持拒绝。** 2026-10-08 的证据显示三家模型都能听到 tool result 音频，拒绝让所有 Chat Completions route 都无法使用 `read_audio`。

**所有模型都放进 tool 消息。** 对只渲染 tool 文本的 endpoint，音频会被静默丢弃，模型照样回答，错误无法从响应中发现。

**所有模型都用 user 消息投影。** 能用，但对已验证的模型丢掉了“音频来自工具”的角色信息；按模型开启的成本只是一个目录字段。

**改用 Vercel AI SDK 的 provider 层。** 2026-10-08 的探测中，其 OpenAI-compatible provider 把 tool result 音频序列化成 tool 文本中的 JSON，模型听不到并按文本计费；Google provider 能听到内联的 tool result 音频，但这一情形本仓库的 Gemini route 已经覆盖，而它把已上传文件的引用写成 tool 文本，模型没有收到音频并编造了答案。

**按 endpoint 能力自动探测。** OpenRouter models API 只列出模型的输入模态，没有 tool 消息媒体能力；探测需要真实请求，不适合在请求路径上做。

## Consequences

`user-message` 模式下模型在 user 角色中收到工具音频，标签文本只说明来源，不降低其权限：音频文件里念出的指令会以 user 消息的身份到达模型。该模式要求 endpoint 接受 tool 消息之后紧跟 user 消息。模型目录多一个需要证据才能开启的字段。通用 plugin 不再由本仓库为每个 endpoint 核实 `input_audio` 文档与模型 modality，这项核实由写 profile entry 的人负责。Chat Completions route 仍在每次请求中内联 base64，没有 provider 文件引用；需要上传复用的 endpoint 要另写 transport。通用 route 允许不设置 credential，此时向 endpoint 发送固定占位 key，只适合不校验 key 的本地服务。
