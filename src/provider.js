/**
 * 模块功能: ZCode provider 解析与安全子 agent 的 LLM 调用（零第三方依赖）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 配置读取优先级：~/.zcode/v2/provider_config.json（新版布局，凭据与自定义接入点的
 *       权威源）→ ~/.zcode/v2/config.json（provider 表：enabled 标记与模板型 provider 的
 *       完整定义）→ ~/.zcode/cli/config.json（旧布局兜底），三者合并为统一 provider 表；
 *       按 kind 选择 Anthropic Messages 或 OpenAI Chat Completions 协议直连调用；
 *       单次调用、不重试——审查是低频关键路径，重试只会把延迟放大到 hook 超时
 * 功能:
 *   - loadUnifiedProviderTable: 多源配置读取与合并（供本模块与 GUI 下拉共用）
 *   - resolveProvider: 配置解析（provider/model 选取、密钥校验）
 *   - callLlm: 通用单轮对话调用（AbortController 超时控制）
 * 依赖: node:os node:path ./common.js
 * 更新日期: 2026年09月18日
 */

import os from "node:os";
import path from "node:path";

import { logWrite, readJsonFile } from "./common.js";

// ZCode provider 表配置文件候选（本机实测 v2 布局优先，cli 布局兜底；测试可用环境变量整体替换）
function zcodeConfigCandidates() {
  if (process.env.AUTO_REVIEW_ZCODE_CONFIG) {
    return [path.resolve(process.env.AUTO_REVIEW_ZCODE_CONFIG)];
  }
  return [
    path.join(os.homedir(), ".zcode", "v2", "config.json"),
    path.join(os.homedir(), ".zcode", "cli", "config.json"),
  ];
}

// 新版 provider 配置文件（凭据与自定义接入点的权威源）；
// 测试模式下（AUTO_REVIEW_ZCODE_CONFIG 已重定向表配置）默认不读真实规则文件，
// 保持测试隔离；需测试规则文件时用 AUTO_REVIEW_PROVIDER_CONFIG 显式指定
function providerRulesCandidates() {
  if (process.env.AUTO_REVIEW_PROVIDER_CONFIG) {
    return [path.resolve(process.env.AUTO_REVIEW_PROVIDER_CONFIG)];
  }
  if (process.env.AUTO_REVIEW_ZCODE_CONFIG) {
    return [];
  }
  return [path.join(os.homedir(), ".zcode", "v2", "provider_config.json")];
}

// provider 配置解析失败（找不到可用 provider / 缺密钥等），携带面向日志的原因
class ProviderError extends Error {}

// LLM 调用失败（网络 / 超时 / HTTP 非 2xx / 响应结构异常）
class LlmError extends Error {}

// 结论 JSON 很小，但必须给混合推理模型的正文留足额度（thinking 已显式关闭，此为双保险）
const MAX_OUTPUT_TOKENS = 2048;

/**
 * 函数功能: 把 provider_config 规则的 api.type 映射为直连协议种类
 * @param {string} api_type - 规则里的 api.type（如 anthropic-messages）
 * @returns {string} "anthropic" 或 "openai"（未知类型按 openai 协议处理）
 */
function mapApiKind(api_type) {
  return String(api_type || "").startsWith("anthropic") ? "anthropic" : "openai";
}

/**
 * 函数功能: 从 provider_config 规则提取模型列表（modelOrder 优先，personalModelIds 补充）
 * @param {object} rule_config - 规则的 config 子对象
 * @returns {string[]} 模型名列表（去重保持顺序），无模型返回空数组
 */
function ruleModelList(rule_config) {
  const t_models = [];
  const t_seen = new Set();
  for (const t_list of [rule_config && rule_config.modelOrder, rule_config && rule_config.personalModelIds]) {
    if (!Array.isArray(t_list)) {
      continue;
    }
    for (const t_model of t_list) {
      const t_name = String(t_model || "").trim();
      if (t_name && !t_seen.has(t_name)) {
        t_seen.add(t_name);
        t_models.push(t_name);
      }
    }
  }
  return t_models;
}

/**
 * 函数功能: 读取全部配置源并合并为统一 provider 表——表配置条目为基础，
 *           provider_config 规则按 providerId 覆盖合并（凭据/接入点优先取规则，
 *           enabled 标记与模板型 provider 的 baseURL/模型仍以表配置为准），
 *           并为规则的 providerName 注册别名键；仅含凭据无法直连的规则（模板型）跳过
 * @returns {{table: object, orderHint: string[], aliasKeys: string[]}} 合并后的表（条目
 *            结构与 v2 表一致）、provider_config 的 providerOrder（无该文件为空数组）、
 *            别名键列表（GUI 展示时需过滤，避免与主键重复）
 */
