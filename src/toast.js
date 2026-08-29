/**
 * 模块功能: Windows 桌面通知——ask 决策时把审查分析推送为系统 Toast（用户决策时可见）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 客户端审批框在"policy 已 ask + hook ask"的同向叠加路径不渲染任何 hook 文本
 *       （reason 被合并丢弃、description 字段不展示），唯一可靠的决策时可见通道是
 *       在 hook 返回前发出系统通知——通知先于/同于审批框出现，先于用户点击
 * 功能:
 *   - compressReasonForToast: 把多行 reason 压缩成通知的两行文本
 *   - notifyAsk: 分离进程启动 PowerShell(WinRT Toast)，不阻塞 hook 决策输出
 * 依赖: node:child_process
 * 更新日期: 2026年08月29日
 */

import { spawn } from "node:child_process";

// 通知正文每行的字符上限（ToastText04 模板两行正文，过长会被系统截断）
const TOAST_LINE_MAX_CHARS = 180;

// PowerShell 的 AUMID：通知系统要求已注册的 AppId，借用 PowerShell 的注册项，
// 避免自定义 AUMID 在部分 Windows 版本被静默丢弃
const TOAST_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

// WinRT Toast 脚本：文本经环境变量传入，规避任何引号转义问题；duration=long 保持约 25 秒
const TOAST_PS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
  "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText04)",
  "$t.DocumentElement.SetAttribute('duration','long')",
  "$n=$t.GetElementsByTagName('text')",
  "$n.Item(0).AppendChild($t.CreateTextNode($env:AR_TITLE))|Out-Null",
  "$n.Item(1).AppendChild($t.CreateTextNode($env:AR_LINE1))|Out-Null",
  "$n.Item(2).AppendChild($t.CreateTextNode($env:AR_LINE2))|Out-Null",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + TOAST_APP_ID + "').Show([Windows.UI.Notifications.ToastNotification]::new($t))",
].join("; ");

/**
 * 函数功能: 把多行审查 reason 压缩为通知的两行正文
 * @param {string} reason - 完整三段式 reason（可能多行）
 * @returns {{line1: string, line2: string}} 通知正文两行
 */
function compressReasonForToast(reason) {
  const t_lines = String(reason || "").split("\n").map((t_line) => t_line.trim()).filter(Boolean);
  const t_head = t_lines[0] || "";
  // 风险点行（"- xxx"）合并为一行；影响范围行单列
  const t_risks = t_lines.filter((t_line) => t_line.startsWith("-")).map((t_line) => t_line.slice(1).trim());
  const t_scope = t_lines.find((t_line) => t_line.startsWith("影响范围:")) || "";
  const t_truncate = (t_text) => (t_text.length > TOAST_LINE_MAX_CHARS ? t_text.slice(0, TOAST_LINE_MAX_CHARS - 1) + "…" : t_text);
  const t_line1 = t_head;
  const t_parts = [];
  if (t_risks.length > 0) {
    t_parts.push("风险点: " + t_risks.join("；"));
  }
  if (t_scope) {
    t_parts.push(t_scope);
  }
  return { line1: t_truncate(t_line1), line2: t_truncate(t_parts.join(" ｜ ")) };
}

/**
 * 函数功能: 发出 ask 决策的系统通知（分离进程，不阻塞 hook 输出与退出）
 * @param {string} title - 通知标题
 * @param {string} line1 - 正文第一行（风险级别+分析）
 * @param {string} line2 - 正文第二行（风险点+影响范围汇总）
 * @returns {boolean} 是否成功派发（非 Windows 平台返回 false）
 */
function notifyAsk(title, line1, line2) {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const t_child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_PS_SCRIPT], {
      env: { ...process.env, AR_TITLE: title, AR_LINE1: line1, AR_LINE2: line2 },
      detached: true,
      stdio: "ignore",
    });
    t_child.unref();
    return true;
  } catch {
    // 通知是辅助通道，失败绝不影响决策输出
    return false;
  }
}

export {
  compressReasonForToast,
  notifyAsk,
};
