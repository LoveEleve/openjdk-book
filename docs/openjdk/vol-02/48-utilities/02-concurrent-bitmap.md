# 02. ConcurrentHashTable + BitMap — 无锁哈希表与位图

> **前置依赖**:[05-cpu-primitives/01 — 原子操作与内存序](openjdk/vol-02/05-cpu-primitives/01-atomic-and-memory-order.md):CAS 与屏障——本篇的并发基础
> → **后续**:[03 — 输出流与异常系统](03-stream-exception.md)
> 关联域: 25-gc(位图标记)、26-g1(prev/next 双位图)、19-sync、06-oops(StringTable;注意 SymbolTable 是另一张表 RehashableHashtable)

## String.intern 的战场:一张"无锁优先"的哈希表

`String.intern("hello")` 在任意多个线程里同时发生——StringTable 底层是 `ConcurrentHashTable`(stringTable.hpp:42-44,concurrentHashTable.hpp:534 行 + inline 实现 1286 行)。它敢叫 Concurrent,靠的不是一把大锁,而是一套精细的分工:**读无锁、插入无锁(CAS)、删除锁桶、resize 逐桶迁移**。这篇拆它的并发模型,然后看位图 BitMap——JVM 里最省空间的标记结构。

## 1. 结构:一个指针里藏着锁

### 1.1 场景:Bucket 到底是什么

哈希表的桶,在 ConcurrentHashTable 里是一个**单指针**——而并发控制的状态就嵌在这指针里:

```cpp
// concurrentHashTable.hpp:76-89(注释与常量,逐字)
    // Embedded state in two low bits in first pointer is a spinlock with 3
    // states, unlocked, locked, redirect. You must never busy-spin on trylock()
    // or call lock() without _resize_lock, that would deadlock. Redirect can
    // only be installed by owner and is the final state of a bucket.
    // The only two valid flows are:
    // unlocked -> locked -> unlocked
    // unlocked -> locked -> redirect
    // Locked state only applies to an updater.
    // Reader only check for redirect.
    Node * volatile _first;

    static const uintptr_t STATE_LOCK_BIT     = 0x1;
    static const uintptr_t STATE_REDIRECT_BIT = 0x2;
    static const uintptr_t STATE_MASK         = 0x3;
```

`_first` 是指向链表头节点的指针,它的**低 2 位**是状态机:unlocked / locked / **redirect**(重定向到新表)。三个用途一目了然:更新者用 trylock 抢桶;读者**只检查 redirect**;resize 完成后把旧桶标记成 redirect,读者看到就跳去新表——这是无锁读者与 resize 协作的接口。

表本身是 2 的幂结构(concurrentHashTable.hpp:164-167 注释:"Table is always a power of two... Use masking of hash for bucket index"),取桶就是掩码:

```cpp
// concurrentHashTable.hpp:268-270(逐字)
  static size_t bucket_idx_hash(InternalTable* table, const uintx hash) {
    return ((size_t)hash) & table->_hash_mask;
  }
```

**关键设计 (斜体)**: *为什么把锁嵌进指针而不是给每个桶一个 Mutex?两个理由:① 内存——桶只有一个指针大小,128K 个桶就是 1MB 的紧凑数组,任何额外字段都是翻倍;② redirect 状态——锁还能当"路标"用,这是独立锁对象做不到的。哈希表的大小按 2 的幂 + 掩码取桶,代价是 hash 质量必须好(hash 的低位分布均匀),换来的是 resize 时"一桶拆两桶"的简单迁移(第 3 节)。*

## 2. 读与插:两条无锁路径

### 2.1 场景:查询和插入为什么可以不用锁

读者路径 `internal_get`(concurrentHashTable.inline.hpp:859-877):

```cpp
// concurrentHashTable.inline.hpp:859-877(截取核心,逐字)
  internal_get(Thread* thread, LOOKUP_FUNC& lookup_f, bool* grow_hint)
{
  bool clean = false;
  size_t loops = 0;
  VALUE* ret = NULL;

  const Bucket* bucket = get_bucket(lookup_f.get_hash());
  Node* node = get_node(bucket, lookup_f, &clean, &loops);
  if (node != NULL) {
    ret = node->value();
  }
  if (grow_hint != NULL) {
    *grow_hint = loops > _grow_hint;
  }

  return ret;
}
```

三步:`get_bucket`(576-588)取桶——**发现 redirect 就换新表重取**;`get_node`(620-645)遍历链表比对;附带统计链长,超过 `_grow_hint`(默认 4,hpp:209)就在 `*grow_hint` 里报告"该扩容了"。

