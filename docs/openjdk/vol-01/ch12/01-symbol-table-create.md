# 12.1 SymbolTable 初始化——经典链表哈希表

> **本文定位**：`SymbolTable::create_table()` 全线——Symbol 是什么、20011 个桶怎么来的、Arena 永久符号区干什么、为什么查找要拿锁、符号的两种命运（永久 vs 引用计数回收）。这是三个 Table（SymbolTable / StringTable / ResolvedMethodTable）初始化讲解的第一篇。
>
> **前置依赖**：ch08/07 Metaspace 背景知识；ch10 LatestMethodCache（`Method*`、`Klass*` 概念）。

---

## 0. 它是什么——常量池符号的全局去重表

### 0.0 Symbol 是什么

Java 的类名 `java.lang.Object`、方法名 `register`、签名 `(Ljava/lang/Object;)V`——这些**名字**在 JVM 内部不是散落的字符串，而是**每个唯一的名字只有一份拷贝**，这份拷贝就是一个 `Symbol` 对象。

注意：这里说的"名字"是 JVM 内部要引用的**类名/方法名/签名**等元数据，**不是 Java 程序里的任意字符串数据**（`new String("hello")` 不会产生 Symbol——那是 StringTable 的事，见下一篇）。

```
"register" 这个名字在 JVM 里只有一个 Symbol 对象
任何地方用到 "register" 这个名字 → 引用同一个 Symbol*
比较两个名字是否相同 → 比较指针是否相等（O(1)），不用逐字符比较
```

一个容易混淆的点：`Symbol` 的类型上是 `MetaspaceObj` 子类，但**实际分配在 C 堆和 Arena**，不在 Metaspace（Metaspace 是 Klass/Method 的存储区）。原因：符号数量巨大（一个应用的符号可达数十万）、生命周期由引用计数管理，放 C 堆更灵活。


这就是"符号化"（intern）的意义：**用指针相等代替字符串比较**。代价是每个新出现的名字要先在表里查一遍——查不到才创建。

**Symbol 类的内部结构**（oops/symbol.hpp）：

```cpp
class Symbol : public MetaspaceObj {
private:
  volatile short _refcount;     // 引用计数（原子操作，§4.2）
  unsigned short _length;       // 名字内容的 UTF8 字符数
  short          _identity_hash;// 身份哈希（首次计算后缓存）
  jbyte          _body[2];      // 名字内容起点（可变长技巧）
};
```

关键点：

1. **头 + 内容一体分配**——`_body[2]` 是"柔性数组"占位：分配时按 `sizeof(Symbol) + (长度 - 2)` 一次性申请（`byte_size(len)`），名字的 UTF8 字节直接跟在头部后面。**Symbol 对象和它的名字内容是一块连续内存**，不是"对象 + 独立字符数组"。

2. **`_length` 是 UTF8 字符数**——不是字节数也不是 Java 的 UTF16 长度。名字按 UTF8 存储，比较时按字符比较。

3. **`_identity_hash` 缓存**——基于对象地址和内容混合计算，首次算出后缓存，供 `System.identityHashCode` 等使用（地址会随 GC 移动，所以不能直接用地址）。

内存布局：

```
Symbol 对象（连续内存，大小 = byte_size(len)）
+- _refcount     (2B)
+- _length       (2B)
+- _identity_hash(2B)
+- 对齐填充
+- _body: "register" 的 UTF8 字节（长度可变）
```

### 0.1 问题：常量池解析是高频操作

JVM 加载类时，常量池里每一项（类名、方法名、字段名、签名）都要转成 Symbol。类加载、方法解析、反射……全都依赖"名字 → Symbol"的查找。这是一个**全局、高频**的去重表需求——符号以增为主（普通符号随类卸载回收，永久符号永不回收）。

### 0.2 解法：全局哈希表 + 引用计数

`SymbolTable` 就是这张表——一个经典的单链表哈希表[^1]：

