# PROMPT: 请撰写 01-HeapRegion.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**HeapRegion — G1 的最小回收单元（432 字节的 4MB 世界）**

### 核心故事线（禁止做源码翻译机！）

G1 把 8GB 堆切成 2048 个 4MB Region。这看起来像一句废话——任何讲 G1 的文章第一段都是这个。但真正的问题是：

**❓ 为什么是 2048 个，不是 1024 个，不是 4096 个？**

答案不是你第一反应想的"管理开销"——那是结论，不是推导。真正的推导是从两端夹逼出来的：

- 上限：Region 不能太大，否则 Young GC 回收粒度太粗 → 停顿超 `MaxGCPauseMillis` 目标
- 下限：Region 不能太小，否则 2048 个 Region 各自 432B 元数据 + RSet 内存爆炸，且并发标记每个 Region 的 bitmap + card table 开销线性增长
- 但这里有一个隐藏约束：`HeapRegion::GrainBytes` 必须是 2 的幂（`heapRegionBounds.hpp` 中的 `is_power_of_2()` 断言），且必须在 `[1MB, 32MB]` 范围内
- 8GB / 2048 = 4MB，正好是 2 的幂，正好在这个范围

**2048 不是"选出来的"，是"算出来的"——它是一系列硬约束下的唯一解。** 4GB 堆下就是 2MB Region，16GB 堆下就是 8MB Region——2048 是分子，Region 大小是分母。

---

但 Region 不只是"4MB 的块"。每个 Region 内部有一个完整的状态机、一个 bump-pointer 分配器、一个 RSet 反向索引、一对 TAMS 双缓冲指针、一个 BOT 偏移表。**432 字节里塞进了 G1 全部决策所需的数据。**

**本文是 06 阶段的第一篇，是整个 G1 系列的标准模板。** 后续 13 篇都会引用这篇文章的 Region 结构、TAMS、free_list。写不好这篇，后面的引用全是乱码。

### 核心叙事线（9 个"为什么"问题，每个必须有源码回答）

1. **❓ 为什么 2048 个 Region？** — 如前所述，从 G1HeapRegionSize 的计算公式出发，推导 8GB→4MB 的必然性。必须回答"为什么是 2 的幂？为什么卡在 [1MB, 32MB] 之间？如果堆不是 8GB 会怎样？"

2. **❓ 为什么继承链是四层？** — `Space → CompactibleSpace → G1ContiguousSpace → HeapRegion`。每层加什么？为什么要分开？为什么 `CompactibleSpace` 的 `_compaction_top` 在 G1 中基本不用，但还是继承了？（因为 Space 体系是 Serial/Parallel/CMS 共享的——G1 用的是 Evacuation 不是 Compaction，但继承体系没法改）。追问：**G1ContiguousSpace 是 G1 独有的层——这一层加的 `_top`（volatile bump-pointer）、`_bot_part`（内联 BOT）、`_par_alloc_lock`、`_pre_dummy_top`——为什么这四样东西必须在 G1ContiguousSpace 这层而不是 HeapRegion 层？**

3. **❓ 为什么 `_type` 用位编码而不是枚举？** — `is_young()` = `(tag & YoungMask) != 0`——一条 AND 指令同时匹配 Eden(2) 和 Survivor(3)。如果用数字枚举需要 `tag==2 || tag==3`（两条比较+分支）。追问：**这条判断在 GC hot path 上被执行多少次？为什么一条指令的差异在这里是致命的？** → 每次 Young GC 遍历 CSet 时，对所有 Region 判断 `is_young()`；在并发标记 Claim Region 时，判断 `is_humongous()`。单次 GC 数百万次调用——每次省一条分支指令就是几毫秒。

