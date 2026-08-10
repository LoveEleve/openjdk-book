# 07-Profile-Data-Flow — Profile 数据流：C1→MethodData→ci/→C2 的 4 层管道

> **阶段**：[05-jit-compiler]
> **前置**：[02-Inline-Decision] §二（CHA——静态类层次分析）+ §三（Type Profile——C2 消费端）
> **配套**：[01-C2-Pipeline] §二（Parse 用 ciMethod 读取方法信息）
> **阅读收益**：理解 C1→MethodData→ci/→C2 的完整 profile 数据管道；掌握 ciMethod/ciKlass/ciCallProfile 的 C2 内联决策基础；能用 profile maturity 和 profile 污染诊断修复生产性能回归

---

## §〇 生产场景——Profile 污染→C2 错误内联→CodeCache 爆炸

### 真实 PrintInlining + PrintDeoptimizationDetails——Profile 来自 warmup，稳态流量完全不同

应用发布后前 5 分钟一切正常。第 6 分钟开始：

```
@ 12 java.util.HashMap::putVal (62 bytes)  inline (hot)
  @ 42 java.util.HashMap::hashCode (49 bytes)  inline (hot)   ← C2 认为 receiver 100% HashMap
    @ 7 java.lang.String::hashCode (49 bytes)  inline (hot)
      @ 19 java.lang.String::value (5 bytes)   accessor
    @ 15 java.util.Objects::equals (23 bytes)   inline (hot)
  @ 56 java.util.HashMap::resize (287 bytes)  inline (hot)
    ... 内联了 6 个深度 callee ...

Uncommon trap happened in java.util.HashMap::putVal
  @ 42 java.util.HashMap::hashCode (5 bytes)
  reason: class_check
  action: maybe_recompile
  trap_request: 5

Uncommon trap happened in java.util.HashMap::putVal
  @ 42 java.util.HashMap::hashCode (5 bytes)
  reason: class_check
  action: make_not_entrant
  trap_request: 4
```

**解读**：

```
PrintInlining 输出:
  inline (hot) → C2 的 type profile 说 "99% receiver is HashMap" → 单态内联了 HashMap::hashCode + 后续 5 个 callee
  → 单个 nmethod 2MB

PrintDeoptimizationDetails 输出:
  同一调用点 @42 反复 deopt → HashMap::hashCode 的 CHA guard 不断失败
  → 生产流量中 40% receiver 是 TreeMap（但 profile 没看到——因为 profile 是 warmup 期间收集的）
  → deopt→recompile→deopt 循环
```

**完整时间线**：

```
T+0min:   应用启动——warmup 流量 100% HashMap
T+2min:   C1 L3 编译——收集 profile——覆盖率 = 500 次调用（receiver 100% HashMap）
T+5min:   MDO 达到成熟——C2 编译——基于 profile "100% HashMap" 内联 6 层 callee
T+6min:   生产稳态流量——receiver: HashMap 60%, TreeMap 40%
T+6.001min: CHA guard 失败（TreeMap 到达）→ deopt → 重编译
T+6.5min:  重编译完成（仍然基于旧的 profile）→ 又 deopt
T+6min~10min: deopt 风暴 → SpecTrapLimit 达到 → 方法被标记 not_compilable → 永远解释执行
T+10min:   CodeCache 满 → CompileBroker 禁用 → QPS -80%
```

**10 分钟诊断 + 修复**：

```bash
# 1. 诊断：找出 profile 污染的根因方法
-XX:+PrintCompilation -XX:+PrintInlining -XX:+PrintDeoptimizationDetails | \
  grep "class_check" | sort | uniq -c | sort -rn
# → HashMap::putVal 最频繁 → profile 污染确认

# 2. 查看 profile 成熟度
-XX:+PrintMethodData  # 输出每个方法的 invocation_counter + backedge_counter

# 3. 修复 1：提高成熟度门槛（让 profile 收集更多数据）
-XX:MatureInvocationLimit=2000    # 从 500 到 2000——等待生产稳态流量

# 4. 修复 2：阻止 C2 用错误 profile 编译（临时）
-XX:TieredStopAtLevel=3           # 只做 C1——不用 C2 读取 profile

# 5. 修复 3：排除问题方法
-XX:CompileCommand=dontinline,com/example/TreeMapProcessor::processNode
```

