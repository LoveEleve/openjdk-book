# PROMPT: 请撰写 01-CodeCache.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- §四 答案方向是"指引"——告诉你去源码里找什么。不能直接抄到文档里。
- **必须逐个读取 §三 列出的源文件**（至少读核心函数），基于自己的源码理解来写文档。
- 源码是证据（20%），你基于源码的分析洞察是正文（80%）。

## §〇 Production Scenario

```
$ java -XX:ReservedCodeCacheSize=48m MyApp
# 48MB CodeCache 在大型应用中很快满 → Emergency flushing → JIT 停止

$ jcmd <pid> Compiler.CodeHeap_Analytics aggregate
CodeHeap 'non-nmethods': size=5696Kb used=3072Kb max_used=3328Kb free=2624Kb
CodeHeap 'profiled nmethods': size=118400Kb used=116912Kb max_used=117440Kb free=1488Kb
CodeHeap 'non-profiled nmethods': size=118400Kb used=118208Kb max_used=118336Kb free=192Kb
```

CodeCache 三段堆的 NonProfiled heap 只剩 192KB！再过几个编译请求就满。此时 sweeper 紧急回收 zombie nmethod，但栈上还有活跃帧的 not_entrant 方法不能回收——编译器发 `handle_full_code_cache()` → 暂停新的编译 → 应用程序跌回解释执行 → 吞吐量骤降 10-100×。

**反事实**：如果 CodeCache 不分段（单堆），永久 stubs 卡在中间，nmethod 释放后的空洞无法被 bump-pointer 绕过 → 碎片化严重 → 明明总空闲够但连续空间不足 → CodeCache full 更早触发。三段设计使 NonNMethod 的永久对象在独立堆中（有序增长、无碎片），Profiled/NonProfiled 各自有 freelist + merge_right 合并相邻空闲块。

**三步诊断**：

```bash
# 1. 查看 CodeCache 使用量
jcmd <pid> Compiler.CodeHeap_Analytics aggregate

# 2. 查看 nmethod 状态分布
jcmd <pid> Compiler.CodeHeap_Analytics MethodTypes

# 3. GDB 验证 freelist 状态
gdb -ex "break CodeHeap::search_freelist" \
    -ex "break NMethodSweeper::sweep_code_cache" \
    -ex "run" \
    --args java -XX:ReservedCodeCacheSize=48m MyApp
```

## §一 Task + Narrative + Beginner Callouts

### Task

本文深度分析 HotSpot CodeCache 的三段堆内部设计：CodeHeap 的 freelist best-fit 分配、segment map 反向索引机制、nmethod 的 5 状态生命周期、sweeper 的清理策略。

### Narrative

CodeCache 不是一块连续内存——是 3 个独立管理的 CodeHeap，分别存储不同类型的代码，用完全不同的分配策略。NonNMethod 用 bump-pointer（永不释放），Profiled/NonProfiled 用 freelist best-fit（支持回收）。每个 CodeHeap 有一个 `_segmap[]` 字节数组——给定任意 PC 地址，O(log n) 跳转就能找到所属 CodeBlob。nmethod 走 5 态生命周期（not_installed→in_use→not_entrant→zombie→unloaded），最少 3 次 sweep 才能回收空间。

### Interview Story Format Answer

"CodeCache 用三个独立 CodeHeap 存储所有编译代码和运行时桩。NonNMethod (~5MB) 存 runtime stubs/adapter/IC buffer，用 bump-pointer 分配——这些永不释放，所以最简单最快。Profiled (~117MB) 存 C1 tier2/3 的 profiled nmethod，NonProfiled (~117MB) 存 C2 tier4 的优化代码和 C1 tier1。两个 nmethod heap 各自管理一个 freelist 单链表（按地址排序，best-fit 查找），释放时 `add_to_freelist` 插入并自动 `merge_right` 合并相邻空闲块。每个 heap 的 `_segmap[]` 字节数组是反向索引——给定任意 PC 地址，通过 segment map 的 hop 计数 O(log n) 找到所属 CodeBlob header。nmethod 走 5 态机：`commit()` 使其从 not_installed 变 in_use → 逆优化或依赖失效触发 `make_not_entrant()` patch 入口到 `handle_wrong_method_stub` → sweeper 确认栈上无活跃帧后 `make_zombie()` → 下次 sweep 调用 `flush()` → `CodeHeap::deallocate()` → freelist。flush 需要至少 3 次 sweep，所以 CodeCache 故障时先有 notify 信号（not_entrant）也有延迟（3 sweep 才释放空间）。CodeCache 满时 `CompileBroker::handle_full_code_cache` 停止新编译 + 紧急 flush，reverse_free_ratio 越大 flushing threshold 越激进。"

