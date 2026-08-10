# Prompt 00 — VirtualSpace Layer

## §〇 Production Scenario

**场景 1 — Metaspace OOM 时 /proc/self/maps 分析**
线上抛 `java.lang.OutOfMemoryError: Metaspace`，运维 `cat /proc/<pid>/maps | grep "---"` 发现大量 PROT_NONE 保留区。

分步诊断：
```bash
# Step 1: 确认 Metaspace 提交量
jcmd <pid> VM.metaspace show-loaders
# 输出: Usage: 241.3 MB, Capacity: 245.2 MB, Committed: 256.0 MB, Reserved: 1024.0 MB
# 解读: 保留了 1GB 地址空间，只提交了 256MB

# Step 2: 查看 PROT_NONE 区域（保留未提交）
cat /proc/<pid>/maps | grep "---p" | wc -l  # 32 个 4KB 区域 = 128KB
cat /proc/<pid>/maps | grep "---p" | grep "fe000000" | head -3

# Step 3: 检查 CommitLimiter 是否已命中
jcmd <pid> VM.flags -all | grep MaxMetaspaceSize
# MaxMetaspaceSize = 268435456 (256MB)，已命中上限
```

为什么 VirtualSpaceNode 的 commit/uncommit 粒度影响碎片？VirtualSpaceList 有 4 个 VirtualSpaceNode，每个 256KB。已提交 256MB 时，如果只用了 200MB，剩余的 56MB 分布在 4 个节点中。单个节点只有完全空闲才能 uncommit，碎片节点即使只有 1% 占用也不能归还。

**场景 2 — GC 间内存无法归还**
GC 后 Metaspace 使用率降了 30%，但 RSS 没有下降。

根因分析路径：
```
GC 清理 ClassLoaderData
  → Metaspace::deallocate() 标记 chunk 空闲
    → ChunkManager::return_chunk() 返还 chunk
      → VirtualSpaceNode::retire() 检查是否可以 uncommit
        → CommitLimiter::possible_expansion_words() >= commit_granule_size?
          NO → 不触发 uncommit（防止抖动）
          YES → VirtualSpace::shrink_by() → os::uncommit_memory()
```

`CommitLimiter` 的 `_commit_granule_size`（默认 64K）决定 uncommit 后可否重新 commit。如果碎片化后空闲块分散在多个 VirtualSpaceNode 中，单个节点可能永远达不到 64K 空闲阈值。

**场景 3 — large pages 启动失败回退**
`-XX:+UseLargePages` 但系统 hugetlbfs 未挂载。

回退流程 (virtualspace.cpp:150-183):
```
os::can_commit_large_page_memory() → false
  → _special = true (line 150)
  → os::reserve_memory_special() → NULL (line 164, large page not available)
  → fallback to os::reserve_memory() (line 210, regular 4K pages)
  → _special = false (line 176, 未设置的新值)
  → _alignment = MAX2(alignment, vm_page_size()) (line 133)
```

fallback 后 `_special=false` 意味着后续 `expand_by()` 会走 `os::commit_memory()` 而非直接使用已提交的大页空间。

**Counterfactual**: 如果 JVM 不做保留/提交分离（一步到位 mmap(PROT_READ|PROT_WRITE)），会浪费多少物理内存？4GB 堆 + 1GB Metaspace + 240MB CodeCache = 5.24GB 物理内存立即分配，即使实际只用了 2-3GB。

**诊断工具链**（在场景中集成）：
```bash
# strace: 跟踪 mmap/mprotect 调用
strace -e trace=mmap,mprotect,madvise -p <pid> 2>&1 | grep -E "PROT_NONE|MAP_NORESERVE"

# jcmd: 查看 Metaspace 提交量
jcmd <pid> VM.metaspace

# /proc/self/maps: 可视化保留 vs 提交
cat /proc/<pid>/maps | awk '{print $1, $2}' | sort | uniq -c
# 大量 "---p" (PROT_NONE) 行 = 保留未提交

# GDB: 检查 VirtualSpaceList 状态
gdb -p <pid> -ex "print Metaspace::_space_list->_current_virtual_space->_virtual_space._low"
```

---

