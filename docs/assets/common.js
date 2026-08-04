/* ============================================================
   LoveEleve's Tech Blog — 公共脚本 (Common JS) · Tufte 重构版

   保留：docsify 配置 / 边注语法 / 代码复制 / 图片缩放 /
         全文搜索(⌘K) / TOC / 面包屑 / 上下篇 / 标题锚点 / giscus
   删除：主题切换 / 极简风格切换 / 代码行折叠 / 阅读进度条
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     docsify 核心配置 + 插件
     ============================================================ */
  var hooks = window.__blogHooks || {};
  var pageConfig = hooks.pageConfig || {};

  window.$docsify = Object.assign({
    name: ' ',
    nameLink: '#/',
    loadSidebar: false,
    subMaxLevel: 3,
    sidebarDisplayLevel: 0,
    executeScript: true,
    requestHeaders: { 'cache-control': 'max-age=0' },
    auto2top: true,

    alias: {
      '/openjdk/vol-01/ch01': '/openjdk/vol-01/ch01/README',
      '/openjdk/vol-01/ch03/background/handles-all': '/openjdk/vol-01/ch03/background/handles-all',
      '/openjdk/vol-01/ch03/background/smr': '/openjdk/vol-01/ch03/background/smr',
    },

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

    plugins: [
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

        // docsify route.path 不带 '#'，首页是 '/'（手动改 hash 时可能是 '#/...'）
        function isHomePath(p) {
          p = (p || '').split('?')[0];
          return p === '/' || p === '' || p === '/README'
            || p === '#/' || p === '#' || p === '#/README';
        }

        /* ============================================================
           边注语法：^[内容] → Tufte sidenote
           在 fenced code block 之外做替换；`code` 反引号保留渲染
           ============================================================ */
        var snIdSeq = 0;

        function transformSidenoteSegment(seg) {
          return seg.replace(/\^\[([^\]]+)\]/g, function (_, note) {
            snIdSeq++;
            var inner = escapeHtml(note).replace(/`([^`]+)`/g, '<code>$1</code>');
            return '<label for="sn-' + snIdSeq + '" class="margin-toggle sidenote-number"></label>' +
              '<input type="checkbox" id="sn-' + snIdSeq + '" class="margin-toggle"/>' +
              '<span class="sidenote">' + inner + '</span>';
          });
        }

        hook.beforeEach(function (content) {
          if (content.indexOf('^[') === -1) return content;
          // 按 ``` 围栏切分，仅处理代码块之外的片段
          var parts = content.split(/(```[\s\S]*?(?:```|$))/g);
          for (var i = 0; i < parts.length; i += 2) {
            parts[i] = transformSidenoteSegment(parts[i]);
          }
          return parts.join('');
        });

        /* ---------- 代码块工具栏：仅复制 ---------- */
        function initToolbar(pre) {
          if (pre.querySelector('.code-tools')) return;
          var tools = document.createElement('div');
          tools.className = 'code-tools';
          tools.innerHTML = '<span class="tool-btn btn-copy">复制</span>';
          pre.insertBefore(tools, pre.firstChild);

          var copyBtn = tools.querySelector('.btn-copy');
          copyBtn.onclick = function (e) {
            e.stopPropagation();
            var text = pre.dataset.rawCode || '';
            if (!text) return;
            navigator.clipboard.writeText(text).then(function () {
              copyBtn.textContent = '已复制';
              setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
            });
          };
        }

        /* ---------- 图片缩放（medium-zoom） ---------- */
        var zoomInstance = null;
        var zoomBindTimer = null;
        var zoomBindTimer2 = null;
        var zoomDelegationInited = false;
        var ZOOM_BG = 'rgba(255, 255, 248, 0.96)';

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
            if (img.closest('#giscus') || img.closest('#page-meta') || img.closest('.sidenote')) return;
            if (img.hasAttribute('data-no-zoom')) return;
            if (!window.mediumZoom) return;
            e.preventDefault(); e.stopPropagation();
            if (!zoomInstance) {
              zoomInstance = window.mediumZoom({ background: ZOOM_BG, margin: 40 });
            }
            zoomInstance.open({ target: img });
          }, true);
        }

        function bindZoomToImages() {
          if (!window.mediumZoom) return;
          if (!zoomInstance) {
            zoomInstance = window.mediumZoom({ background: ZOOM_BG, margin: 40 });
          }
          var imgs = Array.from(document.querySelectorAll('.markdown-section img'))
            .filter(function (img) {
              return !img.closest('#giscus') && !img.closest('#page-meta') && !img.closest('.sidenote') && !img.hasAttribute('data-no-zoom');
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
        var tocLinkClickHandler = null;

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
                '<button type="button" class="toc-back" aria-label="返回" title="返回">← 返回</button>' +
                '<button type="button" class="toc-top" aria-label="回到顶部" title="回到顶部">↑ 顶部</button>' +
                '<button type="button" class="toc-collapse" aria-label="收起目录" title="收起目录">收起 →</button>' +
              '</div>' +
              '<div class="toc-body"></div>';
            document.body.appendChild(toc);

            var openBtn = document.createElement('button');
            openBtn.id = 'toc-open-btn';
            openBtn.type = 'button';
            openBtn.textContent = '目录';
            openBtn.title = '展开目录';
            document.body.appendChild(openBtn);

            toc.querySelector('.toc-collapse').onclick = function () { setTocCollapsed(true); };
            openBtn.onclick = function () { setTocCollapsed(false); };
          }
          return toc;
        }

        function setTocCollapsed(collapsed) {
          var toc = ensureTocDom();
          toc.classList.toggle('is-collapsed', collapsed);
          var hasItems = toc.getAttribute('data-has-items') === '1';
          document.body.classList.toggle('toc-collapsed', collapsed && hasItems);
          try { localStorage.setItem('docsify:toc-collapsed', collapsed ? '1' : '0'); } catch (e) {}
        }

        function isTocCollapsed() {
          try { return localStorage.getItem('docsify:toc-collapsed') === '1'; } catch (e) { return false; }
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

          // 同步收起状态（跨页面持久）
          var collapsed = isTocCollapsed() && items.length > 0;
          toc.classList.toggle('is-collapsed', collapsed);
          document.body.classList.toggle('toc-collapsed', collapsed);

          if (!items.length) { body.innerHTML = ''; return true; }

          var flatList = [];
          function walk(list) {
            list.forEach(function (item) {
              flatList.push({ id: item.id, text: item.text, level: item.level });
              if (item.children.length) walk(item.children);
            });
          }
          walk(items);

          var html = flatList.map(function (item) {
            return '<a class="toc-body-a toc-l' + item.level + '" href="#' + item.id + '">' + item.text + '</a>';
          }).join('');
          body.innerHTML = html;

          // TOC 链接点击 —— 阻止 hash 路由，平滑滚动 + 记录跳转栈
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

        // MutationObserver 自愈
        var tocObserverBound = false;
        function ensureTocObserver() {
          if (tocObserverBound) return;
          tocObserverBound = true;
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
          if (isHomePath(path)) {
            var toc = document.querySelector('#toc-aside');
            if (toc) {
              toc.setAttribute('data-has-items', '0');
              var body = toc.querySelector('.toc-body');
              if (body) body.innerHTML = '';
            }
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

        /* ---------- 面包屑 / 上一篇下一篇 ---------- */
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
            if (isHomePath(currentPath)) return;

            // 面包屑：一行小字 + ⌘K 提示
            var bc = ensureBreadcrumb(section);
            var h1 = section.querySelector('h1');
            var title = h1 ? (h1.textContent || '').replace(/\s+/g, ' ').trim() : '文章';
            bc.innerHTML = '<a href="#/">首页</a>' +
              '<span class="sep"> / </span>' +
              '<span>' + title + '</span>' +
              '<span class="kbd-hint">⌘K 搜索</span>';

            // 上一篇 / 下一篇
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
              .filter(function (l) { return l.href && l.href.indexOf('#/') === 0; });

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
              (prev ? '<a class="nav-prev" href="' + prev.href + '">← ' + prev.text + '</a>' : '<span></span>') +
              (next ? '<a class="nav-next" href="' + next.href + '">' + next.text + ' →</a>' : '<span></span>');
          } catch (e) {}
        }

        /* ---------- 标题锚点 ---------- */
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

        /* ---------- 全文搜索（Ctrl/⌘+K，无页面按钮） ---------- */
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
          modal.classList.add('open');
          ftsVisible = true;
          var input = document.getElementById('fts-input');
          if (input) { setTimeout(function () { input.focus(); input.select(); }, 50); }
        }

        function closeFts() {
          var modal = document.getElementById('fts-modal');
          if (modal) modal.classList.remove('open');
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
          document.getElementById('fts-results').innerHTML = html || '<div class="fts-empty">无匹配结果</div>';

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
        var GISCUS_THEME = (function () {
          // localhost 预览时 giscus.app 拉本地 CSS 会被 Chrome 拦截（Private Network Access）
          // → 本地用内置 light；线上用站内自定义主题
          var h = location.hostname;
          if (h === 'localhost' || h === '127.0.0.1') return 'light';
          var base = (typeof pageConfig.basePath === 'string') ? pageConfig.basePath : 'docs/';
          return location.origin + '/' + base.replace(/^\//, '').replace(/\/?$/, '/') + 'assets/giscus-theme.css';
        })();
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
          theme: GISCUS_THEME,
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
              '<div class="giscus-head">' +
                '<div class="giscus-title">评论</div>' +
              '</div>' +
              '<div class="giscus-body"></div>';
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

        /* ============================================================
           doneEach 钩子（核心渲染入口）
           ============================================================ */
        hook.doneEach(function () {
          document.querySelectorAll('pre[data-lang]').forEach(function (pre) {
            if (pre.dataset.toolbarInited === '1') return;
            pre.dataset.toolbarInited = '1';
            var codeEl = pre.querySelector('code');
            if (codeEl) pre.dataset.rawCode = (codeEl.textContent || '').replace(/\n$/, '');
            initToolbar(pre);
          });

          renderHeadingLinks(vm);
          ensureTocObserver();

          try {
            var p = (vm && vm.route && vm.route.path) ? vm.route.path : ((location.hash || '#/').split('?')[0] || '#/');
            if (!tocLastRoutePath || p !== tocLastRoutePath) {
              tocJumpStack = [];
              tocLastRoutePath = p;
            }
          } catch (e) {}
          try { setTocBackState(); } catch (e) {}

          scheduleTocRender(vm);
          renderBreadcrumbAndNav(vm);
          ensureFullTextSearch(vm);
          maybeApplyPendingHighlight(vm);

          // 评论：首页不加载，改为预建搜索索引
          var cPath = (vm && vm.route && vm.route.path) ? vm.route.path : '#/';
          if (isHomePath(cPath)) {
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
