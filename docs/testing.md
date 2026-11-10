# 测试政策

本项目的自动化验收证明真实 DSH 执行链能把音频内容送到 provider adapter，同时不向任何真实模型或 provider API 发请求。用户明确授权的最小手工 provider 验收是独立证据层，不进入默认测试命令。

## 不可违反的边界

- 单元、集成、Loader、pack、demo、fixture 和发布前检查不得依赖真实 API key，不得发起真实模型请求。
- 真实 provider 浏览器验收必须由用户对具体任务明确授权；只使用最少请求，key 只经既有 launch environment 进入 Host，不写入仓库、命令输出、浏览器内容、日志或 fixture。
- fake adapter 必须在 DSH `LlmAdapter.stream()` 的最终 adapter 边界捕获深冻结后的实际请求；在更早的 helper 中断言对象不算端到端证明。
- 不得把 transcript、路径、工具输出、图片或 UI 预览冒充 audio-native provider payload。
- 音频 fixture 使用仓库生成或许可明确的短 WAV；不提交用户录音、私有 DAW 工程或 secrets。

## 测试层级

1. **纯函数与类型测试**：WAV 容器识别、canonical base64、内容寻址、引用校验、provider request serialization、错误码和 declaration merging。
2. **Store 测试**：批量全有或全无、persist-before-event、immutable ref、缺失/损坏对象 read failure、字节一致性和取消。
3. **真实 Session 测试**：使用 stock `user/message` 与 `ContentBlock[]`，验证 append、derive、flush、cold replay 和 resumed request；compaction 分别覆盖 retained tail 与被 checkpoint 替换的 selected span。
4. **真实 Subagent 测试**：通过 DSH Subagent 创建独立 child Session，用 `ContentBlock[]` start/sendMessage 把音频交给 child，并让 child 通过真实 ToolRuntime 调用 `read_audio`；验证 Main history 不被 fork 进 child，且 fake adapter 捕获 child 的音频。真实轨迹重放把一段真实 DSH Web Session 的音频相关骨架作为 fixture，经 stock Subagent 工具在真实 Agent、Subagent、ToolRuntime 与 Chat Completions route 上重放，fake fetch 按 fixture 回答。
5. **真实 Loader 组合测试**：从 build/pack 后的 package 和真实 `cordis.patch.yml` 启动 Cordis Loader，验证 base、Gemini、`native-audio-routes`、`read_audio` 与 `file-ingress` entry、bundle 之外的 stock `llm-pi-ai` entry 开启音频后的 modality、service/provider 注册、volatile Config 更新和 effect disposal。手工 `ctx.plugin(...)` 单元测试不能替代这一层。
6. **Web 输入测试**：真实 AgentLoop 中，含 `.wav` FileBlock 的 user 消息经 `file-ingress` 后在持久化 `user/message` 和请求中带有 AudioBlock，非 WAV 与无效 WAV 保持普通文件；主 Agent 与 Subagent 都要覆盖。Stock composer 的上传与展示由 DSH 自身测试负责。
7. **发布产物测试**：先从 `pnpm pack` 的 tarball 解包为外部 consumer，核对 archive allowlist、runtime exports 和 declaration typecheck，再把 tarball 安装进含完整 DSH CLI 的临时 profile并启动 Web composition。
8. **授权手工 provider 验收**：使用两份内容不同且文件名不泄露答案的 WAV；第一份由浏览器附件提交，第二份只给路径并要求 Agent 调用 `read_audio`。人工核对工具行、转录和问题答案，不能用文件名或预置 transcript 冒充模型听取结果。

## 附件验证预算

每项 admission/read 校验必须出现在验证清单中，并归入以下一类：

- DSH 图片附件已有的同类不变量；
- WAV/已支持音频容器为了正确解析所必需的格式检查；
- 明确 provider 请求限制；
- 明确资源上限。

没有上述来源的音频质量、内容审查或推测性安全检查不得进入 admission。响度、静音、削波、BPM、调性和母带质量属于 consumer 业务测试，不属于本插件的入站有效性。

## 当前可执行检查

