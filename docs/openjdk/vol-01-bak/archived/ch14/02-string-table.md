# 14.2 StringTable —— 字符串常量池与无锁读取

> **本文定位**：StringTable 全线——从 JVM 业务作用到 `ConcurrentHashTable` + `OopStorage` 双引擎、`intern()` 完整流程（shared lookup → do_lookup → do_intern → dedup）、自动 rehash 扩容和 alt_hash 切换、GC 弱引用清理。StringTable 是三个 Table 中最复杂的一个——它需要在多线程高并发 intern 场景下保持性能，所以放弃了 SymbolTable 的简单 Hashtable + 互斥锁方案，改用 lock-free 的 ConcurrentHashTable。
>
> **前置依赖**：[ch10/07 Metaspace 背景知识](../ch10/07-metaspace.md) + [14.1 SymbolTable](01-symbol-table.md)——已理解 Symbol 与 String 的区别、Hashtable 基类。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码，实证输出使用 jdk11u-copy slowdebug 构建。

---

## 1. StringTable 在 JVM 中的作用

### 1.1 Java 字符串常量池

StringTable 是 JVM 的**字符串常量池**——所有通过 `String.intern()`、编译期字面量、`CONSTANT_String_info` 常量解析的字符串都缓存在这里。

业务语义：**确保相同内容的字符串只有一份在 StringTable 中**——`"Hello".intern() == "Hello".intern()` 返回 `true`（同一个 oop 引用）。

### 1.2 典型场景

三个主要入口进入 StringTable：

| 入口 | 触发时机 | 调用路径 |
|------|---------|---------|
| **类加载** | `ClassFileParser` 解析 `CONSTANT_String_info` 常量 | `StringTable::intern(symbol, THREAD)` |
| **显式 intern** | 用户代码 `"Hello".intern()` | `StringTable::intern(oop, THREAD)` |
| **invokedynamic 字符串拼接** | `"a"+"b"` 在 JDK 9+ 编译为 invokedynamic | `StringConcatFactory` → 生成新 String → 可能 intern |

### 1.3 为什么需要弱引用

StringTable 的 entry 值是 Java 堆中的 `java.lang.String` 对象——它们可以被 GC 回收。如果 StringTable 持有强引用，interned 的字符串将永远不会被 GC（内存泄漏）。所以 StringTable 使用 `OopStorage` 弱引用——当字符串不再被其他引用持有时，GC 将其标记为可回收，StringTable 的 entry 自动失效。

这与 SymbolTable 完全不同——Symbol 存在 Metaspace 中，生命周期由类加载器决定，使用 reference count 而非 GC 管理。

### 1.4 数量级

jdk11u-copy 实测（HelloWorld）：1203 个 interned 字符串，总 footprint ~600KB。典型 Web 应用有 10K-50K 个 interned 字符串。

---

## 2. 内部结构——ConcurrentHashTable + OopStorage 双引擎

### 2.1 类层次

```
CHeapObj<mtSymbol>
  └─ StringTable
       ├─ _local_table: StringTableHash   ← ConcurrentHashTable (lock-free)
       └─ _weak_handles: OopStorage*      ← 弱引用存储
```

`StringTable`（`stringTable.hpp:48`）不是 Hashtable 的子类——它用组合模式，内部持有 `StringTableHash` 和 `OopStorage`。

### 2.2 StringTableHash = ConcurrentHashTable

```cpp
// stringTable.hpp
typedef ConcurrentHashTable<StringTableConfig, mtSymbol> StringTableHash;
```

`ConcurrentHashTable` 是 Java `ConcurrentHashMap` 的 C++ 灵感实现——分段锁、lock-free 读、CAS 写。核心特性：

- **lock-free 读**：`do_lookup()` 和 `lookup_shared()` 不需要任何锁
- **CAS 写**：`do_intern()` 用 `get_insert_lazy` → CAS 插入新 entry
- **自动扩容**：entry 数超过阈值时触发 resize，分步迁移（不阻塞读）
- **分段遍历**：GC 的 `unlink` / `oops_do` 可以 concurrent mark 安全地遍历

