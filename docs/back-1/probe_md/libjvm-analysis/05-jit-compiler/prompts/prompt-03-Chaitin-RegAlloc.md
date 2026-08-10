# PROMPT: 请撰写 03-Chaitin-RegAlloc.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**Chaitin 图着色寄存器分配 — 虚拟寄存器（∞个）如何映射到 x86_64 的 16 个物理 GPR**。

### 核心故事线（禁止做源码翻译机！）

perf top 显示编译后的方法中 40% 指令是 `mov`——不是计算，而是寄存器→栈的 spill/fill 操作。方法在编译后被 spill 到栈上——每次 spill = ~5 周期 L1 访问 + store-forwarding 延迟。寄存器分配失败导致性能比预期慢 3 倍。

x86_64 只有 16 个通用寄存器。C2 可能为 1 个方法生成 50+ 个虚拟寄存器。Chaitin 着色算法将这些虚拟寄存器映射到 16 个物理寄存器——把冲突的寄存器 spill 到栈上。这不是 1982 年论文的数学版本——这是 HotSpot 的具体实现。

**读者前提**：从 [01-Pipeline] §七（Matcher 阶段——Ideal Node→MachNode）进入本文。读者知道 Matcher 为每个 MachNode 分配虚拟寄存器（vreg），最终需要硬件寄存器。本文回答：**那些 vreg 怎么被分配到 16 个 GPR？什么时候 spill？Coalesce 在算法的哪个步骤执行？**

### 你需要知道的（零编译器背景的 Java 工程师必须理解 6 个概念）

#### 概念 1：虚拟寄存器 vs 物理寄存器

**虚拟寄存器**（vreg）：编译器内部随意创建——一个方法有 50 个变量就创建 50 个 vreg——"无限容量"。C2 的每个 MachNode 输出分配一个 vreg。**物理寄存器**（preg）：x86_64 的 16 个 GPR（RAX、RBX、RCX、RDX、RSI、RDI、RBP、RSP、R8-R15）。寄存器分配的目标：把 vreg（可能 50+ 个）映射到 preg（16 个），同时保证"同一时刻没有两个活跃的 vreg 共享同一个 preg"。

#### 概念 2：Live Range（活跃区间）

一个 vreg 从"被定义"（写入值的位置）到"最后一次被使用"（读取值的位置）的代码区间。`PhaseLive::compute()` 计算每个 Node 的 `_first_use` 和 `_last_use`。如果两个 vreg 的 Live Range 重叠 → 它们在某个时刻同时"活着"→ 不能共享同一个物理寄存器。

#### 概念 3：IFG（Interference Graph / 干扰图）

节点 = vreg，边 = Live Range 重叠。IFG 是寄存器分配的核心数据结构——如果 vreg_A 和 vreg_B 的 Live Range 重叠 → IFG 中 A-B 之间有一条边。着色问题转化为：用 K=16 种颜色给 IFG 涂色，相邻节点（有边的）不能用同色。如果某个节点有 ≥16 个邻居（degree ≥ 16）→ 无法着色 → 必须 spill。

#### 概念 4：Spill（溢出）

当某个 vreg 无法被分配物理寄存器（degree ≥ 16 且所有颜色被邻居占用）→ **spill 到栈上**。编译器在栈帧中为此 vreg 分配一个 slot（spill slot），生成 `mov [rbp-offset], reg`（写入）和 `mov reg, [rbp-offset]`（读取）指令。Spill 的代价：每次 spill = ~5 cycles L1 访问 + 可能的 store-forwarding 延迟。

#### 概念 5：Coalesce（合并）

如果两个 vreg 之间有 `mov vreg_A, vreg_B` 指令——但它们的 Live Range 不重叠 → 可以**合并**为同一个 vreg → 消除 `mov` 指令。`PhaseAggressiveCoalesce::coalesce_driver()` 在 IFG 构建后、着色前执行——合并尽可能多的 vreg 对，减少 IFG 的度，使着色更容易。

