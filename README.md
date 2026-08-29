# auto-review — ZCode 自动审查权限插件

作者: hh-zyb

在 ZCode 现有权限模式之上模拟"自动审查"权限：主 agent 保持自动编辑模式，
由一个上下文干净的安全子 agent（PreToolUse hook + LLM）审查权限外的请求——
安全的自动放行，不安全的携带分析、风险点、影响范围转发给用户审查。

> 项目初始化中，完整说明见 docs/ 目录，最终 README 在开发周期结束时补全。