`StringTableConfig` 配置了 entry 的 hash、equals、分配/释放策略：

```cpp
struct StringTableConfig {
  typedef WeakHandle<vm_string_table_data> Value;  // entry 值类型
  static uintx get_hash(Value const& value, bool* is_dead);
  static void* allocate_node(size_t size, Value const& value);
  static void free_node(void* memory, Value const& value);
};
```

### 2.3 OopStorage——弱引用存储

```cpp
// stringTable.cpp:187
_weak_handles = new OopStorage("StringTable weak",
                                StringTableWeakAlloc_lock,
                                StringTableWeakActive_lock);
```

`OopStorage`（`oops/oopStorage.hpp`）管理弱引用 oop 的分配和 GC 交互。每个 entry 的 value 是一个 `WeakHandle<vm_string_table_data>`——内部在 OopStorage 中分配一个 slot 存储 oop 指针。

- **`StringTableWeakAlloc_lock`**：entry 需要新弱引用 slot 时持此锁分配
- **`StringTableWeakActive_lock`**：GC 标记阶段管理活跃 slot 集合
- GC 后弱引用被清空 → slot 内容变为 NULL → `unlink` 遍历时清理对应 entry

### 2.4 初始大小与自动扩容

```cpp
// stringTable.cpp:190-194
size_t start_size_log_2 = ceil_pow_2(StringTableSize);  // StringTableSize 默认 65536 (LP64)
_current_size = ((size_t)1) << start_size_log_2;         // 取 2 的幂: 65536
_local_table = new StringTableHash(start_size_log_2, END_SIZE, REHASH_LEN);
```

jdk11u-copy 实测：65536 个 bucket（2^16），1203 个 entry——bucket 利用率仅 1.8%，极其稀疏。

---

## 3. intern() 的完整流程

### 3.1 四个重载

```cpp
// 从 Symbol (类文件解析) 进入
oop StringTable::intern(Symbol* symbol, TRAPS)
  → 提取 unicode chars → intern(string, chars, length, CHECK_NULL)

// 从已有 Java String 进入
oop StringTable::intern(oop string, TRAPS)
  → 提取 unicode chars → intern(h_string, chars, length, CHECK_NULL)

// 从 UTF-8 字节进入
oop StringTable::intern(const char* utf8_string, TRAPS)
  → UTF8→unicode → intern(string, chars, length, CHECK_NULL)

// 核心方法——所有重载最终调这个
oop StringTable::intern(Handle string_or_null_h, jchar* name, int len, TRAPS)
```

### 3.2 核心流程

```cpp
oop StringTable::intern(Handle string_or_null_h, jchar* name, int len, TRAPS) {
  // ① 计算 hash（与 java.lang.String.hashCode() 一致）
  unsigned int hash = java_lang_String::hash_code(name, len);

  // ② 先查 CDS 共享表（如果有）
  oop found = lookup_shared(name, len, hash);
  if (found != NULL) return found;

  // ③ 处理 alt_hash（上次 rehash 后可能切换了 hash 函数）
  if (_alt_hash) hash = hash_string(name, len, true);

  // ④ 在 ConcurrentHashTable 中查
  found = do_lookup(name, len, hash);
  if (found != NULL) return found;

  // ⑤ 未找到——创建新 entry
  return do_intern(string_or_null_h, name, len, hash, THREAD);
}
```

流程图：

```
intern(name, len)
  │
  ├─ hash_code(name, len)              ← 计算标准 hash
  ├─ lookup_shared(name, len, hash)     ← ① CDS 共享表（mmap 只读）
  │   └─ 命中 → 返回 ✅
  │
  ├─ _alt_hash? hash_string(name, len, true) : hash  ← ② 备用 hash
  ├─ do_lookup(name, len, hash)         ← ③ ConcurrentHashTable lock-free 查
  │   └─ 命中 → 返回 ✅
  │
  └─ do_intern(string_or_null_h, name, len, hash, THREAD)
      │
      ├─ string_or_null_h.is_null()? → create_from_unicode  ← ④ 无现有对象时创建
      ├─ Universe::heap()->deduplicate_string(string_h())    ← ⑤ String Dedup
      ├─ get_insert_lazy(THREAD, lookup, stc, stc, ...)     ← ⑥ CAS insert
      │   ├─ 成功 → stc.get_return()
      │   └─ rehash_warning → _needs_rehashing = true
      └─ 返回新 interned oop ✅
```

