# 16-code-cache/01-codeblob-heap 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 JIT 机器码为什么需要一套正式“住址系统”：`CodeBuffer` 临时生成、`CodeBlob` 正式身份、`CodeCache/CodeHeap` 分配与反查，以及 allocate/commit 两段式发布

## 1. 核心困惑

**为什么 JIT 机器码不能像普通对象一样“编完就 malloc 一块内存放进去”？为什么要先用 CodeBuffer，再包装成 CodeBlob，最后放进按类型切开的 CodeHeap，而且还要把 allocate 与 commit 分成两步？**

## 2. 一句话顿悟

**机器码的“家”不是一块普通内存，而是一套发布协议：编译阶段先在可丢弃、可扩容的 `CodeBuffer` 里搭工地；成品再包装成带布局与身份的 `CodeBlob`；最后放进只管理可执行代码的 `CodeHeap`。`CodeCache` 用 allocate/commit 两段式发布，保证半成品代码不会暴露给执行器、GC 和地址反查。**

## 3. 结构

1. 开场：机器码为什么也要有正规住址
2. 两个失败方案：边生成边写 CodeCache / 所有代码共住一个大堆
3. CodeBuffer：编译期临时工地
4. CodeBlob：正式布局与身份
5. CodeCache allocate/commit：两段式发布
6. CodeHeap：reserve/commit、segment 与 segmap
7. 分段 CodeCache：寿命与用途隔离
8. 收网

## 4. 证据清单

- `src/hotspot/share/asm/codeBuffer.hpp:331-353`
- `src/hotspot/share/asm/codeBuffer.hpp:434`
- `src/hotspot/share/code/codeBlob.hpp:36-71`
- `src/hotspot/share/code/codeBlob.hpp:103-117`
- `src/hotspot/share/code/codeCache.hpp:42-61`
- `src/hotspot/share/code/codeCache.cpp:475-588`
- `src/hotspot/share/memory/heap.cpp:285-493`
- `src/hotspot/share/memory/virtualspace.cpp:255,844`
- `src/hotspot/share/runtime/globals.hpp:89-92`
- `src/hotspot/cpu/x86/globals_x86.hpp:40,49`

## 5. 完成后 review

- 能否复述 CodeBuffer / CodeBlob / CodeHeap 三阶段分工
- 是否讲清 allocate/commit 的发布边界
- 是否讲清 segmap 为什么存在
- 是否完成禁用词、链接、`file:line`、删码、`git diff --check` 校验