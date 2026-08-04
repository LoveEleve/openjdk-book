# ch14 SymbolTable + StringTable + ResolvedMethodTable 写作规划

## ch14 目标

读者读完 4 篇后能回答以下核心问题：

1. **SymbolTable 怎么存储和查找符号？** ——`Hashtable<Symbol*, mtSymbol>` + Arena（bootstrap 永久分配）vs C-heap（自定义 loader 可回收）、`_lookup_shared_first` 优化策略、TempNewSymbol 引用���数 RAII
2. **StringTable 怎么 intern 字符串？** ——`OopStorage` weak handles + `StringTableHash`（ConcurrentHashTable 变体）、`do_intern` 中的 dedup + get_insert_lazy、`do_rehash` 自动扩容和 alt_hash 切换
3. **ResolvedMethodTable 怎么缓存已解析的方法？** ——`Hashtable<ClassLoaderWeakHandle, mtClass>`、`compute_hash`（CLD+klass+name+sig 四元组）、`unlink` GC 清理和 `adjust_method_entries` redefineClasses 支持
4. **三个 Table 在 CDS 路径下的差异？** ——SymbolTable 和 StringTable 有 `_shared_table`(CompactHashTable)，ResolvedMethodTable 纯动态。SymbolTable 有 `lookup_shared_first` 自适应切换
5. **三个 Table 的锁模型差异？** ——SymbolTable_lock（读写锁分桶？）、StringTable 无锁读（ConcurrentHashTable）+ 内部锁写、ResolvedMethodTable_lock（简单互斥）

**不要求掌握的**（源码细节，查源码即可）：
- CompactHashTable 二进制编码格式 / ConcurrentHashTable 完整实现（GenericTaskQueue 内部） / OopStorage 的 Block/Slot 分配链

---

## 定位：JVM 中三个 Table 的业务作用

ch10/07 已经讲完 Metaspace 背景，ch11 讲完堆初始化。ch14 承接 `universe_init` 中的 `SymbolTable::create_table()` / `StringTable::create_table()` / `ResolvedMethodTable::create_table()`——这三个 Table 是 JVM 类加载、字符串池化、方法解析的基础设施。

**在深入源码之前，先理解三个 Table 在 JVM 中"做什么"**：

### SymbolTable：类名/方法名/字段名的规范化存储

每一个 Java 类的类名、方法名、字段名、类型描述符——甚至字节码指令中的字符串常量——都以 `Symbol` 形式存储在 SymbolTable 中。class file 解析器遇到 UTF8 常量时调用 `SymbolTable::lookup()` → 如果表中已有就复用（canonicalization），没有就新建后插入。**一个典型的 JVM 进程有 50K-100K 个 Symbol**。

Symbol 和 String 的关系：`Symbol` 是 C++ 的字节序列（UTF-8，refcounted），存在 Metaspace 中。`String` 是 Java 堆对象（`java.lang.String` 实例）。SymbolTable 管前者，StringTable 管后者。

**如果没有 SymbolTable**：每个 `"Ljava/lang/Object;"` 出现一次就分配一次——类文件中同一个符号出现上百次是常事，内存会爆。SymbolTable 的去重（canonicalization）是 JVM 能正常启动的前提。

### StringTable：Java 字符串常量池

`String.intern()`、编译期字面量（如 `"Hello"`）、`CONSTANT_String_info` 常量的懒解析——都经过 StringTable。与 SymbolTable 不同，StringTable 的 entry 是 Java 堆对象，可以被 GC 回收，所以用 `OopStorage` 弱引用。

一个典型 Web 应用有 10K-50K 个 interned 字符串。StringTable 的大小自动膨胀（ConcurrentHashTable 的 rehash 机制），不会因容量固定而性能退化。

**如果没有 StringTable**：`String.intern()` 无法工作（没有地方存标准引用）、相同字面量 `"Hello"` 每个类加载一次就创建一个新 String 对象——内存浪费。

### ResolvedMethodTable：invokedynamic / MethodHandles 的方法解析缓存

JDK 7 `invokedynamic` / `MethodHandles` 引入后，方法解析不再是类加载时一次性完成——`invokedynamic` 每次调用都需要 bootstrap method 动态计算目标方法。ResolvedMethodTable 缓存已解析的 `ResolvedMethodName` 对象，避免重复调用 bootstrap method。