## §一 Task + Narrative + Beginner Callouts

### Task
写一篇 ~2,000 行的深度技术文档，分析 HotSpot 虚拟空间管理体系：`ReservedSpace`（mmap 保留）、`VirtualSpace`（分段提交）、`VirtualSpaceList`（链表管理）、`VirtualSpaceNode`（节点级 commit 控制）。每个技术断言标注精确 `file:line`。

### Narrative 主线
从内核 `mmap(MAP_NORESERVE)` 的保留语义出发 → `ReservedSpace::initialize()` 的二级分配策略（large pages → regular pages）→ `VirtualSpace::expand_by()` 的 `commit_memory()` 逐页推进 → `VirtualSpaceList::create_new_virtual_space()` 的链式扩容 → `VirtualSpaceNode::take_from_committed()` 的 alloc + padding → `/proc/self/maps` 可视化验证。

### 7 个 Beginner Callout 框
1. **什么是保留/提交分离** — `mmap(NULL, size, PROT_NONE, MAP_NORESERVE)` 只占地址空间不占物理页。类比：预订了 100 个车位（保留），但只给 10 个车位铺了地面（提交）。virtualspace.cpp:210
2. **为什么需要 granularity** — os::vm_allocation_granularity() (通常 64K) 是 mmap 的对齐边界。小于 granularity 的 mmap 会被 OS 自动对齐，导致实际保留大于请求。
3. **VirtualSpace 三区域模型** — low(已提交低端) / high(已提交高端) / boundary(保留边界)。_low ~ _high 可读写，_high ~ _high_boundary 是 PROT_NONE。
4. **VirtualSpaceList 是什么** — Metaspace 的 VirtualSpace 链表，每个节点默认 256KB。每次 Metaspace 需要新空间时创建新节点。virtualSpaceList.hpp:42-44
5. **commit vs pre_touch** — commit=mprotect(PROT_READ|PROT_WRITE) 改权限允许访问。pre_touch=逐页写入触发 page fault 建立页表映射，避免后续首次访问时的 fault 延迟。
6. **ReservedHeapSpace 的 noaccess_prefix** — 压缩指针的保护页（通常 4KB-64KB），放在 heap 基址前 PROT_NONE。NULL 解引用时触发 SIGSEGV 而非静默访问 heap 偏移 0 位置。virtualspace.cpp:310-340
7. **_special 标志何时为 true** — ① 大页模式下 `!os::can_commit_large_page_memory()` 为 true (line 150)；② 文件映射堆（`_fd_for_heap != -1`，line 240-242）。special=true 的 VirtualSpace 不调用 os::commit_memory()/uncommit_memory()。

**额外概念说明**（在正文中随代码嵌入，非独立 callout）：
- **vs_word_size**: Metaspace 中使用 "word" (字，8 字节) 作为单位，virtualSpaceList.cpp:90: `create_new_virtual_space(vs_word_size)`
- **alignment_hint**: os::reserve_memory() 的 alignment 参数只是 hint（建议），OS 可能忽略。virtualspace.cpp:187-189 注释说明 "Optimistically assume that the OSes returns an aligned base pointer"
- **MAP_NORESERVE**: Linux 特有标志，不预分配 swap 空间。mmap 成功但不保证后续写入成功（OOM killer 在 page fault 时介入）

---

## §二 Standard Environment

### Source Roots
- `make/hotspot/lib/CompileJvm.gmk:153` — BUILD_LIBJVM（本文档源代码统一编译入口）
- `src/hotspot/share/memory/virtualspace.hpp:241` — ReservedSpace + VirtualSpace 类定义
- `src/hotspot/share/memory/virtualspace.cpp:1580` — 全部实现
- `src/hotspot/share/memory/metaspace/virtualSpaceList.hpp:169` — VirtualSpaceList
- `src/hotspot/share/memory/metaspace/virtualSpaceList.cpp:475` — VirtualSpaceList 实现
- `src/hotspot/share/memory/metaspace/virtualSpaceNode.hpp:167` — VirtualSpaceNode
- `src/hotspot/share/memory/metaspace/virtualSpaceNode.cpp:662` — VirtualSpaceNode 实现
- `src/hotspot/share/memory/metaspace/metaspaceCommon.hpp:132` / `:213` — 公共定义

