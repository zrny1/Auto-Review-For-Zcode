/**
 * 模块功能: 安全审查引擎——PreToolUse 决策管线的完整编排
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 管线顺序固定"先确定性后概率性"：总开关 → 工具过滤 → 危险规则层（不经过 LLM）
 *       → 会话白名单（本次对话允许过）→ 脚本内容附加（可选）→ 缓存层 → 安全子 agent（LLM）
 *       → 失败兜底 ask；任何一层异常只会让决策更保守，不存在"出错导致放行"的路径
 * 功能:
 *   - reviewToolUse: 主入口，输入 hook JSON，输出 {action, reason, source}
 *   - 规则匹配、会话白名单、缓存读写、LLM 载荷构造、输出解析与 reason 拼装
 *   - 脚本内容附加：提取 Bash 命令引用的脚本文件并读取内容随载荷送审（inspect_scripts）
 * 依赖: node:crypto node:fs node:os node:path ./common.js ./settings.js ./provider.js
 * 更新日期: 2026年09月18日
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CACHE_FILE, SESSION_ALLOWLIST_FILE, logWrite, readJsonFile, writeFileAtomic } from "./common.js";
import { loadSettings, loadDangerRules, loadSecurityPrompt } from "./settings.js";
import { resolveProviderOverride, callLlm, ProviderError, LlmError } from "./provider.js";
import { ACTION_PASS, ACTION_ALLOW, ACTION_ASK, ACTION_DENY } from "./decision.js";

// matcher 别名在内部过滤时归一到标准工具名（ApplyPatch 即 Write/Edit 的别名）
const TOOL_ALIASES = { ApplyPatch: "Write", Task: "Agent" };

// 缓存条目上限：超限时丢弃过期项后按过期时间保留最新的一批，防止缓存文件无限增长
const MAX_CACHE_ENTRIES = 500;

// 会话白名单的会话块最大年龄：hook 输入没有会话结束信号，按时间惰性过期，
// 24h 覆盖一次长对话的正常跨度，跨天旧会话自动失效
const SESSION_MAX_AGE_MS = 24 * 3600 * 1000;

// 无 session_id 输入时的兜底分组键：无法界定对话边界，退化为共享分组（仍受 24h 过期约束）
const SESSION_FALLBACK_ID = "_default";

// 日志中命令预览长度，避免单行日志过长
const LOG_PREVIEW_CHARS = 120;

// 脚本送审的单次命令最多附加文件数：控制载荷规模，超出部分以附注说明
const MAX_SCRIPT_FILES = 3;

// 视为"脚本文件"的扩展名集合：解释器调用与裸路径执行都要求命中，防止误读普通数据文件
const SCRIPT_EXTENSIONS = new Set(["sh", "bash", "py", "pyw", "js", "mjs", "cjs", "ts", "rb", "pl", "ps1", "bat", "cmd"]);

// 命中即放弃该命令段的脚本提取：-c/-e 的代码已内联在命令文本里，-m 引用的是模块而非文件路径
const SCRIPT_INLINE_FLAGS = new Set(["-c", "-e", "-m", "--command", "--eval", "--module"]);

// 命令替换/进程替换构造：出现任一即意味着"表层文本 ≠ 实际执行内容"，
// allow 白名单只对字面命令有意义，含替换构造的文本必须降级 LLM 审查
const SUBSTITUTION_PATTERN = /`|\$\(|<\(|>\(/;

/**
 * 函数功能: 检测文本是否含命令替换/进程替换构造（反引号、$()、<()、>()）
 * @param {string} text - 被检测文本
 * @returns {boolean} 含替换构造返回 true（引号内的替换在 shell 中同样会执行，不区分位置）
 */
function hasCommandSubstitution(text) {
  return SUBSTITUTION_PATTERN.test(String(text || ""));
}

// 可带脚本文件参数的解释器名单（powershell 走 -File 特判，cmd 走 /c、/k 特判）
const SCRIPT_INTERPRETERS = new Set(["python", "python3", "py", "node", "deno", "bun", "bash", "sh", "zsh", "dash", "ruby", "perl", "pwsh"]);

/**
 * 函数功能: 归一化工具名（处理 matcher 别名）
 * @param {string} tool_name - hook 输入中的工具名
 * @returns {string} 标准工具名，无法识别返回空串
 */
function normalizeToolName(tool_name) {
  const t_name = String(tool_name || "").trim();
  return TOOL_ALIASES[t_name] || t_name;
}

/**
 * 函数功能: 构造某工具的"送审文本"——规则层与日志使用的核心内容
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @returns {{ruleText: string, preview: string}} 规则匹配文本与短预览；无法识别时 ruleText 为空
 */
function buildRuleText(tool_name, tool_input) {
  const t_input = tool_input && typeof tool_input === "object" ? tool_input : {};
  if (tool_name === "Bash") {
    const t_command = typeof t_input.command === "string" ? t_input.command : "";
    // 空命令无实际效果，交回内置流程即可，不值得占用一次审查
    if (!t_command.trim()) {
      return { ruleText: "", preview: "(空命令)" };
    }
    return { ruleText: t_command, preview: t_command };
  }
  if (tool_name === "Write" || tool_name === "Edit") {
    const t_path = typeof t_input.file_path === "string" ? t_input.file_path : "";
    if (!t_path) {
      return { ruleText: "", preview: "(无路径)" };
    }
    return { ruleText: t_path, preview: `${t_path} 写入` };
  }
  return { ruleText: "", preview: "(未识别工具)" };
}