### Beginner Callout Boxes（≥7）

1. **HeapWord vs segment**: HeapWord = 8 bytes (堆分配粒度)。segment = 64 或 128 bytes (CodeHeap 管理粒度)。1 segment = 8 或 16 HeapWords。`_segmap[seg]` 的每个字节指向此 segment 所属 block 的 header。CodeCacheSegmentSize 默认 64 (product) / 128 (debug) bytes。

2. **bump-pointer vs freelist**: bump-pointer = 一个原子自增指针，分配就是 `ptr += size`，永不释放。freelist = 空闲块链表，分配要搜索合适的块（best-fit），释放要插回链表并合并相邻块。NonNMethod 用 bump-pointer（永久 stubs，无释放需求）。Profiled/NonProfiled 用 freelist（nmethod 会被 sweep 回收）。

3. **merge_right**: `add_to_freelist()` 插入空闲块后自动调用 `merge_right()`——检查 `following_block(a) == a->link()`，若相邻则合并两个 block 的 segment 计数，减少 `_freelist_length`。这是 CodeCache 唯一的碎片化缓解机制——没有 compaction，不移动已分配的代码。

4. **segmap reverse index**: `_segmap[]` 的每个字节对应一个 segment。值=0 表示此 segment 是 block header。值=N(1-255) 表示向前跳 N 个 segment 找到 header。值=0xFF 表示 hole/未分配区域。给定 PC 地址 `p`，`segmentFor(p)` 计算 `(p - low) >> log2_segment_size`，然后读取 `segmap[seg]` 多跳定位 header。

5. **nmethod state machine**: `not_installed(0)` → commit → `in_use(1)` → make_not_entrant → `not_entrant(2)` → sweeper 确认栈空 → `zombie(3)` → flush → CodeHeap deallocate。unloaded 是独立状态（类卸载直接标记，跳过 not_entrant）。

6. **reverse_free_ratio**: `max_capacity / unallocated_capacity`。10% 空闲 → ratio=10 → sweeper 被唤醒且 flushing threshold 更激进。25% 空闲 → ratio=4 → sweeper 较温和。用于自适应调整 sweeper 的紧迫程度。

7. **handle_wrong_method_stub**: 当 nmethod 变 not_entrant 时，入口地址被 patch 到 `SharedRuntime::handle_wrong_method_stub`。后续调用者跳转到此桩 → 检查调用点的 Method* → 若 Method 有新编译的 nmethod 就重定向，否则回解释器。这是去优化（deoptimization）的轻量级入口。

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/hotspot/share/code/codeCache.cpp:175-314` — initialize_heaps (3-segment calculate)
- `src/hotspot/share/code/codeCache.cpp:1141` — codeCache_init entry
- `src/hotspot/share/memory/heap.hpp:81` — class CodeHeap
- `src/hotspot/share/memory/heap.cpp:285-324` — CodeHeap::allocate
- `src/hotspot/share/memory/heap.cpp:617-669` — deallocate → add_to_freelist
- `src/hotspot/share/memory/heap.cpp:675-742` — search_freelist (best-fit)
- `src/hotspot/share/memory/heap.cpp:592-614` — merge_right
- `src/hotspot/share/code/nmethod.cpp:404-430` — nmethod::init_defaults (states)
- `src/hotspot/share/code/nmethod.cpp:1161-1313` — make_not_entrant_or_zombie
- `src/hotspot/share/code/nmethod.cpp:1315-1355` — nmethod::flush
- `src/hotspot/share/code/sweeper.cpp:429+` — NMethodSweeper::sweep_code_cache
- `src/hotspot/share/code/sweeper.cpp:694-774` — possibly_flush
- `src/hotspot/share/code/codeBlob.hpp:38-47` — CodeBlobType enum
- `src/hotspot/share/code/codeCache.hpp:78` — class CodeCache

Build: `make jdk`
Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so`
Key flags: ReservedCodeCacheSize (240M), InitialCodeCacheSize (160K), CodeCacheSegmentSize (64), CodeCacheExpansionSize

## §三 Source Files Table

