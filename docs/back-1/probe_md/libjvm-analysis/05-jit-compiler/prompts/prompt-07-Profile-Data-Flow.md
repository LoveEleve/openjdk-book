# PROMPT: 请撰写 07-Profile-Data-Flow.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Profile 数据流 — C1→MethodData→ci/ 层→C2 的完整数据管道：C2 怎么读取 C1 收集的类型 profile、调用计数和分支 profile**。

### 核心故事线（禁止做源码翻译机！）

C2 内联了 HashMap::hash() 所有 6 个 callee——CodeCache 爆满。因为 C1 的 type profile 说"99% calls receiver is HashMap"。但 profile 是在 WARMUP 期间收集的——生产稳态的 receiver mix 完全不同。Profile 污染 → C2 做出错误的内联决策 → 2MB nmethod → CodeCache full。

C2 不是瞎子——它透过 ci/ 目录读取 C1 编译器收集的 profile 数据。每次 invokevirtual 调用：C1 记录"这个方法被调用了 N 次，receiver klass 是 X Y% 时间"。ciMethod/ciKlass/ciCallProfile = C2 的"市场调研"。

**读者前提**：从 [02-Inline-Decision] §二（CHA——静态类层次分析）和 §三（Type Profile——动态运行时数据）进入本文。读者知道 C2 内联时使用 CHA 和 type profile 来决定内联决策，本文回答：**type profile 从哪来？C1 怎么收集？MethodData 怎么存储？ci/ 层怎么包装给 C2？从 C1 执行到 C2 内联的完整数据流是什么？**

### 你需要知道的（零 profile 数据背景的工程师必须理解 5 个概念）

#### 概念 1：MethodData（MDO = Method Data Object）

MethodData 是 C1（L2/L3 编译级别）在执行时收集的运行时数据——存储在方法体后的内存中。包含：invocation counter（此方法被调用次数）、backedge counter（循环回边次数）、call site profiles（每次 invokevirtual 的接收者类型统计）、branch profiles（if/else 分支的 taken/not-taken 计数）。大小：通常 ~1-5KB/method。

#### 概念 2：ci/（Compiler Interface）

ci/ 目录 = JVM 内部数据结构（Method*/InstanceKlass*/ConstantPool* NP）→ C2 可读取的**只读包装**。因为 C2 在编译线程上执行（非 safepoint），不能直接访问 JVM 的可变数据结构（可能被 GC 修改）。ciMethod/ciKlass/ciCallProfile 是 C2 的"安全视图"——它们缓存编译时的快照，编译期间不变。

#### 概念 3：ciMethod

ciMethod = C2 眼中的"方法"。包含：(a) Method* pointer（只读引用）；(b) MethodData* pointer（profile 数据）；(c) bytecode stream（字节码）；(d) exception handler table。C2 通过 ciMethod::instructions_size() 做 inline 大小检查，通过 ciMethod::has_compiled_code() 判断是否已有编译版本。

#### 概念 4：ciCallProfile

ciCallProfile = 一个调用点的 profile 快照。`ciCallProfile(ciMethod* callee, int bci)` 构造函数从 MethodData 中读取 bci 处的调用数据 → `count()` = 总调用次数（counter_count + data_count），`receiver_count(i)` = 第 i 个接收者类型被观测到的次数。C2 用 receiver_count 做单态/多态判断。

#### 概念 5：Profile Maturity（profile 成熟度）

MethodData 需要"足够的数据"才能被信任。`MethodData::profile_maturity()` 检查：invocation_count >= MatureInvocationLimit(500) 或 backedge_count >= MatureInvocationLimit 且所有 call site 有足够数据。未成熟的 profile → C1-only 编译 → 不给 C2 编译（防止基于偏差数据做错误决策）。

---

