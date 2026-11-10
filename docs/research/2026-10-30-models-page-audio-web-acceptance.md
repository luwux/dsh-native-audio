# 2026-10-30：Models 页接入音频 route 的 DSH Web 真实验收

宿主是 DSH `0.2.1-rc.5` Web，访问模式“工作区内修改”。用户授权了这次搬迁的真实验收。

## 全新 home 的配置流程

打包命令是 `pnpm pack`（它先跑 `pnpm run check`）。新建一个空 `DSH_HOME`，启动环境里没有 `GEMINI_API_KEY` 与 `OPENROUTER_API_KEY`：

```bash
dsh plugin --profile web add file:<tgz>
dsh --profile web --port 3301 --no-open
```

只这一条安装命令，Web 就正常启动，模型菜单出现 Gemini 3.8 Flash，Models 页的 Gemini 卡片有 API key 输入。这一轮没有发模型请求，只核对界面和写入的配置：

| 操作 | 结果 |
| --- | --- |
| “添加模型提供商”→“自定义模型 API”，填 ID、名称、`http://127.0.0.1:7777/v1`，key 留空；添加模型，填上下文窗口，勾 `图片`；“创建提供商” | `llm-pi-ai.providers.local-qwen` 写入 `api: openai-completions`、`input: [text, image]`；卡片出现“原生音频输入” |
| 点开关 | `native-audio-routes.routes.local-qwen.toolResultAudio: user-message`，出现“工具返回的音频”两档 |
| “第三方模型提供商”选 `openrouter`，展开“自定义设置”，添加模型后保存 | 草稿卡片已有开关；`llm-pi-ai.providers.openrouter` 写入 |
| “编辑 openrouter”，勾 `图片`，保存，再点开关 | `input` 变成 `[text, image]`，`routes` 增加 `openrouter` |

上一轮测试中 OpenRouter 模型只存下 `input: [text]`，原因已查明：目录 provider 新增模型时 `图片` 默认已勾，脚本多点一次把它取消了。这不是产品问题。

## 真实请求

答案表都在 DSH workspace 之外。音频是真实录音，图片是脚本随机生成的。

| Route 与模型 | 用例 | 工具 | 结果 | 对照 |
| --- | --- | --- | --- | --- |
| `local-qwen-omni`（UI 创建，无 key，经本地 llama-server），`qwen3-omni-30b-a3b-instruct-bf16` | `read_audio` `045.wav` | `read_audio` | 听出男声和女声 | 相符 |
| 同上 | 输入框上传 `046.wav` | 无（`[file, audio]`） | 听到门响和碰撞声 | 部分相符，听到了事件，声源判断错误 |
| 同上 | 工作区图片与 `047.wav` | `read_image`、`read_audio` | 字母 HXARCV、橙色、4 个圆，听出语音 | 图片全对，音频相符 |
| `openrouter`（目录 provider，`tool-message`），`qwen/qwen3.8-omni-flash` | `read_audio` `048.wav` | `read_audio` | 持续低频机械嗡声和微弱节奏性咔哒声 | 相符 |
| 同上，`input` 含 `image`，最终 tarball | 工作区图片与 `049.wav` | `read_image`、`read_audio` | 字母 QEMSXE、绿色、4 个圆；先有上膛声，再有约九次枪声般的巨响 | 图片全对；音频部分相符，事件类型相符，次数不对 |

`input` 不含 `image` 的 OpenRouter 模型调用 `read_image` 时，工具返回错误“does not declare image input support”，同一步的 `read_audio` 正常。

## 局限

- 前四行请求用的是搬迁过程中的 tarball；之后只改了 route guard 错误文字、构建前清理 `lib/` 和类型声明，没有重跑本地模型。
- 没有抓取 wire 请求，wire 形状由离线测试覆盖。
- 每个用例只跑一次，不代表模型听音能力的统计结论。
- 没有在 Web 里实测关掉开关后的报错，它由 [`pi-ai-audio-route.spec.ts`](../../tests/pi-ai-audio-route.spec.ts) 覆盖。
- 全新 home 的流程没有发真实模型请求。
