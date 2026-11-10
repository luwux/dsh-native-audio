# dsh-native-audio

[English](README.md)

`dsh-native-audio` 是一个独立的 DeepSeek Harness 插件项目，目标是在不 fork Harness 的前提下，让音频成为 Session、Subagent 和 provider 请求中的原生多模态内容。

当前 package 由五个可独立组合的 Cordis plugin face、一个 Web client module 和两个库入口（`dsh-native-audio/gemini` 与 `dsh-native-audio/openai-compatible`）构成：

- `dsh-native-audio`：`AudioBlock`/`audio` modality、内容寻址本地 store（只保存 PCM WAV；其他格式在入库前经系统 `ffmpeg` 转成 PCM WAV）、Cordis service，以及供 provider face 安装的 route-guard API。
- `dsh-native-audio/gemini-plugin`：独立的 `google-gemini-audio` route、DSH 可编辑配置与 credential 集成，以及 Gemini GenerateContent 原生 WAV serializer；默认用凭据分区的 Files API 稳定 `fileData` 引用复用音频，也保留显式 `inlineData` 模式，并通过 DSH 图片 store 支持 PNG、JPEG、WebP 与音频同次输入。DSH 推理等级映射为 Gemini `thinkingLevel`，默认请求思考摘要并显示为 reasoning block。
- `dsh-native-audio/openai-compatible`：安装在 DSH stock `PiAiAdapter` 上的薄桥接层，只负责把 durable `AudioBlock` 投影为最终 Chat Completions `input_audio` part；tool result 中的音频按 route 设置放进 tool 消息，或放进紧随 tool 消息的 user 消息。
- `dsh-native-audio/pi-ai-audio-plugin`：保存哪些 `llm-pi-ai` route 开了音频。Provider 在 Models 页按普通方式添加和编辑，再打开卡片上的“原生音频输入”；本地 llama-server、OpenRouter、中转站都这样接入。
- `dsh-native-audio/client`：Web client module，在官方 slot `settings.models.provider-card` 上显示音频开关和 Gemini key 输入。
- `dsh-native-audio/read-audio-tool`：把 Agent 可访问的本地音频文件转成 PCM WAV 保存为 durable attachment，并在 tool result 消息中返回真实 AudioBlock。
- `dsh-native-audio/file-ingress`：在 `agent/pre-step` 中让每个音频文件附件后跟一个 AudioBlock（PCM WAV 字节不变，其他格式经系统 `ffmpeg` 转成 WAV），使 DSH Web stock composer 上传的音频成为原生音频输入。

兼容基线是 DSH `0.2.2-rc.1`。Session、AgentLoop、continuable Subagent、resident 投递与 interrupt、JSONL cold replay、compaction retained tail、Subagent 调用 `read_audio`、音频文件附件转换、Cordis Loader 和 packed consumer 均有离线合同测试。Gemini 合同捕获 Files API 首次上传、同进程复用、冷缓存 metadata lookup 与稳定 `fileData`，并保留显式 inline 模式测试；OpenAI-compatible 合同把 AudioBlock 送入 DSH `PiAiAdapter`、pi-ai 和官方 OpenAI SDK 后捕获 byte-equivalent `input_audio`，包括 `read_audio` tool result 在两种放置方式下的位置。这些自动化都使用 fake transport，不调用真实模型 API。

接入步骤见 [consumer guide](docs/consumer-guide.md#接入-chat-completions-模型)，取舍见 [0011](docs/decisions/0011-chat-completions-audio-on-llm-pi-ai.md)。

浏览器输入不需要插件自带的 composer：用户把音频文件拖入、粘贴或选择到 DSH Web 的 stock composer，它作为文件附件上传，`file-ingress` 在 Agent 处理该消息前补上 AudioBlock，模型同时收到文件只读路径和原生音频。待发送卡片与历史消息使用 stock 文件卡片，不提供插件自有的播放器；取舍见 [0007](docs/decisions/0007-wav-file-attachment-ingress.md)。

本仓库只提供通用的原生音频能力，不包含 DAW 或其他领域业务逻辑；领域工具由下游 bundle 提供。
