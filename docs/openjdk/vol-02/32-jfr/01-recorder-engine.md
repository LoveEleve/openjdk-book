# 01. JFR 怎么在每个线程上采集事件?— Recorder Engine

> **前置依赖**:[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JFR Recorder Thread 与采样线程已在后台线程族见过;[31-unsafe/02 — WhiteBox 与 Forte](openjdk/vol-02/31-unsafe-whitebox/02-whitebox-forte.md):JFR 方法采样器(os::SuspendedThreadTask);[38-perfdata/02 — StatSampler](openjdk/vol-02/38-perfdata/02-stat-sampler.md):另一条观测通道的对照
> → **后续**:[32-jfr/02 — 事件类型与元数据](02-event-metadata.md)
> 关联域: 30-jvm-entry(JVM 入口)、27-jni、04-logging

## 130+ 种事件,怎么做到低开销

JFR 采集 130+ 种事件(方法采样、GC、锁、分配……),目标开销在个位数百分比。直接写全局缓冲需要锁——高并发下不可行。核心答案是 **per-thread buffer**: 每个线程自己的写入区,写完才交给后台线程落盘。这篇拆三层: 写入侧(JfrThreadLocal 的 buffer 与刷写链)、调度侧(JFR Recorder Thread 的消息循环)、文件侧(chunk 的格式与轮转)。

## 1. 写入侧: 每线程两个 buffer

每个线程的 JFR 状态在 `JfrThreadLocal`(jfrThreadLocal.hpp),里面是 **两个 buffer**——不是大纲想象的"per-event-type":

```cpp
// jfrThreadLocal.hpp:37-40(截取核心,逐字)
  mutable JfrBuffer* _java_buffer;
  mutable JfrBuffer* _native_buffer;
```

**Java 事件(jdk.jfr.Event 子类)写 `_java_buffer`,native 事件(GC/锁等埋桩)写 `_native_buffer`**——两类事件的产生节奏差异大(Java 事件由业务线程提交,native 事件由 VM 代码提交),分开互不污染。`JfrBuffer` 本身是极简的线性区(jfrBuffer.hpp:33-57,刷空后回收复用):

```cpp
// jfrBuffer.hpp:33-57(截取核心,逐字)
// u1* _pos <-- next store position
// u1* _top <-- next unflushed position
//
// A new _pos must be updated only after all intended stores have completed.
// The relation between _pos and _top must hold atomically,
// _top can move concurrently by other threads but is always <= _pos.
  u1* _pos;
  mutable const u1* volatile _top;
  size_t _size;
```

**`_pos` 是下一写入位置(线程私有),`_top` 是下一"未刷写"位置(其他线程可见)**——事件写入是 bump 分配(`_pos += size`),刷写线程(Recorder Thread)从 `_top` 起读。`_top <= _pos` 且 `_top` 是 volatile: 写入线程更新 `_pos`(普通 store),刷写线程读到的 `_pos` 可能偏旧(少读,保守)但**不会越过写入者真正写完的位置**——而刷写动作本身由消息(MSG_FULLBUFFER)在锁内触发,可见性由消息同步补齐。**默认大小: thread-local 8KB、global 512KB、global 池 20 块**(jfrOptionSet.cpp:165/168 的默认字符串 "512k"/"8k";jdk.jfr 侧 Options.java:44-46: `DEFAULT_GLOBAL_BUFFER_COUNT=20`、`DEFAULT_GLOBAL_BUFFER_SIZE=524288`)——大纲的 "256-512KB" 是 global 的大小,thread-local 只有 8KB。

**满了怎么办**: `JfrStorage::flush`(jfrStorage.cpp:480)→ `flush_regular`(:489)——

```cpp
// jfrStorage.cpp:489-529(截取核心,逐字)
BufferPtr JfrStorage::flush_regular(BufferPtr cur, const u1* const cur_pos, size_t used, size_t req, bool native, Thread* t) {
  debug_only(assert_flush_regular_precondition(cur, cur_pos, used, req, t);)
  if (!cur->empty()) {
    flush_regular_buffer(cur, t);
  }
  assert(t->jfr_thread_local()->shelved_buffer() == NULL, "invariant");
  if (cur->free_size() >= req) {
    // simplest case, no switching of buffers
    if (used > 0) {
      // source and destination may overlap so memmove must be used instead of memcpy
      memmove(cur->pos(), (void*)cur_pos, used);
    }
    ...
    return cur;
  }
  // Going for a "larger-than-regular" buffer.
  // Shelve the current buffer to make room for a temporary lease.
  t->jfr_thread_local()->shelve_buffer(cur);
  return provision_large(cur, cur_pos, used, req, native, t);
}
```

链: ①先**刷空当前 buffer**(`flush_regular_buffer`,把已写数据交给 Recorder Thread 的消息队列);②剩余空间够就原地续写(memmove 迁移未刷数据);③不够就**暂存(shelve)当前 buffer、临时租一个更大的 transient buffer**(`provision_large`),写完再换回(restore,`_transient_mspace` 的大小是 thread buffer 的 8 倍,jfrStorage.cpp:100/136)——**大事件(如大字符串/长栈)不挤占小 buffer,用完即还**。满 buffer 经 `_post_box.post(MSG_FULLBUFFER)`(:351)唤醒 Recorder Thread。

## 2. 调度侧: JFR Recorder Thread 的消息循环

写入侧只负责"塞进 buffer + 发消息",真正的处理在 **JFR Recorder Thread**(20-02 线程转储里见过)。它的入口是消息循环(jfrRecorderThreadLoop.cpp:40-86):

```cpp
// jfrRecorderThreadLoop.cpp:40-86(截取核心,逐字)
  #define START (msgs & (MSGBIT(MSG_START)))
  #define SHUTDOWN (msgs & MSGBIT(MSG_SHUTDOWN))
  #define ROTATE (msgs & (MSGBIT(MSG_ROTATE)|MSGBIT(MSG_STOP)))
  #define PROCESS_FULL_BUFFERS (msgs & (MSGBIT(MSG_ROTATE)|MSGBIT(MSG_STOP)|MSGBIT(MSG_FULLBUFFER)))
  #define SCAVENGE (msgs & (MSGBIT(MSG_DEADBUFFER)))
  ...
    while (!done) {
      if (post_box.is_empty()) {
        JfrMsg_lock->wait(false);
      }
      msgs = post_box.collect();
      ...
      if (PROCESS_FULL_BUFFERS) {
        service.process_full_buffers();
      }
      if (SCAVENGE) {
        service.scavenge();
      }
      // Check amount of data written to chunk already
      // if it warrants asking for a new chunk
      service.evaluate_chunk_size_for_rotation();
      if (START) {
        service.start();
      } else if (ROTATE) {
        service.rotate(msgs);
      }
      ...
```

消息种类: **START/SHUTDOWN/ROTATE/STOP/FULLBUFFER/DEADBUFFER**。满 buffer 来了 → `process_full_buffers`(把 buffer 数据解码写入当前 chunk);录制结束 → ROTATE → `rotate`;线程退出 → DEADBUFFER → `scavenge`(回收死 buffer)。这个线程与 JFR 生命周期绑定:`JfrRecorder::create`(jfrRecorder.cpp:234)创建组件(`create_components`,:256)+ 启动线程(`create_recorder_thread`→`JfrRecorderThread::start`,:399-401);录制启停只是往 post_box 投消息(`start_recording`/`stop_recording`,:417-429)。

**JFR 的启动时机**(20-02 的 create_vm 序列): `JfrRecorder::on_create_vm_1`(:84,启用+JfrTime 初始化)、`on_create_vm_2`(:193,JfrOptionSet 配置+dcmd 注册)、`on_create_vm_3`(:223,启动命令行录制)——[实证:](planning/outlines/00-jvm-tools/materials/commands/32-jfr-recorder-demo.txt) 启动日志 "Started recording 1. No limit specified, using maxsize=250MB as default."

## 3. 文件侧: chunk 格式与轮转

`JfrChunkWriter`(jfrChunkWriter.cpp)是文件 IO 层。`open`(:54-70)写文件头:

```cpp
// jfrChunkWriter.cpp:54-70(截取核心,逐字)
bool JfrChunkWriter::open() {
  assert(_chunkstate != NULL, "invariant");
  JfrChunkWriterBase::reset(open_chunk(_chunkstate->path()));
  const bool is_open = this->has_valid_fd();
  if (is_open) {
    this->write_bytes("FLR", MAGIC_LEN);
    this->be_write((u2)JFR_VERSION_MAJOR);
    this->be_write((u2)JFR_VERSION_MINOR);
    this->reserve(6 * FILEHEADER_SLOT_SIZE);
    // u8 chunk_size
    // u8 initial checkpoint offset
    // u8 metadata section offset
    // u8 chunk start nanos
    // u8 chunk duration nanos
    // u8 chunk start ticks
    ...
```

**"FLR" + 版本 2.0 + 6 个 8 字节头槽**——头里的值(chunk 大小、checkpoint/metadata 偏移、时间戳)在 **chunk 关闭时回填**(`write_header`,:95-107)。[实证:](planning/outlines/00-jvm-tools/materials/commands/32-jfr-recorder-demo.txt) `xxd` 文件头 `464c 5200 0002 0000...`(FLR\0 + major 2 + minor 0),第一个头槽 `0x5068e`=329358 **正好等于文件大小**——回填的证据;`jfr summary` 读出 "Version: 2.0 / Chunks: 1",事件表里 `jdk.NativeMethodSample`(采样器)、`jdk.CheckPoint`(常量池检查点)都在。

**chunk 轮转**: `JfrChunkRotation::evaluate`(jfrChunkRotation.cpp:62-66)——`writer.size_written() > threshold` 就置 rotate 标志并**通知 Java 侧**("chunk monitor",:64-66,`notify_all`)。threshold 由 **Java 侧 `setFileNotification(阈值)`** 设置(jfrJniMethod.cpp:116-118,`jfr_set_file_notification`)——不是大纲的"固定 size limit"。轮转的意义: **每个 chunk 自包含**(自己的文件头+checkpoint+metadata),读者可以边录边读已完成 chunk,不必等录制结束。

## 核心悬念

采集引擎拆完: 写入侧是每线程两个 buffer(Java/native 分流,`_pos`/`_top` 双指针,8KB 默认)与四级刷写链(刷空→原地续→shelve→租大 buffer);调度侧是 JFR Recorder Thread 的消息循环(六种消息,process_full_buffers/scavenge/rotate);文件侧是 "FLR"+版本+6 头槽的 chunk(关闭回填头,阈值由 Java 侧 setFileNotification 决定,chunk 自包含可边录边读)。[实证](planning/outlines/00-jvm-tools/materials/commands/32-jfr-recorder-demo.txt)里文件头逐字节对上、summary 读出 130+ 事件类型。

但"130+ 事件类型"本身是**元数据描述**的——每个事件的名称、字段、阈值、如何序列化,记录在 `.jfr` 的 metadata 区;事件从哪来、描述结构长什么样,直接决定读取端怎么还原。下一篇: 事件类型与元数据。

> → [32-jfr/02 — 事件类型与元数据](02-event-metadata.md)
