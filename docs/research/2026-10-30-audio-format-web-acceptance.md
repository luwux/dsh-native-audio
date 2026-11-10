# 2026-10-30：音频格式转换的 DSH Web 真实验收

被测代码是本仓库 `0d8a4d3` 打包后的 tgz，宿主是 DSH `0.2.1-rc.5` Web（`--profile web`，测试用 DSH home），转换器是本机 `ffmpeg` 8.1.2。所有请求都由 Web 中的真实会话发出，模型是 `qwen/qwen3.8-omni-flash`（`openrouter-native-audio`，`tool-message`）；用户在会话中批准了用真实请求确认这些文件能被解码。对应决定见 [0010](../decisions/0010-convert-audio-before-the-store.md)。

## 测试设计

文件放在 workspace 的临时目录，改成不含内容信息的文件名，验收后删除。`a.wav` 是此前被解析器拒绝的 DAW 自带采样 `Vocal Verb Yeah.wav`（classic PCM，`fmt ` 40 字节，24 bit）。其余由真实录音用 `ffmpeg` 转成目标格式，模型看不到参考描述。前四个文件在一个会话中由 `read_audio` 读取，`e.m4a` 在另一个会话中经 Web 输入框上传，并禁止模型调用工具。

## 结果

| 文件 | 来源与格式 | 路径 | 模型回答 | 判断 |
| --- | --- | --- | --- | --- |
| `a.wav` | DAW 采样，PCM，`fmt ` 40 字节 | `read_audio`，字节不变 | 一声带混响的 “Yeah!” | 相符（对照文件名） |
| `b.mp3` | `042.wav`，MP3 | `read_audio` | 两人交谈，随后重叠的笑声 | 部分相符，漏掉一个事件 |
| `c.wav` | `043.wav`，32-bit 浮点 | `read_audio` | 持续的低频发动机声 | 相符 |
| `d.flac` | `040.wav`，FLAC | `read_audio` | 紧急车辆警笛 | 相符 |
| `e.m4a` | `044.wav`，AAC | 上传 | 一名女性平静地讲话，并复述了内容 | 部分相符，说话相符，漏掉一个背景事件 |

`e.m4a` 的持久化 `user/message` 是 `[file, audio]`：文件 93,969 字节，AudioBlock 是 321,580 字节、16 kHz、16 bit 的 `audio/wav`，`name` 仍是 `e.m4a`。

## 局限

每种格式只跑一次，本次没有无音频对照。没有运行 Gemini route 与本地 Qwen3-Omni，AIFF、Ogg、Opus 只有离线转换测试（Opus 没有）。没有在未安装 `ffmpeg` 的机器上跑 Web，缺少转换器的路径只有离线测试。
