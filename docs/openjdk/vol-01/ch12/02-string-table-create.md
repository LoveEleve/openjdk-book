# 14.2 StringTable 初始化——JDK 11 重写：并发无锁 + 弱引用

> **本文定位**：`StringTable::create_table()` 全线——interned String 为什么和 SymbolTable 走上完全不同的技术路线、OopStorage 弱引用存储怎么工作、ConcurrentHashTable 怎么做到无锁读、JDK 11 为什么要重写这张表。
>
> **前置依赖**：ch12/01 SymbolTable 初始化（哈希表与去重的基础概念、对比基线）。
>
> **概念铺垫**：oop = 指向 Java 对象的指针（对象在堆里，GC 会移动/回收它）；弱引用 = "引用了对象，但不阻止它被回收"。

---

## 0. 它是什么——interned String 的全局表

### 0.1 与 SymbolTable 的定位差异

`String.intern()` 的语义：**内容相同（解码后的 Unicode 字符序列相同）的 String 只保留一份**——intern 后所有相同内容的调用共享同一个 String 对象。`StringTable` 就是支撑这个语义的表：条目存的是 String 对象的**弱引用**（WeakHandle），查找时按**字符内容**匹配，命中返回表中已 intern 的 String 对象（不是内容拷贝，也不是 Symbol）。

两个容易误解的点：

**① "内容相同"指字符序列，不是内部字节**。JDK 9+ 的 String 内部是 `byte[]`（LATIN1 或 UTF16 编码），intern 比较的是**解码后的 Unicode 字符序列**——`LATIN1 "abc"`（`61 62 63`）和 `UTF16 "abc"`（`00 61 00 62 00 63`）字节完全不同，但字符序列相同 → intern 共享。

**② `new` 和 `intern()` 是两回事**：

```
String x = new String("a");   // 堆上新建对象（每次都新）
String y = new String("a");   // 又一个新对象

x == y              → false（两个不同对象，内容相同也不等）
x.intern() == y.intern() → true（intern 后共享同一个对象）
```

**"共享同一个对象"的确切机制**——表里只留一个"官方代表"，就是**第一个 intern 成功的对象**：

```
先 x.intern():
  ① 取 x 的内容 "a" → 查表 → 未命中
  ② 把 x 放入表 → x 成为共享对象 → 返回 x（0x1000）

再 y.intern():
  ① 取 y 的内容 "a" → 查表 → 命中（表里是 x）
  ② 返回 x（0x1000）——不是 y！y 无人引用，之后被 GC 回收

结果: x.intern() == y.intern() → 都是 0x1000 → true
（顺序反过来则 y 成为代表，x 被丢弃）
```

这是 `String.intern()` 的合同：**内容相同的 intern() 一定返回同一个对象**。也解释了 §4.3 的 do_intern 为什么"先建候选 String、查表命中就丢弃新建的"——新建的只是"可能成为代表的候选"，表里已有代表时它毫无用处。

```
SymbolTable（上一篇）:      StringTable（本篇）:
  存 Symbol*（C 堆/Arena）      存 String 弱引用（Java 堆里的对象）
  条目按引用计数回收            条目按弱引用回收（GC 检测）
  类加载时用                    运行时 String.intern() 用
```

定位差异决定了**死亡机制**的差异：两者的条目**都会死**，但死法不同——**SymbolTable 靠显式引用计数**（引用方 `decrement_refcount`，归零后 GC unlink 删除），**StringTable 靠隐式弱引用**（GC 标记时发现无引用自动清理）。Arena 永久符号（PERM_REFCOUNT）不回收只是 Symbol 数据的一类特例，不是条目的普遍命运。

### 0.2 为什么 JDK 11 要重写

JDK 11 之前，StringTable 是经典哈希表，查找要加锁。问题有两个：

1. **intern 是分配热路径**——每次 `String.intern()` 都要查表，Java 程序大量使用 intern（字符串字面量、常量折叠、`intern()` 调用）。加锁查找在并发分配下是瓶颈。
2. **interned String 不死**——旧实现条目是强引用，interned String 永远不会被回收，长期运行的应用 intern 表不断膨胀。

JDK 11 的重写同时解决这两点：**无锁读**（ConcurrentHashTable）+ **弱引用**（OopStorage）。

---

## 1. create_table() 做了什么

```cpp
static void create_table() {
  _the_table = new StringTable();
}
```

`create_table()` 本身只有 3 行，但 `StringTable()` **构造**做的事比 SymbolTable 多得多——完整的构造（stringTable.cpp）：

```cpp
StringTable::StringTable() : _local_table(NULL), _current_size(0), _has_work(0),
  _needs_rehashing(false), _weak_handles(NULL), _items(0), _uncleaned_items(0) {
  _weak_handles = new OopStorage("StringTable weak",          // ① 弱引用存储
                                 StringTableWeakAlloc_lock,
                                 StringTableWeakActive_lock);
  size_t start_size_log_2 = ceil_pow_2(StringTableSize);      // ② 容量计算
  _current_size = ((size_t)1) << start_size_log_2;            //    2^16 = 65536
  _local_table = new StringTableHash(start_size_log_2,        // ③ 并发哈希表
                                     END_SIZE, REHASH_LEN);
}
```

### 1.1 构造拆解——初始化列表 + 三件事

**初始化列表**（7 个字段全部置空/零）：`_local_table`、`_current_size`、`_has_work`、`_needs_rehashing`、`_weak_handles`、`_items`、`_uncleaned_items`——先建一个"全空"的对象壳。

**函数体三件事**：

```
① new OopStorage("StringTable weak", 两把锁)
   → 弱引用的物理存储（§2 展开）

② 容量计算: ceil_pow_2(65536) = 16 → _current_size = 2^16 = 65536
   → 桶数（§1.2 讲为什么是 2 的幂）

③ new StringTableHash(16, 24, 100)
   → 并发哈希表：初始 2^16 桶、容量上限 2^24、rehash 阈值 100（§3 展开）
```

