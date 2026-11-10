# 0002: 音频附件与 DSH 图片附件同构并保持 WAV 字节不变

- Status: Accepted
- Date: 2026-08-29

## Context

音频附件需要入站校验和 durable 存储。没有基线时，每个实现者都可能以“安全”为由加入推测性的防御检查，或在附件层顺手做重采样、归一化之类的音频处理；前者没有消费者或威胁模型支撑，后者会改变 consumer（如 DAW render）交来的字节。

## Decision

音频附件以 DSH 官方图片附件的实际代码为基线：canonical base64、整批数量与总字节、MIME allowlist、声明 MIME 与实际格式一致、单文件字节上限、persist-before-event、SHA-256 内容寻址、不可变 ref、原子持久化和读取时的摘要、长度与元数据核对。当前行为见 [音频附件 spec](../specs/audio-attachments.md)。

每项校验都必须映射到官方图片附件的同类检查，或属于以下之一：WAV 容器正确解析所需、明确的资源预算、provider 的硬限制。没有映射的检查不加入。逐项映射表在 [DSH-AUDIO-010](../tasks/2026-08-29-native-audio-v1.md#图片附件同构验证清单)。

第一版只接受一个可离线确定性验证的 integer PCM WAV 子集，并保持输入字节不变。图片 normalization 服务于像素、方向、色彩空间和 provider 投影，不能类推成自动音频 mastering：附件层不重采样、不改位深、不合并声道、不做响度归一化、降噪、裁剪、dither 或有损转码。时长是解析得到的元数据，可用于 UI 和 provider 说明；对未压缩 PCM WAV，字节上限已经约束资源规模，时长不作为安全拒绝条件。

## Alternatives

**额外的防御性检查。** 杀毒、版权判断、静音或削波拒绝、BPM 或调性验证、HMAC、多重 hash、数据库 ACL。没有消费者或威胁模型依据，只有形成新的威胁模型和 consumer 证据后才另行决定。

**在附件层自动处理音频。** 重采样、改位深、响度归一化或转码属于音频业务处理，应由 consumer 在 DAW/render 层决定生成什么音频；附件层改写字节会使入站字节、durable ref 与 provider payload 之间无法做等价证明。

**时长上限。** 没有明确的 provider 或资源模型依据；未压缩 PCM 的资源规模已由字节上限约束。

## Consequences

入站字节、durable ref、replay 后读取的字节和 adapter payload 之间可以逐字节核对。支持更多格式（尤其压缩格式）需要新的决定，并记录 provider 要求和解码资源预算。响度、静音、削波、BPM、调性和母带质量属于 consumer 的业务测试，不属于本插件的入站有效性。
