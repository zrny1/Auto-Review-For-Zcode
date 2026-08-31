/**
 * 模块功能: PreToolUse hook 入口——stdin 读取 hook JSON，输出权限决策
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: hooks.json 以 process 方式启动本文件（node src/hook_main.js）；
 *       stdout 只允许协议 JSON 或空（决策协议见 decision.js）；
 *       最外层兜底：任何未知异常以 exit 2 阻断，绝不放行
 * 功能:
 *   - stdin 全量读取与容错解析
 *   - 调用审查管线并输出决策
 *   - 对话框三态裁决映射：允许 / 本次对话允许（写会话白名单）/ 拒绝
 * 依赖: ./reviewer.js ./decision.js ./common.js ./dialog.js ./settings.js
 * 更新日期: 2026年08月31日
 */

import { reviewToolUse, addSessionAllowlist } from "./reviewer.js";
import { emitDecision, emitCrash, ACTION_ALLOW, ACTION_ASK, ACTION_DENY } from "./decision.js";
import { logWrite } from "./common.js";
import { askUserViaDialog } from "./dialog.js";
import { loadSettings } from "./settings.js";

/**
 * 函数功能: 全量读取 stdin（hook 输入一次性传入，无流式交互）
 * @returns {Promise<string>} stdin 的完整文本
 */
function readStdinAll() {
  return new Promise((resolve, reject) => {
    const t_chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (t_chunk) => t_chunks.push(t_chunk));
    process.stdin.on("end", () => resolve(t_chunks.join("")));
    process.stdin.on("error", reject);
  });
}

/**
 * 函数功能: 主流程：stdin → JSON → 审查管线 → 决策输出
 * @returns {Promise<void>}
 */
async function main() {
  const t_raw = await readStdinAll();

  // 空输入或非 JSON：无法确认要审查什么，按不干预处理（交回内置流程），记录以便排查
  if (!t_raw.trim()) {
    logWrite("WARN", "hook", "stdin 为空，跳过审查");
    emitDecision({ action: "pass", reason: "" });
    return;
  }
  let t_input;
  try {
    t_input = JSON.parse(t_raw);
  } catch {
    logWrite("WARN", "hook", `stdin 非合法 JSON（前 80 字符: ${t_raw.slice(0, 80).replace(/\s+/g, " ")}），跳过审查`);
    emitDecision({ action: "pass", reason: "" });
    return;
  }

  const t_decision = await reviewToolUse(t_input);

  // ask 决策改为插件自有审批框：客户端同向叠加路径不渲染 hook 文本且无法操纵其 UI，
  // 由用户在本对话框中直接裁决——允许→hook allow（客户端自动放行）、拒绝→hook deny（阻断）；
  // 对话框无超时，直到用户决策（关闭窗口按拒绝）；仅基础设施故障回落客户端原生框。
  // 远程模式（手机控制主机）下本机对话框用户看不到：当前客户端未向 hook 提供任何远程
  // 会话标记（已核查 hook 输入/数据表/querySource 枚举），预留信号检测——输入一旦携带
  // querySource/remote 字样即自动跳过对话框走客户端原生审批（远程可达）
  const t_remote_hint = String((t_input && (t_input.querySource || t_input.source)) || "");
  const t_remote_active = /remote|web/i.test(t_remote_hint);
  if (t_decision.action === ACTION_ASK && !process.env.AUTO_REVIEW_DISABLE_DIALOG) {
    try {
      const t_settings = loadSettings();
      if (t_settings.dialog_on_ask === false || t_remote_active) {
        if (t_remote_active) {
          logWrite("INFO", "dialog", "检测到远程会话标记，跳过对话框走客户端审批");
        }
        // 保持 ask：由客户端原生审批（本地=客户端框；远程=手机端请求）
      } else {
        const t_command = t_input && t_input.tool_input && typeof t_input.tool_input.command === "string"
          ? t_input.tool_input.command
          : "";
        const t_choice = askUserViaDialog("[auto-review] 人工审查", t_command, t_decision.reason);
        if (t_choice === "allow") {
          logWrite("INFO", "dialog", `用户允许: ${t_command.replace(/\s+/g, " ").slice(0, 80)}`);
          t_decision.action = ACTION_ALLOW;
          t_decision.reason = `${t_decision.reason}\n(用户已在 auto-review 审查对话框中批准)`;
          delete t_decision.additionalContext;
        } else if (t_choice === "session") {
          // 本次对话允许：写入会话白名单后按 allow 放行；写盘失败降级为一次性放行，
          // 用户的点击决策本身不能因存储故障被推翻
          logWrite("INFO", "dialog", `用户允许(本次对话): ${t_command.replace(/\s+/g, " ").slice(0, 80)}`);
          if (!addSessionAllowlist(t_input && t_input.session_id, t_input && (t_input.tool_name || t_input.toolName), t_input && t_input.tool_input)) {
            logWrite("WARN", "dialog", "会话白名单写入失败，本次按一次性放行处理");
          }
          t_decision.action = ACTION_ALLOW;
          t_decision.reason = `${t_decision.reason}\n(用户已选择「本次会话允许」：同一指令在本对话内后续不再询问)`;
          delete t_decision.additionalContext;
        } else if (t_choice === "deny") {
          logWrite("INFO", "dialog", `用户拒绝: ${t_command.replace(/\s+/g, " ").slice(0, 80)}`);
          t_decision.action = ACTION_DENY;
          t_decision.reason = `[auto-review] 用户在审查对话框中拒绝了该操作。\n${t_decision.reason}`;
          delete t_decision.additionalContext;
        } else {
          logWrite("WARN", "dialog", "对话框基础设施故障，回落客户端审批");
        }
      }
    } catch (t_error) {
      // 对话框故障回落客户端审批，绝不因 UI 问题放行
      logWrite("WARN", "dialog", `对话框异常回落: ${t_error.message}`);
    }
  }

  emitDecision(t_decision);
}

// 最外层兜底：未知异常阻断（exit 2），宁可打断工作流也不带病放行
main().catch((t_error) => {
  logWrite("ERROR", "hook", `未捕获异常: ${t_error && t_error.stack ? t_error.stack.split("\n")[0] : String(t_error)}`);
  emitCrash(t_error && t_error.message ? t_error.message : "未知异常");
});