### 3.3 do_intern——CAS 插入与 String Dedup

```cpp
oop StringTable::do_intern(Handle string_or_null_h, jchar* name,
                            int len, uintx hash, TRAPS) {
  // ① 如果调用方只有 char 数组没有 Java String 对象——先创建
  Handle string_h;
  if (!string_or_null_h.is_null()) {
    string_h = string_or_null_h;
  } else {
    string_h = java_lang_String::create_from_unicode(name, len, CHECK_NULL);
  }

  // ② String Dedup——在 intern 前去重底层 char[]
  //    原因：编译器可能对 interned 字符串做了优化，
  //    先 dedup 避免打破优化假设
  Universe::heap()->deduplicate_string(string_h());

  // ③ CAS 插入 ConcurrentHashTable
  bool rehash_warning;
  _local_table->get_insert_lazy(THREAD, lookup, stc, stc, &rehash_warning);
  if (rehash_warning) {
    _needs_rehashing = true;
  }
  return stc.get_return();
}
```

`get_insert_lazy` 是 ConcurrentHashTable 的核心操作——它先做一次 lock-free 的 CAS 插入尝试，失败则重试（类似 ConcurrentHashMap 的 `putIfAbsent`）。

---

## 4. 自动 rehash——扩容而非换 hash

### 4.1 与 SymbolTable rehash 的关键差异

| | SymbolTable rehash | StringTable rehash |
|---|---|---|
| 触发 | bucket 冲突超过阈值 | `_needs_rehashing` 标志 |
| 操作 | 换 hash 函数（桶数不变） | **扩容**（桶数翻倍）+ 可能换 hash |
| 安全性 | 全局锁保护 | ConcurrentHashTable 自带分段迁移 |
| alt_hash | 有（alternate hashcode） | 有（`_alt_hash`） |

### 4.2 do_rehash 流程

```cpp
bool StringTable::do_rehash() {
  if (!_local_table->is_safepoint_safe()) return false;  // 不在 safepoint 中不能 rehash

  size_t new_size = _local_table->get_size_log2(Thread::current());
  StringTableHash* new_table = new StringTableHash(new_size, END_SIZE, REHASH_LEN);

  // 启用备用 hash
  _alt_hash = true;

  // 尝试迁移所有 entry 到新表
  if (!_local_table->try_move_nodes_to(Thread::current(), new_table)) {
    _alt_hash = false;     // 迁移失败——回退
    delete new_table;
    return false;
  }

  delete _local_table;     // 释放旧表
  _local_table = new_table;
  return true;
}
```

**注意**：`_current_size` 单调递增——StringTable 只扩容不缩容。极端场景（大量 intern → flush → 再大量 intern）可能导致 table size 比实际 entry 数大几个数量级。jdk11u-copy 实测 65536 个 bucket 只有 1203 个 entry（利用率 1.8%）——就说明扩容过但当前 entry 数少。

---

## 5. GC 交互——弱引用清理

### 5.1 unlink 机制

当 `java.lang.String` 对象不再被引用（GC 回收），OopStorage 中的弱引用 slot 被自动清空为 NULL。StringTable 的 `unlink_or_oops_do` 在 GC 周期中清理这些死 entry。

```cpp
// GC 标记阶段——遍历所有存活 entry 的 oop 并标记
void StringTable::oops_do(OopClosure* f) {
  _local_table->oops_do(f);  // ConcurrentHashTable 的安全遍历
}

// GC 清理阶段——移除弱引用已死的 entry
void StringTable::unlink(BoolObjectClosure* is_alive) {
  _local_table->unlink(is_alive);  // 遍历 + 移除 dead entry
}
```

`_uncleaned_items` 计数器追踪待清理的 entry 数——当 `_uncleaned_items` 超过阈值时触发 `do_rehash`（清理 + 紧凑）。

