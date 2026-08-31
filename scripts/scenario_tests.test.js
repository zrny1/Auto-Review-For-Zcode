/**
 * 模块功能: 八场景固定测试——手工验收场景的自动化回归（放行/转审核/脚本/规则三态/复合命令）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 复现 8 条手工验收路径并固化为可重复执行的断言：
 *       场景1-3 走 LLM 审查层，由本地假 provider 服务（openai 协议）按命令关键字
 *       返回预置结论，离线固化"安全放行 / 危险转审核 / 脚本转审核"的管线行为；
 *       场景4-8 走危险规则层，断言 deny/ask/allow 三态与复合命令逐段拆分匹配，
 *       并以 LLM 请求次数为 0 锚定"规则层不经过 LLM"的承诺；
 *       另附两条防回归锚定：白名单开头的复合命令藏危险段必须降级 LLM、
 *       LLM 幻觉 deny 收敛为 ask。
 *       环境变量必须在 import 业务模块之前设置（common.js 在加载期固化路径）
 * 依赖: node:test node:assert node:fs node:http node:os node:path ../src/*
 * 更新日期: 2026年08月29日
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// 隔离环境：临时数据目录 + 假的 ZCode 配置（provider 指向本地假 LLM 服务）
const t_tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-scenario-"));
process.env.AUTO_REVIEW_DATA_DIR = t_tmp_dir;
process.env.AUTO_REVIEW_ZCODE_CONFIG = path.join(t_tmp_dir, "zcode_config.json");

// LLM 幻觉 deny 专用结论：验证 parseVerdict 把 LLM 的 deny 收敛为 ask（LLM 无拦截权）
const LLM_HALLUCINATED_DENY = { decision: "deny", risk_level: "high", analysis: "（幻觉拦截）", risks: [], scope: "无" };

// 按审查载荷中的命令关键字分发预置结论：场景1 走默认 allow，场景2/3/锚定 各命中专属关键字
const LLM_VERDICT_BY_KEYWORD = [
  {
    keyword: "rm -rf",
    verdict: { decision: "ask", risk_level: "high", analysis: "递归强制删除整个目录，不可逆删除且目标为绝对路径", risks: ["rm -rf 无回收站可恢复", "绝对路径存在范围逃逸"], scope: "目标目录下全部文件与子目录" },
  },
  {
    keyword: ".sh",
    verdict: { decision: "ask", risk_level: "medium", analysis: "执行外部脚本，脚本内容未随调用提供无法确认行为", risks: ["脚本内容不可见", "文件名暗示删除操作"], scope: "脚本内部引用的文件与目录" },
  },
  {
    keyword: "format",
    verdict: LLM_HALLUCINATED_DENY,
  },
];
// 未命中任何关键字的命令（场景1 的安全指令）按安全放行处理
const DEFAULT_VERDICT = { decision: "allow", risk_level: "low", analysis: "命令为只读查询，无破坏性", risks: [], scope: "无" };

// 假 LLM 服务收到的请求计数：规则层场景必须为 0，锚定"规则层不经过 LLM"
let g_llm_request_count = 0;

// 假 LLM 服务（openai chat/completions 协议）：解析载荷中的命令，按关键字回预置结论
const t_fake_llm = http.createServer((t_req, t_res) => {
  const t_chunks = [];
  t_req.on("data", (t_chunk) => t_chunks.push(t_chunk));
  t_req.on("end", () => {
    g_llm_request_count++;
    const t_body = JSON.parse(Buffer.concat(t_chunks).toString("utf8"));
    const t_user_msg = (t_body.messages || []).find((t_m) => t_m.role === "user");
    const t_payload = String((t_user_msg && t_user_msg.content) || "");
    const t_hit = LLM_VERDICT_BY_KEYWORD.find((t_item) => t_payload.includes(t_item.keyword));
    const t_verdict = t_hit ? t_hit.verdict : DEFAULT_VERDICT;
    t_res.writeHead(200, { "content-type": "application/json" });
    t_res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(t_verdict) } }] }));
  });
});
await new Promise((t_resolve) => t_fake_llm.listen(0, "127.0.0.1", t_resolve));
const t_port = t_fake_llm.address().port;

// ZCode 配置：唯一 enabled 的 provider 指向假服务（跟随主 agent 语义即命中它）
fs.writeFileSync(process.env.AUTO_REVIEW_ZCODE_CONFIG, JSON.stringify({
  provider: {
    "builtin:fake-llm": {
      name: "Fake LLM",
      kind: "openai",
      enabled: true,
      options: { baseURL: `http://127.0.0.1:${t_port}/v1`, apiKey: "test-key" },
      models: { "fake-model": {} },
    },
  },
}));

// 环境就绪后再加载业务模块
const { loadSettings, saveSettings, saveDangerRules } = await import("../src/settings.js");
const { reviewToolUse, addSessionAllowlist, clearSessionAllowlist } = await import("../src/reviewer.js");

// 运行时配置：开启审查、只审 Bash、显式指向假 provider、禁用缓存保证用例无状态串扰
const t_settings = loadSettings();
t_settings.enabled = true;
t_settings.review_tools = ["Bash"];
t_settings.provider = "fake-llm";
t_settings.model = "fake-model";
t_settings.cache_ttl_seconds = 0;
saveSettings(t_settings);

/**
 * 函数功能: 写入本用例的危险规则表（数据目录规则优先生效，空数组即屏蔽出厂规则）
 * @param {Array<{pattern: string, action: string, description: string}>} rules - 原始规则数组
 * @returns {void}
 */
