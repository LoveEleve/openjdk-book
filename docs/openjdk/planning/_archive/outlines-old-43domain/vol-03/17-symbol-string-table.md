# SymbolTable / StringTable — 文章大纲

> vol-03 · 域 17 · 🟡 B | 拓扑排序 #17
> 依赖：OOPs + GC Framework（弱引用与 GC 交互）
>
> **→ 从 Metaspace**：类元数据存在 Metaspace，但类名 `"java/lang/String"` 和字段名 `"value"` 这些字符串本身存在哪？被成千上万个类反复引用——JVM 用 SymbolTable 内部化，全 JVM 共用一个实例。String.intern() 同理。

## 叙事计划

**开篇场景**：你写 `"hello" == "hello"`——JVM 把这两个字符串字面量指向同一个对象。不是编译器优化，是 JVM 用 `StringTable` 做字符串内部化——每个字面量在加载时被 `intern` 进去，后续引用直接返回已有对象。Class 的类名、方法名、字段名也是同样机制——通过 `SymbolTable` 内部化，整个 JVM 共用一个 Symbol 实例。

**第一层：SymbolTable——类名/方法名的内部化**

`SymbolTable`（`symbolTable.hpp:101`，继承 `RehashableHashtable<Symbol*>`）用一个并发哈希表存储所有 `Symbol` 对象。`Symbol` 用引用计数管理生命周期——`TempNewSymbol` 是 RAII 包装：构造时 `increment_refcount()`，析构时 `decrement_refcount()`。`rehash_table()`（`symbolTable.cpp:184`）在元素过多时触发重哈希防退化。

**第二层：StringTable——JDK11 的 ConcurrentHashTable 重写**

`StringTable`（`stringTable.hpp:42-43`）用 `ConcurrentHashTable<WeakHandle<vm_string_table_data>>`——JDK11 全新设计的无锁并发哈希表。`WeakHandle` 指向 `OopStorage* _weak_handles`（弱引用存储）——被 intern 的字符串是弱引用，如果程序中没有任何强引用指向它，GC 可以回收。

`intern()` 三入口：`intern(Symbol*)` / `intern(oop, TRAPS)` / `intern(const char*)`。核心路径 `do_intern()`（`:354`）——查哈希表，已存在返回已有对象，不存在则创建并插入。哈希碰撞用 `_alt_hash` + `halfsiphash`（`:75,246`）应对恶意碰撞攻击（哈希洪水）。

**第三层：与 GC 的交互——弱引用为什么重要**

StringTable 用弱引用存储 interned 字符串——和 `WeakReference` 同原理。如果 interned 字符串在代码中没有任何强引用，GC 可以在标记阶段清除它。但类加载器持有的字符串有隐式强引用路径（ClassLoader → Class → ConstantPool → String）——不会被随意回收。这个边界是 `OopStorage::delete_entry()` 管理的。

**设计权衡**

一、并发哈希 vs 全局锁。JDK11 之前 StringTable 用 `RehashableHashtable` + `SystemDictionary_lock` 保护。JDK11 用 `ConcurrentHashTable` 实现无锁读——多个线程可以同时 `intern()`。代价是实现复杂度大幅提高。

二、弱引用 vs 强引用。弱引用允许 interned 字符串被 GC 回收——避免内存泄漏。代价是 GC 标记时多走一步 `OopStorage` 遍历。

## 核心悬念

**`String.intern()` 怎么做到既能全局去重、又能被 GC 安全回收——JDK11 的 ConcurrentHashTable + 弱引用是怎么替代旧版全局锁方案的？**

## 预估

1 篇，3 层递进，预估 1200-1600 行。

**→ 下一域**：类名、字段名被 SymbolTable 内部化了；字符串被 StringTable 缓存了——但 JIT 编译后的 nmethod 存储在哪里？代码的"堆" CodeCache 篇见。