/**
 * 函数功能: 危险规则层——本地正则按数组顺序匹配，首个命中生效；
 *           allow 命中在复合命令/含命令替换的文本上被抑制（复合交由逐段逻辑裁决，
 *           单段替换则继续向后扫描让 deny/ask 仍然生效——保守方向优先）
 * @param {string} rule_text - 被匹配文本（命令全文或目标路径）
 * @returns {object|null} 命中的决策 {action, reason, source}，未命中返回 null
 */
function matchDangerRules(rule_text) {
  if (!rule_text) {
    return null;
  }
  // allow 抑制条件：复合命令（全文以白名单命令开头不代表其余子命令安全，防 "ls; rm -rf x"）
  // 或含命令替换构造（防 "ls $(rm -rf x)"——替换在引号内外都会执行，字面量不能作保）
  const t_is_compound = splitTopLevelCommands(rule_text).length > 1;
  const t_has_subst = hasCommandSubstitution(rule_text);
  let t_rule = null;
  for (const t_candidate of loadDangerRules()) {
    if (!t_candidate.regex.test(rule_text)) {
      continue;
    }
    if (t_candidate.action === ACTION_ALLOW && (t_is_compound || t_has_subst)) {
      if (t_is_compound) {
        // 复合命令直接放弃全文裁决，交由 matchCompoundRules 逐段判定（reason 能指出命中子命令）
        return null;
      }
      // 单段替换：跳过该 allow 继续向后扫描 deny/ask
      continue;
    }
    t_rule = t_candidate;
    break;
  }
  if (!t_rule) {
    return null;
  }
  // allow 规则禁止作用于复合命令全文：全文以白名单命令开头不代表其余子命令安全
  // （防 "ls; rm -rf x" 绕过），也禁止作用于含命令替换的文本（防 "ls $(rm -rf x)" 绕过——
  // 替换构造在引号内外都会执行，表层字面量不能为实际执行内容作保）。
  // 复合命令与含替换文本的放行只能由 matchCompoundRules 逐段确认或降级 LLM；
  // deny/ask 命中全文则维持原判定（拦截/转人工总是保守方向）
  if (t_rule.action === ACTION_ALLOW && (splitTopLevelCommands(rule_text).length > 1 || hasCommandSubstitution(rule_text))) {
    return null;
  }
  const t_desc = `危险规则 #${t_rule.index}: ${t_rule.description}`;
  const t_action = t_rule.action;
  let t_reason;
  if (t_action === ACTION_DENY) {
    t_reason = `[auto-review] 已拦截（${t_desc}）。如需放行请调整规则: /danger-rules list`;
  } else if (t_action === ACTION_ALLOW) {
    t_reason = `[auto-review] 白名单放行（${t_desc}）`;
  } else {
    t_reason = `[auto-review] ${t_desc}\n该操作命中你设置的转人工规则，请确认。`;
  }
  // ask 的 reason 在客户端"模式已 ask"时不进审批框，同步走 additionalContext 送入主 agent 上下文
  const t_extra = t_action === ACTION_ASK ? { additionalContext: t_reason } : {};
  return { action: t_action, reason: t_reason, source: "rule", ...t_extra };
}

/**
 * 函数功能: 对单段文本按数组顺序扫描规则，返回首个命中的规则；allow 命中在文本含
 *           命令替换构造时被抑制（跳过继续向后找 deny/ask——拦截方向总是保守的，
 *           白名单不能替替换内容作保）
 * @param {string} text - 被匹配文本（单段命令）
 * @returns {object|null} 命中的规则定义（含编译好的 regex/action/description/index）
 */
function scanRules(text) {
  if (!text) {
    return null;
  }
  const t_suppress_allow = hasCommandSubstitution(text);
  for (const t_rule of loadDangerRules()) {
    if (!t_rule.regex.test(text)) {
      continue;
    }
    if (t_rule.action === ACTION_ALLOW && t_suppress_allow) {
      continue;
    }
    return t_rule;
  }
  return null;
}

/**
 * 函数功能: 顶层命令分割——按 ; && || | 换行 切分复合命令
 * @param {string} text - 命令全文
 * @returns {string[]} 非空子命令列表；引号内与 $() / 反引号命令替换内的分隔符不参与切分
 */
function splitTopLevelCommands(text) {
  const t_subs = [];
  let t_cur = "";
  let t_single = false;
  let t_double = false;
  let t_backtick = false;
  let t_dollar_depth = 0;
  for (let t_i = 0; t_i < text.length; t_i++) {
    const t_ch = text[t_i];
    // 转义字符连同其后字符原样保留
    if (t_i > 0 && text[t_i - 1] === "\\" && t_ch !== text[t_i - 1]) {
      t_cur += t_ch;
      continue;
    }
    if (t_single) {
      if (t_ch === "'") t_single = false;
      t_cur += t_ch;
      continue;
    }
    if (t_double) {
      if (t_ch === '"') t_double = false;
      t_cur += t_ch;
      continue;
    }
    if (t_backtick) {
      if (t_ch === "`") t_backtick = false;
      t_cur += t_ch;
      continue;
    }
    if (t_ch === "'") { t_single = true; t_cur += t_ch; continue; }
    if (t_ch === '"') { t_double = true; t_cur += t_ch; continue; }
    if (t_ch === "`") { t_backtick = true; t_cur += t_ch; continue; }
    if (t_ch === "$" && text[t_i + 1] === "(") {
      // 一次消费 "$(" 两个字符并把深度置 1，保证闭合 ")" 恰好归零
      t_dollar_depth = 1;
      t_cur += "$(";
      t_i++;
      continue;
    }
    if (t_dollar_depth > 0) {
      if (t_ch === "(") t_dollar_depth++;
      if (t_ch === ")") t_dollar_depth--;
      t_cur += t_ch;
      continue;
    }
    if (t_ch === ";" || t_ch === "\n" || t_ch === "|") {
      t_subs.push(t_cur);
      t_cur = "";
      continue;
    }
    if (t_ch === "&") {
      // && 与单个 &（后台执行）均为命令边界
      t_subs.push(t_cur);
      t_cur = "";
      if (text[t_i + 1] === "&") t_i++;
      continue;
    }
    t_cur += t_ch;
  }
  t_subs.push(t_cur);
  return t_subs.map((t_sub) => t_sub.trim()).filter(Boolean);
}

