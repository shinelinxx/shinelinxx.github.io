#!/usr/bin/env node
/**
 * 公开分享仓脱敏安全门禁（零依赖）
 * 扫描 posts/ 与 raw/ 中所有待发布文件，一旦命中隐私/密钥/内网信息立即阻断构建与推送。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGET_DIRS = ['posts', 'raw'];
const CHECK_EXTS = new Set(['.md', '.html', '.htm', '.txt', '.json', '.css', '.js']);

const RULES = [
  {
    name: 'Private Email',
    regex: /\b[a-zA-Z0-9._%+-]+@(?:gmail|qq|icloud|outlook|hotmail|163|126|proton)\.[a-zA-Z]{2,}\b/i,
  },
  {
    name: 'Personal Domain Internal Host',
    regex: /\b(?:order|paseo|mo|gz|tx|dify|bot|agy|hk)\.shinelin\.net\b/i,
  },
  {
    name: 'Local Absolute Path',
    regex: /\/Users\/[a-zA-Z0-9._-]+|C:\\Users\\[a-zA-Z0-9._-]+/,
  },
  {
    name: 'LAN / Loopback IP',
    regex: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.0\.0\.1:\d+)\b/,
  },
  {
    name: 'WeChat Internal ID',
    regex: /\bwxid_[a-zA-Z0-9_-]{6,}\b|\d{8,}@chatroom\b/,
  },
  {
    name: 'API Token / Private Key',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[0-9A-Za-z-]{10,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: 'CN Mobile Phone',
    regex: /(?<!\d)1[3-9]\d{9}(?!\d)/,
  },
  {
    name: 'Card Last-4 / Sensitive Personal Info',
    regex: /尾号\s*[:：]?\s*\d{4}|(?:SSN|ITIN)\s*[:：]?\s*\d{3}-\d{2}-\d{4}/i,
  },
  {
    name: 'Private ZSXQ Group/Topic Direct Link',
    regex: /wx\.zsxq\.com\/group\/\d+/i,
  },
];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (CHECK_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

let violations = [];
let scannedFiles = 0;

for (const dir of TARGET_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    scannedFiles++;
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (line.includes('privacy-ignore-line')) return;
      for (const rule of RULES) {
        const m = line.match(rule.regex);
        if (m) {
          violations.push({
            file: rel,
            line: idx + 1,
            rule: rule.name,
            sample: m[0].slice(0, 48),
          });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`\n❌ Privacy check FAILED (${violations.length} violation(s) found):\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${v.line} [${v.rule}] -> ${v.sample}`);
  }
  console.error('\n请先脱敏处理后再构建或推送（如确为无害示例，可在该行添加 <!-- privacy-ignore-line -->）。\n');
  process.exit(1);
}

console.log(`✅ Privacy check passed (${scannedFiles} file(s) scanned, 0 violations).`);