缓存 key 是 `Method*` 指针 → 通过 CLD + klass_name + name + signature 四元组计算 hash。value 是 `ResolvedMethodName` oop（弱引用，Method 所在的类被卸载时 entry 自动失效）。

**如果没有 ResolvedMethodTable**：每个 `invokedynamic` 调用点每次调用都重新走 bootstrap → 性能急剧下降（lambda 表达式、字符串拼接 `"a"+"b"` 都依赖 invokedynamic）。

---

三个 Table 在 `universe_init` 中的创建位置（`universe.cpp:675-749`）：

```cpp
if (UseSharedSpaces) {
  MetaspaceShared::initialize_shared_spaces();  // CDS: 恢复共享符号表和字符串表
  StringTable::create_table();
} else {
  SymbolTable::create_table();                   // 非 CDS: 新建符号表
  StringTable::create_table();                   // 非 CDS: 新建字符串表
}
ResolvedMethodTable::create_table();              // 始终新建（不参与 CDS）
```

CDS 路径下 StringTable 先于 SymbolTable 创建（因为 archive 中符号表是 mmap 恢复的，不需要 create_table）。

---

## 文章结构（4 篇）

```
ch10/07 核心机制 (背景)
  │
  ├─→ 01-symbol-table.md  ← 最难——Hashtable + Arena + CDS + RC
  │     └─ 内部结构、分配策略、lock-free lookup、unlink GC
  │
  ├─→ 02-string-table.md ← 最复杂——OopStorage + ConcurrentHashTable
  │     └─ weak handle、intern 流程、automatic rehash、String Dedup 交互
  │
  ├─→ 03-resolved-method-table.md ← 最简单——简单 Hashtable
  │     └─ weak handle、compute_hash、GC unlink、redefineClasses
  │
  └─→ 04-create-table-cds.md ← CDS 差异 + 三者对比
        └─ CDS vs 非 CDS 创建路径差异、锁模型对比、生命周期对比
```

---

## 各篇规划

### 01 — SymbolTable