function loadUnifiedProviderTable() {
  // ① 表配置：按优先级取第一个含 provider/providers 表的文件（找不到表时 entries 为空仍可由规则补充）
  let t_entries = [];
  let t_table_files = [];
  for (const t_candidate of zcodeConfigCandidates()) {
    const t_config = readJsonFile(t_candidate, null, "provider");
    const t_table = t_config && (t_config.provider || t_config.providers);
    if (t_config) {
      t_table_files.push(path.basename(path.dirname(t_candidate)) + "/" + path.basename(t_candidate));
    }
    if (t_table && typeof t_table === "object") {
      t_entries = Object.entries(t_table);
      break;
    }
  }

  // ② 规则文件：provider_config.json 的 providerRules
  let t_order_hint = [];
  const t_rules = [];
  for (const t_candidate of providerRulesCandidates()) {
    const t_raw = readJsonFile(t_candidate, null, "provider");
    const t_rule_list = t_raw && t_raw.config && t_raw.config.providerConfigRules
      && Array.isArray(t_raw.config.providerConfigRules.providerRules)
      ? t_raw.config.providerConfigRules.providerRules
      : null;
    if (t_rule_list) {
      t_rules.push(...t_rule_list.filter((t_rule) => t_rule && typeof t_rule === "object" && t_rule.providerId));
      if (Array.isArray(t_raw.config.providerOrder)) {
        t_order_hint = t_raw.config.providerOrder.map(String);
      }
      break;
    }
  }

  // ③ 合并：表条目深拷贝后按 providerId 覆盖；表没有的 providerId 若规则自带 api 接入点则新增
  const t_table = {};
  for (const [t_key, t_entry] of t_entries) {
    t_table[t_key] = t_entry && typeof t_entry === "object" ? JSON.parse(JSON.stringify(t_entry)) : {};
  }
  const t_rule_ids = new Set();
  for (const t_rule of t_rules) {
    t_rule_ids.add(String(t_rule.providerId));
    const t_rule_config = t_rule.config && typeof t_rule.config === "object" ? t_rule.config : {};
    const t_access_key = t_rule_config.access && typeof t_rule_config.access.apiKey === "string"
      ? t_rule_config.access.apiKey
      : "";
    const t_api_base = t_rule_config.api && typeof t_rule_config.api.baseUrl === "string"
      ? t_rule_config.api.baseUrl
      : "";
    const t_api_kind = t_rule_config.api && t_rule_config.api.type ? mapApiKind(t_rule_config.api.type) : "";
    const t_rule_models = ruleModelList(t_rule_config);

    const t_existing = t_table[String(t_rule.providerId)];
    if (!t_existing) {
      // 表里没有该 providerId：仅当规则自带完整接入点（baseUrl + apiKey）才能直连，模板型跳过
      if (!t_api_base || !t_access_key) {
        logWrite("INFO", "provider", `规则 ${t_rule.providerId} 无接入点且表配置缺失，跳过`);
        continue;
      }
      t_table[String(t_rule.providerId)] = {
        name: t_rule.providerName || String(t_rule.providerId),
        kind: t_api_kind,
        options: { baseURL: t_api_base, apiKey: t_access_key },
        models: Object.fromEntries(t_rule_models.map((t_m) => [t_m, {}])),
      };
      continue;
    }
    // 覆盖合并：凭据与接入点优先取规则（新版权威源），缺什么回落表条目
    const t_options = { ...(t_existing.options || {}) };
    if (t_access_key) {
      t_options.apiKey = t_access_key;
    }
    if (t_api_base) {
      t_options.baseURL = t_api_base;
    }
    if (t_api_kind) {
      t_existing.kind = t_api_kind;
    }
    t_existing.options = t_options;
    if (t_existing.name === undefined) {
      t_existing.name = t_rule.providerName || String(t_rule.providerId);
    }
    if (t_rule_models.length > 0) {
      const t_merged_models = { ...t_existing.models };
      for (const t_model of t_rule_models) {
        if (!(t_model in t_merged_models)) {
          t_merged_models[t_model] = {};
        }
      }
      // 规则模型排前（用户新版配置里勾选的顺序），表内其余模型跟后
      const t_ordered = {};
      for (const t_model of t_rule_models) {
        t_ordered[t_model] = t_merged_models[t_model];
      }
      for (const [t_model, t_def] of Object.entries(t_merged_models)) {
        if (!(t_model in t_ordered)) {
          t_ordered[t_model] = t_def;
        }
      }
      t_existing.models = t_ordered;
    }
  }

  // ④ 别名：规则的 providerName 指向同一 entry（显式按名指定时可用），不覆盖既有键
  const t_alias_keys = [];
  for (const t_rule of t_rules) {
    const t_name = t_rule.providerName && String(t_rule.providerName).trim();
    if (t_name && !t_table[t_name] && t_table[String(t_rule.providerId)]) {
      t_table[t_name] = t_table[String(t_rule.providerId)];
      t_alias_keys.push(t_name);
    }
  }

  if (t_table_files.length > 0 || t_rules.length > 0) {
    logWrite("INFO", "provider", `配置源: 表(${t_table_files.join("、") || "无"}) + 规则(${t_rules.length}条)，共 ${Object.keys(t_table).length} 个键`);
  }
  return { table: t_table, orderHint: t_order_hint, aliasKeys: t_alias_keys };
}

