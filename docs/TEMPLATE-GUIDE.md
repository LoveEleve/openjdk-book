# Tufte 极简阅读站 — 模版使用指南

> 从 `LoveEleve/openjdk-book` 的 Tufte 重构中提取。本文档随项目 git 管理，换机器不丢。
> 原站效果：https://openjdk-book.cn

---

## 目录

1. [跨文章引用正确写法](#一跨文章引用正确写法)
2. [边注/注脚语法](#二边注sidenote语法)
3. [模版文件清单与职责](#三模版文件清单与职责)
4. [index.html 详解](#四indexhtml-详解)
5. [common.js 适配详解](#五commonjs-适配详解)
6. [tufte.css 调参指南](#六tufte.css-调参指南)
7. [giscus 评论区（可选）](#七giscus-评论区可选)
8. [新项目适配完整步骤](#八新项目适配完整步骤)
9. [本地预览与部署](#九本地预览与部署)
10. [已知坑与解决方案](#十已知坑与解决方案)

---

## 一、跨文章引用正确写法

### 核心原则

### 核心规则

- **所有跨文章引用必须写成 `[文字](路径)` —— 决不能用纯文本。** 读者要能点击跳转。
- `docsify` 的 hash 路由 `#/` 不支持 `../` 相对路径回溯，也不要把 `#/` 写进 markdown 链接。

### ✅ 正确写法

| 链接类型 | 写法 | docsify 转成 |
|----------|------|-------------|
| 跨章引用 | `[文字](openjdk/vol-01/ch03/overview)` | `#/openjdk/vol-01/ch03/overview` |
| 跨章引用（带 .md） | `[文字](openjdk/vol-01/ch03/overview.md)` | 同上 |
| 同章引用 | `[文字](02-next-article)` | `#/openjdk/vol-01/chX/02-next-article` |
| 章节锚点 | `[文字](openjdk/vol-01/ch03/overview#section-id)` | 带锚点跳转 |
| 图片 | `![图](assets/foo.png)` | 浏览器自行解析 |
| 上级目录图片 | `![图](../assets/foo.png)` | 浏览器自行解析 ✅ |

### ❌ 错误写法

| 错误写法 | 问题 |
|----------|------|
| `[](../ch03/overview.md)` | `../` 原样保留在 hash 路由中 → `#/../ch03/...` → 404 |
| `[](#/openjdk/vol-01/ch03/overview)` | `#/` 被 docsify 当成当前页的锚点 → URL 变成 `?id=%2fopenjdk%2f...` → 跳转失败 |
| `[](../../ch03/overview.md)` | 同上，`../../` 无法回溯 |

### 为什么

`docsify` 是一个 SPA（单页应用），所有页面路由都在 URL 的 hash 片段中。
浏览器不会对 hash 片段做 `../` 路径解析——`../` 在 `#/../path` 里就是一个字面文本，不是向上跳一层。
所以跨目录引用必须用「从内容根目录出发的绝对路径」，即 `openjdk/vol-01/ch03/overview`。

---

## 二、边注（Sidenote）语法

### 行内边注

```markdown
这是一段正文。^[这条注释会出现在右侧边距区，带自动编号]
继续正文。
```

渲染效果：正文中出现上标编号 `¹`，注释内容浮动在右边距区。

### 标准注脚

```markdown
正文中引用一个注脚[^1]，继续写正文。

[^1]: 这是注脚的定义内容。支持跨行续写：
    第二行用 4 空格缩进再接。
    这一行还是同一个注脚。
```

- 定义行 `[^1]: ...` 会在渲染时被自动从正文中移除
- 定义内容支持行内代码 `` `code` `` 和链接 `[文字](url)`
- 多行续写：下一行开头 4 空格或 1 个 tab

### 边注在不同屏幕上的表现

| 屏幕宽度 | 效果 |
|----------|------|
| ≥1200px | 浮动在正文右侧边距区（带自动编号） |
| 760-1199px | 行内缩进块，左竖线 + 灰色小字，肉眼区分正文 |
| <760px | 隐藏，点击正文中的编号展开 |

---

## 三、模版文件清单与职责

```
项目根/
├── index.html                    # ① 唯一 HTML 入口，所有 CDN 引用在此
├── CNAME                         # ⑧ GitHub Pages 自定义域名（可选）
│
├── docs/
│   ├── README.md                 # ② 首页（纯 markdown）
│   ├── _sidebar.md               # ③ 目录结构（仅用于全文搜索索引）
│   ├── TEMPLATE-GUIDE.md         #   本文档
│   │
│   ├── assets/
│   │   ├── common.js             # ④ 所有前端 JS：docsify 配置、边注、TOC、搜索、giscus
│   │   ├── tufte.css             # ⑤ 唯一样式表：排版、网格、响应式、功能 UI
│   │   ├── giscus-theme.css      # ⑥ giscus 评论区自定义主题（可选，不需要评论就删）
│   │   │
│   │   └── fonts/
│   │       └── et-book/          # ⑦ 自托管西文衬线字体（5 个 woff，MIT 许可）
│   │           ├── et-book-roman-line-figures.woff
│   │           ├── et-book-display-italic-old-style-figures.woff
│   │           ├── et-book-bold-line-figures.woff
│   │           ├── et-book-roman-old-style-figures.woff
│   │           └── et-book-semi-bold-old-style-figures.woff
│   │
│   └── 你的内容目录/              # 按你的文章结构自由组织
│       ├── ch01/
│       │   └── 01-article.md
│       └── ...
```

**各文件职责**：

| 文件 | 作用 | 是否必须 |
|------|------|----------|
| `index.html` | 唯一入口，加载 docsify + 字体 CDN + JS/CSS | ✅ 必须 |
| `docs/README.md` | 首页内容 | ✅ 必须 |
| `docs/_sidebar.md` | 目录树，用于全文搜索索引构建 | 建议保留 |
| `docs/assets/common.js` | docsify 配置、边注引擎、TOC、搜索 | ✅ 必须 |
| `docs/assets/tufte.css` | 全部样式 | ✅ 必须 |
| `docs/assets/giscus-theme.css` | 评论区主题 | 可选 |
| `docs/assets/fonts/et-book/` | 西文衬线字体 | ✅ 推荐（或改 `tufte.css` 字体栈） |

---

## 四、index.html 详解

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <!-- ★ 改：站点标题 -->
  <title>你的站名</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0" />
  <meta name="referrer" content="no-referrer" />

  <!-- 字体：代码 JetBrains Mono + 正文 Noto Serif SC（思源宋体） -->
  <!-- 不需要中文字体？删掉 Noto Serif SC 这一行，改 tufte.css 的 --body-font -->
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" />

  <!-- 唯一样式表（★ 改：每次发布改版本号防 CDN 缓存） -->
  <link rel="stylesheet" href="docs/assets/tufte.css?v=1" />
</head>
<body>
  <div id="app">正在加载...</div>

  <!-- ★ 页面配置：basePath 指向你的内容根目录 -->
  <script>
    window.__blogHooks = window.__blogHooks || {};
    window.__blogHooks.pageConfig = {
      basePath: 'docs/'   // ← 改：你的内容根目录
    };
  </script>

  <!-- 公共 JS（★ 改：每次发布改版本号） -->
  <script src="docs/assets/common.js?v=1"></script>

  <!-- CDN 依赖（无需修改） -->
  <script src="https://cdn.jsdelivr.net/npm/medium-zoom@1/dist/medium-zoom.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4/lib/docsify.min.js"></script>

  <!-- 代码高亮：按你需要的语言加载，不需要的删掉 -->
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-bash.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-c.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-cpp.min.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-java.min.js" defer></script>
</body>
</html>
```

### 需要改的地方（标记了 ★）

1. `<title>` — 站点名称
2. `basePath` — 内容目录路径，通常是 `docs/`
3. `tufte.css?v=1` 和 `common.js?v=1` — 每次发布后 +1 清零用户缓存
4. 不需要中文衬线？删掉 `<link ... Noto+Serif+SC ...>` 并修改 `tufte.css` 中 `--body-font`
5. 不需要某些编程语言高亮？删掉对应的 `prism-xxx.min.js`

---

## 五、common.js 适配详解

`common.js` 包含：docsify 配置、边注/注脚引擎、TOC、全文搜索（⌘K）、giscus 评论区。

### 必须改的

**A. 路径别名**

```javascript
// common.js 第 28 行附近
alias: {
  '/你的路径别名': '/你的实际文件路径',
  // 示例：
  // '/guide': '/docs/guide/README',
},
```

**B. giscus 评论区（不用就删）**

```javascript
// common.js 第 870 行附近
var GISCUS_CFG = {
  src: 'https://giscus.app/client.js',
  repo: '你的用户名/你的仓库',              // ← 改
  repoId: 'R_xxxxxxxxxx',                   // ← 改（giscus.app 获取）
  category: 'Announcements',                // ← 改
  categoryId: 'DIC_xxxxxxxxxx',             // ← 改
  mapping: 'specific',
  strict: '0',
  reactionsEnabled: '1',
  emitMetadata: '0',
  inputPosition: 'top',
  theme: GISCUS_THEME,
  lang: 'zh-CN'
};
```

要完全删除 giscus，删掉以下代码段：
- `GISCUS_CFG` 整个对象
- `GISCUS_THEME` 变量定义
- `getGiscusTerm()` 函数
- `ensureGiscusHost()` 函数
- `renderOrUpdateGiscus()` 函数
- `doneEach` 中调用 giscus 的两行

**C. 代码块默认语言**

```javascript
// common.js 第 162 行附近
markdown: {
  renderer: {
    code: function (code, lang) {
      // ...
      return this.origin.code(code, fallback ? 'java' : normalized);
      //                                             ^^^^
      //                                   改：你的默认语言
    }
  }
}
```

### 可选调整

| 功能 | 位置 | 调整项 |
|------|------|--------|
| TOC 层级 | `subMaxLevel: 3` | 目录显示到 h3 |
| 搜索缓存 key | `SEARCH_INDEX_KEY` | 索引持久化键名 |
| 代码复制按钮 | `initToolbar()` | 复制反馈文字 "已复制"/"复制失败" |
| 面包屑 | `renderBreadcrumbAndNav()` | "首页" 链接、分隔符 |

---

## 六、tufte.css 调参指南

### 核心颜色变量（在 `:root` 块）

```css
:root {
  --ink: #111;              /* 正文墨色 */
  --ink-soft: #444;         /* 次要文字（引用、边注、元信息） */
  --ink-faint: #888;        /* 三级灰色（面包屑、TOC 非活跃项） */
  --paper: #fffff8;         /* 页面底色 */
  --rule: #ddd8cc;          /* 细线（三线表、代码块顶底线、引用块左线） */
}
```

**换主题色示例**（深色背景）：
```css
:root {
  --ink: #e0e0e0;
  --ink-soft: #aaa;
  --ink-faint: #666;
  --paper: #1a1a1a;
  --rule: #333;
}
```

### 排版变量

```css
  --body-font: etbook, "Noto Serif SC", serif;    /* 正文字体栈 */
  --code-font: "JetBrains Mono", monospace;        /* 代码字体栈 */
  --text-width: 700px;                             /* 正文栏宽度 */
  --page-max: 1400px;                              /* 页面最大宽度 */
  --page-pad: 12.5%;                               /* 页左留白比例 */
```

**纯英文站**：`--body-font: etbook, "Noto Serif", serif;` 并删掉 Google Fonts 的 Noto Serif SC 链接。

### 响应式断点

| 断点 | 行为 |
|------|------|
| ≥1200px | TOC 在右边距、边注浮右 |
| <1200px | TOC 隐藏（左侧浮标可展开遮罩）、边注行内 |
| <760px | 单栏、边注点编号展开、面包屑出"搜索"入口 |

---

## 七、giscus 评论区（可选）

### 获取 giscus 参数

1. 打开 https://giscus.app
2. 填写你的 GitHub 仓库名
3. 选择 Discussion 分类
4. 复制生成的 `data-repo`、`data-repo-id`、`data-category`、`data-category-id`
5. 填入 `common.js` 的 `GISCUS_CFG` 对象

### giscus 自定义主题

`docs/assets/giscus-theme.css` — 自定义了评论区外观，使其融入 Tufte 纸面风格：
- 纸底色、墨色链接、直角边框
- 加载了 Tufte 衬线字体（与站内一致）

主题 CSS 通过 jsdelivr CDN 加载（giscus 不允许加载 localhost 的 CSS）。
公式：`https://cdn.jsdelivr.net/gh/你的用户名/你的仓库@main/docs/assets/giscus-theme.css`

具体 URL 在 `common.js` 的 `GISCUS_THEME` 变量中配置。

---

## 八、新项目适配完整步骤

### 第一步：复制模版文件

```bash
# 在新项目根目录执行
mkdir -p docs/assets/fonts/et-book
cp 源项目/index.html .
cp 源项目/docs/assets/common.js docs/assets/
cp 源项目/docs/assets/tufte.css docs/assets/
cp 源项目/docs/assets/giscus-theme.css docs/assets/   # 不用评论则跳过
cp 源项目/docs/assets/fonts/et-book/*.woff docs/assets/fonts/et-book/
cp 源项目/docs/TEMPLATE-GUIDE.md docs/               # 本文档
```

### 第二步：改 index.html

| 改什么 | 改成什么 |
|--------|----------|
| `<title>` | 你的站点名 |
| `basePath` | 你的内容根目录，如 `docs/` |

### 第三步：改 common.js

| 要不要 giscus | 操作 |
|--------------|------|
| 要 | 修改 `GISCUS_CFG` 对象中的 repo/repoId/category/categoryId |
| 不要 | 删除 giscus 全部相关代码段（见第五节） |

### 第四步：调 tufte.css

- 如果不需要中文字体：删 `"Noto Serif SC"` 并改 `--body-font`
- 如果换配色：改 `--ink` / `--paper` / `--rule`
- 如果正文太窄/太宽：改 `--text-width`

### 第五步：创建首页

新建 `docs/README.md`：

```markdown
# 你的站名

一句话简介。

## 第一章

* [第一篇文章](docs/ch01/01-article)
* [第二篇文章](docs/ch01/02-article)
```

### 第六步：创建文章

在 `docs/` 下按你的结构创建目录和 .md 文件。
所有跨目录引用用 `docs/你的路径/文件` 格式（不加 `#/`，不加 `../`）。

### 第七步：创建 _sidebar.md

```markdown
* [首页](README.md)
* [第一章](docs/ch01/01-article)
  * [1.1 第一篇文章](docs/ch01/01-article)
  * [1.2 第二篇文章](docs/ch01/02-article)
```

这个文件不会被渲染为侧边栏（`loadSidebar: false`），但它会被全文搜索索引爬虫读取。

### 第八步：本地预览

```bash
cd 新项目根目录
python3 -m http.server 8899
# 浏览器打开 http://localhost:8899
```

---

## 九、本地预览与部署

### 本地预览

```bash
python3 -m http.server 8899 --directory . &
open http://localhost:8899
```

- `Ctrl+Shift+R` 强制刷新（防止浏览器缓存旧 CSS/JS）
- 改 `tufte.css` 或 `common.js` 后，记得 +1 版本号：`?v=N+1`

### GitHub Pages 部署

1. Push 到 GitHub 仓库的 `main` 分支
2. Settings → Pages → Source: Deploy from a branch → main → /
3. CNAME 文件（可选）：写入你的自定义域名
4. DNS 添加 CNAME 记录指向 `你的用户名.github.io`

部署后等待几秒即可访问 `https://你的域名`。

---

## 十、已知坑与解决方案

### 1. `**粗体含[方括号]**` → 字面显示 `**`

marked 引擎在粗体中遇到 `[` 会误判为链接起始标记，导致粗体不闭合。

**解决**：写成 `<strong>粗体含[方括号]</strong>`。

### 2. ASCII 画线 ┌┐└┘ 与中文混排不对齐

box-drawing 字符是 1 列宽，中文是 2 列宽，浏览器字体回退不好时会歪。

**解决**：改用纯 ASCII `+-|` 画方框。

### 3. `../` 跨目录链接 404

见第一节。用从内容根出发的绝对路径。

### 4. giscus 主题在 localhost 失效

Chrome 的 Private Network Access 策略禁止 giscus.app 加载 localhost 的 CSS。

**解决**：线上部署后自动生效（giscus 主题走 jsdelivr CDN，是公网 https 地址）。
本地可暂时接受原版 light 主题（功能正常，只是样式不统一）。

### 5. 发布后用户看到的还是旧版

浏览器和 CDN 会缓存静态文件。

**解决**：每次发布改 `index.html` 中的版本号：
```html
<link rel="stylesheet" href="docs/assets/tufte.css?v=2" />
<script src="docs/assets/common.js?v=2"></script>
```

### 6. 代码块中的中文显示为方框 □

某些操作系统缺少等宽中文字体，代码字体（JetBrains Mono）没有中文 glyphs。

**已处理**：`tufte.css` 的 `--code-font` 栈包含了 Noto Serif SC 回退。少数生僻系统可能仍缺字，属于环境问题。

### 7. 注脚定义行仍在正文中显示

检查注脚定义格式：必须是 `[^id]: 内容`（`]:` 后有一个空格）。
如果 `]:` 后没有空格，定义行不会被提取为边注。