**本文是 05-jit-compiler 阶段的第 7 篇。前置：[02-Inline-Decision] §二（CHA）和 §三（Type Profile——C2 消费端）。读者知道 C2 用 type profile 做内联决策，本文回答：type profile 从哪来——C1→MethodData→ci→C2 的完整数据管道。配套：[01-Pipeline] §二（Parse 用 ciMethod 读取方法信息）、[02]（InlineTree 用 ciCallProfile 做内联决策）。**

### 核心叙事线 — "从 C1 采集到 C2 消费的完整数据管道"

1. **★★ MethodData：C1 的"数据采集器"** — `Method::method_data()` 返回 `MethodData*`。C1 在每次解释器执行/编译执行时更新 MethodData：invocation_counter 递增（触发编译）、call site 的 receiver type 计数器递增、branch 的 taken/not-taken 计数器递增。MethodData 存储在方法体后、在 GC 的 oop 扫描外（它是 C++ heap 不是 Java heap）。

2. **★★ ciMethod：C2 的"安全视图"** — ciMethod 是 C2 层对 Method 的包装。构造时快照 Method* + MethodData* + bytecodes + exception handlers——编译期间此快照不变（即使其它线程修改 MethodData）。ciMethod 提供高层 API：`instructions_size()`（inline 大小检查）、`has_compiled_code()`（是否已有编译版本）。

3. **★★★ ciCallProfile：调用点的 profile 快照** — `ciCallProfile(ciMethod* callee, int bci)` 读取 MethodData 中 bci 的 call site 数据 → `count()` = invocation 总数（考虑 counter decay）→ `receiver_count(0)` = 最常见接收者次数。C2 内联决策：如果 receiver_count(0) / count() > 90% → 单态内联 + guard；如果 < 50% → polymorphic dispatch（不做 speculative inlining）。

4. **★ ciTypeFlow：类型传播** — `ciTypeFlow::flow_types()` 在 C2 Parse 之前做一版类型分析（类似 C1 的 SEAF）。为每个 bci 计算类型信息 → 这个信息被 Parse 用来确定 Node::bottom_type() → 影响 IGVN 的类型优化。例如：如果 ciTypeFlow 分析出某处局部变量一定是 `String` → Parse 把常量类型写入 Node → IGVN 可以用它消除 virtual dispatch。

5. **★ ciKlass：类层次信息** — ciKlass 包装 InstanceKlass。提供 CHA 信息：`is_leaf_type()`、`subklass_of()`、`is_loaded()`。C2 内联时用 ciKlass 判断 invokevirtual 是否可以单态化。ciKlass 也缓存类层次关系——编译期间不变。

6. **★★ Profile Maturity 审查** — `MethodData::profile_maturity()` → 如果 profile 不够成熟 → 不给 C2 编译 → 防止被"warmup 偏差"误导。MatureInvocationLimit（默认 500）= 500 次调用或足够 backedge 后 → profile 才被认为是"成熟的"。未成熟时只有 C1 L3 编译（继续收集 profile）→ 成熟后 C2 编译。

