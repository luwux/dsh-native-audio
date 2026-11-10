# 当前架构

本文是地图：插件由哪些子系统组成、跨子系统的流程，以及每个子系统的 [spec](specs/README.md)。子系统细节在各自的 spec 中，选择的理由在 [decisions](decisions/)。

## 仓库角色

`dsh-native-audio` 是独立的 DSH 第三方插件工作区，与两个外部仓库形成单向依赖：

```text
DeepSeek Harness 已验证发布基线
  └─ 提供 Cordis、LLM、Session、Subagent、文件附件与 agent/pre-step 接口
      └─ dsh-native-audio
          └─ 提供通用原生音频能力
              └─ 下游 bundle 等消费方
```

本仓库不修改 DSH 上游，也不包含下游 bundle 的业务逻辑。已验证的 DSH 版本与所依赖的上游源码见 [上游契约](upstream-contract.md)。

## 子系统

- [音频附件与 route guard](specs/audio-attachments.md)：package 默认入口。`AudioBlock` 与 `audio` modality 声明、`audioAttachments` service、内容寻址的本地 WAV store，以及在 transport 前拒绝未注册音频 route 的全局 guard。
- [Gemini 音频 route](specs/gemini-provider.md)：`google-gemini-audio`，直接实现 Gemini GenerateContent，默认用 Files API 引用复用音频，也接收图片。
- [OpenAI-compatible 音频 route](specs/openai-compatible-provider.md)：给 stock `llm-pi-ai` route 加一个音频开关。薄 bridge 安装在 DSH `PiAiAdapter` 实例上生成 Chat Completions `input_audio`，tool result 音频按 route 设置放进 tool 消息或其后的 user 消息；Web client module 把开关放到 Models 页卡片上。
- [`read_audio` 工具](specs/read-audio-tool.md)：把本地音频文件转成 PCM WAV 存为 durable attachment，在 tool result 消息中返回 AudioBlock。
- [音频文件附件转换](specs/file-ingress.md)：全局 `agent/pre-step` listener，把 stock 文件附件中的音频补成 AudioBlock。
- [Package 与 bundle](specs/bundle.md)：导出、构建、发布文件和按顺序插入五个 entry 的 `cordis.patch.yml`。

## 音频流

```text
程序化 base64 或 Uint8Array 输入            DSH Web stock 文件附件（.wav）
  │                                          → FileBlock 进入 user/message
  │                                          → file-ingress（agent/pre-step）
  │                                             读取文件字节，追加 AudioBlock
  │                                        read_audio 工具读取本地音频
  → admitEncodedAudios / audioAttachments.saveAudios
  → LocalAudioAttachmentStore（WAV 解析、SHA-256 内容寻址、只读对象）
  → AudioAttachmentRef → AudioBlock
  → stock user/message，或 read_audio 的 tool result 消息
  → DSH Session / AgentLoop / continuable Subagent / compaction retained tail
  → 全局 audio route guard（llm/stream）
      ├─ 未注册音频的 route：在 adapter transport 前报 UNSUPPORTED_CONTENT
      ├─ google-gemini-audio → 读取并校验 WAV → Files API fileData 或 inlineData
      └─ 开了音频的 llm-pi-ai route
           → 私有 marker → DSH PiAiAdapter → pi-ai onPayload
           → input_audio（user content、tool 消息或 tool 消息之后插入的 user 消息）
```

Session log 只持久化 JSON-safe 的 `AudioAttachmentRef`；WAV 字节在本地 store 中，provider adapter 在最终请求边界读取并校验。所有音频入口最终都汇入同一种 AudioBlock，因此 Web 输入、程序化输入和工具读取共用同一条 Session、provider 与 Subagent 路径。

Web 输入不需要自有 composer：DSH 0.2 的 stock composer 把音频文件当作文件附件上传，`file-ingress` 在 Agent 处理该消息前补上 AudioBlock，持久化的 `user/message` 同时含 FileBlock 与 AudioBlock。Package 发布的 client module 只负责 Models 页卡片上的音频开关和 Gemini key 输入。

## 已验证的 Session 与 Subagent 生命周期

```text
fresh child start(AudioBlock A)
  → child 独立 context，不继承 Main message history
  → resident sendMessage(AudioBlock B)
  → interrupt 当前 turn，但不删除已经接纳的 FIFO work
  → 下一次 waking sendMessage 恢复队列
  → child fiber disposal
  → JSONL cold reopen / sendMessage
  → A、B durable refs 与 WAV bytes 仍可解析

compaction
  ├─ selected span：由 text checkpoint 替换，其中的音频不再进入请求
  └─ retained tail：AudioBlock 经 flush、Context disposal 与 cold prepare 后保留
```

这些是 DSH `0.2.2-rc.1` 上由离线合同测试覆盖的行为（见 [测试政策](testing.md)），不自动适用于其他 DSH 版本。Compaction 只保证 retained tail 中的音频的理由见 [0001](decisions/0001-standalone-dsh-plugin.md)。
