# 开发过程记录

## 第一轮：八条手工验收场景固化为自动测试

### 本轮需求/背景

八条手工验收场景（放行/转审核/脚本/规则三态/复合命令）验证通过后，用户要求将其固化为固定测试脚本存入 `scripts/`，作为可重复执行的回归资产。

### 实际修改步骤

- 新增 `scripts/scenario_tests.test.js`（node:test 风格，与 unit_tests 同款隔离模式）：
  - 场景1-3（LLM 审查层）：本地假 provider 服务（node:http，openai 协议）按审查载荷中的命令关键字返回预置结论 JSON，离线固化"安全放行/高风险转审核/中风险转审核"的管线行为；
  - 场景4-8（危险规则层）：临时数据目录注入 deny/ask/allow 规则直接断言决策，以假服务请求计数为 0 锚定"规则层不经过 LLM"；复合命令两段全 allow 与任一段 ask 各有断言；
  - 两个防回归锚定：allow 白名单开头的复合命令藏危险段必须降级 LLM（防绕过）；LLM 幻觉 deny 收敛 ask（拦截权只属规则层）。
- README 测试章节同步运行方式。

### 验证结果

- 10/10 通过，全量 29/29；单次运行约 0.2s 全离线。
- 发现 `node --test scripts/` 目录模式在本机 Node22 把目录当单个测试执行而失败，统一改用显式文件路径运行。

## 第二轮：git 历史敏感信息清洗

### 本轮需求/背景

用户要求清除 git 历史中的敏感信息（个人路径、个人信息等）。全历史扫描结论：28 个提交身份已是匿名 `hh-zyb <hh-zyb@local>`，无邮箱/手机号/真实密钥/个人路径残留；残留集中在 provider 套餐名（process.md 历史版本、project_process 旧文档、使用指南旧示例、sanitize_docs 清洗规则自引用、provider.js 注释示例）。

### 实际修改步骤

- mirror 备份到项目同级裸仓库（28 提交完整，路径从略）。
- `src/provider.js:55` 注释示例键中性化（不再引用真实套餐配置键；工作区 sanitize_docs.mjs 已是通配正则无需改）。
- 提交工作区后执行 `git filter-repo --replace-text`：四条映射（本机套餐名长句→规范表述、套餐名→泛化占位符、示例配置键→中性值）。
- 复扫发现新提交带入了本机 git 配置的真实身份（用户名/邮箱）——`git filter-repo --commit-callback` 把全部 29 提交的 author/committer 统一为 `hh-zyb <hh-zyb@local>`，并 `git config --local` 固化仓库级身份防再犯。

### 验证结果

- 全历史个人信息与套餐名模式零命中（唯一残留为替换后的泛化占位符）。
- 29 提交完整、身份唯一、测试回归全绿。备份保留在 mirror 仓库。

## 第三轮：审查对话框三按钮 + 会话白名单

### 本轮需求/背景

用户要求审批对话框增加「在本次对话中允许该指令」按钮，与 ZCode 原生审批窗对齐。按反馈迭代：按钮文字定「本次会话允许」、位置移到允许/拒绝中间、绿底白字、提示行去掉按钮解释。

### 方案/决策

- 会话边界用 hook 输入的 `session_id` 精确界定；`session_allowlist.json` 按会话分组、键=命令哈希（复用缓存键算法 computeCacheKey）；24h 惰性过期；无 session_id 退化为 `_default` 分组。
- 管线接入点：危险规则层之后、缓存层之前——deny/ask 持久规则永远优先于临时放行（防早先放行过的复合命令绕过之后新增的子命令拦截规则）；精确匹配整条指令文本。
- 对话框退出码契约扩展：0=允许 1=拒绝(含关窗) 2=本次会话允许；`hook_main.js` 收到 session 先 `addSessionAllowlist`（写盘失败降级一次性放行，不推翻用户点击）再输出 allow。
- `ctl.js` 新增 `session list|clear`；`common.js` 新增 `SESSION_ALLOWLIST_FILE`。

### 验证结果

- 场景测试扩至 12 场景 + 2 锚定 14/14 全绿（白名单命中 source=session 且 LLM 零请求、deny 规则压过白名单、精确匹配、会话隔离各专项断言）；全量 33/33。
- 实机弹窗多轮验证：choice=session / allow / deny 全路径通过；改动同步插件缓存即时生效。

## 第四轮：对话框键盘导航（左右键光标 / 回车 / Esc）

### 本轮需求/背景

用户要求：左右键移动光标在三个按钮间、回车点击光标所在按钮、Esc=拒绝、提示行只保留「关闭窗口=拒绝」。

### 排障记录（两次返工）

- v1（窗体 KeyPreview+KeyDown，用 ActiveControl 判断焦点）：初始焦点设置失败或焦点被分析区 RTB 抢走时判断落空，方向键走 WinForms 默认导航漂到文字区；改 `$script:g_idx` 自管理索引（PS 函数内写标量须 `$script:` 前缀）后光标可动，但 PowerShell 事件委托开销造成丢键（按好几遍才动一下）。
- v2（根治）：Add-Type 定义 ARNavForm 继承 Form 重写 `ProcessCmdKey`，在消息预处理层原生拦截 Left/Right/Enter——不经 PS 事件。新坑：Add-Type 未带 `-ReferencedAssemblies` 时 PS5.1 默认引用集无 System.Windows.Forms.dll 导致编译失败，且被 try/catch 静默吞掉（表现为光标消失、焦点落文字区、回车无反应）；补齐引用后独立编译脚本确认 COMPILE_OK。

### 实际修改步骤