/**
 * 函数功能: 把单段命令按空白切分为 token（引号内的空白不切分，引号本身剥离）
 * @param {string} segment - 单段命令文本
 * @returns {string[]} token 列表
 */
function tokenizeSegment(segment) {
  const t_tokens = [];
  let t_cur = "";
  let t_quote = "";
  for (const t_ch of String(segment || "")) {
    if (t_quote) {
      if (t_ch === t_quote) {
        t_quote = "";
      } else {
        t_cur += t_ch;
      }
      continue;
    }
    if (t_ch === "'" || t_ch === '"') {
      t_quote = t_ch;
      continue;
    }
    if (/\s/.test(t_ch)) {
      if (t_cur) {
        t_tokens.push(t_cur);
        t_cur = "";
      }
      continue;
    }
    t_cur += t_ch;
  }
  if (t_cur) {
    t_tokens.push(t_cur);
  }
  return t_tokens;
}

/**
 * 函数功能: 判断 token 是否为已知扩展名的脚本文件路径
 * @param {string} token - 命令中的单个 token
 * @returns {boolean} 是否脚本路径
 */
function isScriptPath(token) {
  const t_clean = String(token || "").trim();
  const t_dot = t_clean.lastIndexOf(".");
  if (t_dot <= 0) {
    return false;
  }
  return SCRIPT_EXTENSIONS.has(t_clean.slice(t_dot + 1).toLowerCase());
}

/**
 * 函数功能: 从单段命令的 token 序列中提取脚本文件引用
 * @param {string[]} tokens - tokenizeSegment 的输出
 * @returns {string|null} 脚本路径引用（原始文本），无匹配返回 null
 */
function extractRefFromSegment(tokens) {
  const t_head = String(tokens[0] || "").toLowerCase();
  // powershell/pwsh 的 -File <path>：显式脚本入口
  if (t_head === "powershell" || t_head === "pwsh") {
    for (let t_i = 1; t_i < tokens.length - 1; t_i++) {
      if (tokens[t_i].toLowerCase() === "-file" && isScriptPath(tokens[t_i + 1])) {
        return tokens[t_i + 1];
      }
    }
    return null;
  }
  // cmd 的 /c、/k <path>：批处理入口
  if (t_head === "cmd") {
    for (let t_i = 1; t_i < tokens.length - 1; t_i++) {
      const t_flag = tokens[t_i].toLowerCase();
      if ((t_flag === "/c" || t_flag === "/k") && isScriptPath(tokens[t_i + 1])) {
        return tokens[t_i + 1];
      }
    }
    return null;
  }
  // 裸脚本路径执行（./x.sh、x.py 直接作为段首命令）
  if (isScriptPath(tokens[0])) {
    return tokens[0];
  }
  // 解释器调用：跳过选项，取第一个非选项 token；内联/模块标志出现则整段放弃
  if (SCRIPT_INTERPRETERS.has(t_head)) {
    for (let t_i = 1; t_i < tokens.length; t_i++) {
      const t_token = tokens[t_i];
      const t_lower = t_token.toLowerCase();
      if (t_token.startsWith("-")) {
        if (SCRIPT_INLINE_FLAGS.has(t_lower) || SCRIPT_INLINE_FLAGS.has(t_lower.split("=")[0])) {
          return null;
        }
        continue;
      }
      return isScriptPath(t_token) ? t_token : null;
    }
  }
  return null;
}

/**
 * 函数功能: 从 Bash 命令全文中提取全部脚本文件引用（复合命令逐段提取、去重、保持顺序）
 * @param {string} command - 命令全文
 * @returns {string[]} 脚本路径引用列表（原始文本）
 */
function extractScriptRefs(command) {
  const t_refs = [];
  const t_seen = new Set();
  for (const t_segment of splitTopLevelCommands(String(command || ""))) {
    const t_tokens = tokenizeSegment(t_segment);
    if (t_tokens.length === 0) {
      continue;
    }
    const t_ref = extractRefFromSegment(t_tokens);
    if (t_ref && !t_seen.has(t_ref)) {
      t_seen.add(t_ref);
      t_refs.push(t_ref);
    }
  }
  return t_refs;
}

/**
 * 函数功能: 展开 ~ 前缀为用户主目录（跨平台），其余路径原样返回
 * @param {string} ref - 命令中的路径引用
 * @returns {string} 展开后的路径
 */
function expandTilde(ref) {
  if (ref === "~") {
    return os.homedir();
  }
  if (ref.startsWith("~/") || ref.startsWith("~\\")) {
    return path.join(os.homedir(), ref.slice(2));
  }
  return ref;
}

/**
 * 函数功能: 读取命令引用的脚本文件内容，构造送审附件（任何失败只降级为"不附加该文件"）
 * @param {string} command - Bash 命令全文
 * @param {string} cwd - 相对路径的解析基准目录（hook 输入的 cwd 回落进程 cwd）
 * @param {object} settings - 运行时配置（script_max_bytes 已在加载时钳制）
 * @returns {{files: Array<{ref: string, path: string, content: string, truncated: boolean, total_bytes: number}>, notes: string[]}|null}
 *          附件对象；无任何引用或整体异常返回 null
 */
