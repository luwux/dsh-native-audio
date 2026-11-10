# 2026-10-08：Chat Completions tool 消息音频与 Vercel AI SDK 真实探测

本记录是 [0009](../decisions/0009-chat-completions-tool-result-audio.md) 的证据。两组请求都由手写脚本直接发出，不经过本仓库代码，脚本没有纳入仓库；用户在会话中明确授权了这些真实请求。

## 测试音频与判定

macOS `say` 生成的 16 kHz 单声道 16-bit WAV（141,574 bytes，约 4 秒），内容是 “The secret word is pineapple” 念两遍，单词从六个候选中随机选出。请求让模型只回复听到的单词，听不到时回复 `UNKNOWN`。回复包含该单词记为听到；第三种对照请求不带音频，用于排除猜中。

## 探测一：经 OpenRouter 的手写 Chat Completions 请求

请求历史为：user 要求调用 `read_audio`，assistant 的 `tool_calls` 调用 `read_audio`，随后按变体放置 tool 结果：

- A：tool 消息 content 为 `[{type:'text'}, {type:'input_audio', input_audio:{data, format:'wav'}}]`。
- B：tool 消息只有文本，其后一条 user 消息携带标签文本与 `input_audio`。
- C：tool 消息只有文本，没有音频。

| 模型（OpenRouter 报告的 provider） | A | B | C |
| --- | --- | --- | --- |
| `qwen/qwen3.8-omni-flash`（Alibaba） | 听到，416 输入 token | 听到，435 | `UNKNOWN`，386 |
| `mistralai/voxtral-small-24b-2507`（Mistral） | 听到，147 | 听到，168 | 空回复，142 |
| `xiaomi/mimo-v2.6-flash`（Makora） | 听到，177 | 听到，199 | 回复无法听取音频，148 |
| `google/gemini-3.8-flash` | 403 | 403 | 403 |
| `openai/gpt-audio-mini` | 403 | 403 | 403 |

两个 403 行在不带音频的 C 中同样出现，错误为 provider Terms of Service，属于账号对该 provider 的访问限制，与音频位置无关。

## 探测二：Vercel AI SDK

版本：`ai@7.0.40`、`@ai-sdk/google@4.0.93`、`@ai-sdk/openai-compatible@3.0.67`。Google 直连 `gemini-3.8-flash`；OpenAI-compatible provider 指向 OpenRouter 的 `qwen/qwen3.8-omni-flash`。通过自定义 `fetch` 记录最终请求体。

| 情形 | 最终请求 | 结果 |
| --- | --- | --- |
| Google，user 消息 file part | `inlineData` | 听到 |
| Google，tool result `file-data` | `functionResponse.parts[].inlineData` | 听到 |
| Google，`uploadFile` 后在 tool result 中引用文件 | 引用被写成 `functionResponse.response.content` 中的 JSON 文本 | 未听到；新写法回复 `SESAME`，旧写法回复为空 |
| Google，无音频 | — | `UNKNOWN` |
| OpenAI-compatible，user 消息 file part | `input_audio` | 听到 |
| OpenAI-compatible，tool result 音频 | 整段 base64 序列化进 tool 消息的 JSON 字符串 | `UNKNOWN`，131,869 输入 token |
| OpenAI-compatible，无音频 | — | `UNKNOWN` |

Google provider 在回放缺少 `thoughtSignature` 的 Gemini 3 `functionCall` 时，自动写入 `skip_thought_signature_validator` 让请求通过。

## 局限

每个模型每种变体只发了一次请求，音频只有一段合成语音。探测没有覆盖音乐内容、长音频、多段音频或 compaction 之后的 history。