---

## §一 ★★★ Profile 数据流全景——C1 解释器是 C2 的"市场调研部门"

### 1.0 本文不做什么

本文不是 `ciMethod.cpp` + `methodData.cpp` 的源码 walkthrough。本文是 **Profile 数据流的 ARCHITECTURE STORY**：C2 不是瞎子——它透过 ci/ 目录看到 C1/解释器运行时收集的 profile。数据流有 4 层：C1 解释器计数器累加 `→` 写入 MethodData（MDO）`→` ci/ 层包装为 immutable 快照 `→` C2 Parse + InlineTree 消费。

### 1.1 读者前提——你从哪里来

你从 [02-Inline-Decision] §二 学完：CHA 是编译时的静态类层次分析——只看已加载的类，不看运行时数据。§三 学完：Type Profile 是动态运行时数据——`ciCallProfile::receiver_count(0)` 返回最常见 receiver 被调用的次数。**本文回答：type profile 从哪来？C1 怎么收集？MethodData 怎么存储？ci/ 层为什么需要、怎么包装给 C2？**

```
[02-Inline] §二/§三                       本文从这里开始
      │                                         │
      ▼                                         ▼
C2 消费端: ciCallProfile ──→ 数据来源: C1 → MethodData → ci → C2
      │                               ┌────── 4 层管道 ──────┐
      └─ 02 只讲 C2 怎么用              本文讲 数据怎么来、怎么传
```

### 1.2 你需要知道的——5 个概念 callout 框

> **以下 5 个概念是理解 profile 数据流的前提。每个不超过 200 字，自包含——不依赖本文其他部分。**

#### 概念 1：MethodData（MDO）

MethodData 是 C1/解释器在执行时收集的运行时数据——每个方法 1 个 MDO。存储：invocation counter、backedge counter、call site profiles（每次 invokevirtual 的 receiver 类型分布）、branch profiles（if/else 的 taken/not-taken 计数）。大小：通常 ~1-5KB/method。MDO 从 C-Heap 分配（独立于 Java heap），由 Method 的 `_method_data` 字段持有。

#### 概念 2：ci/（Compiler Interface）

ci/ 目录 = JVM 内部数据结构（`Method*` / `InstanceKlass*` / `ConstantPool*` NP）→ C2 编译器可读取的**immutable 包装**。C2 在编译线程上执行（非 safepoint），不能直接访问 JVM 的可变数据结构（可能被 GC 线程修改）。ci/ 层在编译开始时**快照**所有需要的信息 `→` 编译期间 immutable `→` C2 看到一致的数据视图。

#### 概念 3：ciMethod

ciMethod = C2 眼中的"方法"。构造时快照：Method*（只读引用）、MethodData*（profile 数据）、bytecodes（字节码数组）、exception handler table。C2 通过 `ciMethod::instructions_size()` 做 inline 大小检查，通过 `ciMethod::has_compiled_code()` 判断是否已有编译版本。

#### 概念 4：ciCallProfile

ciCallProfile = 一个调用点的 profile 快照。构造器从 MethodData 的 `ReceiverTypeData` 中提取 bci 处的数据 → `count()` = 总调用次数（counter_count + data_count，计入 counter decay）→ `receiver_count(i)` = 第 i 个 receiver 被观测到的次数。C2 用 `receiver_count(0) / count() > 90%` 做单态决策。

#### 概念 5：Profile Maturity（profile 成熟度）

MDO 不是什么时候都能被信任。`MethodData::profile_maturity()` 检查：`invocation_count >= 500`（MatureInvocationLimit）或 `backedge_count >= 500` 且所有 call site 有足够数据。未成熟的 profile `→` C2 忽略此 MDO `→` 只做 C1 编译。成熟后才触发 C2 编译——防止基于 warmup 期间不完整数据做错误决策。

---

## §二 标准环境