#### 概念 6：Simplify + Select（着色步骤）

**Simplify**：迭代移除 IFG 中度 < K(16) 的节点 → 压入栈。这些节点"容易着色"——因为它们邻居少，肯定能分配到某种颜色。**Select**：从栈中弹出节点 → 分配颜色（找一个未被邻居占用的颜色）。如果某节点从栈弹出时 degree ≥ 16 → **着色失败** → 必须 spill 此节点 → 分裂其 Live Range → 重新开始分配。

---

**本文是 05-jit-compiler 阶段的第 3 篇。前置：[01-Pipeline] §七（Matcher——Ideal Node→MachNode→vreg 分配）。读者知道 Matcher 阶段后每个 MachNode 有 vreg，本文完成寄存器分配。配套：[01] §八（Output——分配后的代码生成）。**

### 核心叙事线 — "从 50 个 vreg 到 16 个 preg 的着色旅程"

1. **★★ PhaseLive：计算 Live Range** — `PhaseLive::compute()` 遍历基本块 → 对每个 Node 计算 `_first_use`（定义位置）和 `_last_use`（最后使用位置）→ 形成 Live Range 区间。例：`int x = a+b; int y = c+d; return x+y;` → x 从 `a+b` 活到 `x+y`；y 从 `c+d` 活到 `x+y`——两者在 `x+y` 处重叠 → 不能共享寄存器。

2. **★★ IFG 构建（虚拟）** — `PhaseChaitin::build_ifg_virtual()` 对每对 vreg：如果 Live Range 重叠 → 在 IFG 中添加边。边的权重 = 重叠的严重程度（用于 spill 选择——优先 spill 权重低的 vreg）。

3. **★★★ AggressiveCoalesce（合并 mov）** — `PhaseAggressiveCoalesce::coalesce_driver()` (chaitin.cpp:425) 遍历所有 `mov vreg_A, vreg_B` 指令 → 如果 A 和 B 不干扰（IFG 中无边）→ 合并为一个 vreg → 消除 mov。为什么在 IFG 虚拟之后、IFG 物理之前？因为合并后 vreg 数量减少 → IFG 物理的度降低 → 更容易着色。

4. **★ IFG 构建（物理）** — `PhaseChaitin::build_ifg_physical()` 用合并后的 vreg 构建真正的物理干扰图——对阵 16 个 GPR。vreg 到 preg 的"候选颜色"由 `MachNode::two_adr()` 的 `reg_class` 限制——某些 MachNode 只能用特定寄存器（如 `idiv` 只能用 RAX:RDX）。

5. **★★ Simplify + Select（着色）** — `PhaseChaitin::Simplify()` (chaitin.cpp:515) 迭代移除低度节点 → 压栈。`PhaseChaitin::Select()` (:519) 弹栈分配颜色。如果某节点的 degree ≥ 16 → `PhaseChaitin::choose_color()` 返回 -1 → `PhaseChaitin::select_spill()` 标记 spill → `PhaseChaitin::Split()` 分裂 Live Range。

6. **★ Split + ConservativeCoalesce + 重做** — 如果 Select 失败 → `PhaseChaitin::Split()` (:546) 把 spill 节点的 Live Range 切成多段 → 每段分配新 vreg → 重新执行 Live→IFG→Coalesce→着色。Split 后 Coalesce 转为保守（ConservativeCoalesce）——只合并"合并后不增加 degree 到 ≥16"的 vreg 对。

