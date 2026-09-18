# auto-review — ZCode 自动审查权限插件

> 在 ZCode 现有权限模式之上模拟"自动审查"：主 agent 保持自动编辑模式，由一个**上下文干净的安全子 agent**（PreToolUse hook + LLM）审查权限外的请求——安全的自动放行，不安全的在**插件审查对话框**中携带分析、风险点、影响范围由用户裁决。

作者: hh-zyb ｜ 版本: 0.2.5 ｜ 技术栈: Node.js ≥ 18（零第三方依赖，GUI 为 PowerShell WinForms）｜ License: MIT

## 功能特性

- 🔎 **自动审查模式**——自动编辑基座 + hook 门卫，安全的命令自动放行（实测 2~5 秒/次）
- 🧼 **上下文干净**——安全子 agent 只看本次工具调用的 JSON（+ 可选的脚本附件），不接触对话历史，免疫对话内提示注入
- 🖥️ **插件审查对话框**（默认关闭）——现代化深色窗口：风险徽章 + 命令卡片 + 三段式分析；三按钮裁决「允许执行 / 本次会话允许 / 拒绝」，会话内放行同指令不再询问；不弹框时审批走客户端原生流程
- 🔁 **fallback provider**——主 provider 不可用（超时 / HTTP 429 限额 / 缺密钥 / 输出异常）时自动切换备用 provider 继续审查，全部失败才转人工；对话框在锁屏/无交互桌面无法显示时自动回落客户端原生审批，绝不把"没弹框"误当用户拒绝
- 🚧 **确定性危险规则层**——本地正则先行（deny 拦截 / ask 转人工 / allow 白名单），不经过 LLM；复合命令逐段审查，白名单无法被"白名单命令; 危险命令"绕过
- 📜 **脚本内容随命令送审**（默认关闭）——开启后 python/node/bash 等调用的脚本文件内容自动读取并随载荷送审，审查基于脚本实际内容而非文件名猜测；脚本内容变化后缓存自动失效重审
- ⚙️ **图形配置界面**——`/auto-review gui` 打开深色设置窗口：开关/审查工具/脚本送审/provider 与模型/超时缓存/危险规则管理，全组件统一风格
- ✏️ **可定制审查策略**——提示词在 GUI 编辑器中全文显示、就地修改（契约字段校验），保存立即生效；`/security-prompt` 命令等价
- 🔌 **provider 复用**——默认跟随主 agent 当前 provider，可指定其他 provider / 快模型（已适配 GLM 混合推理模型的 thinking 关闭）；配置读取优先 `~/.zcode/v2/provider_config.json`（新版凭据/接入点权威源），与 `~/.zcode/v2/config.json` provider 表合并，旧版 cli 布局兜底
- 🛡️ **失败必保守**——LLM 超时/报错一律转人工，插件崩溃时阻断而非放行；默认关闭，显式开启才介入

**平台支持**：审查内核（规则层 / LLM 审查 / 缓存 / 命令）全平台可用；审查对话框与图形配置界面仅 Windows，其他平台 ask 决策自动回落客户端原生审批、配置走命令式（`/auto-review set ...`）。

## 快速开始

```bash
# 1. 安装：ZCode 设置 → 插件管理 → 发现 → + 添加本地 marketplace（选本项目根目录，含市场清单）→ 安装 auto-review
# 2. 图形化配置：/auto-review gui（或在窗口里勾选启用）
# 3. 命令式：/auto-review on，然后把权限模式切到「自动编辑模式」
```

三个命令：`/auto-review`（总控 + gui）、`/danger-rules`（危险规则）、`/security-prompt`（审查策略）。

## 仓库结构

```
├── marketplace.json             # 市场清单（本地市场源入口）
├── .zcode-plugin/plugin.json    # 插件清单（hooks + commands）
├── hooks/hooks.json             # PreToolUse 注册（预算 1 小时，支撑对话框持久等待）
├── src/                         # 核心模块（零第三方依赖）
│   ├── common.js                # 路径常量/日志轮转/原子写
│   ├── settings.js              # 配置与规则加载（回落默认+类型钳制）
│   ├── provider.js              # ZCode provider 解析 + 双协议 LLM 调用（thinking 关闭）
│   ├── reviewer.js              # 决策管线（含复合命令逐段审查）
│   ├── decision.js              # hook 输出协议封装
│   ├── hook_main.js             # PreToolUse 入口 + 对话框裁决映射
│   ├── dialog.js                # 审查对话框（现代化深色窗口）
│   ├── gui.js                   # 图形配置界面
│   └── ctl.js                   # 控制 CLI（命令的唯一操作入口）
├── commands/                    # 3 个斜杠命令
├── config/                      # 出厂默认（14 条高危规则 + 审查提示词）
├── scripts/                     # 测试与维护脚本
└── docs/                        # 需求、方案、wiki、开发日志
```

## 测试

```bash
node --test scripts/unit_tests.test.js   # 单元测试（31 项）
node --test scripts/scenario_tests.test.js  # 场景固定测试（18 场景 + 2 锚定，离线）
node scripts/smoke_test.js               # 端到端冒烟（不触网，14 项断言组）
node scripts/validate_ps.js              # GUI 的 PowerShell 脚本语法校验
node scripts/llm_smoke.js                # 真实 LLM 链路（2 次真实调用）
```

## 文档导航

| 内容 | 位置 |
|------|------|
| 需求（只读） | [docs/project_demand.md](docs/project_demand.md) |
| 技术方案 | [docs/project_plan/](docs/project_plan/) |
| 使用指南 / 常见问题 | [docs/project_wiki/01_用户指南/](docs/project_wiki/01_用户指南/) |
| 开发文档 / 流程图 | [docs/project_wiki/02_开发文档/](docs/project_wiki/02_开发文档/) |
| 二次开发 | [docs/project_wiki/03_二次开发指南/](docs/project_wiki/03_二次开发指南/) |
| 开发日志 | [docs/project_log.md](docs/project_log.md) |

## 设计边界说明

插件无法修改客户端内置的权限模式枚举，"自动审查"通过 **内置自动编辑模式 + PreToolUse hook 返回 allow/ask/deny 决策** 实现，入口是 `/auto-review on` 而非模式下拉框。客户端原生审批框仅在"升级路径"渲染 hook 文本（合并函数在同向叠加时丢弃 reason），插件侧已用自有对话框 + additionalContext 转述补全决策时信息。