- OpenJDK 11 slowdebug build（`#ifdef ASSERT` 全部生效）
- `bash configure --with-debug-level=slowdebug`
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintCompilation -XX:+PrintInlining`
- 64 位 Linux x86_64
- Tiered compilation 开启（C1 L2/L3 收集 profile → C2 编译时消费）

---

## §三 源文件生态——9 个文件驱动 4 层数据管道

| # | 文件 | 完整路径 | 模块 | 核心函数 | 本文角色 |
|---|------|---------|------|---------|---------|
| 1 | `methodData.hpp` | `src/hotspot/share/oops/methodData.hpp` | oops | `MethodData` 类、`DataLayout`、`ReceiverTypeData` | ★★★ MDO 存储 + 布局 |
| 2 | `methodData.cpp` | `src/hotspot/share/oops/methodData.cpp` | oops | `invocation_counter_inc()`、`profile_maturity()` | ★★★ MDO 更新 + 成熟度 |
| 3 | `ciMethod.cpp` | `src/hotspot/share/ci/ciMethod.cpp` | ci | `ciMethod()` 构造器、`instructions_size()`、`has_compiled_code()` | ★★★ C2 的方法视图 |
| 4 | `ciMethod.hpp` | `src/hotspot/share/ci/ciMethod.hpp` | ci | `ciMethod` 类定义 | ★★ 接口定义 |
| 5 | `ciCallProfile.hpp` | `src/hotspot/share/ci/ciCallProfile.hpp` | ci | `ciCallProfile()` 构造器、`count()`、`receiver_count()` | ★★★ C2 的调用点视图 |
| 6 | `ciKlass.hpp` | `src/hotspot/share/ci/ciKlass.hpp` | ci | `is_leaf_type()`、`subklass_of()`、`is_loaded()` | ★★ CHA 类层次信息 |
| 7 | `ciKlass.cpp` | `src/hotspot/share/ci/ciKlass.cpp` | ci | ciKlass 构造器 | ★★ CHA 实现 |
| 8 | `ciTypeFlow.cpp` | `src/hotspot/share/ci/ciTypeFlow.cpp` | ci | `ciTypeFlow::flow_types()` | ★★ 类型传播分析 |
| 9 | `doCall.cpp` | `src/hotspot/share/opto/doCall.cpp` | opto | `InlineTree::should_inline()` | ★★ Profile 消费端 |

**跨模块说明**：profile 数据流横跨 oops/（MethodData 原始存储）+ ci/（C2 可读的包装层）+ opto/（消费端）。ci/ 层是 JVM 数据结构→C2 编译器的"安全中间件"。

---

## §四 ★★★ The 4-Layer Pipeline——从 C1 采集到 C2 消费

### 4.1 ★★ Layer 1：C1/Interpreter——Counter Accumulation

每个方法有一个 `MethodData*` 指针（`Method::_method_data`）`→` 初次调用时分配 MDO。

**MDO 存储布局**——`DataLayout[]` 数组：

```
MethodData = header + DataLayout[]
  ├── [0] invocation_counter_entry     ← 此方法被调用的总次数
  ├── [1] backedge_counter_entry       ← 循环回边的总次数
  ├── [2] ReceiverTypeData @ bci=42    ← call site bci=42 的 receiver 统计
  │       ├── (klass=HashMap, count=150000)
  │       ├── (klass=TreeMap, count=80000)
  │       └── (klass=nullptr, count=0) ← 只记录 2-4 个 receiver
  ├── [3] BranchData @ bci=55          ← if/else 的分支统计
  │       ├── taken_count=230000
  │       └── not_taken_count=1000
  └── [4] ReceiverTypeData @ bci=72    ← 另一个 call site
```

**Profile 更新——~5 条 x86 指令**：

C1 L2/L3 编译的代码在每个 invokevirtual 处插入 profile 更新：

```asm
; C1 编译的 profile 更新代码
mov  rsi, [r15 + offset_of_method_data]  ; 1. 加载 MethodData 基址
mov  rdx, [rsi + call_site_offset]        ; 2. 加载当前 call site 的计数字段
inc  rdx                                   ; 3. 计数器 + 1
mov  [rsi + call_site_offset], rdx         ; 4. 写回计数字段
; 总共 ~5 条指令，~5 cycles
```

Pseudo-code for what C1 is doing:
```
void profile_invokevirtual(Method* m, int bci, Klass* receiver) {
  MethodData* mdo = m->method_data();
  if (mdo == NULL) return;

  ReceiverTypeData* rtd = mdo->receiver_type_data_at(bci);
  rtd->increment_count();                    // 增加调用计数器
  rtd->add_receiver(receiver);               // 记录此 receiver 的 klass
  // 如果 receiver 是新的 Klass，且未超出 Recording limit（2-4个）
}
```

### 4.2 ★★ Layer 2：MethodData——MDO Storage + Maturity

**MDO 生命周期**：

```
Method::create_mdo()
  → 从 C-Heap 分配 MethodData（~2KB）
  → 初始化 invocation_counter = 0, backedge_counter = 0
  → 初始化 DataLayout 槽（预先分配但计数为 0）

