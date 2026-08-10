# SharedRuntime 第一遍产出：解释器↔编译器桥接

> vol-04 · 域 27 · 🟡 B | Pass 1 扫描完成
> 源码：`runtime/sharedRuntime.*` (3216+729+664=4609行)

## 继承树/调用图

```
┌─────────────────────────────────────────────────────────────┐
│                   SharedRuntime (AllStatic)                   │
│              (sharedRuntime.hpp:47, 3216行.cpp)               │
│                                                              │
│  ┌─── RuntimeStubs ───────────────────────────────────┐     │
│  │ _wrong_method_blob         → 编译代码内联缓存miss      │     │
│  │ _wrong_method_abstract_blob→ 抽象方法调用桩            │     │
│  │ _ic_miss_blob              → inline cache miss桩      │     │
│  │ _resolve_opt_virtual_call  → 优化虚调用resolve桩      │     │
│  │ _resolve_virtual_call_blob → 虚调用resolve桩          │     │
│  │ _resolve_static_call_blob  → 静态调用resolve桩        │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─── Safepoint Blobs ─────────────────────────────────┐     │
│  │ _polling_page_return_handler_blob       返回轮询桩   │     │
│  │ _polling_page_safepoint_handler_blob    安全点轮询桩   │     │
│  │ _polling_page_vectors_safepoint_handler 向量安全点桩   │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─── Deopt/Uncommon ─────────────────────────────────┐     │
│  │ _deopt_blob              → Deoptimization handler  │     │
│  │ _uncommon_trap_blob (C2)→ uncommon trap handler    │     │
│  └──────────────────────────────────────────────────────┘     │
│                                                              │
│  resolve_helper()            → 调用点解析（虚/静态/优化）      │
│  handle_ic_miss_helper()     → IC miss → 去虚化               │
│  exception_handler_for_      → 跨解释器/编译器边界异常处理      │
│    return_address()                                           │
│  implicit exception throwers → NullPointer/Arithmetic/Stack   │
│  monitor_enter_helper/exit   → monitor 快速通道                │
│  java_calling_convention()   → JVM→Java 参数传递约定           │
│  c_calling_convention()      → JVM→Native 参数传递约定         │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 使用
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              AdapterHandlerLibrary (AllStatic)                │
│            (sharedRuntime.hpp:704-727)                        │
│                                                              │
│  _adapters → AdapterHandlerTable (哈希表)                     │
│  _buffer   → BufferBlob (临时CodeBuffer，生成adapter用)       │
│                                                              │
│  get_adapter(method) → 查表 → 未命中 → 生成adapter → 插入表    │
│  create_native_wrapper() → 为native方法生成wrapper nmethod     │
│  new_entry() → 创建 AdapterHandlerEntry 插入哈希表             │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 持有
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              AdapterHandlerEntry                             │
│      (sharedRuntime.hpp:635, BasicHashtableEntry子类)         │
│                                                              │
│  _fingerprint        → AdapterFingerPrint* (基于签名哈希)     │
│  _i2c_entry          → 解释器→编译代码 (interpreter→compiled) │
│  _c2i_entry          → 编译代码→解释器 (compiled→interpreter) │
│  _c2i_unverified_entry→ 未验证调用(用于IC miss)              │
│                                                              │
│  CDSAdapterHandlerEntry ← CDS共享适配器(带trampoline地址)      │
│                                                              │
│  AdapterFingerPrint:                                         │
│    基于方法签名的指纹(参数类型+返回类型+参数数量)              │
│    用于在哈希表中查找/比较已生成的adapter                      │
└─────────────────────────────────────────────────────────────┘
```

## 基本元素分解

