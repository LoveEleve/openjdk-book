# 14.1 SymbolTable —— 符号表的去重与引用计数

> **本文定位**：SymbolTable 全线——从 JVM 业务作用到 `Hashtable<Symbol*, mtSymbol>` 内部结构、Arena vs C-heap 分配策略、double-check lock 的 lock-free 查找、`TempNewSymbol` 引用计数 RAII、unlink GC 清理机制、CDS `CompactHashTable` 共享表。
>
> **前置依赖**：[ch10/07 Metaspace 背景知识](../ch10/07-metaspace.md)——理解 Arena 分配器和 `Hashtable` 基类的 bucket-entry 链表结构。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码。

---

## 1. SymbolTable 在 JVM 中的作用

### 1.1 Symbol 是什么

`Symbol`（`oops/symbol.hpp`）是 JVM 中的 **C++ 原生字符串**——一个 UTF-8 字节序列，附带 reference count。它在 Metaspace 中分配（不是 Java 堆），GC 不可见。

`Symbol` vs `String` 的区别是一个基础问题：

| | Symbol | String |
|---|---|---|
| 语言层 | C++ 对象 | Java 对象（`java.lang.String`） |
| 存储位置 | Metaspace | Java 堆 |
| GC 可见 | 否（但通过 `unlink` 手动清理） | 是（可达性分析） |
| 生命周期 | 由类加载器生命周期决定 | 由引用决定 |
| 编码 | UTF-8（紧凑） | UTF-16（Java 内部编码） |
| 管理方式 | refcount（`_length_and_refcount`） | GC 根集可达性 |

`Symbol` 存储 UTF-8 是因为 class file 中 CONSTANT_Utf8 本身就是 UTF-8 编码——不需要转换。而且 UTF-8 比 UTF-16 节省一半空间（大部分类/方法/字段名是 ASCII 字符，UTF-8 只占 1 字节，UTF-16 占 2 字节）。

### 1.2 为什么需要 SymbolTable

每一个 Java 类的类名、方法名、字段名、类型描述符都以 `Symbol*` 形式存储在 SymbolTable 中。class file 解析器（`ClassFileParser`）遇到 CONSTANT_Utf8 时调用 `SymbolTable::lookup()`，如果表中已有就复用同一个 `Symbol*`（去重 / canonicalization），没有则新建后插入。

**如果没有 SymbolTable**：class file 中同一个 UTF8 常量（例如 `"Ljava/lang/Object;"`）出现上百次就会分配上百次——内存爆炸。SymbolTable 的去重是 JVM 能正常启动的前提。

### 1.3 典型流程

```
ClassFileParser 读取 class 文件
  ↓
遇到 CONSTANT_Utf8 "Ljava/lang/Object;"
  ↓
SymbolTable::lookup("Ljava/lang/Object;", len, THREAD)
  ↓
hash_to_index(hash) → bucket 链遍历
  ↓
  找到 → 返回已有 Symbol*（refcount++）
  未找到 → 持锁 → double-check → allocate_symbol → 插入 → 返回新 Symbol*
```

### 1.4 数量级

一个典型 JVM 进程有 **50K-100K 个 Symbol**，每个 Symbol 平均 20-50 字节。最长的 Symbol 是高度重复的类名和描述符。SymbolTable 的固定大小（默认 20011 个 bucket）对这个数量级来说 bucket 平均 2.5-5 个 entry，冲突不大。

---

## 2. 内部结构

### 2.1 类层次

```
CHeapObj<mtSymbol>
  └─ BasicHashtable<mtSymbol>
       └─ Hashtable<Symbol*, mtSymbol>          ← bucket数组 + entry链表 + hash
            └─ RehashableHashtable<Symbol*, mtSymbol>  ← rehash支持
                 └─ SymbolTable
```

`SymbolTable`（`symbolTable.hpp:101`）继承自 `RehashableHashtable<Symbol*, mtSymbol>`，本质上是一个固定 bucket 数的开放哈希表。

### 2.2 核心字段

```cpp
/* === src/hotspot/share/classfile/symbolTable.hpp === */

class SymbolTable : public RehashableHashtable<Symbol*, mtSymbol> {
  static SymbolTable* _the_table;                    // 单例
  static Arena*  _arena;                             // bootstrap 永久符号的 Arena
  static CompactHashtable<Symbol*, char> _shared_table;  // CDS 共享符号表（mmap）
  static bool _needs_rehashing;                      // 需要 rehash 的标志
  static bool _lookup_shared_first;                  // 自适应：先查共享表还是先查动态表
  static int _symbols_removed;                       // GC 统计
  static int _symbols_counted;
};
```

