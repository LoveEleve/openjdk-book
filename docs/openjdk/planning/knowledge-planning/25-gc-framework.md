# 域 25: GC Framework — 知识规划

> 源码路径: hotspot/share/gc/shared/ (156文件) + cpu/x86/gc/shared/ (6文件)
> 源码量: 184 文件 / ~37,400 行 | 🔴 巨型域（覆盖 BarrierSet/CollectedHeap/ReferenceProcessing/WorkGang/TaskQueue/CardTable/StringDedup）
>
> ⚠️ 活代码 vs 死代码: 经典代际模型 (GenCollectedHeap/generation/space/adaptiveSizePolicy ~9,500行) 在 G1-ONLY 构建中是死代码（INCLUDE_SERIALGC/INCLUDE_PARALLELGC/INCLUDE_CMSGC = 0）。知识规划以 G1-ONLY 构建为准——死代码不作为独立域，仅在需要理解 G1 设计动机时引用。

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| barrierSet.hpp + barrierSet.cpp + barrierSet.inline.hpp | **BarrierSet — GC↔Compiler 桥接根**: 三层子组件(_barrier_set_assembler/C1/C2), Name enum(ModRef/CardTableModRef/G1/Shenandoah/Z via FakeRtti), write_barrier/write_ref_array_pre/post/post_barrier, oops_do/gc_prologue/gc_epilogue, on_thread_create/destroy | High |
| access.hpp + accessBackend.hpp + accessDecorators.hpp | **Access API — 跨层 oop 访问**: Access<> 模板通过 Decorator(T_DECORATORS: IN_HEAP/IN_NATIVE/AS_RAW 等 12 种 flags+BarrierStrengthBits) 在 load/store/atomic/arraycopy 时自动注入 GC barrier。编译期为每种 BarrierSet 模板实例化→零运行时开销。三层: RawAccessBarrier→BarrierSet backend→decorator-based dispatcher | High |
| cardTable.hpp + cardTableBarrierSet.hpp + cardTable.cpp | **CardTable — 脏卡标记**: byte map(512 bytes per card=512 bytes/卡片覆盖 512×512=256KB), write_barrier 通过 `*card_addr = dirty` 标记脏卡片(不调函数——直接内存写入)。G1 和 CardTableModRef BS 共享——dirty card 标记需要扫描的跨代引用。DirtyCardQueue 批处理 write barrier | High |
| collectedHeap.hpp + collectedHeap.cpp + collectorPolicy.hpp | **CollectedHeap — 堆基类**: universe heap 单例, initialize/allocate/collect/mem_allocate/tlab_allocate, GC cause(GC_locker/jni/allocation/full_gc_*), Safepoint/GC prologue/epilogue, soft ref policy, GC overhead limit | High |
| referenceProcessor.hpp + referenceProcessor.cpp (15文件/3368行) | **ReferenceProcessor — 引用处理**: Soft/Weak/Phantom/Final 四类引用生命周期, discover_reference(存 Ref 列表), process_discovered_references(标记+清除), RefProcPhase1-4(四阶段), SoftRefLRUPolicyMSPerMB, OopStorage 存储 | High |
| workgroup.hpp + workgroup.cpp | **WorkGang — 并行 GC worker**: WorkGang(一组 GangWorker), run_task(task)→dispatch to N workers, WorkData/WaitCount 同步, WorkGangBarrierSync(barrier 同步点), task 分配到 workers via work queue | High |
| taskqueue.hpp + taskqueue.inline.hpp | **TaskQueue — 无锁工作窃取队列**: GenericTaskQueue(volatile _bottom/_age 双指针), GenericTaskQueueSet(多队列注册+steal), pop_global(pop from own), pop_local(steal from other), overflow stack(_overflow_stack 备转) | High |
| oopStorage.hpp + oopStorage.cpp | **OopStorage — 并发 oop 存储**: 无锁分配(每个 block 独立+concurrent iteration), defragment, 用于 ReferenceProcessor (discovered refs) + StringTable + JNI handles | Medium |
| stringdedup/stringDedup.hpp + stringDedupQueue + stringDedupTable | **String Dedup — 字符串去重共享层**: 共享 hash table + queue, G1/Shenandoah 各自有实现, dedup 请求→queue→deduplicate→table lookup | Medium |
| gcCause.hpp + gcId.hpp + gcTimer.hpp + gcTrace.hpp | **GC 统计与可观测性**: GCCause(G1 Evacuation/Allocation/System.gc/Metadata/... 30+ 原因), GCTimer(时间测量), GCTraceTime(RAII timer+logging), GCId(唯一 GC ID 追踪) | Low |

*10 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识 (≥5 文件)
| KP | 出现文件 |
|----|---------|
| BarrierSet + Access API (GC↔Compiler bridge) | barrierSet.*, access.*, cardTableBarrierSet.*, gc/shared/c1(barrier), gc/shared/c2(barrier) |
| CollectedHeap + allocation paths | collectedHeap.*, collectorPolicy.*, gcCause.*, tlab.*, plab.*, memAllocator.* |
| Reference Processing (4类引用) | referenceProcessor.*, oopStorage.*(存储), gc/shared/g1(消费方) |

