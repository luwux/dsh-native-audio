# 2026-10-30：Chat Completions route 图片输入的 DSH Web 真实验收

被测代码是本仓库 `0d61ef6` 打包后的 tgz，宿主是 DSH `0.2.1-rc.5` Web（`--profile web`，测试用 DSH home），访问模式“工作区内修改”。所有请求都由 Web 中的真实会话发出，用户在会话中授权了本地 llama-server 上的 Qwen3-Omni（上下文 65536）与 OpenRouter 请求。

## 测试设计

两张脚本随机生成的 640×360 PNG，上方是 6 个随机大写字母，下方是一排同色圆。文件名 `p1.png`、`p2.png` 不含内容信息，答案表保存在 DSH workspace 之外：`p1` 是 `LYDNYD`、green、6 个圆；`p2` 是 `AYSTVX`、blue、7 个圆。随机字母无法猜中，所以答对字母即说明模型看到了图片。混合用例的音频是真实录音 `041.wav`。

## 结果

| 模型与 route | 用例 | 工具调用 | 字母 | 颜色 | 圆数 | 音频 |
| --- | --- | --- | --- | --- | --- | --- |
| `qwen3-omni-30b-a3b-instruct-bf16`，`local-qwen-omni` | 输入框上传 `p1` | `read_image` 读附件 | 正确 | 正确 | 答 5，错 | 无 |
| 同上 | 工作区 `p2` 与 `041.wav` | `read_image`、`read_audio` | 正确 | 正确 | 答 6，错 | “door slamming shut”，相符 |
| `qwen/qwen3.8-omni-flash`，`openrouter-native-audio`（`tool-message`） | 工作区 `p2` 与 `041.wav` | `read_image`、`read_audio` | 正确 | 正确 | 正确 | 低频嗡声、两次重击、一次咔哒，相符 |

Web 输入框接受图片后显示缩略图与“移除图片”按钮。DSH 把上传的图片作为文件交给模型，模型用 `read_image` 读取，Session log 中的 tool result 是 text 与 image 两个 block，所以上传用例实际走的也是 tool result 图片路径。

## 观察

本地模型第一次收到混合用例时只回复“将要调用工具”就结束了本轮，没有调用工具；提示改为“now 调用”后两个工具都调用了。这一次没有发出任何图片或音频，不是 wire 问题。本地模型两次都数少了圆，字母与颜色都对。

## 局限

每个用例只跑一次。没有运行 `google/gemini-3.7-flash`（OpenRouter），其目录中的 `image` 声明未经真实请求证明；Gemini route 的图片与本次改动无关，本次未测。没有抓取 wire 请求，消息顺序由离线测试覆盖，本记录只证明模型能同时看到图片并听到音频。
