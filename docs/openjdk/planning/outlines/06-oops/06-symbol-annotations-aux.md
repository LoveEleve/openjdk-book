# 06. Symbol + Annotations — 辅助元数据

> 🟡 Working | 15 KP 中的 3 个辅助机制
> 读者处境: JVM 有成千上万个 "java/lang/String" 引用——怎么不去重 10000 遍？Symbol intern 机制。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/06-oops/06 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"_hash precomputed hash 字段"编造**: Symbol 无 _hash 字段,是 `short _identity_hash`(symbol.hpp:114)+ identity_hash() 动态计算(:151-155,地址位^长度^前两字节);结构=ATOMIC_SHORT_PAIR(_refcount,_length)(:110-113)+ _body[2] 柔性数组(:115),operator new(size,len) 按长度分配(:133-135),max=2^16-1(:117-120)
> - **as_C_string 会加 \0**: 注释原文 "null-terminated UTF-8 string"(symbol.hpp:206-208),资源区或调用方 buffer——大纲"不加 \0"错
> - **_refcount 是原子的**: `volatile short` + 注释 "needs atomic operation"(:111),Atomic::inc/add(symbol.cpp:277-289);PERM_REFCOUNT=-1 永久符号(:99-101)
> - **ConcurrentHashTable 编造**: SymbolTable 是 `RehashableHashtable<Symbol*, mtSymbol>`(symbolTable.hpp:101,**在 share/classfile/ 非 oops/**),全局 **SymbolTable_lock**(symbolTable.cpp:329-330);StringTable 才是 ConcurrentHashTable(stringTable.hpp:42)——关键设计对比成立
> - **rehash 表述修正**: 删除=GC 周期 SymbolTable::unlink 摘 refcount()==0(symbolTable.cpp:147-155,:131),非"定期 rehash"
> - **AnnotationArray 是 Array<u1>(字节)不是 int 数组**(annotations.hpp:38);四份容器 :44-55;parse_annotations 在 classFileParser.cpp:1213
> - **FieldInfo 无 attributes_count**: 槽 3=initval_index(fieldInfo.hpp:66,与 03 篇一致)——大纲"attributes_count"错
> - **FieldStream 不含父类**: FieldStreamBase(InstanceKlass*) 遍历本类 java_fields_count(fieldStreams.hpp:102-109)
> - **CompiledICHolder 字段编造**: 是 `Metadata* _holder_metadata` + `Klass* _holder_klass` + `bool _is_metadata_method`(compiledICHolder.hpp:51-54),非 "_holder_method: Method*";用途=inline cache 辅助对象(:33 注释);"cmp/jne/jmp + 95% 命中"汇编/数字删除

### 1. Symbol — 全局唯一字符串

场景: `ClassFileParser` 读到第 10000 次 "java/lang/String"——再创建一个 Symbol？不——查 SymbolTable hashtable——返回第一个——引用计数 +1。

**Symbol 结构** (`symbol.hpp:40-100`):
- `_length` + `_body[]` (UTF-8 bytes)——Symbol 对象和内容在连续内存——一次分配
- `_hash`: precomputed hash——查 SymbolTable 时用——避免每次 compute
- [C++: Symbol 是 immutable——创建后永不修改——多线程安全共享指针。UTF-8 内部 (不是 Java modified UTF-8)——`\0` 作为有效字符。`Symbol::as_C_string()`——不加 `\0`——`char* str = NEW_RESOURCE_ARRAY(char, length+1); memcpy(str, _body, length); str[length]=0;`]
- `_refcount`: 引用计数——`increment_refcount()` + `decrement_refcount()`——manual 管理——不是 atomic——多线程访问由调用者保证同步

**SymbolTable intern** (`symbolTable.hpp/cpp` + `symbolTable.cpp`):
- `SymbolTable::lookup(name, len, hash)`: ConcurrentHashTable lookup——O(1)
- `SymbolTable::new_symbol(name, len, hash)`: lookup first→如果存在→return existing→否则 allocate new Symbol→insert into table
- [C++: ConcurrentHashTable——多线程并发 lookup——无全局锁——per-bucket lock。insert 有 global lock。lookup 后 `Symbol::increment_refcount()` 在多线程下可能 race——由调用者 (ClassFileParser) 保证——CP 持有 refcount]
- rehash: 定期——清理 refcount=0 的 Symbol——释放 Metaspace 内存

### 2. Annotations + Field + CompiledICHolder

**Annotations** (`annotations.hpp:30-80`):
- `AnnotationArray`——扁平 int 数组——压缩存储注解数据 (type_index + element_value pairs)
- [C++: 注解不是对象——是 int array——和 ClassFile 中的二进制格式一样。`ClassFileParser::parse_annotations()`→生成的运行时常量池条目 + element_value pairs→存到 AnnotationArray]
- `type_annotations()`: Java 8+ type annotations——`@NonNull String` 的 `@NonNull` 存为 type_annotation

**Field** (`fieldInfo.hpp` + `fieldStreams.hpp`):
- `FieldInfo`: access_flags (u2) + name_index (u2) + signature_index (u2) + attributes_count (u2)——6 fields
- [C++: field offset——`FieldInfo::offset()`——非 static field 在对象中的偏移。`Unsafe.objectFieldOffset(field)` 返回此值。static field——offset 是 mirror klass 中的 static field 偏移]
- `FieldStream`: 遍历类的所有 field——包括来自父类的——顺序=ClassFile 字段声明顺序

**CompiledICHolder** (`compiledICHolder.hpp:30-60`):
- `_holder_method`: Method*——被 cache 的方法
- `_holder_klass`: Klass*——目标 receiver class
- [x86: compiled IC stub——`cmp [rax+klass_offset], _holder_klass; jne miss; jmp _holder_method`——两条指令+一个分支——95% 命中 (monomorphic call site)→直接跳——5% miss→full vtable lookup——~20 cycles penalty]

---

### 核心悬念

**"`"java/lang/String"`——整个 JVM 中只有 1 个 Symbol 对象。"** — SymbolTable 的 intern 机制。Annotations 是 int array 不是对象。CompiledICHolder 是 JIT 的 inline cache——让 95% 虚方法调用跳过 vtable lookup。域 6 完成。Group 2 结束。下一篇: 类加载——.class 文件怎么变成 InstanceKlass？

> → domain 7: [ClassFile — .class 字节怎么变成 InstanceKlass？](../07-classfile-classloader/01-classfile-parser.md)
