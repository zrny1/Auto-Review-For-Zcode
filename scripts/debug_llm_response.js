/**
 * 模块功能: LLM 响应诊断——直接调用 provider API，打印原始响应结构（不打印密钥）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 排查"响应中没有文本内容"的根因：验证是否为 GLM 思考块耗尽 max_tokens 导致正文为空
 * 依赖: ../src/provider.js ../src/settings.js ../src/reviewer.js
 * 用法: node scripts/debug_llm_response.js （3 次真实 API 调用）
 * 更新日期: 2026年08月29日
 */

import { resolveProvider, callLlm } from "../src/provider.js";
import { loadSettings, loadSecurityPrompt } from "../src/settings.js";

const t_settings = loadSettings();
const t_provider = resolveProvider(t_settings);
const t_prompt = loadSecurityPrompt();
const t_payload =
  '审查以下工具调用，只输出结论 JSON：\n' +
  JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf <测试目录>", description: "删除测试目录" } });

/**
 * 函数功能: 发送一次原始请求并打印响应结构
 * @param {string} label - 用例标签
 * @param {object} extra - 附加请求字段
 * @returns {Promise<void>}
 */
async function callRaw(label, extra) {
  const t_url = t_provider.baseURL.replace(/\/+$/, "") + "/v1/messages";
  const t_body = {
    model: t_provider.model,
    max_tokens: 1024,
    system: t_prompt,
    messages: [{ role: "user", content: t_payload }],
    ...extra,
  };
  const t_start = Date.now();
  try {
    const t_res = await fetch(t_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": t_provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(t_body),
    });
    const t_data = await t_res.json();
    const t_seconds = ((Date.now() - t_start) / 1000).toFixed(1);
    console.log(`=== ${label} ===`);
    console.log(`HTTP ${t_res.status}  耗时 ${t_seconds}s`);
    console.log(`stop_reason: ${t_data.stop_reason}`);
    const t_blocks = (t_data.content || []).map((t_block) => {
      if (t_block.type === "text") return `text(${(t_block.text || "").length}字符)`;
      if (t_block.type === "thinking") return `thinking(${(t_block.thinking || "").length}字符)`;
      return t_block.type;
    });
    console.log(`content 块: ${t_blocks.join(", ") || "(空)"}`);
    console.log(`usage: ${JSON.stringify(t_data.usage || {})}`);
    if (t_data.error) {
      console.log(`error: ${JSON.stringify(t_data.error).slice(0, 300)}`);
    }
  } catch (t_error) {
    console.log(`=== ${label} === 异常: ${t_error.message}`);
  }
}

await callRaw("A: 当前格式 max_tokens=1024（不加 thinking 字段）");
await callRaw("B: 显式关闭 thinking", { thinking: { type: "disabled" } });
await callRaw("C: max_tokens=4096 不加 thinking", { max_tokens: 4096 });

// 对照组：用 callLlm（插件真实路径）跑同一载荷，看报错是否复现
try {
  await callLlm(t_provider, t_prompt, t_payload);
  console.log("=== callLlm（插件路径）=== 正常返回文本");
} catch (t_error) {
  console.log(`=== callLlm（插件路径）=== 失败: ${t_error.message}`);
}
