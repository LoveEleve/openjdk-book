# 06-OopMap-GC-Roots — OopMap + GC Roots：GC 怎么在编译代码中找到所有 live oop——bitmask 的双向流程

> **阶段**：[05-jit-compiler]
> **前置**：[01-C2-Pipeline] §九（Output——PhaseOutput 中 OopMap 生成并嵌入 nmethod）。[05-Deoptimization] 将消费本文的 OopMap 进行帧重建——OopMap 是编译产物，独立于 deopt 存在。
> **配套**：[04-CodeCache-Sweeper]（nmethod 存储 OopMapSet）、[05]（deopt 消费端）
> **阅读收益**：理解 OopMap 是 JIT 和 GC 之间的"契约"——编译时生成 bitmask 编码 oop 位置、GC 时二分查找 bitmask 定位所有 oop root；掌握 "bad oop" GC crash 的诊断工作流

---

## §〇 生产场景——GC crash，"bad oop" in compiled method

### 真实 hs_err——G1 copy_to_survivor 读到 invalid oop

夜间 Full GC 时 JVM 崩溃。hs_err 日志：

```
#
# A fatal error has been detected by the Java Runtime Environment:
#
#  Internal Error (g1ParScanThreadState.cpp:123)
#  guarantee(oopDesc::is_oop(oop)) failed: not an oop!
#
# Native frames: (J=compiled Java code, j=interpreted, Vv=VM code)
# V  [libjvm.so+0xa12b30]  G1ParScanThreadState::copy_to_survivor+0x120
# V  [libjvm.so+0xa15890]  G1ParScanThreadState::trim_queue+0x80
# V  [libjvm.so+0x9a2340]  G1EvacuateRootsClosure::do_oop+0x60
# V  [libjvm.so+0x6567a0]  OopMap::oops_do+0x1c0
# V  [libjvm.so+0x674c10]  compiled_frame::oops_do+0x50
#
# J 28745 C2 com.example.DataProcessor::compute(I[Ljava/lang/Object;)V (312 bytes)
```

**解读这份 hs_err**：

```
guarantee(oopDesc::is_oop(oop)) failed
│                              └─ GC 读到一个值——但不是有效的 Java 对象指针
└─ VM 断言失败 → JVM 主动 crash（非 SIGSEGV——是 VM 自己检测到问题停止的）

OopMap::oops_do → compiled_frame::oops_do → GC
│                    │                      └─ GC 在遍历 compiled frame 的 oop
│                    └─ 当前被执行的是一个 C2 编译的方法
└─ OopMap 说本 safepoint 处某寄存器有 oop——但实际上寄存器的值不是 oop
```

**根因**：OopMap 在编译时被错误生成——在某个 safepoint 处，C2 标记了寄存器 R10 为 oop，但 R10 实际存的是 int（整数值被 GC 当成对象指针解引用 `→` `is_oop()` 返回 false `→` crash）。

**10 分钟诊断**：

```bash
# 1. 确认是 bad oop 问题
grep "not an oop\|bad oop" hs_err_pid*.log

# 2. 找出出错的编译方法
grep "# J.*C2" hs_err_pid*.log
# → DataProcessor::compute —— 排除此方法的 C2 编译

# 3. 修复：排除此方法
-XX:CompileCommand=exclude,com/example/DataProcessor::compute

# 4. 验证：开启 OopMap 验证（慢但能 catch）
-XX:+VerifyOops
```

---

## §一 ★★★ OopMap 是 JIT 和 GC 之间的"契约"——编译端生成，GC 端消费

### 1.0 本文不做什么

本文不是 `oopMap.cpp` 的源码 walkthrough。本文是 **OopMap 的双向流程 ARCHITECTURE STORY**：编译代码没有"局部变量表"了——值分散在 16 个寄存器和栈槽中。GC 怎么找到哪些是对象引用？OopMap——一个每个 safepoint 的压缩位掩码——"在这个 PC 偏移处，R10 存的是 oop，RDI 存的是 oop，[RSP+0x18] 存的是 oop"。每个 bit = 1 个 oop。没有列表，没有遍历，没有扫描——GC 解码 bitmask 在每次 safepoint 找到所有 live oop。

### 1.1 读者前提——你从哪里来