/**
 * 函数功能: 从统一 provider 表中选出目标 provider 定义
 * @param {object} unified - loadUnifiedProviderTable 的返回值
 * @param {string} wanted - settings.provider 指定的名称，空串表示跟随主 agent
 * @returns {object} provider 定义对象
 * @throws {ProviderError} 找不到指定或可用的 provider
 */
function pickProvider(unified, wanted) {
  const t_table = unified.table;
  if (Object.keys(t_table).length === 0) {
    throw new ProviderError("ZCode 配置中未找到 provider 表");
  }

  if (wanted) {
    // 显式指定时兼容带与不带 builtin: 前缀两种写法（配置键形如 "builtin:your-provider"）
    const t_entry = t_table[`builtin:${wanted}`] || t_table[wanted];
    if (!t_entry) {
      throw new ProviderError(`指定的 provider "${wanted}" 不存在，可用: ${Object.keys(t_table).join(", ")}`);
    }
    return t_entry;
  }

  // 跟随主 agent：取第一个 enabled 的 provider（enabled 标记只存在于表配置中）
  for (const [, t_entry] of Object.entries(t_table)) {
    if (t_entry && t_entry.enabled === true) {
      return t_entry;
    }
  }
  // 表配置无 enabled（如未来版本只留 provider_config）：按 providerOrder 首选
  for (const t_id of unified.orderHint) {
    if (t_table[t_id]) {
      logWrite("INFO", "provider", `无 enabled 标记，按 providerOrder 取 ${t_id}`);
      return t_table[t_id];
    }
  }
  throw new ProviderError("ZCode 配置中没有 enabled 的 provider，无法跟随主 agent");
}

/**
 * 函数功能: 解析指定 provider 的连接信息（主 provider 与 fallback 复用同一解析）
 * @param {object} settings - 运行时配置（timeout_ms）
 * @param {string} provider_name - 目标 provider 名，空串表示跟随主 agent
 * @param {string} model_name - 目标模型名，空串表示该 provider 第一个模型
 * @returns {{kind: string, baseURL: string, apiKey: string, model: string, timeoutMs: number}}
 * @throws {ProviderError} 配置不完整时抛出，原因写入日志
 */
function resolveProviderOverride(settings, provider_name, model_name) {
  const t_unified = loadUnifiedProviderTable();
  if (Object.keys(t_unified.table).length === 0) {
    throw new ProviderError("未找到 ZCode 配置文件（~/.zcode/v2/provider_config.json、~/.zcode/v2/config.json 或 ~/.zcode/cli/config.json）");
  }

  const t_entry = pickProvider(t_unified, String(provider_name || "").trim());
  const t_base_url = t_entry.options && t_entry.options.baseURL;
  const t_api_key = t_entry.options && t_entry.options.apiKey;
  if (!t_base_url) {
    throw new ProviderError("provider 缺少 baseURL（provider_config 规则与表配置均未提供）");
  }
  if (!t_api_key) {
    // OAuth 型 provider 没有静态 apiKey，直连不可行，明确指导用户改配 API Key 型 provider
    throw new ProviderError("provider 缺少 apiKey（OAuth 型凭证不支持直连），请在 /auto-review set provider 指定 API Key 型 provider");
  }

  const t_models = t_entry.models && typeof t_entry.models === "object" ? Object.keys(t_entry.models) : [];
  const t_model = String(model_name || "").trim() || t_models[0] || "";
  if (!t_model) {
    throw new ProviderError("provider 无可用模型，请通过 /auto-review set model 指定");
  }

  logWrite("INFO", "provider", `使用 ${t_entry.name || "?"} / ${t_model}（kind=${t_entry.kind || "openai"}）`);
  return {
    kind: String(t_entry.kind || "openai"),
    baseURL: t_base_url,
    apiKey: t_api_key,
    model: t_model,
    timeoutMs: settings.timeout_ms,
  };
}

