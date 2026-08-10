# 02-Inline-Decision — C2 内联决策：InlineTree 的递归决策引擎如何用 CHA + Type Profile 决定"内联 or not"

> **阶段**：[05-jit-compiler]
> **前置**：[01-C2-Pipeline] §二（Parse——字节码→Node） + §三（IGVN——hash-consing）
> **配套**：[04-CodeCache-Sweeper]（内联过深的后果——CodeCache 爆炸）、[07-Profile-Data-Flow]（type profile 的数据来源——ci/ 层）
> **后续依赖本文**：无直接后续（内联是叶节点优化），但 [01] 的 Inline 阶段引用本文
> **阅读收益**：理解 C2 如何用 InlineTree 递归决策树决定"内联 or not"——从 5 步决策链到 CHA 静态分析到 type profile 动态数据；从"内联到哪个深度"的权衡到"PrintInlining 日志解读"的生产诊断工作流

---

## §〇 生产场景——CodeCache 100% 满，inline depth 无限制

### 真实 PrintInlining 输出——1 个方法内联了 2000+ 层

启动后前 2 分钟。你打开 `-XX:+PrintInlining`：

```
@ 12 java.util.HashMap::hash (62 bytes)   inline (hot)
  @ 4 java.util.Objects::hashCode (12 bytes)   inline (hot)
    @ 4 java.lang.String::hashCode (49 bytes)   inline (hot)
      @ 19 java.lang.String::value (5 bytes)   accessor
    @ 8 java.lang.String::hashCode (49 bytes)   already compiled into a big method
  @ 9 java.lang.Integer::hashCode (10 bytes)   inline (hot)
```

Interpreting this inline tree:
- `@ 12` = the call site is at bytecode offset 12 in the caller method
- `inline (hot)` = C2 profiled this call site > `InlineFrequencyRatio` threshold
- `already compiled into a big method` = this callee was ALREADY inlined into ANOTHER caller. C2 won't inline it twice — this is the mechanism that prevents CodeCache explosion
- `accessor` = trivial field access (e.g., just `return value`), always inlined
- Each level of indentation = 1 more level of inline depth → 4 levels deep here means the root method inlined 4 levels of callee code

**问题**：`MaxInlineLevel=9` 默认深度允许 9 层递归内联。对于此调用链：`processRecords()` → `HashMap::hash()` → `Objects::hashCode()` → `String::hashCode()` → `String::value()` → ... → 单次编译生成了 ~2000 个内联 callee → 单个 nmethod 2MB。

**后果链**：
```
单个 nmethod 2MB → CodeCache 97% → Sweeper 太慢 → CodeCache 100% → CompileBroker 停止
→ 热方法卡在解释器 → QPS -80%
```

### 10 分钟诊断 + 修复

```bash
# 1. 诊断：PrintInlining 查看过度内联
-XX:+PrintInlining | grep "inline (hot)" | wc -l
# → 2000+ lines → 过度内联确认

# 2. 定位：哪个 root method 触发了最深层内联？
-XX:+PrintCompilation -XX:+PrintInlining | head -1
# → processRecords → 限制其内联深度

# 3. 修复：降低内联深度
-XX:MaxInlineLevel=7          # 从 9 降到 7
-XX:MaxInlineSize=25          # 从 35 降到 25
-XX:CompileCommand=dontinline,com/example/processRecords  # 跳过问题方法
```

**根因分析**：`MaxInlineLevel=9` 对这个特定调用链太深。每层内联把 callee 的 Node 图嵌入 caller → 内联 2000 个 callee → Node 图从 ~200 膨胀到 ~10000+ → matching/output 产生 2MB 机器码。这不是内联的 bug——是 `MaxInlineLevel=9` 的默认假设（"大多数调用链在 5 层内终止"）对此 workload 失效。

---

## §一 ★★★ 内联不是优化——内联是优化器

### 1.0 本文不做什么

