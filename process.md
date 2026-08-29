## 本轮需求/背景

用户添加市场源为本项目根目录时报错：`Marketplace manifest not found in directory: D:\Demo\DemoSuperVisionForZcode`。
原因：本地市场源目录必须包含**市场清单** marketplace.json（`.zcode-plugin/` 下），
此前项目只有插件清单 plugin.json，被客户端当作"裸目录"拒绝。

## 预期修改计划

- 计划1：新增 `.zcode-plugin/marketplace.json`，让项目根目录同时充当市场源（source 用相对路径 `./` 指向插件自身）
- 计划2：更新安装文档（wiki 快速开始 / README）中的添加方式说明

## 实际修改步骤

- 新增 `.zcode-plugin/marketplace.json`：name=auto-review-local，plugins 数组含 auto-review（source="./"，description、version 与 plugin.json 一致）
- 脚本校验通过：marketplace 名与插件名均匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`、两清单插件名一致、source 为相对路径且不逃逸插件根
- 更新 docs/project_wiki/01_用户指南/快速开始.md 与 README.md 的安装步骤（改为"选本项目根目录"）
- 更新 wiki 变更记录

## 验证结果

- 清单静态校验全部通过（见上）
- 客户端实机验证待用户重试：设置 → 插件管理 → 发现 → + → 选择本项目根目录，
  应能列出 auto-review 并安装；若 `.zcode-plugin/marketplace.json` 仍不被识别，
  备选方案是把清单复制为 `.claude-plugin/marketplace.json`（兼容名称）