4. **❓ 为什么 TAMS 需要双缓冲（prev 和 next）？** — 并发标记是循环的：上一轮标记刚结束，下一轮就开始了。两轮标记使用各自独立的 TAMS 和数据，互不干扰：
   - `_prev_top_at_mark_start`：上一轮标记完成时的 snapshot → Mixed GC 用它选择 Old Region 回收
   - `_next_top_at_mark_start`：本轮标记进行中 → 并发标记线程用它判断"obj >= TAMS → 自动存活"
   - 标记完成时 swap：`_prev ← _next`，`_next` 重置
   追问：**如果只有一个 TAMS 会怎样？** → 本轮标记进行中，Mixed GC 尝试用同一个 TAMS 选 Old Region → 读到的是"正在变化的中间态"决策错误。双缓冲保证了 consumer（Mixed GC）和 producer（并发标记）各自有独立的只读/读写视图。追问：**live_bytes 公式 `(top - prev_TAMS) * 8 + prev_marked_bytes` 的 `* 8` 是什么？** → `HeapWord*` 转字节。TAMS 和 top 都是 `HeapWord*`（8 字节/字），差值需要 ×8 才能和 `prev_marked_bytes`（字节计数）相加。

5. **❓ 为什么 `_free_list` 是非循环双向链表？** — 遍历旧文档的经典错误："free_list 是双向循环链表"。但源码 `heapRegionSet.hpp` 明确定义 `_head`/`_tail`/`_last`（上次插入缓存），`remove_region(from_head)` O(1) 头部取、`add_ordered` O(n) 有序插入。追问：**如果是循环链表会怎样？** → 无法区分"空链表"和"只剩一个节点"（循环链表的 head == tail 时两种语义重叠）→ `remove_region` 需要额外的 length 计数器来判空 → 多一次内存访问。追问：**为什么不用数组？** → `_regions[2048]` 已经用作 O(1) 随机寻址（`region_index = (addr - base) / 4MB`），不需要另一个数组。链表用于 O(1) 头部分配 + 有序回收——这是分配-回收模式的最优结构。

6. **❓ 字段太多（432B），哪些是 hot-path？哪些是 cold？** — 这是读者读完字段表后最想问的问题。必须给一个 hot/cold 分类表：
   - **Hot（每次分配都访问）**：`_top`（TLAB bump-pointer，L1 cache 常驻）
   - **Warm（每次 Young GC 访问）**：`_type`（CSet 遍历判断）、`_rem_set`（RSet 扫描）、`_bottom/_end`（内存边界）
   - **Cold（仅在并发标记时访问）**：`_prev/_next_marked_bytes`、`_prev/_next_top_at_mark_start`（TAMS）
   - **Cold（仅在 Mixed/Full GC 时访问）**：`_gc_efficiency`、`_predicted_elapsed_time_ms`、`_evacuation_failed`

7. **❓ Region 怎么从"不存在的概念"变成"2048 个活生生的对象"？** — JVM 初始化中 Region 的完整生命周期：`mmap(PROT_NONE) → G1RegionToSpaceMapper × 6 → expand(8GB) → make_regions_available(0, 2048) → commit_regions → 2048 × new HeapRegion → initialize → insert_into_free_list`。追问：**为什么 6 个 Mapper？** → 每个 Mapper 管理一种元数据空间的虚拟→物理映射：堆空间、prev_bitmap（~128MB）、next_bitmap（~128MB）、BOT、cardtable（~16MB）、card_counts。它们有独立的访问模式和保护需求——bitmap 和 cardtable 在 GC 期间被批量 mprotect 切换读写。追问：**为什么 GC worker（13 个线程）参与 commit？** → 并行触发 page fault。单线程顺序访问 8GB 需要 ~200ms 的 page fault 累积——13 个线程并行把延迟降到 ~15ms。

8. **❓ 为什么状态机没有 RETAINED 类型？** — 旧文档错误地将 Evacuation Failure 后的 Region 称为 "RETAINED 状态"。但 `HeapRegionType` 枚举中根本没有 `RetainedTag`。真相是：Evacuation Failure 后的 Region，**`_type` 仍然是 Old 或 Survivor，只是 `_evacuation_failed` 字段为 true**。GC 跳过它（不回收），等 Mixed GC 或 Full GC 兜底。这个区分是 `_type`（决定 GC 怎么处理这个 Region）和 `_evacuation_failed`（标记"这次别碰我"）两个正交维度的叠加——不是类型系统的一部分。

