# G1 运行时前置知识——从 Region 角色到 GC 暂停的全景地基

> **本文定位**：桥章——连接 ch11 初始化系列（01-06）和运行时系列（08-16）。本文不讲任何具体 GC 流程细节，只搭建后续 8 篇文章共享的**全部概念砖块**。
>
> **前置依赖**：ch11/01-06（知道堆初始化建了哪些数据结构：Region/RemSet/BOT/CSet 测试位图/Mapper/写屏障/卡表）。
>
> **长度策略**：无上限——每块砖必须垒到足够坚实，后续引用时不再回头解释。
>
> **源码引用说明**：所有带行号的引用均基于 HotSpot JDK 11u 源码，已 MCP 验证。

---

## 目录

| Section | 标题 |
|---------|------|
| 1 | [Region 角色全景——G1 的"代"是标签位](#1-region-角色全景g1-的代是标签位) |
| 2 | [GC 暂停——STW / Safepoint / WorkGang](#2-gc-暂停stw--safepoint--workgang) |
| 3 | [G1 暂停类型——决策树 + GC 日志](#3-g1-暂停类型决策树--gc-日志) |
| 4 | [Evacuation——搬活不删死](#4-evacuation搬活不删死) |
| 5 | [GC Root 扫描——13 类根源](#5-gc-root-扫描13-类根源) |
| 6 | [CSet 全景——选哪些 Region 回收](#6-cset-全景选哪些-region-回收) |
| 7 | [分配与 GC 的因果链](#7-分配与-gc-的因果链) |

---

## 1. Region 角色全景——G1 的"代"是标签位

### 1.1 传统分代 GC 怎么分

传统分代 GC（Serial/Parallel/CMS）将堆**物理切割**成两块连续空间：

```
┌────────────────────────────────────────────────────────────────┐
│                      Young Generation                          │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │       Eden       │  │    Survivor      │                    │
│  └──────────────────┘  └──────────────────┘                    │
├────────────────────────────────────────────────────────────────┤
│                      Old Generation                            │
└────────────────────────────────────────────────────────────────┘

特点：Eden 和 Old 之间有固定边界。对象从 Eden 晋升到 Old 时，
      跨越物理上的"那道线"——地址从 Young 区跳到 Old 区。
```

在这种模型下，"eden collection"就是清空 Eden 这块固定大小的空间。

### 1.2 G1 怎么分——HeapRegionType 标签

G1 把堆切成等大 Region（大小由 ch11/02 的 `setup_heap_region_size` 确定）。但 Region **不按物理位置分代**——每个 Region 上的"角色"由 `HeapRegionType` 的 **Tag 位**决定：

```cpp
// src/hotspot/share/gc/g1/heapRegionType.hpp:64-91
typedef enum {
    FreeTag               = 0,     //  0b00000

    YoungMask             = 2,     //  0b00010
    EdenTag               = 2,     //  0b00010
    SurvTag               = 3,     //  0b00011

    HumongousMask         = 4,     //  0b00100
    PinnedMask            = 8,     //  0b01000
    StartsHumongousTag    = 12,    //  0b01100
    ContinuesHumongousTag = 13,    //  0b01101

    OldMask               = 16,    //  0b10000
    OldTag                = 16,    //  0b10000

    ArchiveMask           = 32     //  0b100000 (CDS)
    // OpenArchiveTag / ClosedArchiveTag = ArchiveMask | PinnedMask | OldMask +/- 1
} Tag;
```

**设计要点**：Tag 用高位区分大类、低位区分子类：

```
Tag bits:
  bit 4 (16): Old     → is_old()
  bit 3 (8):  Pinned  → is_pinned()
  bit 2 (4):  Humongous → is_humongous()
  bit 1 (2):  Young   → is_young()
  bit 0 (1):  子类型   → is_eden() vs is_survivor(), is_starts_humongous() vs is_continues_humongous()
```

**四个关键的 is_X() 方法**（heapRegionType.hpp:123-143）：

```cpp
bool is_free()      const { return get() == FreeTag; }             // 只有 0
bool is_young()     const { return (get() & YoungMask) != 0; }     // 0bxxxx1x
bool is_eden()      const { return get() == EdenTag; }             // 精确 2
bool is_survivor()  const { return get() == SurvTag; }             // 精确 3
bool is_humongous() const { return (get() & HumongousMask) != 0; } // 0bxx1xx
bool is_old()       const { return (get() & OldMask) != 0; }       // 0b1xxxx
```

这代表 G1 中"这个 Region 是什么角色"不靠地址判断——靠一条位掩码查询。同一个 Region 物理位置不变，角色改变只需要改 Tag。

### 1.3 五种核心角色详解

| 角色 | Tag 值 | 谁往里分配 | GC 行为 | 存放对象特征 | 典型数量占比 |
|------|--------|----------|--------|------------|-----------|
| **Eden** | 2 | Mutator（TLAB 慢速路径） | Young GC 全量回收——搬走活对象，整块 Region → Free | 新创建的对象 | 最多，通常 60-80% |
| **Survivor** | 3 | Young GC evacuation | 下次 Young GC 扫描——活对象晋升到 Old 或搬另一个 Survivor | 经受住 ≥1 次 GC 的对象 | 少，通常 ≤10% |
| **Old** | 16 | Survivor 晋升 / Mutator 大对象 | 不参与 Young GC。Mixed GC 或 Full GC 才回收 | 长期存活对象 | 随运行时间增长 |
| **Humongous** | 12/13 | Mutator（对象≥RegionSize/2） | Young GC 判断是否死（急切回收），否则等 Full GC | 超大对象 | 极少 |
| **Free** | 0 | 无 | 空闲，等待分配 | 空 | 堆初始化后大量，运行时动态 |

**重点**：Eden + Survivor 合起来称为 **Young Generation**（is_young() 返回 true 的 Region 集合）。但这不是一块连续空间，而是**散落在堆各处的、Tag 为 2 或 3 的 Region 集合**。

### 1.4 Region 角色变迁状态机

一个 Region 在生命周期中反复切换角色：

```
                        Young GC
    Free ──→ Eden ──────────────────→ Survivor
     ↑        │                         │
     │        │ (所有活对象搬走)           │ 年龄达到阈值 (晋升)
     │        │                         ↓
     │        │ (GC 完成)              Old
     │        │    └── 1. 复制活对象到 Survivor/Old
     │        │        2. 原 Region Tag = 0 (Free)
     │        │        3. 归还 FreeRegionList
     │        │
     │        └────────────────────→ Free
     │                                  ↑
     │                  Mixed/Full GC 后 │
     └──────────────────────────────────┘
```

**变迁路径的源码追踪**：

1. **Free → Eden**：`HeapRegionManager::allocate_free_region(is_old=false)` → `hr->set_eden()` → Tag 从 0 变 2
2. **Eden → Survivor**：GC evacuation 时 `hr->set_survivor()` → Tag 从 2 变 3
3. **Survivor → Old**：下一次 GC 晋升时 `hr->set_old()` → Tag 从 3 变 16
4. **任意角色 → Free**：GC 完成后 `hr->set_free()` → Tag 变 0，插入 `_free_list`

### 1.5 Humongous——独占 Region 的超大对象

#### 1.5.1 判定条件

```
对象大小 ≥ RegionSize / 2
```

以 8GB 堆、4MB Region 为例——超过 2MB 的对象判定为 Humongous。

`G1CollectedHeap::is_humongous(size_t word_size)` 判断逻辑（g1CollectedHeap.hpp）：

```cpp
bool is_humongous(size_t word_size) {
  return word_size > (size_t)HeapRegion::GrainWords / 2;
}
```

#### 1.5.2 双 Region 结构

Humongous 对象跨越连续的 Region：

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Start Region     │  │ Continues Rgn 1  │  │ Continues Rgn 2  │
│ Tag=12 (Start)   │  │ Tag=13 (Cont.)   │  │ Tag=13 (Cont.)   │
│ 存对象头+数据     │  │ 仅占位，无独立对象 │  │ 仅占位，无独立对象 │
│ _humongous_start │  │ _humongous_start  │  │ _humongous_start  │
│  = self          │  │  = Start Region   │  │  = Start Region   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

- **StartsHumongousTag (12)** = HumongousMask (4) | PinnedMask (8)
- **ContinuesHumongousTag (13)** = HumongousMask (4) | PinnedMask (8) + 1

每个 Continues Region 通过 `_humongous_start_region` 反向指针指向 Start Region。

#### 1.5.3 三种 GC 路径

| GC 类型 | Humongous 行为 | 条件 |
|---------|---------------|------|
| **Young GC（急切回收）** | 如果 RSet 为空（无入引用）→ 立即回收所有连续 Region | `is_humongous() && rem_set()->is_empty()` |
| **Young GC（保留）** | RSet 非空 → 标记为活，保留 | 有入引用 |
| **Full GC** | 标准标记-整理——如果死了才回收 | 堆满降级 |

急切回收的位图 `humongous_reclaim_candidates` 在 ch11/06 详细讲解。

### 1.6 FreeRegionList——空闲 Region 栈

`HeapRegionManager` 维护一个按 `hrm_index` **有序**的双向链表 `_free_list`：

```cpp
// heapRegionManager.hpp:83
FreeRegionList _free_list;

// 插入 (heapRegionManager.inline.hpp):
inline void HeapRegionManager::insert_into_free_list(HeapRegion* hr) {
  _free_list.add_ordered(hr);  // 保持 hrm_index 升序
}

// 取出分配:
HeapRegion* hr = _free_list.remove_region(is_old);
// is_old=true  → 从头部取（低地址，倾向于 old allocation 使用低地址）
// is_old=false → 从尾部取（高地址，倾向于 young allocation 使用高地址）
```

这种有序+分头尾的设计帮助堆地址保持分离：Old Region 聚在低地址，Young Region 聚在高地址。

### 1.7 读者心理模型

读完后续 08-16 时，请保持以下默认认知：

> G1 堆 = N 个等大 Region，每个 Region 上挂一个 Tag（0/2/3/12/13/16）。
> "分代"不存在物理边界——只存在"哪些 Region 当前是 Eden"的集合概念。
> Region 角色可变：Eden → Survivor → Old → Free → Eden。
> 每个 Region 独立维护自己的 RSet（ch11/06 讲的三层结构）。

---

## 2. GC 暂停——STW / Safepoint / WorkGang

### 2.1 为什么需要 Stop-The-World

GC 做三件事：**找活对象（标记）→ 搬活对象（疏散）→ 更新引用**。这三件事都要求**堆状态不变**：

| GC 操作 | 如果 mutator 不停会怎样 |
|---------|----------------------|
| 标记存活 | mutator 持续创建新对象、修改引用——标记结果永远不完整 |
| 移动对象 | mutator 正在读某个对象 → GC 搬走了 → 读到垃圾数据 |
| 更新引用 | mutator 持有旧地址 → GC 更新了一半 → 引用指向中间状态 |

**根本原因**：GC 需要"所有引用关系冻结"的瞬间快照。STW 是最简单粗暴但可靠的快照获取方式。

### 2.2 STW 的四个阶段

```
┌──── 运行中 ────┐  ┌──── 同步中 ────┐  ┌──── 已同步(GC执行) ────┐  ┌──── 恢复 ────┐
│                │  │               │  │                        │  │              │
│ Mutator 正常    │  │ 线程逐个进入   │  │ GC Worker 并行工作     │  │ 线程逐个唤醒  │
│ 执行 Java 代码  │→│ Safepoint     │→│ (标记/疏散/更新)        │→│ 恢复执行      │
│                │  │               │  │                        │  │              │
│ 时间: 无限      │  │ 时间: ms级    │  │ 时间: 暂停的目标时长    │  │ 时间: μs级   │
└────────────────┘  └───────────────┘  └────────────────────────┘  └──────────────┘
```

**关键时间指标**：
- **到达时间 (time-to-safepoint)**：从发起请求到最后一个线程停下的时间
- **暂停时间 (pause time)**：GC 实际工作时间
- 总 STW = 到达时间 + 暂停时间 + 恢复时间

G1 的优化重点在"暂停时间可控"——通过预测（`_analytics` + `_mmu_tracker`，ch11/04）限制 CSet 大小来控制 GC 工作量。

### 2.3 Safepoint 协议——线程怎么集体停下来

Safepoint 不是 OS 级别的强制挂起——是 JVM 的**协作式协议**。流程分 5 步：

#### Step 1: VM Thread 发起请求

```cpp
// safepoint.cpp — SafepointSynchronize::begin()
Threads_lock->lock();           // 获取全局线程锁
_state = _synchronizing;        // 设置状态：正在同步
_waiting_to_block = nof_threads; // 初始化等待计数器 = 活跃线程数
```

#### Step 2: Arm 所有线程的 Poll

两种 Poll 机制同时启用：

```cpp
// 2a: Thread-local poll — 每个线程有自己的轮询页
for (JavaThread *cur : all_threads) {
    SafepointMechanism::arm_local_poll(cur);
    // 设置线程本地标志 → 线程在下一个 poll 检查点读到 1
}

// 2b: Global polling page — 解释器和编译代码共用
OrderAccess::fence();                      // 内存屏障
os::make_polling_page_unreadable();        // 标记 polling page 不可读
// → 执行代码中的 test 指令读到该页 → SIGSEGV → 信号处理器 → 进入 safepoint
```

**两种 Poll 的区别**：

| | **Thread-local Poll** | **Global Polling Page** |
|---|---|---|
| 检测方式 | 读线程本地标志位 | 读全局内存页 |
| 速度 | 快（本地缓存） | 较慢（跨核访问） |
| 覆盖范围 | JIT 编译的方法 | 解释器 + 模板解释器 |
| 何时用 | `UseFastSafepoints` 开启时优先 | 始终作为兜底 |

#### Step 3: 自旋等待所有线程到达

```cpp
// safepoint.cpp — begin() 中的等待循环
while (still_running > 0) {
    for (JavaThread *cur : all_threads) {
        if (!cur->safepoint_state()->is_running()) {
            still_running--;  // 这个线程已到达
        }
    }
    if (still_running > 0) {
        // 自旋 N 次 → yield → 短暂 sleep → 回到自旋
        // 逐渐递增等待间隔，避免空转浪费 CPU
    }
}
```

#### Step 4: 所有线程等待阻塞确认

```cpp
while (_waiting_to_block > 0) {
    Safepoint_lock->wait(true);  // 等待最后一个线程确认已阻塞
}
// 此时 _waiting_to_block == 0
// _state = _synchronized
```

#### Step 5: GC 完成，恢复

```cpp
// safepoint.cpp — SafepointSynchronize::end()
os::make_polling_page_readable();  // 恢复 polling page
for (JavaThread *cur : all_threads) {
    SafepointMechanism::disarm_local_poll(cur);
}
_state = _not_synchronized;
Threads_lock->unlock();
```

### 2.4 线程的"到达点"——Safepoint 检查

线程不是在任何位置都能停下的。`_synchronizing` 状态请求后，线程在**下一个检查点**检测到请求并停下：

| 线程状态 | 检查点在哪里 | 到达 safepoint 的延迟 |
|---------|------------|---------------------|
| **运行 Java 代码** | 方法返回（`return` 指令后）、循环回边（`goto` 前） | 取决于方法大小和循环长度（最长可达数 ms） |
| **运行 native 代码** | 返回 Java 时（`JNI_CreateJavaVM` 边界） | 取决于 native 调用时长 |
| **阻塞中**（I/O、锁等待） | 被唤醒时立即检查 | 几乎为零 |
| **已停在 safepoint** | 已经是了 | 零 |

**长循环是主要延迟来源**——如果一个方法里有一个不含 safepoint 检查的紧凑循环，线程可能数毫秒都无法到达 safepoint。G1 的并发标记阶段用 `regular_clock` 主动检查就是为了避免这个问题。

### 2.5 WorkGang——GC 线程的并行框架

暂停期间，GC 工作由 **多个 GC Worker 并行执行**。`WorkGang` 是 JVM 通用的并行任务调度框架：

```
                    WorkGang
                  (线程池管理)
                       │
          ┌────────────┼────────────┐
          │            │            │
     Worker 0      Worker 1     Worker 2
          │            │            │
     ┌────┴────┐  ┌────┴────┐  ┌────┴────┐
     │ 抢任务   │  │ 抢任务   │  │ 抢任务   │
     │ 执行     │  │ 执行     │  │ 执行     │
     │ 抢新任务 │  │ 抢新任务 │  │ 抢新任务 │
     └─────────┘  └─────────┘  └─────────┘
          ↑            ↑            ↑
          └────────────┴────────────┘
                工作窃取 (work stealing)
            空闲 Worker 从忙的 Worker 队列里偷任务
```

**任务分派流程**：

1. VM Thread 创建一个 `AbstractGangTask` 子类（如 `G1ParEvacuateFollowersTask`）
2. 调用 `WorkGang::run_task(task)` → 分发到所有 Worker
3. 每个 Worker 执行 `task->work(worker_id)`
4. Worker 内部：从任务队列取作业 → 执行 → 继续取 → 直到所有作业完成

**关键**：每个 Worker 的 `work(int worker_id)` 方法内部是一个"干活 + 偷活"的循环——不是"分一块干一块就结束"，而是持续竞争直到全局任务全部完成。

### 2.6 暂停 vs 并发——两个基本世界

本文后续约 40% 的篇幅在"暂停中"的场景（Young GC、Mixed GC、Remark、Cleanup），约 30% 在"并发"的场景（Concurrent Mark、Preclean）。两者有根本区别：

| | **暂停中 (STW)** | **并发中 (Concurrent)** |
|---|---|---|
| Mutator 状态 | 全部停止 | 正常运行 |
| GC 能做什么 | 移动对象、修改堆结构 | 标记、扫描、统计 |
| 安全性保证 | 天然安全——没有人修改堆 | 需要写屏障保护（SATB + 卡表） |
| 线程角色 | GC Worker 并行 | GC Thread + GC Worker 并行，mutator 穿插 |

---

## 3. G1 暂停类型——决策树 + GC 日志

### 3.1 决策树（完整版）

G1 每次 GC 暂停的类型由 `G1Policy::young_gc_pause_kind()` 决定（g1Policy.cpp:1034-1051）：

```cpp
G1Policy::PauseKind G1Policy::young_gc_pause_kind() const {
  if (collector_state()->in_initial_mark_gc())      → InitialMarkGC
  else if (collector_state()->in_young_gc_before_mixed()) → LastYoungGC
  else if (collector_state()->in_mixed_phase())          → MixedGC
  else                                                   → YoungOnlyGC
}
```

**决策树可视化**：

```
开始 GC
  │
  ├─ collector_state()->in_initial_mark_gc()?
  │   YES → InitialMarkGC (Young GC + 标记 survivor 为 root)
  │         ↑ 什么时候设这个标志？
  │           IHOP 触发 → 设置 initiation 标志 → 下次 Young GC 自动变成 Initial-mark
  │
  ├─ collector_state()->in_young_gc_before_mixed()?
  │   YES → LastYoungGC (Mixed GC 前的最后一次纯 Young GC)
  │         ↑ 保证 CSet 候选列表准备好
  │
  ├─ collector_state()->in_mixed_phase()?
  │   YES → MixedGC (回收 Eden + Survivor + 精选 Old Region)
  │
  └─ 以上全 NO → YoungOnlyGC (纯 Young GC)
```

完整 PauseKind 枚举（g1Policy.hpp:267-275）：

```cpp
enum PauseKind {
    FullGC,         // 降级兜底
    YoungOnlyGC,    // 纯 young 回收
    MixedGC,        // young + old
    LastYoungGC,    // Mixed 前的最后一次 young
    InitialMarkGC,  // young + 标记 survivor root（启动 CM）
    Cleanup,        // CM 收尾，计算 liveness
    Remark          // CM 的 STW 收尾，排空 SATB
};
```

### 3.2 YoungOnlyGC——最频繁的暂停

**触发条件**：Eden 用尽（allocation failure）

**回收对象**：CSet = 所有 Eden Region + 所有 Survivor Region（不含任何 Old Region）

**典型 GC 日志**：

```
[0.456s][info][gc] GC(3) Pause Young (G1 Evacuation Pause) 128M->64M(1024M) 8.234ms
[0.456s][info][gc,cpu] GC(3) User=0.12s Sys=0.01s Real=0.01s
```

解读：GC 编号 3，Young-only pause。堆使用量 128M→64M（总容量 1024M）。耗时 8.234ms。

**内部流程**（08 展开）：
1. CSet = 所有 Eden + Survivor
2. Root 扫描 → RSet 扫描 → 活对象疏散 → 引用更新
3. 回收所有 CSet Region → 归还 Free List

### 3.3 InitialMarkGC——带标记启动的 Young GC

**触发条件**：IHOP 阈值达到。Policy 在本次 Young GC 前设置了 `initiate_conc_mark_if_possible()` 标志。

**与 YoungOnlyGC 的唯一区别**：多扫描 survivor Region 作为 CM 的 root。其余全部相同。

**典型 GC 日志**：

```
[5.234s][info][gc] GC(42) Pause Young (Concurrent Start) (G1 Evacuation Pause) 512M->256M(1024M) 15.678ms
```

关键差异：`(Concurrent Start)` 标记——表示本次同时启动并发标记周期。

**注意**：IHOP 是什么、怎么算的——留到 15（Mixed GC）展开。这里只需知道"IHOP 阈值到了，Policy 给这次 Young GC 多安排了一个任务——标记 survivor 为 CM root"。

### 3.4 MixedGC——young + 精选 old

**触发条件**：CM 完成（14 的 Cleanup 得到 per-region liveness 后），`in_mixed_phase()` 返回 true。

**回收对象**：CSet = Eden + Survivor + 从 candidate list 精选的 Old Region。

**典型 GC 日志**：

```
[5.890s][info][gc] GC(43) Pause Young (Mixed) (G1 Evacuation Pause) 512M->384M(1024M) 22.345ms
```

`(Mixed)` 标记表示本次回收包含了 Old Region。

**分批策略**：不是一次回收全部 Old——`G1MixedGCCountTarget`（默认 8）次分批进行。每轮回收效率低的 Old Region 被放弃。

### 3.5 Full GC——兜底

**触发条件**：
- Evacuation failure 累积（promotion 空间不够）
- CM 周期失败
- 显式 `System.gc()`
- 元空间 GC 阈值

**典型 GC 日志**：

```
[12.345s][info][gc] GC(89) Pause Full (G1 Evacuation Pause) 1020M->400M(1024M) 234.567ms
```

`Pause Full`——不是 Young 也不是 Mixed。停顿时间长（几百毫秒到几秒），希望永远不会出现。

### 3.6 暂停类型频率递进

```
时间 →
|──── 启动 ────|──── 正常运行 ────|──── CM 周期 ────|──── Mixed 回收 ────|──── 正常 ────|

YoungOnly:      ██  ██  ██  ██  ██  ██  ██  ██  ██  ██
InitialMark:                                     ██
LastYoungGC:                                              ██
MixedGC:                                                       ██  ██  ██
YoungOnly:                                                                       ██  ██
```

典型频率：每 10-50 次 YoungOnly 触发 1 次 InitialMark → CM 完成 → 1 次 LastYoung → 数 次 Mixed → 回到 YoungOnly。

---

## 4. Evacuation——搬活不删死

### 4.1 为什么搬活不删死

传统 mark-sweep GC 扫描整个堆、标记活对象、清扫死对象空间。问题：

```
CMS sweep 后:
┌────────────────────────────────────┐
│ 活   │ 死(空) │ 活   │ 活   │ 死(空) │ 死(空) │ 活   │ 死(空) │
│ objA │  空洞  │ objB │ objC │  空洞  │  空洞  │ objD │  空洞  │
└────────────────────────────────────┘
         ↑                            ↑
    碎片——下次分配要遍历 free list 找合适大小的空洞

G1 evacuation 后:
原 Region ┌────────────────────┐
          │ 全空——整块归还 FreeList │
          └────────────────────┘
                                新 Region ┌────────────────────┐
                                         │ objA │ objB │ objC │ objD │
                                         └────────────────────┘
```

**根本原因：Region 是 G1 回收的粒度。** 回收一个 Region = 搬走活对象 → 整块归还 Free List。如果走 sweep 路线——Region 内的死对象空洞没法作为 Region 粒度归还。

### 4.2 三部曲

```
原位置（CSet Region 中）                   目标位置（Survivor/Old Region）
┌─────────────────────────┐              ┌─────────────────────────┐
│ Object A (原地址 &A)     │              │ Object A' (新地址 &A')   │
│ ┌─────────────────────┐ │              │ ┌─────────────────────┐ │
│ │ mark_word = 0x...01 │ │   step 1    │ │ mark_word = 0x...01 │ │
│ │ klass_ptr = 0x...   │ │  ──copy──→  │ │ klass_ptr = 0x...   │ │
│ │ field_1   = ref_B   │ │             │ │ field_1   = ref_B   │ │
│ │ field_2   = 42      │ │             │ │ field_2   = 42      │ │
│ └─────────────────────┘ │              │ └─────────────────────┘ │
│                         │              │                         │
│ step 2: mark_word       │              │                         │
│         = forwarding    │              │                         │
│         pointer to &A'  │              │                         │
│ ┌─────────────────────┐ │              │                         │
│ │ mark_word = &A'|11  │ │              │                         │
│ │ (原内容暂存到        │ │              │                         │
│ │  PreservedMark 栈)   │ │              │                         │
│ └─────────────────────┘ │              │                         │
│                         │              │                         │
│ step 3: 更新所有         │              │                         │
│ 指向 &A 的引用 → &A'     │              │                         │
└─────────────────────────┘              └─────────────────────────┘
```

#### Step 1: COPY（复制到目标位置）

GC Worker 在目标 Region 的 PLAB（或直接分配）中预留空间，memcpy 整个对象过去。新对象的 mark word 和 klass 与被搬运对象完全一致。

#### Step 2: FORWARD（写 forwarding pointer 到旧对象 mark word）

这是 evacuation 最关键的一步——Mark Word 的**双重身份**。

**2.1 Normal Mark Word 布局**（markOop.hpp）：

```
64-bit mark word 正常布局:
┌──────────────────────────────────────────────────┬───┬───┐
│   hash:31  │  age:4  │  biased:1  │  unused:25   │lock│
│            │         │            │              │ 2  │
└──────────────────────────────────────────────────┴───┴───┘

最低 2 位编码当前 lock 状态:
  00 = locked_value       — 已上锁（thin lock），前 62 位指向 LockRecord
  01 = unlocked_value     — 未锁定，正常对象头
  10 = monitor_value      — 膨胀锁（重量级），前 62 位指向 ObjectMonitor
  11 = marked_value        — GC 标记/转发状态，前 62 位是 forwarding pointer
```

**2.2 设置 forwarding pointer**（markOop.hpp:325, 356）：

```cpp
markOop set_marked() {
    return markOop((value() & ~lock_mask_in_place) | marked_value);
    // marked_value = 3 → 最低 2 位 = 11
}

inline static markOop encode_pointer_as_mark(void* p) {
    return markOop(p)->set_marked();
    // 把 p 的地址直接写入 mark word，然后设置 lock bits = 11
}
```

**2.3 原 mark word 去哪了**

Evacuation 覆盖 mark word 前，原 mark word 被保存到 `PreservedMark` 栈（09 展开）：

```
GC Worker 的 preserved mark 栈:
┌─────────────────────────┐
│ PreservedMark(&A, 原mark)│  ← push
│ PreservedMark(&B, 原mark)│
│ ...                     │
└─────────────────────────┘

最终恢复时（post-evacuation）:
  A'.set_mark(原mark)   ← 从 PreservedMark 栈中恢复
```

#### Step 3: UPDATE（更新引用）

遍历所有旧指向 &A 的引用字段，改成 &A'。

### 4.3 自愈 (Self-Healing) 引用

如果在引用更新完成前，**另一个 GC Worker 先访问了 A**：

```
Worker 1 正在搬 A，尚未更新所有引用
Worker 2 遍历某个引用 → 读到 &A
  → 读 &A.mark_word → lock bits = 11（marked）
  → 取 forwarding pointer → 得到 &A'
  → &A.mark_word 中的 forwarded pointer → 更新自己持有的引用
  → 返回 &A'
```

**自愈的含义**：被"误"访问了一次的引用被**当场修复**，后续再访问不再需要通过 forwarding pointer。

### 4.4 evac_failure——搬不走了怎么办

如果 Survivor/Old Region 空间不足，对象搬不走——这叫 evacuation failure：

```
正常:  旧对象 → 找到空间 → 复制到目标 → 旧 mark = forwarding
失败:  旧对象 → 找不到空间 → 保留在原 Region → 标记为"evac failed"
        → 原 Region 不能释放（里面还有活对象）
        → 进入 Full GC 或在下一轮 GC 重试
```

`evac_failure` 会增加 `_evacuation_failed` 计数器。累积到一定次数后触发 Full GC 降级。

### 4.5 与传统 GC 的 forwarding 对比

| GC | forwarding 编码方式 | 存储位置 |
|----|-------------------|---------|
| **G1 / Parallel / Serial** | Mark Word 最低 2 位 = 11 | 对象自身 Mark Word |
| **Shenandoah** | Brooks-style forwarding pointer | 对象头前额外 8 字节 |
| **ZGC** | Colored pointer (42 位地址 + 4 位颜色) | 指针本身 |

G1 的 forwarding 编码在 Mark Word 中，不占用额外空间——但对锁状态有要求（lock bits 必须是 01 才能覆盖，如果已经被 biased/thin-locked 需要先撤销）。

---

## 5. GC Root 扫描——13 类根源

### 5.1 可达性分析原理

GC 判断"对象是否存活"的唯一标准：**从 GC Roots 出发，沿引用链能否到达该对象**。

```
GC Roots（堆外入口）              堆内对象
──────────────────              ────────────
 thread_stack_var      ──→      Object A ──→ Object C
 JNI_GlobalRef         ──→      Object B ──→ Object D
 static_field_of_Class ──→      Object E
                                 Object F  ← 无法从任何 Root 到达 → 死
```

GC 不关心对象是否"还有用"——只关心"还能不能从 Root 走到"。

### 5.2 G1RootProcessor——13 个并行子任务

G1 的 Root 扫描由 `G1RootProcessor` 统一编排（g1RootProcessor.hpp:59-74）：

```cpp
enum G1H_process_roots_tasks {
    G1RP_PS_Universe_oops_do,            // 1. Universe 基础类型
    G1RP_PS_JNIHandles_oops_do,          // 2. JNI 全局/局部引用
    G1RP_PS_ObjectSynchronizer_oops_do,  // 3. 同步原语（wait/notify）
    G1RP_PS_Management_oops_do,          // 4. JMX/JFR 管理引用
    G1RP_PS_SystemDictionary_oops_do,    // 5. 系统字典（加载的类）
    G1RP_PS_ClassLoaderDataGraph_oops_do,// 6. 类加载器数据图
    G1RP_PS_jvmti_oops_do,              // 7. JVMTI 探针引用
    G1RP_PS_CodeCache_oops_do,          // 8. CodeCache 中的 oop 常量
    G1RP_PS_aot_oops_do,                // 9. AOT 编译缓存
    G1RP_PS_filter_satb_buffers,        // 10. SATB 缓冲过滤
    G1RP_PS_refProcessor_oops_do,       // 11. Reference 处理器
    G1RP_PS_weakProcessor_oops_do,      // 12. 弱引用处理器
    G1RP_PS_NumElements                 // 13. (计数哨兵)
};
```

**核心方法**（g1RootProcessor.hpp:130-131）：

```cpp
void evacuate_roots(G1ParScanThreadState* pss, uint worker_id);
// Young GC 时并行调用——每个 GC Worker 抢一个未处理的子任务执行
```

### 5.3 五大类根源详解

#### 5.3.1 Java 线程栈

每个 Java 线程的**所有栈帧**都是 Root：

```
Thread 1 调用栈:
┌─────────────────────────┐
│ frame 3: methodC()      │
│  local[0] → Object X    │  ← Root: 栈帧中的局部变量引用
│  local[1] → Object Y    │  ← Root
│  operand stack slot     │
├─────────────────────────┤
│ frame 2: methodB()      │
│  local[0] → Object Z    │  ← Root
├─────────────────────────┤
│ frame 1: methodA()      │
│  local[0] → args        │  ← Root
└─────────────────────────┘

GC 遍历方式: frame walk + oop map
  - oop map tells GC: "frame 3 的 rsi 寄存器、rsp+16 是引用"
  - GC follows those references to find live objects
```

**为什么要 STW**：线程栈每秒变化百万次——栈帧进出、局部变量赋值。不停下就没有稳定的"当前引用集合"。

#### 5.3.2 JNI Handles

JNI 代码通过 `JNIHandles` 持有 Java 对象引用：

| Handle 类型 | 数据结构 | 生命周期 | 是否作为 Root |
|-----------|---------|---------|-------------|
| **Local ref** | `JNIHandleBlock` 栈分配 | native 方法返回时自动释放 | ? 是（当前活跃的 JNI 调用） |
| **Global ref** | `_global_handles` 全局列表 | 显式 `DeleteGlobalRef()` | ? 是（永久性的） |
| **Weak global ref** | `_weak_global_handles` | 可被 GC 清除 | ?? 弱引用（不阻止回收） |

扫描 JNI handles 就是遍历当前活跃的 `JNIHandleBlock` 链表——`G1RP_PS_JNIHandles_oops_do` 子任务。

#### 5.3.3 系统类（SystemDictionary / Universe）

| 机构 | 包含什么 | 为什么是 Root |
|------|---------|-------------|
| **SystemDictionary** | 所有已加载的 Java 类（`Class` 对象）+ 它们的静态字段 | 静态字段引用必须被视为 Root |
| **Universe** | JVM 基础类型（`java.lang.Class` 的 mirror、基本类型数组类等） | 基础类型的 class 对象必须存活 |
| **ClassLoaderDataGraph** | 类加载器之间的父子关系 + 每个 CLD 的已加载类列表 | 类卸载需要它来判断哪些 CLD 可以回收 |

**典型 Root 示例**：

```java
class MyService {
    static final Cache GLOBAL_CACHE = new Cache();  // ← Root!
    // GLOBAL_CACHE 存在 SystemDictionary 的 MyService 类镜像中
    // 它是 GC Root → 它引用的所有对象都不会被回收
}
```

#### 5.3.4 CodeCache

JIT 编译后的机器码中嵌入了**不可变的对象引用**——编译时常量、类指针、方法指针：

```cpp
// 编译后机器码中的 "mov reg, 0x...object_address" 指令
// 嵌在 CodeBlob 中的 oop 常量 → 作为 GC Root
```

`G1RP_PS_CodeCache_oops_do` 遍历所有 `nmethod` 中的 oop map 找这些嵌入引用。

#### 5.3.5 StringTable / 其他表

| 表 | 内容 | 为什么是 Root |
|----|------|-------------|
| **StringTable** | `String.intern()` 的字符串 | 已 intern 的字符串必须存活 |
| **ResolvedMethodTable** | 已解析的方法引用缓存 | 缓存条目可能被类引用 |
| **ProtectionDomainCache** | 保护域缓存 | 安全策略引用 |

### 5.4 扫描方向——BFS 扩散

```
从 Root 出发，BFS:

Level 0 (Roots):         [A]  [B]  [C]
                           │    │    │
Level 1 (直接引用):        [D]  [E]   [F]
                           │         │
Level 2 (间接引用):        [G]    [H, I]
                                 │
Level 3:                        [J]

所有从 Root 能走到的对象 → 存活 (A 到 J)
走不到的 → 死对象 → 回收
```

### 5.5 为什么 13 个子任务要并行

G1RootProcessor 的 `evacuate_roots()` 在 Young GC 时被**所有 GC Worker 并行调用**。13 个子任务用 `SubTasksDone` 协调——Worker i 抢到一个未处理的任务 → 执行 → 再抢下一个：

```cpp
// g1RootProcessor.cpp evacuate_roots() 内部逻辑:
process_java_roots(closures, phase_times, worker_id);
  // → 内部: SubTasksDone::try_claim_task(N) → 成功就执行子任务 N
process_vm_roots(closures, phase_times, worker_id);
  // → 同上，不同的子任务组
process_string_table_roots(closures, phase_times, worker_id);
  // → 同上
```

每个子任务**独立**（扫描不同的数据结构），可以完全并行。这就是为什么 GC 暂停中 Root 扫描很快——人手多（Worker 多）+ 活分得细。

---

## 6. CSet 全景——选哪些 Region 回收

### 6.1 记忆回拨——06 讲了什么

ch11/06 讲了 `in_cset_fast_test`：偏置数组 + `InCSetState(-1/0/1/2)` O(1) 判断"某个地址在不在 CSet"。那是 **CSet 的使用阶段**。

本节讲 **CSet 的构建阶段**——这些 Region 是怎么被选进去的。

### 6.2 G1CollectionSet 类结构

```cpp
// g1CollectionSet.hpp:39-197
class G1CollectionSet {
    G1CollectedHeap* _g1h;
    G1Policy*        _policy;
    CollectionSetChooser* _cset_chooser;  // Mixed 时的 Old Region 选择器

    // 当前 CSet 中各角色的 Region 数
    uint _eden_region_length;       // eden 数量
    uint _survivor_region_length;   // survivor 数量
    uint _old_region_length;        // old 数量 (Mixed 时 > 0)

    // CSet 容器——Region 索引数组
    uint*   _collection_set_regions;       // 实际存储
    volatile size_t _collection_set_cur_length;  // 当前有效条数
    size_t  _collection_set_max_length;          // 最大容量

    // 增量构建状态
    enum CSetBuildType { Active, Inactive };
    CSetBuildType _inc_build_state;      // 当前是否在构建中

    // 增量构建的预测计数器
    size_t  _inc_bytes_used_before;              // 加入前的已用字节
    size_t  _inc_recorded_rs_lengths;            // RSet 长度累计
    double  _inc_predicted_elapsed_time_ms;       // 预测耗时累计
};
```

**关键**：CSet 不只是 "Region 的 set"——它是 `uint` 数组（存 hrm_index）+ 分类计数器（eden/survivor/old 各多少），支持按"构建→使用→清空"的生命周期管理。

### 6.3 Young-only CSet 构建（全加，无需选）

Young GC 时 CSet 构建逻辑：**eden 和 survivor Region 全量纳入 CSet**，不需要选择。

```
Young-only CSet = {
    heap 中所有 is_eden() 的 Region    // 全加
    heap 中所有 is_survivor() 的 Region // 全加
}

约束：全加可能导致暂停超时？Policy 通过调整下次的 young gen target length 来约束——
   不是"少选几个 eden"（G1 不这么做），而是"下次分配少拿几个 Region 当 eden"。
```

`G1CollectionSet::add_eden_region(hr)` 和 `add_survivor_regions(hr)` 插入 Region 索引到数组，同时递增 `_eden_region_length` / `_survivor_region_length`。

### 6.4 Mixed CSet 构建（需要选 Old Region）

Mixed GC 时 CSet = **全部 Eden + Survivor + 精选 Old Region**。

Old Region 的候选列表来自 CM Cleanup 阶段（14 展开）——Cleanup 计算了每个 Old Region 的 liveness（存活字节数），排序后产生 `candidate list`。

**选择约束**（`G1Policy::add_old_gen_to_cset`）：

1. **Pause time 约束**：`_inc_predicted_elapsed_time_ms + next_region_cost ≤ target_pause_time`
2. **G1MixedGCCountTarget**：分 N 批回收
3. **G1HeapWastePercent**：回收效率低于此阈值的 Region 不选（回收它产生的空间不足以摊平成本）

```
candidate list (按回收效率排序):  [R5(90%死) R12(85%死) R3(60%死) R18(30%死) R7(10%死)]
                                    ↑                                 ↑
                                 优先选                            浪费太多，不选

G1MixedGCCountTarget=4 → 分 4 批:
  Mixed GC #1: R5 R12 R3    ← 这批能停下吗？pause time 预测 OK → 就这些
  Mixed GC #2: R18 R7 ...   ← 继续选
  Mixed GC #3: ...
  Mixed GC #4: ...
```

### 6.5 CSet 生命周期

```
┌─────────── 构建阶段 ───────────┐  ┌──── 使用阶段 ────┐  ┌── 释放阶段 ──┐
│                               │  │                  │  │              │
│ start_incremental_building()  │  │ in_cset_fast_test │  │ clear()      │
│  ↓                            │  │ (O(1) 查询)       │  │  ↓           │
│ add_eden_region() × N         │  │                  │  │ Region → Free│
│ add_survivor_regions() × M    │  │ RSet 扫描找入引用  │  │ 位图清空     │
│ add_old_region() × K (Mixed)  │  │ Evacuation 搬运   │  │              │
│  ↓                            │  │                  │  │              │
│ finalize_incremental_building │  │                  │  │              │
│  ↓                            │  │                  │  │              │
│ 填充 in_cset_fast_test 位图   │  │                  │  │              │
└───────────────────────────────┘  └──────────────────┘  └──────────────┘
```

### 6.6 与 06 的衔接

| 06 讲的 | 本节补充的 |
|---------|----------|
| `in_cset_fast_test` 怎么工作 | CSet 是怎么被选出来的 |
| `InCSetState` 枚举（-1/0/1/2） | CSet 里有几个 eden、几个 survivor、几个 old |
| O(1) 测试 | O(Region数) 构建 |

---

## 7. 分配与 GC 的因果链

### 7.1 整条因果闭路

G1 GC 不是"定时触发的清理事件"，而是**分配的自然终点**：

```
                         ┌──────────────────────────────────────────────────┐
                         │                                                  │
                         ▼                                                  │
                ┌────────────────┐                                          │
                │ 1. Mutator 分配 │  TLAB fast path                          │
                │   新对象到 Eden  │  (pointer bump, ~10 CPU instructions)    │
                └───────┬────────┘                                          │
                        │ TLAB 满 (剩余空间不够)                               │
                        ▼                                                    │
                ┌────────────────┐                                          │
                │ 2. TLAB 退休    │  剩余空间归还                             │
                │    申请新 TLAB   │                                          │
                └───────┬────────┘                                          │
                        │ 新 TLAB = Eden Region 的连续空间                    │
                        │ 如果 Eden 也没空间了...                             │
                        ▼                                                    │
                ┌────────────────┐                                          │
                │ 3. 分配失败     │  Eden 全部满 → 无法分配                   │
                │    触发 GC      │  attempt_allocation() 返回 NULL          │
                └───────┬────────┘                                          │
                        │                                                    │
                        ▼                                                    │
                ┌────────────────┐      ┌────────────────┐                  │
                │ 4. VM Operation│ ──→  │ 5. GC 执行      │                  │
                │    请求 GC      │      │ Young/Mixed GC  │                  │
                └────────────────┘      └───────┬────────┘                  │
                                                │ 活对象搬走                  │
                                                │ CSet Region → Free         │
                                                ▼                            │
                                        ┌────────────────┐                  │
                                        │ 6. Region 归还  │                  │
                                        │    FreeList      │─────────────────┘
                                        └────────────────┘
```

### 7.2 走一遍完整流程

用具体时间线演示：

```
T0: Mutator 线程 T1 开始分配
    TLAB 内部: _top + size ≤ _end → pointer bump 分配成功
    (重复数十万次)

T1: T1 的 TLAB 剩余空间不够下一个对象
    → retire_current_tlab()
    → 向 Eden 申请新 TLAB

T2: Eden 的 MutatorAllocRegion 也满了
    → attempt_allocation() 遍历 AllocRegion → 返回 NULL
    → 调用 G1CollectedHeap::attempt_allocation_slow()

T3: slow path 尝试 expand 堆
    → 如果还有未 commit 的 Region → commit + 分配
    → 如果 expand 也失败 → 触发 GC

T4: G1CollectedHeap::collect(GCCause::_g1_inc_collection_pause)
    → VM Thread 发起 safepoint
    → 所有 mutator 线程停在 safepoint

T5-T8: GC 执行 (08-09 展开)
    T5: CSet 构建 + Root 扫描
    T6: RSet 扫描 + 对象疏散
    T7: 引用更新
    T8: CSet Region 归还 FreeList

T9: Safepoint 结束，所有 mutator 恢复执行
    → T1 重新尝试分配
    → Eden 有空闲 Region 了
    → 分配成功

T10: 程序继续运行
```

### 7.3 关键——GC 是分配的结果，不是主动事件

理解这一点至关重要：G1 不会"定时决定做一次 GC"。**GC 的唯一触发条件就是分配失败**（Full GC 除外——那是降级兜底）。

```
正确的心理模型:
  分配 → 不够 → GC → 够了 → 分配 → 不够 → GC → ...

错误的心理模型:
  "JVM 每 10 秒做一次 Young GC"
  "堆用了一半就开始 GC"
```

G1 的 Adaptive IHOP 主动启动 CM，但那个 CM 也是为了**避免未来分配失败**——最终还是为分配服务的。

---

## 本文结束——你该带到下一篇的东西

读完本文后，你应该能**不假思索**地回答以下问题（如果某一条答不出来，回到对应 Section 重读）：

| 问题 | 答不出来 → 回看 |
|------|---------------|
| G1 的 Eden 在堆的什么位置？ | §1.2（不存在固定位置——Eden 是 Tag=2 的 Region 集合） |
| Region 从 Survivor 变成 Old 时，地址变了没？ | §1.4（没变——Tag 从 3 改成 16，对象地址不变） |
| STW 和 Concurrent 的根本区别是什么？ | §2.6（mutator 停了 vs 没停） |
| 线程怎么知道"要停下来了"？ | §2.3（Thread-local poll + global polling page） |
| G1 有几种 GC 暂停？ | §3.1（YoungOnly / InitialMark / LastYoung / Mixed / Full / Remark / Cleanup） |
| Evacuation 搬活对象还是删死对象？ | §4.1（搬活——整块 Region 归还） |
| Mark Word 最低 2 位 = 11 代表什么？ | §4.2（forwarding pointer） |
| "自愈引用"是什么意思？ | §4.3（被另一个 Worker 误读到的旧引用当场修复） |
| GC Root 有哪些？ | §5.3（线程栈 / JNI / 系统类 / CodeCache / StringTable） |
| G1RootProcessor 有几个子任务？ | §5.2（13 个） |
| Young-only CSet 怎么选 Region？ | §6.3（全取所有 Eden + Survivor，不选） |
| Mixed CSet 的 Old Region 从哪来？ | §6.4（CM Cleanup 的 candidate list） |
| GC 什么时候触发？ | §7.3（分配失败时——不是定时事件） |
| 分配失败 → GC → 有空闲 → 重新分配的完整路径是什么？ | §7.2（TLAB 满 → Eden 满 → expand 失败 → GC → Region 归还 → 分配成功） |

下一篇：**ch11/08 Young GC Evacuation 周期**——把本节搭好的砖块真正用起来。