[^1]: "旧式设计"是相对而言：JDK 11 中 StringTable 被重写为无锁的 ConcurrentHashTable（12.2 的主题），而 SymbolTable 沿用经典的 Hashtable 设计——原因在于两者的访问模式不同（类加载中频 vs intern 高频），本篇先不展开。

下面的图只是**概览**——哈希表的具体结构（桶、链表、entry 块、rehash 能力）在 §1-§2 逐步展开：

```
哈希表（20011 个桶）
+- 桶 0: Symbol* → Symbol* → NULL
+- 桶 1: NULL
+- ...
+- 桶 N: Symbol* → NULL

查找: hash(名字) → 桶 → 链表逐个比较 → 命中返回 Symbol*
插入: 查不到 → 分配新 Symbol → 挂到桶链表头
```

### 0.3 位置：universe_init 的第(10)步

三个 Table 的创建顺序（`universe_init` 中）：

```
SymbolTable::create_table()       ← 本文
StringTable::create_table()       ← 下一篇
ResolvedMethodTable::create_table() ← 第三篇
```

SymbolTable 排在最前，因为类加载马上就会用到它（StringTable 和 RMT 的创建都不依赖 SymbolTable，但后续所有类加载都依赖符号表就绪）。

---

## 1. create_table() 做了什么

```cpp
static void create_table() {
  _the_table = new SymbolTable();            // (1) 哈希表本体
  initialize_symbols(symbol_alloc_arena_size);  // (2) 360K Arena
}
```

两件事：建表、建符号分配区。

### 1.1 new SymbolTable()——20011 个桶

`SymbolTable()` 构造只做一件事：向基类 `RehashableHashtable` 传两个参数——**桶数**和**每个条目的大小**：

```cpp
SymbolTable()
  : RehashableHashtable<Symbol*, mtSymbol>(   // 基类：装 Symbol* 的哈希表
        SymbolTableSize,                      // 参数(1) 桶数 = 20011
        sizeof (HashtableEntry<Symbol*, mtSymbol>))  // 参数(2) 每个条目的字节大小
{}
```

（不懂 C++ 没关系：构造函数在初始化列表里把两个数交给基类，基类负责真正的建表工作。）

`SymbolTableSize` 的默认值是 **20011**——一个质数。

**为什么不是 2 的幂（像 Java HashMap 那样）？** 因为两种哈希表的寻址方式不同：

```
Java HashMap:      hash & (table.length - 1)     ← 位与掩码
                   要求长度是 2 的幂（如 16、65536）
                   位运算快，但长度被限定

HotSpot BasicHashtable（SymbolTable 的基类）:
                   hash % table_size            ← 取模
                   任意正整数都行，质数分布更均匀
                   慢一点（除法），但长度自由
```

为什么质数更好：取模寻址时，如果桶数是合数而 hash 值恰好和它有公因子，结果会聚集在少数桶上；质数没有真因子，能避免这种聚集。

对比：StringTable 的 ConcurrentHashTable 用掩码寻址（桶数 2^16），ResolvedMethodTable 用取模（桶数 1007）——三种方案会在 12.3 的三表对比里收束。

构造真正做的事（基类 `BasicHashtable`）——真实代码：

```cpp
template <MEMFLAGS F> inline BasicHashtable<F>::BasicHashtable(int table_size, int entry_size) {
  // Called on startup, no locking needed
  initialize(table_size, entry_size, 0);      // (1) 记录 table_size、entry_size，清空空闲链表等
  _buckets = NEW_C_HEAP_ARRAY2(HashtableBucket<F>, table_size, F, CURRENT_PC);  // (2) C 堆分配桶数组
  for (int index = 0; index < _table_size; index++) {
    _buckets[index].clear();                  // (3) 逐个桶清零（桶 = 链表头指针，初始为空）
  }
}
```

逐行讲解：

**(1) `initialize(table_size, entry_size, 0)`**——把两个参数记进 `_table_size` / `_entry_size` 字段，同时清空三个空闲管理字段（`_free_list`、`_first_free_entry`、`_end_block`）——此时还没有任何条目，空闲池为空。

