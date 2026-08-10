# PROMPT: 请撰写 02-Inline-Decision.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**C2 内联决策 — InlineTree 的递归决策引擎如何用 CHA + type profile 决定"内联 or not"**。

### 核心故事线（禁止做源码翻译机！）

启动后前 2 分钟——CodeCache 从 0% 到 97% 满。`-XX:+PrintInlining` 显示 1 个方法内联了 2000+ 层——InlineTree 深度没有限制，生成单个 nmethod 2MB。CodeCache full → CompileBroker 停止 → 热方法卡在解释器 → QPS 跌 80%。

内联是 C2 最重要的单一优化——不是因为内联本身快，而是因为**内联让其他优化"看见"更多代码**。没有内联 = GC 在隔壁房间观察你的程序，只能看到 `call 0x...`。有了内联 = GC 看到了 callee 的 load/add/cmp 指令——可以跨方法消除重复计算。

**读者前提**：从 [01-Pipeline] §二（Parse 阶段——字节码→Node）和 §三（IGVN——hash-consing + worklist）进入本文。读者知道 Parse 阶段对每个 `invokevirtual` 创建 `CallStaticJavaNode`，IGVN 阶段之后 Inline 发生。本文回答：**C2 怎么决定是否内联这个 CallStaticJavaNode？InlineTree 的递归决策逻辑是什么？**

### 你需要知道的（零编译器背景的 Java 工程师必须理解 5 个概念）

#### 概念 1：InlineTree（内联树）

InlineTree 是 C2 用于管理内联决策的递归数据结构——一棵调用树。根节点 = 被编译的根方法。叶节点 = 被内联的叶子方法。每个节点存储：callee 的 `ciMethod*`、调用 `bci`（字节码索引）、inline 深度、调用频率。`InlineTree::should_inline(ciMethod* callee)` 在每个节点上做决策——如果决定内联 → 创建子节点 → 在子节点上继续递归决策。

#### 概念 2：CHA（Class Hierarchy Analysis）

CHA = 类层次分析——编译时扫描**已加载的**类层次结构，判断 invokevirtual 调用的接收者类型。如果 `HashMap.hashCode()` 是 `invokevirtual Object::hashCode()`——但 JVM 当前只加载了 `HashMap`（没有 `HashMap` 的子类加载）→ CHA 判断："Object::hashCode() 在当前类层次中只有 1 个实现 → 可以用单态调用（monomorphic）替代虚拟调用"。CHA 的风险：如果之后加载了 HashMap 的子类并重写了 hashCode() → CHA 的假设破灭 → deopt。

#### 概念 3：Type Profile（类型画像）

C1（L2/L3 编译级别）在执行时收集每次 invokevirtual 的**实际接收者类型**。C2 编译时读取此 profile：`ciCallProfile::receiver_count(i)` 返回第 i 个接收者类型被观察到的次数。如果 99% 的调用都是 HashMap → C2 内联 HashMap::hashCode()，并为剩余 1% 生成 guard check（`cmp [recv+klass], HashMap_klass; jne uncommon_trap`）。

#### 概念 4：Hot Count（热度计数）

不是所有方法都值得内联——只内联"热"的。`ciCallProfile::count()` 返回此调用点的总调用次数。"热"的定义：频率高于 `InlineFrequencyRatio`（默认 ~20%）→ 相对于 root method 的热度。一个 root method 里被调用了 5000 次的方法大概率热；被调用了 5 次的方法不值得内联。

#### 概念 5：Uncommon Trap（罕见陷阱）

C2 内联时基于 CHA 或 type profile 做了**单态假设**——生成了一个 guard check。如果 guard 失败（接收者不是假设的类型）→ 触发 `uncommon_trap` → deopt 回解释器 → 解释器重新执行此 invokevirtual → 可能触发新的 C2 编译（基于新的、更准确的 type profile）。Uncommon trap 的代价：deopt（~1000 cycles）+ 解释执行（慢 20-100×）+ 重编译（~100ms）。

---

**本文是 05-jit-compiler 阶段的第 2 篇。前置：[01-Pipeline] §二（Parse——字节码→Node）+ §三（IGVN——hash-consing）。读者知道 C2 8 阶段管道的全貌，本文聚焦第 3 阶段（Inline）——C2 的第一个"决策"阶段。配套：[04-CodeCache-Sweeper]（内联过深的后果——CodeCache 爆炸）、[07-Profile-Data-Flow]（type profile 的数据来源——ci/ 层）。**

