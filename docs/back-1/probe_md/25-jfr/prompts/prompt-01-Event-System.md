# prompt-01 — Event System: JNI 桥接 + EventWriter 模板 + 周期事件 + DCMD

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1 — JFR 不记录任何事件**。线上 `-XX:StartFlightRecording=filename=rec.jfr` 配置后 `.jfr` 文件为空。三步诊断：
1. `jcmd <pid> VM.jfr check` → 输出 running, chunk size=0 → 事件未提交到 buffer
2. `jcmd <pid> VM.jfr dump` → 空 chunk → JfrRecorder::start_recording() 成功但无 Commit
3. `strace -e trace=futex -p <pid>` → 无 writer thread futex 等待 → JNI 桥接未初始化

**场景 2 — ThreadLocal buffer 泄漏**。记录 48h 后 JFR 的 `mem(Java Heap)` 增长 800MB。`jcmd <pid> VM.native_memory detail` 显示 `Thread::_jfr_thread_local` malloc 未释放 → shelved_buffer 未归还全局池。诊断：`jfr_flush` 只 flush 不 reclaim，`rotate` 才触发全局回收。

**场景 3 — 周期事件时间漂移**。CPU load 事件在 60s 周期上报告 59.7s-61.3s 漂移。`jfrThreadCPULoadEvent.cpp` → `JfrOSInterface::cpu_load_total_process()` 调用 `/proc/stat` → 读取间隔不稳定。Counterfactual：如果周期调度用 CLOCK_MONOTONIC 而非 `javaTimeMillis()`？

---

## §一 Task + Narrative + Beginner Callouts

**任务**：分析 JFR Event System 从 Java `Event.commit()` 到 C++ buffer 的完整路径，覆盖：
1. JNI 桥接 — `jdk.jfr.internal.JVM` 的 native 方法如何分派到 jfrJniMethod.cpp
2. EventWriter 模板体系 — 类型安全的 struct → buffer offset 写出
3. 周期事件调度 — PeriodicType 注册 → JfrPeriodicEventSet 定时触发
4. JfrThreadLocal — per-thread buffer 管理 + shelve 机制
5. DCMD 命令 — `VM.jfr` 的 7 个子命令实现

**叙事线索**：从一行 `EventThreadSleep.commit()` Java 代码出发，追踪 JNI→EventWriter→buffer→Storage 的 12 步调用链。

**7 个 Beginner Callout 框**：（必须在 §一 中 inline `> **` 块引用格式）
1. **JFR JNI 不进入 safepoint**：jfrJniMethod.cpp 的 `NO_TRANSITION` 宏保持 `_thread_in_native`，避免 safepoint 开销
2. **EventWriter 模板不是运行时多态**：每个 event type 编译期生成完整的 struct→buffer 写入代码，零虚函数调用
3. **ThreadLocal buffer 不是 free 的**：java_buffer 默认 256KB，JFR 开/关期间每个 Java 线程都在 Thread 对象头部持有一个
4. **StackEventWriterHost 的 RAII 语义**：构造时自动 begin_event_write()，析构时自动 commit()，异常安全
5. **周期事件注册是编译期的**：`jfrfiles/jfrPeriodic.hpp` 由 metadata.xml 生成，运行时不动态注册
6. **jfr_emit_event 不是"事件提交"**：它是请求周期引擎触发事件，不是直接向 buffer 写数据
7. **jfr_set_enabled 有 GC 危险**：line 106-110 设置 `EventOldObjectSample` 的 enabled flag 后立即 `ThreadInVMfromNative transition` → 触发 LeakProfiler::start() 的 safepoint

---

## §二 Standard Environment

### Source Roots
```
make/hotspot/lib/CompileJvm.gmk:153 — BUILD_LIBJVM (JFR 通过 --with-jfr 控制编译)
```

### Build
```bash
bash configure --with-jfr --with-debug-level=slowdebug
make jdk
```

### Binary
```
build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so
```

