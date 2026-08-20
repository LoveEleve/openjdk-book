# 26-g1-gc/07-full-gc-roots 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
> 目标：解释 G1 的 Full GC 为什么不是"把 Young/Mixed evacuation 放大到全堆"，而是一条独立的 mark-compact 路径；以及它的四阶段为什么必须顺序执行、根处理为什么和 Young GC 不同、为什么在内存很紧时还要保留串行兜底

## 1. 选题判断

现稿已有很强事实基础：
- `G1FullCollector::prepare_collection` / `collect` / `complete_collection`
- `phase1_mark_live_objects` 四阶段
- `G1FullGCMarkTask` 用 `G1RootProcessor`
- `phase2/3/4` 并行 + serial compaction 兜底
- `restore_marks` / `update_derived_pointers` / epilogue

但当前正文仍偏"prepare / collect / complete 一节 + 根一节 + 结束一节 + 辅助一节"的流程并列。真正该打穿的读者困惑更集中：

**G1 每天都在用 Young/Mixed GC 的 evacuation 处理暂停，那 Full GC 是不是就是把 CSet 放大成全堆、把 evacuation 再跑一遍？为什么 Full GC 要切成"标记→定目标→改引用→移动"四个阶段而不是直接复制？Full GC 的根扫描和 Young GC 的根扫描是不是同一套入口？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**Full GC 不是 evacuation 的全堆放大版，而是一条独立的 mark-compact 路径。evacuation 的优势是"有地方搬"——CSet 之外有堆空间可以复制活对象；Full GC 恰恰发生在没有可搬空间的绝境，只能原地把全堆压缩。这就决定了它不能边复制边走 forwarding pointer，必须先为所有活对象算好压缩目标（prepare），再统一把引用改成新地址（adjust），最后才移动对象（compact）——四阶段顺序不可调换。根处理也一样：它服务于全堆可达性标记，而不是服务 CSet，所以是并行地从全部强/弱根出发做 STW 标记。**

## 3. 总图

