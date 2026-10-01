---
description: Execute an existing .plans/<slug>.md work plan, updating checkboxes as work completes. Stop for human acceptance when done.
---

# /start-work — 执行既有计划

你是 **omo-slim-plan** 工作流中的执行编排者（orchestrator）。计划文件是**唯一事实来源**；你按计划执行，并在每完成一项后同步计划文件中的复选框。

## 执行步骤

1. **解析计划路径**：
   - 若命令参数给出了 `<slug>` 或路径：优先使用 `.plans/<slug>.md`（相对项目根）。
   - 若参数缺失且 `.plans/` 下只有一个 `.md` 计划：直接用它。
   - 若有多个计划且无法确定：用 question 工具让人类选择，**不要猜**。
   - 若计划不存在：报错并停止（不要凭空创建计划再执行）。

2. **读取计划并注册 todos**：
   - 读取 `.plans/<slug>.md` 全文。
   - 把 `## Todos` 中每个 `- [ ] N. <title>` 注册为 todo（含验收/证据子行）。
   - 把 `## Final checks` 中的 F1–F3 也注册为待办（它们是完成门槛）。
   - 若计划 `status` 为 `draft`：先按门禁流程让它 `ready`（可问人类是否先修订），**不要直接执行未 ready 的计划**。

3. **按计划执行**：
   - 按 todo 顺序执行；**独立的 lane 可并行派发**给现有 agent（explorer / fixer / designer / oracle / librarian）。
   - 编排者负责协调与验收判据判断；大段实现优先交给 agent，小规模机械改动（如复选框同步）可自己做。
   - 每个 todo 必须满足其 `验收:` 判据，并留下 `证据:` 所要求的产物/命令输出。

4. **每完成一个顶层 todo 后，立即更新计划文件**：
   - 把该 todo 的 `- [ ] N.` 改为 `- [x] N.`。
   - 若实现与计划有偏差：在该 todo 下追加子行说明偏差，或写入 `## Notes`；**不要悄悄改 Scope**。
   - 未验证完成的 todo **不得**打勾。

5. **可选通知**：仅当 `planflow.json` 中 `webhook.events.task-done` 为 `true` 时发送：

   ```bash
   node ~/.config/opencode/plugin/planflow-notify.mjs --event task-done --plan .plans/<slug>.md --message "<todo N 完成>" --remaining <剩余未完成数>
   ```

   通知失败不阻塞执行。

6. **全部完成后进入验收**：
   - 确认 `## Todos` 全部 `- [x]` 且 `## Final checks` 全部 `- [x]`。
   - 把元数据行改为 `- status: done`。
   - 发送验收通知：

     ```bash
     node ~/.config/opencode/plugin/planflow-notify.mjs --event awaiting-acceptance --plan .plans/<slug>.md --title "Awaiting acceptance: <slug>" --remaining 0
     ```

   - 向人类呈现**验收摘要**：
     - 做了什么（对照 Todos 逐项）
     - 证据（命令输出摘要 / 路径 / 测试结果）
     - 残留风险与已知限制

7. **等待人类接受/拒绝**（question 工具）：
   - `accept` → 把元数据行改为 `- status: accepted`，会话结束。
   - `reject` → 按人类反馈回到执行循环，修复后再次请求验收。

## 硬性规则

- **无复选框不宣称完成**：任何 "done" 声明必须与计划文件复选框一致。
- **计划文件是事实来源**：状态、进度、偏差都写进计划文件，不只留在对话里。
- **不得跳过 Final checks**：F1 计划符合度 / F2 质量与测试 / F3 Scope 与 Must-NOT 一致，全部通过才可 `status: done`。
- **不得在验收通过前写 `status: accepted`**。
- notify 脚本未安装或 webhook 未配置时：**继续工作流**，不报错中断。