### 核心叙事线 — "InlineTree 的递归决策引擎"

1. **★ InlineTree 的 5 步决策链** — `InlineTree::should_inline(ciMethod* callee)`：
   (1) `callee->should_inline()` —— @ForceInline 注解？
   (2) `callee->should_not_inline()` —— @DontInline？native method？too big？
   (3) `inline_level() > MaxInlineLevel` —— 递归深度超过 9？
   (4) `callee->code_size() > MaxInlineSize` —— 方法体超过 35 bytes？
   (5) frequency filter —— 调用频率高于 `InlineFrequencyRatio`？
   只有 5 关全过 → 开始 `try_to_inline()`。

2. **★★ CHA：静态类型分析** — `ciKlass::is_leaf_type()` → 如果只有一个具体实现 → invokevirtual → 内联为直接调用。`ciKlass::subklass_of(ciKlass* super)` → 检查类层次。CHA 缓存在 `ciKlass` 对象中——每次编译新的 root method 时刷新。

3. **★★ Type Profile：动态运行时数据** — `ciCallProfile::receiver_count(i)` → 哪个接收者类型最常见。99% HashMap + 1% TreeMap → 内联 HashMap，guard for TreeMap。Profile 成熟度检查：`MethodData::profile_maturity()` → 如果 profile 不够成熟 → 不内联（避免基于不准确数据做错误决策）。

4. **★ Late Inline：在 IGVN 之后的补内联** — 先 IGVN（消除死代码、合并冗余）→ 再 inline。为什么？IGVN 可能消除某些调用（如常量折叠后的死代码）→ 剩下的调用才是"真正重要的"。`PhaseIdealLoop::do_call()` 注册 late inline candidates。

5. **★★ 内联的瀑布效应** — 内联不是独立的优化——它**乘以**所有其他优化的效果。5 个方法被内联到 root → IGVN 跨 5 个方法边界发现重复计算 → EA 跨 5 个方法边界追踪对象 → LoopOpt 跨方法边界提升循环不变代码。不内联：每个方法是独立世界；内联后：所有方法变成一个世界。

6. **★★ Production：`PrintInlining` 日志解读** — `(hot)` = 调用足够热，正在考虑；`already compiled into a big method` = caller 的大小达到上限；`callee is too large` = callee 字节码 > MaxInlineSize；`inline level too deep` = 递归深度 > 9；`no static binding` = 虚拟调用有多个子类型，无法 CHA 或 profile 单态化。

### 验证报告
- `sverklo_search "InlineTree should_inline try_to_inline CHA inline decision"` → doCall.cpp
- `codegraph query "InlineTree::should_inline"` → doCall.cpp:54-528
- `rg -n "should_inline\|should_not_inline\|try_to_inline\|MaxInlineLevel\|MaxInlineSize" doCall.cpp bytecodeInfo.cpp` → Inline 实现
- `rg -n "is_leaf_type\|subklass_of\|ciKlass" ci/ciKlass.cpp ci/ciKlass.hpp` → CHA 实现

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintCompilation -XX:+PrintInlining`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:+PrintInlining` 是本文的核心诊断工具

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `doCall.cpp` | `src/hotspot/share/opto/doCall.cpp` | opto | `InlineTree::should_inline()`(:54-250)、`InlineTree::try_to_inline()`(:252-528)、`InlineTree::should_inline_always()` | ★★★ InlineTree 决策引擎——核心 |
| 2 | `inline.cpp` | `src/hotspot/share/opto/inline.cpp` | opto | `InlineTree::InlineTree()`(构造器)、`InlineTree::build_inline_tree()` | ★★ InlineTree 构造 |
| 3 | `bytecodeInfo.cpp` | `src/hotspot/share/opto/bytecodeInfo.cpp` | opto | `InlineTree::should_not_inline()`、`ciMethod::should_inline()`、`ciMethod::should_not_inline()` | ★★ Inline 策略规则 |
| 4 | `ciMethod.cpp` | `src/hotspot/share/ci/ciMethod.cpp` | ci | `ciMethod::instructions_size()`、`ciMethod::has_compiled_code()`、`ciMethod::should_inline()` | ★★★ CI 层方法接口 |
| 5 | `ciCallProfile.hpp` | `src/hotspot/share/ci/ciCallProfile.hpp` | ci | `ciCallProfile::count()`、`receiver_count()`、`argument_projected_type()` | ★★★ C1 profile 数据消费 |
| 6 | `ciKlass.hpp` | `src/hotspot/share/ci/ciKlass.hpp` | ci | `ciKlass::is_leaf_type()`、`subklass_of()`、`is_loaded()` | ★★ CHA——类层次分析 |
| 7 | `callGenerator.cpp` | `src/hotspot/share/opto/callGenerator.cpp` | opto | `CallGenerator::for_inline()`、`for_virtual_call()`、`call_generator()` 派发 | ★★ CallGenerator 策略选择 |
| 8 | `loopnode.cpp` | `src/hotspot/share/opto/loopnode.cpp` | opto | `PhaseIdealLoop::do_call()` | ★★ Late Inline 注册 |

