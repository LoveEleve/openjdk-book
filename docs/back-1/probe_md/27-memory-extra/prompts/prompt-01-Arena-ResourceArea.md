# prompt-01: Arena & ResourceArea — libjvm.so 快速路径分配器

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

**场景 1: NMT 报告 "mtThread" 内存在 Safepoint 后暴涨 200MB**

线上 `-XX:NativeMemoryTracking=detail` 报告 `mtThread` 类别在 3 分钟内从 50MB 涨到 250MB，但 Java heap 使用正常。GDB 断点打进去发现 Safepoint VM_Operation 中某处 `ResourceMark` 被过早析构，导致 chunk 链表被截断——但这只是假象，真正的答案是 ResourceMark `reset_to_mark()` 只在 `~ResourceMark()` 时触发，如果 `ResourceMark` 作用域被异常绕过（C++ `longjmp` 通过 `PreserveExceptionMark`），chunk 会无限堆积。

诊断：`jcmd <pid> VM.native_memory summary | grep Thread` → `strace -e trace=mmap,mprotect -p <pid>` → GDB `p _resource_area->_size_in_bytes` → 发现 `ChunkPool::clean()` 未被调用，由于 `ChunkPoolCleaner` 的 `CleaningInterval = 5000ms` 周期性任务正常但只保留 5 个 chunk。

**场景 2: Amalloc 返回的指针在 Debug 构建中被 memset 覆盖**

`-XX:+ZapResourceArea` 下，`Afree(old, size)` 中 `memset(ptr, badResourceValue, size)` → 后续 `ResourceMark::reset_to_mark()` 再次 `memset(_hwm, badResourceValue, _max - _hwm)` → 如果代码还持有旧指针，读取到 `0xBAADBAAD` 即 `badResourceValue`。

**场景 3: Arena::grow() 的 OOM 导致 chunk 链表断裂**

`Arena::grow(x, RETURN_NULL)` 中 `_chunk = new (RETURN_NULL, len) Chunk(len)` 失败返回 NULL，`_chunk` 恢复为旧值 `k`。但如果调用者没有检查 `Amalloc(x, RETURN_NULL)` 的返回值，后续 `_hwm += x` 会使用 `_chunk->bottom()` 的内容——此时 `_chunk == k` 仍然是已满的旧 chunk，导致 overflow。

---

## §一 Task + Narrative + Beginner Callouts

### Task
写文档 `01-Arena-ResourceArea.md`，深度分析 HotSpot 的 Arena 分配器家族：Arena（通用 chunk 链表分配器）、ResourceArea（thread-local + ResourceMark 回滚）、分配器选择树（ARENA_OBJ / C_HEAP_OBJ / RESOURCE_AREA / Metaspace）。

### Narrative
**从一次 Safepoint 操作开始**：VM_Operation::doit() 创建 ResourceMark → 调用 NEW_RESOURCE_ARRAY(int, 64) → Amalloc(256) → _hwm += 256 → ~ResourceMark() → _hwm 回到 mark。揭开 Arena/ResourceArea 作为 JVM 临时分配引擎的全貌。

### Beginner Callouts（7 个，内嵌于 §一）

1. `> **Beginner Callout 1: Arena 不是 malloc 的替代品** — Arena 分配内存不需要逐个 `free()`，在 `~ResourceMark()` 时整个 chunk 链表被释放。适合生命周期短的临时数据结构，不适合长期持有的对象。`

2. `> **Beginner Callout 2: Amalloc vs Amalloc_4 vs Amalloc_D** — Amalloc 做 `ARENA_ALIGN(x)`（2×word 对齐），Amalloc_4 跳过对齐假定 `x` 已是字对齐，Amalloc_D 仅 SPARC 32-bit 额外做 8 字节对齐。常用 Amalloc，知道 size 已对齐时用 Amalloc_4。`

3. `> **Beginner Callout 3: ResourceMark 是栈式 RAII** — 嵌套 ResourceMark 是合法的：最内层析构时回滚到该 mark 保存的 _hwm/_chunk/_max，外层 mark 不受影响。`

4. `> **Beginner Callout 4: UseMallocOnly 调试开关** — `-XX:+UseMallocOnly` 下 Arena::Amalloc 绕过 chunk 分配走 `os::malloc()`，所有指针记录在 resource area 中，`~ResourceMark()` 时逐个 `os::free()`。用于检测 use-after-free。`

