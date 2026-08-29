/**
 * 模块功能: 安全审查引擎——PreToolUse 决策管线的完整编排
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 管线顺序固定"先确定性后概率性"：总开关 → 工具过滤 → 危险规则层（不经过 LLM）
 *       → 缓存层 → 安全子 agent（LLM）→ 失败兜底 ask；
 *       任何一层异常只会让决策更保守，不存在"出错导致放行"的路径
 * 功能:
 *   - reviewToolUse: 主入口，输入 hook JSON，输出 {action, reason, source}
 *   - 规则匹配、缓存读写、LLM 载荷构造、输出解析与 reason 拼装
 * 依赖: node:crypto ./common.js ./settings.js ./provider.js
 * 更新日期: 2026年08月29日
 */

import { createHash } from "node:crypto";

import { CACHE_FILE, logWrite, readJsonFile, writeFileAtomic } from "./common.js";
import { loadSettings, loadDangerRules, loadSecurityPrompt } from "./settings.js";
import { resolveProvider, callLlm, ProviderError, LlmError } from "./provider.js";
import { ACTION_PASS, ACTION_ALLOW, ACTION_ASK, ACTION_DENY } from "./decision.js";

// matcher 别名在内部过滤时归一到标准工具名（ApplyPatch 即 Write/Edit 的别名）
const TOOL_ALIASES = { ApplyPatch: "Write", Task: "Agent" };

// 缓存条目上限：超限时丢弃过期项后按过期时间保留最新的一批，防止缓存文件无限增长
const MAX_CACHE_ENTRIES = 500;

// 日志中命令预览长度，避免单行日志过长
const LOG_PREVIEW_CHARS = 120;

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
 * 函数功能: 危险规则层——本地正则按数组顺序匹配，首个命中生效
 * @param {string} rule_text - 被匹配文本（命令全文或目标路径）
 * @returns {object|null} 命中的决策 {action, reason, source}，未命中返回 null
 */
