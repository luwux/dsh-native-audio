# 0001: 原生音频作为独立 DSH 插件

- Status: Accepted
- Date: 2026-08-29

## Context

DSH 把 `ContentBlockMap` 与 `ModelModalityMap` 设计成可扩展类型，但 stock 附件、Host prompt、Conversation UI、route preparation、Pi adapter 和 DeepSeek adapter 只完成 text/image 路径。只加一个 TypeScript `AudioBlock` 声明、一个上传按钮或一个返回转录文本的工具，都不能让原生音频模型在实际请求中收到音频，也不能保证 Session replay 和 Subagent context 隔离。

下游 bundle 需要让音频进入用户面对的 Main 或独立 child，同时复用 DSH 的 AgentLoop、steer、streaming、Session、Subagent 和 Web UI。若把通用音频能力和 DAW 业务写在同一个包里，其他 DSH consumer 无法复用，音频 provider 兼容也会和 DAW 生命周期耦合。

## Decision

`dsh-native-audio` 是独立仓库和可安装的 DSH bundle，由多个普通 Cordis plugin face 和一份 profile patch 组成（见 [bundle](../specs/bundle.md)）。DSH 上游 checkout 只作为固定版本的依赖、源码参考和真实 Loader 测试宿主；本项目不维护 DSH fork，也不通过私有字段 monkey-patch。

AudioBlock 经已有的 `user/message` 事件进入 Session，Session log 只保存 durable `AudioAttachmentRef`；原始字节在内容寻址 store 中，provider adapter 在请求边界解析 ref。这样 cold replay 和 child Session 能重建模型可见输入，stock persistence 不需要认识新的仓外 event 类型。

Stock compaction 用 text checkpoint 替换 selected span，所以插件只保证 retained tail 中的 AudioBlock 经 compaction 与 replay 后仍可解析。需要继续试听的音频要留在 selection 之外，或由 consumer 重新注入。若产品要求被压缩 span 内的音频仍然可听，先设计 audio-aware checkpoint 与 token 计价，不依赖开放类型绕过 stock 假设。

通用 API 接受 `ContentBlock[]`，同一个 AudioBlock 可以留在 Main 的自然 history，也可以由 consumer 交给 Subagent `startContinuable()` 或 `sendMessage()`。本仓库不注册、命名或强制任何领域 Agent 工作流。

## Alternatives

**Fork DeepSeek Harness。** 能立刻获得全部内部类型和 UI 入口，但要长期跟随 alpha 主线、承担整个 Harness 的 merge 与发布成本，也放弃了验证普通插件是否足够这一目标。只有公开 seam 经最小复现证明缺失、且上游不接受必要扩展时才重新考虑。

**把音频直接实现进下游 bundle。** 接入一个领域 Agent 更快，但 provider、多模态附件、Web UI 和 Session replay 会与 DAW 业务耦合，无法独立发布或测试，第二个 consumer 必须复制这套基础设施。

**只提供 `listen_audio` 工具。** 工具可以返回转录或分析结果，但原生音频模型不会在自己的请求中收到音频，调用 Agent 也不能在自己的 context 中直接听。

**把音频伪装成通用文件或图片附件。** 图片 store 和 route projection 是 image-specific 的，复用错误的媒体类型会让 adapter、UI、限制和 normalization 语义混乱。复用的是生命周期原则，不是媒体类型。

**依赖 Experimental Agent Teams。** Teams 的 mailbox、task 和 CAS 值得参考，但它是 package-private、不在正式 release 中且没有稳定承诺。插件使用 stable Subagent seam；可靠 mailbox 留给 consumer 层另行决定。

## Consequences

插件保留 DSH 升级边界并与下游 consumer 解耦，代价是每次 DSH 升级都要重跑兼容测试；DSH 0.2 迁移就改动了消息结构、配置机制和 Web 输入路径（见 [0007](0007-wav-file-attachment-ingress.md)）。

DSH `master`、GitHub Pages 和发布包处于不同快照，package 因此固定一个已验证的发布基线（见 [上游契约](../upstream-contract.md)），升级作为新的兼容性验收。Provider-specific 的音频 wire 与限制留在各 adapter；未经审计的 stock route 遇到音频时明确失败。
