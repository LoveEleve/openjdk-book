# prompt-00 — JFR Recorder Engine: 记录引擎核心管道

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1: JFR Chunk Rotation 导致 30s GC Pause**
线上 `-XX:FlightRecorderOptions=repository=/tmp,maxchunksize=20m`。Full GC 期间触发 JFR chunk rotation，`InvokeSafepointWriteSynchronizedVMOperation` 在 safepoint 内做 chunk 最终写入和 checkpoint 序列化。20MB chunk 的 `write_header()` + 类型常量池写出导致 safepoint 延长至 30 秒。
- strace 追踪：`strace -e trace=write -p 12345 -T` 发现 fd=42 在 safepoint 区间连续 write(2) 调用，每次 512KB
- 根因：`JfrRecorderService::safepoint_write()` → `JfrChunkWriter::write_header()` → `StreamWriterHost::flush()` → `::write(fd, buf, 512K)` 发生在线程暂停区间
- GDB 打断：`b JfrRecorderService::safepoint_write` → `bt` → 确认 VMThread 调用栈

**场景 2: Thread-Local Buffer 泄漏 — 48 小时 OOM**
生产环境启用 JFR continuous recording，48 小时后 Metaspace OOM。排查发现 JFR thread-local buffer 分配未释放：
- `jcmd 12345 VM.native_memory summary` 显示 JFR 占用 2GB CHeap
- GDB: `p JfrStorage::global_mspace()->full_list_size()` → 18654 full buffers 堆积
- 根因：`JfrRecorderService::process_full_buffers()` 消费速率 < 生产速率 — commit thread 未被唤醒
- jstack 确认：JfrRecorderThread 处于 `WAITING (parking)`，未收到 PostBox message

**场景 3: VM Error 期间 JFR Emergency Dump 竞态**
进程收到 SIGSEGV，VMError::report_and_die() 中调用 `JfrRecorderService::vm_error_rotation()`。同时 WatcherThread 尝试 periodic task → rotate()。两个线程争 `RotationLock` 的 CAS：
- `try_set()` 使用 `Atomic::cmpxchg` — 只一个线程胜出
- 失败者 `log(true)` 输出 "Unable to issue rotation due to recursive calls"
- Counterfactual: 如果 VMError 不使用 try_set 而用递归锁，可能导致死锁

---

## §一 Task + Narrative + Beginner Callouts

**任务**: 写一篇 ~2,500 行的深度技术文档，覆盖 JFR Recorder Engine 的核心管道：从 `JfrRecorder::create()` 创建 10+ 组件 → `start_recording()` 启动 → 事件写入环形缓冲区 → chunk rotation → 最终 checkpoint 序列化 → chunk 文件落盘。

**叙事线索**: 跟踪一次完整的 JFR recording 生命周期。

> **Beginner Callout 1 — 什么是 JFR Chunk?** JFR 不写单个大文件。它将 recording 分成多个 "chunk"（块），每个 chunk 是自包含的 JFR 文件。Chunk rotation（块轮转）发生在达到 maxchunksize 或 manual rotate 时。每个 chunk 包含：header + constant pool (checkpoint events) + event section + metadata。

> **Beginner Callout 2 — 为什么需要 Ring Buffer?** 事件写入是非常热路径（每毫秒数千事件）。直接 disk write(2) 会阻塞 mutator 线程。JFR 使用环形缓冲区：线程先写入 thread-local buffer，buffer 满后"退休"到 global buffer 队列，由专门的 JfrRecorderThread 异步写出到磁盘。这是典型的 producer-consumer 分离。

> **Beginner Callout 3 — _pos vs _top 双指针语义**。`JfrBuffer::_pos` 是线程独占的写入位置（只有 owner 移动）。`JfrBuffer::_top` 是并发可见的"已提交"边界（多个读者可见）。pos ≥ top。当 writer 调用 `set_top(new_pos)` 时，才把新数据"发布"给消费者（chunk writer）。

> **Beginner Callout 4 — Epoch 老化机制**。Buffer 不是无限增长——epoch 切换时，旧 epoch 的 buffer 被移到 `_age_mspace`（老化空间）。类似 JVM 的 GC survivor → old generation。AgeNode 持有 retired buffer 链表，等待 scavenge 时清理。

