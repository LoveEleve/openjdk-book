# 15-c2-compiler/07-c2-macro-intrinsics 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 C2 在前面几章故意保留一批高层“宏节点”而不立刻降级，以及 `PhaseMacroExpand` 如何在最晚时机统一裁决“能消的消、必须留的展开”

## 1. 选题判断

现稿已经抓到不少关键事实：
- `expand_macro_nodes`
- `eliminate_macro_nodes`
- `expand_allocate` / `eliminate_allocate_node`
- `expand_lock_node` / `eliminate_locking_node`
- `expand_arraycopy_node`
- Opaque/LoopLimit 清理与 arraycopy 先行顺序

但结构仍偏“分配/锁/数组拷贝”并列说明。真正该打穿的核心困惑是：

**既然 C2 迟早都要把 `Allocate`、`Lock`、`ArrayCopy` 之类高层节点降成机器节点，为什么不在 Parse 或 Matcher 阶段就早点做？它到底在等什么信息成熟，才非要把“消除”和“展开”都拖到 `PhaseMacroExpand` 这个最晚时机再统一裁决？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**宏节点不是“还没来得及降级的半成品”，而是 C2 故意保留到优化后期的高层占位符。之所以保留，是因为在 EA、循环优化、匹配和寄存器分配之前，编译器还不知道这些高层操作最终命运：有些会被证明可以完全消失（分配/锁消除），有些必须保留但要按平台与运行时协议展开成复杂控制流（slow path、stub 调用、patching）。`PhaseMacroExpand` 的职责，就是在这些信息都成熟之后做最后一次审判。**

## 3. 总图

```text
Parse / IGVN / CCP / EA / LoopOpts 完成后
  │
  ├─ 宏节点仍在图中保留：Allocate / Lock / ArrayCopy / Opaque / LoopLimit ...
  │
  ├─ PhaseMacroExpand
  │    ├─ 再试一次 eliminate_macro_nodes
  │    ├─ 清理临时宏节点（Opaque/LoopLimit 等）
  │    ├─ 先展开 ArrayCopy
  │    └─ 再展开 Allocate / Lock / Unlock
  │
  └─ 结果
       ├─ 能消的：彻底消失
       └─ 必留的：展开成真实控制流 / 调用 / MachNode 友好形态
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么这些高层节点不早点展开

目标约 1300 字。

- 从 Allocate/Lock/ArrayCopy 这些高层节点开场
- 提出问题：既然终归要落机器码，为什么不早点降级
- 提前埋一句：晚展开是为了等“命运信息”成熟

### 第二节：两个朴素办法为什么都不对

目标约 1800 字。

必须推演：
1. Parse 后立刻把所有高层节点都展开
2. 宏节点一律保留到最后，完全不尝试消除

结论：
- 过早展开会污染优化视图、放大图规模、妨碍 EA/循环优化
- 从不提前消除会错失“零成本消失”的机会

### 第三节：`expand_macro_nodes` 的编排——为什么这是“最后审判”而不是普通 pass

目标约 1900 字。

- `expand_macro_nodes`
- last attempt to eliminate
- node budget
- Opaque / LoopLimit 清理
- arraycopy 先行
- allocate/lock/unlock 主循环
- `_igvn.optimize()` 收尾

### 第四节：分配的两条出路——为什么先问“能不能不存在”再问“怎么存在”

目标约 2200 字。

- `eliminate_allocate_node`
- `_is_non_escaping` / scalar replacement 前提
- `expand_allocate` / `expand_allocate_common`
- 快路径内联 + 慢路径调用
- 强调：消除与展开是两个互斥命运

### 第五节：锁的两条出路——锁消除与锁展开为什么也要拖到这一步

目标约 1900 字。

- `eliminate_locking_node`
- `expand_lock_node`
- MemBarAcquireLock / MemBarReleaseLock
- fastlock/slow path 结构
- 说明锁也不是“总会留下机器指令”

### 第六节：为什么 arraycopy 要先于 allocate 展开

目标约 1700 字。

- `expand_arraycopy_node`
- clonebasic / copyof / cloneoop / generate_arraycopy
- compile-time checks
- `ReduceBulkZeroing` 顺序依赖
- 说明这不是偶然顺序，而是宏节点间的依赖拓扑

### 第七节：宏节点保留到这里，说明 C2 前半程在刻意保护什么

目标约 1500 字。

- 优化视图干净
- EA/loop opts 看到的是高层语义，而不是细碎 slow path 控制流
- 宏节点是“延迟决策”的载体，不是未完成工作

### 第八节：收尾 IGVN 为什么还要再跑一次

目标约 1300 字。

- 展开/消除之后图再次变化
- `_igvn.optimize()` 收敛 residual graph
- barrier set 继续 expand macro nodes
- 说明 macro expand 不是末尾一次性替换，而是再触发一轮图收敛

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. 宏节点是不是“还没来得及匹配成机器节点”的残次品
2. EA 是否已经等于分配删除
3. `expand_lock_node` 是否直接发出 cmpxchg 之类最终机器码
4. arraycopy 是否只是一个普通调用节点
5. 宏展开为什么不能早做也不能太晚做

## 5. 失败方案必须写进正文

1. Parse 后立刻展开全部宏节点
2. 从不做消除，只到最后统一展开
3. 把 MacroExpand 当成单纯的“节点翻译”阶段

## 6. 证据清单

- `share/opto/macro.cpp:2645-2778`：`expand_macro_nodes`
- `share/opto/macro.cpp:1091-1155`：`eliminate_allocate_node`
- `share/opto/macro.cpp:2182-2255`：`eliminate_locking_node`
- `share/opto/macro.cpp:2258+`：`expand_lock_node`
- `share/opto/macroArrayCopy.cpp:1106-1175`：`expand_arraycopy_node`
- `share/opto/compile.cpp:2326-2333` / `2432-2440`：MacroExpand 在总管线中的位置

## 7. 必须明确的边界

- 基于 JDK 11u C2 当前实现
- 本篇聚焦宏节点的“保留、消除、展开”时序，不展开 library_call intrinsic 细节（下一篇）
- 机器级指令最终仍由 Matcher/Output 负责，不把 expand 讲成最终发码
- 部分路径依赖 Runtime/Stub/BarrierSet，只点到为止

## 8. 完成后 review

- 删除代码后，能否复述“宏节点是延迟决策占位符，不是未完成节点”
- 是否把 eliminate/expand/arraycopy ordering 收回到同一个‘最后审判’主线
- 是否明确区分了：证明可消、真正消除、必须展开 三种状态
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