9. **❓ 为什么 BOT（Block Offset Table）必须存在？** — GC 线程扫卡时只知道"这张卡从地址 X 开始"，但不知道对象边界在哪——如果 X 在一个对象的中间，需要知道前一个对象从哪里开始。BOT 以 `N_words`（2 的幂）为块粒度记录每块内最近对象起始地址的偏移。追问：**为什么用 2 的幂块大小而不是逐卡？** → 逐卡存储 8192 个偏移需要 16KB/Region，2 的幂块大小将条目数压缩到 ~256 个→ per-Region 只有 ~240B，内联在 G1ContiguousSpace 中避免指针间接访问。追问：**per-Region BOT（内联 240B）和 BOT Mapper 是什么关系？** → 前者是 G1ContiguousSpace 的内联缓存，后者是 HeapRegionManager 管理的独立虚拟内存区域——两者共存但职责不同。

### 禁止行为

- ❌ 把四个父类的字段平铺列出然后说"这段代码定义了 XXX 字段"——这是翻译源码
- ❌ 只讲"是什么"不讲"为什么"：每节必须以"❓ 为什么..."开头
- ❌ 不标注字段的 hot/cold 路径和访存频率
- ❌ 不追踪跨文件约束（如 `_max_desired_young_length` 定义在 `g1YoungGenSizer.hpp` 但使用时在 `g1Allocator.cpp` 的 `should_allocate_mutator_region()`）
- ❌ 不区分 `_type` 和 `_evacuation_failed` 两个正交维度
- ❌ 不给出 GDB 可验证的断言

### 要求行为