**跨模块说明**：内联决策跨 opto/（InlineTree 递归引擎）+ ci/（类型信息 + profile 数据）。ciMethod/ciKlass/ciCallProfile 是 C2 读取 JVM 内部数据的"视图层"（详参 07-Profile-Data-Flow）。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ InlineTree 的 5 步决策链

```
问题：
  ① InlineTree::should_inline(ciMethod* callee) 的 5 步决策顺序是什么？为什么是这个顺序？
      线索: doCall.cpp:54-250
      答案方向: (1) @ForceInline 快速通过（白名单，不消耗预算）；(2) @DontInline/native/too big 快速拒绝
      （黑名单，不浪费后续分析）；(3) 深度检查（防止栈/CodeCache 爆炸）；(4) 大小检查（防止单方法过大）；
      (5) 频率检查（最贵的检查，需要计算 profile 数据——只对通过前 4 关的方法做）。
      顺序反映"便宜检查→ 贵检查"——先过滤绝大多数不合适的候选，再对通过初筛的候选做昂贵的热度分析。

  ② callee->code_size() > MaxInlineSize 的大小限制是多少？为什么不是更大的值？
      答案方向: MaxInlineSize = 35 bytes（默认）。为什么 35？→ 内联后 callee 的 Node 数量约 code_size×4
      = 140 Node。root method 默认 ~1000 Node → 每内联 1 个方法增加 140 Node → 内存和编译时间线性增长。
      如果提高到 200 bytes → 每次内联增加 800 Node → 5 次内联就满 → CodeCache 爆炸。
      追问: 热方法可以超限吗？→ 可以。`InlineFrequencyRatio` 检查：如果调用频率 > 20% root freq →
      即使 code_size > 35 也可以内联——但受 `FreqInlineSize`（默认 325 bytes）上限约束。

  ③ 深度限制 MaxInlineLevel=9 是硬限制还是软限制？
      答案方向: 硬限制——inline_level() == 9 → 不再继续递归。为什么是 9？→ 9 层 = 
      root → A → B → C → D → E → F → G → H → I → 停止。10 层深度意味着 call/ret 链上有 10 个帧——
      每个帧的保存/恢复（push rbp/sub rsp）累加 ~30 cycles × 10 = 300 cycles/调用链。
      内联消除这 300 cycles。但内联到第 10 层时 callee 已经非常小（code_size << 35）→ 继续内联收益递减。
      追问: 能否 override？→ -XX:MaxInlineLevel=15 可以设更大，但 CodeCache 压力剧增。
```

### 4.2 ★★ CHA：静态类层次分析

