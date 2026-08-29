/**
 * 模块功能: hook 输出协议封装——把内部决策映射为 PreToolUse 的 stdout JSON / exit code
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 输出 schema 是唯一与客户端耦合的点，字段名如与严格校验不符只需改本文件；
 *       stdout 必须只有协议 JSON 或完全为空，任何杂散输出都会破坏协议
 * 功能:
 *   - 内部动作 pass/allow/ask/deny 到协议的映射
 *   - claude 风格（hookSpecificOutput 包装，默认）与 simple 风格（集成期排查用）
 * 依赖: ./common.js
 * 更新日期: 2026年08月29日
 */

import {
  OUTPUT_STYLE_CLAUDE,
  OUTPUT_STYLE_SIMPLE,
} from "./common.js";

// 内部决策动作：pass 表示不干预（交回内置权限流程），其余三个为显式权限决策
const ACTION_PASS = "pass";
const ACTION_ALLOW = "allow";
const ACTION_ASK = "ask";
const ACTION_DENY = "deny";

// exit code 2 在 PreToolUse 语义下是阻断，作为内部崩溃时的最终防线
const EXIT_PASS = 0;
const EXIT_BLOCK = 2;

/**
 * 函数功能: 输出决策并结束进程
 * @param {{action: string, reason: string}} decision - 内部决策对象
 * @returns {void} 进程直接退出
 */
function emitDecision(decision) {
  // pass = 不干预：空输出 + exit 0，客户端按内置权限流程继续
  if (decision.action === ACTION_PASS) {
    process.exit(EXIT_PASS);
  }

  const t_style = process.env.AUTO_REVIEW_OUTPUT_STYLE === OUTPUT_STYLE_SIMPLE ? OUTPUT_STYLE_SIMPLE : OUTPUT_STYLE_CLAUDE;
  let t_payload;
  if (t_style === OUTPUT_STYLE_SIMPLE) {
    t_payload = { decision: decision.action, reason: decision.reason };
  } else {
    t_payload = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.action,
        permissionDecisionReason: decision.reason,
        // 客户端在"模式已 ask + hook ask"时不渲染 reason（fTr 合并丢弃），
        // additionalContext 是把审查分析送进主 agent 上下文的唯一通道
        ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
        // updatedInput 在权限判定前生效（审批框渲染改写后的输入）：
        // 把分析注入 Bash 的 description（纯展示字段，不影响命令执行），让用户决策时可见
        ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
      },
    };
  }
  process.stdout.write(JSON.stringify(t_payload));
  process.exit(EXIT_PASS);
}

/**
 * 函数功能: 内部崩溃时的最终防线——阻断而非放行
 * @param {string} message - 崩溃原因（写入 stderr 供诊断，不污染 stdout 协议）
 * @returns {void} 进程以 exit 2 退出
 */
function emitCrash(message) {
  process.stderr.write(`[auto-review] 内部错误: ${message}\n`);
  process.exit(EXIT_BLOCK);
}

export {
  ACTION_PASS,
  ACTION_ALLOW,
  ACTION_ASK,
  ACTION_DENY,
  emitDecision,
  emitCrash,
};
