# PROMPT: 请撰写 05-StringTable.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

## §〇 Production Scenario

`String.intern()` 在高并发 JSON parser 中每秒调用 100K 次。StringTable 用 ConcurrentHashTable 的 Bucket 位锁 + CAS 头插法实现无全局锁并发——Thread A `cas_first(NewA, NULL)` SUCCESS, Thread B `cas_first(NewB, first)` FAIL → SpinPause retry → `internal_get` 找到 A 的 entry → `destroy_node(NewB)` → 返回同一对象。GC 通过 `weak_oops_do` 遍历 OopStorage 所有 slot → 不活的 String 置 NULL → ServiceThread 检测 `dead_factor > 0.5` → `clean_dead_entries()` → `bucket lock` → `delete_in_bucket()` → `Node::destroy_node()` → `OopStorage::release()` 归还 slot。

**反事实**：若 StringTable 用全局锁 → 100K intern/sec → 每次 lock/unlock ~50ns → 5ms/sec lock 开销 → 0.5% CPU 但仍可工作。真正的瓶颈是 resize——全局锁下 resize 阻塞所有查找数百微秒 → latency spike。ConcurrentHashTable 的 unlock→lock→redirect 机制使 resize 与查找并发。

## §一 Task + Narrative + Beginner Callouts

### Interview

"StringTable 用 `ConcurrentHashTable<WeakHandle<vm_string_table_data>>`，初始 `2^16=65536` buckets。每个 Bucket 的 `_first` 指针低 2 bit 复用位锁: bit0=LOCK_BIT (0x1), bit1=REDIRECT_BIT (0x2)。4 态: unlocked→locked→unlocked (正常插入), unlocked→locked→redirect (resize 搬迁终态)。查找 `internal_get`: `ScopedCS(thread,this)` 进入 GlobalCounter critical section → `get_bucket(hash)` → `have_redirect()`? → 转新表 → `get_node()` → `load_acquire` 遍历。插入 `internal_insert`: 循环 `ScopedCS → get_bucket → get_node → NULL → new_node(first_at_start) → cas_first(new, first) → 成功返回/失败 spin retry`。OopStorage 每个 Block 64 slot (64-bit, `BitsPerByte×BytesPerWord`)，`_active_array` 动态扩容。GC 清理: `weak_oops_do` 遍历所有 slot → `is_alive`? 否 → `*slot=NULL` → `_uncleaned_items++`。ServiceThread 调用 `check_concurrent_work()`: `dead_factor > 0.5 ∨ load_factor > 2 ∨ dead_factor > load_factor` → `trigger_concurrent_work()` → `grow()` resize 或 `clean_dead_entries()` 清理。"

### Callouts（≥7）

1. **Bucket 位锁 4 态**: unlocked(00) → locked(01) → unlocked(00) 正常操作; unlocked(00) → locked(01) → redirect(11) resize 搬迁。`is_locked() = _first & 1`, `have_redirect() = _first & 2`。
2. **GlobalCounter epoch**: 读者 `critical_section_begin/end`，写者 `write_synchronize()` 等待所有读者离开 → 安全释放旧表。不同于 RCU（无 grace period 限制）和 hazard pointer（per-thread retired list）。
3. **CAS 头插法重试**: `internal_insert` 中 `first_at_start=bucket->first()` → `lookup` 无重复 → `new_node(first_at_start)` → `cas_first(new, first_at_start)` → 成功 break/失败 spin retry。一致性靠 CAS 原子性保证。
4. **OopStorage Block**: 每 Block `BitsPerByte×BytesPerWord=8×8=64` slot (64-bit)。`_active_array` 初始 8 个 Block* 槽，翻倍扩容。`allocate()` CAS 从 `_allocation_list` head 获取空 slot。
5. **GC weak_oops_do**: `StringTable::unlink_or_oops_do(is_alive, f)` → `_weak_handles->weak_oops_do`: 遍历 active_array → 每 Block `_allocated_bitmask` → 每 slot `is_alive?` → 否 `*slot=NULL` → `_uncleaned_items++` → check_concurrent_work。
6. **ConcurrentHashTable resize**: `grow()` 分配新 InternalTable(2× buckets) → for each bucket: lock → `unzip_bucket()` 拆为两个 → `set_redirect()` 标记旧桶 → unlock。查找发现 redirect → 自动转新表查询。
7. **WeakHandle 生命周期**: `StringTableLookupOop` peek slot → `equals()` 比较 String 内容。`StringTableCreateEntry` → `WeakHandle::create(Handle)`: `get_storage()->allocate()` (OopStorage 分配 slot) + `NativeAccess<ON_PHANTOM_OOP_REF>::oop_store(oop_addr, obj())`。

