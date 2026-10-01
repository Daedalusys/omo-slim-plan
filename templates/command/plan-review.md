---
description: Delegate a review of a .plans/<slug>.md work plan to the oracle agent, write findings into the plan Notes, then return to the human gate.
---

# /plan-review — oracle 评审计划

你是 **omo-slim-plan** 工作流中的评审协调者。你把 `.plans/<slug>.md` 交给 **oracle** agent 做对抗性评审，把结论写进计划的 `## Notes`，然后**回到人工门禁**——评审本身不开始实现。

## 执行步骤

1. **读取计划**：
   - 解析 `.plans/<slug>.md`（参数给 slug 用 `.plans/<slug>.md`；缺失时列出 `.plans/*.md` 让人类选择）。
   - 确认计划存在且可读；不存在则报错停止。

2. **派发 oracle 评审**（task 工具，subagent_type：`oracle`）：
   - 输入：计划路径、当前请求/目标的一句话摘要、评审关注点。
   - 明确要求 oracle 检查：
     - **自相矛盾**：Todos 与 Scope/Must-NOT 是否冲突
     - **验收缺失**：哪些 todo 没有 agent 可执行的验收判据/证据
     - **scope creep**：计划是否夹带未请求的范围
     - **风险**：遗漏的依赖、顺序错误、不可逆操作、测试盲区
   - oracle 只读评审：**不得**改产品代码；建议改动以文本形式返回。

3. **把评审结论写入计划文件**：
   - 写入 `## Notes` 节（若无则创建）。
   - 格式建议：
     ```
     ## Notes
     - 2026-XX-XX oracle review:
       - [finding] ...
       - 建议: ...（需要人类/规划者确认后再改 Todos）
     ```
   - **不要盲目重写 Todos**：若建议改动，标注为 suggested edits，保持原复选框不变。

4. **通知**：在评审**开始时**发送（事件 `awaiting-review`）：

   ```bash
   node ~/.config/opencode/plugin/planflow-notify.mjs --event awaiting-review --plan .plans/<slug>.md --title "Plan review: <slug>"
   ```

   若 notify 未安装/未配置：跳过，不阻塞。

5. **呈现摘要并回到人工门禁**：
   - 向人类展示：oracle 发现数、最关键的问题、建议的处理方式。
   - 用 question 工具问人类：
     - `start-work <slug>` — 评审通过（或问题可接受），开始执行
     - `revise plan` — 先按建议修订计划（回到 `/plan` 或直接修订，保持 ready）
   - **不得**在人类选择前开始实现。

## 硬性规则

- 评审阶段禁止改产品代码；只允许写 `.plans/` 与调用 notify。
- Notes 中保留评审痕迹，供后续 start-work / 验收时参考。
- notify 失败不阻塞评审流程。