### 验证报告
- `sverklo_search "ciMethod ciKlass ciCallProfile methodData profile maturity ci"` → ci/ 目录
- `codegraph query "ciMethod::ciMethod ciCallProfile::ciCallProfile MethodData::profile_maturity"` → 核心函数
- `rg -n "ciMethod\|ciKlass\|ciCallProfile\|MethodData\|profile_maturity\|receiver_count\|instructions_size" ci/` → CI 层实现

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintCompilation -XX:+PrintInlining`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ Tiered compilation 开启（C1 L2/L3 收集 profile → C2 编译时消费）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `methodData.hpp` | `src/hotspot/share/oops/methodData.hpp` | oops | `MethodData` 类、`DataLayout`、`ProfileData`、`ReceiverTypeData`、`invocation_counter()` | ★★★ 原始 profile 存储 |
| 2 | `methodData.cpp` | `src/hotspot/share/oops/methodData.cpp` | oops | `MethodData::invocation_counter_inc()`、`profile_maturity()`、`receiver_type_data()` | ★★★ MDO 更新 + 成熟度检查 |
| 3 | `ciMethod.cpp` | `src/hotspot/share/ci/ciMethod.cpp` | ci | `ciMethod::ciMethod()`(构造器)、`instructions_size()`、`has_compiled_code()`、`should_inline()` | ★★★ C2 的方法视图 |
| 4 | `ciMethod.hpp` | `src/hotspot/share/ci/ciMethod.hpp` | ci | `ciMethod` 类定义 | ★★ 接口定义 |
| 5 | `ciCallProfile.hpp` | `src/hotspot/share/ci/ciCallProfile.hpp` | ci | `ciCallProfile::ciCallProfile()`(构造器)、`count()`、`receiver_count()` | ★★★ C2 的调用点视图 |
| 6 | `ciKlass.hpp` | `src/hotspot/share/ci/ciKlass.hpp` | ci | `ciKlass` 类、`is_leaf_type()`、`subklass_of()`、`is_loaded()` | ★★ CHA 类层次信息 |
| 7 | `ciKlass.cpp` | `src/hotspot/share/ci/ciKlass.cpp` | ci | ciKlass 构造 + 方法实现 | ★★ CHA 实现 |
| 8 | `ciTypeFlow.cpp` | `src/hotspot/share/ci/ciTypeFlow.cpp` | ci | `ciTypeFlow::flow_types()`——C1-style SEAF 在 CI 层的重做 | ★★ 类型传播分析 |
| 9 | `doCall.cpp` | `src/hotspot/share/opto/doCall.cpp` | opto | `InlineTree::should_inline()` — ciCallProfile 的消费端 | ★★ Profile 消费端 |

**跨模块说明**：profile 数据流横跨 oops/（MethodData 原始存储）+ ci/（C2 可读的包装层）+ opto/（消费端：InlineTree / Parse）。ci/ 层是 JVM 数据结构→C2 编译器的"安全接口"——保证编译期间数据的不可变性。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★ MethodData：C1 的数据采集器

```
问题：
  ① MethodData 存储了什么数据？布局是什么？
      线索: methodData.hpp MethodData 类 + DataLayout
      答案方向: MethodData = header + DataLayout 数组。每个 DataLayout = 一个"槽"——存储一种 profile 数据。
      槽类型：(a) invocation_counter_entry（方法调用计数器——触发 JIT 编译）；(b) backedge_counter_entry
      （循环回边计数器——触发 OSR 编译）；(c) ReceiverTypeData（每个 invokevirtual 的接收者类型统计——
      包含 N=2-4 个 (klass, count) 对）；(d) BranchData（if/else 的 taken/not-taken 计数）；
      (e) MultiBranchData（tableswitch/lookupswitch 的 case 分布）。
      追问: 为什么限制 receiver type 只记录 2-4 个？→ 空间限制——MethodData 存在方法体后，太大浪费内存。
      2 个最常见的 receiver 足以判断单态/双态；≥3 个 receiver → 判定为 polymorphic → 不做 speculative inlining。

  ② C1 怎么更新 MethodData？C1 编译代码中的"profile 写入"是怎么做的？
      答案方向: C1 L2/L3 编译的方法插入"profile 更新指令"——每次 invokevirtual 执行前：`__ increment
      MethodData at bci offset` → 增加 receiver type 计数器。每次 if/else 执行后：更新 branch 计数器。
      Profile 更新指令是轻量的——~5 x86 指令（load MethodData base + offset + increment + store）。
      解释器执行（Level 0）不写 profile——只有 C1 L2/L3 执行时写入 MethodData。
