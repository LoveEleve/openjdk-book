# 04. 信号里不能 malloc，采样数据放哪？——无锁存储、调用栈去重与溢出

> **前置依赖**：[01 —— 寄存器访问与安全行走](./01-register-walking.md)、[03 —— FrameName 与 Java 方法命名](./03-frame-naming.md)
> → **后续**：AP-5 输出格式（flamegraph、collapsed、JFR、OTLP 各自消费 `CallTraceStorage` 中的栈身份）
>
> 场景：采样信号里不能随便调用 malloc，但每次采样又要保存一组调用帧，还要在有限内存下继续运行。
>
> 本篇基于当前 async-profiler 源码，重点讨论 Linux 实现。本文不把某个 HotSpot JDK/GC 版本的内部布局当成通用规范；重点对象 `ASGCT_CallFrame`、存储表和 allocator 的行为，是当前 async-profiler 代码中的实现事实。这里讲的是采样数据已经被组织成 `ASGCT_CallFrame` 之后，如何在并发采样、信号上下文和有限内存下保存它；不把它外推成所有平台或所有 JVM 的统一实现。

## 先把问题说尖锐：每次采样都要保存栈，但信号里不能随便分配

一次采样得到的不是一个可以直接展示的字符串，而是一组 `ASGCT_CallFrame`。每个元素包含 `bci` 和 `method_id`；其中 `method_id` 既可能是 `jmethodID`，也可能按照 `BCI_*` 约定表示 native 地址、线程号、错误字符串、CPU 或事件对象类型（`src/vmEntry.h:41-76`）。调用栈还可能包含 Java、JIT、VM 和 native 帧。

`Profiler::recordSample()` 先把这些帧写入按并发槽复用的临时缓冲区，再交给 `_call_trace_storage.put()` 保存（`src/profiler.cpp:421-488`）。问题在于，这条路径通常由异步信号触发：如果这里直接调用普通 `malloc`，分配器内部锁可能与被中断线程持有的锁形成死锁；如果调用复杂的 C/C++ 容器，也可能触发不可重入代码。

直觉方案有两个：第一，每个信号都 `malloc` 一块内存，写完调用栈后保存；第二，所有线程共用一个大数组，用互斥锁保护写入。前者把不安全的通用分配器放进信号热路径，后者会让采样线程在锁竞争时丢样，甚至被正在执行的线程反向阻塞。async-profiler 的答案不是“完全不分配”，而是把分配拆成两层：

```text
采样线程
  → 复用的 ASGCT_CallFrame 临时缓冲区
  → CallTraceStorage.put()
      → LongHashTable 找到/创建栈记录
      → LinearAllocator 保存唯一调用栈
  → 只在槽位中累加 samples/counter

停止或输出
  → collectSamples / collectTraces
  → FrameName 解析帧身份
  → flamegraph、collapsed、JFR 或 OTLP 消费
```

*关键设计（斜体）：* *热路径保存的是“栈身份 + 计数”，不是每次采样都复制一份完整文本；常态分配使用原子推进，边界扩容使用 async-profiler 自己可控制的 OS 分配路径。*[模式: 临时缓冲区 + 无锁索引 + 延迟格式化]

## 第一层：LinearAllocator 把“写一块新栈”变成指针推进

### 采样者真正需要的不是通用堆，而是一段可顺序消耗的空间

`CallTraceStorage` 用 `LinearAllocator` 保存 `CallTrace`。`CallTrace` 的头部只有 `num_frames`，后面紧跟可变长度的 `ASGCT_CallFrame` 数组（`src/callTraceStorage.h:18-21`）。保存时，`storeCallTrace()` 根据帧数计算总长度，从 allocator 取得一段连续内存，然后逐个复制帧（`src/callTraceStorage.cpp:203-213`）。这里没有在信号处理器中调用 `memcpy`，而是使用逐元素赋值；这正是该路径对信号上下文约束的明确回应。

```text
chunk 0: [Chunk 头][trace A][trace B][空闲区域……]
chunk 1: [Chunk 头][trace C][空闲区域………………]
                         ↑ offs
```

`LinearAllocator` 不维护任意大小的空闲块，也不做回收合并。每个 chunk 只有一个 `offs` 游标；在空间足够时，`alloc()` 读取旧偏移，并用 CAS 把它推进到 `offs + size`（`src/linearAllocator.cpp:35-51`）。成功者得到旧偏移对应的地址，失败者重新读取游标再试。

