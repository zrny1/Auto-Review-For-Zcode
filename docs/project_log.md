# 项目开发日志

> 时间维度的开发日志，记录 git 无法替代的背景、方案、影响与验证结果。
> 每条记录关联对应 git 提交 ID。

## e226492

- 修改性质：新功能（v0.1 完整实现）
- 背景/需求：ZCode 四种内置权限模式缺少"中间地带"——全自动裸奔、默认模式打断多。按 docs/project_demand.md 六条需求实现 auto-review 插件：自动编辑基座 + 安全子agent 门卫。
- 方案/决策：
  - 用 PreToolUse hook 返回 allow/ask/deny 模拟第五种权限模式（插件无法修改内置模式枚举，这是上限最高的等价实现）；
  - 安全子agent 实现为 hook 进程内的 LLM 直连（只看工具调用 JSON、不看对话上下文），而非对话内 subagent——天然免疫对话内提示注入；
  - 决策管线"先确定性后概率性"：用户危险规则（正则，不经过 LLM）→ 缓存 → LLM → 失败兜底 ask；
  - LLM 无 deny 权限（deny 收敛为 ask），拦截特权只属于用户规则层，避免幻觉拦截卡死工作流；
  - provider 从 ~/.zcode/v2/config.json 解析（anthropic/openai 双协议），默认跟随主 agent，可显式指定其他（需求6）；
  - 放弃的备选：userConfig 注入 hook（env 展开未经验证）、命令引导主 agent 手改 JSON（易错）——改为 ctl.js 控制脚本统一校验（计划外新增的第 7 个模块）；
  - 数据目录固定 ~/.zcode/auto-review/ 而非 ${ZCODE_PLUGIN_DATA}：hook 进程与主 agent 命令两侧都能确定性推出路径。
- 影响范围：新增全部文件（src×7、commands×3、hooks、config×3、scripts×3、方案文档）；无既有功能受影响（enabled 默认 false，装上不改变行为）。
- 验证结果：node --check 8 文件全过；单测 16/16；模拟冒烟 14 项断言组全过（含 LLM 不可达兜底、规则拦截/白名单、ctl 全命令）；真实 LLM 冒烟 2/2（安全命令 allow 2.5s、数据外发命令 ask 3.8s 且 reason 含分析/风险点/影响范围三段）。客户端集成验收待用户操作（hook 输出 schema 的实机校验是唯一残留风险点，集中在 decision.js 单文件可快速修正）。
