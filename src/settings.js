/**
 * 模块功能: 运行时配置的加载与保存——settings / 危险规则 / 安全提示词
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 数据目录文件优先，缺失或损坏时回落插件包内出厂默认；
 *       所有写入走原子写；规则对象在加载时即编译正则，非法规则跳过并告警
 * 功能:
 *   - loadSettings/saveSettings: 运行时配置（开关、审查工具、provider、脚本送审等）
 *   - loadDangerRules: 危险规则表（含正则编译与容错）
 *   - loadSecurityPrompt: 安全子 agent 系统提示词
 * 依赖: ./common.js
 * 更新日期: 2026年09月05日
 */

import path from "node:path";
import fs from "node:fs";

import {
  SETTINGS_FILE,
  DANGER_RULES_FILE,
  SECURITY_PROMPT_FILE,
  DEFAULT_SETTINGS_FILE,
  DEFAULT_DANGER_RULES_FILE,
  DEFAULT_SECURITY_PROMPT_FILE,
  logWrite,
  readJsonFile,
  writeFileAtomic,
} from "./common.js";

// LLM 超时的合法区间：下限保证可用性，上限必须小于 hook 总预算 60s，留出规则/缓存/进程启动时间
const TIMEOUT_MS_MIN = 5000;
const TIMEOUT_MS_MAX = 45000;

// 脚本送审单文件读取上限的合法区间：过小无审查价值，过大撑爆载荷与 token 预算
const SCRIPT_BYTES_MIN = 1000;
const SCRIPT_BYTES_MAX = 100000;

// 合法动作集合，规则 action 超出此集合按 ask 处理（宁可多问不放过）
const VALID_RULE_ACTIONS = new Set(["deny", "ask", "allow"]);

// 规则正则编译标志：i 应对 Windows 命令大小写不定，m 保证行首锚点按行生效
const RULE_REGEX_FLAGS = "im";

/**
 * 函数功能: 加载运行时配置（出厂默认 + 数据目录覆盖，含类型校验与钳制）
 * @returns {object} 合并后的配置对象
 */
function loadSettings() {
  const t_defaults = readJsonFile(DEFAULT_SETTINGS_FILE, {}, "settings");
  const t_stored = readJsonFile(SETTINGS_FILE(), {}, "settings");
  const t_merged = { ...t_defaults };

  // 只接受与默认值同类型的覆盖，防止手改配置文件引入脏值拖垮审查
  for (const t_key of Object.keys(t_defaults)) {
    const t_value = t_stored[t_key];
    if (t_value === undefined) {
      continue;
    }
    if (Array.isArray(t_defaults[t_key])) {
      if (Array.isArray(t_value)) {
        t_merged[t_key] = t_value;
      } else {
        logWrite("WARN", "settings", `字段 ${t_key} 应为数组，已回落默认值`);
      }
    } else if (typeof t_value === typeof t_defaults[t_key] && t_value !== null) {
      t_merged[t_key] = t_value;
    } else {
      logWrite("WARN", "settings", `字段 ${t_key} 类型不符，已回落默认值`);
    }
  }

  // 数值字段钳制到合法区间，越界值就近收敛而不是拒绝服务
  t_merged.timeout_ms = Math.min(TIMEOUT_MS_MAX, Math.max(TIMEOUT_MS_MIN, Number(t_merged.timeout_ms) || TIMEOUT_MS_MAX));
  t_merged.cache_ttl_seconds = Math.max(0, Number(t_merged.cache_ttl_seconds) || 0);
  t_merged.max_payload_chars = Math.max(500, Number(t_merged.max_payload_chars) || 8000);
  t_merged.script_max_bytes = Math.min(SCRIPT_BYTES_MAX, Math.max(SCRIPT_BYTES_MIN, Number(t_merged.script_max_bytes) || 16000));
  return t_merged;
}

/**
 * 函数功能: 保存运行时配置到数据目录（原子写）
 * @param {object} settings - 完整配置对象
 * @returns {boolean} 是否保存成功
 */
function saveSettings(settings) {
  return writeFileAtomic(SETTINGS_FILE(), JSON.stringify(settings, null, 2) + "\n");
}

/**
 * 函数功能: 加载危险规则并编译正则
 * @returns {Array<{regex: RegExp, action: string, description: string, index: number}>}
 *          可用规则列表，index 为用户在命令中看到的序号（含被跳过的非法规则）
 */
function loadDangerRules() {
  let t_rules = readJsonFile(DANGER_RULES_FILE(), null, "rule");
  if (!Array.isArray(t_rules)) {
    t_rules = readJsonFile(DEFAULT_DANGER_RULES_FILE, [], "rule");
  }

  const t_compiled = [];
  t_rules.forEach((t_rule, t_index) => {
    // 单条规则非法只跳过自身：用户改错一条不能让整个规则层瘫痪
    if (!t_rule || typeof t_rule.pattern !== "string" || typeof t_rule.description !== "string") {
      logWrite("WARN", "rule", `规则 #${t_index + 1} 结构非法（缺 pattern/description），已跳过`);
      return;
    }
    try {
      const t_regex = new RegExp(t_rule.pattern, RULE_REGEX_FLAGS);
      t_compiled.push({
        regex: t_regex,
        action: VALID_RULE_ACTIONS.has(t_rule.action) ? t_rule.action : "ask",
        description: t_rule.description,
        index: t_index + 1,
      });
    } catch (t_error) {
      logWrite("WARN", "rule", `规则 #${t_index + 1} 正则编译失败: ${t_error.message}，已跳过`);
    }
  });
  return t_compiled;
}

/**
 * 函数功能: 读取原始规则数组（供命令展示与修改用，不做编译）
 * @returns {Array<{pattern: string, action: string, description: string}>} 原始规则数组
 */
function loadRawDangerRules() {
  const t_rules = readJsonFile(DANGER_RULES_FILE(), null, "rule");
  if (Array.isArray(t_rules)) {
    return t_rules;
  }
  return readJsonFile(DEFAULT_DANGER_RULES_FILE, [], "rule");
}

/**
 * 函数功能: 保存原始规则数组到数据目录
 * @param {Array<object>} rules - 规则数组
 * @returns {boolean} 是否保存成功
 */
function saveDangerRules(rules) {
  return writeFileAtomic(DANGER_RULES_FILE(), JSON.stringify(rules, null, 2) + "\n");
}

/**
 * 函数功能: 加载安全子 agent 系统提示词（数据目录优先，回落出厂默认）
 * @returns {string} 提示词全文
 */
function loadSecurityPrompt() {
  try {
    return fs.readFileSync(SECURITY_PROMPT_FILE(), "utf8");
  } catch {
    try {
      return fs.readFileSync(DEFAULT_SECURITY_PROMPT_FILE, "utf8");
    } catch (t_error) {
      // 提示词彻底缺失时给最小可用兜底，保证审查仍按契约输出 JSON
      logWrite("ERROR", "settings", `出厂提示词缺失: ${t_error.message}`);
      return "你是安全审查员。只输出 JSON：{\"decision\":\"allow或ask\",\"risk_level\":\"low/medium/high\",\"analysis\":\"一句话分析\",\"risks\":[\"风险点\"],\"scope\":\"影响范围\"}";
    }
  }
}

export {
  loadSettings,
  saveSettings,
  loadDangerRules,
  loadRawDangerRules,
  saveDangerRules,
  loadSecurityPrompt,
};
