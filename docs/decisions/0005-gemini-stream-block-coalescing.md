# 0005: 在 Gemini adapter 中合并跨 SSE event 的文本块

- Status: Accepted
- Date: 2026-09-04

## Context

Gemini SSE 常把一个 Markdown 段落、表格行或内联标记拆进多个 event。Adapter 若把每个 event 翻译成独立的 Harness text block，Session 和前端会在 provider 没有输出换行的位置形成块边界，Markdown 表格、单词和强调随机断开。

## Decision

Adapter 在一个响应内保留一个 pending text 或 reasoning block，把下一个 event 中 metadata 兼容的首个同类 part 作为 continuation；类型改变、同一 event 出现新 part、tool call 或流结束时关闭 block。Replay metadata 记录合并后的逻辑 block 顺序，实时渲染与同 provider replay 使用同一分段。见 [Gemini spec](../specs/gemini-provider.md#响应流)。

合并只针对 transport delta，不改写模型主动输出的内容；consumer persona 仍应要求 GUI 可呈现的标准 Markdown。

## Alternatives

**在 Web UI 中拼接相邻块。** 只修正一个 renderer；durable Session、其他客户端和 provider replay 仍保留错误分段。

**合并所有相邻文本，忽略 part 边界。** 可能吞掉 provider 在同一 event 中明确给出的多 part 结构，或跨越 tool call；因此只把跨 event 的兼容首 part 视为 continuation。

## Consequences

前端不需要 Gemini 专用后处理就能正确增量显示 Markdown。Adapter 为每个响应保留一个 pending 字符串，直到出现真实的 part 边界或响应结束。