## §四 Deep Dive Question Groups（≥6）

4.1 ★★★ Bucket 位锁: LOCK_BIT(0x1)+REDIRECT_BIT(0x2) 的 4 态状态机 → 何时 lock？何时 redirect？
4.2 ★★★ GlobalCounter epoch: `ScopedCS` 构造/析构 → `GlobalCounter::critical_section_begin/end` → `write_synchronize()` 如何等待所有读者？
4.3 ★★★ CAS 头插法: `internal_insert` 完整循环 → 查找重复→无→new_node→cas_first→成功/失败→spin/yield
4.4 ★★★ OopStorage Block: 64 slot/block, `_active_array` 动态翻倍, `allocate()` CAS 从 allocation list
4.5 ★★★ GC weak_oops_do→cleanup 链路: unlink_or_oops_do→weak_oops_do→置 NULL→_uncleaned_items→check_concurrent_work→clean_dead_entries→delete_in_bucket
4.6 ★★★ ConcurrentHashTable resize: grow()→lock bucket→unzip→set_redirect→unlock→旧 entry 何时删除？
4.7 ★★★ StringTable vs SymbolTable 全维对比: 存储/分配/并发/回收/GC/lookup/intern 流程/resize 方式

## §六 不要写成→应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| "Bucket 有位锁" | "`_first` 低 2 bit: `is_locked()=_first&1, have_redirect()=_first&2`. 查找: `load_acquire` 读 first→按位解析→redirect?→新表。插入: `locked=bucket->lock()`→modify→`unlock()`" |
| "GC 清理 intern strings" | "`weak_oops_do` 遍历 active_array→每 Block allocated_bitmask→`*slot=NULL`→`_uncleaned_items++`→`check_concurrent_work`: dead_factor>0.5∨load>2∨dead>load→trigger" |
| "ConcurrentHashTable 支持并发" | "三个并发原语: ① bucket lock (CAS bit0), ② CAS 头插 (cas_first), ③ GlobalCounter (epoch-based reader protection). 无 RCU, 无 hazard pointer" |

## §八 Prohibited（≥8）
❌ 不画 Bucket 位锁 4 态 → ❌ 不画 CAS insert 循环 → ❌ 不画 OopStorage Block 布局 → ❌ 不画 GC cleanup 链路 → ❌ 不对比 SymbolTable → ❌ 不提 GlobalCounter → ❌ 不画 resize unzip → ❌ 不写 GDB

## §九 Required（≥8）
✅ ★ Bucket 4 态状态机图 ✅ ★ CAS internal_insert 源码 ✅ ★ OopStorage Block 64 slot 图 ✅ ★ Mermaid: intern 全链路(GET→CAS→OopStorage→GC→cleanup) ✅ ★ SymbolTable vs StringTable 9 维对比 ✅ ★ GlobalCounter vs RCU 对比 ✅ ★ 面试 Story ✅ ★ GDB 8 断点

## §十 GDB

断言 1: create_table→`print _local_table->_log2_size` (16→65536)
断言 2: Bucket→`print bucket->_first & 3` (lock bits)
断言 3: CAS→break `internal_insert`→`print cas_first result`
断言 4: OopStorage→`print _active_array length` + `block->_data[0]`
断言 5: weak_oops_do→`break StringTable::unlink_or_oops_do`
断言 6: cleanup→`print _uncleaned_items, dead_factor`
断言 7: GlobalCounter→`break write_synchronize`
断言 8: resize→`break unzip_bucket`→`print redirect bits`

路径: `docs/05-StringTable.md`

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 04-SymbolTable 承接**: SymbolTable 不用 ConcurrentHashTable（类加载锁保护）→ 本文对比 StringTable 必须并发的原因。
2. **同组**: 04-SymbolTable（共享对比表）、07-PerfMemory（OopStorage vs PerfMemory 的 mmap 对比）。
3. **后续依赖**: 15-Thread-Creation（ServiceThread 触发 StringTable cleanup）。

---

## §四 详细答案方向（补充）

### 4.1 Bucket 位锁
锁状态: `_first & 0x3`。unlocked(00)→`bucket->lock()` CAS bit0:0→1→locked(01)→操作→`bucket->unlock()` CAS back→unlocked。resize: locked→`set_redirect()` 设 bit1→redirect(11)→永久不可变。
追问: 为什么不直接用 spin lock？→ 低 2 bit 复用节省额外状态变量 + 0 拷贝。
反事实: 如果不用位锁而用独立 Mutex → 每个 bucket 16B overhead → 65536×16=1MB → 浪费且与锁系统耦合。