本文不是 `doCall.cpp` 的逐行源码翻译。本文是 **内联决策的 ARCHITECTURE STORY**：C2 的新手需要理解的核心问题是——**内联为什么是 JIT 最重要的单一优化**。内联本身消除的 `call/ret` 开销只有 ~5 cycles。内联的核心价值是**让所有其他优化"看见"更多代码**——从"在隔壁房间隔着墙观察程序"变成"在同一个房间里看到全部细节"。

### 1.1 读者前提——你从哪里来

你从 [01-C2-Pipeline] §二 学完：Parse 阶段对每个 `invokevirtual` 创建 `CallStaticJavaNode`。§三 学完：IGVN 阶段在 Inline 之前先优化 root method 的图。**本文回答：`InlineTree::should_inline()` 怎么决定是否内联这个 `CallStaticJavaNode`？InlineTree 的递归决策逻辑是什么？CHA 和 type profile 在内联决策中各自贡献什么？**

```
[01-Pipeline] §二/§三                           本文从这里开始
      │                                              │
      ▼                                              ▼
Parse → CallStaticJavaNode ──→ should_inline() ──→ inline / dont-inline
                                       │
                                       ├─ ForceInline? (白名单)
                                       ├─ DontInline? (黑名单)
                                       ├─ Depth ≤ 9?
                                       ├─ Size ≤ 35 bytes?
                                       └─ Frequency > threshold?
```

### 1.2 你需要知道的——5 个概念 callout 框

> **以下 5 个概念是理解内联决策的前提。每个不超过 200 字，自包含——不依赖本文其他部分。**

#### 概念 1：InlineTree（内联树）

InlineTree 是 C2 用于管理内联决策的递归数据结构——一棵调用树。根节点 = 被编译的根方法。叶节点 = 被内联的叶子方法。每个节点存储：callee 的 `ciMethod*`、调用 `bci`（字节码索引）、inline 深度、调用频率。`InlineTree::should_inline(ciMethod* callee)` 在每个节点上做决策——如果决定内联 → 创建子节点 → 在子节点上继续递归决策。树的深度 = 内联深度——`inline_level()` 返回当前节点距离根节点的层数。

#### 概念 2：CHA（Class Hierarchy Analysis）

CHA = 类层次分析——编译时扫描**已加载的**类层次结构，判断 invokevirtual 调用的接收者类型。如果 `HashMap.hashCode()` 是 `invokevirtual Object::hashCode()`——但 JVM 当前只加载了 `HashMap`（没有 `HashMap` 的子类加载）→ CHA 判断："Object::hashCode() 在当前类层次中只有 1 个实现 → 可以用单态调用（monomorphic）替代虚拟调用"。CHA 的风险：如果之后加载了 HashMap 的子类并重写了 hashCode() → CHA 的假设破灭 → deopt。

#### 概念 3：Type Profile（类型画像）

C1（L2/L3 编译级别）在执行时收集每次 invokevirtual 的**实际接收者类型**。C2 编译时读取此 profile：`ciCallProfile::receiver_count(i)` 返回第 i 个接收者类型被观察到的次数。如果 99% 的调用都是 HashMap → C2 内联 HashMap::hashCode()，并为剩余 1% 生成 guard check（`cmp [recv+klass], HashMap_klass; jne uncommon_trap`）。

#### 概念 4：Hot Count（热度计数）

不是所有方法都值得内联——只内联"热"的。`ciCallProfile::count()` 返回此调用点的总调用次数。"热"的定义：频率高于 `InlineFrequencyRatio`（默认 ~20%）→ 相对于 root method 的热度。一个 root method 里被调用了 5000 次的方法大概率热；被调用了 5 次的方法不值得内联。

#### 概念 5：Uncommon Trap（罕见陷阱）

C2 内联时基于 CHA 或 type profile 做了**单态假设**——生成了一个 guard check。如果 guard 失败（接收者不是假设的类型）→ 触发 `uncommon_trap` → deopt 回解释器 → 解释器重新执行此 invokevirtual → 可能触发新的 C2 编译（基于新的、更准确的 type profile）。Uncommon trap 的代价：deopt（~1000 cycles）+ 解释执行（慢 20-100×）+ 重编译（~100ms）。

