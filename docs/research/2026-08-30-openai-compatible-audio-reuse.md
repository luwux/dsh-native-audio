# 2026-08-30：OpenAI-compatible 音频适配复用审计

## 研究问题

本记录回答三个问题：OpenRouter 音频 route 是否需要重写完整 DSH adapter；哪些 DSH、pi-ai 与官方 SDK 代码可以直接复用；本仓库真正必须拥有的最小音频增量是什么。

## 固定证据

- DeepSeek Harness 发布基线是 tag [`dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)，commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。
- DSH [`LLM adapter guide`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/user/develop/practice/llm-adapter.md)把 `llm-deepseek` 与 `llm-pi-ai` 列为两种参考实现：前者直接拥有 HTTP/SSE，后者包装一个成熟的多 provider LLM 库。
- 本仓库固定 `@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2`、[`@earendil-works/pi-ai@0.82.1`](https://github.com/earendil-works/pi/tree/v0.82.1/packages/ai)；lockfile 中 pi-ai 使用官方 [`openai@6.26.0`](https://github.com/openai/openai-node/blob/v6.26.0/src/resources/chat/completions/completions.ts) JavaScript SDK，其 Chat Completions types 包含 `ChatCompletionContentPartInputAudio`。
- OpenRouter 的 [OpenAI SDK quickstart](https://openrouter.ai/docs/quickstart)要求把官方 SDK 的 `baseURL` 指向 `https://openrouter.ai/api/v1`；[Audio input 文档](https://openrouter.ai/docs/guides/overview/multimodal/audio)规定 Chat Completions user content 使用 `{ type: 'input_audio', input_audio: { data: rawBase64, format: 'wav' } }`。
- OpenRouter 的 [`google/gemini-3.7-flash` model page](https://openrouter.ai/google/gemini-3.7-flash)列出 audio input、1,048,576 context window、65,536 completion limit 和 tool calling。该目录事实会变化，因此 plugin 把模型列表设计为 settings 可配置值，而不是把全部 OpenRouter catalog 编进源码。

## 上游代码实际拥有的能力

DSH [`PiAiAdapter`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-pi-ai/src/adapter.ts)已经拥有 provider/model snapshot、credential resolution、reasoning effort、tool schema、assistant replay state、abort、stream idle timeout、pi event 到 `StreamChunk` 的转换、usage 和 terminal error 语义。重新实现这些行为会形成第二套 DSH runtime，而不是一个音频扩展。

DSH [`toPiContext()`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/llm/llm-pi-ai/src/context.ts)显式转换 text、image 与 tool result，并在 default 分支跳过其他 declaration-merged block。pi-ai `0.82.1` 的 [`UserMessage`](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/types.ts)也只接受 string 或 `TextContent | ImageContent`。因此 AudioBlock 不能原样穿过 stock DSH→Pi 内容转换；单纯给 TypeScript declaration merge 增加 `audio` 不会改变最终请求。

pi-ai `0.82.1` 的 [`StreamOptions.onPayload`](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/types.ts)是公开的最终 payload 检查或替换 hook。[`simple-options.ts`](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/api/simple-options.ts)把它从 `streamSimple()` 保留到具体 API options；[`openai-completions.ts`](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/api/openai-completions.ts)先构造完整 params，再调用 `onPayload`，最后才调用官方 OpenAI SDK。这个时点已经包含 system、history、tools、reasoning、token limit 与 streaming options，并且尚未发起 HTTP 请求。

pi-ai 的 [`openrouterProvider()`](https://github.com/earendil-works/pi/blob/v0.82.1/packages/ai/src/providers/openrouter.ts)本身就是 `createProvider()` + OpenRouter base URL/catalog/auth + `openAICompletionsApi()`；本仓库沿用同一 provider construction，只把 API stream 包一层最终 audio payload hook。pi-ai 的兼容层根据 provider/base URL 处理 developer role、reasoning dialect、usage streaming、token-limit field、tool-result name 和 OpenRouter routing 等差异。把 OpenRouter 当成只有 endpoint 不同的裸 OpenAI clone 会丢掉这些已经存在的适配规则。

## 最小实现边界

```text
DSH GenerateOptions.messages 中的 AudioBlock
  → AudioAttachmentStore.readAudio()
  → 用 request-scoped marker 替换同一位置
  → DSH PiAiAdapter.toPiContext()
  → pi-ai 构造完整 Chat Completions payload
  → pi-ai onPayload()
      marker → input_audio(raw base64, wav)
  → official OpenAI SDK
  → fake fetch 或经明确授权的真实 OpenRouter endpoint
```

marker 只存在于一次 adapter 调用的内存副本中，不写回 Session、Subagent history 或 durable attachment。每次请求使用随机 id，每个 audio occurrence 有独立序号；最终 patch 要求每个 occurrence 恰好出现一次，完成或失败后释放 request map。这样既不会扩展 pi-ai 的 text/image public vocabulary，也不会 monkey-patch DSH 私有 converter。

`OpenAICompatibleAudioPayloadBridge`只拥有四项行为：从既有 store 读取已经验证的 WAV；保留 AudioBlock 的消息和 block 顺序；在最终 user content 中生成 `input_audio`；生成 occurrence receipt 并拒绝无法表达的 role 或 nested tool-result audio。它不重复 store 的 MIME、hash、length 或 WAV admission，因为这些检查已有唯一 owner。

`OpenAICompatibleAudioAdapter`只组装一条自定义 pi-ai provider stream，把上述 bridge 接入公开 `onPayload`，再把 `providerInfo`、model resolution、`prepareCall`、retry policy 与 stream 委托给 DSH `PiAiAdapter`。HTTP、headers、OpenAI request options、SSE、tool-call partial JSON、reasoning delta、usage、finish 和 provider error 都不在本仓库重新实现。

`openrouter-native-audio` Cordis face 只拥有 route/settings/credential/model catalog 与 effect 生命周期。它与 `google-gemini-audio` 共用 base service 的动态 allowlist；卸载任一 provider 不会错误地关闭另一条已挂载 route。

## 复用责任表

| 行为 | Owner | 本仓库是否重写 |
| --- | --- | --- |
| Session、Subagent、steer、compaction/replay | DSH | 否 |
| DSH message → Pi context、tool/reasoning replay、StreamChunk | DSH `PiAiAdapter` | 否 |
| OpenAI-compatible options、compat detection、stream parsing、usage/error | pi-ai `openai-completions` | 否 |
| HTTP client、Bearer header、baseURL、SSE transport | official OpenAI SDK through pi-ai | 否 |
| OpenRouter `input_audio` wire shape | OpenRouter documented contract | 只生成该 content part |
| durable WAV admission/read | `AudioAttachmentStore` | adapter 只调用 |
| AudioBlock occurrence materialization 与 receipt | `dsh-native-audio` | 是 |
| Cordis route/settings/credential 生命周期 | `openrouter-plugin` | 是 |

## 为什么不直接复用 stock OpenRouter route

Stock DSH Pi converter 在 audio 到达 pi-ai 前就会跳过未知 block，而 pi-ai `0.82.1` 的 context type 没有 audio 成员。只在 `cordis.yml` 把 stock OpenRouter model 标成 audio-capable 会造成静默丢失；route guard 必须继续拒绝这种配置。

当前 DSH `PiAiAdapter` 没有注册 content-block converter 或 per-profile `onPayload` contributor 的配置 seam。本仓库因此构造一个公开 pi-ai provider stream 并交给公开 `PiAiAdapter`，而不是复制其内部代码。若上游以后暴露 audio content converter，marker bridge 可以缩减为该 converter，不需要改变 AudioBlock、store、route 名或 consumer API。

## OpenAI-compatible 的准确边界

“OpenAI-compatible”是接口家族描述，不是保证所有 endpoint、模型和 SDK 版本都支持 audio 的正式统一规范。许多兼容服务只实现 text、tools 或 image；有的在 reasoning、system role、max-token field 和 streaming usage 上也不同。

因此 generic adapter 只表示它能复用 Chat Completions `input_audio` payload 形状；每个 provider plugin 必须单独给出 endpoint 文档、模型 modality、format 和 limit 证据。当前仅 OpenRouter face 满足这一条件，不自动替任何私有 gateway 开启 audio allowlist。

## TypeScript 构建边界

引入完整 pi-ai provider package 会把多个可选 provider SDK 的 declaration 一并放入依赖图。独立工作区在 `skipLibCheck: false` 时命中第三方 Anthropic SDK declaration 的错误；这些错误不来自本仓库 public API。项目采用与 DSH [`tsconfig.base.json`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/tsconfig.base.json)一致的 `skipLibCheck: true`，同时保留 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess` 和 packed external-consumer declaration typecheck。

该设置只跳过依赖 `.d.ts` 的内部一致性检查，不跳过本仓库 TypeScript source、生成 declarations 或 consumer imports。若 pi-ai 后续提供只含 OpenAI protocol 的更窄 package，或上游 vendor declarations 修复，可以重新评估这一编译选项。

## 离线验证与未知项

纯 bridge 测试证明 text/audio/text/audio 的顺序、byte-equivalent base64、逐 occurrence receipt 和 nested tool-result fail-closed。Adapter 测试用 fake fetch 证明最终 request body 不含 marker，并由 pi-ai 返回 text、reasoning、tool call、usage 和 finish chunks。

完整合同测试让 fresh DSH Subagent 经真实 Session、AgentLoop、`openrouter-native-audio`、DSH `PiAiAdapter`、pi-ai 与官方 OpenAI SDK 到达 fake fetch；断言 URL、Bearer key、DSH attribution、`input_audio` WAV bytes、Main-history isolation 和 durable Session event。测试没有真实 API key，也没有访问 OpenRouter 网络。

这些证据证明代码复用边界和预期 wire shape，不证明 OpenRouter 当日服务状态、计费、模型实际听感、上游 provider 路由选择或真实音频响应质量。真实 API 验收仍需单独明确授权；本项目当前验收口径禁止执行它。
