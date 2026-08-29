/**
 * 模块功能: 人工审查对话框（现代化深色主题版）——ask 决策时弹出插件自己的审批窗口
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 现代化设计：Win11 DWM 窗口圆角 + 深色标题栏；风险徽章药丸形；命令区为圆角卡片
 *       （无边框 RTB 内嵌圆角 Panel）；扁平分区；按钮圆角加大间距；
 *       滚动条策略：内容自动换行 + 加高展示区，仅在溢出时出现系统滚动条（WinForms 无法重绘原生滚动条）
 *       行为不变：无超时等待用户决策、关窗=拒绝、回车=拒绝、允许需显式点击
 * 功能:
 *   - parseReasonForDialog: 把 reason 文本解析为结构化展示数据
 *   - askUserViaDialog: 阻塞式弹出 WinForms 对话框，返回 allow/deny/timeout
 * 依赖: node:child_process（PowerShell WinForms，零第三方依赖）
 * 更新日期: 2026年08月29日
 */

import { spawnSync } from "node:child_process";

// 24 小时是 spawnSync 的绝对安全上限，防止 PowerShell 进程本身僵死拖死 hook
const DIALOG_HARD_LIMIT_MS = 24 * 3600 * 1000;

// PowerShell 脚本退出码约定：0=允许 1=拒绝（含直接关闭窗口）
const EXIT_ALLOW = 0;
const EXIT_DENY = 1;

// 深色主题配色（与 gui.js 的设置界面保持一致，风格对齐 ZCode 客户端）
const THEME = {
  bg: "#1E1E1E",
  panel: "#252526",
  border: "#3E3E42",
  text: "#D4D4D4",
  textDim: "#9D9D9D",
  accent: "#4C8DFF",
  riskHigh: "#F14C4C",
  riskMedium: "#FFA657",
  riskLow: "#4EC9B0",
  denyBg: "#4A2B2E",
};

/**
 * 函数功能: 把审查 reason 文本解析为对话框展示用的结构化数据
 * @param {string} reason - 完整 reason（LLM 三段式 / 规则命中 / 兜底文案）
 * @returns {{risk: string, analysis: string, risks: string[], scope: string|null, plain: string}}
 */
function parseReasonForDialog(reason) {
  const t_text = String(reason || "");
  const t_lines = t_text.split("\n").map((t_line) => t_line.trim()).filter(Boolean);
  const t_risk = (t_text.match(/风险级别\s*([a-zA-Z\u4e00-\u9fa5]+)\s*[:：]/) || [])[1] || "";
  const t_risks = t_lines.filter((t_line) => t_line.startsWith("-")).map((t_line) => t_line.replace(/^-\s*/, ""));
  const t_scope_line = t_lines.find((t_line) => /^影响范围[:：]/.test(t_line));
  const t_scope = t_scope_line ? t_scope_line.replace(/^影响范围[:：]\s*/, "") : null;
  const t_analysis = (t_lines[0] || "")
    .replace(/^\[auto-review\]\s*/, "")
    .replace(/^风险级别\s*[a-zA-Z\u4e00-\u9fa5]+\s*[:：]\s*/, "");
  const t_structured = t_risk !== "" || t_risks.length > 0 || t_scope !== null;
  return {
    risk: t_risk.toLowerCase(),
    analysis: t_analysis,
    risks: t_risks,
    scope: t_scope,
    plain: t_structured ? "" : t_text,
  };
}