- ✅ **★ 每节以 "❓ 为什么..." 开头**：先建立设计问题，再用源码做证据
- ✅ **★ 字段 hot/cold 分类表**：标注每个字段在 hot/warm/cold 哪条路径上、访问频率、cache 亲和性
- ✅ **★ 继承链每层的"为什么"**：不是 "Space 有 _bottom 和 _end" 而是 "为什么 G1 还需要 CompactibleSpace 这层？为什么 G1ContiguousSpace 的四样东西不能直接放在 HeapRegion？"
- ✅ **★ 位编码类型系统的设计决策**：`is_young()` 一条 AND 的指令级论证（x86_64 `test` 指令 1 cycle vs 两条 `cmp` + `je` 3 cycles）
- ✅ **★ TAMS 双缓冲的读写分离论证**：画时间线说明 prev（Mixed GC 只读）和 next（并发标记读写）的分离
- ✅ **★ free_list 非循环的严格证明**：引用 `heapRegionSet.hpp` 的 `_head`/`_tail`/`_last` 字段定义 + GDB `_head->prev == NULL` 验证
- ✅ **★ 初始化全路径的 Mermaid 图**：`reserve → 6×Mapper → expand → commit → 2048×new → init → insert`，标注 13 worker 并行
- ✅ **★ 状态机 ASCII 图**（不带 RETAINED）+ 每条边的跨文件前置条件表
- ✅ **★ GDB 验证 ≥7 条**：`sizeof(HeapRegion)=432`、`_free_list` 非循环、`_head->_prev==NULL`、`HeapRegion::GrainBytes=4194304`、`is_young()` 汇编指令验证、`_num_committed=2048`、TAMS 字段偏移验证
- ✅ **★ 设计替代分析**：每回答一个"为什么 X"，必须追问"如果不用 X 而用 Y 会怎样"

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（G1 Region = 4MB，2048 Regions）
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心函数/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `heapRegion.hpp` | `src/hotspot/share/gc/g1/heapRegion.hpp` | gc/g1 | `HeapRegion`(L191-701), `G1ContiguousSpace`(L97-189) | ★★★ Region 核心字段 |
| 2 | `heapRegion.cpp` | `src/hotspot/share/gc/g1/heapRegion.cpp` | gc/g1 | `HeapRegion::HeapRegion()`(L246), `initialize()`(L285), `hr_clear()` | ★★ 构造 + 初始化 |
| 3 | `heapRegionType.hpp` | `src/hotspot/share/gc/g1/heapRegionType.hpp` | gc/g1 | `HeapRegionType`, Tag 枚举(L65-91), `is_young()`(L125) | ★★★ 位编码类型系统 |
| 4 | `heapRegionManager.hpp` | `src/hotspot/share/gc/g1/heapRegionManager.hpp` | gc/g1 | `HeapRegionManager`, `_regions[2048]`, `_free_list`, `_available_map` | ★★★ Region 管理器 |
| 5 | `heapRegionManager.cpp` | `src/hotspot/share/gc/g1/heapRegionManager.cpp` | gc/g1 | `initialize()`(L35), `expand_by()`(L50), `make_regions_available()`(L165), `commit_regions()` | ★★★ 初始化全路径 |
| 6 | `heapRegionSet.hpp` | `src/hotspot/share/gc/g1/heapRegionSet.hpp` | gc/g1 | `FreeRegionList`(L155-212), `_head`/`_tail`/`_last`, `remove_region()`, `add_ordered()` | ★★★ free_list 定义 |
| 7 | `heapRegionSet.cpp` | `src/hotspot/share/gc/g1/heapRegionSet.cpp` | gc/g1 | `remove_region()`, `add_ordered()` 实现 | ★★ free_list 操作 |
| 8 | `g1YoungGenSizer.hpp` | `src/hotspot/share/gc/g1/g1YoungGenSizer.hpp` | gc/g1 | `_min_desired_young_length`(L76), `_max_desired_young_length`(L77) | ★★ 年轻代约束（跨文件追踪） |
| 9 | `space.hpp` (gc/shared/) | `src/hotspot/share/gc/shared/space.hpp` | gc/shared | `Space`, `CompactibleSpace` | ★ 继承基类 |
| 10 | `g1RegionToSpaceMapper.hpp` | `src/hotspot/share/gc/g1/g1RegionToSpaceMapper.hpp` | gc/g1 | `G1RegionToSpaceMapper` — 两阶段 commit 协议 | ★★ 虚拟内存映射 |

**跨模块说明**：本文跨越 `gc/shared/`（Space 继承体系）和 `gc/g1/`（G1 专用 Region），是 G1 架构的基石。

## 四、必须深度走读的核心概念（每个先定位源文件行号，再回答"为什么"）

### 4.1 ★★★ 继承链四层——为什么不扁平化？

```
问题：
  ① Space → CompactibleSpace → G1ContiguousSpace → HeapRegion
     每层各自解决什么问题？为什么不能合并？
     
  ② Space（_bottom, _end）：
     为什么只存两个指针不存大小？→ _end - _bottom = GrainBytes 是 per-Region 固定常量，存大小浪费 8 字节 × 2048 = 16KB
     为什么 _bottom 和 _end 在 Region 整个生命周期中不变？→ G1 Region 是固定大小的，不像 CMS 的 free chunk 可变
     
  ③ CompactibleSpace（_compaction_top）：
     G1 不用 Compaction（用 Evacuation），为什么还要继承这层？
     → Space 体系是 Serial/Parallel/CMS/G1 共享的。去掉这层需要修改所有 GC 的 Space 体系——代价太高
     → G1 的 Full GC 确实用 Compaction（G1FullGCCompactionPoint::forward）——这层在 Full GC 时是有用的
     
  ④ G1ContiguousSpace（_top, _bot_part, _par_alloc_lock, _pre_dummy_top）：
     为什么 _top 是 volatile？→ 并发标记线程在 concurrent mark 阶段读 _top（update_region_limit），
       此时 mutator 在并行写 _top（分配对象）— 两个线程并发读写同一个字段。另外并行 GC worker 
       在 Evacuation 时 CAS bump-pointer 也需要 volatile 语义保证可见性。
     为什么 BOT 要内联在 G1ContiguousSpace 里？→ 避免指针间接访问（内联 240B 省一次 L1 miss）
     为什么 _par_alloc_lock 是 Region 级的而不是全局的？→ 不同 Region 的分配锁互不冲突，全局锁会成为瓶颈
     为什么需要 _pre_dummy_top？→ Region 退休时塞 dummy object，防止其他线程继续分配 + 记录最后真实对象的 top
```

