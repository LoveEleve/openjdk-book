# 15-c2-compiler/03-c2-optimizations 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 为什么不靠一个“万能优化器”解决一切，而要把图上优化拆成 IGVN、CCP、Escape Analysis 三套互补引擎

## 1. 选题判断

现稿已经覆盖大量关键事实：
- IGVN 在 `Compile::Optimize` 中多次重跑
- `PhaseCCP` 的乐观 TOP 初始化与 worklist 分析
- `ConnectionGraph::compute_escape` 五步构图/传播/优化
- `PhaseMacroExpand::eliminate_allocate_node`
- `Compile::Optimize` 中 EA/CCP/IGVN 的实际编排

但现稿主线仍偏“两个新引擎 + 一个调度器说明书”。真正该打穿的读者困惑应更集中：

**既然 C2 已经有了 Ideal Graph、Type 和 IGVN，为什么它还不够？为什么还要再引入 CCP 和 Escape Analysis？也就是说，这三套机制各自弥补了哪一种优化缺口，才让 C2 形成真正的全局优化闭环？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**IGVN、CCP 和 Escape Analysis 不是三套并列的“再优化一遍”的工具，而是分别解决图上三种不同缺口：IGVN负责局部形状与全局值合并，CCP负责把“某条控制流根本走不到/某个值恒定”这类可达性与常量事实推过整图，Escape Analysis 负责证明“这个对象其实可以不分配”。三者互相喂数据，之间穿插 IGVN 再收敛，最后再由 MacroExpand 把被证明安全的宏节点真正消掉。**

## 3. 总图

```text
Ideal Graph 已建好
  │
  ├─ IGVN
  │    └─ 局部代数化简 / 类型传播 / CSE / 节点合并
  │
  ├─ CCP
  │    └─ 乐观常量传播 + 不可达控制流剪除
  │
  ├─ Escape Analysis (ConnectionGraph)
  │    └─ 证明对象是否逃逸、是否可标量替换
  │
  └─ MacroExpand
       └─ 把 EA 证明过的分配/锁/宏节点真正消掉
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——IGVN 都这么强了，为什么还不够

目标约 1300 字。

- 从 Ideal Graph + IGVN 接过来
- 提出疑问：既然节点可改写、类型会变窄、还能 CSE，为什么还要 CCP 和 EA
- 引出三个缺口：局部图形、控制可达性、对象去向

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. IGVN 一把梭就能完成全部优化
2. CCP/EA 只是“再跑一遍图优化”

结论：
- IGVN 擅长节点重写和类型传播，但不专门负责控制可达性与对象去向证明
- CCP/EA 不是重复劳动，而是各自补上不同信息维度

### 第三节：IGVN 的调度地位——为什么它像“收敛器”一样反复回来

目标约 1600 字。

- `Compile::Optimize` 多处 `igvn.optimize()`
- EA 后一次、MacroExpand 后一次、CCP 后一次
- 说明它不是“三引擎之一”，更像各阶段之后的统一收敛器

### 第四节：CCP——为什么要从 TOP 出发做乐观前向传播

目标约 2200 字。

- `PhaseCCP::analyze`
- 全部节点类型初始化为 `TOP`
- 从 `root` 入 worklist
- 类型只增不减（widen）
- 与 IGVN 的“悲观精化”形成对照

### 第五节：CCP 真正消掉的是什么——不是代数式，而是不可达控制流

目标约 1900 字。

- `transform_once`
- singleton -> constant
- `Type::TOP` region -> unreachable region cut
- If/Region/Phi 的死亡链
- 说明 CCP 的价值在“控制流可达性”而非简单折叠表达式

### 第六节：Escape Analysis——为什么对象去向不能靠 IGVN/CCP 推出来

目标约 2200 字。

- `ConnectionGraph` 节点类型
- `EscapeState`
- JavaObject / LocalVar / Field
- 解释为什么“对象是否逃逸”是一张图问题，不是单节点类型问题

### 第七节：ConnectionGraph 的核心流程——先构图，再传播，再决定能否标量替换

目标约 2300 字。

- `compute_escape` 五步
- `add_node_to_connection_graph`
- `add_final_edges`
- `complete_connection_graph`
- `adjust_scalar_replaceable_state`
- `split_unique_types`
- 区分 NoEscape 与 scalar_replaceable

### 第八节：EA 不是最后一刀——真正删除分配发生在 `PhaseMacroExpand`

目标约 1700 字。

- `eliminate_allocate_node`
- `_is_non_escaping`
- `can_eliminate_allocation`
- `scalar_replacement`
- `process_users_of_allocation`
- 说明“证明”和“真正删除”是两个阶段

### 第九节：三引擎怎么咬合成闭环

目标约 1500 字。

- IGVN 提供图和类型收敛
- CCP 把控制路径变窄，交回 IGVN
- EA 改写内存图/宏节点，再交回 IGVN 和 MacroExpand
- 解释为什么它们之间要反复插 `igvn.optimize()`

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. CCP 是否是“从 BOTTOM 开始逆传播”
2. EA 是否是从每个 Allocate 做 DFS 搜索
3. NoEscape 是否直接等于“可以标量替换”
4. EA 是否自己删除分配
5. IGVN 是否可以取代 CCP 和 EA

## 5. 失败方案必须写进正文

1. IGVN 一把梭解决所有优化问题
2. CCP 只是“再做一次常量折叠”
3. EA 只是从 Allocate 往外搜一圈使用者
4. NoEscape 一定等于可标量替换

## 6. 证据清单

- `share/opto/compile.cpp:2247-2254` / `2308-2333` / `2375-2391`：IGVN/EA/CCP 编排
- `share/opto/phaseX.cpp:1811-1957`：`PhaseCCP::analyze`
- `share/opto/phaseX.cpp:1991-2113`：`transform_once`
- `share/opto/escape.hpp:85-112`：ConnectionGraph 注释与边语义
- `share/opto/escape.hpp:145-168`：NodeType / EscapeState / NodeFlags
- `share/opto/escape.cpp:118-343`：`compute_escape`
- `share/opto/macro.cpp:1091-1155`：`eliminate_allocate_node`

## 7. 必须明确的边界

- 基于 JDK 11u C2 当前实现
- 本篇聚焦三引擎协作，不深入 LoopOpts/SuperWord（下一篇）
- CCP/EA 的 debug 打印与 release 可见性边界要明确
- `bcEscapeAnalyzer` 只作对照，不重复 12-ci 的分析细节

## 8. 完成后 review

- 删除代码后，能否复述“IGVN、CCP、EA 分别填三种不同缺口”
- 是否把 `Compile::Optimize` 的时序收成一条线，而不是三套平铺介绍
- 是否讲清了“证明”和“真正删除”是两阶段
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