// WinForms 现代化深色审查对话框；动态内容经环境变量传入规避引号转义；
// 不用反引号（换行以 [char]10 拼接）；控件圆角用 GraphicsPath Region
const DIALOG_PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "try { Add-Type 'using System;using System.Runtime.InteropServices;public class ARDwm{[DllImport(\"dwmapi.dll\")]public static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int s);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);}' } catch {}",
  "$NL=[char]10",
  "function C($hex){ [System.Drawing.ColorTranslator]::FromHtml($hex) }",
  "function Lbl($text,$hex,$size,$style){ $l=New-Object System.Windows.Forms.Label; $l.Text=$text; $l.ForeColor=C $hex; $l.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',$size,$style); $l.AutoSize=$true; return $l }",
  // 圆角 Region：以控件当前尺寸生成四角圆弧路径（须在 Size 设置之后调用）
  "function Round($ctrl,$r){",
  "  $p=New-Object System.Drawing.Drawing2D.GraphicsPath",
  "  $d=2*$r",
  "  $p.AddArc(0,0,$d,$d,180,90); $p.AddArc($ctrl.Width-$d,0,$d,$d,270,90); $p.AddArc($ctrl.Width-$d,$ctrl.Height-$d,$d,$d,0,90); $p.AddArc(0,$ctrl.Height-$d,$d,$d,90,90)",
  "  $p.CloseFigure()",
  "  $ctrl.Region=New-Object System.Drawing.Region($p)",
  "}",
  // 窗体：深色 + Win11 原生圆角
  "$f=New-Object System.Windows.Forms.Form",
  "$f.Text='auto-review 人工审查'",
  "$f.BackColor=C '" + THEME.bg + "'",
  "$f.TopMost=$true",
  "$f.ShowInTaskbar=$false",
  "$f.StartPosition='CenterScreen'",
  "$f.FormBorderStyle='FixedDialog'",
  "$f.MaximizeBox=$false",
  "$f.Size=New-Object System.Drawing.Size(700,700)",
  "$f.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75)",
  // 头部：标题 + 药丸形风险徽章
  "$t=Lbl '需要人工审查' '" + THEME.text + "' 15 ([System.Drawing.FontStyle]::Bold)",
  "$t.Location=New-Object System.Drawing.Point(24,20)",
  "$badgeMap=@{high='" + THEME.riskHigh + "';medium='" + THEME.riskMedium + "';low='" + THEME.riskLow + "'}",
  "$risk=$env:AR_RISK; if(-not $badgeMap.ContainsKey($risk)){$risk='medium'}",
  "$badge=New-Object System.Windows.Forms.Label",
  "$badgeText= if($env:AR_RISK){$env:AR_RISK.ToUpper()+' 风险'}else{'需确认'}",
  "$badge.Text=$badgeText",
  "$badge.AutoSize=$false; $badge.Size=New-Object System.Drawing.Size(112,36)",
  "$badge.Location=New-Object System.Drawing.Point(548,14)",
  "$badge.BackColor=C $badgeMap[$risk]; $badge.ForeColor=C '#FFFFFF'",
  "$badge.TextAlign='MiddleCenter'",
  "$badge.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold)",
  "Round $badge 18",
  // 命令区：圆角卡片（Panel 圆角 + 无边框内嵌 RTB，同色无缝）
  "$cl=Lbl '待审查命令' '" + THEME.accent + "' 9.75 ([System.Drawing.FontStyle]::Bold)",
  "$cl.Location=New-Object System.Drawing.Point(26,66)",
  "$card=New-Object System.Windows.Forms.Panel",
  "$card.BackColor=C '" + THEME.panel + "'",
  "$card.Location=New-Object System.Drawing.Point(24,92); $card.Size=New-Object System.Drawing.Size(632,92)",
  "Round $card 12",
  "$cb=New-Object System.Windows.Forms.RichTextBox",
  "$cb.ReadOnly=$true; $cb.BorderStyle='None'; $cb.ScrollBars='None'; $cb.WordWrap=$true",
  "$cb.BackColor=C '" + THEME.panel + "'; $cb.ForeColor=C '" + THEME.text + "'",
  "$cb.Font=New-Object System.Drawing.Font('Consolas',9.75)",
  "$cb.Location=New-Object System.Drawing.Point(6,6); $cb.Size=New-Object System.Drawing.Size(620,80)",
  "$cb.Text=$env:AR_CMD",
  "$card.Controls.Add($cb)",
  // 分析主体（分节着色，自动换行）
  "$b=New-Object System.Windows.Forms.RichTextBox",
  "$b.ReadOnly=$true; $b.BorderStyle='None'; $b.WordWrap=$true",
  "$b.BackColor=C '" + THEME.bg + "'; $b.ForeColor=C '" + THEME.text + "'",
  "$b.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75)",
  "$b.Location=New-Object System.Drawing.Point(26,202); $b.Size=New-Object System.Drawing.Size(628,376)",
  "function Sec($title){ $b.SelectionColor=C '" + THEME.accent + "'; $b.SelectionFont=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75,[System.Drawing.FontStyle]::Bold); $b.AppendText($title+$NL) }",
  "function Txt($text,$hex){ $b.SelectionColor=C $hex; $b.SelectionFont=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75); $b.AppendText($text+$NL) }",
  "if($env:AR_PLAIN){",
  "  Txt $env:AR_PLAIN '" + THEME.text + "'",
  "} else {",
  "  if($env:AR_ANALYSIS){ Sec '分析'; Txt $env:AR_ANALYSIS '" + THEME.text + "'; $b.AppendText($NL) }",
  "  if($env:AR_RISKS){",
  "    Sec '风险点'",
  "    foreach($r in ($env:AR_RISKS -split $NL)){ if($r.Trim()){",
  "      $b.SelectionColor=C '" + THEME.riskHigh + "'; $b.SelectionFont=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75); $b.AppendText('  * ')",
  "      Txt $r '" + THEME.text + "'",
  "    } }",
  "    $b.AppendText($NL)",
  "  }",
  "  if($env:AR_SCOPE){ Sec '影响范围'; Txt $env:AR_SCOPE '" + THEME.text + "' }",
  "}",
  // 底部：分隔线 + 提示 + 圆角按钮（加大间距）
  "$sep=New-Object System.Windows.Forms.Label",
  "$sep.AutoSize=$false; $sep.Size=New-Object System.Drawing.Size(652,1); $sep.Location=New-Object System.Drawing.Point(24,592)",
  "$sep.BackColor=C '" + THEME.border + "'",
  "$h=Lbl '回车=拒绝 · 关闭窗口=拒绝 · 本框不会自动消失' '" + THEME.textDim + "' 8.25 ([System.Drawing.FontStyle]::Regular)",
  "$h.Location=New-Object System.Drawing.Point(26,616)",
  "$bd=New-Object System.Windows.Forms.Button",
  "$bd.Text='拒 绝'; $bd.FlatStyle='Flat'; $bd.FlatAppearance.BorderSize=0",
  "$bd.BackColor=C '" + THEME.denyBg + "'; $bd.ForeColor=C '" + THEME.riskHigh + "'",
  "$bd.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75,[System.Drawing.FontStyle]::Bold)",
  "$bd.Size=New-Object System.Drawing.Size(130,42); $bd.Location=New-Object System.Drawing.Point(396,606); $bd.Cursor='Hand'",
  "Round $bd 10",
  "$ba=New-Object System.Windows.Forms.Button",
  "$ba.Text='允许执行'; $ba.FlatStyle='Flat'; $ba.FlatAppearance.BorderSize=0",
  "$ba.BackColor=C '" + THEME.accent + "'; $ba.ForeColor=C '#FFFFFF'",
  "$ba.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75,[System.Drawing.FontStyle]::Bold)",
  "$ba.Size=New-Object System.Drawing.Size(130,42); $ba.Location=New-Object System.Drawing.Point(546,606); $ba.Cursor='Hand'",
  "Round $ba 10",
  "$f.Controls.AddRange(@($t,$badge,$cl,$card,$b,$sep,$h,$bd,$ba))",
  "$f.Tag='deny'",
  "$ba.Add_Click({$f.Tag='allow';$f.Close()})",
  "$bd.Add_Click({$f.Tag='deny';$f.Close()})",
  "$f.AcceptButton=$bd",
  // 强制可见 + 深色标题栏 + Win11 窗口圆角
  "[void]$f.Handle",
  "try{ [ARDwm]::ShowWindow($f.Handle,5) | Out-Null }catch{}",
  "$f.Add_Shown({ try{ $dark=1; [ARDwm]::DwmSetWindowAttribute($f.Handle,20,[ref]$dark,4); $cr=2; [ARDwm]::DwmSetWindowAttribute($f.Handle,33,[ref]$cr,4); $f.Activate() } catch {} })",
  // ShowWindow(SW_SHOW) 兜底强制显示后，WinForms 可能因消息时序把窗体标记为"已可见"，
  // ShowDialog 对已可见窗体会抛 InvalidOperationException 直接杀进程（表现为窗口闪退）——
  // 此时窗体已在屏幕上，降级为 Application::Run 手动消息循环，窗口关闭即返回，退出码契约不变
  "try{ [void]$f.ShowDialog() } catch { try{ [System.Windows.Forms.Application]::Run($f) }catch{} }",
  "switch($f.Tag){'allow'{exit 0}default{exit 1}}",
].join("\n");

/**
 * 函数功能: 弹出深色主题审查对话框并阻塞等待用户操作（无超时，直到用户决策）
 * @param {string} title - 对话框标题
 * @param {string} command - 待审查命令全文
 * @param {string} reason - 审查分析全文
 * @returns {"allow"|"deny"|"timeout"} 用户选择；仅基础设施故障返回 timeout
 */
function askUserViaDialog(title, command, reason) {
  if (process.platform !== "win32") {
    return "timeout";
  }
  const t_parsed = parseReasonForDialog(reason);
  try {
    const t_result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", DIALOG_PS_SCRIPT],
      {
        env: {
          ...process.env,
          AR_TITLE: title,
          AR_CMD: command || "(未知命令)",
          AR_RISK: t_parsed.risk,
          AR_ANALYSIS: t_parsed.analysis,
          AR_RISKS: t_parsed.risks.join("\n"),
          AR_SCOPE: t_parsed.scope || "",
          AR_PLAIN: t_parsed.plain,
        },
        timeout: DIALOG_HARD_LIMIT_MS,
        windowsHide: true,
      },
    );
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
  parseReasonForDialog,
  THEME,
  DIALOG_PS_SCRIPT,
};