- `dialog.js`：窗体换 ARNavForm（类型缺失时回退普通 Form，鼠标仍可用）；`$f.NavButtons` 注入三按钮；`MoveNav` 画白框光标+Focus；Add_Shown 初始 `MoveNav(0)`（焦点在「拒 绝」）；`CancelButton=$bd` 实现 Esc=拒绝；命令区/分析区 RTB `TabStop=$false`；提示行精简；去掉 AcceptButton（固定回车目标与光标语义冲突）。
- 使用指南补键盘操作说明。

### 验证结果

- 实机：光标初始在「拒 绝」、左右键每按必动（消息层处理零丢键）、回车点击光标按钮（choice=session）、Esc=拒绝（choice=deny）。

## 第五轮：修复"部分 bash 被直接拒绝且不弹审查框" + fallback provider

### 本轮需求/背景

用户报告：部分 bash 命令被直接拒绝，完全没弹审查框。实测复现：当天所有 bash 调用（含 `pwd`/`ls`）都在 0.5s 内被拦，日志为 `[fallback] 审查失败转人工: HTTP 429`（BigModel GLM 本周额度耗尽）→ `[dialog] 用户拒绝`。

### 排障结论

三层叠加导致：
1. LLM 429 限额 → 所有不命中本地规则的命令全部走 fallback 转人工（ask）；
2. 当前桌面处于锁屏/无交互状态（进程里有 LockApp 锁屏、两屏截图均取不到画面），插件自绘 PowerShell WinForms 对话框无法真正显示；
3. PowerShell 脚本默认 `$f.Tag='deny'`、末尾 `default{exit 1}`，窗口没弹出来时静默以 exit 1 收场，Node 侧把 1 当成"用户点了拒绝"——**"没弹框"被误报成"用户拒绝"**，命令被硬拦。时间戳是铁证：fallback→"用户拒绝"恒为 0.5s，真人无法在 0.5s 内读框并点击。

### 方案/决策

- **对话框未显示即回落客户端原生审批**（核心修复）：PowerShell 增加"窗口从未显示"（Shown 事件未触发）与"锁屏/无交互桌面"（OpenInputDesktop 返回空句柄）两条检测，任一命中用**独立退出码 3** 退出；Node 侧 `mapDialogExitCode` 把 3 映射为 `timeout`，hook_main 回落客户端原生审批（保持 ask），绝不把 UI 故障当成真人拒绝。退出码契约：0=允许 1=拒绝(含显示后关窗/Esc) 2=本次会话允许 3=未显示/基础设施故障。
- **fallback provider**：`runLlmReview` 主 provider 解析/调用/输出解析任一失败自动切换 `fallback_provider`，全部失败抛汇总错误由上层兜底转人工（绝不带病放行）。解析复用新增 `resolveProviderOverride(settings, name, model)`，`resolveProvider` 变薄封装。配置新增 `fallback_provider`/`fallback_model`（settings 默认/ctl/gui 全链路）。

### 实际修改步骤

- `src/dialog.js`：新增 `EXIT_NOT_SHOWN=3`、`mapDialogExitCode`；PS 脚本加 `$script:dialog_shown`（Add_Shown 置真）+ 守卫 `if($f.Tag -eq 'deny' -and -not $script:dialog_shown){ exit 3 }`；顶部加 OpenInputDesktop 锁屏/无交互检测（探测失败按旧行为弹窗，不误伤正常桌面）。
- `src/provider.js`：抽出 `resolveProviderOverride` 并导出；`resolveProvider` 改薄封装。
- `src/reviewer.js`：`runLlmReview` 改为 provider 尝试列表循环（主 → fallback），失败记录后切下一个，全部失败 `throw new LlmError(汇总)`；llm 日志带 provider 标签。
- `config/default_settings.json`：新增 `fallback_provider`/`fallback_model` 默认空串。
- `src/ctl.js`：`SETTABLE_KEYS` 加两个键，`status` 输出 fallback 配置。
- `src/gui.js`：模型区下方新增 Fallback Provider/模型两行（下拉复用 Theme-Combo），规则区整体下移 64px、窗体加高，保存写回两个字段。
- 测试：`unit_tests` 新增 `resolveProviderOverride` 与 `mapDialogExitCode`（3→timeout）用例；`scenario_tests` 新增场景13（主 provider 死端口→自动切 fallback 完成审查，LLM 计数 1）与场景14（主与 fallback 均死→兜底转人工，reason 汇总两次失败）。
- 部署：5 个 src 文件 + default_settings.json 同步安装插件缓存副本（`…/auto-review/0.1.0/`）。

### 验证结果

- 离线：单元 21/21、场景 16/16（含新增 13/14）、冒烟 14 断言组、PS 双脚本语法校验全绿。
- 实机（配置 fallback_provider=火山方舟2 / deepseek-v4-flash）：主 GLM 429 → 日志 `WARN[llm] 主 provider 审查失败，切换下一个` → `使用 火山方舟2 / deepseek-v4-flash` → `allow (fallback provider)`，`pwd`/`tail` 均放行执行——**fallback 自动切换实机生效**。
- 实机对话框：用户在场时正常弹出并可点击（探针实测用户点"本次会话允许"→ exit 2，Tag=session）；"窗口未显示/锁屏"路径由退出码 3 回落客户端审批覆盖。

## 遗留事项

- 仓库级 git 身份已固化为 hh-zyb；全局配置仍为本机真实身份，跨仓库提交需注意。
- 插件缓存目录版本号（0.1.0）与仓库功能进度持续漂移，建议随下个版本发布重装缓存。
- `node --test scripts/` 目录模式在本机 Node22 失效，统一用显式文件路径运行测试。
- project_process 旧归档文件名中的提交短哈希（e226492/3a3fdef/a012812）为历史清洗前的旧 ID，与新历史不对应（仅文件名记录，内容不受影响）。