function writeRules(rules) {
  saveDangerRules(rules);
}

/**
 * 函数功能: 以 hook 输入形态执行一次审查，并重置 LLM 请求计数便于逐用例断言
 * @param {string} command - 被审查的 Bash 命令
 * @returns {Promise<{action: string, reason: string, source: string}>} 决策对象
 */
async function reviewCommand(command) {
  g_llm_request_count = 0;
  return reviewToolUse({ tool_name: "Bash", tool_input: { command } });
}

// 单条测试规则（场景4-6 换 action 复用同一正则，与手工验收一致）
const LS_RULE = (t_action) => ({ pattern: "^\\s*ls\\b", action: t_action, description: "测试规则-ls命令" });
const NODE_VERSION_RULE = (t_action) => ({ pattern: "^\\s*node\\s+--version\\b", action: t_action, description: "测试规则-node版本查询" });

test("场景1: 安全普通指令——LLM 审查后放行", async () => {
  writeRules([]);
  const t_decision = await reviewCommand("node --version");
  assert.equal(t_decision.action, "allow");
  assert.equal(t_decision.source, "llm");
  assert.match(t_decision.reason, /安全审查通过/);
  assert.equal(g_llm_request_count, 1);
});

test("场景2: 危险删除指令——LLM 判高风险转审核", async () => {
  writeRules([]);
  const t_decision = await reviewCommand("rm -rf D:/app/demo_dir");
  assert.equal(t_decision.action, "ask");
  assert.equal(t_decision.source, "llm");
  assert.match(t_decision.reason, /风险级别 high/);
  // ask 双发通道：审查分析必须随 additionalContext 进入主 agent 上下文
  assert.match(t_decision.additionalContext, /风险级别 high/);
  assert.equal(g_llm_request_count, 1);
});

test("场景3: 执行删除脚本——LLM 判中风险转审核", async () => {
  writeRules([]);
  const t_decision = await reviewCommand("bash D:/app/delete_demo.sh");
  assert.equal(t_decision.action, "ask");
  assert.equal(t_decision.source, "llm");
  assert.match(t_decision.reason, /风险级别 medium/);
  assert.equal(g_llm_request_count, 1);
});