> **Beginner Callout 5 — safepoint write 为什么特殊**。Chunk rotation 的关键步骤（finalize_current_chunk, write_header）必须在 safepoint 中执行，因为需要保证所有线程的 buffer 都被刷新、无竞争写入。代价：safepoint 期间 compute-bound 工作（类型序列化）延长暂停时间。

> **Beginner Callout 6 — VM Error 安全保证**。JFR emergency dump 在信号处理器中执行（SIGSEGV/SIGBUS）。存在严格约束：不能用 malloc/printf，只能用 write(2) + 静态缓冲 + 信号安全路径。`JfrRecorderService::prepare_for_vm_error_rotation()` 预计算 buffer 位置避免 malloc。

> **Beginner Callout 7 — PostBox 消息通道**。JfrRecorderThread 不是 busy-spin 轮询。它使用 `JfrPostBox` — 类似 Actor model 的信箱：producer 通过 `post(MSG_ROTATE)` 发消息，recorder thread 通过 `JfrPostBox::collect()` 获取。底层是 semaphore + 无锁队列。

---

## §二 Standard Environment

### Source Roots & Build

```
源码根: src/hotspot/share/jfr/recorder/
构建: make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM
      --with-jfr 控制是否编译入 libjvm.so
Binary: build/linux-x86_64-server-release/jdk/lib/server/libjvm.so
```

### 运行时依赖

```
JFR 默认内存: 见 JfrMemorySizer
Chunk 默认位置: java.io.tmpdir (通常是 /tmp)
Chunk 文件名格式: hotspot-pid-<pid>-id-<N>.jfr
Repository: 保存最近 N 个 chunk 供 dump 使用
```

### Syscall 速查表

| Syscall | 用途 | man | JFR 调用位置 |
|---------|------|-----|-------------|
| write(2) | chunk 数据落盘 | man 2 write | JfrBufferedStreamWriter::flush() → ::write() |
| open(2) | 创建 chunk 文件 | man 2 open | JfrChunkWriter::open() |
| close(2) | 关闭 chunk 文件 | man 2 close | JfrChunkWriter::close() |
| mmap(2) | 内存映射存储 | man 2 mmap | JfrVirtualMemory::initialize() |
| futex(2) | semaphore wait | man 2 futex | JfrPostBox semaphore 底层 |
| clock_gettime(2) | 纳秒时间戳 | man 2 clock_gettime | JfrTime::stamp() |
| rename(2) | chunk 文件重命名 | man 2 rename | JfrChunkRotation::rotate() |
| ftruncate(2) | chunk 文件截断 | man 2 ftruncate | JfrChunkWriter::close() |

### 全局状态表