### P2 — 局部重要 (2-4 文件)
| KP | 出现文件 |
|----|---------|
| WorkGang + TaskQueue (无锁工作窃取) | workgroup.*, taskqueue.*, gc/shared/g1(G1采用方的 GangTask) |
| CardTable 脏卡标记 | cardTable.*, cardTableBarrierSet.*, cardTableRS.* |
| String Dedup 共享层 | stringdedup/* |

### P3 — 孤立 (1-2 文件)
| KP | 文件 |
|----|------|
| GC Stats/Trace (统计+可观测) | gcCause.*, gcId.*, gcTimer.*, gcTrace.* |
| Collector Policy (旧版值存) | collectorPolicy.* (Serial/Parallel flag 检查——in this build=死代码) |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (5 KP)
| KP | 为什么 🔴 |
|----|---------|
| BarrierSet + Access<> 模板装饰器体系 | GC barrier 通过 Access<> 模板在编译期解析 Decorator flags→选择 BarrieSet 后端→生成 barrier 代码。三层: (1) RawAccessBarrier 直接访问 (2) C++ barrier 实现(card mark/SATB/G1 pre/post) (3) 汇编 barrier(assembler). 关键设计: 模板元编程让 barrier 在编译期静态分派——不是虚函数调用(virtual call)→零运行时 overhead。每个 Access<decorators>::load(addr) → 编译期展开到具体 barrier 实现 |
| ReferenceProcessor 四阶段引用处理 | Soft→Weak→Final→Phantom 处理顺序至关重要——Finalizer 可能复活对象(live again), 需要在 Phantom 之前处理。四阶段: (1) SoftRef cleanup(如果 memory pressure 高), (2) WeakRef cleanup(弱引用), (3) FinalRef enqueue(终结器), (4) PhantomRef enqueue(虚引用)。Phase1(enqueue after marking)→Phase2(find more dead)→Phase3(adjust pointers)→Phase4(iterate)"
| WorkGang + TaskQueue 无锁工作窃取 | GC 并行度核心: GenericTaskQueue 用 volatile _bottom/_age 双指针 (Arora 算法)。pop_local: 从 own queue 取任务(修改 _bottom), pop_global/steal: 从其他 worker queue 偷任务(通过 CAS on _age)。WorkGang dispatch: run_task→GangWorker::loop→while(!task.is_done)→pop/steal→execute。不需要全局锁→几乎线性扩展 |
| CardTable + DirtyCardQueue 写屏障 | `card = (address >> CardTable::card_shift) + card_table_base` → `*card = dirty`。零调用的写屏障(不存转发、不调函数)——只有 mov 指令。DirtyCardQueue 批次收集脏卡片→GC 时处理。G1 用 CardTableModRefBS——只检查 dirty cards 找到跨代引用 |
| CollectedHeap + TLAB/PLAB 分配路径 | 三层: fast path(TLAB: bump pointer alloc without lock, ~10 cycles)→medium path(PLAB: promotion local allocation buffer, for survivor→old copy)→slow path(global allocation: CAS+mutex via CollectorPolicy)。每个分配路径由 BarrierSet 自动注入 GC barrier |

### 🟡 Working — 有设计但非核心 (3 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| OopStorage 并发 oop 存储 | 无锁 block 分配+并发 iteration——支持 ReferenceProcessor/StringTable/JNIHandle 的 oop 存储 | 是一个基础设施块——理解 GC 时不需要深入其内部 |
| String Dedup 共享层 | 共享 hash table+queue——多个 GC 实现(G1/Shenandoah)共用 | 是 GC 的辅助特性——不影响 GC 核心正确性 |
| GC Stats/Trace | GCTimer/GCId/GCCause/GCTraceTime——统计+logging | 运维辅助——不影响 GC 行为 |

### 🟢 Surface — 了解即可 (2 KP)
| KP | 说明 |
|----|------|
| Dead code (GenCollectedHeap etc) | Serial/Parallel/CMS GC 的代际模型——在当前构建中为死代码 |
| CollectorPolicy | 检查并发 GC flags——在当前构建中仅检查 G1Enabled |

## 04 聚类 — 文章拆分: 6 篇

| 篇 | 标题 | 覆盖 KP | 核心问题 | 预估 |
|:--:|------|:--:|------|:--:|
| 1 | BarrierSet + Access API | BarrierSet 三层, Access<> 模板装饰器, CardTable write barrier, c1/c2 barrier 注入 | "GC 怎么在每次 oop 访问时悄悄插入 barrier？" | 核心 |
| 2 | CollectedHeap + 分配路径 | CollectedHeap 基类, TLAB/PLAB bump pointer, GC Cause, Safepoint coordination | "new Object() 从 Java 代码到 OS 内存——经过哪些层？" | 核心 |
| 3 | Reference Processing | ReferenceProcessor, 四种引用类型, SoftRef LRU, 四阶段处理 | "WeakReference 什么时候被清除？PhantomReference 什么时候 enqueue？" | 核心 |
| 4 | WorkGang + TaskQueue | GenericTaskQueue 无锁(Arora算法), WorkGang dispatch, GangWorker loop, steal | "4 个 GC worker 怎么平分扫描任务——不用锁？" | 核心 |
| 5 | CardTable + DirtyCardQueue | CardTable byte map, write barrier, DirtyCardQueue batch, CardTableRS | "一次 `obj.field = val` 在 GC 眼里怎么变成 '脏卡片'？" | 深度 |
| 6 | OopStorage + StringDedup + GC Stats | OopStorage 并发存储, String dedup table/queue, GC Tracing/Logging | "字符串去重和 GC 统计——GC 辅助设施" | 深度 |