function collectScriptAttachments(command, cwd, settings) {
  try {
    const t_refs = extractScriptRefs(command);
    if (t_refs.length === 0) {
      return null;
    }
    const t_max_bytes = Math.max(1, Number(settings && settings.script_max_bytes) || 16000);
    const t_base_dir = String(cwd || "").trim() || process.cwd();
    const t_files = [];
    const t_notes = [];
    for (const t_ref of t_refs) {
      if (t_files.length >= MAX_SCRIPT_FILES) {
        t_notes.push(`引用脚本超过 ${MAX_SCRIPT_FILES} 个，其余未附加`);
        break;
      }
      const t_full = path.resolve(t_base_dir, expandTilde(t_ref));
      try {
        const t_stat = fs.statSync(t_full);
        if (!t_stat.isFile()) {
          t_notes.push(`${t_ref}: 非普通文件，未附加`);
          continue;
        }
        let t_content;
        let t_truncated = false;
        if (t_stat.size > t_max_bytes) {
          const t_fd = fs.openSync(t_full, "r");
          try {
            const t_buf = Buffer.alloc(t_max_bytes);
            const t_read = fs.readSync(t_fd, t_buf, 0, t_max_bytes, 0);
            t_content = t_buf.subarray(0, t_read).toString("utf8");
          } finally {
            fs.closeSync(t_fd);
          }
          t_truncated = true;
        } else {
          t_content = fs.readFileSync(t_full, "utf8");
        }
        // 二进制内容对审查无意义且浪费载荷：NUL 字节在前 8K 出现即跳过
        if (t_content.slice(0, 8192).includes("\0")) {
          t_notes.push(`${t_ref}: 二进制文件，未附加`);
          continue;
        }
        t_files.push({ ref: t_ref, path: t_full, content: t_content, truncated: t_truncated, total_bytes: t_stat.size });
      } catch (t_error) {
        // 详细原因进日志即可，给 LLM 的附注不携带本机错误细节
        logWrite("WARN", "script", `读取脚本失败 ${t_ref}: ${t_error.message}`);
        t_notes.push(`${t_ref}: 无法读取，未附加`);
      }
    }
    if (t_files.length === 0 && t_notes.length === 0) {
      return null;
    }
    logWrite("INFO", "script", `脚本送审 ${t_files.length} 个文件: ${t_files.map((t_f) => t_f.ref).join("、").slice(0, LOG_PREVIEW_CHARS) || "(全部失败)"}`);
    return { files: t_files, notes: t_notes };
  } catch (t_error) {
    // 附加功能自身故障绝不影响决策：按无附件继续走原管线
    logWrite("WARN", "script", `脚本附加异常: ${t_error.message}`);
    return null;
  }
}

/**
 * 函数功能: 计算附件的缓存加盐串（文件路径 + 内容摘要 + 附注），空附件返回空串
 * @param {object|null} attachments - collectScriptAttachments 的返回值
 * @returns {string} 加盐串
 */
function hashAttachments(attachments) {
  if (!attachments) {
    return "";
  }
  const t_parts = [];
  for (const t_file of attachments.files || []) {
    t_parts.push(`${t_file.path}:${createHash("sha256").update(t_file.content).digest("hex")}`);
  }
  for (const t_note of attachments.notes || []) {
    t_parts.push(`note:${t_note}`);
  }
  return t_parts.join("|");
}

/**
 * 函数功能: 复合命令的逐段规则审查——每段独立匹配，任一段命中 deny/ask 即整体生效，
 *           全部段命中 allow 且无任何段含命令替换构造才整体放行，其余情况返回 null
 *           降级 LLM 审查完整命令。防止 allow 规则（如 ^ls\b）放行 "ls; rm -rf x"
 *           这类以白名单命令开头的复合命令，以及 "ls $(危险命令)" 这类单段替换绕过
 * @param {string} rule_text - 命令全文
 * @returns {object|null} 命中的决策 {action, reason}，需要 LLM 审查时返回 null
 */
function matchCompoundRules(rule_text) {
  const t_subs = splitTopLevelCommands(rule_text);
  if (t_subs.length <= 1) {
    return null;
  }
  const t_hits = t_subs.map((t_sub) => ({ sub: t_sub, rule: scanRules(t_sub) }));
  const t_short = (t_sub) => t_sub.replace(/\s+/g, " ").slice(0, 80);

  const t_deny_hit = t_hits.find((t_item) => t_item.rule && t_item.rule.action === ACTION_DENY);
  if (t_deny_hit) {
    return {
      action: ACTION_DENY,
      reason: `[auto-review] 已拦截：复合命令的子命令「${t_short(t_deny_hit.sub)}」命中（危险规则 #${t_deny_hit.rule.index}: ${t_deny_hit.rule.description}）。任一子命令命中 deny 即整体拦截。`,
    };
  }
  const t_ask_hit = t_hits.find((t_item) => t_item.rule && t_item.rule.action === ACTION_ASK);
  if (t_ask_hit) {
    const t_reason = `[auto-review] 复合命令的子命令「${t_short(t_ask_hit.sub)}」命中（危险规则 #${t_ask_hit.rule.index}: ${t_ask_hit.rule.description}），整条命令转人工确认。`;
    return { action: ACTION_ASK, reason: t_reason, additionalContext: t_reason };
  }
  const t_unmatched = t_hits.filter((t_item) => !t_item.rule);
  if (t_unmatched.length === 0) {
    // 任一段含命令替换构造（$()/反引号/进程替换）时整体不放行：替换内容不参与逐段
    // 规则匹配，字面命中 allow 不能为其实际执行内容作保，降级 LLM 审查完整命令
    if (t_hits.some((t_item) => hasCommandSubstitution(t_item.sub))) {
      return null;
    }
    const t_ids = t_hits.map((t_item) => `#${t_item.rule.index}`).join("、");
    return {
      action: ACTION_ALLOW,
      reason: `[auto-review] 白名单放行：${t_hits.length} 段子命令全部命中白名单规则（${t_ids}）。`,
    };
  }
  // 存在未命中白名单的子命令：整体降级 LLM 审查（allow 不能替未覆盖的段作保）
  return null;
}