**(2) `NEW_C_HEAP_ARRAY2(...)`**——在 C 堆分配一段连续内存作为桶数组，长度 20011，每个元素是一个 `HashtableBucket`。注释说 "Called on startup, no locking needed"：启动期是单线程，不需要锁。

`HashtableBucket` 本身极简——内部就一个字段：

```cpp
template <MEMFLAGS F> class HashtableBucket : public CHeapObj<F> {
private:
  BasicHashtableEntry<F>* _entry;   // 唯一的字段：链表头指针
public:
  void clear() { _entry = NULL; }                    // 清零 = 链表头置 NULL
  BasicHashtableEntry<F>* get_entry() const;         // 读链表头（带内存序）
  void set_entry(BasicHashtableEntry<F>* l);         // 写链表头（带 release 语义）
};
```

**"桶"就是一个链表头指针**——`get_entry`/`set_entry` 用了带内存序的读写（`OrderAccess::release_store`），目的是让"先把条目内容写完整、再发布到链表"的顺序对读者可见——这是无锁读安全的前提。

**数据存在哪？三层结构，桶不存数据**：

```
桶数组（20011 个 HashtableBucket，每个只装一个指针）
+- 桶 5: _entry --------------+
                              ↓
                     +--------------------+    +--------------------+
                     | HashtableEntry #1   |    | HashtableEntry #2   |
                     | _hash = 0x1234      |    | _hash = 0x5678      |
                     | _next --------------+---→| _next ----------→ NULL
                     | _literal = Symbol* A |    | _literal = Symbol* B|
                     +--------------------+    +--------------------+
                        ↑ 数据在这                  ↑ 数据在这
```

| 层次 | 结构 | 存什么 |
|------|------|--------|
| 桶 | `HashtableBucket` | 只有一个 `_entry` 指针（链表头），**不存数据** |
| 条目 | `HashtableEntry<Symbol*>` | **存数据**：`_literal`（Symbol*）+ `_hash` + `_next` |
| 数据本体 | `Symbol` 对象 | 在 C 堆/Arena（§4 的分配路径） |

条目里存数据的关键字段（`HashtableEntry` 模板）：

```cpp
template <class T, MEMFLAGS F> class HashtableEntry : public BasicHashtableEntry<F> {
  T _literal;   // ← 真正的数据！SymbolTable 里 T = Symbol*
};
```

所以查表路径是：**桶 → 条目（比对 _hash）→ 取 _literal 的 Symbol* → 比较内容**。

**(3) 循环清零**——20011 个桶的链表头全部置 NULL。

此时表是**空的**——20011 个空链表头（指针指向 NULL），既没有条目也没有 Symbol。

### 1.2 initialize_symbols(360K)——永久符号的分配区

```cpp
void SymbolTable::initialize_symbols(int arena_alloc_size) {
  if (arena_alloc_size == 0) {
    _arena = new (mtSymbol) Arena(mtSymbol);       // 无参数：按需增长
  } else {
    _arena = new (mtSymbol) Arena(mtSymbol, arena_alloc_size);  // 预分配 360K
  }
}
```

**默认走哪个分支？预分配分支（else）。** 调用链只有一条：`create_table()` 显式传入 `symbol_alloc_arena_size`（360K）→ 非 0 → 走 else。if 分支（按需增长）只是函数默认参数 `int arena_alloc_size = 0` 留下的**兜底路径**——理论上前提，实际不会被走到。

为什么预分配：360K 是"基于 java -version 大小测量"得出的启动期符号总量，**一次性申请一整块**，让启动阶段几百个核心类符号都在同一块 Chunk 里连续 bump，避免逐个 grow 的多次分配。

`_arena` 和 `_the_table` 一样是 **SymbolTable 的类静态变量**（`static Arena* _arena`，全局唯一，生命周期 = JVM 进程）。它给"永久符号"（null class loader 的符号，如核心类名）提供分配空间。

#### Arena 的结构——Chunk 链表 + 游标

Arena 不是"一大块连续内存"，而是**Chunk 链表**：