你从 [01-C2-Pipeline] §九 学完：`PhaseOutput::install_code()` → `DebugInformationRecorder::describe_scope()` → `OopMapSet::add_gc_map()`——OopMap 在编译时生成并嵌入 nmethod。[05-Deoptimization] 将消费 OopMap 进行帧重建。**本文回答：OopMap 的 bitmask 怎么编码 oop 位置信息？GC 线程怎么从 PC→OopMap→寄存器/栈槽→找到所有 oop root？编译端和 GC 端的数据结构怎么对应？**

```
[01-Pipeline] §九                          本文从这里开始
      │                                         │
      ▼                                         ▼
Output: SafePointNode → OopMapSet::add_gc_map ──→ OopMap bitmask 生成（编译端）
                                                            │
                                                            │ 
                                                            ▼
                                              nmethod 存储 OopMapSet
                                                            │
                                                            ▼
                                              GC 消费（运行时）
                                              frame::oops_do() → find_map_at_offset
                                                              │
                                                            ▼
                                              [05-Deoptimization] deopt 消费端
```

### 1.2 你需要知道的——5 个概念 callout 框

> **以下 5 个概念是理解 OopMap 的前提。每个不超过 200 字，自包含——不依赖本文其他部分。**

#### 概念 1：OopMap（对象指针映射）

OopMap = 压缩位掩码——每个 bit 代表一个寄存器或栈槽：bit=1 `→` 此位置是 oop（对象指针），bit=0 `→` 不是 oop。每个 safepoint 生成 1 个 OopMap——因为 GC 只在 safepoint 处扫描栈（其他时候指令在运行中，寄存器/栈值不可靠）。OopMap 大小：典型 ~10 bytes/safepoint（2-3 个 oop 值）。

#### 概念 2：OopMapSet

OopMapSet = 一个 nmethod 中所有 OopMap 的集合——按 PC offset 排序的数组 `(pc_offset, OopMap*)`。每个 nmethod 有 1 个 OopMapSet。GC 需要快速查找 PC 对应的 OopMap `→` 二分查找 OopMapSet。

#### 概念 3：OopMapValue（单个 oop 位置记录）

OopMap 内部存储 `OopMapValue` 流——每个 OopMapValue = `(content_type, register_number, stack_offset)`。content_type = `oop` / `narrowoop` / `narrow_klass` / `value`（non-oop）。存储格式：run-length encoding——"连续 N 个 non-oop 位置 → 1 个 oop 位置"。

#### 概念 4：OopMapBlock

OopMapBlock = 一组连续的 OopMapValue。OopMap 分成多个 OopMapBlock：(a) **register block**——寄存器 0-15 的 oop 标记；(b) **stack block**——栈槽的 oop 标记。分 Block 的目的：加速遍历——GC 可能只关心寄存器（扫描更快），跳过栈 block。

#### 概念 5：Safepoint 对应关系

OopMap 和 safepoint **一一对应**——每个 `SafePointNode`（编译阶段创建）在 Output 阶段生成 1 个 OopMap，以该 safepoint 在 nmethod 机器码中的偏移植为 key。GC 只在 safepoint 处扫描——safepoint poll（`testl [r15 + polling_page_offset], 0`）处线程可能停止 `→` GC 知道此时所有 live oop 都在 OopMap 中有记录。

---

## §二 标准环境

