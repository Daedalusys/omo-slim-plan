# `.plans/` 目录约定

`.plans/` 是 **omo-slim-plan** 工作流的计划存放目录，位于**每个项目的项目根**下。

## 为什么存在

- 计划是「决策完整」的工作说明书：执行者没有访谈上下文也能照做。
- 计划文件同时是**进度事实来源**：start-work 执行时同步 `- [ ]` → `- [x]`。
- 人工门禁（start-work / plan-review / revise）都以计划文件为准。

## 文件命名

- 一个计划 = 一个文件：`.plans/<slug>.md`
- slug：**小写-连字符**（例如 `add-rate-limit`、`fix-login-timeout`）
- slug 与文件名、`- slug:` 元数据行保持一致

## 状态字段（元数据行，列 0）

```
- status: draft | ready | approved | in-progress | done | accepted
```

| status | 含义 |
|--------|------|
| `draft` | 草稿，尚不可执行 |
| `ready` | 决策完整，停在人工门禁 |
| `approved` | （可选）人类已批准 |
| `in-progress` | `/start-work` 执行中 |
| `done` | Todos + Final checks 全部完成，等待验收 |
| `accepted` | 人类验收通过，终态 |

## 计划模板

完整文件契约见 **plan-workflow** skill（安装后位于 `~/.config/opencode/skills/plan-workflow/SKILL.md`，或 skillshare 对应路径）。

最小骨架：

```markdown
# my-feature
- status: ready
- created: 2026-01-01
- slug: my-feature

## TL;DR
## Scope
## Must-NOT
## Todos
- [ ] 1. <title>
  - 验收: <agent-executable criteria>
  - 证据: <exact command or path>
## Final checks
- [ ] F1. 计划符合度
- [ ] F2. 质量与测试通过
- [ ] F3. 与 Scope/Must-NOT 一致
## Notes
```

## Git 策略

- **默认：提交计划**（commit plans），不提交 boulder 之类的重型工件。
- 少数团队可能希望计划只在本地：按需在项目 `.gitignore` 中加入 `.plans/`，或只忽略特定 slug。
- 计划文件本身不含密钥；`planflow.json`（webhook token）住在 `~/.config/opencode/`，**永不进项目仓库**。