`_the_table` 是单例——JVM 只有一个 SymbolTable，通过 `the_table()` 全局访问，`create_table()` 只调用一次。

### 2.3 构造函数

```cpp
SymbolTable()
  : RehashableHashtable<Symbol*, mtSymbol>(SymbolTableSize,
      sizeof(HashtableEntry<Symbol*, mtSymbol>)) {}
```

`SymbolTableSize`（默认 20011）决定 bucket 数——**固定不变**。SymbolTable 不像 StringTable 那样自动扩容，它的 bucket 数从构造到 JVM 退出始终不变。冲突多了走 rehash（重建同大小但不同 hash 函数的表）而非扩容。

### 2.4 `_arena`——bootstrap 符号的永久 Arena

`initialize_symbols(symbol_alloc_arena_size)`（`symbolTable.cpp` 开头）创建 Arena，初始大小 360KB（`symbol_alloc_arena_size = 360*K`，`symbolTable.hpp:166`）。bootstrap class loader 加载的类的符号从这里分配——永不 GC、永不释放。自定义 class loader 的符号从 C-heap 分配（`os::malloc`），在 loader 被卸载时通过 GC 的 `unlink` 回收。

---

## 3. 分配策略：Arena vs C-heap

### 3.1 `allocate_symbol`

```cpp
Symbol* SymbolTable::allocate_symbol(const u1* name, int len, bool c_heap, TRAPS) {
  // c_heap=false → 从 _arena 分配（bootstrap loader 的永久符号）
  // c_heap=true  → os::malloc 分配（自定义 loader 的可回收符号）
  Symbol* sym;
  if (c_heap) {
    sym = new (len) Symbol(name, len, PERM_REFCOUNT);   // C-heap
  } else {
    sym = new (len) Symbol(name, len, PERM_REFCOUNT);   // Arena
  }
  // ...
}
```

决定 `c_heap` 的标志来自调用方——`ClassFileParser` 解析类时，如果是 bootstrap class loader（`loader_data->is_the_null_class_loader_data()`）则 `c_heap=false`，其他 loader 则 `c_heap=true`。

### 3.2 为什么分两种

- **bootstrap 符号**：JVM 核心类的符号永远不会卸载（bootstrap loader 永不 GC）→ Arena 分配最省：不考虑 free，没有碎片管理开销
- **自定义 loader 符号**：loader 可能被卸载 → 符号需要能释放 → `os::malloc` / `os::free` 管理

---

## 4. lookup 和 basic_add —— 双重检查锁

### 4.1 lookup——lock-free 预查 + 持锁添加

```cpp
/* === src/hotspot/share/classfile/symbolTable.cpp === */

Symbol* SymbolTable::lookup(const char* name, int len, TRAPS) {
  unsigned int hashValue = hash_symbol(name, len);
  int index = the_table()->hash_to_index(hashValue);

  // ① lock-free 预查
  Symbol* s = the_table()->lookup(index, name, len, hashValue);
  if (s != NULL) return s;           // ← 90%+ 在这里命中！

  // ② 未找到 → 持锁
  MutexLocker ml(SymbolTable_lock, THREAD);

  // ③ 不重复 ① 的预查——直接 basic_add（内部会 double-check）
  return the_table()->basic_add(index, (u1*)name, len, hashValue, true, THREAD);
}
```

### 4.2 basic_add——持锁下的 double-check

```cpp
Symbol* SymbolTable::basic_add(int index_arg, u1 *name, int len,
                                unsigned int hashValue_arg, bool c_heap, TRAPS) {
  // ... 长度检查、rehash 处理 ...

  // ① double-check：锁内重新查找
  Symbol* test = lookup(index, (char*)name, len, hashValue);
  if (test != NULL) {
    return test;  // ← 另一个线程已经添加了这个符号
  }

  // ② 真正创建新 Symbol
  Symbol* sym = allocate_symbol(name, len, c_heap, CHECK_NULL);
  HashtableEntry<Symbol*, mtSymbol>* entry = new_entry(hashValue, sym);
  add_entry(index, entry);  // 插入 bucket 链表头部
  return sym;
}
```

### 4.3 为什么 lock-free 预查有效

90%+ 的 lookup 在 lock-free 阶段就命中了（符号去重就是让"已存在"成为最常见情况）。**如果每次 lookup 都持 `SymbolTable_lock`，这个锁会成为类加载的瓶颈**——所有并发类加载都需要互斥。

双重检查锁的 trade-off：lock-free 预查快（不存在就持锁），锁内 double-check 安全（防止竞态）。代价是 look-up 时哈希可能已在 rehash 后过期——所以锁内会 recalculate hash。

