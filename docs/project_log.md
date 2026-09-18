# 项目开发日志

> 时间维度的开发日志，记录 git 无法替代的背景、方案、影响与验证结果。
> 每条记录关联对应 git 提交 ID。

## ac78c71

- 修改性质：bug 修复（GUI 显示）
- 背景/需求：用户 /auto-review gui 实机使用后发现 provider/Fallback 下拉显示的是统一表键——自定义 provider 的键为 UUID 不可读，要求优先显示 providerName。
- 方案/决策：显示名优先取条目 name、无 name 回落去 builtin: 前缀键、真同名碰撞追加括号键后缀（键唯一保证显示名唯一）；统一表新增返回 aliasKeys 供 GUI 过滤 providerName 别名键（别名与主键同 entry，同展示会重复）——set provider 按名解析不受影响；settings 存储值仍为稳定键，保存反查与回显经 显示名↔键 双向映射。验证中发现 PS5.1 读无 BOM UTF-8 中文脚本按 ANSI 解析会语法错误（临时验证脚本需加 BOM；正式 GUI 脚本经 -Command 字符串传递不受影响，已记录备查）。
- 影响范围：src/provider|gui、单元测试 +1 断言、变更记录/代码地图、五处版本号 0.2.5。
- 验证结果：单元 31/31、场景 20/20、冒烟 14 组、PS 语法校验全绿；PS 显示逻辑离线验证（唯一性/回显/反查）与真实配置预演（Mimo/deepseek/火山方舟等名称化显示、同名 Z.ai 项自动加后缀）通过。

## 55bba28

- 修改性质：bug 修复（安全）+ 新功能（新版配置适配）+ 文档/版本治理
- 背景/需求：ZCode 更新至 3.12.3.7463 后的适配评审引出三项修复与两项调查——
  ①上轮评审实测发现的 allow 白名单命令替换绕过（`ls $(危险载荷)` 整段被放行）；
  ②平台声明缺失（非 Windows 用户静默降级）；③provider 读取未覆盖新版
  `~/.zcode/v2/provider_config.json`；④调查 plugin.json userConfig 能否替代自建 GUI
  及远程渲染；⑤调查脚本送审为何对安全子 agent 仍是黑箱。
- 方案/决策：
  - ①：新增 `hasCommandSubstitution`（反引号/`$()`/`<()`/`>()`）；关键取舍——allow
    命中复合命令仍返回 null 交逐段逻辑（reason 能指向命中子命令，保持旧行为与旧
    测试），单段含替换构造则抑制该 allow **并继续向后扫描 deny/ask**（首个命中被
    抑制后，后续 deny 命中载荷文本仍拦截——保守方向优先，这是首版实现踩过再修正的
    语义点）；逐段全 allow 但任一段含替换→整体降级 LLM；
  - ③：provider_config 规则缺 enabled 标记、模板型规则缺 api.baseUrl（模板定义在
    客户端内），纯文件级切换会破坏"跟随主 agent"与模板型 provider——放弃"整文件
    优先"直译，改为**多源合并统一表**：规则（凭据/接入点/模型顺序，新版权威源）
    按 providerId 覆盖合并进 v2 表（enabled 与模板型定义），providerName 注册别名，
    无 enabled 时按 providerOrder 回落；GUI 下拉共用该表（临时 JSON 文件传递，
    finally 删除防密钥残留）；测试隔离新增 `AUTO_REVIEW_PROVIDER_CONFIG`；
  - ②：逆向确认当前清单 schema 无 platform 字段（zcode.cjs 中命中的 "platforms"
    均为 Flutter CLI 参数），强加未知键有严格校验拒绝风险——采用描述级声明 +
    gui 报错引导命令式配置 + 回落日志区分平台；
  - ④结论（见归档）：userConfig 类型仅 string/number/boolean/directory/file，值存
    `~/.zcode/cli/config.json` 的 `plugins.options`；`${user_config.*}` 展开仅 MCP
    字段可用，hook 模板变量为枚举式正则不含 user_config、hook 进程 env 也不含——
    hook 侧需自行读配置文件；可覆盖开关/数值/字符串类基础配置，无法覆盖 review_tools
    多选、危险规则 CRUD、提示词编辑器与审批对话框（运行时 UI 与设置无关）；远程
    场景值主机侧生效、不依赖宿主桌面，渲染入口为客户端插件管理界面（手机端有无
    该界面无法在本机验证），架构上比 PowerShell GUI 更远程友好；
  - ⑤结论：用户实际配置 `inspect_scripts: false`（0.2.3 该功能默认关闭且从未开启），
    功能本身无缺陷（隔离环境五场景提取/读取全通过）——已按用户意图执行
    `ctl set inspect_scripts true` 并实证 `scripts=1` 送审。