5. `> **Beginner Callout 5: ChunkPool 四级缓存** — Arena::grow() 的 Chunk 不直接 `os::free()`，而是回收到 ChunkPool（tiny/small/medium/large 四级），下次 grow() 优先从池中取。ChunkPoolCleaner 每 5 秒清理多余 chunk（保留 5 个）。`

6. `> **Beginner Callout 6: ResourceArea::bias_to()** — 切换 ResourceArea 的 MEMFLAGS，使后续分配被 NMT 统计到不同类别（如从 mtThread 切换到 mtGC）。`

7. `> **Beginner Callout 7: DeoptResourceMark vs ResourceMark** — DeoptResourceMark 是 CHeap 分配的（继承 CHeapObj），因为去优化发生在栈帧被替换后，无法使用栈上 ResourceMark。功能完全一致。`

---

## §二 Standard Environment

### Source Roots
- `src/hotspot/share/memory/arena.hpp:92-239` — Arena 类定义 + Amalloc/Afree/Arealloc
- `src/hotspot/share/memory/arena.cpp:247-375` — Arena 构造/析构 + grow() + move_contents()
- `src/hotspot/share/memory/arena.cpp:38-162` — ChunkPool 四级池实现
- `src/hotspot/share/memory/arena.cpp:182-245` — Chunk::operator new/delete（池分配）
- `src/hotspot/share/memory/resourceArea.hpp:44-264` — ResourceArea + ResourceMark + DeoptResourceMark
- `src/hotspot/share/memory/resourceArea.cpp:32-89` — bias_to() + resource_allocate_bytes() + ResourceMark ASSERT constructor
- `src/hotspot/share/memory/resourceArea.inline.hpp` — allocate_bytes() inline
- `src/hotspot/share/memory/allocation.hpp:111-142` — MemoryType enum + AllocateHeap/FreeHeap
- `src/hotspot/share/memory/allocation.hpp:175-201` — CHeapObj 模板
- `src/hotspot/share/memory/allocation.inline.hpp` — AllocateHeap inline

### Build
```bash
bash configure --with-debug-level=slowdebug --with-native-debug-symbols=internal
make hotspot
```

### Binary
`build/linux-x86_64-server-slowdebug/jdk/lib/server/libjvm.so`

### Syscall 速查表
| syscall | man | 使用场景 |
|---------|-----|---------|
| `mmap(2)` | man 2 mmap | ChunkPool::allocate() → os::malloc() → os::reserve_memory() |
| `mprotect(2)` | man 2 mprotect | os::commit_memory() |
| `munmap(2)` | man 2 munmap | os::free() → os::release_memory() |
| `malloc(3)` | man 3 malloc | os::malloc() 底层实现 |
| `free(3)` | man 3 free | os::free() |
| `memcpy(3)` | man 3 memcpy | Arena::Arealloc() 搬家 |
| `memset(3)` | man 3 memset | Chunk::chop() 清空 / ZapResourceArea |

### 全局状态表
| 变量 | 位置 | 描述 |
|------|------|------|
| ChunkPool::_large_pool | arena.cpp:150 | 32KB chunk 池（静态） |
| ChunkPool::_medium_pool | arena.cpp:151 | 10KB chunk 池（静态） |
| ChunkPool::_small_pool | arena.cpp:152 | 1KB chunk 池（静态） |
| ChunkPool::_tiny_pool | arena.cpp:153 | 256B chunk 池（静态） |
| Arena::_first | arena.hpp:102 | chunk 链表头 |
| Arena::_chunk | arena.hpp:103 | 当前可分配 chunk |
| Arena::_hwm | arena.hpp:104 | High Water Mark（下次分配起始） |
| Arena::_max | arena.hpp:104 | 当前 chunk 的 top() |
| Arena::_size_in_bytes | arena.hpp:107 | 总分配字节（NMT 用） |
| ResourceArea::_nesting | resourceArea.hpp:48 | 嵌套 ResourceMark 深度（debug only） |
| UseMallocOnly | globals.hpp | -XX 开关 |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| arena.hpp | `src/hotspot/share/memory/arena.hpp` | 256 | Chunk class, Arena class, Amalloc/Afree/Arealloc, NEW_ARENA_ARRAY 宏 | Arena 头文件 |
| arena.cpp | `src/hotspot/share/memory/arena.cpp` | 525 | ChunkPool(四级池), Chunk::operator new/delete, Arena::grow(), move_contents() | Arena + ChunkPool 实现 |
| resourceArea.hpp | `src/hotspot/share/memory/resourceArea.hpp` | 264 | ResourceArea, ResourceMark, DeoptResourceMark | ResourceMark 头文件 |
| resourceArea.cpp | `src/hotspot/share/memory/resourceArea.cpp` | 89 | bias_to(), resource_allocate_bytes(), ResourceMark ASSERTS | ResourceMark 实现 |
| resourceArea.inline.hpp | `src/hotspot/share/memory/resourceArea.inline.hpp` | 43 | allocate_bytes() inline | ResourceArea 快速路径 |
| allocation.hpp | `src/hotspot/share/memory/allocation.hpp` | 577 | MemoryType enum, CHeapObj, AllocateHeap/FreeHeap, RESOURCE_ARRAY 宏 | 分配框架头文件 |
| allocation.cpp | `src/hotspot/share/memory/allocation.cpp` | 297 | AllocateHeap 实现, NMT 记录 | 分配框架实现 |
| allocation.inline.hpp | `src/hotspot/share/memory/allocation.inline.hpp` | 174 | AllocateHeap inline 包装 | 分配框架 inline |