```
问题：
  ① ciKlass::is_leaf_type() 如何判断"只有一个实现"？
      线索: ciKlass.hpp/cpp 的 is_leaf_type + subklass_of
      答案方向: 遍历 InstanceKlass::subklass() 链表 → 如果没有子类 → is_leaf_type() = true。
      注意：只考虑"已加载的"子类——如果之后加载新子类 → CHA 的 leaf type 假设破灭 → deopt。
      这与 C2 的 `dependency_context` 机制挂钩：编译时记录"依赖 X 是 leaf type"→ 
      C2 的 dependency 追踪：如果 X 的子类被加载 → 所有依赖此假设的 nmethod → deopt。

  ② 如果 CHA 说"只有 1 个实现"——C2 生成什么代码？
      答案方向: 内联唯一的实现（如 HashMap::hashCode()）作为直接调用 + guard check：
        cmp [recv + klass_offset], HashMap_Klass  ; 检查接收者是否是 HashMap
        jne uncommon_trap                          ; 如果不是 → 去优化
        ; ... HashMap::hashCode() 的内联体 ...
      如果 guard 通过（99% 情况）→ 直接执行内联体——无 virtual dispatch 开销。
      如果 guard 失败（1% 情况）→ jne 触发 uncommon_trap → deopt → 解释器重新执行 invokevirtual
      → 解释器做真实的 vtable dispatch（O(1) anyway，但比直接调用慢 5×）。

  ③ CHA vs type profile —— 哪个更可靠？冲突时谁优先生效？
      答案方向: CHA = 静态保证（已知已加载类 → 100% 确定）。type profile = 运行时采样（可能有偏差）。
      如果 CHA 说"只有 1 个实现"→ 无视 type profile（即使 profile 说 50% HashMap / 50% 其他—
      但这不可能发生——因为 CHA 说了只有 1 个实现）。如果 CHA 说"多个实现"→ 看 type profile——
      如果 profile 说 99% HashMap → 内联 HashMap + guard。冲突不存在——CHA 是正确的（对于已加载类）。
```

### 4.3 ★★ Type Profile：动态运行时数据

```
问题：
  ① ciCallProfile::count() 和 receiver_count(i) 的数据从哪来？
      线索: ciCallProfile.hpp + methodData.hpp
      答案方向: C1（L2/L3）在执行时收集 MethodData（MDO = Method Data Object）。MDO 存储在 Method*
      之后。每次 invokevirtual 执行 → `MethodData::receiver_type_data()->add_receiver(receiver_klass)`
      增加计数器。ciCallProfile 是 C2 层对 MDO 的只读包装——`count()` = 总调用次数，
      `receiver_count(0)` = 最常见的接收者被观测到的次数。
      追问: MDO 多大？→ 通常 ~1-5KB/method。包含 invocation counter、backedge counter、
      call site profiles、branch profiles。

  ② profile 不成熟（maturity < threshold）时 C2 怎么处理？
      线索: MethodData::profile_maturity()
      答案方向: MDO 未成熟 → C2 不做 C2 级编译 → 只做 C1 L3 编译（继续收集 profile）。
      直到 MDO 成熟（invocation_count >= MatureInvocationLimit=500 或足够多的 backedge）→ 
      才触发 C2 编译。这防止 C2 基于"warmup 期间的偏差数据"做错误的内联决策。

  ③ 如果 type profile 说 "99% HashMap"但实际线上流量有 30% TreeMap——怎么办？
      答案方向: 这是"profile 污染"灾难——C2 内联 HashMap::hashCode() + guard for 1% TreeMap →
      实际流量中 30% 调用触发 guard → 30% 调用走 uncommon_trap → deopt 风暴 → CPU 50% 在 deopt blob。
      解决方案：(a) 增大 -XX:MatureInvocationLimit → profile 更成熟后才 C2 编译；(b) `-XX:CompileCommand=dontinline,HashMap::hashCode`；(c) 重启 JVM（清除被污染的 profile）。
```

### 4.4 ★ Late Inline：在 IGVN 之后的补内联

```
问题：
  ① 为什么不在 Parse 阶段立即内联所有方法？
      答案方向: 如果 Parse 立即内联 → 构建一个巨大的初始图（1000+ Node）→ IGVN 要处理这个大图
      → 编译时间爆炸（O(N²) with graph size）。策略：先构建 root method 的小图（~200 Node）→
      IGVN 优化到 ~100 Node → 然后对内联候选做 late inline（把 callee 的 Node 嵌入优化后的图）。
      追问: late inline 后还要再 IGVN 吗？→ 要——每次 inline 后都需要 IGVN 合并冗余 + 消除死代码。

  ② PhaseIdealLoop::do_call() 注册 late inline 的逻辑是什么？
      线索: loopnode.cpp PhaseIdealLoop::do_call
      答案方向: do_call() 遍历 Ideal Graph 中的 CallNode → 检查 call 是否有 `CallGenerator::for_late_inline()`
      → 如果有 → 在 IGVN 收敛后、LoopOpt 之前执行 inline。late inline candidate 的条件：
      调用频率高 + CHA 或 type profile 支持单态 + callee 大小适中。

  ③ Late inline 和 early inline（Parse 阶段的 inline）如何分工？
      答案方向: Early inline（Parse 阶段）= 小方法 + @ForceInline + accessor（getter/setter）。
      这些方法 code_size < 35 bytes → 内联开销小、收益高（eliminate method call overhead）。
      Late inline（IGVN 后）= 中等大小方法（35-325 bytes）+ 热调用点。这些方法的 inline 决策
      依赖 IGVN 后的图（如 IGVN 可能消除了某些调用 → 剩下的调用点更值得内联）。
```

