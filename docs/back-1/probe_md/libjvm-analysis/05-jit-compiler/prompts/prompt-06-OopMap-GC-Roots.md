# PROMPT: 请撰写 06-OopMap-GC-Roots.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**OopMap + GC Roots — GC 怎么找到 JIT 编译代码中的 live object pointers？编译时 OopMap 生成 vs GC 时 OopMap 消费的完整双向流程**。

### 核心故事线（禁止做源码翻译机！）

GC crash in G1ParScanThreadState::copy_to_survivor — bad oop reference in compiled method。OopMap 说"register r10 has an oop at PC 0x..."但 r10 包含了 0x7f8b...（一个有效指针但指向死对象）。OopMap 为错误的 safepoint 生成——GC 遍历编译代码时使用了错误的 root set。

GC 怎么找到 JIT 编译代码中的 live object pointers？编译后没有"局部变量表"了——值分散在 16 个寄存器和栈槽中。OopMap = 每个 safepoint 的位掩码——一行一行告诉 GC："在 PC 0x... 处，R10 有 oop，RDI 有 oop，[RSP+0x18] 有 oop"。

**读者前提**：从 [01-Pipeline] §八（PhaseOutput::install_code()——OopMap 在编译时被生成）进入本文。读者知道 OopMap 在编译时被嵌入 nmethod，本文回答：**OopMap 的位掩码怎么编码 oop 位置信息？GC 线程怎么从 PC→OopMap→寄存器/栈槽→找到所有 oop root？编译端和 GC 端的数据结构怎么对应？**

[05-Deoptimization] 将消费本文生成的 OopMap 进行帧重建，但 OopMap 独立于 deopt 存在——它是 GC 与 JIT 的桥梁，不是 deopt 的私有数据结构。

### 你需要知道的（零 OopMap 背景的工程师必须理解 4 个概念）

#### 概念 1：OopMap（对象指针映射）

OopMap = 一个压缩的位掩码——每个 bit 代表一个寄存器或栈槽：1 = 这个位置有 oop（对象指针），0 = 这个位置没有 oop。每个 safepoint 生成 1 个 OopMap——因为只有在 safepoint 处 GC 才会扫描栈（其他时候指令在运行中，栈/寄存器值不可靠）。OopMap 大小：~10 bytes/safepoint（典型 2-3 个 oop 值）。

#### 概念 2：OopMapSet

OopMapSet = 一个 nmethod 中所有 OopMap 的集合——按 PC offset 排序的数组 `(pc_offset, OopMap*)`。每个 nmethod 有 1 个 OopMapSet（存储在 nmethod 的 metadata section）。GC 需要快速查找 PC 对应的 OopMap→ 二分查找 OopMapSet。

#### 概念 3：OopMapValue（单个 oop 位置记录）

OopMap 内部存储 `OopMapValue` 流——每个 OopMapValue = (location_type, location_number, content_type)：location_type = register 或 stack slot；location_number = 寄存器号或栈偏移；content_type = oop、narrowoop、narrow_klass、value（non-oop）。

#### 概念 4：Safepoint 对应关系

OopMap 和 safepoint **一一对应**——每个 `SafePointNode`（编译阶段创建）在 Output 阶段生成 1 个 OopMap。GC 只在 safepoint 处扫描——safepoint poll（`testl [r15 + polling_page_offset], 0`）处线程可能停止 → GC 知道此时所有 live oop 都在 OopMap 中有记录 → 可以从 OopMap 准确地找到所有 root。

---

**本文是 05-jit-compiler 阶段的第 6 篇。前置：[01-Pipeline] §九（Output——PhaseOutput::install_code() 中 OopMap 被生成并嵌入 nmethod）。[05-Deoptimization] 将消费本文描述的 OopMap 进行帧重建——OopMap 是编译时的产物，GC 和 deopt 在运行时消费它。读者知道 OopMap 在编译后嵌入 nmethod，本文回答：OopMap 的 bitmask 编码、GC 消费流程、以及它与 deopt 消费的关系。配套：[05]（deopt 消费端）、[04-CodeCache-Sweeper]（nmethod 存储 OopMapSet）。**