### 验证报告
- `sverklo_search "chaitin register allocate live range IFG coalesce spill split"` → chaitin.cpp
- `codegraph query "PhaseChaitin::Register_Allocate"` → chaitin.cpp:336-583
- `rg -n "Register_Allocate\|build_ifg_virtual\|build_ifg_physical\|coalesce_driver\|Simplify\|Select\|Split\|fixup_spills" chaitin.cpp` → 算法步骤
- `rg -n "PhaseLive::compute\|PhaseIFG::PhaseIFG" live.cpp ifg.cpp` → Live Range + IFG 构建

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+UnlockDiagnosticVMOptions -XX:+PrintOptoAssembly`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `-XX:+PrintOptoAssembly` 输出 post-regalloc 汇编（可观察 spill/fill mov）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `chaitin.cpp` | `src/hotspot/share/opto/chaitin.cpp` | opto | `PhaseChaitin::Register_Allocate()`(:336-583)、`build_ifg_virtual()`、`build_ifg_physical()`、`Simplify()`(:515)、`Select()`(:519)、`Split()`(:546)、`fixup_spills()`(:680) | ★★★ 主分配器——8 步算法 |
| 2 | `ifg.cpp` | `src/hotspot/share/opto/ifg.cpp` | opto | `PhaseIFG::PhaseIFG()`(构造器)、`add_edge()`、`test_edge()`、`effective_degree()` | ★★★ 干扰图构建 |
| 3 | `coalesce.cpp` | `src/hotspot/share/opto/coalesce.cpp` | opto | `PhaseAggressiveCoalesce::coalesce_driver()`、`PhaseConservativeCoalesce::coalesce_driver()` | ★★★ Coalesce——消除 mov |
| 4 | `live.cpp` | `src/hotspot/share/opto/live.cpp` | opto | `PhaseLive::PhaseLive()`(构造器)、`compute()` | ★★★ Live Range 计算 |
| 5 | `chaitin.hpp` | `src/hotspot/share/opto/chaitin.hpp` | opto | `PhaseChaitin` 类(:141-956)、`LRG`(Live Range Group) 结构 | ★★ 类定义 + LRG |
| 6 | `output.cpp` | `src/hotspot/share/opto/output.cpp` | opto | Post-allocation 代码发射——消费 RegAlloc 的输出 | ★★ 代码生成消费者 |

**跨模块说明**：寄存器分配全在 opto/ 内部——chaitin.cpp（主算法）+ ifg.cpp（干扰图）+ coalesce.cpp（合并）+ live.cpp（活跃区间）。output.cpp 是下游消费者——读取分配结果生成最终机器码。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ Live Range 计算

```
问题：
  ① PhaseLive::compute() 如何确定每个 Node 的 _first_use 和 _last_use？
      线索: live.cpp 的 compute()
      答案方向: 反向遍历基本块（从 exit 到 entry）→ 对每个基本块：从最后一条指令到第一条指令 →
      维护一个 "当前活着的 vreg 集合"。对每条指令：如果指令定义 vreg X → 这是 X 的"最后定义"→
      _first_use = 此指令位置。如果指令使用 vreg Y → 这是 Y 的"一次使用"→ 更新 _last_use。
      追问: 为什么反向遍历？→ 正向遍历不知道"后面是否还有使用"——反向遍历从使用点出发，可以确定
      "最后一次使用"的位置。

  ② Live Range 重叠为什么意味着"不能共享寄存器"？
      答案方向: 如果 vreg A 和 vreg B 在代码区间 [L1, L2] 同时活着 → 在 L1 处 A 的值还存在
      （后面还要用），在 L2 处 B 的值也存在——如果它们共享同一个物理寄存器 R1 → 在 L1 写入 A 的值
      会覆盖 B 的值 → 后续使用 B 会读到 A 的错值。追问: 如果 Live Range 不重叠 → 可以共享寄存器吗？
      → 可以。A 在 [1,10] 活着、B 在 [20,30] 活着 → A 用完释放寄存器 → B 复用则一 → 不冲突。

  ③ Live Range 的粒度——是 per-Node 还是 per-基本块？
      答案方向: per-Node 粒度。每个定义值的 Node（MachNode）有独立的 vreg 和 Live Range。
      如果一条指令既使用又定义（如 `add rax, rbx` → rax 被使用也被重新定义）→ 使用的 Live Range
      在指令前结束，定义的 Live Range 从指令后开始——即"同一个 vreg 在 add 处被 kill + redefine"。
