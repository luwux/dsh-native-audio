# DSH-AUDIO-010：原生音频插件第一版

Status: complete

## 结果

交付一个可安装的独立 DSH bundle，使 WAV 音频通过 Web、程序化入口或 `read_audio` Tool 进入真实 Session 与 stable Subagent。自动化默认使用 fake transport；本 Task 最终另跑两次用户明确授权的最小 Google Gemini 浏览器验收。

Host、provider、Subagent、rc.2 Web compatibility face、`read_audio`、pack/profile 和两次授权浏览器验收均已完成。插件不修改 DSH 上游，也不声称提供 stock 逐手势 busy-mode 或 durable history player。

## Owning decision

[0001: 原生音频作为独立 DSH 插件](../decisions/0001-standalone-dsh-plugin.md)

## 范围

1. 建立独立仓库、文档生命周期、package build 和 bundle/profile scaffold。
2. 扩展 `ContentBlockMap` 与 `ModelModalityMap`，定义只含 durable ref 与必要展示元数据的 `AudioBlock`。
3. 实现 WAV admission、content-addressed immutable store、batch atomicity、persist-before-event 和 verify-on-read。
4. 通过公开 Host/Session seam 让 audio 进入已知 `user/message`，并完成 derive、compaction、cold replay。
5. 实现程序化 API，使 consumer 能以 `ContentBlock[]` start/followup 一个独立 continuable child。
6. 实现至少一个 audio-native adapter 路径和一个永不联网的 capture adapter；前者的 provider wire serialization 用 fixture 验证，后者用于完整运行时验收。
7. 实现 DSH Web client 入口、附件草稿、同次提交、错误显示和待发送播放/暂停；历史采用 stock generic extra-block，刷新不恢复未提交 browser 草稿。
8. 提供 `dsh.bundle.patch`、构建产物、安装说明和 tarball/profile 离线验收。

## 非目标

- 不实现 DAW 控制、render、resampling、freeze 或 export。
- 不定义 Main 何时调用 Music Agent，也不强制 Main → Music 流程。
- 不依赖 private Experimental Agent Teams。
- 不创建新的仓外 Session event 类型。
- 不在 attachment 层转录、重采样、改位深、改声道、响度归一化、降噪、裁剪、dither 或转码。
- 不添加 antivirus、版权判断、静音/削波拒绝、BPM/调性判断、HMAC、多重 hash 或数据库 ACL，除非后续 threat model 和 consumer 证据形成新的 Proposal。

## 实施顺序

### 1. 工作区与上游契约

- [x] 新建独立 `dsh-native-audio` 工作区。
- [x] 安装并适配 DSH Agent Docs Kit。
- [x] 初始化 package、TypeScript、build、test 与 `dsh.bundle` scaffold。
- [x] 固定 DSH `0.1.1-rc.2`、Cordis `4.0.1` 与 Schemastery `3.18.1` 兼容基线。

### 2. 最小 Host 垂直切片

- [x] 定义 singular AudioBlock、AudioAttachmentRef、limits、stable error codes 和 Config。
- [x] 实现 WAV-only admission/store/read。
- [x] 用 stock `user/message` 完成 child Session append、surface derive 与 cold followup replay。
- [x] 让不联网的 recording adapter 在真实 AgentLoop 捕获包含音频的 `GenerateOptions.messages`。
- [x] 让 capture adapter 通过生产 serializer 捕获最终 provider wire object、音频 occurrence receipt 与原始字节等价证据。
- [x] 安装全局 route guard，让 stock Pi/DeepSeek 等未经审计的 route 在 transport 前拒绝顶层和 nested AudioBlock。
- [x] 注册 `google-gemini-audio` Cordis provider face，并接入 DSH settings、credential ref 与 effect disposal。
- [x] 默认通过 Gemini Files API 为历史 AudioBlock 使用稳定 `fileData`，覆盖首次上传、同进程复用和冷缓存 metadata hit；保留显式 inline transport。
- [x] 合并跨 SSE event 的兼容 text/reasoning delta，避免 provider transport 分块成为 Markdown 块边界。
- [x] 实现复用 DSH `PiAiAdapter`、pi-ai `openai-completions` 与官方 OpenAI SDK 的薄 OpenAI-compatible bridge；自有逻辑只物化 AudioBlock 并在最终 `onPayload` 位置生成 `input_audio`。
- [x] 注册 `openrouter-native-audio` Cordis provider face，并接入 DSH settings、credential ref、可配置模型目录与 effect disposal。

### 3. Subagent