```text
触发 Full GC (分配失败/explicit/碎片/策略兜底)
  G1FullCollector
    prepare_collection
      ├─ abort_concurrent_cycle
      ├─ CodeCache::gc_prologue / BiasedLocking::preserve_marks
      └─ clear_and_activate_derived_pointers
    collect
      ├─ phase1 标记 (workgang 并行, 处理引用/弱根/unload)
      ├─ phase2 压缩计划 (G1FullGCPrepareTask, 无 freed region -> serial)
      ├─ phase3 改引用 (G1FullGCAdjustTask)
      └─ phase4 移动 (G1FullGCCompactTask, serial 兜底)
    complete_collection
      ├─ restore_marks / update_derived_pointers
      ├─ CodeCache/JVMTI epilogue
      └─ prepare_heap_for_mutators
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——Full GC 是不是 evacuation 放大到全堆

目标约 1100 字。

- 从"Young/Mixed 都靠 CSet evacuation"切入
- 点出 key 差异：evacuation 需要"有地方搬"，Full GC 恰恰发生在没地方搬的绝境
- 埋主线：Full GC 是独立的 mark-compact，四阶段顺序不可调换

### 第二节：两个朴素方案为什么都不对

目标约 1500 字。

必须推演：
1. Full GC = 把 CSet 放大到全堆、evacuation 再跑一遍（没有可搬空间，无从复制；且 RSet 只为 CSet 服务，覆盖不了全堆压缩）
2. Full GC 的标记 = 直接用并发标记的 SATB 逻辑（Full GC 是 STW，没有 mutator 并发改图，不需要 SATB 快照）

结论：
- 全堆压缩必须先定目标、再改引用、后移动，因为移动后引用必须一次改对
- Full GC 是 STW，没有并发改图，标记从根出发即可

### 第三节：骨架——prepare / collect / complete 三层生命周期

目标约 1800 字。

- `G1FullCollector` 成员（g1FullCollector.hpp:56-103）
- `prepare_collection`（g1FullCollector.cpp:140-165）
- `collect` 串起四个 phase（g1FullCollector.cpp:167-179）
- `complete_collection` 收尾（g1FullCollector.cpp:181-201）
- 说明：prepare 不是"标记前热身"，而是中止并发周期、预置引用处理/CodeCache/derived pointer

### 第四节：Phase 1 标记——不止 parallel scan，还带引用/弱根/unload

目标约 2200 字。

- `phase1_mark_live_objects`（g1FullCollector.cpp:203-234）
- `G1FullGCMarkTask::work`（g1FullGCMarkTask.cpp:44-69）
- 引用处理 / weak oops / class unloading 分支
- 说明：标记阶段决定存活判定、引用可达性和元数据状态

### 第五节：根处理——服务于全堆可达性，不是服务 CSet

目标约 2100 字。

- `G1FullGCMarkTask` 的 `G1RootProcessor`
- `process_strong_roots` vs `process_all_roots_no_string_table`（ClassUnloading 分支）
- root 家族（java/vm/jni/cld/code cache 等，g1RootProcessor.hpp:59-74 的 task 枚举）
- 与 Young GC 根处理对比：evacuate_roots 服务 CSet，Full GC 从全部根出发做可达性标记

### 第六节：prepare→adjust→compact——为什么必须先想好再动手

目标约 2200 字。

- 压缩目标：`G1FullGCCompactionPoint`（g1FullGCCompactionPoint.hpp:34-62）
- `phase2` 并行 prepare + 无 freed region 时 serial 兜底（g1FullCollector.cpp:236-245）
- `phase3` adjust 指针（:247-253）
- `phase4` compact + serial 兜底（:255-265）
- 收回"四阶段顺序不可调换"主线

### 第七节：误解澄清与收网

目标约 1300 字。

至少回答：
1. Full GC 是否 = CSet 放大到全堆的 evacuation
2. Full GC 标记是否复用 SATB 并发标记
3. 全堆压缩是否只是"搬完就结束"
4. 为什么正常情况下干净、但内存极紧时保留 serial 兜底
5. 根处理是否和 Young GC 是同一套入口

## 5. 失败方案必须写进正文

1. Full GC = 把 CSet 放大到全堆、再跑一遍 evacuation（没有可搬空间 + RSet 不覆盖全堆）
2. Full GC 直接用 SATB 并发标记逻辑（STW 无并发改图，不需要快照协议）
3. 全堆压缩可以"边搬边改引用"（引用必须一次改对，必须 prepare→adjust→compact 分步）

## 6. 证据清单

- `src/hotspot/share/gc/g1/g1FullCollector.hpp:56-103`：`G1FullCollector` 成员与 phase 方法
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:140-165`：`prepare_collection`
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:167-179`：`collect`
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:181-201`：`complete_collection`
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:203-234`：`phase1_mark_live_objects`
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:236-245`：`phase2_prepare_compaction` + serial 兜底
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:247-253`：`phase3_adjust_pointers`
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:255-265`：`phase4_do_compaction` + serial 兜底
- `src/hotspot/share/gc/g1/g1FullCollector.cpp:267-271`：`restore_marks`
- `src/hotspot/share/gc/g1/g1FullGCMarkTask.cpp:36-69`：MarkTask 的 root_processor 与 complete_marking
- `src/hotspot/share/gc/g1/g1RootProcessor.hpp:44-74`：root 任务枚举 + StrongRootsScope
- `src/hotspot/share/gc/g1/g1RootProcessor.hpp:79-119`：`process_strong_roots` / `process_all_roots` / `process_string_table_roots` / `evacuate_roots`
- `src/hotspot/share/gc/g1/g1FullGCCompactionPoint.hpp:34-62`：`G1FullGCCompactionPoint`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
- 本篇聚焦 Full GC 的 mark-compact 与根处理，不展开引用处理/弱根的完整算法（25-03 已讲）
- 不展开 String Dedup/Symbol table 内部细节（25-06 已讲共享层）
- 不展开 JVMTI/CodeCache epilogue 细节
- 下一篇若讲 JNI Handle 系统，应自然承接"根扫描里也有 JNI handles 这一族"

## 8. 完成后 review

- 删除代码后，能否复述"Full GC 不是 evacuation 放大版，是独立 mark-compact"
- 是否讲清四阶段顺序不可调换的原因（先定目标→改引用→再移动）
- 是否讲清 Full GC 是 STW、不走 SATB
- 是否讲清根处理服务全堆可达性，与服务 CSet 的 Young GC 根处理不同
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验