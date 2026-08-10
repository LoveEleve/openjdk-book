# PROMPT: 请撰写 04-Escape-Analysis.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

线上服务每 30 分钟一次 Full GC，GC 日志显示 `[Full GC (Allocation Failure) 81920K->81920K(131072K)]`，堆内存被频繁分配的对象塞满。但分析代码发现这些对象是方法局部 `new ArrayList<>()` —— 本应在方法返回后就不可达。

Root cause：这些 ArrayList 的引用被传递到 `synchronized` 块或 `ThreadLocal.set()` 中 → C2 逃逸分析标记为 `GlobalEscape` → 跳过标量替换 → 必须在堆上分配 → TLAB 耗尽 → 触发 GC。

正常情况（NoEscape）下，如果对象不逃逸方法/线程且不是传入参数引用的，C2 会将对象的字段拆分为独立标量变量分配到 CPU 寄存器或栈帧 → 零堆分配。但如果对象通过了 `synchronized(obj)` 锁块、赋值给了静态字段、或作为返回值传出 → `PointsToNode::GlobalEscape` → C2 放弃标量替换 → 所有分配落地堆上。

**三步诊断**：

```bash
# 1. 检查逃逸分析是否生效
java -XX:+PrintEscapeAnalysis -XX:+PrintEliminateAllocations \
     -cp app.jar com.example.Service 2>&1 | grep "scalar replaceable"

# 2. 确认哪些对象分配被标量替换
java -XX:+PrintCompilation -XX:+PrintInlining \
     -cp app.jar com.example.Service 2>&1 | rg "scalar"

# 3. GDB 断点验证 ConnectionGraph 构建
gdb -ex "break escape.cpp:109" \
    -ex "break escape.cpp:256" \
    -ex "run" \
    --args java -cp app.jar com.example.Service
```

**反事实**：如果 C2 不做逃逸分析而始终在堆上分配 → 每个 `StringBuilder.append()` 调用产生一个临时 char[] 对象 → 每秒 100K QPS 的服务每秒产生 ~1M 个临时对象 → TLAB refill O(100ns/次) × 1M = 100ms/s → 服务吞吐从 100K QPS 降到 ~50K QPS。标量替换将这些临时对象拆为两个寄存器变量 + 栈上 char 数组 → 零 GC 压力。

C2 在连接图构建阶段对每个 AllocateNode 做 PointsTo 分析，计算 `EscapeState`（NoEscape/ArgEscape/GlobalEscape）。只有 NoEscape + ScalarReplaceable 的对象才触发展开为标量。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces C2 逃逸分析 (Escape Analysis) 的完整 pipeline —— 从 ConnectionGraph 构建（escape.cpp:99 `do_analysis()`）到 `PhaseMacroExpand::scalar_replacement()`（macro.cpp:760）将 AllocateNode 拆解为标量，到锁消除决策（escape.cpp:1944 `not_global_escape` → 消除 `Lock`/`Unlock` 节点）。

Reader completed **doc-03 (Inline Decision)** 理解了 InlineTree + CHA，**doc-02 (GVN/IGVN/CCP)** 理解了理想图变换引擎 `PhaseIterGVN`。本文文档：**逃逸分析的完整算法** —— 从 IR 节点 → PointsToNode 映射 → EscapeState 传播 → 标量替换 / 锁消除的完整链条，附带每步算法决策的 JVM Flag 和反事实分析。

### Interview Story Format Answer（必须出现在 §一 末尾）

"C2 逃逸分析的核心是 ConnectionGraph —— 一个流不敏感、上下文不敏感的 PointsTo 分析。算法分 5 个步骤：(1) `compute_escape()` (escape.cpp:120) 遍历理想图的每个 Node，调用 `add_node_to_connection_graph(n)` 创建 PointsToNode 映射 —— AllocateNode → `JavaObjectNode`, LoadN/LoadP/Phi → `LocalVarNode`, AddP → `FieldNode`。(2) `add_final_edges()` (escape.cpp:651) 对延迟处理的 node 添加最终的 PointsTo/Deferred/Field 边。(3) `complete_connection_graph()` (escape.cpp:1206) 传播引用直到不动点——所有 GlobalEscape 的对象将其 PointsTo 集合标记为 GlobalEscape，ArgEscape 同理。(4) `optimize_ideal_graph()` (escape.cpp:1932) 基于 EA 信息优化 IR —— 消除 NoEscape 对象的 `Lock`/`Unlock` 节点（锁消除），消除 `StoreStore` 内存屏障。(5) `split_unique_types()` (escape.cpp:3010) 为 scalar replaceable 的分配创建独立的内存切片 → `PhaseMacroExpand::scalar_replacement()` (macro.cpp:760) 将分配拆分为字段级 `SafePointScalarObjectNode`。最终效果：局部 ArrayList 的 Object[] 展开为栈上变量，synchronized(this) 在 NoEscape 对象上直接消除锁操作。"

### Beginner Callout Boxes（文档中必须出现的 7 个 callout 框）

1. **流不敏感 (Flow-Insensitive)**：ConnectionGraph 不跟踪程序点的执行顺序，只关心"哪些 LocalVar 可能指向哪些 JavaObject"。这意味着 `p = new A(); q = p;` 和 `q = p; p = new A();` 产生相同的 PointsTo 图——算法牺牲精度换取 O(N) 时间复杂度（vs 流敏感 O(N³) 的 full alias analysis）。源码验证：escape.cpp 只有一个全局图遍历，不使用 CFG 顺序。

2. **上下文不敏感 (Context-Insensitive)**：ConnectionGraph 不区分方法调用上下文。如果方法 `foo()` 被调用两次，每次传入不同的实参，PointsTo 分析将所有调用上下文的 points-to 关系混合（merge）——这个方法内的 LocalVar 可能指向来自任何一个调用者的 JavaObject。保守但安全：如果 merge 后任一上下文导致逃逸 → GlobalEscape → 不允许标量替换。

