# Phase 30 doc-00 分析汇总：Region Runtime & Allocation

## 范围
Region 9 态状态机 + TLAB/PLAB/Humongous 分配路径 + Barrier + Card Table + Free List

## 源文件和符号（scout-1 定位）

### 核心文件
- heapRegion.hpp/cpp/inline.hpp (724+922+408行) — Region 状态机
- heapRegionType.hpp/cpp (189+95行) — Tag 位编码
- heapRegionManager.hpp/cpp (286+607行) — commit/uncommit/expand
- heapRegionSet.hpp/cpp/inline.hpp (245+366+151行) — Free List 管理
- heapRegionRemSet.hpp/cpp (421+921行) — 三级 PRT
- g1Allocator.hpp/cpp/inline.hpp (291+515+167行) — 三层 AllocRegion 路由
- g1AllocRegion.hpp/cpp/inline.hpp (294+393+146行) — AllocRegion CAS 分配
- g1BarrierSet.hpp/cpp (125+291行) — SATB + Card 双 Barrier
- g1CardTable.hpp/cpp (124+144行) — Card Table 操作
- dirtyCardQueue.hpp/cpp (174+373行) — 脏卡队列
- satbMarkQueue.hpp/cpp (132+358行) — SATB 队列
- memAllocator.hpp/cpp (shared, 110+460行) — 分配入口

### 关键符号
- HeapRegion::set_free()/set_eden()/set_old() (heapRegion.cpp:157-237)
- HeapRegion::hr_clear() (heapRegion.cpp:113-136)
- OtherRegionsTable::add_reference() (heapRegionRemSet.cpp:348-436)
- MemAllocator::allocate() (memAllocator.cpp:387)
- G1AllocRegion::attempt_allocation() (g1AllocRegion.inline.hpp:73)
- G1Allocator::attempt_allocation() (g1Allocator.inline.hpp:44)
- G1BarrierSet::enqueue() (g1BarrierSet.cpp:128)
- G1CardTable::mark_card_deferred() (g1CardTable.cpp:34)
- G1BarrierSet::invalidate() (g1BarrierSet.cpp:190)

## 实现细节（reader-1 提取）

### Region 状态机
- Tag 位编码: FreeTag=0, YoungMask=2, HumongousMask=4, OldMask=16
- mask 判定 O(1): is_young()=(get()&YoungMask)!=0, is_old()=(get()&OldMask)!=0
- set_eden() 断言旧值为 FreeTag, set_old() 无前置约束
- hr_clear() 清理: 类型→Free, RemSet 全清, marked_bytes→0

### 三级 PRT 切换
- 第0层: FromCardCache 快速过滤
- 第1层: _coarse_map 粗粒度检查
- 第2层: _fine_grain_regions[] 查找 PerRegionTable
- 第3层: 锁内双重检查 → SparsePRT → Fine→Coarse 退化
- Fine→Coarse 退化: _n_fine_entries == _max_fine_entries 时 delete_region_table()
- release_store 保证 PerRegionTable 发布可见性

### 分配路径
- TLAB 快速: MemAllocator::allocate() → tlab().allocate() (线程本地撞针)
- AllocRegion CAS: par_allocate() CAS 无锁分配, 失败走 attempt_allocation_locked() 锁路径
- new_alloc_region_and_allocate(): 先分配对象 → storestore 屏障 → 再发布 region 指针
- GC 期间: survivor_attempt_allocation() → CAS 快速 → MutexLockerEx(FreeList_lock) 慢速 → set_survivor_full()

### Barrier Set
- SATB enqueue: 仅 marking active 时生效, Java线程无锁本地队列
- SATB filter: 两指针对撞压缩 O(n)
- mark_card_deferred: CAS 无重试 wait-free
- invalidate: 跳过 young card → StoreLoad 屏障 → 遍历标记 dirty

## 调用链（tracer 结果关联）
- MemAllocator::allocate → attempt_allocation → attempt_allocation_locked → retire → new_alloc_region
- SATB: write_ref_field_pre → enqueue → SATBMarkQueue::enqueue → buffer满 → flush → completed list
- Card: write_ref_field_post_slow → mark_card_deferred → dirtyCardQueue::enqueue → completed list
