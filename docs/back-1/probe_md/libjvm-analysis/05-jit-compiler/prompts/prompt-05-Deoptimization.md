# PROMPT: 请撰写 05-Deoptimization.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Deoptimization — 从 C2 优化过的高效代码跳回解释器：何时、为什么、怎么实现**。

### 核心故事线（禁止做源码翻译机！）

200 deopt/s — GC 日志显示每 20ms 一个 deopt event。因为反射式框架每次使用不同子类——CHA 失效 → uncommon trap → deopt → 重编译 → 再次 uncommon trap → deopt。CPU 50% 在 deopt blob 中。

Deopt = 从 C2 优化过的高效代码跳回解释器。JVM 必须在栈上完整"重建"解释器帧——从 16 个 x86 寄存器中的随机值重建 Java 局部变量和操作数栈。OopMap 是关键的蓝图——它告诉 deopt engine "哪个寄存器/栈槽有哪个 Java 变量，什么类型"。

**读者前提**：从 [01-Pipeline] §八（编译完成——nmethod 构造 + OopMap 生成）和 [06-OopMap-GC-Roots] §X（OopMap 的结构——bitmask 记录哪些寄存器有 oop）进入本文。读者知道 OopMap 在每个 safepoint 处被生成，本文回答：**OopMap 在 deopt 时怎么被消费——怎么从 "寄存器值"重建"Java 帧"？**

### 你需要知道的（零 deopt 背景的工程师必须理解 4 个概念）

#### 概念 1：Deopt（去优化）

Deopt = "优化后的机器码 → 解释器"。当 C2 编译时基于的假设被打破（如 CHA 说"只有 1 个子类"，但新子类被加载）→ C2 的优化代码不再正确 → 必须回退到解释器。Deopt 不是 crash——它是有序的、可恢复的"回退"操作。

#### 概念 2：Uncommon Trap（罕见陷阱）

C2 编译时插入的 guard check 指令——如 `cmp [recv+klass], HashMap_Klass; jne uncommon_trap`。当 guard 失败时（执行了 jne）→ CPU 跳转到 DeoptimizationBlob 的入口 → 读取发生位置的信息（`UncommonTrapBlob` 是 DeoptimizationBlob 的一种）→ 执行去优化。

#### 概念 3：Frame Rebuild（帧重建）

Deopt 的核心操作：从 16 个 x86 寄存器和当前栈状态中重建一个**解释器帧**——每个局部变量放到正确的 slot、操作数栈的内容顺序排列、bcp 指到正确的字节码。Frame rebuild 读取 DebugInfo（ScopeValue 列表）→ 逐个 slot 按类型写入解释器帧。

#### 概念 4：OopMap Consumption（OopMap 消费）

OopMap 在编译时被生成（记录"此 safepoint 处哪些寄存器/栈槽有 oop"）。Deopt 时消费 OopMap——`OopMapSet::find_map_at_offset(pc_offset)` 查找当前位置的 OopMap → 遍历 bitmask → 为每个 oop 寄存器/栈槽调用 oop 处理函数（GC root 遍历）。

---

**本文是 05-jit-compiler 阶段的第 5 篇。前置：[01-Pipeline] §八（nmethod + OopMap 生成）、[06-OopMap-GC-Roots] §二（OopMap 结构——bitmask 编码）。读者知道 OopMap 在编译后被嵌入 nmethod，本文回答：OopMap 在 deopt 时怎么被读取来重建帧。配套：[02-Inline] §二（CHA 破灭→deopt 触发）、[04-CodeCache-Sweeper] §五（deopt→not_entrant）。**

### 核心叙事线 — "从 16 个寄存器重建 1 个 Java 帧"

