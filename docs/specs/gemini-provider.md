# Gemini 音频 route

Source: `src/gemini/`, `src/gemini-plugin.ts`

本页拥有 `dsh-native-audio/gemini` 导出的 `GeminiGenerateContentAdapter`、Gemini wire serializer、SSE parser、Files API cache，以及注册 `google-gemini-audio` route 的 `dsh-native-audio/gemini-plugin` face。它通过 [`audioAttachments`](audio-attachments.md) 读取 durable WAV，并可选通过 DSH `attachments` service 读取图片；Session、Subagent 与 route guard 不属于本页。为什么直接实现 GenerateContent 见 [0003](../decisions/0003-provider-wire-paths.md)。

## Plugin 与配置

- Plugin inject `llm` 与 `audioAttachments`，注册 provider `google-gemini-audio`（显示名 Google Gemini Native Audio），Settings 命名空间是 entry id（默认 `llm-google-gemini-audio`），并在 effect 中向 route guard 注册该 provider。
- Config 全部是 DSH 0.2 volatile 字段：`apiKeyEnv`（credential reference，默认 `GEMINI_API_KEY`）、`baseURL`（缺省 `https://generativelanguage.googleapis.com`）、`maxInlineRequestBytes`（默认 20,000,000）、`audioTransport`（`files` 或 `inline`，默认 `files`）、`includeThoughts`（默认 `true`）、`models`。默认模型目录只有 `gemini-3.8-flash`，声明全部四个推理等级。
- 每次操作从当前 Config 构造一份 adapter 快照，因此 Settings 修改在下一次 request generation 生效。组合时无效的 Config 直接报错；`loader/volatile-update` 后无效的新值只记录 warn。
- Credential 先经 DSH credentials service 解析；没有该 service 时才读 launch environment。缺少 credential 不影响 Loader 组合，在发起请求时报 `MISSING_CREDENTIAL`。

## 请求序列化

- 请求发往 `<baseURL>/v1beta/models/<model>:streamGenerateContent?alt=sse`。
- Loop 请求开头的 system 消息成为 `systemInstruction`，`options.system` 优先；之后的 system 消息按原位置成为 user 文本。本 route 不声明 tool-update 模式，serializer 遇到 developer 消息报 `UNSUPPORTED_CONTENT`。
- Tool result 消息成为一个 user content：首个 part 是 `functionResponse`，同一消息中的图片和音频作为后续 part 原生发送。Adapter 保留 tool call/result 关联和 Gemini replay metadata（含 thought signature）。
- 每个音频 occurrence 都在最终 transport 前从 store 读取并校验，并生成带 wire 位置与 attachment id 的 receipt；同一份 WAV 不按 attachment id 去重。
- 推理等级只映射到 `generationConfig.thinkingConfig.thinkingLevel`（`minimal`、`low`、`medium`、`high`）。模型目录项的 `thinkingLevels` 决定 Web 推理等级菜单，未声明的等级在发送前被拒绝；`defaultThinkingLevel` 必须属于 `thinkingLevels`，缺省时请求不带等级。`includeThoughts` 为 `true` 时请求思考摘要，并作为 reasoning block 显示。
- `maxInlineRequestBytes` 在两种 transport 下都限制最终 JSON body；图片计入该上限。

## 音频 transport

- `files`（plugin 默认）：provider file name 是 `files/dsh-audio-<凭据 SHA-256 前 10 位>-<内容 SHA-256 前 19 位>`，history 中用 `fileData` 引用 `<baseURL>/v1beta/files/...`。一次请求内相同 WAV 只上传一次。理由见 [0004](../decisions/0004-gemini-files-audio-reuse.md)。
- 同一 plugin 实例共享一个 `GeminiFileCache`，按凭据与内容分区。内存命中在 provider 到期时间前 60 秒内有效，此时不访问 Files API；否则先 GET metadata，返回 403 或 404 时用 resumable upload 上传原字节，真正的鉴权失败由 upload start 报出。Provider 文件过期后，本地 durable attachment 是重新上传的来源。
- 并发请求同一份文件时共享一次传输，该传输最长 60 秒。每个调用者取消只结束自己的等待；最后一个等待者退出时才中止共享传输并移除 pending 项，之后的新调用重新发起。取消不删除 provider 上已上传的对象。理由见 [0006](../decisions/0006-gemini-image-input-and-files-cancellation.md)。
- `inline`：每个 occurrence 编码为 `inlineData`。直接构造 `GeminiGenerateContentAdapter` 时 `audioTransport` 默认是 `inline`。

## 图片输入

Context 中存在 DSH `attachments` service 时，adapter 获得 `readImage`，模型目录与 `resolveModel` 声明 `text`、`image`、`audio` 输入；否则只声明 `text`、`audio`。用户消息与 tool result 中的 PNG、JPEG、WebP 编码为 `inlineData`；其他图片类型（如 GIF）和没有 reader 时的图片报 `UNSUPPORTED_CONTENT`，不做转换。已 offload 的图片发送统一占位文本。

## 响应流

SSE parser 处理 UTF-8 分块、CRLF、多行 `data:`、取消和终止错误。Adapter 在一个响应内保留一个 pending text 或 reasoning block：下一个 SSE event 的首个同类 part 在 metadata 兼容时作为 delta 继续该 block；类型改变、同一 event 出现新 part、tool call 或流结束时关闭它。Replay metadata 记录合并后的 block 顺序。理由见 [0005](../decisions/0005-gemini-stream-block-coalescing.md)。

## 已知限制

- 使用 Google 的 legacy GenerateContent API；不支持 Interactions 或 Live API，不产生输出音频。
- Files API 只减少重复字节传输与 request body，provider 仍按输入音频计价。
- Provider file name 暴露凭据与内容的两个截断 hash，不含本机路径、文件名或 key 字面值。
