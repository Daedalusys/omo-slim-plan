---
name: plan-workflow
description: "ACTIVATES on explicit plan-work requests: user asks to plan, write a plan, plan this, /plan, /plan-work, or asks for a work plan before coding. Also pairs with /start-work and /plan-review. Lightweight plan-first workflow: write a decision-complete plan under .plans/, wait for human choice (start-work / plan-review / revise), execute with checkbox progress, then human acceptance. NEVER self-activates on bare coding requests. Does not implement during planning."
---

# plan-workflow

轻量 plan-first 工作流（oh-my-opencode-slim 之上）：
**写计划 → 人工门禁 → 执行打勾 → 人工验收**。
本 skill 约束规划与执行契约；命令入口为 `/plan`、`/start-work`、`/plan-review`。

## Plan file contract（计划文件契约）

路径：`.plans/<slug>.md`（项目根下，per-project；默认提交入库）

```markdown
# <slug>
- status: draft | ready | approved | in-progress | done | accepted
- created: YYYY-MM-DD
- slug: <slug>

## TL;DR
## Scope
## Must-NOT
## Todos
- [ ] 1. <title>
  - 验收: <agent-executable criteria>
  - 证据: <exact command or path>
- [ ] 2. ...
## Final checks
- [ ] F1. 计划符合度
- [ ] F2. 质量与测试通过
- [ ] F3. 与 Scope/Must-NOT 一致
## Notes
```

### 字段说明

| 字段 | 含义 |
|------|------|
| `- status:` | `draft` → `ready` → (`approved`) → `in-progress` → `done` → `accepted` |
| `- created:` | `YYYY-MM-DD`，首次写入时生成 |
| `- slug:` | 文件名同名 slug，小写-连字符 |
| `## Todos` | 可执行任务，列 0 的 `- [ ] N. <title>`；每项带 `验收:` 与 `证据:` 子行 |
| `## Final checks` | `- [ ] F1./F2./F3.` 完成门槛，全部通过才能 `status: done` |
| `## Notes` | 偏差、oracle 评审结论、变更痕迹 |

### 契约硬规则

- **执行者没有访谈上下文**：每个 todo 必须自带路径、验收判据、证据要求，零追问可执行。
- **规划只写 `.plans/`**（以及调用 notify CLI），**从不写产品代码**。
- **Approval/start 是人工门禁**：规划永远不自行开始实现。
- **start-work 必须在验证该 todo 后**才把 `- [ ]` 改为 `- [x]`，并追加 Notes（如有偏差）。
- **status 迁移**：`draft → ready → (optional approved) → in-progress → done → accepted`，禁止跳步宣称 accepted。
- **Review findings 写入 `## Notes`**：标注 suggested edits，不盲目重写 Todos。

## Workflow phases（工作流阶段）

### Phase 1 — Plan（`/plan`）
1. 只读探索（CodeGraph → Grep/Glob/Read → 必要时 librarian 外部文档）。
2. 写 `.plans/<slug>.md`，填满契约；元数据 `- status: ready`。
3. 通知：`plan-ready`（见下）。
4. 用 question 工具停在门禁，等待人类选择。

### Phase 2 — Human choice（人工门禁）
- **`start-work <slug>`** → 进入 Phase 3。
- **`plan-review <slug>`** → 派 `@oracle` 评审计划，结论写 `## Notes`，通知 `awaiting-review`，回到门禁。
- **`revise`** → 修改计划（仍在 `.plans/` 内），保持 `ready`，再次停在门禁。

### Phase 3 — Execute（`/start-work`）
1. 读计划，注册全部 todos（含 Final checks）。
2. 按序执行；独立 lane 可派发 explorer / fixer / designer；oracle 用于评审，librarian 用于外部文档。
3. **每完成一个顶层 todo**：更新 `- [x]`，必要时追加 Notes。
4. 可选通知 `task-done`（仅当事件在配置中启用）。
5. 全部 Todos + Final checks 完成后：`- status: done`，通知 `awaiting-acceptance`，呈现验收摘要（做了什么 / 证据 / 残留风险）。
6. 人类 accept → `- status: accepted`；reject → 按反馈修复后重新请求验收。

### Phase 4 — Acceptance（验收）
- 无复选框不宣称完成；计划文件是唯一事实来源。
- 验收摘要必须包含证据（命令/路径/测试结果）。

## Notify integration（通知集成）

当配置文件存在时（默认 `~/.config/opencode/planflow.json`）：

```bash
node ~/.config/opencode/plugin/planflow-notify.mjs \
  --event <event> \
  --plan .plans/<slug>.md \
  [--title "..."] \
  [--message "..."] \
  [--remaining N] \
  [--session ID] \
  [--config PATH] \
  [--dry-run]
```

| event | 时机 | 默认启用 |
|-------|------|----------|
| `plan-ready` | 计划写完、status: ready | true |
| `awaiting-review` | oracle 评审开始 | true |
| `task-done` | 单个 todo 完成（可选） | false |
| `awaiting-acceptance` | 全部完成、等待人工验收 | true |

- **notify 失败或 provider 未配置：继续工作流，绝不阻塞**。
- 也可直接编辑 `~/.config/opencode/planflow.json` 配置 Telegram / generic webhook / command provider。

## Delegation（委派）

使用 oh-my-opencode-slim 现有 agents，orchestrator 只做协调：

| Agent | 用途 |
|-------|------|
| `explorer` | 仓库内侦察：模式、约束、现状 |
| `fixer` | 有界实现 lane（按计划 todos） |
| `designer` | UI/结构相关实现 lane |
| `oracle` | 计划评审（对抗性、找缺口） |
| `librarian` | 外部文档/依赖研究 |

## Hard rules（硬规则汇总）

1. 规划阶段禁止实现、禁止改 `.plans/` 以外文件。
2. 人工门禁：人类不选择，不执行。
3. 执行阶段：复选框同步是唯一进度事实来源。
4. 验收阶段：F1–F3 全过 + 人类 accept 才算完成。
5. 通知是旁路信号，永不阻塞主流程。
