/* ============================================================
   LoveEleve's Tech Blog — 公共脚本 (Common JS)
   
   包含：主题切换 / 极简风格 / docsify 配置 / 插件系统
   
   页面特有功能通过 window.__blogHooks 注册：
   - __blogHooks.pageConfig : 页面专属配置覆盖
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     极简风格：Paper / Mono / Soft（持久化）
     ============================================================ */
  (function () {
    var KEY = 'docsify:min-style';
    var STYLES = ['mono', 'paper', 'soft'];
    var LABELS = { soft: '柔和', mono: '黑白', paper: '纸感' };

    function getStyle() {
      try { return localStorage.getItem(KEY) || 'mono'; }
      catch (e) { return 'mono'; }
    }
    function normalize(style) {
      return STYLES.indexOf(style) >= 0 ? style : 'mono';
    }
    function render(style) {
      var btn = document.getElementById('style-toggle');
      if (!btn) return;
      var text = btn.querySelector('.style-text');
      btn.setAttribute('data-style', style);
      if (text) text.textContent = LABELS[style] || style;
      btn.title = '风格：' + (LABELS[style] || style) + '（点击切换）';
    }
    function apply(style, persist) {
      var s = normalize(style);
      document.documentElement.setAttribute('data-min-style', s);
      if (persist) { try { localStorage.setItem(KEY, s); } catch (e) {} }
      render(s);
    }
    function nextStyle(cur) {
      var idx = STYLES.indexOf(cur);
      return STYLES[(idx + 1 + STYLES.length) % STYLES.length] || 'mono';
    }
    apply(getStyle(), false);
    document.addEventListener('click', function (e) {
      var btn = e && e.target && e.target.closest ? e.target.closest('#style-toggle') : null;
      if (!btn) return;
      e.preventDefault();
      var cur = btn.getAttribute('data-style') || getStyle();
      apply(nextStyle(cur), true);
    }, true);
    window.__docsifyStyle = {
      get: getStyle,
      apply: function (s) { apply(s, true); },
      list: function () { return STYLES.slice(); }
    };
  })();

  /* ============================================================
     主题切换：跟随系统 / 暗色 / 亮色（持久化）
     ============================================================ */
  (function () {
    var KEY = 'docsify:theme-mode';
    var MODES = ['auto', 'dark', 'light'];
    var media = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)'))
      ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function getMode() {
      try { return localStorage.getItem(KEY) || 'auto'; }
      catch (e) { return 'auto'; }
    }
    function resolve(mode) {
      if (mode === 'dark' || mode === 'light') return mode;
      return media && media.matches ? 'dark' : 'light';
    }
    function renderButton(mode, resolved) {
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;
      var icon = btn.querySelector('.theme-icon');
      var text = btn.querySelector('.theme-text');
      btn.setAttribute('data-mode', mode);
      if (mode === 'auto') {
        if (icon) icon.textContent = '⭮';
        if (text) text.textContent = '跟随';
        btn.title = '主题：跟随系统（点击切换）';
        return;
      }
      if (resolved === 'dark') {
        if (icon) icon.textContent = '☾';
        if (text) text.textContent = '暗色';
        btn.title = '主题：暗色（点击切换）';
        return;
      }
      if (icon) icon.textContent = '☀';
      if (text) text.textContent = '亮色';
      btn.title = '主题：亮色（点击切换）';
    }
    function dispatchChange(mode, resolved) {
      try {
        window.dispatchEvent(new CustomEvent('docsify-theme-change', {
          detail: { mode: mode, resolved: resolved }
        }));
      } catch (e) {}
    }
    function apply(mode, persist) {
      var resolved = resolve(mode);
      document.documentElement.setAttribute('data-theme', resolved);
      document.documentElement.setAttribute('data-theme-mode', mode);
      if (persist) { try { localStorage.setItem(KEY, mode); } catch (e) {} }
      renderButton(mode, resolved);
      dispatchChange(mode, resolved);
    }
    function nextMode(cur) {
      var idx = MODES.indexOf(cur);
      return MODES[(idx + 1 + MODES.length) % MODES.length] || 'auto';
    }
    apply(getMode(), false);
    if (media) {
      var handler = function () { if (getMode() === 'auto') apply('auto', false); };
      try { media.addEventListener('change', handler); }
      catch (e) { try { media.addListener(handler); } catch (err) {} }
    }
    document.addEventListener('click', function (e) {
      var btn = e && e.target && e.target.closest ? e.target.closest('#theme-toggle') : null;
      if (!btn) return;
      e.preventDefault();
      apply(nextMode(btn.getAttribute('data-mode') || getMode()), true);
    }, true);
    window.__docsifyTheme = {
      getMode: getMode,
      apply: function (m) { apply(m || 'auto', true); },
      resolve: resolve
    };
  })();

  /* ============================================================
     docsify 核心配置 + 插件
     ============================================================ */
  var hooks = window.__blogHooks || {};
  var pageConfig = hooks.pageConfig || {};

  window.$docsify = Object.assign({
    name: ' ',
    nameLink: '#/',
    repo: 'https://github.com/LoveEleve/LoveEleve.github.io',
    loadSidebar: false,
    subMaxLevel: 3,
    sidebarDisplayLevel: 0,
    executeScript: true,
    requestHeaders: { 'cache-control': 'max-age=0' },
    auto2top: true,

    // 代码块默认语言：无标记/纯文本 → Java
    markdown: {
      renderer: {
        code: function (code, lang) {
          var raw = (lang == null ? '' : String(lang)).trim();
          var first = raw ? raw.split(/\s+/)[0] : '';
          var normalized = (first || '').toLowerCase();

          var fallback = (!normalized || normalized === 'text' || normalized === 'plaintext'
            || normalized === 'plain-text' || normalized.indexOf('plain') === 0);
          return this.origin.code(code, fallback ? 'java' : normalized);
        }
      }
    },

    tabs: { persist: true, sync: true, theme: 'material' },

    'flexible-alerts': {
      style: 'callout',
      note: { label: 'NOTE' },
      tip: { label: 'TIP' },
      warning: { label: 'WARNING' },
      danger: { label: 'DANGER' }
    },

    plugins: [
      /* ============================================================
         主插件函数：代码增强 / 图片缩放 / 画图 / 元信息 / 搜索 / TOC / 阅读 / giscus
         行数：~2026 至 ~4409（逻辑与原始一致）
         ============================================================ */
      function (hook, vm) {

        /* ---------- 工具函数 ---------- */
        function escapeHtml(str) {
          return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function safeHighlight(line, lang) {
          try {
            if (window.Prism && Prism.languages && Prism.languages[lang]) {
              return Prism.highlight(line, Prism.languages[lang], lang);
            }
          } catch (e) {}
          return escapeHtml(line);
        }

        /* ---------- 代码块括号折叠分析 ---------- */
        function buildFoldBlocks(lines) {
          var blocks = [];
          var stack = [];
          var inBlockComment = false;
          var inString = null;
          var escape = false;

          function scanLine(line) {
            var openCount = 0;
            var closeCount = 0;
            for (var i = 0; i < line.length; i++) {
              var ch = line[i];
              var next = i + 1 < line.length ? line[i + 1] : '';
              if (escape) { escape = false; continue; }
              if (inString) {
                if (ch === '\\') { escape = true; continue; }
                if (ch === inString) { inString = null; }
                continue;
              }
              if (inBlockComment) {
                if (ch === '*' && next === '/') { inBlockComment = false; i++; }
                continue;
              }
              if (ch === '/' && next === '/') break;
              if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
              if (ch === '"' || ch === "'") { inString = ch; continue; }
              if (ch === '{') openCount++;
              if (ch === '}') closeCount++;
            }
            return { openCount: openCount, closeCount: closeCount };
          }

          lines.forEach(function (line, idx) {
            var counts = scanLine(line);
            for (var i = 0; i < counts.openCount; i++) stack.push(idx);
            for (var i = 0; i < counts.closeCount; i++) {
              if (!stack.length) continue;
              var start = stack.pop();
              if (idx >= start + 2) blocks.push({ start: start, end: idx, folded: false });
            }
          });
          blocks.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
          return blocks;
        }

        var INLINE_FOLD_MAX_LINES = 360;

        /* ---------- 行级折叠初始化 ---------- */
        function initInlineFolding(pre) {
          var langRaw = (pre.getAttribute('data-lang') || '').toLowerCase();
          var lang = langRaw === 'plain' ? 'markup' : langRaw;
          var codeEl = pre.querySelector('code');
          if (!codeEl) return;
          var raw = (codeEl.textContent || '').replace(/\n$/, '');
          var lines = raw.split('\n');
          if (lines.length > INLINE_FOLD_MAX_LINES) {
            pre.dataset.rawCode = raw;
            pre.dataset.inlineFoldSkipped = '1';
            return;
          }
          var blocks = buildFoldBlocks(lines);
          var blocksByStart = new Map();
          var ellipsisByStart = new Map();

          codeEl.innerHTML = '';
          var wrap = document.createElement('div');
          wrap.className = 'fold-wrap';

          var gutter = document.createElement('div');
          gutter.className = 'fold-gutter';
          var scroll = document.createElement('div');
          scroll.className = 'fold-code-scroll';

          blocks.forEach(function (b) {
            blocksByStart.set(b.start, b);
            b.endIdx = b.end;
          });

          var ellSet = new Set();
          lines.forEach(function (line, idx) {
            var gr = document.createElement('div');
            gr.className = 'fold-gutter-row';
            var block = blocksByStart.get(idx);
            if (block) {
              var tog = document.createElement('span');
              tog.className = 'fold-toggle';
              tog.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5l8 7-8 7z"/></svg>';
              gr.appendChild(tog);
            }
            var lnNum = document.createElement('span');
            lnNum.style.cssText = 'font-size:11px;color:var(--code-muted);min-width:20px;text-align:right;opacity:0.5;';
            lnNum.textContent = idx + 1;
            gr.appendChild(lnNum);
            gutter.appendChild(gr);

            var cr = document.createElement('div');
            cr.className = 'fold-code-row';
            cr.setAttribute('data-line', idx);
            cr.innerHTML = safeHighlight(line, lang);

            var ell;
            blocks.forEach(function (b) {
              if (b.start === idx && b.end !== undefined) {
                ell = document.createElement('span');
                ell.className = 'fold-ellipsis';
                var hiddenCount = b.end - b.start - 2;
                ell.textContent = '... ' + (hiddenCount > 1 ? hiddenCount + ' 行' : '');
                cr.appendChild(ell);
                ellipsisByStart.set(idx, ell);
              }
            });

            scroll.appendChild(cr);
          });

          wrap.appendChild(gutter);
          wrap.appendChild(scroll);
          codeEl.appendChild(wrap);
          pre.dataset.rawCode = raw;

          function recompute() {
            var allEls = scroll.querySelectorAll('.fold-code-row');
            var hidden = new Set();
            blocks.forEach(function (b) {
              if (b.folded) {
                for (var i = b.start + 1; i <= b.end - 1; i++) hidden.add(i);
              }
            });
            allEls.forEach(function (el) {
              var li = parseInt(el.getAttribute('data-line'), 10);
              el.classList.toggle('is-hidden', hidden.has(li));
            });
            blocks.forEach(function (b) {
              var toggleEl = gutter.querySelectorAll('.fold-toggle')[Array.from(blocksByStart.keys()).indexOf(b.start)];
              if (toggleEl) toggleEl.classList.toggle('is-folded', b.folded);
              var startEl = scroll.querySelector('[data-line="' + b.start + '"]');
              if (startEl) startEl.classList.toggle('is-fold-head', b.folded);
            });
          }

          blocks.forEach(function (b) {
            var start = b.start;
            var pick = b;
            var toggles = gutter.querySelectorAll('.fold-toggle');
            var idxInBlocks = Array.from(blocksByStart.keys()).indexOf(start);
            var toggle = toggles[idxInBlocks];
            if (toggle) {
              toggle.onclick = function (e) {
                e.stopPropagation();
                pick.folded = !pick.folded;
                recompute();
              };
            }
            var ell = ellipsisByStart.get(start);
            if (ell) {
              ell.onclick = function (e) {
                e.stopPropagation();
                pick.folded = false;
                recompute();
              };
            }
          });
          recompute();
        }

        /* ---------- 代码块工具栏 ---------- */
        function initToolbar(pre) {
          if (pre.querySelector('.code-tools')) return;
          var lang = (pre.getAttribute('data-lang') || '').toUpperCase();
          var tools = document.createElement('div');
          tools.className = 'code-tools';
          tools.innerHTML =
            '<div class="code-tools-left">' +
              '<span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
              '<span>' + lang + '</span>' +
            '</div>' +
            '<div class="code-tools-right">' +
              '<span class="tool-btn btn-copy">复制</span>' +
              '<span class="tool-btn btn-toggle">收起代码</span>' +
            '</div>';
          pre.insertBefore(tools, pre.firstChild);

          var copyBtn = tools.querySelector('.btn-copy');
          var toggleBtn = tools.querySelector('.btn-toggle');

          copyBtn.onclick = function (e) {
            e.stopPropagation();
            var text = pre.dataset.rawCode || '';
            navigator.clipboard.writeText(text).then(function () {
              copyBtn.textContent = '已复制';
              setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
            });
          };

          var handleToggle = function (e) {
            if (e) e.stopPropagation();
            var isCollapsed = pre.classList.toggle('is-collapsed');
            toggleBtn.textContent = isCollapsed ? '展开代码' : '收起代码';
          };
          toggleBtn.onclick = handleToggle;
          pre.onclick = function () {
            if (pre.classList.contains('is-collapsed')) handleToggle();
          };
        }

        /* ---------- 图片缩放（medium-zoom） ---------- */
        var zoomInstance = null;
        var zoomBindTimer = null;
        var zoomBindTimer2 = null;
        var zoomDelegationInited = false;

        function ensureImageZoomDelegation() {
          if (zoomDelegationInited) return;
          zoomDelegationInited = true;
          document.addEventListener('click', function (e) {
            if (!e || e.defaultPrevented) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            var path = (typeof e.composedPath === 'function') ? e.composedPath() : null;
            var img = null;
            if (path && path.length) {
              for (var i = 0; i < path.length; i++) {
                if (path[i] && path[i].tagName === 'IMG') { img = path[i]; break; }
              }
            }
            if (!img) { var t = e.target; if (t && t.tagName === 'IMG') img = t; }
            if (!img) return;
            var section = img.closest('.markdown-section');
            if (!section) return;
            if (img.closest('#giscus') || img.closest('#page-meta')) return;
            if (img.hasAttribute('data-no-zoom')) return;
            if (!window.mediumZoom) return;
            e.preventDefault(); e.stopPropagation();
            if (!zoomInstance) {
              zoomInstance = window.mediumZoom({ background: 'rgba(0,0,0,0.78)', margin: 40 });
            }
            zoomInstance.open({ target: img });
          }, true);
        }

        function bindZoomToImages() {
          if (!window.mediumZoom) return;
          if (!zoomInstance) {
            zoomInstance = window.mediumZoom({ background: 'rgba(0,0,0,0.78)', margin: 40 });
          }
          var imgs = Array.from(document.querySelectorAll('.markdown-section img'))
            .filter(function (img) {
              return !img.closest('#giscus') && !img.closest('#page-meta') && !img.hasAttribute('data-no-zoom');
            });
          try { zoomInstance.detach(); } catch (e) {}
          if (imgs.length) zoomInstance.attach(imgs);
          ensureImageZoomDelegation();
        }


        /* ---------- 搜索索引系统 ---------- */
        var SEARCH_INDEX_KEY = 'docsify:search-index';
        var SEARCH_INDEX_VERSION = 'v1';
        var searchIndex = null;
        var searchIndexPromises = {};

        function normalizeSlug(path) {
          var p = String(path || '').replace(/#.*$/, '').replace(/\?.*$/, '');
          if (!p || p === '/') return '/README';
          if (p.endsWith('/')) return p + 'README';
          if (p.endsWith('.md')) return p;
          return p + '.md';
        }

        function getIndexKey() { return SEARCH_INDEX_KEY + ':' + SEARCH_INDEX_VERSION; }

        function loadSearchIndex(vm) {
          if (searchIndex) return Promise.resolve(searchIndex);
          try {
            var cached = localStorage.getItem(getIndexKey());
            if (cached) { searchIndex = JSON.parse(cached); return Promise.resolve(searchIndex); }
          } catch (e) {}
          return buildSearchIndex(vm);
        }

        function buildSearchIndex(vm) {
          if (searchIndexPromises._building) return searchIndexPromises._building;
          var seen = {};
          var linkEls = [];

          var contentEl = document.querySelector('.markdown-section');
          if (contentEl) {
            Array.from(contentEl.querySelectorAll('a[href]')).forEach(function (a) {
              var h = a.getAttribute('href') || '';
              if (!h || seen[h]) return;
              seen[h] = true;
              linkEls.push(a);
            });
          }

          var bp = window.$docsify && window.$docsify.basePath;
          var base = (typeof bp === 'string') ? bp : '';

          var sidebarPromise = fetch(base + '_sidebar.md', { headers: { 'cache-control': 'max-age=0' } })
            .then(function (r) { return r.ok ? r.text() : ''; })
            .catch(function () { return ''; })
            .then(function (text) {
              if (!text) return;
              var regex = /\[([^\]]+)\]\(([^)]+)\)/g;
              var m;
              while ((m = regex.exec(text)) !== null) {
                var rawHref = m[2].trim();
                if (!rawHref || rawHref === '#') continue;
                if (/^(https?:)?\/\//.test(rawHref)) continue;
                if (rawHref.indexOf('#') === 0 && rawHref.indexOf('#/') !== 0) continue;
                if (rawHref.indexOf('#/') !== 0) rawHref = '#/' + rawHref;
                if (seen[rawHref]) continue;
                seen[rawHref] = true;
                linkEls.push({ getAttribute: function (attr) { return attr === 'href' ? rawHref : null; } });
              }
            });

          if (!linkEls.length) {
            var emptyP = sidebarPromise.then(function () { return {}; });
            searchIndexPromises._building = emptyP;
            return emptyP;
          }

          var fetches = linkEls.map(function (a) {
            var rawHref = a.getAttribute('href') || '';
            if (!rawHref || rawHref === '#') return null;
            if (rawHref.indexOf('#') === 0 && rawHref.indexOf('#/') !== 0) return null;
            var cleaned = rawHref.replace(/^#\//, '');
            if (!cleaned || /^(https?:)?\/\//.test(cleaned)) return null;
            var path = normalizeSlug(cleaned);
            var url = base + path.replace(/^\//, '');
            return fetch(url, { headers: { 'cache-control': 'max-age=0' } })
              .then(function (r) {
                if (!r.ok) return null;
                return r.text().then(function (text) {
                  var title = '';
                  var m = text.match(/^#\s+(.+)$/m);
                  if (m) title = m[1].trim();
                  var cleanedText = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*[\]()>`\-|~]/g, ' ');
                  return { url: rawHref, title: title, text: cleanedText.toLowerCase(), rawLen: cleanedText.length };
                });
              })
              .catch(function () { return null; });
          });

          var p = sidebarPromise.then(function () {
            return Promise.all(fetches);
          }).then(function (results) {
            var idx = {};
            results.forEach(function (doc) {
              if (!doc) return;
              idx[doc.url] = doc;
            });
            searchIndex = idx;
            try { localStorage.setItem(getIndexKey(), JSON.stringify(idx)); } catch (e) {}
            delete searchIndexPromises._building;
            return idx;
          });
          searchIndexPromises._building = p;
          return p;
        }

        function invalidateSearchIndex() {
          searchIndex = null;
          try { localStorage.removeItem(getIndexKey()); } catch (e) {}
        }

        /* ---------- TOC 系统 ---------- */
        var tocLastRoutePath = '';
        var tocJumpStack = [];
        var tocRenderTimer = null;
        var tocObs = null;
        var scrollTimer = null;
        var tocMobileBound = false;
        var tocLinkClickHandler = null;
        var TOC_BODY_CLASS = 'has-toc-aside';

        function buildTocItems(section) {
          var items = [];
          if (!section) return items;
          var stack = [];
          section.querySelectorAll('h1,h2,h3,h4').forEach(function (h) {
            if (h.closest('#page-meta') || h.closest('#toc-aside') || h.closest('#giscus')) return;
            var text = (h.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text) return;
            var id = h.id || '';
            if (!id) { id = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, ''); h.id = id; }
            var level = parseInt(h.tagName.charAt(1), 10);
            var item = { id: id, text: text, level: level, children: [] };
            while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
            if (stack.length) { stack[stack.length - 1].children.push(item); }
            else { items.push(item); }
            stack.push(item);
          });
          return items;
        }

        function ensureTocDom() {
          var toc = document.querySelector('#toc-aside');
          if (!toc) {
            toc = document.createElement('div');
            toc.id = 'toc-aside';
            toc.className = 'toc-aside';
            toc.setAttribute('data-has-items', '0');
            toc.innerHTML =
              '<div class="toc-head">' +
                '<div class="toc-title">目录</div>' +
                '<div class="toc-actions">' +
                  '<button type="button" class="toc-action toc-back" aria-label="返回" title="返回">' +
                    '<svg class="toc-icon" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M19 12H5m7-7l-7 7 7 7"/></svg>' +
                  '</button>' +
                  '<button type="button" class="toc-action toc-top" aria-label="回到顶部" title="回到顶部">' +
                    '<svg class="toc-icon" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M18 15l-6-6-6 6"/></svg>' +
                  '</button>' +
                '</div>' +
                '<button type="button" class="toc-close" aria-label="关闭目录" title="关闭">×</button>' +
              '</div>' +
              '<div class="toc-body"></div>';
            document.body.appendChild(toc);
          }
          return toc;
        }

        function setTocFabState(hasItems) {
          document.body.classList.toggle(TOC_BODY_CLASS, !!hasItems);
          var fab = document.querySelector('#toc-fab');
          if (!fab) return;
          fab.style.display = hasItems ? '' : 'none';
        }

        function setTocBackState() {
          var btn = document.querySelector('#toc-aside .toc-back');
          if (!btn) return;
          btn.classList.toggle('is-disabled', tocJumpStack.length === 0);
        }

        function renderToc(vm) {
          var section = document.querySelector('.markdown-section');
          if (!section) return false;
          var items = buildTocItems(section);
          var toc = ensureTocDom();
          var body = toc.querySelector('.toc-body');
          if (!body) return false;

          toc.setAttribute('data-has-items', items.length ? '1' : '0');
          setTocFabState(items.length > 0);

          if (!items.length) { body.innerHTML = ''; return true; }

          var flatList = [];
          function walk(list, depth) {
            list.forEach(function (item) {
              flatList.push({ id: item.id, text: item.text, level: item.level, hasChildren: item.children.length > 0 });
              if (item.children.length) walk(item.children, depth + 1);
            });
          }
          walk(items, 0);

          // 构建 h2 分组
          var html = '';
          var currentGroup = null;
          flatList.forEach(function (item) {
            if (item.level === 2) {
              if (currentGroup) html += '</div></div>';
              currentGroup = { items: [], hasChildren: item.hasChildren };
              html += '<div class="toc-group">' +
                '<div class="toc-group-head">' +
                  '<button class="toc-group-toggle' + (item.hasChildren ? '' : ' is-hidden') + '" type="button">' +
                    '<svg class="toc-caret" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5l8 7-8 7z"/></svg>' +
                  '</button>' +
                  '<a class="toc-body-a toc-group-link toc-l' + item.level + '" href="#' + item.id + '">' + item.text + '</a>' +
                '</div>' +
                '<div class="toc-children">';
            } else if (currentGroup) {
              html += '<a class="toc-body-a toc-l' + item.level + '" href="#' + item.id + '">' + item.text + '</a>';
            } else {
              html += '<a class="toc-body-a toc-l' + item.level + '" href="#' + item.id + '">' + item.text + '</a>';
            }
          });
          if (currentGroup) html += '</div></div>';

          // 没有 h2 的情况下平铺
          if (!html) {
            html = flatList.map(function (item) {
              return '<a class="toc-body-a toc-l' + item.level + '" href="#' + item.id + '">' + item.text + '</a>';
            }).join('');
          }

          body.innerHTML = html;

          // 绑定折叠
          body.querySelectorAll('.toc-group-toggle').forEach(function (btn) {
            btn.onclick = function () {
              var group = btn.closest('.toc-group');
              if (group) group.classList.toggle('is-collapsed');
            };
          });

          // 绑定 TOC 链接点击 —— 阻止 hash 路由导航，改用 scrollIntoView 平滑滚动
          if (tocLinkClickHandler) body.removeEventListener('click', tocLinkClickHandler);
          tocLinkClickHandler = function (e) {
            var a = e.target.closest ? e.target.closest('.toc-body-a') : null;
            if (!a || !body.contains(a)) return;
            var href = a.getAttribute('href');
            if (!href || href.charAt(0) !== '#') return;
            e.preventDefault();
            var id = href.slice(1);
            var el = document.getElementById(id);
            if (el) {
              var prevId = null;
              var prevTop = Infinity;
              links.forEach(function (lk) {
                var lid = lk.getAttribute('href').slice(1);
                var lel = document.getElementById(lid);
                if (!lel) return;
                var rect = lel.getBoundingClientRect();
                if (rect.top >= 0 && rect.top < prevTop) { prevId = lid; prevTop = rect.top; }
              });
              if (prevId && prevId !== id) {
                tocJumpStack.push(prevId);
                setTocBackState();
              }
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          };
          body.addEventListener('click', tocLinkClickHandler);

          // 滚动高亮（节流）
          var activeLink = null;
          var links = body.querySelectorAll('a[href^="#"]');
          var tocScrollUpdate = function () {
            var best = null;
            var bestTop = Infinity;
            links.forEach(function (a) {
              var id = a.getAttribute('href').slice(1);
              var el = document.getElementById(id);
              if (!el) return;
              var rect = el.getBoundingClientRect();
              if (rect.top >= 0 && rect.top < bestTop) { best = a; bestTop = rect.top; }
            });
            if (best && best !== activeLink) {
              if (activeLink) activeLink.classList.remove('is-active');
              best.classList.add('is-active');
              activeLink = best;
              // 滚动 TOC 让当前项可见
              if (best.offsetTop) {
                var tocBody = best.closest('.toc-body');
                if (tocBody) tocBody.scrollTop = best.offsetTop - tocBody.clientHeight / 3;
              }
            }
          };
          var throttledScroll = function () {
            if (scrollTimer) return;
            scrollTimer = setTimeout(function () { scrollTimer = null; tocScrollUpdate(); }, 100);
          };
          window.removeEventListener('scroll', throttledScroll);
          window.addEventListener('scroll', throttledScroll, { passive: true });
          setTimeout(tocScrollUpdate, 200);

          // TOC 按钮交互
          var topBtn = document.querySelector('#toc-aside .toc-top');
          if (topBtn) topBtn.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }); };
          var backBtn = document.querySelector('#toc-aside .toc-back');
          if (backBtn) backBtn.onclick = function () {
            if (tocJumpStack.length) {
              var id = tocJumpStack.pop();
              setTocBackState();
              var el = document.getElementById(id);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          };

          return true;
        }

        function ensureTocMobileDelegation() {
          if (tocMobileBound) return;
          tocMobileBound = true;

          // Fab 按钮（小屏目录入口）
          document.addEventListener('click', function (e) {
            var fab = e && e.target && e.target.closest ? e.target.closest('#toc-fab') : null;
            var toc = document.querySelector('#toc-aside');
            if (fab) { e.preventDefault(); if (toc) toc.classList.toggle('is-open'); return; }
            var closeBtn = e && e.target && e.target.closest ? e.target.closest('#toc-aside .toc-close') : null;
            if (closeBtn) { e.preventDefault(); if (toc) toc.classList.remove('is-open'); return; }
            // 点击 TOC 浮层外部关闭
            if (toc && toc.classList.contains('is-open')) {
              var inside = e && e.target && e.target.closest
                ? (e.target.closest('#toc-aside') || e.target.closest('#toc-fab')) : null;
              if (!inside) toc.classList.remove('is-open');
            }
          }, true);

          // MutationObserver 自愈
          if (window.MutationObserver) {
            tocObs = new MutationObserver(function () {
              try { scheduleTocRender(); } catch (e) {}
            });
            var section = document.querySelector('.markdown-section');
            if (section) tocObs.observe(section, { childList: true, subtree: true });
          }
        }

        function scheduleTocRender(vm) {
          var path = (vm && vm.route && vm.route.path) ? vm.route.path : ((location.hash || '#/').split('?')[0] || '#/');
          if (path === '#/' || path === '#/README') {
            var toc = document.querySelector('#toc-aside');
            if (toc) {
              toc.setAttribute('data-has-items', '0');
              var body = toc.querySelector('.toc-body');
              if (body) body.innerHTML = '';
            }
            setTocFabState(false);
            return;
          }
          if (tocRenderTimer) clearTimeout(tocRenderTimer);
          tocRenderTimer = setTimeout(function () {
            tocRenderTimer = null;
            var ok = renderToc(vm);
            if (!ok) scheduleTocRender(vm);
            setTocBackState();
          }, 350);
        }

        /* ---------- 进度条 / 面包屑 / 上一篇下一篇 ---------- */
        function ensureProgressBar() {
          if (document.getElementById('read-progress')) return;
          var bar = document.createElement('div');
          bar.id = 'read-progress';
          document.body.appendChild(bar);
          var ticking = false;
          window.addEventListener('scroll', function () {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(function () {
              ticking = false;
              var scrollTop = window.scrollY || document.documentElement.scrollTop;
              var docHeight = document.documentElement.scrollHeight - window.innerHeight;
              var pct = docHeight > 0 ? Math.min(100, (scrollTop / docHeight) * 100) : 0;
              var barEl = document.getElementById('read-progress');
              if (barEl) barEl.style.width = pct + '%';
            });
          }, { passive: true });
        }

        function ensureBreadcrumb(section) {
          var bc = section.querySelector('#page-breadcrumb');
          if (!bc) {
            bc = document.createElement('div');
            bc.id = 'page-breadcrumb';
            bc.className = 'page-breadcrumb';
            var h1 = section.querySelector('h1');
            if (h1 && h1.parentNode) { h1.parentNode.insertBefore(bc, h1); }
            else { section.insertBefore(bc, section.firstChild); }
          }
          return bc;
        }

        function renderBreadcrumbAndNav(vm) {
          try {
            var section = document.querySelector('.markdown-section');
            if (!section) return;
            var currentPath = (vm && vm.route && vm.route.path) ? vm.route.path : (location.hash || '#/');
            currentPath = (currentPath || '').split('?')[0];
            var isHome = currentPath === '#/' || currentPath === '#/README';
            if (isHome) return;

            // 面包屑
            var bc = ensureBreadcrumb(section);
            var h1 = section.querySelector('h1');
            var title = h1 ? (h1.textContent || '').replace(/\s+/g, ' ').trim() : '文章';
            bc.innerHTML = '<a href="#/">首页</a>' +
              '<span class="crumb-sep"> / </span>' +
              '<span>' + title + '</span>';

            // 上一篇 / 下一篇 — 从 markdown-section 链接获取
            var nav = section.querySelector('#page-nav');
            if (!nav) {
              nav = document.createElement('div');
              nav.id = 'page-nav';
              nav.className = 'page-nav';
              var g = section.querySelector('#giscus');
              if (g && g.parentNode === section) { section.insertBefore(nav, g); }
              else { section.appendChild(nav); }
            }

            var allLinks = Array.from(document.querySelectorAll('.markdown-section a[href^="#/"]'))
              .map(function (a) { return { href: a.getAttribute('href') || '', text: (a.textContent || '').trim() }; })
              .filter(function (l) { return l.href && l.href.indexOf('#') === 0 && l.href.indexOf('#/') === 0; });

            if (!allLinks.length) { nav.innerHTML = ''; return; }

            var currentIdx = -1;
            var normPath = currentPath.replace(/^#/, '');
            [].concat(allLinks).forEach(function (link, i) {
              var ln = (link.href || '').split('#')[0].split('?')[0];
              if (ln === normPath || ln === normPath.replace(/^\/docs/, '')) currentIdx = i;
            });

            var prev = currentIdx > 0 ? allLinks[currentIdx - 1] : null;
            var next = currentIdx < allLinks.length - 1 ? allLinks[currentIdx + 1] : null;

            nav.innerHTML =
              '<a class="' + (prev ? '' : 'is-disabled') + '" href="' + (prev ? prev.href : '#') + '">' +
                '<div class="nav-kicker">← 上一篇</div>' +
                '<div class="nav-title">' + (prev ? prev.text : '没有了') + '</div>' +
              '</a>' +
              '<a class="' + (next ? '' : 'is-disabled') + '" href="' + (next ? next.href : '#') + '">' +
                '<div class="nav-kicker">下一篇 →</div>' +
                '<div class="nav-title">' + (next ? next.text : '没有了') + '</div>' +
              '</a>';
          } catch (e) {}
        }

        /* ---------- 标题复制链接 ---------- */
        function renderHeadingLinks(vm) {
          try {
            var section = document.querySelector('.markdown-section');
            if (!section) return;
            section.querySelectorAll('h1,h2,h3,h4').forEach(function (h) {
              if (h.querySelector('.heading-link-btn')) return;
              if (!h.id) { h.id = (h.textContent || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, ''); }
              var btn = document.createElement('span');
              btn.className = 'heading-link-btn';
              btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>';
              btn.title = '复制链接';
              btn.setAttribute('tabindex', '0');
              btn.setAttribute('role', 'button');
              btn.onclick = function (e) {
                e.preventDefault(); e.stopPropagation();
                var url = location.origin + location.pathname + '#' + h.id;
                navigator.clipboard.writeText(url).then(function () {
                  btn.classList.add('is-copied');
                  setTimeout(function () { btn.classList.remove('is-copied'); }, 1500);
                });
              };
              h.appendChild(btn);
            });
          } catch (e) {}
        }

        /* ---------- 全文搜索（Ctrl/⌘+K） ---------- */
        var ftsBound = false;
        var ftsModal = null;
        var ftsVisible = false;
        var ftsPendingHighlight = null;

        function ensureFtsModal() {
          if (ftsModal) return ftsModal;
          ftsModal = document.createElement('div');
          ftsModal.id = 'fts-modal';
          ftsModal.setAttribute('aria-label', '全文搜索');
          ftsModal.innerHTML =
            '<div class="fts-backdrop"></div>' +
            '<div class="fts-panel">' +
              '<div class="fts-head">' +
                '<input class="fts-input" id="fts-input" type="search" placeholder="全文搜索…" autocomplete="off" spellcheck="false" />' +
                '<button id="fts-close" class="fts-close" aria-label="关闭">×</button>' +
              '</div>' +
              '<div class="fts-meta"><span id="fts-count"></span><div class="fts-meta-right"><span class="fts-link" id="fts-rebuild">重新索引</span></div></div>' +
              '<div class="fts-results" id="fts-results"></div>' +
            '</div>';
          document.body.appendChild(ftsModal);
          return ftsModal;
        }

        function openFts() {
          var modal = ensureFtsModal();
          modal.classList.add('is-open');
          ftsVisible = true;
          var input = document.getElementById('fts-input');
          if (input) { setTimeout(function () { input.focus(); input.select(); }, 50); }
        }

        function closeFts() {
          var modal = document.getElementById('fts-modal');
          if (modal) modal.classList.remove('is-open');
          ftsVisible = false;
        }

        function performSearch(query) {
          if (!searchIndex) { document.getElementById('fts-count').textContent = '索引加载中…'; return; }
          var q = query.toLowerCase().trim();
          if (!q) { document.getElementById('fts-count').textContent = ''; document.getElementById('fts-results').innerHTML = ''; return; }

          var results = [];
          Object.keys(searchIndex).forEach(function (key) {
            var doc = searchIndex[key];
            if (!doc || !doc.text) return;
            var idx = doc.text.indexOf(q);
            if (idx === -1 && doc.title.toLowerCase().indexOf(q) === -1) return;
            var score = 0;
            if (doc.title.toLowerCase().indexOf(q) >= 0) score += 100;
            var pos = -1;
            while ((pos = doc.text.indexOf(q, pos + 1)) >= 0) score += 1;
            var snippet = '';
            if (idx >= 0) {
              var start = Math.max(0, idx - 40);
              var end = Math.min(doc.text.length, idx + q.length + 60);
              snippet = doc.text.substring(start, end).replace(q, '<mark>' + q + '</mark>');
            }
            results.push({ url: doc.url, title: doc.title, score: score, snippet: snippet });
          });

          results.sort(function (a, b) { return b.score - a.score; });

          document.getElementById('fts-count').textContent = results.length + ' 条结果';
          var html = results.slice(0, 30).map(function (r) {
            return '<a class="fts-item" href="' + r.url + '" data-fts-result="1">' +
              '<div class="fts-title">' + r.title + '</div>' +
              (r.snippet ? '<div class="fts-snippet">' + r.snippet + '</div>' : '') +
              '</a>';
          }).join('');
          document.getElementById('fts-results').innerHTML = html || '<div style="padding:12px;color:#57606a;">无匹配结果</div>';

          document.querySelectorAll('#fts-results .fts-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
              e.preventDefault();
              var href = item.getAttribute('href');
              closeFts();
              if (href) {
                var term = (document.getElementById('fts-input') || {}).value || '';
                ftsPendingHighlight = term;
                location.hash = href;
              }
            });
          });
        }

        function highlightInPage(term) {
          if (!term) return;
          clearPageHighlight();
          var section = document.querySelector('.markdown-section');
          if (!section) return;
          var walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
              if (node.parentElement && node.parentElement.closest('pre, code, #toc-aside, #page-meta, #giscus'))
                return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          });
          var nodes = [];
          var n;
          while ((n = walker.nextNode())) nodes.push(n);
          var regex = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
          nodes.forEach(function (node) {
            if (regex.test(node.textContent)) {
              regex.lastIndex = 0;
              var frag = document.createDocumentFragment();
              var txt = node.textContent;
              var m;
              var last = 0;
              while ((m = regex.exec(txt)) !== null) {
                if (m.index > last) frag.appendChild(document.createTextNode(txt.substring(last, m.index)));
                var mark = document.createElement('mark');
                mark.className = 'fts-mark';
                mark.textContent = m[1];
                frag.appendChild(mark);
                last = m.index + m[1].length;
              }
              if (last < txt.length) frag.appendChild(document.createTextNode(txt.substring(last)));
              node.parentNode.replaceChild(frag, node);
            }
          });
        }

        function clearPageHighlight() {
          document.querySelectorAll('.fts-mark').forEach(function (mark) {
            var parent = mark.parentNode;
            if (parent) { parent.replaceChild(document.createTextNode(mark.textContent), mark); parent.normalize(); }
          });
        }

        function maybeApplyPendingHighlight(vm) {
          if (!ftsPendingHighlight) return;
          var term = ftsPendingHighlight;
          ftsPendingHighlight = null;
          setTimeout(function () { highlightInPage(term); }, 600);
        }

        function ensureFullTextSearch(vm) {
          if (ftsBound) return;
          ftsBound = true;
          ensureFtsModal();

          var searchBtn = document.getElementById('search-toggle');
          if (searchBtn) searchBtn.addEventListener('click', function (e) {
            e.preventDefault();
            ftsVisible ? closeFts() : (openFts(), loadSearchIndex(vm));
          });

          var input = document.getElementById('fts-input');
          if (input) input.addEventListener('input', function () { performSearch(input.value); });
          document.getElementById('fts-close').addEventListener('click', closeFts);
          document.querySelector('#fts-modal .fts-backdrop').addEventListener('click', closeFts);

          document.getElementById('fts-rebuild').addEventListener('click', function () {
            invalidateSearchIndex();
            document.getElementById('fts-count').textContent = '重新索引中…';
            searchIndexPromises._building = null;
            buildSearchIndex(vm).then(function () {
              var inp = document.getElementById('fts-input');
              if (inp) performSearch(inp.value);
            });
          });

          document.addEventListener('keydown', function (e) {
            if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              ftsVisible ? closeFts() : (openFts(), loadSearchIndex(vm));
            }
            if (e.key === 'Escape' && ftsVisible) { closeFts(); }
          });
        }

        /* ---------- giscus 评论区 ---------- */
        var GISCUS_CFG = {
          src: 'https://giscus.app/client.js',
          repo: 'LoveEleve/LoveEleve.github.io',
          repoId: 'R_kgDOMpC7XQ',
          category: 'Announcements',
          categoryId: 'DIC_kwDOMpC7Xc4CiVfG',
          mapping: 'specific',
          strict: '0',
          reactionsEnabled: '1',
          emitMetadata: '0',
          inputPosition: 'top',
          theme: 'light',
          lang: 'zh-CN'
        };

        function getGiscusTerm(vm) {
          var path = (vm && vm.route && vm.route.path) ? vm.route.path : (location.hash || '#/');
          path = (path || '').split('?')[0];
          if (!path || path === '/') path = '/README';
          var file = path.replace(/^#/, '').replace(/^\//, '');
          if (!file) return 'README.md';
          if (file.endsWith('/')) file += 'README';
          if (!file.endsWith('.md')) file += '.md';
          return file;
        }

        function ensureGiscusHost() {
          var section = document.querySelector('.markdown-section');
          if (!section) return null;
          var host = section.querySelector('#giscus');
          if (!host) {
            host = document.createElement('div');
            host.id = 'giscus';
            host.innerHTML =
              '<div class="giscus-card">' +
                '<div class="giscus-head">' +
                  '<div class="giscus-head-left">' +
                    '<div class="giscus-title">评论</div>' +
                    '<div class="giscus-meta">GitHub Discussions</div>' +
                  '</div>' +
                  '<a class="giscus-badge" href="https://github.com/LoveEleve/LoveEleve.github.io/discussions" target="_blank" rel="noopener noreferrer">打开讨论区</a>' +
                '</div>' +
                '<div class="giscus-body"></div>' +
              '</div>';
            section.appendChild(host);
          }
          return host;
        }

        function renderOrUpdateGiscus(term) {
          var host = ensureGiscusHost();
          if (!host) return;
          var mount = host.querySelector('.giscus-body') || host;
          var iframe = mount.querySelector('iframe.giscus-frame');
          if (iframe) {
            iframe.contentWindow && iframe.contentWindow.postMessage({
              giscus: { setConfig: { term: term } }
            }, 'https://giscus.app');
            return;
          }
          mount.innerHTML = '';
          var s = document.createElement('script');
          s.src = GISCUS_CFG.src;
          s.async = true;
          s.crossOrigin = 'anonymous';
          s.setAttribute('data-repo', GISCUS_CFG.repo);
          s.setAttribute('data-repo-id', GISCUS_CFG.repoId);
          s.setAttribute('data-category', GISCUS_CFG.category);
          s.setAttribute('data-category-id', GISCUS_CFG.categoryId);
          s.setAttribute('data-mapping', GISCUS_CFG.mapping);
          s.setAttribute('data-term', term);
          s.setAttribute('data-strict', GISCUS_CFG.strict);
          s.setAttribute('data-reactions-enabled', GISCUS_CFG.reactionsEnabled);
          s.setAttribute('data-emit-metadata', GISCUS_CFG.emitMetadata);
          s.setAttribute('data-input-position', GISCUS_CFG.inputPosition);
          s.setAttribute('data-theme', GISCUS_CFG.theme);
          s.setAttribute('data-lang', GISCUS_CFG.lang);
          host.appendChild(s);
        }

        var giscusThemeBound = false;
        function rerenderGiscus(term) {
          var host = ensureGiscusHost();
          if (!host) return;
          var mount = host.querySelector('.giscus-body') || host;
          try {
            host.querySelectorAll('iframe.giscus-frame').forEach(function (el) { el.remove(); });
            host.querySelectorAll('script[src*="giscus.app/client.js"]').forEach(function (el) { el.remove(); });
          } catch (e) {}
          mount.innerHTML = '';
          renderOrUpdateGiscus(term);
        }

        function bindThemeChangeForGiscus() {
          if (giscusThemeBound) return;
          giscusThemeBound = true;
          window.addEventListener('docsify-theme-change', function (ev) {
            var resolved = (ev && ev.detail && ev.detail.resolved)
              ? ev.detail.resolved
              : (document.documentElement.getAttribute('data-theme') || 'light');
            var want = resolved === 'dark' ? 'dark' : 'light';
            if (GISCUS_CFG.theme === want) return;
            GISCUS_CFG.theme = want;
            rerenderGiscus(getGiscusTerm(vm));
          });
        }

        bindThemeChangeForGiscus();

        /* ============================================================
           doneEach 钩子（核心渲染入口）
           ============================================================ */
        hook.doneEach(function () {
          document.querySelectorAll('pre[data-lang]').forEach(function (pre) {
            if (pre.dataset.inlineFoldInited === '1') return;
            pre.dataset.inlineFoldInited = '1';
            initInlineFolding(pre);
            initToolbar(pre);
          });

          renderHeadingLinks(vm);

          try { ensureTocMobileDelegation(); } catch (e) {}
          try { setTocFabState(false); } catch (e) {}

          try {
            var p = (vm && vm.route && vm.route.path) ? vm.route.path : ((location.hash || '#/').split('?')[0] || '#/');
            if (!tocLastRoutePath || p !== tocLastRoutePath) {
              tocJumpStack = [];
              tocLastRoutePath = p;
            }
          } catch (e) {}
          try { setTocBackState(); } catch (e) {}

          scheduleTocRender(vm);
          ensureProgressBar();
          renderBreadcrumbAndNav(vm);
          ensureFullTextSearch(vm);
          maybeApplyPendingHighlight(vm);

          // 评论：首页不加载
          var cPath = (vm && vm.route && vm.route.path) ? vm.route.path : '#/';
          if (cPath === '#/' || cPath === '#/README') {
            loadSearchIndex(vm);
          } else {
            renderOrUpdateGiscus(getGiscusTerm(vm));
          }

          // 图片缩放：延迟重绑（某些插件在 doneEach 后改 DOM）
          if (zoomBindTimer) clearTimeout(zoomBindTimer);
          zoomBindTimer = setTimeout(function () { bindZoomToImages(); }, 200);
          if (zoomBindTimer2) clearTimeout(zoomBindTimer2);
          zoomBindTimer2 = setTimeout(function () { bindZoomToImages(); }, 800);
        });
      }
    ]
  }, pageConfig);

})();
