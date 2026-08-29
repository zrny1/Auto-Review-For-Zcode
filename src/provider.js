/**
 * 模块功能: ZCode provider 解析与安全子 agent 的 LLM 调用（零第三方依赖）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 从 ZCode 配置文件解析 provider（默认跟随主 agent 当前启用的，可显式指定其他），
 *       按 kind 选择 Anthropic Messages 或 OpenAI Chat Completions 协议直连调用；
 *       单次调用、不重试——审查是低频关键路径，重试只会把延迟放大到 hook 超时
 * 功能:
 *   - resolveProvider: 配置解析（provider/model 选取、密钥校验）
 *   - callLlm: 通用单轮对话调用（AbortController 超时控制）
 * 依赖: node:os node:path node:fs ./common.js
 * 更新日期: 2026年08月29日
 */

import os from "node:os";
import path from "node:path";

import { logWrite, readJsonFile } from "./common.js";

// ZCode 配置文件候选路径（本机实测 v2 布局优先，cli 布局兜底；测试可用环境变量整体替换）
function zcodeConfigCandidates() {
  if (process.env.AUTO_REVIEW_ZCODE_CONFIG) {
    return [path.resolve(process.env.AUTO_REVIEW_ZCODE_CONFIG)];
  }
  return [
    path.join(os.homedir(), ".zcode", "v2", "config.json"),
    path.join(os.homedir(), ".zcode", "cli", "config.json"),
  ];
}

// provider 配置解析失败（找不到可用 provider / 缺密钥等），携带面向日志的原因
class ProviderError extends Error {}

// LLM 调用失败（网络 / 超时 / HTTP 非 2xx / 响应结构异常）
class LlmError extends Error {}

/**
 * 函数功能: 从配置对象中选出目标 provider 定义
 * @param {object} zcode_config - ZCode 配置文件解析结果
 * @param {string} wanted - settings.provider 指定的名称，空串表示跟随主 agent
 * @returns {object} provider 定义对象
 * @throws {ProviderError} 找不到指定或可用的 provider
 */
function pickProvider(zcode_config, wanted) {
  // v2 布局的键为 provider，兼容名为 providers 的布局
  const t_table = zcode_config && (zcode_config.provider || zcode_config.providers);
  if (!t_table || typeof t_table !== "object") {
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

  // 跟随主 agent：取第一个 enabled 的 provider
  for (const [t_key, t_entry] of Object.entries(t_table)) {
    if (t_entry && t_entry.enabled === true) {
      return t_entry;
    }
  }
  throw new ProviderError("ZCode 配置中没有 enabled 的 provider，无法跟随主 agent");
}

/**
 * 函数功能: 解析出可直接调用的 provider 连接信息
 * @param {object} settings - 运行时配置（provider / model / timeout_ms）
 * @returns {{kind: string, baseURL: string, apiKey: string, model: string, timeoutMs: number}}
 * @throws {ProviderError} 配置不完整时抛出，原因写入日志
 */
function resolveProvider(settings) {
  let t_config = null;
  let t_used_file = "";
  for (const t_candidate of zcodeConfigCandidates()) {
    t_config = readJsonFile(t_candidate, null, "provider");
    if (t_config) {
      t_used_file = t_candidate;
      break;
    }
  }
  if (!t_config) {
    throw new ProviderError("未找到 ZCode 配置文件（~/.zcode/v2/config.json 或 ~/.zcode/cli/config.json）");
  }

  const t_entry = pickProvider(t_config, String(settings.provider || "").trim());
  const t_base_url = t_entry.options && t_entry.options.baseURL;
  const t_api_key = t_entry.options && t_entry.options.apiKey;
  if (!t_base_url) {
    throw new ProviderError(`provider 缺少 options.baseURL（配置源 ${path.basename(t_used_file)}）`);
  }
  if (!t_api_key) {
    // OAuth 型 provider 没有静态 apiKey，直连不可行，明确指导用户改配 API Key 型 provider
    throw new ProviderError("provider 缺少 apiKey（OAuth 型凭证不支持直连），请在 /auto-review set provider 指定 API Key 型 provider");
  }

  const t_models = t_entry.models && typeof t_entry.models === "object" ? Object.keys(t_entry.models) : [];
  const t_model = String(settings.model || "").trim() || t_models[0] || "";
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
      max_tokens: 1024,
      system: system_prompt,
      messages: [{ role: "user", content: user_payload }],
    };
  } else {
    t_headers["authorization"] = `Bearer ${provider_info.apiKey}`;
    t_body = {
      model: provider_info.model,
      max_tokens: 1024,
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
  resolveProvider,
  callLlm,
};