### Syscall 速查表
| Syscall | man | 用途 | JFR 使用位置 |
|---------|-----|------|-------------|
| futex(2) | man 2 futex | 线程唤醒 | JfrJavaEventWriter::notify() → pthread_cond_signal |
| clock_gettime(2) | man 2 clock_gettime | 纳秒时间戳 | JfrTicks::now() |
| write(2) | man 2 write | 文件输出 | JfrChunkWriter (通过 chunk 路径) |
| mmap(2) | man 2 mmap | Buffer 分配 | JfrStorage |

### 全局状态表
| 变量 | 类型 | 文件 | 说明 |
|------|------|------|------|
| JfrRecorder::_state | volatile int | jfrRecorderService.cpp | NEW→CREATED→RUNNING→CLOSED |
| JfrThreadLocal::_native_buffer | JfrBuffer* | jfrThreadLocal.hpp:40 | per-thread native event buffer |
| JfrThreadLocal::_java_buffer | JfrBuffer* | jfrThreadLocal.hpp:39 | per-thread Java event buffer |
| JfrThreadLocal::_shelved_buffer | JfrBuffer* | jfrThreadLocal.hpp:41 | 已置换 buffer (待归还) |
| JfrEventSetting::_enabled | BitMap | jfrEventSetting.hpp | per-event-type 启用标志 |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Functions / Classes | Role |
|------|-----------|:---:|---------------------------|------|
| jfrEvents.hpp | jfr/jfrEvents.hpp | 35 | #include jfrEventClasses.hpp, jfrEventIds.hpp | 事件头文件门面 |
| jfrJniMethod.cpp | jfr/jni/jfrJniMethod.cpp | 312 | jfr_create_jfr/begin_recording/end_recording/emit_event/set_enabled... | JNI 桥接实现 |
| jfrJniMethodRegistration.hpp | jfr/jni/jfrJniMethodRegistration.hpp | ~50 | JfrJniMethodRegistration | JNI 方法注册 |
| jfrJavaEventWriter.hpp | jfr/writers/jfrJavaEventWriter.hpp | 50 | JfrJavaEventWriter | Java 侧事件写出器 |
| jfrJavaEventWriter.cpp | jfr/writers/jfrJavaEventWriter.cpp | ~300 | notify()/flush()/new_event_writer() | 事件写出器实现 |
| jfrEventWriterHost.hpp | jfr/writers/jfrEventWriterHost.hpp | 51 | EventWriterHost / StackEventWriterHost | 事件写出器模板 |
| jfrEventWriterHost.inline.hpp | jfr/writers/jfrEventWriterHost.inline.hpp | ~200 | begin_write()/end_write()/begin_event_write()/end_event_write() | 写出器内联实现 |
| jfrWriterHost.hpp | jfr/writers/jfrWriterHost.hpp | ~100 | WriterHost | 基础写出器框架 |
| jfrWriterHost.inline.hpp | jfr/writers/jfrWriterHost.inline.hpp | ~300 | write()/flush() 实现 | 写出器基类实现 |
| jfrThreadLocal.hpp | jfr/support/jfrThreadLocal.hpp | 227 | JfrThreadLocal | per-thread JFR 状态 |
| jfrThreadLocal.cpp | jfr/support/jfrThreadLocal.cpp | ~200 | install_native_buffer()/release() | buffer 管理实现 |
| jfrEventClass.hpp | jfr/support/jfrEventClass.hpp | ~150 | JfrEventClass/JfrEventClasses | 事件类注册表 |
| jfrPeriodic.cpp | jfr/periodic/jfrPeriodic.cpp | ~300 | event handlers | 周期事件调度 |
| jfrPeriodic.hpp | jfr/periodic/jfrPeriodic.hpp | ~100 | JfrPeriodicEventSet | 周期事件框架 |
| jfrThreadSampler.hpp | jfr/periodic/sampling/jfrThreadSampler.hpp | ~120 | JfrThreadSampling | 线程采样配置 |
| jfrDcmds.cpp | jfr/dcmd/jfrDcmds.cpp | ~400 | JfrDcmd::execute() | DCMD 命令实现 |
| jfrTypes.hpp | jfr/utilities/jfrTypes.hpp | ~100 | JfrEventId, traceid, u1/u4/u8 | 基础类型定义 |
| jfrEventClassIterator.hpp | jfr/utilities/jfrEventClassIterator.hpp | ~80 | JfrEventClassIterator | 事件类遍历 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 JNI 桥接的双层分派模型