/**
 * 函数功能: 递归按键排序的稳定序列化，保证等价输入命中同一缓存键
 * @param {*} value - 任意 JSON 值
 * @returns {string} 规范化 JSON 文本
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const t_keys = Object.keys(value).sort();
  return "{" + t_keys.map((t_key) => JSON.stringify(t_key) + ":" + stableStringify(value[t_key])).join(",") + "}";
}

/**
 * 函数功能: 计算缓存键
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @param {string} [extra_salt] - 附加加盐串（如脚本附件摘要）；空串时与旧版键完全一致
 * @returns {string} sha256 十六进制摘要
 */
function computeCacheKey(tool_name, tool_input, extra_salt = "") {
  const t_base = `${tool_name}\n${stableStringify(tool_input)}`;
  return createHash("sha256").update(extra_salt ? `${t_base}\n${extra_salt}` : t_base).digest("hex");
}

/**
 * 函数功能: 读取缓存中未过期的决策
 * @param {string} key - 缓存键
 * @param {number} ttl_seconds - 有效期（秒），0 表示禁用缓存
 * @returns {object|null} {action, reason}，未命中或已过期返回 null
 */
function readCachedDecision(key, ttl_seconds) {
  if (ttl_seconds <= 0) {
    return null;
  }
  const t_cache = readJsonFile(CACHE_FILE(), {}, "cache");
  const t_entry = t_cache[key];
  if (!t_entry || typeof t_entry !== "object") {
    return null;
  }
  if (Date.now() > Number(t_entry.expires) || Number(t_entry.expires) - Date.now() > ttl_seconds * 1000 * 2) {
    return null;
  }
  if (t_entry.action !== ACTION_ALLOW && t_entry.action !== ACTION_ASK) {
    return null;
  }
  return { action: t_entry.action, reason: t_entry.reason || "" };
}

/**
 * 函数功能: 写入缓存决策（惰性清理过期项并限制总量）
 * @param {string} key - 缓存键
 * @param {object} decision - {action, reason}
 * @param {number} ttl_seconds - 有效期（秒）
 * @returns {void}
 */
function writeCachedDecision(key, decision, ttl_seconds) {
  if (ttl_seconds <= 0) {
    return;
  }
  const t_cache = readJsonFile(CACHE_FILE(), {}, "cache");
  const t_now = Date.now();
  for (const [t_k, t_v] of Object.entries(t_cache)) {
    if (!t_v || Number(t_v.expires) < t_now) {
      delete t_cache[t_k];
    }
  }
  t_cache[key] = { ...decision, expires: t_now + ttl_seconds * 1000 };
  const t_entries = Object.entries(t_cache);
  if (t_entries.length > MAX_CACHE_ENTRIES) {
    t_entries.sort((a, b) => Number(a[1].expires) - Number(b[1].expires));
    for (let t_i = 0; t_i < t_entries.length - MAX_CACHE_ENTRIES; t_i++) {
      delete t_cache[t_entries[t_i][0]];
    }
  }
  writeFileAtomic(CACHE_FILE(), JSON.stringify(t_cache));
}

/**
 * 函数功能: 读取会话白名单并惰性清理过期会话块（超龄整块删除并回写）
 * @returns {object} {session_id: {cache_key: {cmd: string, ts: number}}}
 */
function readSessionAllowlist() {
  const t_table = readJsonFile(SESSION_ALLOWLIST_FILE(), {}, "session");
  const t_now = Date.now();
  let t_expired = false;
  for (const t_sid of Object.keys(t_table)) {
    const t_block = t_table[t_sid];
    if (!t_block || typeof t_block !== "object") {
      delete t_table[t_sid];
      t_expired = true;
      continue;
    }
    // 块内任一条目的时间戳都代表该会话的最近活跃，取最大值判定整块年龄
    const t_latest = Math.max(0, ...Object.values(t_block).map((t_e) => Number(t_e && t_e.ts) || 0));
    if (t_now - t_latest > SESSION_MAX_AGE_MS) {
      delete t_table[t_sid];
      t_expired = true;
    }
  }
  if (t_expired) {
    writeFileAtomic(SESSION_ALLOWLIST_FILE(), JSON.stringify(t_table));
  }
  return t_table;
}

/**
 * 函数功能: 查询某次工具调用是否已被用户在本次对话中允许过
 * @param {string} session_id - hook 输入的会话标识，缺失时用兜底分组
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @returns {boolean} 是否命中白名单
 */
function matchSessionAllowlist(session_id, tool_name, tool_input) {
  const t_table = readSessionAllowlist();
  const t_block = t_table[String(session_id || "").trim() || SESSION_FALLBACK_ID];
  if (!t_block) {
    return false;
  }
  return Boolean(t_block[computeCacheKey(tool_name, tool_input)]);
}

