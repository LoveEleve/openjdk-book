# 01. JFR 怎么在每个线程上采集事件?— Recorder Engine

> **前置依赖**:[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JFR Recorder Thread 与采样线程已在后台线程族见过;[31-unsafe/02 — WhiteBox 与 Forte](openjdk/vol-02/31-unsafe-whitebox/02-whitebox-forte.md):JFR 方法采样器(os::SuspendedThreadTask);[38-perfdata/02 — StatSampler](openjdk/vol-02/38-perfdata/02-stat-sampler.md):另一条观测通道的对照
> → **后续**:[32-jfr/02 — 事件类型与元数据](02-event-metadata.md)
> 关联域: 30-jvm-entry(JVM 入口)、27-jni、04-logging

JFR 采集 130+ 种事件(方法采样、GC、锁、分配……),目标开销在个位数百分比。直接写全局缓冲需要锁——高并发下不可行。核心答案是 **per-thread buffer**: 每个线程自己的写入区,写完才交给后台线程落盘。本篇要回答的核心问题:

1. 写入侧——每线程怎么避免锁竞争,满了怎么办?
2. 调度侧——后台线程怎么处理满 buffer、chunk 轮转?
3. 文件侧——chunk 文件怎么组织,为什么可以边录边读?

答案会反复落到一句话:**JFR 的低开销靠每线程两个 buffer(Java/native 分流,bump 分配写 `_pos`,`_top` 做刷写水位线),满了走四级刷写链。后台 Recorder Thread 处理六种消息,chunk 自包含关闭时回填头。**

---

## 1. 开场困惑——"130+ 种事件,怎么低开销"

130+ 种事件类型,涉及方法采样、GC 阶段、锁竞争、分配剖面——这些事件在业务线程上实时产生,频率高、分布广。如果每个事件都写全局缓冲,多线程竞争同一块内存,锁的开销会吞噬掉 JFR 本身的意义。

JFR 的解决方案是: **每个线程自己写自己的 buffer,写完再通知后台线程取走。** 写入端无锁,满了有消息通知,后台线程批量处理。

---

## 2. 两个朴素方案为什么都不对

### 方案一: 全局单一缓冲 + 锁保护

最直接的方案: 一块全局缓冲,所有线程写之前加锁。问题在于: 高并发下锁竞争严重,写事件的线程被迫串行化,反过来又延长了持有锁的时间。JFR 的目标开销是个位数百分比,这个方案连 10 个线程都撑不住。

### 方案二: 每事件类型一个缓冲

另一种思路: 让 130 个事件类型各管各的 buffer,互相不争。问题在于: 事件类型数量多,但每个类型的事件频率差异巨大(GC 事件每秒几次,方法采样每秒几百次)。大多数 buffer 长期空闲,浪费内存;少数 buffer 又频繁满,管理成本高。

正确方案是 per-thread buffer: 每个线程自己的写入区,频率自然匹配(繁忙线程写得多,空闲线程写得少),写入时无锁。而且 Java 事件和 native 事件分开两个 buffer,因为两者的产生节奏差异大(Java 事件由业务线程提交,native 事件由 VM 代码提交),分开互不污染。

---

## 3. 写入侧——每线程两个 buffer

每个线程的 JFR 状态在 `JfrThreadLocal`(jfrThreadLocal.hpp:37-40)里,里面是 **两个 buffer**:

```cpp
// jfrThreadLocal.hpp:37-40(截取核心,逐字)
  mutable JfrBuffer* _java_buffer;
  mutable JfrBuffer* _native_buffer;
```

**Java 事件(jdk.jfr.Event 子类)写 `_java_buffer`,native 事件(GC/锁等埋桩)写 `_native_buffer`**。

### JfrBuffer 双指针

`JfrBuffer` 本身是极简的线性区(jfrBuffer.hpp:33-57):

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

**`_pos` 是下一写入位置(线程私有),`_top` 是下一"未刷写"位置(其他线程可见)**——事件写入是 bump 分配(`_pos += size`),刷写线程(Recorder Thread)从 `_top` 起读。`_top <= _pos` 且 `_top` 是 volatile: 写入线程更新 `_pos`(普通 store),刷写线程读到的 `_pos` 可能偏旧(少读,保守)但**不会越过写入者真正写完的位置**——而刷写动作本身由消息(MSG_FULLBUFFER)在锁内触发,可见性由消息同步补齐。

**默认大小**: thread-local 8KB、global 512KB、global 池 20 块(jfrOptionSet.cpp:165/168)。

### 满了怎么办——四级刷写链

`JfrStorage::flush`(jfrStorage.cpp:480)→ `flush_regular`(:489):

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

四级链:

1. **刷空当前 buffer**(`flush_regular_buffer`,把已写数据交给 Recorder Thread 的消息队列);
2. **剩余空间够就原地续写**(memmove 迁移未刷数据);
3. **不够就暂存(shelve)当前 buffer、临时租一个更大的 transient buffer**(`provision_large`),**大事件(如大字符串/长栈)不挤占小 buffer,用完即还**;
4. 恢复(restore)原 buffer。

满 buffer 经 `_post_box.post(MSG_FULLBUFFER)` 唤醒 Recorder Thread。

---

## 4. 调度侧——JFR Recorder Thread 的消息循环

写入侧只负责"塞进 buffer + 发消息",真正的处理在 **JFR Recorder Thread**。它的入口是消息循环(jfrRecorderThreadLoop.cpp:40-86):

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
      service.evaluate_chunk_size_for_rotation();
      if (START) {
        service.start();
      } else if (ROTATE) {
        service.rotate(msgs);
      }
      ...
```

消息种类: **START/SHUTDOWN/ROTATE/STOP/FULLBUFFER/DEADBUFFER**。满 buffer 来了 → `process_full_buffers`(把 buffer 数据解码写入当前 chunk);录制结束 → ROTATE → `rotate`;线程退出 → DEADBUFFER → `scavenge`(回收死 buffer)。

**JFR 的启动时机**(20-02 的 create_vm 序列): `JfrRecorder::on_create_vm_1`(jfrRecorder.cpp:84,启用+JfrTime 初始化)、`on_create_vm_2`(:193,JfrOptionSet 配置+dcmd 注册)、`on_create_vm_3`(:223,启动命令行录制)。

---

## 5. 文件侧——chunk 格式与轮转

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

**"FLR" + 版本 2.0 + 6 个 8 字节头槽**——头里的值(chunk 大小、checkpoint/metadata 偏移、时间戳)在 **chunk 关闭时回填**(`write_header`,:84-98)。第一个头槽是 chunk 大小,关闭时正好等于文件总大小。

**chunk 轮转**: `JfrChunkRotation::evaluate`(jfrChunkRotation.cpp:58-68)——`writer.size_written() > threshold` 就置 rotate 标志并**通知 Java 侧**("chunk monitor",:64-66,`notify_all`)。threshold 由 **Java 侧 `setFileNotification(阈值)`** 设置(jfrJniMethod.cpp:116-118)。轮转的意义: **每个 chunk 自包含**(自己的文件头+checkpoint+metadata),读者可以边录边读已完成 chunk,不必等录制结束。

---

## 6. 误解澄清与收网

1. **JFR 是否用全局缓冲?** 不是。每线程两个 buffer(Java/native),写入无锁。
2. **满了怎么办?** 四级刷写链: 刷空 → 原地续 → shelve → 租大 buffer,最后发 MSG_FULLBUFFER 通知 Recorder Thread。
3. **chunk 文件头什么时候写?** 打开时预留 6 个 8 字节槽,关闭时回填。所以文件头在关闭前是不完整的。
4. **chunk 轮转阈值怎么定?** 由 Java 侧 `setFileNotification(阈值)` 设置,不是固定值。
5. **JFR 启动分几步?** 三步: on_create_vm_1(初始化)、on_create_vm_2(配置)、on_create_vm_3(启动录制)。

把这一篇压成三句话:

- **写入侧**:每线程两个 buffer,`_pos`/`_top` 双指针 bump 分配,四级刷写链应对满 buffer。
- **调度侧**:Recorder Thread 消息循环处理六种消息,`process_full_buffers`/`scavenge`/`rotate`。
- **文件侧**:chunk 自包含,FLR+版本+6 头槽,关闭回填,阈值由 Java 侧设置。

事件怎么来的、描述结构长什么样——直接决定读取端怎么还原。下一篇: 事件类型与元数据。

> → [32-jfr/02 — 事件类型与元数据](02-event-metadata.md)