### Build Command
```bash
bash configure --with-debug-level=slowdebug --with-jvm-features=cds
make hotspot
```

### Binary Path
`build/linux-x86_64-server-slowdebug/jdk/lib/server/libjvm.so`

### Syscall 速查表
| syscall | man | 使用文件 | 用途 |
|---------|-----|---------|------|
| mmap(MAP_NORESERVE) | man 2 mmap | virtualspace.cpp:210 | 保留地址空间 |
| mmap(MAP_ANONYMOUS\|MAP_PRIVATE) | man 2 mmap | virtualspace.cpp:210 | 匿名保留 |
| munmap | man 2 munmap | virtualspace.cpp:88-95 | 释放保留 |
| mprotect(PROT_NONE) | man 2 mprotect | virtualspace.cpp:324 | 保护页 |
| mprotect(PROT_READ\|PROT_WRITE) | man 2 mprotect | os_linux.cpp commit | 提交页 |
| madvise(MADV_DONTNEED) | man 2 madvise | os_linux.cpp uncommit | 归还物理页 |
| mincore | man 2 mincore | 诊断 | 检查页驻留 |

---

## §三 Source Files Table

| File | Full Path | Lines | Core Constructs | Role |
|------|-----------|:-----:|----------------|------|
| virtualspace.hpp | src/hotspot/share/memory/virtualspace.hpp | 241 | ReservedSpace, ReservedHeapSpace, ReservedCodeSpace, VirtualSpace | 类定义 |
| virtualspace.cpp | src/hotspot/share/memory/virtualspace.cpp | 1580 | ReservedSpace::initialize, ReservedSpace::release, ReservedHeapSpace::try_reserve_heap, VirtualSpace::initialize_with_granularity, VirtualSpace::expand_by, VirtualSpace::shrink_by | 内存保留/提交实现 |
| virtualSpaceList.hpp | src/hotspot/share/memory/metaspace/virtualSpaceList.hpp | 169 | VirtualSpaceList, create_new_virtual_space, retire_current_virtual_space, get_new_chunk | 虚拟空间链表管理 |
| virtualSpaceList.cpp | src/hotspot/share/memory/metaspace/virtualSpaceList.cpp | 475 | VirtualSpaceList::create_new_virtual_space, VirtualSpaceList::retire_current_virtual_space, VirtualSpaceList::contains | 链表操作实现 |
| virtualSpaceNode.hpp | src/hotspot/share/memory/metaspace/virtualSpaceNode.hpp | 167 | VirtualSpaceNode, OccupancyMap, take_from_committed, allocate_padding_chunks | 节点级 commit 控制 |
| virtualSpaceNode.cpp | src/hotspot/share/memory/metaspace/virtualSpaceNode.cpp | 662 | VirtualSpaceNode::initialize, VirtualSpaceNode::take_from_committed, VirtualSpaceNode::get_top, VirtualSpaceNode::retire, VirtualSpaceNode::committed_words | 节点实现 |
| metaspaceCommon.hpp | src/hotspot/share/memory/metaspace/metaspaceCommon.hpp | 132 | CommitLimiter, commit_granule_size, Settings 常量 | 公共设置 |
| metaspaceCommon.cpp | src/hotspot/share/memory/metaspace/metaspaceCommon.cpp | 213 | CommitLimiter::possible_expansion_words, CommitLimiter::committed_bytes | 提交限制器 |

---

## §四 Deep Dive Question Groups（≥6 组，每组含 counterfactual）

### 4.1 ReservedSpace 的三级分配策略

Q1: `ReservedSpace::initialize()` (virtualspace.cpp:122-243) 为什么先尝试 `os::reserve_memory_special()`（line 164），失败后才回退 `os::reserve_memory()`（line 210）？两种路径的差异？

Q2: `os::reserve_memory(size, NULL, alignment, _fd_for_heap)` (line 210) 底层调用 `mmap(NULL, size, PROT_NONE, MAP_NORESERVE|MAP_ANONYMOUS|MAP_PRIVATE)`。为什么用 `PROT_NONE` 而非 `PROT_READ|PROT_WRITE`？

