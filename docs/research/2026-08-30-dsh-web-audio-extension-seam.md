# 2026-08-30：DSH Web 原生音频扩展面审计

## 结论

原生音频不是“Cordis 插件完全做不到”。分层结论如下：

| 层级 | 普通 Cordis 插件是否足够 | 当前证据 |
| --- | --- | --- |
| ContentBlock、modality、durable store | 是 | declaration merge、Cordis service、WAV store 已实现并通过测试。 |
| Session、AgentLoop、stable Subagent、persistence、compaction retained tail | 是 | DSH `0.1.1-rc.2` 真实运行时合同测试已通过。 |
| Provider 原生音频请求 | 是，但每个 provider 必须有自己的 adapter | Gemini adapter 已把 WAV 序列化为 `inlineData`，stock Pi/DeepSeek 路由由全局 guard 拒绝。 |
| Web compatibility face | 是，但有 rc.2 差异 | 公开 client module、single-slot priority、hidden `CommandClaim` 和 Typert Remote 足以复用 Enter、图片、失败保留及 Agent 投递。 |
| 与 stock 图片逐手势同构的 queue/steer、乐观回显、刷新恢复与历史渲染 | 当前不够 | rc.2 与 `0.1.2-alpha.1` 快照的 prompt、draft、submission 和 attachment owner 仍闭合为 text/image。 |

因此，当前可发布边界是 **Host 核心插件、provider 插件和明确标注差异的 Web compatibility face**。Web face 不复制整个 composer 和 prompt controller；它复用 stock InputMachine 能公开提供的部分，并把逐手势 busy-mode、刷新恢复和 durable history player 保留为已知限制。更通用的 attachment/submission 扩展面可以在未来替换这些限制，但不是独立插件交付的前置条件。

## 固定版本

- 已运行验证：DSH tag [`dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)，commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。
- 升级观察：DSH `master` commit [`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/deepseek-ai/deepseek-harness/tree/cd5ef8148158c3a752a658978873241fdf8e2bbc)，仓库版本 `0.1.2-alpha.1`。

第二个版本只用于确认公开 seam 是否已经变化，不构成当前 package 的兼容声明。

## Stock 提交事务实际拥有的职责

Web 音频问题不只是“能否上传一个文件”。Stock 提交路径同时拥有以下状态和策略：

```text
输入草稿：text + image draft ids
  → 创建一次 submission / command attempt
  → 解析当前顶层 Agent，并拒绝绕过 Subagent 所有权
  → 判断 route 是否已服务、模型是否支持图片
  → 把 browser image ids admission 成 durable ImageBlock
  → 记录 rpc / timezone 等 source
  → 根据 Agent 状态选择直接 turn、queue、followup 或 steer
  → 投影 pending message，失败时恢复草稿
  → 历史消息用 image owner 读取和渲染 durable 附件
```

一个音频 client 若绕过这条事务，需要重新实现并持续跟随上面每一项，而不仅是调用一次 HTTP/RPC。

## rc.2 源码证据

### Host prompt 是 text/image 闭合集合