1. **★★ Deopt 触发类型** — (a) Uncommon trap：C2 的优化假设破灭（CHA/type profile/null check）；(b) OSR deopt：OSR 编译的循环不再有效——回退到解释器的 loop entry；(c) Method deopt：JVMTI 强制的 deopt（PopFrame、ForceEarlyReturn）。
2. **★★★ Frame Rebuild：核心机制** — 读取 Deoptimization::UnrollBlock → 对每个帧重建 scope → 读取 DebugInfo 的 ScopeValue 列表 → 每个 ScopeValue = (location, type) → 从寄存器/栈槽读原始值 → 按 type 写入解释器帧。
3. **★ DeoptimizationBlob 执行流程** — unpack_uncommon_trap → unpack_reexecute → interpreter re-entry。两种路径：(a) uncommon_trap → 不重执行触发指令（它产生的值不能用）；(b) reexecute → 重执行触发指令（如 class loading 触发的 deopt——类加载后方法可以被内联了）。
4. **★★ OopMap 在 deopt 中的消费** — `OopMapSet::find_map_at_offset(pc_offset)` → 找到此 PC 的 OopMap → 遍历 bitmask → `frame::oops_do(OopClosure*)` → 为每个 oop 调用 GC 的 oop 闭包。
5. **★ Deopt 的代价** — deopt 本身：~1000 cycles（unroll pack + frame rebuild）。但更大的代价是 deopt 之后：方法回到解释器（慢 20-100×）→ CompileBroker 可能重编译（~100ms）→ 如果 deopt 循环发生 → CPU 崩溃。

### 验证报告
- `sverklo_search "deoptimization uncommon trap frame rebuild unroll_block"` → deoptimization.cpp
- `codegraph query "Deoptimization::fetch_unroll_info Deoptimization::unpack_frames"` → 核心函数
- `rg -n "fetch_unroll_info\|unpack_frames\|uncommon_trap\|reexecute\|UnrollBlock" deoptimization.cpp` → deopt 实现

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintDeoptimizationDetails`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:+TraceDeoptimization` 输出每次 deopt 的详细信息

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `deoptimization.cpp` | `src/hotspot/share/runtime/deoptimization.cpp` | runtime | `Deoptimization::fetch_unroll_info()`、`unpack_frames()`、`uncommon_trap()`、`UnrollBlock` | ★★★ 核心 deopt 逻辑 |
| 2 | `deoptimization.hpp` | `src/hotspot/share/runtime/deoptimization.hpp` | runtime | `Deoptimization` 类、`UnrollBlock` 结构、`DeoptReason` 枚举 | ★★ 接口定义 |
| 3 | `sharedRuntime.cpp` | `src/hotspot/share/runtime/sharedRuntime.cpp` | runtime | DeoptimizationBlob 的生成——`SharedRuntime::generate_deopt_blob()` | ★★ deopt blob 生成 |
| 4 | `frame_x86.cpp` | `src/hotspot/cpu/x86/frame_x86.cpp` | cpu/x86 | `frame::deoptimize()`、sender_for_compiled_frame in deopt context | ★★ 帧相关——平台专有 |
| 5 | `oopMap.cpp` | `src/hotspot/share/compiler/oopMap.cpp` | compiler | `OopMapSet::find_map_at_offset()`、`OopMap::oops_do()` | ★★ OopMap 消费 |
| 6 | `compile.cpp` | `src/hotspot/share/opto/compile.cpp` | opto | uncommon trap 的插入——`Compile::add_safepoint_edges()` | ★★ trap 生成处 |

**跨模块说明**：deopt 跨 runtime/（核心逻辑）+ cpu/x86/（平台帧重建）+ compiler/（OopMap 消费——OopMap 是编译器 artifact，在 compiler/ 模块中定义）。`deoptimization.cpp` 是主引擎——调用 `OopMapSet::find_map_at_offset()` 读取 OopMap → 调用 `frame::deoptimize()` 重建帧。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★ Deopt 触发类型

