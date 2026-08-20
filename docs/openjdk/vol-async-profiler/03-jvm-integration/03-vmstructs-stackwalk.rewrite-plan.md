# 03-vmstructs-stackwalk 重写规划

> 状态：deep review 完成，待修订同步
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“VMStructs + FP/DWARF/VM walker + CodeCache 说明文”重写成一篇围绕“采样只拿到 PC/SP/FP，为什么 async-profiler 还要运行时读取 JVM 内部地图，并在不同栈结构之间切换多种 walker，最后才能把地址恢复成逻辑 Java 帧”的机制文章

## 1. 读者困惑

- 采样拿到的明明只是地址和寄存器，为什么不能直接查符号表变成方法名？
- 为什么 VMStructs 不是启动期一次“扫描所有结构”就结束，而是 `initOffsets` + `ready` + `resolveOffsets` 这样的两段式准备？
- FP、DWARF、VM walker 为什么必须共存，不能只选一种最快的？
- CodeCache 到底是在做符号表、JIT 地址表，还是 walker 的辅助索引？
- `walkVM()` 为什么比 `walkFP()` / `walkDwarf()` 更像“逻辑帧恢复”而不是“物理 native frame 遍历”？
- safe fetch / thread bridge / CodeHeap 边界到底在解决什么失败风险？

## 2. 一句话顿悟

**async-profiler 先用 VMStructs 从当前 libjvm 拿到内部偏移与地址，再在具体栈上按结构选择 FP、DWARF 或 VM walker；CodeCache 提供地址身份和 JIT blob 边界，最终让“物理地址/寄存器状态”一步步恢复成 Java/JIT/native/inline 的逻辑帧。**

## 3. 总图

```text
ucontext / PC / SP / FP
  → 地址先判断：native lib / CodeHeap / JVM internal
    → VMStructs 提供内部偏移与桥接地址
      → walkFP / walkDwarf / walkVM 选路
        → CodeCache / CodeHeap 识别 JIT blob
          → method / scope / inline frame 恢复
            → 后续 frame naming
```

## 4. 版本与边界

- 当前实现以运行时 libjvm 暴露的 VMStructs 数据为准，不写死版本分支表。
- `VMStructs::ready()` 当前调用的是 `resolveOffsets()`、`patchSafeFetch()`、`initThreadBridge()`，不要写成“重新扫描全部 VMStructs 表”。
- `walkFP()` / `walkDwarf()` 更偏物理 native frame；`walkVM()` 则要理解 HotSpot/inline 逻辑帧。
- CodeCache 不等于 frame naming；它先解决“地址属于哪个 JIT blob/库区间”。
- walker 选择依赖事件、`CStack`、平台、CodeHeap 和当前地址，不是单一快慢排序。

## 5. 现稿方法论差距审计

- 开篇已提出地址到方法名缺三层信息，但整体仍偏“组件介绍”，缺少“为什么不能简单做符号查找”的失败方案厚度。
- `VMStructs::ready()` 容易被误读成再次全面扫描；需要更硬地写成“initOffsets 先收集静态符号，ready 阶段再 resolve/patch/bridge”。
- 三种 walker 被讲成“分别解决不同栈结构”，方向对，但还缺更清楚的“物理 frame vs 逻辑 Java frame”对比。
- `walkVM()` 缺少和 CodeHeap / VMThread / JavaFrameAnchor / crash protection 的具体桥接。
- CodeCache 章节还偏“add/find/search 数据结构”，没有完全纳入“地址先归属，再做 JIT/inline 恢复”的主线。
- safe fetch / patchSafeFetch / thread bridge / CodeHeap availability 这些失败防护边界没被收紧到主线里。

## 6. 重写策略

