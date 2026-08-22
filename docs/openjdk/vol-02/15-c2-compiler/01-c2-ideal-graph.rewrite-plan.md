# 15-c2-compiler/01-c2-ideal-graph 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 C2 不沿用 C1 的块式世界，而是先换成 `Ideal Graph = Node + Type + IGVN` 这套统一图世界观，以及这三件基础设施怎样形成全局优化闭环

## 1. 选题判断

现稿事实基础很强：
- `Node` 的 `_in/_out`、required / precedence edges
- `Identity / Value / Ideal` 三钩子
- `Type` 的格：`meet / join / dual`
- `PhaseIterGVN::transform_old` / worklist / hash CSE
- `Compile::_for_igvn` 的初始工作表

真正该打穿的困惑更集中：

**为什么 C2 需要先换成一张统一图，再让 `Node + Type + IGVN` 互相推动，才能把优化真正推到全局？`IGVN` 为什么不是“多跑几遍 Canonicalizer”？**

## 2. 一句话顿悟

**C2 的关键变化不是“优化更多”，而是“先换世界观”——控制、数据和内存都画成图边；节点的可能取值都刻进类型格；然后用 worklist 驱动的 IGVN，让每一次局部改写都沿图自动传播，直到整张图不再有新变化。**

## 3. 总图

```text
Ideal Graph
  Node
    ├─ _in  : use-def
    ├─ _out : def-use
    └─ required / precedence edges

  Type lattice
    ├─ meet / join / dual
    ├─ 整数区间
    └─ 指针空值 / 非空 / Bottom

  IGVN
    ├─ Ideal()    图改写
    ├─ Value()    类型收窄
    ├─ Identity() 等价节点
    └─ hash_find_insert() 全局值编号
         ↓
      worklist 传播到不动点
```

## 4. 结构大纲

### 第一节：开场困惑——为什么 C2 要先换世界观

- 从 C1 的块式 HIR 作为对照切入
- 点出：C1 不擅长把控制流、数据流、内存依赖和类型传播揉成同一个全局问题
- 埋主线：C2 先统一图表示，再让 Type 和 IGVN 在图上互相推动

### 第二节：两个朴素方案为什么都不对

1. C2 只是“更猛的 C1”
2. IGVN 不就是“多跑几遍 Canonicalizer”

### 第三节：`Node`——为什么控制、数据和内存都画成边

- `_in` / `_out`
- required / precedence edges
- arena 分配与不做细粒度 delete

### 第四节：`Node` 不是被动结构——`Identity / Value / Ideal`

- 三钩子的默认语义
- `Ideal()` 的返回契约
- 节点自己暴露优化接口而不是 pass 外部乱改图

### 第五节：`Type`——为什么必须把“可能值集合”刻在图上

- `meet / join / dual`
- `TypeInt::xmeet`
- `TypePtr::ptr_meet`
- 类型不是注释，而是优化驱动器

### 第六节：IGVN——为什么必须迭代到不动点

- `transform_old()` 五步
- `Ideal / Value / Identity / singleton 常量化 / hash CSE`
- worklist 传播而不是固定趟次

### 第七节：这不是全图暴力重扫——worklist 的稀疏传播

- `_for_igvn` 初始工作表
- `optimize()` 的工作流
- 死节点清理与防发散守卫

### 第八节：误解澄清与收网

## 5. 失败方案

1. C2 只是“优化更多的 C1”
2. IGVN 就是多跑几遍规范化 pass

## 6. 证据清单

- `src/hotspot/share/opto/node.hpp:282-291`
- `src/hotspot/share/opto/node.hpp:231-238`
- `src/hotspot/share/opto/node.cpp:1081-1145`
- `src/hotspot/share/opto/type.hpp:224-247`
- `src/hotspot/share/opto/type.cpp:1455-1495`
- `src/hotspot/share/opto/type.cpp:2460-2466`
- `src/hotspot/share/opto/phaseX.cpp:1223-1247`
- `src/hotspot/share/opto/phaseX.cpp:1283-1390`
- `src/hotspot/share/opto/compile.cpp:757-759`

## 7. 完成后 review

- 删除代码后，能否复述“统一图 + 类型 + worklist 传播到不动点”
- 是否讲清 `Node / Type / IGVN` 的闭环关系
- 是否讲清 worklist 不是全图暴力重扫
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验