```
Arena
+- _first: 第一块 Chunk（链表头）
+- _chunk: 当前正在分配的 Chunk
+- 每个 Chunk:
   +- _next: 指向下一块
   +- _len:  本块大小（默认 32K，第一块 1K）
   +- 数据区: [_bottom, _top)
                ↑        ↑
              _hwm     _max
              (分配游标) (本块末尾)
```

三个关键字段：`_first`（链表头）、`_chunk`（当前块）、`_hwm`/`_max`（当前块内的**高水位游标**和块末尾）。

#### 分配——指针比较 + 递增（bump pointer）

```cpp
void* Arena::Amalloc_4(size_t x) {
  if (_hwm + x > _max) {      // 当前块剩余不够？
    return grow(x);           // 开新 Chunk（至少 32K），游标移到新块
  } else {
    char *old = _hwm;         // 够：返回当前游标
    _hwm += x;                // 游标前进 x 字节
    return old;
  }
}
```

快路径就三步：**比较 → 返回 → 前进**。注释原话："Fast allocate in the arena. Common case is: pointer test + increment."

`grow()` 开新块时：新 Chunk 大小 = `MAX2(请求大小, 32K)`，追加到链表尾部，`_hwm`/`_max` 移到新块。

Chunk 默认大小分档（arena.hpp）：第一块 1K（`init_size`），后续默认 32K（`size`）。空闲的 Chunk 会进 `ChunkPool` 复用（减少 malloc）。

#### Symbol 从 Arena 分配——整体 placement new

```cpp
// symbol.cpp —— Symbol 的 Arena 分配路径
void* Symbol::operator new(size_t sz, int len, Arena* arena, TRAPS) throw() {
  int alloc_size = size(len)*wordSize;        // Symbol 头 + 名字内容的总大小
  address res = (address)arena->Amalloc_4(alloc_size);  // 从 Arena bump 出来
  return res;
}
```

Symbol 对象（含名字内容）**整个从 Arena 里切**，不是单独 malloc。

#### 为什么用 Arena 而不是直接 malloc

| 维度 | Arena | 逐个 malloc |
|------|-------|------------|
| 分配速度 | 指针比较 + 递增（纳秒级） | 系统调用/内存管理（微秒级） |
| 分配次数 | 一块 32K Chunk 装几百个小 Symbol | 每个 Symbol 一次 |
| 释放 | 永不释放（进程结束整体归还） | 需要逐个 free + 簿记 |
| 碎片 | 无（连续 bump） | 可能碎片化 |

`symbol_alloc_arena_size = 360*K` 的注释说"基于 java -version 大小测量"——即启动核心类加载所需的符号量，预分配一整块避免后续多次 grow。用完后 `_hwm` 继续 bump，不够时按 32K 自动开新块。

---

## 2. 表结构：RehashableHashtable

### 2.1 BasicHashtable——桶 + 链表 + 空闲 entry 块

SymbolTable 的表结构来自 `BasicHashtable`：

```
BasicHashtable
+- _buckets: 桶数组（20011 个链表头）
+- _entry_size: 每个条目的大小
+- 空闲 entry 管理:
   +- _free_list        ← 被释放条目的回收链表
   +- _first_free_entry / _end_block  ← 按块批量分配的 entry 池
```

一个细节：**条目（HashtableEntry）不是一个个 malloc 的，而是按块批量分配**。分配顺序：先复用 `_free_list` 里的回收条目，空了才开新块（块大小按当前条目数自适应，封顶 512 个）。块用完再开新块，entry 从块里切——减少 malloc 次数，也方便 GC 时批量释放。源码注释："HashtableEntrys are allocated in blocks to reduce the space overhead"。

**`_entry_size` 是多少、干什么用？** 它等于 `sizeof(HashtableEntry<Symbol*>)`——64 位平台上 **24 字节**（`_hash` 4 + 对齐 4 + `_next` 8 + `_literal` 8）。开新块和从块里切条目都按它算：

```
开新块: 块大小 = 24 字节 × 块内条目数
               （块内条目数 = min(512, max(桶数/2, 当前条目数))，向下取 2 的幂）
切条目: 游标按 24 字节步长前进（_first_free_entry += _entry_size）
```

