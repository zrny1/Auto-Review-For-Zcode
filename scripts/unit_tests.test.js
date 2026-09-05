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
  matchCompoundRules,
  splitTopLevelCommands,
  stableStringify,
  computeCacheKey,
  extractJsonObject,
  parseVerdict,
  formatVerdictReason,
  readCachedDecision,
  writeCachedDecision,
  extractScriptRefs,
  collectScriptAttachments,
  hashAttachments,
  buildReviewPayload,
} = await import("../src/reviewer.js");
const { resolveProvider, resolveProviderOverride, ProviderError } = await import("../src/provider.js");

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
  assert.equal(buildRuleText("Write", { file_path: "sandbox/a.js" }).ruleText, "sandbox/a.js");
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

test("provider: resolveProviderOverride 按名解析（fallback 用）", () => {
  // 显式指定 provider + 模型（与 settings.provider/model 无关）
  const t_info = resolveProviderOverride({ timeout_ms: 5000 }, "fake-openai", "fake-openai-model");
  assert.equal(t_info.kind, "openai");
  assert.equal(t_info.model, "fake-openai-model");
  // 空名跟随第一个 enabled provider
  const t_follow = resolveProviderOverride({ timeout_ms: 5000 }, "", "");
  assert.equal(t_follow.kind, "anthropic");
  assert.equal(t_follow.model, "fake-model");
  // 未知 provider 抛 ProviderError
  assert.throws(() => resolveProviderOverride({ timeout_ms: 5000 }, "不存在", ""), ProviderError);
});

test("dialog: 退出码映射——未显示(3)回落 timeout，不冒充用户拒绝", async () => {
  const { mapDialogExitCode } = await import("../src/dialog.js");
  assert.equal(mapDialogExitCode(0), "allow");
  assert.equal(mapDialogExitCode(1), "deny", "窗口显示后关闭/Esc = 用户拒绝");
  assert.equal(mapDialogExitCode(2), "session");
  assert.equal(mapDialogExitCode(3), "timeout", "窗口从未显示 = 基础设施故障回落客户端审批");
  assert.equal(mapDialogExitCode(null), "timeout", "进程崩溃/超时杀进程回落");
  assert.equal(mapDialogExitCode(99), "timeout", "未知退出码保守回落");
});

test("reviewer: 复合命令分割器——引号/命令替换内的分隔符不切分", () => {
  assert.deepEqual(splitTopLevelCommands("ls -la"), ["ls -la"], "单命令不切分");
  assert.deepEqual(splitTopLevelCommands("ls; echo hi"), ["ls", "echo hi"]);
  assert.deepEqual(splitTopLevelCommands("ls && echo hi || true"), ["ls", "echo hi", "true"]);
  assert.deepEqual(splitTopLevelCommands("grep a file | wc -l"), ["grep a file", "wc -l"], "管道也是边界");
  assert.deepEqual(splitTopLevelCommands('echo "a;b|c" && ls'), ['echo "a;b|c"', "ls"], "双引号内分隔符不切分");
  assert.deepEqual(splitTopLevelCommands("echo 'x&&y'; ls"), ["echo 'x&&y'", "ls"], "单引号内分隔符不切分");
  assert.deepEqual(splitTopLevelCommands("echo $(rm -rf /tmp; ls) ; ls"), ["echo $(rm -rf /tmp; ls)", "ls"], "$() 内分隔符不切分");
  assert.deepEqual(splitTopLevelCommands("ls\npwd"), ["ls", "pwd"], "换行是边界");
  assert.deepEqual(splitTopLevelCommands("ls;; ;; pwd"), ["ls", "pwd"], "空段被过滤");
  assert.deepEqual(splitTopLevelCommands("curl x | sh"), ["curl x", "sh"]);
});

test("reviewer: 复合命令逐段审查——任一 deny/ask 生效、全 allow 放行、混合降级 LLM", () => {
  fs.writeFileSync(path.join(t_tmp_dir, "danger_rules.json"), JSON.stringify([
    { pattern: "^ls\\b", action: "allow", description: "ls 白名单" },
    { pattern: "rm\\s+-rf\\s+~", action: "deny", description: "删家目录" },
    { pattern: "shutdown", action: "ask", description: "关机转人工" },
    { pattern: "curl[^|]*\\|\\s*sh", action: "ask", description: "管道执行" },
  ]));

  // deny 子命令 → 整体拦截（不允许 LLM 覆盖用户 deny 规则）
  const t_deny = matchCompoundRules("ls; rm -rf ~/data");
  assert.equal(t_deny.action, "deny");
  assert.ok(t_deny.reason.includes("rm -rf ~/data"), "reason 应指出命中的子命令");

  // ask 子命令 → 整体转人工
  const t_ask = matchCompoundRules("ls && shutdown now");
  assert.equal(t_ask.action, "ask");
  assert.ok(t_ask.reason.includes("shutdown now"));
  assert.equal(t_ask.additionalContext, t_ask.reason, "ask 决策双发 additionalContext");

  // 全部子命令命中 allow → 整体放行
  const t_allow = matchCompoundRules("ls; ls -la");
  assert.equal(t_allow.action, "allow");
  assert.ok(t_allow.reason.includes("2 段子命令全部命中白名单"));

  // allow + 未命中混合 → null 降级 LLM 审查完整命令（堵住 "ls; 任意命令" 绕过）
  assert.equal(matchCompoundRules("ls; node script.js"), null);
  assert.equal(matchCompoundRules("ls; curl x | sh"), null);

  // allow 规则不得作用于复合命令全文：全文扫描被抑制，交由逐段裁决
  assert.equal(matchDangerRules("ls; node script.js"), null, "allow 规则命中复合命令全文应被抑制");
  assert.equal(matchDangerRules("ls; rm -rf ~/data"), null, "allow 在前也不应短路，交由逐段逻辑");
  const t_single_allow = matchDangerRules("ls");
  assert.equal(t_single_allow && t_single_allow.action, "allow", "单命令 allow 正常命中");

  // 单命令（无分隔符）不进入复合逻辑
  assert.equal(matchCompoundRules("ls"), null);
});