---

## §二 标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintCompilation -XX:+PrintInlining`
- 64 位 Linux x86_64
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:+PrintInlining` 是本文的核心诊断工具

---

## §三 源文件生态——6 个文件驱动内联决策

| # | 文件 | 完整路径 | 模块 | 核心函数 | 本文角色 |
|---|------|---------|------|---------|---------|
| 1 | `doCall.cpp` | `src/hotspot/share/opto/doCall.cpp` | opto | `InlineTree::should_inline()`(:54-250)、`InlineTree::try_to_inline()`(:252-528) | ★★★ InlineTree 决策引擎——核心 |
| 2 | `inline.cpp` | `src/hotspot/share/opto/inline.cpp` | opto | `InlineTree::InlineTree()`(构造器)、`InlineTree::build_inline_tree()` | ★★ InlineTree 构造 |
| 3 | `bytecodeInfo.cpp` | `src/hotspot/share/opto/bytecodeInfo.cpp` | opto | `InlineTree::should_not_inline()`、`ciMethod::should_inline()`、`ciMethod::should_not_inline()` | ★★ Inline 策略规则 |
| 4 | `ciMethod.cpp` | `src/hotspot/share/ci/ciMethod.cpp` | ci | `ciMethod::instructions_size()`、`ciMethod::has_compiled_code()`、`ciMethod::should_inline()` | ★★★ CI 层方法接口 |
| 5 | `ciCallProfile.hpp` | `src/hotspot/share/ci/ciCallProfile.hpp` | ci | `ciCallProfile::count()`、`receiver_count()`、`argument_projected_type()` | ★★★ C1 profile 数据消费 |
| 6 | `ciKlass.hpp` | `src/hotspot/share/ci/ciKlass.hpp` | ci | `ciKlass::is_leaf_type()`、`subklass_of()`、`is_loaded()` | ★★ CHA——类层次分析 |

**跨模块说明**：内联决策跨 `opto/`（InlineTree 递归引擎）+ `ci/`（类型信息 + profile 数据）。`ciMethod` / `ciKlass` / `ciCallProfile` 是 C2 读取 JVM 内部数据的"视图层"。

---

## §四 ★★★ InlineTree：递归决策引擎

### 4.1 5 步决策链

`InlineTree::should_inline(ciMethod* callee, int bci)` 按以下顺序执行 5 步检查：

```
Step 1: callee->force_inline() → @ForceInline 注解?
  YES → inline always (白名单，不消耗预算)
  NO  → continue

Step 2: callee->should_not_inline() → @DontInline? native? abstract?
  如果 callee 是 native 方法（JVM 无法看穿 native code）→ NO
  如果 callee 是 abstract 方法（没有实现体）→ NO
  如果 callee 被 @DontInline 注解 → NO
  NO  → stop (黑名单，不浪费后续分析)
  都不是 → continue

Step 3: inline_level() > MaxInlineLevel(9)?
  YES → NO（递归深度超过 9 → 停止）
  NO  → continue

Step 4: callee->code_size() > MaxInlineSize(35)?
  YES → NO unless frequency overrides
  NO  → continue

Step 5: callee->call_count() / total_calls > InlineFrequencyRatio?
  YES → inline (足够热)
  NO  → NO (不够热)