① 阅读 `jfrJniMethod.cpp:60-70` 的 `NO_TRANSITION` 宏定义和 `jfr_register_natives()`。这个宏如何保持 thread 在 `_thread_in_native` 状态？与 `JVM_ENTRY_NO_ENV` 宏的 `_thread_in_vm` 过渡（line 186）有何区别？

② **Counterfactual**：如果所有 JFR JNI 都用 `JVM_ENTRY_NO_ENV`（即全部进入 VM 状态）？每次 `jfr_is_enabled()` 调用（高频 hot path）都会触发 safepoint 检查 + ThreadState 过渡，GC safepoint 下阻塞 `is_enabled` 检查会延迟所有事件提交。HotSpot 用 `NO_TRANSITION` 确保 enabled check 是 ~5 CPU cycles 的 JNI static call。

③ 为什么 `jfr_create_jfr()` 和 `jfr_begin_recording()` 用 `JVM_ENTRY_NO_ENV` 而 `jfr_is_enabled()` 用 `NO_TRANSITION`？前者需要访问 VM 内部数据结构（JfrRecorder::create() 操作 global buffer list），需要 GC 安全保证；后者仅读取 `Jfr::is_enabled()` 的 static bool，不需要 GC 安全。

④ 追踪 `jfr_set_enabled()` 中 line 106-110 的特殊路径。为什么 `EventOldObjectSample` 需要 `ThreadInVMfromNative transition`？因为 `LeakProfiler::start()` 内部需要遍历线程列表（threadSMR 迭代）→ 必须在 VM safe 状态下执行。

### 4.2 EventWriter 模板的类型安全

① 阅读 `jfrEventWriterHost.hpp:30-40` 的模板定义。`EventWriterHost<BE, IE, WriterPolicyImpl>` 的三参数模板分别控制什么？`BE` = BigEndian/SmallEndian（字节序），`IE` = Instrumentation Enabled（是否启用 BCI 插桩），`WriterPolicyImpl` = 写入策略（adaptive/growable）。

② 追踪 `begin_write()` → `end_write()` 的生命周期。它们如何通过 `WriterHost::current_pos()` 计算事件大小？`end_write()` 的 commit 语义是什么——仅仅是 commit 偏移还是也触发 flush？

③ **Counterfactual**：如果 Event 写出不用模板而用运行时 vtable 分派？每个 `write(field_name, value)` 都需要字符串→偏移映射（hash 查找）+ 虚函数调用，事件提交从 ~15ns 退化到 ~500ns。模板在编译期展开 field offset，生成连续的 buffer write 序列。

④ 阅读 `StackEventWriterHost`（line 42-49）。它的构造/析构 RAII 如何保证事件在异常路径上也正确 commit？

### 4.3 JfrJavaEventWriter 的 Java↔C++ 双向通知

① 阅读 `jfrJavaEventWriter.hpp:34-48`。`notify()` 和 `flush()` 的区别是什么？`notify()` 唤醒 Java 侧 event writer thread（通过 pthread_cond_signal），`flush()` 将 Java buffer 数据写入 C++ buffer。

② 为什么需要 `new_event_writer()`？每个 JavaThread 在第一次 JFR 使用时分配一个 JNI global ref → `JfrJavaEventWriter` 对象，绑定到 `JfrThreadLocal::_java_event_writer`。这个绑定如何避免全局竞争？

③ **Counterfactual**：如果只有一个全局 event writer 而非 per-thread？所有线程的 event commit 串行化在同一个 JNI object 上 → 锁竞争 + buffer 溢出 + GC safepoint 下的写阻塞。per-thread 设计实现完全无锁的 Java 侧 event 写入。

### 4.4 JfrThreadLocal 的三缓冲管理