每次调用:
  → MethodData::invocation_counter_inc() → counter++
  → 如果 counter >= CompileThreshold → 触发 C1 L3 编译

C1 L3 执行:
  → C1 编译的代码更新 MDO：invocation_counter++、receiver type、branch stats
  → counter 达到 MatureInvocationLimit(500) → MDO 标记为 mature

MDO mature:
  → 触发 C2 编译
  → ciMethodFactory 复制 MDO 到 ciMethodData（编译期不变）
```

**Profile Maturity 的 3 条件**：

```cpp
// MethodData::profile_maturity() 伪代码
bool is_mature() {
  // 条件 1: invocation_counter >= MatureInvocationLimit (500)
  if (_invocation_counter >= 500) return true;

  // 条件 2: backedge_counter >= 500 AND 所有 call site 有 ≥2 receiver 数据
  if (_backedge_counter >= 500) {
    for (each call_site in DataLayout[]) {
      ReceiverTypeData* rtd = data_at(call_site);
      if (rtd->count() < 2) return false;  // 某 call site 数据不足
    }
    return true;
  }

  // 条件 3: 不满足 → 不成熟
  return false;
}
```

> **Counterfactual**："如果没有 Maturity 机制：10 次 warmup 调用 `→` HashMap 100% `→` C2 基于 10 个样本做单态内联 `→` 生产流量 40% TreeMap `→` deopt 风暴。有了 Maturity：500+ 次调用后才被认为是'成熟'的 profile `→` warmup 偏差被 500 次样本稀释 `→` C2 基于更接近稳态的数据做决策。"

**类比**：就像你观察一家咖啡店的顾客行为——只看了早上 7 点前 10 个顾客，100% 点咖啡。你会得出结论"所有人都喝咖啡，多买咖啡豆"。然后午餐时间到了——40% 的顾客点茶。你的早间偏差测量让你赔了钱。Profile maturity = 等到你看够足够多的顾客（500+）看到**真正的**模式后，再做昂贵决策（C2 编译）。

**Counter Decay——旧数据的半衰**：

MDO 的计数器定期减半（在 safepoint 中由 `MethodData::decay_counters()` 执行）。旧 profile 逐渐"消失"，新 profile 权重增大。目的：应用的 phase 变化（warmup→steady→peak）`→` warmup 期间的 profile 不应该永远影响 C2 决策。

Counterfactual："如果没有 decay：app 从 warmup 进入稳态后，warmup 的 profile（可能 100% 偏差）仍在 MDO 中永久存在 `→` C2 基于去年的数据做内联 `→` 错误内联 `→` deopt。"

### 4.3 ★★ Layer 3：ci/ Directory——Compiler Interface Bridge

**ci/ 层为什么必须存在？C2 不能直接读 MethodData 吗？**

C2 在编译线程上执行（非 safepoint）。`Method` / `InstanceKlass` / `MethodData` 是 JVM 的可变数据结构——可能被以下操作并发修改：
- 另一个线程的 `Method::set_code()` 替换 nmethod
- class redefinition（JVMTI RetransformClasses）修改方法体
- GC 移动 ConstantPool

如果 C2 直接读可变数据结构 → 看到中间状态 → 内联了不该内联的方法 → deopt 或 crash。

ci/ 层在 **编译开始时**快照所有需要的信息 `→` 构造 ciMethod、ciKlass、ciCallProfile `→` 编译期间 immutable `→` C2 看到一致的数据视图。编译结束后 ci 对象被销毁。

```
VM 数据结构 (mutable)               ci/ 快照 (immutable for compile duration)
┌───────────────────┐              ┌──────────────────────┐
│ Method*            │ ──快照──→   │ ciMethod*            │
│  ├ code (nmethod*) │              │  ├ instructions_size  │
│  ├ MethodData* MDO │              │  ├ bytecodes          │
│  └ bytecodes       │              │  └ ciMethodData*      │
├───────────────────┤              ├──────────────────────┤
│ InstanceKlass*      │ ──快照──→   │ ciKlass*             │
│  ├ vtable           │              │  ├ is_leaf_type()    │
│  ├ itable           │              │  ├ subklass_of()     │
│  └ hierarchy        │              │  └ is_loaded()       │
├───────────────────┤              ├──────────────────────┤
│ MethodData*         │ ──快照──→   │ ciMethodData*        │
│  ├ invocation_cnt   │              │  ├ receiver_count()  │
│  ├ receiver_types   │              │  └ branch_counts()   │
│  └ branch_data      │              │                      │
└───────────────────┘              └──────────────────────┘
```

### 4.4 ★★★ Layer 4：C2 Parse + Inline——Profile Consumption

C2 从 ci/ 层消费 profile 数据做 3 类决策：

**决策 1：InlineDecision（内联决策）**

`InlineTree::should_inline()` → `ciCallProfile(callee, bci)` → 检查 `receiver_count(0) / count()`：

```
count = 230000 (总调用次数)
receiver_count(0) = 150000 (HashMap 被观测 150000 次 = 65%)
receiver_count(1) = 80000  (TreeMap 被观测 80000 次 = 35%)