**总计**: 8 源文件, ~1,800 行源码

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 Arena::Amalloc() 的快速路径与 slow path

① `arena.hpp:145-159` Amalloc 的 `_hwm + x > _max` 判断 → 如果 `_hwm + x <= _max` 直接 `_hwm += x` 返回，这是整个 HotSpot 最高频路径之一。为什么用 HWM (High Water Mark) 而非一般 allocator 的 block 链表？HWM 的 cache 局部性（连续分配在 cache line 内）vs Chunk 链表（已满 chunk 留在链表中）的取舍是什么？

② 为什么 Amalloc_4 跳过 `ARENA_ALIGN(x)`？因为调用者已经保证 `x` 是字对齐的（`arena.hpp:162` 的 assert）。为什么 `ARENA_AMALLOC_ALIGNMENT = 2*BytesPerWord` 而不是 1*BytesPerWord？在 LP64 上是 16 字节对齐——与 SSE 指令的对齐需求有关。

③ **Counterfactual**: 如果 Amalloc 用 `bump pointer` 但不用 chunk 链表，而是固定大小 buffer + `realloc()` → 频繁 realloc 的 memcpy 开销 > Arena 的 chunk 链表分摊。

④ **Counterfactual**: 如果 Amalloc 像 tcmalloc 一样用 size-class 的 freelist → 需要 per-size 的 freelist + 线程本地缓存，Arena 的 HWM 模式更简单但无法高效处理变长大对象。

### 4.2 ChunkPool 四级缓存与 buddy allocator 的关系

① `arena.cpp:43-148` ChunkPool 的 tiny(256B)/small(1KB)/medium(10KB)/large(32KB) 四级 → `arena.hpp:65-69` 的 Chunk::tiny_size/init_size/medium_size/size 与 ChunkPool::initialize() 的映射。为什么 `slack=40` (LP64) / `slack=20` (32-bit)？因为要防备 buddy-system malloc 实现的内部头开销。

② `arena.cpp:70-83` allocate() 中先 `ThreadCritical` 加锁取池中的 chunk，失败才走 `os::malloc()`。为什么用 `ThreadCritical` 而非 `Mutex`？因为 ChunkPool 在 `Threads::create_vm()` 之前就被使用（chunkpool_init()），此时 Mutex 系统还没初始化。

③ **Counterfactual**: 如果不分四级，用单一 freelist → 每次 `Chunk::operator new` 都要遍历找合适大小的 chunk，丢失了 O(1) 的 switch-case 分发。

④ **Counterfactual**: 如果不用 ChunkPool 缓存，每次 grow() 都 os::malloc()/os::free() → `ChunkPoolCleaner` 每 5 秒 `free_all_but(5)` 把多余 chunk 归还给 OS，pool 命中率高时 malloc/free 开销可降低 90%+。

### 4.3 Arena::grow() 的链表追加和失败恢复