3. **EscapeState 三级**：(1) `NoEscape` — 对象不逃逸方法或线程且不作为参数传入调用，可以标量替换；(2) `ArgEscape` — 对象不逃逸方法但作为参数传入调用且调用中不逃逸（这在 JDK 9+ 被移除，合并到 GlobalEscape）；(3) `GlobalEscape` — 对象可能被任何地方访问，必须在堆上分配。`escape.hpp:153-161` 枚举定义三个级别。

4. **PointsToNode 四种类型**：(1) `JavaObject` — 堆分配点（AllocateNode/AllocateArrayNode）或外部对象（Parm/CreateEx/CastX2P）；(2) `LocalVar` — 指针值的局部持有者（Phi/LoadP/LoadN/Proj#5/CheckCastPP/CastPP）；(3) `Field` — 对象的字段（AddP 节点）；(4) `Arraycopy` — System.arraycopy 节点。`escape.hpp:145-151` 枚举定义。

5. **ConnectionGraph 三种边**：(1) `PointsTo (-P>)` — LocalVar/Field 直接指向 JavaObject；(2) `Deferred (-D>)` — LocalVar/Field 通过另一个 LocalVar/Field 间接指向（类似指针链，后处理时消除）；(3) `Field (-F>)` — JavaObject 拥有 Field。`escape.hpp:49-53` 定义这三种边。

6. **标量替换 (Scalar Replacement)**：NoEscape + ScalarReplaceable 对象的字段被拆分为独立的标量变量，分配到寄存器或栈帧。AllocateNode 从 IR 图中完全移除——对象的堆分配被消除。这要求 `C->AliasLevel() >= 3` 和 `EliminateAllocations` flag 开启。实现：`PhaseMacroExpand::scalar_replacement()` (macro.cpp:760) 将 AllocateNode 替换为 `SafePointScalarObjectNode` 列表 + 字段分散存储。

7. **锁消除 (Lock Elimination)**：如果 `synchronized(obj)` 的 obj 被标记为 NoEscape（或 not_global_escape），C2 直接将 `Lock`/`Unlock` 节点从 IR 图中移除——因为只有一个线程能访问这个对象，锁竞争不可能发生。escape.cpp:1944 `not_global_escape(alock->obj_node())` → 设置 `alock->set_non_esc_obj()` → 后续宏展开阶段 `PhaseMacroExpand::expand_lock_node()` 将 Lock/Unlock 替换为 no-op。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux, C2 编译器 (Tier 4).

Source roots:
- `src/hotspot/share/opto/escape.cpp` — 3650 行: ConnectionGraph 构造 + EA 算法 + 锁消除
- `src/hotspot/share/opto/escape.hpp` — PointsToNode 类族 + CG 接口声明
- `src/hotspot/share/opto/macro.cpp` — PhaseMacroExpand::scalar_replacement() (:760)
- `src/hotspot/share/opto/macro.hpp` — PhaseMacroExpand 声明
- `src/hotspot/share/opto/callnode.cpp` — CallNode 相关 (EA 处理调用参数)
- `src/hotspot/share/opto/callnode.hpp` — AllocateNode/LockNode/UnlockNode 声明
- `src/hotspot/share/ci/bcEscapeAnalyzer.hpp` — 字节码级 EA 辅助分析

Build: `make hotspot`

Key flags:
- `-XX:+DoEscapeAnalysis` — 启用逃逸分析 (默认 ON)
- `-XX:+EliminateAllocations` — 启用标量替换 (默认 ON)
- `-XX:+EliminateLocks` — 启用锁消除 (默认 ON)
- `-XX:+PrintEscapeAnalysis` — 打印 EA 结果 (debug build)
- `-XX:+PrintEliminateAllocations` — 打印标量替换决策
- `-XX:+PrintEliminateLocks` — 打印锁消除决策
- `-XX:AliasLevel=3` — 内存别名分析级别 (3=precise)

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **escape.cpp** | `src/hotspot/share/opto/escape.cpp` | 3,650 | `do_analysis`(:99), `compute_escape`(:120), `add_node_to_connection_graph`(:258), `add_final_edges`(:651), `complete_connection_graph`(:1206), `optimize_ideal_graph`(:1932), `split_unique_types`(:3010), `not_global_escape`(:2254) | EA 算法核心——ConnectionGraph 构建 + EscapeState 传播 |
| 2 | **escape.hpp** | `src/hotspot/share/opto/escape.hpp` | ~350 | `PointsToNode` 类族, `EscapeState` 枚举, `NodeType` 枚举, `ConnectionGraph` 类 | PointsTo 节点类型 + 边类型 + EA API |
| 3 | **macro.cpp** | `src/hotspot/share/opto/macro.cpp` | ~2,765 | `scalar_replacement`(:760), `expand_lock_node`, `eliminate_macro_nodes` | 宏节点展开阶段——Allocate→标量, Lock→no-op, ArrayCopy→展开 |
| 4 | **callnode.hpp** | `src/hotspot/share/opto/callnode.hpp` | ~2,000 | `AllocateNode`, `AllocateArrayNode`, `LockNode`, `UnlockNode`, `CallStaticJavaNode` | 被 EA 分析的核心 IR 节点声明 |
| 5 | **compile.cpp** | `src/hotspot/share/opto/compile.cpp` | 5,024 | `Optimize()` (:2329 EA 入口调用) | 编译优化总控——调度 EA 时机 |
| 6 | **bcEscapeAnalyzer.hpp** | `src/hotspot/share/ci/bcEscapeAnalyzer.hpp` | ~150 | `BCEscapeAnalyzer` 接口 | 字节码级逃逸分析——辅助 EA 解析调用字节码 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ★★★ ConnectionGraph 构建 — IR 节点 → PointsToNode 映射

