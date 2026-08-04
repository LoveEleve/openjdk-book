# 14.4 三个 Table 的 CDS 差异、锁模型与生命周期对比

> **本文定位**：收尾篇——CDS vs 非 CDS 创建路径差异、三个 Table 的锁模型横向对比、entry 生命周期、JVM 启动参数速查、在 `universe_init` 中的精确位置。读完本文后应该能完整回答"JVM 启动时 SymbolTable / StringTable / ResolvedMethodTable 按什么顺序创建、各自用什么数据结构、为什么选这个"。
>
> **前置依赖**：14.1-14.3 全部——已理解三个 Table 的内部结构和业务作用。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码。

---

## 1. CDS 路径下的创建差异

### 1.1 `universe_init` 中的分叉

```cpp
/* === src/hotspot/share/memory/universe.cpp:675-749 === */

if (UseSharedSpaces) {
  // CDS 路径：mmap 恢复归档数据
  MetaspaceShared::initialize_shared_spaces();
  // initialize_shared_spaces 内部：
  //   1. mmap CDS 归档文件 → 恢复 CompactHashTable（_shared_table）
  //   2. 设置 SystemDictionary 共享字典
  //   3. restore SymbolTable _shared_table → 恢复 StringTable _shared_table
  //   → SymbolTable 不需要 create_table()——符号直接从 mmap 读取

  StringTable::create_table();    // 新建 _local_table，但 _shared_table 已指向 mmap
} else {
  // 非 CDS 路径：正常创建
  SymbolTable::create_table();   // 新建 _the_table（20011 buckets）
  StringTable::create_table();   // 新建 _local_table（65536 buckets）
}
ResolvedMethodTable::create_table();  // 始终新建（不参与 CDS）
```

### 1.2 为什么 StringTable 在 CDS 路径也调 create_table

StringTable 有双引擎——`_local_table`（ConcurrentHashTable，可写）和 `_shared_table`（CompactHashTable，只读）。CDS 恢复时 `_shared_table` 指向 mmap 归档区，但 `_local_table` 仍然需要创建——运行时新 intern 的字符串写入 `_local_table`。

SymbolTable 没有这个需要——它的 entry 在 CDS 中已经全部恢复，运行时新符号直接添加到动态 `_the_table` 中。

### 1.3 为什么 ResolvedMethodTable 不参与 CDS

`ResolvedMethodName` 的生命周期绑定到 class loader——不同 loader 的同名方法解析到不同的 `ResolvedMethodName`。CDS 共享的类在不同 JVM 实例中可能被不同的 class loader 加载，缓存没有跨实例的意义。且 `ResolvedMethodName` 后续会被 redefineClasses 修改——只读 mmap 不支持。

---

## 2. 锁模型横向对比

| | SymbolTable | StringTable | ResolvedMethodTable |
|---|---|---|---|
| **数据结构** | `RehashableHashtable` | `ConcurrentHashTable` | 简单 `Hashtable` |
| **读锁** | 无锁（lock-free 预查）→ `SymbolTable_lock`（正式加） | **完全无锁**（CAS 读） | 无 |
| **写锁** | `SymbolTable_lock`（互斥） | **CAS**（无全局锁） | `ResolvedMethodTable_lock`（互斥） |
| **为什么这样设计** | 90%+ 读在 lock-free 阶段命中，持锁写成本可接受 | intern 可能被多线程高并发调用——必须避免瓶颈 | entry 数少（几百到几千），写操作频率低——互斥锁足够 |
| **GC 安全** | `unlink` 持锁分段 | ConcurrentHashTable 内置并发安全 | `unlink` 不需要锁（GC 时在 safepoint 中） |
| **rehash** | 需持全局锁重建 | ConcurrentHashTable 自带分段迁移 | 不支持 |

### 2.1 为什么 StringTable 需要 ConcurrentHashTable

考虑场景：100 个线程同时执行 `"Hello" + i`（字符串拼接，都需要 intern）。如果用 SymbolTable 式的全局互斥锁——所有 100 个线程在 `intern()` 中顺序执行。ConcurrentHashTable 允许 100 个线程同时做 lock-free 读（`do_lookup`），只有少数做 CAS 插入（`do_intern`）——吞吐量提升 100 倍。

