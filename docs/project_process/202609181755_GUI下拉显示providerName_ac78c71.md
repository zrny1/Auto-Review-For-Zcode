# process

## 本轮需求/背景

用户使用 `/auto-review gui` 后提出（2026-09-18）：

1. 配置界面 provider 与 Fallback 下拉直接显示统一表的键——自定义 provider 的键是
   UUID（如 `8a0a21c0-...`），不可读；应优先显示 providerName，无名称才显示 ID
2. 咨询 userConfig 能否用来做审批弹窗（不替代插件配置界面）——纯咨询，无代码

## 预期修改计划

- provider.js：`loadUnifiedProviderTable` 增加返回 `aliasKeys`（providerName 别名键）
- gui.js：临时表过滤别名键（别名与主键指向同一 entry，同时展示会重复）；
  PS 侧下拉显示名优先取 entry.name、同名加括号键后缀去重、选中回显用键→显示名映射
- 测试：别名键断言 + PS 显示逻辑离线验证 + 全量回归；版本 0.2.5

## 实际修改步骤

- **provider.js**：别名注册循环同步收集 `t_alias_keys`，返回值增加 `aliasKeys`；JSDoc 更新
- **gui.js**：`launchSettingsGui` 用 `aliasKeys` 过滤统一表后再写临时 JSON；
  PS 脚本 provider/Fallback 两处下拉构造改为——显示名 `$dn` 优先取
  `$provTable.$k.name`，无 name 回落去 `builtin:` 前缀的键；`$provKeyMap.ContainsKey($dn)`
  碰撞时追加 `' (' + 键 + ')'` 后缀；新增 `$provKeyToDn`（键→显示名）用于当前值回显
  （settings.provider 存储值仍是稳定键，保存反查 `$provKeyMap[选中显示名]` 逻辑不变）；
  Fallback 下拉复用同一映射
- **单元测试**：provider 规则合并用例增加 `aliasKeys` 深比较断言
- **PS 逻辑离线验证**（临时脚本，已删）：模拟含 UUID 键/无 name 条目/builtin 键/真同名
  碰撞的表——下拉项 6/6 唯一；UUID 回显 → "Mimo"；`builtin:` 回显 → "Fake OpenAI"；
  未知值回落首项；显示名反查键正确。注：PS5.1 读取无 BOM 的 UTF-8 中文脚本会按 ANSI
  解析导致语法错误，验证脚本需加 BOM（与插件正式 PS 脚本经 `-Command` 传递的方式无关）
- **真实配置预演**：过滤别名后的下拉为 BigModel - Coding Plan / BigModel- Coding Plan /
  Z.ai - Coding Plan ×2（同名，第二项自动加 `zai-start-plan` 后缀）/ Bigmodel - API Key /
  Z.ai - API Key / deepseek / kimi / 火山方舟 / 火山方舟2 / kimi2 / Mimo / Kimi
- **文档/版本**：变更记录 0.2.5、代码地图 GUI_PS_SCRIPT 行、五处版本号 0.2.5

## 验证结果

- 单元 31/31（含新断言）、场景 20/20、冒烟 14 组、validate_ps 双脚本全绿
- PS 显示名逻辑离线验证与真实配置预演均符合预期（见上）
- 咨询项 2 的结论（userConfig 审批弹窗不可行及原因）在周期汇报中给出，不涉及代码
- 偏离率说明：与计划一致，无偏离
