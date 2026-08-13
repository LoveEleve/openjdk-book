# 03. SymbolTable + StringTable — 两个 intern 表

> 🔴 Deep | 15 KP 中的 1 个核心机制
> 读者处境: `String.intern()`——怎么保证相同字符串只存一次？不是 Java HashMap——是 JVM 的 StringTable。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/07-classfile-classloader/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 ~230 行):
> - **"SymbolTable 并发 hash / ConcurrentHashTable::get()→per-bucket lock" 错**(06-06 已证,大纲未更新): SymbolTable=RehashableHashtable<Symbol*>(symbolTable.hpp:101)+**全局 SymbolTable_lock**;lookup(symbolTable.cpp:319-334)=hash_symbol(:286-290)→hash_to_index→**先无锁查桶**(Symbol 只在 safepoint 删除)→miss 才 MutexLocker 拿锁 basic_add(:329-334 "Grab SymbolTable_lock first")
> - **"Symbol::_refcount int16...不需要 atomic" 错**(06-06 已证): volatile short+Atomic::inc/add(symbol.cpp:277-289)
> - **"rehash_table() 回收 Symbol" 错**: 回收=GC 周期 `SymbolTable::unlink`(symbolTable.cpp:147-155,buckets_unlink 遍历+bulk_free_entries **批量释放** refcount==0 的符号);`rehash_table`(:184-203)是**换交替哈希种子重建表**(new SymbolTable+move_to,非回收)
> - **"StringTable key=Symbol" 错**: 表=typedef ConcurrentHashTable<**WeakHandle**<vm_string_table_data>,StringTableConfig,mtSymbol>(stringTable.hpp:42-43),key 是字符串内容(name,len,hash)非 Symbol;弱句柄全收在 OopStorage* _weak_handles(:71,06-05 呼应)
> - **intern 全链路**(大纲简化): String.intern→`JVM_InternString`(jvm.cpp:3501-3509)→StringTable::intern(stringTable.cpp:312-328)=lookup_shared(CDS 共享表)→_alt_hash 时 hash_string(halfsiphash)→do_lookup→do_intern(:354-380: 无现成对象→java_lang_String::create_from_unicode 创建+**deduplicate_string 去重**(:365-367,入表后禁止 dedup 注释)+ConcurrentHashTable get_insert_lazy 懒插入+rehash 预警 :377-379)
> - **create_from_unicode**(javaClasses.cpp:263-285): CompactStrings 时 UNICODE::is_latin1 检测→**value 永远是 byte[]**(String.java:140;basic_create :252-253 Latin-1 1B/字符、UTF-16 长度翻倍 2B/字符,非"latin1 byte[]/utf16 char[]"——07-07 REVIEW 修正)→JDK9+ "abc" 占 16+3 字节(数组头 16)
> - **GC 淘汰**(大纲"unlink 遍历 dead entry"简化): unlink_or_oops_do(stringTable.cpp:402-417)=_weak_handles->weak_oops_do(is_alive, f)(死项清除计数+活项修正引用一石二鸟);oops_do(:419-422)标记阶段只修引用;possibly_parallel_unlink(:429)按桶分块原子认领
> - **并发维护**(大纲未提,重点): check_concurrent_work(stringTable.cpp:520-537)三条件(dead>live/load>PREF_AVG_LIST_LEN/dead>CLEAN_DEAD_HIGH_WATER_MARK)→concurrent_work(:538-550,**grow 优先**因顺带清死项)→grow(:455,StringTableHash::GrowTask);StringTableSize 默认 **65536**(globalDefinitions.hpp:483,非 60013)
> - **hash 同源**: java_lang_String::hash_code(javaClasses.cpp:525-540);SymbolTable::hash_symbol 默认同一函数,交替哈希 AltHashing::halfsiphash_32(symbolTable.cpp:286-290)
> - 行号全漂移(大纲 symbolTable.cpp:50-250/stringTable.cpp:40-350 不成立);"lookup inc refcount 后不需要 atomic"错(见 06-06)
> - 悬念指向 04-system-dictionary.md(标题 "04. SystemDictionary — 类的'全球电话号码本'")✓;实证: materials/commands/07-classfile-stringtable-log.txt(Concurrent work triggered live factor 3.05/dead 1.53 + **Grown to size:131072=65536×2** + intern 语义 new==new false/intern==true/literal==intern true)

### 1. SymbolTable — JVM 内部符号 intern

场景: ClassFileParser 读到第 1000 次 `"java/lang/String"`——创建新 Symbol？不——`SymbolTable::lookup(name, len, hash)`→O(1)→返回第一个——`Symbol::increment_refcount()`。

**SymbolTable**(替代原 "symbolTable.cpp:50-250 并发 hash";06-06 已讲结构/refcount/unlink,本篇补锁语义):
- `lookup`(symbolTable.cpp:319-334): hash_symbol→hash_to_index→**先无锁查**→miss 才 `MutexLocker(SymbolTable_lock)`+basic_add
- `hash_symbol`(:286-290)=java_lang_String::hash_code 或 AltHashing::halfsiphash_32——**与 StringTable 共用同一 hash**
- 回收: GC 周期 unlink(:147-155)批量释放 refcount==0;rehash_table(:184-203)=换种子重建表
- [C++: 06-06 已证非 ConcurrentHashTable;全局锁+先查后锁,命中路径无锁]

### 2. StringTable — `String.intern()` 的 JVM 实现

**StringTable::intern**(替代原 "stringTable.cpp:40-350";表=ConcurrentHashTable<WeakHandle>,stringTable.hpp:42-43):
- 链路: `JVM_InternString`(jvm.cpp:3501-3509)→StringTable::intern(:312-328): lookup_shared(CDS)→do_lookup→do_intern
- `do_intern`(:354-380): create_from_unicode(javaClasses.cpp:263-285,CompactStrings latin1)→deduplicate_string(:365-367)→get_insert_lazy 插入+rehash 预警
- GC: unlink_or_oops_do(:402-417)=weak_oops_do(弱句柄在 OopStorage,:71);oops_do(:419-422)
- 维护: check_concurrent_work(:520-537,死>活/负载>平均桶长/死项>水位)→concurrent_work(grow 优先,:538-550)→grow(:455);默认 65536(globalDefinitions.hpp:483)
- [C++: intern 语义实证: new==new false/intern==true/literal==intern true;20 万 intern 触发 Concurrent work+Grown 131072]

---

### 核心悬念

**"SymbolTable (Metaspace, C++ Symbol, 强引用+refcount, 全局锁) vs StringTable (Heap, Java String, 弱引用+GC, 并发哈希)——两个独立的 intern 表。"** — hash 同源、生命周期相反;谁拥有对象谁负责回收。String 存 `String.intern()` 结果——UTF-16, Heap, GC 淘汰。下一篇: SystemDictionary——同一个全限定名在不同 ClassLoader 中是不同类。

> → [04-system-dictionary.md](04-system-dictionary.md)