- 影响范围：src/reviewer|provider|gui|hook_main|ctl、清单三处（0.2.4）、单元测试 +4、
  README/FAQ/代码地图/变更记录/wiki 首页/命令文档。
- 验证结果：单元 31/31、场景 20/20、冒烟 14 组、PS 校验双脚本全绿；真实配置解析
  实证（统一表 18 键、Mimo 双路径解析、凭据取自规则、跟随主 agent 不变）；生产 hook
  日志实证新 provider 代码与脚本送审均已生效。

## 0.2.3 周期（360a313 ~ ecda9d0，2026-09-05）

- 修改性质：新功能（提示词 GUI 编辑器 + 脚本内容随命令送审）+ 测试 + 文档/版本治理
- 背景/需求：用户提出两点——①安全子 agent 的安全策略提示词应在 GUI 中显示且可修改
  （此前只有 CLI 拿路径外部编辑，GUI 无入口）；②安全子 agent 能否查看文件、对运行
  脚本的命令做进一步审查（安全子 agent 是单轮无工具 LLM 调用，`python deploy.py`
  只能看到命令文本，凭文件名猜测，测试预期即"内容未随调用提供"转人工）。
- 方案/决策：
  - ②的答复与方案：子 agent 本身无法浏览文件；不引入多轮工具循环（违背"上下文干净、
    单轮、低延迟"设计原则），采用 **Node 侧预附加**——管线在 LLM 前提取命令引用的
    脚本路径并读取内容拼入载荷（`extractScriptRefs`/`collectScriptAttachments`），
    审查基于脚本实际内容。产品决策（用户确认）：`inspect_scripts` **默认关闭**；
    提示词编辑采用**独立编辑器窗口**（主窗口仅加分区入口，复用"添加危险规则"子对话框
    模式，避免主窗口布局大改）；
  - 缓存键附件加盐：附件摘要（路径+内容 sha256）参与缓存键，脚本内容变化自动失效
    重审；无附件时键与旧版逐字节一致（历史缓存/会话白名单兼容）——会话白名单键刻意
    保持原始键（用户批准的是命令本身，临时放行不因脚本内容变化失效，持久规则仍优先）；
  - 内联/模块排除：`-c`/`-e` 代码已在命令文本、`-m` 引用非文件路径，均不提取；
  - GUI 防御性修复：PS 侧配置加载原为"存在用户文件即整体替换"，旧版 settings.json
    缺新键会得 $null、保存把默认悄悄写坏——改逐键合并回填（PS5.1 独立验证）；
  - 版本号结束"随发布统一"暂缓：三处统一 0.2.3（package.json 原 0.1.0 一并修复）。
- 影响范围：src/reviewer|settings|ctl|gui、config/default_settings+default_security_prompt、
  测试 +10、ar_gui_check.ps1、方案 02/04/00、命令文档、README、wiki 六处、版本号三处。
- 验证结果：离线全绿（单元 27/27、场景 20/20、冒烟 14 组、PS 双脚本校验）；ctl 新键
  实测（钳制 1000/100000、status 展示）；GUI 实机验证（窗口 760×876 显示/关闭 exit 0/
  status 含新键）；PS 逐键合并独立验证。意外收获：开发会话中本插件危险规则 #11 拦截了
  含 `Remove-Item -Recurse -Force` 的验证命令并弹框、用户拒绝生效——实机验证了规则层
  +对话框链路在工作。