- OpenJDK 11 slowdebug build（`#ifdef ASSERT` 全部生效）
- `bash configure --with-debug-level=slowdebug`
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+VerifyOops`
- 64 位 Linux x86_64
- 汇编输出：`-XX:+PrintAssembly`（可看到 safepoint 标记 + OopMap 信息）

---

## §三 源文件生态——5 个文件驱动 OopMap 双向流程

| # | 文件 | 完整路径 | 模块 | 核心函数 | 本文角色 |
|---|------|---------|------|---------|---------|
| 1 | `oopMap.cpp` | `src/hotspot/share/compiler/oopMap.cpp` | compiler | `OopMapSet::add_gc_map()`、`find_map_at_offset()`、`OopMap::oops_do()` | ★★★ 生成 + 查找 + 遍历 |
| 2 | `oopMap.hpp` | `src/hotspot/share/compiler/oopMap.hpp` | compiler | `OopMap` 类、`OopMapSet` 类、`OopMapValue` 结构、`OopMapBlock` | ★★★ 数据结构定义 |
| 3 | `debugInfoRec.cpp` | `src/hotspot/share/code/debugInfoRec.cpp` | code | `DebugInformationRecorder::describe_scope()`、`add_safepoint_edges()` | ★★ 编译端——safepoint→OopMap |
| 4 | `output.cpp` | `src/hotspot/share/opto/output.cpp` | opto | `PhaseOutput::install_code()`——OopMap 生成的触发处 | ★★ Output 阶段调用 add_gc_map |
| 5 | `frame.cpp` | `src/hotspot/share/runtime/frame.cpp` | runtime | `frame::oops_do()`、`compiled_frame::oops_do()` | ★★★ GC 消费入口 |

**跨模块说明**：OopMap 跨 opto/（编译端：output.cpp 触发生成 → OopMapSet::add_gc_map）+ compiler/（数据结构：oopMap.cpp + oopMap.hpp）+ runtime/（GC 端：frame::oops_do → OopMapSet::find_map_at_offset）。双向流程：编译时 `output.cpp` → `add_gc_map()` 写入 nmethod → GC 时 `frame::oops_do()` → `find_map_at_offset()` 读取。

---

## §四 ★★★ OopMap 生成 + 消费：双向流程详解

### 4.1 ★★ OopMap 生成（编译时）——SafePointNode → OopMapSet

**触发**：Output 阶段，`PhaseOutput::install_code()` 遍历所有 safepoint（SafePointNode）。

```
SafePointNode at bci=42:
  jvms->locals:
    [0] = oop (HashMap*)  ← 局部变量 0 是对象引用
    [1] = int (42)
    [2] = float (3.14)
    [3] = oop (String*)
  jvms->expressions:
    [0] = int (0)
    [1] = oop (Integer*)

  提取所有 oop 位置 →
    reg R10 = oop (HashMap*)
    reg RDI = int
    reg RSI = float
    stack slot 0 = oop (String*)
    stack slot 1 = int
    stack slot 2 = oop (Integer*)

  OopMap for pc_offset=0x2a:
    register block: {R10: oop}
    stack block: {slot0: oop, slot2: oop}
```

**编码格式**——run-length encoding：

```
OopMapValue stream (delta-compressed):
  [0]: {type: oop, reg: 10}           → R10 是 oop
  [1]: {type: none, run: 5}           → 跳过 5 个寄存器（R11-R15）
  [2]: {type: oop, stack_slot: 0}     → 栈槽 0 是 oop
  [3]: {type: none, run: 1}           → 跳过 1 个栈槽
  [4]: {type: oop, stack_slot: 2}     → 栈槽 2 是 oop
```

**为什么这么小？** 一个典型的 OopMap ~10 bytes/safepoint。压缩策略：(a) 只有 oop 槽被记录——non-oop 槽只计 run length；(b) run-length encoding 高效编码"稀疏的 oop"（大部分寄存器/栈槽不是 oop）。如果每个指令都生成 OopMap `→` 1M nmethod × 500 指令 × 10B = 5GB CodeCache——metadata 占 80%。只在 safepoint 处生成：同样 1M nmethod × 5 safepoints × 10B = 50MB——可忽略。

**为什么用 bitmask 而不是 list？** 一个简单的 list 编码：每个 oop = 4 bytes（2B register/slot index + 2B type encoding）→ 5 个 oop per safepoint = 20 bytes。Bitmask：delta-compressed offsets → ~2 bytes per oop → 5 个 oop = ~10 bytes。以 15,000 个 nmethod × 平均 5 个 safepoint = 75,000 个 OopMap × 每个省 10 bytes = ~750KB CodeCache 节省。这就是 HotSpot 为什么选择 bitmask 而不是 list——单个 OopMap 的差距不大，但在 JVM 级别（百万级 OopMap）累积后影响显著。

### 4.2 ★★★ OopMap 数据结构——OopMapValue + OopMapBlock + OopMapSet

**OopMapValue 的 3 种 content_type**：

| content_type | 含义 | 示例 |
|-------------|------|------|
| `oop_loc` | 普通 oop 位置 | `OopMapValue(oop_loc, reg=10)` = R10 存了一个 Java Object* |
| `derived_oop_loc` | derived pointer（内部指针 = base + offset） | `OopMapValue(derived_oop_loc, reg=11, base_reg=10, offset=12)`——当 GC 移动对象后，R11 = new_base + 12 |
| `narrowoop_loc` | 压缩 oop 位置（4 bytes） | 32-bit compressed oop 在栈上 |

**OopMapBlock 层次**：

```
OopMap
  ├── Register Block (covers reg 0-15)
  │     └── OopMapValue[0] = {oop_loc, reg=10}
  │     └── OopMapValue[1] = {oop_loc, reg=7}   ← RDI 是 oop
  │
  └── Stack Block (covers stack slots)
        └── OopMapValue[2] = {oop_loc, stack_slot=0}
        └── OopMapValue[3] = {oop_loc, stack_slot=2}