- [ ] **01-symbol-table.md**
  | 定位: SymbolTable 全线——从 JVM 业务作用到 `Hashtable` 基类到 Arena 到 CDS 共享表到 unlink GC
  | 前置: ch10/07（理解 Arena 和 Hashtable 基类）

  **Section 1. SymbolTable 在 JVM 中的作用**（新增）
  - `Symbol` 是什么：C++ 的 UTF-8 字节序列，带 reference count，存在 Metaspace 中
  - `Symbol` vs `String`：前者是 C++ native 对象（refcounted），后者是 Java 堆对象（GC 管理）
  - SymbolTable 的去重（canonicalization）：class file 中同一个 UTF8 常量出现 N 次，SymbolTable 确保只有一份 `Symbol*`
  - 典型场景：类文件解析器 (`ClassFileParser`) 遇到 CONSTANT_Utf8 → `SymbolTable::lookup()` → return existing or create new
  - 数量级：典型 JVM 50K-100K 个 Symbol，每个 10-100 字节
  - `vmSymbols`：预定义的 JVM 内部符号（`java_lang_Object` 等），启动时批量创建

  **Section 1. SymbolTable 内部结构**
  - `SymbolTable : RehashableHashtable<Symbol*, mtSymbol>`（`symbolTable.hpp:101`）
  - 固定 bucket 数：`SymbolTableSize`（默认 20011）
  - 单例模式：`_the_table` + `the_table()` + `create_table()`
  - `_arena`（`symbolTable.hpp:150`）：Arena 用于 bootstrap loader 的永久符号——永不 GC
  - `_shared_table`（`symbolTable.hpp:118`）：`CompactHashtable<Symbol*, char>`——CDS 共享符号表
  - `_lookup_shared_first`（`symbolTable.hpp:111`）：自适应标志——初始查共享表先，第一次 miss 后切到查动态表先（自适应优化）

  **Section 2. 分配策略：Arena vs C-heap**
  - `allocate_symbol(const u1* name, int len, bool c_heap)`（`symbolTable.cpp`）
    - `c_heap=false` → 从 `_arena` 分配（bootstrap loader 的永久符号）
    - `c_heap=true` → `os::malloc` 分配（自定义 loader 的可回收符号）
  - `initialize_symbols(arena_alloc_size)`：初始时预分配 360KB Arena
  - 为什么分两种——自定义 loader 可卸载，其符号需要能释放；bootstrap 永不卸载，Arena 分配最省

  **Section 3. lookup 和 basic_add 的双重检查锁**
  - `lookup()`（`symbolTable.cpp:319`）：
    1. 无锁：`hash_to_index` + bucket 遍历（lock-free 预查）
    2. 找到 → 返回 ✅
    3. 未找到 → 持 `SymbolTable_lock` → 重查（double-check） → 调 `basic_add`
  - `basic_add()`（`symbolTable.cpp:473`）：
    1. assert + length check
    2. 再次 bucket 遍历（可能其他线程已添加）
    3. `allocate_symbol` + `new_entry` + `add_entry`
  - 为什么是双重检查锁而不是持锁查？——90%+ 的 lookup 在 lock-free 阶段就命中了（符号去重的核心），只有 10% 需要进锁。如果每次 lookup 都持锁，符号表会成为类加载的瓶颈

  **Section 4. vmSymbols——JVM 预定义的内部符号**（新增）
  - `vmSymbols.hpp`：约 200 个 JVM 内部使用的预定义符号（`java_lang_Object`、`<init>`、`Code` 等）
  - 启动时通过 `vmSymbols::initialize()` → `SymbolTable::new_permanent_symbol()` 批量创建
  - 永久分配在 `_arena` 中（不通过 GC 回收）
  - 为什么需要预定义——JVM 内部代码（解释器、编译器、GC）频繁引用这些符号，如果每次都查 SymbolTable 太慢，直接用 `vmSymbols::java_lang_Object()` 返回固定指针

  **Section 4. TempNewSymbol 引用计数**
  - `TempNewSymbol`（`symbolTable.hpp:59-97`）——RAII 引用计数管理
  - 构造不 inc，拷贝构造 inc，析构 dec
  - `Symbol::refcount()` 为 0 时在 `unlink` 中被删除

  **Section 5. unlink——GC 触发的符号清理**
  - `unlink()` → `buckets_unlink(start, end, context)`——分桶 chunked 扫描
  - `possibly_parallel_unlink()`：多线程并发 unlink（SystemDictionary_lock 段分割）
  - `_symbols_removed` / `_symbols_counted` 统计

  **Section 6. 诊断与观测**（新增）
  - `jcmd <pid> VM.symboltable [-verbose]`：`SymboltableDCmd`（`symbolTable.cpp:733`）
    - 打印统计：bucket 数/entry 数/字面量总大小/平均 bucket 大小/方差/最大 bucket
    - 底层调用 `Hashtable::print_table_statistics`（`hashtable.cpp:322-359`）遍历所有 bucket 计数
  - JFR：`jdk.SymbolTableStatistics` event（定期采集—每 ~1s）

  **Section 6. CDS 共享表**
  - `_shared_table`：`CompactHashtable`——mmap 的 CDS 归档段
  - `lookup_shared()`（`symbolTable.cpp:229`）：先查共享表（hash → offset → Symbol*）
  - `encode_shared()` / `decode_shared()`：Symbol* → 归档偏移 → 恢复时反编码

  **Section 7. rehash**
  - `rehash_table()`：当某个 bucket 哈希冲突严重时创建新表并移动所有 entry
  - `RehashableHashtable::check_rehash_table(count)` + `try_move_nodes_to`

---

### 02 — StringTable

