/**
 * 模块功能: 插件控制 CLI——斜杠命令操作插件的唯一入口（init/status/set/rules/prompt/session/gui）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 命令文档指导主 agent 调用本脚本完成配置变更，校验逻辑集中在代码而非提示词中，
 *       避免模型手改 JSON 出错；本脚本独立于 hook 协议，stdout 面向命令输出可读文本
 * 功能:
 *   - init: 把出厂默认配置物化到数据目录（不覆盖已有文件）
 *   - status / set: 运行时配置查看与修改（键与类型校验）
 *   - rules list|add|remove|test: 危险规则表管理
 *   - prompt show|path|reset: 安全提示词查看/定位/恢复默认
 *   - session list|clear: 会话白名单（"本次对话允许"）查看与清空
 * 依赖: node:fs node:path ./common.js ./settings.js ./reviewer.js ./gui.js
 * 更新日期: 2026年08月31日
 */

import fs from "node:fs";

import {
  getDataDir,
  SETTINGS_FILE,
  DANGER_RULES_FILE,
  SECURITY_PROMPT_FILE,
  DEFAULT_SETTINGS_FILE,
  DEFAULT_DANGER_RULES_FILE,
  DEFAULT_SECURITY_PROMPT_FILE,
  writeFileAtomic,
} from "./common.js";
import { loadSettings, saveSettings, loadRawDangerRules, loadDangerRules, saveDangerRules } from "./settings.js";
import { listSessionAllowlist, clearSessionAllowlist } from "./reviewer.js";
import { launchSettingsGui } from "./gui.js";

// set 命令允许修改的键及其解析方式；未列出的键一律拒绝，防止写入无效配置
const SETTABLE_KEYS = {
  enabled: "boolean",
  review_tools: "string_array",
  provider: "string",
  model: "string",
  timeout_ms: "int",
  cache_ttl_seconds: "int",
  max_payload_chars: "int",
  dialog_on_ask: "boolean",
};

// 数值键的合法区间，与 settings.js 加载时的钳制保持一致
const NUMBER_RANGES = {
  timeout_ms: [5000, 45000],
  cache_ttl_seconds: [0, 86400],
  max_payload_chars: [500, 100000],
};

/**
 * 函数功能: 把出厂默认配置物化到数据目录（已存在的文件不覆盖）
 * @returns {void}
 */
function cmdInit() {
  getDataDir();
  const t_pairs = [
    [DEFAULT_SETTINGS_FILE, SETTINGS_FILE()],
    [DEFAULT_DANGER_RULES_FILE, DANGER_RULES_FILE()],
    [DEFAULT_SECURITY_PROMPT_FILE, SECURITY_PROMPT_FILE()],
  ];
  for (const [t_src, t_dst] of t_pairs) {
    if (fs.existsSync(t_dst)) {
      console.log(`已存在，跳过: ${t_dst}`);
      continue;
    }
    writeFileAtomic(t_dst, fs.readFileSync(t_src, "utf8"));
    console.log(`已初始化: ${t_dst}`);
  }
}

/**
 * 函数功能: 输出当前配置摘要（供 /auto-review 状态汇报）
 * @returns {void}
 */
function cmdStatus() {
  const t_settings = loadSettings();
  const t_rules = loadRawDangerRules();
  console.log(`数据目录: ${getDataDir()}`);
  console.log(`enabled: ${t_settings.enabled}`);
  console.log(`review_tools: ${t_settings.review_tools.join(", ")}`);
  console.log(`provider: ${t_settings.provider || "(跟随主 agent 当前启用的 provider)"}`);
  console.log(`model: ${t_settings.model || "(该 provider 的第一个模型)"}`);
  console.log(`timeout_ms: ${t_settings.timeout_ms}`);
  console.log(`cache_ttl_seconds: ${t_settings.cache_ttl_seconds}`);
  console.log(`max_payload_chars: ${t_settings.max_payload_chars}`);
  console.log(`危险规则条数: ${t_rules.length}`);
  console.log(`提示词: ${fs.existsSync(SECURITY_PROMPT_FILE()) ? "已自定义" : "出厂默认"}`);
}

/**
 * 函数功能: 解析 set 命令的值字符串为目标类型
 * @param {string} key - 配置键
 * @param {string} raw_value - 命令行原始值
 * @returns {*} 类型正确的值
 * @throws {Error} 值非法时抛出（消息面向用户）
 */