```

### 4.2 ★★★ IFG 构建

```
问题：
  ① PhaseIFG::PhaseIFG() 如何构建干扰图？
      线索: ifg.cpp 构造器
      答案方向: 初始化邻接矩阵（稀疏表示——每个 vreg 有一个邻接列表）。遍历所有基本块 →
      对每个基本块：维护"当前此位置的活 vreg 集合"。当遇到新定义 vreg X → X 和所有当前活着的
      vreg 都产生干扰边 → add_edge(X, live_vreg)。当 vreg Y 的最后一次使用在当前指令 →
      从活集合中移除 Y。追问: 邻接矩阵多大？→ N×N（N=vreg 数量）→ 50×50 = 2500 edges——稀疏。

  ② 边的权重有什么用？
      答案方向: 权重 = 两个 vreg 同时活着的指令数目。Spill 选择时：优先 spill 权重低的节点
      （与邻居的重叠少 → spill 的影响小）。权重也影响 Coalesce——如果两个 `mov` 相连的 vreg 有
      高权重干扰 → 不值得合并（硬合并可能增加 IFG 度）。

  ③ IFG_virtual 和 IFG_physical 的区别？
      答案方向: IFG_virtual 用"虚拟寄存器号"作为节点——vreg 序号（1-Nvreg）→ 节点数 = vreg 数。
      IFG_physical 用"物理寄存器号"作为节点——但只有 16 个 preg → 节点数 = 16。IFG_physical 是
      "简化版"——vreg 先在 IFG_virtual 上被 Coalesce 合并 → 然后剩余 vreg 映射到 16 个 preg →
      只有 16 个节点的 IFG_physical 才是真正决定 spill 的图。
```

### 4.3 ★★★★ HotSpot 的算法顺序（CRITICAL——这是和标准教科书不同的）

```
问题：
  ① 从 chaitin.cpp:336-583 推断的完整算法顺序是什么？和标准 Chaitin 论文有什么不同？
      线索: chaitin.cpp Register_Allocate() 的代码流程
      答案方向:
        HotSpot 的实际顺序（已从源码验证）：
          1. PhaseLive::compute() — 计算 Live Range
          2. PhaseIFG::build_ifg_virtual() — 构建虚拟干扰图
          3. ★ PhaseAggressiveCoalesce::coalesce_driver() (L425) — 合并 mov 对
          4. PhaseIFG::build_ifg_physical() — 构建物理干扰图
          5. PhaseChaitin::Simplify() (L515) — 移除低度节点
          6. PhaseChaitin::Select() (L519) — 着色
          7. If spill → PhaseChaitin::Split() (L546) → ConservativeCoalesce (L575) → goto 1
          8. PhaseChaitin::fixup_spills() (L680) — 插入 spill/fill mov 指令

        标准 Chaitin (1982): Live → IFG → Simplify → Select(可能spill) → Coalesce
        标准 Chaitin-Briggs (1989): Live → IFG → Coalesce → Simplify → Select(可能spill)

        HotSpot 的关键差异：(a) AggressiveCoalesce 在 IFG_virtual 之后、IFG_physical 之前——
        合并减少 vreg 数 → 降低 IFG_physical 度 → 更容易着色；(b) 如果 spill 发生 → 
        Coalesce 转为 ConservativeCoalesce（保守合并——不增加度到 ≥16）。

      追问: 为什么 HotSpot 选择这个顺序？→ AggressiveCoalesce 在 IFG_physical 之前做 →
      减少后续着色图的复杂度 → 降低 spill 概率。Spill 是昂贵的（分裂 Live Range + 重新分配）→
      投入更多精力在 Coalesce 上比 spill 后重做更划算。

  ② AggressiveCoalesce 为什么"aggressive"？它可能造成什么问题？
      答案方向: AggressiveCoalesce 在 IFG_physical 之前做——它"激进地"合并所有不干扰的 mov 对。
      "激进"= 即使合并后会增加节点的度（让邻居更多）也合并——因为它还不知道 IFG_physical 的度限制。
      可能导致：合并后某个 vreg 的度变成 18（超过 K=16）→ 着色时 spill。
      追问: ConservativeCoalesce 的区别？→ ConservativeCoalesce 在 spill 后——只有合并后
      不导致度 ≥16 的 vreg 对才合并。更保守但更安全——不会引入新 spill。