### 2.2 为什么 SymbolTable 不需要 ConcurrentHashTable

SymbolTable 的访问模式不同——类加载是一次性操作（类加载完成后再也不需要查 SymbolTable）。类加载本身是串行的（`ClassLoader.loadClass` synchronized），所以 SymbolTable 不会面临"100 个线程同时查同一个 Symbol"的情况。90% 的 lookup 在 lock-free 预查命中的设计已经足够——不需要 ConcurrentHashTable 的额外复杂度。

---

## 3. entry 生命周期对比

| | SymbolTable | StringTable | ResolvedMethodTable |
|---|---|---|---|
| **entry 对象** | `HashtableEntry<Symbol*, mtSymbol>` | ConcurrentHashTable 内部 node | `ResolvedMethodEntry` (HashtableEntry 子类) |
| **entry 的 key** | `Symbol*` | `WeakHandle<vm_string_table_data>` 的 hash | `ClassLoaderWeakHandle` 的 hash |
| **entry 的 value** | `Symbol*`（key 即是 value——去重） | oop（`java.lang.String`） | oop（`java.lang.invoke.ResolvedMethodName`） |
| **何时创建** | `basic_add` | `do_intern` | `basic_add` |
| **何时死亡** | `Symbol::refcount() == 0` + `unlink` | 弱引用被 GC 清空 + `unlink` | 弱引用被 GC 清空 + `unlink` |
| **由谁清理** | GC safepoint → `unlink` | GC → `oops_do` + `unlink` | GC safepoint → `unlink` |
| **CDS 中的 entry** | `_shared_table`（只读，mmap） | `_shared_table`（只读，mmap） | 不参与 |

### 3.1 Symbol entry 何时死亡

1. 自定义 class loader 被 GC 卸载
2. 它加载的所有类变成 unreachable
3. 这些类的 Symbol refcount 降为 0
4. 下次 safepoint → `SymbolTable::unlink()` 清理

### 3.2 String entry 何时死亡

1. `"Hello".intern()` → StringTable 记录弱引用
2. 所有其他 `"Hello"` 引用被清除（唯一引用者就是 StringTable）
3. GC → OopStorage 弱引用 slot 被清空为 NULL
4. 下次 `StringTable::unlink_or_oops_do` → 移除 dead entry

### 3.3 ResolvedMethod entry 何时死亡

1. invokedynamic 生成的 `ResolvedMethodName` oop = StringTable entry 的 value
2. 它的 `Method*` key 所在的类被 redefine 或卸载
3. GC → `ClassLoaderWeakHandle` 弱引用清空为 NULL
4. `ResolvedMethodTable::unlink` → 移除 + `release()` 弱引用 handle

---

## 4. JVM 启动参数速查

| 参数 | 默认值 | 影响的 Table | 说明 |
|------|--------|-------------|------|
| `-XX:SymbolTableSize` | 20011 | SymbolTable | 固定 bucket 数——不自动扩容 |
| `-XX:StringTableSize` | 65536 (LP64) | StringTable | 初始 bucket 数——ConcurrentHashTable 会自动 grow |
| `-XX:StringDeduplicationAgeThreshold` | 3 | StringTable (间接) | G1 String Dedup——intern 前也会触发 dedup |
| `-XX:+UseStringDeduplication` | false (JDK 11 默认关) | StringTable (间接) | 启用 G1 String Dedup |
| `-XX:MetaspaceSize` | ~20MB | 间接 | 所有三个 Table 的 Symbol/String 字面量都在 Metaspace 中 |
| `-XX:+UnlockDiagnosticVMOptions` | — | — | 解锁以下调试 flag |
| `-XX:+PrintStringTableStatistics` | false | StringTable | JVM 退出时打印 StringTable 统计 |
| `-Xlog:stringtable*=trace` | off | StringTable | Unified Logging——追踪 StringTable 操作 |

### 4.1 `PrintStringTableStatistics`

这是一个隐藏的诊断 flag——需要 `-XX:+UnlockDiagnosticVMOptions` 才能用。JVM 退出时自动打印 StringTable 统计（与 `jcmd VM.stringtable` 相同格式），方便离线分析。

