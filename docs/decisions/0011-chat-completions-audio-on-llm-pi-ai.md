# 0011: Chat Completions 音频搬到 stock `llm-pi-ai` route

- Status: Accepted
- Date: 2026-10-30

## Context

此前 Chat Completions 音频有自己的 route：`openrouter-native-audio` 预设和由 `cordis.patch.yml` 配置的通用 plugin。DSH Models 页的 `ProviderEditor` 只为 `llm-deepseek` 与 `llm-pi-ai` 两个命名空间提供编辑表单，其他 provider 只显示“其余字段在 cordis.patch.yml 中”。接一个本地 Omni 模型因此要手写 YAML，普通 provider 无法顺手开音频。用户要求添加和编辑时的体验与普通模型一致，最多多一个开关。

DSH `0.2.1-rc.5` 没有这里的公开 seam：`PiAiAdapter` 不接受外部 payload hook，`llm-pi-ai` 的 `input` schema 拒绝 `audio`，`ModelInputTypes` 把 `['text','image']` 写死且没有 slot。

## Decision

删除 `openrouter-plugin`、`openai-compatible-plugin` 与自有 adapter。Chat Completions 音频成为 stock `llm-pi-ai` route 上的一个开关：

- Route 完全由 `llm-pi-ai` 拥有，用 Models 页原有表单添加和编辑。
- `native-audio-routes` entry 保存开了音频的 route 及其 `toolResultAudio`。Package 发布一个 client module，在官方 keyed slot `settings.models.provider-card` 上显示开关。
- `installAudioBridge()` 在 `PiAiAdapter` 实例上加入 `input_audio` 投影，不含音频的请求直接走 stock 代码。

这违反 [上游契约](../upstream-contract.md) 的默认纪律（需要读取私有字段时先停下提 Proposal）：bridge 读取私有的 `LlmRuntime.adapters` 与 `PiAiAdapter.config`，并替换实例方法。用户明确接受这个代价，因为项目只维护最新发布的 DSH 版本（`engines.dsh` 精确固定），每次升级本来就要重新验收。

这样消除的上游缺口写在这里，以后可以提给上游：`PiAiAdapter` 的 payload hook，以及 `llm-pi-ai` 模型 `input` 对扩展 modality 的开放和对应的 Models 页 slot。有了这两个 seam，bridge 不再需要私有字段，音频可以成为 `图片` 旁的逐模型勾选。

此决定取代 [0007](0007-wav-file-attachment-ingress.md) 中“不发布 browser module”的部分（音频文件输入仍走 stock composer），以及 [0009](0009-chat-completions-tool-result-audio.md) 中按模型目录设置 `toolResultAudio`、由 `route.ts` 拥有 route 生命周期的部分（放置方式改为按 route 设置，投影规则不变）。

## Alternatives

**保留独立 route，为它写自己的表单。** 不依赖私有字段，升级更稳；但要重做 Models 页已有的连接、目录发现、模型选项和 key 处理，添加流程也仍与普通 provider 不同。这正是用户不想要的并行系统。

**在 `llm/stream` waterfall 中短路请求。** 不需要替换 adapter 方法，但 `LlmRuntime.adapterStream` 的文件、图片和 tool 更新投影在 waterfall 之后，`next()` 也不接受新参数，短路就会跳过这些投影。

**把 `audio` 写进 `llm-pi-ai` 模型的 `input`。** 体验最接近逐模型勾选，但 schema 拒绝这个值，需要改上游。

**把 Gemini 也搬进来。** Gemini 用 GenerateContent 和 Files API，不是 Chat Completions；stock Google route 的 replay 与自有 adapter 混用风险高。它保留独立 route，卡片上加 key 输入。

## Consequences

本地端口、中转站、目录 provider 都能用普通表单接入，再点一个开关就能听音频；只要 key 为空的 loopback 地址也能直接用。`compat`、`headers`、模型发现等 `llm-pi-ai` 能力随之可用，也不再有 `openrouter-native-audio` 这个 route：引用它的旧 Session 需要换模型才能继续。

代价是 DSH 改动这些私有字段时 bridge 会失效，升级时靠 typecheck 和 [`pi-ai-audio-route.spec.ts`](../../tests/pi-ai-audio-route.spec.ts) 发现。音频是 route 级开关，不是逐模型勾选；同一 route 的模型共用开关和放置方式。“自定义模型 API”的创建草稿没有开关，要创建后才出现。默认不再内置 OpenRouter 模型目录，用户自己在 Models 页添加。

## Evidence

[2026-10-30 Models 页接入的 Web 验收](../research/2026-10-30-models-page-audio-web-acceptance.md)。