```
问题：
  ① 3 种 deopt 触发各为什么场景？
      线索: deoptimization.hpp DeoptReason 枚举
      答案方向:
        (a) Uncommon trap (DeoptReason::uncommon_trap): C2 的 guard check 失败——CHA 假设破灭、
        type profile 偏差、null check 未通过。这是频次最高的 deopt。
        (b) OSR deopt (DeoptReason::OSR_migration_fail): OSR 编译的循环的 entry condition 不再
        满足（如数组长度变化导致 OSR 代码假设的 loop bound 不成立）→ 回退到解释器重新进入循环。
        (c) Method deopt (DeoptReason::ForceDeoptTopFrame / PopFrame / ForceEarlyReturn):
        JVMTI 工具强制的 deopt——agent 调用 RetransformClasses 后立即 deopt 所有相关帧。
      追问: 哪个 deopt 的代价最大？→ Uncommon trap + 后续的重编译（因为假设破灭 → C2 会重编译
      不带 optimisitc assumption 的版本）。如果假设反复破灭 → deopt 循环 → 最大代价。

  ② Uncommon trap 和 reexecute 的区别？
      答案方向: Uncommon trap → 跳过了触发指令 → 不执行它（因为该指令产生的值基于"破灭的假设"——
      用它结果会错误）。 Reexecute → 重执行触发指令（因为该指令没问题——问题是调用上下文，
      如 class loading 完成后可以重新执行调用链）。Reexecute 少见——主要用于 class loading 触发的 deopt。
```

### 4.2 ★★★ Frame Rebuild：核心机制

```
问题：
  ① Deoptimization::UnrollBlock 是什么？包含哪些信息？
      线索: deoptimization.hpp UnrollBlock 结构
      答案方向: UnrollBlock 描述 "如何重建这个调用链上的所有帧"：(a) 每个帧的 frame_size（解释器帧的大小）；
      (b) 每个帧的 num_locals / num_expressions / num_monitors（帧内分区大小）；
      (c) 每个帧的 return address（deopt 完成后解释器从哪里继续执行）。UnrollBlock 是 fetch_unroll_info()
      的输出——它从 DebugInfo + nmethod metadata 中提取这些信息。

  ② unpack_frames() 如何从 16 个寄存器重建解释器帧？
      线索: deoptimization.cpp unpack_frames
      答案方向:
        1. 从执行栈（当前 RSP）开始向高地址方向遍历——为每个需重建的帧分配空间
        2. 对每个帧：读取 DebugInfo 的 ScopeValue 列表
        3. 对每个 ScopeValue：(location, type) → 如果 location = 寄存器 → 读寄存器的当前值；
           如果 location = 栈槽 → 读 [RSP + offset]
        4. 按 type 转换值（T_INT/T_LONG/T_OBJECT/T_FLOAT/T_DOUBLE）→ 写入新建的解释器帧的对应位置
        5. 设置解释器帧的 sender_sp、return address、bcp → 链成完整解释器帧链
      追问: 为什么需要 type 信息？→ 同一个寄存器的值可以是 int、oop、float → 写入解释器帧时需要
      不同的 slot 布局（int=1 slot, long=2 slot, oop=1 slot + GC header）。DebugInfo 提供 type，
      OopMap 提供 oop vs non-oop 区分。

  ③ 帧的重建顺序——从上到下还是从下到上？
      答案方向: 从最老的帧（caller）到最新的帧（callee）——先分配最老的帧 → 然后分配调用者的帧 → ...
      直到当前帧。栈是从高地址到低地址——所以先分配高地址（老帧），再分配低地址（新帧）。
      重建完成后，UNextendedSP 指向最老帧的底部，ExtendedSP 指向最新帧的栈顶。
```

### 4.3 ★ DeoptimizationBlob 执行流程

```
问题：
  ① DeoptimizationBlob 包含哪些 code blobs？
      线索: sharedRuntime.cpp generate_deopt_blob
      答案方向: DeoptimizationBlob 是一个 SingletonBlob → 包含 2 个入口：
      (a) unpack_uncommon_trap：从 uncommon trap 的 jne 跳转到此入口 → 读 trap 信息 →
      构建 UnrollBlock → unpack_frames() → jmp 到解释器的对应 bci。
      (b) unpack_reexecute：从 reexecute 路径进入 → 类似但 unpack_frames 后返回到触发指令的 bci（而不是跳过）。
      追问: DeoptimizationBlob 是共享的——所有 nmethod 共享同一个 blob？→ 是。DeoptimizationBlob 
      在 JVM 启动时创建一次，存储在 `SharedRuntime::deopt_blob()` 中。每个 nmethod 的 uncommon trap
      guard 的 jne 目标都是这个 blob 的入口。

  ② 从 nmethod 的 uncommon trap guard 到 DeoptimizationBlob 的跳转——怎么传递"这是哪个 trap"的信息？
      答案方向: nmethod 的 trap guard 紧前一条指令把 trap 原因 + bci 写入已知寄存器（如 rscratch1）。
      DeoptimizationBlob 入口的第一条指令读此寄存器 → 获得 trap 信息 → 传递给 fetch_unroll_info()。
      追问: 在 x86_64 上具体哪些寄存器？→ rscratch1/rscratch2（r10/r11）——这两个寄存器的值在
      正常执行时不保证保留（caller-saved），所以 trap guard 写入它们没有副作用。
```

