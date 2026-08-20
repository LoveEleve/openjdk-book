# 16-code-cache/03-nmethod-lifecycle 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 nmethod 为什么不能“判死就删”，以及 HotSpot 如何用 safepoint 标记、增量 sweeper、状态机、热度计数和 GC 交接把一段代码从可执行送到回收

## 1. 选题判断

现稿已经覆盖了大量事实：
- 四种死亡入口
- `NMethodSweeper` 的 mark/sweep 两阶段
- hotness counter
- `can_convert_to_zombie`
- CodeCache 满时的应急链
- GC 与 unloading 的若干交接点

但当前正文还是偏“机制清单”。真正该打穿的读者困惑应该更集中：

**为什么一段编译代码明明已经被证明过时了，HotSpot 却不能立刻把它从 CodeCache 里删掉？谁负责判死、谁负责确认栈上没人、谁负责真正收尸？为什么整个过程还要跨 safepoint、跨多轮 sweeps，甚至可能先停编译再等清扫成功？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**nmethod 的死亡不是一个瞬间事件，而是一段并发退出协议：deopt、依赖失效、分层替换和 sweeper 都只能先宣布“以后别再进来”；真正回收还要等 safepoint 栈扫描证明没有活帧、sweeper 在非 safepoint 里清掉入口和 IC 残留、GC 或清扫逻辑完成注销，最后才把空间还给 CodeHeap。HotSpot 把“判死”“验尸”“收尸”拆开，是因为代码一旦在别人栈上执行，就不能像普通对象那样当场搬走或释放。**

## 3. 总图