### 核心叙事线 — "GC 怎么在编译代码中找到所有 oop"

1. **★★ OopMap 生成（编译端）** — `PhaseOutput::install_code()` → `DebugInformationRecorder::describe_scope()` → `OopMapSet::add_gc_map(pc_offset, oopmap)`。每个 SafePointNode → 遍历其 oop 槽 → 构造 OopMap → 压缩为 bitmask → 加入 OopMapSet。
2. **★★ OopMap 结构** — OopMapValue 流→压缩 bitmask。每个 OopMapValue：location_type + location_number + content_type。压缩策略：run-length encoding of "non-oop" runs between oop positions。
3. **★★★ OopMap 消费（GC 端）** — GC 线程调用 `frame::oops_do(OopClosure*)` on compiled frame → `OopMapSet::find_map_at_offset(pc_offset)` → 二分查找 OopMapSet → 遍历 bitmask → 对每个 oop 位置调用 `f->do_oop()`。
4. **★★ OopMap 在 deopt 中的消费** — deopt 需要知道 "哪些寄存器值是 oop" 以正确写入解释器帧的 oop slot。和 GC 消费的区别：GC 遍历所有 oop 做标记；deopt 需要 type 信息（DebugInfo 提供 type，OopMap 只提供 oop vs non-oop）。
5. **★ OopMap 的正确性保证** — 如果 OopMap 错了（少标记了 oop）→ GC 漏扫描 → 对象被回收 → 悬挂指针 → SIGSEGV。如果 OopMap 多标记了 oop（把 int 标记为 oop）→ GC 把 int 值当作指针 → "bad oop" assertion 触发或 GC crash。C2 的 debug builds 有 OopMap 验证：`-XX:+VerifyOops`。

### 验证报告
- `sverklo_search "OopMap OopMapSet add_gc_map find_map find_map_at_offset bitmask"` → oopMap.cpp oopMap.hpp
- `codegraph query "OopMapSet::add_gc_map OopMapSet::find_map_at_offset OopMap::oops_do"` → 核心函数
- `rg -n "add_gc_map\|find_map_at_offset\|oops_do\|OopMapValue\|OopMapBlock" oopMap.cpp oopMap.hpp` → OopMap 实现

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+VerifyOops`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:+PrintAssembly` 可以看到 safepoint 标记 + OopMap 信息

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `oopMap.cpp` | `src/hotspot/share/compiler/oopMap.cpp` | compiler | `OopMapSet::add_gc_map()`、`OopMapSet::find_map_at_offset()`、`OopMap::oops_do()`、`OopMap::update_map()` | ★★★ OopMap 核心——生成+查找+遍历 |
| 2 | `oopMap.hpp` | `src/hotspot/share/compiler/oopMap.hpp` | compiler | `OopMap` 类(:82-350)、`OopMapSet` 类、`OopMapValue` 结构、`OopMapBlock` | ★★★ 数据结构定义 |
| 3 | `debugInfoRec.cpp` | `src/hotspot/share/code/debugInfoRec.cpp` | code | `DebugInformationRecorder::describe_scope()`、`add_safepoint_edges()` | ★★ 编译端——safepoint→OopMap 生成 |
| 4 | `output.cpp` | `src/hotspot/share/opto/output.cpp` | opto | `PhaseOutput::install_code()`——OopMap 生成的触发处 | ★★ 编译端 ——Output 阶段调用 add_gc_map |
| 5 | `nmethod.cpp` | `src/hotspot/share/code/nmethod.cpp` | code | nmethod 存储 OopMapSet——`oops_do()` | ★★ GC 消费端——nmethod→OopMapSet |
| 6 | `frame.cpp` | `src/hotspot/share/runtime/frame.cpp` | runtime | `frame::oops_do()`——GC root 遍历入口 | ★★ GC 消费端——frame→OopMap |

