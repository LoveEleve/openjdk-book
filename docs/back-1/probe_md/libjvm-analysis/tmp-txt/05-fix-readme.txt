Fix 8 issues from 05-jit-compiler/README.md review (41/60 → target 55+). Read README fully, then fix each issue.

## ⛔ HARD RULE: edit existing README only. No new files.

## Issue 1: Chaitin algorithm order WRONG (§八 03, lines ~400-406)
Current: Coalesce placed AFTER coloring (step 5/6).
Actual HotSpot order from `chaitin.cpp:336-583` (`Register_Allocate()`):
1. `PhaseLive` at line 418 — compute Live ranges
2. `IFG_virtual` — build virtual interference graph
3. `AggressiveCoalesce` at line 425 (`aggressive_coalesce.coalesce_driver()`) — eliminate moves by merging registers
4. `IFG_physical` — build physical IFG (real 16 GPRs)
5. `Simplify` at line 515 — iteratively remove low-degree nodes from graph
6. `Select` at line 519 — color: if degree < 16 at any simplification step → success; else → spill
7. If Select fails → `split` + `ConservativeCoalesce` (line 546-575) → loop back to Step 1

Fix: rewrite the Chaitin section in §八 03 to use THIS order. Add a note: "这是实际 HotSpot 的顺序，与 Chaitin 1982 论文的标准顺序略有不同——HotSpot 在 IFG 构建后会立即进行 AggressiveCoalesce，消除尽可能多的 mov 指令，之后再构建物理干扰图。"

## Issue 2: Missing doc on profile data flow (§六 + §八)
The `ci/` directory (74 files) is Compiler Interface — how C2 reads C1's profiling data. Add a 7th doc to the plan:

### 07-Profile-Data-Flow.md
**Core question**: "C2 怎么读取 C1 收集的类型 profile、调用计数和分支 profile？ciMethod/ciKlass/ciTypeFlow 是什么？"
**Production**: "生产性能回归——C2 内联了不需要的方法导致 CodeCache 爆满。因为 C1 的类型 profile 被污染了（一次调用了罕见的子类），C2 基于错误数据决定内联。`-XX:+PrintInlining` 显示 `@ 1 java.lang.Object::hashCode` — 单型陷阱。"
**Coverage**: ciMethod (method metadata + profile), ciKlass (class hierarchy + profiling data), ciTypeFlow (type propagation), ciCallProfile (call counts + receiver types), ProfileData consumtion in `Parse::Parse()` and `InlineTree::should_inline()`

Add this doc to §六 dependency diagram as: 07 dependent on 01+02 (Parse + Inline use ci for decisions)

## Issue 3: Missing production scenarios (§十三)
Add 3 scenarios:
- **预熱延迟**: "C2 编译耗时 80-100ms/方法, 启动后前 5 分钟 200 个热方法 × 100ms = 20s 累积延迟 → 应用在启动后 P99 高高。`-XX:+PrintCompilation` 显示编译时间 → `-XX:CICompilerCount=4` (from cgroup CPU) + `-XX:TieredCompileTaskTimeout=100`"
- **重编译循环**: "方法编译→去优化→重编译→再去优化… perf 显示 50% CPU 在 CompileBroker。因为不稳定的类层次——每次都看到新子类 → CHA 推翻 → uncommon trap → 下一调用又看到新子类 → trap again。检测: `-XX:+PrintDeoptimizationDetails` → count recompiles >5 for same method → exclude with CompileCommand"
- **遗漏内联**: "热点方法中的关键子调用没被内联——性能只有预期的 40%。`PrintInlining` 显示 `@ 12 java.util.HashMap::hash invoked = 100000, hot method too big`。修复: 检查 callee 大小 (`-XX:MaxInlineSize=400` → 500) 或 inline 深度 (`-XX:MaxInlineLevel=9` → 12)"

## Issue 4: ADL undefined (line 207 + §八 01 line 368)
Add to §0.4 glossary:
"**ADL** (Architecture Description Language): C2 的描述文件——通过 `x86_64.ad` 定义 x86_64 的寄存器集、指令模式、栈帧约定。Matcher 阶段读取 ADL 文件来将 Ideal Graph Node 匹配到具体的 x86 指令。"

## Issue 5: Interview answers are fact dumps (§十三)
Rewrite 3 example answers in story format:

**C2 pipeline answer** (story format): "C2 不是一条流水线——它是一个图形优化器。第一步 Parse：字节码 → Node。iload_0 变成 ParmNode（this 指针），iload_1 变成另一个 ParmNode（第一个参数），iadd 变成 AddINode。100 条字节码 → 500 个 Node。第二步 Optimize：IGVN 发现 hashCode() 被调用了 4 次——合并成 1 次。Escape Analysis 发现对象不逃逸——分配操作被删除，字段变成标量变量。Inline Tree 将 5 个方法内联——消除了 20 次调用开销。第三步 Output：优化后的 200 个 Node 被映射到 x86 指令——Matcher 读取 x86_64.ad 找到对应的指令模式（AddI → addl），RegAlloc 将虚拟寄存器映射到 16 个 GPR，最后 CodeGen 输出指令字节到 CodeCache。"

**Inline answer** (why it's the most important optimization): "内联是 JIT 的基石——没有内联，其他优化几乎无效。每次方法调用成本：push 参数（4 条 mov）+ call 指令（5 bytes）+ 帧设置（push rbp; mov rbp,rsp）+ 返回（ret）= ~40 周期。C2 的 IGVN 只能优化方法**内部**——它看不到跨调用的冗余。但一旦内联：HashMap.get() 内联到你的 process() 中 → 10 次 hashCode() 调用都可见 → IGVN 消除 9 次重复计算 → 再内联 hashCode() → 字段读取消除 → from 10 loads to 1。这是瀑布效应：1 次内联触发 10 次下游优化。"

## Issue 6: Container/K8s awareness zero (§十三)
Add to §十三 production scenarios:
"**容器 JIT 资源不足**: CICompilerCount 从 cgroup CPU 限制自动推导——如果容器只有 2 核 → CICompilerCount=2 → 但同时有 500 个方法需要 JIT → 编译队列积压。`-XX:+PrintCompilation | wc -l` 显示编译数远低于预期。修复: 检查容器 CPU 限制 vs 实际 JIT 负载 → 加容器 CPU 限制或 `-XX:CICompilerCount=4`。"

## Issue 7: Missing cross-dependencies in §六 diagram
Current: 01→02, 01→03, 01→04, 01→05, 01→06
Add: 05→06 (OopMaps consumed by deopt for frame rebuild), 02→04 (inline depth affects nmethod size → CodeCache) in the dependency diagram.

## Issue 8: ADL + HIR/LIR defined
HIR/LIR (line 118): Add to §0.4 glossary or explain inline:
"HIR (High-level IR) = C1's optimization IR (SEAF nodes). LIR (Low-level IR) = C1's linear IR (close to machine code, used for Linear Scan register allocation). These are C1-only concepts — C2 uses Sea of Nodes instead."

## Report: what was fixed, new README line count, old→new score estimate
