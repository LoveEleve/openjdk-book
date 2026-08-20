# M-8 Cursor、ResultHandler 与增量结果消费 — note

## 本篇主张

- Cursor 不是懒 List，而是受 Session 生命周期约束的增量消费协议。
- `DefaultCursor` 的状态机和单 iterator 限制，是对底层 ResultSet 资源模型的直接表达。
- `ResultHandler` / `DefaultResultContext.stop()` 是“一次只推进一条结果”的真正开关。

## 本篇边界

- 不展开 Spring 对 Cursor 的封装。
- 不把 `cursor_cache_oom` 扩写成缓存专题。
- 只在需要时点到结果装配与 Session 关闭责任。

## 下篇桥接

- `M-9` 将收束 XML mapper 与注解 mapper 双入口如何并回同一套元数据主线。