test("场景4: deny 规则拦截 ls——本地规则直接拦，不经 LLM", async () => {
  writeRules([LS_RULE("deny")]);
  const t_decision = await reviewCommand("ls D:/app/demo_dir");
  assert.equal(t_decision.action, "deny");
  assert.equal(t_decision.source, "rule");
  assert.match(t_decision.reason, /已拦截（危险规则 #1/);
  assert.equal(g_llm_request_count, 0);
});

test("场景5: ask 规则命中 ls——转人工审查", async () => {
  writeRules([LS_RULE("ask")]);
  const t_decision = await reviewCommand("ls D:/app/demo_dir");
  assert.equal(t_decision.action, "ask");
  assert.equal(t_decision.source, "rule");
  assert.match(t_decision.reason, /该操作命中你设置的转人工规则/);
  assert.match(t_decision.additionalContext, /转人工规则/);
  assert.equal(g_llm_request_count, 0);
});

test("场景6: allow 规则命中 ls——白名单直接放行，跳过 LLM", async () => {
  writeRules([LS_RULE("allow")]);
  const t_decision = await reviewCommand("ls D:/app/demo_dir");
  assert.equal(t_decision.action, "allow");
  assert.equal(t_decision.source, "rule");
  assert.match(t_decision.reason, /白名单放行/);
  assert.equal(g_llm_request_count, 0);
});

test("场景7: 复合命令 ls(allow)+node --version(ask)——拆分匹配整条转人工", async () => {
  writeRules([LS_RULE("allow"), NODE_VERSION_RULE("ask")]);
  const t_decision = await reviewCommand("ls D:/app/demo_dir && node --version");
  assert.equal(t_decision.action, "ask");
  assert.equal(t_decision.source, "rule");
  assert.match(t_decision.reason, /node --version/);
  assert.match(t_decision.reason, /整条命令转人工确认/);
  assert.equal(g_llm_request_count, 0);
});

test("场景8: 复合命令两段全 allow——白名单整条放行", async () => {
  writeRules([LS_RULE("allow"), NODE_VERSION_RULE("allow")]);
  const t_decision = await reviewCommand("ls D:/app/demo_dir && node --version");
  assert.equal(t_decision.action, "allow");
  assert.equal(t_decision.source, "rule");
  assert.match(t_decision.reason, /2 段子命令全部命中白名单规则/);
  assert.equal(g_llm_request_count, 0);
});

test("锚定A: allow 开头的复合命令藏危险段——不允许直接放行，降级 LLM 转审核", async () => {
  // 仅 ls 在白名单：`ls && rm -rf` 的第二段未命中任何规则，allow 不能替它作保
  writeRules([LS_RULE("allow")]);
  const t_decision = await reviewCommand("ls D:/app/demo_dir && rm -rf D:/app/demo_dir");
  assert.equal(t_decision.action, "ask");
  assert.equal(t_decision.source, "llm");
  assert.equal(g_llm_request_count, 1);
});

test("锚定B: LLM 幻觉 deny——收敛为 ask（拦截权只属于用户规则层）", async () => {
  writeRules([]);
  const t_decision = await reviewCommand("format D:");
  assert.equal(t_decision.action, "ask");
  assert.equal(t_decision.source, "llm");
  assert.equal(g_llm_request_count, 1);
});

// ─── 场景9-12: 会话白名单（对话框第三按钮「本次对话允许」）───

// 带 session_id 的 hook 输入构造（与真实 hook stdin 一致）
function sessionInput(t_session, t_command) {
  return { tool_name: "Bash", tool_input: { command: t_command }, session_id: t_session };
}

/**
 * 函数功能: 以指定会话执行一次审查并重置 LLM 计数
 * @param {string} t_session - 会话标识
 * @param {string} t_command - 被审查命令
 * @returns {Promise<object>} 决策对象
 */
async function reviewSession(t_session, t_command) {
  g_llm_request_count = 0;
  return reviewToolUse(sessionInput(t_session, t_command));
}

test("场景9: 本次对话允许后——同一会话同一指令直接放行，不经 LLM", async () => {
  writeRules([]);
  assert.equal(addSessionAllowlist("sess_t1", "Bash", { command: "node D:/app/build.js" }), true);
  const t_decision = await reviewSession("sess_t1", "node D:/app/build.js");
  assert.equal(t_decision.action, "allow");
  assert.equal(t_decision.source, "session");
  assert.match(t_decision.reason, /会话白名单放行/);
  assert.equal(g_llm_request_count, 0);
});

test("场景10: deny 规则优先于会话白名单——持久规则压过临时放行", async () => {
  writeRules([{ pattern: "^\\s*node\\s+D:/app/build\\.js\\b", action: "deny", description: "测试规则-拦截构建脚本" }]);
  assert.equal(addSessionAllowlist("sess_t1", "Bash", { command: "node D:/app/build.js" }), true);
  const t_decision = await reviewSession("sess_t1", "node D:/app/build.js");
  assert.equal(t_decision.action, "deny");
  assert.equal(t_decision.source, "rule");
  assert.equal(g_llm_request_count, 0);
});

test("场景11: 精确匹配——白名单只对完全相同指令生效，其他指令照常审查", async () => {
  writeRules([]);
  addSessionAllowlist("sess_t1", "Bash", { command: "node D:/app/build.js" });
  const t_decision = await reviewSession("sess_t1", "node D:/app/build.js --prod");
  assert.equal(t_decision.action, "allow");
  assert.equal(t_decision.source, "llm");
  assert.equal(g_llm_request_count, 1);
});

test("场景12: 会话隔离——另一会话不受已允许指令影响", async () => {
  writeRules([]);
  addSessionAllowlist("sess_t1", "Bash", { command: "node D:/app/build.js" });
  const t_decision = await reviewSession("sess_t2", "node D:/app/build.js");
  assert.equal(t_decision.action, "allow");
  assert.equal(t_decision.source, "llm");
  assert.equal(g_llm_request_count, 1);
  // 测试收尾清空白名单，避免影响后续用例
  clearSessionAllowlist();
});

test.after(() => {
  t_fake_llm.close();
});