| # | File | Role |
|---|------|------|
| 1 | `codeCache.cpp` | codeCache_init + initialize_heaps (3段创建) |
| 2 | `codeCache.hpp` | CodeCache 类声明 + _heaps/_compiled_heaps/_nmethod_heaps |
| 3 | `heap.hpp` | CodeHeap 类声明 (_segmap + _freelist + _next_segment) |
| 4 | `heap.cpp` | allocate/deallocate/search_freelist/merge_right |
| 5 | `nmethod.cpp` | nmethod 5 状态生命周期 + make_not_entrant_or_zombie + flush |
| 6 | `nmethod.hpp` | nmethod 类声明 (_state + _hotness_counter 等) |
| 7 | `sweeper.cpp` | NMethodSweeper::sweep_code_cache + possibly_flush |
| 8 | `sweeper.hpp` | NMethodSweeper 类声明 + traversal count |
| 9 | `codeBlob.hpp` | CodeBlobType 枚举 (MethodNonProfiled=0, MethodProfiled=1, NonNMethod=2) |

## §四 Deep Dive Question Groups（≥6）

### 4.1 ★★★ 三段堆大小计算

问：`initialize_heaps()` 如何计算 NonNMethod/Profiled/NonProfiled 各段大小？当用户设置了 `-XX:ReservedCodeCacheSize=240m` 但其中一个 heap 的 `-XX:NonNMethodCodeHeapSize` 被单独设置时如何处理？

答案方向：`codeCache.cpp:175-314` 分三种情况：
1. 所有 heap 都未 set → NonNMethod = compiler_buffer_size + 额外，剩余 = (cache_size - nmethod_size) / 2 分给 Profiled 和 NonProfiled
2. 部分 set → 用总 cache_size 减去已 set 的，剩余按比例分配给未 set 的
3. `check_heap_sizes` (`codeCache.cpp:156-173`) 验证三段之和 ≤ ReservedCodeCacheSize

追问：为什么 NonNMethod 的 compiler buffer 要预留 C1/C2 的 `code_buffer_size()` × 线程数？
→ C1 的 buffer = `Compiler::code_buffer_size()` → 每个 CompilerThread 需要这个 buffer 来生成代码后写入 CodeCache。如果不预留，C1 线程生成代码时可能 CodeCache full → 部分生成的代码无法写入 → fatal error。

反事实：如果不分段，CompileBroker 如何知道应该从哪个 heap 分配？
→ `CodeCache::allocate(size, CodeCache::get_code_blob_type(comp_level))`，`get_code_blob_type` 根据 compilation level 决定 heap: CompLevel_none/simple/full_optimization → MethodNonProfiled, CompLevel_limited_profile/full_profile → MethodProfiled。分段使同一 level 的代码在同一个 heap，减少碎片。

### 4.2 ★★★ freelist best-fit 分配

问：`search_freelist()` 的单链表遍历如何选空闲块？什么条件下触发 `split_block()`？

答案方向：`heap.cpp:675-742` 遍历单链表：
- 找 `cur_length == length` → 完美匹配，立即使用
- 找 `cur_length > length && cur_length < found_length` → 最接近的匹配（best-fit）
- 剩余空间 ≥ `CodeCacheMinBlockLength` → `split_block()` 切开，剩余留在 freelist
- < CodeCacheMinBlockLength → 整块取出

追问：为什么用 best-fit 而非 first-fit？
→ best-fit 最小化碎片：把刚好够的块分出去，剩余的大块留给后续大请求。first-fit 遇到第一个够大的就分配 → 可能浪费大的连续块 → 后续大请求失败。

反事实：如果不用 freelist 而用 alloc-only（像 NonNMethod 的 bump-pointer）？
→ nmethod 会被 flush 释放 → bump-pointer 无法重用释放的空间 → 空间永远不回收 → CodeCache 迅速满。

### 4.3 ★★★ segmap 反向索引

问：给定 PC 地址 0x7f1234abcd，CodeHeap::find_blob_unsafe() 如何找到对应的 CodeBlob？

答案方向：
1. `segmentFor(p)` → `(p - low) >> log2_segment_size`
2. 读 `segmap[seg]`：
   - 若 0xFF → 返回 NULL（未分配/hole）
   - 若 >0 → 向前跳: `seg -= segmap[seg]`，重复
   - 若 ==0 → 找到 block header