```
问题：
  ① ConnectionGraph 构造函数 (escape.cpp:52-76) 初始化了什么？
      答案方向: escape.cpp:52-76 初始化 6 个成员:
        (1) _nodes — Arena 分配的 Node→PointsToNode* 映射数组 (大小=C->unique())
        (2) phantom_obj — 添加 C->top() 映射为 GlobalEscape 的 JavaObject (所有未知引用汇聚点)
        (3) null_obj — 添加 ConP(#NULL) 映射为 NoEscape 的 JavaObject
        (4) _next_pidx=0 — PointsTo 节点索引计数器
        (5) _collecting=true — 标记仍在收集阶段 (禁止边删除)
        (6) _pcmp_neq/_pcmp_eq — 指针比较优化缓存, 初始 NULL
        关键设计: phantom_obj 是所有未知引用的 receiver——任何指向未知对象的
        LocalVar 都有一条 PointsTo 边连到 phantom_obj → phantom_obj 的
        has_unknown_ptr() 标记立即触发 → 全局逃逸传播。
      
      追问: 为什么 phantom_obj 映射 C->top() 而非单独的哨兵节点?
      → C->top() 是理想图的死节点哨兵 (索引 0), 任何不应该在图中活跃的节点
        最终会映射到 top。phantom_obj 使用 top 的索引避免额外分配和索引分配。
        但这也意味着 EA 代码中 ptn != phantom_obj 检查与 ptn != NULL 检查
        在语义上形成两层过滤——见 escape.cpp:156 的 if (ptn != NULL && ptn != phantom_obj)。

  ② add_node_to_connection_graph() (escape.cpp:258) 如何处理 4 种节点类型？
      答案方向: escape.cpp:258 是一个大型 switch 分发函数——根据 Node 的 Opcode()
      创建对应的 PointsToNode 子类:
        - Allocate/AllocateArray → new JavaObjectNode(CG, n, NoEscape) — 
          初始状态 NoEscape, 后续通过 References 传播可能升级
        - Parm → new JavaObjectNode(CG, n, GlobalEscape) — 
          方法参数直接 GlobalEscape (可能从外部传入任意对象)
        - CheckCastPP/CastPP → new LocalVarNode(CG, n, UnknownEscape) — 
          类型转换节点作为局部变量
        - Phi → new LocalVarNode(CG, n, UnknownEscape) — 
          合并点作为局部变量
        - LoadP/LoadN → new LocalVarNode(CG, n, UnknownEscape) — 
          加载指针作为局部变量
        - Proj (proj_out==TypeFunc::Parms) → new LocalVarNode(CG, n, ...) — 
          调用返回值的投影
        - AddP → new FieldNode(CG, n, UnknownEscape, offs, is_oop) — 
          地址计算作为字段访问
        - CreateEx → new JavaObjectNode(CG, n, GlobalEscape) — 
          异常对象逃逸
        - CallStaticJava → new JavaObjectNode(CG, n, UnknownEscape) — 
          静态调用返回值, 后续处理决定是否 boxing method
        - ArrayCopy → new ArraycopyNode(CG, n, ...) — 
          数组拷贝作为特殊边类型
      escape.cpp:258 约 200 行 if/else 分发。
      
      追问: 为什么 LoadP/LoadN 作为 LocalVar 而不是直接连接到 JavaObject?
      → 流不敏感分析的妥协。LoadP 可能加载不同时间点的不同值——作为 LocalVar
        节点收集所有可能的 PointsTo 目标，而不预设具体对象。后续 complete_connection_graph
        通过 Deferred 边传播最终确定每个 LocalVar 的 PointsTo 集合。

  ③ Counterfactual: 如果不使用 Phantom Object 汇聚所有未知引用会怎样？
      答案方向: 没有 phantom_obj → 每个存储到未知目标的 StoreP 都需要为
      所有可能的 JavaObject 创建边 → 图规模爆炸 O(N²)。phantom_obj 将"任意
      可能对象"抽象为一个哨兵节点 → O(N) 图规模。代价：如果一个对象被存储到
      某个可能全局的字段 (如有 phantom_obj 作为 base 的 FieldNode) → 该对象
      被升级为 GlobalEscape——安全但保守，可能过度抑制标量替换。
```

### 4.2 ★★★ add_final_edges — Deferred 边消除 + Field 边建立

```
问题：
  ① add_final_edges() (escape.cpp:651) 为什么需要延迟处理？
      答案方向: 在 add_node_to_connection_graph() 中, 某些边无法在第一次遍历时
      建立（因为目标 PointsToNode 尚未创建）。延迟处理分三类:
      (1) Phi 输入: 初始遍历只创建 Phi 的 LocalVarNode——等所有前驱都创建后,
          add_final_edges 为 Phi 的每个输入添加 Deferred 边:
          add_deferred_edge(phi_ptn, input_ptn)
      (2) Call 参数/返回值: 等调用目标的字节码分析完成, 根据 BCEscapeAnalyzer 
          结果添加 Deferred 边 (实参→形参, 返回值→调用点)
      (3) StoreP/StoreN: 存储到对象的字段——add_field_edge(JavaObject, Field) 
          + add_deferred_edge(Field, stored_value)
      (4) ArrayCopy: src 和 dst 都是 LocalVar→JavaObject 边的特殊情况
         —— add_arraycopy_edge(src_node, dst_node)
      escape.cpp:651-1204 约 550 行的延迟边处理逻辑。
      
      追问: 为什么 StoreP 使用 add_field_edge 而非直接 PointsTo?
      → Field (-F>) 边表达的是 "JavaObject 拥有这个字段"。存储的值通过
        Deferred 边间接指向最终对象。后续处理将 Deferred 边展开：
        如果 LocalVar A -D> LocalVar B 且 B -P> JavaObject J，
        则添加 A -P> J 边，删除 A -D> B 边。这种两级间接性的设计允许
        字段可以存储不同的对象——Field 节点作为一个中介收集所有可能的 PointsTo 目标。

  ② Counterfactual: 如果对每个 Node 做完整流分析而非延迟+两阶段？
      答案方向: 流敏感分析需要为每个程序点维护独立的 PointsTo 映射 →
      内存和计算复杂度从 O(N) 跳到 O(N³)——LLVM 的 Andersen 分析就是 O(N³)。
      Java 方法可能包含数千个 IR 节点 → 流敏感分析可能消耗数秒 → C2 编译时间
      从 ~100ms 膨胀到 ~10s → 违反 C2 的编译时间约束。流不敏感 + 延迟边方案的
      精度损失通过保守策略补偿（未知引用 → phantom_obj → GlobalEscape），
      对大多数无副作用的业务方法返回正确结果。
```