### 4.4 ★★ OopMap 在 deopt 中的消费

```
问题：
  ① OopMapSet::find_map_at_offset(pc_offset) 怎么找到正确位置的 OopMap？
      线索: oopMap.cpp find_map_at_offset
      答案方向: nmethod 存储了 OopMapSet——一个数组 (pc_offset, OopMap) 对。find_map_at_offset
      做二分查找：在 OopMapSet 的 pc_offset 数组中找 >= pc_offset 的最小值 → 返回对应的 OopMap。
      如果找不到 → deopt 失败（说明此处没有 safepoint 记录——这是 C2 的 bug）。

  ② OopMap::oops_do(OopClosure*) 遍历 bitmask——deopt 中 GC 怎么用这个信息？
      答案方向: deopt 重建帧时，需要知道哪些寄存器/栈槽是 oop——因为 oop 需要被 GC 正确扫描。
      OopMap bitmask：bit 0-15 = 寄存器 r0-r15；bit 16+ = 栈槽。每个 bit = 1 → 此位置是 oop。
      oops_do() 遍历 bitmask → 对每个 oop 位置调用 OopClosure::do_oop() → GC 标记此 oop 为活跃。
      追问: deopt 帧重建过程中 OopMap 至少被消费几次？→ 至少 2 次：(1) deopt engine 读取 OopMap
      知道哪些值是 oop 以正确写入解释器帧；(2) GC 后续扫描解释器帧时重新遍历 OopMap 找到 oop root。
```

### 4.5 ★ Deopt 的代价与诊断

```
问题：
  ① Deopt 本身消耗多少 cycles？deopt 之后呢？
      答案方向: deopt 本身 ~1000 cycles（unroll pack + frame rebuild ~10μs @2GHz）。
      deopt 之后：(a) 方法回到解释器 → 慢 20-100×；(b) CompileBroker 有 deopt 反馈 → 可能重编译
      （~100ms）→ 重编译有不同策略——不带 optimisitc assumption。如果 deopt 循环 → 解释器 + 反复编译
      → CPU 50% 在编译和 deopt。
      追问: deopt 频率 > 10/s 就是问题 → deopt detailing 日志可查频率。

  ② -XX:+PrintDeoptimizationDetails 输出什么？怎么读？
      答案方向: 每次 deopt 打印：(a) deopt reason（uncommon_trap / OSR_migration_fail / etc.）；
      (b) method name + bci；(c) deopt 的 frame 数目；(d) trap 信息（为什么假设破灭？）。
      解读：如果同一方法反复 deopt（recompile 后再次 deopt）→ 该类层次不稳定 → CHA 错误 → 需修复代码。
```

### 4.6 ★ Deopt 循环——生产中的"死循环"

```
问题：
  ① deopt→recompile→deopt 的循环怎么形成？怎么打破？
      答案方向:
        形成: 反射式框架每次用不同子类 → CHA 说"只有 A" → C2 编译 → A 的方法被内联 → 
        然后 B 类出现 → uncommon trap → deopt → C2 重新编译但不假设单态 → 然后 C 类出现 →
        又 uncommon trap → deopt。
        打破: (a) -XX:CompileCommand=exclude,problematicMethod → 永远解释执行；
        (b) -XX:PerMethodTrapLimit=100 → 限制每个方法的 trap 次数 → 超过后不编译；
        (c) 重构 Java 代码——把 polymorphic dispatch 写成显式的 if-else 链而不是
        依赖 C2 的 speculative inlining。
```

## 五、文章结构