3. 检查 `block->free()` → 若是 free 返回 NULL → 否则返回 `block->allocated_space()`（CodeBlob*）

追问：segmap 的 hop 计数如何维护？什么时候更新？
→ `mark_segmap_as_used()` 在分配时标记 header 为 0，后续 segment 写递增的 hop。释放时 `invalidate()` 写 0。`defrag_segmap()` 逻辑整理 hop 计数但不移动实际数据。

反事实：如果不用 segmap 而用红黑树映射 PC→CodeBlob？
→ 红黑树每次分配/释放 O(log n) 插入删除 → 比当前 O(log n) 查找 + O(1) 更新慢。segmap 的优势是写入 O(1)（写一个字节），查找 O(log n)（hop 跳转），在频繁分配/释放的 CodeCache 中更高效。

### 4.4 ★★★ nmethod 5 态生命周期

问：nmethod 从 `commit()` 到最终 `flush()` 释放空间，经历了哪些状态转换？每一步的触发条件是什么？

答案方向：
- `not_installed(0)`: 构造函数 `init_defaults()` 设置 (`nmethod.cpp:405`)。nmethod 对象已分配但尚未在 CodeCache 中提交。
- `commit()` → in_use(1): CodeCache 注册完成，可被调用。与 Method 建立双向链接。
- `make_not_entrant()` → not_entrant(2): `NativeJump::patch_verified_entry()` 将入口 patch 到 `handle_wrong_method_stub`。不可被新调用，但栈上可能还有活跃帧。
- sweeper 确认栈空 → zombie(3): `nmethod.cpp:1161-1313` 中 `make_not_entrant_or_zombie()` 设置。完全不可访问。
- `flush()` → 释放: `CodeCache::free(this)` → `CodeHeap::deallocate()` → freelist。
- `unloaded`: 类卸载时 GC 直接标记，跳过 not_entrant。

追问：为什么需要 not_entrant 状态，不能直接 zombie？
→ 栈上可能还有活跃帧在执行该方法——如果直接 zombie+flush，活跃帧返回时没有有效的代码 → 崩溃。not_entrant 是个"发送信号"的过程（入口 patch），等 sweeper 确认栈空后才安全转 zombie。

反事实：如果 nmethod 没有状态机而用简单的 alloc/free？
→ 无法区分"正在被调用"和"可以安全释放" → 释放正在执行的代码 → 返回地址指向已回收内存 → 执行垃圾 → SIGILL 或其他未定义行为。

### 4.5 ★★★ sweeper 清理策略

问：sweeper 的两步清理（mark_active + sweep）如何保证安全回收？为什么最少 3 次 sweep 才能释放空间？

答案方向：
- Step 1 `mark_active_nmethods()`: 在 safepoint 执行，遍历所有线程栈，找到栈上的 not_entrant nmethod → `mark_as_seen_on_stack()` 记录 traversal mark。
- Step 2 `sweep_code_cache()`: 非 safepoint，遍历所有 nmethod: zombie → flush；not_entrant → 检查 `stack_traversal_mark()+1 < traversal_count()` 确认至少等了两轮 → `make_zombie()`。
- 最少 3 次 sweep 才能释放: sweep1 标记 not_entrant → sweep2 转 zombie → sweep3 flush。

追问：`possibly_flush()` 如何决定是否将 in_use 的 nmethod 转为 not_entrant？
→ `sweeper.cpp:694-774` 基于热度计数器: `nm->dec_hotness_counter()` 每次 sweep 减 1。threshold = `-reset_val + reverse_free_ratio * NmethodSweepActivity`。CodeCache 越满 → `reverse_free_ratio` 越大 → threshold 越大 → 更容易触发 flush。`MethodCounters::nmethod_age()` 评估: hot → 更多时间, warm → 重置, cold → 确认可 flush。

反事实：如果 sweeper 在 safepoint 中进行而非异步？
→ 每次 sweep 触发 safepoint → STW → 延迟增加 → 吞吐量下降。异步 sweep 保证 GC 不受 sweep 延迟影响。

### 4.6 ★★★ CodeCache 扩容与 Full 处理

问：CodeCache 能否动态扩容？满了会发生什么？

答案方向：`CodeCache::allocate()` 失败后 → `heap->expand_by(CodeCacheExpansionSize)` 从 reserved 空间 commit 更多物理页 → retry 分配。每次扩展 `CodeCacheExpansionSize`（默认对齐到 page_size）。扩容仅限 reserved 虚拟空间之内——物理内存不足时无法扩展。NonNMethod 扩展失败时尝试 fallback 到 method heaps。