```text
死亡入口
  ├─ tiered replacement
  ├─ uncommon trap / deoptimization
  ├─ dependency invalidation
  └─ sweeper hotness eviction
        ↓ 统一先变 not_entrant

等待退出
  safepoint 末尾 mark_active_nmethods
    └─ 记录哪些 not_entrant 方法仍在栈上

增量清扫
  sweeper thread / sweep_code_cache
    ├─ alive        -> 视热度决定是否 make_not_entrant
    ├─ not_entrant  -> 满足 epoch 条件后 make_zombie
    └─ zombie       -> flush 回收空间

GC / unloading 交接
  ├─ young GC: scavenge root nmethods
  ├─ full/unloading: do_unloading_oops
  └─ unloaded / zombie -> flush -> CodeHeap freelist
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么过时代码不能当场删

目标约 1200 字。

- 从“代码已经错了，为什么不立刻 free”切入
- 点出栈上活帧、inline cache、GC 引用、并发遍历这几层约束
- 埋主线：这是退出协议，不是简单状态翻转

### 第二节：两个朴素方案为什么都不行

目标约 1800 字。

必须推演：
1. 代码一被判错就立刻从 CodeCache 删掉
2. 只改状态位，不做栈扫描和入口补丁，等大家自己绕开

结论：
- 代码可能还在栈上执行
- 新调用与旧栈帧必须分开处理
- 回收需要 safepoint 读阶段与 sweeper 写阶段配合

### 第三节：谁在判死——四种死亡入口其实都只做第一步

目标约 2200 字。

- sweeper.hpp 注释里的四种 not-entrant 来源
- tiered replacement 只简述回钩上一章
- uncommon trap 的 action 分流：不是所有 trap 都判死
- dependency invalidation 的反向索引查找，不是全量扫 CodeCache
- 收回主线：这些入口都只能先宣布“别再进来了”

### 第四节：为什么必须分成 mark 与 sweep 两阶段

目标约 2200 字。

- `mark_active_nmethods()` 在 safepoint，`sweep_code_cache()` 不在 safepoint
- `prepare_mark_active_nmethods()` 如何推进 traversal
- `MarkActivationClosure` 重置 hotness 并标记 not_entrant 活帧
- `can_convert_to_zombie` 的 epoch 判据
- 解释“至少 3 sweeps”为什么不是实现细节而是安全边界

### 第五节：sweeper 怎么在普通时间里增量收尸

目标约 2100 字。

- sweeper 线程睡眠 / notify / possibly_sweep
- 非 safepoint 扫描但随时给 safepoint 让路
- `process_compiled_method` 的 alive/not_entrant/zombie/unloaded 分流
- OSR 方法的特殊 flush 路径
- 强调 sweeper 既是清扫者，也是部分死刑执行入口

### 第六节：热度计数器——为什么“冷了”才会被牺牲

目标约 1900 字。

- hotness 不是调用次数，而是“距上次在栈上被看到多久”
- reset 值与 ReservedCodeCacheSize 关系
- threshold 与 reverse_free_ratio 的关系
- `MinPassesBeforeFlush` 作为冷静期
- 为什么空间越紧越激进，但仍然不能立刻删

### 第七节：GC 与 CodeCache 的交接——谁负责看代码里的活引用

目标约 2200 字。

- young GC 只看 scavenge root nmethods
- full/unloading 走 `do_unloading_oops`
- `make_unloaded` 与 sweeper 后续收尸的关系
- G1 并行卸载只点关键边界，不深挖 collector 实现
- 说明 GC 与 sweeper 分工：GC 宣布“你和活对象断了”，sweeper 回收壳体

### 第八节：CodeCache 满了怎么办——为什么先停编译，再等真的腾出字节

目标约 1600 字。

- notify 门槛、强制 stack scanning
- `handle_full_code_cache` 先停新编译、保留解释器
- `freed_memory > 0` 才恢复编译
- 碎片化为什么让“看起来有空闲”不等于“真的可恢复”

### 第九节：误解澄清与收网

目标约 1300 字。

至少回答：
1. not_entrant 是否等于可以回收
2. sweeper 是否就是一个“定时删代码”的后台线程
3. hotness 是否等于调用计数
4. GC 是否直接 free nmethod
5. code cache 满是否等于 JVM 不能运行

## 5. 失败方案必须写进正文

1. 一判死就立刻 free 掉 nmethod
2. 只改状态位，不做入口补丁与栈扫描
3. 仅按空闲比例恢复编译，不看是否真的回收过字节

## 6. 证据清单

- `share/runtime/sweeper.hpp:35`：mark/sweep 两阶段总注释
- `share/runtime/sweeper.hpp:49`：四种 not-entrant 来源
- `share/runtime/sweeper.hpp:57`：至少 3 sweeps
- `share/runtime/sweeper.cpp:163`：`MarkActivationClosure`
- `share/runtime/sweeper.cpp:188`：`hotness_counter_reset_val`
- `share/runtime/sweeper.cpp:203`：`mark_active_nmethods`
- `share/runtime/sweeper.cpp:210`：`prepare_mark_active_nmethods`
- `share/runtime/sweeper.cpp:256`：`do_stack_scanning`
- `share/runtime/sweeper.cpp:283`：notify 门槛
- `share/runtime/sweeper.cpp:327`：possibly_sweep 三个触发条件
- `share/runtime/sweeper.cpp:373`：强制 stack scanning 只看 non-profiled heap
- `share/runtime/sweeper.cpp:429`：`sweep_code_cache`
- `share/runtime/sweeper.cpp:543`：`freed_memory > 0` 才恢复编译
- `share/runtime/sweeper.cpp:558`：`report_state_change`
- `share/runtime/sweeper.cpp:595`：`process_compiled_method`
- `share/runtime/sweeper.cpp:689`：`possibly_flush`
- `share/code/nmethod.cpp:989`：`mark_as_seen_on_stack`
- `share/code/nmethod.cpp:999`：`can_convert_to_zombie`
- `share/code/nmethod.cpp:1020`：`make_unloaded`
- `share/code/nmethod.cpp:1496`：`do_unloading_oops`
- `share/runtime/safepoint.cpp:613`：safepoint 收尾的 nmethod 标记闭包
- `share/runtime/deoptimization.cpp:1794`：uncommon trap action 分流
- `share/classfile/systemDictionary.cpp:1817`：类层次变化后 `flush_dependents_on`
- `share/code/codeCache.cpp:730`：`scavenge_root_nmethods_do`
- `share/code/codeCache.cpp:772`：`register_scavenge_root_nmethod`
- `share/code/codeCache.cpp:1148`：`mark_for_deoptimization(KlassDepChange&)`
- `share/code/codeCache.cpp:1259`：`make_marked_nmethods_not_entrant`
- `share/code/dependencyContext.cpp:62`：反向依赖表逐个标记
- `share/compiler/compileBroker.cpp:2292`：`handle_full_code_cache`
- `share/gc/g1/g1CollectedHeap.cpp:3414`：G1 并行清理入口

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦“生命周期协议”，不展开 relocation 细节与 IC 清理细节，下一篇再讲
- GC 交接只讲 nmethod 这一侧的责任，不展开各种 GC 算法内部流程
- tiered replacement 与 dependency 种类只点必要事实，不把策略分析扩成编译策略专题
- 具体统计日志与命令只作为证据，不抢正文主线

## 8. 完成后 review

- 删除代码后，能否复述“nmethod 的死亡是并发退出协议，不是瞬间事件”
- 是否清楚区分判死、栈扫描、zombie、flush 这几步
- 是否明确解释了为什么至少要跨多轮 sweep
- 是否把 sweeper、GC、CompileBroker 三者的职责边界讲清楚
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