> **注**：① 的 OopStorage 是什么、为什么需要它（GC 搬对象后，谁来更新你存下的对象地址）——完整设计推演见 [ch08/02 OopStorage](../ch08/02-oopstorage.md)。本文 §2 只展开 StringTable 用到的弱引用语义。

### 1.2 容量：2 的幂，不是质数

`StringTableSize` 默认 65536。注意与 SymbolTable 的差异：**SymbolTable 选质数 20011（取模均匀），StringTable 选 2 的幂**——因为 ConcurrentHashTable 用**掩码**寻址（`hash & mask`）而不是取模，2 的幂让掩码生效且位运算更快。

### 1.3 两个新组件

这一节先把两个新组件是什么说清楚，后面两节分别深挖：

| 组件 | 类型 | 职责 |
|------|------|------|
| OopStorage | 弱引用存储 | 给 interned String 分配槽位；GC 能遍历并清理死槽 |
| StringTableHash | 并发哈希表 | 无锁查找；渐进式扩容 |

两者分工：StringTableHash 回答"该内容的字符串是否在表中"，OopStorage 回答"条目对应的 String 对象当前在堆上何处"。

#### 真实结构——四个类与整体结构树

StringTableHash 的类型定义（stringTable.hpp）：

```cpp
typedef ConcurrentHashTable<WeakHandle<vm_string_table_data>,
                            StringTableConfig, mtSymbol> StringTableHash;
```

`typedef` 是类型别名——为填好参数的模板类型起短名，后续 `new StringTableHash(...)` 无需重复全串。`ConcurrentHashTable` 的声明是 `ConcurrentHashTable<VALUE, CONFIG, F>`——`VALUE` 等是**形参占位名**（如同函数形参），不是具体存在的类；Node 中 `VALUE _value;` 的类型由填参决定。StringTable 填 `WeakHandle<vm_string_table_data>`，ResolvedMethodTable（下一篇）填另一种类型，同一套模板代码生成不同的表。尖括号内三个类型参数：

| 参数 | 填入值 | 作用 |
|------|--------|------|
| VALUE（节点存什么） | `WeakHandle<vm_string_table_data>` | 每个 Node 的 `_value` 字段类型 |
| CONFIG（操作规则） | `StringTableConfig` | 提供 `get_hash`（从 VALUE 现算 hash）、`allocate_node` / `free_node`（节点分配与释放） |
| MEMFLAGS（内存记账） | `mtSymbol` | 该表的 C 堆内存归入 mtSymbol 类别（NMT 报表分类标签） |

VALUE 本身也是模板：`WeakHandle<T>` 的枚举参数 T 标记弱句柄用途（`vm_class_loader_data` / `vm_string` / `vm_string_table_data`），每种 T 对应各自的 OopStorage——`vm_string_table_data` 对应 StringTable 的 `_weak_handles`。

涉及的四个类（均为裁剪后的真实定义）：

**WeakHandle**（weakHandle.hpp）——对 OopStorage 槽位的包装，只有一个字段：

```cpp
template <WeakHandleType T>
class WeakHandle {
  oop* _obj;                       // 唯一的字段：OopStorage 槽位地址
  static WeakHandle create(Handle obj);  // 租槽位 + 写入 oop
  oop resolve() const;             // 读 *_obj（GC 周期内保活）
  oop peek() const;                // 读 *_obj（不保活，可能拿到已死对象或 NULL）
  void release() const;            // 归还槽位
};
```

**Node**（concurrentHashTable.hpp）——链表节点，只有两个字段：

```cpp
class Node {
  Node * volatile _next;
  VALUE _value;   // StringTable 中 = WeakHandle，即一个 oop*（8 字节）
};
```

注意 `_value` 是 **WeakHandle 对象本体，内嵌在 Node 内存中**——这是 C++ 与 Java 的对象模型差异：Java 的对象字段存的是引用（指向另一块堆内存），C++ 的类类型字段是内嵌值（子对象内存直接成为宿主的一部分）。因此：

- `sizeof(Node) = 8(_next) + 8(_value)`，`_value` 这 8 字节就是 WeakHandle 唯一的字段 `_obj`——WeakHandle 实例没有独立内存
- 生命周期随 Node：建 Node 时 `WeakHandle::create` 的临时值被**拷贝**进 `_value`；查找时拿到的 `WeakHandle*` 是 `&node->_value`；删 Node 时随 Node 一起释放（`free_node` 先 `value.release()` 归还槽位，再 free Node 内存）

注意与 SymbolTable 条目的差异：**Node 没有 `_hash` 字段**——hash 不缓存，需要时由 `StringTableConfig::get_hash(value)` 现场算：`peek()` 取出 String 对象、读内容、重新计算。所以查找遍历节点时是**逐个解引用比对字符内容**（`equals`），没有 SymbolTable 那种"先比缓存 hash 再比内容"的预筛选。

**Bucket**（concurrentHashTable.hpp）——桶，只有一个指针：

```cpp
class Bucket {
  Node * volatile _first;   // 链表头，低 2 位嵌状态（locked/redirect，§3.2）
};
```

源码注释原话："A bucket is only one pointer with the embedded state."

**InternalTable**（concurrentHashTable.hpp）——桶数组本体，CHT 对象经指针持有它：

```cpp
class InternalTable {
  Bucket* _buckets;        // 桶数组（表体）
  const size_t _log2_size; // 16
  const size_t _size;      // 65536
  const size_t _hash_mask; // 65535（hash & mask = 桶下标）
};
```

源码注释原话："The backing storage table holding the buckets and it's size and mask-bits." 它独立成类的原因在扩容：CHT 对象持有 `_table`（当前表）与 `_new_table`（迁移目标）两个指针，扩容 = 新建一个更大的 InternalTable、逐桶迁移、切换 `_table` 指针——§3.5"两表共存"的两个表就是两个 InternalTable 实例。

CHT 对象本身还持有 `_resize_lock`（扩容与批量删除共用的一把锁，§3.4/§3.5）和三个配置数——构造传入的 `new StringTableHash(16, 24, 100)` 落点为 `_log2_start_size = 16`（第一个 InternalTable 的规格）、`_log2_size_limit = 24`、`_grow_hint = 100`（含义见 §3.6）。

