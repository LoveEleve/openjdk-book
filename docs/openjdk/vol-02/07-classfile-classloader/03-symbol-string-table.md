# 03. SymbolTable + StringTable — 两个 intern 表

> **前置依赖**:[06-oops/06 — Symbol 与注解](openjdk/vol-02/06-oops/06-symbol-annotations-aux.md):Symbol 的结构/引用计数与 SymbolTable 的查表/清扫已拆过——本篇接上 StringTable 与两表对比;[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):解析时 Utf8 已经走了一次 SymbolTable 的批量分配
> → **后续**:[04 — SystemDictionary](04-system-dictionary.md)
> 关联域: 06-oops(对象模型)、25-gc(弱引用与清理)、11-cds(共享表)

## 两个 intern 表,两种生命周期

"相同内容只存一份"在 JVM 里由**两张表**完成,因为它们服务的对象生命周期完全不同: **SymbolTable** 存类名/方法名/字段签名——C++ 的 Symbol,放 Metaspace,靠引用计数回收; **StringTable** 存 `String.intern()` 的结果——Java 的 String 对象,放堆,靠 GC 淘汰。06 域拆过 Symbol 本体(结构、refcount 的 Atomic 语义、PERM_REFCOUNT)和 SymbolTable 的查表/清扫;这一篇把 SymbolTable 的锁语义补齐,然后重点拆 StringTable: intern 全链路、弱引用与 GC、以及两表为何选择了完全不同的并发策略。

## 1. SymbolTable: 一把全局锁的经典哈希表

06-06 已确认关键事实: **SymbolTable 不是并发哈希**——它是 `RehashableHashtable<Symbol*>` 加一把全局锁(symbolTable.hpp:101)。`lookup` 的流程把锁的用法写得明明白白(symbolTable.cpp:319-334,逐字):

```cpp
// symbolTable.cpp:319-334(逐字)
Symbol* SymbolTable::lookup(const char* name, int len, TRAPS) {
  len = check_length(name, len);
  unsigned int hashValue = hash_symbol(name, len);
  int index = the_table()->hash_to_index(hashValue);

  Symbol* s = the_table()->lookup(index, name, len, hashValue);

  // Found
  if (s != NULL) return s;

  // Grab SymbolTable_lock first.
  MutexLocker ml(SymbolTable_lock, THREAD);

  // Otherwise, add to symbol to table
  return the_table()->basic_add(index, (u1*)name, len, hashValue, true, THREAD);
}
```

- **先无锁查,再上锁插**: 读路径(Symbol 不会被删除,GC 清理在 safepoint)直接查桶;只有 miss 才 `MutexLocker(SymbolTable_lock)` 拿全局锁做 `basic_add`;
- **hash 与 String 同源**: `hash_symbol`(:286-290)默认用 `java_lang_String::hash_code`(与 String 对象的 hashCode 算法一致),开启交替哈希时用 `AltHashing::halfsiphash_32`——两个 intern 表共用同一套 hash,`String.intern()` 才能直接和常量池里的内容对上;
- **回收在 GC 周期**: 06-06 讲过 `unlink` 摘掉 `refcount()==0` 的符号——细节是 `buckets_unlink` 遍历桶、`bulk_free_entries` **批量释放**(symbolTable.cpp:147-155),refcount 归零的 Symbol 在 Metaspace 里被整批归还。`rehash_table`(:184)是另一回事: 换交替哈希种子、把活条目搬进新表,不是回收。

**关键设计 (斜体)**: *"先查后锁"让命中路径完全无锁——而 SymbolTable 的命中率极高(类名/方法名被反复查)。全局锁只在插入时短暂持有,代价可接受。这条设计与 StringTable 的并发哈希形成对照: Symbol 的访问频率虽高但极短,而 String.intern 是用户可触发的热点,且要配合 GC 做清理——两种负载,两种结构。*

## 2. StringTable: intern 的全链路

### 入口: String.intern → JVM_InternString

`String.intern()` 的 native 端是 `JVM_InternString`(jvm.cpp:3501-3509,逐字):

```cpp
// jvm.cpp:3501-3509(逐字)
JVM_ENTRY(jstring, JVM_InternString(JNIEnv *env, jstring str))
  JVMWrapper("JVM_InternString");
  JvmtiVMObjectAllocEventCollector oam;
  if (str == NULL) return NULL;
  oop string = JNIHandles::resolve_non_null(str);
  oop result = StringTable::intern(string, CHECK_NULL);
  return (jstring) JNIHandles::make_local(env, result);
JVM_END
```