### 4.2 ★★ 类型位编码——为什么用 bit flag 而不是 enum？

```
问题：
  ① 源码: heapRegionType.hpp L65-91 — Tag 枚举
     FreeTag=0, EdenTag=2, SurvTag=3, HumongousMask=4, OldTag=16, ...
     为什么跳过了 1？→ Tag[0] = 1bit 被保留给 YoungMask(bit0=0 → Free/Old；bit0=1 → Eden/Surv)
     
  ② is_young() = (get() & YoungMask) != 0 — 一条 AND 指令
     如果用数字枚举: tag==2 || tag==3 → 两条 cmp + je + 一次逻辑或 → 3-4 条指令
     差异: 1 cycle vs 3-4 cycles → GC hot path 上调用数百万次 → 省几 ms
     
  ③ 为什么 is_humongous() 用 HumongousMask 并返回 StartsHumongous OR ContinuesHumongous？
     StartsHumongous = 12 = 1100, ContinuesHumongous = 13 = 1101
     (tag & HumongousMask=4) → 两者都返回 true
     等价于: Starts 和 Continues 共享 bit 2 (HumongousMask)，bit 0 区分起始/后续
     
  ④ ArchiveMask=32, OpenArchiveTag=56(ArchiveMask|OldMask|PinnedMask), ClosedArchiveTag=57(+1)
     为什么 Archive 要单独的 Mask？→ CDS 加载的类元数据和字符串常量映射到 Archive Region → 永远不会被 GC 回收 → 需要独立标识
     为什么 Archive Region 还要叠加 OldMask 和 PinnedMask？→ 因为从 GC 角度看它们属于 Old（不参与 Young GC），且不可 Evacuation（Pinned）
```

### 4.3 ★★★ TAMS 双缓冲——为什么一个指针不够？

```
问题：
  ① 标记开始: _next_top_at_mark_start = top() — 记录快照
     标记进行: obj >= _next_TAMS → 自动存活（SATB 快照之后分配）
     标记完成: _prev_TAMS ← _next_TAMS; _next_TAMS 重置
     Mixed GC: 用 _prev_TAMS 计算 live_bytes → 选 Old Region 回收
     
  ② 如果只有一个 TAMS:
     Concurrent Mark 写 TAMS（每轮标记开始时更新）
     Mixed GC 读 TAMS（Cleanup 后选候选 Region）
     → 读写竞争！Mixed GC 选策时可能读到的是下轮标记刚开始更新的值
     → 对应关系错乱 → 选错 Region → 回收不该回收的对象 → crash
     
  ③ live_bytes 公式详解:
     live_bytes = (top - prev_TAMS) * HeapWordSize + prev_marked_bytes
       (top - prev_TAMS): TAMS 以来新分配的对象数（字地址差值）
       * HeapWordSize(8): 字地址 → 字节数
       + prev_marked_bytes: 标记时确定的活字节数
     例: top = TAMS + 1000 字 → 标记后分配了 8000B + prev_marked=50000B → live=58000B
```

### 4.4 ★★ free_list 非循环——为什么不是循环链表？