```

**为什么是这个顺序？** "便宜检查 → 贵检查"——先过滤绝大多数不合适的候选，再对通过初筛的候选做昂贵的热度分析。步骤 1-4 都是 O(1) 检查（查标志位 / 数值比较），步骤 5 需要读取 MDO（MethodData Object）的 profile 数据——相对昂贵。

**深度限制计数器论**：为什么 MaxInlineLevel=9？因为每个 call site 是一个树节点。深度 9 = 2^9 个可能的 callee（如果每个方法调用 2 个其他方法）→ 512 个方法在 1 个 nmethod 中。深度 10 = 1024 个方法 → 4 倍编译时间。9 是编译时间跨越编译收益的分界点。

**大小限制计数器论**：如果无大小限制——内联所有方法 → CodeCache 10 倍增大 → sweeper 不堪重负 → 紧急 flush 风暴。MaxInlineSize=35 的原因是：内联后 callee 的 Node 数量 ≈ code_size × 4 = 140 Node。root method 默认 ~1000 Node → 每内联 1 个方法增加 140 Node → 内存和编译时间线性增长。热方法可以超限——`InlineFrequencyRatio` 检查：如果调用频率 > 20% root freq → 即使 code_size > 35 也可以内联——但受 `FreqInlineSize`（默认 325 bytes）上限约束。

**`hash(String s)` 的内联决策实战**：

```
root method: hash(String s)
  CallStaticJavaNode at bci=10: invokevirtual String::hashCode()
  → Step 1: @ForceInline? NO（String.hashCode() 没有此注解）
  → Step 2: @DontInline/native/abstract? NO
  → Step 3: inline_level() = 1 < 9 → PASS
  → Step 4: hashCode() code_size = 49 > 35 → SIZE FAIL
      → 但 hashCode() 调用频率 > InlineFrequencyRatio → HOT OVERRIDE → PASS
  → Step 5: call_count / total_calls > 20% → PASS
  → result: INLINE

  hashCode() inlined → now in hashCode() body:
    CallStaticJavaNode at bci=19: invokevirtual String::value()
    → Step 1-3: PASS
    → Step 4: value() code_size = 5 < 35 → PASS
    → Step 5: accessor (trivial getter) → ALWAYS INLINE
    → result: INLINE