```

### 4.2 ★★ ciMethod：C2 的方法视图

```
问题：
  ① ciMethod 和 Method 的关系——为什么 C2 不能直接读 Method？
      答案方向: Method 是 JVM 的可变数据结构——字段可能在 C2 编译期间被修改（如 set_code() 替换 nmethod、
      redefine 修改方法体）。C2 在编译线程上执行（非 safepoint、非 VMThread）→ 直接读 Method 会导致
      看到中间状态。ciMethod 在构造时**快照**Method 的编译相关字段（bytecodes、exception handlers、
      MethodData*）→ 编译期间此快照不变——C2 看到的是一致的数据。
      追问: ciKlass 同理——InstanceKlass 的 vtable/itable 在 redefine 时会变 → ciKlass 快照。

  ② ciMethod::instructions_size() 怎么使用？为什么对 inline 决策重要？
      答案方向: instructions_size() = 字节码条数。InlineTree::should_inline() 第 4 步检查：
      `callee->code_size() > MaxInlineSize(35)` → 太大 → 拒绝内联。如果 code_size 从错误的 state 读取
      （如 redefine 进行中）→ 可能做了错误的 inline 决策 → deopt 或 CodeCache 爆炸。
      ciMethod 的快照确保 code_size 在编译期间不变。

  ③ ciMethod 的生命周期——什么时候被创建、什么时候被销毁？
      答案方向: 在 C2 编译开始时创建（`Compile::Compile()` 构造器）→ 存入 `Compile::method()` →
      编译过程中被 Parse/IGVN/Inline/Matcher/RegAlloc 等阶段读取 → 编译结束时（Compile 析构）销毁。
      每个 C2 编译任务（CompileTask）创建自己的 ciMethod 实例——不同编译任务的 ciMethod 互相独立。
```

### 4.3 ★★★ ciCallProfile：调用点的 profile 快照

```
问题：
  ① ciCallProfile::ciCallProfile(ciMethod* callee, int bci) 怎么从 MethodData 读取数据？
      线索: ciCallProfile.hpp 构造器
      答案方向: 构造器：(a) 从 callee 的 ciMethod→MethodData 中查找 bci 处的 DataLayout；
      (b) 如果找到 ReceiverTypeData → 读取 count = invocation_count + data_count（考虑 counter decay）；
      (c) 提取 receiver_count(i) = 第 i 个 receiver 的次数 → 排序（最频繁的在前）；
      (d) 如果找不到 DataLayout → profile 数据为空 → count = 0 → 不做 profile-based inline。
      追问: counter_count + data_count 为什么是两数之和？→ counter_count = 从 method entry 到
      第一次更新 MethodData 期间的计数（原始 invocation counter），data_count = 写入 MDO 后的计数。
      C2 用两者之和作为总调用次数。

  ② receiver_count(0) / count() > 90% → C2 做什么决策？
      答案方向: 90% 阈值 → 单态化——内联最常见接收者的方法 + guard check for 其他 10%：
        if (recv.klass == HashMap_Klass) {
          // 内联 HashMap::hashCode()
        } else {
          // guard 失败 → uncommon_trap → deopt → 解释器
        }
      追问: 如果 receiver_count(0) / count() < 50% → 怎么办？→ polymorphic 场景 → 不做
      speculative inlining → 走真实的 vtable dispatch（invokevirtual）→ 仍然比解释器快
      （vtable dispatch = 2 条 x86 指令），但没有内联的瀑布效应收益。

  ③ ciCallProfile 的"counter decay"是怎么回事？
      答案方向: Counter decay = 旧 profile 数据的"衰减"。MethodData 的计数器是"半衰"的——
      每隔一段时间（safepoint 时）把计数器的值除以 2 → 旧的 profile 慢慢消逝，新的 profile 权重更大。
      应对：应用的 phase 变化（warmup→steady→peak）→ warmup 期间的 profile 不应该永远影响 C2 决策。
      追问: 如果 decay 过于激进→ 计数器永远达不到成熟度阈值 → 永远 C1 编译 → 性能退化。
