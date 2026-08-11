# 02. ConcurrentHashTable + BitMap — 并发数据结构

> 🔴 Deep | lock-free hash table + bit-level heap mark
> 读者处境: `String.intern("hello")`→SymbolTable→ConcurrentHashTable→lock-free lookup/insert。G1 SATB buffer→BitMap→set bit per marked object。

### 1. "ConcurrentHashTable — per-bucket mutex + CAS resize"

场景: 多个 Java 线程同时 `String.intern()`→ConcurrentHashTable 的 lookup/insert 是 lock-free——per-bucket mutex(不是全局锁) + CAS resize(支持并发 grow)。

**ConcurrentHashTable** (`concurrentHashTable.hpp:200-534 + ipp:200-800`):
```
ConcurrentHashTable<K,V>::get(K key, V* value):
  → hash = key.hash() → bucket_idx = hash % _table_size
  → Bucket* bucket = &_buckets[bucket_idx]
  → MutexLocker ml(bucket->_mutex) — per-bucket lock
  → 遍历 bucket's linked list → find key → return value

insert(K key, V value):
  → bucket_mutex lock → check if already exists
  → 如果 bucket 满(linked list > max_size) → _resize_lock.tryLock()
  → if got resize lock: CAS _table_size*=2 → rehash all entries → unlock
  → if couldn't get lock: insert anyway(另一个线程在 resize) → return
[C++: concurrentHashTable.hpp:534行——per-bucket mutex + global resize lock——读写无全局竞争]
```
- 源码: `concurrentHashTable.hpp:200-400` (get/insert→per-bucket lock) + `concurrentHashTable.hpp:400-534` (resize→CAS _table_size×2)

- 关键设计: **per-bucket mutex** — 不同 bucket 的 lookup 可并行——全局锁会是 bottleneck(每次 String.intern 都串行)。**Resize 通过 global _resize_lock** — 同时只一个线程 resize——其他线程发现 resize in progress→不等待(继续用旧 table 插入——新 table 就绪后 atomic switch)。**双重哈希** — rehash 时用两个 hash functions——减小 resize 后的 collision probability。

### 2. "BitMap — 1 bit per heap word"

场景: G1 SATB mark→`BitMap::set_bit(obj_addr >> LogMinObjAlignment)`→bit 对应 heap word。GC marking→BitMap iterate→find marked objects。

**BitMap** (`bitMap.cpp:50-300 + bitMap.hpp:80-200`):
```
BitMap::set_bit(idx_t bit):
  → word_idx = bit >> LogBitsPerWord  // which 64-bit word
  → bit_in_word = bit & (BitsPerWord-1)
  → _map[word_idx] |= (1L << bit_in_word)  // atomic OR

BitMap::iterate(BitMapClosure* cl):
  → 遍历 _map[] 64-bit words
  → each word != 0 → for each set bit → cl->do_bit(bit_index)
  → large iteration: 跳过全零 words(skip entire 64-bit chunks→faster for sparse bitmap)
[C++: bitMap.cpp:702行——每个 bit 代表一个 heap word(8 bytes in 64-bit JVM)→bitmap 开销 = heap_size / 64 bytes]
```
- 源码: `bitMap.cpp:50-150` (set_bit/clear_bit→bitwise ops) + `bitMap.cpp:200-350` (iterate→skip zero words)

- 关键设计: **word-level skip** — `iterate()` 跳过 `_map[word_idx] == 0` 的 64-bit words(skip 64 bits at a time)→sparse bitmap(GC marking 通常 5-10% density)→iteration 速度提升 10-20x。**G1 用两个 BitMap(prev+next)** — concurrent marking fill next bitmap→cleanup use prev——双 bit 不冲突。

---

### 核心悬念

**"ConcurrentHashTable: per-bucket mutex(无全局竞争)+CAS resize(其他线程不等 resize)。BitMap: 1 bit per heap word→set_bit(atomic OR)→iterate(skip zero words 64 at a time→sparse→fast)。"** — 下一篇: Output streams + 异常。

> → [03-stream-exception.md](03-stream-exception.md)
