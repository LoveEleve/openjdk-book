# 03. SymbolTable + StringTable — 两个 intern 表

> 🔴 Deep | 15 KP 中的 1 个核心机制
> 读者处境: `String.intern()`——怎么保证相同字符串只存一次？不是 Java HashMap——是 JVM 的 StringTable。

### 1. SymbolTable — JVM 内部符号 intern

场景: ClassFileParser 读到第 1000 次 `"java/lang/String"`——创建新 Symbol？不——`SymbolTable::lookup(name, len, hash)`→O(1)→返回第一个——`Symbol::increment_refcount()`。

**SymbolTable 并发 hash** (`symbolTable.cpp:50-250`):
- `lookup(name, len, hash)`: `ConcurrentHashTable::get()`→per-bucket lock→O(1)
- `new_symbol(name, len, hash)`: lookup first→已存在→refcount++→return；否则→allocate Symbol in Metaspace→insert into table→return
- [C++: ConcurrentHashTable——`_table` 是 volatile bucket 数组。lookup: read bucket→key match→CAS。insert: `_global_lock` MutexLocker——全局锁→不频繁 (大部分是 lookup hit)。bucket number = hash % table_size]
- [C++: `Symbol::_refcount`——int16——manual——没有 `shared_ptr`。创建者 inc→使用者 dec。refcount=0 时 `SymbolTable::rehash_table()` 回收 Symbol→释放 Metaspace。多线程安全: lookup 在 ConcurrentHashTable 中——lookup inc refcount 后——调用者的 refcount 是私有的→不需要 atomic]
- [JVM Spec: §4.4.7 The CONSTANT_Utf8_info Structure — modified UTF-8 编码: `\u0001-\u007f`=1B, `\u0080-\u07ff`=2B, `\u0800-\uffff`=3B, supplementary chars=6B (surrogate pair)]

### 2. StringTable — `String.intern()` 的 JVM 实现

**StringTable::intern** (`stringTable.cpp:40-350`):
- `intern(oop string, TRAPS)`: lookup→已存在→return existing→否则→allocate in heap→insert→return
- [C++: StringTable——key=Symbol (intern string content), value=Heap OOP。String 是 Java 对象——在 heap 中——StringTable 保存 OOP——GC 必须更新 forwarding。`StringTable::oops_do(OopClosure*)`→遍历所有 entry→更新 OOP 引用]
- [C++: `java_lang_String::create_from_unicode(jchar* buf, int len)`——在 heap 上创建 String 对象→设置 value (char[] or byte[], per coder)→设置 coder (LATIN1 or UTF16)→设置 hash (0=未计算)→return oop]
- `String.intern()`: native method→`JVM_InternString(JNIEnv*, jstring)`→`StringTable::intern(java_lang_String::as_oop(string), THREAD)`
- GC 清理: `StringTable::unlink()`——GC safepoint——遍历 dead entry→remove from table→free InternedString object

---

### 核心悬念

**"SymbolTable (Metaspace, C++ Symbol) vs StringTable (Heap, Java String)——两个独立的 intern 表。"** — Symbol 存类名/方法名/字段名——UTF-8, Metaspace, refcount 淘汰。String 存 `String.intern()` 结果——UTF-16, Heap, GC 淘汰。下一篇: SystemDictionary——同一个全限定名在不同 ClassLoader 中是不同类。

> → [04-system-dictionary.md](04-system-dictionary.md)