**注意：这个块分配和 Arena（§1.2）是两回事**——Arena 分配的是 **Symbol 数据本体**，块分配的是 **HashtableEntry 节点**，互不相关：

```
C 堆                          Arena（360K）
+- 桶数组 (20011 个链表头)     +- Symbol: "java"（bump）
+- 块1: [entry][entry][entry]  +- Symbol: "lang"
+- 块2: [entry][entry]         +- Symbol: "Object"
+- ...                        +- ...
    ↑ 条目的家（24B 步长）         ↑ 数据的家（bump）
```

**块的实体**：`NEW_C_HEAP_ARRAY(char, 24 × N)` 在 C 堆分配的一段连续内存（N = 块内条目数，封顶 512）——它就是条目的"家"。

**块的生命周期**：`BasicHashtable` 只跟踪**当前块**（`_first_free_entry` 游标 + `_end_block` 块尾），旧块用完后**没有链表跟踪，内存一直持有直到表析构**。所谓"释放"（GC 时 `bulk_free_entries`）只是把被删除的条目 CAS 挂回 `_free_list` 循环使用——**内存不还给 OS**：

```
新条目分配: free_list 复用 → 没有 → 当前块里 24B 步长切 → 块满 → 开新块
条目释放  : 挂回 free_list（CAS），下次分配优先复用
块本身    : 从不释放，直到表析构
```

查找命中时，桶里的 `HashtableEntry._literal` 指向 Arena 里的 Symbol——**C 堆的节点装着指向 Arena 数据的指针**。

#### 两块内存池总结

整个 SymbolTable 的内存被组织成**两块完全独立的内存池**：

| 维度 | 条目池（块） | 符号池（Arena） |
|------|------------|----------------|
| 分配单位 | 24 字节条目（块内步长） | 任意大小的 Symbol（含名字内容） |
| 分配方式 | 块：NEW_C_HEAP_ARRAY；条目：块内游标切 | Chunk 内 bump pointer |
| 生命周期 | 条目可循环（桶 ↔ free_list），块只增不减 | 只增不减，永不回收 |
| 循环机制 | `_free_list` 回收站 | 无（无回收概念） |
| 服务对象 | 表的**结构**（链表节点） | 表的**内容**（数据本体） |
| 依赖关系 | 条目通过 `_literal` 指向符号 | 不感知条目 |

两块池各司其职：**条目池管"表的结构"（节点增删循环），符号池管"表的内容"（数据分配）**——前者可变可循环，后者只增不减。这是理解 SymbolTable 内存模型的核心：查找时经条目池（C 堆）取指针，再解引用到符号池（Arena）取数据。

### 2.2 "Rehashable"——表不平衡时的自救

表名里的 Rehashable 表示它能**重新哈希**：当某个桶的链表过长（hash 分布失衡）时，用**新的随机种子**重新计算所有 Symbol 的 hash 并重建表。

触发机制：

```
查找遍历桶链表时顺带检查:
  本桶条目数 ≥ rehash_count（100）→ check_rehash_table()
    +- 表失衡（最长的桶太长）→ _needs_rehashing = true
下次 safepoint → rehash_table()
    +- 换一个新 seed（AltHashing::halfsiphash_32(seed, ...)）→ 全部重算 → 重建
```

**两个阶段由谁执行？**

| 阶段 | 执行者 | 做什么 |
|------|--------|--------|
| 检测 | mutator 线程（查找时顺带） | 桶长 ≥ 100 时检查失衡，失衡则置 `_needs_rehashing = true`（只打标记） |
| 重建 | **VM 线程**（safepoint cleanup 阶段） | 换 seed、全部重算、重建整表 |

执行机制：safepoint 期间，VM 线程执行 `do_cleanup_tasks()`，检查到 `needs_rehashing()` 后调用 `rehash_table()`。源码断言 "Only VM thread can execute a safepoint"。

