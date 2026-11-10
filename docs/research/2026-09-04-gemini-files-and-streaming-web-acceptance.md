# 2026-09-04 Gemini Files 复用与流式渲染的授权 Web 验收

测量对象：DSH `0.1.1-rc.2` Web 上的插件，Gemini route 已默认使用 Files API（[0004](../decisions/0004-gemini-files-audio-reuse.md)）并合并跨 SSE event 的文本块（[0005](../decisions/0005-gemini-stream-block-coalescing.md)）。当时的插件源码没有对应的 Git 提交。验收由用户授权，使用真实 Google Gemini。

## Files 复用

- 在 DSH Web 中手动提交第一份匿名 WAV，再让同一 Main 通过 `read_audio` 读取第二份匿名 WAV。
- Google Files 列表中只出现两个对应的 `ACTIVE` 对象，后续请求没有再次上传第一份。
- 模型第一次宽泛的配器描述过度识别出军鼓与踩镲；随后的定向比较回答纠正为第一段只有四踩底鼓，并正确识别第二段新增的反拍 open hi-hat。

这证明 transport 与同一 Agent 的历史音频可用，不能作为模型听觉质量的结论。

## 流式 Markdown 渲染

Gemini 3.8 Flash 在 DSH Web 中流式返回标题、列表和 Markdown 表格；浏览器没有再把 provider event 边界渲染成随机换行，也没有拆断表格。