```

### 4.4 ★ ciTypeFlow：类型传播分析

```
问题：
  ① ciTypeFlow::flow_types() 为什么需要？C2 Parse 不能自己分析吗？
      答案方向: C2 Parse 能自己做类型分析（通过 Node::bottom_type()），但 Parse 时期图还没建成——
      类型信息不完整。ciTypeFlow 在 Parse 之前做一版快速分析——类似 C1 的 SEAF（Semi-pruned SSA with
      Exception handling And Flow-sensitive），计算每个 bci 处每个局部变量和表达式栈元素的类型。
      结果传给 Parse → Parse 用准确的类型初始化 Node::bottom_type() → 避免 Parse 阶段做保守假设。

  ② ciTypeFlow 的类型分析比 C2 的类型分析保守还是精确？
      答案方向: ciTypeFlow 更保守——它用"简单/快速"的算法（no loop unrolling, no inlining, no 
      inter-procedural analysis）在 ~2ms 内计算出"足够好"的类型信息。C2 的后续类型分析（Ideal/IGVN）
      可以在这个基础上精化。ciTypeFlow 的目的是：给 Parse 一个"接近正确"的初始类型，减少后续 IGVN
      的迭代次数。追问: 如果 ciTypeFlow 错了？→ C2 后续优化会纠正，所以不影响正确性，只影响编译时间。
```

### 4.5 ★★★ Profile Maturity + Profile 污染

```
问题：
  ① MethodData::profile_maturity() 的检查条件是什么？
      线索: methodData.cpp profile_maturity
      答案方向: (a) invocation_count >= MatureInvocationLimit(500) → 成熟；(b) backedge_count >= 
      MatureInvocationLimit AND 所有 call site 有足够的 receiver data（每个 call site 记录了 ≥2 个 receiver）
      → 成熟；(c) 否则 → 不成熟 → C2 编译被推迟 → 只有 C1 L3 编译（继续收集 profile）。
      追问: 为什么 backedge 也能触发成熟？→ 循环密集的方法——invocation_count 低（只调用 1 次）但
      backedge 高（循环内重复执行）→ 同样需要 profile 数据来优化循环体。

  ② Profile 污染——C1 收集了"错的" profile，C2 基于它做了错误决策。最常见的污染模式？
      答案方向: (a) Warmup 偏差：启动前 10 次调用都是 type A → profile 说 "100% A"→ C2 内联 A →
      稳态流量 50% B → deopt 风暴；(b) 采样偏差：profile 的 receiver type 只记录 2-4 个——
      如果真正的 receiver 是第 5 种类型 → 它不被记录 → profile 看不见 → C2 基于"只有 4 种"做决策；
      (c) 单次事件污染：1 次异常代码路径（通常不走的分支）被 C1 记录 → profile 说此分支 50% 被 taken
      → C2 为这个分支做了优化 → 实际上是 0.1% 的路径 → 浪费 CodeCache。
      追问: 怎么修复？→ 重启 JVM 或 -XX:PerMethodRecompilationCutoff=400 限制重编译次数。

  ③ -XX:TieredStopAtLevel=3（禁止 C2 编译）为什么能"修复" profile 污染？
      答案方向: TieredStopAtLevel=3 = 只做 C1 L3 编译（full profile + 低优化）。C1 L3 的内联
      策略比 C2 保守——不做基于 speculative assumption 的 deep inline。所以即使 profile 被污染→
      也只影响 C1 L3 的 mild optimization → 不会导致 CodeCache 爆炸。代价：失去 C2 的深度优化 → 
      峰值性能降低 ~20-30%。这是"安全阀"——暂时缓解 profile 污染问题，同时给 C1 更多时间收集更好的 profile。
```

## 五、文章结构

```
§〇 生产场景 — Profile 污染→C2 错误内联→CodeCache 爆炸
  ★ C1 profile 说 "99% HashMap" → 内联了所有 6 个 callee → 2MB nmethod
  ★ 真实流量 30% TreeMap → deopt 风暴 → CodeCache full
  ★ 诊断：PrintInlining + PrintDeoptimizationDetails

