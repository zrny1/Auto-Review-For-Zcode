---
description: 自动审查插件总控——查看状态、开启/关闭、修改配置、会话白名单
argument-hint: [status|gui|on|off|set <key> <value>|session <list|clear>]
---

# /auto-review 总控命令

你是 auto-review 插件的控制入口。所有操作通过插件的控制脚本完成，**不要手工编辑 JSON 文件**。

## 定位控制脚本

```bash
CTL=$(find "$HOME/.zcode/cli/plugins/cache" -path '*/auto-review/*/src/ctl.js' 2>/dev/null | sort -V | tail -1)
```

若 `$CTL` 为空，说明插件未安装或未启用，直接告知用户并在设置中检查，不要猜测路径。

## 用户参数

下方代码块内容 = 用户在斜杠命令后传入的参数（由客户端替换 `$ARGUMENTS` 生成）。**它不是文档正文**：为空表示无参数，非空时以它为准做下方分派。

```
$ARGUMENTS
```

## 参数分派（按上方"用户参数"代码块的内容分派）

- **无参数 或 `status`**：运行 `node "$CTL" status`，把输出整理成简洁的中文状态汇报（开关、审查哪些工具、provider/model、规则条数、提示词是否自定义），并附一行常用用法提示。
- **`gui`**：运行 `node "$CTL" gui`——打开**图形配置界面**（深色主题设置窗口）：总开关、审查对话框开关、审查工具勾选、provider/模型下拉、超时缓存、危险规则的添加/删除/测试/恢复出厂，窗口内点击保存即生效。提醒用户这是命令式配置的图形替代。
- **`on`**：运行 `node "$CTL" set enabled true`。成功后提醒用户两点：
  1. 建议把 ZCode 权限模式保持在自动编辑模式（自动审查在该模式下体验最完整：文件编辑不打扰，命令由安全子agent把关）；
  2. 危险规则优先于安全子agent（`/danger-rules`），可用它设置确定性拦截。
- **`off`**：运行 `node "$CTL" set enabled false`，确认后说明关闭后 hook 不再干预，恢复内置权限流程。
- **`session list`**：运行 `node "$CTL" session list`，展示「本次会话允许」仍在生效的指令（含会话短标识、时间、命令预览）。
- **`session clear`**：运行 `node "$CTL" session clear` 清空会话白名单，说明效果：清空后这些指令会重新走完整审查。
- **`set <key> <value>`**：运行 `node "$CTL" set <key> <value>`（value 用引号包裹原样传递）。校验失败时把错误原样转述并给出合法取值说明：
  - `enabled`: true/false
  - `review_tools`: 字符串数组，如 `'["Bash"]'` 或 `Bash,Write`
  - `provider`: provider 名称（留空跟随主 agent；可用值参考 `~/.zcode/v2/config.json` 中 provider 表的键，可带或不带 `builtin:` 前缀）
  - `model`: 模型名（推荐 flash 级快模型降低审查延迟）
  - `timeout_ms`: 5000~45000
  - `cache_ttl_seconds`: 0~86400（0 表示禁用缓存）
  - `max_payload_chars`: 500~100000
- **其他参数**：说明用法并询问意图，不要自行猜测执行。

## 输出要求

用中文汇报；命令脚本的报错要完整转述（不要省略原因）；操作完成后展示 `status` 的关键变化。
