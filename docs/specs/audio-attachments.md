# 音频附件与 route guard

Source: `src/index.ts`, `src/service.ts`, `src/store.ts`, `src/admission.ts`, `src/wav.ts`, `src/audio-conversion.ts`, `src/types.ts`, `src/brand.ts`, `src/error.ts`, `src/audio-route-guard.ts`, `src/volatile.ts`

本页拥有 package 默认入口 `dsh-native-audio`：`AudioBlock` 与 `audio` modality 声明、`audioAttachments` service、本地内容寻址 WAV store、base64 admission、WAV 解析和全局音频 route guard。[Gemini](gemini-provider.md)、[OpenAI-compatible](openai-compatible-provider.md)、[`read_audio`](read-audio-tool.md) 与 [`file-ingress`](file-ingress.md) 调用该 service；本页不拥有 provider wire 或 Web 输入。附件策略的理由见 [0002](../decisions/0002-image-parity-byte-preserving-wav.md)。

## 数据与类型

- `AudioBlock` 是 `{ type: 'audio', attachment: AudioAttachmentRef }`，经 declaration merge 加入 DSH `ContentBlockMap`；`ModelModalityMap` 同时增加 `audio`。一个 AudioBlock 只引用一份附件；多份音频由同一 `ContentBlock[]` 中多个有序 block 表示。
- `AudioAttachmentRef` 是 JSON-safe durable 引用：`attachmentId`（`sha256:<hex>`）、`mediaType`（`audio/wav`）、`bytes`、`encoding`（`pcm`）、`sampleRateHz`、`channels`、`bitsPerSample`（8、16、24 或 32）、`validBitsPerSample`、可选 `channelMask`、`sampleFrames` 与可选 `name`。`name` 只取路径最后一段，去掉控制字符并截到 255 字符。Session log 只保存 ref，WAV 字节只在 store 中。
- 时长由 `audioDurationSeconds()` 从 `sampleFrames / sampleRateHz` 派生，不写入 ref。
- `AudioAttachmentError` 带稳定 `code`。调用方可修正的 admission 错误是 `TOO_MANY_AUDIOS`、`AUDIOS_TOO_LARGE`、`UNSUPPORTED_AUDIO_TYPE`、`INVALID_AUDIO_BASE64`、`INVALID_AUDIO`、`AUDIO_TYPE_MISMATCH`、`AUDIO_TOO_LARGE`、`AUDIO_CONVERTER_MISSING`、`AUDIO_CONVERSION_FAILED`，由 `isAudioAdmissionError()` 识别；store 错误是 `INVALID_ATTACHMENT_REF`、`ATTACHMENT_CORRUPT`、`ATTACHMENT_WRITE_FAILED`、`ATTACHMENT_NOT_FOUND`、`ATTACHMENT_READ_FAILED`。

## WAV 子集

`parseWav()` 只接受 little-endian RIFF/WAVE：一个 integer PCM `fmt ` chunk（classic PCM 至少 16 字节，多余字节被跳过；或带 PCM subformat GUID 的 `WAVE_FORMAT_EXTENSIBLE`），之后一个完整的 top-level `data` chunk。RIFF size、byte rate 与 block alignment 必须自洽，未知 RIFF chunk 被跳过。非 RIFF/WAVE 字节报 `AUDIO_TYPE_MISMATCH`，其他容器错误报 `INVALID_AUDIO`。解析不解码、不改写字节。

## 转成 PCM WAV

`convertToPcmWav(data, signal?)` 是 service 方法，由 [`file-ingress`](file-ingress.md) 与 [`read_audio`](read-audio-tool.md) 在调用 store 之前使用；理由见 [0010](../decisions/0010-convert-audio-before-the-store.md)。

- `parseWav()` 接受的字节原样返回（同一个数组），不启动进程。
- 其余字节写入 `0700` 临时目录，由 Config `ffmpegPath` 转成 16-bit PCM WAV，采样率、声道数不变，取第一条音轨，去掉 metadata 并使用 `-bitexact`。临时目录在结束时删除。
- `ffmpeg` 输入限定为 `file` 协议与 `wav`、`aiff`、`mp3`、`flac`、`mov`、`aac`、`ogg` demuxer，上传内容不能让它读取其他文件或 URL。超时 120 秒；调用方中止时进程被终止，并以 signal 的 reason 结束。
- 输出超过 `maxAudioBytes` 报 `AUDIO_TOO_LARGE`；找不到可执行文件报 `AUDIO_CONVERTER_MISSING`；其他失败报 `AUDIO_CONVERSION_FAILED`，消息含 `ffmpeg` stderr 末尾。
- `isAudioFileName()` 是两个调用方共用的扩展名判断：`.wav`、`.wave`、`.aif`、`.aiff`、`.aifc`、`.mp3`、`.flac`、`.m4a`、`.aac`、`.ogg`、`.oga`、`.opus`，不区分大小写。

## 写入与读取

- `LocalAudioAttachmentStore`（默认导出的 Cordis plugin）的根目录是 `<DSH home>/audio-attachments/v1`；DSH home 依次取 Config `dshHome`、`DSH_HOME`、`~/.dsh`。对象路径是 `objects/<SHA-256 前两位>/<SHA-256>`，`audioHostPath(ref)` 返回该路径。
- `saveAudios()` 先对整批检查数量、总字节与 media type，再逐个检查单文件上限、WAV 解析和声明类型一致；全部通过后才写入，因此任一文件不合格时整批不产生 ref。返回的 ref 与输入同序。
- 写入先在 `tmp/` 以 `0600` 独占创建临时文件并 fsync，再硬链接到对象路径、删除临时文件并把对象改为 `0400`；目录为 `0700` 并逐级 fsync。相同字节得到相同 id；目标已存在时核对其摘要。
- `readAudio()` 校验 ref 格式、对象 SHA-256，并重新解析 WAV 与 ref 中全部元数据比对；不一致报 `ATTACHMENT_CORRUPT`，对象缺失报 `ATTACHMENT_NOT_FOUND`。Provider adapter 在最终请求边界调用它。
- `admitEncodedAudios()` 把 canonical base64 解码后交给 `saveAudios()`；空串或非 canonical 编码报 `INVALID_AUDIO_BASE64`。

## 配置

Schemastery `Config`：`dshHome`、`maxAudioBytes`（默认 50 MiB）、`maxAudiosPerMessage`（默认 4）、`maxMessageAudioBytes`（默认 100 MiB）、`ffmpegPath`（默认 `ffmpeg`，从 `PATH` 查找）。允许的 media type 固定为 `audio/wav`。`plainOptions()`（`src/volatile.ts`）读取 provider plugin 的 volatile Config 引用的当前值。

## Route guard

`AudioAttachmentStore` 构造时安装一个全局、prepend 的 `llm/stream` listener。请求中任一消息的 content 含 AudioBlock，且 provider 不在已注册集合中时，stream 在 adapter transport 之前抛出 `LlmError`（`UNSUPPORTED_CONTENT`）。Provider plugin 在 `ctx.effect` 中调用 `registerAudioProvider(provider)`；注册按引用计数，effect 卸载时撤销。Provider adapter 在自己的 wire 边界仍会重复模型与角色检查。

## 已知限制

- Store 只接受 integer PCM WAV，不重采样、不改位深或声道、不做响度处理、降噪、裁剪、dither 或转码。其他格式依赖系统 `ffmpeg`，转换后的位深固定为 16 bit；相同输入在不同 `ffmpeg` 版本上可能得到不同字节和 attachment id。
- Store 没有引用感知的垃圾回收；对象写入后一直保留。