```
问题：
  ① 源码: heapRegionSet.hpp L155-212 — FreeRegionList
     HeapRegion* _head;  // hrm_index 最小
     HeapRegion* _tail;  // hrm_index 最大
     HeapRegion* _last;  // 有序插入缓存
     
  ② 操作复杂度:
     remove_region(from_head): O(1) — 头部取（分配）
     add_ordered(hr): O(n) — 有序插入（回收）
     但 _last 缓存优化: 连续回收相邻 Eden Region 时从 _last 起步而非 _head → 摊还 O(1)
     
  ③ 循环链表的问题:
     判空: head==tail → 无法区分"空"和"只剩一个节点"
     需要额外 _count 字段 → add/remove 时维护 → 多一次内存写入
     非循环链表: _head==NULL 就是空 → 一条 NULL 检查
     
  ④ 为什么不用数组？
     _regions[2048] 已用于 O(1) 寻址
     链表用于 O(1) 头部分配 + 有序回收 → 这是分配-回收模式的最优结构
     数组需要维护空闲位图 → 分配时扫描位图 O(n/64) → 比 O(1) 慢
```

### 4.5 ★★★ 初始化全路径——从 mmap 到 free_list

```
问题：
  ① 为什么 6 个 G1RegionToSpaceMapper？
     映射 6 种元数据空间:
       ① _heap_mapper:     8GB 堆空间（obj 在这里）
       ② _prev_bitmap_mapper: prev marking bitmap（~128MB = 8GB/(8B/word) bits）
       ③ _next_bitmap_mapper: next marking bitmap（~128MB）
       ④ _bot_mapper:       BOT 偏移表（全堆块偏移索引，大小取决于 N_words 块粒度）
       ⑤ _cardtable_mapper: CardTable（~16MB = 8GB/512B）
       ⑥ _card_counts_mapper: per-card refinement counts
     每个 Mapper 独立管理 reserve→commit→uncommit 两阶段协议。
     ★ 注意：上述大小为近似值，最终文档需通过 GDB 或源码计算验证精确值。
     
  ② 为什么 GC worker（13 threads）参与 commit？
     commit 后首次访问触发 page fault → 内核分配物理页
     单线程: 8GB / 4KB/page = 2M page faults 串行 → ~200ms
     13 线程并行: 2M / 13 ≈ 154K page faults/thread → ~15ms
     
  ③ 初始状态:
     创建完成: 全部 2048 个 Region _type=FreeTag, _top=_bottom, _next/_prev=链入 free_list
     Mutator 第一次 new Object() → TLAB refill → 从 free_list 取第一个 → set_eden() → _top 开始 bump
```

### 4.6 ★★ BOT — 为什么 GC 扫卡时需要知道对象边界？

```
问题：
  ① 卡表的局限: GC 线程通过 RSet 知道"Old Region #501 的 Card #1500 有引用指向 Eden"
     → 扫描 Card #1500 的 512B 区间时: 只知道起始地址 addr=card_start
     → 但对象可能从上一张卡开始跨越到这张卡 → addr 可能指向对象中间 → 无法解析 oop 字段
     
  ② BOT 的答案: 每 N_words（2 的幂）个字存一个 offset → 记录"最近的对象起始地址离这里多远"
     当 GC 要扫一个地址 obj_start 时:
       index = obj_start / N_words → bot[index] = offset（到 nearest object start 的距离）
       如果 offset != 0 → 回退 offset → 从实际对象头开始扫描
     
  ③ 为什么用 2 的幂块而不是每张卡存一个偏移？
     8192 卡/Region × 2B = 16KB/Region → 太浪费
     用 N_words 块大小（通常 512 words = 4KB）:
     → 4MB / 4KB = 1024 个块 → 1024 × 2B + 元数据 ≈ ~240B（GDB 实测 +32 _bot_part）
     → 内联在 G1ContiguousSpace 内 → 一个 cache line 就覆盖 → 扫卡时 L1 命中
     
  ④ per-Region BOT（~240B 内联）和 BOT Mapper 是什么关系？
     per-Region BOT: G1ContiguousSpace::_bot_part → Region 构造时内联分配
     BOT Mapper: G1RegionToSpaceMapper → 独立虚拟内存区域，管理全堆 BOT 的虚拟→物理映射
     两者共存: Mapper 负责内存映射，_bot_part 是 Mapper 中当前 Region 片段的局部热缓存
```

