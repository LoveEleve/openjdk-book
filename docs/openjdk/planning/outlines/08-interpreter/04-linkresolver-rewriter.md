# 04. LinkResolver + Rewriter — 符号→直接引用 + 字节码重写

> 🔴 Deep | 13 KP 中的 2 个核心机制
> 读者处境: `invokevirtual #5`——#5 是什么？ConstantPool 第 5 个条目——LinkResolver 解析它→method address——Rewriter 把 #5 改成 cpCache index。

### 1. LinkResolver — 符号引用→直接引用

场景: 解释器执行 invokevirtual→`InterpreterRuntime::resolve_invoke()`→`LinkResolver::resolve_invokevirtual()`→查 cpCache→未解析→resolve→cpCache._f2=vtable index→返回。

**resolve_invokevirtual** (`linkResolver.cpp:300-600`):
- Step 1: `resolve_pool(bytecode, index, pool, CHECK)`→取 CONSTANT_Methodref→class_index+name_and_type_index
- Step 2: `resolve_klass(pool, class_index, CHECK)`→`SystemDictionary::resolve_or_fail`→已加载→return Klass*; 未加载→load class
- Step 3: `resolve_method(klass, name, signature, CHECK)`→`klass->lookup_method(name, signature)`→vtable scan (virtual) or itable scan (interface)→Method*
- Step 4: `check_accessibility(klass, method, CHECK)`→public/private/protected check→`Reflection::verify_class_access`
- Step 5: `ConstantPoolCacheEntry::set_method(bytecode, method, vtable_index, THREAD)`→set _f1 (Klass*), _f2 (vtable/field index), _flags (resolved+bytecode type)
- [C++: access check for protected——`Reflection::verify_class_access(caller, callee, resolved)`——三个 class: caller class/callee class/resolved class (声明方法的类)。只有 caller 是 resolved 的子类 → 允许。不是简单 public/private——是三向检查]
- [JVM Spec: §5.4.3 Resolution — method/field 解析规则——先尝试 class→lookup method→如果找不到→try superclass→找不到→NoSuchMethodError]

**resolve_invokeinterface** (`linkResolver.cpp:750-950`):
- 与 invokevirtual 相同——但 itable 扫描——`klass->itable_method_at(resolved_klass, itable_index)`——不是 vtable offset——因为接口方法没有固定 index

**field resolution** (`linkResolver.cpp:100-280`):
- getstatic/putstatic/getfield/putfield → `resolve_field`→field offset→`cpCache.set_field(bytecode, klass, field_index, field_offset, field_type, ...)`→_f2=field offset
- [C++: field offset——InstanceKlass 中 field 的相对偏移——instance field: oop+offset→field; static field: mirror klass+offset→static field]

### 2. Rewriter — 字节码重写

**Rewriter::rewrite** (`rewriter.cpp:50-400`):
- 类加载时一次性扫描所有方法 bytecodes——`rewrite_method(methodHandle, CHECK)`——把 cp index→cpCache index
- `_getstatic → fast_agetfield`, `_putstatic → fast_aputfield`——7 种 field access 的 quick forms——把 cp index 替换为 cpCache index
- `newarray → fast_newarray`——直接把 type code 放到 operand 里——省去 constant pool lookup
- [C++: `Rewrite::rewrite_invokedynamic(method, CHECK)`——lambda bootstrapping。`invokedynamic #0`→`invokedynamic cpCacheIndex`——cpCacheIndex 指向已解析的 CallSite。每个 invokedynamic call site 有独立的 cpCache entry]
- [C++: 为什么在类加载时重写？— 解释器每次 invoke 都要用 cpCache index。如果在解释器里每次都做 cp→cpCache 转换——每条 invoke 多 1 次 lookup——慢 5%。一次性重写——类加载时一次性——省掉所有后续 lookup]
- wide 重写: 宽版本的 load/store→format 标记为 "J"(2B index)→`rewrite_wide(方法, CHECK)`

---

### 核心悬念

**"invokevirtual #5——首次: LinkResolver resolve (100µs)→后续: cpCache._f2→vtable[offset](5ns)。"** — cpCache entry 在首次解析时 set——后续全部 hit。Rewriter 把 #5→cpCacheIndex 提前到类加载时——解释器每次直接读 cpCache。域 8 完成。Group 3 结束。

> → domain 9: [Memory 核心 — 虚拟内存之上的堆: universe/arena/resourceArea](../09-memory-core/01-universe-heap.md)