① `arena.cpp:356-375` g=MAX2(x, Chunk::size) → `new Chunk(len)` → `k->set_next(_chunk)` → `_hwm=_chunk->bottom()` → 返回 `_hwm`。如果 `new Chunk(len)` 返回 NULL（RETURN_NULL 模式），`_chunk = k` 恢复旧值，`_hwm` 不变。但 _hwm 还在旧 chunk 的 top() 处——下次 Amalloc 会立即触发下一个 grow()。

② **Counterfactual**: 如果 grow() 不恢复 `_chunk = k` → `_chunk = NULL` 导致下次 Amalloc 在 NULL 上做 `_hwm + x > _max` 导致 SIGSEGV。

③ **Counterfactual**: 如果 grow 默认 32KB（Chunk::size）→ 第一次 grow 产生 32KB chunk，但 `Chunk::init_size = 1KB` 的首 chunk 很小。为什么首 chunk 小？因为大部分 ResourceMark 内的分配量 < 1KB，用大 chunk 浪费。

### 4.4 ResourceMark 嵌套与恢复的三层水位线

① `resourceArea.hpp:84-96` initialize() → 保存 `_area->_chunk`、`_area->_hwm`、`_area->_max`、`_area->_size_in_bytes`。`~ResourceMark()` 调用 `reset_to_mark()`: ①如果 `_chunk->next() != NULL` 调用 `_chunk->next_chop()` 释放后续 chunk → ②恢复 `_area->_chunk/_hwm/_max` → ③如果 `ZapResourceArea` memset(_hwm, badResourceValue, _max-_hwm)。

② 嵌套场景：最内层 RM 分配了额外 chunk → 析构时 `next_chop()` 释放 → 中间层 RM 恢复 → 最外层 RM 恢复。为什么嵌套 RM 不需要复制整个 chunk 链表？因为每个 RM 只保存当前位置，恢复时丢弃自己作用域内的增长。

③ **Counterfactual**: 如果 ResourceMark 不保存 `_size_in_bytes` → `next_chop()` 前调用 `_area->set_size_in_bytes(size_in_bytes())` 的前提不存在，NMT 会 double-count → arena `_size_in_bytes` 超过所有 chunk 的总和。

### 4.5 Afree() 的 bump-pointer 回退 vs 通用 free()

① `arena.hpp:202-211` Afree(ptr, size): 只有 `((char*)ptr) + size == _hwm` 时才回退 `_hwm = ptr`，其他情况 NOP。这是 bump-pointer allocator 的典型行为——只支持 LIFO 释放。

② **Counterfactual**: 如果 Afree 用通用 freelist → 需要 per-size 的元数据 + 合并相邻空闲块，Arena 的高频临时分配不划算。

③ **Counterfactual**: 如果 Afree 不支持回退（永远 NOP）→ `Arena::Arealloc()` 的 in-place shrink 无法工作（`arena.cpp:402-408` 依赖 `c_old+old_size == _hwm` 判断）。

### 4.6 ResourceArea 的 thread-local 快速路径

① `resourceArea.hpp:60` allocate_bytes() 声明 → `resourceArea.inline.hpp` 实际实现在 inline 文件中。Thread::current()->resource_area() 获取 thread-local Arena → Amalloc() 走 HWM 快速路径。

② `resourceArea.cpp:49-54` resource_allocate_bytes() → `Thread::current()->resource_area()->allocate_bytes()` 的全局函数包装。为什么提供全局函数而不直接让调用者使用 `Thread::current()->resource_area()`？因为 `NEW_RESOURCE_ARRAY` 宏展开后的简洁性和一致性。

③ **Counterfactual**: 如果每个线程不用独立 ResourceArea，用全局 Arena + Mutex → 所有线程的临时分配串行化，Safepoint 操作（VM Thread 独占）变成瓶颈。

### 4.7 AllocateHeap 的 NMT 追踪 vs Arena 的 MemTracker

① `allocation.hpp:160-167` AllocateHeap() 声明 → NMT 在每次 CHeap 分配时记录 call site stack。Arena::set_size_in_bytes() 在 chunk 链表增长时通知 `MemTracker::record_arena_size_change()`。

② **Counterfactual**: 如果 Arena 像 CHeapObj 一样对每次 Amalloc 做 NMT → Arena 分配极高频（百万次/秒），NMT 开销不成比例。Arena 只在 chunk 粒度（>1KB）上报 NMT。

③ **Counterfactual**: 如果不用 MEMFLAGS 标记分配类别 → NMT 无法区分 mtThread/mtGC/mtChunk，内存泄漏诊断无法按类别隔离。