- [ ] **02-string-table.md**
  | 定位: StringTable 全线——从 JVM 业务作用到 OopStorage 到 ConcurrentHashTable 到 intern 到自动 rehash
  | 前置: ch10/07 + 01

  **Section 1. StringTable 在 JVM 中的作用**（新增）
  - Java 字符串常量池：`String.intern()`、编译期字面量、`CONSTANT_String_info` 常量解析
  - `intern()` 的业务语义：确保相同内容的字符串只有一份在 StringTable 中——所有 `"Hello"` 引用指向同一个 oop
  - 典型场景：
    - 类加载器解析 `CONSTANT_String_info` → `StringTable::intern(symbol, THREAD)` → 返回唯一 oop
    - 用户代码 `"Hello".intern()` → `StringTable::intern(oop, THREAD)`
    - invokedynamic 字符串拼接 (`"a"+"b"`) → 生成新 String → intern
  - 为什么需要弱引用：字符串是堆对象——如果类被卸载、没有其他引用，interned 的字符串也应该被 GC
  - 与 String Dedup 的关系：G1/Shenandoah 的 StringDedup 在 StringTable 之外工作——去重底层 char[]，不影响 StringTable 的 oop 身份
  - 数量级：典型 Web 应用 10K-50K 个 interned 字符串

  **Section 1. StringTable 内部结构**
  - `StringTable : CHeapObj<mtSymbol>`（`stringTable.hpp`）
  - `_local_table`：`StringTableHash`（`ConcurrentHashTable<StringTableConfig, mtSymbol>` 的 typedef）
    - 不是简单的 Hashtable——是 **ConcurrentHashTable**（Java 8 ConcurrentHashMap 的 C++ 灵感版）
    - 分段锁（per-bucket 或 per-segment）、lock-free 读、CAS 写
  - `_weak_handles`：`OopStorage*`（`stringTable.cpp:187`）——用于保存字符串的弱引用
    - 两个定制锁：`StringTableWeakAlloc_lock`（分配）和 `StringTableWeakActive_lock`（活跃集）
  - 自动扩容：`_current_size` + `ceil_pow_2(StringTableSize)` 起始规模

  **Section 2. intern 的完整流程**
  - `intern()`（`stringTable.cpp:312-328`）：
    1. `java_lang_String::hash_code()` 计算 hash
    2. `lookup_shared()` 查 CDS 共享表（如果有）
    3. `do_lookup()` 在 ConcurrentHashTable 中查
    4. 找到 → 返回
    5. 未找到 → `do_intern()`
  - `do_intern()`（`stringTable.cpp:354-382`）：
    1. `string_or_null_h.is_null()`? → `create_from_unicode`
    2. **dedup**: `Universe::heap()->deduplicate_string()`
    3. `get_insert_lazy(THREAD, lookup, stc, stc, &rehash_warning)` → CAS insert
    4. rehash_warning → `_needs_rehashing = true`

  **Section 3. 自动 rehash**
  - `do_rehash()`（`stringTable.cpp:556-577`）：
    1. 检查 safepoint 安全
    2. 计算新 size → `new StringTableHash(new_size)`
    3. `try_move_nodes_to()` → 移动所有 entry 到新表
    4. 成功 → 设置 `_alt_hash = true`（使用备用哈希避免全部碰撞）
    5. 失败 → 回退，下次再试
  - rehash 只扩容不缩容——`_current_size` 单调递增

  **Section 4. GC 交互**
  - 弱引用清理：OopStorage 的 weak handle 在 GC 后变成 NULL
  - `unlink_or_oops_do()`：concurrent mark 安全遍历
  - `_uncleaned_items` 追踪待清理的 entry 数

  **Section 5. String Dedup 交互**
  - intern 前 dedup：`deduplicate_string(string_h())`
  - 原因：compiler 可能对 interned 字符串做了优化——先 dedup 避免打破优化
  - StringDedupTable 在 G1/Shenandoah 中独立实现

  **Section 6. jcmd 诊断**（新增）
  - `jcmd <pid> VM.stringtable [-verbose]`：`StringtableDCmd`（`stringTable.cpp:758-763`）
    - 默认打印字符串统计（bucket 数/entry 数/字面量大小/平均/标准差）
    - `-verbose` 时逐个打印字符串内容
    - 底层：`print_table_statistics`（`hashtable.cpp:322-359`）→ 遍历所有 bucket 和 entry 链 → 聚合统计
  - `jcmd <pid> VM.symboltable [-verbose]`：`SymboltableDCmd`（`symbolTable.cpp:733`）
    - 同理，遍历所有 Symbol，聚合统计后打印
    - `-verbose` 时逐个打印符号内容

---

### 03 — ResolvedMethodTable

- [ ] **03-resolved-method-table.md**