| 变量 | 位置 | 类型 | 说明 |
|------|------|------|------|
| JfrRecorder::_enabled | jfrRecorder.hpp:60 | static bool | JFR 是否启用 |
| JfrStorage::_control | jfrStorage.hpp:47 | JfrStorageControl* | 存储策略控制 |
| _global_mspace | jfrStorage.hpp:48 | JfrStorageMspace* | 全局 buffer 空间 |
| _thread_local_mspace | jfrStorage.hpp:49 | JfrThreadLocalMspace* | 线程本地 buffer |
| _age_mspace | jfrStorage.hpp:51 | JfrStorageAgeMspace* | 老化 buffer 空间 |
| rotation_thread | jfrRecorderService.cpp:76 | static void* | 当前持有 RotationLock 的线程 |
| JfrCheckpointManager::_lock | jfrCheckpointManager.hpp:60 | Mutex* | checkpoint 序列化互斥 |
| _checkpoint_epoch_state | jfrCheckpointManager.hpp:63 | bool | epoch 切换标记 |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| jfrRecorder.hpp | jfr/recorder/ | 70 | `class JfrRecorder` | 顶层生命周期管理 |
| jfrRecorder.cpp | jfr/recorder/ | 290 | create_components(), destroy_components() | 组件创建/销毁 |
| jfrRecorderService.hpp | jfr/recorder/service/ | 77 | `class JfrRecorderService` | chunk rotation 编排器 |
| jfrRecorderService.cpp | jfr/recorder/service/ | 540 | start(), rotate(), process_full_buffers() | 核心编排逻辑 |
| jfrRecorderThread.hpp/cpp | jfr/recorder/service/ | ~120 | recorderthread_entry() | recorder 线程 |
| jfrRecorderThreadLoop.cpp | jfr/recorder/service/ | ~200 | `JfrRecorderThreadLoop::run()` | 线程主循环 |
| jfrPostBox.hpp/cpp | jfr/recorder/service/ | ~150 | `class JfrPostBox` | 消息通道 |
| jfrBuffer.hpp | jfr/recorder/storage/ | 184 | `class JfrBuffer`, `class JfrAgeNode` | 环形缓冲区 |
| jfrBuffer.cpp | jfr/recorder/storage/ | ~350 | acquire(), release(), move() | buffer 并发操作 |
| jfrStorage.hpp | jfr/recorder/storage/ | 98 | `class JfrStorage`, 4 个 mspace typedef | 4 层 buffer 管理 |
| jfrStorage.cpp | jfr/recorder/storage/ | ~550 | flush_regular(), provision_large() | buffer 流控 |
| jfrMemorySpace.hpp | jfr/recorder/storage/ | ~350 | `template class JfrMemorySpace` | 内存空间模板 |
| jfrStorageControl.hpp/cpp | jfr/recorder/storage/ | ~200 | `class JfrStorageControl` | buffer 大小/数量策略 |
| jfrChunkWriter.hpp | jfr/recorder/repository/ | 58 | `class JfrChunkWriter` | chunk 文件写入 |
| jfrChunkWriter.cpp | jfr/recorder/repository/ | ~300 | open(), close(), write_header() | chunk 格式生成 |
| jfrChunkState.hpp/cpp | jfr/recorder/repository/ | ~200 | `class JfrChunkState` | chunk 路径/状态管理 |
| jfrChunkRotation.hpp/cpp | jfr/recorder/repository/ | ~200 | `class JfrChunkRotation` | chunk 轮转 |
| jfrRepository.hpp/cpp | jfr/recorder/repository/ | ~300 | `class JfrRepository` | chunk 仓库 |
| jfrCheckpointManager.hpp | jfr/recorder/checkpoint/ | 108 | `class JfrCheckpointManager` | checkpoint 总管 |
| jfrCheckpointManager.cpp | jfr/recorder/checkpoint/ | ~400 | write_types(), write_type_set() | 类型序列化 |
| jfrCheckpointWriter.hpp/cpp | jfr/recorder/checkpoint/ | ~250 | `class JfrCheckpointWriter` | checkpoint 写出器 |
| jfrTypeManager.hpp/cpp | jfr/recorder/checkpoint/types/ | ~300 | type registration | 类型注册 |
| jfrTypeSet.hpp/cpp | jfr/recorder/checkpoint/types/ | ~600 | `class JfrTypeSet` | 类型集序列化 |
| jfrStringPool.hpp/cpp | jfr/recorder/stringpool/ | ~600 | `class JfrStringPool` | 字符串去重 |
| jfrStackTraceRepository.hpp/cpp | jfr/recorder/stacktrace/ | ~500 | `class JfrStackTraceRepository` | 栈帧去重 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 JfrRecorder 生命周期状态机（WHY 多层 create）

**①**: `create(bool simulate_failure)` 的三阶段创建流程是什么？为什么分 `on_create_vm_1/2/3` 三个 hook 而非一次性创建？
- `on_create_vm_1`: JfrRecorderThread 启动前 — 创建 Storage + CheckpointManager
- `on_create_vm_2`: 在 `Threads::create_vm()` 中 — 创建 Repository + StringPool + StackTraceRepository
- `on_create_vm_3`: VM 完全初始化后 — 创建 JVMTI agent + OS interface
- 分阶段的 WHY: 依赖顺序（Storage 必须先于 Repository 创建，因为 Repository 依赖 Storage 的 buffer 池）；JVMTI 必须在 VM 完全初始化后才能 attach

**② Counterfactual**: 如果一次性 `create()` 所有组件，会有什么问题？
- JVMTI agent 在 VM 未完全初始化时 attach 会触发未定义行为（Java Thread 不存在）
- 无法通过 `simulate_failure` 进行阶段性失败测试— 分阶段允许在任意阶段注入模拟错误

### 4.2 JfrBuffer 双指针并发模型（_pos/_top 事务语义）

**①**: `_pos` 和 `_top` 的并发语义是什么？为什么 `set_pos()` 必须在所有 store 完成后调用？
- `_pos` thread-local write（只有 owner 写）
- `_top` concurrent read（多个线程读，consumer 也写）
- 事务保证：必须先将 event 字节全部写入 buffer，最后 atomic 更新 `_pos` → 确保 `_top` 看到的状态是完整的 event，不会读到半写数据

