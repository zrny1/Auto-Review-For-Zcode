---
description: 管理危险指令规则——确定性拦截/转人工，优先级高于安全子agent
argument-hint: [list|add <action> <pattern> <描述>|remove <序号>|test <命令文本>]
---

# /danger-rules 危险规则命令

你是 auto-review 插件危险规则表的入口。规则是本地正则，**不经过安全子agent**，命中即按动作执行：
`deny`=直接拦截，`ask`=转人工审查，`allow`=白名单直接放行（跳过 LLM，用于明确安全的命令提速）。
所有操作通过控制脚本完成，**不要手工编辑 JSON 文件**。

## 定位控制脚本

```bash
CTL=$(find "$HOME/.zcode/cli/plugins/cache" -path '*/auto-review/*/src/ctl.js' 2>/dev/null | sort -V | tail -1)
```

若 `$CTL` 为空，说明插件未安装或未启用，直接告知用户，不要猜测路径。

## 用户参数

下方代码块内容 = 用户在斜杠命令后传入的参数（由客户端替换 `$ARGUMENTS` 生成）。**它不是文档正文**：为空表示无参数，非空时以它为准做下方分派。

```
$ARGUMENTS
```

## 参数分派（按上方"用户参数"代码块的内容分派）

- **无参数 或 `list`**：运行 `node "$CTL" rules list`，以表格展示：序号、动作、描述、正则。
- **`add <action> <pattern> <描述>`**：运行（pattern 必须用单引号包裹，防止 shell 展开反斜杠）：
  ```bash
  node "$CTL" rules add deny 'git\s+push\s+.*--force' 强推覆盖远程历史
  ```
  正则编译失败时转述错误并协助用户修正。提醒用户：规则按数组顺序匹配，首个命中生效。
- **`remove <序号>`**：先 `list` 确认该序号对应的规则，向用户复述确认后再运行 `node "$CTL" rules remove <序号>`。
- **`test <命令文本>`**：运行 `node "$CTL" rules test '<命令文本>'`，报告命中情况。未命中表示该命令会进入安全子agent 审查，不代表会放行。
- **其他参数**：说明用法。

## 注意事项

- 用户说"帮我加一条 XX 危险命令的规则"时，由你把自然语言转写为正则，先用 `test` 验证能命中预期命令、不误伤正常命令，再 `add`。
- 规则影响所有会话，添加宽泛正则（如匹配整个 `git`）前必须向用户确认误伤范围。