这种设计解决了普通堆分配器的两个问题：没有空闲链表和大小分类，也没有需要持有的 allocator mutex；同一个 chunk 内的分配是固定方向的 O(1) 操作。代价也很明确：单个 trace 不会释放，只有整次 recording 清理时一起回收，因此存储层必须另有内存上限。

### “无锁”不等于“没有 mmap”

构造 allocator 时，`CallTraceStorage` 使用 8 MiB 的 `CALL_TRACE_CHUNK`；`LinearAllocator` 构造函数立即申请第一个 chunk，并把 `_tail` 与 `_reserve` 指向它（`src/callTraceStorage.cpp:13-16`、`src/linearAllocator.cpp:10-14`）。真正的 Linux 分配落在 `OS::safeAlloc()`：它直接执行 mmap 系统调用，而不是经过 libc 的 malloc（`src/os_linux.cpp:323-331`）。源码明确说明裸 syscall 可以在 signal handler 内使用。

因此更准确的表述是：已经存在的 chunk 内，分配是原子游标推进；chunk 用尽或接近用尽时，才进入新的 OS 内存映射路径。不能把它写成“所有内存都在启动时一次性预分配”，也不能写成“采样过程永远不会申请新内存”。

### 为什么要提前准备下一块

如果等当前 chunk 完全耗尽才申请下一块，最后一次分配就必须在最敏感的边界上承担 mmap 延迟。`alloc()` 当游标跨过 chunk 中部时调用 `reserveChunk()`（`src/linearAllocator.cpp:39-46`）。该函数先分配新 chunk，再用 CAS 把它挂到 `_reserve`；如果另一个线程已经抢先挂上，就释放自己多申请的那块（`src/linearAllocator.cpp:67-73`）。

之后，当前 chunk 没空间时，`getNextChunk()` 把 `_reserve` 推进为 `_tail`。如果发现 `_reserve` 仍等于当前块，说明预留动作还没有完成，多个线程会竞争创建；只有 CAS 成功者成为赢家，失败者释放自己的块并使用赢家留下的预留块（`src/linearAllocator.cpp:75-102`）。这就是源码注释中“probably being allocated right now, so let's compete”的真实含义：它不是普通锁等待，而是围绕一个预留指针进行有限的 CAS 竞争。

`Chunk` 的 `offs` 后面放置 56 字节 padding，目的是避免游标与其他高频字段发生 false sharing（`src/linearAllocator.h:12-17`）。这是性能布局优化，不是内存安全边界；真正保证并发唯一性的仍是对 `offs` 和 `_reserve/_tail` 的原子操作。

## 第二层：CallTraceStorage 不重复存相同调用栈

### 先存哈希槽，再决定是否真的复制帧

如果每次采样都把完整栈追加到 allocator，即使分配安全，相同调用栈也会大量占用内存。`CallTraceStorage` 因此维护 `LongHashTable`：键是调用帧数组计算出的 64 位 hash，值是 `CallTraceSample`，其中保存 `CallTrace*`、样本数和计数器（`src/callTraceStorage.h:23-42`）。`calcHash()` 使用 MurmurHash64A 的变体对整段 `ASGCT_CallFrame` 计算 hash（`src/callTraceStorage.cpp:171-200`）。

```text
相同帧序列 A ─┐
相同帧序列 A ─┼→ 同一个 hash 槽 → 一个 CallTrace* + 累计计数
相同帧序列 A ─┘
不同帧序列 B ───────────────→ 另一个槽位
```

`put()` 的流程是：计算 hash；从当前表的 hash 槽开始探测；遇到已有同 hash 时直接复用槽位；遇到空槽时用 CAS 把空键改成 hash，再建立对应的 `CallTrace`（`src/callTraceStorage.cpp:235-290`）。已存在的栈只做 `samples` 和 `counter` 的原子累加，不重新复制帧。

这里要准确理解“去重”：当前实现主要以完整 `ASGCT_CallFrame` 序列的 hash 作为身份，并通过开放寻址处理冲突；它不是火焰图 Trie，也不是按公共前缀拆分的栈压缩。火焰图的节点合并发生在更晚的输出阶段。存储层做的是“相同完整 trace 复用”，输出层再把不同 trace 中相同的 frame 名称聚合。

### 扩容为什么不覆盖旧表