Q3: `failed_to_reserve_as_requested()` (line 99-120) 如何检测 OS 忽略了请求地址？压缩指针场景下为什么必须精确地址？

**Counterfactual**: 如果不用 MAP_NORESERVE，一次 mmap 直接提交所有物理页——Java 堆 4GB 会立即消耗 4GB 物理内存，即使 heap 只用了 200MB。

### 4.2 VirtualSpace 的分段提交状态机

Q1: `VirtualSpace::expand_by()` 如何将 `_high` 指针向上推进？每次 commit 的最小粒度是多少？

Q2: `VirtualSpace::initialize_with_granularity()` 中的 `max_commit_granularity` 参数的作用？为什么要限制单次 commit 的最大粒度？

Q3: `_special=true` 的 VirtualSpace 为什么不调用 `os::commit_memory()`（line:153）？`_special` 标志在 VirtualSpace 生命周期中的语义？

**Counterfactual**: 如果没有 commit_granularity 限制，一次 expand_by(1GB) 调用 `mprotect` 1GB 范围——OS 需要建立 256K 个页表条目，阻塞时间 > 1ms。

### 4.3 VirtualSpaceList 的链式扩容

Q1: `VirtualSpaceList::create_new_virtual_space()` (virtualSpaceList.cpp) 分配新 VirtualSpaceNode 的大小如何决定？为什么默认 `VirtualSpaceSize = 256 * K`？

Q2: `VirtualSpaceList::retire_current_virtual_space()` 何时触发？退役后 `_current_virtual_space` 如何处理？

Q3: `_envelope_lo` / `_envelope_hi` (virtualSpaceList.hpp:65-68) 的快速排除范围优化如何工作？

**Counterfactual**: 如果 VirtualSpaceList 用单个大 VirtualSpace（如 64MB）而非 256KB 节点链表——扩容时一次 commit 64MB，即使用户只用 2MB，浪费 62MB 物理内存。

### 4.4 VirtualSpaceNode 的 commit 粒度与碎片

Q1: `VirtualSpaceNode::take_from_committed()` 如何从已提交区域分配？`_top` 指针移动逻辑？

Q2: `VirtualSpaceNode::allocate_padding_chunks_until_top_is_at()` 的 padding chunk 是什么？为什么需要填充到对齐边界？

Q3: `OccupancyMap` 的作用？如何追踪 VirtualSpaceNode 中每个 chunk 的使用情况？

**Counterfactual**: 如果 VirtualSpaceNode 不维护 OccupancyMap——无法判断哪些 chunk 可以 uncommit，导致内存泄漏。

### 4.5 CommitLimiter 的全局提交上限

Q1: `CommitLimiter::possible_expansion_words()` (metaspaceCommon.cpp) 如何计算还能提交多少？`_commit_granule_size` 的作用？

Q2: CommitLimiter 的 `cap` 与 `-XX:MaxMetaspaceSize` 的关系？当达到 cap 时的行为？

Q3: commit 上限检查发生在哪一层？VirtualSpaceNode 还是 VirtualSpaceList？

**Counterfactual**: 如果没有 CommitLimiter——`-XX:MaxMetaspaceSize=256m` 可能被实际提交到 512MB，因为 commit 粒度 > 分配粒度。

### 4.6 内存归还路径

Q1: `VirtualSpace::shrink_by()` 调用 `os::uncommit_memory()` → `mmap(MAP_FIXED|MAP_NORESERVE)` 重映射为 PROT_NONE。为什么不直接用 `madvise(MADV_DONTNEED)`？

Q2: Metaspace 什么时候触发 shrink？GC 后 free 的 class metadata 如何通知 VirtualSpaceNode？

Q3: 为什么 `CommitLimiter::possible_expansion_words()` 可能阻止 uncommit？碎片如何阻止归还？

**Counterfactual**: 如果 uncommit 用 `madvise(MADV_DONTNEED)` 而非重新 mmap——虚拟地址范围保持不变，但 HugeTLB 大页场景下 MADV_DONTNEED 对大页无效（kernel 不会拆分大页）。

### 4.7 ReservedHeapSpace 的压缩指针保护