### 5.2 与 SymbolTable unlink 的对比

| | SymbolTable | StringTable |
|---|---|---|
| entry 死因 | Symbol refcount == 0 | 弱引用被 GC 清空 |
| 检测方式 | `buckets_unlink` 遍历所有 entry | ConcurrentHashTable 的 `unlink(is_alive)` |
| 并行支持 | `possibly_parallel_unlink`（分桶段） | ConcurrentHashTable 内部支持 |
| 触发时机 | GC 后的 safepoint | GC 标记/清理阶段 |

---

## 6. String Dedup 交互

### 6.1 intern 前的 dedup

```cpp
Universe::heap()->deduplicate_string(string_h());
```

在 intern 之前先调用 GC 的 `deduplicate_string`——这会检查字符串底层 `char[]` 是否与已存在的某个 interned 字符串相同，如果是则**复用底层数组**（只改变 oop 指向的 char[]，不改变 oop 身份）。

### 6.2 为什么在 intern 前做

编译器可能对 interned 字符串做了优化假设（例如 `==` 比较）。如果 intern 之后再去重 char[]，其他线程可能已经读取到旧的 char[] 引用——打破优化的假设。先 dedup 再 intern 保证进入 StringTable 的字符串已经是最优形态。

### 6.3 G1 String Dedup vs StringTable Dedup

| | StringTable Dedup（intern 前） | G1 String Dedup |
|---|---|---|
| 触发时机 | intern 时（主动） | GC 并发标记时（被动） |
| 作用范围 | 当前正在 intern 的字符串 | 堆中所有 age>=3 的字符串 |
| 目的 | 避免重复 char[] 进入 StringTable | 全局减少字符串 char[] 内存占用 |
| 关系 | 互补——前一道防线 | 后一道防线 |

---

## 7. 诊断——`jcmd VM.stringtable`

jdk11u-copy 实测：

```bash
# 统计模式（默认）
$ jcmd <pid> VM.stringtable
StringTable statistics:
Number of buckets       :     65536 =    524288 bytes, each 8
Number of entries       :      1203 =     19248 bytes, each 16
Number of literals      :      1203 =     72584 bytes, avg  60.336
Total footprint         :           =    616120 bytes
Average bucket size     :     0.018
Variance of bucket size :     0.019
Std. dev. of bucket size:     0.136
Maximum bucket size     :         2
```

- `buckets` = 65536：当前桶数（经过扩容后的值，2^16）
- `entries` = 1203：当前 interned 的字符串数
- `literals` = String 对象本身占用的字节
- `Average bucket size` = 0.018：极稀疏——多空 bucket
- `Maximum bucket size` = 2：最冲突的 bucket 只有 2 个 entry

**-verbose 模式**——逐个打印字符串内容，格式为 `refcount: string_content`：

```
VERSION: 1.1
0:
18: Property settings:
1: #
1: '
1: (
1: .
1: /
1: 0
1: <
1: @
```

注意 refcount=0 的字符串（如单字符 `#`、`'`、`(`）——它们当前没有被任何引用持有，只是还没被 GC 清理（下次 unlink 会移除）。

---

## 8. 小结

```
StringTable 核心设计要点：

1. ConcurrentHashTable + OopStorage 双引擎：
   - lock-free 读 + CAS 写 → 高并发 intern 无瓶颈
   - 弱引用 → 字符串可被 GC

2. intern 三步：lookup_shared(CDS) → do_lookup(CAS读) → do_intern(CAS写+dedup)

3. 自动 rehash：扩容（桶数翻倍）+ alt_hash 切换
   - 只扩容不缩容 → 可能数个数量级的过度分配

4. 与 SymbolTable 的关键差异：
   - SymbolTable: 固定大小 Hashtable + 互斥锁 + refcount
   - StringTable: 可变大小 ConcurrentHashTable + 弱引用 + GC清理

5. 与 StringDedup: intern 前 dedup 是第一道防线
```

下一篇（14.3）讲解 ResolvedMethodTable——三个 Table 中最简单的，聚焦 invokedynamic 的方法解析缓存。