65% > 90%? → NO → 不是单态
65% > 50%? → YES → 双态（bimorphic）
→ 内联 HashMap::hashCode() + TreeMap::hashCode() + guard check
```

**决策 2：TypeFlow（类型传播）**

`ciTypeFlow::flow_types()` 在 C2 Parse 之前做快速类型分析 `→` 为每个 bci 处的局部变量/表达式栈元素给出准确类型 `→` Parse 用这些类型初始化 Node::bottom_type() `→` 避免 Parse 阶段做保守假设。例如：如果 ciTypeFlow 确定 bci=42 处的表达式栈顶是 `String` 类型 → Parse 的后续 IGVN 可以用 `String` 做类型优化，而不是 `Object` 的保守类型。

**决策 3：BranchFreq（分支频率）**

C2 从 MethodData 的 `BranchData` 读取 `taken_count / not_taken_count` `→` 设置 IfNode 的分支概率 `→` C2 基于概率重排代码块——高频路径放热区域（代码布局优化）。

### 4.5 ★★★ Profile 污染——3 种模式 + 诊断 + 修复

| 污染模式 | 原因 | 生产症状 | 修复 |
|---------|------|---------|------|
| **Warmup 偏差** | 启动前 10s profile 与稳态相差大——C2 基于 warmup profile 编译 | deopt 风暴→CodeCache full | 提高 `MatureInvocationLimit`（等更长时间收集更多数据）→让 profile 更接近稳态 |
| **采样偏差** | MDO 只记录 2-4 个 receiver——真正的 receiver 是第 5 种类型，不被记录 | C2 "不知道" 第 5 个 receiver 存在→不做 bimorphic guard→频繁 deopt | 修改代码：显式 if-else dispatch，不依赖 C2 speculative inlining |
| **单次事件污染** | 1 次异常代码路径被 C1 记录→MDO 显示此分支 50% 被 taken → C2 优化此分支 | 为 0.1% 的路径浪费 CodeCache + 分支预测 | `PerMethodRecompilationCutoff` 限制重编译次数→让 C1 L3 重新收集 profile |

**诊断 workflow**：

```bash
# 1. 识别 profile 污染
-XX:+PrintCompilation -XX:+PrintInlining -XX:+PrintDeoptimizationDetails
# 寻找：同一方法反复出现 deopt（recompile_count > 3）

# 2. 查 MDO 内容
-XX:+PrintMethodData
# 输出 invocation_counter / receiver_type 分布 → 对比已知的稳态流量

# 3. 确认 maturity 状态
# 如果 invocation_counter 接近 500 但仍在 warmup → maturity 可能过早

