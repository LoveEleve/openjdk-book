# 26-g1-gc/06-g1-barrier 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
> 目标：解释 G1 为什么需要两道屏障（pre 记旧值、post 标脏卡），以及为什么"最重"的写屏障在大部分路径上并不重——inline 快路径、编译器删除、runtime stub 三条路径的成本天差地别

## 1. 选题判断

现稿已有很强事实基础：
- `write_ref_field_pre` / `enqueue` / SATB 队列
- `write_ref_field_post` / `write_ref_field_post_slow`
- `G1BarrierSetC1::pre_barrier` / `post_barrier`
- `G1BarrierSetC2::g1_can_remove_pre_barrier` / `g1_can_remove_post_barrier`
- `G1BarrierSetAssembler::g1_write_barrier_pre` / `g1_write_barrier_post`

但当前正文仍偏"C++ 入口一节 + C1 一节 + C2 一节 + Assembler 一节"的层次并列。真正该打穿的读者困惑更集中：

**一次写引用为什么需要两道屏障？SATB 保护旧值、card mark 记录新值——这两个问题能不能用一道屏障解决？"G1 的写屏障最重"这个说法在什么情况下成立、什么情况下不成立？C1/C2/Assembler 三层是不是三层独立实现？**

## 2. 一句话顿悟

**G1 的两道屏障解决的是两个不同的问题：pre barrier 保护并发标记的旧世界快照不被应用线程的新写覆盖，post barrier 标记跨 Region 引用的来源卡让 RSet 可追踪。两者方向不同、也不能合并。但"最重"是有条件的：SATB 不 active 时 pre barrier 直接 return，card 已 dirty 时 post barrier 不重复入队，大量场景下 C2 还能在编译期证明屏障可删除——真正走完完整路径的写操作只占一小部分。**

## 3. 总图