`CodeCache::allocate()` 彻底失败后: `CompileBroker::handle_full_code_cache()` → 停止新编译 → 紧急 flush → 记录 full_count。完全 full 时所有新方法跌回解释执行。

追问：为什么 NonNMethod 不能也动态扩容？
→ 可以。`expand_by(CodeCacheExpansionSize)` 对所有 CodeHeap 都有效。但 NonNMethod 的 virtual reserve 小（~5MB），扩容上限受限。

### 4.7 ★★★ scavenge_root_nmethods

问：`_scavenge_root_nmethods` 列表的用途是什么？GC 为什么需要它？

答案方向：nmethod 可能包含 embedded oop（嵌入的对象指针），如静态字段引用、Class 引用、String 常量等。这些 oop 是 GC root——GC 需要扫描它们来判断对象是否 alive。`_scavenge_root_nmethods` 是这些 nmethod 的单链表，GC 遍历此列表而**不需要扫描整个 CodeCache**。

追问：nmethod 何时被加入/移出此列表？
→ `register_scavenge_root_nmethod()` 在 nmethod 包含 scavengable oop 时条件性添加。`drop_scavenge_root_nmethod()` 在 nmethod flush 或 oop 被替换时移出。每个 nmethod 通过 `_scavenge_root_link` 成员形成链表。

## §五 Article Structure

```
§〇 生产场景 — CodeCache Full → Emergency flushing
§一 ★★★ CodeCache 三段堆全链路源码走读
  1.1 initialize_heaps — 3段大小计算 + 内存布局 (高地址: NonProfiled, 低地址: NonNMethod)
  1.2 NonNMethod 段 — bump-pointer 分配 (never freed)
  1.3 Profiled/NonProfiled 段 — freelist best-fit + merge_right
  1.4 ★ Mermaid: 三段堆内存布局图
  1.5 segmap 反向索引 — O(log n) PC→CodeBlob 查找
  1.6 nmethod 5 态生命周期 — 状态机 + 每个状态对应的入口 patch 操作
  1.7 sweeper 两步清理 — mark_active (safepoint) + sweep_code_cache (async)
  1.8 possibly_flush — 热度计数器 + reverse_free_ratio + UseCodeAging
  1.9 CodeCache 扩容 + Full 处理 — expand_by + handle_full_code_cache
  1.10 scavenge_root_nmethods — GC root nmethod 单链表
  1.11 ★ 面试 Story Format 答案

§二 ★★★ 7 Beginner Callout 框 (在 §一 内 inline)

§三 ★★ 异常路径分析
  3.1 CodeCache allocation 失败 → expand_by → 扩容失败 → handle_full_code_cache
  3.2 nmethod flush 失败 → zombie 积累 → space pressure → sweeper 加快频率
  3.3 CodeCache lock 竞争 → CodeCache_lock (special rank, safepoint_check_never)

§四 ★ GDB 断点验证 — 8 断点
  断言 1: codeCache_init → verify 3 CodeHeaps
  断言 2: CodeHeap::allocate → freelist search
  断言 3: segmap → 验证给定 PC 地址的反向索引
  断言 4: nmethod::commit → state 从 not_installed → in_use
  断言 5: make_not_entrant → verify entry patch to handle_wrong_method_stub
  断言 6: NMethodSweeper::sweep_code_cache → zombie → flush
  断言 7: CodeCache::expand_by → committed 增加
  断言 8: possibly_flush → hotness_counter vs threshold

§五 ★ Cross-Reference
  → 00-JNI-CreateJavaVM (codeCache_init 在 init_globals 第5步调用)
  → 02-G1-Heap-Startup (同样在 init_globals 中初始化)
  → 09-Interpreter-Init (解释器 Codelet 分配在 CodeCache 中)
```

## §六 Writing Requirements