**②**: `try_acquire()` 的 CAS 语义是什么？为什么 `_identity` 是实现 owner 检测的关键？
- `try_acquire(const void* id)`: `Atomic::cmpxchg(id, &_identity, NULL)` — CAS 竞标
- `acquired_by_self()`: `_identity == Thread::current()` — 快速 owner 检查
- `acquired_by(const void* id)`: 检查特定 owner

**③ Counterfactual**: 如果不使用 `_pos/_top` 双指针，而用一个 mutex 保护的 `_size` field，会损失什么性能？
- 失去无锁写入：thread-local buffer 的无锁写入是 ~10ns，mutex lock+unlock 是 ~50ns（5× 慢）
- 失去并发消费：consumer 无法在不阻塞 writer 的情况下读取已提交数据

### 4.3 JfrStorage 四层 Buffer 空间（thread-local → global → transient → age）

**①**: 四层空间的完整生命周期是什么？每个层次在什么条件下触发 buffer 晋升？
- **thread-local**: 线程独占，写入事件，满后 → register_full → **global**
- **global**: 待写出队列，JfrRecorderService::write() → write(2) 到 chunk 文件 → 返回到 **thread-local free list**
- **transient**: 大事件的临时大 buffer，使用后 → release 到 **global free list** 或直接 free
- **age**: epoch 切换时旧 buffer 的暂存，scavenge 时清理

**②**: `flush_regular()` 和 `flush_large()` 的分支逻辑是什么？为什么 `native` 参数至关重要？
- `flush_regular()`: 尝试获取新的 thread-local buffer → 把当前 buffer move 到新 buffer → register full
- `flush_large()`: 事件大小超过 buffer capacity → 获取专用 transient buffer → 写入 → release
- `native=true`: 在 JNI native 方法中调用 → 不能用 JavaThread blocking → 使用 `provision_large()` 非阻塞路径

**③ Counterfactual**: 如果不分层，所有线程直接写 global buffer（单一大缓冲），会面临什么竞态？
- 所有线程 CAS 竞争单一 buffer → 高冲突率（千级线程）→ CAS 重试风暴
- consumer 消费期间阻塞所有 producer（无法并发读写）
- 无法按线程分类事件（丢失 thread attribution）

### 4.4 JfrChunkWriter: Chunk 文件格式与三段结构

**①**: Chunk 文件的三段结构是什么？`write_header()` 中的 `metadata_offset` 参数作用是什么？
- **Header段**（固定大小）: magic number("FLR\0") + version + chunk size + chunk timestamp + duration + metadata offset pointer
- **Event段**（variable）: checkpoint events + recorded events 交错排列
- **Metadata段**（结尾之前）: metadata_offset 指向的 checkpoint type descriptors
- WHY metadata 在尾部：header 中有 `metadata_offset` 字段 — 允许 event + checkpoint 顺序写入，最后回填 metadata 位置

**②**: `close(int64_t metadata_offset)` 的流程是什么？为什么需要 ftruncate？
- 计算 metadata start offset → write_header(metadata_offset) — 回填 header 中的 metadata 指针
- `::ftruncate(fd, actual_size)` — 截断预分配的多余空间
- `::close(fd)` — 关闭 fd

**③ Counterfactual**: 如果不用 `metadata_offset` 回填而把 metadata 放在 header 之后（顺序布局），有什么问题？
- Metadata 的内容（type descriptions）是在 checkpoint 写入过程中动态决定的 — 在 chunk 开始时不知道 metadata 大小
- 顺序布局必须预留固定大小空间 → 要么浪费 (over-allocate)，要么溢出 (under-allocate)

### 4.5 JfrCheckpointManager: Type Serialization 与 Epoch 切换

**①**: checkpoint 的序列化流程是什么？`write_type_set()` 和 `write_safepoint_types()` 的区别？
- `write_type_set()`: 序列化所有已注册的类型（Thread/Class/Method/Symbol/ThreadGroup 等）→ 写出 key-value pairs → 生成 TypeSet checkpoint event
- `write_safepoint_types()`: 仅在 safepoint 内序列化 — 只写线程相关的类型（Thread State, Thread Group）— 因为这些类型在 safepoint 外可能改变
- 非 safepoint 类型（Class/Method/Symbol）在正常 write() 中序列化