/**
 * 函数功能: 解析主 provider 连接信息（跟随 settings.provider / settings.model）
 * @param {object} settings - 运行时配置（provider / model / timeout_ms）
 * @returns {{kind: string, baseURL: string, apiKey: string, model: string, timeoutMs: number}}
 * @throws {ProviderError} 配置不完整时抛出，原因写入日志
 */
function resolveProvider(settings) {
  return resolveProviderOverride(settings, settings && settings.provider, settings && settings.model);
}

/**
 * 函数功能: 拼接 API 地址，避免 baseURL 末尾斜杠与重复版本段
 * @param {string} base_url - provider baseURL
 * @param {string} version_prefix - 版本段（如 "/v1"），baseURL 已含时不再重复
 * @param {string} endpoint - 接口名（如 "/messages"、"/chat/completions"）
 * @returns {string} 完整 URL
 */
function joinUrl(base_url, version_prefix, endpoint) {
  let t_base = base_url.replace(/\/+$/, "");
  if (t_base.endsWith(version_prefix)) {
    t_base = t_base.slice(0, -version_prefix.length);
  }
  return t_base + version_prefix + endpoint;
}

/**
 * 函数功能: 执行一次 LLM 单轮调用（系统提示 + 用户消息），带超时控制
 * @param {object} provider_info - resolveProvider 的返回值
 * @param {string} system_prompt - 系统提示词（安全审查提示词）
 * @param {string} user_payload - 用户消息（审查载荷）
 * @returns {Promise<string>} 模型输出的文本
 * @throws {LlmError} 超时、网络错误、HTTP 非 2xx、响应结构异常
 */
async function callLlm(provider_info, system_prompt, user_payload) {
  const t_is_anthropic = provider_info.kind === "anthropic";
  const t_url = t_is_anthropic
    ? joinUrl(provider_info.baseURL, "/v1", "/messages")
    : joinUrl(provider_info.baseURL, "/v1", "/chat/completions");

  const t_headers = { "content-type": "application/json" };
  let t_body;
  if (t_is_anthropic) {
    t_headers["x-api-key"] = provider_info.apiKey;
    t_headers["anthropic-version"] = "2023-06-01";
    t_body = {
      model: provider_info.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // GLM 系为混合推理模型：默认思考会吃掉大量时延与 token 额度，
      // 实测关闭后 16s→5s 且正文稳定存在（否则长思考可耗尽 max_tokens 导致正文为空）
      thinking: { type: "disabled" },
      system: system_prompt,
      messages: [{ role: "user", content: user_payload }],
    };
  } else {
    t_headers["authorization"] = `Bearer ${provider_info.apiKey}`;
    t_body = {
      model: provider_info.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: system_prompt },
        { role: "user", content: user_payload },
      ],
    };
  }

  // AbortController 超时：settings 的 timeout_ms 已在加载时钳制到 hook 预算内
  const t_controller = new AbortController();
  const t_timer = setTimeout(() => t_controller.abort(), provider_info.timeoutMs);
  try {
    const t_response = await fetch(t_url, {
      method: "POST",
      headers: t_headers,
      body: JSON.stringify(t_body),
      signal: t_controller.signal,
    });
    if (!t_response.ok) {
      const t_error_text = (await t_response.text()).slice(0, 300);
      throw new LlmError(`HTTP ${t_response.status}: ${t_error_text}`);
    }
    const t_data = await t_response.json();
    const t_text = t_is_anthropic
      ? (t_data.content || []).filter((t_block) => t_block.type === "text").map((t_block) => t_block.text).join("")
      : (t_data.choices && t_data.choices[0] && t_data.choices[0].message && t_data.choices[0].message.content) || "";
    if (!t_text) {
      throw new LlmError("响应中没有文本内容");
    }
    return t_text;
  } catch (t_error) {
    if (t_error instanceof LlmError) {
      throw t_error;
    }
    if (t_error.name === "AbortError") {
      throw new LlmError(`请求超时（${provider_info.timeoutMs}ms）`);
    }
    throw new LlmError(t_error.message);
  } finally {
    clearTimeout(t_timer);
  }
}

export {
  ProviderError,
  LlmError,
  loadUnifiedProviderTable,
  resolveProvider,
  resolveProviderOverride,
  callLlm,
};
