# Package 与 bundle

Source: `package.json`, `cordis.patch.yml`, `tsconfig.build.json`, `scripts/test-packed-package.mjs`, `scripts/build-client.mjs`

本页拥有 npm package 的导出、构建、发布文件清单、DSH bundle patch 与 pack 测试脚本。各 face 的行为见 [音频附件](audio-attachments.md)、[Gemini](gemini-provider.md)、[OpenAI-compatible](openai-compatible-provider.md)、[`read_audio`](read-audio-tool.md) 与 [`file-ingress`](file-ingress.md)；兼容的 DSH 版本基线由 [上游契约](../upstream-contract.md) 维护。

## 导出与构建

- Package `dsh-native-audio` 是 ESM。`build` 先清空 `lib/`，`tsc -p tsconfig.build.json` 把 `src/`（不含 `src/client/`）编译到 `lib/`，声明文件在 `lib/types/`；`scripts/build-client.mjs` 把 `src/client/index.tsx` 输出为 DSH client module 格式的 `lib/client.js`，可用第一个参数指定输出路径。
- 导出：`.`（store 与 service）、`./types`、`./gemini`、`./gemini-plugin`、`./openai-compatible`、`./read-audio-tool`、`./file-ingress`、`./package.json`、`./pi-ai-audio-plugin`、`./client`。`./client` 只在浏览器的 client module loader 中运行，`dsh.client` 声明它（`platform: web`，inject `dsh-client-ui-settings`、`dsh-client-locale`、`dsh-api-remotes`）。
- 发布文件只有 `lib/**/*.js`、`lib/types/**/*.d.ts`、`cordis.patch.yml`、`README.md` 与 `LICENSE`。`prepack` 运行 `pnpm run check`（typecheck、test、build）。
- DSH 与 Cordis 包是精确版本的 peer dependency，`engines.dsh` 声明同一个 DSH 版本，安装和 profile 启动据此拒绝其他版本；Schemastery 是 dependency；`react` 与 `dsh-client-*` 只是 devDependency，运行时由宿主提供。

## Bundle patch

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，按顺序插入五个 entry：

| Entry id | Plugin |
| --- | --- |
| `native-audio` | `dsh-native-audio` |
| `llm-google-gemini-audio` | `dsh-native-audio/gemini-plugin` |
| `native-audio-routes` | `dsh-native-audio/pi-ai-audio-plugin` |
| `native-audio-read-tool` | `dsh-native-audio/read-audio-tool` |
| `native-audio-file-ingress` | `dsh-native-audio/file-ingress` |

Bundle 不注册 Chat Completions route；它们由用户在 Models 页添加到 stock `llm-pi-ai`（见 [consumer guide](../consumer-guide.md#接入-chat-completions-模型)）。Entry id 同时是 DSH Settings 命名空间；旧版 `settings.yaml` 中同名 section 在 DSH 0.2 首次启动时导入对应 entry。

## Pack 测试脚本

`scripts/test-packed-package.mjs --repo-root <path> --work-dir <path>` 把仓库（不含 `.git`、`lib`、`node_modules`）复制到临时目录，用同样的两步构建并 pack；Loader 组合测试与 packed-consumer 测试用它从 tarball 加载 package。
