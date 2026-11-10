# 0008: 用统一文档布局取代 Agent Notes

- Status: Accepted
- Date: 2026-10-13

## Context

2026-08-29 起，本仓库采用由 `dsh-agent-docs-kit` 适配的 DeepSeek Harness 文档子集：取舍理由写在 `.agents/notes/` 下按 proposed、implemented、rejected、archived 生命周期分目录的 Agent Notes，配有格式检查 `scripts/verify_agent_notes.py`（该脚本已从仓库删除）和 `dsh-prose-standard`、`dsh-find-simplifications` 两个 skill。Implemented note 必须随代码保持最新，同一事实因此同时存在于 note、architecture 和 task 中。

2026-10-13 用户决定弃用这套机制，原话是 Agent Notes “极度难以维护”，要求改用 tasks、specs、decisions、research 和 architecture。

## Decision

文档采用 [docs/AGENTS.md](../AGENTS.md) 描述的布局：`docs/architecture.md` 是跨子系统的地图；`docs/specs/` 每个子系统一页，以 `Source:` 行声明拥有的源码路径，根 `AGENTS.md` 中的路径表由 `scripts/verify_subsystem_pages.py --map` 生成；`docs/product.md` 记录范围、目标、非目标和方向；`docs/decisions/` 记录不再改写的决定；`docs/tasks/` 记录有界工作；`docs/research/` 记录带日期的证据。

原有 Agent Notes 按内容迁入 decisions、specs 与 research 后删除。`scripts/verify_agent_notes.py`、两个 kit 派生 skill 和记录文档套件来源的 `.agents/UPSTREAM.md` 一并删除，后者中的代码改编来源移入上游契约。DeepSeek Harness 作为运行时、API 与依赖的所有引用保持不变；`.agents/LICENSE.deepseek-harness` 保留，因为 `src/store.ts` 改编自 DSH 代码（见 [上游契约](../upstream-contract.md#代码改编来源)）。（注：该许可证文本后来移到仓库根目录的 [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES)。）

## Alternatives

**保留 Agent Notes。** 用户在 2026-10-13 明确否决（“极度难以维护”）。

**复制 DSH 整仓库的文档系统。** 2026-08-29 已否决：DSH 的双语同步、网站生成、package catalog、release gate 和 monorepo 命令在本项目没有消费者，复制会产生无法执行的规则和持续漂移。

**每个 Agent run 写一份日志。** 2026-08-29 已否决：会形成与 task、Git 和测试重复的第二套状态系统。

## Consequences

当前行为只写在 spec 和 architecture 中，理由只写在 decision 中，二者不再互相复制。决定一旦接受就不再改写，推翻时写新的 decision。`verify_subsystem_pages.py` 只证明 spec 索引、`Source:` 路径与生成表一致，不证明 spec 内容与代码相符。
