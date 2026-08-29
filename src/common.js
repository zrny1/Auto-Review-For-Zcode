/**
 * 模块功能: 全局配置中心——数据目录、路径常量、统一日志与原子写工具
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 集中管理插件全部路径常量与跨模块共用的工具函数；
 *       测试可通过 AUTO_REVIEW_DATA_DIR / AUTO_REVIEW_ZCODE_CONFIG 环境变量重定向数据与配置，避免污染真实用户数据
 * 功能:
 *   - 数据目录定位与按需创建
 *   - 审查日志（带轮转）写入
 *   - JSON 文件防御式读取与原子写（临时文件 + rename，避免半截文件）
 * 依赖: node:os node:path node:fs node:url
 * 更新日期: 2026年08月29日
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// 插件名，用于目录与日志标识
const PLUGIN_NAME = "auto-review";

// 源码目录向上即插件根目录（marketplace 缓存运行时同样成立）
const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = path.resolve(SRC_DIR, "..");

// 统一数据目录：hook 进程与主 agent 侧命令都能确定性推出该路径（方案见 docs/project_plan/04）
const g_data_dir = process.env.AUTO_REVIEW_DATA_DIR
  ? path.resolve(process.env.AUTO_REVIEW_DATA_DIR)
  : path.join(os.homedir(), ".zcode", PLUGIN_NAME);

// 数据目录内各文件路径
const SETTINGS_FILE = () => path.join(g_data_dir, "settings.json");
const DANGER_RULES_FILE = () => path.join(g_data_dir, "danger_rules.json");
const SECURITY_PROMPT_FILE = () => path.join(g_data_dir, "security_prompt.md");
const CACHE_FILE = () => path.join(g_data_dir, "cache.json");
const LOG_FILE = () => path.join(g_data_dir, "review.log");

// 出厂默认配置（只读回落源，位于插件包内）
const DEFAULT_SETTINGS_FILE = path.join(PLUGIN_ROOT, "config", "default_settings.json");
const DEFAULT_DANGER_RULES_FILE = path.join(PLUGIN_ROOT, "config", "default_danger_rules.json");
const DEFAULT_SECURITY_PROMPT_FILE = path.join(PLUGIN_ROOT, "config", "default_security_prompt.md");

// hook 输出协议的两种风格：claude 为默认（hookSpecificOutput 包装），simple 用于集成期排查
const OUTPUT_STYLE_CLAUDE = "claude";
const OUTPUT_STYLE_SIMPLE = "simple";

// 日志轮转阈值：超过则把旧日志改名为 .old 重新起笔，防止日志无限增长
const MAX_LOG_BYTES = 512 * 1024;

// 日志级别到标识的映射，统一"时间戳[级别][模块] 内容"格式
const LOG_LEVEL_TAGS = { INFO: "INFO", WARN: "WARN", ERROR: "ERROR" };

/**
 * 函数功能: 获取数据目录（不存在则创建）
 * @returns {string} 数据目录绝对路径
 */
function getDataDir() {
  fs.mkdirSync(g_data_dir, { recursive: true });
  return g_data_dir;
}

/**
 * 函数功能: 追加一条审查日志，超限时轮转
 * @param {string} level - 日志级别 INFO/WARN/ERROR
 * @param {string} moduleName - 模块标识（rule/cache/llm/settings/fallback 等）
 * @param {string} message - 日志内容（不得包含密钥等敏感信息）
 * @returns {void}
 */
function logWrite(level, moduleName, message) {
  try {
    const t_log_file = LOG_FILE();
    // 轮转：rename 失败（如被占用）时继续追加，日志不应影响主流程
    if (fs.existsSync(t_log_file) && fs.statSync(t_log_file).size > MAX_LOG_BYTES) {
      fs.renameSync(t_log_file, t_log_file + ".old");
    }
    const t_tag = LOG_LEVEL_TAGS[level] || "INFO";
    const t_line = `[${new Date().toISOString()}][${t_tag}][${moduleName}] ${message}\n`;
    fs.appendFileSync(t_log_file, t_line, "utf8");
  } catch (t_error) {
    // 日志失败必须静默：审查决策本身不能被日志故障拖垮
  }
}

/**
 * 函数功能: 防御式读取 JSON 文件
 * @param {string} file_path - 文件路径
 * @param {*} fallback - 读取失败或解析失败时的返回值
 * @param {string} moduleName - 记日志用的模块标识
 * @returns {*} 解析后的 JSON 值或 fallback
 */
function readJsonFile(file_path, fallback, moduleName) {
  try {
    const t_raw = fs.readFileSync(file_path, "utf8");
    // 剥 UTF-8 BOM：GUI 侧 PowerShell Set-Content -Encoding UTF8 恒写 BOM，不剥会导致 JSON.parse 失败静默回落默认值
    return JSON.parse(t_raw.replace(/^\uFEFF/, ""));
  } catch (t_error) {
    if (t_error.code !== "ENOENT" && moduleName) {
      logWrite("WARN", moduleName, `读取 ${path.basename(file_path)} 失败: ${t_error.message}，使用回落值`);
    }
    return fallback;
  }
}

/**
 * 函数功能: 原子写文件（先写临时文件再 rename），保证读者不会看到半截内容
 * @param {string} file_path - 目标文件路径
 * @param {string} content - 写入内容
 * @returns {boolean} 是否写入成功
 */
function writeFileAtomic(file_path, content) {
  const t_tmp_path = file_path + ".tmp";
  try {
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    fs.writeFileSync(t_tmp_path, content, "utf8");
    fs.renameSync(t_tmp_path, file_path);
    return true;
  } catch (t_error) {
    logWrite("WARN", "common", `原子写 ${path.basename(file_path)} 失败: ${t_error.message}`);
    try { fs.unlinkSync(t_tmp_path); } catch { /* 临时文件本就不存在，无需处理 */ }
    return false;
  }
}

export {
  PLUGIN_NAME,
  PLUGIN_ROOT,
  getDataDir,
  SETTINGS_FILE,
  DANGER_RULES_FILE,
  SECURITY_PROMPT_FILE,
  CACHE_FILE,
  LOG_FILE,
  DEFAULT_SETTINGS_FILE,
  DEFAULT_DANGER_RULES_FILE,
  DEFAULT_SECURITY_PROMPT_FILE,
  OUTPUT_STYLE_CLAUDE,
  OUTPUT_STYLE_SIMPLE,
  logWrite,
  readJsonFile,
  writeFileAtomic,
};