```bash
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintStringTableStatistics \
     -XX:StringTableSize=100000 -jar app.jar
# JVM 退出时自动打印：
# StringTable statistics:
# Number of buckets       :    131072 = ...
```

没有对应的 `PrintSymbolTableStatistics`——但可以用 `jcmd VM.symboltable` 达到同样效果。

---

## 5. 在 universe_init 中的精确位置

三个 Table 在 `universe_init()`（`universe.cpp:675-749`）中的创建时序：

```
universe_init()
  ├─ compute_hard_coded_offsets()
  ├─ Universe::initialize_heap()
  ├─ SystemDictionary::initialize_oop_storage()
  ├─ Metaspace::global_initialize()           ← ch12: Metaspace 初始化
  ├─ MetaspaceCounters::init ...
  ├─ JVMFlagConstraintList::check_constraints(AfterMemoryInit)
  ├─ ClassLoaderData::init_null_class_loader_data()
  │
  ├─ ★ CDS 路径:
  │   if (UseSharedSpaces) {
  │     MetaspaceShared::initialize_shared_spaces()  ← mmap 恢复 CDS 共享 Symbol/String 表
  │     StringTable::create_table()                  ← 新建 _local_table（_shared_table 已指向 mmap）
  │   } else {
  │     ★ 非 CDS 路径:
  │     SymbolTable::create_table()                  ← 新建 20011 bucket
  │     StringTable::create_table()                  ← 新建 65536 bucket
  │   }
  │
  ├─ ★ ResolvedMethodTable::create_table()          ← 始终新建 1007 bucket
  │
  ├─ SymbolTable / StringTable / ResolvedMethodTable → 全部就绪
  └─ 后续：universe2_init → javaClasses_init → ...
```

时序的关键约束：
- **StringTable 必须在 SymbolTable 之前创建（CDS 路径）**——因为 CDS 归档中的 StringTable 可能依赖 Symbol 的解码，但 `_local_table` 的创建是独立的
- **ResolvedMethodTable 必须是最后一个**——它在 `universe2_init` 之前不需要被访问
- **CDS 路径下 SymbolTable 不调 `create_table`**——共享符号从 mmap 区域恢复，不新建 Hashtable

---

## 6. 全量对比速查表

```
                     SymbolTable          StringTable           ResolvedMethodTable
─────────────────────────────────────────────────────────────────────────────────────
用途                 类名/方法名去重       字符串常量池            invokedynamic 缓存
数据结构              RehashableHashtable  ConcurrentHashTable   简单 Hashtable
bucket 数             20011                65536→grow            1007
读                    lock-free预查+锁    CAS无锁              无锁(小表遍历)
写                    互斥锁                CAS                  互斥锁
扩容                  不扩容(换hash)      自动grow(只扩不缩)    不扩容
CDS                   有(_shared_table)   有(_shared_table)    无
弱引用                 无(refcount管理)    有(OopStorage)       有(CLDWeakHandle)
GC清理                unlink(refcount=0)  unlink(弱引用NULL)   unlink(弱引用NULL)
jcmd命令              VM.symboltable      VM.stringtable       无
entry数(典型)          50K-100K            1K-50K              几百-几千
```

---

## 7. 小结

三个 Table 的设计体现了 HotSpot 中的**按需工程选择**：

1. **SymbolTable** 选择固定大小 Hashtable + 互斥锁——因为类加载是串行的，不需要高并发，简单的 double-check lock 已经足够
2. **StringTable** 选择 ConcurrentHashTable + CAS——因为 `String.intern()` 可能被多线程高频调用，必须避免瓶颈
3. **ResolvedMethodTable** 选择最简单 Hashtable + 1007 bucket——因为 entry 数少、写操作少、不需要 fancy 优化

CDS 为前两个 Table 提供了共享只读表——启动时 mmap 恢复，省去了类加载阶段的大量符号和字符串 intern 开销。

---

ch12 全部 4 篇完成。下一篇（ch13）讲解 `LatestMethodCache`——`universe_init` 中后置的 6 个单槽方法缓存。