**跨模块说明**：OopMap 跨 opto/（编译端生成）+ compiler/（数据结构定义——oopMap.cpp/oopMap.hpp 在 compiler/ 中，因为 OopMap 是编译器 artifact）+ runtime/（GC 消费端）。双向流程：编译时 `output.cpp` 调用 `OopMapSet::add_gc_map()` 写入 nmethod → GC 时 `frame::oops_do()` 调用 `OopMapSet::find_map_at_offset()` 读取 OopMap。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★ OopMap 生成（编译时）

```
问题：
  ① OopMap 在哪个编译阶段生成？
      线索: output.cpp PhaseOutput::install_code + debugInfoRec.cpp
      答案方向: PhaseOutput::install_code() 遍历所有 safepoint（SafePointNode）→ 对每个 safepoint：
      调用 DebugInformationRecorder::describe_scope() 生成 DebugInfo → 调用 OopMapSet::add_gc_map(pc_offset, oopmap)
      把 OopMap 加入 OopMapSet。pc_offset = 此 safepoint 在 nmethod 机器码中的偏移。
      OopMap 从 SafePointNode 的 jvms 信息中提取——遍历 jvms 的 locals/expressions/monitors → 
      对每个 oop 值的 loc（寄存器/栈槽）→ 在 OopMap 中标记。

  ② 为什么只在 safepoint 处生成 OopMap？不在每个指令处？
      答案方向: GC 只在 safepoint 处发生——safepoint poll（testl 指令）处线程可能停止。
      非 safepoint 处线程不会停止 → GC 不需要扫描这些位置的 oop。如果每个指令都生成 OopMap →
      nmethod metadata 爆炸（OopMap 数量 = 指令数）× ~10 bytes → CodeCache 中 metadata 占比 >50%。
      追问: 但线程可能在非 safepoint 处被信号中断——怎么处理？→ 信号到达时线程已经在"任意位置"，
      但信号处理器通常立即把线程带到 safepoint（通过 poll）或处理完后线程继续执行——过程中 GC 不会发生。

  ③ OopMap 的大小是多少？为什么这么小？
      答案方向: 典型 OopMap ~10 bytes/safepoint。为什么小？压缩策略：(a) 只有 oop 槽被记录——
      non-oop 槽只计 run length；(b) OopMapValue 用 run-length encoding：连续 N 个 non-oop 位置后
      记录 1 个 oop 位置；(c) bit position 参考：寄存器号 0-15 + 栈槽相对偏移。追问: 如果方法很大
      （2000 条指令、20 个 safepoints）→ OopMapSet 总大小 ~200 bytes——可忽略。
```

### 4.2 ★★ OopMap 数据结构

```
问题：
  ① OopMapValue 流怎么编码 oop 位置？
      线索: oopMap.hpp OopMapValue 结构
      答案方向: OopMapValue = (content_type, register_number, stack_offset)。
      content_type = oop / narrowoop / narrow_klass / value（non-oop）。
      OopMap 存储方式：不是每个寄存器/栈槽 1 bit——而是压缩流——记录"有多少个连续的 non-oop 位置 →
      然后 1 个 oop 位置"。示例：连续 5 个 non-oop → r8 有 oop → 连续 3 个 non-oop → r12 有 oop。
      存储为[(5, r8, oop), (3, r12, oop)]。

  ② OopMapBlock 是什么？和 OopMap 什么关系？
      答案方向: OopMapBlock = 一组连续的 OopMapValue——每个 Block 覆盖一定范围的栈槽或寄存器。
      OopMap 分成多个 OopMapBlock：(a) register block（0-15）→ 寄存器 0-15 的 oop 标记；
      (b) stack block → 当前帧的栈槽的 oop 标记；(c) 可能有多个 stack block（caller 的栈参数）。
      追问: 为什么分 Block？→ 加速遍历——GC 可能只关心寄存器（扫描更快），跳过栈 block。
```

### 4.3 ★★★ OopMap 消费（GC 时）