§一 ★★★ Profile 数据流全景 — C1→MDO→ci→C2 的 4 层管道
  ❓ 为什么需要 ci/ 层？C2 不能直接读 MethodData？
  ❓ 每一层的"不可变性"保证——为什么在编译期间数据快照？
  1.1 ★ Mermaid：4 层数据流图——C1 写入 MDO → ci 包装 → C2 Parse/Inline 消费
  1.2 ★ 面试 Story Format 答案：C2 怎么读取 C1 的 profile 数据？
  1.3 和 [02-Inline] §二/§三 的连接——C2 消费端

§二 ★★ MethodData — C1 的数据采集器
  ❓ MDO 的存储布局——DataLayout 数组 + 槽类型
  ❓ C1 编译代码中的 profile 更新指令
  2.1 MethodData 头 + DataLayout[ ]
  2.2 invocation_counter / backedge_counter / ReceiverTypeData / BranchData
  2.3 ★ C1 的 profile 更新——~5 条 x86 指令

§三 ★★ ciMethod — C2 的方法视图
  ❓ 为什么 C2 需要 ciMethod 而不是直接读 Method？
  ❓ ciMethod 快照了什么字段？
  3.1 ciMethod 构造器——快照 Method* + MethodData* + bytecodes
  3.2 ciMethod::instructions_size() —— inline 大小检查
  3.3 ciMethod 的生命周期——创建→使用→销毁

§四 ★★★ ciCallProfile — 调用点的 profile 快照
  ❓ 构造器怎么从 MethodData 中提取 bci 处的调用数据？
  ❓ receiver_count(0) / count() > 90% → 单态决策
  4.1 ciCallProfile 构造器——查找 DataLayout → 提取 count + receiver
  4.2 ★ receiver_count vs counter_count + data_count
  4.3 counter decay 机制——旧数据半衰

§五 ★ ciTypeFlow — 类型传播分析
  ❓ 为什么需要 ciTypeFlow？和 C2 的类型分析什么关系？
  ❓ SEAF 分析在 CI 层的实现
  5.1 ciTypeFlow::flow_types() → 类型信息→Parse
  5.2 ciTypeFlow 的保守性 vs C2 的精化

§六 ★★ ciKlass — 类层次信息
  ❓ ciKlass 为 CHA 提供了什么查询？
  ❓ is_leaf_type / subklass_of —— C2 的 CHA 依赖
  6.1 ciKlass 构造——快照 InstanceKlass 的层次关系
  6.2 is_leaf_type() + subklass_of() 的 CHA 应用

§七 ★★★ Profile Maturity + Profile 污染
  ❓ MethodData::profile_maturity() 的 3 个条件
  ❓ Profile 污染的 3 种模式 + 诊断 + 修复
  7.1 成熟度检查——MatureInvocationLimit=500
  7.2 ★ Profile 污染：Warmup 偏差、采样偏差、单次事件污染
  7.3 修复：重启 JVM + TieredStopAtLevel=3 + PerMethodRecompilationCutoff

§八 GDB 验证 + 可证伪断言 (≥10 条)
  断言 1: MethodData::invocation_counter_inc() — 调用计数器递增
  断言 2: MethodData::profile_maturity() — 成熟度检查
  断言 3: ciMethod::ciMethod() — 快照 Method* + 字段
  断言 4: ciCallProfile::ciCallProfile() — 打印 receiver_count(0) / count()
  断言 5: receiver_count(0) / count() > 90% — 验证单态决策被采用
  断言 6: ciTypeFlow::flow_types() — 打印 bci 处的类型信息
  断言 7: ciKlass::is_leaf_type() — 类层次检查
  断言 8: counter decay 在 safepoint 时——计数器减半
  断言 9: TieredStopAtLevel=3 时 C2 编译不被触发
  断言 10: ciCallProfile 为空时（无 profile）→ count() = 0