**数据存在哪？整体结构树，桶不存数据**——以 `intern("abc")` 成功后为例（`"abc"` 在堆上 `0x1000`，租到的槽位在 `0xA000`）：

```
StringTableHash 对象
├─ _table: InternalTable* ──→ _buckets: Bucket[65536]
│    （_log2_size=16, _size=65536, _hash_mask=65535）
│                                └─ 桶 #5: _first ──────────┐
│                                                            ↓
│                                                   ┌─────────────────────┐   ┌─────────────────────┐
│                                                   │ Node #1              │   │ Node #2              │
│                                                   │ _next ───────────────┼──→│ _next ──────────→ NULL│
│                                                   │ _value: WeakHandle   │   │ _value: WeakHandle   │
│                                                   │   (_obj = 0xA000)    │   │   (_obj = 0xB000)    │
│                                                   └─────────────────────┘   └─────────────────────┘
│                                                         │ _obj
│                                                         ↓
│                                              OopStorage 槽位 0xA000: [ 0x1000 ]
│                                                         ↓
│                                              Java 堆: String "abc" @ 0x1000   ← 数据本体在这
├─ _resize_lock                       ← 扩容/批量删除共用的锁（§3.4/§3.5）
└─ _log2_size_limit=24, _grow_hint=100  ← 构造后两个参数的落点（§3.6）
```

| 层次 | 结构 | 存什么 |
|------|------|--------|
| 表对象 | `ConcurrentHashTable`（StringTableHash） | `_table` 指针、`_resize_lock`、三个配置数 |
| 桶数组 | `InternalTable` | `_buckets` 数组 + `_log2_size`/`_size`/`_hash_mask` |
| 桶 | `Bucket` | 只有一个 `_first` 指针（Node* + 低 2 位状态），**不存数据** |
| 节点 | `Node` | `_next` + `_value`（WeakHandle），**无 hash 缓存** |
| 弱引用 | `WeakHandle` | 唯一字段 `_obj` = OopStorage 槽位地址 |
| 槽位 | OopStorage Block 内的 8 字节槽位 | oop（String 对象的当前堆地址） |
| 数据本体 | String 对象 | Java 堆（普通堆分配，见 §4.3） |

完整引用链：`CHT._table` → `InternalTable._buckets[i]`（Bucket）→ Node 链 → `Node._value`（WeakHandle）→ `_obj`（槽位地址）→ OopStorage 槽位 → oop → String 对象。

查表路径：**桶 → 遍历 Node（逐个 `peek()` 解引用比对字符内容）→ 命中后 `resolve()` 返回 String**。

查找时两者配合：`intern("abc")` 再次执行，先由 hash 定位桶，遍历 Node 链取得节点的 `_obj = 0xA000`，读 `*0xA000` 得到对象地址并比对内容。哈希表负责定位条目，OopStorage 负责提供对象的当前地址。

拆成两层的原因在 GC 移动对象时体现：GC 将 `"abc"` 从 `0x1000` 移至 `0x2000` 时，只需遍历 OopStorage 将槽位内容改为 `0x2000`；Node 与 WeakHandle 保存的槽位地址 `0xA000` 不随 GC 变化，哈希表整体无需被 GC 感知。若 Node 直接保存 oop，GC 必须理解哈希表内部布局并逐节点修正指针。

最后辨析"链表"：整个系统有两条互不相干的链——**桶上的 Node 链**（`_first` → `_next` → …，同桶条目的串联，本节）与 **OopStorage 的 `_allocation_list` 块链**（还有空槽位的 Block，§2.2）。前者回答"同桶的条目有哪些"，后者回答"哪个 Block 还能分配槽位"。

---

## 2. OopStorage——弱引用的物理存储

### 2.1 为什么需要它

"弱引用"需要一个**能感知 GC 的存储**：条目被 GC 判定为死时，存储要能发现并清理。OopStorage 就是这种存储——**它把 oop 存放在专用的块里，GC 通过特殊路径遍历这些块，识别并清理死条目**。

### 2.2 块（Block）与两个索引结构

```
OopStorage
├─ _allocation_list: 有可用空间的块链表    ← 分配用
├─ _active_array:    所有活跃块的数组       ← GC 遍历用
└─ 每个 Block:
   ├─ 一批 oop 指针槽位（按位图标记已用/空闲）
   └─ 状态：空闲/部分使用/已满
```

为什么两个结构？分配需要"找到有空位的块"（链表方便），GC 需要"遍历所有块"（数组方便）——一物两用。

### 2.3 双锁模型

```
_allocation_mutex:  保护分配/释放（块槽位的抢占）
_active_mutex:      保护活跃块数组的增删（GC 并发遍历时的安全）
```

两条锁的职责分开：分配线程抢 `_allocation_mutex`；GC 更新活跃块数组抢 `_active_mutex`。互不阻塞——分配不被 GC 遍历阻塞，GC 遍历不被分配阻塞。

### 2.4 allocate() 路径

```
allocate():
  拿 _allocation_mutex
  先处理 deferred updates（延迟归还的块）→ 也许能腾出空间
  用 _allocation_list 头部块 → 块里按位图找空槽 → 返回 oop*
  链表头没有可用块 → 释放锁 → 新建一个 Block → 挂回链表 → 再分配
```

一个小细节：`new Block` 是在**释放锁之后**做的（大内存操作不该持锁），期间其他线程可能已经建好块——所以重新加锁后要再看一次链表头。

### 2.5 GC 清理

```
两个入口:
  delete_empty_blocks_safepoint()    ← GC 暂停内（STW）直接清
  delete_empty_blocks_concurrent()   ← 暂停外并发清（CMS 等场景）
     └─ 找出 0 个活条目的块 → 从两个结构中摘除 → 释放整块内存
```

块是回收的**最小单位**：整块清空才释放，部分存活的块保留。

---

## 3. ConcurrentHashTable——无锁读的并发哈希表

### 3.1 与经典哈希表的根本差异

SymbolTable 的乐观锁：查找无锁，**插入必须拿锁**。
StringTable 的 ConcurrentHashTable：查找无锁，**插入也基本无锁**（CAS）；只有结构性批量操作拿锁——扩容与批量删除共用一把 resize 锁（§3.4/§3.5）。