Q1: `ReservedHeapSpace::establish_noaccess_prefix()` (virtualspace.cpp:314-340) 如何在堆基址前设置保护页？

Q2: `_noaccess_prefix` 的大小如何计算（line 310-312）？为什么用 `lcm(os::vm_page_size(), alignment)`？

Q3: 保护页设置后 `_base += _noaccess_prefix; _size -= _noaccess_prefix;` (line 337-338) 如何调整 ReservedSpace 的边界？

**Counterfactual**: 如果没有 noaccess_prefix——压缩指针的 NULL 编码可能落入有效地址空间，`if (obj != NULL)` 检查失效。

### 4.8 大页兼容性路径

Q1: `os::can_commit_large_page_memory()` 的返回值如何影响 `_special` 标志 (virtualspace.cpp:150)？不同 OS/内核版本的行为差异？

Q2: 当 `_special=true` 时，为什么 `os::reserve_memory_special()` 返回的地址必须对齐到 large page size？assert 检查在何处 (virtualspace.cpp:172-175)？

Q3: `UseLargePages && !FLAG_IS_DEFAULT(UseLargePages)` 的大页显式设置 vs 默认行为的日志区别 (virtualspace.cpp:153-158)？

**Counterfactual**: 如果 JVM 不区分 special/regular 路径——所有平台统一 mmap，Linux hugetlbfs 需要显式 `mount -t hugetlbfs` 才能使用，但 mmap 不会自动回退到普通页导致启动失败。

### 4.9 ReservedSpace 的分割与子空间

Q1: `ReservedSpace::first_part()` (virtualspace.cpp:245-256) 的 `split` 参数含义？`os::split_reserved_memory()` 的实现？

Q2: `first_part()` 和 `last_part()` 切割后两个 ReservedSpace 共享同一底层 mmap 区域吗？生命周期管理？

Q3: CodeCache 的 `ReservedCodeSpace` (virtualspace.hpp:132-136) 为什么要加 `PROT_EXEC` 权限？`MAP_JIT` (macOS) 的区别？

**Counterfactual**: 如果不用 first_part/last_part 切割，每个子空间独立 mmap——32-bit 地址空间碎片严重，Heap/CodeCache/Metaspace 可能无法分配到期望地址。

---

## §五 Article Structure

建议文档按以下章节组织（共 ~2000 行）：