初始哈希表容量是 65536。表的占用达到容量的 75% 时，`put()` 分配容量翻倍的新表，并通过 release store 发布到 `_current_table`（`src/callTraceStorage.cpp:256-263`）。旧表通过 `_prev` 链保留。新表插入时还会尝试从前一张表找到同 hash 的 trace；如果找到，只复用旧 `CallTrace*`，否则才从 `LinearAllocator` 复制帧（`src/callTraceStorage.cpp:266-271`）。

```text
_current_table → 新表 256K → 旧表 128K → 初始表 64K
                    新写入       仍可读取
```

这是一种“发布新表、保留旧表”的并发策略：采样线程不需要搬迁旧表中的每个槽位，读写路径也不必在扩容时停顿。代价是旧表和新表会同时占用内存，所以 `_used_memory` 同时统计所有哈希表的已分配空间；`usedMemory()` 还要加上 allocator 的 chunk 空间（`src/callTraceStorage.cpp:110-118`）。

## 第三层：内存上限不是把已有记录截断，而是停止接收新栈

### `--memlimit` 的语义落点

参数解析把 `--memlimit` 的值按字节放入 `Arguments::_mem_limit`（`src/arguments.cpp:174-175`）。开始一次新的 recording 或 reset 时，`Profiler::start()` 调用 `_call_trace_storage.clear(args._mem_limit)`（`src/profiler.cpp:914-929`）。`clear()` 保留并清空当前哈希表，删除其余旧表，重置 allocator，并将限制设为指定值；如果限制为 0，则使用 `SIZE_MAX`，表示不设置这个上限。源码还额外加上最多 64 KiB 的 `LongHashTable` 头部预算（`src/callTraceStorage.cpp:13-16、99-108`）。

这意味着 memlimit 不是“到达上限时把最老数据淘汰掉”。当前实现没有 ring buffer 式的逐条淘汰；它是在 `put()` 准备占用新 hash 槽时检查 `usedMemory() > _mem_limit`。超过限制后，新的调用栈不再加入存储，而是递增 `_overflow` 并返回固定的 `OVERFLOW_TRACE_ID`（`src/callTraceStorage.cpp:244-250`）。

### overflow 是可见的降级结果

内存不足不能让采样线程继续写越界，也不能静默伪造一个普通栈。`CallTraceStorage` 定义了固定的 `_overflow_trace`，它只有一个 `BCI_ERROR` 帧，名字是 `storage_overflow`；对应 ID 是 `0x7fffffff`（`src/callTraceStorage.cpp:13-15、84`）。当采样数据被收集为 trace 时，如果 `_overflow > 0`，`collectTraces()` 会把这个哨兵 trace 放入结果映射（`src/callTraceStorage.cpp:120-141`）。

```text
新栈需要新槽位 + usedMemory > mem_limit
                ↓
       不复制 ASGCT_CallFrame
                ↓
       返回 OVERFLOW_TRACE_ID
                ↓
       输出阶段可见 storage_overflow
```

这里的“宁可标记溢出”不能理解成所有溢出样本都会自动恢复完整计数。它表示存储层用一个明确的错误身份代替无法保存的栈；具体输出格式如何读取 trace、如何呈现计数，还由对应消费者决定。

### `storeCallTrace()` 失败时并不自动转成 overflow

这里还有一个容易漏掉的边界：`OVERFLOW_TRACE_ID` 是 `usedMemory() > _mem_limit` 或哈希表探测失败时返回的显式溢出结果（`src/callTraceStorage.cpp:244-250、275-279`）；而 `storeCallTrace()` 如果因为 allocator 拿不到空间而返回 `NULL`，`put()` 当前只是把这个 `NULL` trace 写入槽位（`src/callTraceStorage.cpp:266-271`）。后续输出侧会通过 `acquireTrace() != NULL` 过滤掉这类记录（例如 `collectSamples(std::map<u64, CallTraceSample>&)` 中的判定，`src/callTraceStorage.cpp:157-169`）。

所以文章不能把“allocator 失败”和“memlimit overflow”混成同一条降级链。前者更像“槽位已经建立，但唯一 trace 没成功物化”；后者是“拒绝再接纳新的 trace 身份，并用固定 overflow ID 暴露出来”。

## 采样结束后才把身份变成人话