```
问题：
  ① GC 线程怎么从 PC 找到 OopMap？
      线索: oopMap.cpp find_map_at_offset + frame.cpp oops_do
      答案方向: GC 遍历线程栈帧 → 遇到 compiled frame → 获取此帧当前的 PC（存储在帧的 return address
      位置）→ 计算 pc_offset = PC - nmethod->code_begin() → 调用 OopMapSet::find_map_at_offset(pc_offset)
      → 在 OopMapSet 中二分查找 pc_offset → 返回对应的 OopMap。
      追问: 如果 pc_offset 不在 OopMapSet 中（不是 safepoint）？→ 说明 GC 在不该发生的地方发生了——
      JVM bug。但正常不可能——GC 只在 safepoint poll 处收集——那些位置一定有 OopMap。

  ② OopMap::oops_do(frame* fr, OopClosure* f) 怎么遍历？
      答案方向: (a) 遍历 OopMap 的 register block → 对每个标记为 oop 的寄存器 → 
      从 frame 中读寄存器值（RegisterMap + frame::register_addr()）→ 调用 f->do_oop(addr)；
      (b) 遍历 OopMap 的 stack block → 对每个标记为 oop 的栈槽 → 从 frame 的栈中读值
      （frame::sp() + stack_offset）→ 调用 f->do_oop(addr)。
      GC closure (f) 的具体实现取决于 GC 类型——G1 的 SATB marking、ZGC 的 colored pointers、
      Shenandoah 的 Brooks pointers——OopMap 遍历对 GC 类型透明。

  ③ 如果 OopMap 标记了 r15_thread（Thread* 存在寄存器中）为 oop——GC 会怎么处理？
      答案方向: r15_thread 存 JavaThread*——这是一个 C++ 对象，不是 Java oop。如果 OopMap 错误
      标记了 r15 为 oop → GC 会把 Thread* 当作 Java 对象 → 解引用 → 读到 Thread 对象的字段值
      （不是 oop layout）→ "bad oop" assertion 触发或 GC crash。正确做法：r15_thread 不应该在
      OopMap 中被标记。编译时 SafePointNode 的判断条件排除了 r15（因为它是 Thread*，不是 Java oop）。
```

### 4.4 ★★ OopMap 在 deopt 中的消费

```
问题：
  ① deopt 中 OopMap 的消费和 GC 有什么不同？
      答案方向: GC 只需要知道"哪里是 oop"——然后对所有 oop 执行标记操作（do_oop）。
      Deopt 还需要知道"这个 oop 应该放到解释器帧的哪个位置 + 是什么类型"。
      OopMap 只提供 oop vs non-oop 区分——不提供类型信息。DebugInfo（ScopeValue 列表）
      提供类型（T_INT/T_LONG/T_OBJECT/T_FLOAT/T_DOUBLE）——deopt 结合 OopMap（bitmask）
      和 DebugInfo（ScopeValue）重建解释器帧。
      追问: 为什么 OopMap 不保存类型？→ 为了省空间。GC 不需要类型（只需知道"是不是 oop"即可）；
      deopt 需要类型但有独立的 DebugInfo 存储。两者分工明确。

  ② OopMap bitmask 和 DebugInfo ScopeValue 怎么对应？
      答案方向: OopMap bitmask 按位置编号——bit 0=reg0, bit 1=reg1, ..., bit 16=stack_slot0, ...
      DebugInfo ScopeValue 按帧 slot 编号——slot 0=local0, slot 1=local1, ..., slot N=expr0, ...
      OopMap 的栈 block 中的位置和 DebugInfo 的 slot 通过 offset 映射——两者共用同一套位置编号系统。
```

### 4.5 ★ OopMap 的正确性

```
问题：
  ① 如果 OopMap 少了 1 个 oop——GC 漏扫描了——会怎样？
      答案方向: GC 漏扫描某 oop → 对象被当作 dead → 被回收 → 后续访问此对象 → 
      悬挂指针解引用 → 可能读到已被覆盖的内存 → SIGSEGV 或不可预测的行为。
      这是"GC crash with bad oop"的生产灾难——非常难重现和 debug。

  ② -XX:+VerifyOops 怎么验证 OopMap 正确性？
      线索: oopMap.cpp 中的 verify 相关代码
      答案方向: VerifyOops 在 GC 前做一次额外的 oop 遍历——走每个 nmethod 的所有 OopMap
      → 对每个 oop 位置解引用 → 验证：(a) oop 是有效的对象指针（在 heap 范围内）；
      (b) oop 的 Klass* 是有效的 klass；(c) oop 没有被标记已回收。如果验证失败 →
      VM 断言触发（`guarantee(oop->is_oop(), "bad oop")`）→ 输出错误信息（哪个 PC、哪个寄存器、
      什么 oop 值）→ 帮助定位 C2 的 OopMap bug。
```