---

## 5. vmSymbols——JVM 预定义的 540 个符号

### 5.1 是什么

`vmSymbols.hpp` 定义了约 540 个 JVM 内部代码频繁使用的预定义符号（542 个 `template(` 条目）：

```cpp
// 类名
template(java_lang_Object, "java/lang/Object")
template(java_lang_String, "java/lang/String")
template(java_lang_Class,  "java/lang/Class")

// 方法名
template(object_initializer_name, "<init>")
template(class_initializer_name, "<clinit>")

// 签名
template(void_method_signature, "()V")
template(int_void_signature,    "()I")
```

### 5.2 为什么需要预定义

JVM 内部代码（解释器、编译器、GC）频繁引用这些符号——例如 `SystemDictionary::Object_klass()` 需要 "java/lang/Object" 来查找已加载的 Object 类。**如果每次都查 SymbolTable 太慢**——直接用 `vmSymbols::java_lang_Object()` 返回固定的 `Symbol*` 指针。

这些符号在 JVM 启动时通过 `vmSymbols::initialize()` → `SymbolTable::new_permanent_symbol()` 批量创建，分配在 `_arena` 中（永不 GC）。

---

## 6. TempNewSymbol——引用计数 RAII

### 6.1 问题

`Symbol*` 是裸指针——它指向 Metaspace 中的 Symbol 对象。Symbol 有一个 `_length_and_refcount` 字段跟踪引用计数。但 C++ 不自动管理裸指针的引用计数——如果忘记 `increment_refcount` 或 `decrement_refcount`，Symbol 会过早或永远不释放。

### 6.2 TempNewSymbol RAII

```cpp
/* === src/hotspot/share/classfile/symbolTable.hpp */

class TempNewSymbol : public StackObj {
  Symbol* _temp;
public:
  TempNewSymbol() : _temp(NULL) {}
  TempNewSymbol(Symbol *s) : _temp(s) {}                      // 构造不 inc（调用方已 inc）
  TempNewSymbol(const TempNewSymbol& rhs) : _temp(rhs._temp) {
    if (_temp != NULL) _temp->increment_refcount();           // 拷贝构造 inc
  }
  ~TempNewSymbol() {
    if (_temp != NULL) _temp->decrement_refcount();           // 析构 dec
  }
  operator Symbol*() { return _temp; }                        // 隐式转 Symbol*
};
```

使用时——`SymbolTable::lookup()` 返回 `Symbol*`（内部已 inc refcount），调用方包装成 `TempNewSymbol`：

```cpp
TempNewSymbol sym = SymbolTable::lookup("foo", 3, THREAD);
// sym 析构时自动 decrement_refcount——不需要手动管理
```

---

## 7. unlink——GC 触发的符号清理

### 7.1 何时调用

当自定义 class loader 被卸载（GC 回收 CLD），其对应的 `Symbol` 不再被引用。GC 之后 JVM 调用 `SymbolTable::unlink()` 清理这些死符号。

### 7.2 清理机制

```cpp
void SymbolTable::unlink() {
  int processed = 0, removed = 0;
  unlink(&processed, &removed);
}

void SymbolTable::unlink(int* processed, int* removed) {
  // 遍历所有 bucket，对每个 entry 检查 Symbol 的 refcount
  for (int i = 0; i < table_size(); i++) {
    // 单 bucket 的 chain 遍历中清理 refcount==0 的 entry
    buckets_unlink(i, i+1, &context);
  }
}
```

`buckets_unlink(start, end, context)` 分 bucket 扫描，每 bucket 内部：遍历 entry 链 → 检查 `Symbol::refcount()` → == 0 ? 从链表中移除并 free → 继续。

多线程版本 `possibly_parallel_unlink()` 将 table 分成多个段，多线程并发扫描。分段的依据是 `_parallel_claimed_idx`（CAS 原子分配未处理段）。

---

## 8. CDS 共享表——`_shared_table`

### 8.1 `CompactHashTable`

`_shared_table`（`symbolTable.hpp:118`）是 `CompactHashtable<Symbol*, char>`——一个只读的 CDS 共享符号表，mmap 自 CDS 归档文件。

与动态 `Hashtable` 的区别：

| | 动态 Hashtable | Compact HashTable |
|---|---|---|
| 存储位置 | C heap | mmap 的 CDS 归档区 |
| 写入方式 | add_entry | CDS dump 时一次性写入 |
| 修改 | 支持（lock + insert） | 只读 |
| entry 格式 | HashtableEntry 链表 | 紧凑 packed array（value-only 或 hash+offset 对） |