```
§〇 生产场景 — /proc/self/maps 中的 PROT_NONE + Metaspace OOM 诊断
  ├─ 场景 1: Metaspace OOM — 保留 1GB 提交 256MB 的根因
  ├─ 场景 2: RSS 不降 — CommitLimiter 防抖动阻止 uncommit
  ├─ 场景 3: large pages 回退 — _special 标志切换路径
  └─ 诊断工具链: strace + jcmd + GDB + /proc/self/maps
§一 Reserve → Commit → Use 三层模型 — 架构总览 + Mermaid 序列图
  ├─ ASCII 内存布局图: ReservedSpace::_base / _noaccess_prefix / _size
  ├─ 三层抽象: ReservedSpace(保留) → VirtualSpace(提交) → User(使用)
  └─ 关键字段表: _base/_size/_alignment/_special/_noaccess_prefix
§二 Source Files Table + Standard Environment
§三 ReservedSpace 内核 — initialize() 源码全路径
  ├─ 三级回退: large-special → requested-address → random-address
  ├─ os::reserve_memory() 的参数语义 (MAP_NORESERVE|PROT_NONE)
  ├─ release() 的 special vs regular 路径分支
  └─ first_part()/last_part() 切割语义
§四 VirtualSpace 状态机 — expand_by()/shrink_by()
  ├─ 三区域模型: low_boundary / low / high / high_boundary
  ├─ expand_by() 的 commit_granularity 分步循环
  ├─ shrink_by() → os::uncommit_memory() → madvise(MADV_DONTNEED)
  └─ _special=true 的独占路径（不调用 commit/uncommit）
§五 VirtualSpaceList — 链式扩容
  ├─ 256KB 节点大小的设计理由
  ├─ create_new_virtual_space() 分配流程
  ├─ retire_current_virtual_space() 退役机制
  └─ _envelope 快速排除范围优化
§六 VirtualSpaceNode — 节点级 commit 控制
  ├─ take_from_committed() 的 _top 推进
  ├─ allocate_padding_chunks_until_top_is_at() 填充机制
  ├─ OccupancyMap 比特位映射
  └─ committed_words()/free_words_in_vs() 统计
§七 CommitLimiter — 全局提交上限
  ├─ possible_expansion_words() 计算公式
  ├─ cap 与 MaxMetaspaceSize 关系
  └─ 防抖动: _commit_granule_size 阻止频繁 uncommit/recommit
§八 内存归还 — 从 shrink 到内核
  ├─ VirtualSpace::shrink_by() → os::uncommit_memory()
  ├─ mmap(MAP_FIXED|MAP_NORESERVE) PROT_NONE 重新映射
  ├─ 与 madvise(MADV_DONTNEED) 的对比
  └─ 大页 uncommit 限制（HugeTLB 不支持 MADV_DONTNEED）
§九 ReservedHeapSpace — 压缩指针保护页
  ├─ establish_noaccess_prefix() 源码
  ├─ implicit null check 与保护页的关系
  └─ OopEncodingHeapMax 地址范围约束
§十 ReservedCodeSpace — JIT 代码页
  ├─ executable=true 的 mmap(PROT_EXEC|PROT_READ) vs PROT_READ|PROT_WRITE
  └─ macOS MAP_JIT 特殊处理
§十一 Counterfactual 对比表 — 8 个设计决策
  ├─ 保留/提交分离 vs 一步到位
  ├─ 分步提交 vs 批量提交
  ├─ 链表节点 vs 单个大区域
  ├─ noaccess_prefix 存在 vs 不存在
  ├─ special vs regular 路径
  ├─ CommitLimiter vs 不限制
  ├─ uncommit(mmap) vs madvise(DONTNEED)
  └─ split vs 独立 mmap
§十二 GDB 验证 — 8 断言
§十三 边缘场景 — 大页失败 / 地址空间碎片 / 并发 commit / HugeTLB 限制
§十四 Cross-Reference + man 索引
```

---

## §六 Writing Requirements

| 不要写成 | 应该写成 |
|---------|---------|
| "ReservedSpace::initialize() 调用 os::reserve_memory()" 这种机械调用描述 | 解释 init 的分层回退设计：large page special → requested address → random address，Why 每一层？virtualspace.cpp:122-243 |
| "VirtualSpace 有 _low / _high 两个指针" 的值罗列 | 解释 _low/_high 作为提交边界的语义：_low 以下未提交，_high 以上未提交，_low~_high 已提交可读写 |
| "expand_by 调用 commit_memory" 的 shallow 描述 | expand_by 的粒度控制：每次 commit 不超过 max_commit_granularity，避免单次 mprotect 过大阻塞 |
| "VirtualSpaceList 是个链表" | 解释为什么用 256KB 节点链表：O(1) 退役当前节点、细粒度 commit 控制、扩容无需移动已有节点 |
| "OccupancyMap 记录使用情况" | OccupancyMap 的比特位映射：每个 chunk (2K/4K) 占 1 bit，512 bytes 可覆盖 1MB VirtualSpace 的 512 个 chunk |
| "CommitLimiter 限制提交量" | CommitLimiter 的 granularity 语义：_commit_granule_size (默认 64K) 决定 uncommit 后可否重新 commit，低于粒度不归还 |
| "uncommit 释放物理内存" | uncommit → mmap(MAP_FIXED\|MAP_NORESERVE) PROT_NONE 的效果 vs madvise(MADV_DONTNEED)——两者释放物理页但前者改变 VMA 权限，后者保留可读写权限 |
| "shrink_by 减少 committed_size" | shrink_by 后如果实际提交量低于 _commit_granule_size 则不会调用 uncommit——CommitLimiter 的防止抖动设计 |
| "large pages 路径 special=true" | special=true 的三个影响：① 不可分步 commit（一次全部提交）；② 不可 uncommit（不支持 madvise 大页归还）；③ 内存不可 swap |

---

## §七 Output Format

