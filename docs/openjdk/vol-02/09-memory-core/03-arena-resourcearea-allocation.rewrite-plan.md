# 09-memory-core/03-arena-resourcearea-allocation 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 HotSpot 为什么不让 VM 的大部分临时对象走普通 malloc/free，而要用 Arena/ResourceArea 把生命周期结构化到作用域里

## 1. 选题判断

现稿已经覆盖了 Arena、Chunk、ResourceArea、AllocateHeap、GuardedMemory，但结构仍偏“分配器大全”：一个组件一节，读者容易记住类名，却不一定记住它们解决的是同一个生命周期问题。

真正的读者困惑：

**JVM 自己的 C++ 临时对象（编译期 IR、类解析临时结构、GC 扫描辅助对象）为什么不直接 `malloc/free`？Arena 解决的究竟是不是“更快的 malloc”，还是“免掉逐个 free 的生命周期管理”？`ResourceArea` 为什么说是 per-thread 的栈式 Arena，而不是一个完全不同的分配器？又为什么还有 `AllocateHeap` 和 `GuardedMemory` 这两条看起来完全不同的路？**

## 2. 一句话顿悟

**HotSpot 给 C++ 侧对象分配分成两大类：生命周期规则整齐、能按作用域整批回收的，进 Arena/ResourceArea；生命周期不规则或跨作用域的，进 `AllocateHeap`。Arena 的核心收益不是“单次 malloc 更快”，而是把释放从“每个对象自己 free”变成“退回到一个 mark 或销毁整条 chunk 链”。`GuardedMemory` 则是在调试/checked JNI 场景下，把普通分配再包上一层守卫。**

## 3. 总图

