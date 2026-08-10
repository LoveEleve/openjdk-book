# 03. ciObjectFactory + ciReplay — ciObject 生命周期与编译回放

> 🟡 Working | 11 KP 中的 3 个辅助机制
> 读者处境: ciObject 在编译中创建——编译后怎么释放？同一个 Klass 被多次编译——ciObject 复用了吗？调试 JIT bug 时——怎么重现编译？

### 1. ciObjectFactory — ciObject 的创建者与缓存

场景: C2 编译 `ArrayList.add()`——需要 ciKlass(ArrayList)、ciKlass(Object[])、ciMethod(add)、ciField(elementData)——四个 ciObject——全部通过 ciObjectFactory 获取。

**ciObjectFactory** (`ciObjectFactory.hpp.cpp`):
- `get_metadata(Metadata* m)`: 输入 Klass* 或 Method*——返回对应的 ciObject——`_unloaded_methods/_loaded_methods/_klasses` GrowableArray lookup——如果存在→return existing→如果不存在→`create_ciObject(m)`→insert
- [C++: ciObjectFactory 的生命周期——在 `ciEnv::ciEnv(CompileTask*)` 构造——分配在 CHeapObj (C++ heap)——编译完成→`ciEnv::~ciEnv()`→`ciObjectFactory::~ciObjectFactory()`→遍历所有 ciObject→deallocate→释放全部]
- GC 安全: ciObject 持有 `Metadata*` (Klass*/Method*)——编译在 safepoint 中——Klass/Method 不会被 GC——safe。编译后 ciObject 释放——不再持有 Metadata*——没有 dangling pointer
- [C++: ciObject 分两类——loaded (Klass/Method 已加载, 有 Metadata*) vs unloaded (类未加载, 只有符号引用)。ciObjectFactory 用 `_unloaded_klasses` 和 `_loaded_klasses` 两个表分别管理。Symbol*→ciSymbol, oop→ciInstance]

**oop→ciObject 映射** (`ciObjectFactory.cpp`):
- `get(oop obj)`: oop→ciInstance 映射——`_oop_ci_objects` hashtable——key=oop (narrow oop)→value=ciObject*。编译中 Java 对象 (String constant, Class mirror) 的 ci 表示
- [C++: oop→ciInstance 映射——GC safe——编译后 `_oop_ci_objects` 被清除——ciObject 持有的 oop reference 被释放。ciObject 不存活于 safepoint 之间——编译结束时全部 remove]

### 2. ciReplay — JIT 编译的确定性回放

场景: JIT bug——某个方法在特定 profiling data 下 C2 生成错误代码——但下次编译 profiling data 变了——bug 消失了。ciReplay 录制编译时的完整 CI 输入 (ciKlass/ciMethod/profiling counter/type profile)——下次用 `-XX:+ReplayCompiles` 回放——重现 bug。

**ciReplay** (`ciReplay.hpp.cpp`):
- 录制: C2 compile task→`ciEnv::dump_replay_data(output)`→输出方法+所有 ciObject→replay file
- 回放: `ciEnv::initialize_from_replay()`→读 replay file→`ciObjectFactory::create_from_replay_data()`→重建全部 ciObject——不给 JVM 实际加载的类——用录制的——保证确定性
- [C++: ciReplay 的确定性——Profiling data (invocation/backedge counter) 从 replay 录制的值——不从 JVM runtime 读。Type profile (receiver type/class) 从录制的——不使用实际接收类型。保证每次 replay 都是同样的 C2 输入→同样的 C2 输出→bug 重现]

### 3. ciMethodData — profiling data 的编译器视图

**ciMethodData** (`ciMethodData.hpp.cpp`):
- `invocation_counter()`: ciEnv 中最不被 JIT 考虑——C2 达到编译阈值后进入 compile queue——ciMethodData 记录这时的 counter
- `backedge_counter()`: 循环后沿 counter——决定 OSR 编译
- [C++: ciMethodData 是 MethodData (MDO) 的 ci 层——在 ciMethod 构造时创建——一次性从 MDO 复制 profiling data。编译中 C2 读 ciMethodData——不读原始 MDO——防止 safepoint 中 MDO 被 GC 修改]

---

### 核心悬念

**"C2 编译完成→ciEnv::~ciEnv()→ciObjectFactory 释放全部 ciObject——同一个 Klass 下次编译时重新 create ciKlass——零长期内存。"** — ciReplay 录制完整的 CI 输入——让 JIT bug 在确定性条件下重现。ciObject 镜像体系在 C2 编译层次中只存一个编译周期——safepoint 间创建→编译完释放——简洁生命周期。域 12 完成——Group 5 执行引擎开始。

> → domain 13: [JIT Framework — CompileBroker 怎么管理编译队列: compile task/compile queue/compiler threads](../13-jit-framework/01-compile-broker.md)