**②**: `shift_epoch()` 和 `use_epoch_transition_mspace()` 的 epoch 机制是什么？
- 两个 epoch 空间 — `_free_list_mspace` 和 `_epoch_transition_mspace`
- `shift_epoch()` 交换两者角色 — 新的 type 写入进入新 epoch 的 mspace，旧 epoch 的 type 等待 GC
- `use_epoch_transition_mspace()`: 检查当前线程是否有旧 epoch 类型的脏引用

**③ Counterfactual**: 如果所有类型在每次 chunk 都全量序列化（无增量），会有什么成本？
- 每个 chunk 包含所有已加载类的元数据（数千类 × 每类 200 bytes = ~1MB per chunk）
- JVM 运行数小时后可能累积数十万个类 → 全量序列化 O(N) 而非 O(Δ) → chunk rotation 时间线性增长

### 4.6 JfrRecorderService: chunk rotation 编排与 safepoint 协议

**①**: `chunk_rotation()` 的完整流程是什么？为什么需要 `invoke_safepoint_write()`？
- `pre_safepoint_write()`: 普通写（非 safepoint-safe types）
- `invoke_safepoint_write()`: 提交 `VM_InvokeSafepointWriteSynchronizedOperation` → VMThread 执行
- `safepoint_write()`: 在 safepoint 中 — 刷新所有 thread-local buffer → 写入 safepoint types → 最终 checkpoint → finalize_current_chunk()
- `post_safepoint_write()`: post-chunk cleanup → 打开新 chunk → 写入新 chunk header

**②**: `in_memory_rotation()` 的特殊性是什么？为什么不需要 safepoint？
- disk=false 模式 — 数据不写盘，只在内存中旋转
- `serialize_storage_from_in_memory_recording()` — 从 global buffer 链表反序列化写出
- 不需要 safepoint 因为没涉及 chunk 文件格式的正确性保证（无 ftruncate/close）

**③ Counterfactual**: 如果 chunk rotation 完全不在 safepoint 中执行（全异步），会面临什么问题？
- 类型元数据可能不一致 — `write_safepoint_types()` 依赖 VM 一致性状态（线程卡在 safepoint 确保不变）
- 部分线程的 thread-local buffer 在 rotation 过程中继续写入 → 新 chunk 丢失事件

### 4.7 StringPool + StackTraceRepository: 无锁去重

**①**: StringPool 的无锁去重机制是什么？如何确保不同线程写入相同字符串时只存储一份？
- `JfrStringPoolBuffer` 使用 CAS 探测已有 entry — `StringPoolBuffer::add()` 先尝试 find（hash table probe），失败则 CAS insert
- 如果 CAS 失败（另一个线程先写入）→ 复用已有 entry 的 string_id，不重复写
- writer 记录 `(string_id, offset, length)` → consumer 通过 string_id 查找实际字符串

**②**: StackTraceRepository 的去重基于什么？为什么用 hash + frame 比较而非指针比较？
- `JfrStackTrace::hash()` 哈希所有帧的 method_id + bci
- `JfrStackTrace::equals()` 逐帧比较 method_id + bci + type
- WHY 不用指针: 同一调用栈可能由不同 thread 产生 → frame oop 不同 → 指针比较失败 → 用语义去重

**③ Counterfactual**: 如果 StringPool 和 StackTraceRepository 都用全局 mutex 而非无锁，JFR recording 在 1000 并发线程下的吞吐会降多少？
- Mutex lock/unlock ~50ns，无锁 CAS ~10ns → 5× per operation
- 1,000 threads × 10,000 events/sec = 千万/秒 events → 无锁: ~10ms/s latency，mutex: ~50ms/s → 在 high-load 下 mutex 成为瓶颈

### 4.8 JfrMemorySpace: 模板化的内存空间抽象

**①**: `JfrMemorySpace<JfrBuffer, RetrievalPolicy, Callback>` 的模板设计意图是什么？
- `RetrievalPolicy`: 定义 buffer 如何从 free_list 分配 — `JfrMspaceSequentialRetrieval`（顺序）vs `JfrMspaceAlternatingRetrieval`（交替）vs `JfrThreadLocalRetrieval`（per-thread）
- `Callback`: 当 buffer 满时调用的回调 → `register_full()` → 发送 PostBox 消息通知 consumer
- WHY template: 同样的 mspace 框架被 5 个不同子系统复用（Storage, Checkpoint, ThreadLocal, Age, StringPool）

