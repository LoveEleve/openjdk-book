# 06. Symbol + Annotations — 辅助元数据

> 🟡 Working | 15 KP 中的 3 个辅助机制
> 读者处境: JVM 有成千上万个 "java/lang/String" 引用——怎么不去重 10000 遍？Symbol intern 机制。

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
