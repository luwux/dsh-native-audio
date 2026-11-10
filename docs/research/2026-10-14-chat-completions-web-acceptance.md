# 2026-10-14：tool result 音频的 DSH Web 真实验收

本记录是 [DSH-AUDIO-030](../tasks/2026-10-14-chat-completions-tool-result-audio.md) 的真实验收证据。被测代码是本仓库 `185513a` 打包后的 tgz，宿主是 DSH `0.2.0-rc.2` Web（`--profile web`，测试用 DSH home）；所有请求都由 Web 中的真实会话发出，用户在会话中授权了这些 OpenRouter 与 Google API 请求。

## 测试设计

六段 macOS `say` 生成的 16 kHz 单声道 16-bit WAV（约 4.25 秒），内容是 “The secret word is <word>” 念两遍，单词从 12 个候选中随机选出。文件名为 `acceptance-1014/clip-1.wav` 到 `clip-6.wav`，不含内容信息；答案表保存在 DSH workspace 与 DSH home 之外。每个会话只要求模型用 `read_audio` 听一个文件并说出单词，禁止 bash 与读取其他文件；Session log 中模型可用的信息只有 `read_audio` 结果，MiMo Subagent 用例的主 Agent 另调用过一次 `glob`，只看到文件名。对照：Qwen 会话第一轮被要求不调用工具说出 `clip-3` 的单词，回答“我不知道”；第二轮调用 `read_audio` 后答对。

## 结果

| 模型与 route | 放置 | 主 Agent `read_audio` | Subagent 自己 `read_audio` 后 `send_message` |
| --- | --- | --- | --- |
| `gemini-3.8-flash`，`google-gemini-audio` | Gemini route | clip-1 正确 | clip-2 正确 |
| `qwen/qwen3.8-omni-flash`，`openrouter-native-audio`（Alibaba） | `tool-message` | clip-3 正确，并复述整句 | clip-4 正确 |
| `xiaomi/mimo-v2.6-flash`，`openrouter-native-audio`，provider 固定为 Xiaomi 或 Makora | `user-message` | clip-5 正确 | clip-6 正确 |

MiMo 行的请求经一个本地记录代理转发到 OpenRouter，代理只给请求体加入 `provider: { order: ['Xiaomi', 'Makora'], allow_fallbacks: false }`，其余字节不变。抓到的请求中，tool 消息只含文本与 `[audio attached in the next user message]`，其后的 user 消息含标签文本与 `input_audio`（`wav`）；主 Agent 的请求不含音频。Subagent 发送 `send_message` 之后的下一次请求，前 7 条 wire 消息与读取音频后那次请求逐字节相同。

`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` 的会话多次以上游错误 `ResourceExhausted: Worker local total request limit reached` 结束；其中一次在报错前连续调用了三次 `read_audio` 而没有回答，因此不计入结果。

## OpenRouter 把 MiMo 路由到丢弃音频的 provider

不固定 provider 时，两次 MiMo Web 会话都没有听到 clip-5：一次回答了错误单词，另一次回答 `read_audio` 只返回了元数据。OpenRouter 为该模型列出 8 个 provider，endpoints API 不提供逐 provider 的输入模态。把抓到的请求原样或按变体重放，并用 `provider.order` 与 `allow_fallbacks: false` 固定 provider：

| Provider | 抓到的完整请求（`user-message`） | 只有一条带音频的 user 消息 |
| --- | --- | --- |
| DeepInfra | 输入 8,560 token，回答错误单词 | 输入 26 token，回答错误单词 |
| Xiaomi | 输入 8,694 token，正确 | 输入 52 token，正确 |
| Makora | 输入 8,588 token，正确 | 输入 54 token，正确 |

DeepInfra 的输入 token 与 DSH 记录的无音频请求规模相同，回答与音频无关，HTTP 状态为 200。不固定 provider 的重放中，被分到 Xiaomi 的 `tool-message` 变体与 `user-message` 变体都答对。

## 局限

每个模型每种用例只跑一次，音频是合成语音单词。没有运行本地 Qwen3-Omni（本地 llama-server）；用户在本日把真实验收改为 OpenRouter 与 Google API。MiMo 其余 5 个 provider 未测。