**② Counterfactual**: 如果用虚函数 + 子类继承替代模板策略，有什么运行时代价？
- 虚函数调用 ~5-10ns overhead × 每秒百万次 buffer 操作 → ~10ms/s 额外 overhead
- 模板编译期绑定 → 零虚函数开销

### 4.9 JfrRecorderThreadLoop: recorder thread 主循环

**①**: `JfrRecorderThreadLoop::run()` 的事件循环是什么？如何从 PostBox 获取消息并分发？
- `JfrPostBox::collect()` — blocking wait on semaphore
- 消息类型: `MSG_ROTATE`, `MSG_STOP`, `MSG_FLUSHPOINT`, `MSG_FULLBUFFER`
- 分发: rotate() → chunk rotation; write() → process_full_buffers; scavenge() → 清理 age buffer
- 定时器: `JfrRecorderThreadLoop` 检查是否达到 `maxchunksize` 或 `globalbuffersize` 阈值

**② Counterfactual**: 如果 recorder thread 使用 busy-spin 而非 blocking semaphore，对 CPU 占用影响？
- busy-spin 持续消耗 1 个 CPU 核心（100% utilization）— 即使无事可做
- blocking semaphore → 0% CPU when idle → 只在实际有 work 时唤醒

---

## §五 Article Structure

```
# 00-JFR-Recorder-Engine — 记录引擎核心管道

## §〇 生产场景（3 个线上故障）
## §一 全景架构 — 记录引擎地图
## §二 Source Files Table + Standard Environment
## §三 JfrRecorder 生命周期 — 从 create() 到 destroy()
## §四 JfrBuffer 并发模型 — _pos/_top 事务语义
## §五 JfrStorage 四层 Buffer 空间
## §六 JfrMemorySpace 模板抽象
## §七 JfrChunkWriter — Chunk 文件格式
## §八 JfrChunkRotation + Repository — 轮转策略
## §九 JfrCheckpointManager — 类型序列化引擎
## §十 StringPool + StackTraceRepository — 无锁去重
## §十一 JfrRecorderService — chunk rotation 编排
## §十二 JfrRecorderThreadLoop — recorder thread 主循环
## §十三 VM Error Emergency Dump
## §十四 Counterfactual 对比表
## §十五 GDB 断点验证 + strace/jstack/jcmd 诊断
## §十六 Cross-Reference
## §十七 "不要写成→应该写成" 对照表
```

---

## §六 Writing Requirements（含"不要写成→应该写成"对照表）

| 不要写成 | 应该写成 |
|---------|---------|
| 罗列 `JfrRecorderService` 所有 73 行成员函数声明 | 解释 `start()`/`rotate()`/`process_full_buffers()` 三函数的调用关系和协议（safepoint 协议约束） |
| "JfrBuffer 有 _pos 和 _top 两个指针" 就结束 | 解释 `_pos ≥ _top` 保证的事务语义：为什么先写 event 再 atomic move pos，确保 consumer 只看到完整 event；`jfrBuffer.hpp:33-46` 注释的英文翻译 |
| 按文件顺序逐个翻译 `jfrStorage.cpp` | 用 4 层空间的生命周期图：thread-local → global → transient → age，追踪一次 event write 的全链路 (jfrStorage.cpp:64 delegate → flush_regular → register_full → PostBox) |
| "有 5 个 mspace typedef" 然后列出 | 解释 `JfrMemorySpace` 模板的 RetrievalPolicy 策略差异：Sequential (顺序分配，适合 checkpoint buffer) vs Alternating (交替轮流，减少冲突，适合 global buffer) vs ThreadLocal (per-thread 隔离) |
| JfrChunkWriter 变成文件格式说明书 | 解释 chunk 三段布局的 WHY: metadata offset 回填是不得已——因为 type metadata 动态生成，在 chunk 开始时无法预知其大小 |
| 忽略 `RotationLock` 的递归防护 | 必须独立小节分析 `try_set()` CAS 锁 (jfrRecorderService.cpp:59-74) — 为什么尝试 1000 次、为什么 JavaThread sleep 而非 spin、为什么显式拒绝递归 |
| 省略 VM Error 路径 | 必须单独章节分析 emergency dump 的信号安全约束：只能用 write(2)，不能用 malloc，必须预计算路径 |
| StringPool 变成 hash 表实现手册 | 必须解释去重的 WHY：JFR chunk 中字符串占据 30-40% 空间（类名/方法名/文件名），去重后压缩到 ~5%。成本：CAS probe vs mutex 的吞吐差异 |

