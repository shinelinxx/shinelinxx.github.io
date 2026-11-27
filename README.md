# shinelinxx.github.io

极简、零外部依赖的 **Markdown → HTML** 静态分享站（GitHub Pages 自动构建与发布）。

> 2016 年原 Hexo 博客内容已完整保留在 `archive-2016-hexo` 分支。

## 新增一篇分享（2 步搞定）

1. 在 `posts/` 目录下新建一个脱敏后的 Markdown 文件，例如 `posts/my-guide.md`：

```markdown
---
title: 文章标题
date: 2026-11-27
updated: 2026-11-27
summary: 一句话摘要
tags:
  - 攻略
unlisted: false # 设为 true 时不显示在首页，仅持直链可访问
noindex: true   # 默认 true，禁止搜索引擎抓取
---

## 正文标题

写标准 Markdown（支持表格、代码块、`> [!WARNING]` 提示框、折叠块等）。
```

2. 本地校验并推送：

```bash
node scripts/build.mjs
git add posts/my-guide.md
git commit -m "post: add my-guide"
git push
```

推送到 `main` 后，GitHub Actions 会在约 20 秒内自动完成脱敏扫描并上线至：
`https://shinelinxx.github.io/my-guide/`

## 安全脱敏门禁

`scripts/privacy-check.mjs` 会在每次本地构建与 GitHub Actions 发布前自动运行，拦截个人邮箱、手机号、内网/私密域名、API Token、密钥与个人卡号尾号等信息。
