# Host consumer 接入指南

本文说明当前已经存在的程序化、Tool 和 DSH Web 接入面，兼容基线是 DSH `0.2.2-rc.1`。package 从 npm 安装到 profile，然后重启 DSH：

```bash
dsh plugin --profile web add dsh-native-audio
```

DSH 按 `engines.dsh` 判断兼容；运行的 DSH 版本不在其中时，安装会被拒绝。

## Bundle 组成

`cordis.patch.yml` 按顺序插入五个 entry：

```yaml
- insert:
    - id: native-audio
      name: 'dsh-native-audio'
    - id: llm-google-gemini-audio
      name: 'dsh-native-audio/gemini-plugin'
    - id: native-audio-routes
      name: 'dsh-native-audio/pi-ai-audio-plugin'
    - id: native-audio-read-tool
      name: 'dsh-native-audio/read-audio-tool'
    - id: native-audio-file-ingress
      name: 'dsh-native-audio/file-ingress'
```

第一个 entry 提供 `ctx.audioAttachments`；第二个注册 `google-gemini-audio` route；第三个保存哪些 `llm-pi-ai` route 开了音频，并在这些 route 上发送 `input_audio`；第四个注册 `read_audio`；第五个 inject DSH `attachments` 与 `audioAttachments`，把 WAV 文件附件转换为原生音频。Entry 的 id 同时是 DSH Settings 表单的命名空间；旧版 `settings.yaml` 中同名 section 会在 DSH 0.2 首次启动时导入对应 entry。真实 Loader 测试验证五个 entry 共同挂载、provider/store disposal 和重新挂载。Chat Completions 模型在 Models 页添加，见 [接入 Chat Completions 模型](#接入-chat-completions-模型)。package 同时发布 Web client module，给 Models 页的卡片加开关和 Gemini key 输入。

当前兼容合同固定为 DSH `0.2.2-rc.1`、Cordis `4.1.0` 和 Schemastery `3.19.0`。该结果不允许推断任意 DSH alpha 都兼容。

## 在 DSH Web 中附上音频

把音频文件拖入、粘贴或经“添加文件”选择到 stock composer。DSH 把它作为文件附件上传，附件栏显示 stock 文件卡片；发送后消息以 FileBlock 进入 Agent inbox。`file-ingress` 在该消息进入 step 时读取文件字节，存入 `audioAttachments`，并在 FileBlock 之后插入 AudioBlock。模型因此同时收到文件的只读路径文本和原生音频；路径可以交给 `read_audio` 或写进委托给 Subagent 的说明。

只有扩展名是音频（WAV、AIFF、MP3、FLAC、M4A、AAC、Ogg、Opus）、能成为 integer PCM WAV、且不超过 `maxAudioBytes`、`maxAudiosPerMessage` 与 `maxMessageAudioBytes` 的文件会得到 AudioBlock；非 PCM WAV 的格式需要系统安装 `ffmpeg`（或设置 store 的 `ffmpegPath`），转成 16-bit PCM WAV。其他文件保持普通文件，Host 日志记录一条 warn。会话中出现 AudioBlock 后，所选模型必须是音频 route，否则 route guard 在请求发出前报 `UNSUPPORTED_CONTENT`。

插件不提供待发送或历史消息中的音频播放器；Web 只显示 stock 文件卡片，AudioBlock 本身没有专用 renderer。

## 让 Agent 读取本地音频

`read_audio` 接受一个 `file_path`。相对路径基于 Agent Session `cwd`，绝对路径保持原样；接受与上传相同的音频格式。工具先按 store 的单文件上限检查文件，转成 PCM WAV 后交给同一个 `AudioAttachmentStore`，tool result 消息同时包含说明文本和 durable AudioBlock。主 Agent 和 Subagent 调用该工具的结果相同。

Gemini route 在下一次模型请求中把这条 tool result 消息物化为一个 user content：`functionResponse` 之后是有序 `fileData`；显式选择 inline transport 时才使用 `inlineData`。开了音频的 Chat Completions route 按卡片上“工具返回的音频”的设置放置音频：缺省的 `user-message` 让 tool 消息只保留文本，并在 tool 消息之后插入一条带 `Audio returned by tool call <id>:` 标签与 `input_audio` 的 user 消息；`tool-message` 把 `input_audio` 直接放进 tool 消息。细节见 [Bridge 行为](specs/openai-compatible-provider.md#bridge-行为)。工具没有播放、转录、重采样或内容分析逻辑，听取与回答由所选原生音频模型完成。

## 创建 durable AudioBlock

在已经声明 `audioAttachments` injection 的 Host plugin 中，先持久化字节，再把 ref 放入已知 DSH `ContentBlock[]`：

```ts
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const [ref] = await ctx.audioAttachments.saveAudios([{
  data: wavBytes,
  mediaType: 'audio/wav',
  name: 'review-round-03.wav',
}])

const prompt: ContentBlock[] = [
  { type: 'text', text: '只评价这次渲染，并引用可听见的证据。' },
  { type: 'audio', attachment: ref! },
]
```

`name` 只用于显示，不应传本机私有路径。Session 只持久化 `AudioAttachmentRef`；provider adapter 在最终请求边界通过 service 重新读取并校验 WAV bytes。

Store 只接受 `audio/wav` 的 integer PCM 子集，不会重采样、归一化、转录、改位深或修复文件；程序化调用其他格式时先用 `convertToPcmWav()`。Consumer 应在 DAW/render 层决定要生成什么音频，attachment 层只负责保持原字节。

## 交给当前 Agent 或独立 child

AudioBlock 可以直接留在用户面对的 audio-capable Main history；后续请求继续把它作为原生多模态上下文发送。需要把听觉上下文与其他工作隔离时，consumer 也可以通过 DSH Subagent API 投递同一个 `ContentBlock[]`。

下面只展示 child 调用关系；`parent`、spawn provider、agent route 和 source policy 由 consumer bundle 自己拥有：

```ts
const started = await ctx.subagents.startActivation({
  provider: 'spawn',
  delivery: 'parent',
  label: 'review render',
  request: { parent, prompt },
  signal,
})

await ctx.subagents.sendMessage(parent, started.childId, nextPrompt, { signal })
```

Fresh child 的 Session 保留 parent lineage，Main 历史不会自动复制进去。`sendMessage` 复用 child 自己的历史：child 空闲时开始新 turn，运行中时在最近的 step 边界接收，已卸载时从持久化 Session 冷恢复。Resident interrupt 中止当前 turn，但不删除已经接纳的 FIFO 消息，下一次 waking send 会恢复它。Consumer UI 应把“已中止当前推理”和“已撤销排队音频”显示成不同动作。

角色与工具策略由 consumer 决定。通用插件既不假设音频一定属于 child，也不假设 Main 必须是 text-only。

## 选择 Gemini 音频 route

Agent 的默认模型配置使用：

```text
provider = google-gemini-audio
model    = gemini-3.8-flash
```

默认 `apiKeyEnv` 是 credential reference `GEMINI_API_KEY`，不是 API key 值。Models 页的 Google Gemini Native Audio 卡片可以直接保存 key。其余字段都是 DSH 0.2 volatile Config，在 profile 的 `cordis.patch.yml` 的 entry `llm-google-gemini-audio` 中覆盖，新值在下一次 request generation 生效。Provider plugin 优先从 DSH credentials service 解析该 ref；没有 credentials service 时才读取 launch environment。缺少 credential 不影响 Loader composition，只在真正发起 request 时失败。

默认 generation endpoint 是 Gemini Developer API 的 legacy GenerateContent SSE 路径，默认音频 transport 是 `files`。首次遇到一份 WAV 时，plugin 通过 resumable Files API 上传原字节；同一 plugin 实例复用内存缓存，全新进程先按“凭据指纹命名空间 + 内容摘要”派生的稳定 name 获取 metadata。Google 对当前凭据空间中不存在的 caller-supplied name 返回 403，plugin 将 metadata GET 的 403/404 视为需要创建，并让 upload start 保留真正的鉴权失败。GenerateContent history 只包含 `fileData` URI，Google 临时资源到期后由本地 durable attachment 重新提供字节。Files API 引用不会消除 provider 对历史音频的输入计价。

模型目录项可以声明 `thinkingLevels`（`minimal`、`low`、`medium`、`high` 的子集，按显示顺序）和 `defaultThinkingLevel`。声明后 Web 的推理等级菜单显示这些选项，所选等级以 `generationConfig.thinkingConfig.thinkingLevel` 发送；未选择且没有 `defaultThinkingLevel` 时，请求不带等级，由 Gemini 使用服务端默认值。默认目录中的 `gemini-3.8-flash` 声明全部四个等级。`includeThoughts` 默认 `true`：请求 Gemini 思考摘要并显示为 reasoning block；设为 `false` 时只返回正文。

将 `audioTransport` 设为 `inline` 可恢复每个 occurrence 的 `inlineData`。`maxInlineRequestBytes` 在两种模式下都限制最终 JSON body；inline 模式还必须为 base64 音频留出空间。

## 接入 Chat Completions 模型

任何接受 Chat Completions `input_audio` 的 endpoint（本地 llama-server、vLLM、OpenRouter、中转站）都按普通 provider 接入，只多一个开关。在 Settings → 模型：

1. 点“添加模型提供商”。本地端口或中转站选“自定义模型 API”，填 Provider ID、API 地址，协议保持 OpenAI Chat Completions；目录里已有的服务（如 `openrouter`）选“第三方模型提供商”，模型目录在“自定义设置”里。
2. 添加模型，填模型 ID。在“模型选项”里填上下文窗口，能看图的模型勾 `图片`。
3. 需要 key 的服务填 API 密钥。`localhost`、`127.0.0.1` 或 `[::1]` 上不校验 key 的服务留空即可，请求带固定占位值 `dsh-native-audio-no-credential`。
4. 保存后，在这个 provider 的卡片上打开“原生音频输入”。目录 provider 的草稿卡片已有开关；自定义 provider 要点“创建提供商”后才出现。已有的 provider 也一样，直接打开开关，下一次请求生效，不用重启。

开关属于整个 provider，下面所有模型共用。“工具返回的音频”默认放进下一条 user 消息；只有经真实请求确认模型能听到 tool 消息中的音频后，才选“放进 tool 消息”。需要给两个模型不同设置时，添加两个 provider。

保存后的配置是普通 `llm-pi-ai` route，加上一个开关条目：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      local-qwen:
        displayName: Local Qwen
        api: openai-completions
        baseURL: http://127.0.0.1:7777/v1
        models:
          - id: qwen3-omni-30b-a3b-instruct-bf16
            contextWindow: 65536
            input: [text, image]
- id: native-audio-routes
  name: 'dsh-native-audio/pi-ai-audio-plugin'
  config:
    routes:
      local-qwen:
        toolResultAudio: user-message
```

模型 `id` 原样作为请求的 `model` 发送，模型必须先在 endpoint 上启动。`contextWindow` 不要超过 endpoint 单路请求能用的上下文：llama-server 默认把 `--ctx-size` 平分给每个 `--parallel` slot，以 endpoint `GET /v1/models` 报告的值为准。多模态模型需要加载对应的 mmproj。

音频内联为 base64 放进请求，每次请求都带上 history 中的全部音频，没有文件上传或 URL 引用。“OpenAI-compatible”不是对所有 endpoint 的统一音频保证，开关也不探测模型能力：只有明确接受 `/chat/completions`、multipart user content 与 `input_audio` 的服务才能用。细节见 [spec](specs/openai-compatible-provider.md)。

## 离线集成验收

Consumer 的默认接线验收不使用真实 key。仓库现有测试采用三种边界：

1. `RecordingLlmAdapter` 证明真实 Session/AgentLoop/Subagent 能看到 AudioBlock，没有任何 HTTP transport。
2. `GeminiGenerateContentAdapter` 注入 fake credential 与 fake fetch，捕获最终 JSON、audio receipts 和 SSE 响应；生产 serializer 与 capture serializer 是同一份代码。
3. 真实 `LlmRuntime`、`llm-pi-ai` 与音频开关 plugin 经 pi-ai 和官方 OpenAI SDK 走到 fake fetch，捕获最终 `input_audio` 与 tool/reasoning/usage stream；`installAudioBridge()` 的 `captureRequest` 另外给出带 `placement` 的 occurrence receipts。

集成到下游 bundle 后仍应沿用这三层，并增加固定的音频 fixture。只有在独立、明确授权的手工验收中才允许真实 provider 或真实 DAW 操作；本仓库的自动化不包含这类授权。

## 当前不提供的能力

- 待发送或历史消息中的音频播放器；
- 在 DSH 0.2 中打开含 AudioBlock 的 DSH `0.1.1-rc.2` Session（DSH 的 v2→v3 Session 格式迁移拒绝未知 content kind）；
- 让没打开音频开关的 `llm-pi-ai` route 或 stock DeepSeek route 发送 AudioBlock；
- Chat Completions route 的文件上传或 URL 引用 transport，以及自动探测 endpoint 是否支持 tool 消息音频；
- Gemini Interactions 或 Live API；
- 任意音频格式、输出音频、转录或音乐分析；
- DAW tool、render、resampling、freeze、export 或 Agent 之间的调用策略。

Web 输入的取舍见 [0007](decisions/0007-wav-file-attachment-ingress.md)，Models 页接入的取舍见 [0011](decisions/0011-chat-completions-audio-on-llm-pi-ai.md)。
