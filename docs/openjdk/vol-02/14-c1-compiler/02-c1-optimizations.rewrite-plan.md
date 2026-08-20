# 14-c1-compiler/02-c1-optimizations 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 C1 为什么敢在“快编译”前提下做一批优化，以及这些优化为什么集中在“建图即时化简 + 便宜的值复用 + 局部结构清理”，而不会把 C1 拖成小号 C2

## 1. 选题判断

现稿已有不错事实：
- `Canonicalizer` 在 `append_with_bci` 即时运行
- `ValueMap::find_insert` 做 LVN/GVN
- `IR::optimize_blocks`、`IR::eliminate_null_checks`
- `RangeCheckElimination::eliminate`
- 一些规则与 flag 边界

但主线仍偏“优化工具三件套目录”。真正该打穿的困惑应更集中：

**C1 一边追求极低延迟，一边又不能把 naive HIR 原样送去发码。那它到底敢在什么时机做哪些‘便宜但划算’的优化？为什么这些优化不会把 C1 变成一个慢吞吞的小号 C2？**

这才是本篇最值得围绕的核心问题。

## 2. 一句话顿悟

**C1 的优化哲学不是“做尽可能多”，而是“只做那些在建图期或 HIR 早期就能低成本兑现、并且能明显减少后续工作量的清理动作”。因此它把一部分优化前移到 `append_with_bci` 当场解决（Canonicalizer + LVN），另一部分做成轻量的 HIR 级整理（block cleanup / null check / range check / GVN），目标不是榨尽代码质量，而是让后面的 LIR 和发码阶段少背垃圾。**

## 3. 总图

```text
naive HIR
  │
  ├─ 建图当场清理
  │    ├─ Canonicalizer：代数/常量/控制流简化
  │    └─ Local Value Numbering：同块重复值复用
  │
  ├─ HIR 阶段轻量整理
  │    ├─ optimize_blocks：条件表达式/块清理
  │    ├─ Global Value Numbering
  │    ├─ RangeCheckElimination
  │    └─ NullCheck elimination
  │
  └─ 结果
       └─ 不是“最优 HIR”，而是“够干净，值得继续快速降成 LIR”
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——C1 既要快，为什么还要做优化

目标约 1200 字。

- 从上一篇的 naive HIR 接过来
- 说明“不优化”会把后端拖死，但“优化太多”又会拖慢编译
- 引出核心：C1 只挑低成本、高回报的清理动作

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. C1 应该完全不做优化，直接发码
2. C1 既然要优化，就应该像 C2 一样尽量多做

结论：
- 不做优化会让后续 LIR/寄存器分配/发码背太多垃圾
- 做太多会破坏 tiered 的低延迟目标

### 第三节：`Canonicalizer`——为什么最佳时机不是“图建完后”，而是“节点刚 append 时”

目标约 2100 字。

- `append_with_bci` 调用点
- `Canonicalizer` 构造即 visit
- 即时 canonicalize 的意义
- 解释为什么它不是独立大阶段

### 第四节：Canonicalizer 真正在做什么——不是大而全优化器，而是便宜的局部恒等/折叠/分支收缩

目标约 2200 字。

- x==y 恒等规则
- 双常量折叠
- 单常量（0 等）简化
- If → Goto 的控制流简化
- 讲清“它不做什么”：不是方法内联器，不做深层代数重写

### 第五节：`ValueMap`——为什么值复用也要分“当场局部”和“后续全局”两层

目标约 2100 字。

- `find_insert`
- hash + `is_equal`
- 跨块命中为什么要 pin
- `kill_memory/kill_field/kill_array`
- LVN 与 GVN 的边界

### 第六节：`optimize_blocks` / `Optimizer`——为什么 C1 仍愿意做一点控制流结构清理

目标约 1500 字。

- `IR::optimize_blocks`
- `Optimizer` 只有很少几类事情
- 它服务的是“把图修平”，不是深度全局变换

### 第七节：空检查与范围检查消除——为什么它们值得在 C1 做

目标约 1900 字。

- `IR::eliminate_null_checks`
- `RangeCheckElimination::eliminate`
- 只有在 `has_access_indexed` 时才做 RCE
- 讲清收益：后续少发异常边/少留冗余守卫

### 第八节：这些优化共同追求的到底是什么

目标约 1400 字。

- 不是“最优代码”，而是“把垃圾尽早扔掉”
- 为 LIR / LinearScan / 发码减负
- 强调 C1 优化的成功标准：低成本清图，而不是高度聪明

### 第九节：误解清单与收网

目标约 1200 字。

至少回答：
1. Canonicalizer 是否是多趟独立主阶段
2. ValueMap 是否只是一个普通哈希缓存
3. GVN 是否意味着 C1 已经变成 C2 式全局优化器
4. range/null check elimination 是否只是“锦上添花”
5. C1 是否没有 escape analysis / profile 相关浅层优化意识

## 5. 失败方案必须写进正文

1. C1 完全不该做优化，直接发码
2. C1 既然要优化，就应该尽量做成 C2 那样
3. 所有 canonicalization 都应该留到 HIR 全部建完以后再统一跑

## 6. 证据清单

- `share/c1/c1_Canonicalizer.hpp:57-61`：构造即 visit
- `share/c1/c1_Canonicalizer.cpp:77-191`：算术/常量 canonicalize
- `share/c1/c1_GraphBuilder.cpp:2299-2319`：append 时 canonicalize + LVN
- `share/c1/c1_ValueMap.cpp:109-148`：`find_insert`
- `share/c1/c1_ValueMap.cpp:123-127`：跨块 pin
- `share/c1/c1_ValueMap.cpp:196-213`：kill 语义
- `share/c1/c1_IR.cpp:277-305`：`optimize_blocks` / `eliminate_null_checks`
- `share/c1/c1_Optimizer.hpp:31-43`：Optimizer 职责边界
- `share/c1/c1_RangeCheckElimination.cpp:46-52`：RCE 启动条件
- `share/c1/c1_globals.hpp`：相关 flags 边界（必要时正文提边界，不必展开太多）

## 7. 必须明确的边界

- 基于 JDK 11u C1 当前实现
- 本篇聚焦 HIR 前后期的“低成本清理”，不扩展到 C2 式深全局优化
- 不把 escape / profiling 重新展开成 12-ci 内容，只在需要时提到 C1 也会消费这些信息
- 某些 flags 是 develop/product，要清楚交代边界

## 8. 完成后 review

- 删除代码后，能否复述“C1 优化的目标不是做最多，而是尽快把垃圾扔掉”
- 是否把 Canonicalizer、ValueMap、Optimizer、RCE/NCE 收回到同一条低延迟主线
- 是否明确哪些动作发生在 append 当场，哪些发生在 HIR 阶段整理
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
