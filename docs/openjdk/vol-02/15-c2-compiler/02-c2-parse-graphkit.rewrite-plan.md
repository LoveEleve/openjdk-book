# 15-c2-compiler/02-c2-parse-graphkit 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 Ideal Graph 不是“自动长出来的”，而是 Parse 像抽象解释器一样逐字节码推进 JVMState，GraphKit 则把控制、内存、异常和 safepoint 这些运行时状态编织进图里

## 1. 选题判断

现稿已经具备大量好素材：
- `Parse` 构造与 `ciTypeFlow`/block 初始化
- `do_all_blocks` 与 `do_one_block`
- `do_one_bytecode`、`do_if`/`do_ifnull`
- `do_call` 与 `call_generator`
- `GraphKit::memory` / `make_load` / `store_to_memory`
- `add_safepoint`
- `JVMState` map 槽位

但当前正文仍然像“Parse 清单 + GraphKit 清单”。真正该打穿的核心困惑应该更集中：

**既然 C2 的世界观已经是一张 Ideal Graph，那字节码究竟是怎么一条条被灌进这张图里的？Parse 为什么既像解释器、又像图构造器？GraphKit 为什么要维护一整份 JVMState map，而不是像普通 builder 一样只管 new 节点连边？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**Parse 的工作不是“读字节码、随手建节点”，而是像一台抽象解释器一样沿着字节码和基本块推进当前 JVM 状态；GraphKit 则把这份状态投影到图里：当前控制点是哪、当前内存切片是哪、表达式栈和局部变量各是什么节点、异常与 safepoint 需要保留什么状态。于是建图和执行语义在 C2 前端里是交错进行的，而不是先有图、后补语义。**

## 3. 总图

```text
ciTypeFlow 提供块骨架
  │
  └─ Parse
       ├─ 维护 iter + bci + JVMState map
       ├─ 逐字节码 do_one_bytecode
       ├─ 分支/merge 时生成 Region/Phi
       ├─ 调用时 call_generator 决定 inline or call
       └─ safepoint / 异常边随建图一起接入

GraphKit
  ├─ control()
  ├─ memory(alias_idx)
  ├─ map() / set_map()
  ├─ make_load / store_to_memory
  └─ add_safepoint / uncommon_trap / replace_in_map
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——Ideal Graph 不是自动长出来的

目标约 1300 字。

- 从上一篇的“节点海”接过来
- 提问：字节码如何真正变成这张图
- 引出 Parse 与 GraphKit 的分工

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. Parse 只是顺序读字节码、new 节点
2. GraphKit 只是“方便写图”的小工具类

结论：
- Parse 实际上维护的是当前 JVM 抽象执行状态
- GraphKit 管的是控制/内存/异常/safepoint 状态，不只是节点工厂

### 第三节：Parse 为什么是块驱动而不是线性读到 return

目标约 1900 字。

- `_flow = method()->get_flow_analysis()`
- `init_blocks`
- `do_all_blocks`
- RPO 驱动
- merge 点与不可达块
- 说明 Parse 建图天然依赖 ciTypeFlow 提供的骨架

### 第四节：`do_one_bytecode`——像解释器一样推进状态，像编译器一样建节点

目标约 2300 字。

- iload 零成本压栈
- iadd 当场 `_gvn.transform(new AddINode(...))`
- `do_if` / `do_ifnull`
- `merge(target_bci)`
- uncommon_trap 让路径中止

### 第五节：内联为什么不是“优化后做”，而是建图方式的一部分

目标约 2100 字。

- `do_call`
- `call_generator`
- `ParseGenerator::generate -> new Parse(...)`
- 大小/深度/热度只是决策条件
- 决策通过后，callee 字节码直接铺进 caller 图

### 第六节：GraphKit——为什么它必须维护一整份 JVMState map

目标约 2200 字。

- `_map`
- JVMState 布局：locals/stack/args/monitors/scalars
- `control()` / `memory()` / `set_memory()`
- 图状态不是旁路数据，而是图的一部分

### 第七节：MergeMem 与内存切片——为什么 C2 的“内存流”也在图里

目标约 1700 字。

- `GraphKit::memory(alias_idx)`
- `make_load` / `store_to_memory`
- `MergeMemNode` 的 alias 切片
- 讲清不同内存类别如何在图上隔离

### 第八节：safepoint 与异常边——为什么 Parse 期就必须把这些运行时语义接进图

目标约 2200 字。

- `add_safepoint`
- clone current memory state
- poll address
- `add_safepoint_edges`
- `do_exceptions`
- uncommon_trap / throw_to_exit / catch_inline_exceptions
- 强调 parse 期保留的是 JVMState，不是机器级 OopMap

### 第九节：OSR 与普通入口——为什么 Parse 有时是“从方法中间开始建图”

目标约 1400 字。

- `is_osr_parse`
- `load_interpreter_state`
- StartOSRNode / osr buffer
- 说明 Parse 不是永远从 bci 0 起跑

### 第十节：误解清单与收网

目标约 1200 字。

至少回答：
1. Parse 是否只是顺序建节点
2. 内联是否是图建完后的优化阶段
3. GraphKit 是否只是节点工厂
4. Parse 期是否已经生成机器级 OopMap
5. safepoint/异常边是否属于“后处理”

## 5. 失败方案必须写进正文

1. 把 Parse 理解成“顺序读字节码 + new 节点”
2. 把内联理解成“建图后再展开”
3. 把 GraphKit 理解成普通 builder，不维护 JVMState

## 6. 证据清单

- `share/opto/parse1.cpp:425-427`：TypeFunc / iter / flow
- `share/opto/parse1.cpp:549-556`：`init_blocks` / `build_exits` / `create_entry_map`
- `share/opto/parse1.cpp:631-733`：`do_all_blocks`
- `share/opto/parse1.cpp:598-604`：`merge_common` 入口接法
- `share/opto/parse1.cpp:2234-2308`：`add_safepoint`
- `share/opto/parse2.cpp:1449-1526`：`do_ifnull`
- `share/opto/parse2.cpp:1529+`：`do_if`
- `share/opto/parse2.cpp:2014-2033`：`iload` 系列
- `share/opto/parse2.cpp:2250-2253`：`iadd`
- `share/opto/doCall.cpp:423-592`：`do_call`
- `share/opto/callGenerator.cpp` / 现稿中的 `ParseGenerator` 引用：内联递归入口（正文按需补齐）
- `share/opto/graphKit.cpp:1477-1580`：`memory` / `make_load` / `store_to_memory`
- `share/opto/callnode.hpp:230-259`：JVMState 布局 / map / depth

## 7. 必须明确的边界

- 基于 JDK 11u C2 当前 Parse/GraphKit 实现
- 本篇聚焦“图怎么出生”，不展开后续 IGVN/EA/CCP 优化（下一篇）
- 机器级 OopMap 明确放到寄存器分配后，不在本篇延展
- InlineTree/阈值细节只为说明“何时内联”，不喧宾夺主

## 8. 完成后 review

- 删除代码后，能否复述“Parse 像解释器一样推进状态，GraphKit 像图态管理器一样把状态接进图”
- 是否把块驱动、逐字节码、内联递归、JVMState map、MergeMem、safepoint/异常边收回到同一主线
- 是否明确区分了 parse 期 JVMState 与后端机器级 OopMap
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
