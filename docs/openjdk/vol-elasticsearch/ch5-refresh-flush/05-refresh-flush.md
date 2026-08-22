# refresh 和 flush：为什么 ES 是"近实时"搜索

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第五篇，回答 refresh/flush 的可见性与持久化。

## 困惑：为什么 ES 写入后要等 1 秒才能搜到？

`PUT /my_index/_doc/1` 返回后，立即 `GET /my_index/_search` 可能搜不到。为什么？

因为写入只到了 Lucene 的 `IndexWriter` 内存 buffer，还没打开新的 `IndexReader`。**refresh** 才让新数据可见——默认 1s 一次。这就是 ES 的 NRT（Near-Real-Time）搜索。

## 分层拆解

### 1. refresh：让新数据可见

`Engine.java:1109` 定义抽象：

```java
public abstract RefreshResult refresh(String source) throws EngineException;
```

`InternalEngine.java:2016` `maybeRefresh()`：

```java
public void maybeRefresh(String source, ActionListener<RefreshResult> listener) throws EngineException {
    // 通过 ReferenceManager.maybeRefresh() 打开新 IndexReader
    refreshed = referenceManager.maybeRefresh();
}
```

refresh 是**打开新的 IndexReader**，让 Lucene 内存 buffer 中的新 segment 对查询可见。默认 1s 一次（`index.refresh_interval=1s`），因为打开太频繁会降低写入性能。

### 2. flush：保证持久化

`InternalEngine.java:2173` `flush()`：

```java
public void flush(boolean force, boolean waitIfOngoing, ActionListener<FlushResult> listener) throws EngineException {
    // ① 获取 readLock + flushLock 防止并发 flush
    // ② refresh 关闭空闲 segment
    // ③ Lucene IndexWriter.commit() 执行 fsync
    // ④ Translog.createNewTranslog() 生成新 generation
}
```

flush 的三步：
1. **refresh**：关闭当前空闲 segment 到磁盘
2. **IndexWriter.commit()**：Lucene 的 fsync，保证数据落盘
3. **createNewTranslog()**：旧 transaction log 封闭，新 generation 开始

默认触发条件是 30min 或 translog 达到 512MB。

### 3. NRT 的原理

refresh 让新数据 1s 内可见（近实时），但此时数据只在内存 buffer / 缓存中，未 fsync。如果宕机，未 fsync 的数据会丢失——但 **Translog 保证恢复**：重启后从 Translog 重放未 flush 的操作。

所以 ES 的可靠性模型是：
- **可见性**：refresh（1s）
- **持久性**：Translog（请求级 fsync，`durability=request`）
- **磁盘落盘**：flush（30min/512MB）

## 失败路径

- refresh 间隔过短 → 打开 IndexReader 频繁，降低写入性能
- `durability=request` 时宕机 → Translog 重放恢复
- `durability=async` 时宕机 → 最多丢 5s 数据
- flush 时 IndexWriter.commit() fsync 慢 → 阻塞写入

## 收网

refresh 打开新 IndexReader 让数据可见（1s），flush 做 fsync + 新 translog generation（30min/512MB）。NRT 搜索 = refresh 的近实时可见性 + Translog 的 crash-safe 恢复。两者缺一不可。

## 下篇桥接

E-5 分片生命周期与复制。
ENDOFFILE