function matchDangerRules(rule_text) {
  const t_rule = scanRules(rule_text);
  if (!t_rule) {
    return null;
  }
  // allow 规则禁止作用于复合命令全文：全文以白名单命令开头不代表其余子命令安全
  // （防 "ls; rm -rf x" 绕过）。复合命令的放行只能由 matchCompoundRules 逐段确认，
  // deny/ask 命中全文则维持原判定（拦截/转人工总是保守方向）
  if (t_rule.action === ACTION_ALLOW && splitTopLevelCommands(rule_text).length > 1) {
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
 * 函数功能: 对单段文本按数组顺序扫描规则，返回首个命中的规则
 * @param {string} text - 被匹配文本
 * @returns {object|null} 命中的规则定义（含编译好的 regex/action/description/index）
 */
function scanRules(text) {
  if (!text) {
    return null;
  }
  for (const t_rule of loadDangerRules()) {
    if (t_rule.regex.test(text)) {
      return t_rule;
    }
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
 * 函数功能: 复合命令的逐段规则审查——每段独立匹配，任一段命中 deny/ask 即整体生效，
 *           全部段命中 allow 才整体放行，其余情况返回 null 降级 LLM 审查完整命令。
 *           防止 allow 规则（如 ^ls\\b）放行 "ls; rm -rf x" 这类以白名单命令开头的复合命令
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
 * @returns {string} sha256 十六进制摘要
 */
function computeCacheKey(tool_name, tool_input) {
  return createHash("sha256").update(`${tool_name}\n${stableStringify(tool_input)}`).digest("hex");
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
 * 函数功能: 构造送审载荷（截断保护）
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @param {number} max_chars - 截断上限
 * @returns {string} 审查载荷文本
 */
function buildReviewPayload(tool_name, tool_input, max_chars) {
  let t_json = JSON.stringify({ tool_name, tool_input });
  if (t_json.length > max_chars) {
    t_json = t_json.slice(0, max_chars) + `…(已截断，原文 ${t_json.length} 字符)`;
  }
  return `审查以下工具调用，只输出结论 JSON：\n${t_json}`;
}

/**
 * 函数功能: 执行安全子 agent 审查（provider 解析 → LLM 调用 → 解析 → 缓存）
 * @param {string} tool_name - 标准工具名
 * @param {object} tool_input - 工具调用参数
 * @param {object} settings - 运行时配置
 * @returns {Promise<{action: string, reason: string}>} 决策对象
 */
async function runLlmReview(tool_name, tool_input, settings) {
  const t_provider = resolveProvider(settings);
  const t_prompt = loadSecurityPrompt();
  const t_payload = buildReviewPayload(tool_name, tool_input, settings.max_payload_chars);

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
  logWrite("INFO", "llm", `${t_verdict.decision} risk=${t_verdict.risk_level} ${t_duration_s}s`);
  // 只有 LLM 结论入缓存（规则层是即时的，且规则变更后旧缓存可能失效）
  writeCachedDecision(computeCacheKey(tool_name, tool_input), { action: t_verdict.decision, reason: t_reason }, settings.cache_ttl_seconds);
  // ask 决策双发：reason 给客户端 deny/升级路径，additionalContext 保证分析进入主 agent 上下文
  const t_extra = t_verdict.decision === ACTION_ASK ? { additionalContext: t_reason } : {};
  return { action: t_verdict.decision, reason: t_reason, ...t_extra };
}

/**
 * 函数功能: 构造带审查分析注释的工具输入——只对 Bash 的 description 追加分析文本，
 *           命令本身一字不改（description 是纯展示字段，不参与执行）
 * @param {object} tool_input - 原始工具输入
 * @param {string} reason - 审查分析全文（三段式 reason）
 * @returns {object} 注入后的新输入对象（原对象不被修改）
 */
function buildAnnotatedInput(tool_input, reason) {
  const t_desc = typeof tool_input.description === "string" ? tool_input.description.trim() : "";
  const t_annotation = `${t_desc ? t_desc + "\n\n" : ""}[auto-review 审查分析·决策参考]\n${reason}`.slice(0, 1500);
  return { ...tool_input, description: t_annotation };
}

/**
 * 函数功能: 决策管线主入口（对 hook_main 暴露的唯一函数，保证不抛异常）
 * @param {object} hook_input - hook stdin 的 JSON（tool_name/tool_input，字段防御式读取）
 * @returns {Promise<{action: string, reason: string, source: string}>} 决策对象
 */
async function reviewToolUse(hook_input) {
  const t_decision = await reviewToolUseInner(hook_input);
  // ask 决策统一附加 updatedInput：把分析注入 Bash 的 description，
  // 客户端在权限判定前应用改写输入，审批框内即可看到分析（决策时可见，非后置）
  if (t_decision.action === ACTION_ASK && t_decision.reason && hook_input && typeof hook_input === "object") {
    const t_input = hook_input.tool_input;
    const t_name = normalizeToolName(hook_input.tool_name || hook_input.toolName);
    if (t_name === "Bash" && t_input && typeof t_input === "object") {
      t_decision.updatedInput = buildAnnotatedInput(t_input, t_decision.reason);
    }
  }
  return t_decision;
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

    // ④ 缓存层：相同调用短期内复用结论，降低延迟与 token 消耗
    const t_cache_key = computeCacheKey(t_tool_name, t_tool_input);
    const t_cached = readCachedDecision(t_cache_key, t_settings.cache_ttl_seconds);
    if (t_cached) {
      logWrite("INFO", "cache", `${t_cached.action} ${t_tool_name}: ${t_short}`);
      // ask 结论同样双发 additionalContext（兼容不含该字段的旧缓存条目）
      const t_extra = t_cached.action === ACTION_ASK ? { additionalContext: t_cached.reason } : {};
      return { ...t_cached, source: "cache", ...t_extra };
    }

    // ⑤ 安全子 agent（LLM）审查
    const t_llm_decision = await runLlmReview(t_tool_name, t_tool_input, t_settings);
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
  buildAnnotatedInput,
  matchDangerRules,
  matchCompoundRules,
  splitTopLevelCommands,
  stableStringify,
  computeCacheKey,
  readCachedDecision,
  writeCachedDecision,
  extractJsonObject,
  parseVerdict,
  formatVerdictReason,
};