### 3.2 桶头指针嵌入状态位

每个桶的链表头指针 `Node*` 的低 2 位被"借用"来存状态：

```
指针低 2 位: 00 = unlocked（正常，可读写）
            01 = locked   （写者正在改这个桶，CAS 设置）
            10 = redirect （这个桶已迁移到新表，读者请去新表）
```

为什么能借？`Node` 分配时保证 4 字节对齐——真实指针低 2 位恒为 0，正好用来编码状态。

### 3.3 无锁查找

```
internal_get(hash):
  bucket = get_bucket(hash & mask)    ← 掩码寻址
  node = bucket->first()              ← 读头指针（volatile）
  while (node): 
    比较值 → 命中？返回
    node = node->next()
  （若头指针是 redirect 状态 → 取新表重查）
```

读者全程无锁：读头指针、遍历链表。写者插入用 CAS 更新头指针；读到的要么是旧链表的某个一致状态，要么是 redirect 标志——都不会读到半更新状态。

### 3.4 插入与懒删除

```
get_insert_lazy(hash, value):
  桶头 CAS 插入新节点（失败则重试）
  ── 链表里的"死条目"（弱引用已死的）不立即删除，只标记

查找时发现死条目 → 记一个 have_dead 标志 → 继续找
真正的删除由 ServiceThread 用 BulkDeleteTask 并发批量做（§4.4）← "懒"
```

懒删除的动机：**删除要动链表指针，而读者在无锁遍历**——并发删除需要 epoch 同步，成本高。所以"发现死的不删，攒着等 GC 统计完死条目数后，由 ServiceThread 并发批量删"（时序见 §4.4）。

### 3.5 渐进式扩容

扩容不锁表，而是**逐桶迁移**：

```
grow():
  ① 拿 resize 锁 → 创建新表（容量 ×2，log2+1）
  ② 逐桶处理旧表:
     把该桶链表按新掩码拆成两半 → 挂到新表的第 i 桶和第 i+旧表大小 桶
     （源码称 even/odd siblings：hash 新高位为 0 留原位，为 1 迁到后半区）
     旧桶设 redirect → 等待在途读者退出（write_synchronize）
  ③ 全部迁移完 → 原子切换 _table 指向新表 → 删旧表
```

读者无感知：正在读的桶没被迁移就用旧链；遇到 redirect 就转新表。新表创建后旧表不会消失，直到所有桶迁移完——**两表共存期，读者永远能找到一个一致的桶**。

### 3.6 参数含义

```
new StringTableHash(log2size=16, 容量上限 24, rehash 阈值 100)
  log2size = 16   → 初始 2^16 = 65536 桶（_log2_start_size）
  上限 24        → 最多扩到 2^24 ≈ 1600 万桶（_log2_size_limit）
  阈值 100       → 单桶遍历超 100 个节点 → _needs_rehashing = true
                   （CHT 内参数名叫 _grow_hint，但 StringTable 接到 rehash：
                    safepoint 时换 alt hash、按当前大小重建表——不是扩容；
                    扩容 grow 由负载因子 > 2 触发，见 §4.4 阶段三）
```

### 3.7 rehash——分布失衡时的换 hash 重建

链表变长有两个原因：条目真的多，或者 hash 分布失衡。**扩容治"多"，rehash 治"偏"**——这是与 grow 并行的第二条自救路径。

触发链：

```
插入/查找时（do_intern 的 get_insert_lazy、do_lookup 的 get）:
  单桶遍历节点数 > 100（REHASH_LEN）
    → CHT 输出 *grow_hint = true → do_intern 置 _needs_rehashing = true

下一次 safepoint（VM 线程，safepoint.cpp）:
  is_cleanup_needed() 发现 _needs_rehashing
    → do_cleanup_tasks 中 StringTable::rehash_table()
```

执行入口 `try_rehash_table` 按条件分三条路：

| 条件 | 动作 |
|------|------|
| 负载因子 > 2 且未到上限 | **改走扩容**（trigger_concurrent_work）——条目真的多，换 hash 没用 |
| 已 rehash 过（`static bool rehashed`） | 不再 rehash，只触发并发清理——**JVM 生命周期内最多 rehash 一次** |
| 其余（分布失衡） | 换 seed 重建：`_alt_hash_seed = AltHashing::compute_seed()` → `do_rehash()` |

三行是**每次进入时三选一的互斥分支**，"最多一次"由第二行的拦截形成：

- **第一次失衡**：`rehashed == false`，落到第三行——换 seed、`do_rehash()` 成功后置 `rehashed = true`
- **之后的失衡**：第二行命中，只触发并发清理直接返回，第三行永远不可达

只允许一次的原因：第一次 rehash 已切换到带随机 seed 的 siphash——若新 seed 下仍出现长桶，说明不是碰撞攻击而是业务本身有大量同 hash 内容，再换 seed 改变不了分布，不如留给扩容和清理处理。

重建（`do_rehash`）：按**当前大小**建新表（不扩容——源码注释 "We use current size, not max size"）→ `_alt_hash = true` → `try_move_nodes_to` 迁移全部节点 → 删旧表换指针。若此时有扩容/批量删除正在进行（`!is_safepoint_safe()`）则放弃本次。必须在 safepoint 由 VM 线程执行的原因与 SymbolTable 相同（01 §2.2）——mutator 正在无锁读表，不能边读边重建。

`_alt_hash = true` 的效果：从此时起，查找/插入的 hash 算法从 `java_lang_String::hash_code`（与 Java `String.hashCode()` 同算法——CDS 共享表依赖它跨进程一致，源码注释 "shared table always uses java_lang_String::hash_code"）切换为 `AltHashing::halfsiphash_32(_alt_hash_seed, ...)`。新 seed 是重建时现算的随机数，攻击者预先构造的碰撞串全部失效——与 SymbolTable 换 seed 的目的相同（01 §2.2），差异在 StringTable 平时必须使用 Java 兼容的 hash，只在失衡后才切到带 seed 的 siphash。

