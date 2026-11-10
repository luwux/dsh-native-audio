# DSH-AUDIO-030：Chat Completions route 听取 tool result 音频

- Status: Done
- Date: 2026-10-14

Agent 经 Chat Completions route 调用 `read_audio` 时，模型在下一次请求中收到工具读取的音频，而不是以 `UNSUPPORTED_CONTENT` 结束 turn；同一套 route 也能指向本地 endpoint。

## Goal

OpenRouter 上的 `qwen/qwen3.8-omni-flash` 在 tool 消息中收到 `input_audio`；其他模型在紧随 tool 消息的 user 消息中收到；一个 profile entry 可以把 route 指向本地 Qwen3-Omni（本地 llama-server）。

## Scope

In scope:
- 按模型的 tool result 音频投影与默认模型目录，见 [0009](../decisions/0009-chat-completions-tool-result-audio.md)。
- 通用 `dsh-native-audio/openai-compatible-plugin` 与共享 route 生命周期，OpenRouter plugin 改为其预设。
- 离线测试：bridge 单元测试、plugin 测试、Subagent 合同测试，以及把真实 Session 轨迹（主 Agent `read_audio`、派生两个 Subagent 各自 `read_audio` 并 report）改写成 Chat Completions 请求后在真实 DSH pipeline 上重放。
- 同步 README、architecture、specs、consumer guide、testing 与 upstream contract。

Out of scope:
- Chat Completions route 的文件上传或 URL 引用 transport。
- 自动探测 endpoint 是否支持 tool 消息音频。
- 下游 bundle 的迁移。

## Specs

- [OpenAI-compatible 音频 route](../specs/openai-compatible-provider.md)
- [bundle](../specs/bundle.md)

## Constraints

- 离线测试只使用 fake fetch 与合成 WAV；真实请求只在用户授权的正式验收中发出。
- 投影只取决于 Session history 与本次请求模型的 `toolResultAudio`；模型与目录不变时，后续请求对同一段 history 的序列化必须相同。
- 不改 DSH、pi-ai 或其他上游源码；扩展点仍是 pi-ai 的 `onPayload`。

## Acceptance

- `pnpm run typecheck`、`pnpm run test`、`pnpm run build`、`git diff --check` 通过。
- 轨迹重放在 Qwen Omni（tool-message）、Gemini 3.7 Flash via OpenRouter（user-message）与本地 endpoint 配置（user-message、无 credential）三条 route 上完成，每次 `read_audio` 之后的请求按模型放置字节相同的 `input_audio`。
- 用户授权后的真实验收：本地 Qwen3-Omni 与 OpenRouter Qwen Omni 经 DSH Web 调用 `read_audio` 并说出只存在于音频中的内容。

## Result

离线部分已完成：按 [0009](../decisions/0009-chat-completions-tool-result-audio.md) 实现 tool result 音频的两种放置、共享 route 生命周期与通用 plugin，OpenRouter 默认目录加入 `qwen/qwen3.8-omni-flash`（`tool-message`）。轨迹重放 fixture 取自一条 DSH 0.1.1 Web Session（Main `read_audio` 后派生两个各自 `read_audio` 的 Subagent），保留音频相关步骤，0.1.1 的 `report` 工具在 0.2 中改为 `send_message`；新增 dev dependency `@deepseek-ai/dsh-tool-subagent` 与 `@deepseek-ai/dsh-tool-subagent-control`（`0.2.0-rc.2`）。

2026-10-14 运行：`pnpm run typecheck` 通过；`pnpm exec vitest run` 22 个文件 101 个测试通过；`pnpm run build` 通过；`python3 scripts/verify_subsystem_pages.py` 与 `git diff --check` 通过。

同日用户把真实验收改为经 DSH Web 使用 OpenRouter 与 Google API，本地 Qwen3-Omni 未运行。`qwen/qwen3.8-omni-flash`（`tool-message`）与 `xiaomi/mimo-v2.6-flash`（`user-message`）的主 Agent 和 Subagent 都经 `read_audio` 说出了只存在于音频中的单词，Qwen 在不调用工具时回答不知道；MiMo 只有在 provider 固定为 Xiaomi 或 Makora 时听到，OpenRouter 把它路由到 DeepInfra 时音频被丢弃而响应仍为 200。证据见 [2026-10-14 Web 验收](../research/2026-10-14-chat-completions-web-acceptance.md)。