- [ ] **03-resolved-method-table.md**
  | 定位: ResolvedMethodTable 全线——从 JVM 业务作用到 weak handle 到 GC unlink 到 redefineClasses
  | 前置: ch10/07 + 01 + 02

  **Section 1. ResolvedMethodTable 在 JVM 中的作用**（新增）
  - JDK 7 `invokedynamic` 引入后，方法解析不再是类加载时一次性完成——`invokedynamic` 的调用目标由 bootstrap method 在运行时动态计算
  - `ResolvedMethodName`：一个 Java 对象，封装了已解析的 Method 引用。Bootstrap method 返回它来告诉 JVM "这个 invokedynamic 调用的就是这个方法"
  - ResolvedMethodTable 缓存 `Method*` → `ResolvedMethodName` oop 的映射——避免重复 bootstrap
  - 典型场景：
    - Lambda 表达式 `list.forEach(x -> ...)` → invokedynamic → LambdaMetafactory → 生成 ResolvedMethodName → 缓存
    - 字符串拼接 `"" + obj` → invokedynamic → StringConcatFactory → 生成 ResolvedMethodName → 缓存
    - `MethodHandles.lookup().findVirtual(...)` → MemberName → resolve → ResolvedMethodName
  - 为什么 key 用 CLD hash 组合：不同 class loader 的同名同签名方法不应该映射到同一个 ResolvedMethodName
  - 缓存失效：类被 redefine 时 `adjust_method_entries()` 更新 entry；class loader 被卸载时 weak handle 自动清空
  - 面试常问："invokedynamic 的性能靠什么保证？" → ResolvedMethodTable 缓存 + LambdaForm 编译

  **Section 1. 结构**
  - `ResolvedMethodTable : Hashtable<ClassLoaderWeakHandle, mtClass>`（`resolvedMethodTable.hpp`）
  - 单例：`_the_table`
  - entry 类型：`ResolvedMethodEntry`（extends `HashtableEntry`）
  - key = Method* → 通过 `compute_hash` 转哈希值
  - value = `ResolvedMethodName` oop（weak handle）

  **Section 2. compute_hash 四元组**
  - `compute_hash()`（`resolvedMethodTable.cpp:81-87`）：
    ```cpp
    hash = CLD->identity_hash();           // 哪个 class loader
    hash = (hash*31) ^ klass_name->identity_hash();  // 哪个类
    hash = (hash*31) ^ name->identity_hash();        // 方法名
    hash = (hash*31) ^ signature->identity_hash();   // 签名
    ```
  - 为什么用 CLD hash → 不同 loader 的同名同签名方法是不同的——必须区分

  **Section 3. lookup + basic_add**
  - `lookup(Method*)`：compute_hash → bucket→next 遍历 → 比较 `vmtarget == method`
  - `basic_add()`：locked → compute_hash → 重查（double-check lock） → `ClassLoaderWeakHandle::create()` → `add_entry`
  - Lock: `ResolvedMethodTable_lock`

  **Section 4. unlink——GC 清理**
  - `unlink()`（`resolvedMethodTable.cpp:155-182`）：
    1. 遍历每个 bucket 的 chain
    2. `object_no_keepalive()` → peek 弱引用
    3. NULL → 弱引用已死 → 从链表中移除
    4. 调用 `literal().release()` 释放 weak handle 和底层 OopStorage entry
  - 定期触发：每次 GC 后 SystemDictionary 会调

  **Section 5. adjust_method_entries——redefineClasses 支持**
  - `adjust_method_entries()`（`resolvedMethodTable.cpp:204-241`）：
    - 遍历所有 entry → 检查 `Method::is_old()` → 替换为 `get_new_method()`
    - 为 JVMTI RedefineClasses 服务
    - 仅在 safepoint 中执行

---

### 04 — 创建路径 + CDS 差异 + 三者对比