- 标题格式：`# 00-VirtualSpace Layer — 从 mmap 保留到分页提交`
- 每章开头有 3-5 行的 What/Why 概述
- 每段源码引用格式：`virtualspace.cpp:210` — `base = os::reserve_memory(size, NULL, alignment, _fd_for_heap)`
- Mermaid 序列图：Reserve → Commit → Expand → Use 的数据流
- ASCII 内存布局图：ReservedSpace 的 _base / _noaccess_prefix / _size 关系
- 文档末尾附 Cross-Reference 表

---

## §八 Prohibited（≥8）

1. 不要写成 mmap/mprotect 的手册翻译——要解释 HotSpot 为什么选择这些参数组合
2. 不要忽略 _special 标志的所有代码路径影响（commit/uncommit/release/expand/shrink）
3. 不要跳过 ReservedHeapSpace 的压缩指针保护页（_noaccess_prefix）
4. 不要省略 CommitLimiter 的防抖动设计（_commit_granule_size 的配置和影响）
5. 不要只描述 commit 路径而忽略 uncommit/shrink 路径
6. 不要忽略 VirtualSpaceNode 的 padding chunk 机制（对齐到 chunk size 的语义）
7. 不要遗漏 /proc/self/maps 的验证方法（PROT_NONE "---p" 区域的诊断意义）
8. 不要用 "OS 相关函数" 替代具体的 mmap/mprotect/madvise 系统调用名
9. 不要在 counterfactual 中使用泛泛的 "可能更好/更差"——要给出量化对比（内存节省量、延迟增量）
10. 不要跳过 VirtualSpaceList 的 _envelope 快速排除优化
11. 不要把 ReservedSpace / VirtualSpace 和 VirtualSpaceList / VirtualSpaceNode 混为一谈——前者是通用内存管理，后者是 Metaspace 专用封装
12. 不要忽略 ReservedCodeSpace 的 PROT_EXEC 权限（JIT 编译代码需要可执行页）
13. 不要使用"自动"或"托管"等模糊词汇描述内存管理——务必明确是 OS 内核行为还是 JVM 主动调用
14. 不要跳过 os::reserve_memory() 和 os::reserve_memory_special() 在 Linux/macOS/Windows 三个平台的实现差异——至少标注 Linux 路径的 file:line

---

## §九 Required（≥8）

1. ReservedSpace::initialize() 源码全路径展开（含 large pages → regular 回退）
2. VirtualSpace::expand_by() 的 commit_granularity 循环分析
3. VirtualSpaceList::create_new_virtual_space() 的扩容决策树
4. VirtualSpaceNode::take_from_committed() 的 _top 推进 + padding 分配
5. CommitLimiter::possible_expansion_words() 的计算公式
6. ReservedHeapSpace::establish_noaccess_prefix() 的保护页设置源码
7. 至少 1 个 Mermaid 序列图（Reserve→Commit→Expand→Use 全链路）
8. Counterfactual 对比表（≥6 个设计决策，每个含 file:line + 量化对比）
9. /proc/self/maps 解读示例（展示 PROT_NONE vs rwxp 区域）
10. 每个关键函数至少有 WHY 分析（不超过 3 句）
11. ReservedSpace::first_part()/last_part() 的切割机制（含 split/realloc 语义）
12. os::reserve_memory() 底层 mmap 参数详解（MAP_NORESERVE/MAP_ANONYMOUS/MAP_PRIVATE/PROT_NONE 的选择理由）

---

## §十 GDB Verification（≥7）