### 4.7 ★ 状态机——没有 RETAINED 类型

```
问题：
  ① 6 种有效 type: Free(0), Eden(2), Survivor(3), Old(16),
     StartsHumongous(12), ContinuesHumongous(13)
     
  ② 旧文档中的 "RETAINED" 是错的:
     Evacuation Failure 后 → _evacuation_failed=true → type 仍是 Old 或 Survivor
     _evacuation_failed=true 的作用: Free CSet 阶段跳过这个 Region（不回收）
     等 Mixed GC 或 Full GC 来兜底
     
  ③ 为什么 _evacuation_failed 不和 _type 合并？
     因为 _type 控制 GC 策略（怎么扫描这个 Region）
     _evacuation_failed 控制回收策略（要不要回收这个 Region）
     两个正交维度 → 分开存避免 6×2=12 种 type 组合 → 位编码复杂度翻倍
```

## 五、文章结构（§〇 ~ §七 + 附录）

```
§〇 源文件清单（10 文件，标注模块归属）

§一 ★ 继承链 — 四层叠加了什么？
  ❓ 每层解决什么问题？为什么不能合并？
  1.1 Space — 内存边界（为什么只存指针不存大小？）
  1.2 CompactibleSpace — 压缩指针（G1 不用 Evacuation，为什么还继承？）
  1.3 ★ G1ContiguousSpace — G1 专用层（_top/bot_part/lock/dummy_top 各自解决什么？）
  1.4 ★ BOT 详解（为什么 GC 扫卡时需要知道对象边界？N_words 块设计 + per-Region vs Mapper 两层）
  1.5 HeapRegion — 完整字段

§二 ★★★ HeapRegion 432B 字段全景
  ❓ 432 字节里塞了什么？哪些是 hot？哪些是 cold？
  2.1 空间组 — bump-pointer 三件套（_bottom/_top/_end + BOT）
  2.2 类型组 — _type 位编码（is_young()=一条 AND + 逐 Tag 解释）
  2.3 关系组 — RSet + 链表（_rem_set 卡粒度 + _next/_prev 非循环）
  2.4 统计组 — 标记 + GC 决策（prev/next_marked_bytes + TAMS + gc_efficiency）
  2.5 ★ hot/cold 分类表（标注每个字段在哪个路径上被访问、频率、cache 亲和性）
  2.6 GDB 字段偏移表（ptype /o 实测 432B，标注每个字段的 offset）

§三 ★★★ TAMS 双缓冲 — 并发标记为什么需要两个指针
  ❓ 为什么一个指针不够？
  3.1 SATB 快照语义 + TAMS 的作用
  3.2 双缓冲读写分离（timeline 图: prev 只读(Mixed GC) vs next 读写(CM)）
  3.3 live_bytes 计算公式推导（每项的含义 + 为什么 ×8）
  3.4 bitmap swap 协议（swap_mark_bitmaps 的时机）

§四 ★ 类型位编码 — 一条 AND 指令的百万倍价值
  ❓ 为什么不用数字枚举？
  4.1 Tag 枚举全解（11 个值，每 bit 的含义）
  4.2 ★ is_young() 反汇编验证（GDB `disas` 确认是一条 `test` 指令）
  4.3 is_humongous() / is_old() / is_archive() 的 bit 级实现
  4.4 Client 视角: GC 代码中每个 is_xxx() 的调用频率

§五 ★ 状态机 — Free→Eden→Survivor→Old→Free（不含 RETAINED）
  ❓ 每条边谁触发？有什么前置条件？
  5.1 ASCII 状态转换图（标注触发函数 + 源文件:行号）
  5.2 每条边的前置条件表（标注条件来自哪个文件的哪一行）
  5.3 年轻代 Region 数量约束（_min=102, _max=1228 — G1NewSizePercent + G1MaxNewSizePercent + G1ReservePercent）
  5.4 ★ 没有 RETAINED 类型 — _type vs _evacuation_failed 的正交论证

§六 ★★ free_list — 非循环有序双向链表
  ❓ 为什么不是循环链表？为什么不是数组？
  6.1 _head/_tail/_last 结构 + 操作复杂度（O(1) 取头, O(n) 有序插入, _last 缓存优化）
  6.2 循环链表的问题（判空歧义 + 额外计数开销）
  6.3 与 _regions[2048] 的职能分工（链表分配 / 数组寻址）

§七 ★★ JVM 初始化 — 从 mmap 到 2048 个活 Region
  ❓ 2048 个 Region 是怎么来的？
  7.1 G1CollectedHeap::initialize() 全流程
  7.2 6 个 G1RegionToSpaceMapper 的使命（为什么是 6 个？每个映射什么？）
  7.3 make_regions_available 并行化（为什么 13 个 worker？带来多少加速？）
  7.4 初始状态验证: GDB 确认全部 Free + 全部在 free_list

§八 GDB 验证 + 可证伪断言（≥7 条）
  断言 1: sizeof(HeapRegion) = 432B
  断言 2: _free_list 非循环，_head->_prev == NULL
  断言 3: HeapRegion::GrainBytes = 4194304 (4MB)
  断言 4: _num_committed = 2048
  断言 5: is_young() = (tag & 2) != 0，反汇编确认是一条 test 指令
  断言 6: 初始化后全部 Region type=Free, _top=_bottom, 全部在 free_list
  断言 7: TAMS 字段偏移: _prev_top_at_mark_start, _next_top_at_mark_start → GDB ptype /o 实测（旧文档偏移 +400/+408 不可信，必须重新验证）
  断言 8: EdenTag=2, SurvTag=3, OldTag=16 → GDB p /o HeapRegionType 验证

§九 一句话总结
  必须包含: 继承链目的 + 432B 字段分组 + TAMS 双缓冲本质 + free_list 非循环 + 状态机 RETAINED 澄清

附录 A: 相关 JVM 参数（G1NewSizePercent / G1MaxNewSizePercent / G1ReservePercent / G1HeapRegionSize）
附录 B: 与书籍对比 §1（彭成章 Ch2.1 分区的覆盖对照）
```

