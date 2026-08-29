---
description: 查看/修改/重置安全子agent的审查提示词
---

# /security-prompt 安全提示词命令

你是 auto-review 插件安全子agent 提示词的入口。提示词决定安全子agent 的审查策略与保守程度。
查看/重置通过控制脚本完成；**改写由你（主 agent）完成**——这是语言任务，脚本不做内容改写。

## 定位控制脚本

```bash
CTL=$(find "$HOME/.zcode/cli/plugins/cache" -maxdepth 4 -path '*/auto-review/*/src/ctl.js' 2>/dev/null | sort -V | tail -1)
```

若 `$CTL` 为空，说明插件未安装或未启用，直接告知用户，不要猜测路径。

## 参数分派（$ARGUMENTS 为用户传入的参数）

- **无参数 或 `show`**：运行 `node "$CTL" prompt show`，原文输出当前提示词（含来源标注）。
- **`reset`**：运行 `node "$CTL" prompt reset`，确认恢复出厂默认。
- **`edit <修改要求>`**：按以下步骤执行：
  1. 运行 `node "$CTL" prompt path` 拿到提示词文件路径；
  2. 读取该文件全文；
  3. 按用户的修改要求改写（保持中文、保持整体结构：角色 → 审查对象 → 审查维度 → 裁量标准 → 输出契约）；
  4. 向用户展示修改前后的关键差异（摘要即可），确认后写回文件（UTF-8 编码）；
  5. 提示：修改立即生效（每次审查前现读文件）。
- **其他参数**：说明用法。

## 硬性约束（改写时必须遵守）

- **不得改动"输出契约"一节的 JSON 字段名与结构**（decision/risk_level/analysis/risks/scope）——
  审查引擎按此契约解析，改了会导致所有审查失败兜底转人工；
- 只能调整审查维度的宽严、增删检查项、调整语言风格；
- 用户要求"更宽松"时提醒：提示词只影响 LLM 层，确定性危险规则（/danger-rules）不受影响。