```

### 4.4 ★★ Spill：当 16 个寄存器不够用

```
问题：
  ① x86_64 有 16 个 GPR——但实际编译器可用几个？为什么？
      答案方向: 16 个 GPR，但：RSP(栈指针—专用)、RBP(帧指针—通常保留)、R12(heapbase—压缩 OOP 时占用)、
      R15(Thread* — 永久绑定)、R10/R11(scratch—被 JVM runtime 随意破坏)、RAX(返回值—被 call 破坏)。
      实际留给编译器自由分配的：~9-10 个。如果方法有 20+ 个同时活跃的变量 → spill 不可避免。
      追问: 为什么 JVM 不释放 R12 和 R15？→ R15 省掉了每次方法调用的 TLS 查找（省 50 cycles/调用）；
      R12 省掉了每次 OOP 访问的解压（省 3 cycles/访问）。"浪费"2 个寄存器换来的收益远超失去的。

  ② PhaseChaitin::Select() 中 spill 是怎么发生和处理的？
      线索: chaitin.cpp:519 Select()
      答案方向: Select() 从栈弹出节点 → 遍历 0-15 号颜色（preg）→ 检查是否被邻居占用 →
      如果找到未占用颜色 → 分配；如果所有 16 个颜色都被邻居占用 → choose_color() 返回 -1 →
      select_spill() 标记此节点为 "spill candidate" → 基于节点权重选最不痛的 spill。
      Split() 然后把这个 vreg 的 Live Range 切成两段：(a) spill 前段 → 结束后写栈；
      (b) spill 后段 → 从栈读回。新 vreg 重新参与分配。

  ③ Spill 的代价具体是多少？perf 怎么验证？
      答案方向: 每次 spill `mov [rbp-offset], reg` → ~5 cycles（L1 cache hit）→ 
      每次 fill `mov reg, [rbp-offset]` → ~5 cycles → spill+fill pair = ~10 cycles。
      如果方法中有 20 个 spill+fill 对 → 200 cycles。无 spill 版本只需 1 cycle × 20 = 20 cycles。
      perf 验证：`perf top -p <PID>` → 查看 JIT compiled code 的热点指令 → 如果大量
      `mov %rax, -0x10(%rbp)` / `mov -0x10(%rbp), %rcx` → spill 风暴。