```

### 4.2 CHA（Class Hierarchy Analysis）——静态类层次分析

**当 C2 看到 `invokevirtual hashCode()`，它不知道哪个类的 hashCode。CHA 检查：接收者声明类型有多少个具体子类？**

`ciKlass::is_leaf_type()` → 只有 1 个已加载的具体实现 → monomorphic → 内联为直接调用 + CHA guard。

编译后的代码：
```asm
cmp  [recv + klass_offset], expected_klass   ; 检查接收者是否是期望的类型
jne  uncommon_trap                             ; 如果不是 → 去优化
call hashCode_direct                          ; 直接调用（非 virtual dispatch）
```

如果 guard 通过（99.9% 的调用）：直接调用，~1 cycle。如果 guard 失败：deopt，~5000 cycles。

**计数器论**：没有 CHA → 每次 invokevirtual = vtable dispatch = 4 次内存读取（klass → vtable → itable → entry）= ~20 cycles。有 CHA：1 cmp + 直接调用 = ~2 cycles。单态调用加速 10×。

`ciKlass::has_subklass()` → 多个子类 → bimorphic → 为两个最常见类型各自内联 + guard：

```asm
cmp  [recv + klass], HashMap    ; 类型 1
je   hashMap_code
cmp  [recv + klass], ArrayList  ; 类型 2
je   arrayList_code
jmp  vtable_dispatch            ; slow path——真实的 vtable 分发
```

**计数器论**：没有 bimorphic → monomorphic + deopt for TreeMap。如果 TreeMap 频率 < 0.01% → deopt 率可忽略。但如果 TreeMap 频率 = 40% → 40% deopt 率 → 重编译循环。Bimorphic 处理 2 个常见类型无需 deopt。

**CHA 的局限**：CHA 只考虑"已加载的"子类——如果之后加载了新子类 → CHA 的 leaf type 假设破灭 → 依赖被 JVM 记录在 `dependency_context` 中 → 如果 X 的子类被加载 → 所有依赖"X 是 leaf type"的 nmethod → deopt。

**CHA vs Type Profile**：CHA = 静态保证（已加载类 → 100% 确定）。Type Profile = 运行时采样（可能有偏差）。如果 CHA 说"只有 1 个实现"→ 无视 type profile（即使 profile 说 50%/50%——但这不可能发生，因为 CHA 说了只有 1 个实现）。如果 CHA 说"多个实现"→ 看 profile——如果 99% HashMap → 内联 HashMap + guard。两者不冲突——CHA 对于已加载类是正确的。

### 4.3 Type Profile（类型画像）——从 C1 的运行时数据

**CHA 是盲目的——它不知道经验频率。CHA 说"子类 X 存在"→ 可能。Profile 说"子类 X 在 100000 次调用中从未出现"→ 不要为它 guard。**

`ciCallProfile::count()` —— 总调用次数 = `counter_count + data_count`
`ciCallProfile::receiver_count(i)` —— 第 i 个接收者类型被观察到的次数
`ciCallProfile::receiver_projected_type(i)` —— 第 i 个参数的类型（不只是接收者）

**数据来源**：C1（L2/L3）在执行时收集 MethodData（MDO = Method Data Object）。MDO 存储在 `Method*` 之后。每次 invokevirtual 执行 → `MethodData::receiver_type_data()->add_receiver(receiver_klass)` 增加计数器。`ciCallProfile` 是 C2 层对 MDO 的只读包装。

**Profile 成熟度**：`MethodData::profile_maturity()` 检查 MDO 是否足够成熟。如果 MDO 未成熟 → C2 不做 C2 级编译 → 只做 C1 L3 编译（继续收集 profile）。直到 `invocation_count >= MatureInvocationLimit=500` 或足够多的 backedge → 才触发 C2 编译。这防止 C2 基于预热期间的偏差数据做错误的内联决策。

**计数器论**：没有 profiling → C2 必须为所有可能的子类 guard。5 个子类 → 5 路 guard → 25 cycles/call。有 profiling：99.9% = HashMap → 1 路 guard + 慢路径 = 3 cycles + 偶尔 deopt。

**Profile 污染的灾难**：

- 场景：type profile 说 "99% HashMap"但实际线上流量有 30% TreeMap
- 后果：C2 内联 HashMap::hashCode() + guard for 1% TreeMap → 实际 30% 调用触发 guard → 30% 调用走 `uncommon_trap` → deopt 风暴 → CPU 50% 在 deopt blob
- 修复：(a) 增大 `-XX:MatureInvocationLimit` → profile 更成熟后才 C2 编译；(b) `-XX:CompileCommand=dontinline,HashMap::hashCode`；(c) 重启 JVM（清除被污染的 profile）

### 4.4 Late Inline（IGVN 之后的补内联）

**为什么不在 Parse 阶段立即内联所有方法？**

如果 Parse 立即内联 → 构建一个巨大的初始图（1000+ Node）→ IGVN 要处理这个大图 → 编译时间爆炸（O(N²) with graph size）。策略：先构建 root method 的小图（~200 Node）→ IGVN 优化到 ~100 Node → 然后对内联候选做 late inline（把 callee 的 Node 嵌入优化后的图）。

`PhaseIdealLoop::do_call()` 遍历 Ideal Graph 中的 `CallNode` → 检查 call 是否有 `CallGenerator::for_late_inline()` → 如果有 → 在 IGVN 收敛后、LoopOpt 之前执行 inline。

**Late inline 和 early inline 的分工**：

| 类型 | 时机 | 目标方法 | 大小限制 |
|------|------|---------|---------|
| Early inline | Parse 阶段 | 小方法 + @ForceInline + accessor | code_size < 35 bytes |
| Late inline | IGVN 收敛后 | 中等大小 + 热调用点 | 35-325 bytes |

**计数器论**：内联 BEFORE IGVN → 在冗余计算图上内联 → 2× Nodes → IGVN 更慢。IGVN 之后：图已干净 → 内联增加更少 Node → 更快。

### 4.5 ★★★ 内联的瀑布效应——具体数字对比

**内联的显性收益**：消除方法调用开销（~3-15 cycles/call）。

**内联的核心收益**：让其他优化"看见"更多代码（multiplicative effect）。

```
process() { hash(a); hash(b); hash(c); hash(d); }
```

**不内联**：
```
process 的 4 条 call hash() = 4 × 40 cycles 调用开销 = 160 cycles
hash() 本身 = 8 cycles × 4 = 32 cycles
hashCode() = 49 cycles × 4 = 196 cycles
总指令数: ~82
总周期: ~200 cycles
```

**内联后**：
```
IGVN 看到 hashCode() 被 compute 了 4 次 → 相同的输入 a/b/c/d → 但 IGVN 发现：
  如果输入都不同 → 无法消除计算
  但如果 process() 调用了 4 次同一个 hashCode 被 inline → IGVN 发现重复
