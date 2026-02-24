# Java并发编程思维导图

> 点击节点可展开/折叠，支持鼠标滚轮缩放和拖拽移动

<div id="markmap-toolbar" style="margin-bottom: 10px;">
  <button onclick="markmapFit()" style="padding:6px 14px;background:#42b983;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-right:8px;">适应屏幕</button>
  <button onclick="markmapToggle(true)" style="padding:6px 14px;background:#42b983;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-right:8px;">全部展开</button>
  <button onclick="markmapToggle(false)" style="padding:6px 14px;background:#42b983;color:#fff;border:none;border-radius:4px;cursor:pointer;">全部折叠</button>
</div>

<div id="markmap-container" style="border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
  <svg id="markmap" style="width: 100%; height: 750px;"></svg>
</div>

<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-view@0.15.4/dist/browser/index.js"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-lib@0.15.4/dist/browser/index.js"></script>
<script>
(function() {
  var checkInterval = setInterval(function() {
    if (typeof markmap === 'undefined' || !document.getElementById('markmap')) return;
    clearInterval(checkInterval);

    var Transformer = markmap.Transformer;
    var Markmap = markmap.Markmap;

    fetch('concurrent/mindmap/java-concurrency-mindmap-data.md')
      .then(function(r) { return r.text(); })
      .then(function(content) {
        var transformer = new Transformer();
        var result = transformer.transform(content);
        var mm = Markmap.create('#markmap', null, result.root);
        mm.fit();
        window._markmap = mm;
      })
      .catch(function(err) {
        document.getElementById('markmap').innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#999">加载失败: ' + err.message + '</text>';
      });
  }, 200);
})();

function markmapFit() {
  if (window._markmap) window._markmap.fit();
}

function markmapToggle(expand) {
  if (!window._markmap) return;
  var data = window._markmap.state.data;
  function toggle(node) {
    node.payload = node.payload || {};
    node.payload.fold = expand ? 0 : 1;
    if (node.children) node.children.forEach(toggle);
  }
  toggle(data);
  window._markmap.setData(data);
}
</script>
