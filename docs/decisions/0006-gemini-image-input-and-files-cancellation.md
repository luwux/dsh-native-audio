# 0006: Gemini 接收图片输入，共享 Files 请求按调用者取消

- Status: Accepted
- Date: 2026-09-06

## Context

浏览器 composer 同时接收图片和音频，但 Gemini serializer 曾拒绝 ImageBlock，合法草稿无法发送。另一方面，相同音频的并发 Files 请求共享首个调用者的 signal，一个会话取消会破坏其他会话的请求。

## Decision

Gemini adapter 可注入 DSH AttachmentStore 的 `readImage`，把用户消息和 tool result 中 PNG、JPEG、WebP 的实际字节编码为 `inlineData`，图片与音频可以位于同一次请求。只有图片 reader 存在时，模型目录与 `resolveModel` 才声明 image modality；没有 reader 或遇到其他图片类型时明确失败，不做静默转换。格式依据 [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)。

Files cache 把共享传输与各调用者的等待分开：一个调用者取消只结束自己的等待；所有等待者退出后才取消共享传输并移除 pending 项。共享请求有独立的 60 秒期限；新调用不复用已因无人等待而取消的请求。已完成的对象仍按凭据、base URL、内容身份和有效期复用。行为见 [Gemini spec](../specs/gemini-provider.md)。

## Alternatives

**隐藏浏览器图片入口。** 会放弃 DSH 已有的图片 admission 和 Main 的多模态上下文；经现有 AttachmentStore 读取图片，让消息接收与模型能力一致。

**直接共享首个调用的 Promise 和 signal。** 生命周期代码更少，但跨会话的取消会互相影响；每个等待者独立退出是共享 cache 需要承担的行为。

## Consequences

图片计入最终 JSON 大小上限，Files 复用不缩小内联图片。图片 reader 负责本地引用与字节校验，adapter 不重复实现图片存储。取消不删除 provider 上可能已上传的对象，之后的冷查询可以复用它。离线回归用 fake fetch 证明请求构造与生命周期，不能替代真实 provider 接受或计费的证据。