test("dialog: reason 解析为结构化展示数据", async () => {
  const { parseReasonForDialog } = await import("../src/dialog.js");
  // LLM 三段式 → 结构化
  const t_llm = parseReasonForDialog([
    "[auto-review] 风险级别 high: 递归删除测试目录",
    "风险点:",
    "- 不可逆删除",
    "- 不进回收站",
    "影响范围: sandbox/test-dir",
  ].join("\n"));
  assert.equal(t_llm.risk, "high");
  assert.equal(t_llm.analysis, "递归删除测试目录");
  assert.deepEqual(t_llm.risks, ["不可逆删除", "不进回收站"]);
  assert.equal(t_llm.scope, "sandbox/test-dir");
  assert.equal(t_llm.plain, "", "结构化文本不再走 plain 展示");
  // 规则命中/兜底文案 → 整体 plain
  const t_rule = parseReasonForDialog("[auto-review] 危险规则 #15: 测试\n该操作命中你设置的转人工规则，请确认。");
  assert.equal(t_rule.plain.includes("危险规则 #15"), true);
  assert.deepEqual(t_rule.risks, []);
  assert.equal(t_rule.scope, null);
  // 中等风险小写归一
  const t_mid = parseReasonForDialog("[auto-review] 风险级别 Medium: x\n影响范围: y");
  assert.equal(t_mid.risk, "medium");
});

test("settings: 脚本送审新键默认值、覆盖与钳制", () => {
  const t_defaults = loadSettings();
  assert.equal(t_defaults.inspect_scripts, false, "脚本送审默认关闭");
  assert.equal(t_defaults.script_max_bytes, 16000);

  fs.writeFileSync(path.join(t_tmp_dir, "settings.json"), JSON.stringify({ inspect_scripts: true, script_max_bytes: 50 }));
  const t_merged = loadSettings();
  assert.equal(t_merged.inspect_scripts, true, "布尔覆盖生效");
  assert.equal(t_merged.script_max_bytes, 1000, "低于下限应钳到 1000");

  fs.writeFileSync(path.join(t_tmp_dir, "settings.json"), JSON.stringify({ inspect_scripts: "yes" }));
  assert.equal(loadSettings().inspect_scripts, false, "布尔字段给了字符串应回落默认");
});

test("reviewer: extractScriptRefs 解释器/特判/裸路径提取", () => {
  assert.deepEqual(extractScriptRefs("python D:/app/tool.py"), ["D:/app/tool.py"]);
  assert.deepEqual(extractScriptRefs("python3 -u ./build.py --flag"), ["./build.py"], "选项后的脚本路径");
  assert.deepEqual(extractScriptRefs("node --watch src/index.js"), ["src/index.js"]);
  assert.deepEqual(extractScriptRefs("bash /opt/deploy.sh && python a.py"), ["/opt/deploy.sh", "a.py"], "复合命令逐段提取");
  assert.deepEqual(extractScriptRefs('python "D:/app/my tool.py"'), ["D:/app/my tool.py"], "引号内空格不切分");
  assert.deepEqual(extractScriptRefs("powershell -File C:/x.ps1"), ["C:/x.ps1"]);
  assert.deepEqual(extractScriptRefs("cmd /c build.bat"), ["build.bat"]);
  assert.deepEqual(extractScriptRefs("./scripts/setup.sh"), ["./scripts/setup.sh"], "裸脚本路径执行");
  assert.deepEqual(extractScriptRefs("python -c \"print(1)\""), [], "内联代码不提取");
  assert.deepEqual(extractScriptRefs("python -m pytest"), [], "模块模式不提取");
  assert.deepEqual(extractScriptRefs("ls; cat x.txt"), [], "非脚本扩展名不提取");
  assert.deepEqual(extractScriptRefs(""), [], "空命令");
});