- [x] 通过 stable Subagent `startContinuable()` 把 AudioBlock 送入 fresh child。
- [x] 通过 `followup()` 复用 child context 并送入下一份音频。
- [x] 销毁第一轮 child 后，通过 persistence cold resume 并保留 child 自己的两轮音频上下文。
- [x] 用已完成 parent turn 的 sentinel 明确验证 fresh child 未 fork Main history，且 child header 的 lineage seed 为零。
- [x] 覆盖 resident followup 与 interrupt；rc.2 已接纳的 FIFO followup 在 interrupt 后由下一次 waking send 恢复。
- [x] 验证 retained-tail compaction 保留 active audio ref，并把 selected-span replacement 作为显式 history policy 测试。

### 4. Web 与上游 seam

- [x] 审计 rc.2 和当前 master 的 PromptContentPart、Host admission、InputActions、submission、slots、Typert Agent lookup 与 stock Pi replay。
- [x] 拒绝完整 composer takeover；采用只覆盖附件 presentation 的受限 Typert Remote compatibility face。
- [x] 定义最小上游 seam：extensible prompt part、Host admitter registry、draft contributor、generic pending/history renderer。
- [x] 按官方 client module factory 格式导出 `/client`。
- [x] 用 single-slot priority shadow 保留官方图片生命周期，用 hidden `CommandClaim` 复用 Enter、图片序列化和失败恢复。
- [x] 支持粘贴/拖入 WAV、删除草稿、播放/暂停和 text/image/audio 同一次 Host 投递。
- [x] 实现 `read_audio` Tool，并让 Gemini 序列化器把 nested Tool AudioBlock 放入下一次模型请求。
- [x] 记录 rc.2 历史 generic extra-block 和 busy queue/steer mode 限制；不用 ChatView takeover 伪造完整同构。

Compatibility face 以 public slot、InputMachine 事件和 Typert Remote 完成交付；它没有获得通用 submission contributor，因此按 Agent 当前状态把空闲请求映射为 `followup`、运行中请求映射为 `steer`。证据和接口差异见 [Web 扩展面审计](../research/2026-08-30-dsh-web-audio-extension-seam.md)。

### 5. 发布与消费

- [x] 从构建/pack 后的 package 运行真实 Cordis Loader patch 组合，验证 base/provider row 与 effect disposal。
- [x] `pnpm pack` 后解包到临时 `node_modules`，从外部 consumer 导入 runtime/types 并完成 TypeScript typecheck。
- [x] 安装到含完整 DSH CLI 的临时 profile并启动 Web 服务，实际加载 pack tarball 的 Host 与 browser module。
- [x] 在 DSH Web 浏览器界面中使用 Google Gemini 人工验收两份不同、中性文件名的音频：第一份手动附件提交，第二份由 Agent 调用 `read_audio`。
- [x] 编写 [Host consumer 接入指南](../consumer-guide.md)；下游 bundle 侧的可执行拆分由其仓库维护。

## 图片附件同构验证清单

每个实现 guard 必须在测试名或验证表中注明来源。第一版允许的类别是：

| 检查 | 来源 | 第一版行为 |
| --- | --- | --- |
| canonical base64 | DSH image admission | 非 canonical 或无法完整解码时拒绝。 |
| batch count 与 aggregate encoded bytes | DSH image store | 整批预检，任一失败时不发布任何 ref。 |
| MIME allowlist | DSH image store | 第一版只接受 `audio/wav`；别名是否支持由实际 browser/provider fixture 决定。 |
| declared MIME 与实际容器一致 | DSH image store | 检查 RIFF/WAVE 与必需 PCM chunks，不根据扩展名猜测。 |
| 单文件 encoded byte cap | DSH image store | 由 Schemastery Config 配置。 |
| content-addressed id | DSH local image store | SHA-256 覆盖被保存的规范字节；同字节得到同 id。 |
| persist-before-event | DSH image lifecycle | 对象成功持久化后才允许 `user/message` 引用。 |
| read hash、bytes 与最小 metadata | DSH image read | 缺失、损坏、替换或 ref 不一致时 fail closed。 |
| duration/sample metadata | WAV 正确解析与 UI/provider 描述 | 可记录为派生 metadata；对未压缩 PCM WAV 不默认作为安全 admission gate。 |

以下行为不得借“安全”名义悄悄加入：自动修复或重新编码、音频质量评分、响度/静音/削波拒绝、内容审查、BPM/调性验证，以及没有明确 provider 或资源模型依据的时长上限。

## 验收标准