```text
写引用时
  pre barrier (写之前)
    ├─ IS_DEST_UNINITIALIZED / AS_NO_KEEPALIVE → return
    ├─ 旧值为 null → return
    ├─ SATB 不 active → return
    └─ enqueue 到线程本地 SATB 队列
         ├─ buffer 未满: inline 写入
         └─ buffer 满: runtime stub (call G1BarrierSetRuntime)

  oop_store (raw write)

  post barrier (写之后)
    ├─ 来源 field 位于 young card → return
    ├─ card 已 dirty → return
    ├─ card 不是 young → 置 dirty + enqueue 到 DirtyCardQueue
    └─ 同方式 inline 满→runtime

C2 编译期删除
  ├─ pre: 新分配对象 + 字段初始化 null → 可删除
  └─ post: 新分配 Eden 对象 + ReduceInitialCardMarks → 可删除
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么需要两道屏障，而不是一道

目标约 1100 字。

- 从 G1 写引用比 Serial/Parallel GC 多出两道屏障切入
- 点出两道屏障解决不同问题：pre 保护旧世界快照（SATB），post 标记跨 Region 来源卡（RSet）
- 埋主线：两道屏障各自有多个快路径，真正走完所有路径的写操作很少

### 第二节：两个朴素方案为什么都不对

目标约 1500 字。

必须推演：
1. 一道屏障就够了（SATB 和 card mark 方向不同不能合并：pre 读旧值，post 写新卡）
2. 每次写都走 runtime（cost 固定但高；实际上 inline 快路径处理了绝大多数情况）

结论：
- 两道屏障各司其职，不能互相替代
- 成本不是固定的，取决于 SATB/young/dirty 等门控状态

### 第三节：pre barrier——保护旧值不丢

目标约 2000 字。

- `write_ref_field_pre` 的 decorator 门控（g1BarrierSet.inline.hpp:36-46）
- `enqueue` 的 SATB active 检查和线程分流（g1BarrierSet.cpp:61-73）
- `SATBMarkQueue` 是 PtrQueue 实例（satbMarkQueue.hpp:44-64）
- 说明：非标记时期 pre barrier 只有 active 检查和 null 判断，成本可忽略

### 第四节：post barrier——标记跨 Region 引用

目标约 1800 字。

- `write_ref_field_post` 先过滤 young card（g1BarrierSet.inline.hpp:48-55）
- `write_ref_field_post_slow` 才做 dirty + enqueue（g1BarrierSet.cpp:99-114）
- 说明：同 Region 引用、young card 引用、已 dirty card 都直接跳过

### 第五节：C1/C2/Assembler——不是三层独立实现，是同一套屏障的三套代码生成

目标约 2200 字。

- C1 在 LIR 层生成 active flag 检查 + 跨 Region XOR 判断 + stub（g1BarrierSetC1.cpp:51-108,110-176）
- C2 在 Ideal Graph 中分析内存链，证明可删除时才生成 barrier（g1BarrierSetC2.cpp:86-172,306-335,372-479）
- x86 Assembler 做 inline 写入/递减，buffer 满才 call runtime（g1BarrierSetAssembler_x86.cpp:142-258）
- 收回"三层是同一套屏障在各层的代码生成，慢路径统一指向 G1BarrierSetRuntime"

### 第六节：误解澄清与收网

目标约 1300 字。

至少回答：
1. pre barrier 是否每次写都入队
2. post barrier 是否每次写都标脏卡
3. 两道屏障是否可合并为一道
4. C1/C2 是否生成不同的屏障逻辑（不是，只是生成策略不同）
5. "G1 写屏障最重"是否无条件成立

## 5. 失败方案必须写进正文

1. 用一道屏障同时解决 SATB + card mark（方向冲突）
2. 每次写引用都走 runtime（浪费：绝大多数被 inline 快路径过滤）
3. C1/C2/Assembler 是三层独立实现（实际是共享同一套 BarrierSetRuntime）

## 6. 证据清单

- `src/hotspot/share/gc/g1/g1BarrierSet.inline.hpp:36-46`：`write_ref_field_pre`
- `src/hotspot/share/gc/g1/g1BarrierSet.inline.hpp:48-55`：`write_ref_field_post`
- `src/hotspot/share/gc/g1/g1BarrierSet.cpp:61-73`：`enqueue`
- `src/hotspot/share/gc/g1/g1BarrierSet.cpp:99-114`：`write_ref_field_post_slow`
- `src/hotspot/share/gc/g1/satbMarkQueue.hpp:44-64`：`SATBMarkQueue` 定义
- `src/hotspot/share/gc/g1/c1/g1BarrierSetC1.cpp:51-108`：C1 pre_barrier
- `src/hotspot/share/gc/g1/c1/g1BarrierSetC1.cpp:110-176`：C1 post_barrier
- `src/hotspot/share/gc/g1/c2/g1BarrierSetC2.cpp:86-172`：`g1_can_remove_pre_barrier`
- `src/hotspot/share/gc/g1/c2/g1BarrierSetC2.cpp:306-335`：`g1_can_remove_post_barrier`
- `src/hotspot/share/gc/g1/c2/g1BarrierSetC2.cpp:372-479`：`post_barrier` 完整路径
- `src/hotspot/cpu/x86/gc/g1/g1BarrierSetAssembler_x86.cpp:142-258`：x86 pre barrier（inline + runtime）
- `src/hotspot/cpu/x86/gc/g1/g1BarrierSetAssembler_x86.cpp:261-374`：x86 post barrier

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
- 本篇聚焦 G1 的两道写屏障，不展开 SATB 并发标记原理（02 篇已讲）、RSet 精炼（03 篇已讲）
- 不展开 interpreter/chvm 的 barrier 插桩
- 不展开 C2 的 memory chain 分析的完整 C2 后端细节
- 下一篇若讲 Full GC + 根处理，应自然承接"屏障都失败时 G1 如何兜底"

## 8. 完成后 review

- 删除代码后，能否复述"两道屏障解决两个不同的问题，不能合并"
- 是否讲清 pre barrier 只在 SATB active + 旧值非 null 时入队
- 是否讲清 post barrier 先过滤 young card 再 dirty + enqueue
- 是否讲清三层不是独立实现，而是同一套屏障的三套代码生成
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验