### 4.5 ★★★ 内联的瀑布效应——具体数字对比

```
问题：
  ① 一个不内联的调用链 vs 内联后的调用链——指令数差多少？
      线索: 具体代码示例
      答案方向:
        // 不内联：每个方法独立
        int process(String s) {
          int h = hash(s);              // call hash — 需要 5 条指令（push args + call + ret）
          return verify(h);             // call verify — 5 条
        }
        int hash(String s) {
          return s.hashCode();          // call hashCode — 5 条
        }
        总指令数: 10 (process body) + 5 + 5 (call overhead × 2) + 8 (hash body) + 5 + 49 (hashCode body) = 82
        执行周期: ~200 cycles

        // 内联后：所有方法在一个图中
        // process body: 10
        // IGVN 跨方法消除 3 次重复 hashCode() → hashCode body 从 49 减少到 16
        // hash body 消除（语义被 IGVN 吸收）
        总指令数: 10 + 16 - 3 (合并) = 23
        执行周期: ~50 cycles

        加速比: 200/50 = 4× —— 仅内联本身的收益。
        加上后续优化的收益（EA、LoopOpt 能跨方法工作）→ 总加速比可达 10-100×。

  ② 内联的"隐形收益"——为什么 02 是"最重要的优化阶段"？
      答案方向: 内联的显性收益 = 消除方法调用开销（~3-15 cycles/call）。内联的核心收益 = 让其他
      优化"看见"更多代码（multiplicative effect）。没有内联：GVN 只能在方法内部消除重复；
      EA 看不到 callee 内的对象使用；LoopOpt 提不到跨方法的循环不变代码。内联是"撬动其他优化"的支点——
      1 次内联触发 10+ 次下游优化。这就是为什么 Inline 是 P0 文档。
```

### 4.6 ★ Production：`PrintInlining` 日志解读

```
问题：
  ① 以下日志行各是什么意思？
      线索: -XX:+PrintInlining 输出格式
      答案方向:
        @ 12 java.util.HashMap::hash (62 bytes)   inline (hot)
          → 在 bci=12 处调用 HashMap::hash()，callee 有 62 bytes，决策 = inline，原因 = hot
        @ 4 java.util.Objects::hashCode (12 bytes)   inline (hot)
          → bci=4 调用 Objects::hashCode(), 12 bytes, inline, hot
        @ 4 java.lang.String::hashCode (49 bytes)   inline (hot)
          → bci=4 调用 String::hashCode(), 49 bytes, inline, hot
        @ 19 java.lang.String::value (5 bytes)   accessor
          → bci=19 调用 String::value(), 5 bytes, inline, 原因 = accessor（getter/setter——特例）
        @ 8 java.lang.String::hashCode (49 bytes)   already compiled into a big method
          → bci=8 又调用 String::hashCode()，但 callee 已被内联到 caller 的其他位置
          → 这次调用不再次内联——直接复用之前内联的代码

  ② 如何用 PrintInlining 诊断"内联过深"？
      答案方向: 查看缩进层级——每内联 1 层缩进 2 空格。如果看到 9+ 层缩进 → 深度接近 MaxInlineLevel
      → CodeCache 风险。同时间看内联的 callee 大小——如果深层 callee 仍然是 30+ bytes → 总体
      nmethod 可能很大。确认：`jcmd <PID> Compiler.CodeHeap_Analytics` → 看 individial nmethod sizes。
```

## 五、文章结构

```
§〇 生产场景 — CodeCache 爆炸诊断
  ★ 真实 PrintInlining 输出（多层内联导致 2MB nmethod）
  ★ 10 分钟诊断：PrintInlining → 定位过度内联的方法 → CompileCommand dontinline

Actual -XX:+PrintInlining output from a hot compilation:

```
@ 12 java.util.HashMap::hash (62 bytes)   inline (hot)
  @ 4 java.util.Objects::hashCode (12 bytes)   inline (hot)
    @ 4 java.lang.String::hashCode (49 bytes)   inline (hot)
      @ 19 java.lang.String::value (5 bytes)   accessor
    @ 8 java.lang.String::hashCode (49 bytes)   already compiled into a big method
  @ 9 java.lang.Integer::hashCode (10 bytes)   inline (hot)
