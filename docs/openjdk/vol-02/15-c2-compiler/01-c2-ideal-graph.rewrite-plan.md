# 15-c2-compiler/01-c2-ideal-graph 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C2 为什么不是“更猛的 C1”，而是先把程序表示换成一张统一的 Ideal Graph，再用 `Node + Type + IGVN` 把优化推到全局

## 1. 选题判断

现稿素材非常扎实，已经有：
- `Node` 的 `_in/_out` 与 arena 生命周期
- `Identity/Value/Ideal` 三钩子
- `Type` 格与 `meet/join/dual`
- `TypeInt::xmeet`、`TypePtr::ptr_meet`
- `PhaseIterGVN::transform_old` 和 `optimize`
- parse 期的 `_gvn.transform(new AddINode(...))`

但当前正文还是更像“组件说明书”：Node 一节、Type 一节、IGVN 一节，知识点都对，问题张力还不够集中。

真正要打穿的核心困惑应该是：

**C1 已经有 HIR、Phi 和若干优化趟次了，C2 为什么不在那个世界里继续增强，而是非要彻底换成一张统一控制/数据/内存边的图？以及，为什么这张图还必须配一套 `Type` 格和会反复迭代到不动点的 IGVN？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**C2 的关键变化不是“优化更多”，而是“先换世界观”：它不再把控制流、数据流和内存流分散在基本块和指令链上，而是统一到一张 Ideal Graph 里。节点一旦改变，def-use 边会自然暴露所有受影响用户；再配合 `Type` 把每个节点的“可能值集合”刻在图上，IGVN 就能围绕这张图反复做 `Ideal` 改写、类型变窄、常量化和全局值编号，直到整张图稳定下来。**

## 3. 总图

```text
Parse / GraphKit 建图
  │
  ▼
Ideal Graph
  ├─ Node
  │    ├─ 控制边
  │    ├─ 数据边
  │    └─ 内存边
  │
  ├─ Type
  │    └─ 每个节点的“可能值集合”
  │
  └─ IGVN
       ├─ Ideal 图改写
       ├─ Value 重新求类型
       ├─ singleton -> constant
       ├─ Identity 旧节点替换
       └─ hash CSE + worklist 不动点
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——C1 已经有图了，为什么 C2 还要换世界观

目标约 1300 字。

- 从 C1 的块式 HIR 接过来
- 点出 C1 在跨块/全局传播上的天然局限
- 引出核心：C2 不是多几趟 pass，而是先换 IR 形状

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. C2 只是“更激进的 C1”
2. IGVN 只是“多跑几遍 C1 那种固定趟次”

结论：
- C2 的根变化是统一图表示，不是单纯优化强度
- IGVN 依赖图结构和类型互相反馈，不是固定次数 pipeline

### 第三节：Node——为什么要把控制、数据、内存都画成边

目标约 2200 字。

- `_in/_out`
- required / precedence / outputs
- arena 分配与 delete NOP
- 纯算术节点控制边为空可以浮动
- `MemNode` 槽位解释
- “sea of nodes” 真正的含义

### 第四节：节点不是被动 IR——`Identity/Value/Ideal` 三钩子决定它怎么参与优化

目标约 2100 字。

- `Identity`
- `Value`
- `Ideal`
- 默认行为
- 重点讲 `Ideal` 返回值契约与“不能从 Ideal 返回旧节点”

### 第五节：Type——为什么 C2 必须把“可能值集合”刻在图上

目标约 2200 字。

- `meet/join/dual`
- `TypeInt::xmeet`
- `TypePtr::ptr_meet`
- `Null meet NotNull = BotPTR`
- 类型哈希唯一化与不可变性
- 类型精度为什么是优化燃料

### 第六节：IGVN——为什么必须围绕 worklist 迭代到不动点

目标约 2400 字。

- `transform_old`
- Ideal loop
- `Value()` 更新类型并推用户
- singleton 常量化
- `Identity`
- `hash_find_insert`
- `subsume_node`
- 每一步为何都把用户重新入队

### 第七节：为什么这不是“全图反复扫描”——IGVN 的效率来自稀疏传播

目标约 1600 字。

- `_for_igvn`
- `record_for_igvn`
- `optimize()` 主循环
- `remove_dead_node`
- 节点上限与 `K * live_nodes()` 守卫

### 第八节：把三件事收回到同一个闭环——Node 给传播路径，Type 给精度，IGVN 给传播机制

目标约 1400 字。

- 节点 rewrite → 用户入队
- 类型变窄 → 更多常量化 / 分支剪死
- CSE / subsume → 图收缩
- 解释为什么它比 C1 的固定趟次更全局

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. C2 是否只是更强的块式 IR 编译器
2. `Ideal()` 返回 NULL/this/旧节点分别意味着什么
3. `Type::TOP/BOTTOM` 是否只是抽象概念
4. IGVN 是否只是“多跑几轮 canonicalize”
5. `Null meet NotNull` 是否只是放弃 nullness

## 5. 失败方案必须写进正文

1. 在 C1 的块式 IR 上加更多 pass 就能得到 C2
2. 用固定几轮优化代替 worklist 不动点迭代
3. 不给节点附类型，只做纯结构重写

## 6. 证据清单

- `share/opto/node.hpp:231-238`：arena 分配与 delete NOP
- `share/opto/node.hpp:282-301`：`_in/_out` 与边分类
- `share/opto/node.cpp:1081-1146`：`Identity/Value/Ideal` 默认与 Ideal 契约
- `share/opto/type.hpp:224-253`：`meet/join/dual`
- `share/opto/type.cpp:1455-1497`：`TypeInt::xmeet/xdual`
- `share/opto/type.cpp:2460-2468`：`TypePtr::ptr_meet`
- `share/opto/phaseX.cpp:1223-1251`：`optimize()` 主循环
- `share/opto/phaseX.cpp:1283-1402`：`transform_old`
- `share/opto/compile.cpp:757-765`：`_for_igvn` 与 initial GVN
- `share/opto/node.hpp:1575-1576`：`record_for_igvn`

## 7. 必须明确的边界

- 基于 JDK 11u C2 当前实现
- 本篇建立 C2 世界观，不展开 Parse/GraphKit 细节（放到下一篇）
- 不深挖 matcher、loop opts、regalloc，它们建立在本篇三支柱之上
- debug-only 图打印与 release 可观察边界要明确说明

## 8. 完成后 review

- 删除代码后，能否复述“C2 不是更多 pass，而是换成统一图 + 类型 + 不动点迭代”
- 是否真正把 Node、Type、IGVN 收回到同一个优化闭环上
- 是否讲清了 `Ideal/Value/Identity` 与 `TOP/BOTTOM`、worklist/不动点之间的关系
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