### 4.8 DeoptResourceMark: CHeap 分配的 ResourceMark

① `resourceArea.hpp:195-262` DeoptResourceMark 继承 CHeapObj<mtInternal>，功能与 ResourceMark 相同但用于去优化路径：去优化发生时栈帧已被替换（`vframeArray` 持有 Resource allocated 数据），ResourceMark 必须是 CHeap 分配才能跨越栈帧变化。

② **Counterfactual**: 如果没有 DeoptResourceMark → 去优化需要 `vframeArray` 的数据全部用 CHeap 分配并手动 free，代码复杂度 ×3。

### 4.9 Arena::Arealloc() 的 in-place 扩展 vs 通用 relocate

① `arena.cpp:380-428` Arealloc: shrink 尝试 in-place, 扩展先检查 in-place 是否可行（`c_old+old_size==_hwm && c_old+new_size<=_max`），不可行则 `Amalloc(new) → memcpy → Afree(old)`。

② **Counterfactual**: 如果 Arealloc 不检测 in-place → 每次 realloc 都 copy，ResourceMark 内的字符串拼接（频繁 realloc）性能退化 2-3×。

---

## §五 Article Structure

```
# 01-Arena & ResourceArea — libjvm.so 快速路径分配器

## §〇 生产场景 — 三个线上诊断
## §一 架构全景 — Arena 家族与分配器选择树
  1.1 为什么 JVM 需要自己的分配器？malloc 不够吗？
  1.2 分配器四态：Arena / CHeap / Metaspace / Stack
  1.3 调用链总览：NEW_RESOURCE_ARRAY → resource_allocate_bytes → Amalloc
  1.4 7 个 Beginner Callout（嵌入本节）
## §二 Standard Environment
## §三 Source Files Table
## §三 Arena 核心 — Chunk 链表 + HWM bump-pointer
  3.1 Chunk 结构体：_next + _len + bottom()/top()
  3.2 Arena::Arena(flag, init_size) 构造：Chunk::init_size=1KB 首 chunk
  3.3 Amalloc: hwm + x > max 检查 → grow() 或 bump
  3.4 Afree: LIFO 回退
  3.5 Arealloc: in-place shrink/extend vs relocate
  3.6 grow(): MAX2(x, 32KB) → Chunk::operator new → 链表追加
## §四 ChunkPool: 四级池与 OOM 防护
  4.1 tiny/small/medium/large 四级 → switch-case 分发
  4.2 ThreadCritical 锁 (vs Mutex: 启动前可用)
  4.3 ChunkPoolCleaner: 5s 周期 trim 到 5 个
  4.4 Chunk::operator delete 的池回收路径
## §五 ResourceArea & ResourceMark: 栈式回滚
  5.1 ResourceArea: thread-local Arena
  5.2 ResourceMark 构造: 保存 _chunk/_hwm/_max
  5.3 ResourceMark 析构: next_chop() → 恢复三层水位线
  5.4 嵌套 ResourceMark: 层层递增 _nesting
  5.5 ZapResourceArea: memset badResourceValue
  5.6 bias_to(): 动态切换 MEMFLAGS
## §六 DeoptResourceMark: CHeap 版的 ResourceMark
  6.1 为什么需要 CHeap 分配: 去优化栈帧替换
  6.2 与 ResourceMark 的功能等价性
## §七 分配器宏体系
  7.1 NEW_RESOURCE_ARRAY/OBJ: resource_allocate_bytes → Amalloc
  7.2 NEW_C_HEAP_ARRAY/OBJ: AllocateHeap → os::malloc
  7.3 分配器选择树
## §八 Counterfactual 对比表
## §九 边缘场景
## §十 GDB 验证
## §十一 "不要写成→应该写成" 对照表
## §十二 诊断工具五件套
## §十三 Cross-Reference
```