# 4. 修复
-XX:TieredStopAtLevel=3              # 临时——只做 C1，不用 C2
-XX:MatureInvocationLimit=2000       # 提高 maturity 门槛
-XX:PerMethodRecompilationCutoff=200  # 限制每个方法的重编译次数
```

**`-XX:TieredStopAtLevel=3` 为什么能'修复'？** TieredStopAtLevel=3 = 只到 C1 L3（full profile + low optimization）。C1 L3 的内联策略比 C2 保守——不做基于 speculative assumption 的 deep inline。即使 profile 被污染，也只影响 C1 L3 的 mild optimization `→` 不会导致 CodeCache 爆炸。代价：失去 C2 的深度优化 `→` 峰值性能降低 20-30%。这是"安全阀"——给 MDO 更多时间收集更好的 profile。

### 4.6 ★ ciTypeFlow——Parse 之前的预类型分析

`ciTypeFlow::flow_types()` 在 C2 Parse 之前做一版快速类型分析——类似 C1 的 SEAF（Semi-pruned SSA with Exception handling And Flow-sensitive）——在 ~2ms 内计算每个 bci 处每个局部变量和表达式栈元素的类型。结果传给 Parse `→` 用准确的类型初始化 Node::bottom_type() `→` 避免 Parse 阶段做保守假设（假设所有值都是 `Object`）。

**ciTypeFlow vs C2 后续类型分析**：
- ciTypeFlow: 保守（不做 loop unrolling、不做 inline、不做 inter-procedural）——但**快**（~2ms）
- C2 IGVN/CCP: 精确（有完整的 Ideal Graph）——但**慢**（在 graph 构建后才能做）
- ciTypeFlow 的目的是：给 Parse 一个"接近正确"的初始类型——减少 C2 后续 IGVN 的迭代次数。如果 ciTypeFlow 出错 → C2 后续分析会纠正——不影响正确性，只影响编译时间。

---

## §五 ★ Mermaid：4 层 Pipeline——C1 采集 → MDO → ci → C2 消费

```mermaid
graph TD
    subgraph Layer 1: C1/Interpreter
        A[C1/解释器 执行方法] --> B[invocation_counter++<br/>backedge_counter++]
        B --> C[每次 invokevirtual:<br/>记录 receiver klass]
        C --> D[每次 if/else:<br/>记录 taken/not_taken]
    end

    subgraph Layer 2: MethodData (MDO)
        D --> E[MethodData::invocation_counter_inc]
        E --> F{MethodData::profile_maturity?}
        F -->|invocation_count >= 500| G[MDO mature → 触发 C2 编译]
        F -->|NOT mature| H[C1 L3 继续收集 profile]
        H --> E
    end

    subgraph Layer 3: ci/ 包装层
        G --> I[ciObjectFactory::create_ciObject]
        I --> J[ciMethod: 快照 Method* + bytecodes]
        I --> K[ciCallProfile: 快照 receiver_type]
        I --> L[ciKlass: 快照 class hierarchy]
    end

    subgraph Layer 4: C2 Parse + Inline
        J --> M[Parse: 用 ciMethod 读 bytecodes]
        K --> N[InlineTree: 用 ciCallProfile 做内联决策]
        L --> O[CHA: 用 ciKlass 做单态判断]
        M --> P[IGVN + Inline + LoopOpt + ... ]
        N --> P
        O --> P
        P --> Q[C2 输出 nmethod → CodeCache]
    end

    style F fill:#FFD700,stroke:#B8860B
    style G fill:#90EE90,stroke:#006400
    style I fill:#87CEEB,stroke:#000080
    style N fill:#FFA500,stroke:#8B0000
