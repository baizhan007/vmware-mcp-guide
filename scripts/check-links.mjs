#!/usr/bin/env node
// 检查 Markdown 里的相对链接是否指向真实存在的文件。
// 用法: node scripts/check-links.mjs
// 退出码: 0 全部有效, 1 存在断链

import { readFileSync, existsSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".github"]);

/** 递归收集所有 .md 文件 */
function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectMarkdown(join(dir, entry.name), out);
    } else if (entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** 提取 Markdown 里的链接目标：[text](target) 和 ![alt](target) */
function extractLinks(markdown) {
  const links = [];
  // 先去掉围栏代码块，避免把示例代码里的括号当链接
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/[^\n]/g, " ")
  );
  const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(withoutFences)) !== null) {
    links.push({ target: m[1], index: m.index });
  }
  return links;
}

/** 由字符偏移算出所在行号 */
function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

const problems = [];
const files = collectMarkdown(ROOT);
let checked = 0;

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  for (const { target, index } of extractLinks(raw)) {
    // 跳过外链、锚点、mailto
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    checked++;

    const [pathPart] = target.split("#");
    if (!pathPart) continue; // 纯锚点

    let decoded = pathPart;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      /* 保留原样 */
    }

    const abs = resolve(dirname(file), decoded);
    if (!existsSync(abs)) {
      problems.push({
        file: relative(ROOT, file),
        line: lineAt(raw, index),
        target,
        reason: "目标文件不存在",
      });
      continue;
    }
    // 目录链接要求以 / 结尾，便于 GitHub 渲染
    if (statSync(abs).isDirectory() && !target.endsWith("/")) {
      problems.push({
        file: relative(ROOT, file),
        line: lineAt(raw, index),
        target,
        reason: "目录链接应以 / 结尾",
      });
    }
  }
}

console.log(`检查了 ${files.length} 个 Markdown 文件，${checked} 个相对链接。`);

if (problems.length === 0) {
  console.log("✓ 没有断链");
  process.exit(0);
}

console.error(`\n✗ 发现 ${problems.length} 个问题：\n`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  ->  ${p.target}`);
  console.error(`      ${p.reason}`);
}
process.exit(1);