---

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| 列出 Amalloc 的逐行代码 | 解释 `_hwm + x > _max` 为什么是 HotSpot 最高频路径（bump pointer 的 2-3 指令开销 vs malloc 的 50+ 指令） |
| 翻译 `arena.cpp:356-375` grow() | 分析 `MAX2(x, Chunk::size)` 的设计—为什么最小 32KB？因为 malloc 内部 arena 分配的是 64KB 对齐的 mmap 区域，32KB 刚好避开内部碎片 |
| 说"ChunkPool 有四级" | 分析为什么是 256B/1KB/10KB/32KB 而不是任意大小——这四级对应 `Chunk::tiny_size` 到 `Chunk::size`，均匀覆盖 HotSpot 的临时分配模式（80% < 1KB, 15% < 10KB, 5% > 10KB） |
| 说"ResourceMark 保存三个水位线" | 分析为什么保存的是 `_chunk`（链表节点引用）而不是索引——`reset_to_mark()` 需要 `_chunk->next_chop()` 释放后续 chunk，索引无法定位到正确的 chunk 节点 |
| 翻译 `ThreadCritical` 注释 | 分析为什么 ChunkPool 不能用 `Mutex` 而用 `ThreadCritical`——因为 `chunkpool_init()` 在 `Threads::create_vm()` 之前调用，此时 Mutex 初始化 (`MutexLocker::_mutex_array`) 还未完成 |
| 说"DeoptResourceMark 是 CHeap 的 ResourceMark" | 分析去优化的 7 步流程（assembly stub → vframeArray → unpack_frames）中 ResourceMark 的生命周期跨越了栈帧重建——栈上 RAII 对象的栈地址在解绑后无效 |
| 列出 Arena::move_contents() 的代码 | 解释为什么需要 move_contents——用于 `PreserveExceptionMark` 把旧 ResourceArea 的内容转移到新 ResourceArea，避免 `longjmp` 跳过 `~ResourceMark()` |
| 说"UseMallocOnly 用于调试" | 分析 UseMallocOnly 如何与 `Arena::free_malloced_objects()` 配合：chunk 的 bottom-to-top 存储的是 `char*` 指针数组（每次 Amalloc → os::malloc → 保存指针），`ResourceMark::free_malloced_objects()` 遍历这些指针逐个 `os::free()` |
| 说明 MemTracker 追踪 Arena 分配 | 分析 `Arena::set_size_in_bytes()` 的 `ssize_t delta = size - old_size` 差分上报—避免每次 Amalloc 都走 NMT 记录，只在 chunk 粒度（>1KB）通知一次 |

---

## §七 Output Format

按照 `§〇 → §十三` 的 section 顺序生成文档。每个技术断言标注 `file:line` 引用。代码片段不超过 15 行（完整函数放附录或引用行号）。Mermaid 图放在 §一 架构全景和 §四 ChunkPool 中。

---

## §八 Prohibited（≥8）

1. 不要写成"Arena 就是 bump pointer allocator"——要解释 HWM 模式 + chunk 链表如何形成完整分配器
2. 不要忽略 `arena.hpp:58-69` 的 `slack=40` 设计——这是避开 buddy-system malloc 开销的关键
3. 不要写成"Afree 是 NOP"——它是 LIFO 回退，`ptr + size == _hwm` 才生效（约 15% 命中率）
4. 不要混淆 `Arena::Arena(flag)` 和 `Arena::Arena(flag, init_size)`——前者用 `Chunk::init_size` (1KB)，后者用指定大小
5. 不要只分析 ResourceMark 不分析 DeoptResourceMark——去优化路径的 CHeap 分配是核心设计决策
6. 不要忽略 `ZapResourceArea` 的行为——它影响 Debug 构建中的内存可见性和 use-after-free 检测
7. 不要写成"ChunkPool 只是缓存"——它和 `ThreadCritical` 锁的选择是启动顺序约束驱动的
8. 不要忽略 `Arena::signal_out_of_memory()` 路径——在 `EXIT_OOM` 模式下直接 `vm_exit_out_of_memory()`，不抛异常
9. 不要跳过 `resource_allocate_bytes()` 的全局函数包装——它是 NEW_RESOURCE_ARRAY 宏的最终调用目标
10. 不要把 allocation.hpp 的 MemoryType enum 一笔带过——24 种 `MEMFLAGS` 是 NMT 分类体系的基础

---

## §九 Required（≥8）