插入路径 `internal_insert`(880 起)更关键——新节点用 **CAS 挂到桶头**,失败就重试:

```cpp
// concurrentHashTable.inline.hpp:897-911(截取核心,逐字)
      if (old == NULL) {
        // No duplicate found.
        if (new_node == NULL) {
          new_node = Node::create_node(value_f(), first_at_start);
        } else {
          new_node->set_next(first_at_start);
        }
        if (bucket->cas_first(new_node, first_at_start)) {
          callback(true, new_node->value());
          new_node = NULL;
          ret = true;
          break; /* leave critical section */
        }
        // CAS failed we must leave critical section and retry.
        locked = bucket->is_locked();
```

`cas_first`(inline:140-153)内部就是 `Atomic::cmpxchg`。为什么插入可以无锁?因为**新节点永远插在桶头,链表其余部分对读者不可变**——读者遍历时看到的要么是旧链要么是新链,绝无中间态。插入和查询都被 `ScopedCS`(213-229)包着:进入时 `GlobalCounter::critical_section_begin`、离开时 `critical_section_end`——这是 JVM 的"读者计数"机制,为第 3 节的安全回收铺路;两者还各自回报链长(`loops > _grow_hint`,870-872 与 937-939 行)决定是否触发 grow。

**关键设计 (斜体)**: *"插入只动桶头"是这整张表无锁性能的来源:读者从头遍历、插入者 CAS 换头,两者都只碰不可变的链表主体——除了桶头那个指针,没有任何共享可写状态。代价是链表顺序与插入序相反(后进先出),以及链长的反馈要由操作方顺手回报(grow_hint)。JVM 把"并发正确性"拆成最小协议:读者声明自己的存在(critical section),写者决定何时等待(见下节)。*

## 3. 删除与 resize:必须等读者的地方

### 3.1 场景:链表中间摘节点,读者还在遍历

删除 `internal_remove`(458-488)不能 CAS 了事——要改链表中间节点的 next 指针,而读者可能正停在那:

```cpp
// concurrentHashTable.inline.hpp:458-488(截取核心,逐字)
  internal_remove(Thread* thread, LOOKUP_FUNC& lookup_f, DELETE_FUNC& delete_f)
{
  Bucket* bucket = get_bucket_locked(thread, lookup_f.get_hash());
  assert(bucket->is_locked(), "Must be locked.");
  Node* const volatile * rem_n_prev = bucket->first_ptr();
  Node* rem_n = bucket->first();
  bool have_dead = false;
  while (rem_n != NULL) {
    if (lookup_f.equals(rem_n->value(), &have_dead)) {
      bucket->release_assign_node_ptr(rem_n_prev, rem_n->next());
      break;
    } else {
      rem_n_prev = rem_n->next_ptr();
      rem_n = rem_n->next();
    }
  }

  bucket->unlock();
  ...
  // Publish the deletion.
  GlobalCounter::write_synchronize();
  delete_f(rem_n->value());
  Node::destroy_node(rem_n);
```

`get_bucket_locked`(590-618)在临界区内 trylock 桶锁,失败则 SpinPause/`os::naked_yield` 重试。摘除节点后,`bucket->unlock()`,然后 **`GlobalCounter::write_synchronize()` 等待所有读者离开临界区**,最后才 `destroy_node` 真正释放——读者可能在遍历中被摘掉的节点,write_synchronize 保证此刻已无人再读它。

resize 是同一哲学的大规模版本。过程:拿全局 `_resize_lock`(317-358,含 `_resize_lock_owner` 状态解决"互斥锁+safepoint 丢锁"问题)→ 建新表 → `internal_grow_range`(418-456)逐桶迁移——表翻倍,一个旧桶按 hash 的最高位 **unzip 成新表的两个桶**(一拆二,unzip_bucket 648 起)→ 旧桶标记 redirect → `set_table_from_new`(402-416)发布:

```cpp
// concurrentHashTable.inline.hpp:402-416(截取核心,逐字)
  set_table_from_new()
{
  InternalTable* old_table = _table;
  // Publish the new table.
  OrderAccess::release_store(&_table, _new_table);
  // All must see this.
  GlobalCounter::write_synchronize();
  // _new_table not read any more.
  _new_table = NULL;
  ...
  return old_table;
}
```

`write_synchonize_on_visible_epoch`(300-314)还做了优化:如果没有任何读者见过旧版本(`_invisible_epoch` 检查),可以跳过 write_synchronize。

