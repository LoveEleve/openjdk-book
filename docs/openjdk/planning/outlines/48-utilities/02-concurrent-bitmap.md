# 02. ConcurrentHashTable + BitMap — 并发数据结构

> 🔴 Deep | lock-free hash table + bit-level heap mark
> 读者处境: `String.intern("hello")`→StringTable→ConcurrentHashTable→无锁 lookup/insert(stringTable.hpp:42-44,⚠️注意 SymbolTable 是 RehashableHashtable,非本表)。G1 SATB buffer→BitMap→set bit per marked object。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/48-utilities/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"per-bucket mutex" 错误**: Bucket 是单指针,并发状态嵌在指针**低 2 位**(STATE_LOCK_BIT=0x1/STATE_REDIRECT_BIT=0x2,concurrentHashTable.hpp:76-89)——3 态 spinlock: unlocked/locked/redirect;读者只查 redirect
> - **"hash % _table_size" 错误**: 表是 2 的幂,取桶 = `hash & _hash_mask`(hpp:268-270)
> - **"CAS resize" 错误**: resize 用全局 `_resize_lock`(317-358,含 _resize_lock_owner 状态)+ 逐桶 **unzip 迁移**(表翻倍一拆二,unzip_bucket 648 起)+ 旧桶标 redirect + `set_table_from_new` release_store 发布(402-416)
> - **"双重哈希" 不存在**;grow 触发 = 查询/插入回报的链长 `loops > _grow_hint`(默认 4,hpp:209)
> - **"set_bit(atomic OR)" 错误**: `set_bit` 非原子(bitMap.inline.hpp:31-34);并发用 `par_set_bit`(CAS 循环,41-58)
> - 行号漂移: set_bit/par_set_bit 在 bitMap.inline.hpp:31-77;iterate 在 bitMap.cpp:612-630;ConcurrentHashTable 实现主要在 inline.hpp

### 1. "并发模型:读无锁、插 CAS、删锁桶、resize 逐桶迁移"

场景: 多个 Java 线程同时 `String.intern()`→StringTable→ConcurrentHashTable。并发协议:**读者只声明存在,写者负责等待**。

**结构 + 路径**(`concurrentHashTable.hpp:73-161` + `inline.hpp`):
```
Bucket(73-161): Node* volatile _first + 低 2 位状态(LOCK=0x1/REDIRECT=0x2)
  → 更新者 trylock 抢桶; 读者只检查 redirect(注释 76-83:"Reader only check for redirect")
InternalTable(168-185): 2 的幂 + _hash_mask; bucket_idx_hash = hash & mask(268-270)

读者 internal_get(inline:859-877):
  → ScopedCS(critical section, 213-229) → get_bucket(576-588, redirect 则跳新表) → get_node(620-645)
插入 internal_insert(880-939):
  → ScopedCS 内 → get_node 查重 → cas_first(new_node, first_at_start) 乐观 CAS(897-911),失败重试
删除 internal_remove(458-488):
  → get_bucket_locked(590-618, trylock+SpinPause) → 摘除 → unlock → GlobalCounter::write_synchronize() → destroy
resize: _resize_lock(317-358) → internal_grow_range(418-456, unzip 一拆二) → set_table_from_new(402-416, release_store 发布)
  → write_synchonize_on_visible_epoch(300-314, invisible_epoch 优化跳过等待)
[C++: concurrentHashTable.hpp:534行 + inline 1286行——GlobalCounter::write_synchronize = 等所有读者离开临界区(JVM 全局屏障)]
```
- 源码: `concurrentHashTable.hpp:73-161` (Bucket) + `inline.hpp:859-939` (get/insert) + `inline.hpp:402-488` (remove/resize)

- 关键设计: **插入无锁的秘密 = 只动桶头** — 新节点 CAS 到链表头,链表主体对读者不可变。**读者协议 = critical section** — 删除/resize 后 write_synchronize 等读者离开才回收节点(延迟释放)。**redirect 路标** — resize 把旧桶标记 redirect,读者立即跳新表,无需等迁移完成。grow 反馈 = 操作方回报链长。

### 2. "BitMap — 1 bit 一个标记"

场景: GC 标记/卡表/SATB → `par_set_bit(obj_addr >> LogMinObjAlignment)`→bit 对应一个对象对齐单位。

**BitMap**(`bitMap.inline.hpp:31-77` + `bitMap.cpp:612-630`):
```
set_bit(bit) (inline:31-34):    *word_addr(bit) |= bit_mask(bit)        ← 非原子,单线程
par_set_bit(bit) (inline:41-58): CAS 循环(new_val = old_val | mask)    ← 并发标记
  → 返回值 false = 别人已置(判断"首次标记")
par_clear_bit(60-77): CAS 循环清位
iterate(blk, l, r) (bitMap.cpp:612-630):
  → word 循环: rest = map(index) >> ...; rest != 0 才进内层逐位循环   ← 跳过全零 word
[C++: bitMap.cpp:702行——G1 用 prev/next 双位图(g1ConcurrentMark.hpp:306-307, 域 26 伏笔)]
```
- 源码: `bitMap.inline.hpp:31-77` (set/clear/par 版本) + `bitMap.cpp:612-630` (iterate)

- 关键设计: **word 级跳过** — iterate 对全零 64 位 word 整体跳过,稀疏位图(GC 标记 5-10% 密度)扫描成本 ≈ 已标记对象数。**set vs par_set 分工** — 单线程路径绝不付并发代价。1 bit 标记 = 8 倍空间压缩,代价是移位/掩码计算。

---

### 核心悬念

**"ConcurrentHashTable: 指针低 2 位嵌入 spinlock + CAS 桶头插入 + redirect 迁移 + GlobalCounter 等读者。BitMap: par_set_bit(CAS) + iterate 跳过零词。"** — 下一篇: Output streams + 异常。

> → [03-stream-exception.md](03-stream-exception.md)
