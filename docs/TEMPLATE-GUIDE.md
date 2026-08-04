# Tufte 极简模版 — 使用指南

> 基于 LoveEleve/openjdk-book 的 Tufte 重构提取。本文档随项目一起 git 版本管理，换机器也不会丢。

---

## 一、跨文章引用正确写法

**规则：用 docsify 根路径相对格式，不加 `#/`，不加 `../`。**

| 写法 | 效果 | 正确性 |
|------|------|--------|
| `[文字](openjdk/vol-01/ch03/overview)` | ✅ 推荐（不带 `.md`） | 正确 |
| `[文字](openjdk/vol-01/ch03/overview.md)` | ✅ 带 `.md` 也可以 | 正确 |
| `[文字](同目录文件)` | ✅ 同级目录可用 | 正确 |
| `[文字](../ch03/overview.md)` | ❌ `../` 在 hash 路由里是字面文本 → 404 | 错误 |
| `[文字](#/openjdk/vol-01/…)`  | ❌ `#/` 被 docsify 当成同页锚点 → 跳转失败 | 错误 |

**图片**：继续用相对路径，浏览器会自行解析。

---

## 二、边注（Sidenote）语法

| 语法 | 示例 |
|------|------|
| 行内边注 | `正文内容^[这条注释出现在右边距区]` |
| 标准注脚 | `正文[^1]`...`[^1]: 这是注脚定义`（定义行会被自动移除） |

边注行为：≥1200px 右栏浮动 / <1200px 行内左竖线 / <760px 点击编号展开

---

## 三、模版文件清单

```
项目根/
├── index.html                          # 唯一 HTML 入口
├── docs/
│   ├── README.md                       # 首页
│   ├── _sidebar.md                     # 目录（loadSidebar:false，仅用于搜索索引）
│   └── assets/
│       ├── common.js                   # JS（docsify配置/边注/TOC/搜索/giscus）
│       ├── tufte.css                   # 唯一样式表
│       ├── giscus-theme.css            # giscus 评论区主题（可选）
│       └── fonts/
│           └── et-book/
│               ├── et-book-roman-line-figures.woff
│               ├── et-book-display-italic-old-style-figures.woff
│               ├── et-book-bold-line-figures.woff
│               ├── et-book-roman-old-style-figures.woff
│               └── et-book-semi-bold-old-style-figures.woff
├── CNAME                               # 域名（可选）
└── TEMPLATE-GUIDE.md                   # 本文档
```

---

## 四、index.html 骨架

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>你的站名</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" />
  <link rel="stylesheet" href="docs/assets/tufte.css?v=1" />
</head>
<body>
  <div id="app">正在加载...</div>
  <script>
    window.__blogHooks = window.__blogHooks || {};
    window.__blogHooks.pageConfig = { basePath: 'docs/' };
  </script>
  <script src="docs/assets/common.js?v=1"></script>
  <script src="https://cdn.jsdelivr.net/npm/medium-zoom@1/dist/medium-zoom.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4/lib/docsify.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-bash.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-c.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-cpp.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-java.min.js" defer></script>
</body>
</html>
```

---

## 五、common.js 适配新项目

需要修改的配置项：

| 位置 | 说明 |
|------|------|
| `pageConfig.basePath`（index.html） | 内容根目录，如 `docs/` |
| `$docsify.alias` | 路径别名，按需配 |
| `GISCUS_CFG` | giscus 参数（repo/repoId/category），不用的删 |
| `GISCUS_THEME` | giscus 主题 URL，不用的删 |
| `markdown.renderer.code` | 代码块默认语言（现默认 java） |

---

## 六、tufte.css 可调参数

```css
:root {
  --ink: #111;          /* 正文墨色 */
  --ink-soft: #444;     /* 次要文字 */
  --ink-faint: #888;    /* 三级灰 */
  --paper: #fffff8;     /* 纸面底色 */
  --rule: #ddd8cc;      /* 细线色 */
  --body-font: etbook, "Noto Serif SC", serif;
  --code-font: "JetBrains Mono", monospace;
  --text-width: 700px;  /* 正文栏宽 */
  --page-max: 1400px;   /* 页面最大宽 */
}
```

---

## 七、适配新项目步骤

1. 复制 `index.html` + `docs/assets/` 全部 + `docs/assets/fonts/et-book/`
2. 改 `index.html` 的 `<title>` 和 `basePath`
3. 改 `common.js` 的 giscus 参数（或删除 giscus 段）
4. 调 `tufte.css` 颜色变量适配新调色板
5. 创建 `docs/README.md` 首页
6. 创建文章目录，所有跨文章链接用 `path/to/file` 格式
7. 文章中用 `^[...]` 或 `[^id]` 写边注
8. 本地 `python3 -m http.server 8899 --directory .` 预览

---

## 八、已知坑

- `**粗体含[方括号]**` → marked 失败，写成 `<strong>粗体含[方括号]</strong>`
- ASCII 画线 ┌┐└┘ 与中文混排可能不对齐 → 改用纯 ASCII `+-|`
- giscus 自定义主题在 localhost 被 Chrome 拦截 → 公网部署后正常（或走 jsdelivr CDN）