总指令数: 10 + 16 - 3 (合并) = 23
总周期: ~50 cycles
加速比: 200/50 = 4× ← 只来自内联本身
```

**加上后续优化的额外收益**：
- EA 跨方法边界追踪对象 → 原本逃逸的对象现在不逃逸 → 标量替换 → 省 GC
- LoopOpt 跨方法边界提升循环不变代码 → 省 ~200 cycles
- 常量传播跨方法边界 → 消除条件分支 → 省分支预测失败 penalty

**总计：内联是"乘数"而不是"加数"——1 次内联触发 10+ 次下游优化。总加速比可达 10-100×。**

### 4.6 ★ Production：`PrintInlining` 日志解读

`-XX:+PrintInlining` 输出格式：

```
@ <bci> <callee_class>::<callee_method> (<code_size> bytes)  <decision>
```

**8 种决策标记完整解读表**：

| 标记 | 含义 | 原因 | 建议操作 |
|------|------|------|---------|
| `inline (hot)` | 已内联——调用足够热 | 频率 > `InlineFrequencyRatio` | 无需操作——这是正常行为 |
| `accessor` | 已内联——trivial getter/setter | 方法只返回一个字段 | 无需操作——总是内联，不占预算 |
| `already compiled into a big method` | 不内联——callee 已被内联到 caller 的其他位置 | 防止重复内联 → 防止 CodeCache 爆炸 | 无需操作——这是保护机制 |
| `callee is too large` | 不内联——callee 字节码 > MaxInlineSize(35) | 内联太大 → CodeCache 压力 | 如果此 callee 是关键热路径 → `-XX:MaxInlineSize=500` |
| `inline level too deep` | 不内联——递归深度 > MaxInlineLevel(9) | 深度内联收益递减 + CodeCache 风险 | 如果确定需要 → `-XX:MaxInlineLevel=12` |
| `no static binding` | 不内联——虚拟调用有多个子类型 | CHA 无法单态化 + profile 不支持 | 重构代码消除多态，或 `-XX:CompileCommand=inline` |
| `not compilable` | 不内联——callee 不能被编译 | 方法有编译限制（如 JVMCI） | 检查 callee——为什么不能编译 |
| `intrinsic` | 已内联——JVM intrinsic（如 `System.arraycopy`） | 直接用对应汇编实现 | 无需操作——intrinsic 比正常内联更快 |

**诊断过度内联**：
```bash
# 查看每个 root method 的内联深度
-XX:+PrintInlining | awk '{print length($0) - length(substr($0, 1, index($0, "@")))}' | sort -rn | head -20
# 缩进越深 → 内联深度越大

# 定位最大的单个 nmethod
jcmd <PID> Compiler.CodeHeap_Analytics | grep "nmethod" | sort -t':' -k2 -rn | head -10
```

---

## §五 ★ Mermaid：InlineTree 递归决策树

```mermaid
graph TD
    A[Parse::do_call<br/>invokevirtual bci=N] --> B{callee->force_inline?<br/>@ForceInline?}
    B -->|YES| INLINE[★ INLINE<br/>always inline]
    B -->|NO| C{callee->should_not_inline?<br/>@DontInline / native / abstract?}
    C -->|YES| NO1[❌ NO<br/>blacklist reject]
    C -->|NO| D{inline_level > MaxInlineLevel?<br/>default: 9}
    D -->|YES| NO2[❌ NO<br/>too deep]
    D -->|NO| E{callee->code_size > MaxInlineSize?<br/>default: 35 bytes}
    E -->|YES: hot by freq| E2[hot override → continue]
    E -->|YES: cold| NO3[❌ NO<br/>too large]
    E -->|NO| F{call_count / total_calls<br/>> InlineFrequencyRatio?<br/>default: 20%}
    F -->|YES| INLINE2[★ INLINE<br/>hot enough]
    F -->|NO| NO4[❌ NO<br/>not hot enough]
    E2 --> F

    INLINE --> G[InlineTree::try_to_inline]
    INLINE2 --> G
    G --> H{CHA: is_leaf_type?<br/>单态?}
    H -->|YES: 1 impl| I[inline direct call + CHA guard<br/>cmp recv,klass; jne trap]
    H -->|NO: >1 impl| J{Type Profile?<br/>receiver_count}
    J -->|99% one type| K[inline most-common + guard<br/>bimorphic if 2 common types]
    J -->|no clear winner| L[vtable dispatch<br/>no inline]
    I --> M[late inline candidate<br/>IGVN then inline]
    K --> M
    M --> N[IGVN re-run → merge + fold → recurse]
