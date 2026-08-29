/**
 * 模块功能: 文档隐私清洗——移除个人路径/账户信息（一次性维护脚本）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 全仓库扫描 .md 文件，替换泄露盘符结构/用户名/provider 账户名的字符串
 * 用法: node scripts/sanitize_docs.mjs
 * 更新日期: 2026年08月29日
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const t_root = path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");

// 长模式优先；作者名 hh-zyb 不受影响
const g_rules = [
  [/D:\\Demo\\DemoSuperVisionForZcode|D:\/Demo\/DemoSuperVisionForZcode/g, "<项目根目录>"],
  [/D:\\Demo\\test_demo|D:\/Demo\/test_demo/g, "<项目外测试目录>"],
  [/D:\\Demo(?![\w/\\])|D:\/Demo(?![\w/\\])/g, "<项目父目录>"],
  [/C:\\Users\\zyb|C:\/Users\/zyb/g, "~"],
  [/本机 XX 订阅套餐 \/ anthropic 协议/g, "本机启用的 provider（anthropic 协议）"],
];

const g_files = [];
function walk(dir) {
  for (const t_entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (t_entry.name === ".git" || t_entry.name === "node_modules") {
      continue;
    }
    const t_path = path.join(dir, t_entry.name);
    if (t_entry.isDirectory()) {
      walk(t_path);
    } else if (t_entry.name.endsWith(".md")) {
      g_files.push(t_path);
    }
  }
}
walk(t_root);

let t_changed = 0;
for (const t_file of g_files) {
  const t_source = fs.readFileSync(t_file, "utf8");
  let t_result = t_source;
  for (const [t_re, t_to] of g_rules) {
    t_result = t_result.replace(t_re, t_to);
  }
  if (t_result !== t_source) {
    fs.writeFileSync(t_file, t_result, "utf8");
    t_changed++;
    console.log("已清洗:", path.relative(t_root, t_file));
  }
}
console.log(`共清洗 ${t_changed} 个文件 / 扫描 ${g_files.length} 个 md`);