### 4.2 GlobalCounter epoch
`ScopedCS(thread, this)`: 构造 `GlobalCounter::critical_section_begin(thread)` 标记读开始。析构 `critical_section_end(thread)`。写者 `write_synchronize() → 等所有在线程的 CS 结束 → 安全释放。不是 RCU（需要 grace period callback），不是 hazard pointer（per-thread retired list）。
追问: 最大读者并发量？→ 等于活跃 JavaThread 数，无硬限制。
反事实: 如果不用 GlobalCounter 而用读写锁 → 读锁争用 + 写锁会阻塞所有读 → 延迟 spike。

### 4.3 CAS 头插法
`internal_insert`: `do { ScopedCS; first=bucket->first(); lookup重复→无→new_node(first); if bucket->cas_first(new,first) break; SpinPause; } while(!bucket->is_locked()));`。`SpinPause` = x86 PAUSE 指令 + 可能 `os::naked_yield()`。
追问: 最多 retry 几次？→ 无上限但竞争窗口小（CAS+重查 lookup），实际<3次。
反事实: 如果不用 CAS 而用 bucket lock → 插入需要 lock+unlock → 两次 CAS + 可能等待 → 延迟 2×。

### 4.4 OopStorage Block
`_active_array` 初始 8 Block* slots，翻倍扩容。Block: `_data[64]` oop* slots + `_allocated_bitmask` 64-bit bitmap。`allocate()`: 从 `_allocation_list` head CAS 获取空 slot → 更新 bitmap。`release()`: 设 slot=NULL + clear bitmap bit → 归还到 `_allocation_list`。
追问: active_array 何时扩容？→ `_allocation_count` 接近 capacity → 翻倍 `allocate_new_active_array`（RCU style）。
反事实: 如果不用 OopStorage → oop 散落各处 → GC 必须扫描整个 StringTable + JNI handles → 混合代码/数据扫描 → 复杂化 GC 接口。

### 4.5 GC→cleanup 完整链路
`StringTable::unlink_or_oops_do(is_alive, f)` → `_weak_handles->weak_oops_do(&stiac)` → 遍历 active_array → 每 Block allocated_bitmask → `is_alive->do_object_b(*slot)`? 否→`*slot=NULL`→`stiac._count++`→`_uncleaned_items=count`。然后 `check_concurrent_work()`: `dead_factor=dead/total, load_factor=entries/buckets` → `dead>load ∨ load>2 ∨ dead>0.5` → `trigger_concurrent_work()` → ServiceThread 异步调用 `do_concurrent_work()` → `grow()` resize 或 `clean_dead_entries()`。
追问: 为什么不在 GC 中直接删除 Node？→ GC 时间敏感（STW），删除需 bucket lock（可能阻塞）→ 延迟到 ServiceThread 异步处理。
反事实: GC 中同步删除 → STW 延长 10-100ms → 不满足 GC pause target。

### 4.6 ConcurrentHashTable resize
`grow()`: new_table(2× buckets) → for each old_bucket: `bucket->lock()` → `unzip_bucket(old, tableA, tableB)` 按 hash 位拆 → `bucket->set_redirect()` → `bucket->unlock()`。查找自动: `get_bucket`→`have_redirect()`→`get_new_table()`→新 bucket。旧 Node 何时删除？→ `write_synchronize()` 等所有读者离开 → `delete old_table` → Node 在 `clean_dead_entries` 或 final delete_table 时释放。
追问: resize 触发条件？→ `load_factor > 2.0 ∨ rehash_warning` (bucket 链长>100)。
反事实: 如果 resize 在 safepoint（如 SymbolTable）→ STW 依赖堆大小，不可控。

### 4.7 SymbolTable vs StringTable 完整对比

| 维度 | SymbolTable | StringTable |
|------|------------|-------------|
| 存储对象 | C++ Symbol* (Metaspace) | Java String oop (GC heap) |
| 数据表 | BasicHashtable (safepoint resize) | ConcurrentHashTable (online resize) |
| 并发查找 | 是 (release/acquire) | 是 (GlobalCounter) |
| 并发插入 | 否 (classLoading_lock) | 是 (CAS 头插) |
| 删除方式 | refcount=0→buckets_unlink (safepoint) | GC weak_oops_do→ServiceThread cleanup |
| GC 关系 | 无关 | 紧密 (OopStorage 追踪, weak_oops_do 清理) |
| 扩容 | 新建表+move_to (safepoint) | lock+unzip+redirect (online) |
| 分配器 | Arena bump-pointer + block allocator | CHeapObj (Node new/delete) |
| 清理周期 | safepoint periodic | ServiceThread + GC triggered |
