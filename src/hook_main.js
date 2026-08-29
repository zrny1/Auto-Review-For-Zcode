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
import { emitDecision, emitCrash, ACTION_ASK } from "./decision.js";
import { logWrite } from "./common.js";
import { compressReasonForToast, notifyAsk } from "./toast.js";
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

  // ask 决策先派发桌面通知：客户端同向叠加路径下审批框不渲染 hook 文本，
  // 通知是唯一稳定"决策时可见"的分析通道；派发不阻塞（分离进程），失败不影响决策
  if (t_decision.action === ACTION_ASK && !process.env.AUTO_REVIEW_DISABLE_TOAST) {
    try {
      const t_settings = loadSettings();
      if (t_settings.toast_on_ask !== false) {
        const t_command = t_input && t_input.tool_input && typeof t_input.tool_input.command === "string"
          ? t_input.tool_input.command.replace(/\s+/g, " ").slice(0, 60)
          : "";
        const t_compressed = compressReasonForToast(t_decision.reason);
        notifyAsk(
          `[auto-review] 需人工确认${t_command ? ": " + t_command : ""}`,
          t_compressed.line1,
          t_compressed.line2,
        );
      }
    } catch {
      // 通知失败静默：决策输出不受影响
    }
  }

  emitDecision(t_decision);
}

// 最外层兜底：未知异常阻断（exit 2），宁可打断工作流也不带病放行
main().catch((t_error) => {
  logWrite("ERROR", "hook", `未捕获异常: ${t_error && t_error.stack ? t_error.stack.split("\n")[0] : String(t_error)}`);
  emitCrash(t_error && t_error.message ? t_error.message : "未知异常");
});