- [ ] **04-create-table-comparison.md**
  | 定位: 收尾——CDS vs 非 CDS 路径差异、三者对比、在 universe_init 中的位置
  | 前置: 01 + 02 + 03

  **Section 1. CDS 路径下的创建差异**
  - CDS: SymbolTable 不调 `create_table()`（archive mmap 恢复）
    - StringTable 调 `create_table()`（_local_table 新建，但 _shared_table 指向 mmap 区）
  - 非 CDS: 两个都调 `create_table()`
  - ResolvedMethodTable 始终调 `create_table()`（不参与 CDS）

  **Section 2. 三个 Table 的锁模型对比**

  | Table | 数据结构 | 读锁 | 写锁 | rehash |
  |-------|---------|------|------|--------|
  | SymbolTable | RehashableHashtable | 无锁（预查）→ SymbolTable_lock（正式加） | SymbolTable_lock | 需要（bucket 碰撞） |
  | StringTable | ConcurrentHashTable | 无锁 | 内部 CAS | 自动（膨胀触发） |
  | ResolvedMethodTable | 简单 Hashtable | 无 | ResolvedMethodTable_lock | 不需要（固定大小） |

  **Section 3. entry 生命周期对比**
  - SymbolTable entry 何时死：refcount 降到 0 + GC unlink
  - StringTable entry 何时死：弱引用被 GC 清空 + unlink
  - ResolvedMethodTable entry 何时死：弱引用被 GC 清空 + unlink

  **Section 4. JVM 启动参数速查**（新增）

  | 参数 | 默认值 | 影响的 Table | 说明 |
  |------|--------|-------------|------|
  | `-XX:SymbolTableSize` | 20011 | SymbolTable | 固定 bucket 数——SymbolTable 不自动扩容 |
  | `-XX:StringTableSize` | 65536 (LP64) / 1009 (client) | StringTable | 初始 bucket 数——StringTable 会自动 rehash 扩容 |
  | `-XX:StringDeduplicationAgeThreshold` | 3 | StringTable (间接) | G1 String Dedup——达到这个年龄的字符串才考虑去重 |
  | `-XX:MetaspaceSize` | ~20MB | 间接 | 所有三个 Table 的 Symbol/String 对象都在 Metaspace 中 |

  **Section 5. 在 universe_init 中的精确位置**
  - `universe_init` 源码 → `MetaspaceShared::initialize_shared_spaces`（CDS 路径）或 `SymbolTable::create_table`（非 CDS）→ `StringTable::create_table` → `ResolvedMethodTable::create_table`

---

## 关键决策

### 为什么 SymbolTable 放第一篇

SymbolTable 使用最基础的数据结构（`RehashableHashtable`）和最简单的分配策略（Arena vs C-heap），且是整个 ch14 的入口——StringTable 和 ResolvedMethodTable 都依赖对 Symbol 和 Hashtable 基类的理解。先把它讲透，后面两篇可以直接引用"类似 SymbolTable 的 lock-free lookup"而不重复解释。

### 为什么 StringTable 是独立一篇（不合并到 SymbolTable）

SymbolTable 是固定大小 Hashtable + 简单 GC unlink。StringTable 完全不同——ConcurrentHashTable 的 lock-free 读 + CAS 写 + 自动 rehash + OopStorage weak handle + dedup 交互，复杂度远高于 SymbolTable。合并会淹没两者的关键差异——读者读完可能以为 StringTable 只是"符号表的字符串版本"，其实内部实现完全不同。

### 为什么 ResolvedMethodTable 是独立一篇（不是 04 的小节）

三个关键差异：compute_hash 四元组设计（CLD-aware）、redefineClasses 的 adjust_method_entries、以及最简的实现（简单 Hashtable，无 rehash）。这些值得独立成篇——读者对比三种 Table 的设计权衡能理解"选择简单实现还是复杂实现的工程判断"。

### 为什么需要第 4 篇收尾

CDS 和非 CDS 两条路径下 `create_table` 的调用顺序不同、锁模型不同、生命周期不同。不单独收尾的话，读者可能在 01-03 中"只见树木不见森林"——知道每个 Table 怎么工作，但不理解它们在同一时刻的创建顺序和相互关系。

---

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 | ✅ | 07/24 | SymbolTable 全线 (364行) |
| 02 | ✅ | 07/24 | StringTable 全线 (367行) |
| 03 | ✅ | 07/24 | ResolvedMethodTable 全线 (307行) |
| 04 | — | — | |

---

## 与前后章节的连接

```
ch10/07 Metaspace 背景 ──→ ch11 堆初始化 ──→ ch13 CDS ──→ ch14 三个 Table
                                                          │
                           universe_init 中                 ├─ 01: SymbolTable
                           create_table 调用               ├─ 02: StringTable  
                                                          ├─ 03: ResolvedMethodTable
                                                          └─ 04: CDS 差异 + 对比
```