/**
 * 函数功能: 把用户在对话框点选的"本次对话允许"写入会话白名单
 * @param {string} session_id - hook 输入的会话标识，缺失时用兜底分组
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @returns {boolean} 是否写入成功（失败时调用方降级为一次性放行）
 */
function addSessionAllowlist(session_id, tool_name, tool_input) {
  const t_table = readSessionAllowlist();
  const t_sid = String(session_id || "").trim() || SESSION_FALLBACK_ID;
  const t_block = t_table[t_sid] || {};
  t_block[computeCacheKey(tool_name, tool_input)] = {
    cmd: buildRuleText(normalizeToolName(tool_name), tool_input).preview.slice(0, 200),
    ts: Date.now(),
  };
  t_table[t_sid] = t_block;
  const t_ok = writeFileAtomic(SESSION_ALLOWLIST_FILE(), JSON.stringify(t_table));
  if (t_ok) {
    logWrite("INFO", "session", `会话白名单 +1 (${t_sid.slice(0, 12)}): ${t_table[t_sid][computeCacheKey(tool_name, tool_input)].cmd.replace(/\s+/g, " ").slice(0, LOG_PREVIEW_CHARS)}`);
  }
  return t_ok;
}

/**
 * 函数功能: 清空会话白名单（供 ctl 命令与用户手动重置）
 * @returns {boolean} 是否清空成功
 */
function clearSessionAllowlist() {
  return writeFileAtomic(SESSION_ALLOWLIST_FILE(), JSON.stringify({}));
}

/**
 * 函数功能: 列出会话白名单条目（供 ctl 展示）
 * @returns {Array<{session: string, cmd: string, ts: number}>} 条目列表（cmd 已预览截断）
 */
function listSessionAllowlist() {
  const t_table = readSessionAllowlist();
  const t_items = [];
  for (const [t_sid, t_block] of Object.entries(t_table)) {
    for (const t_entry of Object.values(t_block)) {
      t_items.push({
        session: t_sid,
        cmd: String((t_entry && t_entry.cmd) || "").slice(0, 120),
        ts: Number((t_entry && t_entry.ts) || 0),
      });
    }
  }
  return t_items.sort((a, b) => b.ts - a.ts);
}

/**
 * 函数功能: 从模型输出中提取平衡的第一个 JSON 对象文本（容忍围栏与前后杂文）
 * @param {string} text - 模型原始输出
 * @returns {string|null} JSON 对象文本，找不到返回 null
 */
function extractJsonObject(text) {
  const t_start = text.indexOf("{");
  if (t_start < 0) {
    return null;
  }
  let t_depth = 0;
  let t_in_string = false;
  let t_escaped = false;
  for (let t_i = t_start; t_i < text.length; t_i++) {
    const t_char = text[t_i];
    if (t_in_string) {
      if (t_escaped) {
        t_escaped = false;
      } else if (t_char === "\\") {
        t_escaped = true;
      } else if (t_char === '"') {
        t_in_string = false;
      }
      continue;
    }
    if (t_char === '"') {
      t_in_string = true;
    } else if (t_char === "{") {
      t_depth++;
    } else if (t_char === "}") {
      t_depth--;
      if (t_depth === 0) {
        return text.slice(t_start, t_i + 1);
      }
    }
  }
  return null;
}

/**
 * 函数功能: 解析并归一化安全子 agent 的审查结论
 * @param {string} llm_text - 模型原始输出
 * @returns {{decision: string, risk_level: string, analysis: string, risks: string[], scope: string}}
 * @throws {Error} 输出不可解析或缺少必需字段
 */
function parseVerdict(llm_text) {
  const t_json_text = extractJsonObject(llm_text) || "";
  let t_parsed;
  try {
    t_parsed = JSON.parse(t_json_text);
  } catch {
    throw new Error("模型输出不是合法 JSON");
  }
  if (!t_parsed || typeof t_parsed !== "object") {
    throw new Error("模型输出不是 JSON 对象");
  }
  if (t_parsed.decision !== ACTION_ALLOW && t_parsed.decision !== ACTION_ASK && t_parsed.decision !== ACTION_DENY) {
    throw new Error(`decision 字段非法: ${String(t_parsed.decision)}`);
  }
  // LLM 没有 deny 权限：显式拦截只能来自用户规则层，幻觉 deny 收敛为 ask
  const t_decision = t_parsed.decision === ACTION_DENY ? ACTION_ASK : t_parsed.decision;
  return {
    decision: t_decision,
    risk_level: String(t_parsed.risk_level || "medium"),
    analysis: String(t_parsed.analysis || "（模型未给出分析）"),
    risks: Array.isArray(t_parsed.risks) ? t_parsed.risks.map(String).slice(0, 8) : [],
    scope: String(t_parsed.scope || "（模型未给出影响范围）"),
  };
}

/**
 * 函数功能: 拼装展示给用户的审批框 reason（需求3：分析 + 风险点 + 影响范围）
 * @param {object} verdict - parseVerdict 的返回值
 * @returns {string} 多行 reason 文本
 */
function formatVerdictReason(verdict) {
  const t_lines = [
    `[auto-review] 风险级别 ${verdict.risk_level}: ${verdict.analysis}`,
  ];
  if (verdict.risks.length > 0) {
    t_lines.push("风险点:");
    for (const t_risk of verdict.risks) {
      t_lines.push(`- ${t_risk}`);
    }
  }
  t_lines.push(`影响范围: ${verdict.scope}`);
  return t_lines.join("\n");
}

/**
 * 函数功能: 构造送审载荷（截断保护 + 可选脚本附件块）
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @param {number} max_chars - 工具调用 JSON 的截断上限（附件块预算独立，不受此值约束）
 * @param {object|null} [attachments] - collectScriptAttachments 的返回值
 * @returns {string} 审查载荷文本
 */