### 8.2 `_lookup_shared_first` 自适应策略

```
首次 lookup → 先查 _shared_table (CDS 符号优先)
  ↓ 命中 → 返回
  ↓ miss → 设置 _lookup_shared_first = false
后续 lookup → 先查动态表
  ↓ 命中 → 返回
  ↓ miss → 查 _shared_table → 命中 → 设置 _lookup_shared_first = true
```

为什么自适应？CDS 符号只在启动早期大量命中（类加载阶段），之后动态生成的符号（如 lambda 代理类）不在共享表中。"先查共享表"在启动阶段高效（多数命中），"先查动态表"在稳定阶段高效（多数是动态符号）。

---

## 9. rehash——容量不变，hash 函数变

当某个 bucket 的 entry 数远超平均值（哈希冲突），触发 `rehash_table()`：

1. 检查 `check_rehash_table(count)`——count 是上次操作涉及的 bucket entry 数
2. 创建新的 `SymbolTable`（同大小 bucket 数组，但使用 alternate hash function）
3. `try_move_nodes_to(new_table)`——逐个移动 entry 到新表
4. 成功 → 设置 `use_alternate_hashcode()` 标记，新符号使用备用 hash

注意：rehash **不扩容**——只是改用不同的 hash 函数。扩容需要重建整个 bucket 数组（O(N)），而换 hash 函数 + 移动 entry 的成本与扩容相似，但保证 bucket 数不变能简化并发逻辑（不需要处理大小变化的读）。

---

## 10. 诊断——`jcmd VM.symboltable`

jdk11u-copy 实测（HelloWorld，24676 个 Symbol）：

```bash
$ jcmd <pid> VM.symboltable
SymbolTable statistics:
Number of buckets       :     20011 =    320176 bytes, each 16
Number of entries       :     24676 =    789632 bytes, each 32
Number of literals      :     24676 =    986840 bytes, avg  39.992
Total footprint         :           =   2096648 bytes
Average bucket size     :     1.233
Variance of bucket size :     1.243
Std. dev. of bucket size:     1.115
Maximum bucket size     :         9
```

```
SymbolTable statistics:
Number of buckets       :     20011 =     160088 bytes, each 8
Number of entries       :     52345 =     418760 bytes, each 8
Number of literals      :     52345 =    2093800 bytes, avg 40.000
Total footprint         :              =    2672648 bytes
Average bucket size     :     2.616
Variance of bucket size :     2.891
Std. dev. of bucket size:     1.700
Maximum bucket size     :        12
```

- `buckets` = 20011 = `SymbolTableSize`
- `entries` = 24676 = 当前活着的 Symbol 数
- `literals` = 986840 bytes，avg 39.992 → 每个 Symbol 平均约 40 字节
- `Average bucket size` = 1.233 → 平均每个 bucket 只有 1.23 个 entry——冲突很小
- `Maximum bucket size` = 9 → 最冲突的 bucket 只有 9 个 entry——离需要 rehash 还很远
- Total footprint = 2,096,648 bytes ≈ 2MB——一个 HelloWorld 的 SymbolTable 只占 2MB

JFR 的 `jdk.SymbolTableStatistics` 定期（~1s）提交同样的统计信息，供生产环境长期追踪符号表趋势。

传 `-verbose` 时会逐个打印 Symbol 内容，格式为 `VERSION: 1.0` 后逐行 `refcount bucket: symbol_text`：

```
VERSION: 1.0
16 -1: UnixFileKey.java
72 -1: (Lsun/nio/fs/UnixPath;...)V
15 -1: IntCumulateTask
```

每行三个字段：`refcount`（当前引用计数）、`bucket`（bucket 索引，`-1` 表示 bucket 信息未采集）、`symbol_text`（Symbol 的 UTF-8 文本）。输出量很大（24676 行）——生产慎用。

---

## 11. 小结

```
SymbolTable 核心设计要点：

1. 去重 (canonicalization)：同一 UTF8 常量全 JVM 只有一份 Symbol*
2. 双重检查锁：lock-free 预查（90%+ 命中）→ 持锁 double-check → add_entry
3. Arena (bootstrap) / C-heap (custom loader) 双分配策略
4. TempNewSymbol RAII：引用计数自动管理
5. unlink：GC 后清理 refcount==0 的 dead Symbol
6. CDS _shared_table：mmap 共享符号表 + 自适应查找
7. rehash：换 hash 函数（不扩容）
```

下一篇（14.2）讲解 StringTable——比 SymbolTable 更复杂的 ConcurrentHashTable + OopStorage 实现。