① 阅读 `jfrThreadLocal.hpp:37-54` 的成员布局。三个 buffer（`_java_buffer` / `_native_buffer` / `_shelved_buffer`）的语义分别是什么？
- `_java_buffer`：Java 侧 EventStream 写入目标
- `_native_buffer`：C++ 侧 EventWriter 写入目标
- `_shelved_buffer`：已满待归还给全局池的 buffer

② solar buffer 的归还路径是什么？什么时候 `shelved_buffer` 被 reclaim 回全局池？在 `rotate` 操作中 `JfrStorage::reclaim_for_thread()` 检查是否有 shelved buffer → 归还。

③ `install_native_buffer()`（line 56）和 `install_java_buffer()`（line 57）的 lazy allocation 策略——第一次写事件时才从全局池分配 buffer，降低未使用 JFR 的线程开销。

④ **Counterfactual**：如果不用 shelve 机制而是原地覆盖满 buffer？事件丢失的数据一致性无法追踪——JFR 需要 `_data_lost` 计数器（line 45）即使有 shelve 仍然记录溢出事件数。

### 4.5 周期事件的编译期注册

① 阅读 `jfrfiles/jfrPeriodic.hpp`（由 `metadata.xml` 生成）。`JfrPeriodicEventSet::requestEvent(JfrEventId)` 如何将 Java 侧的 `jfr_emit_event` 调用映射到 C++ 的 `jfrPeriodic.cpp` 中的对应处理函数？

② 为什么周期事件用 `requestEvent` 而非直接调用？`requestEvent` 是异步语义——将事件 ID 推入 `_pending` bitfield → `JfrRecorderThread` 在下一个周期检查 bitfield → 按序执行。这避免了 Java 线程在 native→vm 过渡中阻塞周期调度。

③ **Counterfactual**：如果周期事件在 Java 线程上下文直接执行（同步语义）？每次 `jfr_emit_event` 都会有 ~10μs 的 GC/CpuLoad 数据收集 → 在 ZGC 的 mark 线程中增加不可预测的延迟。

### 4.6 DCMD VM.jfr 的 7 子命令实现

① 阅读 `jfrDcmds.cpp` 的 `JfrDcmd::execute()` 实现。`VM.jfr start/stop/dump/check/configure/list/summary` 的 7 个子命令如何路由到 JfrRecorder 的不同操作？

② `VM.jfr configure` 的 runtime 配置如何绕过 `JfrOptionSet` 的 static const 限制？`jfr_set_global_buffer_count()` → `JfrOptionSet::set_num_global_buffers()` 直接修改 global variable。

③ **Counterfactual**：如果 DCMD 通过 Java JFR MBean 而非 native 分派？DCMD 在 VM Thread 上下文执行 → 零 Java→C++ JNI 过渡开销 + 在 safepoint 期间安全操作 VM internal state。

### 4.7 metadata.xml 的事件描述符体系

① `metadata.xml` 如何定义 JFR 内置事件（~150 个）的元数据？每个 `<Event>` 元素包含 `<Name>`、`<Description>`、`<Field>`（type + name + description）、`<Transition>`（from/to 线程状态）。

② 这个 XML 如何被编译到 `jfrfiles/jfrEventClasses.hpp` 和 `jfrfiles/jfrEventIds.hpp`？构建系统（`make/jfr/`）用 Java tool `jfr-gen` 解析 XML → 生成 C++ struct + enum + visitor 模板。

③ **Counterfactual**：如果事件定义用 annotation 而非 XML？运行时反射解析 annotation → 启动慢（+500ms class scanning）+ 丢失编译期类型检查。XML 保证 JFR 关闭时零运行时开销。

### 4.8 per-thread Buffer 的 epoch 老化机制

① `JfrThreadLocal::_java_buffer` 和 `_native_buffer` 如何与 JfrStorage 的 epoch 系统交互？每个 buffer 有一个 `epoch_id`，`JfrStorage::advance_epoch()` 全局递增 epoch → 所有线程的 buffer 进入下一 epoch。

② 什么时候 buffer 被认为"full"？`end_event_write()` 检查 `used() >= capacity()` → 触发 `flush()` → 如果 full → shelve_buffer → request new buffer from global pool。