function buildReviewPayload(tool_name, tool_input, max_chars, attachments) {
  let t_json = JSON.stringify({ tool_name, tool_input });
  if (t_json.length > max_chars) {
    t_json = t_json.slice(0, max_chars) + `…(已截断，原文 ${t_json.length} 字符)`;
  }
  let t_payload = `审查以下工具调用，只输出结论 JSON：\n${t_json}`;
  if (attachments && ((attachments.files && attachments.files.length > 0) || (attachments.notes && attachments.notes.length > 0))) {
    const t_sections = ["", "── 命令引用的脚本文件内容（auto-review 自动读取附上，结论必须结合脚本实际内容）──"];
    for (const [t_index, t_file] of attachments.files.entries()) {
      const t_size_note = t_file.truncated
        ? `已截断至前 ${t_file.content.length} 字符（原文 ${t_file.total_bytes} 字节）`
        : `${t_file.total_bytes} 字节`;
      t_sections.push(`[${t_index + 1}] ${t_file.path}（${t_size_note}）`);
      t_sections.push("```");
      t_sections.push(t_file.content);
      t_sections.push("```");
    }
    for (const t_note of attachments.notes) {
      t_sections.push(`(附注) ${t_note}`);
    }
    t_payload += "\n" + t_sections.join("\n");
  }
  return t_payload;
}

/**
 * 函数功能: 执行安全子 agent 审查（provider 解析 → LLM 调用 → 解析 → 缓存），
 *           主 provider 不可用自动切换 fallback provider，全部失败抛错由上层兜底转人工
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @param {object} settings - 运行时配置（provider/fallback_provider 等）
 * @param {object|null} [attachments] - 脚本附件（参与载荷与缓存键）
 * @returns {Promise<{action: string, reason: string}>} 决策对象
 * @throws {LlmError} 所有 provider 均失败时抛出汇总原因
 */
async function runLlmReview(tool_name, tool_input, settings, attachments) {
  const t_prompt = loadSecurityPrompt();
  const t_payload = buildReviewPayload(tool_name, tool_input, settings.max_payload_chars, attachments);
  const t_cache_key = computeCacheKey(tool_name, tool_input, hashAttachments(attachments));
  const t_script_note = attachments && attachments.files.length > 0 ? ` scripts=${attachments.files.length}` : "";

  // 主 provider 失败自动切换 fallback；解析/调用/输出解析任一失败都视为该 provider 不可用。
  // 未配置 fallback 时仅单次尝试，行为与旧版一致。
  const t_has_fallback = Boolean(String(settings.fallback_provider || "").trim());
  const t_attempts = [
    { label: "主 provider", provider: settings.provider, model: settings.model },
    ...(t_has_fallback ? [{ label: "fallback provider", provider: settings.fallback_provider, model: settings.fallback_model }] : []),
  ];
  const t_failures = [];
  for (const [t_index, t_attempt] of t_attempts.entries()) {
    try {
      const t_provider = resolveProviderOverride(settings, t_attempt.provider, t_attempt.model);
      const t_start_ms = Date.now();
      const t_raw = await callLlm(t_provider, t_prompt, t_payload);
      const t_verdict = parseVerdict(t_raw);
      const t_duration_s = ((Date.now() - t_start_ms) / 1000).toFixed(1);

      const t_decision = { action: t_verdict.decision };
      let t_reason;
      if (t_verdict.decision === ACTION_ALLOW) {
        t_reason = `[auto-review] 安全审查通过（${t_verdict.risk_level}风险，${t_duration_s}s）: ${t_verdict.analysis}`;
      } else {
        t_reason = formatVerdictReason(t_verdict);
      }
      logWrite("INFO", "llm", `${t_verdict.decision} risk=${t_verdict.risk_level} ${t_duration_s}s${t_script_note} (${t_attempt.label})`);
      // 只有 LLM 结论入缓存（规则层是即时的，且规则变更后旧缓存可能失效）；
      // 缓存键含脚本附件摘要——脚本内容变更后旧结论自动失效重新审查
      writeCachedDecision(t_cache_key, { action: t_verdict.decision, reason: t_reason }, settings.cache_ttl_seconds);
      // ask 决策双发：reason 给客户端 deny/升级路径，additionalContext 保证分析进入主 agent 上下文
      const t_extra = t_verdict.decision === ACTION_ASK ? { additionalContext: t_reason } : {};
      return { action: t_verdict.decision, reason: t_reason, ...t_extra };
    } catch (t_error) {
      const t_has_next = t_index < t_attempts.length - 1;
      t_failures.push(`${t_attempt.label}: ${t_error.message}`);
      logWrite("WARN", "llm", `${t_attempt.label} 审查失败${t_has_next ? "，切换下一个" : "，转人工"}: ${t_error.message}`);
    }
  }
  // 全部 provider 失败：抛汇总错误，由上层兜底转人工（绝不带病放行）
  throw new LlmError(t_failures.join("；"));
}

/**
 * 函数功能: 决策管线主入口（对 hook_main 暴露的唯一函数，保证不抛异常）
 * @param {object} hook_input - hook stdin 的 JSON（tool_name/tool_input，字段防御式读取）
 * @returns {Promise<{action: string, reason: string, source: string}>} 决策对象
 */
async function reviewToolUse(hook_input) {
  return reviewToolUseInner(hook_input);
}

/**
 * 函数功能: 决策管线的内部实现（六层编排与兜底）
 * @param {object} hook_input - hook stdin 的 JSON
 * @returns {Promise<{action: string, reason: string, source: string}>} 决策对象
 */
