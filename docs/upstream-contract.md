# DeepSeek Harness 上游契约

本文是第三方插件当前运行时基线与上游接口索引，不复制 DSH 整仓库产品文档。发布基线源码决定可声称的兼容合同；GitHub Pages 与 `master` 只能作为候选演化证据。

## 已验证发布基线

- 仓库：`deepseek-ai/deepseek-harness`
- tag：`dsh-v0.2.2-rc.1`
- commit：[`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db)
- DSH packages：`0.2.2-rc.1`
- Cordis：`4.1.0`；`cordis-plugin-loader`：`1.1.0`；`cordis-plugin-include`：`1.1.0`
- Schemastery：`3.19.0`
- pi-ai：`@earendil-works/pi-ai@1.5.1`。DSH 包声明 `^1.3.0`，上游仓库在该 tag 锁定并打过补丁（`patches/@earendil-works__pi-ai@1.3.0.patch`）的是 `1.3.0`，2026-11-09 从 npm 安装 `@deepseek-ai/dsh@0.2.2-rc.1` 实际解析到 `1.5.1`；本仓库按后者验证
- OpenAI JavaScript SDK：`openai@7.19.0`，由 pi-ai 的 `openai-completions` 实现传递依赖并拥有 transport

`package.json` 只声明上述已验证基线：DSH packages 的 peer 与 dev dependencies 精确等于 `0.2.2-rc.1`；Cordis 与 `cordis-plugin-loader` peer 沿用上游自身的 `~4.1.0`、`~1.1.0`，Schemastery 声明 `~3.19.0`，dev dependencies 精确锁定上述版本。扩大兼容范围前必须增加相应版本的 install、typecheck、Loader、Session/Subagent 和 packed-consumer matrix。DSH `0.1.1-rc.2` 不再受支持；最后支持它的源码是本仓库 `main` 上的提交 `77f758f`。

## 第三方插件与 bundle

- [第一个 Harness 插件](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/basic/index.md)：普通插件导出 `apply(ctx, config)` 或可由 Loader 应用的 plugin class，通过 `inject` 声明真实依赖，由 profile patch 加载。
- [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/basic/publish.md)：第三方发布单位是带 `dsh.bundle.patch` 的 npm package，用户通过 `dsh plugin --profile <name> add` 安装到 profile。
- [配置](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/basic/config.md)：部署可调值由 Schemastery `Config` 验证；`.volatile()` 字段以 `Volatile<T>` 引用交给插件，[Loader](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/vendor/loader/README.md) 在只有 volatile 字段变化时原地更新引用并发出 `loader/volatile-update`，[Settings](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/settings/settings/README.md) 表单按 profile entry id 编辑这些字段，并把旧版 `settings.yaml` 的同名 section 一次性导入对应 entry。
- [Cordis 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/cordis-tutorial/02-lifecycle-and-effects.md) 与 [Services](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/cordis-tutorial/03-services.md)：Fiber 激活由依赖决定，注册随 effect 卸载。

本仓库使用独立 package/bundle，不在 DSH monorepo 的 `packages/` 下开发。

## 音频闭环所依赖的发布源码 owner

| 主题 | 0.2.2-rc.1 源码或文档 | 对本项目的约束 |
| --- | --- | --- |
| Content block、modality 与消息 | [`llm/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm/src/types.ts) 与 [`message.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm/src/message.ts) | `ContentBlockMap` 和 `ModelModalityMap` 可 declaration merge。消息有稳定 `id` 与必填 `source`，content 只读；tool result 是 `role: 'tool'` 消息，内容是任意 `ContentBlock[]`。Loop 请求的 system prompt 是开头的 `role: 'system'` 消息。 |
| LLM runtime 与 adapter | [LLM adapter guide](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/user/develop/practice/llm-adapter.md) 与 [`llm/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm/src/index.ts) | Adapter 必须序列化 AudioBlock，不支持的内容 fail loud，并尊重 `AbortSignal`。`LlmRuntime` 在 adapter 之前把 FileBlock 投影为路径文本、为无 `toolUpdate` 的 route 去掉 developer 消息；`llm/stream` listener 只能观察请求，不能替换内容。`resolveModel().reasoning` 决定 Web 推理等级选项，`prepareCall()` 把模型元数据与 dispatch 绑定到同一配置快照。 |
| DSH Pi adapter | [`llm-pi-ai/src/adapter.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm-pi-ai/src/adapter.ts) 与 [`context.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm-pi-ai/src/context.ts) | `PiAiAdapter` 拥有 credential、model snapshot、tool/reasoning replay、abort、stream chunk、usage 与 error 映射；context converter 对未知 block 执行 default skip，因此 AudioBlock 必须在进入 converter 前保住 occurrence。Model 不声明 `image` 输入时，`PiAiAdapter` 在进入 converter 前对含图片的请求报 `UNSUPPORTED_CONTENT`；没有图片时 converter 把一条消息的 text block 无分隔符拼成一个 text block。Provider profile 需要 `modelErrors`。插件可经 waterfall 事件 `'llm-pi-ai/request-headers'`（adapter 选项 `prepareHeaders`）编辑每次推理的请求 headers，抛错使调用以 `REQUEST_HEADERS` 失败；没有 payload hook。 |
| pi-ai OpenAI Completions | [`v1.5.1 openai-completions.ts`](https://github.com/earendil-works/pi/blob/v1.5.1/packages/ai/src/api/openai-completions.ts) | `StreamOptions.onPayload` 在 SDK 调用前检查或替换完整 payload；该公开 hook 是 OpenAI-compatible 音频 bridge 的唯一 wire 扩展点。每条 tool result 的 text block 用 `\n` 合并为 tool 消息的字符串 content；model `input` 含 `image` 时，同一段连续 tool result 中的图片移到其后的一条 user 消息（`Attached image(s) from tool result:`），否则不发送。`requiresAssistantAfterToolResult` 自动检测恒为 `false`，只有 model `compat` 设置它时才在 tool result 与随后的 user 消息之间插入合成 assistant 消息。 |
| OpenRouter 音频 wire | [Audio input](https://openrouter.ai/docs/guides/overview/multimodal/audio) 与 [OpenAI SDK quickstart](https://openrouter.ai/docs/quickstart) | OpenRouter 使用 `/api/v1/chat/completions` 和 user content 中的 `input_audio`；Chat Completions 的 tool 消息只定义文本 content。Tool 消息中的 `input_audio` 是否被接受、被模板丢弃或被模型听到取决于下游 provider 与模型，2026-10-08 的[探测](research/2026-10-08-chat-completions-tool-audio-probe.md)记录了已测模型的结果。 |
| Session log | [`core/session/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/session/src/index.ts) | 模型可见内容进入已有 `user/message` 或 tool result 消息；仓外自定义 event 无法由 stock persistence cold reopen。 |
| Agent step 扩展点 | [`core/agent/src/runtime-types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent/src/runtime-types.ts) | `agent/pre-step` waterfall 可以拒绝 step 或替换进入 step 的消息，替换结果被持久化；`file-ingress` 用它把 WAV FileBlock 补成 AudioBlock。 |
| 文件与图片附件 | [`attachment/attachment`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/attachment/attachment) 与 [`attachment-local`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/attachment/attachment-local) | 图片附件提供 durable ref、persist-before-event、content addressing 与 verify-on-read 的基线。文件附件按字节原样保存，`FileAttachmentRef` 只有 `name` 与 `bytes`，字节经 `readFileStream` 读取。 |
| Host prompt | [`api/session-controller/src/commands.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/src/commands.ts) | Web prompt 由 text、image 与 file receipt 组成，经 `attachments.admitPromptContent` 转为 `user/message`；没有插件可注册的音频 prompt part。 |
| Subagent | [`docs/subsystems/subagent.md`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/subagent.md) 与 [`subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/subagent/src/index.ts) | `startActivation` 与 `sendMessage` 接受 `ContentBlock[]`；stock model tool 只接收字符串。 |
| 工作目录 | [`session/working-directory`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session/working-directory) | Session 当前目录由 `ctx.workingDirectory` 拥有，`working_directory` 工具可以中途切换，Session header 的 `cwd` 只是初值；`SubagentRuntime` 与 `read_audio` 都 inject 它。 |
| Stock Subagent model tool | [`subagent/tool-subagent`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/tool-subagent) 与 [`tool-subagent-control`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/tool-subagent-control) | 只作为轨迹重放测试的 dev dependency。`subagent` 工具始终在后台启动 child 并返回 `started subagent <id>`；child 用 `send_message` 回报，父 Agent 收到 `Agent <id> sent a message:` 与 `Background subagent <id> finished` 通知，child prompt 末尾写明父 Agent id；child 最后一个工具调用是 `send_message` 时，finished 通知省略 child 的收尾文本。测试依赖这些文本。 |
| Web composer | [`ui-conversation/src/client/contract/slots.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-conversation/src/client/contract/slots.ts) | Composer 附件分为 image 与 file 两类；file 在选取时上传，提交时作为 FileBlock 进入消息。 |
| Compaction/replay | [LLM Streaming](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/llm-streaming.md) 与 compaction 源码 | retained tail 可保留 AudioBlock；selected span 默认被 text checkpoint 替换。 |

## 公开扩展点与必须 fail closed 的位置

普通插件可以扩展 Cordis services、content block 类型、model modality、adapter、Subagent 输入和 `agent/pre-step` 消息。以下事项不能只靠类型声明或静态 manifest 证明完成：

- stock route preparation 只有 image-specific modality 处理；
- stock Pi/DeepSeek serializers 静默跳过或拒绝未知 AudioBlock；
- stock compaction checkpoint 只保留 text；
- Web history renderer 没有 AudioBlock 专用展示；
- bundle patch 的真实 parser、Loader、profile 和 packed-consumer 路径；
- stock persistence 不认识仓外新 Session event 类型；
- [`session-format-v2-to-v3`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session/session-format-v2-to-v3) 只迁移 stock content kind，含 AudioBlock 的 DSH `0.1.1-rc.2` Session 在 0.2 中无法打开，插件不能为该静态迁移注册新的 kind。

实施时优先使用公开 service、event、slot 和 adapter 扩展点。如果必须读取私有字段、替换 DSH 源文件或 monkey-patch 内部方法，Task 应停止并把最小缺口写成上游 Proposal，而不是把 workaround 当作普通插件能力。

Chat Completions 音频是这条纪律的唯一例外（[0011](decisions/0011-chat-completions-audio-on-llm-pi-ai.md)）。Bridge 读取私有的 `LlmRuntime.adapters`（Map，值含 `adapter`）与 `PiAiAdapter.config`（`profiles`、`resolveApiKey`），替换这两个 config 函数，并在实例上替换 `stream`、`prepareCall`、`listModels`、`resolveModel`。Client module 依赖 `settings.models.provider-card` slot 的 owner props `{provider, configured, keyConfigured}`。升级 DSH 时先核对这些名字。上游提供 `PiAiAdapter` payload hook 和可扩展的模型 modality 后，这些访问应当删除。Bridge 在 DSH converter 前把 AudioBlock 物化为一次性 marker，并在 pi-ai 公开 `onPayload` hook 中生成 `input_audio`；tool result 音频的放置见 [OpenAI-compatible spec](specs/openai-compatible-provider.md#bridge-行为)。除这次内容投影外，request 与 response 生命周期继续由上游实现拥有。

## 代码改编来源

[`src/store.ts`](../src/store.ts) 的内容寻址对象发布、私有权限、目录持久化和读取时摘要校验改编自 DSH 发布基线 [`b150a551`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e) 的 [`packages/attachment/attachment-local/src/store.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/attachment/attachment-local/src/store.ts)，依照 DSH 的 [MIT 许可证](../THIRD_PARTY_NOTICES) 使用。图片 decode、normalization 与 request projection 没有带入；WAV 字节保持不变。
