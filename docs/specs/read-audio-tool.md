# read_audio 工具

Source: `src/read-audio-tool.ts`

本页拥有 `dsh-native-audio/read-audio-tool` face：注册到 DSH Tool Registry 的模型工具 `read_audio`。它把 Agent 可访问的本地音频文件转成 PCM WAV 存入 [`audioAttachments`](audio-attachments.md)，并在 tool result 消息中返回 AudioBlock；该 AudioBlock 如何进入请求由 [Gemini](gemini-provider.md) 与 [OpenAI-compatible](openai-compatible-provider.md) route 决定。

## 行为

- Plugin inject `tools`、`audioAttachments` 与 `workingDirectory`。工具参数只有 `file_path`：相对路径基于 `ctx.workingDirectory` 给出的 Session 当前工作目录（会随 `working_directory` 工具切换；没有 Agent 时用进程 `cwd`），绝对路径保持原样。
- 路径必须是[音频扩展名](audio-attachments.md#转成-pcm-wav)，目标必须是普通文件，大小不超过 store 的 `maxAudioBytes`；之后读取字节并依次调用 `convertToPcmWav()` 与 `saveAudio()`，转换与 admission 错误原样抛出，模型在工具错误中看到原因（例如缺少 `ffmpeg`）。
- 工具返回值是 `{ path, audio }`，`audio` 是 durable ref 的各字段。渲染后的 tool result 内容是一段说明文本（路径、时长、采样率、声道、位深、字节数）加一个 AudioBlock。
- 工具声明可并发执行，UI 以 generic read 卡片展示调用。
- 主 Agent 与 Subagent 调用结果相同；tool result 消息进入调用者自己的 Session history。
- 下一次请求中，Gemini route 把该 AudioBlock 放在 `functionResponse` 之后的同一 user content 中（见 [请求序列化](gemini-provider.md#请求序列化)）；Chat Completions route 按模型目录的 `toolResultAudio` 放进 tool 消息或紧随 tool 消息的 user 消息（见 [Bridge 行为](openai-compatible-provider.md#bridge-行为)）。

## 已知限制

- 工具不播放、转录、重采样或分析音频；转换只改容器、编码与位深。