```text
VM C++ memory users
  │
  ├─ 短命、同作用域、可整批丢弃
  │    └─ Arena
  │         ├─ Chunk 链表
  │         ├─ bump-pointer allocation
  │         └─ ResourceArea / ResourceMark 做 per-thread 栈式回滚
  │
  ├─ 长命或生命周期不规则
  │    └─ AllocateHeap / ReallocateHeap / FreeHeap
  │         ├─ os::malloc/realloc/free
  │         ├─ AllocFailStrategy
  │         └─ NMT header + malloc-site indexes
  │
  └─ 调试/检查包裹层
       └─ GuardedMemory
            ├─ 16-byte head/tail guards (0xAB)
            ├─ user area zaps (0xF1 / 0xBA)
            └─ checked JNI wrap_copy/free_copy
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么 VM 自己不直接 `malloc/free`

目标约 1000 字。

- 从 parser / C2 / GC 里大量短命小对象开场
- 指出它们的共同点：量大、寿命短、通常和某个作用域同生共死
- 提出核心问题：为什么 HotSpot 想把释放从“逐个对象”变成“整批回滚”
- 回收上一章：VirtualSpace 解决的是地址空间层，这篇解决的是 VM C++ 对象层

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：

1. 所有临时对象都直接 `malloc/free` → 手工释放负担与同步/碎片成本过高
2. 用一个全局 Arena 给所有线程共享 → 无法表达 per-thread / per-scope 生命周期，争用严重
3. 让 `AllocateHeap` 承担所有场景，再靠调试工具查内存问题 → 无法把临时对象的释放结构化到作用域边界

引出：
- Arena = region allocator + chunk backstore
- ResourceArea = 每线程 Arena + mark-based scoped rollback
- AllocateHeap = 不规则寿命对象的 C-heap 路径

### 第三节：Arena——核心不是“更快”，而是“整批释放”

目标约 2000 字。

- `Arena` 的对象模型：chunk 链 + `_hwm/_max`
- `ResourceObj::operator new(size_t, Arena*)` 直走 `arena->Amalloc(size)`
- `Amalloc`：align -> overflow check -> pointer test + increment
- `Afree` 只是 LIFO 顶端优化，不是任意 free
- 真正释放在 `destruct_contents()` / `Chunk::chop()`
- 这说明 Arena 的真正语义是 lifetime region，而不是 free-list malloc 替代品

### 第四节：Chunk 与 ChunkPool——backing storage 为什么要四个规格

目标约 1700 字。

- `slack` 与“略小于 2^k”防 buddy allocator 特殊行为
- `tiny_size/init_size/medium_size/size/non_pool_size`
- 第一个 chunk 默认是 `init_size`，不是 32KB
- grow 时 `MAX2(request, Chunk::size)`，后续默认块 32K-slack，只是下限
- `Chunk::operator new/delete` 只把四种 canonical size 放回池，其他大小直接 `os::malloc/free`
- 四个静态共享 ChunkPool + cleaner 保留 5 块
- pooling 是 backing-store 复用优化，不是 Arena 的本体语义

### 第五节：ResourceArea——为什么它是 per-thread 的栈式 Arena，而不是另一种新分配器

目标约 2100 字（核心拆解层）。

- `ResourceArea : public Arena`
- 每个 `Thread` 一个 `_resource_area`
- `resource_allocate_bytes` 总是落到当前线程的 ResourceArea
- thread ctor 安装 ResourceArea
- compiler thread `bias_to(mtCompiler)` 只影响 NMT 归类，不改变分配语义
- ResourceArea 解决的是“作用域化临时分配”而非另一套底层 chunk 算法

### 第六节：ResourceMark——为什么“回滚 top 指针”只说对了一半

目标约 2200 字（核心拆解层）。

- `ResourceMark` 保存 `_chunk/_hwm/_max/_size_in_bytes`
- `reset_to_mark()` 先 `next_chop()` 砍掉后续 chunk，再恢复保存状态
- `ZapResourceArea` 填 0xAB 抓 use-after-reset
- `_nesting` 与 assert-only no-mark fatal
- 推荐的精确叙事：mark 是 arena checkpoint，不是 allocator owner
- 嵌套 mark 的 LIFO 语义
- 纠偏：不是“只把 `_top` 指回 `_saved_top`”

### 第七节：AllocateHeap——为什么 HotSpot 仍然需要普通 C-heap 路径

目标约 1600 字。

- `AllocateHeap/ReallocateHeap/FreeHeap` 是 `os::malloc/realloc/free` 包装
- `AllocFailStrategy::EXIT_OOM` vs `RETURN_NULL`
- 适用场景：长命、不规则寿命、跨作用域或无法整批回滚的对象
- 与 Arena 的界线：不是快慢之分，而是生命周期结构是否整齐
- `CHeapObj` / `NEW_C_HEAP_ARRAY` 这层包装关系

### 第八节：NMT header——为什么“调用栈嵌进每个分配块头”是错的

目标约 1500 字。

- `MallocHeader` 两个 machine words on LP64
- size/flags/position-index/bucket-index
- detail 级别把 site 索引写进 header，不是把 `NativeCallStack` 整个拷进去
- 真正调用栈保存在 `MallocSiteTable`
- fallback 到 summary mode 的时机
- 纠偏：header 存的是索引，不是 stack trace 本体

### 第九节：GuardedMemory——为什么它不是“调试玩具”，而是 checked JNI 的真实客户

目标约 1700 字。

- 16-byte head/tail guards，内容 0xAB
- user area 初始 0xF1，释放后 0xBA
- `verify_guards()` 只查 guard，不验证用户区模式
- `os::malloc` 在 ASSERT 下自动套 GuardedMemory
- checked JNI `wrap_copy` / `free_copy` / tag 的真实使用
- `CheckJNICalls` 控制 JNI 检查路径；不是纯编译期 debug 玩具
- 纠偏：0xAB 是 guard，0xF1/0xBA 是 user area zap，不是同一个 canary

### 第十节：误解澄清与收网

目标约 1100 字。

至少回答：

1. Arena 是否只是更快的 malloc
2. 第一个 chunk 是否总是 32KB
3. grow 是否永远分配 32KB chunk
4. `Afree` 是否可释放任意对象
5. `ResourceArea` 是否是全局共享 arena
6. `ResourceMark` 是否只是回滚 top 指针
7. `AllocateHeap` header 是否直接嵌调用栈
8. `GuardedMemory` 是否只在 debug 玩具代码里用

## 5. 失败方案必须写进正文

1. 所有临时对象都直接 `malloc/free`
2. 用一个全局 Arena 给所有线程共享
3. 让 `AllocateHeap` 承担所有场景

## 6. 证据清单

- `arena.hpp:37-70`：alignment / slack / chunk sizes
- `arena.cpp:41-146`：ChunkPool and cleaner
- `arena.cpp:182-228`：`Chunk::operator new/delete`
- `arena.hpp:117-159,202-210`：`Amalloc` / overflow / `Afree`
- `arena.cpp:249-272,353-383,221-239,313-323`：Arena constructors, grow, chop, destruct_contents
- `allocation.cpp:101`：`ResourceObj` placement new on Arena
- `resourceArea.hpp:31-71,84-149`：ResourceArea / ResourceMark semantics
- `resourceArea.inline.hpp:30-43`：allocation without mark assert/fatal
- `thread.hpp:505-506`、`thread.cpp:230,3446-3447`：per-thread ResourceArea / bias_to(mtCompiler)
- `allocation.cpp:39-70`：AllocateHeap/ReallocateHeap/FreeHeap
- `allocation.hpp:34-38,174-213,456-489`：AllocFailStrategy / CHeapObj / macros
- `mallocTracker.hpp:240-316,333-373`：MallocHeader layout / header size / get_base
- `mallocTracker.cpp:68-147`：record_malloc/free and stack-site indexing
- `mallocSiteTable.hpp:177-209`、`mallocSiteTable.cpp:142-204`：bucket/position indexing and shared site table
- `memTracker.hpp:86-91,157-163`：CALLER_PC and MemTracker hooks
- `guardedMemory.hpp:31-56,90-123,127-147,195-217,243-295`：guard layout and verify behavior
- `guardedMemory.cpp:31-81`：wrap_copy/free_copy/print_on
- `jniCheck.cpp:373-440,1460-1604`：checked JNI real users
- `os.cpp:700-820`：os::malloc/realloc/free with NMT and ASSERT guarded path
- `globals.hpp:259,913-914`：ChunkPool async cleaning and CheckJNICalls flag
- `runtime/init.cpp:47,95`、`thread.cpp:3953`：chunk pool initialization / cleaner scheduling

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- Arena 的核心价值是 lifetime discipline，不是单点 malloc 微优化
- ChunkPool 只缓存 canonical chunk sizes；不规则大小仍直接 malloc/free
- ResourceArea 是 Arena 的 per-thread/scoped protocol，不是完全不同的底层分配器
- ResourceMark 的 reset 包括 chunk chopping，不只是 top rollback
- `AllocateHeap` / `FreeHeap` 是长寿命或不规则寿命对象的 C-heap 包装
- GuardedMemory 的 ASSERT path 与 checked JNI 显式包裹路径都要讲，但不能混成“总是带 guard”
- NMT header 存索引而不是完整 stack trace

## 8. 完成后 review

- 删除代码后能否复述“整齐生命周期 -> Arena/ResourceArea；不规则生命周期 -> AllocateHeap；检查/调试包裹 -> GuardedMemory”
- 是否纠正了 first chunk、Afree、top rollback、完全 debug-only、stack trace in header 等常见误解
- 是否把 backing chunk 优化、作用域生命周期协议、NMT/guard 包裹三层真正分开
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