1. 用“采样拿到地址，却不能直接变成 Java 方法名”的事故场景开篇。
2. 推演并否定：只靠 native 符号表、只靠 FP、只靠 DWARF、只靠 VM walker。
3. 给出总图：地址归属 → VMStructs 地图 → walker 选路 → CodeCache/JIT blob → 逻辑帧恢复。
4. 分层讲：
   - VMStructs 两阶段准备（initOffsets vs ready）；
   - walkFP / walkDwarf 的物理栈边界；
   - walkVM 的 Java/JIT/inline 恢复；
   - CodeCache/CodeHeap 的地址身份角色；
   - safe fetch / thread bridge / crash protection 的失败防护。
5. 收网时明确：AP-4 frame naming 之前，AP-3 只解决“地址和寄存器怎样还原成帧身份”。

## 7. 结构大纲

### 第一节：事故开场——拿到的是地址，用户却要看到 Java 方法名

回答：为什么“采样地址 ≠ 可读帧名”，以及为什么单一符号查找必然不够。

预估字数：900-1100

### 第二节：先排除四个错误直觉——只靠 native 符号、只靠 FP、只靠 DWARF、只靠 VM walker

预估字数：1600-2000

### 第三节：第一层——VMStructs 不是版本号猜测，而是运行时地图协议

证据：`vmStructs.cpp:133-146`、`:148-339`、`:445+`、`:576+`、`:600+`。

回答：initOffsets 收集什么，ready 阶段再补什么，为什么要分两段。

预估字数：1900-2300

### 第四节：第二层——walkFP 与 walkDwarf 在恢复物理 native frame 上各自靠什么

证据：`stackWalker.cpp:73-212`。

回答：对齐、栈界、frame chain、FrameDesc/CFA、默认 frame、vDSO 等边界。

预估字数：1900-2300

### 第五节：第三层——walkVM 为什么能恢复 JIT/解释器/inline 的逻辑 Java 帧

证据：`stackWalker.cpp:214+`、`vmStructs.cpp` 相关 offsets。

回答：VMThread、JavaFrameAnchor、CodeHeap、inline scope、crash protection。

预估字数：2200-2600

### 第六节：第四层——CodeCache/CodeHeap 先解决地址身份，再谈名字

证据：`codeCache.cpp:32-154`、`profiler.cpp` 相关 `findLibraryByAddress` / `CodeHeap::updateBounds`。

回答：add/updateBounds/sort/binarySearch 的主线意义，不把它写成孤立容器章节。

预估字数：1500-1900

### 第七节：第五层——safe fetch / patchSafeFetch / thread bridge 为什么是必须的防护层

证据：`vmStructs.cpp:141-145`、`stackWalker.cpp` crash protection 片段。

回答：错误偏移、不可读地址、bridge 缺失时怎样避免 profiler 把自己走崩。

预估字数：1400-1800

### 第八节：收网——在 AP-4 命名之前，AP-3 先把地址恢复成帧身份

桥接 frame naming / symbol resolution。

预估字数：800-1000

## 8. 必须展开的失败方案

1. 采样地址直接查 native 符号表就够了。
2. 只要保留 frame pointer，所有栈都能走出来。
3. 有 DWARF 就不需要 VM walker。
4. 只靠 VM walker 就能解决全部 native frame。
5. CodeCache 只是附属索引，不影响帧恢复主线。

## 9. 证据清单

- `src/vmStructs.cpp:133-146`
- `src/vmStructs.cpp:148-339`
- `src/vmStructs.cpp:445-600+`
- `src/stackWalker.cpp:73-212`
- `src/stackWalker.cpp:214+`
- `src/codeCache.cpp:32-154`
- `src/profiler.cpp` 中 `findLibraryByAddress`、`CodeHeap::updateBounds`、walker 调用点

## 10. 完成后检查

1. 删除代码块后，读者仍能复述“地址归属 → walker 选路 → JIT/Java 逻辑帧恢复”。
2. 至少展开 4 个失败方案。
3. 不把 `VMStructs::ready()` 写成再次全面扫描。
4. 不把 FP/DWARF/VM walker 写成简单快慢排序。
5. 不把 CodeCache 写成孤立数据结构章节。
6. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
