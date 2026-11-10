# 0007: DSH 0.2 用 stock 文件附件承载浏览器 WAV 输入

- Status: Accepted；“不发布 browser module”一项被 [0011](0011-chat-completions-audio-on-llm-pi-ai.md) 取代，音频文件输入路径不变
- Date: 2026-10-08

## Context

DSH `0.1.1-rc.2` 的 stock composer 只接受图片，所以插件曾发布一个 browser module：以更低 priority 替换附件栏 presentation，用空 token `CommandClaim` 接管含 WAV 的提交，再经自有 Typert Remote 在 Host 写入 `user/message`。它依赖 `dsh-client-runtime`、`SubmitImageAttachment`、`onAddImages`、`ComposerAttachment.previewUrl` 和 Typert codec 的 `schema` 字段。

DSH `0.2.0-rc.2` 删除了 `dsh-client-runtime`，把 composer 附件改为 image 与 file 两类，并新增通用文件附件：任意文件在选取时上传到 Host，提交后以 `FileBlock` 进入 `user/message`，请求组装时由 `LlmRuntime` 投影为带只读路径的文本。旧 browser module 在 0.2 上无法编译，还会与 stock 文件上传争夺同一个拖放和粘贴事件。

## Decision

插件不再发布 browser module、Typert Remote 或 Web submit service。浏览器里的 WAV 走 stock 文件附件路径；`file-ingress` 在全局 `agent/pre-step` 中，在每个 WAV FileBlock 之后插入同字节的 AudioBlock，FileBlock 保留。见 [file-ingress spec](../specs/file-ingress.md)。

改写发生在 `agent/pre-step`，所以 durable `user/message` 本身带有 AudioBlock：后续请求、cold replay、compaction 和 Subagent 读同一事实，不必每次请求重算。保留 FileBlock 让模型同时得到只读路径（可交给 `read_audio` 或委托给 child），stock Web 也继续显示文件卡片。`agent/pre-step` 是 DSH 0.2 公开的 waterfall，可以替换进入 step 的消息；请求层没有可用的改写位置。

## Alternatives

**把旧 browser module 移植到 0.2 的 slot 与 claim API。** 0.2 仍有 `conversation.input.attachments` 单占位 slot 和 `CommandClaim`，但附件栏同时负责图片、文件、上传进度、重试和拖放提示；替换它等于复制 stock 文件附件 UI，并让自定义 claim 解析 file receipt，每次 DSH 调整 composer 都要重新适配。完整的 composer takeover 在 rc.2 时已因要重建整个输入状态机而被拒绝。

**在请求层把 WAV FileBlock 投影成 AudioBlock。** `llm/stream` listener 只能观察请求，`next()` 不接受新的 options；`LlmRuntime` 在 adapter 之前无条件把 FileBlock 换成文本，adapter 看不到文件引用。从路径文本反解文件属于依赖私有格式。

**只把 FileBlock 留给模型，依靠模型调用 `read_audio`。** 可以工作，但模型是否去听取决于它是否主动调用工具，音频也以 tool result 而不是用户输入出现。用户直接附上的音频应在同一条用户消息中原生可听。

**按当前模型能力决定是否改写。** `agent/pre-step` 的 payload 不含本 step 的 provider/model，DSH 的 model selection 只在 Web entry 内部可见。改写因此不看模型；选择不支持音频的 route 时，route guard 在 transport 前明确报错。

## Consequences

Web 输入只依赖 DSH 公开的文件附件与 `agent/pre-step`；stock composer 的上传、重试、拖放提示和图片附件保持原样。代价是待发送卡片不再提供播放控件，历史消息中的 WAV 显示为 stock 文件卡片加 generic AudioBlock；WAV 字节在 Host 上保存两份；会话出现 AudioBlock 后切换到不支持音频的模型，请求会被 route guard 拒绝。