1. **SharedRuntime** — AllStatic 全局工具类。持有所有 RuntimeStub/Safepoint/Deopt blob；提供调用点解析（`resolve_helper`/`handle_ic_miss_helper`）、隐式异常抛出、跨边界异常处理、monitor fast-path。`sharedRuntime.hpp:47`，3216 行 .cpp
2. **AdapterHandlerLibrary** — Adapter 工厂+缓存。`AllStatic`。通过 `get_adapter(method)` 返回 AdapterHandlerEntry——先查哈希表（用 AdapterFingerPrint），未命中就用 BufferBlob 生成 adapter 代码并插入表。`sharedRuntime.hpp:704`
3. **AdapterHandlerEntry** — 单一方法签名的 adapter。持有 3 个入口地址：`_i2c_entry`（解释器→编译）、`_c2i_entry`（编译→解释器，已验证）、`_c2i_unverified_entry`（编译→解释器，未验证→IC miss 场景）。`sharedRuntime.hpp:635`
4. **AdapterFingerPrint** — 基于方法签名的指纹。参数类型列表 + 返回类型编码为哈希值。用于在 AdapterHandlerTable 中查找已生成的 adapter，避免相同签名重复生成。`sharedRuntime.hpp:38`
5. **RuntimeStub blobs** — 6 个 resolve stubs：`_wrong_method_blob`（方法不匹配）、`_wrong_method_abstract_blob`（抽象方法）、`_ic_miss_blob`（IC miss）、3 个 resolve stubs（静态/虚拟/优化虚拟）。编译代码中 call 指令直接 call 这些 stub 地址，stub 内部调 C++ 函数完成解析。`sharedRuntime.hpp:57-63`
6. **Implicit Exception** — 5 种隐式异常：NULL/DIVIDE_BY_ZERO/STACK_OVERFLOW。编译代码不显式检查除法零——硬件产生信号→signal handler→SharedRuntime::continuation_for_implicit_exception()。`sharedRuntime.hpp:188-203`
7. **调用约定** — `java_calling_convention()` 计算 Java 参数在寄存器/栈槽中的位置（用于 i2c adapter），`c_calling_convention()` 计算 Native 参数位置（用于 native wrapper）。`sharedRuntime.hpp:378`
8. **monitor helper** — `monitor_enter_helper()`/`monitor_exit_helper()` 暴露编译代码直接调用的锁快速通道（使用 `BasicLock`+`ObjectSynchronizer`）。`sharedRuntime.hpp:340-344`

## 标记问题（≥5）

1. **[设计决策] i2c/c2i adapter 为什么每个方法签名都需要独立生成？** — 解释器用 Java 栈帧（局部变量表+操作数栈），编译器用寄存器+Native 栈。不同签名的参数在寄存器/栈槽中的位置不同——adapter 是签名的"映射函数"。但为什么不用统一的"unbox+rebox"栈帧方案？`AdapterHandlerLibrary::get_adapter0()`

2. **[设计决策] AdapterFingerPrint 缓存的命中率** — 相同签名的不同方法可以复用同一个 adapter——这是用 AdapterFingerPrint 做哈希 key 的核心原因。但 2^31 或 2^63 的指纹空间可能碰撞。碰撞的处理策略是什么？`AdapterFingerPrint`

3. **[数据结构] 为什么 AdapterHandlerEntry 有 3 个 entry（而非 2 个或 1 个）？** — `_c2i_unverified_entry` 和 `_c2i_entry` 的区别在于后者跳过 receiver 类型检查。为什么分开？这和 IC miss→resolve→patch→verified 的流程有关。`AdapterHandlerEntry` in sharedRuntime.hpp:640-642

4. **[并发策略] RM resolve stubs 的线程安全** — RuntimeStub 中的 call resolve stubs 可以被多个线程同时调用（多个线程同时遇到 IC miss）。resolve 过程涉及方法解析（可能加载类、初始化），期间其他线程看到什么？

5. **[跨域] sharedRuntimeTrans.cpp 和 SharedRuntime 的职责划分** — `sharedRuntimeTrans.cpp`（664行）专门处理各种类型转换（float↔int、double→float等）——这些是纯算术操作，为什么放在 SharedRuntime 域而不是平台无关的数学库？

6. **[设计决策] 隐式异常 vs 显式检查** — 编译代码不检查 null/除零/栈溢出，依赖硬件异常+SIGSEGV/SIGFPE→signal handler→SharedRuntime。这比显式 if 快但不是所有平台都支持——如何做平台兼容？

7. **[设计决策] monitor_enter_helper 的 fast locking** — `use_inlined_fast_locking` 参数决定是否走 inlined locking path。inlined locking 和 ObjectMonitor 的膨胀路径如何交互？在什么情况下会 fallback 到 slow path？

8. **[跨域] SharedRuntime 与 InterpreterRuntime 的边界** — 解释器调用 SharedRuntime 的 resolve_helper 处理首次调用点的链接——这和 linkResolver（在 ClassFile 域中）的关系是什么？

9. **[跨域] deopt_blob 和 uncommon_trap_blob 的归属** — DeoptimizationBlob 由 SharedRuntime::generate_deopt_blob() 生成，但语义上属于 Deoptimization 域。为什么放在这里？是设计分层还是历史遗留？