async function reviewToolUseInner(hook_input) {
  try {
    const t_settings = loadSettings();
    if (!t_settings.enabled) {
      return { action: ACTION_PASS, reason: "", source: "off" };
    }

    // 防御式读取：tool_name 与 toolName 双兼容，缺失时按未识别工具放行流程不阻断
    const t_tool_name = normalizeToolName(hook_input && (hook_input.tool_name || hook_input.toolName));
    if (!t_settings.review_tools.includes(t_tool_name)) {
      return { action: ACTION_PASS, reason: "", source: "skip" };
    }

    const t_tool_input = hook_input && hook_input.tool_input && typeof hook_input.tool_input === "object"
      ? hook_input.tool_input
      : {};
    const { ruleText: t_rule_text, preview: t_preview } = buildRuleText(t_tool_name, t_tool_input);
    const t_short = t_preview.replace(/\s+/g, " ").slice(0, LOG_PREVIEW_CHARS);

    // ③ 危险规则层：确定性、不经过 LLM（需求4）
    const t_rule_decision = matchDangerRules(t_rule_text);
    if (t_rule_decision) {
      logWrite("INFO", "rule", `${t_rule_decision.action} ${t_tool_name}: ${t_short} (${t_rule_decision.reason.split("\n")[0]})`);
      return t_rule_decision;
    }
    // ③' 复合命令逐段审查：防 allow 白名单放行 "ls; rm -rf x" 这类复合命令
    if (t_tool_name === "Bash") {
      const t_compound_decision = matchCompoundRules(t_rule_text);
      if (t_compound_decision) {
        logWrite("INFO", "rule", `${t_compound_decision.action} ${t_tool_name}: ${t_short} (复合命令逐段: ${t_compound_decision.reason.split("\n")[0]})`);
        return { ...t_compound_decision, source: "rule" };
      }
    }
    if (!t_rule_text) {
      // 送审文本为空说明输入形态异常，保守转人工
      return { action: ACTION_ASK, reason: "[auto-review] 无法解析工具输入，已转人工审查。", source: "malformed", additionalContext: "[auto-review] 无法解析工具输入，已转人工审查。" };
    }

    // ③'' 会话白名单：用户对完全相同的指令点过"本次对话允许"即放行。
    //     位于规则层之后——deny/ask 等持久规则永远优先于对话框的临时放行，
    //     防止早先放行过的复合命令绕过之后新增的子命令拦截规则；
    //     白名单键不含脚本附件——用户批准的是命令本身
    if (matchSessionAllowlist(hook_input && hook_input.session_id, t_tool_name, t_tool_input)) {
      logWrite("INFO", "session", `allow ${t_tool_name}: ${t_short} (会话白名单)`);
      return { action: ACTION_ALLOW, reason: "[auto-review] 会话白名单放行：该指令你已在本次对话中允许过。", source: "session" };
    }

    // ③.5 脚本内容附加：读取命令引用的脚本文件随载荷送审（相对路径按 hook 输入的 cwd 解析）。
    //     放在白名单之后（临时放行不因脚本内容变化失效）、缓存之前（附件摘要参与缓存键）
    let t_attachments = null;
    if (t_tool_name === "Bash" && t_settings.inspect_scripts) {
      t_attachments = collectScriptAttachments(t_rule_text, String((hook_input && hook_input.cwd) || ""), t_settings);
    }

    // ④ 缓存层：相同调用短期内复用结论，降低延迟与 token 消耗
    const t_cache_key = computeCacheKey(t_tool_name, t_tool_input, hashAttachments(t_attachments));
    const t_cached = readCachedDecision(t_cache_key, t_settings.cache_ttl_seconds);
    if (t_cached) {
      logWrite("INFO", "cache", `${t_cached.action} ${t_tool_name}: ${t_short}`);
      // ask 结论同样双发 additionalContext（兼容不含该字段的旧缓存条目）
      const t_extra = t_cached.action === ACTION_ASK ? { additionalContext: t_cached.reason } : {};
      return { ...t_cached, source: "cache", ...t_extra };
    }

    // ⑤ 安全子 agent（LLM）审查
    const t_llm_decision = await runLlmReview(t_tool_name, t_tool_input, t_settings, t_attachments);
    return { ...t_llm_decision, source: "llm" };
  } catch (t_error) {
    // ⑥ 总兜底：任何异常（provider 不可用 / 超时 / 输出不可解析）一律转人工，绝不在错误时放行
    const t_cause = t_error instanceof ProviderError || t_error instanceof LlmError
      ? t_error.message
      : t_error.message || "未知错误";
    logWrite("WARN", "fallback", `审查失败转人工: ${t_cause}`);
    return {
      action: ACTION_ASK,
      reason: `[auto-review] 安全审查不可用（${t_cause}），已转人工审查。`,
      source: "fallback",
      additionalContext: `[auto-review] 安全审查不可用（${t_cause}），已转人工审查。该操作未经安全评估，建议用户谨慎确认。`,
    };
  }
}

export {
  reviewToolUse,
  normalizeToolName,
  buildRuleText,
  matchDangerRules,
  matchCompoundRules,
  hasCommandSubstitution,
  matchSessionAllowlist,
  addSessionAllowlist,
  clearSessionAllowlist,
  listSessionAllowlist,
  splitTopLevelCommands,
  extractScriptRefs,
  collectScriptAttachments,
  hashAttachments,
  stableStringify,
  computeCacheKey,
  readCachedDecision,
  writeCachedDecision,
  extractJsonObject,
  parseVerdict,
  formatVerdictReason,
  buildReviewPayload,
};