```

**OopMapSet 层次**：

```
OopMapSet (stored per-nmethod)
  ├── [pc_offset=0x10] → OopMap{safepoint 1: {R10: oop}}
  ├── [pc_offset=0x2a] → OopMap{safepoint 2: {R10: oop, stack0: oop, stack2: oop}}
  ├── [pc_offset=0x3c] → OopMap{safepoint 3: {RDI: oop, R10: oop}}
  └── ...
```

### 4.3 ★★★ OopMap 消费（GC 时）——PC → OopMap → oops_do

GC 线程在 safepoint 中遍历所有线程栈帧 `→` 遇到 compiled frame `→` 调用 `frame::oops_do(OopClosure* f)`。

**Step 1：从 PC 找到 OopMap**

```cpp
// compiled_frame::oops_do() 伪代码
nmethod* nm = frame::cb()->as_nmethod();          // 当前代码块
int pc_offset = frame::pc() - nm->code_begin();   // PC 在 nmethod 中的偏移
OopMap* map = nm->oop_map_set()->find_map_at_offset(pc_offset); // 二分查找
```

`OopMapSet::find_map_at_offset()` 做二分查找——在 OopMapSet 的 `(pc_offset, OopMap)` 数组中找 `>= pc_offset` 的最小值 `→` 返回对应 OopMap。O(log N)，N = 该 nmethod 的 safepoint 数（通常 3-10 个）。

**Step 2：遍历 OopMap bitmask → 找到所有 oop → 调用 GC closure**

```cpp
// OopMap::oops_do(frame* fr, OopClosure* f) 伪代码
// 遍历 Register Block
for each OopMapValue in register_block:
    if content_type == oop_loc:
        oop* addr = fr->register_addr(register_number)  // 获取寄存器在帧中的存储位置
        f->do_oop(addr)   // GC closure 处理此 oop（标记/复制/压缩）
    if content_type == derived_oop_loc:
        oop* derived_addr = fr->register_addr(register_number)
        oop* base_addr = fr->register_addr(base_register_number)
        f->do_derived_oop(derived_addr, base_addr)

// 遍历 Stack Block
for each OopMapValue in stack_block:
    if content_type == oop_loc:
        oop* addr = fr->stack_addr(stack_slot_offset)  // 获取栈槽地址
        f->do_oop(addr)   // GC closure 处理此 oop
```

**GC closure 的透明性**：`OopClosure::do_oop()` 的具体实现取决于 GC 类型：
- **G1** `→` `G1ParCopyClosure` `→` copy to survivor region + SATB marking
- **ZGC** `→` `ZBarrier` `→` colored pointer check + forwarding
- **Shenandoah** `→` `ShenandoahBarrier` `→` Brooks pointer forwarding

OopMap 遍历对 GC 类型完全透明——OopMap 只负责"找 oop 位置"，不参与 GC 策略。

### 4.4 ★★ Derived OopMap：内部指针（interior pointer）跟踪

当 C2 生成 `lea (R10, 12), R11`（interior pointer = `array[3]` = base + 12）：

```
编译代码中的状态：
  R10 = array_obj (base pointer)        → OopMap: R10 = oop_loc
  R11 = array_obj + 12 (interior ptr)   → OopMap: R11 = derived_oop_loc(base=R10, offset=12)

GC 移动对象后：
  array_obj 被复制到新位置 → new_base
  GC 更新 R10 = new_base
  GC 更新 R11 = new_base + 12           ← 自动更新 interior pointer
