#!/usr/bin/env node
/**
 * 极简零依赖 Markdown -> HTML 静态分享站构建器
 * - 读取 posts/*.md（支持 YAML Frontmatter、GFM 表格、Alerts 提示框、代码块、列表、折叠块）
 * - 可选拷贝 raw/ 下自定义静态 HTML
 * - 自动运行 privacy-check.mjs 脱敏门禁
 * - 输出至 dist/（供 GitHub Pages Actions 直接发布）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, 'posts');
const RAW_DIR = path.join(ROOT, 'raw');
const DIST_DIR = path.join(ROOT, 'dist');
const SITE_TITLE = 'Notes & Guides';
const SITE_DESC = '实用攻略与工具笔记分享';

// 1. 先跑强制脱敏检查
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'privacy-check.mjs')], {
  stdio: 'inherit',
});

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const yaml = m[1];
  const body = m[2];
  const meta = {};
  let currentKey = null;

  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(stripQuotes(listMatch[1].trim()));
      continue;
    }
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      currentKey = key;
      if (val === '') {
        meta[key] = [];
      } else if (val === 'true') {
        meta[key] = true;
      } else if (val === 'false') {
        meta[key] = false;
      } else if (val.startsWith('[') && val.endsWith(']')) {
        meta[key] = val
          .slice(1, -1)
          .split(',')
          .map((x) => stripQuotes(x.trim()))
          .filter(Boolean);
      } else {
        meta[key] = stripQuotes(val);
      }
    }
  }
  return { meta, body };
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function renderInline(text) {
  const codeSlots = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code>${esc(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  s = esc(s);
  // Images ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const external = /^https?:\/\//i.test(url);
    const extra = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${url}"${extra}>${label}</a>`;
  });
  // Bold + Italic
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Restore inline code
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSlots[Number(i)]);
  return s;
}

function slugifyHeading(text, used) {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-') || 'section';
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n++}`;
  }
  used.add(id);
  return id;
}

function parseTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

const ALERT_MAP = {
  NOTE: { cls: 'alert-note', label: '说明' },
  TIP: { cls: 'alert-tip', label: '建议' },
  IMPORTANT: { cls: 'alert-important', label: '重点' },
  WARNING: { cls: 'alert-warning', label: '注意' },
  CAUTION: { cls: 'alert-caution', label: '避雷警告' },
};

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const headings = [];
  const usedIds = new Set();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Raw HTML block passthrough (<details>, </details>, <summary>, <div>, <br>, etc.)
    if (/^\s*<(?:details|\/details|summary|div|\/div|hr\b)/i.test(line)) {
      html.push(line);
      i++;
      continue;
    }

    // Fenced code block
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const cls = lang ? ` class="lang-${esc(lang)}"` : '';
      html.push(`<pre><code${cls}>${esc(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      html.push('<hr />');
      i++;
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const rawText = hMatch[2].trim();
      const id = slugifyHeading(rawText, usedIds);
      if (level === 2 || level === 3) {
        headings.push({ level, id, text: rawText.replace(/[*_`~]/g, '') });
      }
      html.push(`<h${level} id="${esc(id)}">${renderInline(rawText)}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote / GitHub Alert
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const first = quoteLines[0] || '';
      const alertMatch = first.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alertMatch) {
        const type = alertMatch[1].toUpperCase();
        const info = ALERT_MAP[type] || ALERT_MAP.NOTE;
        const customTitle = alertMatch[2]?.trim();
        const rest = quoteLines.slice(1).join('\n').trim();
        const inner = rest ? renderMarkdown(rest).html : '';
        html.push(
          `<div class="alert ${info.cls}"><div class="alert-title">${esc(customTitle || info.label)}</div>${inner}</div>`
        );
      } else {
        const inner = renderMarkdown(quoteLines.join('\n')).html;
        html.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    // GFM Table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseTableCells(line);
      const aligns = parseTableCells(lines[i + 1]).map((sep) => {
        if (sep.startsWith(':') && sep.endsWith(':')) return 'center';
        if (sep.endsWith(':')) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(parseTableCells(lines[i]));
        i++;
      }
      const thead = headers
        .map((h, idx) => `<th style="text-align:${aligns[idx] || 'left'}">${renderInline(h)}</th>`)
        .join('');
      const tbody = rows
        .map(
          (r) =>
            `<tr>${headers
              .map((_, idx) => `<td style="text-align:${aligns[idx] || 'left'}">${renderInline(r[idx] || '')}</td>`)
              .join('')}</tr>`
        )
        .join('');
      html.push(`<div class="table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }

    // Unordered / Ordered Lists
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const tag = isOrdered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = isOrdered ? cur.match(/^(\s*)\d+\.\s+(.*)$/) : cur.match(/^(\s*)[-*+]\s+(.*)$/);
        if (m) {
          let content = m[2];
          // Task checkbox support
          if (!isOrdered) {
            content = content
              .replace(/^\[x\]\s+/i, '<span class="chk chk-done">✓</span> ')
              .replace(/^\[\s\]\s+/, '<span class="chk">○</span> ');
          }
          items.push(content);
          i++;
        } else if (cur.startsWith('  ') && items.length > 0 && cur.trim()) {
          items[items.length - 1] += '<br />' + cur.trim();
          i++;
        } else {
          break;
        }
      }
      const lis = items
        .map((it) => {
          const parts = it.split('<br />').map((p) => {
            if (p.startsWith('<span class="chk')) {
              const idx = p.indexOf('</span> ');
              return p.slice(0, idx + 8) + renderInline(p.slice(idx + 8));
            }
            return renderInline(p);
          });
          return `<li>${parts.join('<br />')}</li>`;
        })
        .join('');
      html.push(`<${tag}>${lis}</${tag}>`);
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|\s*>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*(?:---|\*\*\*|___)\s*$|\s*<(?:details|\/details|summary|div|\/div|hr\b))/i.test(
        lines[i]
      ) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    html.push(`<p>${renderInline(paraLines.join(' '))}</p>`);
  }

  return { html: html.join('\n'), headings };
}

const BASE_CSS = `
:root {
  --bg: #f6f7fb;
  --surface: #ffffff;
  --surface-soft: #f8fafc;
  --ink: #111827;
  --ink-2: #374151;
  --muted: #6b7280;
  --border: #e5e7eb;
  --primary: #1d4ed8;
  --primary-soft: #eff6ff;
  --primary-border: #bfdbfe;
  --emerald: #047857;
  --emerald-soft: #ecfdf5;
  --emerald-border: #a7f3d0;
  --amber: #b45309;
  --amber-soft: #fffbeb;
  --amber-border: #fde68a;
  --rose: #be123c;
  --rose-soft: #fff1f2;
  --rose-border: #fecdd3;
  --shadow: 0 8px 26px rgba(15, 23, 42, 0.06);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
  line-height: 1.72;
  font-size: 15.5px;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 20px 16px 56px; }
.topbar {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  margin-bottom: 14px; font-size: 13px; color: var(--muted);
}
.topbar a { color: var(--muted); text-decoration: none; font-weight: 600; }
.topbar a:hover { color: var(--primary); }
.hero {
  background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 58%, #1d4ed8 100%);
  color: #fff; border-radius: 20px; padding: 26px 24px 22px;
  box-shadow: 0 14px 34px rgba(30, 58, 138, 0.2); margin-bottom: 18px;
}
.hero-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.chip {
  font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
  background: rgba(255,255,255,0.16); border: 1px solid rgba(255,255,255,0.24); color: #f8fafc;
}
.hero h1 { margin: 0 0 8px; font-size: clamp(22px, 5vw, 30px); line-height: 1.28; font-weight: 800; }
.hero p { margin: 0; color: rgba(241,245,249,0.92); font-size: 14.5px; }
.toc {
  background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  padding: 12px 16px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(15,23,42,0.04);
}
.toc-title { font-size: 12.5px; font-weight: 700; color: var(--muted); margin-bottom: 6px; }
.toc-links { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.toc-links a { font-size: 13.5px; color: var(--primary); text-decoration: none; font-weight: 600; }
.toc-links a:hover { text-decoration: underline; }
.article {
  background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
  padding: 26px 24px; box-shadow: var(--shadow);
}
.article h2 {
  margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
  font-size: 19px; font-weight: 800; color: var(--ink);
}
.article h2:first-child { margin-top: 0; }
.article h3 { margin: 20px 0 8px; font-size: 16.5px; font-weight: 800; color: var(--ink); }
.article h4 { margin: 16px 0 6px; font-size: 15px; font-weight: 700; color: var(--ink-2); }
.article p { margin: 0 0 12px; color: var(--ink-2); }
.article ul, .article ol { margin: 0 0 14px; padding-left: 22px; color: var(--ink-2); }
.article li { margin-bottom: 6px; }
.article strong { color: var(--ink); }
.article a { color: var(--primary); text-decoration: none; font-weight: 500; }
.article a:hover { text-decoration: underline; }
.article hr { border: none; border-top: 1px solid var(--border); margin: 22px 0; }
.article code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px; background: #f1f5f9; color: #0f172a; padding: 2px 6px; border-radius: 6px;
}
.article pre {
  background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 12px;
  overflow-x: auto; margin: 0 0 14px; line-height: 1.55;
}
.article pre code { background: transparent; color: inherit; padding: 0; font-size: 13px; }
.article blockquote {
  margin: 0 0 14px; padding: 11px 15px; border-left: 4px solid var(--primary);
  background: var(--surface-soft); border-radius: 0 10px 10px 0; color: var(--ink-2);
}
.article blockquote p:last-child { margin-bottom: 0; }
.alert {
  margin: 0 0 16px; padding: 12px 15px; border-radius: 12px; border: 1px solid var(--border);
  font-size: 14.5px;
}
.alert-title { font-weight: 800; font-size: 13.5px; margin-bottom: 4px; }
.alert p:last-child { margin-bottom: 0; }
.alert-note { background: var(--primary-soft); border-color: var(--primary-border); color: #1e3a8a; }
.alert-tip { background: var(--emerald-soft); border-color: var(--emerald-border); color: #065f46; }
.alert-important { background: #f5f3ff; border-color: #ddd6fe; color: #5b21b6; }
.alert-warning { background: var(--amber-soft); border-color: var(--amber-border); color: #92400e; }
.alert-caution { background: var(--rose-soft); border-color: var(--rose-border); color: #9f1239; }
.table-wrap {
  overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 0 16px;
  border: 1px solid var(--border); border-radius: 12px;
}
table { width: 100%; border-collapse: collapse; min-width: 540px; font-size: 13.5px; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { background: var(--surface-soft); font-weight: 700; color: var(--ink); white-space: nowrap; }
tr:last-child td { border-bottom: none; }
details {
  background: var(--surface-soft); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 15px; margin: 0 0 14px;
}
summary { cursor: pointer; font-weight: 700; color: var(--ink); }
.chk { display: inline-block; width: 16px; font-weight: 700; color: var(--muted); }
.chk-done { color: var(--emerald); }
.post-grid { display: flex; flex-direction: column; gap: 12px; }
.post-card {
  display: block; text-decoration: none; color: inherit;
  background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
  padding: 18px 20px; box-shadow: 0 2px 8px rgba(15,23,42,0.04); transition: transform .15s, border-color .15s;
}
.post-card:hover { transform: translateY(-1px); border-color: var(--primary-border); }
.post-card h2 { margin: 0 0 6px; font-size: 17.5px; font-weight: 800; color: var(--ink); border: none; padding: 0; }
.post-card p { margin: 0 0 8px; font-size: 14px; color: var(--ink-2); }
.post-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12.5px; color: var(--muted); }
.tag { background: #f1f5f9; color: #334155; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.footer {
  margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border);
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px;
  font-size: 12.5px; color: var(--muted);
}
.copy-btn {
  appearance: none; border: 1px solid #d1d5db; background: #fff; color: var(--ink);
  padding: 6px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.copy-btn:hover { border-color: var(--primary); color: var(--primary); }
@media (max-width: 600px) {
  .wrap { padding: 14px 12px 44px; }
  .hero { padding: 20px 18px 18px; border-radius: 16px; }
  .article { padding: 18px 16px; border-radius: 14px; }
}
`;

function layoutHtml({ title, summary, date, updated, tags = [], noindex = true, toc = [], bodyHtml, isIndex = false }) {
  const robots = noindex ? '<meta name="robots" content="noindex, nofollow, noarchive" />' : '';
  const metaChips = [
    updated ? `📅 更新于 ${updated}` : date ? `📅 ${date}` : '',
    ...tags.map((t) => `# ${t}`),
  ]
    .filter(Boolean)
    .map((c) => `<span class="chip">${esc(c)}</span>`)
    .join('');

  const tocHtml =
    !isIndex && toc.filter((h) => h.level === 2).length >= 2
      ? `<nav class="toc" aria-label="目录"><div class="toc-title">快速导航</div><div class="toc-links">${toc
          .filter((h) => h.level === 2)
          .map((h) => `<a href="#${esc(h.id)}">${esc(h.text)}</a>`)
          .join('')}</div></nav>`
      : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  ${robots}
  <meta name="description" content="${esc(summary || title)}" />
  <title>${esc(title)}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <main class="wrap">
    ${isIndex ? '' : '<div class="topbar"><a href="/">← 返回分享目录</a><span>脱敏整理 · 仅供交流参考</span></div>'}
    <header class="hero">
      ${metaChips ? `<div class="hero-meta">${metaChips}</div>` : ''}
      <h1>${esc(title)}</h1>
      ${summary ? `<p>${esc(summary)}</p>` : ''}
    </header>
    ${tocHtml}
    ${isIndex ? bodyHtml : `<article class="article">${bodyHtml}</article>`}
    <footer class="footer">
      <span>${updated ? `最后更新：${esc(updated)} · ` : ''}纯静态页面 · 零追踪</span>
      <button class="copy-btn" id="copyBtn" type="button">📋 复制分享链接</button>
    </footer>
  </main>
  <script>
    (function(){
      var b = document.getElementById('copyBtn');
      if (!b) return;
      b.addEventListener('click', function(){
        var u = window.location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(u).then(done, fallback);
        } else { fallback(); }
        function done(){ b.textContent = '✓ 已复制链接'; setTimeout(function(){ b.textContent = '📋 复制分享链接'; }, 1800); }
        function fallback(){ var i = document.createElement('input'); i.value = u; document.body.appendChild(i); i.select(); document.execCommand('copy'); document.body.removeChild(i); done(); }
      });
    })();
  </script>
</body>
</html>`;
}

// 2. 清空并重建 dist/
fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

const posts = [];
if (fs.existsSync(POSTS_DIR)) {
  for (const file of fs.readdirSync(POSTS_DIR)) {
    if (!file.endsWith('.md')) continue;
    const slug = file.replace(/\.md$/, '');
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const { html, headings } = renderMarkdown(body);
    const post = {
      slug,
      title: meta.title || slug,
      summary: meta.summary || '',
      date: meta.date || '',
      updated: meta.updated || meta.date || '',
      tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
      unlisted: meta.unlisted === true,
      noindex: meta.noindex !== false,
    };
    const outDir = path.join(DIST_DIR, slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      layoutHtml({ ...post, toc: headings, bodyHtml: html }),
      'utf8'
    );
    posts.push(post);
  }
}

// 3. 可选拷贝 raw/ 下自定义静态文件
if (fs.existsSync(RAW_DIR)) {
  fs.cpSync(RAW_DIR, DIST_DIR, { recursive: true });
}

// 4. 生成首页（仅展示 unlisted !== true 的文章）
const listedPosts = posts
  .filter((p) => !p.unlisted)
  .sort((a, b) => String(b.updated || b.date).localeCompare(String(a.updated || a.date)));

const indexBody =
  listedPosts.length === 0
    ? '<section class="article"><p>暂无公开索引文章，请通过分享直链访问指定页面。</p></section>'
    : `<section class="post-grid">${listedPosts
        .map(
          (p) => `<a class="post-card" href="./${esc(p.slug)}/">
            <h2>${esc(p.title)}</h2>
            ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
            <div class="post-meta">
              ${p.updated ? `<span>📅 ${esc(p.updated)}</span>` : ''}
              ${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
            </div>
          </a>`
        )
        .join('')}</section>`;

fs.writeFileSync(
  path.join(DIST_DIR, 'index.html'),
  layoutHtml({
    title: SITE_TITLE,
    summary: SITE_DESC,
    noindex: true,
    bodyHtml: indexBody,
    isIndex: true,
  }),
  'utf8'
);

// 5. 生成 robots.txt、.nojekyll 与简洁 404.html
fs.writeFileSync(path.join(DIST_DIR, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');
fs.writeFileSync(path.join(DIST_DIR, '.nojekyll'), '', 'utf8');
fs.writeFileSync(
  path.join(DIST_DIR, '404.html'),
  layoutHtml({
    title: '404 · 页面不存在',
    summary: '请检查分享链接是否完整。',
    noindex: true,
    bodyHtml: '<section class="article"><p>未找到对应页面。<a href="/">返回目录</a></p></section>',
    isIndex: true,
  }),
  'utf8'
);

console.log(`✅ Built ${posts.length} markdown post(s) into dist/ (${listedPosts.length} listed on index).`);