关于 `java_lang_String::hash_code` 的三点澄清：

1. **`String.hashCode()` 是 Java 规范钉死公式的内容 hash**：`hash = s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]`——`"abc".hashCode()` 在任何 JVM 上恒为 96354。它重写了 `Object.hashCode()` 的身份 hash（与内容无关）；StringTable 按内容去重，只能使用内容 hash。
2. **`java_lang_String::hash_code` 是同一公式的 C++ 实现**（JVM 内部工具函数），不是经 JNI 调用 Java 方法——C++ 代码借此在不进入 Java 的情况下得到与 Java 侧一致的结果。
3. **分桶选它的原因**：CDS 的共享字符串表按此固定算法定位桶（归档跨进程一致的要求）。CDS 默认不开启；不开启时共享表为空，查找直接落到本地表。

切换只改 StringTable **内部**的桶分布，两点有源码为证。

① 切换只作用于本地表查找路径：`lookup()` 中 `if (_alt_hash)` 只包裹 `do_lookup` 前的重算——共享表查找在此判断之前，但 CDS 默认不开启、共享表为空直接跳过，主流流程不受影响。

**② Java 层 `String.hashCode()` 的返回值不受影响**（java/lang/String.java）：

```java
public int hashCode() {
    int h = hash;
    if (h == 0 && value.length > 0) {
        hash = h = isLatin1() ? StringLatin1.hashCode(value)
                              : StringUTF16.hashCode(value);
    }
    return h;
}
```

由 String 对象自行计算并缓存在 `hash` 字段，与 StringTable 的分桶算法无任何调用关系——StringTable 换不换 hash，动不了这个方法的返回值。

---

## 4. intern 完整路径

### 4.1 入口：String.intern() → JVM_InternString

```cpp
// jvm.cpp
JVM_ENTRY(jstring, JVM_InternString(JNIEnv *env, jstring str))
  JvmtiVMObjectAllocEventCollector oam;
  if (str == NULL) return NULL;
  oop string = JNIHandles::resolve_non_null(str);
  oop result = StringTable::intern(string, CHECK_NULL);
  return (jstring) JNIHandles::make_local(env, result);
JVM_END
```

`String.intern()` 是 Java 侧标记的 `native` 方法，JVM 经 JNI 收到 `jstring` → 解出堆上 `oop` → 交给 `StringTable::intern()` → 结果包装回 `jstring` 返回。逐行：

- **`JVM_ENTRY`**：JNI 入口宏，展开为函数签名 + 线程环境获取（非 C++ 标准语法，HotSpot 内部基础设施）
- **`JvmtiVMObjectAllocEventCollector`**：栈上 RAII 对象，析构时通知 JVMTI 调试器——只用于诊断，不影响主流程
- **`if (str == NULL) return NULL`**：空串提前返回
- **`JNIHandles::resolve_non_null(str)`**：`jstring` 不是直接 oop——它是 JNI 句柄指针，指向线程 JNIHandleBlock（每个线程的 32 槽固定块链表，结构见 ch03/06）里的一个槽位，槽位内才存着对象在堆上的真实地址。`resolve` 从槽位读出这个 oop（底层 `reinterpret_cast<oop*>(handle)` + `oop_load`）。这一层间接与 OopStorage 同一原理：传一个 GC 能更新的槽位地址，比传会野的裸 oop 安全

  > JNI（Java Native Interface）是 Java 调用 `native` 方法的唯一协议栈。**只有 JNI 边界的传参才走 JNIHandleBlock**——此处 `intern()` 是 native 方法，所以参数包在 `jstring` 里；进入 `StringTable` 内部后（§4.2 以下），所有 C++ 互调直接传 `oop`，不再经过 JNI 句柄。
- **`StringTable::intern(string, CHECK_NULL)`**：核心调用，进入 §4.2-4.3 的主路径；`CHECK_NULL` 是异常检查宏（若 intern 内部因 OOM 抛异常，自动返回 NULL）
- **`JNIHandles::make_local(env, result)`**：结果转回 JNI 局部引用，返回给 Java 调用者

### 4.2 StringTable::intern()——主入口

```cpp
// stringTable.cpp（public 重载——JVM_InternString 调的就是它）
oop StringTable::intern(oop string, TRAPS) {
  if (string == NULL) return NULL;
  ResourceMark rm(THREAD);
  int length;
  Handle h_string(THREAD, string);                          // 包 Handle：保护 oop 不被 GC 搬野
  jchar* chars = java_lang_String::as_unicode_string(string, length, CHECK_NULL);
  oop result = intern(h_string, chars, length, CHECK_NULL); // 调私有实现
  return result;
}
```

逐行：

- **空值检查**：`if (string == NULL) return NULL`
- **`ResourceMark rm(THREAD)`**：标记当前 ResourceArea 水位——`as_unicode_string` 的 `jchar[]` 临时缓冲区从此处分配；函数结束时自动回滚回收
- **`int length`**：声明，由 `as_unicode_string` 输出字符串长度
- **包装 Handle**：`Handle h_string(THREAD, string)` 将 oop 存入线程 HandleArea 槽位——`intern()` 内部可能触发 GC（分配字符串、去重），裸 oop 会野；Handle 通过槽位间接读写，GC 更新槽位值后仍拿到最新地址（原理见 ch08/02）。这不是多余的来回包装——JNIHandleBlock（jstring 的槽位）和 HandleArea（Handle 的槽位）是两套不同的池子：JNI 管着 JNIHandleBlock 的生命周期（native 返回时自动释放），内部代码管着 HandleArea（HandleMark 按 C++ 作用域释放）；两者不能互用，`intern()` 的 GC 暴露点在 HandleMark 作用域内，必须用自己的池子。**先于 `as_unicode_string` 包装**——因为 `as_unicode_string` 使用 `CHECK_NULL`（内部可能因 OOM 抛异常触发 GC），此时 oop 已在 Handle 保护下
- **提取字符**（`as_unicode_string`）：从 String 对象的内部 `byte[]`（JDK 9+ 分 LATIN1/UTF16 两种编码）转为 `jchar[]`。无论哪种编码，均用 `NEW_RESOURCE_ARRAY_RETURN_NULL(jchar, length)` 从 ResourceArea 分配新空间并逐个复制——LATIN1 逐字节零扩展（1B→2B），UTF16 逐 char 拷贝。不能直接用堆上的 `byte[]`——GC 会搬动，裸指针不安全；且 LATIN1 必须扩容。结果指向 ResourceArea 临时缓冲区，`ResourceMark` 析构时自动回收
- **调用私有实现**：`intern(h_string, chars, length, CHECK_NULL)` 进入真正的 hash 计算 + 查表路径
- **`return result`**