**为什么必须 VM 线程 + 全暂停？** 重建是结构性大操作——换 seed 后所有条目要重新计算 hash 并迁移到新桶。而 mutator 正在无锁读桶链表：**不可能让 mutator 边读边改表**。所以必须到达 safepoint（所有线程暂停）、由 VM 线程独占执行重建，完成后统一唤醒。mutator 只负责"发现并标记"，没有权限也没有机会执行重建。

为什么要换 seed？hash 算法带随机 seed（siphash 系），恶意构造大量同名 hash 的字符串让桶失衡时，换 seed 后攻击者无法预测新分布——**这是对 hash 碰撞攻击的防护**。日常路径永远走不到 rehash，但它存在，防止最坏情况。

### 2.3 与普通 Hashtable 的关系

`BasicHashtable` → `Hashtable` → `RehashableHashtable` 是一族通用表，`ResolvedMethodTable`（第三篇）复用了同一套基类，只是换了条目类型和弱引用。

本篇围绕 SymbolTable 覆盖了 Hashtable 家族的核心机制，**后续文章直接复用的就是这些**：

```
已覆盖（SymbolTable 用到的部分）:
  (1) 桶数组 + 链表结构（§1.1）
  (2) 条目结构（hash / next / literal，§1.1）
  (3) 条目块分配 + free_list 循环（§2.1）
  (4) 取模寻址（hash % table_size，§1.1）
  (5) 乐观锁模型（§3.1）
  (6) rehash 触发机制（§2.2）

未覆盖（本篇不展开，按需再讲）:
  rehash 重建的内部实现、表的遍历与复制、
  Hashtable 家族的其他使用者（SystemDictionary 等）
```

RMT 复用时只需知道：**结构（(1)(2)(3)(4)）和锁模型（(5)）与 SymbolTable 完全一致**，差异只有条目类型（弱引用）和桶数。

---

## 3. 锁模型与查找路径

### 3.1 锁模型——先无锁查，未命中才拿锁

SymbolTable 的并发模型不是"全程持锁"，而是**乐观锁模式**：

```
查找（lookup）:
  hash → 桶 → 无锁遍历链表        ← 不拿锁！
    命中 → refcount++（原子）→ 返回
    未命中 → 才拿 SymbolTable_lock → basic_add 插入

插入（basic_add）:
  持锁 → 重新计算 hash/index（等待期间表可能 rehash 了）→ 再查一次 → 插入
```

关键点：

1. **查找不持锁**——链表遍历是只读操作，命中概率高，绝大多数 lookup 根本不会碰到锁
2. **未命中才拿锁**——竞争只在"插入新符号"时发生，这是低频操作
3. **加锁后要重算**——basic_add 内部会检查表是否被 rehash 过，重新计算 hash 和桶下标，然后**再查一次**——如果等锁期间别的线程已经插入了同名符号（race），直接返回已有的，不再重复创建

补充：lookup 有两个重载——`lookup(const char*, len)` 走上述乐观锁路径（主路径）；`lookup(const Symbol*, begin, end)` 直接持锁（用于常量池等已知 Symbol 的二次检查）。

对 SymbolTable 来说这个模型够用：符号查找不是分配热路径（对象分配走 TLAB，类加载才查符号表）。对比：StringTable（下一篇）的 intern 是分配热路径，就必须上彻底的无锁设计了。

### 3.2 lookup 路径——三步

```
lookup(name, len):
  (1) hash_symbol(name, len)         → 算 hash（seed + siphash）
  (2) bucket(hash % 20011)           → 取桶链表头
  (3) 链表逐个 Symbol 比较（无锁）    → 命中 → refcount++（原子）→ 返回
                                  → 未命中 → 拿锁 basic_add 插入（§3.1）
```

命中后 `refcount++` 是必须的——防止引用方并发释放（`decrement_refcount` 归零）把刚找到的 Symbol 回收掉（引用计数机制见 §4.2）。

---

## 4. 符号的分配与生命周期

### 4.1 双路径：C 堆 vs Arena