```
§〇 生产场景 — deopt 风暴 + CPU 50% 在 deopt blob
  ★ 真实 deopt 日志：200 deopt/s → 每 20ms 1 次
  ★ 10 分钟诊断：PrintDeoptimizationDetails → 定位 deopt 方法 → 修复

Actual -XX:+PrintDeoptimizationDetails output:

```
Uncommon trap happened in java.util.HashMap::putVal
  @ 42 java.util.HashMap::hashCode (5 bytes)
  reason: class_check
  action: maybe_recompile
  trap_request: 5
```

Reading deopt output:
- "@ 42 java.util.HashMap::hashCode" = the call site at bytecode offset 42 was compiled with a CHA guard that assumed a specific receiver class
- "reason: class_check" = at runtime, the guard failed — the receiver's class was NOT the one C2 expected. This is a CHA invalidation.
- "action: maybe_recompile" = C2 will attempt recompilation with updated profile data, BUT only if this doesn't happen too many times (SpecTrapLimit prevents recompile loops)
- "trap_request: 5" = the deopt reason bitmask: reason_class_check = bit 2 (value 4) + action_maybe_recompile = bit 0 (value 1) = 5
- If you see the same method repeatedly in this output → CHA assumption keeps breaking → deopt→recompile→deopt loop → CodeCache + CPU crisis

§一 ★★★ Deopt 全貌 — 为什么 Java 需要"回退到解释器"？
  ❓ 如果 Java 不需要 deopt——C2 会失去什么优化？
  ❓ deopt 是 "cost paid later" ——运行时成本的量化
  1.1 ★ Mermaid：从 nmethod guard 到 interpreter re-entry 的完整路径
  1.2 ★ 面试 Story Format 答案：deopt 是什么？什么时候发生？
  1.3 和 [01-Pipeline] §八（nmethod 有 uncommon trap guard）的连接

§二 ★★ Deopt 触发类型（3 种）
  ❓ uncommon trap vs OSR deopt vs method deopt 的区别
  ❓ 哪种最常见？哪种代价最大？
  2.1 Uncommon trap — CHA/type profile/null check 假设破灭
  2.2 OSR deopt — 循环条件不再满足
  2.3 Method deopt — JVMTI PopFrame/ForceEarlyReturn

§三 ★★★ Frame Rebuild — 核心机制
  ❓ 16 个寄存器 → 1 个解释器帧：怎么重建？
  ❓ ScopeValue 列表和 OopMap 在重建中的分工
  3.1 UnrollBlock 结构 — 重建蓝图
  3.2 unpack_frames() 的逐步实现
  3.3 ★ 帧重建顺序——从老到新
  3.4 DebugInfo 的 ScopeValue → type + location → 解释器帧 slot

§四 ★ DeoptimizationBlob 执行
  ❓ 所有 nmethod 共享同一个 DeoptimizationBlob？
  ❓ uncommon trap 的 jne 怎么跳到 DeoptimizationBlob？
  4.1 unpack_uncommon_trap vs unpack_reexecute 两条路径
  4.2 DeoptimizationBlob 的生成——SharedRuntime::generate_deopt_blob()
  4.3 trap 信息传递——rscratch1/rscratch2 的角色

§五 ★★ OopMap 在 deopt 中的消费
  ❓ OopMap 被读取几次？每步用途？
  ❓ find_map_at_offset() 的二分查找
  5.1 OopMap bitmask → oop 标记
  5.2 oops_do() → GC closure → oop root 遍历
  5.3 和 [06-OopMap-GC-Roots] §X 的连接——OopMap 结构

§六 ★★ Deopt 循环 — 生产诊断 + 修复
  ❓ deopt→recompile→deopt 怎么形成？
  ❓ 怎么监控？怎么打破？
  6.1 生产诊断：PrintDeoptimizationDetails + deopt 频率
  6.2 修复：CompileCommand exclude + PerMethodTrapLimit
  6.3 deopt 循环对 CodeCache + CPU 的影响

§七 GDB 验证 + 可证伪断言 (≥10 条)
  断言 1: fetch_unroll_info() — 打印 deopt reason + method name + bci
  断言 2: unpack_frames() — 验证帧重建前后的栈布局
  断言 3: UnrollBlock 的 frame_size 列表
  断言 4: OopMapSet::find_map_at_offset() — 验证 OopMap 查找
  断言 5: OopMap::oops_do() — 遍历 oop 位置
  断言 6: DeoptimizationBlob 入口 — 验证所有 trap 跳转到同一 blob
  断言 7: uncommon_trap 的 jne 目标 — 验证跳转到 DeoptimizationBlob
  断言 8: unpack_reexecute 路径 — 验证 return 到触发指令
  断言 9: deopt 后 method->from_compiled_entry 的变化
  断言 10: PrintDeoptimizationDetails 输出验证 — 与 GDB 信息一致

§八 和 [01][04][06] 的交叉验证
  ❓ 01-Pipeline §八（nmethod + uncommon trap guard）→ 05 deopt 触发
  ❓ 04-CodeCache-Sweeper §五（deopt→not_entrant）→ 05 deopt 触发→nmethod 生命周期
  ❓ 06-OopMap-GC-Roots §二（OopMap bitmask 结构）→ 05 deopt 中的 OopMap 消费
```