1. 每个技术断言必须标注 `file:line`（如 `arena.hpp:145-159`）
2. 至少 3 个 Mermaid 图：① Arena 分配器族谱类图 ② Amalloc 快速路径 vs grow() slow path 流程图 ③ ResourceMark 嵌套生命周期序列图
3. 必须包含 `Amalloc()` 的完整源码分析（`arena.hpp:145-159`）和 `grow()` 的完整源码分析（`arena.cpp:356-375`）
4. 必须包含 `ChunkPool::allocate()` 的 ThreadCritical 上锁路径源码（`arena.cpp:70-83`）
5. 必须包含 `ResourceMark::reset_to_mark()` 的完整源码分析（`resourceArea.hpp:129-147`）
6. 必须包含 `NEW_RESOURCE_ARRAY` / `NEW_C_HEAP_ARRAY` / `NEW_ARENA_OBJ` 三个宏的展开分析
7. 必须包含 7 个 Beginner Callout（嵌入 §一 各小节）
8. 必须包含 §六 Counterfactual 对比表（≥5 个对比对）
9. 必须包含 §九 边缘场景（≥5 个场景：OOM/RETURN_NULL、嵌套 RM 泄漏、ZapResourceArea、longjmp 跳过析构、ThreadCritical 死锁）
10. 必须包含 GDB 验证节（≥7 断言，覆盖 Arena 创建/Amalloc/ResourceMark/grow/ChunkPool）
11. 必须包含诊断工具五件套（strace + jcmd + jstack + GDB + /proc）
12. 必须包含 Interview Story: "如果我是一个临时对象，从 ResourceMark 创建到析构的完整生命周期"

---

## §十 GDB Verification（≥7 assertions）

1. **断点 Arena::Amalloc**: `b 'Arena::Amalloc(unsigned long, AllocFailType)'` → `bt` 查看调用栈 → `p x` 查看分配大小 → `p _hwm` `p _max` 查看当前水位
2. **断点 Arena::grow()**: `b 'Arena::grow(unsigned long, AllocFailType)'` → `p _chunk->length()` 查看当前 chunk 大小 → `p x` 查看请求大小 → `p len`（`MAX2(x, Chunk::size)` 结果）
3. **ResourceMark 生命周期**: `b 'ResourceMark::ResourceMark()'` → `b 'ResourceMark::~ResourceMark()'` → 两个断点之间 `p _area->_chunk` 看 chunk 变化
4. **ChunkPool 池命中**: `b 'ChunkPool::allocate(unsigned long, AllocFailType)'` → `p _num_chunks` 查看池中缓存数 → `p _num_used` 查看已取出的 chunk 数
5. **ChunkPool::clean()**: `b 'ChunkPool::clean()'` → `p _num_chunks` 清理前 → `finish` → `p _num_chunks` 清理后（≤5）
6. **UseMallocOnly 路径**: 设置 `-XX:+UseMallocOnly` → `b 'Arena::malloc(unsigned long)'` → `p size` → `finish` 返回 os::malloc() 的结果
7. **Arena::set_size_in_bytes()**: `b 'Arena::set_size_in_bytes(unsigned long)'` → `p _size_in_bytes` → `p size` → 验证差分增量
8. **Arena::Arealloc in-place 路径**: `b 'Arena::Arealloc(void*, unsigned long, unsigned long, AllocFailType)'` → `p old_size` → `p new_size` → 触发 in-place 条件时 `p _hwm` 的变化
9. **NMT arena 追踪**: `b 'MemTracker::record_arena_size_change(long, MEMFLAGS)'` → `info args` 查看 delta

---

## §十一 与 README 和同组 prompt 的连续性

- **README**: 本文档对应 Phase 27 的 doc-01，紧随 doc-00 (VirtualSpace Layer) 之后。Arena 在 VirtualSpace 之上申请 CHeap 空间作为 chunk。
- **前一篇 (00-VirtualSpace-Layer)**: doc-00 分析 `ReservedSpace` → `os::reserve_memory()` → `VirtualSpace` → `os::commit_memory()` 的虚拟空间管理层。Arena 的 ChunkPool::allocate() → `os::malloc()` 最终走向 doc-00 的 commit 路径——这两篇构成 JVM 内存分配的金字塔（底层 VirtualSpace → 中层 Arena → 顶层 ResourceMark）。
- **后一篇 (02-Metaspace Internals)**: Metaspace 的 `ChunkManager` 和 `SpaceManager` 使用了类似的 chunk 管理思想（链表 + 水位线），但粒度不同（Metaspace 在 classloader 粒度，Arena 在线程粒度）。
- **旧文档**: `libjvm-analysis/01-jvm-startup/03-Metaspace.md` 覆盖了 Metaspace 高层架构，Arena/ResourceArea 未深入。本文档标记为互补。