私有实现在下面紧接着——算 hash、查本地表、未命中则插：

```cpp
// stringTable.cpp（私有实现——省略 CDS 共享表查找，默认不开启）
oop StringTable::intern(Handle string_or_null_h, jchar* name, int len, TRAPS) {
  unsigned int hash = java_lang_String::hash_code(name, len);  // ① 算 hash
  if (StringTable::_alt_hash) {                                // ② rehash 过 → 换 siphash
    hash = hash_string(name, len, true);
  }
  oop found_string = StringTable::the_table()->do_lookup(     // ③ 本地表纯查找
    name, len, hash);
  if (found_string != NULL) {                                  //    命中 → 直接返回
    return found_string;
  }
  return StringTable::the_table()->do_intern(                 // ④ 未命中 → 插入
    string_or_null_h, name, len, hash, THREAD);
}
```

逐行：

- **① 算 hash**：Java 规范固定公式（与 §3.7 一致）
- **② alt 判断**：若 rehash 过，换为 `halfsiphash_32`（随机 seed）。日常路径该标志为 false，跳过
- **③ 本地表纯查找**：调 `do_lookup` 无锁遍历 CHT——`intern()` 本身**也做查找**（只查不插），命中已有 String 直接返回，不等于"看都不看就看 do_intern 插入"
- **④ 调 `do_intern`**：只有步骤③未命中才走到这里——去建 String、get_insert_lazy 查+插（§4.4）

### 4.3 do_lookup——本地表纯查找

`do_lookup` 是 `intern()` 私有实现里步骤③调用的纯查找函数——只查不插，无锁读 CHT：

```cpp
// stringTable.cpp
oop StringTable::do_lookup(jchar* name, int len, uintx hash) {
  Thread* thread = Thread::current();
  StringTableLookupJchar lookup(thread, hash, name, len);
  StringTableGet stg(thread);
  bool rehash_warning;
  _local_table->get(thread, lookup, stg, &rehash_warning);
  if (rehash_warning) {
    _needs_rehashing = true;
  }
  return stg.get_res_oop();
}
```

逐行：

- **`Thread::current()`**：拿到当前线程——遍历过程中需要线程上下文
- **`StringTableLookupJchar lookup(...)`**：创建"比对器"对象，将待查目标（字符内容 `name`+`len`、hash `hash`）存入其中。稍后 CHT 遍历每个 Node 时调 `lookup.equals(node->_value)`："这个条目是不是我要找的？"
- **`StringTableGet stg(thread)`**：创建"结果接收器"对象——当前为空。之所以需要独立的容器而非通过 `get` 返回值传出来，是因为 `get` 的签名返回 `void`——CHT 作为通用模板无法表达"匹配项应转换成什么格式"（StringTable 要 oop Handle，ResolvedMethodTable 要 Metadata Handle）。于是 CHT 规定协议：遍历中匹配到条目后调 `stg(val)`，你自己把结果记下；遍历结束后用 `get_res_oop()` 取出——`stg` 就是这个自管理的结果容器
- **`_local_table->get(thread, lookup, stg, ...)`**：将两个对象交给 CHT——CHT 调 `lookup.get_hash()` 定位桶、遍历 Node、每个 Node 调 `lookup.equals()` 比对、命中则调 `stg()` 记结果。**全程 CHT 不认识 String、不认识 Handle**——这两个对象是 StringTable 与 CHT 之间的协议：通过它们把 String 特有的比对逻辑和结果存储方式传进通用的 CHT 遍历引擎

`do_lookup` 传给 CHT 的两个对象的真实定义（源码紧接着）：

```cpp
// ① 查找回调——CHT 每遇到一个 Node 就调 equals 一次
class StringTableLookupJchar : StackObj {
  Thread* _thread;
  uintx  _hash;
  int    _len;
  const jchar* _str;              // 待查找的目标字符内容
  Handle _found;                  // 匹配成功后才填入

  uintx get_hash() const { return _hash; }

  bool equals(WeakHandle<vm_string_table_data>* value, bool* is_dead) {
    oop val_oop = value->peek();                             // 从句柄槽位读 oop
    if (val_oop == NULL) { *is_dead = true; return false; }  // 槽位已清 → 死条目
    bool eq = java_lang_String::equals(val_oop, (jchar*)_str, _len);  // 比内容
    if (!eq) return false;                                   // 内容不同 → 下一个
    _found = Handle(_thread, value->resolve());              // 匹配！保活 + 记结果
    return true;
  }
};

// ② 命中回调——equals 返回 true 后 CHT 调它一次
class StringTableGet : StackObj {
  Thread* _thread;
  Handle  _return;                    // 收到的匹配 String 用 Handle 存入
  void operator()(WeakHandle<vm_string_table_data>* val) {
    oop result = val->resolve();      // 保活读
    _return = Handle(_thread, result);
  }
  oop get_res_oop() { return _return(); }
};
```

**调用链展开**——`get(thread, lookup, stg)` 内部按以下顺序驱动两个回调：

1. CHT 调 `lookup.get_hash()` → 取得 hash → 掩码定位桶
2. 从桶头指针开始遍历 Node 链
3. **对每个 Node** 调 `lookup.equals(node->_value, &is_dead)`：
   - `peek()` 从句柄槽位读 oop → `NULL` → 死条目，标记 `is_dead=true`，CHT 知道需要清理
   - 非 NULL → `java_lang_String::equals` 逐字符比对——Node 里存的是 OopStorage 槽位地址（WeakHandle），并非 String 本体；`peek` 第一次跳：从槽位取 oop（堆上 String 的地址）；`equals` 第二次跳：拿出堆上 String 对象内容，与 `_str`（传入的待查字符）逐字符比对
   - 内容不同 → 跳到下个 Node（③ 循环）
   - 内容匹配 → `resolve()` 保活读 → 存入 `_found` → 返回 true
