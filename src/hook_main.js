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
 * 依赖: ./reviewer.js ./decision.js ./common.js
 * 更新日期: 2026年08月29日
 */

import { reviewToolUse } from "./reviewer.js";
import { emitDecision, emitCrash, ACTION_ALLOW, ACTION_ASK, ACTION_DENY } from "./decision.js";
import { logWrite } from "./common.js";
import { askUserViaDialog, DIALOG_TIMEOUT_SECONDS } from "./dialog.js";
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
  // 由用户在本对话框中直接裁决——允许→hook allow（客户端自动放行）、拒绝→hook deny（阻断）、
  // 超时/失败→保持 ask（回落客户端原生框，优雅退化）
  if (t_decision.action === ACTION_ASK && !process.env.AUTO_REVIEW_DISABLE_DIALOG) {
    try {
      const t_settings = loadSettings();
      if (t_settings.dialog_on_ask !== false) {
        const t_command = t_input && t_input.tool_input && typeof t_input.tool_input.command === "string"
          ? t_input.tool_input.command
          : "";
        const t_body = `【待审查命令】\n${t_command || "(未知)"}\n\n${t_decision.reason}`;
        const t_choice = askUserViaDialog(
          "[auto-review] 人工审查",
          t_body,
          DIALOG_TIMEOUT_SECONDS,
        );
        if (t_choice === "allow") {
          logWrite("INFO", "dialog", `用户允许: ${t_command.replace(/\s+/g, " ").slice(0, 80)}`);
          t_decision.action = ACTION_ALLOW;
          t_decision.reason = `${t_decision.reason}\n(用户已在 auto-review 审查对话框中批准)`;
          delete t_decision.additionalContext;
        } else if (t_choice === "deny") {
          logWrite("INFO", "dialog", `用户拒绝: ${t_command.replace(/\s+/g, " ").slice(0, 80)}`);
          t_decision.action = ACTION_DENY;
          t_decision.reason = `[auto-review] 用户在审查对话框中拒绝了该操作。\n${t_decision.reason}`;
          delete t_decision.additionalContext;
        } else {
          logWrite("INFO", "dialog", `对话框超时/失败，回落客户端审批: ${t_command.replace(/\s+/g, " ").slice(0, 80)}`);
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
