# G1 运行时前置知识——从 Region 角色到 GC 暂停的全景地基

> **本文定位**：桥章——连接 ch11 初始化系列（01-06）和运行时系列（08-16）。本文不讲任何具体 GC 流程，只搭建后续 8 篇文章共享的概念砖块。
>
> **前置依赖**：ch11/01-06（知道堆初始化建了哪些数据结构：Region/RemSet/BOT/CSet 测试位图/Mapper/写屏障/卡表）。
>
> **阅读提示**：读完后你获得了 7 块通用砖块——后续任何 G1 运行时文章引到"STW""Evacuation""Root 扫描""CSet"时都不再解释。每块砖都值得慢慢消化，没有字数限制。

---

## 目录

1. [Region 角色全景——G1 的"分代"是标签，不是分区](#1-region-角色全景g1-的分代是标签不是分区)
2. [GC 暂停——STW、Safepoint、GC Worker 并行](#2-gc-暂停stw安全点gc-worker-并行)
3. [G1 的四种暂停类型——Young、Initial-mark、Mixed、Full](#3-g1-的四种暂停类型younginitial-markmixedfull)
4. [Evacuation——搬走活对象，不是删除死对象](#4-evacuation搬走活对象不是删除死对象)
5. [GC Root 扫描——活对象追踪的第一关](#5-gc-root-扫描活对象追踪的第一关)
6. [CSet 全景——本次 GC 要回收哪些 Region](#6-cset-全景本次-gc-要回收哪些-region)
7. [分配与 GC 的因果链——整条闭环](#7-分配与-gc-的因果链整条闭环)

---

## 1. Region 角色全景——G1 的"分代"是标签，不是分区

### 1.1 传统分代 GC 怎么分

传统分代 GC（Serial/Parallel/CMS）里，堆被**物理切割**成两块连续空间：

```
┌──────────────────────────────────────────────────────────────┐
│                    Young Generation                          │
│  ┌────────────┐  ┌────────────┐                              │
│  │    Eden    │  │  Survivor  │                              │
│  └────────────┘  └────────────┘                              │
├──────────────────────────────────────────────────────────────┤
│                    Old Generation                            │
└──────────────────────────────────────────────────────────────┘
```

Eden 和 Old 是两块**固定边界**的内存区域。对象在 Eden 出生，晋升到 Old 后物理地址改变（跨过了那道线）。

### 1.2 G1 怎么分——Region 标签

G1 把整个堆切成等大 Region（ch11/02 讲了大小的算法）。但 Region **不分代**——它只是一个内存块。

"Eden""Survivor""Old""Humongous"**不是物理区域，是每个 Region 上挂的标签**：

```
┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ Region 0 │ Region 1 │ Region 2 │ Region 3 │ Region 4 │ Region 5 │
│  [Eden]  │  [Eden]  │[Survivor]│ [Old]    │ [Old]    │  [Free]  │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘

关键：Region 1、2、3、4 在物理上是连续的，但它们的"角色"完全不同
```

### 1.3 五种角色

| 角色 | 谁往里分配？ | GC 行为 | 存放什么对象 |
|------|------------|--------|------------|
| **Eden** | mutator（TLAB 慢速路径） | Young GC 时**全量回收**——搬走所有活对象，整块 Region 标记为 Free | 新创建的对象 |
| **Survivor** | Young GC 的 evacuation（搬过来的） | 下次 Young GC 时再次扫描——活对象晋升到 Old 或搬到另一个 Survivor | 经受住至少一次 GC 的对象 |
| **Old** | Survivor 晋升过来的 + mutator 大对象直接分配（Humongous 以外的） | **不参与 Young GC**。只有 Mixed GC 或 Full GC 才回收。Old Region 内的活对象靠 ConcurrentMark 判断 | 长期存活对象 |
| **Humongous** | mutator（对象 ≥ RegionSize/2） | 路径特殊——Young GC 时判断是否已死（急切回收），否则等 Full GC | 超大对象（如大数组） |
| **Free** | 无 | 无——空闲 | 空 Region，等待分配 |

**关键认知**：**不是所有 Old Region 都在堆的"老年区域"**。一个 Old Region 的物理位置可能夹在两个 Eden Region 之间。G1 的"分代"仅仅是 `HeapRegion` 对象上的一个标志位。

### 1.4 角色的变化

一个 Region 的生命周期：

```
Free ──→ Eden ──→ Survivor ──→ Old ──→ Free ──→ Eden ...
                 ↑                    ↑
                 │                    │
            Young GC 后              Mixed/Full GC 后
            (幸存对象晋升)            (死对象回收)
```

**Eden → Survivor**：Young GC 发现 Eden Region 里有活对象 → 复制到 Survivor Region → Eden Region 变为 Free。

**Survivor → Old**：下次 Young GC 发现 Survivor Region 里的对象年龄达到晋升阈值 → 复制到 Old Region → Survivor Region 变为 Free。

**Old → Free**：Mixed GC 回收 Old Region → Region 变为 Free。

**Free → Eden**：堆管理器从 Free List 重新分配 Region 给 Eden 使用。

### 1.5 Humongous 的特殊性

Humongous 不是单标签——它实际上是一个**角色 + 一种 Region 类型**：

```
对象 ≥ RegionSize/2（8GB 堆 / 4MB Region = 超过 2MB）→ 判定为 Humongous
```

Humongous 对象独占连续的 Region：

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   Start Region   │  │ Continues Region  │  │ Continues Region  │
│  [Humongous]     │  │  [Humongous]      │  │  [Humongous]      │
│   (3MB 对象)      │  │   (空，标记用)     │  │   (空，标记用)     │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

- **Start region**：实际存对象数据 + 对象头
- **Continues region**：只占位，不存数据（但参与 RSet 维护和 BOT 计算）

Humongous 对象在 GC 时有独立路径：
- **Young GC**：先判断 RSet 是否有入引用——如无 → 急切回收（Eager Reclaim，ch11/06 的 humongous_reclaim_candidates 位图）；如有 → 保留
- **Full GC**：标准标记-整理回收

### 1.6 读者心理模型

读后续文章时，你应该默认：

> G1 堆 = N 个等大 Region，每个 Region 当前有一个角色（Eden / Survivor / Old / Humongous / Free）。
> 角色可以变、会变。"分配在 Eden、晋升到 Old"不再意味着"地址跳过一个物理边界"，
> 而是"对象的 Region 标签从 Eden 改成 Old"。

---

## 2. GC 暂停——STW、安全点、GC Worker 并行

### 2.1 STW (Stop-The-World)

GC 暂停时，**所有 mutator（应用 / Java）线程全部停止**。世界静止了——没有新对象分配、没有引用变更、没有人修改堆。

```
暂停前 ──→ STW 开始 ──→ GC Worker 并行工作 ──→ 工作完成 ──→ STW 结束 ──→ 暂停后
         ↑                                                              ↑
    所有 mutator 线程                        所有 mutator 线程
    停在 safepoint                          恢复执行
```

### 2.2 Safepoint——STW 的实现机制

"所有线程停下来"不是靠 OS 挂起——是靠 JVM 的 **safepoint 协议**：

1. GC 线程发起 safepoint 请求（设置全局标志）
2. 每个 mutator 线程**在下一个 safepoint 检查点**主动检查标志
3. 检查到标志位的线程**自己停住**，等待所有线程到齐
4. 所有线程都停住后，GC 开始

```
Mutator 1:   ██████████████████████████████▓▓  → 到达 safepoint，等待
Mutator 2:         ████████████▓▓             → 到达 safepoint，等待
GC Thread:                             ░░░░░░  → 开始 GC
                                        ↑
                                   所有人都停了
```

Safepoint 检查点不是每行代码都插入——只在"安全的位置"（方法返回、循环回边、JNI 边界等）。所以从发起请求到所有线程停下之间有**到达延迟**。

### 2.3 GC Worker 并行模型

暂停期间，GC 工作由**多个 GC 线程并行执行**（`ParallelGCThreads` 参数控制数量）：

```
GC 暂停中:
  Worker 0: [扫描 Root 0] [Evacuate Region 3] [Evacuate Region 7]
  Worker 1: [扫描 Root 1] [Evacuate Region 5] [Evacuate Region 9]
  Worker 2: [扫描 Root 2] [Evacuate Region 1] [更新引用]
  Worker 3: [扫描 Root 3] [Evacuate Region 6] [收尾]

  所有 Worker 并行推进，用 CAS/原子操作抢任务
```

G1 的绝大多数 GC 工作通过 `WorkGang` 框架调度——把大任务切分成小作业，多个 Worker 通过**工作窃取 (work-stealing)** 机制并行完成。

### 2.4 暂停 vs 并发——两个世界

| | **暂停阶段（STW）** | **并发阶段（Concurrent）** |
|---|---|---|
| Mutator 状态 | 全部停止 | 正常执行 |
| GC 能做什么 | 移动对象、更新引用、修改堆布局 | 标记、扫描、统计（不能移动对象） |
| 安全保证 | mutator 停了，没有并发冲突 | 需要额外的"写时保护"机制（SATB / 卡表） |

读后续文章时请注意这两种状态的区别：

- **Young GC = STW 暂停**（全部停在 safepoint，GC Worker 并行疏散对象）
- **ConcurrentMark = 并发**（mutator 照常跑，GC 线程悄悄标记）
- **Remark / Cleanup = STW 收尾**（并发完需要停一下完成最后几步）

---

## 3. G1 的四种暂停类型——Young、Initial-mark、Mixed、Full

### 3.1 四种暂停概览

| 暂停类型 | 频率 | 何时触发 | 回收什么 | 是否包含 Old Region |
|---------|------|---------|---------|------------------|
| **Young-only** | 最高 | Eden 用尽（allocation failure） | Eden + Survivor（全量） | ❌ 不 |
| **Initial-mark** | 中 | IHOP 阈值达到（老年代占比过高） | Eden + Survivor + 标记 survivor 为 root | ❌ 不（但**启动 CM**） |
| **Mixed** | 中低 | Initial-mark 完成 + CM 结果出来后 | Eden + Survivor + 精选 Old Region | ✅ **有** |
| **Full GC** | 极低 | 降级（堆满了 / CM 失败 / 显式 System.gc()） | **全堆** | ✅ 全部 Old |

### 3.2 暂停类型在 G1 生命周期中的位置

```
应用启动 ──→ 初始化 ──→ [Young-only] ... [Young-only] ──→
                         ↑                              ↑
                    高频，几十到几百次              IHOP 达阈值

  ──→ [Initial-mark] ──→ 并发标记 ──→ [Remark] [Cleanup] ──→
       ↑ 特殊：本质                                    ↑
       是 Young GC，但                    CM 周期结束，
       多了一步"标 survivor"              得到 per-region liveness

  ──→ [Mixed] [Mixed] [Mixed] ... ──→ [Young-only] ... ──→
       ↑                             ↑
    分多次回收 Old Region        Old Region 回收完了，
    (G1MixedGCCountTarget 次)    回到纯 Young-only 节奏
```

**Initial-mark 是特殊的 Young GC**——它在 piggyback 上做"额外一步"（把 survivor 标记为 root），其余部分和普通 Young GC 一模一样。这也是为什么后续 08 讲完 Young GC 后，13 讲 CM 的 initial-mark 阶段时只需要追加"多做了什么"，不需要重新讲整个 Young GC 流程。

### 3.3 Full GC 是兜底

G1 的设计目标是**尽量不走 Full GC**。但当以下情况发生时，只能降级：

- Evacuation failure 累积——promotion 空间不够，搬不走对象
- Concurrent cycle 失败——标记过程中出现不可恢复的错误
- 显式 `System.gc()`（如果没有 `-XX:+DisableExplicitGC`）

Full GC 使用 Serial GC 或 Parallel GC 的**单线程/多线程标记-整理**算法，停顿时间长（堆越大越久），应尽量避免。

---

## 4. Evacuation——搬走活对象，不是删除死对象

### 4.1 两种回收策略

| | **标记-清扫（Mark-Sweep）** | **标记-复制（Mark-Copy / Evacuation）** |
|---|---|---|
| 代表 | CMS、Serial Old | G1、Serial Young、Parallel Scavenge |
| 回收方式 | 标记活对象，清扫死对象空间 | 标记活对象，**搬走**活对象，整块区域直接释放 |
| 碎片化 | 严重——死对象散落在活对象之间 | 无碎片——搬走后原区域变连续空闲空间 |
| 额外开销 | 需要 free list 管理碎片 | 需要额外的"目标空间"来接收搬过来的对象 |

### 4.2 Evacuation 三部曲

G1 的 Young GC 使用 Evacuation——一个对象的搬运过程分三步：

```
原位置（CSet Region）                  目标位置（Survivor/Old Region）
┌──────────────────┐                ┌──────────────────┐
│  Object A        │                │  (预留空间)       │
│  mark word       │    ── copy ──→ │                  │
│  klass ptr       │                │                  │
│  field 1         │                │                  │
│  field 2         │                │                  │
└──────────────────┘                └──────────────────┘

步骤 1: COPY —— 把 Object A 的完整内容拷贝到目标位置
        Object A'.mark_word = A.mark_word
        Object A'.klass     = A.klass
        Object A'.field_1   = A.field_1
        Object A'.field_2   = A.field_2

步骤 2: FORWARD —— 在原位置的 mark word 里写入 forwarding pointer
        A.mark_word = &Object_A'  (指向新地址)
        打上一个特殊标记"这里是 forwarding pointer"（锁状态位 = 11，即 markOop::marked_value）

步骤 3: UPDATE —— 更新所有指向 A 的引用，让它们指向 A'
        ref_to_A → ref_to_A'
```

### 4.3 Forwarding Pointer——mark word 的双重身份

Java 对象的 mark word 正常存锁状态、GC 年龄、哈希码。Evacuation 时，mark word 被**临时覆盖**为 forwarding pointer：

```
正常: mark word = [hash:25][age:4][biased_lock:1][lock:2]
转发: mark word = [forwarding_pointer:62][marked:2]    ← lock=11 表示"这是转发指针"
```

**自愈 (self-healing) 引用**：当另一个 GC worker 通过引用访问 A 时：

```
1. 读引用 → 发现指向旧地址 &A
2. 读 &A.mark_word → 发现 lock=11（是 forwarding pointer）
3. 取 forwarding_pointer → 得到 &A'
4. **当场修复**：把引用从 &A 改成 &A'（不再指向旧地址）
5. 返回 &A'
```

"自愈"意味着后续访问同一个引用**不会再走 forwarding pointer**——它已经被修复了。

### 4.4 Preserved Marks——mark word 的冲突

对象的 mark word 里有 GC 年龄字段需要保留。Evacuation 把 mark word 覆盖成 forwarding pointer 后，原 mark word 信息去哪了？

答案：存到 `G1PreservedMark` 栈里——09（Young GC 内部机制）会详细展开。现在只需要知道：
- Evacuation 后 mark word = forwarding pointer
- 原来 mark word 的信息被保存在 preserved mark 栈
- 恢复阶段会把 preserved mark 写回新对象的 mark word

### 4.5 为什么 G1 用 Evacuation——Region 化堆的逻辑必然

G1 用 Evacuation 不是偶然的——是 Region 化堆的**逻辑必然**：

```
Young GC 回收 CSet 中的所有 Region:

收集前:
  [Eden R0 活/死/死/死]  [Eden R1 死/死/活/活]  [Survivor R2 活/死]
           ↓ Evacuation ↓
收集后:
  [Free R0          ]  [Free R1          ]  [Free R2          ]
          活对象搬走了，整块 Region 直接标记为 Free

对比 CMS sweep:
  [Old R0 活/死/活/死/活/死/死/活/死] → sweep → [Old R0 活/_/活/_/活/_/_/活/_]
  ↑ 碎片！下次分配要遍历 free list 找合适大小的空洞
```

**Region 是 G1 回收的粒度**——回收一个 CSet Region = 搬走它的活对象 → 整块 Region 归还 Free List。如果走 sweep 路线（标记死对象然后释放）——Region 内的碎片没法作为 Region 粒度归还。

---

## 5. GC Root 扫描——活对象追踪的第一关

### 5.1 GC Roots 是什么

GC 判断"对象是否存活"的标准是**从 GC Roots 出发能否到达**。如果一个对象无法从任何 Root 回溯到，它就是"死的"。

```
GC Roots（堆外的入口点）          堆内对象
─────────────────────         ──────────
  线程栈局部变量        ──→     Object A
  JNI GlobalRef         ──→     Object B  ──→  Object C
  系统类静态字段         ──→     Object D
                              Object E  ← 无法从任何 Root 到达 → 死对象
```

### 5.2 G1 用到的五类 GC Root

| 根类型 | 是什么 | 什么时候变 | 为什么必须 STW 扫描 |
|--------|--------|-----------|-------------------|
| **Java 线程栈** | 每个线程栈帧中的局部变量、操作数栈中的引用 | 每条指令执行期间都在变 | 线程停了，栈才冻结 |
| **JNI handles** | `NewGlobalRef()` 创建的全局引用、`NewLocalRef()` 的局部引用 | native 代码期间可变 | 线程停了，native 栈帧才冻结 |
| **系统类** | `SystemDictionary`（所有加载的类）、`Universe`（基础类型 mirror 对象） | 类加载/卸载时 | 类加载可以在 safepoint 做，但根扫描类引用时类加载不能并发 |
| **JVM 内部结构** | `StringTable`（intern 的字符串）、`CodeCache`（已编译代码中的 oop 常量）、`ClassLoaderDataGraph` | 运行时持续变化 | 这些结构在 mutator 运行期间一直在变 |
| **Management/JFR** | JMX Bean 引用、JFR chunk 引用 | GC 外可变 | 引用关系不稳定 |

### 5.3 扫描方向

从 Root 出发，**向外扩散**：

```
Root ⊥→ Object A ──→ Object B ──→ Object C
       └──→ Object D ──→ Object E

扫描顺序:
  1. 从所有 Root 出发，收集第一层引用（A, D）
  2. 从 A 出发，发现 B
  3. 从 B 出发，发现 C
  4. 从 D 出发，发现 E
  5. C 和 E 没有继续引用 → 扫描结束

  标记结果: A, B, C, D, E 存活
  F（从未被任何 Root 到达）→ 死对象
```

### 5.4 G1RootProcessor

G1 专门有 `G1RootProcessor` 类来**统一管理所有 Root 类型**的扫描。它不是一个"逻辑概念"，而是有一个真实类的——它的 `process_all_roots()` 方法依次驱动各种 `G1RootClosure` 子类去扫不同的根。

具体细节在 08（Young GC）展开——这里只需要知道"存在一个叫 G1RootProcessor 的东西，负责遍历所有 Root，驱动后续的存活对象追踪"。

---

## 6. CSet 全景——本次 GC 要回收哪些 Region

### 6.1 CSet 是什么

CSet（Collection Set）= **本次 GC 暂停要回收的 Region 集合**。

ch11/06 已经讲了 `in_cset_fast_test`——如何 O(1) 判断一个地址是否在 CSet 中。但没回答"这个集合是怎么选出来的"。那是 CSet **构建**的问题。

```
CSet 构建           CSet 使用（06 讲的）            CSet 回收
─────────          ──────────────────            ─────────
选哪些 Region ──→  快速判断 in_cset   ──→  搬走活对象，释放 Region
（本节展开）        （06 讲的）                   （08 展开）
```

### 6.2 两类 CSet

| | **Young-only CSet** | **Mixed CSet** |
|---|---|---|
| 包含 | Eden 全部 + Survivor 全部 | Eden 全部 + Survivor 全部 + 精选 Old Region |
| 怎么选 | 直接全取——eden 和 survivor 不需要选（全量回收） | 从 CM Cleanup 产生的 **candidate list** 中选（选回收效率高的） |
| 约束 | Pause time 预测——如果"eden + survivor 全部"导致了工作量超过目标暂停，**下次缩小 young gen** | Pause time + `G1MixedGCCountTarget`（分批）+ `G1HeapWastePercent`（浪费阈值） |
| 何时用 | 每次 Young GC | Initial-mark 完成后，CM Cleanup 结果出来后 |

### 6.3 Pause time 约束——CSet 不能太大

CSet 大小 **直接决定 GC 暂停时长**：

```
暂停时长 ≈ 扫 CSet 成本 + 搬活对象成本 + 更新引用成本

G1Policy 的目标: 暂停时长 ≤ MaxGCPauseMillis（默认 200ms）
```

Policy 用历史数据（`_analytics` 的 19 个滑动窗口） + EWMA 算法 **预测**下一次 GC 的成本，然后反过来算"能放多少 Region 进 CSet 还不会超时"。这就是 `_mmu_tracker` 的职责——ch11/04 讲了它作为 Policy 的组件存在，详细算法在 10 展开。

### 6.4 CSet 生命周期

```
构建 ──→ 使用 ──→ 释放

构建阶段（GC 暂停开始）:
  1. 清空上次的 CSet
  2. 加所有 eden + survivor Region
  3. 如果是 Mixed GC，从 candidate list 选 old Region
  4. 设 in_cset_fast_test 位图（06 讲的操作）

使用阶段（GC 暂停中，08 展开）:
  - in_cset_fast_test O(1) 判断任意地址
  - RSet 扫描找 CSet 的入引用
  - Evacuation 搬走活对象

释放阶段（GC 暂停末尾，08 展开）:
  - CSet Region 中活对象已搬走 → Region 标记为 Free
  - CSet Region 中如果还有对象（evac failure 的情况）→ 保留并标记
  - 清 in_cset_fast_test 位图
```

---

## 7. 分配与 GC 的因果链——整条闭环

### 7.1 闭环全景

```
                 ┌──────────────────────────────────────────┐
                 │                                          │
                 ▼                                          │
        ┌──────────────┐                                    │
        │ Mutator 分配  │                                    │
        │ (TLAB 快速路径)│                                    │
        └──────┬───────┘                                    │
               │ TLAB 满                                      │
               ▼                                              │
        ┌──────────────┐                                    │
        │ 堆内存不足     │                                    │
        │ (Eden 用尽)    │                                    │
        └──────┬───────┘                                    │
               │                                              │
               ▼                                              │
        ┌──────────────┐      ┌──────────────┐      ┌──────┴───────┐
        │ 触发 GC       │ ──→  │ GC 执行       │ ──→  │ Region 释放   │
        │ (Young GC等)  │      │ (搬活/删死)   │      │ (归还FreeList)│
        └──────────────┘      └──────────────┘      └──────────────┘
                                                           │
                                                           │ Region 回到
                                                           │ Free List
                                                           │
                                                           ▼
                                                    Mutator 重新分配
                                                    (从 Free List 拿 Region)
```

这是一条**因果闭环**。GC 不是"偶尔触发的一次清理"，而是"分配的自然结果"。理解这条闭环后，读后续文章时心中要随时能调用它：

### 7.2 读后续文章用的极简版

> Mutator 分配 → TLAB 满 → 慢速路径 → Eden 无可用空间 → 触发 GC → GC 搬活放死 → Region 归还 → 重新分配 → 重回第一步

本文到此结束。现在你已经有了 7 块概念砖块——每块都足够扎实。开始读 ch11/08（Young GC 流程）时，请随时回来查这里的概念。