4. CHT 收到 equals 的 true → 调 `stg(val)` 传回匹配的 WeakHandle → `resolve + Handle` 化
5. `do_lookup` 调 `stg.get_res_oop()` 取出匹配的 String oop 返回

**不建 Node、不写表**——全程只读 CHT 已有节点，命中了才记结果 Handle。这是它与 `get_insert_lazy`（§4.4——查不到就插入）的关键区别。

`do_lookup` 与 `do_intern` 的分工：`do_lookup` 做纯查找（CHT::get），命中则省掉后续 `get_insert_lazy` + `create_from_unicode` 的开销；未命中才进 `do_intern` 的"建字符串 + 查+插"流程。

### 4.4 do_intern——先建 String，再查表决定去留

> 进入 `do_intern` 时，`intern()` 已经做完 hash 计算和本地表纯查找（§4.3）——两次查找都未命中，表中确实没有这个内容的 String。必须走"建对象 + 插入"的完整插入路径。

```cpp
// stringTable.cpp
oop StringTable::do_intern(Handle string_or_null_h, jchar* name,
                           int len, uintx hash, TRAPS) {
  HandleMark hm(THREAD);
  Handle string_h;

  if (!string_or_null_h.is_null()) {
    string_h = string_or_null_h;
  } else {
    string_h = java_lang_String::create_from_unicode(name, len, CHECK_NULL);
  }

  Universe::heap()->deduplicate_string(string_h()); // 默认什么都不做

  StringTableLookupOop lookup(THREAD, hash, string_h);
  StringTableCreateEntry stc(THREAD, string_h);

  bool rehash_warning;
  _local_table->get_insert_lazy(THREAD, lookup, stc, stc, &rehash_warning);
  if (rehash_warning) {
    _needs_rehashing = true;
  }
  return stc.get_return();
}
```

入参：

| 参数 | 来源 | 含义 |
|------|------|------|
| `string_or_null_h` | §4.2 公共重载传入（可能空） | 已有 Java String 的 Handle 包装。非空 = 复用现有对象；空 = 需新建 |
| `name` | `as_unicode_string` 返回 | 字符内容的 `jchar*` 指针，指向 ResourceArea 临时缓冲区 |
| `len` | `as_unicode_string` 输出 | 字符数组长度 |
| `hash` | `intern()` 私有实现计算 | 已算好并完成 alt 判断的 hash 值 |
| `TRAPS` | JVM 框架 | 异常处理——内部 OOM 时自动返回 NULL |

返回 `oop`——已 intern 的 String 对象（可能是新建的或查表命中的已有对象）。

逐行：

- **`HandleMark hm`**：标记当前 HandleArea 水位——作用域内创建的临时 Handle（如下面 `string_h`）在 `hm` 析构时自动回收
- **建 String**：若调用方已有 String 对象（`intern(oop)` 路径——从 JVM_InternString Java 侧传入），直接复用；若为空（`intern(Symbol*)` 或 `intern(const char*)`——JVM 内部拿 Symbol/C 字符串查驻留，没有现成 Java String），则 `create_from_unicode` 在**堆上**普通分配一个新 Java String 对象
- **去重**：`deduplicate_string(string_h())`——基类 `CollectedHeap` 默认实现为空（Serial/Parallel GC 下什么都不做）。G1 覆写中检查 `G1StringDedup::is_enabled()`：默认 `-XX:-UseStringDeduplication` 关闭，同样什么都不做；只有显式开启时，G1 在 GC 期间将同内容的 String 重指向共用的底层 `byte[]`（省内存）。日常路径此行为 no-op。注释强调必须在 intern 之前做——任何在 intern 后才动 byte[] 的去重，会破坏 JIT 对符号串"同一对象"的编译优化假设
`do_intern` 的查找与插入由两个回调对象驱动——与 §4.3 的 `do_lookup` 对称，但第二个对象多了一个"建新条目"的重载：

```cpp
// ① 查找回调——用已有 String 对象比对（与 do_lookup 的 jchar 版对应）
class StringTableLookupOop : StackObj {
  Thread* _thread;
  uintx  _hash;
  Handle _find;           // 待驻留的 String（新建的候选）
  Handle _found;          // 查表中的匹配值才记入这里

  uintx get_hash() const { return _hash; }
  bool equals(WeakHandle<vm_string_table_data>* value, bool* is_dead) {
    oop val_oop = value->peek();
    if (val_oop == NULL) { *is_dead = true; return false; }
    bool eq = java_lang_String::equals(val_oop, _find());   // 比 String 内容
    if (!eq) return false;
    _found = Handle(_thread, value->resolve());             // 匹配 → 记结果
    return true;
  }
};

// ② 插入回调——一个对象两种重载，覆盖命中与未命中
class StringTableCreateEntry : StackObj {
  Thread* _thread;
  Handle  _return;       // 命中：已有匹配 → resolve 记这里
  Handle  _store;        // 未命中：新建的候选 String 准备存入

  StringTableCreateEntry(Thread* thread, Handle store)
    : _thread(thread), _store(store) {}

  // 未命中：CHT 需要"建新值"时调它
  WeakHandle<vm_string_table_data> operator()() {
    return WeakHandle<vm_string_table_data>::create(_store);  // 租 OopStorage 槽位 + 写入 oop
  }

  // 命中：CHT 需要"记已有值"时调它
  void operator()(bool inserted, WeakHandle<vm_string_table_data>* val) {
    oop result = val->resolve();
    _return = Handle(_thread, result);
  }

  oop get_return() const { return _return(); }
};
```

### `get_insert_lazy`——查不到就插入，一个调用完成

`_local_table->get_insert_lazy(thread, lookup, stc, stc, &rehash_warning)` 的内部流程——与 `get`（§4.3）的不同全在命中/未命中的分岔，`stc` 在未命中场景被调两次，但不是循环：