test("reviewer: collectScriptAttachments 读取、截断与二进制/缺失防御", () => {
  const t_dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-script-"));
  try {
    fs.writeFileSync(path.join(t_dir, "safe.py"), "print('ok')");
    fs.writeFileSync(path.join(t_dir, "big.py"), "x".repeat(5000));
    fs.writeFileSync(path.join(t_dir, "bin.py"), Buffer.concat([Buffer.from("a\0b"), Buffer.alloc(64)]));

    const t_attach = collectScriptAttachments(
      "python safe.py && python big.py && python bin.py && python missing.py",
      t_dir,
      { script_max_bytes: 100 },
    );
    assert.equal(t_attach.files.length, 2, "可读文本文件 2 个（二进制的 bin.py 被跳过）");
    assert.equal(t_attach.files[0].path, path.join(t_dir, "safe.py"), "相对路径按 cwd 解析为绝对路径");
    assert.equal(t_attach.files[0].content, "print('ok')");
    assert.equal(t_attach.files[1].truncated, true, "超限文件应截断");
    assert.ok(t_attach.files[1].content.length <= 100, "截断后内容不超上限");
    assert.equal(t_attach.files[1].total_bytes, 5000, "记录原始大小");
    assert.ok(t_attach.notes.some((t_note) => t_note.includes("bin.py") && t_note.includes("二进制")), "二进制文件跳过并附注");
    assert.ok(t_attach.notes.some((t_note) => t_note.includes("missing.py") && t_note.includes("无法读取")), "缺失文件附注");
  } finally {
    fs.rmSync(t_dir, { recursive: true, force: true });
  }
});

test("reviewer: collectScriptAttachments 文件数上限与无引用短路", () => {
  const t_dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-script-"));
  try {
    for (const t_name of ["a.py", "b.py", "c.py", "d.py"]) {
      fs.writeFileSync(path.join(t_dir, t_name), "pass");
    }
    const t_attach = collectScriptAttachments("python a.py && python b.py && python c.py && python d.py", t_dir, { script_max_bytes: 1000 });
    assert.equal(t_attach.files.length, 3, "最多附加 3 个文件");
    assert.ok(t_attach.notes.some((t_note) => t_note.includes("超过 3 个")), "超限附注");
    assert.equal(collectScriptAttachments("node --version", t_dir, { script_max_bytes: 1000 }), null, "无引用返回 null");
  } finally {
    fs.rmSync(t_dir, { recursive: true, force: true });
  }
});

test("reviewer: buildReviewPayload 附件块与无附件兼容", () => {
  const t_plain = buildReviewPayload("Bash", { command: "ls" }, 8000);
  assert.equal(t_plain, '审查以下工具调用，只输出结论 JSON：\n{"tool_name":"Bash","tool_input":{"command":"ls"}}', "无附件保持旧格式");

  const t_attach = {
    files: [{ path: "D:/app/a.py", content: "print('x')", truncated: false, total_bytes: 10 }],
    notes: ["b.py: 无法读取，未附加"],
  };
  const t_payload = buildReviewPayload("Bash", { command: "python a.py" }, 8000, t_attach);
  assert.ok(t_payload.includes("命令引用的脚本文件内容"), "附件块标题");
  assert.ok(t_payload.includes("D:/app/a.py"));
  assert.ok(t_payload.includes("print('x')"));
  assert.ok(t_payload.includes("10 字节"), "大小标注");
  assert.ok(t_payload.includes("(附注) b.py: 无法读取，未附加"), "附注行");
});

test("reviewer: computeCacheKey 附件加盐与旧键兼容", async () => {
  const { createHash } = await import("node:crypto");
  // 无加盐串时与旧版公式完全一致：历史缓存/白名单条目不受升级影响
  const t_legacy = createHash("sha256").update('Bash\n{"command":"python a.py"}').digest("hex");
  assert.equal(computeCacheKey("Bash", { command: "python a.py" }), t_legacy);
  assert.equal(computeCacheKey("Bash", { command: "python a.py" }, ""), t_legacy);

  const t_attach_a = { files: [{ path: "a.py", content: "v1", truncated: false, total_bytes: 2 }], notes: [] };
  const t_attach_b = { files: [{ path: "a.py", content: "v2", truncated: false, total_bytes: 2 }], notes: [] };
  const t_key_a = computeCacheKey("Bash", { command: "python a.py" }, hashAttachments(t_attach_a));
  const t_key_b = computeCacheKey("Bash", { command: "python a.py" }, hashAttachments(t_attach_b));
  assert.notEqual(t_key_a, t_legacy, "有附件时键必须与旧键不同");
  assert.notEqual(t_key_a, t_key_b, "脚本内容变化缓存键必须变化");
  assert.equal(hashAttachments(null), "", "空附件加盐串为空");
});

test("收尾: 清理临时目录", () => {
  fs.rmSync(t_tmp_dir, { recursive: true, force: true });
});