表本身是**并发哈希**: `typedef ConcurrentHashTable<WeakHandle<vm_string_table_data>, StringTableConfig, mtSymbol> StringTableHash`(stringTable.hpp:42-43)——注意 value 是 **`WeakHandle`**(弱句柄,06-05 拆过),这正是"GC 淘汰"的支点。intern 的查插流程(stringTable.cpp:312-328,截取核心,逐字):

```cpp
// stringTable.cpp:312-328(截取核心,逐字)
oop StringTable::intern(Handle string_or_null_h, jchar* name, int len, TRAPS) {
  // shared table always uses java_lang_String::hash_code
  unsigned int hash = java_lang_String::hash_code(name, len);
  oop found_string = StringTable::the_table()->lookup_shared(name, len, hash);
  if (found_string != NULL) {
    return found_string;
  }
  if (StringTable::_alt_hash) {
    hash = hash_string(name, len, true);
  }
  found_string = StringTable::the_table()->do_lookup(name, len, hash);
  if (found_string != NULL) {
    return found_string;
  }
  return StringTable::the_table()->do_intern(string_or_null_h, name, len,
                                             hash, THREAD);
}
```

三段式: **共享表(CDS) → 活表 → 插入**。`lookup_shared` 查 CDS 归档里的只读字符串(11-cds 域的共享表);miss 后若开启交替哈希换用 `hash_string`(halfsiphash);`do_lookup` 在活表里找;都没有才 `do_intern` 插入。

### do_intern: 建对象、去重、插表

`do_intern`(stringTable.cpp:354-380,截取核心,逐字):

```cpp
// stringTable.cpp:354-380(截取核心,逐字)
oop StringTable::do_intern(Handle string_or_null_h, jchar* name,
                           int len, uintx hash, TRAPS) {
  HandleMark hm(THREAD);  // cleanup strings created
  Handle string_h;

  if (!string_or_null_h.is_null()) {
    string_h = string_or_null_h;
  } else {
    string_h = java_lang_String::create_from_unicode(name, len, CHECK_NULL);
  }

  // Deduplicate the string before it is interned. Note that we should never
  // deduplicate a string after it has been interned. Doing so will counteract
  // compiler optimizations done on e.g. interned string literals.
  Universe::heap()->deduplicate_string(string_h());

  assert(java_lang_String::equals(string_h(), name, len),
         "string must be properly initialized");
  assert(len == java_lang_String::length(string_h()), "Must be same length");
  StringTableLookupOop lookup(THREAD, hash, string_h);
  StringTableCreateEntry stc(THREAD, string_h);
  bool rehash_warning;
  _local_table->get_insert_lazy(THREAD, lookup, stc, stc, &rehash_warning);
  if (rehash_warning) {
    _needs_rehashing = true;
  }
```

- **没现成对象就造一个**: `java_lang_String::create_from_unicode`(javaClasses.cpp:263-285)——`CompactStrings` 开启时先检测是否纯 Latin-1,是则创建 `byte[]` value,否则 `char[]`(这就是为什么 JDK 9+ 的 "abc" 的 value 只占 16+3 字节而非 16+6——数组头 16 字节,06-03 讲过);
- **插入前先做字符串去重**(:365-367,`deduplicate_string`,注释: 入表后就不能再 dedup,否则会破坏对 intern 字面量的编译期优化)——这是 JDK 8u20 的 String Deduplication 特性在 intern 路径上的落点;
- **插入走 `get_insert_lazy`**: ConcurrentHashTable 的懒插入,带 rehash 预警(桶不平衡时置 `_needs_rehashing`)。

### 语义实证

[实证](materials/commands/07-classfile-stringtable-log.txt)里 intern 的行为与上面的链路一一对应:

```
new == new:       false          ← 两个 new String("abc") 是不同对象
a.intern()==b.intern(): true     ← intern 后是同一个
literal==intern:  true           ← 字面量编译期已 intern
interned 200000 strings, kept=200000
```

**关键设计 (斜体)**: *intern 的语义是"内容相同即同一对象",但表的 value 是弱引用——这保证了**表本身不延长字符串生命周期**: 没有外部强引用的 intern 字符串,GC 后从表里消失。这与 SymbolTable(强引用+refcount)的根本差异,来自两种对象的所有权: Symbol 归 Metaspace 管,SymbolTable 必须自己计数;String 归堆管,GC 天然知道谁死谁活。*

## 3. 弱引用与并发维护: GC 怎么清表

### 淘汰: weak_oops_do

表的弱句柄全部收在 `OopStorage* _weak_handles`(stringTable.hpp:71,06-05 拆过 OopStorage)。GC 的清理入口是 `unlink_or_oops_do`(stringTable.cpp:402-417,截取核心,逐字):

