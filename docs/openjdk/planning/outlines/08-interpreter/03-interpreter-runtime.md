# 03. InterpreterRuntime — 解释器调 C++

> 🟡 Working | 13 KP 中的 3 个 runtime 机制
> 读者处境: `new`——TemplateInterpreter 不自己做——它调 C++ `InterpreterRuntime::_new()`——分配+初始化。

### 1. InterpreterRuntime — C++ runtime 入口

场景: 解释器执行 `new`→template 生成 `call InterpreterRuntime::_new(thread, constantPool, index)`→C++ 分配对象→GC OopMap 记录新对象在栈上的位置。

**runtime entry 宏** (`interpreterRuntime.hpp:50-200` + `interpreterRuntime.cpp`):
- `JRT_ENTRY(result_type, name)`: 宏——save caller frame→enter VM→`ThreadInVMfromJava` transition→C++ code→leave VM→restore frame→return
- `ldc(bool wide)`: 从 cpCache 加载常量——int/float/String/Class—→push to interpreter stack
- `_new(JavaThread*, ConstantPool*, index)`: `InstanceKlass::allocate_instance(THREAD)`→init→return oop
- [C++: `JRT_ENTRY` + `JRT_END`——enter VM=卡 safepoint→ThreadState: _thread_in_Java→_thread_in_vm。safepoint 检查: 只有在 _thread_in_vm 时才能 block。解释器在 Java 模式下——不能 block——必须先转 VM 模式]
- [C++: `JavaCalls::call(result, method, args, THREAD)`——C++ 调 Java 方法。RESOLVE_INVOKE——先调 LinkResolver 解析→再用 JavaCall 调 callee。不是直接跳——需要 JavaCalls 设置 Java 帧]
- `monitorenter(JavaThread*, BasicObjectLock*)`: `ObjectSynchronizer::fast_enter()`→biased lock→stack lock→inflated lock

**OopMapCache** (`oopMapCache.hpp.cpp` + `oopMapCache.cpp`):
- `InterpreterOopMap`——每个方法的 OOP 位置 bitmask——哪个局部变量/栈元素是 OOP
- [C++: OopMapCache——LRU cache + hash(method)→OopMap。`method()->oop_maps()`——如果未生成→compute——遍历 bytecodes→每个字节码的 stack effect→推断所有执行点的 OOP 位置→store in cache。capacity = `OopMapCacheSize` (默认 ~1024 entry per thread)。GC 时——每种方法用其 OopMap 扫描解释器帧]

### 2. InvocationCounter — OSR 触发

**InvocationCounter** (`invocationCounter.hpp.cpp`):
- `_counter` (int): 从 `CompileThreshold` 递减——每次 invoke→`InterpreterRuntime::frequency_counter_overflow()`→check 0→JIT compile
- `backedge_counter`: loop backedge——每个 backedge→counter--→0→OSR compile——在循环中间切换到 JIT
- [C++: TieredCompilation——`TieredThresholdPolicy::event(method, bci, level)`——根据当前 counter 决定下一编译层级 (C1/C2)。C1 profile→C2 compile——counter 值不同——让热点方法先 C1、再 C2 (profiling data accumulated)]
- `CompileThreshold`: 默认 C1=5000, C2=15000 (with TieredCompilation)

---

### 核心悬念

**"解释器不自己做 new——call C++ runtime→JRT_ENTRY→set thread state→allocate→return。"** — JRT_ENTRY/JRT_END 管理 safepoint 安全。OopMapCache——LRU 缓存一个方法的 OOP 位置——避免每次 GC 重新计算。下一个: LinkResolver——符号→直接引用。

> → [04-linkresolver-rewriter.md](04-linkresolver-rewriter.md)