```

Interpreting this inline tree:
- "@ 12" = the call site is at bytecode offset 12 in the caller method
- "inline (hot)" = C2 profiled this call site > InlineFrequencyRatio threshold
- "already compiled into a big method" = this callee was ALREADY inlined into ANOTHER caller. C2 won't inline it twice — this is the mechanism that prevents CodeCache explosion
- "accessor" = trivial field access (e.g., just "return value"), always inlined
- Each level of indentation = 1 more level of inline depth → 4 levels deep here means the root method inlined 4 levels of callee code

§一 ★★★ InlineTree 递归决策引擎
  ❓ 为什么内联是 C2 最重要的优化？和其他优化是什么关系？
  ❓ 内联决策不是"内联 yes/no"——是"内联到哪个深度"的连续决策
  1.1 ★ InlineTree 数据结构 — 根节点→子节点递归树
  1.2 ★ 5 步决策链 Mermaid 图 — yes/no 分支 + 每步的判定函数
  1.3 ★ 面试 Story Format 答案：内联为什么是 JIT 的基石
  1.4 和 [01-Pipeline] §二 的连接 — CallStaticJavaNode→InlineTree::try_to_inline

§二 ★★ CHA：静态类层次分析
  ❓ CHA 为什么是"静态"的？如果新类加载了怎么办？
  ❓ CHA 和 type profile 在内联决策中的权重
  2.1 ciKlass::is_leaf_type() + subklass_of() — 实现细节
  2.2 dependency_context — CHA 假设破灭→deopt 的机制
  2.3 CHA 的风险 — 动态类加载场景

§三 ★★ Type Profile：动态运行时数据
  ❓ C1 怎么收集 type profile？C2 怎么读取？
  ❓ profile 不成熟时 C2 怎么处理？
  3.1 ciCallProfile — count/receiver_count 数据来源
  3.2 profile maturity — MethodData::profile_maturity() 检查
  3.3 profile 污染的灾难 — 3 种典型场景 + 诊断

§四 ★ Late Inline：IGVN 后的补内联
  ❓ 为什么不直接在 Parse 阶段全部内联？
  ❓ Late inline 和 early inline 的分工
  4.1 PhaseIdealLoop::do_call() — 注册 late inline candidate
  4.2 Late inline 的时机 — IGVN 收敛后、LoopOpt 前
  4.3 Late vs Early 的分工表

§五 ★★★ 内联的瀑布效应 — 具体数字对比
  ❓ 不内联 vs 内联：指令数/周期数的量化差异
  ❓ 为什么说内联是"乘数"而不是"加数"？
  5.1 具体方法链：process()→hash()→hashCode()→value
  5.2 内联前后：Node 数×5 → Node 数÷2（IGVN 合并后）
  5.3 启用下游优化的额外收益表

§六 ★ Production：PrintInlining 日志解读 workflow
  ❓ 每种 inline 决策标记的含义
  ❓ 如何用 PrintInlining 定位过度内联/遗漏内联
  6.1 日志格式详解（8 种标记：hot/too large/deep/no static binding/...）
  6.2 诊断 workflow：CodeCache 满 → PrintInlining → 定位过度内联方法
  6.3 修复参数：-XX:MaxInlineLevel=9 -XX:MaxInlineSize=35 -XX:FreqInlineSize=325

§七 GDB 验证 + 可证伪断言 (≥10 条)
  断言 1: InlineTree::should_inline() 入口 — 打印 callee name + size + decision
  断言 2: @ForceInline 注解 → should_inline_always() == true
  断言 3: inline_level() 达到 9 → should_inline 返回 false
  断言 4: code_size() > MaxInlineSize(35) → should_inline 返回 false
  断言 5: ciCallProfile::count() 读取 MDO 中的调用计数
  断言 6: ciCallProfile::receiver_count(0) > 90% → 决策单态内联
  断言 7: ciKlass::is_leaf_type() == true → invokevirtual 转为直接调用
  断言 8: Late inline 在 IGVN 之后、LoopOpt 之前被执行
  断言 9: PrintInlining 输出验证 — 断点 should_inline 时的 callee 与日志一致
  断言 10: 内联后的 Node 数 > 内联前的 Node 数 × 1.5（callee Node 的增量）

§八 和 [01][07] 的交叉验证
  ❓ 01-Pipeline §二（Parse 创建 CallStaticJavaNode）→ 02 的 InlineTree 接收这个 Node
  ❓ 07-Profile-Data-Flow §X（ciCallProfile 数据来源）→ 02 的 type profile 决策
```