- 返工记录（用户反馈）：提示词编辑框首版 `WordWrap=$false + ScrollBars='Both'`——出厂
  提示词含超长行（首行约 1300+ 像素），横向滚动范围被撑到数倍于框宽，用户报告"编辑栏
  宽度与显示框不匹配、下方超长滚动条"。修复：折行 + 仅纵向滚动（`WordWrap=$true +
  ScrollBars='Vertical'`），实机截图验证无横向滚动条、文本框内折行。教训：调试遵循
  "先观察后动手"——离线 WinForms 复现脚本未能触发（自动增宽理论不成立），实机截图
  才定位到真实根因是滚动范围问题。

## 0.2.2 周期（d0c071a，2026-09-03）

- 修改性质：bug 修复（对话框未显示误拒）+ 新功能（fallback provider）+ 测试/文档
- 背景/需求：用户报告部分 bash 命令被直接拒绝且完全不弹审查框。实测复现：当天所有 bash 调用（含 pwd/ls）均 0.5s 内被拦，日志恒为 `[fallback] 审查失败转人工: HTTP 429`（BigModel GLM 周额度耗尽）→ `[dialog] 用户拒绝`。根因三层叠加：①LLM 429 使所有命令走转人工；②锁屏/无交互桌面（进程含 LockApp、截图取不到画面）下插件自绘 WinForms 对话框无法显示；③PowerShell 默认 `$f.Tag='deny'` + 末尾 `default{exit 1}`，窗口没弹出时静默 exit 1，被 Node 当成"用户点了拒绝"——"没弹框"误报成"用户拒绝"。
- 方案/决策：
  - 对话框"未显示即回落客户端原生审批"：PS 侧两条检测——Shown 事件未触发（窗口从未显示）、OpenInputDesktop 返回空句柄（锁屏/无交互桌面），任一命中用独立退出码 3 退出；Node 侧 `mapDialogExitCode` 把 3 映射为 timeout，hook_main 回落客户端原生审批（保持 ask），绝不把 UI 故障当真人拒绝。退出码契约 0=允许 1=拒绝(含显示后关窗/Esc) 2=本次会话允许 3=未显示/基础设施故障；探测不可用（Add-Type 失败）时按旧行为弹窗，不误伤正常桌面。
  - fallback provider：`resolveProviderOverride(settings, name, model)` 抽出按名解析（主/fallback 复用）；`runLlmReview` 改为 provider 尝试列表（主→fallback），解析/调用/输出解析任一失败切下一个，全部失败抛汇总错误由上层兜底转人工（绝不带病放行）；配置新增 `fallback_provider`/`fallback_model`，settings 默认/ctl/gui 全链路支持。
- 影响范围：src/dialog|provider|reviewer|ctl|gui、config/default_settings.json、测试 +4 项、README/使用指南/常见问题；已同步安装插件缓存副本；实机已配 fallback_provider=火山方舟2/deepseek-v4-flash。
- 验证结果：离线全绿（单测 21/21、场景 16/16 含新增场景13/14、冒烟 14 断言组、PS 双脚本校验）。实机 fallback 生效：主 GLM 429 → `WARN[llm] 主 provider 审查失败，切换下一个` → `使用 火山方舟2 / deepseek-v4-flash` → `allow (fallback provider)`，pwd/tail 放行执行。实机对话框：用户在场可正常弹出并点击（探针实测点"本次会话允许"→ exit 2、Tag=session）；锁屏/未显示路径由退出码 3 回落客户端审批覆盖。插件版本号未 bump（随发布统一）。

## 0.2.1 周期（44ceed5 ~ 6b50ce4，2026-08-31）

- 修改性质：新功能（对话框三按钮+会话白名单、键盘导航）+ 测试资产（场景固化）+ 仓库治理（历史清洗）
- 背景/需求：用户要求 ①八条手工验收场景固化为回归测试；②清除 git 历史敏感信息（套餐名等，经全历史扫描定位）；③审批对话框增加「本次会话允许」按钮对齐 ZCode 原生审批窗；④键盘导航（左右键光标/回车/Esc=拒绝）。
- 方案/决策：
  - 场景固化：scripts/scenario_tests.test.js 用本地假 provider（openai 协议）离线固化 LLM 层行为，规则层直接断言并以 LLM 请求计数为 0 锚定"规则层不触网"；扩至 12 场景+2 锚定（防 allow 白名单绕过、LLM 幻觉 deny 收敛）；
  - 历史清洗：git filter-repo --replace-text 四条映射清除套餐名 + --commit-callback 统一 29 提交身份为 hh-zyb（修复清洗中新提交带入本机真实身份的失误）；仓库级 user.name/email 固化防再犯；mirror 备份可回滚；
  - 会话白名单：session_id 界定对话边界，session_allowlist.json 按会话分组存命令哈希（与缓存键同算法），24h 惰性过期；管线接入点在危险规则层**之后**——deny/ask 持久规则永远压过对话框临时放行；精确匹配整条指令；退出码契约扩展 2=会话允许，hook_main 写白名单失败降级一次性放行；
  - 键盘导航：Add-Type ARNavForm 重写 ProcessCmdKey 在消息预处理层原生拦截左右键/回车（两次返工：PS 事件委托丢键→$script: 索引自管理仍丢键→消息层根治）；Esc=拒绝走 CancelButton；关键坑：Add-Type 必须带 -ReferencedAssemblies（PS5.1 默认引用集无 WinForms），编译失败被 try/catch 静默吞导致导航全灭——独立编译脚本确诊。
- 影响范围：src/common|reviewer|dialog|hook_main|ctl、scripts/scenario_tests.test.js、README/使用指南/auto-review 命令文档、project_process 归档 ×2；插件缓存各轮已同步。
- 验证结果：全量测试 33/33；实机弹窗 choice=session/allow/deny 全路径验证；左右键每按必动、光标初始在「拒 绝」；历史清洗后全历史敏感模式零命中、身份唯一。

## 0.2.0 周期（b85e34d ~ a298f68，2026-08-29）

- 修改性质：新功能批次 + bug 修复批次 + 文档治理
- 背景/需求：实机验证暴露三类问题（GLM thinking 致空响应/超时、客户端审批框同向叠加不渲染 hook 文本、复合命令可被 allow 白名单绕过）；用户追加需求（自有审批对话框、图形配置、现代化美化、隐私清洗）。
- 方案/决策：
  - thinking 修复：诊断脚本直调 API 对照实验确诊混合推理机制，anthropic 协议显式 disabled（16s→3.3s）；
  - 审批框显示边界：客户端合并函数 fTr 在同向叠加时丢弃 hook reason、框不渲染 description 字段（两次实测+源码穷尽确认），插件侧以**自有对话框**取代（用户点击映射 hook allow/deny，超时回落原生审批）而非操纵客户端 UI；
  - 复合命令：用户提案+加固（deny/ask 不降级 LLM；allow 全文抑制）；
  - GUI：WinForms 深色现代化（Win11 DWM 圆角、自绘勾选/下拉/列表、扁平分区）；
  - 关键排障：PS 事件处理器作用域隔离（弹框风暴根因）、windowsHide 的 SW_HIDE 不被 ShowDialog 覆盖（窗口不可见根因，ShowWindow 显式修复）、模型下拉空态清空回归。
- 影响范围：新增 dialog.js/gui.js/4 个维护脚本，删除 toast.js；reviewer/provider/hook_main/ctl/命令文档/默认配置更新；hooks 预算 60s→1h。
- 验证结果：单测 19/19、冒烟 14 项、PS 校验双绿；四轮 8 项实机验证全过（含复合命令两组）；对话框与 GUI 实机验证通过（探测器确认 visible=True）；文档隐私清洗后复扫零残留。

## 59f99cf

- 修改性质：bug 修复（安全加固）+ 审批框显示机制调查
- 背景/需求：①审查发现 allow 白名单规则（^ls\b）可放行 "ls; rm -rf x" 复合命令——全文扫描以白名单命令开头即整体放行；②用户观察到审批框"有时显示审查分析、有时不显示"（仅 ls 验证时显示）。
- 方案/决策：
  - 复合命令修复（用户提案+加固）：按顶层分隔符（; && || | 换行，引号与 $()/反引号内不切分）拆分子命令逐段过规则——任一段 deny → 整体拦截、任一段 ask → 整体转人工（deny/ask 不降级 LLM，保持用户规则权威）、全段 allow → 放行、混合 → 降级 LLM 审查完整命令；另堵住全文扫描路径：allow 规则禁止命中复合命令全文；
  - 审批框不稳定机制（客户端源码证实）：模式引擎对命令分副作用等级，ls 判低风险→模式 allow→hook ask 走 escalated 分支（框内显示 reason）；rm/node 判需审批→模式 ask→hook ask 同向叠加，fTr 合并丢弃 reason。属客户端能力边界，插件已用 additionalContext 转述通道兜底。
- 影响范围：src/reviewer.js（matchDangerRules 拆分 + splitTopLevelCommands + matchCompoundRules + 管线接入）、单测 +2 项（18/18）、已同步插件缓存。
- 验证结果：A `ls; ls -la` 全段 allow → 复合放行；B `ls; rm -rf ...` 混合 → 降级 LLM ask high；C `ls` 单命令正常白名单；allow 复合全文抑制有专项断言。

## b85e34d

- 修改性质：bug 修复（LLM 调用层）+ 实机验证完成
- 背景/需求：实机验证暴露三类失败：Turbo 30s 超时、flash"响应为空"、客户端 hook 10s 判失败（Permission request failed）。用户要求查清原因。
- 方案/决策：诊断脚本直调 API 对比实验确诊——GLM 系为混合推理模型，遇危险命令默认长思考（~2652 字符≈700+ token），吃掉 max_tokens=1024 额度导致正文块为空，且思考耗时 16s 级撞上客户端 hook 等待上限。修复：anthropic 请求显式 `thinking:{type:"disabled"}` + max_tokens 提至 2048 双保险。实测 rm -rf 审查 16s/空响应 → **3.3s 带完整三段式分析**。
- 影响范围：src/provider.js（anthropic 分支）、新增 scripts/debug_llm_response.js 诊断脚本；已同步已安装插件缓存。
- 验证结果：6 项实机测试全部通过（详见 review.log）——安全命令自动放行（含超时兜底转人工路径）；rm -rf 与删除脚本均 4s 级转人工并展示分析/风险点/影响范围；deny/ask/allow 三种规则动作分别实现秒拦/转人工/白名单直放；规则层决策全部 `[rule]` 来源，LLM 决策全部 `[llm]` 来源。测试后规则表恢复出厂 14 条。

## efc0116

- 修改性质：bug 修复（安装路径）
- 背景/需求：上轮清单放 `.zcode-plugin/marketplace.json` 后实机仍报 `Marketplace manifest not found`，推测的探测路径有误。
- 方案/决策：不再猜测，直接逆向客户端程序（`zcode.cjs` 中 grep 报错字符串定位探测函数 `Not`）：市场清单只探测**根目录 `marketplace.json`** 与 **`.claude-plugin/marketplace.json`** 两路径；`.zcode-plugin/` 仅用于插件清单 plugin.json。据此把清单移到根目录（与本机官方市场源 `~/.zcode/cli/plugins/marketplaces/...` 布局一致），删除放错位置的文件。教训：兼容目录名的适用范围（plugin.json vs marketplace.json）以程序源码为准，不能类推。
- 影响范围：根目录新增 marketplace.json、删除 .zcode-plugin/marketplace.json、文档三处更新；插件本体零改动。
- 验证结果：静态校验通过（探测路径正确、名称合法、与 plugin.json 一致）；实机添加待用户重试。

## a6be9d3

- 修改性质：bug 修复（构建/安装路径）
- 背景/需求：用户添加市场源为项目根目录时报 `Marketplace manifest not found`——本地市场源目录必须含市场清单，项目此前只有插件清单。
- 方案/决策：项目根目录兼任市场源，新增 `.zcode-plugin/marketplace.json`（name=auto-review-local，plugins[0].source="./" 相对路径指向自身）；放弃的备选：在 <项目父目录> 父目录建市场清单（污染项目外目录）、提供独立 marketplace 子目录（多一层嵌套无收益）。
- 影响范围：新增市场清单 + 安装文档两处更新；插件本体（src/hooks/commands）零改动。
- 验证结果：清单静态校验通过（名称正则、两清单插件名一致、source 不逃逸插件根）；实机添加待用户重试，备选兼容路径 `.claude-plugin/marketplace.json` 已记录在归档文档。

## 5e25968

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