## 六、写作要求

1. **★ Mermaid deopt 完整路径图**——从 nmethod guard jne → DeoptimizationBlob → UnrollBlock → unpack_frames → interpreter re-entry
2. **★ "你需要知道的" 4 概念 callout 框**——Deopt/Uncommon Trap/Frame Rebuild/OopMap Consumption
3. **★ 面试 Story Format 答案**——§ 一末尾："去优化是什么？什么时候发生？"
4. **★ Frame Rebuild 的逐步分解**——ScopeValue 列表→寄存器→解释器帧的映射
5. **★ Deopt 代价的量化**——deopt 本身 ~1000 cycles + 重编译 ~100ms + 解释器退化的倍率
6. **★ Deopt 循环的诊断+修复**——PrintDeoptimizationDetails→定位→CompileCommand exclude
7. **★ GDB 断点**——fetch_unroll_info、unpack_frames、OopMapSet::find_map_at_offset
8. **★ 交叉引用**：01 §八（trap guard）、04 §五（deopt→not_entrant）、06 §二（OopMap bitmask）

## 七、输出格式

- Markdown 文件，命名为 `05-Deoptimization.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/05-jit-compiler/`
- 元信息头：
  ```
  > **阶段**：[05-jit-compiler]
  > **前置**：[01-C2-Pipeline] §八（nmethod + uncommon trap guard）、[06-OopMap-GC-Roots] §二（OopMap bitmask 结构）
  > **配套**：[02-Inline-Decision] §二（CHA 破灭→deopt 触发）、[04-CodeCache-Sweeper] §五（deopt→not_entrant）
  > **阅读收益**：理解 Java 的"回退机制"——从 C2 优化代码回到解释器的完整过程；掌握 Frame Rebuild 原理（ScopeValue + OopMap → 解释器帧）；能用 PrintDeoptimizationDetails 诊断 deopt 风暴
  ```

## 禁止行为

- ❌ 把 deopt 解释成"crash"或"异常"——deopt 是有序的、可恢复的、设计好的回退操作
- ❌ 忽略 UnrollBlock 的结构——只说"重建帧"不说 UnrollBlock 的蓝图作用
- ❌ 不解释 ScopeValue 的类型信息来源——DebugInfo 不是 OopMap，两者存储不同的信息
- ❌ 不解释 uncommon trap 和 reexecute 的区别——两条路径的产物不同
- ❌ 忽略 deopt 循环的生产影响——这是 JVM 线上最严重的性能问题之一
- ❌ 不做 deopt 代价的量化——~1000 cycles deopt + ~100ms recompile + 解释器退化 20-100×
- ❌ 忘记和 [01]（trap guard）和 [06]（OopMap）的连接

## 要求行为

- ✅ **★ Mermaid deopt 完整路径图**
- ✅ **★ "你需要知道的" 4 概念 callout 框**
- ✅ **★ Frame Rebuild 的逐步代码走读**
- ✅ **★ 面试 Story Format 答案模板**
- ✅ **★ Deopt 代价量化表**
- ✅ **★ Deopt 循环诊断+修复 workflow**
- ✅ **★ GDB 断言 ≥10 条**
- ✅ **★ 交叉引用 01 + 04 + 06 的精确 § 号**
