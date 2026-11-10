# 0004: Gemini 默认用 Files API 引用复用音频

- Status: Accepted
- Date: 2026-09-04

## Context

AudioBlock 持久保留在 Agent history 中。Gemini inline transport 在每次请求中重新编码并发送完整 WAV：会话语义稳定，但网络负载、request body 和重复字节随历史音频累积，并受最终 JSON body 大小限制。把听过的音频从 history 删除又会破坏 Main 的自然多模态上下文。

## Decision

`google-gemini-audio` 默认使用 Gemini Files API，history 中用 `fileData` 引用音频。Provider file name 由凭据 SHA-256 的短命名空间与内容 SHA-256 共同派生，合法、稳定、按凭据分区；同一 plugin 实例共享一个文件 cache，冷缓存先按稳定 name 查 metadata，缺失时才上传。本地 durable attachment 仍是事实来源：Google 的临时文件到期后从它重新上传。机制细节见 [Gemini spec](../specs/gemini-provider.md#音频-transport)。

每个 AudioBlock occurrence 仍产生独立 receipt。`audioTransport: inline` 保留为显式选项；直接构造 adapter 时默认仍是 inline，不改变低层调用者既有的测试和集成语义。

Google 对当前凭据空间中不存在的 caller-supplied name 返回 403（实际观察到的行为），所以 metadata GET 的 403 与 404 都进入 upload；无效凭据由 upload start 报为鉴权失败。

## Alternatives

**每轮都用 inlineData。** 实现最少，但持续 history 会重复传输全部音频字节，并受最终 JSON body 大小限制。

**听完后从 Session history 删除 AudioBlock。** 减少后续负载，但模型失去已听音频的自然上下文，也破坏 append-only conversation 与缓存前缀。

**只保存随机 provider file name。** 跨进程复用需要新增本地 provider 映射的持久化；凭据分区的内容派生 name 通过 metadata lookup 就能找回同一资源，并避免换 key 后碰撞到旧凭据拥有的私有文件。

## Consequences

Agent history 可以保留已听音频，资源有效期内不重复上传 WAV。每次模型请求仍引用这些音频，provider 仍按输入计价；Files API 解决的是字节传输和 request body，不免除音频 token 成本。

稳定 name 暴露内容与凭据的两个截断 hash，不含本机路径、文件名或 key 字面值。Name 与内存 cache 都按凭据分区，防止不同 Google project 误复用或碰撞同一资源。

实测证据见 [2026-09-04 Web 验收](../research/2026-09-04-gemini-files-and-streaming-web-acceptance.md)。