function parseSetValue(key, raw_value) {
  const t_type = SETTABLE_KEYS[key];
  if (t_type === "boolean") {
    if (raw_value === "true") return true;
    if (raw_value === "false") return false;
    throw new Error(`${key} 只接受 true/false`);
  }
  if (t_type === "string_array") {
    let t_parsed;
    try {
      t_parsed = JSON.parse(raw_value);
    } catch {
      // 容忍裸写法：Bash,Write
      t_parsed = raw_value.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(t_parsed) || t_parsed.some((s) => typeof s !== "string" || !s.trim())) {
      throw new Error(`${key} 需要字符串数组，如 '["Bash"]' 或 "Bash,Write"`);
    }
    return t_parsed;
  }
  if (t_type === "string") {
    return raw_value;
  }
  // 数值键
  const t_num = Number(raw_value);
  if (!Number.isFinite(t_num)) {
    throw new Error(`${key} 需要数字`);
  }
  const [t_min, t_max] = NUMBER_RANGES[key];
  return Math.min(t_max, Math.max(t_min, Math.round(t_num)));
}

/**
 * 函数功能: 修改并保存一个配置键
 * @param {string} key - 配置键
 * @param {string} raw_value - 原始值字符串
 * @returns {void}
 */
function cmdSet(key, raw_value) {
  if (!(key in SETTABLE_KEYS)) {
    throw new Error(`未知配置键 "${key}"，可用: ${Object.keys(SETTABLE_KEYS).join(", ")}`);
  }
  const t_settings = loadSettings();
  t_settings[key] = parseSetValue(key, raw_value);
  if (!saveSettings(t_settings)) {
    throw new Error("写入 settings.json 失败");
  }
  console.log(`已设置 ${key} = ${JSON.stringify(t_settings[key])}`);
  if (key === "enabled" && t_settings.enabled) {
    console.log("提示: 自动审查已开启，建议主 agent 权限模式保持为自动编辑模式。");
  }
}

/**
 * 函数功能: 列出危险规则表
 * @returns {void}
 */
function cmdRulesList() {
  const t_rules = loadRawDangerRules();
  if (t_rules.length === 0) {
    console.log("(规则表为空，所有请求都将交给安全子 agent 审查)");
    return;
  }
  t_rules.forEach((t_rule, t_index) => {
    console.log(`#${t_index + 1} [${t_rule.action}] ${t_rule.description}`);
    console.log(`    ${t_rule.pattern}`);
  });
}

/**
 * 函数功能: 追加一条危险规则（正则先行自校验）
 * @param {string} action - deny/ask/allow
 * @param {string} pattern - 正则源文本
 * @param {string} description - 规则描述
 * @returns {void}
 */
function cmdRulesAdd(action, pattern, description) {
  if (!["deny", "ask", "allow"].includes(action)) {
    throw new Error(`action 只能是 deny/ask/allow，收到 "${action}"`);
  }
  // 与运行时相同的编译条件（im 标志），保证"加得进去就一定拦得住"
  try {
    new RegExp(pattern, "im");
  } catch (t_error) {
    throw new Error(`正则编译失败: ${t_error.message}`);
  }
  const t_rules = loadRawDangerRules();
  t_rules.push({ pattern, action, description: description || "(无描述)" });
  if (!saveDangerRules(t_rules)) {
    throw new Error("写入 danger_rules.json 失败");
  }
  console.log(`已追加规则 #${t_rules.length} [${action}] ${description}`);
}

/**
 * 函数功能: 按序号删除危险规则
 * @param {string} index_str - 1 起始的序号字符串
 * @returns {void}
 */
function cmdRulesRemove(index_str) {
  const t_index = Number(index_str);
  const t_rules = loadRawDangerRules();
  if (!Number.isInteger(t_index) || t_index < 1 || t_index > t_rules.length) {
    throw new Error(`序号必须是 1~${t_rules.length}`);
  }
  const t_removed = t_rules.splice(t_index - 1, 1)[0];
  if (!saveDangerRules(t_rules)) {
    throw new Error("写入 danger_rules.json 失败");
  }
  console.log(`已删除 #${t_index}: ${t_removed.description}`);
}

/**
 * 函数功能: 用给定文本跑一遍规则层（不调 LLM），报告全部命中
 * @param {string} text - 被测文本（命令或路径）
 * @returns {void}
 */
function cmdRulesTest(text) {
  if (!text) {
    throw new Error("缺少被测文本");
  }
  const t_hits = [];
  for (const t_rule of loadDangerRules()) {
    if (t_rule.regex.test(text)) {
      t_hits.push(`#${t_rule.index} [${t_rule.action}] ${t_rule.description}`);
    }
  }
  if (t_hits.length === 0) {
    console.log("未命中任何规则（将进入安全子 agent 审查）");
  } else {
    console.log(`命中 ${t_hits.length} 条:`);
    for (const t_hit of t_hits) {
      console.log(`  ${t_hit}`);
    }
  }
}

