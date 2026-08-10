# ci (Compiler Interface) — Pass 0+1 探索笔记

> vol-04 · 域 25 · 🟡 B | 2026-08-07

## Pass 0: 设计上下文

**关键 git 提交**：
- `8dfd3d4c1f` JDK-8216987: `ciMethodData::load_data()` 非原子 copy unpack MDO——并发安全 bug
- `47516b1603` JDK-8216427: `load_extra_data()` 不总是 unpack 最后一条——数据丢失
- `9437d45b4b` JDK-8252049: `ciMethodData` 构造函数 native 内存泄漏
- `fb76f0e7be` JDK-8283441: `ciMethodBlocks::make_block_at()` SIGSEGV——空指针

**演进趋势**：ci 层的 bug 集中在 `ciMethodData`（profiling 数据的 copy 一致性）和生命周期（内存泄漏）。ci 的设计意图是 immutable snapshot——但 profiling data 在编译过程中可能被并发更新，copy 一致性是关键挑战。

## Pass 1: 结构扫描

### 核心类
```
ci/ (74 文件)
  ciEnv.hpp              — 编译环境的入口（StackObj，每次编译一个实例）
  ciObjectFactory.hpp    — ci 对象工厂，缓存 invariant: 一个 oop → 一个 ciObject
  ciObject.hpp           — 所有 ci 对象的基类
  ciKlass.hpp            — Klass 的 ci 表示
  ciInstanceKlass.hpp    — InstanceKlass 的 ci 表示
  ciMethod.hpp/cpp       — Method 的 ci 表示（3048 行 ciTypeFlow）
  ciField.hpp            — 字段的 ci 表示
  ciMethodData.hpp       — MethodData 的 ci 表示（profiling 数据的 copy）
  ciTypeFlow.hpp/cpp     — 字节码类型流分析（C2 用，3048 行）
  ciStreams.hpp          — 字节码流的 ci 表示
  ciCallProfile.hpp      — 调用点 profiling 的 ci 表示
```

### 架构图
```
C1/C2 编译器
    │
    ▼
ciEnv (每次编译一个实例，StackObj 栈上生存)
    │
    ├── ciObjectFactory (缓存：一个 VM 对象 → 一个 ci 对象)
    │     ├── get_metadata(klass) → ciKlass*
    │     ├── get_metadata(method) → ciMethod*
    │     └── get_metadata(mdo) → ciMethodData*
    │
    ├── ciMethod → ciStreams (字节码迭代器)
    │            → ciMethodData (profiling 数据 copy)
    │
    ├── ciTypeFlow (C2 用的字节码类型分析)
    │
    └── Dependencies (编译假设记录——后续去优化用)
```

### 基本元素分解

1. **ciEnv**：`ciEnv`（`ciEnv.hpp:44`，StackObj）是编译环境的入口。每次 JIT 编译创建一个 `ciEnv` 实例——持有 `ciObjectFactory`、`Dependencies`、编译选项。C1 的 `Compilation` 和 C2 的 `Compile` 都持有 `ciEnv*`。

2. **ciObjectFactory**：`ciObjectFactory`（`ciObjectFactory.hpp:38`）缓存 invariant：**一个 VM oop 至多对应一个 ciObject**。编译器通过 `get_object()` / `get_metadata()` 获取 ci 对象——重复请求同一个 VM 对象返回相同的 ci 指针。

3. **ciObject 层级**：`ciObject` → `ciMetadata` → `ciKlass`/`ciMethod`/`ciField`。每个 ci 对象是 VM 对象的"不可变快照"——编译器不能通过 ci 修改 VM 状态。

4. **ciMethodData**：`ciMethodData`（`ciMethodData.hpp`）是 `MethodData` 的 copy——编译器读取 profiling 信息（分支频率、类型分布、调用计数）来决定优化策略。**copy 不是原子的**（JDK-8216987）——并发 profiling 更新可能在 copy 过程中发生，导致 ciMethodData 中的数据不一致。

5. **ciTypeFlow**：`ciTypeFlow`（3048 行 `.cpp`）做字节码类型流分析——在 CI 的 immutable snapshot 上推演每个字节码执行后的操作数栈和局部变量类型。C2 用类型流的结果做内联决策和类型推导。

6. **Dependencies**：`Dependencies` 记录编译器在优化时做的假设（"这个虚调用只有一个 receiver 类型"、"这个类没有子类"）。后续如果假设被破坏（类加载了新的子类），触发去优化——把编译帧退回解释器。

7. **ciStreams**：`ciStreams` 提供字节码流的 ci 层访问——比直接读 `Method::code_base()` 更安全，因为它是 immutable 副本。

### 标记问题（≥5）

1. **ciObjectFactory 的 immutable 不变量是怎么保证的？** 一个 oop 对应一个 ciObject——但 GC 可能移动 oop 导致 oop 地址变化。ciObject 怎么跟踪被移动的 oop？用 `Handle` 还是 `JNIHandles`？

2. **ciMethodData 的非原子 copy 会导致什么问题？** JDK-8216987——如果 profiling 过程中计数被并发更新，ciMethodData 中复制的值可能是不一致的——这会影响 C2 的优化决策吗？会导致错误的去优化吗？

3. **ciEnv 是 StackObj——为什么不是 CHeapObj？** 每次编译一个 ciEnv 实例，栈上生存——编译完成后自动析构。这意味着 ciEnv 中持有的 ci 对象也在编译完成后自动释放？

4. **Dependencies 怎么检测"假设被破坏"？** 编译器假设"这个类没有子类"→ 类加载了一个新子类→ Dependencies 怎么收到通知？通过 `SystemDictionary` 还是 `InstanceKlass` 的回调？

5. **ciTypeFlow 和 C2 的 type.cpp 是什么关系？** ciTypeFlow 在 ci 层做类型推导，C2 的 `Type::meet()` 在优化层做类型合并。两者的结果一致吗——如果 ciTypeFlow 推导出类型 A，C2 的 Type 系统会得出同样的结论吗？

6. **ciKlass 和 Klass 的生命周期不同——ciKlass 是栈上的快照，Klass 是 Metaspace 中的永久对象。类卸载后 ciKlass 怎么处理？** 编译正在使用的 ciKlass 对应的 VM Klass 被类卸载了——编译中断还是继续？

7. **ciStreams 提供的字节码流和直接读 Method 的字节码有什么区别？** ciStreams 有 `get_klass_by_index()` 解析常量池引用——在 ci 的安全上下文中解析，不需要持有 VM 锁。
