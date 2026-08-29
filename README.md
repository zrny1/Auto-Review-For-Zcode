# auto-review — ZCode 自动审查权限插件

> 在 ZCode 现有权限模式之上模拟"自动审查"：主 agent 保持自动编辑模式，由一个**上下文干净的安全子 agent**（PreToolUse hook + LLM）审查权限外的请求——安全的自动放行，不安全的携带**分析、风险点、影响范围**转人工审查。

作者: hh-zyb ｜ 版本: 0.1.0 ｜ 技术栈: Node.js ≥ 18（零第三方依赖）｜ License: MIT

## 功能特性

- 🔎 **自动审查模式**——自动编辑基座 + hook 门卫，安全的命令自动放行，不安全的转人工
- 🧼 **上下文干净**——安全子 agent 只看本次工具调用的 JSON，不接触对话历史，免疫对话内提示注入
- 📋 **结构化审批框**——转人工时展示三段式 reason：分析 / 风险点 / 影响范围
- 🚧 **确定性危险规则层**——本地正则先行（deny 拦截 / ask 转人工 / allow 白名单），不经过 LLM
- ✏️ **可定制审查策略**——安全子 agent 提示词全文可改，立即生效
- 🔌 **provider 复用**——默认跟随主 agent 当前 provider，可指定其他 provider / 快模型
- 🛡️ **失败必保守**——LLM 超时/报错一律转人工，插件崩溃时阻断而非放行；默认关闭，显式开启才介入

## 快速开始

```bash
# 1. 安装：ZCode 设置 → 插件管理 → 发现 → + 添加本地 marketplace（选本项目根目录，含市场清单）→ 安装 auto-review
# 2. 开启：
/auto-review on
# 3. 权限模式切到「自动编辑模式」即可
```

三个命令：`/auto-review`（总控）、`/danger-rules`（危险规则）、`/security-prompt`（审查策略）。

## 仓库结构

```
├── .zcode-plugin/plugin.json   # 插件清单（hooks + commands）
├── hooks/hooks.json            # PreToolUse 注册
├── src/                        # 7 个核心模块（决策管线/provider/输出协议/控制CLI）
├── commands/                   # 3 个斜杠命令
├── config/                     # 出厂默认（14 条高危规则 + 审查提示词）
├── scripts/                    # 单元测试 / 冒烟测试 / 真实 LLM 冒烟
└── docs/                       # 需求、方案、wiki、开发日志
```

## 测试

```bash
node --test scripts/unit_tests.test.js   # 单元测试（16 项）
node scripts/smoke_test.js               # 端到端冒烟（不触网，14 项）
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

插件无法修改客户端内置的权限模式枚举（那是编译在客户端里的行为）。
"自动审查"通过 **内置自动编辑模式 + PreToolUse hook 返回 allow/ask/deny 决策** 实现，
功能上等价于第五种权限模式，入口是 `/auto-review on` 而非模式下拉框。