`allocate_symbol` 按 `c_heap` 标志走两条完全不同的分配路径。c_heap 的判定：类加载批量插入时由 `loader_data` 决定（null class loader → false），lookup 快速路径固定为 true：

```
c_heap = true（普通类加载器的符号）:
  new (len) Symbol(name, len, 1)      → C 堆单独分配，引用计数从 1 开始
  → 随类卸载释放，计数递减，归零回收

c_heap = false（null class loader 的永久符号）:
  new (len, arena()) Symbol(name, len, PERM_REFCOUNT)
  → 从 360K Arena 里切，引用计数 = -1（PERM_REFCOUNT）
  → 永不回收
```

### 4.2 引用计数机制

`Symbol` 内部有一个 `volatile short _refcount`：

```
PERM_REFCOUNT = -1    ← 永久符号：计数固定 -1，永远不递减
正常计数 ≥ 0          ← 普通符号：lookup 命中 +1，引用方释放时 -1
                        计数归零 → GC unlink 时从表里摘除 + 释放内存
```

为什么 lookup 要 +1？因为查表和引用方释放是并发的：查到 Symbol 后如果引用计数没有增加，引用方可能在这期间把它的计数减到 0——返回一个即将被删除的指针。引用计数保证"**有人引用就不会被回收**"。

**并发安全靠什么？** 两个机制分工：

```cpp
void Symbol::increment_refcount() {
  if (_refcount >= 0) {          // PERM_REFCOUNT(-1) 跳过（永久符号不计数）
    Atomic::inc(&_refcount);     // 原子自增（单条读-改-写指令）
  }
}
void Symbol::decrement_refcount() {
  if (_refcount >= 0) {
    short new_value = Atomic::add(short(-1), &_refcount);  // 原子自减
    ...
  }
}
```

| 机制 | 解决什么问题 |
|------|------------|
| `volatile` | **可见性**——写立即对其他线程可见，不被缓存遮蔽 |
| `Atomic::inc/add` | **原子性**——读-改-写是单条硬件指令（x86 的 `lock xadd`），不会丢失更新 |

只有 `volatile` 而不用原子指令：两个线程同时 `+1` 会各自"读旧值 → 写回"导致丢失一次更新。**两者缺一不可**：`volatile` 保证可见，`Atomic` 保证不丢更新。

### 4.3 GC 清理：unlink——只删除已归零的

**refcount 的递减发生在引用方，不是 GC**——常量池等不再引用某个 Symbol 时调用 `decrement_refcount()`，计数归零后，该 Symbol 在 GC 的 unlink 阶段被删除：

```
引用方（常量池等）释放引用:
  decrement_refcount() → 计数可能归零

GC 时（safepoint），SymbolTable::unlink 扫描整张表:
  buckets_unlink(0, table_size)     → 把 20011 个桶分给多个 GC 线程并行扫描
      +- 每个条目: refcount() == 0 ? → 从链表摘除 + 释放内存
                                    : → 保留（还有人在用）
  bulk_free_entries(context)        → 把摘除的条目批量释放
```

并行按桶段扫描（多线程各扫一段桶）——这是 SymbolTable 里唯一的多线程协作点（GC 暂停期）。

---

## 5. 小结

```
SymbolTable 初始化全景:
  create_table()
    +- new SymbolTable()         → 20011 个空桶（质数，经典链表哈希）
    +- initialize_symbols(360K)  → Arena 永久符号分配区

核心机制:
  查找    : hash → 桶 → 无锁链表遍历，未命中才拿锁插入
  分配    : C 堆（refcount=1，可回收）/ Arena（PERM_REFCOUNT，永久）
  回收    : 引用方递减，计数归零后 GC unlink 删除
  rehash  : 桶长 ≥ 100 时换 seed 重建（防 hash 碰撞）

一句话: 乐观锁 + 一张经典哈希表 + 引用计数 —— 够用就好，
       真正激进的设计（彻底无锁 + 弱引用）在下一篇 StringTable。
```

> **下一篇**：[12.2 StringTable 初始化](02-string-table-create.md)——JDK 11 重写：并发无锁哈希表 + OopStorage 弱引用。