---

## §七 Output Format

- 标题: `# 00-JFR-Recorder-Engine — 记录引擎核心管道`
- 每节用 `## §X Title` 格式
- 技术断言标注 `file:line` 引用（3 位精确行号，如 `jfrRecorderService.cpp:218-234`）
- 源码代码块使用 fence + 语言标注 `cpp`
- Mermaid 图用于：JfrStorage 4 层空间流、chunk rotation 时序图、JfrBuffer _pos/_top 并发模型
- Counterfactual 使用 `> **Counterfactual** — 如果...则会...` 格式
- Callout 框使用 `> **Beginner Callout N —**` 格式

---

## §八 Prohibited（≥8）

1. **不要源码翻译**：源码作为证据（20%），原理分析是正文（80%）
2. **不要忽略 `JfrMemorySpace` 模板**：它是 5 个子系统复用的基础设施，必须单独章节分析模板策略参数
3. **不要省略 `write_safepoint_types()` 的 safepoint 必要性**：必须解释为什么某些类型只能在 safepoint 内序列化
4. **不要跳过大事件(big event)的 `flush_large()` 路径**：它与 `flush_regular()` 有根本不同的 buffer 框架
5. **不要忽略 VM Error emergency dump 的信号安全约束**：独立章节
6. **不要把 `jfrStringPool` 和 `jfrStackTraceRepository` 混为一谈**：两者去重机制不同（CAS hash vs frame compare）
7. **不要省略 `RotationLock` 的 try_set 重试策略**：必须分析 1000 次重试 + JavaThread sleep 的 WHY
8. **不要忘记 PostBox 消息机制**：recorder thread 不是忙等的，必须解释 mailbox + semaphore 通信
9. **不要写成 API reference**：不要列出每个函数的声明，要解释为什么这些函数存在、它们如何协作
10. **不要忽略 chunk rotation 的 in_memory vs disk 分支**：两者有根本不同的序列化路径

---

## §九 Required（≥8）

1. **Mermaid 序列图**：chunk rotation 全过程（JfrRecorderThread → JfrRecorderService → JfrStorage → JfrChunkWriter → safepoint VMOperation）至少 6 lanes
2. **JfrRecorderService::rotate() 完整源码走读**（jfrRecorderService.cpp 中 rotate() 定义 ±10 行上下文）
3. **JfrBuffer::acquire()/release() 源码解释**（jfrBuffer.cpp 中的 CAS 实现）
4. **JfrStorage::flush_regular() 路径分析**（jfrStorage.cpp 中 buffer 获取 + move + register_full 流程）
5. **JfrChunkWriter::write_header() 源码**（chunk header 的每个 field 含义）
6. **7 个 Beginner Callout**（已在 §一 定义）必须有精确对应的文档位置
7. **Interview Story-style 答案**：§四 每组深度问题必须有清晰的结构化答案
8. **独立 Counterfactual 对比表**（§十四）：3 列（设计决策 / 当前实现 / 如果相反）
9. **string_id dedup 机制解释**：StringPool 去重如何减少 chunk 大小（含定量数据）
10. **紧急 dump vs 正常 rotation 的路径对比表**

---

## §十 GDB Verification（≥7 assertions）

