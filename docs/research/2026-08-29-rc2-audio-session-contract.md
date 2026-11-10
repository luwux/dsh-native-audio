# 2026-08-29：DSH rc.2 原生音频 Session 合同研究

## 研究问题

本记录验证第三方普通 DSH/Cordis 插件能否在不修改 Harness 源码、不调用真实模型 API 的条件下，把 durable AudioBlock 送入 stock Session、AgentLoop 与 continuable Subagent，并确定从该中间状态到 provider 原生音频、Web 输入和 compaction 仍缺哪些公开合同。

## 固定证据版本

- 已验证发布基线：DeepSeek Harness tag [`dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)，commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，Cordis `4.0.1`，Schemastery `3.18.1`。
- 升级观察快照：DSH `master` commit [`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/deepseek-ai/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc)，仓库版本 `0.1.2-alpha.1`。该快照只用于检查公开 seam 演化，不代表当前 package 已兼容。
- 运行依赖来自发布包和 lockfile；本机 DSH clone 只读用于源码核对，不是插件运行时依赖。

## 已证明的 Host 垂直切片

`AudioBlock` 使用与 `ImageBlock` 相同的 singular occurrence 形状：一个 block 含一个 `attachment`；多份音频由有序 `ContentBlock[]` 中多个 block 表示。Declaration merge 使它成为 DSH `ContentBlock` 与 `audio` modality 的合法类型成员，但不自动改变任何 adapter。

本地附件 service 接受 canonical base64 或 `Uint8Array`，解析 little-endian RIFF/WAVE integer PCM，保存输入原始字节，并返回 JSON-safe `AudioAttachmentRef`。第一版接受 classic PCM 与 `WAVE_FORMAT_EXTENSIBLE` PCM 的 8/16/24/32-bit container；unknown RIFF chunks 按 padding 跳过。Store 使用 SHA-256 内容寻址、先完整 prepare 再发布、私有目录、临时文件加 hardlink 原子发布、fsync、只读对象和 read-time digest/长度/metadata 核对。

真实 rc.2 组合测试加载 Cordis Context、LLM runtime、Session、SystemPrompt、ToolRuntime、AgentRegistry、JSONL SessionPersistence、AgentLoop、SubagentRuntime 与 in-process spawn。Parent Session 先写入一个完整、已完成且包含唯一 sentinel 的 turn；第一次 `startContinuable()` 向 fresh child 发送 AudioBlock，child request 不含该 sentinel，header 保留 `parentSession` lineage 且 seed length 为零。Child 完成并卸载后，第二次 `followup()` 从 JSONL cold resume 同一 child。真实 AgentLoop 的 recording adapter 首次捕获第一份 ref，第二次捕获第一、第二份 ref；持久化 Session log 同样保留两次 `user/message` 的 ref。

Recording adapter 只生成确定性 token chunk，没有 HTTP client、provider SDK、API key 或网络 transport。本次测试证明音频穿过真实 Session/Subagent/AgentLoop 到达 `GenerateOptions.messages`，不证明任何 provider wire 已含音频字节。

## 真实 DAW WAV 兼容观察

只读检查了一个下游 bundle 既有输出中的 22 份 DAW 导出 WAV header，没有复制、修改或播放用户音频。观察到三种形态：5 份 48 kHz/stereo/24-bit classic PCM 含 `JUNK`，16 份 48 kHz/stereo/16-bit classic PCM 含 `LIST`，1 份 48 kHz/stereo/24-bit WAVE_FORMAT_EXTENSIBLE PCM 含 `LIST` 和 channel mask `3`。从三种形态各取一份直接运行当前 `parseWav()` 均成功。

这些观察只证明第一版 parser 覆盖当前样本的容器结构；它不证明全部 DAW export 设置、RF64、float WAV、压缩音频或未来工程都兼容。仓库测试仍只使用确定性合成字节，不提交真实 DAW 音频。

## Provider adapter 实现与边界

rc.2 与升级观察快照的 stock DeepSeek/Pi serializer 都只处理 text/image；未知 merge-extensible AudioBlock 会被过滤或在 default 分支跳过。`ModelModalityMap.audio` 只扩展类型和 catalog 词汇，stock route preparation 也只有 image-specific capability projection。因此 package 增加全局 `audio-route-guard`：请求树包含顶层或 nested tool-result AudioBlock 时，只有显式 allowlist 的 provider route 可继续，其余 route 在 adapter transport 前抛出 `UNSUPPORTED_CONTENT`。

本记录验证的首条原生路径由插件自有 `google-gemini-audio` route 提供。`serializeGeminiRequest()` 读取 durable WAV，为每个 source occurrence 生成一份有 occurrence、message/block/content/part position 和 attachment id 的 receipt，并把未经转码的原始 bytes 编码成 Gemini `inlineData`。重复引用同一 ref 仍产生独立 receipt，保持消息顺序可审计。未知 block、不支持的 role、损坏 ref、nested audio tool result、缺失 tool call id 或不可信 replay metadata 都 fail closed。OpenRouter 的 Pi/SDK 复用边界由 [独立审计](2026-08-30-openai-compatible-audio-reuse.md)拥有。