根据本次改动自行选择最少且必要的测试，避免冗余或重复测试；不需要测试的改动可以不测。产品功能的具体验收标准仍适用；只报告实际执行的命令和结果。

产品全量离线检查在仓库根目录执行：

```bash
pnpm run typecheck
pnpm run test
pnpm run build
git diff --check
```

只改文档时运行 `python3 scripts/verify_subsystem_pages.py` 与 `git diff --check`；前者检查 spec 索引、`Source:` 路径和根 `AGENTS.md` 中生成的路径表，不检查 spec 内容是否与代码相符。

`pnpm run test` 使用合成 WAV 和临时目录。真实 DSH 合同测试加载发布版 Cordis、Session、AgentLoop、JSONL persistence、Subagent、in-process spawn 与 compaction。Gemini、OpenRouter 与通用 OpenAI-compatible plugin 测试以及轨迹重放在发出请求前替换全局 fetch（轨迹重放在创建 Context 前），并只设置专用假 key 或使用无 credential 占位值；仓库没有读取真实 API key 或调用真实网络 transport。

当前测试已经证明：

- provider-neutral AudioBlock/store 和 image-parity admission/read；
- stock unsupported route 在 user 消息和 tool result 消息中的 audio 上 fail loud；
- Gemini final JSON wire、ordered receipts、Files API resumable upload、stable `fileData`、显式 inline 的 WAV byte-equivalent base64、tool replay、SSE 和取消/错误；
- Gemini system 消息映射（开头的 system 消息成为 `systemInstruction`，`options.system` 优先，之后的 system 消息成为 user 文本）、developer 消息拒绝与 offloaded 图片占位文本；
- Gemini 推理等级映射到 `thinkingConfig.thinkingLevel`、模型目录未声明的等级在发送前被拒绝、`includeThoughts` 开关与 `resolveModel().reasoning`；
- Gemini tool result 消息成为 `[functionResponse, 音频 part]` 的同一 user content，同一音频在 resident 与 cold-cache 请求中复用 provider resource；
- Gemini 跨 SSE event 的兼容 text/reasoning delta 合并为一个 durable Harness block；
- 同一条 fresh Subagent→AgentLoop→Gemini plugin→fake fetch 链中的 durable WAV materialization、Files transport、`systemInstruction` 与 Main-history isolation；Subagent 调用真实 `read_audio` 后，下一次 Gemini 请求在 `functionResponse` 之后携带 byte-equivalent 音频；
- OpenAI-compatible bridge 把 user 消息中的 AudioBlock 原位替换为 `input_audio`；tool result 音频在 `tool-message` 下进入 tool 消息，在缺省 `user-message` 下由 tool 消息中的占位文本与连续 tool 消息之后的一条带标签 user 消息承载（每个含音频的 call 按 tool 顺序只标一次，只替换 marker 所在文本，在合成 payload 中位于 pi-ai 图片 user 消息之前，缺少 `tool_call_id` 时报错，同一请求的 marker 被丢弃、全部消失或重复时报错）；assistant 消息中的音频在读取字节前被拒绝；tool、reasoning、usage 与 streaming 行为留给 DSH `PiAiAdapter` 和 pi-ai；
- 真实 `LlmRuntime` + `llm-pi-ai` + 音频 plugin（[`pi-ai-audio-route.spec.ts`](../tests/pi-ai-audio-route.spec.ts)）：放置方式取自 route 设置；不含音频的请求不经过 bridge；`[file, audio]` 经 runtime 投影后保持顺序；关掉音频或非 Chat Completions 的模型在 transport 前报 `UNSUPPORTED_CONTENT`；Models 页开关的 volatile 更新不重新挂载也不重新注册 route；后挂载的 `llm-pi-ai` 与后添加的 route 也被 bridge 接管；卸载恢复 stock adapter；
- Web client module（[`client-bundle.spec.ts`](../tests/client-bundle.spec.ts)）：lazy factory 格式、只用宿主 external、开关写入的 config 操作、slot 注册。它不证明界面渲染；
- 同一条 fresh Subagent→AgentLoop→stock `llm-pi-ai` OpenRouter route→bridge→pi-ai→官方 OpenAI SDK→fake fetch 链中的 byte-equivalent `input_audio` 与 Main-history isolation；Subagent 经 OpenRouter 调用 `read_audio` 后，下一次请求按模型的放置方式携带 byte-equivalent `input_audio`；
- `apiKeyEnv` 经 credentials service 或 launch environment 解析；没有 key 时 loopback 地址发送占位 Bearer 值，远程地址不发请求；
- 真实轨迹重放（[`trajectory-replay.contract.spec.ts`](../tests/trajectory-replay.contract.spec.ts)）：Main 调用 `read_audio`，再派生两个各自调用 `read_audio` 并 report 的 Subagent，分别经 OpenRouter `qwen/qwen3.8-omni-flash`（`tool-message`）、OpenRouter `google/gemini-3.7-flash`（`user-message`）与无 credential 的本地 route（`user-message`）运行；每个 Agent 在 `read_audio` 之前的请求不带音频，之后的每次请求都带一份 byte-equivalent `input_audio`，且每次请求的 messages 以前一次请求为不变前缀；child 不含 Main history，Main 收到两个 child 的 report 与结束通知，Session log 中的 tool result 保留 AudioBlock；
- fresh/cold/resident Subagent、`sendMessage` cold resume、interrupt FIFO、JSONL reopen；
- selected-span replacement 与 retained-tail cold compaction；
- `file-ingress` 在主 Agent 与 Subagent 的持久化 `user/message` 中把音频 FileBlock 补成 `[file, audio]`，消息 id 与 source 不变，请求中文件变为路径文本、音频字节不变；非 WAV 与无效 WAV 保持普通文件；
- `read_audio` 通过真实 ToolRuntime 返回 text + AudioBlock 的 tool result 消息；
- 非 PCM WAV 输入经本机 `ffmpeg` 转成 PCM WAV（[`audio-conversion.spec.ts`](../tests/audio-conversion.spec.ts)），机器上没有 `ffmpeg` 时这些用例跳过；缺少转换器的报错不依赖 `ffmpeg`；
- Gemini 与音频开关 plugin 的 volatile Config：Loader 更新后下一次 `listModels`、`resolveModelInfo` 与请求使用新值且不重新挂载，schema 无效的修改不生效；
- build/pack 后的五个 entry 与 bundle 之外的 stock `llm-pi-ai` entry 的真实 Loader composition，以及 packed external consumer。