**关键设计 (斜体)**: *这张表的并发协议可以总结成一句:**读者只声明存在,写者负责等待**。读路径零同步原语(只有 critical section 的计数器),所有"等待读者离开"的成本都记在删除、resize 头上——而这两者远少于查询。write_synchronize 本身是 JVM 全局的"等所有临界区退出"屏障(GlobalCounter),代价与活动读者数相关,所以才会用 invisible_epoch 这种"没人看到就别等"的优化。*

## 4. BitMap:1 bit 一个标记

### 4.1 场景:要标记 1 亿个对象的状态

GC 标记、卡表、SATB buffer 都需要"某个位置有没有被处理过"——用 `bool[]` 要 1 字节/位,BitMap 用 **1 bit**:

```cpp
// bitMap.hpp:79-82 + bitMap.inline.hpp:31-58(截取核心,逐字)
  static idx_t word_index(idx_t bit)  { return bit >> LogBitsPerWord; }
  static idx_t bit_index(idx_t word)  { return word << LogBitsPerWord; }

inline void BitMap::set_bit(idx_t bit) {
  verify_index(bit);
  *word_addr(bit) |= bit_mask(bit);
}

inline bool BitMap::par_set_bit(idx_t bit) {
  verify_index(bit);
  volatile bm_word_t* const addr = word_addr(bit);
  const bm_word_t mask = bit_mask(bit);
  bm_word_t old_val = *addr;

  do {
    const bm_word_t new_val = old_val | mask;
    if (new_val == old_val) {
      return false;     // Someone else beat us to it.
    }
    const bm_word_t cur_val = Atomic::cmpxchg(new_val, addr, old_val);
    if (cur_val == old_val) {
      return true;      // Success.
    }
    old_val = cur_val;  // The value changed, try again.
  } while (true);
}
```

注意两个版本的差别:`set_bit` 是普通 OR(**单线程场景**);`par_set_bit` 是 CAS 循环(**并发标记**)——两个 GC 线程可能同时 set 同一个 word 里的不同 bit,CAS 保证不丢置位。返回值还能告诉你"是不是我第一个置的"(false = 别人已经置过——SATB 里常用来判断"这个对象已被处理")。

遍历用 `iterate`(bitMap.cpp:612-630),对每个 64 位 word:`rest != 0` 才进内层逐位循环——**全零的 word 一次跳过**:

```cpp
// bitMap.cpp:612-630(截取核心,逐字)
bool BitMap::iterate(BitMapClosure* blk, idx_t leftOffset, idx_t rightOffset) {
  ...
  for (idx_t index = startIndex, offset = leftOffset;
       offset < rightOffset && index < endIndex;
       offset = (++index) << LogBitsPerWord) {
    idx_t rest = map(index) >> (offset & (BitsPerWord - 1));
    for (; offset < rightOffset && rest != 0; offset++) {
      if (rest & 1) {
        if (!blk->do_bit(offset)) return false;
        ...
      }
      rest = rest >> 1;
    }
  }
  return true;
}
```

- [C++: GC 里位图的典型用法:G1 的并发标记用 **prev/next 两张位图**——`_prev_mark_bitmap`(已完成)与 `_next_mark_bitmap`(构造中),上一轮标记在 prev,新一轮写 next,互不干扰(g1ConcurrentMark.hpp:306-307,域 26 的伏笔);对象地址 >> LogMinObjAlignment 作为 bit 下标,即"1 bit 对应一个最小对象对齐单位"]
- [x86: par_set_bit 的 CAS 就是 `lock cmpxchg`(05-cpu 篇)——两个线程置同 word 不同 bit,cmpxchg 循环重读再试,不会互相覆盖]

**关键设计 (斜体)**: *位图是"用计算换内存"的极端例子:1 字节变 1 bit,8 倍压缩,代价是 set/test/iterate 都要做移位与掩码。iterate 的 word 级跳过是它的灵魂——GC 标记位图通常稀疏(5-10% 密度),一个 64 位 word 全零就整体跳过,扫描成本接近"已标记对象数"而不是"地址空间大小"。`set_bit` vs `par_set_bit` 的分工还体现了 JVM 的纪律:单线程路径绝不付并发代价,需要并发的地方显式用带前缀的版本。*

## 核心悬念

"ConcurrentHashTable 的读者协议(critical section + redirect 跟随)和 BitMap 的位级标记,都是'结构级'的并发工具——而 JVM 里所有诊断输出、错误信息、GC 日志,要经过另一层抽象:输出流(tty/stringStream)与异常系统(Exceptions)。下一篇:输出流与异常——JVM 怎么管理所有输出管道,Exceptions::debug_check_abort 怎么挂调试器。"

> → [03-stream-exception.md](03-stream-exception.md):tty/gclog/stringStream 抽象与异常系统