`GeminiGenerateContentAdapter` 使用与生产路径相同的 serializer；测试只注入 secret-free `captureRequest`、credential resolver 和 fake fetch，没有第二份 capture serializer。Inline transport 在解析 credential 和调用 transport 前验证最终 UTF-8 JSON body 不超过 20,000,000 bytes；Files transport 先解析 credential 以生成凭据分区的稳定 provider name，再物化 `fileData`、验证最终 body，然后才查询或上传文件并调用 generation endpoint。SSE parser 覆盖 byte-hostile UTF-8 chunks、CRLF、注释、多行 data、EOF、取消和 malformed JSON；adapter 还覆盖 tool call/result correlation、`thoughtSignature`/part metadata replay、usage/finish mapping、HTTP 与 in-band safety error。

该第一版使用 Gemini Developer API 的 `streamGenerateContent?alt=sse`。Google 当前把 GenerateContent 文档标为 legacy，而较新的 Interactions API 是后续迁移方向；选择前者是为了在 DSH rc.2 中明确控制 stateless full-history 和 tool replay，不代表它是 Google 最新接口。20 MB 限制依据 [Gemini 音频文档](https://ai.google.dev/gemini-api/docs/audio)。后续实现已增加默认 Files transport，用稳定 `fileData` 引用承载超过 inline request 限制或需要在历史中复用的音频；Interactions API、Live API、输出音频、在线模型发现、provider retry 和 reasoning-effort 映射仍未实现。

## Compaction 实测边界

Stock compaction 在 summarization request 输入阶段保留被选 surface message 的 AudioBlock；因此 summary route 也必须具备 audio serializer 或 fail loud。成功 compaction 会用 checkpoint 替换 selected span，默认 summarizer 只产出 text，并不保证被替换范围内的历史音频继续出现在 active surface。

真实 rc.2 compaction 合同测试使用确定性 subclass，避免调用任何 LLM。位于 selected span 的 AudioBlock 被 text checkpoint 替换；位于 retained tail 的 AudioBlock 经 compact、flush、整个 Context disposal、JSONL cold prepare 后仍解析到同一 ref，store 读取的 WAV bytes 与原始输入一致。

这证明 retained-tail policy，不承诺 selected span 内的历史音频持续发送。若要求后者也持续发送，需新增 audio-aware checkpoint 与 token-pricing 设计。把 AudioBlock 塞入默认 text checkpoint 会违反 stock pricing 假设，不是安全的普通类型扩展。

## Web 公共 seam 边界

rc.2 与升级观察快照都提供 client module、composer/list slots 和 Typert Agent lookup。普通插件可以另放顶层音频控件、定义 custom Remote，甚至接管整个 `conversation.composer`。但 `PromptContentPart`、Host durable admission、draft actions、默认 submission、pending echo 与 attachment history 仍是 text/image 闭合合同。Custom Remote 解决 Agent 寻址，却不会复用 stock prompt 的 route capability、source、queue/steer、乐观回显和失败恢复；composer takeover 则必须复制整个 InputBar 和图片状态机。

因此不实现 queue-only PoC 或完整 composer takeover。Main 到 Music child 的稳定路径留在 Host，通过 Subagent `ContentBlock[]` start/followup 投递音频；Web 端等待 generic attachment/submission contributor seam。逐源码证据和最小上游提案见 [Web 扩展面审计](2026-08-30-dsh-web-audio-extension-seam.md)。

## 当前验证结果

独立插件仓库的离线测试现已覆盖：

- 类型扩展、WAV parser、admission/store/read 和 Cordis service；
- 全局 route guard 的顶层与 nested audio fail-closed；
- Gemini final-wire JSON、ordered occurrence receipts、字节等价、tool replay、SSE、取消和错误映射；
- fresh Subagent 经真实 AgentLoop 和 Gemini Cordis plugin 到 fake fetch 的单链路最终请求；Main sentinel 未进入 child wire；
- 真实 rc.2 Session/AgentLoop/Subagent fresh start、cold followup、resident followup/interrupt FIFO；
- selected-span replacement 与 retained-tail cold compaction；
- 构建/pack 后的真实 Cordis Loader composition、provider/service effect disposal 和外部 TypeScript consumer imports。

所有 provider transport 都是 injected fake；没有真实 API key 或真实 endpoint。仍未证明：完整 DSH profile CLI 的 `--dump-config`、Web composer/历史播放器、真实浏览器组合和任意未来 DSH 版本兼容。

2026-08-30 全量门禁结果为：TypeScript typecheck 通过，14 个 Vitest 文件共 33 项测试通过，build 通过，Agent Note verifier 通过，`git diff --check` 通过。

因此总体 Agent Note 保持 `proposed`，Task 保持 `in-progress`：Host/provider 垂直切片是当前事实，Web 与 profile CLI 仍是未完成范围。文档工作流本身已经安装并可由格式检查验证，所以它单独保持 `implemented`。
