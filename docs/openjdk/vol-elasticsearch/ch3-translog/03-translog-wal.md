# Translog：ES 怎么保证写入不丢数据

> 本文基于 ES v8.12.2 当前源码。`vol-elasticsearch` 第三篇，回答 Translog 的 WAL 机制。

## 困惑：写入 ES 后立即宕机，数据会丢吗？

`PUT /my_index/_doc/1` 返回 `201 Created` 后，如果节点立即宕机，重启后数据还在吗？

如果数据只写在 Lucene 的 `IndexWriter` 内存 buffer 里，宕机就丢了。所以 ES 用 Translog 作为 WAL——`Translog.add()` 先写日志，CarEngine 再写 Lucene。宕机重启后从 Translog 恢复未 flush 的数据。

## 分层拆解

### 1. Translog.add()：WAL 写入

`Translog.java:575`：

```java
public Location add(final Operation operation) throws IOException {
    // 写入 TranslogWriter（FileChannel.force(false)）
    writeOperationWithSize(out, operation);
    // ...
}
```

`TranslogWriter` 通过 `FileChannel.force(false)` 确保元数据写入（但数据可能延迟刷盘）。ES 8.x 默认 `index.translog.durability=request`——每次请求都 fsync。

### 2. Checkpoint 文件

`translog.ckp` 文件记录 `globalCheckpoint` 和 `minTranslogGeneration`。崩溃恢复时通过 checkpoint 定位需要回放的操作。

### 3. Generation 轮转

flush 时 `createNewTranslog()` 使当前 generation 封闭、只读，创建新 generation 继续写入。旧 generation 等待全部副本已同步后异步删除。

### 4. Translog.newSnapshot()：peer recovery

`Translog.java:657`：

```java
public Snapshot newSnapshot() throws IOException {
    return newSnapshot(0, Long.MAX_VALUE);
}
```

peer recovery 期间通过 `Translog.newSnapshot()` 创建 `TranslogSnapshot`，从主分片复制未 flush 的操作到新分片。

## 失败路径

- `durability=request` 时每次请求 fsync，慢但安全
- `durability=async` 时 fsync 间隔可能丢数据（默认 5s）
- generation 未及时清理导致磁盘空间占满

## 收网

Translog 是 ES 的 WAL：`Translog.add()` 先写日志再写 Lucene，`Translog.newSnapshot()` 用于 peer recovery。flush 时 `createNewTranslog()` 封闭旧 generation。Checkpoint 文件定位恢复起始位置。

## 下篇桥接

E-1a Engine 写入路径。
ENDOFFILE