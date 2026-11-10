# 0010: 其他音频格式在进入 store 之前转成 PCM WAV

- Status: Accepted
- Date: 2026-10-30

## Context

[0002](0002-image-parity-byte-preserving-wav.md) 只接受 integer PCM WAV，并要求支持更多格式时另行决定。用户上传的音频常见 MP3、FLAC、M4A，DAW 还会产生 AIFF 与浮点 WAV，这些文件此前只能作为普通文件留在消息里。各 provider 接受的编码不同：OpenAI 兼容的 `input_audio` 声明 `format`，Gemini 有自己的列表，所以把原始编码一路传到 wire 需要按模型维护格式表。DSH 到 `0.2.2-alpha.2` 没有音频内容块，本包经 `ContentBlockMap` 与 `ModelModalityMap` 扩展。用户于 2026-10-30 确认：内部只留 WAV，其他格式在入口转换。

## Decision

`AudioBlock`、store、Session 与 provider wire 仍然只有 `audio/wav`。`file-ingress` 与 `read_audio` 在调用 store 之前经 `audioAttachments.convertToPcmWav()` 取得字节：能被 `parseWav()` 接受的 WAV 原样返回；其余经 `ffmpeg` 转成 16-bit PCM WAV，采样率与声道数不变。转换器是系统 `ffmpeg`（`ffmpegPath` 可配），不增加 npm 依赖；找不到或转换失败是 admission 错误，上传的文件保持普通文件，`read_audio` 把原因作为工具错误返回。

Classic PCM 的 `fmt ` chunk 允许 16 字节之后有多余字节；一些 DAW 自带采样带 40 字节的此类 chunk。

## Alternatives

**把压缩音频原样传到 provider。** 没有解码开销，但需要按模型维护格式表，还要在 Session 与 store 中引入多种 media type；上游以后加入音频块时要迁移的面也更大。

**用 WASM 或 npm 解码库。** 不依赖系统工具，但增加包体积和依赖维护。用户当前只维护最新版本，先用系统工具；上游 `office-to-pdf` 同样优先用原生引擎。

**把任何不规整的 WAV 都交给 `ffmpeg`。** 不用放宽解析器，但没装 `ffmpeg` 时 DAW 自带的普通 PCM 采样也不可用，而且这些字节本来就不需要改写。

## Consequences

转换后的音频与原文件字节不同，并且失去 16 bit 以上的精度；PCM WAV 不受影响，[0002](0002-image-parity-byte-preserving-wav.md) 的逐字节核对对 store 及其之后的路径仍然成立。压缩文件解码后可能超过 `maxAudioBytes`，此时报 `AUDIO_TOO_LARGE`，不做降采样。相同输入在不同 `ffmpeg` 版本上可能得到不同字节，因而得到不同的 attachment id。