```

**关键数据转换**：

| 阶段 | 输入数据结构 | 输出数据结构 | 数据维度 |
|------|------------|------------|---------|
| C1 采集 | 方法执行 | MethodData::DataLayout[] | invocation_count + receiver_klass + branch_stats |
| MDO 检查 | MethodData counter | profile_maturity = bool | >= 500 or not |
| ci 快照 | MethodData* | ciCallProfile + ciKlass | receiver_count(0)/count(), is_leaf_type() |
| C2 决策 | ciCallProfile | inline / dont-inline | 90%→单态, 50-90%→双态, <50%→polymorphic |

---

## §六 ★ GDB 验证——10 个关键断点

### 断言 1：`MethodData::invocation_counter_inc()` —— 调用计数器递增

```gdb
(gdb) br methodData.cpp:50  # invocation_counter_inc 内部
(gdb) p _invocation_counter
# 预期: 递增前的值——如 499
(gdb) n  # step over increment
(gdb) p _invocation_counter
# 预期: 递增后的值——500
# 当达到 500 → profile_maturity() 应该返回 true
```

### 断言 2：`MethodData::profile_maturity()` —— 成熟度检查

```gdb
(gdb) br methodData.cpp:200  # profile_maturity 返回
(gdb) p _invocation_counter
# 预期: >= 500 或 < 500
(gdb) p $
# 预期: true（invocation_counter >= 500 或 backedge >= 500 且 call site 数据完整）
# 如果 false → C2 编译被推迟 → 只做 C1 L3
```

### 断言 3：`ciMethod::ciMethod()` —— 快照 Method* + 字段

```gdb
(gdb) br ciMethod.cpp:100  # ciMethod 构造器
(gdb) p _method
# 预期: Method* 指针——被快照的原始 Method
(gdb) p _method_data
# 预期: MethodData* 指针——被快照的 MDO（如果有）
(gdb) p _instructions_size
# 预期: 字节码大小——从 Method::code_size() 快照
```

### 断言 4：`ciCallProfile::ciCallProfile()` —— 打印 receiver_count / count

```gdb
(gdb) br ciCallProfile.hpp:110  # ciCallProfile 构造器
(gdb) p _count
# 预期: 总调用次数——如 230000
(gdb) p _receiver_count[0]
# 预期: 最常见 receiver 的次数——如 150000
(gdb) p _receiver_count[0] * 100 / _count
# 预期: receiver 百分比——如 65%
# 65% < 90% → 不是单态 → bimorphic guard
```

### 断言 5：receiver_count(0) / count() > 90% —— 验证单态决策

```gdb
(gdb) br doCall.cpp:150  # should_inline 中的 profile 检查
(gdb) p call_profile->receiver_count(0) * 100 / call_profile->count()
# 预期: 百分比
# 如果 > 90% → C2 做单态内联（最常见的 receiver） + guard check
# 如果 < 50% → C2 不做 speculative inlining → vtable dispatch
```

### 断言 6：`ciTypeFlow::flow_types()` —— 打印 bci 处的类型信息

```gdb
(gdb) br ciTypeFlow.cpp:300  # flow_types 内部
(gdb) p bci
# 预期: 当前分析的字节码偏移
(gdb) p state()->type_at(local_index)
# 预期: ciType*——此局部变量的类型
# 如 "java/lang/String" 而不是 "java/lang/Object"（保守的）
```

### 断言 7：ciKlass::is_leaf_type() —— 类层次检查

```gdb
(gdb) br ciKlass.cpp:80  # is_leaf_type 返回
(gdb) p _klass->name()->as_utf8()
# 预期: 类名——如 "java/util/HashMap"
(gdb) p $
# 预期: true（HashMap 在当前类层次中没有子类）或 false（有子类被加载）
# true → CHA 可以做单态内联
```

### 断言 8：Counter decay 在 safepoint 时——计数器减半

```gdb
(gdb) br methodData.cpp:350  # decay_counters 中
(gdb) p _invocation_counter
# 预期: decay 前——如 800
(gdb) n  # step over decay
(gdb) p _invocation_counter
# 预期: decay 后——400（减半）
# 目的: 旧 profile 逐渐"消失" → 新 profile 权重更大
```

### 断言 9：TieredStopAtLevel=3 时——C2 编译不被触发

```bash
# JVM 参数: -XX:TieredStopAtLevel=3
-XX:+PrintCompilation
# 输出中所有编译的 level 为 0 - 3
# 没有 level 4 (C2) 条目 → C2 被完全禁用
```

### 断言 10：ciCallProfile 为空时（无 profile）→ count() = 0

```gdb
(gdb) br ciCallProfile.hpp:80  # ciCallProfile 构造器（无 profile 路径）
(gdb) p _count
# 预期: 0——MethodData 中此 bci 处没有 profile 数据
# C2 行为: 不做 profile-based inline → 只用 CHA 做内联决策
```

---

## §七 ★ 面试 Story Format——"C2 怎么读取 C1 的 profile？ci/ 层做什么？"（90 秒版）

C2 不是瞎子——它透过 ci/ 目录看到 C1/解释器在执行时收集的运行时数据。整个管道有 4 层。

**第一层：C1/解释器。** 每次 invokevirtual 调用——C1 编译的代码执行 ~5 条 x86 指令更新 MethodData（MDO）：接收者的类是哪个 + 调用次数 + 1。每次 if/else——更新 taken/not-taken 计数。这个数据存在方法的 MDO 中——从 C-Heap 分配，不在 GC 扫描范围内。

**第二层：MethodData（MDO）。** 但 10 次 warmup 调用收集的 profile 不能被 C2 信任——MDO 有"成熟度"机制：`invocation_counter >= 500` 或 `backedge_counter >= 500` 且所有 call site 数据完整 `→` 成熟。未成熟的 profile `→` C2 忽略 `→` 只做 C1 L3 编译——继续收集 profile。

**第三层：ci/ 包装层。** 当 MDO 成熟且 C2 编译被触发——ci/ 层在编译开始时**快照**所有信息：ciMethod（bytecodes + exception handlers）、ciCallProfile（receiver 类型统计）、ciKlass（类层次关系）。快照后编译期间 immutable——因为 C2 在非 safepoint 编译线程上执行，不能直接读 JVM 的可变数据结构（可能被 GC 线程修改）。

**第四层：C2 消费。** Parse 用 ciMethod 读 bytecodes。InlineTree 用 ciCallProfile 做内联决策：`receiver_count(0) / count() > 90%` `→` 单态内联最常见类型 + guard check。CHA 用 ciKlass::is_leaf_type() 判断 invokevirtual 是否可以单态化。

最关键的是**防止 profile 污染**：warmup 偏差、采样偏差、单次事件污染——都会导致 C2 基于错误数据做决策 `→` deopt 风暴 `→` CodeCache 爆炸。Maturity 机制是第一道防线；提高 `MatureInvocationLimit` 和 `TieredStopAtLevel=3` 是应急修复。

---

## §八 和 [01][02] 的交叉验证

| 交叉文档 | 相关内容 | 验证方法 |
|---------|---------|---------|
| 01-Pipeline §二 | Parse 用 ciMethod 读取方法 body + bytecodes | GDB 断点 ciMethod 构造器——快照 Method* → C2 Parse 使用 |
| 02-Inline §二 | CHA——静态类层次分析 → ciKlass 提供 | ciKlass::is_leaf_type() → 决定 CHA 单态化 |
| 02-Inline §三 | Type Profile——C2 消费端 → ciCallProfile 提供 | ciCallProfile::receiver_count(0)/count() → 决定单态/双态/polymorphic |
| 02-Inline §四 | InlineTree::should_inline() —— 消费 ciCallProfile | doCall.cpp 断点——验证 profile 如何影响内联决策 |

---

## 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | **Profile 数据流有 4 层——不是"直接读取"** | C1→MDO→ci→C2：每层有独立的目的——采集、存储、隔离、消费 |
| 2 | **ci/ 层的核心价值是"不可变快照"** | C2 在非 safepoint 线程执行——不能读可变数据——ci 层提供编译期一致性 |
| 3 | **Profile Maturity 是第一道防污染线** | 500+ 次调用才信任——防止 warmup 偏差导致 C2 错误内联 |
| 4 | **Counter decay 是"时间维度"的过滤** | 旧数据半衰→新数据权重增大→防止 phase 变化后的决策错误 |
| 5 | **3 种 Profile 污染模式** | warmup 偏差、采样偏差、单次事件污染——各有不同的根因和修复方式 |
| 6 | **ciTypeFlow = Parse 前的"预类型分析"** | ~2ms 快速分析→给 Parse 准确的初始类型→减少 IGVN 迭代 |
| 7 | **TieredStopAtLevel=3 是 Profile 污染的临时安全阀** | 不用 C2→省 CodeCache→给 MDO 更多时间收集好 profile→后续提升到 C2 |
