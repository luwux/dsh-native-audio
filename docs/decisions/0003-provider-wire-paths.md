# 0003: Gemini 直接实现 GenerateContent，OpenRouter 复用 pi-ai 的薄 bridge

- Status: Accepted
- Date: 2026-08-29

## Context

插件需要至少一条在最终 provider 请求中携带原生音频的 route。DSH 的 stock Pi serializer 没有 AudioBlock wire 支持，并且对未知 block 执行默认跳过；Gemini 的音频输入还需要插件明确控制完整 history、tool call/result 与 provider 私有的 replay metadata。OpenAI-compatible Chat Completions 的 `input_audio` 只缺一个内容投影，其余 system、history、tool、reasoning、usage、retry、abort、streaming 和错误语义 DSH `PiAiAdapter` 与 pi-ai 已经实现。

## Decision

Gemini face 直接实现 GenerateContent `streamGenerateContent?alt=sse`：自有 serializer、SSE parser 与 replay metadata，不经过 stock Pi serializer。见 [Gemini spec](../specs/gemini-provider.md)。

OpenRouter face 不复制另一套 OpenAI-compatible transport。它在 DSH `PiAiAdapter` 转换前把 AudioBlock 物化为请求唯一的一次性文本 marker，pi-ai 完成最终 payload 后，在其公开 `onPayload` hook 中把 marker 精确替换为 `input_audio`。本仓库只拥有 AudioBlock 物化、occurrence receipt 和 provider plugin 生命周期；transport 与响应映射由 pi-ai 和官方 OpenAI SDK 拥有。见 [OpenRouter spec](../specs/openai-compatible-provider.md)。

Bridge 的 generic 名称只表示 Chat Completions payload 形状可复用，不把 “OpenAI-compatible” 当作统一的音频标准。每个接入的 endpoint 都需要明确的 `input_audio` 文档与模型 modality 证据；当前只注册 OpenRouter route。

## Alternatives

**Gemini 经 stock Pi serializer。** 它没有 AudioBlock wire，并可能静默跳过未知 block，音频会在请求中消失。

**为 OpenRouter 手写完整 LlmAdapter、HTTP client 与 SSE parser。** 会复制 `PiAiAdapter`、pi-ai 和官方 OpenAI SDK 已有的 system、tool、reasoning、replay、usage、retry 与错误语义，并扩大未来兼容面。pi-ai 的公开 `onPayload` 足以承载唯一缺失的 `input_audio` 投影。

## Consequences

Gemini route 使用 Google 已标为 legacy 的 GenerateContent API，并由本仓库维护它的 wire 与 SSE 代码。OpenRouter route 依赖 pi-ai 的 `onPayload` 保持公开；Chat Completions 的 tool 消息只能携带文本，所以工具返回的音频只有 Gemini route 能听到。