```

> **Counterfactual**："如果没有 derived_oop——GC 移动对象 → 更新 R10（base pointer）但 R11（interior pointer）还是旧地址 → 指向 freed memory → 下一次 array 访问 = SIGSEGV。"

### 4.5 ★★ OopMap 在 deopt 中的消费——和 GC 不同的第二条路径

| | GC 消费 OopMap | Deopt 消费 OopMap |
|---|---|---|
| **目标** | 找到所有 live oop → GC 标记/复制 | 知道哪些值是 oop → 正确重建解释器帧 oop slot |
| **遍历方式** | `oops_do(OopClosure*)` —— 遍历所有位置 | 按需查询：`has_oop_for_register(reg)` |
| **需要 type?** | 否——oop vs non-oop 足够 | 是——需要 ScopeDesc 的 Java 类型 |
| **频率** | 每个 safepoint 1 次 | 每次 deopt 时 |
| **线程** | GC 线程（safepoint 中） | 当前 Java 线程 |

两条路径消费**同一个** OopMapSet——OopMap 是编译时生成的 artifacts，GC 和 deopt 在运行时从不同角度使用它。

### 4.6 ★ OopMap 正确性——"bad oop"的 3 种后果

**少标记 oop**（漏标）：GC 漏扫描某 oop `→` 对象被当作 dead `→` 被回收 `→` 后续访问 `→` use-after-free `→` SIGSEGV 或数据 corruption。

**多标记 oop**（过标）：GC 把 int 值当成对象引用 `→` 解引用非对象内存 `→` `is_oop()` 检查失败 `→` VM assertion `→` `guarantee(oopDesc::is_oop(oop)) failed`。

**错误标记位置**：标记了 r15_thread（Thread* 不是 Java oop） `→` GC 把 Thread* 当作 Java 对象解引用 `→` crash。编译时 SafePointNode 的正确性判断必须排除 Thread* 寄存器。

**诊断**：`-XX:+VerifyOops` 在 GC 前做额外的 oop 遍历——走每个 nmethod 的所有 OopMap → 验证每个 oop 位置：(a) oop 在 heap 范围内；(b) oop 的 Klass* 有效；(c) oop 未被标记已回收。如果验证失败 → VM assertion 触发 → hs_err 包含错误信息：哪个 PC、哪个寄存器、什么 oop 值。

---

## §五 ★ Mermaid：OopMap 双向流程图——编译端生成 + GC 端消费 + deopt 端消费

```mermaid
graph TD
    subgraph 编译端——每次 C2 编译
        A[SafePointNode<br/>jvms: locals + expressions] --> B[DebugInformationRecorder<br/>describe_scope]
        B --> C[提取 oop 位置<br/>reg/stack slot → OopMapValue 流]
        C --> D[run-length encoding<br/>压缩为 bitmask]
        D --> E[OopMapSet::add_gc_map<br/>pc_offset, oopmap]
        E --> F[nmethod 存储 OopMapSet<br/>metadata section]
    end

    subgraph GC 端——每次 safepoint
        G[GC: 遍历线程栈 frames] --> H[compiled_frame::oops_do]
        H --> I[计算 pc_offset = PC - code_begin]
        I --> J[OopMapSet::find_map_at_offset<br/>二分查找]
        J --> K[OopMap::oops_do<br/>遍历 bitmask]
        K --> L1[register block: 寄存器→oop地址]
        K --> L2[stack block: 栈槽→oop地址]
        L1 --> M[OopClosure::do_oop<br/>G1/ZGC/Shenandoah]
        L2 --> M
    end

    subgraph Deopt 端——每次 deopt
        N[Deoptimization::fetch_unroll_info] --> O[find_map_at_offset<br/>同 GC 查找]
        O --> P[读取 OopMap bitmask<br/>按需查询寄存器/栈槽]
        P --> Q[结合 ScopeDesc type 信息<br/>重建解释器帧 oop slot]
    end

    F --> H
    F --> N

    style E fill:#FFD700,stroke:#B8860B
    style J fill:#FFD700,stroke:#B8860B
    style M fill:#90EE90,stroke:#006400
    style Q fill:#87CEEB,stroke:#000080
