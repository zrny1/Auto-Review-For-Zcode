# 项目开发日志

> 时间维度的开发日志，记录 git 无法替代的背景、方案、影响与验证结果。
> 每条记录关联对应 git 提交 ID。

## c140b2e

- 修改性质：bug 修复（LLM 调用层）+ 实机验证完成
- 背景/需求：实机验证暴露三类失败：Turbo 30s 超时、flash"响应为空"、客户端 hook 10s 判失败（Permission request failed）。用户要求查清原因。
- 方案/决策：诊断脚本直调 API 对比实验确诊——GLM 系为混合推理模型，遇危险命令默认长思考（~2652 字符≈700+ token），吃掉 max_tokens=1024 额度导致正文块为空，且思考耗时 16s 级撞上客户端 hook 等待上限。修复：anthropic 请求显式 `thinking:{type:"disabled"}` + max_tokens 提至 2048 双保险。实测 rm -rf 审查 16s/空响应 → **3.3s 带完整三段式分析**。
- 影响范围：src/provider.js（anthropic 分支）、新增 scripts/debug_llm_response.js 诊断脚本；已同步已安装插件缓存。
- 验证结果：6 项实机测试全部通过（详见 review.log）——安全命令自动放行（含超时兜底转人工路径）；rm -rf 与删除脚本均 4s 级转人工并展示分析/风险点/影响范围；deny/ask/allow 三种规则动作分别实现秒拦/转人工/白名单直放；规则层决策全部 `[rule]` 来源，LLM 决策全部 `[llm]` 来源。测试后规则表恢复出厂 14 条。

## a012812

- 修改性质：bug 修复（安装路径）
- 背景/需求：上轮清单放 `.zcode-plugin/marketplace.json` 后实机仍报 `Marketplace manifest not found`，推测的探测路径有误。
- 方案/决策：不再猜测，直接逆向客户端程序（`zcode.cjs` 中 grep 报错字符串定位探测函数 `Not`）：市场清单只探测**根目录 `marketplace.json`** 与 **`.claude-plugin/marketplace.json`** 两路径；`.zcode-plugin/` 仅用于插件清单 plugin.json。据此把清单移到根目录（与本机官方市场源 `~/.zcode/cli/plugins/marketplaces/...` 布局一致），删除放错位置的文件。教训：兼容目录名的适用范围（plugin.json vs marketplace.json）以程序源码为准，不能类推。
- 影响范围：根目录新增 marketplace.json、删除 .zcode-plugin/marketplace.json、文档三处更新；插件本体零改动。
- 验证结果：静态校验通过（探测路径正确、名称合法、与 plugin.json 一致）；实机添加待用户重试。

## 3a3fdef

- 修改性质：bug 修复（构建/安装路径）
- 背景/需求：用户添加市场源为项目根目录时报 `Marketplace manifest not found`——本地市场源目录必须含市场清单，项目此前只有插件清单。
- 方案/决策：项目根目录兼任市场源，新增 `.zcode-plugin/marketplace.json`（name=auto-review-local，plugins[0].source="./" 相对路径指向自身）；放弃的备选：在 D:\Demo 父目录建市场清单（污染项目外目录）、提供独立 marketplace 子目录（多一层嵌套无收益）。
- 影响范围：新增市场清单 + 安装文档两处更新；插件本体（src/hooks/commands）零改动。
- 验证结果：清单静态校验通过（名称正则、两清单插件名一致、source 不逃逸插件根）；实机添加待用户重试，备选兼容路径 `.claude-plugin/marketplace.json` 已记录在归档文档。

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