采样线程保存的是 `ASGCT_CallFrame`，不是 `std::string`。collapsed 和 flamegraph 输出都先调用 `collectSamples()`，拿到每个槽位的 `CallTraceSample`，再由 `FrameName` 对每一帧执行命名和过滤（`src/profiler.cpp:1254-1277、1297-1347`）。这与上一篇的边界一致：`classMap`、JVMTI 方法名、native symbol 和类型后缀在输出阶段汇合，而不是在信号上下文中完成。

不同消费者拿到的视图也不同：

- collapsed 输出按逆序帧名写成 `frame;frame count`；
- flamegraph 输出把 trace 逐帧加入 `FlameGraph` 的 Trie，再生成 HTML（`src/profiler.cpp:1310-1347`）；
- JFR 写出阶段通过 `collectTraces()` 获取带 ID 的 `CallTrace`，将帧解析成 JFR stack trace pool（`src/flightRecorder.cpp:962-984`）；
- OTLP 走 `collectSamples()`，交给 `Otlp::Recorder`（`src/profiler.cpp:1439-1445`）。

所以不能把“CallTraceStorage 去重”写成“它直接生成火焰图节点”，也不能把 JFR 的 stack-trace pool 与 flamegraph 的 Trie 混成一层。存储层提供共享的 trace 身份和计数，格式层各自消费。

## 三个容易误解的边界

**误解一：信号路径完全不能调用任何系统调用。** 当前 Linux 实现的准确说法是：避免普通 malloc 和不可控的库分配；`OS::safeAlloc()` 明确通过裸 mmap syscall 提供可用于 signal handler 的路径（`src/os_linux.cpp:323-335`）。这不是对其他平台实现的保证。

**误解二：LinearAllocator 让所有采样永远不分配。** 它只让 chunk 内的常态分配变成 CAS 推进；预留新 chunk 仍会调用 `safeAlloc`，失败时 `alloc()` 返回空指针，进而由上层进入 trace 无法保存的降级路径。

**误解三：memlimit 会删除旧样本，保持最近窗口。** 当前代码的 `clear()` 只在 recording reset 时清理；运行中超过限制时，`put()` 停止创建新的 trace 并统计 overflow，并不是按时间淘汰旧记录。

**误解四：相同 hash 就必然是相同调用栈。** `put()` 的探测逻辑按 hash 找槽，并通过 hash 表处理键冲突；源码这里没有再逐帧比较两个同 hash 序列。因此文章可以说它按 hash 复用 trace 身份，但不应把它夸成带完整逐帧碰撞校验的内容寻址存储。

## 收网：这套存储真正优化的是什么

到这里，采样存储的完整闭环可以压缩成四句话：

1. `recordSample()` 把当前调用链放入复用的 `ASGCT_CallFrame` 缓冲区，避免在信号里生成文本（`src/profiler.cpp:421-488`）。
2. `LinearAllocator` 在 chunk 内用 CAS 推进游标，只有边界处才通过 Linux 裸 syscall 获取新的映射（`src/linearAllocator.cpp:35-103`、`src/os_linux.cpp:323-335`）。
3. `CallTraceStorage` 用哈希表让相同 trace 共享一份 `CallTrace`，并把样本数、事件计数器放在槽位中原子累加（`src/callTraceStorage.cpp:235-290`）。
4. 内存预算耗尽时停止创建新 trace，用 `storage_overflow` 显式暴露降级；录制结束后，collapsed、flamegraph、JFR、OTLP 各自把轻量身份转成自己的输出结构。

*关键设计（斜体）：* *async-profiler 没有试图在信号处理器里完成“分配、命名、格式化、聚合”全部工作，而是把它们拆成：临时帧缓冲、原子存储、输出期解析和格式专属聚合。*[模式: 热路径轻量化 + 延迟物化 + 有界降级]

**本篇的一句话困惑**：信号里不能 malloc，采样栈如何保存？

**本篇的一句话顿悟**：先用可 CAS 推进的 chunk 保存唯一 trace，再用哈希槽累计计数；内存到顶时停止接收新栈并留下可识别的 overflow，而不是让采样线程失控。

AP-4 至此完成：前文解决“如何走栈、如何解析地址、如何命名帧”，本篇解决“走出来的栈如何安全保存”。下一篇进入 AP-5，观察这些 `CallTraceSample` 如何被 flamegraph 输出层重新组织成浏览器可消费的 HTML。

[跨层标注：C++ 原子 CAS 与 release/acquire；Linux `mmap/munmap` 裸 syscall；JVMTI/ASGCT 帧身份；JFR stack-trace pool；flamegraph Trie；OTLP recorder]