/**
 * 函数功能: 输出当前安全提示词全文
 * @returns {void}
 */
function cmdPromptShow() {
  const t_source = fs.existsSync(SECURITY_PROMPT_FILE()) ? SECURITY_PROMPT_FILE() : DEFAULT_SECURITY_PROMPT_FILE;
  console.log(`(来源: ${t_source})`);
  console.log(fs.readFileSync(t_source, "utf8"));
}

/**
 * 函数功能: 输出提示词文件路径（供主 agent 直接编辑）
 * @returns {void}
 */
function cmdPromptPath() {
  getDataDir();
  // 不存在则先物化默认，保证 agent 拿到的路径一定可编辑
  if (!fs.existsSync(SECURITY_PROMPT_FILE())) {
    writeFileAtomic(SECURITY_PROMPT_FILE(), fs.readFileSync(DEFAULT_SECURITY_PROMPT_FILE, "utf8"));
  }
  console.log(SECURITY_PROMPT_FILE());
}

/**
 * 函数功能: 恢复出厂默认提示词
 * @returns {void}
 */
function cmdPromptReset() {
  writeFileAtomic(SECURITY_PROMPT_FILE(), fs.readFileSync(DEFAULT_SECURITY_PROMPT_FILE, "utf8"));
  console.log("已恢复出厂默认提示词");
}

/**
 * 函数功能: 列出会话白名单条目（"本次对话允许"的生效中指令）
 * @returns {void}
 */
function cmdSessionList() {
  const t_items = listSessionAllowlist();
  if (t_items.length === 0) {
    console.log("(会话白名单为空：尚无「本次会话允许」的指令，或已超过 24 小时自动过期)");
    return;
  }
  for (const t_item of t_items) {
    const t_time = new Date(t_item.ts).toLocaleString();
    console.log(`[${t_time}] (${t_item.session.slice(0, 12)}…) ${t_item.cmd}`);
  }
}

/**
 * 函数功能: 清空会话白名单（后续同指令将重新走完整审查）
 * @returns {void}
 */
function cmdSessionClear() {
  if (!clearSessionAllowlist()) {
    throw new Error("清空 session_allowlist.json 失败");
  }
  console.log("已清空会话白名单");
}

/**
 * 函数功能: 子命令分发表
 * @param {string[]} argv - 去掉 node 与脚本路径后的参数列表
 * @returns {void}
 */
function dispatch(argv) {
  const [t_cmd, t_sub, ...t_rest] = argv;
  if (t_cmd === "init") return cmdInit();
  if (t_cmd === "status") return cmdStatus();
  if (t_cmd === "gui") {
    // 图形配置界面：阻塞至窗口关闭，随后输出当前状态摘要
    const t_ok = launchSettingsGui();
    if (!t_ok) {
      throw new Error("图形界面启动失败（仅支持 Windows）");
    }
    console.log("设置窗口已关闭。当前状态：");
    return cmdStatus();
  }
  if (t_cmd === "set") {
    if (!t_sub || t_rest.length < 1) throw new Error("用法: set <key> <value>");
    return cmdSet(t_sub, t_rest.join(" "));
  }
  if (t_cmd === "rules") {
    if (t_sub === "list") return cmdRulesList();
    if (t_sub === "add") {
      if (t_rest.length < 3) throw new Error('用法: rules add <deny|ask|allow> <正则> <描述>');
      return cmdRulesAdd(t_rest[0], t_rest[1], t_rest.slice(2).join(" "));
    }
    if (t_sub === "remove") {
      if (t_rest.length < 1) throw new Error("用法: rules remove <序号>");
      return cmdRulesRemove(t_rest[0]);
    }
    if (t_sub === "test") {
      if (t_rest.length < 1) throw new Error("用法: rules test <文本>");
      return cmdRulesTest(t_rest.join(" "));
    }
    throw new Error("子命令: list / add / remove / test");
  }
  if (t_cmd === "prompt") {
    if (t_sub === "show") return cmdPromptShow();
    if (t_sub === "path") return cmdPromptPath();
    if (t_sub === "reset") return cmdPromptReset();
    throw new Error("子命令: show / path / reset");
  }
  if (t_cmd === "session") {
    if (t_sub === "list") return cmdSessionList();
    if (t_sub === "clear") return cmdSessionClear();
    throw new Error("子命令: list / clear");
  }
  throw new Error(`未知命令 "${t_cmd || ""}"。可用: init / status / set / rules / prompt / session`);
}

// 入口：错误统一走 stderr + exit 1，成功输出全部在 stdout
try {
  dispatch(process.argv.slice(2));
} catch (t_error) {
  process.stderr.write(`[auto-review] ${t_error.message}\n`);
  process.exit(1);
}