### 4.3 ★★★ complete_connection_graph — EscapeState 传播到不动点

```
问题：
  ① complete_connection_graph() (escape.cpp:1206) 如何将 EscapeState 传播到不动点？
      答案方向: 迭代传播算法——循环直到 no changes:
        Phase 1 — Deferred 边消解:
          遍历所有 LocalVar/Field 节点，检查 Deferred 边。
          如果 LocalVar A -D> LocalVar B:
            - 遍历 B 的所有 PointsTo 边 (B -P> JavaObject J)
            - 为 A 添加 A -P> J 边
            - 如果 J 是 phantom_obj → 标记 A 为 has_unknown_ptr()
          完成后删除所有 Deferred 边 → 图只剩 PointsTo + Field 边。
        
        Phase 2 — Escape State 传播:
          规则 1: GlobalEscape 传播:
            如果 JavaObject J 是 GlobalEscape:
              任何有 Field(-F>) 边指向的 OF 节点标记为 GlobalEscape
              任何 PointsTo(-P>) J 或 OF 的节点标记为 GlobalEscape
          规则 2: ArgEscape 传播 (类似但更弱):
            如果 JavaObject J 是 ArgEscape:
              → 传播到有 Field 边的 OF 节点 (标记为 ArgEscape)
              → 但不传播到 PointsTo 边 (参数逃逸不影响指向它的 LocalVar)
          规则 3: Phantom Object 级联:
            任何 has_unknown_ptr() 的节点 → Phantom Object → 
            其所有可达的 JavaObject → GlobalEscape 传播
        
        传播过程在 non_escaped_worklist 上迭代——每次传播后检查
        worklist 中的 NoEscape 候选是否仍然 NoEscape。

      追问: 算法何时收敛？
      → escape.cpp:1206 有两个终止条件:
        (1) 时间限制: ElapsedTime > CompilationTimeoutLimit → 放弃
        (2) 迭代计数限制: iterations > MaxNodeLimit → 放弃
        两者都触发 _collecting = false → 放弃标量替换 → 保守处理，堆上分配。

  ② Counterfactual: 如果每个 AllocateNode 起点都是 NoEscape 而非 UnknownEscape？
      答案方向: 如果所有分配的起点都是 NoEscape (而非当前实现的 UnknownEscape
      通过传播逐步确定) → 一个线程传递新分配对象到 ThreadLocal 的场景：
        AllocateNode → LoadP (从 TLS 加载) → StoreP (写入 TLS)
        如果起点 NoEscape → StoreP 前需要检查 → 但 StoreP 的目标是 Field
        → Field 的 base 可能是 Global (ThreadLocal 全局) → 
        传播后依然 GlobalEscape，结果相同。
        实际差别：在 conservative 分析中，NoEscape 作为起点的分析更激进
        (先假设不逃逸再反证) → 可能导致 unsafe 对象在并行代码中被错误标量替换
        → 数据竞争。当前从 UnknownEscape 出发 → 传播到 GlobalEscape 的
        过程是 monotonic 升级 (单向)——确保安全。
```

### 4.4 ★★★ 锁消除决策 — not_global_escape → 移除 Lock/Unlock

```
问题：
  ① optimize_ideal_graph() (escape.cpp:1932) 如何决定消除锁？
      答案方向: 遍历所有 LockNode:
        (1) 检查 Lock 对应的对象: Node* obj = alock->obj_node()->uncast();
        (2) escape.cpp:1944 调用 not_global_escape(alock->obj_node()):
            → 查询该对象对应 PointsToNode 的 escape_state()
            → 如果 ≤ ArgEscape (即 NoEscape 或 ArgEscape) → true
        (3) 如果 not_global_escape(obj) 为 true:
            → alock->set_non_esc_obj()  // 标记 Lock 节点
            → alock->log_lock_optimization(C, "eliminate_lock_set_non_esc3");
            → 后续 PhaseMacroExpand 中 expand_lock_node() 检测
              LockNode::is_non_esc_obj() → 直接将 Lock/Unlock 替换为 no-op
      
      源码 (escape.cpp:1932-1955):
        for (uint next = 0; next < C->macro_count(); next++) {
          Node* n = C->macro_node(next);
          if (n->is_Lock()) {
            AbstractLockNode* alock = n->as_AbstractLock();
            if (not_global_escape(alock->obj_node())) {
              ...
              alock->set_non_esc_obj();
            }
          }
        }
      
      追问: 为什么锁消除发生在 optimize_ideal_graph 而非 split_unique_types？
      → 锁消除不修改内存类型系统——它只标记 Lock/Unlock 为 no-op。split_unique_types
        涉及内存图切片的复杂重构。分离这两个阶段允许锁消除在所有情况下生效
        （即使对象不能标量替换——例如被作为参数传入但不逃逸线程）。

  ② Counterfactual: 如果锁消除出错——对 GlobalEscape 对象消除 Lock？
      答案方向: 两个线程并发修改同一个堆上的 ArrayList (GlobalEscape):
        线程1: add(1) → 如果不加锁 → 先读取 size=0 → 线程2 add(2) → 线程2 写入 elementData[0]=2, size=1 → 线程1 写入 elementData[0]=1, size=1 → add(2) 丢失 → 数组元素被静默覆盖
        在 C2 的代码中, GlobalEscape 标记是 conservative 的——phantom_obj 
        传播保证任何可能逃逸的对象最终标记为 GlobalEscape → 只有在
        ConnectionGraph 构建时确认所有 PointsTo 边都指向 NoEscape 的对象
        才消除锁。这是一个安全的 conservative 分析——宁可漏消锁（精度损失）
        也不可错误消除锁（正确性损失）。
```