```

**每层递归：**
```
Root: hash(String s)          ← inline_level = 0
  ├─ String::hashCode()       ← inline_level = 1 (depth check: 1 < 9)
  │   ├─ String::value()      ← inline_level = 2 (depth check: 2 < 9) — accessor
  │   └─ Arrays::copyOf()     ← inline_level = 2 — too large → NO
  └─ Integer::hashCode()      ← inline_level = 1 (depth check: 1 < 9)
```

---

## §六 GDB 验证——4 个关键断点

### 断言 1：`InlineTree::should_inline()` 入口——打印 callee name + size + decision

```gdb
(gdb) br doCall.cpp:115
(gdb) p callee_method->name()->as_utf8()
# 预期: 被内联候选的方法名——如 "hashCode"
(gdb) p callee_method->code_size()
# 预期: hashCode 的字节码大小 —— 49
(gdb) p callee_method->holder()->name()->as_utf8()
# 预期: callee 所属类——如 "java/lang/String"
(gdb) finish
(gdb) p $
# 预期: 返回值 —— NULL (不内联) 或 WarmCallInfo* (内联决策对象)
```

### 断言 2：`@ForceInline` 注解 → `should_inline_always()` == true

```gdb
(gdb) br bytecodeInfo.cpp:55  # should_inline_always 检查
(gdb) p callee_method->force_inline()
# 预期: true (如果有 @ForceInline 注解) 或 false
(gdb) p callee_method->name()->as_utf8()
# 预期: 有 @ForceInline 的方法名
# 如果 true → 跳过所有后续检查，直接内联
```

### 断言 3：inline_level() 达到 9 → should_inline 返回 false

```gdb
(gdb) br doCall.cpp:140  # inline_level() > MaxInlineLevel 检查
(gdb) p inline_level()
# 预期: 当前递归深度 (如 8 或 9)
(gdb) p MaxInlineLevel
# 预期: 9
(gdb) p inline_level() > MaxInlineLevel
# 预期: true (如果当前深度 ≥ 9 → 拒绝内联)
```

### 断言 4：ciCallProfile::receiver_count(0) — 查看 type profile 数据

```gdb
(gdb) br ciCallProfile.hpp:80  # receiver_count 返回
(gdb) p _receiver_count[0]
# 预期: 最常见的接收者类型的观测次数
(gdb) p _mdo
# 预期: MethodData 对象指针 —— profile 数据来源
(gdb) p _call_count
# 预期: 此调用点的总调用次数
# 如果 receiver_count(0) / call_count > 90% → 决策单态内联
```

### 断言 5：`ciKlass::is_leaf_type()` — CHA 单态判定

```gdb
(gdb) br ciKlass.hpp:180  # is_leaf_type 返回
(gdb) p is_loaded()
# 预期: true (类已被加载)
(gdb) p subklass()
# 预期: NULL (没有子类 → leaf type = true)
# 或: != NULL (有子类 → leaf type = false)
```

### 断言 6：Late inline 在 IGVN 之后、LoopOpt 之前注册

```gdb
(gdb) br compile.cpp:2281  # inline_incrementally 调用
(gdb) p _late_inlines.length()
# 预期: 等待被 late-inlined 的候选数量 (>0)
(gdb) p igvn._worklist.size()
# 预期: IGVN worklist 大小 (应该已经收敛——接近 0)
```

### 断言 7：PrintInlining 输出验证——内联后的 Node 数增长

```gdb
(gdb) br doCall.cpp:341  # try_to_inline 入口
(gdb) p C->unique()
# 预期: 内联前的 Node 总数
(gdb) p callee_method->code_size()
# 预期: callee 字节码大小
# 在内联完成后:
(gdb) p C->unique()  # 再次打印
# 预期: 新 Node 总数 > 旧 Node 总数（callee 的 Node 被注入）
```

### 断言 8：`InlineTree::should_not_inline()` — 黑名单拒绝

```gdb
(gdb) br bytecodeInfo.cpp:80  # should_not_inline 入口
(gdb) p callee_method->is_native()
# 预期: true 或 false
(gdb) p callee_method->is_abstract()
# 预期: true 或 false
(gdb) p callee_method->should_not_inline()
# 预期: true (如果 callee 在黑名单中) 或 false
```

---

## §七 ★ 面试 Story Format——"内联为什么是 JIT 最重要的优化？"（90 秒版）

内联不是优化——内联是优化器。

把 callee 的代码搬到 caller 内——不是为了省那 5 cycles 的 call/ret 开销。是为了让 C2 "看到"更多细节。

没有内联——C2 在隔壁房间观察你的程序。它看到一个 `invokevirtual hashCode()`——只能看到一个 `call 0x...`。它能做什么？什么也做不了。

有了内联——C2 在同一个房间里。它看到 `hashCode()` 内部的 `for (int i=0; i<len; i++) { h = 31*h + value[i]; }`。现在 IGVN 可以跨方法合并 3 次重复的 `hashCode()` 计算——从 3 × 16 条指令变成 1 × 16 条指令。EA 可以看穿方法边界——原来逃逸到 `add(new Foo())` 的 Foo，在 `add()` 被内联后发现还是不逃逸 → 标量替换 → 零堆分配。LoopOpt 可以跨方法边界提升循环不变代码。

具体数字：不内联 82 条指令、~200 cycles。内联后 23 条指令、~50 cycles——4× 加速只来自内联本身。加上下游优化——10×-100×。

这就是为什么我说内联是乘数而不是加数。1 次内联触发 10+ 次下游优化。没有内联——C2 的所有其他优化只能在方法边界内工作——对于现代 Java 代码的小方法风格（5-10 行方法）来说，几乎是瞎的。

---

## §八 核心发现总结

| # | 发现 | 核心洞察 |
|---|------|--------|
| 1 | **内联是优化的乘数，不是加数** | 1 次内联触发 10+ 次下游优化——GVN、EA、LoopOpt 全部跨方法工作 |
| 2 | **5 步决策链顺序不可重排** | 便宜检查（注解/标志位）→ 贵检查（profile 读取）——前 4 个 O(1) 过滤 90% 候选 |
| 3 | **CHA 给正确性保证，Profile 给频率信息** | CHA 说"子类 X 已被加载=可能性"→ Profile 说"子类 X 从未出现=不要 guard" |
| 4 | **Late Inline 是 C2 的专利设计** | C1 没有——先 IGVN 优化、再 inline——只内联重要调用，减少图膨胀 |
| 5 | **MaxInlineLevel=9 是编译时间的分界点** | 深度 9 = 512 个可能 callee，深度 10 = 1024 → 4× 编译时间 |
| 6 | **`already compiled into a big method` 是保护机制** | 防止同一个 callee 被内联到多位置 → 防止 CodeCache 爆炸 |
| 7 | **Profile 污染是生产灾难的主因** | 预热期的偏差 profile → 错误的内联决策 → deopt 风暴 → CPU 50% 在 deopt |
| 8 | **"内联到哪个深度"比"内联 yes/no"更重要** | 深度管理是 CodeCache 空间和编译收益的连续权衡——不是二值决策 |
