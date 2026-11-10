# 音频文件附件转换

Source: `src/file-ingress.ts`

本页拥有 `dsh-native-audio/file-ingress` face：一个全局 `agent/pre-step` listener，把 DSH Web stock composer 上传的音频文件附件补成原生音频。它读取 DSH `attachments` service 的文件字节，写入 [`audioAttachments`](audio-attachments.md)；stock composer 的上传、重试和展示属于 DSH。选择这条路径的理由见 [0007](../decisions/0007-wav-file-attachment-ingress.md)。

## 行为

- Plugin inject `attachments` 与 `audioAttachments`，listener 对所有 Agent 生效，包括 stable Subagent 收到的 prompt。它先调用 `next()`；step 被拒绝或 signal 已中止时原样返回。
- 对进入 step 的每条消息，找出文件名是[音频扩展名](audio-attachments.md#转成-pcm-wav)的 FileBlock，经 `readFileStream` 读取字节、调用 `convertToPcmWav()` 与 `saveAudios()`，并在该 FileBlock 之后插入 AudioBlock。PCM WAV 的 AudioBlock 与文件字节相同；其他格式的 AudioBlock 是转换后的 WAV，`name` 仍是原文件名。FileBlock 保留，模型同时收到文件的只读路径文本（由 DSH `LlmRuntime` 投影）和原生音频。
- 改写后的消息保持原 `id` 与 `source`，并替换 step 中的消息，所以 Session 持久化的 `user/message` 已含 AudioBlock；后续请求、cold replay、compaction 与 Subagent 都读取同一事实。
- 已含 AudioBlock 的消息不改写。改写不看当前模型；所选 route 不支持音频时，由 [route guard](audio-attachments.md#route-guard) 在请求发出前报 `UNSUPPORTED_CONTENT`。

## 失败与跳过

超过 `maxAudiosPerMessage`、`maxAudioBytes` 或 `maxMessageAudioBytes` 的文件（`maxMessageAudioBytes` 按转换后的大小累计），以及转换或 admission 拒绝的文件（例如没有 `ffmpeg`、内容不是音频）保持普通 FileBlock，并记录一条 warn，用户在会话中看不到原因。非 admission 错误（例如读取失败）向上抛出。

## 已知限制

- 音频在 Host 上保存两份：文件附件 store 中的原文件与音频 store 中的 WAV，两者都是内容寻址的不可变对象。
- 插件不发布 browser module；待发送与历史消息中的音频文件显示为 stock 文件卡片，AudioBlock 没有专用 renderer，也没有播放控件。
