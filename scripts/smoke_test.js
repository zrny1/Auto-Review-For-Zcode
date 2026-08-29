/**
 * 模块功能: 端到端冒烟测试——以子进程方式运行 hook_main.js 与 ctl.js，模拟真实 hook 输入
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 覆盖决策管线六个分支与 ctl 控制脚本全命令；
 *       provider 指向必然拒绝连接的本地端口，验证失败兜底（不触网、不消耗真实额度）
 * 依赖: node:child_process node:assert node:fs node:os node:path
 * 用法: node scripts/smoke_test.js
 * 更新日期: 2026年08月29日
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const t_root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const t_hook = path.join(t_root, "src", "hook_main.js");
const t_ctl = path.join(t_root, "src", "ctl.js");

// 每次冒烟用独立临时数据目录，避免污染真实用户数据
const t_data_dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-smoke-"));
// 假 ZCode 配置：enabled 的 anthropic provider 指向必然 ECONNREFUSED 的本地端口
const t_zcode_config = path.join(t_data_dir, "zcode_config.json");
fs.writeFileSync(t_zcode_config, JSON.stringify({
  provider: {
    "builtin:dead": {
      name: "Dead", kind: "anthropic", enabled: true,
      options: { baseURL: "http://127.0.0.1:1/api/anthropic", apiKey: "smoke-key" },
      models: { "dead-model": {} },
    },
  },
}));

// 通过配置文件把开关打开（enabled 默认 false，冒烟需要显式开启）
fs.writeFileSync(path.join(t_data_dir, "settings.json"), JSON.stringify({
  enabled: true, review_tools: ["Bash"], provider: "", model: "",
  timeout_ms: 5000, cache_ttl_seconds: 0, max_payload_chars: 8000,
}));

// AUTO_REVIEW_DISABLE_TOAST：冒烟中的 ask 用例不弹真实系统通知
const t_env = { ...process.env, AUTO_REVIEW_DATA_DIR: t_data_dir, AUTO_REVIEW_ZCODE_CONFIG: t_zcode_config, AUTO_REVIEW_DISABLE_TOAST: "1" };

let g_pass_count = 0;

/**
 * 函数功能: 执行一次 hook 冒烟并断言结果
 * @param {string} name - 用例名
 * @param {string} stdin_text - 模拟的 hook stdin
 * @param {object} expect - {stdout_json|null, exit_code}
 * @returns {void}
 */
function runHookCase(name, stdin_text, expect) {
  const t_result = spawnSync("node", [t_hook], { input: stdin_text, env: t_env, encoding: "utf8", timeout: 30000 });
  const t_exit = t_result.status;
  const t_stdout = (t_result.stdout || "").trim();
  if (expect.stdout_json === null) {
    assert.equal(t_stdout, "", `${name}: 期望空输出`);
    assert.equal(t_exit, 0, `${name}: 期望 exit 0`);
  } else {
    assert.equal(t_exit, expect.exit_code ?? 0, `${name}: exit code`);
    const t_payload = JSON.parse(t_stdout);
    if (expect.decision) {
      assert.equal(t_payload.hookSpecificOutput.permissionDecision, expect.decision, `${name}: decision`);
      if (expect.reason_includes) {
        assert.ok(t_payload.hookSpecificOutput.permissionDecisionReason.includes(expect.reason_includes), `${name}: reason 内容`);
      }
    }
  }
  g_pass_count++;
  console.log(`  ok - ${name}`);
}

/**
 * 函数功能: 执行一次 ctl 冒烟并断言退出码与输出片段
 * @param {string[]} args - ctl 参数
 * @param {object} expect - {exit_code, stdout_includes?}
 * @returns {object} spawn 结果
 */
function runCtl(args, expect) {
  const t_result = spawnSync("node", [t_ctl, ...args], { env: t_env, encoding: "utf8", timeout: 30000 });
  assert.equal(t_result.status, expect.exit_code ?? 0, `ctl ${args.join(" ")}: exit code`);
  if (expect.stdout_includes) {
    assert.ok((t_result.stdout || "").includes(expect.stdout_includes), `ctl ${args.join(" ")}: 输出应包含 "${expect.stdout_includes}"`);
  }
  if (expect.stderr_includes) {
    assert.ok((t_result.stderr || "").includes(expect.stderr_includes), `ctl ${args.join(" ")}: 错误应包含 "${expect.stderr_includes}"`);
  }
  return t_result;
}

console.log("hook_main.js 决策管线分支:");