```

### 4.5 ★★ Coalesce：消除 mov 指令的艺术

```
问题：
  ① Coalesce 消除的 "mov" 从哪来？
      答案方向: C2 的代码生成（Matcher 阶段）产生大量 `mov` 指令——因为 Matcher 把每个 MachNode
      的输出分配到独立的 vreg。例如 `x = a + b; y = x + c;` → Matcher 把 `a+b` 的结果放到 vreg_5、
      `y` 的结果放到 vreg_6 → 生成 `mov vreg_6, vreg_5`（把 x 的值复制到 y 的 vreg）。
      Coalesce 发现 vreg_5 和 vreg_6 的 Live Range 不重叠 → 合并为一个 vreg → `mov` 消失。

  ② 为什么 AggressiveCoalesce 在 IFG_virtual 之后、IFG_physical 之前？
      答案方向: IFG_virtual 提供了"谁和谁冲突"的信息——Coalesce 需要这个来决定哪些 mov 对可以合并
      （如果 A 和 B 冲突 → 不能合并——否则 merge 后 A/B 会和自己冲突）。但 AggressiveCoalesce 在
      IFG_physical 之前做 → 因为合并 vreg 减少 vreg 总数 → IFG_physical 的度降低 → 着色更容易 →
      spill 更少。这是 HotSpot 的核心优化——用 Coalesce 预防 spill，而不是 spill 后再修复。

  ③ 如果两个 vreg 连接的 `mov` 不是"纯粹的 copy"——还能 Coalesce 吗？
      答案方向: 看情况。如果 `mov vreg_A, vreg_B` 后 A 立即被使用、B 不再使用 → 可以 Coalesce。
      如果 `mov vreg_A, vreg_B` 后 B 还有后续使用 → 不能 Coalesce——因为合并后 B 被 "kill" 了。
      PhaseAggressiveCoalesce 的 `compatible()` 检查：dest 的 Live Range 是否完全包含 src 的
      最后使用。如果是 → 合并安全。
```

### 4.6 ★★ Production：Spill 风暴诊断

```
问题：
  ① perf top 显示 40% mov 指令——一定是 spill 吗？
      答案方向: 不一定是 spill。mov 可能来自：(a) spill/fill（reg↔stack）→ "mov reg, disp(rbp)" /
      "mov disp(rbp), reg"；(b) 参数传递（ABI 要求参数在特定寄存器）→ "mov rdi, rax"；
      (c) 类型转换（sign extension）→ "movsxd rcx, eax"。诊断：看 mov 的源/目标——如果是
      disp(rbp) → 确定是 spill。spill 的频率 >5% 总指令 → 值得关注。

  ② 如何减少 spill？
      答案方向: (a) 减少方法的寄存器压力——内联更少 → 更少 vreg → 更少 spill。这个 tradeoff 在
      02-Inline 中体现——内联增加 vreg 数 → spill 增加 → 内联的收益要扣除 spill 的代价。
      (b) -XX:FreqInlineSize 减小 → 减少大方法的内联。(c) 重构 Java 代码——把一个"大而全"
      的方法拆成多个小子方法 → 每个子方法的 vreg 更少 → spill 更少。

  ③ -XX:+PrintOptoAssembly 怎么看 spill？
      答案方向: PrintOptoAssembly 输出 post-regalloc 汇编——可以看到哪些指令是 spill/fill。
      spill 特征：`mov [rsp + #offset], R` 或 `mov [rbp - #offset], R`（写入栈）。
      fill 特征：`mov R, [rsp + #offset]`（从栈读回）。计算 spill+fill 占总指令的 %。
```

## 五、文章结构

```
§〇 生产场景 — perf spill 风暴诊断
  ★ 真实 perf top 输出——40% mov 是 spill/fill
  ★ 诊断：perf → PrintOptoAssembly → 定位 spill 源

Actual perf top output from a method with register pressure > 16:

```
Samples: 128K of event 'cycles', 4000 Hz
Overhead  Shared Object          Symbol
  22.12%  [JIT compiled code]    mov %rax, -0x10(%rbp)    ← spill
  18.34%  [JIT compiled code]    mov -0x10(%rbp), %rcx    ← fill
  15.23%  [JIT compiled code]    add %rdx, %rax
   8.21%  [JIT compiled code]    mov %rsi, -0x18(%rbp)    ← spill
```

Spill ratio: (22.12 + 18.34 + 8.21) / total = 48.67% of instructions are mov reg↔stack.
Normal compiled code: <5% mov to/from stack → CPU spends time computing, not shuttling data.
This is what Chaitin spill looks like at the CPU level — the compiler ran out of registers and had to "park" values on the stack, then "retrieve" them later. Every spill/fill pair costs ~10 cycles that should have been 1 cycle in a register.