```gdb
# 1. 检查 JfrRecorder 是否已创建
(gdb) p JfrRecorder::is_created()
(gdb) 预期: true

# 2. 检查 JfrStorage global buffer 状态
(gdb) p JfrStorage::instance()._global_mspace->full_list_size()
(gdb) 预期: < 100 (正常录音中), > 1000 (buffer 堆积时)

# 3. 检查 RotationLock 状态
(gdb) p (void*)rotation_thread
(gdb) 预期: NULL (无旋转进行中), 非 NULL (旋转进行中的线程)

# 4. 检查 JfrChunkWriter 是否打开
(gdb) p JfrRecorderService::is_recording()
(gdb) 预期: true

# 5. 触发一次 manual rotation 并设断点
(gdb) b JfrRecorderService::safepoint_write
(gdb) c
# 然后在另一个终端: jcmd <pid> JFR.rotate
# 预期: GDB 中断在 safepoint_write()

# 6. 检查 checkpoint epoch 状态
(gdb) p JfrCheckpointManager::instance()._checkpoint_epoch_state
(gdb) 预期: 0 或 1

# 7. 检查 StringPool 去重率
(gdb) p JfrStringPool::instance()._pool.stats()
(gdb) # 观察 dedup_rate = (total_attempts - total_added) / total_attempts

# 8. 验证 RotationLock CAS 行为
(gdb) b jfrRecorderService.cpp:108 if i == 999  # 1000 次重试的最后一次
(gdb) c
# 预期: 极少触发 — 只在 2+ 线程并发 rotation 时

# 9. 检查 buffer 的 _pos/_top 关系
(gdb) p *(JfrBuffer*)0x7f...  # 任意 buffer 地址
(gdb) p $1._pos >= $1._top
(gdb) 预期: true (pos 永远 ≥ top)
```

---

## §十一 与 README 和同组 prompt 的连续性

### 与 README 关系
- README §二 将 Recorder Engine 列为 doc-00，本文档对应
- 覆盖 README 中指定的子目录：recorder/service + recorder/storage + recorder/repository + recorder/checkpoint + recorder/stacktrace + recorder/stringpool

### 与 prompt-01 (Event System) 关系
- doc-00 覆盖事件的**存储和写出**（buffer → chunk file）
- prompt-01 覆盖事件的**生成和提交**（Java Event → JNI → C++ EventWriter → buffer）
- 边界：`JfrStorage::acquire_thread_local()` 是两篇的交接点——doc-00 讲 buffer 管理侧，prompt-01 讲 event write 侧

### 与 prompt-02 (Leak Profiler) 关系
- doc-00 不涉及 leakprofiler/ 子目录
- JfrRecorderService 的 `process_full_buffers()` 中被 Leak Profiler 注册为 listener — 在 prompt-02 中展开

---

## §十二 进阶验证 — strace / jcmd / jstack 诊断命令

文档 §十五 必须包含以下完整诊断流程（不是片段）：

```bash
# === strace: 观察 chunk 写入的 write(2) 调用 ===
# 启动 JFR 录音: java -XX:StartFlightRecording=filename=test.jfr ...
strace -e trace=write,open,close,ftruncate,rename -p $(pgrep -f "java.*JFR") \
  -o jfr_strace.log &
# 触发 rotation: jcmd <pid> JFR.rotate
# 检查 strace 输出:
grep "write(" jfr_strace.log | wc -l  # 应该 > 0
grep "ftruncate(" jfr_strace.log       # 应该有 1 行（每个 chunk）
grep "rename(" jfr_strace.log          # chunk rotation 后应该有

# === jcmd: 验证 JFR 状态 ===
jcmd <pid> JFR.check             # 是否正在录音
jcmd <pid> JFR.rotate            # 手动触发 rotation
jcmd <pid> JFR.dump filename=dump.jfr  # dump 当前 recording

# === jstack: recorder thread 状态 ===
jstack <pid> | grep -A 5 "JFR Recorder"  # 查看 recorder thread
# 正常状态: TIMED_WAITING (parking) — 等待 PostBox 消息
# 异常状态: RUNNABLE — 在 safepoint 中写入（chunk rotation 中）
# BLOCKED — 等待 RotationLock (2+ 线程争用)

# === GDB: 检查 PostBox 消息队列 ===
(gdb) p JfrPostBox::instance()._messages[0]
(gdb) # 预期: MSG_ROTATE / MSG_STOP / MSG_FLUSHPOINT / MSG_FULLBUFFER
```

---

## §十三 质量锚点参考

本文档写作质量对标：
- `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md` (结构模板)
- `probe_md/23-logging/prompts/prompt-00-Tag-Level-Selection-Configuration.md` (同级 Phase 参考)
- `probe_md/24-utilities/prompts/prompt-00-Core-Containers-Concurrent.md` (最新 Phase 质量)

**关键提醒**: JFR 文档容易陷入"缓冲区实现细节"的泥潭——必须时刻回答 WHY（为什么这样设计 buffer？为什么分 4 层？为什么 checkpoint 跟 event 交错写？），而非 HOW（怎么移动 _pos 指针）。每个 section 的第一段必须是设计意图声明，然后才是实现细节。