// ① 开关关闭 → 不干预（空输出，内置流程继续）
fs.writeFileSync(path.join(t_data_dir, "settings.json"), JSON.stringify({ enabled: false }));
runHookCase("开关关闭 → 空输出放行", JSON.stringify({
  tool_name: "Bash", tool_input: { command: "ls -la" },
}), { stdout_json: null });

// 重新开启，后续用例生效
fs.writeFileSync(path.join(t_data_dir, "settings.json"), JSON.stringify({
  enabled: true, review_tools: ["Bash"], timeout_ms: 5000, cache_ttl_seconds: 0,
}));

// ② 非审查工具（Read 不在 review_tools）→ 不干预
runHookCase("非审查工具 → 空输出放行", JSON.stringify({
  tool_name: "Read", tool_input: { file_path: "D:/a.txt" },
}), { stdout_json: null });

// ③ 危险命令命中出厂规则 → deny（不经过 LLM）
runHookCase("危险命令 rm -rf / → 规则拦截", JSON.stringify({
  tool_name: "Bash", tool_input: { command: "rm -rf /", description: "清理" },
}), { decision: "deny", reason_includes: "危险规则" });

// ④ 白名单规则 → allow（跳过 LLM）
fs.writeFileSync(path.join(t_data_dir, "danger_rules.json"), JSON.stringify([
  { pattern: "^git\\s+status", action: "allow", description: "git status 白名单" },
]));
runHookCase("白名单命令 → 规则放行", JSON.stringify({
  tool_name: "Bash", tool_input: { command: "git status" },
}), { decision: "allow", reason_includes: "白名单" });
fs.rmSync(path.join(t_data_dir, "danger_rules.json"));

// ⑤ 普通命令 + LLM 不可达 → 兜底 ask（宁转人工不放行）
runHookCase("LLM 不可达 → 兜底转人工", JSON.stringify({
  tool_name: "Bash", tool_input: { command: "echo hello" },
}), { decision: "ask", reason_includes: "安全审查不可用" });

// ⑥ stdin 非法 → 不干预
runHookCase("stdin 非法 JSON → 空输出放行", "这不是JSON{{{", { stdout_json: null });

// ⑦ toolName 兼容字段 + Write 别名 ApplyPatch（不在 review_tools，应跳过）
runHookCase("toolName 兼容字段", JSON.stringify({
  toolName: "Bash", tool_input: { command: "echo compat" },
}), { decision: "ask", reason_includes: "安全审查不可用" });

console.log("ctl.js 控制脚本命令:");

runCtl(["status"], { stdout_includes: "enabled: true" });
g_pass_count++;
console.log("  ok - status 展示当前状态");

runCtl(["set", "model", "dead-model"], { stdout_includes: "已设置 model" });
g_pass_count++;
console.log("  ok - set 修改配置");

runCtl(["set", "bad_key", "x"], { exit_code: 1, stderr_includes: "未知配置键" });
g_pass_count++;
console.log("  ok - set 拒绝未知键");

runCtl(["rules", "add", "ask", "python\\s+-m\\s+http\\.server", "起本地HTTP服务"], { stdout_includes: "已追加规则" });
runCtl(["rules", "list"], { stdout_includes: "起本地HTTP服务" });
runCtl(["rules", "test", "python -m http.server 8080"], { stdout_includes: "命中 1 条" });
runCtl(["rules", "test", "echo hi"], { stdout_includes: "未命中" });
runCtl(["rules", "remove", "1"], { stdout_includes: "已删除" });
g_pass_count++;
console.log("  ok - rules add/list/test/remove 全链路");

runCtl(["rules", "add", "deny", "([bad", "x"], { exit_code: 1, stderr_includes: "正则编译失败" });
g_pass_count++;
console.log("  ok - rules add 拒绝非法正则");

const t_prompt_path_result = runCtl(["prompt", "path"], { stdout_includes: t_data_dir });
assert.ok(fs.existsSync(t_prompt_path_result.stdout.trim()), "prompt path 输出的文件应已物化");
g_pass_count++;
console.log("  ok - prompt path 物化并返回路径");

runCtl(["prompt", "reset"], { stdout_includes: "已恢复出厂默认提示词" });
g_pass_count++;
console.log("  ok - prompt reset");

// 收尾：清理临时目录
fs.rmSync(t_data_dir, { recursive: true, force: true });
console.log(`\n冒烟测试全部通过: ${g_pass_count} 项断言组`);
