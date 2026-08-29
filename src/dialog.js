/**
 * 模块功能: 人工审查对话框——ask 决策时弹出插件自己的审批框（完整分析+允许/拒绝），
 *           用户的选择直接映射为 hook 的 allow/deny 决策，取代客户端原生审批框
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 客户端在同向叠加路径（policy ask + hook ask）不渲染任何 hook 文本，
 *       且 hook 进程无法操纵客户端 UI；本模块用"自有对话框 + 决策返回值"实现同等效果：
 *       允许 → hook 返回 allow（客户端自动放行）；拒绝 → 返回 deny（无条件阻断）；
 *       超时/失败 → 返回 ask（回落客户端原生框，优雅退化）
 * 功能:
 *   - askUserViaDialog: 阻塞式弹出 WinForms 对话框，返回 allow/deny/timeout
 * 依赖: node:child_process（PowerShell WinForms，零第三方依赖）
 * 更新日期: 2026年08月29日
 */

import { spawnSync } from "node:child_process";

// 对话框倒计时秒数：须与 LLM 超时(默认30s)之和小于 hook 总预算 60s
const DIALOG_TIMEOUT_SECONDS = 25;

// PowerShell 脚本退出码约定：0=允许 1=拒绝 2=超时/关闭
const EXIT_ALLOW = 0;
const EXIT_DENY = 1;

// WinForms 对话框脚本：动态文本经环境变量传入（AR_TITLE/AR_BODY），规避引号转义；
// 回车默认触发"拒绝"（防误触允许），允许必须显式点击
const DIALOG_PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f=New-Object System.Windows.Forms.Form",
  "$f.Text=$env:AR_TITLE",
  "$f.TopMost=$true",
  "$f.ShowInTaskbar=$false",
  "$f.StartPosition='CenterScreen'",
  "$f.Size=New-Object System.Drawing.Size(640,600)",
  "$f.MinimizeBox=$false",
  "$f.MaximizeBox=$false",
  "$body=New-Object System.Windows.Forms.RichTextBox",
  "$body.ReadOnly=$true",
  "$body.Dock='Fill'",
  "$body.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75)",
  "$body.Text=$env:AR_BODY",
  "$body.BackColor=[System.Drawing.Color]::White",
  "$panel=New-Object System.Windows.Forms.Panel",
  "$panel.Dock='Bottom'",
  "$panel.Height=56",
  "$lbl=New-Object System.Windows.Forms.Label",
  "$lbl.Dock='Left'",
  "$lbl.Width=280",
  "$lbl.TextAlign='MiddleLeft'",
  "$btnDeny=New-Object System.Windows.Forms.Button",
  "$btnDeny.Text='拒绝'",
  "$btnDeny.Dock='Right'",
  "$btnDeny.Width=110",
  "$btnAllow=New-Object System.Windows.Forms.Button",
  "$btnAllow.Text='允许执行'",
  "$btnAllow.Dock='Right'",
  "$btnAllow.Width=110",
  "$panel.Controls.AddRange(@($lbl,$btnDeny,$btnAllow))",
  "$f.Controls.Add($body)",
  "$f.Controls.Add($panel)",
  "$script:left=[int]$env:AR_TIMEOUT",
  "$timer=New-Object System.Windows.Forms.Timer",
  "$timer.Interval=1000",
  "$timer.Add_Tick({$script:left--;$lbl.Text=\"[$script:left 秒后转默认审批] \";if($script:left -le 0){$f.Tag='timeout';$f.Close()}})",
  "$f.Tag='timeout'",
  "$btnAllow.Add_Click({$f.Tag='allow';$f.Close()})",
  "$btnDeny.Add_Click({$f.Tag='deny';$f.Close()})",
  "$f.AcceptButton=$btnDeny",
  "$f.Add_Shown({$timer.Start();$lbl.Text=\"[$script:left 秒后转默认审批] \"})",
  "[void]$f.ShowDialog()",
  "switch($f.Tag){'allow'{exit 0}'deny'{exit 1}default{exit 2}}",
].join("; ");

/**
 * 函数功能: 弹出人工审查对话框并等待用户操作（阻塞，受倒计时约束）
 * @param {string} title - 对话框标题
 * @param {string} body - 正文全文（命令 + 审查分析，多行）
 * @param {number} timeout_seconds - 倒计时秒数，超时按 timeout 处理
 * @returns {"allow"|"deny"|"timeout"} 用户选择；任何异常一律返回 timeout（回落客户端框）
 */
function askUserViaDialog(title, body, timeout_seconds) {
  if (process.platform !== "win32") {
    return "timeout";
  }
  const t_seconds = Math.max(5, Math.min(40, Number(timeout_seconds) || DIALOG_TIMEOUT_SECONDS));
  try {
    const t_result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", DIALOG_PS_SCRIPT],
      {
        env: { ...process.env, AR_TITLE: title, AR_BODY: body, AR_TIMEOUT: String(t_seconds) },
        timeout: (t_seconds + 15) * 1000,
        windowsHide: true,
      },
    );
    // status 为 null 表示被强杀（超时上限），同样按 timeout 回落
    if (t_result.status === EXIT_ALLOW) {
      return "allow";
    }
    if (t_result.status === EXIT_DENY) {
      return "deny";
    }
    return "timeout";
  } catch {
    // 对话框通道整体不可用时回落客户端原生审批，绝不因 UI 故障放行
    return "timeout";
  }
}

export {
  askUserViaDialog,
  DIALOG_TIMEOUT_SECONDS,
};