### 4.5 ★★★ split_unique_types — 标量替换的内存切片准备

```
问题：
  ① split_unique_types() (escape.cpp:3010) 为标量替换做了什么准备？
      答案方向: escape.cpp:3010-3330 ~320 行:
        
        For each scalar replaceable allocation (on alloc_worklist):
          (1) 遍历 allocation 的所有字段 (Fields from ConnectionGraph):
              - 获取字段的 offset (FieldNode::offset())
              - 在 C2 的类型系统中为每个字段创建独立的内存别名索引:
                int alias_idx = C->get_alias_index(adr_type->add_offset(offset))
              - 分配的内存类型是 TypeOopPtr→instance_id 的唯一实例类型
          
          (2) 遍历所有的 MergeMem 节点 (_mergemem_worklist):
              - 将 MergeMem 的内存切片分离——为每个 alias_idx 创建独立的内存输入
              - 这样字段 f1 的 Load 与其字段 f2 的 Load 使用不同的内存输入
              - GVN 可以将字段 f1 的 Load 提升到循环外而不用担心别名冲突
        
          (3) 处理 ArrayCopy 节点:
              - 如果 src 或 dst 是标量替换的目标 → ArrayCopy 也需要展开
              - arraycopy_worklist 上收集所有受影响的 ArrayCopy 节点
        
        关键效果: 内存别名分析的精度从 "所有 AllocateNode"
        细化到 "每个 AllocateNode 的每个字段"。这允许后续的
        PhaseMacroExpand::scalar_replacement() 安全地将字段值
        移动到寄存器——因为每个字段有独立的内存类型，不会与
        其他分配或 GC 写屏障产生别名。

      追问: 为什么需要独立的内存切片 (alias index) 才能做标量替换？
      → 没有独立切片 → 编译器无法证明"field f1 的 Load 与 field f2 的 Store 不冲突"
      → GVN 不能消除冗余 Load → 标量替换产生的寄存器值无法被后续优化利用。
      独立切片让编译器可以精确追踪每个字段的内存生命期。

  ② Counterfactual: 如果 split_unique_types 只分配一个 alias index 给整个对象？
      答案方向: 对象有 3 个字段 {f1, f2, f3}。在循环中:
        obj.f1 = loop_counter;
        tmp = obj.f2;  // Always same value
      如果三个字段共享一个 alias index → Store to f1 会"kill" f2 的所有先前值
      → Load f2 无法提升出循环 → 每次迭代都 Load f2 → 循环体增加 ~5 条指令
      → 10K 次迭代的循环从 ~15ns 膨胀到 ~35ns。
      独立 alias index → Store f1 只 kill f1 的内存位置 → f2 的 Load 不受影响
      → GVN 将 f2 的 Load 提升到循环外 —— 一次读取 → 寄存器复用。
```

### 4.6 ★★★ PhaseMacroExpand::scalar_replacement — AllocateNode → 标量展开

```
问题：
  ① scalar_replacement() (macro.cpp:760) 如何将一个 AllocateNode 拆为标量？
      答案方向: macro.cpp:760-1127 ~367 行:
        
        输入: AllocateNode alloc (已被 EA 标记为 _is_non_escaping + _is_scalar_replaceable)
        
        步骤:
          (1) 收集所有 SafePoint 节点 (包含 GC 信息) 到一个 safepoints 列表
          
          (2) 为每个使用 alloc result 的节点创建替换 —— 遍历 alloc 的所有 output 边:
              - CheckCastPP → 类型转换保持 (但指向的 result 从 alloc 变为标量)
              - LoadP/LoadN from field → 替换为字段的独立 Phi 节点
              - StoreP/StoreN to field → 替换为字段的独立存储
              - Phi (merging different allocations) → 用对应的标量 Phi 替换
          
          (3) 处理初始化 — alloc->initialization() 的 InitializeNode:
              - 将 InitializeNode 分解为字段级初始存储
              - 零初始化 (ZeroTLAB) → 标量初始化为 0/null
          
          (4) 更新 SafePoint debug info:
              为每个收集的 SafePoint 创建 SafePointScalarObjectNode:
              - 包含所有字段的 JVMState 映射 (用于 GC 和 deoptimization)
              - deoptimization 时 JVM 从 SafePointScalarObjectNode 重建对象
          
          (5) 从图中消除 AllocateNode + InitializeNode

  ② Counterfactual: 如果标量替换后发生 Deoptimization——栈上的对象字段如何保留？
      答案方向: SafePointScalarObjectNode 是答案。每个 SafePoint 点:
        - JVM 记录 "这里应该有一个 AllocateNode 的对象, 它的字段 f1=register R1,
          f2=register R2, f3=stack slot S1"
        - Deoptimization 发生时 → JVM 遍历 OopMap → 发现 SafePointScalarObjectNode
        → 从 register/stack 读取字段值 → 在解释器帧中重新构造完整对象
        → 解释器继续执行 (现在对象在堆上, 可以正常 GC)
        开销: SafePointScalarObjectNode 增加了 debug info 大小 (~50 bytes per object)
        → 对于大量 NoEscape 对象, debug info 可能膨胀 5-10% 但堆分配消除的收益更大。
```

### 4.7 ★★★ has_candidates — EA 前置检查 + 编译时间控制