## 六、写作要求（★ 本文是 14 篇的标准模板）

1. **★ 每节以 "❓ 为什么..." 开头** — 这是 06 阶段所有文档的统一格式
2. **★ 字段粒度显式标注** — 每个字段标注存储粒度（字地址/字节计数/卡索引/bit/Region 指针）
3. **★ hot/cold 路径分析** — §2.5 必须给出分类表，标注每个字段的访问频率
4. **★ 设计替代分析** — 每回答一个"为什么 X"，必须追问"如果不用 X 而用 Y 会怎样"
5. **★ 跨文件约束追踪** — 状态转换的前置条件必须标注来自哪个文件哪一行
6. **★ 和书籍对比** — 对照《JVM G1 源码分析和调优》§2.1（分区概念）→ 补充"2048 推导全过程"、§2.2（停顿预测）→ 补充"年轻代约束跨文件追踪"、§2.3（卡表和位图）→ 补充"BOT 的块粒度设计和两层结构"
7. **★ 可证伪断言 ≥7 条** — 每条标注 GDB 命令 + 预期输出 + 如果错了会看到什么
8. **★ GDB 字段偏移表必须用 ptype /o 实测** — 不允许估算或假设
9. **★ 源码行号全部 grep 验证** — 每一处 `文件:行号` 引用必须对照实际源码确认

## 七、输出格式

- Markdown 文件，命名为 `01-HeapRegion.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/06-gc-memory/`
- 元信息头：标准环境 + 源文件清单 + 前置依赖(无) + 阅读收益 + "06 阶段标准模板，阅读顺序第一"的说明
