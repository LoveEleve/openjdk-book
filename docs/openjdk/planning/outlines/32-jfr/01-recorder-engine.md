# 01. JFR 怎么在每个线程上采集事件？— Recorder Engine

> 🔴 Deep | 3 KP 中的核心引擎
> 读者处境: JFR 是 JVM 的生产性能分析器——在 ~2% overhead 下采集 130+ 事件类型。核心设计是 thread-local buffer——每个线程有自己的 per-event-type buffer→消除全局竞争→写 JFR event 只需 ~15 cycles。

### 1. "Thread-local buffer — 消除全局锁"

场景: 100 个线程同时触发了 ObjectAllocationInNewTLAB 事件——如果写全局 buffer→需要 lock→performance disaster。JFR 每个线程有自己的 private buffer→写完才偶尔 flush 到 global。

**JfrStorage — per-thread buffer** (`jfr/recorder/storage/jfrStorage.cpp:40-250`):
```
Per-thread allocation:
  JfrThreadLocal::buffer(event_type) → Thread-local buffer for this event type
  → bump allocate(buffer(), event_size)
    → if buffer full: acquire new buffer from global pool
      → old buffer: enqueue to JfrStorage → writer thread picks up
```
- 关键设计: thread-local buffer 大小 ~256-512KB(可配 `-XX:JfrThreadLocalBufferSize`)。每个 EventType 分别 buffer——高频事件(allocation/NPE)有独立 buffer——不会相互污染
- [C++: buffer allocate 是 bump pointer(类似 TLAB)—`check(top+size <= end)→add top,size→return old_top`。每个 event write 约 40-60 bytes→buffer holds ~5000-10000 events before flush]

### 2. "JfrRecorder — recording 生命周期"

**JfrRecorder** (`jfr/recorder/jfrRecorder.hpp/cpp`):
```
start: JfrRecorder::start() → enable thread local buffers → start periodic events
stop:  JfrRecorder::stop()  → drain all buffers → close chunk → finalize file
dump:  JfrRecorder::dump()  → force chunk rotation → write current chunk to file
```
- 关键设计: start/stop 是 JVM global state——start 后所有线程的系统调用进入 "JFR enabled" 模式→event commit 路径从 ~2 cycles(no-op)变为 ~15 cycles

### 3. "Buffer→Chunk→File 管道"

场景: Per-thread buffer 满→进入 global buffer pool→JfrChunkWriter 在后台 pick up→write to chunk file。

**Chunk Rotation** (`jfr/recorder/repository/jfrChunkWriter`):
```
[Thread1: TLABuffer→full→global queue]
  → JfrChunkWriter::write_chunk_loop:
    → decode events from buffers
    → serialize to chunk binary format
    → write to repository file(.jfr file)
  → chunk rotation: size limit reached → finalize chunk → start new chunk
```
- 源码: `jfr/recorder/repository/jfrChunkWriter.cpp`
- 关键设计: chunk rotation 让 reader 可以在 recording 进行中读已完成的 chunk——不必等 recording 结束。每 chunk 独立——含自己的 constant pool+metadata header

---

### 核心悬念

**"JfrStorage 用 thread-local per-event-type buffer→消除锁→~15 cycles per event write。JfrChunkWriter 后台写 chunk→chunk rotation 让 reader 边录边读。"** — 下一篇: Event Types + Metadata。

> → [02-event-metadata.md](02-event-metadata.md)