## 六、写作要求

1. **★ Mermaid InlineTree 递归决策树图**——5 步决策链的 yes/no 分支，标注每步的函数名 + 判定条件 + 阈值
2. **★ "你需要知道的" 5 概念 callout 框**——InlineTree、CHA、Type Profile、Hot Count、Uncommon Trap
3. **★ 面试 Story Format 答案**——§ 一末尾："内联为什么是 JIT 最重要的优化？"——叙事式回答，可背诵
4. **★ 具体数字对比**——不内联 vs 内联：指令数 82→23，周期数 200→50，加速比 4×；含下游优化：加速比 10-100×
5. **★ PrintInlining 日志 8 种标记的完整解读表**——标记 + 含义 + 原因 + 建议操作
6. **★ 生产诊断 workflow**——CodeCache 满 → PrintInlining → 定位过度内联方法 → CompileCommand 修复
7. **★ 交叉引用**：01 §二（Parse 创建 CallStaticJavaNode→Inline 入口）、01 §三（IGVN→Inline 时机）、07 §X（ciCallProfile 数据来源）
8. **★ GDB 断言**：精确到 doCall.cpp 行号，断点位置 + 预期变量值

## 七、输出格式

- Markdown 文件，命名为 `02-Inline-Decision.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/05-jit-compiler/`
- 元信息头：
  ```
  > **阶段**：[05-jit-compiler]
  > **前置**：[01-C2-Pipeline] §二（Parse——字节码→Node）+ §三（IGVN——hash-consing）
  > **配套**：[04-CodeCache-Sweeper]（内联过深的后果）、[07-Profile-Data-Flow]（type profile 数据来源）
  > **后续依赖本文**：无直接后续（内联是叶节点优化），但 [01] 的 Inline 阶段引用本文
  > **阅读收益**：理解 C2 如何用 InlineTree 递归决策树决定"内联 or not"——从 5 步决策链到 CHA 静态分析到 type profile 动态数据；从"内联到哪个深度"的权衡到"PrintInlining 日志解读"的生产诊断工作流
  ```

## 禁止行为

- ❌ 只讲内联"好"不讲内联"坏"——内联过度导致 CodeCache 爆炸是生产的核心痛点，必须用 PrintInlining 输出做案例
- ❌ 忽略 CHA 和 type profile 的区别——两者都是内联决策的输入，但一个是静态保证一个是运行时采样，冲突不存在但优先级不同
- ❌ 不做具体数字对比——必须用不内联/内联的指令数、Node 数、周期数来量化
- ❌ 不解释 Late Inline 的时机——Late Inline 是 C2 的专利设计（C1 没有），不解释它即忽略 C2 的关键优化策略
- ❌ 忘记和 [01-Pipeline] 的连接——读者从 01 的 Parse 阶段进入本文，需明确 CallStaticJavaNode→InlineTree 的入口
- ❌ 不解释 profile 污染——生产灾难的核心场景之一，必须有：成因 + 诊断 + 修复三步完整工作流
- ❌ 忽略 InlineTree 的递归性质——如果读者不理解"为什么是树而不是列表"，就无法理解内联深度限制的意义
- ❌ 不做 PrintInlining 日志标记的完整解读表——生产诊断的核心工具，必须覆盖 8 种标记

## 要求行为

- ✅ **★ Mermaid 决策树图**——5 步链 yes/no 分支 + 函数名 + 阈值
- ✅ **★ "你需要知道的" 5 概念 callout 框**
- ✅ **★ 不内联 vs 内联：具体数字对比表**——指令数/Node 数/周期数/加速比
- ✅ **★ PrintInlining 8 种标记解读表**
- ✅ **★ 生产诊断 4 步 workflow**
- ✅ **★ GDB 断言 ≥10 条**——打印 callee name、decision、type profile 数据
- ✅ **★ 面试 Story Format 答案模板**
- ✅ **★ 交叉引用 01 + 07 的精确 § 号**
