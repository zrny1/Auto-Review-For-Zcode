/**
 * 模块功能: PowerShell 脚本静态校验——两个 GUI 窗口的 PS 脚本解析检查（不弹窗）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 审查对话框与设置界面的 UI 都由嵌入的 PowerShell 脚本构建；
 *       本脚本用 PS 解析器做语法校验，在弹窗前拦截笔误（如引号不闭合、非法语句）
 * 依赖: node:fs node:os node:path node:child_process ../src/dialog.js ../src/gui.js
 * 用法: node scripts/validate_ps.js
 * 更新日期: 2026年08月29日
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DIALOG_PS_SCRIPT } from "../src/dialog.js";
import { GUI_PS_SCRIPT } from "../src/gui.js";

/**
 * 函数功能: 校验一段 PowerShell 脚本的语法
 * @param {string} name - 脚本名（用于输出）
 * @param {string} script - PS 脚本文本
 * @returns {boolean} 语法是否通过
 */
function validatePs(name, script) {
  const t_dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-ps-"));
  const t_file = path.join(t_dir, "check.ps1");
  // 必须带 BOM：PS5.1 对无 BOM 文件按 ANSI 读取，中文会破坏字符串终止符
  fs.writeFileSync(t_file, "\uFEFF" + script, "utf8");
  const t_checker = [
    "$errs=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('" + t_file.replace(/\\/g, "/") + "',[ref]$null,[ref]$errs);",
    "if($errs -and $errs.Count -gt 0){ $errs | ForEach-Object { Write-Output ('ERR:'+$_.Message) }; exit 1 } else { exit 0 }",
  ].join(" ");
  const t_result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", t_checker], { encoding: "utf8", timeout: 30000 });
  fs.rmSync(t_dir, { recursive: true, force: true });
  if (t_result.status === 0) {
    console.log(`ok - ${name}: PS 语法通过`);
    return true;
  }
  console.log(`FAIL - ${name}:`);
  console.log(t_result.stdout || t_result.stderr || "(无输出)");
  return false;
}

const t_ok_1 = validatePs("审查对话框 dialog.js", DIALOG_PS_SCRIPT);
const t_ok_2 = validatePs("设置界面 gui.js", GUI_PS_SCRIPT);
process.exit(t_ok_1 && t_ok_2 ? 0 : 1);