1. CHT 调 `lookup.get_hash()` → 定位桶
2. 遍历 Node 链，每个 Node 调 `lookup.equals`
3. **命中**：`equals` 返回 true → CHT 调 `stc(inserted=true, val)` → 记已有 String → 不继续遍历，不做插入——这叫 callback_f 的回调，只调用一次
4. **未命中**（遍历完整条链无匹配）——`stc` 被调用两次，顺序进行：
   - **第一次** `stc()` → CHT 调 val_f 需要"建新值" → `operator()()` → `WeakHandle::create` 租槽位 + 写入 oop，返回 WeakHandle 给 CHT
   - CHT 用此 WeakHandle 建新 Node，CAS 桶头
   - **第二次** `stc(inserted=true, val)` → CHT 调 callback_f 完成通知 → `operator(bool, val)` → resolve oop，记入 `_return` 
   两次调用无环——建值工厂 → 插入桶头 → 记结果——单向顺序三件事
5. `do_intern` 调 `stc.get_return()` → 返回已有/新建的 String oop

`stc` 以**两个不同角色**传入 `get_insert_lazy`（参数中连续传两个 `stc`）：第一次出现是"插入工厂"（`operator()()`），第二次是"命中回调"（`operator(bool, val)`）。`StringTableGet`（§4.3）只做命中回调——`StringTableCreateEntry` 多了"建值"这一步。

关键的"先创建、后决定去留"：先 `create_from_unicode` 分配候选 String——`get_insert_lazy` 发现已有同内容的就以查到的为准；新建的被丢弃，`HandleMark` 析构后孤悬为普通垃圾等 GC 回收。表里存的是 `WeakHandle`，String 本体是普通堆对象——OopStorage 只是"条目槽位存储"。

### 4.5 GC 中的回收

#### 弱引用的机制——"检查但不保活"

StringTable 的条目是弱引用，实现上是 **OopStorage 的弱遍历（weak_oops_do）**。核心问题：GC 怎么知道"这个指针不算数，别阻止回收"？

GC 从根出发遍历对象图，**被强引用链到达的对象 = 活**。普通指针（强引用）在遍历时被保活；弱引用的关键在于**遍历时只检查、不保活**：

```
OopStorage 的两种遍历（oopStorage.hpp）:
  oops_do（strong）:      对每个槽位的 oop 做保活处理
                          → 对象被标记为活，继续遍历它的字段

  weak_oops_do（weak）:   对每个槽位的 oop 做检查
                          → is_alive(oop)？ 活 → keep_alive（保留槽位）
                                          死 → 槽位清为 NULL（不保留）
```

StringTable 在 GC 时用的是 **weak_oops_do**——所以它的条目**不会保活任何 String**：String 的死活完全由其他强引用决定，表条目不插手。

#### 完整流程（GC 标记 + GC 后并发清理）

清理分两个时间点：**GC 暂停内只做"标记死槽位 + 计数"**，真正的节点删除是 GC 之后由 **ServiceThread 并发执行**的——不在 GC 暂停里。

```
阶段一（GC 暂停）：标记（从根遍历）
  某个 String 有强引用链 → 标记为活
  没有 → 不标记（表条目"指"着它，但那是弱引用，不算数）

阶段二（GC 暂停）：弱遍历 OopStorage（StringTable 的条目槽位）
  weak_oops_do 逐个检查:
    is_alive(String)? 
      活 → keep_alive（槽位保留，条目继续有效）
      死 → 槽位清为 NULL（条目成为"死条目"，等后续删除）
  同时统计死条目数 → 累加到 _uncleaned_items

阶段三（GC 暂停尾声）：判断是否触发清理
  check_concurrent_work():
    死条目比例 > 50%（CLEAN_DEAD_HIGH_WATER_MARK）
    或 负载因子 > 2（PREF_AVG_LIST_LEN）→ trigger_concurrent_work()
       → _has_work = true，唤醒 ServiceThread

阶段四（GC 之后，并发）：ServiceThread 执行清理
  do_concurrent_work → clean_dead_entries:
    BulkDeleteTask 逐段扫哈希表 → 删除槽位为 NULL 的死条目
    → 删 Node 时 WeakHandle release → 槽位归还 OopStorage
```

源码入口（stringTable.cpp）：

```
GC 内:
  possibly_parallel_unlink(ParState, is_alive)     ← G1 等：ParState 并行遍历块
  unlink_or_oops_do(is_alive)                      ← 串行版（无 ParState）
    └─ _weak_handles->weak_oops_do(...)  → 死槽位清 NULL + 计数

GC 后并发（ServiceThread，serviceThread.cpp）:
  do_concurrent_work → clean_dead_entries
    └─ BulkDeleteTask 扫表删死条目 → free_node 时 release 槽位
```

弱引用的完整闭环：interned String 没人引用 → GC 标记为死、槽位清 NULL → ServiceThread 从哈希表批量删除 → 槽位归还 → 块清空后整块释放。

---

## 5. 小结——重写的收益与代价

```
StringTable 初始化全景:
  create_table()
    └─ new StringTable()
         ├─ OopStorage      → 弱引用槽位存储（双锁 + 块管理）
         ├─ 2^16 桶          → 掩码寻址（对比 SymbolTable 的质数取模）
         └─ ConcurrentHashTable → 无锁读 + 渐进扩容

rehash   : 单桶遍历 > 100 → safepoint 换 alt hash 同大小重建
           （JVM 内最多一次；负载因子 > 2 时改走扩容）

收益:
  查找全程无锁 → intern 热路径不再竞争
  弱引用      → interned String 可回收，长跑应用不膨胀

代价:
  实现复杂度高（状态位、redirect、epoch 同步、懒删除）
  扩容是渐进式而不是瞬间完成（期间两表共存）
  删除攒到 GC 后由 ServiceThread 并发批量做（懒删除，不在 GC 暂停内）
```

> **下一篇**：[14.3 ResolvedMethodTable 初始化 + 三表对比](03-resolved-method-table-create.md)——经典表 + 弱引用的组合，以及三张表的设计对比。