```
问题：
  ① has_candidates() (escape.cpp:78) 如何判断是否需要运行 EA？
      答案方向: escape.cpp:78-97 遍历所有宏节点 (C->macro_count()):
        (1) 存在 AllocateNode → 有标量替换候选 → return true
        (2) 存在 LockNode (且 Lock 的对象不是 Parm/Con — 即不是参数或常量):
            → 有锁消除候选 → return true
        (3) 存在 CallStaticJavaNode 且 is_boxing_method():
            → 有 Boxing 消除候选 → return true
            (例如 Integer.valueOf(1) → 如果 Integer 对象不逃逸 → 消除装箱)
        如果以上全无 → return false — 跳过整个 EA pipeline，节省编译时间。
      
      compile.cpp:2329 调用:
        if (_do_escape_analysis && ConnectionGraph::has_candidates(this)) {
          ConnectionGraph::do_analysis(this, &igvn);
        }
      
      追问: 为什么 Lock 的 obj 是 Parm 或 Con 就跳过锁消除候选？
      → 参数对象的逃逸状态由调用者决定——EA 是方法内分析 (intra-procedural),
        无法追踪参数在调用者中的生命周期。常量对象 (String literal, Class 对象)
        是全局常驻的——消除它们的锁可能影响其他线程。只有方法内部 new 的对象
        才是安全的锁消除候选。

  ② Counterfactual: 如果不做 has_candidates 检查，对所有方法都运行 EA？
      答案方向: ~80% 的编译方法不包含 AllocateNode (纯计算/字段访问/方法调用)
      → 运行全量 ConnectionGraph 遍历这些方法的 ~500-2000 个 IR 节点
      → 耗时 0.1-0.5ms per method → 对 10,000 个编译方法总计 1-5s 浪费
      → 对启动时间和编译队列产生显著影响。
      has_candidates() 扫描 C->macro_count() (通常 <10) → O(10) = ~5ns
      → 具有 O(1000) 倍的效率提升。
```

---

## §五 Article Structure

