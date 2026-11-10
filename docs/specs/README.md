# Specs

One page per subsystem, describing what is built now: the source paths it owns, its data, behavior, failures, configuration, extension points, and known limitations. [architecture.md](../architecture.md) is the map across subsystems and links each page here.

## Page rules

- Write a page only for code an agent must understand before editing it safely: an interface other code relies on, state or a data format, or invariants and failure handling spread across files. Small self-contained code, such as one-off scripts, needs no page: its header comment or `--help` documents it, and a topic document such as `development.md` may list the commands, one line each. Code no page owns is normal.
- A feature that extends a subsystem goes on that subsystem's page: add its files to the `Source:` and describe it where it fits. Start a new page only when the new code meets the bar above on its own.
- Keep this folder flat: one Markdown page per subsystem, named for the subsystem in kebab-case. When a page covers more than one subsystem, split it into sibling pages; do not nest folders.
- The first line after the title is `Source:` followed by the backticked repository paths the page owns, for example ``Source: `src/sync/`, `src/storage/schema.ts`, `publish/src/render-*.ts` ``. A directory path ends with `/`; in a glob, `*` stays within one path segment and `**` crosses segments. A path that exists on disk is literal even when it contains `[`, `*`, or `?`, such as `app/media/[...key]/`. Each declared path belongs to one page. A more specific declaration on another page takes precedence: a file over a glob, a glob over a directory, and a deeper directory over its parent.
- A cross-cutting page that owns no code, such as privacy or configuration rules that span subsystems, writes `Source: none`. Prefer an owning page; a shared file still belongs to one page, and the other pages link it.
- Open with one scope paragraph: what the subsystem owns, which subsystems it calls or is called by (linked), and what it does not own.
- Then document what applies: data and types, behavior and lifecycle, failure and recovery, configuration, extension points, and known limitations. Link the authoritative code instead of restating it.
- A page describes only what exists. Planned behavior belongs in a [task](../tasks/TEMPLATE.md), the reason for a choice in a [decision](../decisions/TEMPLATE.md), and cross-subsystem flows in [architecture.md](../architecture.md).
- One entry file of each owned directory, such as the package comment, the main type, or the `index` module, carries one comment line naming the page, for example `// Spec: docs/specs/sync.md`. Files that cannot hold comments, such as JSON, need none.
- `python3 scripts/verify_subsystem_pages.py` checks this folder and the generated table in the root `AGENTS.md`; `--map` regenerates that table after a `Source:` line changes. `--owner <path>` names the page for a code path, `--changed [BASE]` lists pages whose owned paths changed while the page did not, and `--pointers` lists pages that no owned file names.

## Index

| Page | Owns |
|---|---|
| [audio-attachments.md](audio-attachments.md) | AudioBlock 类型、`audioAttachments` service、WAV store 与 route guard |
| [gemini-provider.md](gemini-provider.md) | `google-gemini-audio` route、Gemini wire、Files cache 与 SSE |
| [openai-compatible-provider.md](openai-compatible-provider.md) | stock `llm-pi-ai` route 上的 `input_audio` bridge、音频开关 plugin 与 Models 页卡片 |
| [read-audio-tool.md](read-audio-tool.md) | `read_audio` 模型工具 |
| [file-ingress.md](file-ingress.md) | WAV 文件附件在 `agent/pre-step` 中补成 AudioBlock |
| [bundle.md](bundle.md) | Package 导出、构建、发布文件与 `cordis.patch.yml` |
