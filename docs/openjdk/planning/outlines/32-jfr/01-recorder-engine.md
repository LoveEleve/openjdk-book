# 01. JFR 怎么在每个线程上采集事件？— Recorder Engine

> 🔴 Deep | 3 KP 中的核心引擎
> 读者处境: JFR 是 JVM 的生产性能分析器——在 ~2% overhead 下采集 130+ 事件类型。核心设计是 thread-local buffer——每个线程有自己的 per-event-type buffer→消除全局竞争→写 JFR event 只需 ~15 cycles。

> ⚠️ 写作期修正(2026-08-14, vol-02/32-jfr/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"per-event-type buffer" 编造**: JDK11 = 每线程 **两个 buffer**——_java_buffer/_native_buffer(jfrThreadLocal.hpp:39-40,Java 事件与 native 事件分流),非 per-event-type;大事件走 shelve+provision_large 临时租 transient buffer(thread buffer 8×,jfrStorage.cpp:100/136)
> - **"-XX:JfrThreadLocalBufferSize" 编造**: 不存在;默认 thread-local 8KB/global 512KB/global 池 20 块(jfrOptionSet.cpp:165/168 默认字符串 "512k"/"8k";jdk.jfr Options.java:44-46 count=20/size=524288)——大纲 "256-512KB" 是 global 大小,thread-local 只有 8K
> - **"~15 cycles/~2 cycles" 无源码依据**(规划数字,删除)
> - **"JfrChunkWriter::write_chunk_loop" 编造**: JDK11 = **JFR Recorder Thread 消息循环**(jfrRecorderThreadLoop.cpp:40-86): 六消息 START/SHUTDOWN/ROTATE/STOP/FULLBUFFER/DEADBUFFER;process_full_buffers/scavenge/evaluate_chunk_size_for_rotation/start/rotate;JfrChunkWriter 只是文件 IO(open :54-70 写 "FLR"+版本 2.0+reserve 6×8 头槽;close 时 write_header :95-107 回填 chunk_size/checkpoint/metadata/时间戳)
> - **"chunk rotation: size limit 固定" 半对**: 阈值=JfrChunkRotation::evaluate(size_written>threshold,jfrChunkRotation.cpp:62-66),**由 Java 侧 setFileNotification 设置**(jfrJniMethod.cpp:116-118);rotate 后 notify Java 侧 chunk monitor
> - **缺机制(重要)**: ①JfrBuffer 双指针: _pos(下一写入,线程私有)/_top(下一未刷,volatile,其他线程可见),_top<=_pos 且 volatile 保证刷写者不越过写入边界(jfrBuffer.hpp:33-57);②flush 链: flush(:480)→flush_regular(:489): 刷空→free_size 够则 memmove 续写→不够则 shelve+provision_large(:530 flush_large 恢复);满 buffer post MSG_FULLBUFFER(:351);③生命周期: JfrRecorder::create(jfrRecorder.cpp:234)=create_components(:256)+create_recorder_thread(:399);on_create_vm_1/2/3(:84/:193/:223);启停=post MSG_START/STOP(:417-429);④JfrRecorderService(start :248→open_new_chunk/rotate :310/finalize :375)
> - **实证**: 32-jfr-recorder-demo.txt(xxd 文件头 464c5200=FLR\0+版本 2.0+chunk_size 槽=文件大小回填;bin/jfr summary: Version 2.0/Chunks 1/事件表含 NativeMethodSample+CheckPoint;启动日志 Started recording)
> - **悬念指向 02-event-metadata ✓**(正确,保留)

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