- [`packages/host/apiproxy/src/api/sessions.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/host/apiproxy/src/api/sessions.ts#L91) 将 `PromptContentPart` 定义为 text 或 image。
- [`packages/host/apiproxy/src/api-proxy.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/host/apiproxy/src/api-proxy.ts#L129) 的 `durablePromptContent()` 只把这两种 wire part 映射成模型内容。
- 同一文件的 `session.prompt` 路径在 [`hasImage` 与 route capability 判断](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/host/apiproxy/src/api-proxy.ts#L2382)、durable admission 和 Agent 投递之间维持一个完整事务。公开 API 没有可以追加第三种 part admission 的 registry。

`ContentBlockMap` 的 declaration merge 发生在这条边界之后。它能让 Session 和 AgentLoop 持有 `AudioBlock`，但不会反向扩展 browser prompt wire 或 Host admission。

### Composer 的状态和附件 owner 是 image-specific

- [`InputActions`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/src/client/input/contract.ts#L73) 暴露 `addImages()`、`removeImage()` 与 `pruneImages()`，没有通用 attachment contributor。
- [`conversation.input.attachments`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/src/client/contract/slots.ts#L247) 是 `single` slot。它接收的 owner 数据仍是 image draft，而不是可合并的附件集合。
- [`conversation.composer`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/src/client/contract/slots.ts#L171) 是 chain，但它的语义是审批或问题等待时替换完整 composer，不是向默认 Enter 提交事务贡献一个新的 content part。
- 官方 [`ui-attachment` 说明](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-attachment/README.zh.md) 明确把该包描述为图片草稿栏、拖放、历史图片 gallery 和 lightbox 的纯呈现插件；它不是通用文件协议。

### Custom Remote 解决寻址，不解决提交一致性

rc.2 的 `@deepseek-ai/dsh-api-remotes` 可以配置 Typert 的 Agent lookup。它能够可靠地寻址顶层 Agent、恢复冷 Session，并保留“Subagent child 只能经 Subagent 路由交付”的所有权边界。因此，自定义 Remote 可以把程序化 `ContentBlock[]` 送给顶层 Agent。

但它不会自动获得 stock `session.prompt` 的 route 检查、图片 admission 串行化、source 元数据、queue/steer 选择、乐观消息和失败恢复。Compatibility face 因此不单独监听键盘，而是先用 hidden `CommandClaim` 进入 stock InputMachine；Remote 只完成图片/音频 durable admission 和 Agent delivery，不重建完整 prompt controller。

## 最新 master 快照仍未开放该 seam

最新观察快照把 Host 逻辑重组到 `packages/api/session-controller`，但合同没有变成通用附件协议：

- [`PromptContentPart`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/session-controller/src/types.ts#L71) 仍只有 text/image。
- [`prompt` command](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/session-controller/src/commands.ts#L283) 仍以 `hasImage` 和 image admission 组织 stock 提交；[`durablePromptContent`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/session-controller/src/commands.ts#L514) 仍只映射 text/image。
- 新增的 [`BeginSubmissionInput`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/session-controller/src/client/contract/session.ts#L30) 和 `beginSubmission()` 提供乐观本地回显，但输入仍是 text 加 images；它不是可注册的媒体贡献者。
- [`InputActions`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-conversation/src/client/contract/input.ts#L221) 仍只有 `addImages/removeImage/pruneImages`，`conversation.input.attachments` 仍是 image-specific single slot。
- Agent lookup 已移到 [`packages/api/session-controller/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/session-controller/src/agent.ts#L146)，仍保留冷恢复与 Subagent 所有权 fence。
- Stock Pi replay 对 `audio` 仍按 unknown block 处理，见 [`llm-pi-ai/tests/convert.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/tests/convert.spec.ts#L620)。因此即使 Web 能产生 AudioBlock，也不能把它送入 Pi/DeepSeek stock route。

## 为什么不采用几个看似简单的方案

### 在另一个 list slot 放音频草稿

这可以显示音频并维护自己的 browser state，但 Enter 只提交 stock text/image。音频插件必须监听同一键盘动作、单独 admission 和单独投递，无法与 stock submission 形成原子事务；其中一半失败时会出现重复消息或孤立附件。

### 只注册自定义 Remote 并直接 prompt

这适合程序化 API 和诊断工具，不足以单独伪装成 stock composer。已实现方案把 Remote 限制在 Host admission 和 Agent delivery，并由 InputMachine claim 保留 Enter、图片和失败恢复；它仍不能读取用户手势的 queue/steer mode。

### 接管整个 `conversation.composer` chain

公开 slot 确实允许这样做，因此“绝对无法用普通插件实现 UI”并不准确。问题是接管者必须重建 stock InputBar、图片附件、命令、审批、权限、键盘、锁定状态、queue/interrupt 与可访问性行为。它与 DSH shell 版本紧耦合，也会和其他 composer takeover 竞争。对一个准备开源的通用音频插件，这不是可维护的第一版。

### Monkey-patch 私有 store 或 submit 函数

这既不受公开 Cordis effect 生命周期保护，也无法建立跨版本类型合同。即使局部演示能运行，也不能声称普通插件兼容。

## 建议的最小上游 seam

以下名称是提案，不是当前 DSH API：

1. **可 declaration merge 的 browser content map。** 用 `PromptContentPartMap` 生成 `PromptContentPart`，避免 wire 类型永久闭合为 text/image。
2. **Host admission registry。** `PromptContentAdmitter` 根据 part type 完成 route modality 判断、durable block 映射和 admission serialization；stock `session.prompt` 仍是唯一事务 owner。
3. **Composer draft contributor。** 每个媒体插件只拥有自己的草稿状态，并向一次 stock `beginSubmission` 贡献 parts、乐观回显和失败恢复钩子；Enter、queue 与 steer 仍由 stock controller 决定。
4. **通用 pending/historical renderer。** 以 content type 为 key 的 list/registry 渲染附件摘要、播放器和 authorized durable read，不再只有 `message.images`。
5. **保持 Subagent fence。** 顶层 prompt 继续走 Agent lookup；child audio 继续由 Host 领域 tool 经 stable Subagent `ContentBlock[]` 投递，不开放 browser 绕过 child 所有权。

该改动不要求把 DSH 改成“任意文件都自动支持”。各媒体插件仍负责自己的 schema、admission、store、provider serializer 与 UI；DSH 只提供一次提交事务中的扩展席位。

## 发布与验收边界

package 发布 store、provider、`read_audio`、Web Host service 和 `/client`。Web face 承诺 WAV 粘贴/拖放、待发送播放/暂停与删除、text/image/audio 同次 Host transaction、Remote 失败保留草稿，以及空闲 `followup`/运行中 `steer`。它不承诺输入手势选择的 queue/steer mode、刷新恢复未提交 WAV 或 durable history player。

若上游 seam 落地，替换 compatibility face 的验收还需覆盖：逐手势 busy mode、刷新后从 durable ref 播放、通用历史 renderer、图片插件共存、审批 composer takeover、键盘与无障碍行为，以及不支持 audio route 时 transport 调用次数为零。

本次审计和仓库全部自动化都没有使用真实 API key，也没有向 Gemini 或其他模型 endpoint 发起请求。

## 2026-08-31 后续验证：rc.2 compatibility bridge

后续源码检查补充了两个不改变上述长期结论、但能交付受限 Web 路径的公开机制。

1. `@deepseek-ai/dsh-client-ui-slots` 允许 single slot 的同一 cell 在不同 priority 共存，最低的 live entry 渲染。音频插件因此可以只 shadow `conversation.input.attachments` 的 presentation，同时保留官方图片 entry 作为备用，不需要接管 composer。
2. `@deepseek-ai/dsh-client-ui-input-trigger` 的 `CommandClaim` 可以使用无可见 token，并由 scoped `slash/input-begin-command` 进入官方 InputMachine。Enter、图片序列化、成功清理和失败保留仍由 stock machine 拥有；claim 只把缺少的音频字节交给 Typert Remote。

这条 bridge 比“监听键盘后另发一条 prompt”或“复制 InputBar”更小，但仍有两个明确限制：`CommandClaim.submit()` 不收到 queue/steer mode，所以 Host 按 Agent 当前状态选择空闲 `followup()` 或运行中 `steer()`，不能逐手势复制 stock busy-mode；rc.2 也没有按 ContentBlock type 注册历史 renderer 的公开席位，因此未知 AudioBlock 在历史 user bubble 中仍是 generic extra block。这些限制保留在 Task 和 consumer 文档中；本项目不修改上游来消除它们。