## 五、文章结构

```
§〇 生产场景 — GC crash with "bad oop" in compiled method
  ★ GC crash hs_err——bad oop reference at G1ParScanThreadState::copy_to_survivor
  ★ 10 分钟诊断：VerifyOops→出错的 OopMap→出错的 safepoint→C2 bug 定位

§一 ★★★ OopMap 全貌 — 编译端的生成 + GC 端的消费 + 双向对应
  ❓ 为什么 Java 需要 OopMap 而 C/C++ 的 GC（Boehm GC）不需要？
  ❓ OopMap = JIT←→GC 的"契约"——两者通过 bitmask 通信
  1.1 ★ Mermaid：编译端 SafePointNode→OopMap→nmethod | GC 端 PC→OopMap→oops_do
  1.2 ★ 面试 Story Format 答案：GC 怎么找到 JIT 代码中的 live oop？
  1.3 和 [01-Pipeline] §八（Output 阶段生成 OopMap）的连接

§二 ★★ OopMap 数据结构
  ❓ OopMapValue 流怎么压缩 oop 信息？
  ❓ OopMapBlock 的层次结构
  2.1 OopMapValue 的 3 种 location_type + 3 种 content_type
  2.2 OopMapBlock — register block / stack block
  2.3 ★ OopMap 大小计算 — 典型 ~10 bytes/safepoint 的推导

§三 ★★ OopMap 生成（编译端）
  ❓ 为什么只在 safepoint 处生成？
  ❓ SafePointNode 的 jvms 信息→ OopMap 写入的路径
  3.1 PhaseOutput::install_code() → DebugInformationRecorder::describe_scope
  3.2 OopMapSet::add_gc_map(pc_offset, oopmap)
  3.3 safepoint 和 OopMap 的一一对应

§四 ★★★ OopMap 消费（GC 端）
  ❓ GC 怎么从 PC→OopMap→寄存器/栈槽→oop 闭包？
  ❓ OopMapSet::find_map_at_offset() 的二分查找
  4.1 frame::oops_do() → OopMapSet → find_map_at_offset → bitmask 遍历
  4.2 ★ register block 遍历 + stack block 遍历
  4.3 GC closure 的透明性 — G1/ZGC/Shenandoah 的各自实现

§五 ★★ OopMap 在 deopt 中的消费
  ❓ GC vs deopt：OopMap 消费的两条路径
  ❓ OopMap bitmask + DebugInfo ScopeValue → 完整帧重建
  5.1 deopt 中 OopMap 消费和 GC 的对比
  5.2 OopMap + DebugInfo 的定位编号系统

§六 ★ OopMap 正确性 + 生产诊断
  ❓ OopMap 错了——少标记/多标记 oop 的后果
  ❓ -XX:+VerifyOops 的验证机制
  6.1 "bad oop" 的生产灾难——少标记→漏扫描→悬挂指针
  6.2 诊断：hs_err + VerifyOops + C2 bug report
  6.3 验证：GDB 断点观察 OopMap bitmask

§七 GDB 验证 + 可证伪断言 (≥10 条)
  断言 1: OopMapSet::add_gc_map() — 验证每个 safepoint 生成 OopMap
  断言 2: OopMap 的 bitmask size — 验证 < 20 bytes/safepoint
  断言 3: OopMapSet::find_map_at_offset() — 验证二分查找
  断言 4: OopMap::oops_do() — 遍历 oop 位置，打印每个 oop 地址
  断言 5: register block 的 oop 标记 — 验证 r15 不被标记
  断言 6: stack block 的 oop 标记 — 验证 local variables 的 oop 位置
  断言 7: 不 safepoint 处 find_map_at_offset 返回 NULL
  断言 8: VerifyOops 的检查 — 每个 oop 值的有效性
  断言 9: deopt 中 OopMap 消费的寄存器→解释器帧映射
  断言 10: OopMap 和 DebugInfo 的对应——同 PC offset 下 OopMap + DebugInfo 一致

§八 和 [01][05] 的交叉验证
  ❓ 01-Pipeline §八（Output 阶段——OopMap::add_gc_map）→ 06 OopMap 生成端
  ❓ 05-Deoptimization §五（deopt 中 OopMap 消费）→ 06 OopMap 消费端
```