### 不要写成 → 应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| "CodeCache 有三个段" | "initialize_heaps() 通过 check_heap_sizes() 验证三段 sum ≤ ReservedCodeCacheSize，按 NonNMethod(compiler_buffer + 额外) → Profiled/NonProfiled(剩余/2) 计算，各段通过单独的 VirtualSpace reserve" |
| "freelist 管理空闲块" | "search_freelist() 遍历单链表做 best-fit：cur_length==length → 完美匹配立即使用；cur_length>length 选最接近的；剩余 ≥ CodeCacheMinBlockLength → split_block() 切开" |
| "segmap 用于查找" | "segmentFor(p) = (p-low) >> log2_segment_size → segmap[seg] 读 1 字节：0=header, N=hop N 步, 0xFF=hole → O(log n) 找到 CodeBlob*" |
| "nmethod 有多个状态" | "init_defaults() 设 not_installed → commit() → in_use → make_not_entrant() patch verified_entry 到 handle_wrong_method_stub → sweeper 确认栈空 → zombie → flush → CodeHeap::deallocate → freelist" |
| "sweeper 清理 CodeCache" | "mark_active_nmethods() 在 safepoint 遍历栈记录 traversal mark → sweep_code_cache() 异步检查 stack_traversal_mark+1 < traversal_count → make_zombie → 下次 sweep flush" |

## §七 Output Format

路径: `/data/workspace/openjdk-cut-new/probe_md/01-jvm-startup/docs/01-CodeCache.md`
元信息头: Phase 01-jvm-startup, 前置 00-JNI-CreateJavaVM, 配套 02~07 (同组数据结构), 后续依赖 09-Interpreter-Init + 12-CompileBroker

## §八 Prohibited（≥8）

- ❌ 只画三段布局而不解释每段的分配策略不同 → 必须对比 bump-pointer vs freelist 的代码实现
- ❌ 不解释 segmap 的 hop 计数机制 → 必须展示 segmentFor()+segmap[] 查找的完整代码路径
- ❌ 不画 nmethod 状态机 → 必须有完整的 5 态转换图 + 每个状态对应的入口 patch 操作
- ❌ 不说 sweeper 的两步机制 → 必须解释 mark_active (safepoint) + sweep_code_cache (async) 的时序
- ❌ 不解释 merge_right 的合并逻辑 → 必须展示 add_to_freelist 后如何检测并合并相邻空闲块
- ❌ 忽略 CodeCache lock → 必须说明 CodeCache_lock 的 special rank 和 safepoint_check_never
- ❌ 不解释 scavenge_root_nmethods → 必须展示 GC 如何遍历此列表而非整个 CodeCache
- ❌ 不做 GDB 验证 → 至少 8 个断点

## §九 Required（≥8）

- ✅ ★ CodeHeap 三段布局图（ASCII art 或 Mermaid）
- ✅ ★ freelist best-fit 搜索代码（search_freelist 核心循环）
- ✅ ★ segmap 反向索引查找代码（segmentFor + while segmap[seg] > 0）
- ✅ ★ nmethod 5 状态机图（Mermaid state diagram）
- ✅ ★ merge_right 合并逻辑代码
- ✅ ★ sweeper 两步时序 + 至少 3 次 sweep 回收的时序图
- ✅ ★ possibly_flush 热度计数器阈值计算公式
- ✅ ★ 面试 Story Format 答案
- ✅ ★ GDB 断点 ≥8 条

## §十 GDB Verification（≥7）

```
断言 1: codeCache_init (codeCache.cpp:1141)
  print CodeCache::_heaps->length() → 3
  print CodeCache::max_capacity() → ~240MB

断言 2: CodeHeap::allocate (heap.cpp:285) freelist path
  print _freelist → 非 NULL
  print _next_segment → bump-pointer 位置

断言 3: segmap lookup (heap.cpp find_start)
  print segmap[seg] → hop count

断言 4: nmethod commit (nmethod.cpp)
  print nm->_state → 0→1

断言 5: make_not_entrant (nmethod.cpp:1161)
  print verified_entry → patched to handle_wrong_method_stub

断言 6: sweeper sweep (sweeper.cpp:429)
  print nm->state() → zombie → flush

断言 7: expand_by (codeCache.cpp)
  print committed → 扩容前后对比

断言 8: possibly_flush (sweeper.cpp:694)
  print nm->hotness_counter → < threshold → make_not_entrant
```

## §十一 Continuity

- 00-JNI-CreateJavaVM 的 init_globals step 5 调用 `codeCache_init()` → 本文展开其内部
- 与 02-G1-Heap-Startup (init_globals step 9 universe_init 子步骤) 并列，同属内存基础设施
- 后续依赖：09-Interpreter-Init (解释器 Codelet 分配在 CodeCache)、12-CompileBroker-Init (编译任务提交到 CodeCache)