```

---

## §六 ★ GDB 验证——10 个关键断点

### 断言 1：`OopMapSet::add_gc_map()` —— 验证每个 safepoint 生成 OopMap

```gdb
(gdb) br oopMap.cpp:100  # add_gc_map 入口
(gdb) p pc_offset
# 预期: 此 safepoint 在 nmethod 机器码中的偏移（如 0x10, 0x2a, 0x3c）
(gdb) p oopmap->count()
# 预期: oop 位置数量——如 2-5
(gdb) p oopmap->heap()->size()
# 预期: OopMap 在 bitmask 中的大小——如 10-20 bytes
```

### 断言 2：OopMap bitmask 大小验证 —— < 20 bytes/safepoint

```gdb
(gdb) br oopMap.cpp:120  # add_gc_map 返回处
(gdb) p oopmap->heap()->size()
# 预期: < 20 bytes（典型 ~10 bytes）
# 验证: 不是每个寄存器/栈槽 1 bit → run-length encoding 压缩
```

### 断言 3：`OopMapSet::find_map_at_offset()` —— 验证二分查找

```gdb
(gdb) br oopMap.cpp:250  # find_map_at_offset 返回
(gdb) p pc_offset
# 预期: 当前 PC 在 nmethod 中的偏移
(gdb) p $
# 预期: 非 NULL（safepoint 处有 OopMap）
# 在非 safepoint 处:
(gdb) p $
# 预期: NULL（非 safepoint 处无 OopMap——这是正常情况）
```

### 断言 4：`OopMap::oops_do()` —— 遍历 oop 位置

```gdb
(gdb) br oopMap.cpp:300  # oops_do 遍历中
(gdb) p omv.type()
# 预期: OopMapValue::oop_loc 或 derived_oop_loc
(gdb) p omv.reg()
# 预期: 寄存器号——如 VMReg for R10
(gdb) p omv.stack_slot()
# 预期: 如果是栈 oop——栈槽号，否则 -1
```

### 断言 5：Register block —— 验证 r15_thread 不被标记为 oop

```gdb
(gdb) br oopMap.cpp:320  # register block 遍历
(gdb) p omv.reg()->value()
# 预期: 遍历的寄存器号——0-15
(gdb) p omv.reg()
# 对于每一个被标记的 reg:
# 预期: reg 不等于 r15_thread (VMReg for r15 = 15 → 但 r15 不应该被标记为 oop)
# 验证: C2 编译时 SafePointNode 的正确性判断排除了 r15
```

### 断言 6：Stack block —— 验证局部变量的 oop 位置

```gdb
(gdb) br oopMap.cpp:360  # stack block 遍历
(gdb) p omv.stack_slot()
# 预期: 栈槽偏移——如 0, 2（数值如 0x10, 0x20 字节）
(gdb) x/a fr->sp() + omv.stack_slot()
# 预期: 该栈位置的内容——是一个有效的 oop 地址
```

### 断言 7：非 safepoint 处 find_map_at_offset 返回 NULL

```gdb
(gdb) p pc_offset = pc() - nmethod->code_begin()
# 在非 safepoint 指令处（如 add/mov 之间）:
(gdb) p nmethod->oop_map_set()->find_map_at_offset(pc_offset)
# 预期: NULL——非 safepoint 处无 OopMap——GC 不应该在此处发生
```

### 断言 8：VerifyOops 检查 —— 每个 oop 值的有效性

```gdb
(gdb) br oopMap.cpp:450  # verify 代码
(gdb) p oop()
# 预期: 有效的 oop 指针
(gdb) p oop()->klass()
# 预期: 有效的 Klass* 指针
(gdb) p oopDesc::is_oop(oop())
# 预期: true
# 如果 false → "bad oop" assertion → hs_err
```

### 断言 9：Deopt 中 OopMap 消费 —— 寄存器→解释器帧映射

```gdb
(gdb) br deoptimization.cpp:200  # fetch_unroll_info 中读取 OopMap
(gdb) p oop_map->count()
# 预期: 与编译时 add_gc_map 时一致
(gdb) p oop_map->has_oop_for_register(VMRegImpl::as_VMReg(10))
# 预期: true（如果 R10 在编译时保存了 oop）
```

### 断言 10：OopMap 和 DebugInfo —— 同一 PC offset 下数据一致

```gdb
(gdb) br deoptimization.cpp:220  # fetch_unroll_info 完成后
(gdb) p unroll_block->pc_offset()
# 对比 GDB 中的 find_map_at_offset 结果:
(gdb) p nm->oop_map_set()->find_map_at_offset(unroll_block->pc_offset())
# → 应与 deopt 中使用的 OopMap 是同一个对象
# 预期: OopMap 的 oop_count = ScopeDesc 中的 oop 局部变量数
```

---

## §七 ★ 面试 Story Format——"GC 怎么找到 JIT 代码中的 live oop？"（90 秒版）

编译后的 Java 代码没有局部变量表了——值分散在 16 个 x86 寄存器和栈槽中。GC 怎么知道寄存器 R10 里是 int 还是对象引用？OopMap。

编译时，C2 在每个 safepoint 处生成一个 OopMap——一个压缩的位掩码。每个 bit 代表一个寄存器或栈槽：bit=1 `→` 此位置是 oop（对象引用），bit=0 `→` 不是 oop。OopMap 用 run-length encoding 压缩——"连续 5 个 non-oop 位置 → R10 是 oop → 连续 3 个 non-oop → 栈槽 0 是 oop"。典型大小 ~10 bytes/safepoint。

GC 时，线程停在 safepoint。GC 遍历线程的栈帧 `→` 遇到 compiled frame `→` 计算当前 PC 在 nmethod 中的偏移 `→` 在 nmethod 的 OopMapSet 中二分查找 `→` 找到对应的 OopMap `→` 遍历 register block 和 stack block → 对每个被标记的位置调用 GC closure（`do_oop()`）。GC 从寄存器/栈槽读取值 → 如果是 oop → 标记、复制、压缩——取决于 GC 类型（G1/ZGC/Shenandoah）——但 OopMap 遍历对 GC 类型完全透明。

OopMap 也是 deopt 帧重建的基础——deopt 消费同一个 OopMap，但结合 ScopeDesc 提供的 type 信息来重建解释器帧。

OopMap 最关键的性质：**正确性**。如果 OopMap 少标记了 oop → GC 漏扫描 → 对象被回收 → use-after-free → SIGSEGV。如果 OopMap 多标记了 oop（把 int 当 oop）→ "bad oop" assertion → JVM crash。这是 `-XX:+VerifyOops` 的角色——在 GC 前验证每个 oop 位置。

---

## §八 和 [01][05] 的交叉验证

| 交叉文档 | 相关内容 | 验证方法 |
|---------|---------|---------|
| 01-Pipeline §九 | Output 阶段：`PhaseOutput::install_code()` → `OopMapSet::add_gc_map()` | 在 output.cpp 断点观察 add_gc_map 调用——每个 safepoint 1 次 |
| 05-Deoptimization §四 | OopMap 在 deopt 中的消费——`find_map_at_offset()` + ScopeDesc | 在 deoptimization.cpp 断点观察 find_map_at_offset 调用——与 GC 查找同一 OopMapSet |
| 05-Deoptimization §五 | Deopt 和 GC 消费 OopMap 的对比——目的不同，数据结构相同 | GC 需要 oop vs non-oop，deopt 还需要 ScopeDesc 的 type 信息——两条路径消费同一 OopMap |

---

## 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | **OopMap 是 JIT 和 GC 的"契约"——编译时生成，运行时消费** | OopMap 不是 GC 的数据结构——是编译器的 artifact。GC 只是消费它 |
| 2 | **bitmask + run-length encoding → ~10 bytes/safepoint** | 压缩率 ~75% vs 每个寄存器 1 bit——150MB CodeCache 节省 |
| 3 | **OopMap 和 safepoint 一一对应——不是每个指令都有** | GC 只在 safepoint 处扫描 → OopMap 只在 safepoint 处生成 → metadata 最小化 |
| 4 | **OopMap 被 GC 和 deopt 两条路径消费——消费方式不同** | GC: 遍历所有 oop 标记；Deopt: 按需查询 + ScopeDesc type |
| 5 | **derived_oop = GC 必须同时更新 interior pointer** | C2 优化产生 interior pointer → GC 移动对象时必须同时更新 base 和 interior |
| 6 | **OopMap 正确性 = 生产安全底线** | 少标记 → 漏扫描 → use-after-free；多标记 → bad oop crash → VerifyOops |
| 7 | **OopMap 是独立于 deopt 存在的编译器 artifact** | 即使 JVM 没有 deopt，OopMap 仍然存在——因为 GC 需要它 |