```gdb
# 1. 检查 ReservedSpace 的保留范围
print Metaspace::_class_space_list->_virtual_space_list->_rs
# 期望输出: _base = 0x7f..., _size = 256K

# 2. 检查 VirtualSpace 的提交边界
print Metaspace::_class_space_list->_virtual_space_list->_virtual_space._low
print Metaspace::_class_space_list->_virtual_space_list->_virtual_space._high
# 期望: low <= high, high - low = committed_size

# 3. 检查 VirtualSpaceNode 的 _top 指针
print Metaspace::_class_space_list->_current_virtual_space->_top
# 期望: low <= _top <= high

# 4. 检查 CommitLimiter 的当前提交量
print metaspace::CommitLimiter::committed_bytes()
# 期望: committed <= MaxMetaspaceSize

# 5. 检查 VirtualSpaceList 的节点数量
print Metaspace::_class_space_list->_virtual_space_count
# 期望: count >= 1

# 6. 检查 OccupancyMap 的比特位
print Metaspace::_class_space_list->_virtual_space_list->_occupancy_map._map[0]
# 期望: uint32_t bitmap

# 7. /proc/self/maps 验证
shell cat /proc/<pid>/maps | grep "---p" | head -5
# 期望: 看到 PROT_NONE 保护区域（---p 权限位为 0）

# 8. 检查 _special 标志
print Metaspace::_class_space_list->_virtual_space_list->_virtual_space._special
# 期望: false (非大页模式)
```

---

## §十一 与 README 和同组 prompt 的连续性

### 与 README 的关系
- README 定义本文档为 doc-00，覆盖 VirtualSpace Layer（4 源文件, ~3,300 行）
- 本文档是 Phase 27 三层分配器的第一层：VirtualSpace Layer (本文) → Arena & ResourceArea (prompt-01) → Metaspace Internals (prompt-02)

### 与同组 prompt 的边界
- **prompt-01 (Arena & ResourceArea)**: 在 VirtualSpace 之上构建 Arena chunk 分配器
- **prompt-02 (Metaspace Internals)**: 使用 VirtualSpaceList/VirtualSpaceNode 进行 Metachunk 级别的块分配

### 交叉引用
- Pre-read: `libjvm-analysis/01-jvm-startup/03-Metaspace.md` — Metaspace 初始化上下文
- Pre-read: `libjvm-analysis/01-jvm-startup/02-G1-Heap-Startup.md` — ReservedHeapSpace 被 G1 使用的上下文
- Post-read: prompt-01 (Arena & ResourceArea) — 本层的上层分配器使用者
- Post-read: prompt-02 (Metaspace Internals) — 使用 VirtualSpaceList/VirtualSpaceNode 进行 Metachunk 块分配
- man 2 mmap, man 2 mprotect, man 2 madvise, man 2 munmap, man 2 mincore, man 5 proc

### 与旧文档的互补关系
- `libjvm-analysis/01-jvm-startup/03-Metaspace.md` 覆盖了 Metaspace "上层"（initialize/allocate/deallocate），本文档覆盖"下层"虚拟空间管理。两层互补：上层调用 VirtualSpaceList::get_new_chunk()，下层实现 VirtualSpaceNode::take_from_committed()
- G1 Heap 文档使用 `ReservedHeapSpace` 但不解释 `try_reserve_heap()` 的 4 次重试逻辑——本文档补充这部分

### 写作注意事项
- 区分两个层次的 VirtualSpace：通用的 `memory/virtualspace.hpp` (ReservedSpace/VirtualSpace) 和 Metaspace 专用的 `memory/metaspace/virtualSpaceList.hpp` (VirtualSpaceList/VirtualSpaceNode)
- 每个 syscall 名称后标注 man 章节（如 mmap(2)）
- 内存大小的单位统一：JVM 内用 words (8 bytes)，OS 调用用 bytes，文档中交替使用时注明换算关系
- 所有指针值在文档中用 `0x7f...` 格式，与 GDB 输出保持一致

### 质量自检清单（文档生成后验证）

文档完成后逐项确认：
1. [ ] VirtualSpaceList::create_new_virtual_space() 源码展示 ≥ 30 行
2. [ ] /proc/self/maps 示例输出有实际地址和权限位
3. [ ] 每个 counterfactual 末尾有量化对比数据
4. [ ] man 手册引用在正文中 inline 标注（非仅 §二 速查表）
5. [ ] GDB 输出示例与实际 libjvm.so 的 DWARF 符号名一致
6. [ ] Mermaid 序列图至少有 4 条生命线（Caller→ReservedSpace→os_reserve_memory→Kernel）
7. [ ] 边缘场景 section 至少 3 个场景含触发条件和 JVM 处理方式
8. [ ] Counterfactual 对比表至少 8 个设计决策，含当前实现 vs 替代方案 + 量化对比数据
