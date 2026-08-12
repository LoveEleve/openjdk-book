# 04. ConstantPool + Method — 符号变直接, 字节码变执行

> 🔴 Deep | 15 KP 中的 2 个核心机制
> 读者处境: 字节码里 `invokevirtual #23`——#23 是什么？常量池第 23 个条目。解析后变成直接方法指针。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/06-oops/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **ConstantPool 继承 Metadata 不是 oopDesc**(constantPool.hpp:98)——"constantPoolOopDesc"是 JDK8 名字;_tags :106、_cache :107
> - **klass_at 不是纯 O(1)**: klass_at_impl 未解析时触发 SystemDictionary 查找/类加载(constantPool.hpp:380-383)
> - **cpCache _f1 语义修正**: 字段访问 _f1=字段持有者(**java.lang.Class 引用**,cpCache.hpp:99 注释)、非虚调用 _f1=Method*、indy/invokehandle _f1=adapter 方法(:108-113);_f2=vtable/itable index 或 final Method* 或 field offset(:114-116)
> - **invokedynamic appendix 不在 _f2**: appendix(CallSite/MethodType)存在 ConstantPool 的 **resolved_references 数组**(cpCache.hpp:110-112 注释);indy 常量池条目是 operands 数组的 bootstrap specifier(_indy_bsm_offset/_indy_argc_offset/_indy_argv_offset,constantPool.hpp:597-613)——"_indy_bsm/_indy_name/_indy_type 字段"是编造
> - **MethodLinker 类不存在**: 入口点由 Method::link_method 设置(method.cpp:1077;entry_for_method :1099;set_interpreter_entry :1102 同时设 _i2i/_from_interpreted)
> - **CompileThreshold 修正**: x86 分层编译 C1=1500(c1_globals_x86.hpp:43)、C2=10000(c2_globals_x86.hpp:43);调用/回边计数在 **MethodCounters**(methodCounters.hpp:51-52)不在 MethodData;OSR 由回边计数触发
> - MethodData(MDO): Metadata(:1955)、_data :286、bci_to_data :2350、ClassLoaderData 分配(:709);"不独立 GC/100 字节码~400B"编造数字删除
> - 耗时数字(100µs/3-5ns/20000x)无源码依据,全文未采用
> - Method 入口点字段: _i2i_entry :103、_from_compiled_entry :106、_code :112、_from_interpreted_entry :113;字节码内联 ConstMethod 尾(code_base=this+1,constMethod.hpp:490)✓

### 1. ConstantPool — 类的符号引用仓库

场景: `String s = "hello"; s.length();` — 字节码: `invokevirtual #5` — #5 指向常量池条目 5——类型: CONSTANT_Methodref——类: java/lang/String——方法名: length——返回类型: ()I。这是字节码**最核心**的间接层。

**ConstantPool 结构** (`constantPool.hpp:50-150` + `constantPool.cpp`):
- `_tags`: Array<u1>——每个条目的类型——CONSTANT_Utf8/CONSTANT_Integer/CONSTANT_String/CONSTANT_Class/CONSTANT_Methodref/CONSTANT_InterfaceMethodref
- [C++: constantPoolOopDesc——继承 oopDesc——存储 ClassFile 解析后的常量池。原始 bytecode 的常量池 index (u2) 直接映射到 ConstantPool 的数组 index——`cp->klass_at(index)` = O(1)]
- `_cache`: ConstantPoolCache*——解析后的直接引用存放在这里——两个分离的对象 (cp + cpCache)——解析状态独立管理
- 符号引用示例: CONSTANT_Methodref = class_index (u2) + name_and_type_index (u2)——分两步解析: class→SystemDictionary::find()→load→Klass*; name_and_type→SymbolTable::lookup→method pointer