## 六、写作要求

1. **★ Mermaid：OopMap 生成端 + 消费端的双向流程图**——标注编译端（SafePointNode→OopMap→nmethod）+ GC 端（PC→find_map_at_offset→bitmask→oops_do）
2. **★ "你需要知道的" 4 概念 callout 框**——OopMap/OopMapSet/OopMapValue/Safepoint 对应
3. **★ OopMapValue 流编码详解**——run-length encoding + content_type + location_number
4. **★ OopMap bitmask 的 ASCII 位布局图**——标注哪些 bit 是寄存器（0-15）、哪些是栈槽（16+）
5. **★ 面试 Story Format 答案**——"GC 怎么找到 JIT 代码中的 live oop？"
6. **★ OopMap 消费的两条路径对比：GC vs deopt**——哪些信息被消费、怎么消费、为什么两条路径不同
7. **★ "bad oop" 生产灾难的诊断 workflow**——hs_err→VerifyOops→定位出错 safepoint
8. **★ 交叉引用**：01 §八（OopMap 生成）、05 §五（OopMap 在 deopt 中消费）

## 七、输出格式

- Markdown 文件，命名为 `06-OopMap-GC-Roots.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/05-jit-compiler/`
- 元信息头：
  ```
  > **阶段**：[05-jit-compiler]
  > **前置**：[01-C2-Pipeline] §九（Output——PhaseOutput 中 OopMap 生成并嵌入 nmethod）。[05-Deoptimization] 将消费本文的 OopMap 进行帧重建——OopMap 是编译产物，独立于 deopt 存在。
  > **配套**：[04-CodeCache-Sweeper]（nmethod 存储 OopMapSet）、[05]（deopt 消费端）
  > **阅读收益**：理解 OopMap 是 JIT 和 GC 之间的"契约"——编译时生成 bitmask 编码 oop 位置、GC 时二分查找 bitmask 定位所有 oop root；掌握 "bad oop" GC crash 的诊断工作流
  ```

## 禁止行为

- ❌ 只讲 OopMap 结构不讲 GC 怎么消费——数据结构是"死"的，GC 的消费流程是"活"的
- ❌ 忽略编译端——OopMap 怎么被生成（SafePointNode→OopMapSet::add_gc_map）
- ❌ 不解释 bitmask 的 run-length encoding 压缩策略——只说"压缩"不给具体编码方式
- ❌ 不区分 GC 消费和 deopt 消费——两条路径的消费方式不同（GC 只需 oop vs non-oop，deopt 还需 type）
- ❌ 忽略 OopMap 正确性——"bad oop" 是生产灾难，必须有诊断 workflow
- ❌ 不解释 safepoint 和 OopMap 的一一对应——这是理解"为什么只在 safepoint 处有 OopMap"的关键
- ❌ 忘记和 [01]（OopMap 生成）和 [05]（OopMap 在 deopt 中消费）的连接

## 要求行为

- ✅ **★ Mermaid 双向流程图**——编译端 + GC 端 + deopt 端
- ✅ **★ "你需要知道的" 4 概念 callout 框**
- ✅ **★ OopMap bitmask 的 ASCII 位布局图**
- ✅ **★ OopMap 消费两条路径对比表**——GC vs deopt
- ✅ **★ "bad oop" 诊断 workflow**
- ✅ **★ 面试 Story Format 答案模板**
- ✅ **★ GDB 断言 ≥10 条**
- ✅ **★ 交叉引用 01 §八 + 05 §五 的精确 § 号**