```
§〇 生产场景 — Full GC due to missed scalar replacement
  ★ GC 日志: Full GC (Allocation Failure), 堆被局部对象塞满
  ★ Root cause: 对象引用传递到 ThreadLocal → GlobalEscape → 丢失标量替换
  ★ 三步诊断: PrintEscapeAnalysis + GDB escape.cpp:109 断点 + jcmd Compiler.codelist
  ★ 反事实: 无 EA → 每秒 1M 临时对象 → 吞吐减半 → TLAB refill 成为瓶颈

§一 ★★★ 逃逸分析全链路源码走读
  ❓ 从 ConnectionGraph 构造到 PhaseMacroExpand::scalar_replacement 的完整 5 步
  1.1 has_candidates() — 快速退出检查 (escape.cpp:78)
  1.2 ConnectionGraph 构造 — 7 worklists, phantom_obj, 5 种 PointsToNode
  1.3 add_node_to_connection_graph() — Allocate/Phi/LoadP/AddP 分发
  1.4 add_final_edges() — Deferred 边消解 + Field 边建立
  1.5 complete_connection_graph() — EscapeState 传播到不动点
  1.6 optimize_ideal_graph() — 锁消除 + StoreStore 屏障消除
  1.7 split_unique_types() — 独立 alias index per field
  1.8 scalar_replacement() — 字段拆分为标量 (macro.cpp:760)
  1.9 ★ Mermaid: EA pipeline 序列图 — has_candidates → CG build → Propagation → Optimize → Split → Macro Expand
      Lanes: C2 Compile / ConnectionGraph / PhaseMacroExpand / Java Object
  1.10 ★ 面试 Story Format 答案 — 完整叙事: Phantom Object → 传播 → NoEscape → 标量替换

§二 ★★★ 7 Beginner Callout 框
  2.1 流不敏感 (Flow-Insensitive)
  2.2 上下文不敏感 (Context-Insensitive)
  2.3 EscapeState 三级 (NoEscape/ArgEscape/GlobalEscape)
  2.4 PointsToNode 四种类型
  2.5 ConnectionGraph 三种边
  2.6 标量替换 (Scalar Replacement)
  2.7 锁消除 (Lock Elimination)

§三 ★★ PointsTo 分析精度 + 编译时间
  ❓ 为什么 C2 选择流不敏感/上下文不敏感 而非 full Andersen？
  ❓ 编译时间约束: EA 在 total compile time 中占比？
  3.1 流敏感 vs 流不敏感对比: O(N³) vs O(N), 精度差异基准测试
  3.2 phantom_obj 设计: O(N) 空间避免 O(N²) 边爆炸
  3.3 编译时间: EA 占 total compile 的 5-8% (典型方法 ~2000 IR nodes)
  3.4 has_candidates 跳过 ~80% 方法的分析

§四 ★ GDB 断点验证 — 8 断点完整 EA trace
  断言 1: has_candidates 结果 (escape.cpp:78) — verify candidates detected
  断言 2: ConnectionGraph 构造完成 (escape.cpp:109) — verify phantom_obj + null_obj
  断言 3: add_final_edges 延迟边处理 (escape.cpp:651) — verify deferred edges count
  断言 4: complete_connection_graph 传播 (escape.cpp:1206) — verify EscapeState after propagation
  断言 5: not_global_escape 锁对象 (escape.cpp:2254) — verify lock elimination decision
  断言 6: split_unique_types alias index (escape.cpp:3010) — verify per-field alias
  断言 7: scalar_replacement field count (macro.cpp:760) — verify fields decomposed
  断言 8: SafePointScalarObjectNode debug info (macro.cpp output) — verify deopt safety

§五 ★ Cross-Reference
  ❓ doc-03 (Inline Decision) — EA 依赖方法内联后的 IR, 内联后的对象分配是 EA 的输入
  ❓ doc-02 (GVN/IGVN/CCP) — EA 后宏展开阶段再次触发 GVN, 消除标量替换产生的冗余 nodes
  ❓ doc-07 (Macro Expansion) — PhaseMacroExpand 是 EA 的下游消费者
  ❓ doc-00 (C2 Pipeline) — Compile::Optimize() 调度 EA 的时机
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because phantom_obj captures all unknown references in a single node, the CG remains O(N) space..." — not WHAT (what is "phantom_obj").

2. **3-5 lines source code per claim** — paste relevant C code from escape.cpp / escape.hpp / macro.cpp, do not describe it.

3. **Mermaid** — EA pipeline sequence diagram. 4 lanes: C2 Compile / ConnectionGraph / PhaseMacroExpand / Java Object Model. Complete flow: `Compile::Optimize()` → `has_candidates()` → `do_analysis()` → `compute_escape()` 5 步骤 → `PhaseMacroExpand::scalar_replacement()`。Annotate every step with file:line.

4. **GDB session** — 8 breakpoints with exact file:line numbers:
   - `escape.cpp:78` has_candidates() — verify Allocate/Lock nodes found
   - `escape.cpp:109` do_analysis() after ConnectionGraph construction — verify phantom_obj
   - `escape.cpp:651` add_final_edges() — verify deferred edges
   - `escape.cpp:1206` complete_connection_graph() — verify EscapeState
   - `escape.cpp:2254` not_global_escape() — verify lock object escape state
   - `escape.cpp:3010` split_unique_types() — verify alias index per field
   - `macro.cpp:760` scalar_replacement() — verify fields decomposed
   - `macro.cpp` after SafePointScalarObjectNode creation — verify deopt safety
   Each with expected variable values to verify.

5. **7 Beginner callout boxes** — exact text from §一: Flow-Insensitive, Context-Insensitive, EscapeState, PointsToNode types, CG edges, Scalar Replacement, Lock Elimination.

6. **Cross-reference at four points**:
   - At `has_candidates()` → "→ doc-03 (Inline Decision) for how allocations reach C2 IR"
   - At `add_node_to_connection_graph()` → "→ doc-00 (C2 Pipeline) for Compile::Optimize() scheduling"
   - At `scalar_replacement()` → "→ doc-07 (Macro Expansion) for PhaseMacroExpand framework"
   - At `split_unique_types()` → "→ doc-02 (GVN/IGVN/CCP) for memory alias analysis"

7. **Story-format interview answer** — at §一末尾: 从 `do_analysis()` 入口到 `scalar_replacement()` 完成的叙事。两部分: "ConnectionGraph 构建 + EscapeState 传播" + "锁消除 + 标量替换"。

8. **不要写成源码翻译** — 源码是证据 (20%)，原理是正文 (80%): 解释 WHY phantom_obj 是关键设计，WHY 流不敏感分析足以应对 Java 的内存模型，WHY EscapeState 传播是 monotonic 的。

---

## §七 Output Format

- Markdown file, named `04-Escape-Analysis.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/22-c2-jit/docs/`
- 元信息头:

```
> **阶段**：[22-c2-jit]
> **前置**：[03-Inline-Decision]（方法内联是 EA 的前置——内联后 IR 才有方法内的 AllocateNode）、[02-GVN-IGVN-CCP]（GVN/Ideal 变换引擎——EA 后需要重新 GVN 清理冗余）、[00-C2-Pipeline]（编译管线总览——Compile::Optimize() 调度 EA 时机）
> **配套**：[05-Loop-Optimization]（循环优化依赖 EA 消除 Lock/Allocate）、[06-SuperWord]（向量化在循环优化后执行）、[07-Macro-Expansion]（PhaseMacroExpand 是 EA 的下游消费者）
> **后续依赖本文**：[05-Loop-Optimization]（EA 消除 Lock 后循环中的锁操作不再阻碍 LoopTransform）、[07-Macro-Expansion]（EA 的 split_unique_types 是 MacroExpand 展开 AllocateNode 的前提）
> **阅读收益**：追踪逃逸分析从 ConnectionGraph 构造到标量替换的完整 5 步算法——理解流不敏感 PointsTo 分析如何构建 Phantom Object + 4 种 PointsToNode + 3 种边、EscapeState 三级传播到不动点的 monotonic 过程、锁消除的 not_global_escape 决策、split_unique_types 为每个字段创建独立 alias index 的内存切片技术、PhaseMacroExpand::scalar_replacement 将 AllocateNode 拆分为 SafePointScalarObjectNode 的字段级展开；掌握 "对象分配 GC 压力" 的 EA 优化诊断路径
```

- 目标行数: 2000+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "逃逸分析标记对象为不逃逸" 而不展示 ConnectionGraph 的完整构建流程 — 必须从 escape.cpp:99 do_analysis() 到 compute_escape() 5 个步骤的源码
- ❌ 不解释 Phantom Object 的设计理由 — 必须展示它是如何将 O(N²) 边爆炸归约为 O(N) 的哨兵节点设计
- ❌ 不解释 PointsToNode 四种类型的语义和数据成员 — 必须从 escape.hpp:131-237 展示每个类型的 edge/use/base 集合
- ❌ 不解释 EscapeState 传播的 monotonic 性质 — 必须展示 GlobalEscape 是单向升级 (NoEscape → GlobalEscape, 不可逆)
- ❌ 不展示锁消除的完整决策流程 — 必须从 escape.cpp:1944 not_global_escape 到 set_non_esc_obj 到 PhaseMacroExpand::expand_lock_node
- ❌ 不解释 split_unique_types 为何需要独立 alias index — 必须展示共享 alias vs 独立 alias 对循环 Load 提升的影响
- ❌ 不做 GDB 断点 trace — 至少 8 个断点覆盖 has_candidates → CG build → Propagation → Lock Elimination → Split Types → Scalar Replacement
- ❌ 不解释标量替换后的 deoptimization 安全机制 — 必须展示 SafePointScalarObjectNode 如何在 deopt 时重建对象
- ❌ 不解释为什么流不敏感而非流敏感分析 — 必须对比 O(N³) Andersen vs O(N) ConnectionGraph 的编译时间代价
- ❌ 不要解释 C/C++ 指针基础

---

## §九 Required（≥8）

- ✅ **★ Mermaid EA Pipeline 序列图** — 4 lanes: C2 Compile / ConnectionGraph / PhaseMacroExpand / Java Object — has_candidates → CG build → Propagation → Optimize → Split Types → Macro Expand
- ✅ **★ ConnectionGraph 构造函数源码展示** — escape.cpp:52-76 完整源码 + phantom_obj/null_obj 注释
- ✅ **★ PointsToNode 类族完整定义** — escape.hpp:131-278 JavaObject/LocalVar/Field/Arraycopy 四种类型 + 三种边
- ✅ **★ EscapeState 三级定义 + 传播规则** — escape.hpp:153-161 枚举 + complete_connection_graph 传播逻辑
- ✅ **★ 锁消除 not_global_escape 源码** — escape.cpp:1942-1955 Lock 遍历 + set_non_esc_obj 标记
- ✅ **★ split_unique_types alias index 分离** — escape.cpp:3010-3330 内存切片技术
- ✅ **★ scalar_replacement 展开流程图** — macro.cpp:760-1127 5 步展开: Collect SafePoints → Replace Uses → Decompose Init → Update Debug Info → Eliminate Allocate
- ✅ **★ 7 Beginner Callout 框** — exact text from §一: Flow-Insensitive, Context-Insensitive, EscapeState, PointsToNode, CG Edges, Scalar Replacement, Lock Elimination
- ✅ **★ 面试 Story Format 答案** — §一末尾: Phantom Object → Propagation → NoEscape → Scalar Replacement
- ✅ **★ GDB 断点 ≥8 条** — 精确到 file:line, 每断点有预期变量值
- ✅ **★ Counterfactual 对比表** — 至少 4 个反事实: 无 phantom_obj / 流敏感 EA / 错误锁消除 / 共享 alias index
- ✅ **★ 交叉引用** — doc-03 (Inline), doc-02 (GVN), doc-07 (Macro Exp), doc-00 (Pipeline)

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: has_candidates 识别 AllocateNode (escape.cpp:78)
  (gdb) break escape.cpp:78
  (gdb) print C->macro_count() → 期望: >0 (有分配或锁)
  (gdb) next
  (gdb) print n->is_Allocate() → 期望: 根据源码 true/false
  (gdb) print n->is_Lock() → 期望: 根据源码 true/false

断言 2: ConnectionGraph 构造 phantom_obj (escape.cpp:109)
  (gdb) break escape.cpp:109
  (gdb) print congraph->phantom_obj → 期望: 非 NULL
  (gdb) print congraph->phantom_obj->escape_state() → 期望: GlobalEscape (3)
  (gdb) print congraph->null_obj → 期望: 非 NULL
  (gdb) print congraph->null_obj->escape_state() → 期望: NoEscape (1)

断言 3: add_final_edges 延迟边处理 (escape.cpp:651)
  (gdb) break escape.cpp:651
  (gdb) print delayed_worklist.size() → 期望: 延迟队列中的节点数
  (gdb) continue
  (gdb) print n → 期望: 正在处理边关系的 IR 节点

断言 4: complete_connection_graph 传播后状态 (escape.cpp:1206)
  (gdb) break escape.cpp:1206 (return false 点)
  (gdb) print non_escaped_worklist.length() → 期望: NoEscape 对象数
  (gdb) print ptnodes_length → 期望: PointsToNode 总数
  (gdb) print java_objects_worklist.length() → 期望: JavaObject 数量

断言 5: not_global_escape 锁消除检查 (escape.cpp:2254)
  (gdb) break escape.cpp:2254
  (gdb) print n → 期望: 锁对应的对象节点 (Allocate/Parm/Con)
  (gdb) print ptnode_adr(n->_idx)->escape_state() → 期望: ≤ ArgEscape
  (gdb) continue
  (gdb) print alock->is_non_esc_obj() → 期望: true (锁将被消除)

断言 6: split_unique_types 创建 alias index (escape.cpp:3010)
  (gdb) break escape.cpp:3010
  (gdb) print alloc_worklist.length() → 期望: scalar replaceable 分配数量
  (gdb) next (多次执行直到 alias index 分配)
  (gdb) print C->get_alias_index(...) → 期望: 独立的 alias index

断言 7: scalar_replacement 展开 AllocateNode (macro.cpp:760)
  (gdb) break macro.cpp:760
  (gdb) print alloc->is_Allocate() → 期望: true
  (gdb) print alloc->_is_scalar_replaceable → 期望: true
  (gdb) print alloc->_is_non_escaping → 期望: true
  (gdb) continue (经过分解)
  (gdb) print safepoints.length() → 期望: SafePoint 节点数
  (gdb) print fields_count → 期望: 对象字段数 (被标量替换的字段数)

断言 8: SafePointScalarObjectNode deopt 安全 (macro.cpp 新增节点后)
  (gdb) print sfn->field_count() → 期望: 对象字段总数
  (gdb) print sfn->first_index() → 期望: debug info 中的起始偏移
  (gdb) print scalar_objects_worklist.length() → 期望: 标量对象数
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README doc-04 承接**：本文展开 README §文档拆分方案 doc-04 的 "ConnectionGraph + 标量替换 + 锁消除"，从 escape.cpp 的 PointsTo 分析到 macro.cpp 的字段展开。

2. **同组边界**: doc-03 (Inline Decision) 提供"哪些方法被内联到 C2 IR"——EA 的输入是内联后方法内的 AllocateNode；doc-02 (GVN/IGVN/CCP) 提供"理想图变换引擎"——EA 对图做了 transform 后需要重新 GVN 清理；doc-07 (Macro Expansion) 提供"PhaseMacroExpand 框架"——EA 的 split_unique_types 是 MacroExpand 的前置条件；doc-05 (Loop Optimization) 提供"循环变换"——EA 消除锁后循环中的同步块不再阻碍 PhaseIdealLoop 的优化。

3. **全部文档共享 §一 开头语**: "Reader completed doc-03 (Inline Decision), doc-02 (GVN/IGVN/CCP). This doc: how C2 Escape Analysis connects PointsTo Graph construction to scalar replacement and lock elimination."