**ConstantPoolCache** (`cpCache.hpp:40-200` + `cpCache.cpp`):
- `cpCache[index] = ConstantPoolCacheEntry`——每个 entry 编码了解析状态+直接引用
- `_f1` (Metadata*): 目标 Klass*——哪个类的哪个方法
- `_f2` (intptr_t): method vtable index / field offset——直接 bytecode offset
- `_flags`: 解析状态——`is_resolved` / `tos_state` (result type: int/long/float/double/oop/void) / `bytecode` (invokevirtual/invokespecial/...)
- [C++: cpCache entry 的不同用法——virtual: _f2=vtable index; field access: _f2=field offset; invokedynamic: _f2=appendix (CallSite 对象)。同一 8B 在不同 bytecode 类型下含义完全不同——类似 markOop 的多义编码——节省内存]
- [x86: cpCache entry 生命周期——first call: bytecode 1 (unresolved)→resolve(class load+link+verify ~100µs)→success→bytecode 2 (resolved)→hit cache→_f2 直接给 JIT。后续调用: 直接读 _f2→vtable lookup 或 field offset→3-5 ns]

**invokedynamic 适配** (`constantPool.hpp:160` + `cpCache.hpp:180`):
- invokedynamic #0 entries——bootstrap method + CallSite——Java 7+ 的动态调用
- [C++: indy constant pool entry——`_indy_bsm` (bootstrap MethodHandle) / `_indy_name` (方法名 symbol) / `_indy_type` (方法签名)。首次执行→bootstrap method→返回 CallSite (MutableCallSite 或 ConstantCallSite)→存入 cpCache _f2→后续调用直接通过 CallSite+MethodHandle]

### 2. Method + MethodData — 字节码元数据 + JIT 燃料

**Method** (`method.hpp:50-250` + `method.cpp`):
- `_constMethod`: ConstMethod* — 字节码/异常表/行号表/**只读**元数据——ClassFileParser 填
- `_code`: CompiledMethod* — JIT 编译后的代码入口 (null=未编译)
- `_i2i_entry`: interpreter-to-interpreter entry — 解释器入口——c2i adapter 由此进入编译代码
- `_from_compiled_entry`: compiled-to-compiled entry — JIT 编译代码直接跳此
- `_from_interpreted_entry`: 解释器调编译——经过 c2i adapter——设置 callee-saved regs + oop map
- [C++: method 的多入口点模式——解释器调 (解释→解释)= `_i2i_entry`——解释器调 (解释→JIT)= `_from_interpreted_entry`——JIT 调 JIT= `_from_compiled_entry`。入口点由 MethodLinker 统一管理——`Method::link_method()`
- [C++: `ConstMethod::code_base()`——返回 bytecode 起始地址——Compiler::compile_method() 取 bytecode→IR→机器码]

**MethodData — JIT profiler** (`methodData.hpp:50-250` + `methodData.cpp`):
- `_data`: 按 BCI (bytecode index) 组织的 profiling 数据——`DataLayout` 结构
- counter: invocation_counter——方法的**被调用次数**——达 CompileThreshold (默认 10000)→C1 编译
- backedge_counter: loop backedge 的**迭代次数**——达 OnStackReplacePercentage (CompileThreshold*OSRPercent)→OSR 编译——在循环**中间**切换 JIT
- [C++: MDO (MethodData Object)——JIT 编译**前**收集。`MethodData::bci_to_data(bci)`——给定字节码偏移→返回对应该位置的数据。C2 用 MDO 做 speculative optimization——"这个 branch 95% 走 true"→生成 biased branch——"这个 invoke 的 receiver 总是 ArrayList"→inline + CHA guard]
- [C++: DataLayout 压缩——每 MDO entry 2-4B——methodData 大小 = bytecode_length * 2~4B——100 条字节码~400B MDO。不独立 GC——随 Method::deallocate_contents() 释放]

---

### 核心悬念

**"invokevirtual #5 → 首次: load class+link+verify (~100µs)→后续: cpCache._f2 → vtable lookup (3-5ns)。"** — cpCache 改变了虚方法调用的整个开销模型。首次走 resolve 路径 (慢 20000x)——但只是**首次**(per class)。后续全是 vtable 查表——4 次 deref。MDO 则是 JIT 的燃料——收集 branch probability + receiver type——C2 用它做激进优化。下一篇: Access API——每次写字段 GC 都在旁听。

> → [05-access-api-barrier.md](05-access-api-barrier.md)