- [x] `AudioBlock` 在 typecheck 后成为 DSH `ContentBlock` 与 `audio` modality 的合法成员。
- [x] 一个合成 WAV 从程序化输入，经 durable store 与真实 Session log，到生产 Gemini serializer 的最终 request；wire base64 与原始规范字节可核对。
- [x] 一个合成 WAV 从 fresh Subagent 经真实 DSH `PiAiAdapter`、pi-ai 与官方 OpenAI SDK 到 OpenRouter fake fetch；最终 `input_audio` 与原始规范字节可核对，Main sentinel 未进入 child wire。
- [x] 不支持 audio 的 provider route 在请求前 fail loud，不静默丢弃 audio block。
- [x] Session flush、Context 重建、retained-tail compaction 和 replay 后，active audio ref 与 bytes 保持一致；selected span 的历史音频由明确 text checkpoint policy 替换。
- [x] fresh continuable child 收到音频，Main 的历史不进入 child；resident/cold followup 复用 child 自己的上下文，interrupt 不把已经接纳的 FIFO 音频当作删除。
- [x] Web UI 能创建、删除、提交、显示和播放待发送音频附件；Remote 失败保留草稿，Host admission 失败不会发布用户消息。
- [x] 图片与音频的 composer 组合策略由 client module composition、Host transaction 测试和真实 DSH Web 手工附件验收共同证明。
- [x] 验证清单中的每个 guard 都有 DSH image 源码或音频/provider 必需性映射；没有额外音频质量拒绝或自动处理。
- [x] tarball 能被临时 external consumer 和真实 Loader 使用；测试 composition 在无真实 key、无 provider 网络条件下启动。
- [x] 完整 DSH Web profile 能安装 tarball、加载 bundle layer并启动 Host/browser composition。
- [x] 所有 adapter 测试只注入 fake fetch/capture；取消与 size failure 还断言 credential 和 transport 调用次数为零。
- [x] Gemini Files fake transport 证明相同 WAV 只上传一次，resident 与 cold-cache generation 都使用相同 provider URI且不包含 inline base64。

## 当前证据

- 已建立独立工作区并安装受控 General Doc Kit 子集；该文档系统已由 [0008](../decisions/0008-docs-layout-replaces-agent-notes.md) 取代。
- package 固定并实际安装 DSH `0.1.1-rc.2`、Cordis `4.0.1`、Schemastery `3.18.1` 与 pi-ai `0.82.1`；全量离线门禁记录见 [2026-08-31 验收](../research/2026-08-31-dsh-0.1.1-acceptance.md)。
- 合成 WAV 已完成 classic PCM 与 WAVE_FORMAT_EXTENSIBLE PCM 单元测试；read-only 检查的 22 份既有 DAW 导出 WAV 只出现三种第一版 parser 已接受的容器形态。
- 真实 DSH Session/AgentLoop/Subagent 离线组合已捕获 fresh child 与 cold followup 的 AudioBlock，并从 JSONL persistence 恢复两份 ref；parent-only sentinel 未进入 child request，child header 保留 parent lineage 但没有 parent seed，adapter 没有网络路径。
- Gemini Files/final-wire、SSE 逻辑块、OpenRouter final-wire、两条真实 Subagent→provider fake-transport 单链路、route guard、resident interrupt、compaction、Loader 与 packed consumer 均已完成；[rc.2 Session 合同](../research/2026-08-29-rc2-audio-session-contract.md)与 [OpenAI-compatible 复用审计](../research/2026-08-30-openai-compatible-audio-reuse.md)划分相应证据。
- [Web 扩展面审计](../research/2026-08-30-dsh-web-audio-extension-seam.md) 记录 stock submission contributor 缺失以及 compatibility face 的 public seam。临时 profile 从 pack tarball 启动 DSH Web；第一段浏览器附件被 Gemini 正确识别为 `violet`、`27`、三个纯音，第二段经可见 `read_audio` tool call 被正确识别为 `red panda`、`94 BPM`、`cello`。

## 风险

- Stock Pi 与 DeepSeek route 仍会静默跳过未知 AudioBlock；全局 route guard 只放行显式注册的音频 route。OpenRouter face 先把 AudioBlock 物化为一次性 marker，再使用 pi-ai 的公开 `onPayload` 生成逐 occurrence `input_audio` receipt，不改变 stock route 的能力声明。
- Stock compaction 会用 text checkpoint 替换 selected span；只有 retained tail 可在不扩展 compaction policy 的情况下保证继续携带 audio ref。
- Web compatibility face 的 pending presentation 与 Host transaction 已验证，但 stock history renderer 仍把 AudioBlock 显示为 generic extra block。
- rc.2 `CommandClaim.submit()` 不传递输入手势的 queue/steer mode；插件按 Agent 状态选择空闲 `followup` 或运行中 `steer`，不宣称逐手势等价。
- DSH 发布版、GitHub Pages 与 master 存在版本漂移；升级观察结论不能覆盖已验证发布基线。