③ **Counterfactual**：如果 buffer size 固定不可配置且 epoch 用时间戳而非全局计数器？全局计数器保证所有 buffer 的 epoch 严格单调 → chunk rotation 时不会遗漏事件。时间戳受 NTP 调整影响，可能导致 epoch 回退 → 事件乱序。

### 4.9 事件类型系统的 TraceId 分配

① 阅读 `jfrTypes.hpp` 的 `traceid` typedef 和 `JfrEventId` 枚举。`traceid` 为什么是 `u8` 而非 `jlong`？JFR chunk 格式要求 trace ID 用无符号 64-bit，且 `0` 表示 null trace。

② `JfrTraceId::use(jclass)` 的 assign-on-first-use 策略：第一次遇到一个类的 event 时分配 traceid → 写入 `klass::_trace_id` 字段。如何避免多线程竞态（两个线程同时 assign 同一个 class）？CAS on klass::_trace_id。

③ **Counterfactual**：如果 traceid 用 sequential counter 而非 klass-based？所有 Java 类型退化为单一 integer ID → 丢失类层次信息 + 无法支持 JDK Flight Recorder 的类型系统查询 API。

---

## §五 Article Structure

```
# 01-Event System — JNI 桥接、EventWriter 模板、周期事件、DCMD

## §〇 生产场景（3 场景）
## §一 Event System 架构全景 — 从 Java Event 到 JFR Chunk 的 12 步调用链
### 1.1 三层分派模型 (Java Event → JNI Bridge → C++ Writer)
### 1.2 JNI 桥接层源码 (NO_TRANSITION vs JVM_ENTRY_NO_ENV)
### 1.3 JfrJavaEventWriter: Java event buffer 的生命周期
### 1.4 EventWriterHost 模板体系 (Begin/End write 的 commit 语义)
### 1.5 StackEventWriterHost RAII (构造/析构自动管理)
### 1.6 JfrThreadLocal: 三缓冲管理 (java/native/shelved)
### 1.7 周期事件调度: JfrPeriodicEventSet + jfr_emit_event
### 1.8 DCMD VM.jfr: 7 子命令的 native 分派
### 1.9 metadata.xml → jfrfiles: 编译期事件代码生成
### 1.10 Interview Story: 追踪一次 CPU 负载周期事件

## §二 Source Files Table & Standard Environment
### 2.1 Source Files Table（18 文件、~4,500 行）
### 2.2 Standard Environment（gmk:153 + build + binary）
### 2.3 Syscall 速查表（5 条目）
### 2.4 全局状态表（5 变量）

## §三 EventWriter 模板体系深度剖析
### 3.1 WriterHost<BE, IE, WriterPolicyImpl> 基类
### 3.2 EventWriterHost 的事件级 commit
### 3.3 write() 的 buffer boundary 检查和扩容策略
### 3.4 每个 event struct 的编译期 offset 展开

## §四 JNI 桥接全链路
### 4.1 jfrJniMethod.cpp 的 25 个 native 方法全景
### 4.2 jfr_create_jfr / jfr_destroy_jfr: Recorder 生命周期
### 4.3 jfr_begin_recording / jfr_end_recording: 录制启停
### 4.4 jfr_set_enabled: EventOldObjectSample 的特殊路径
### 4.5 jfr_emit_event: 周期事件异步请求

## §五 JfrThreadLocal 内存布局与 Buffer 管理
### 5.1 18 个成员字段的字节级偏移
### 5.2 java_buffer / native_buffer / shelved_buffer 三态模型
### 5.3 buffer epoch 老化与旋转
### 5.4 stackframes 的 lazy allocation

## §六 周期事件与 Thread Sampling
### 6.1 JfrPeriodicEventSet 的注册与分派
### 6.2 JfrThreadSampling 的 java/native 双模式
### 6.3 线程 CPU 负载事件的 /proc/stat 实现

## §七 DCMD + metadata.xml
### 7.1 VM.jfr 7 子命令到 JfrRecorder 操作的路由
### 7.2 metadata.xml 的 compile-time 代码生成
### 7.3 jfrfiles 生成产物 (EventClass/EventId/Periodic)

## §八 💡 7 个 Beginner Callout 框

## §九 边缘场景 & 竞态
### 9.1 jfr_flush 缓冲区溢出丢失 (data_lost 计数器)
### 9.2 StackEventWriterHost 析构中抛异常
### 9.3 LeakProfiler::start() 在 safepoint 期间被 jfr_set_enabled 触发
### 9.4 周期事件在 chunk rotation 期间的竞态

## §十 GDB 断点验证 + strace/jstack 诊断
## §十一 "不要写成→应该写成" 对照表
## §十二 Cross-Reference
```