§一 ★★★ 8 步完整算法顺序（从 chaitin.cpp:336-583 验证）
  ❓ HotSpot 的顺序为什么和标准 Chaitin(1982) 不同？
  ❓ Coalesce 为什么在 IFG_virtual 之后、IFG_physical 之前？
  1.1 ★ Mermaid 算法流程图——8 步 + spill 回环
  1.2 和标准 Chaitin 1982 的逐步对比表
  1.3 ★ 面试 Story Format 答案：Chaitin 着色的核心思想

§二 ★★ Live Range 计算
  ❓ 为什么 Live Range 重叠决定"不能共享寄存器"？
  ❓ Live Range 的计算为什么是反向遍历？
  2.1 PhaseLive::compute() — _first_use / _last_use
  2.2 Live Range 矩阵——per-vreg 的活跃区间表

§三 ★★ IFG 构建（虚拟 + 物理）
  ❓ 为什么需要两个 IFG（virtual + physical）？
  ❓ 边的权重如何影响 spill 选择？
  3.1 PhaseIFG 构造器——邻接矩阵构建
  3.2 IFG_virtual → AggressiveCoalesce → IFG_physical 的数据流
  3.3 MachNode::two_adr() 的 reg_class 限制

§四 ★★★ AggressiveCoalesce — 消除 mov 指令
  ❓ mov 从哪来？Coalesce 怎么消除？
  ❓ 为什么 Aggressive 在 IFG_virtual 之后、IFG_physical 之前？
  4.1 PhaseAggressiveCoalesce::coalesce_driver() — 迭代合并
  4.2 compatible() — 何时两个 vreg 可以安全合并
  4.3 ConservativeCoalesce — spill 后的保守合并

§五 ★★ Simplify + Select — 着色
  ❓ 为什么 "degree < 16 的节点一定能着色"？
  ❓ 如果 Select 失败 → spill → 重做的完整回环
  5.1 Simplify() (L515) — 低度节点压栈
  5.2 Select() (L519) — 弹栈着色 choose_color
  5.3 Spill 选择 — select_spill() 的权重策略

§六 ★★ Spill + Split + 重做
  ❓ Spill 后为什么需要重新 Live→IFG→Coalesce→着色？
  ❓ Split 的 Live Range 怎么切？
  6.1 Split() (L546) — Live Range 切段
  6.2 fixup_spills() (L680) — 插入 spill/fill mov 指令
  6.3 重做循环的上限——防止无限 spill

§七 ★ Production：Spill 风暴诊断 workflow
  ❓ perf 怎么区分 spill 和普通 mov？
  ❓ 如何减少 spill：Inline→vreg 数→spill 率的因果关系
  7.1 perf top 定位 spill 频率
  7.2 -XX:+PrintOptoAssembly 确认 spill/fill 指令
  7.3 寄存器压力的根源：内联深度 vs vreg 数

§八 GDB 验证 + 可证伪断言 (≥10 条)
  断言 1: Register_Allocate() 入口 — 打印 vreg 总数 + block 数
  断言 2: PhaseLive::compute() 后 — 验证每个 Node 的 _first_use/_last_use
  断言 3: IFG_virtual 构建后 — degree 分布
  断言 4: AggressiveCoalesce 前后 — vreg 数变化（合并了多少对）
  断言 5: IFG_physical 构建后 — 验证 K=16 的限制
  断言 6: Simplify() 每次 iteration — 低度节点数
  断言 7: Select() 着色成功 — 验证颜色分配
  断言 8: Select() spill 发生 — choose_color 返回 -1
  断言 9: Split() 后 — 新 vreg 的 Live Range 长度
  断言 10: fixup_spills() 后 — 插入的 spill/fill mov 指令数

§九 和 [01][02] 的交叉验证
  ❓ 01-Pipeline §七（Matcher—Ideal Node→MachNode→vreg 分配）→ 03 的输入
  ❓ 02-Inline §五（内联的代价——vreg 数增加→spill 风险）→ 03 的 spill 代价