DSH 0.2 合同测试与 DSH 自身的 Subagent 测试一样，用只实现点读的 `SessionQueryEngine` 子类代替 SQLite 检索后端；其余 Session、persistence、projection 与本地附件 store 都是发布包。

这些命令仍不证明浏览器渲染、真实 provider 可用性、真实 DAW 闭环或未来 DSH 版本兼容；相应证据必须单独记录，不能由离线测试推断。

## 已记录的门禁与手工验收

带日期的运行结果在 `docs/research/`：

- [2026-08-31 DSH 0.1.1-rc.2 全量离线门禁与授权浏览器验收](research/2026-08-31-dsh-0.1.1-acceptance.md)
- [2026-09-04 Gemini Files 复用与流式渲染的授权 Web 验收](research/2026-09-04-gemini-files-and-streaming-web-acceptance.md)
- [2026-10-08 DSH 0.2.0-rc.2 全量离线门禁与 profile 安装](research/2026-10-08-dsh-0.2-offline-gate.md)
- [2026-10-14 Chat Completions tool result 音频的授权 Web 验收](research/2026-10-14-chat-completions-web-acceptance.md)
- [2026-10-30 DSH 0.2.1-rc.5 的授权 Web 验收](research/2026-10-30-dsh-0.2.1-web-acceptance.md)
- [2026-10-30 Chat Completions route 图片输入的授权 Web 验收](research/2026-10-30-image-input-web-acceptance.md)
- [2026-10-30 音频格式转换的授权 Web 验收](research/2026-10-30-audio-format-web-acceptance.md)
- [2026-10-30 Models 页接入音频 route 的授权 Web 验收](research/2026-10-30-models-page-audio-web-acceptance.md)