---

## §六 Writing Requirements

### 源码 vs 原理
- 源码证据占 20%，原理分析占 80%
- 每个函数解释 WHY 而非 HOW
- 每个设计决策必须有反事实对比

### "不要写成→应该写成" 对照表

| 不要写成 | 应该写成 |
|---------|---------|
| 列出 `NO_TRANSITION` 宏的机械展开 | 解释为什么双重分派（NO_TRANSITION vs JVM_ENTRY_NO_ENV）是性能关键：hot path enabled check 不能触发 safepoint，但 create/destroy 需要 VM safe。用 `timespec` benchmark 量化两个路径的差异 (`jfrJniMethod.cpp:60-70` + `:186-197`) |
| 逐个枚举 jfrJniMethod.cpp 的 30 个 JNI 函数 | 按功能分 4 组（Recorder 生命周期 / Event 提交 / 配置 / 诊断），每组解释一个统一的 JNI 约定 + 反事实 |
| 列出 EventWriterHost 三个模板参数的组合 | 解释模板参数如何导致编译期代码生成：每个 event type 生成一个 fully instantiated EventWriter → 零虚函数 + 零字符串 desc → ~15ns per event commit. 对比运行时反射方案的 ~500ns |
| 描述 JfrThreadLocal 18 个字段的 getter/setter | 按语义分 5 组（buffer 管理 / trace identity / 时间 / 阻塞 / 引用），解释三缓冲的完整生命周期 state machine + 何时 install/shelve/reclaim |
| 列举 metadata.xml 的 XML schema 结构 | 解释 XML → jfrfiles C++ 代码生成的构建管道 (jfr-gen tool) + 为什么编译期生成而非运行时解析 + 启动性能对比 |
| 转述 VM.jfr 命令行帮助 | 构建 7 子命令到内部 API 的映射表 + 解释 DCMD 在 VM Thread 上下文执行的安全保证 |
| 列出每个周期事件的文件路径 | 解释周期事件框架的 request/emit 异步模型 + 为什么在 JfrRecorderThread 而非 Java 线程上下文执行 |
| 机械化走读 EventWriter 的 write/flush 循环 | 解释 buffer boundary check 的三层 (position + size + epoch) + 扩容决策 (realloc vs global buffer request) |

### Mermaid 要求
- 1 张 5-lane 序列图：Java Event.commit() → JNI jfr_emit_event → JfrJavaEventWriter::flush() → JfrStorage::write() → JfrChunkWriter
- 1 张事件类型系统类图：metadata.xml → jfr-gen → jfrEventClasses.hpp/.cpp ↔ JfrEventClassIterator

---

## §七 Output Format