§九 和 [01][02] 的交叉验证
  ❓ 01-Pipeline §二（Parse 用 ciMethod 读取方法 body）→ 07 ciMethod 端
  ❓ 02-Inline §二/§三（CHA + type profile → C2 消费端）→ 07 ciCallProfile 端
```

## 六、写作要求

1. **★ Mermaid：4 层数据流图**——C1 写入 MDO → ciMethod/ciKlass/ciCallProfile 包装 → C2 Parse/Inline 消费。标注每层的数据结构 + 访问方法
2. **★ "你需要知道的" 5 概念 callout 框**——MethodData、ci/、ciMethod、ciCallProfile、Profile Maturity
3. **★ ci/ 层的设计理由**——为什么 C2 不能直接读 JVM 数据结构？不可变性保证 + 线程安全性
4. **★ Profile 污染的 3 种模式**——warmup 偏差、采样偏差、单次事件污染——生产案例 + 诊断 + 修复
5. **★ Profile Maturity 的 3 条件判断**——invocation_count / backedge_count / call site 数据
6. **★ 面试 Story Format 答案**——§ 一末尾："C2 怎么读取 C1 的 profile？ci/ 层做什么？"
7. **★ GDB 断点**——ciCallProfile 构造器：打印 receiver_count + count、ciMethod::instructions_size、MethodData::profile_maturity
8. **★ 交叉引用**：01 §二（Parse 用 ciMethod）、02 §二/§三（Inline 用 CHA + type profile）

## 七、输出格式

- Markdown 文件，命名为 `07-Profile-Data-Flow.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/05-jit-compiler/`
- 元信息头：
  ```
  > **阶段**：[05-jit-compiler]
  > **前置**：[02-Inline-Decision] §二（CHA——静态类层次分析）+ §三（Type Profile——C2 消费端）
  > **配套**：[01-C2-Pipeline] §二（Parse 用 ciMethod 读取方法信息）
  > **阅读收益**：理解 C1→MethodData→ci/→C2 的完整 profile 数据管道；掌握 ciMethod/ciKlass/ciCallProfile 的 C2 内联决策基础；能用 profile maturity 和 profile 污染诊断修复生产性能回归
  ```

## 禁止行为

- ❌ 只讲 ciMethod/ciKlass 不讲 MethodData——MethodData 是 profile 数据的原始存储，ci 是包装层
- ❌ 不讲 Profile Maturity——这是防止 profile 污染的"第一道防线"，必须在 § 一 callout 框覆盖
- ❌ 不解释 ci/ 层为什么需要不可变快照——C2 不能直接读 JVM 数据结构的原因（编译线程 + 并发修改）
- ❌ 忽略 counter decay 机制——旧 profile 数据的半衰是理解"为什么 profile 有时不准"的关键
- ❌ 不做 Profile 污染的生产案例——必须用"warmup 偏差"的具体数字说明 profile 污染的严重性
- ❌ 不解释 ciTypeFlow——Parse 之前的类型分析是 C2 的独特设计，不解释即漏掉"为什么 Node::bottom_type 开始就准确"
- ❌ 忘记和 [01]（Parse 用 ciMethod）和 [02]（Inline 用 ciCallProfile）的连接

## 要求行为

- ✅ **★ Mermaid 4 层数据流图**
- ✅ **★ "你需要知道的" 5 概念 callout 框**
- ✅ **★ ci/ 层设计理由详解**——不可变性 + 线程安全性
- ✅ **★ Profile 污染 3 种模式 + 诊断 + 修复**
- ✅ **★ Profile Maturity 3 条件判断详解**
- ✅ **★ 面试 Story Format 答案模板**
- ✅ **★ GDB 断言 ≥10 条**
- ✅ **★ 交叉引用 01 §二 + 02 §二/§三 的精确 § 号**