```

## 六、写作要求

1. **★ 8 步算法顺序的 Mermaid 图**——从 PhaseLive 到 fixup_spills，标注每个步骤的函数名 + 行号 + spill 回环
2. **★ HotSpot 顺序 vs 标准 Chaitin 1982 的逐步对比表**——标注差异步骤 + 差异原因
3. **★ "你需要知道的" 6 概念 callout 框**——vreg/preg/IFG/Spill/Coalesce/Simplify+Select
4. **★ Coalesce 在 IFG_virtual 之后、IFG_physical 之前的理由**——这是和标准教科书的核心差异，必须深入解释
5. **★ spill 的真实代价**——perf 数据 + PrintOptoAssembly 验证 spill 频率 >5% 的阈值
6. **★ 面试 Story Format 答案**——§ 一末尾："Chaitin 着色算法的核心思想？"
7. **★ GDB 断点**——精确到 chaitin.cpp 行号：L425(coalesce_driver)、L515(Simplify)、L519(Select)、L546(Split)、L680(fixup_spills)
8. **★ 交叉引用**：01 §七（Matcher→vreg 分配=RegAlloc 的输入）、02 §五（Inline→vreg 数→spill 率）

## 七、输出格式

- Markdown 文件，命名为 `03-Chaitin-RegAlloc.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/05-jit-compiler/`
- 元信息头：
  ```
  > **阶段**：[05-jit-compiler]
  > **前置**：[01-C2-Pipeline] §七（Matcher——Ideal Node→MachNode + vreg 分配）
  > **配套**：[01] §八（Output——消费 RegAlloc 的输出）、[02-Inline-Decision] §五（内联→vreg 数→spill 风险）
  > **阅读收益**：理解 C2 如何将 ∞ 个虚拟寄存器映射到 16 个 x86_64 GPR——从 Live Range 计算到 IFG 构建到 Coalesce 消除 mov 到 Simplify+Select 着色到 Split spill；掌握 perf spill 风暴诊断 workflow
  ```

## 禁止行为

- ❌ 把 Chaitin 算法的数学论文翻译成中文——这是 HotSpot 的实现分析，不是算法教材
- ❌ 只讲"Chaitin 着色算法"不讲 HotSpot 的具体顺序——Coalesce 的位置是 HotSpot 和标准教科书的本质差异
- ❌ 忽略 x86_64 的寄存器约束——RSP/RBP/R12/R15 的专用化对"可用寄存器数"的压减必须明确
- ❌ 不做 spill 的真实代价量化——perf 验证 spill 频率 >5% 是生产中有意义的阈值
- ❌ 不解释 Coalesce 为什么分 Aggressive 和 Conservative——两种 Coalesce 在不同阶段出现，理由不同
- ❌ 不解释 Select 失败→Spill→Split→重做的完整回环——只说"spill 了就重做"不给循环条件
- ❌ 不做"degree < 16 的节点一定能着色"的证明——这是 Chaitin 算法的核心洞察
- ❌ 忘记和 [01-Pipeline] Matcher 阶段的连接——读者从 Matcher 的 vreg 分配进入 RegAlloc

## 要求行为

- ✅ **★ 8 步算法顺序 Mermaid 图**——标注函数名 + 行号 + spill 回环
- ✅ **★ HotSpot vs 标准 Chaitin 1982 对比表**
- ✅ **★ "你需要知道的" 6 概念 callout 框**
- ✅ **★ Coalesce 位置的深入解释**——Aggressive vs Conservative + 为什么在 IFG 之间
- ✅ **★ spill 代价量化**——perf + PrintOptoAssembly + spill 频率阈值
- ✅ **★ 面试 Story Format 答案模板**
- ✅ **★ GDB 断言 ≥10 条**——精确到 chaitin.cpp 行号
- ✅ **★ 交叉引用 01 §七 + 02 §五 的精确 § 号**