- 标题格式：`# 01-Event System — 事件写出、JNI 桥接、周期事件、DCMD`
- 每个技术断言标注 `file:line`
- 代码引用格式：```cpp （文件名:行号）
- Beginner Callout：`> **Callout N — 标题**：...`
- Counterfactual：`> **Counterfactual** — 如果...则会...`

---

## §八 Prohibited（≥8 条）

1. 不要把 `jfrJniMethod.cpp` 写成逐个函数的 JNI 注释翻译——按 Recorder/Event/Config/Diag 四组整合分析
2. 不要忽略 `NO_TRANSITION` vs `JVM_ENTRY_NO_ENV` 的 ThreadState 差异——必须用 counterfactual 量化 hot path 影响
3. 不要只列 metadata.xml 的 XML 结构而不解释 jfr-gen 代码生成管道
4. 不要忽略 JfrThreadLocal 的三缓冲状态机——必须画完整的状态转换图
5. 不要忘记 jfr_set_enabled 的 EventOldObjectSample 特殊路径（line 106-110）
6. 不要缺失 Source Files Table
7. 不要缺失 Standard Environment 节
8. 不要漏掉 strace/jstack 诊断工具
9. 不要将 per-thread buffer 写成 static global——解释 thread-local 的无锁动机
10. 不要忽略 StackEventWriterHost 的 RAII 异常安全

---

## §九 Required（≥8 条）

1. ★ 每个技术断言标注精确的 `file:line`
2. ★ Mermaid 序列图：Java Event.commit() → chunk write 全链路 5 lanes
3. ★ EventWriter 模板的编译期展开机制：用源码片段展示每个 event type 的 struct field → buffer offset 映射
4. ★ JNI 桥接的双层分派对比表（NO_TRANSITION / JVM_ENTRY_NO_ENV / Transition 完全版）
5. ★ JfrThreadLocal 的三缓冲状态图
6. ★ metadata.xml → jfr-gen → jfrfiles 的代码生成管道
7. ★ 周期事件 request/emit 异步模型
8. ★ 8. 7 个 Beginner Callout 框 (在 §一 内 inline)
9. ★ 9. Interview Story：追踪一次 GC 事件的完整提交过程
10. ★ 10. Counterfactual 表：≥3 个独立 Counterfactual 框
11. ★ "不要写成→应该写成" 对照表 ≥8 行
12. ★ GDB 验证 ≥7 断言

---

## §十 GDB Verification（≥7 个断言）

加载 libjvm.so 带调试符号：
```
gdb -p <pid>
(gdb) p Jfr::is_enabled()  → 验证 JFR 是否开启
```

1. `(gdb) p JfrRecorder::_state` — 验证 Recorder 状态（NEW=0, CREATED=1, RUNNING=2）
2. `(gdb) p *(JfrThreadLocal*)((char*)thread + ByteSize(JfrThreadLocal::java_buffer_offset()))` — 验证 per-thread buffer 地址非 NULL
3. `(gdb) p ((JfrBuffer*)buffer)->_pos` — 验证 buffer 当前写入位置
4. `(gdb) call JfrPeriodicEventSet::requestEvent((JfrEventId)0)` — 验证周期事件请求不崩溃
5. `(gdb) p JfrOptionSet::num_global_buffers()` — 验证 global buffer 数量配置
6. `(gdb) p JfrEventSetting::_enabled.size()` — 验证 enabled events 数量
7. `(gdb) p sizeof(JfrThreadLocal)` — 验证 per-thread 开销（约 128 bytes）
8. `(gdb) p JfrEventClasses::unloaded_event_classes_count()` — 验证已卸载类的事件计数
9. `(gdb) call JfrThreadSampling::set_java_sample_interval(1000)` — 验证线程采样间隔修改

**strace**：
```bash
# 跟踪 JNI 调用中的 futex(2)（JfrJavaEventWriter notify）
strace -e trace=futex -p $(pgrep -f java) 2>&1 | grep -E "FUTEX_WAKE"
# 验证 JFR ON 时 writer thread 的 pthread_cond_signal 频率
```

**jstack**：
```bash
# 确认 JFR Recorder Thread 的 run() 状态
jstack <pid> | grep -A 3 "JFR Recorder Thread"
```

---

## §十一 与 README 和同组 prompt 的连续性

- **前置文档**：prompt-00 (Recorder Engine) — 提供 JfrBuffer/JfrStorage/JfrChunkWriter 的下层知识。本文档的 EventWriter 写入的 buffer 由 prompt-00 的 JfrStorage 分配管理
- **后置文档**：prompt-02 (Leak Profiler) — 使用本文档的 Event 模型写入 `EventOldObjectSample` 和 `EventObjectAllocationSample`
- **README 关联**：本文覆盖 README §一 架构图中的 "Event System (68 files, ~12K lines)"
- **边界**：不深入分析 `JfrBuffer` 的环形缓冲实现（那是 prompt-00 的范围），但解释 `end_event_write()` 如何触发 buffer check
