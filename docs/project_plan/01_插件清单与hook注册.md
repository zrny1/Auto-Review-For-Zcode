# 01 插件清单与 hook 注册

## 职责

定义插件身份与 PreToolUse hook 的注册方式，确定插件在 ZCode 中的加载入口。

## 技术栈

- 插件清单：`.zcode-plugin/plugin.json`（manifest 规范：name 匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`）
- hook 注册：`hooks/hooks.json`（外层 `hooks` 包装，事件名七选一）
- 运行时：Node.js ≥ 18（process 型 hook，argument vector 方式启动，规避 shell 差异）

## 插件目录结构

```
auto-review/                     # 插件根 = 仓库根
├── .zcode-plugin/plugin.json    # 清单：贡献 commands + hooks
├── hooks/hooks.json             # PreToolUse 注册
├── commands/                    # 三个斜杠命令
├── config/                      # 出厂默认配置（只读回落源）
├── src/                         # 核心脚本（零第三方依赖）
├── scripts/                     # 测试脚本
└── package.json                 # type=module，声明元信息
```

## plugin.json 设计

```json
{
  "name": "auto-review",
  "version": "0.1.0",
  "description": "自动审查权限：安全子agent 审查权限外请求，安全放行、危险转人工",
  "author": { "name": "hh-zyb" },
  "license": "MIT",
  "commands": "commands",
  "hooks": "hooks"
}
```

不声明 mcpServers / agents / skills：安全子 agent 是 hook 进程内的 LLM 调用，
不是对话内 subagent，也不需要 MCP 进程常驻。

## hooks.json 设计

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|ApplyPatch",
        "hooks": [
          {
            "type": "process",
            "command": "node",
            "args": ["${ZCODE_PLUGIN_ROOT}/src/hook_main.js"],
            "timeoutMs": 60000,
            "statusMessage": "安全审查中"
          }
        ]
      }
    ]
  }
}
```

关键决策与理由：

- **matcher 宽注册、运行时窄过滤**：matcher 是静态正则，一次注册覆盖所有可能被审查的工具
  （注意别名 `ApplyPatch` → `Write/Edit`，matcher 对工具名大小写敏感）；
  实际审哪些工具由数据目录 settings.json 的 `review_tools` 决定，改配置不需要改插件。
- **process 型而非 command 型**：argument vector 直接启动 node，不经 shell，
  Windows（本机 Git Bash 环境）与 POSIX 行为一致，路径含空格也安全。
- **`${ZCODE_PLUGIN_ROOT}`**：官方文档确认对 plugin hook 可用，保证从 marketplace 缓存目录运行时路径正确。
- **timeoutMs=60000**：hook 总预算必须大于内部 LLM 超时（默认 30000ms），
  预留规则匹配、缓存读写与进程启动时间；hook 被强杀时客户端按失败处理，不会误放行。

## hook 生命周期

```
主 agent 发起工具调用
  → ZCode 触发 PreToolUse（matcher 命中）
  → 以 JSON（stdin）传入 session_id / cwd / tool_name / tool_input
  → node src/hook_main.js 完成审查
  → stdout 输出决策 JSON（allow/ask/deny + reason）
  → ZCode 按决策放行 / 弹审批框（展示 reason） / 拦截
```

输入字段采用防御式读取（`tool_name` 与 `toolName` 双兼容），字段缺失时按"无法识别"处理，
走兜底 ask，绝不因输入异常而放行。
