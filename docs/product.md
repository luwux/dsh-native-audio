# Product

`dsh-native-audio` 是一个独立的 DeepSeek Harness（DSH）插件，让支持原生音频的模型在实际 provider 请求中收到音频，同时完整复用 DSH 的 AgentLoop、Session、Subagent、steer、streaming、Web UI、persistence 与 replay。为什么做成独立插件见 [0001](decisions/0001-standalone-dsh-plugin.md)。

## Scope

- 服务对象是任何 DSH consumer，例如下游 bundle。插件只提供通用的原生音频内容、附件、路由、provider adapter 和 Web 音频文件输入。
- 任意选择音频 route 的 Agent 都可以把 AudioBlock 保存在自己的自然会话中，包括用户直接交互的 Main；consumer 也可以创建独立、非 fork 的 continuable child，并通过 `ContentBlock[]` 把音频交给它。
- 以 DSH bundle 安装到 profile；package 从 npm 安装（`dsh plugin --profile <name> add dsh-native-audio`），提供 `dsh.bundle.patch`，并通过真实 Loader 组合测试。仓库不提交构建产物，所以不支持从 Git commit 安装。

## Goals

一段音频在以下整条链路上贯通，才算模型“原生收到音频”：

```text
Web 音频文件附件或程序化 AudioAttachmentRef
  → Host admission 与 durable audio store
  → 已知 user/message 事件中的 AudioBlock
  → Session surface / compaction / cold replay
  → 当前 Agent history，或 Subagent ContentBlock[] start/sendMessage
  → audio-capable model route
  → 原生音频 adapter serialization
  → fake provider request capture
```

缺少任一环节都不算完成。UI 能播放、Session 中有文件路径、工具能转录或类型系统声明 `audio`，都不能替代最终请求中的音频证据。

## Non-goals

- 不 fork 或直接修改 DSH 上游 checkout。读取 DSH 私有字段只限 [0011](decisions/0011-chat-completions-audio-on-llm-pi-ai.md) 记录的 `llm-pi-ai` 音频 bridge；遇到其他缺失的公开 seam 时，先形成最小复现与上游提案。
- 不包含 DAW 控制、resampling、freeze、export 等领域业务代码，也不决定 consumer 中各 Agent 的角色关系或何时调用 child。
- 附件层不转录、重采样、改位深、处理声道、做响度归一化、降噪、裁剪、dither 或转码（[0002](decisions/0002-image-parity-byte-preserving-wav.md)）；非 PCM WAV 的输入在进入附件层之前转成 PCM WAV（[0010](decisions/0010-convert-audio-before-the-store.md)）。
- 不替换 stock composer 或 history renderer，不提供音频播放器（[0007](decisions/0007-wav-file-attachment-ingress.md)）。README、版本说明和 capability catalog 必须写明 Web 音频输入依赖文件附件与 `file-ingress`，不得宣称 stock composer 本身理解音频。
- 只支持 [上游契约](upstream-contract.md) 列出的已验证 DSH 发布基线，不保留 DSH `0.1.1-rc.2` 兼容。

## Direction

首个公开版本是 `0.1.0-alpha.1`。之后的方向，都还没有排期：

- 跟随 DSH 的最新发布版：每个 DSH 新版本验证通过后发布对应的插件版本。
- 音频从 provider 级开关变成模型输入类型旁的逐模型勾选。这需要上游开放 `llm-pi-ai` 的 payload hook 和模型 `input` 的扩展 modality（见 [0011](decisions/0011-chat-completions-audio-on-llm-pi-ai.md)）。
- 视频输入留待以后评估；内容块命名与社区已有的 `video` block 保持一致。