```cpp
// stringTable.cpp:402-417(截取核心,逐字)
void StringTable::unlink_or_oops_do(BoolObjectClosure* is_alive, OopClosure* f,
                                    int* processed, int* removed) {
  DoNothingClosure dnc;
  assert(is_alive != NULL, "No closure");
  StringTableIsAliveCounter stiac(is_alive);
  OopClosure* tmp = f != NULL ? f : &dnc;

  StringTable::the_table()->_weak_handles->weak_oops_do(&stiac, tmp);

  // This is the serial case without ParState.
  // Just set the correct number and check for a cleaning phase.
  the_table()->_uncleaned_items = stiac._count;
  StringTable::the_table()->check_concurrent_work();
```

`weak_oops_do(is_alive, f)` 遍历弱句柄: 死对象(没有外部引用)直接清除并计数,活对象的 oop 经 f 更新(GC 搬运后修正引用)——**一个调用同时完成"清理死项"和"修正活项"**。并行版 `possibly_parallel_unlink`(:429)按桶分块,原子认领。标记阶段另有 `oops_do`(:419-422)只修引用不清项。

### 维护: 检查与增长的时机

死项的清除(weak_oops_do)每次 GC 都做;而表的**增长与深度清理**由 `check_concurrent_work`(stringTable.cpp:520-536,截取核心,逐字)按负载决定,实际执行在 **serviceThread** 上(serviceThread.cpp:123,GC 间隙):

```cpp
// stringTable.cpp:520-537(截取核心,逐字)
void StringTable::check_concurrent_work() {
  if (_has_work) {
    return;
  }

  double load_factor = StringTable::get_load_factor();
  double dead_factor = StringTable::get_dead_factor();
  // We should clean/resize if we have more dead than alive,
  // more items than preferred load factor or
  // more dead items than water mark.
  if ((dead_factor > load_factor) ||
      (load_factor > PREF_AVG_LIST_LEN) ||
      (dead_factor > CLEAN_DEAD_HIGH_WATER_MARK)) {
    log_debug(stringtable)("Concurrent work triggered, live factor:%g dead factor:%g",
                           load_factor, dead_factor);
    trigger_concurrent_work();
  }
}
```

三条件任一满足就触发: **死项比活项多、负载超过平均桶长上限、死项超过高水位**。真正干活的是 `concurrent_work`(:538-550)——**优先 grow**(表翻倍,顺带清掉死项),表到上限才 `clean_dead_entries` 只清不扩。默认表大小 65536(globalDefinitions.hpp:483),[实证] 里 20 万次 intern 的日志恰好演示了全过程(materials/commands/07-classfile-stringtable-log.txt):

```
[0.093s][debug][stringtable] Concurrent work triggered, live factor: 3.05232 dead factor: 1.52589
[0.113s][debug][stringtable] Grown to size:131072
```

表从 65536 翻倍到 131072,而 dead factor 1.53 说明有约 10 万个 intern 字符串已失去强引用(正好对应 demo 里释放的那批)、等着被下一次清理摘掉——弱引用淘汰不是"立刻",是"随 GC 与服务线程的负载检查推进"。

### 两表对比

| | SymbolTable | StringTable |
|---|---|---|
| 内容 | 类名/方法名/签名(Symbol) | Java String 对象 |
| 存储 | Metaspace | 堆 |
| 表结构 | RehashableHashtable + 全局锁 | ConcurrentHashTable(并发) |
| 表内引用 | 强引用(Symbol 指针) | WeakHandle(弱引用) |
| 淘汰 | refcount==0,GC 周期 unlink 批量释放 | GC weak_oops_do 清除死项 |
| hash | java_lang_String::hash_code / alt halfsiphash | 同左(共用) |

**关键设计 (斜体)**: *"谁拥有对象,谁负责回收"决定了两张表的形态: Metaspace 里的 Symbol 没人替它记账,只能 refcount + 全局锁的简单正确性;堆里的 String 有 GC 全权管理,表就可以用弱引用 + 并发哈希 + 负载检查,把维护成本摊到 GC 周期。intern 的代价不是表本身,而是"查表→建对象→插表"的每次往返——所以命中路径(查)是并发无锁的,插入路径才需要小心。*

## 核心悬念

两个 intern 表到此分明: SymbolTable 一把全局锁管 Metaspace 里的名字(refcount 淘汰),StringTable 用并发哈希管堆里的字符串(弱引用 + GC 淘汰),hash 同源、生命周期相反。但"java/lang/String 只有一个"是**同一名字只有一个 Symbol**——不同的 `ClassLoader` 可以各自读到 "java/lang/String" 并定义出不同的类。下一篇: SystemDictionary——同一个全限定名在不同 ClassLoader 里是不同类,名字到类的第一道闸门。

> → [04 — SystemDictionary](04-system-dictionary.md)
