# 09 - 原生接口（Native Interface）

> 源码索引：`source_index/09-prims.md`（79文件）
> 插桩覆盖：`-Xlog:probe_jni=debug` + `probe_runtime=debug`
> **前置阶段**：[08-safepoint], [07-thread-lock]
> **阅读收益**：理解 JNI 线程如何穿越 Java ↔ Native 边界并和 safepoint 互动、JNI 引用为何是 GC Root、`VM_RedefineClasses` 如何复用刚学的 VM_Operation 框架、反射慢在哪里、invokedynamic 的适配器生成链

---

## 一、阶段定位 — 这不是 JNI API 教程

本阶段的独特价值不在于解释 JNI 规范（`GetStringUTFChars` 做什么），而在于：

1. **连接 08 阶段的成果**：JNI 线程的状态转换是 safepoint 协议的直接参与者。`_thread_in_native` 的线程在 `begin()` SPIN 中被 `roll_forward(_at_safepoint)` 放行——[01]和[02]只是提到了这一点，本阶段把它展开成一篇完整的分析。

2. **用 08 学到的框架解释新东西**：`VM_RedefineClasses` 继承 `VM_Operation`，走 `_safepoint` 模式，入 `VMOperationQueue`，由 `VMThread::loop()` 调度。读者刚学完这套机制，直接拿来分析类重定义——这是"学以致用"的最佳案例。

3. **回答实际开发中的问题**：JNI 引用什么时候被 GC 回收？反射为什么慢？`Unsafe.park()` 底层是什么？

### ★ 和 08 阶段的本质区别：跨模块

08 阶段的核心文件集中在 `runtime/`（safepoint.cpp, vmThread.cpp）和 `gc/shared/`（gcLocker.cpp, vmGCOperations.cpp），基本在 2 个模块内闭环。

**本阶段天然跨 5 个外部模块 + oops/os 两个支撑模块**：

```
prims/          (jni.cpp, jvm.cpp, unsafe.cpp, reflection.cpp, methodHandles.cpp...)
  ├── 调用 ──→ runtime/       (interfaceSupport, safepoint.cpp, sharedRuntime.cpp)
  ├── 调用 ──→ gc/shared/     (oopStorage.hpp ← JNI 引用的底层存储)
  ├── 调用 ──→ os_cpu/        (atomic_linux_x86.hpp, orderAccess_linux_x86.hpp ← Unsafe CAS)
  └── 调用 ──→ interpreter/   (linkResolver.cpp ← invokedynamic 解析)
```

这意味着：
- 每篇文档的源文件清单需要标注**模块归属**
- GDB 验证需要跨模块断点（`br reflection.cpp:invoke_method` 后看 runtime 侧的线程状态）
- 读者心理预期：不是在学"prims 目录"，而是在学**JNI/JVM 的交互面**

---

## 二、文档计划（7篇，带依赖链）

```
                        ┌── 前置依赖 ──┐
                        │  08-safepoint │
                        │  07-thread    │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
     │ 01-ThreadState │ │ 02-JNI-Ref   │ │ 04-JVM-Entry │
     │  NativeTrans   │ │  Management  │ │   Points     │
     └───────┬────────┘ └──────────────┘ └──────┬───────┘
             │                                  │
    ┌────────┼────────┬────────────┐            │
    ▼        ▼        ▼            ▼            ▼
┌───────┐ ┌───────┐ ┌────────┐ ┌───────┐ ┌──────────────┐
│03-Red │ │05-Ref │ │06-MH   │ │07-Un  │
│ efine │ │ lection│ │ invoked│ │ safe  │
│Classes│ │Internal│ │ dynamic│ │       │
└───────┘ └───────┘ └────────┘ └───────┘
    ▲         ▲
    │         │
    └─ 08-[03]─┘  ← 直接用 08 的 VM_Operation 框架
```

### 写作顺序（按依赖链）

```
01 → 02 → 04 → 03/05/06/07 (并行)
```

- 01 必须先写：所有 JNI 交互都涉及线程状态，这是全阶段的基石
- 02 和 04 对 01 有弱依赖，可并行
- 03/05/06/07 在 01+02+04 完成后可并行

---

## 三、逐篇详述

### [01] ThreadState-NativeTransition — JNI 线程状态转换与 safepoint 交互

**核心问题**：JNI 线程从 `_thread_in_native` 返回 Java 时，怎么被 safepoint 拦住？拦住的精度是"返回前"还是"返回后"？`transition_from_native()` 内部的 `poll()` 和 `block_if_requested()` 分别做什么？

**为什么放在第一**：这是 09 阶段和 08 阶段的桥梁文档。08围绕 safepoint 的 begin/end 展开，但始终从 VMThread 视角看问题。本文换到 JavaThread 视角——一个线程从 Java 调用 JNI、在 native 中执行、返回 Java 的全过程中，它和 safepoint 协议互动的每一个点。

**覆盖内容**：

```
§〇 源文件清单
  - interfaceSupport.inline.hpp (transition_from_native, transition_and_fence)  ← [02]已覆盖
  - safepointMechanism.inline.hpp (poll, block_if_requested)
  - safepoint.cpp (block, handle_polling_page_exception)
  - jni.cpp (jni_invoke_static, jni_invoke_nonstatic — 入口和出口)
  - sharedRuntime.cpp (native method 调用桩)

§一 全景：一张图展示 Java→Native→Java 的三阶段状态变化
  ❓ 为什么 Java→Native 不需要 safepoint check，但 Native→Java 需要？
  → [01] 已经解释过：_thread_in_native 的线程被 roll_forward(_at_safepoint) 放行。
    但放行的代价是什么？线程从 native 返回时，在哪个点被"追上"？

§二 ★★★ transition_from_native() 逐行走读
  ❓ poll() 返回 true 之后、block() 之前，线程经历了什么？
  → 这是[02]没有展开的细节。poll 检测到 _synchronizing 后，
    线程调用 JavaThread::check_safepoint_and_suspend_for_native_trans() →
    block() 内部获取 Safepoint_lock → _waiting_to_block-- → Threads_lock 排队。
    不是简单的"检测到就阻塞"。

§三 ★★ transition_and_fence() 在 JNI 场景中的角色
  ❓ 和 transition_from_native 的区别是什么？
  → transition_and_fence 用于 VM 内部的状态转换（如进入/退出 ThreadBlockInVM），
    而 transition_from_native 是 JNI 返回路径的专用函数。
    两者的 poll 时机不同、fence 语义不同（[02] §四 已对比过）。

§四 ★ JNI 调用的全状态循环
  _thread_in_Java → _thread_in_native_trans → _thread_in_native
  → _thread_in_native_trans → _thread_blocked(if safepoing) → _thread_in_vm → _thread_in_Java
  ❓ 为什么中间有个 _thread_in_native_trans？
  → 这是"正在穿越边界的窗口"。如果 VMThread 在 SPIN 中看到这个状态，
    不是 roll_forward(_at_safepoint)（不安全——栈可能不稳定），
    而是保持 _running 等它完成转换。这就是三态设计的意义。

§五 ★ 和 GCLocker 的互动
  ❓ JNI critical (GetPrimitiveArrayCritical) 和 _thread_in_native 的关系？
  → [04] 讲过 jni_lock/jni_unlock 的计数器协议。
    JNI critical 期间的线程状态仍然是 _thread_in_native，
    但 jni_lock 在进入时加了 JNICritical_lock 保护。
    safepoint 中这些线程被 roll_forward(_at_safepoint) 放行，
    但它们被 GCLocker 的 _needs_gc 标记阻止了 GC。

§六 GDB 验证 + 可证伪断言
  - transition_from_native 的完整调用栈
  - poll() 命中 safepoint 时 _thread_state 的精确值
  - _thread_in_native_trans 窗口期内 VMThread 的 SPIN 行为
```

**关键文件**（跨 prims + runtime）：
| 文件 | 模块 | 核心函数 |
|------|------|---------|
| `interfaceSupport.inline.hpp` | runtime | `transition_from_native()`(:158), `transition_and_fence()`(:136) |
| `safepointMechanism.inline.hpp` | runtime | `poll()`(:50), `block_if_requested()`(:58) |
| `safepoint.cpp` | runtime | `block()`(:859) |
| `jni.cpp` | prims | `jni_invoke_static` / `jni_invoke_nonstatic` |
| `sharedRuntime.cpp` | runtime | `generate_native_wrapper()` ★ 只聚焦 native 方法桩生成 |

**前置**：[08-01], [08-02], [08-04], [07-thread]

---

### [02] JNI-Reference-Management — JNI 引用作为 GC Root

**核心问题**：JNI LocalRef 真的会在 native 方法返回时自动释放吗？GlobalRef 在什么时机被回收？`DeleteGlobalRef` 是立即释放还是标记为可回收？JNI 引用如何成为 GC Root？

**为什么重要**：这是"JNI 不泄漏"的唯一保证机制。理解错了 → native 内存泄漏 / 对象被意外 GC。面试高频题。

**覆盖内容**：

```
§〇 源文件清单
  - jniHandles.cpp / jniHandles.hpp (JNIHandleBlock, JNIHandles)
  - jni.cpp (NewGlobalRef, DeleteGlobalRef, NewLocalRef, DeleteLocalRef)
  - oopStorage.hpp (OopStorage — 底层存储)

§一 JNIHandleBlock 结构
  ❓ 为什么 LocalRef 用 block 链表而不是 vector？
  → 线程本地、无锁、栈式分配。每个 block 是 32 个 slot 的定长数组。
    用完一个再分配下一个，形成链表。释放时整条链一次性回收。

§二 ★★★ GlobalRef 与 GC 的交互
  ❓ GlobalRef 的 oop 存在哪？GC 怎么扫到它？
  → OopStorage 是底层存储容器。GC root scanning 阶段遍历 OopStorage
    中的 oop，标记为活的。只有 GlobalRef 指向的对象才被 GC root 保护，
    LocalRef 只在调用期间有效。

§三 Weak GlobalRef 的特殊处理
  ❓ NewWeakGlobalRef 和 NewGlobalRef 的 GC 行为差异？
  → Weak GlobalRef 的 oop 在 OopStorage 中被标记为 weak。
    GC 后如果只被 weak ref 指向 → 自动清除为 NULL。

§四 JNI 引用的生命周期自动机
  LocalRef: create → [native frame] → auto-release on return / PopLocalFrame
  GlobalRef: create → [live] → DeleteGlobalRef → [dead]
  WeakGlobalRef: create → [live] → GC → [cleared or still alive]

§五 GDB 验证
  - JNIHandleBlock 的 _top/_bottom/_next 验证
  - GlobalRef 的 OopStorage entry 定位
```

**关键文件**（跨 prims + runtime + gc）：
| 文件 | 模块 | 核心类/函数 |
|------|------|-----------|
| `jniHandles.hpp` | runtime | `JNIHandleBlock`, `JNIHandles` |
| `jniHandles.cpp` | runtime | `make_global()`, `destroy_global()` ★ 注意：在 runtime/ 不在 prims/ |
| `oopStorage.hpp` | gc/shared | `OopStorage` — GC root scanning 遍历此容器 |
| `jni.cpp` | prims | `NewGlobalRef`, `DeleteGlobalRef`, `PushLocalFrame` |

**前置**：[09-01], [06-GC roots scanning]（需要理解 GC 如何遍历 OopStorage 中的 root set）

---

### [03] VM-RedefineClasses — JVMTI 类重定义作为 VM_Operation 案例

**核心问题**：`VM_RedefineClasses` 继承 `VM_Operation`，走 `_safepoint` 模式。它是怎么入队的？入队后 VMThread 怎么调度它？redefine 过程中 constant pool 合并怎么保证 safepoint 安全？

**为什么这是 08 的完美应用案例**：读者刚学完 VM_Operation 的 Mode 决策、VMOperationQueue 的 add/remove、doit_prologue 门禁、begin/end 协议。现在拿一个真实的、非 GC 的 VM_Operation 子类来走一遍——"这套框架不只是 GC 用的"。

**覆盖内容**：

```
§〇 源文件清单
  - jvmtiRedefineClasses.hpp (VM_RedefineClasses 类定义)
  - jvmtiRedefineClasses.cpp (redefine 核心逻辑, ~4000行)
  - vmOperations.hpp (VM_Operation 基类)
  - vmThread.cpp (VMThread::execute, loop)
  - jvmtiEnv.cpp (RetransformClasses, RedefineClasses 入口)

§一 VM_RedefineClasses 的类层次
  ❓ 它继承了什么？覆写了什么？
  → VM_RedefineClasses : VM_Operation
    - evaluation_mode() → _safepoint  ← ★ 必须 STW
    - doit()  → redefine_single_class + merge_cp_and_rewrite
    - allow_nested_vm_operations() → true  ← ★ GC 可以在 redefine 期间发生
  ★ 源码验证：`VM_RedefineClasses` **确实 override 了 `doit_prologue()`**（`jvmtiRedefineClasses.cpp:115-142`）——
    做参数校验（class_count、class_defs 有效性、`is_modifiable_class` 检查）。
    如果校验失败返回 false → 操作不入队。
    但它**不获取 Heap_lock**、不做 GCLocker 检查——因为 redefine 不分配堆内存。

§二 ★ 从 JVMTI 调用到 VM_Operation 入队
  ❓ 和 GC 的 VM_G1CollectForAllocation 入队路径有什么异同？
  → 相同: VMThread::execute(&op) → doit_prologue → 入队 → wait
  → 不同: doit_prologue 的具体行为不同：
    - VM_GC_Operation::doit_prologue() → Heap_lock->lock() + skip_operation()
    - VM_RedefineClasses::doit_prologue() → 可能是默认 return true（需验证）
  → 线程冻结由 begin() 中的 Threads_lock->lock() 完成（不在 doit_prologue 中）

§三 ★★ redefine 内部的 safepoint 嵌套
  ❓ allow_nested_vm_operations() 返回 true 意味着什么？
  → redefine 期间如果 GC 发生（如元空间分配失败），
    GC 的 VM_Operation 可以在当前 safepoint 内嵌套执行。
    VM_CollectForMetadataAllocation 的 allow_nested 也是 true。
    这是 VM_Operation 框架的一个高级特性。

§四 constant pool 合并与 Method 重写
  ❓ 为什么必须在 safepoint 中进行？
  → 所有线程暂停 → 没有线程在执行旧方法 → 安全替换方法表。
    Method 的 _from_compiled_entry 需要更新 → 涉及 code cache 刷新。

§五 ★ 和 [08-03] 的 VM_Operation 框架对比
  VM_RedefineClasses vs VM_G1CollectForAllocation:
    - 相同: Mode(_safepoint), VMOperationQueue, ticket 等待
    - 不同: doit_prologue 内容, 是否持有 Heap_lock, 是否允许嵌套

§六 GDB 验证
  - VM_RedefineClasses 入队前在 VMOperationQueue 中的位置
  - doit() 执行期间 _state 的值验证
```

**关键文件**（跨 prims + runtime）：
| 文件 | 模块 | 核心类/函数 |
|------|------|-----------|
| `jvmtiRedefineClasses.hpp` | prims | `VM_RedefineClasses`（继承 VM_Operation） |
| `jvmtiRedefineClasses.cpp` | prims | `doit()`, `redefine_single_class()`, `merge_cp_and_rewrite()` |
| `vmOperations.hpp` | runtime | `VM_Operation::Mode`, `allow_nested_vm_operations()` |
| `jvmtiEnv.cpp` | prims | `JvmtiEnv::RedefineClasses()` ★ 入口 |
| `vmThread.cpp` | runtime | `VMThread::execute()` — 复现 [08-03] 学到的入队路径 |

**前置**：[08-01], [08-02], [08-03], [09-01]

---

### [04] JVM-Entry-Points — 302 个 JVM_XXX 函数的统一入口

**核心问题**：Java 代码调用 native 方法，第一步是进入 `JVM_XXX` 函数。为什么需要这个中间层？302 个 JVM_* 函数遵循什么设计模式？它们和 JDK 源码中的 `native` 声明怎么对应？

**为什么重要**：JVM_XXX 是 Java → JVM 的真正入口。理解了这个层的设计，你就理解了 JVM 的"公共 API 面"。

**覆盖内容**：

```
§〇 源文件清单
  - jvm.cpp (3834行, ~170个 JVM_* 函数入口)
  - jvm.hpp (JVM_* 声明)
  - classfile/javaClasses.cpp (Java 类的 native 方法注册)

§一 JVM_XXX 的命名约定与注册机制
  ❓ jvm.cpp:JVM_DefineClass 和 java.lang.ClassLoader.defineClass0 怎么关联？
  → 通过 JNI RegisterNatives 在 JVM 启动时批量注册。
    映射表在 Thread::initialize() / SystemDictionary::initialize() 中。

§二 ★★ 分类走读：挑选 6-8 个代表性函数深挖
  1. JVM_StartThread → os::create_thread → Thread::start
  2. JVM_GC → Universe::heap()->collect()
  3. JVM_DefineClass → SystemDictionary::parse_stream
  4. JVM_MonitorWait → ObjectSynchronizer::wait
  5. JVM_CurrentTimeMillis → os::javaTimeMillis
  6. JVM_FindClassFromBootLoader → SystemDictionary::resolve_or_fail
  ❓ 它们的共同特征是什么？
  → ThreadInVMfromNative 包裹；参数校验 + JNI 环境准备 + 调用核心子系统

§三 ThreadInVMfromNative 的作用
  ❓ 为什么 JVM_XXX 函数体开头总有这个 RAII 对象？
  → 将线程从 _thread_in_native 转换到 _thread_in_vm。
    确保在 VM 代码执行期间 safepoint 可以正确处理此线程。

§四 和 [09-01] ThreadState 的整合
  → 把 JVM_XXX 的状态转换嵌入到完整的 JNI 生命周期中
```

**关键文件**（跨 prims + classfile）：
| 文件 | 模块 | 核心内容 |
|------|------|---------|
| `jvm.cpp` | prims | ~170 个 JVM_* 函数（`grep -c 'JVM_ENTRY\|JVM_QUICK_ENTRY\|JVM_LEAF' jvm.cpp` = 170） |
| `jvm.hpp` | prims | JVM_* 声明 |
| `classfile/javaClasses.cpp` | classfile | native 方法注册 ——JDK 类中的 `native` 方法到 JVM_* 的映射在此建立 |

**前置**：[09-01], [07-thread]

---

### [05] Reflection-Internal — Method.invoke() 到底慢在哪里

**核心问题**：`Method.invoke()` 经过多少层才能到真正的 native 代码？为什么反射比直接调用慢 10-100 倍？（提示：不是"JIT 无法内联"这一件事）

**为什么重要**：反射是框架的基础设施（Spring、MyBatis、JUnit）。理解它的开销来源是性能优化的前提。

**覆盖内容**：

```
§〇 源文件清单
  - reflection.cpp (Reflection::invoke_method, Reflection::new_instance)
  - jni.cpp (jni_invoke_nonstatic via reflection)
  - nativeLookup.cpp (方法查找 → 解析 native 方法绑定)
  - method.cpp (Method::invoke() — 实际方法调用入口)

§一 ★ 从 java.lang.reflect.Method.invoke() 到 native 的全路径
  ❓ 一共经过多少层调用？
  → java.lang.reflect.Method.invoke() [JDK]
    → MethodAccessor.invoke() [JDK]
    → NativeMethodAccessorImpl.invoke0() [JDK native]
    → JVM_InvokeMethod [jvm.cpp]
    → Reflection::invoke_method [reflection.cpp]
    → method->invoke() / methodHandle() [C++ method invocation]
  至少 6 层。直接调用是 1 层（invokevirtual/invokestatic 字节码 → method entry point）。

§二 ★★ 每层开销分析
  ❓ 每层在干什么？哪层最贵？
  → Java 层：MethodAccessor 的委派链、访问检查、拆装箱
  → JNI 层：JVM_InvokeMethod 的 Handle 创建、参数转换
  → C++ 层：method->invoke() 的 JavaCalls::call
  → ★ 最贵的是参数打包/拆包，不是调用本身

§三 MethodAccessor 的 Inflation 机制
  ❓ 为什么前 15 次反射调用走 Native，之后走生成的 bytecode？
  → NativeMethodAccessorImpl → 慢但无需生成代码
    GeneratedMethodAccessor → 生成一段 bytecode，直接用 invokevirtual → 快
    Inflation 阈值 = sun.reflect.inflationThreshold (默认 15)

§四 ★ 和直接调用的对比：为什么 JIT 无法消除开销
  → 反射的 Method 对象在堆上，不在 JIT 的常量传播范围
  → 即使是 GeneratedMethodAccessor，也是间接调用
  → 参数总是 Object[] → 每次调用都要 type check + unboxing

§五 GDB 验证
  - Reflection::invoke_method 调用栈（15层+）
  - Inflation 发生前后的 MethodAccessor 类型切换
```

**关键文件**（跨 prims + runtime）：
| 文件 | 模块 | 核心函数 |
|------|------|---------|
| `reflection.cpp` | prims | `invoke_method()`, `new_instance()` |
| `jvm.cpp` | prims | `JVM_InvokeMethod` — JNI 入口 |
| `nativeLookup.cpp` | prims | native 方法查找 → 解析 `native` 方法的 JVM 实现 |
| `method.cpp` | oops | `Method::invoke()` — 实际的方法调用 |

**前置**：[09-01], [09-04]

---

### [06] MethodHandles-invokedynamic — LambdaForm 的编译链

**核心问题**：`invokedynamic` 指令执行时，JVM 怎么从 `CallSite` 找到 `MethodHandle`、生成 `LambdaForm`、编译成机器码？这条链上哪些步骤是 lazy 的？

**为什么重要**：lambda 表达式、字符串拼接（indy StringConcatFactory）、记录类（Records）都走 invokedynamic。这是 Java 8+ 的字节码引擎。

**覆盖内容**：

```
§〇 源文件清单
  - methodHandles.cpp (MethodHandles::generate_adapters, linkToStatic)
  - methodHandles.hpp (MethodHandles 接口)
  - linkResolver.cpp (invokedynamic 链接)

§一 invokedynamic 的 4 阶段
  1. 解析阶段: LinkResolver::resolve_invokedynamic → 找到 bootstrap method
  2. 链接阶段: BootstrapMethod 执行 → 返回 CallSite
  3. 适配阶段: MethodHandles::generate_adapters → LambdaForm
  4. 编译阶段: LambdaForm 被 C1/C2 编译为机器码

§二 MethodHandle 的类型系统
  ❓ 为什么 MH 有 static/dynamic/volatile 多种调用模式？
  → 对应不同的 JVM 内部操作:
    invokeStatic → linkToStatic (直接调用)
    invokeVirtual → linkToVirtual (vtable dispatch)
    invokeSpecial → linkToSpecial (直接超类调用)

§三 LambdaForm 的结构
  ❓ LambdaForm 是什么样的 IR？
  → 由 Name 节点组成的表达式树。每个 Name 代表一次操作（参数绑定、类型转换、方法调用）。
    LambdaForm 被解释执行 → 达到编译阈值 → C1/C2 编译。

§四 ★ 和反射的性能对比
  → MethodHandle 在 JIT 眼中是"透明的"——可以被内联
  → 反射的 Method.invoke() 无论如何都需要 Object[] 参数 → 不可消除

§五 GDB 验证
  - LambdaForm 的 Name 树结构
  - adapter 方法在 code cache 中的位置
```

**关键文件**（跨 prims + interpreter）：
| 文件 | 模块 | 核心函数 |
|------|------|---------|
| `methodHandles.cpp` | prims | `generate_adapters`, `linkToStatic`, `invokeBasic` |
| `methodHandles.hpp` | prims | `MethodHandles` 接口 |
| `linkResolver.cpp` | interpreter | `resolve_invokedynamic` ★ 在 interpreter/ 模块 |

**前置**：[09-05]

---

### [07] Unsafe-Implementation — CAS、park/unpark、内存屏障的底层实现

**核心问题**：`Unsafe.compareAndSwapInt()` 在 x86 上是 `lock cmpxchg`，为什么还需要 Java 包装层？`Unsafe.park()` 怎么映射到 `pthread_cond_wait()`？`Unsafe.putOrderedInt()` 和 `volatile` 写有什么微妙区别？

**为什么放在最后**：Unsafe 是 Java 到硬件的"后门"。理解它需要前面的线程模型、内存模型知识。放在最后是对整阶段能力的检验。

**覆盖内容**：

```
§〇 源文件清单
  - unsafe.cpp (所有 Unsafe_* 实现)
  - unsafe.hpp (Unsafe 类)
  - atomic_linux_x86.hpp (CAS 的内联汇编实现)
  - orderAccess_linux_x86.hpp (内存屏障)
  - os_linux.cpp (park/unpark → pthread)

§一 ★ Unsafe 的方法分类
  ❓ 为什么 Unsafe 有 100+ 个 native 方法？哪些是核心？
  → 5 大类: 内存操作(allocateMemory/putX/getX)、CAS(compareAndSwapX)、
    线程(park/unpark)、类操作(defineClass/defineAnonymousClass)、
    屏障(loadFence/storeFence/fullFence)

§二 ★★ CAS 的完整链路
  ❓ Unsafe_CompareAndSwapInt → Atomic::cmpxchg → lock cmpxchg
  → unsafe.cpp: 参数校验 + oop 解析
  → atomic_linux_x86.hpp: 内联汇编 `lock cmpxchg %rsi, (%rdi)`
  → 为什么必须 lock 前缀？→ 锁缓存行 → 保证多核原子性

§三 ★★ park/unpark 与 pthread 的映射
  ❓ Unsafe_Park → Parker::park → pthread_cond_wait
  ❓ 为什么不用 sleep？→ park 支持 unpark 提前唤醒，无竞态窗口
  → Parker 维护一个 counter: 0=阻塞, 1=放行
    park: old = Atomic::xchg(0, &_counter); if (old > 0) return;  // 先清零取旧值
          mutex_lock; while(_counter==0) cond_wait; _counter=0; mutex_unlock;
    unpark: mutex_lock; _counter=1; mutex_unlock; cond_signal;

§四 ★ putOrdered vs volatile write
  ❓ putOrderedInt 比 putIntVolatile 快在哪？
  → putOrdered: LazySet(StoreStore barrier) — 只保证不乱序，不保证即时可见
  → putVolatile: 完整 StoreLoad barrier — 保证立即对所有 CPU 可见
  → 典型使用场景: 设置一个 flag，然后发 unpark → unpark 自带 barrier

§五 GDB 验证
  - CAS 的内联汇编反汇编 → lock cmpxchg
  - park 时 pthread 状态 → pthread_cond_wait
```

**关键文件**（跨 prims + os_cpu）：
| 文件 | 模块 | 核心函数 |
|------|------|---------|
| `unsafe.cpp` | prims | `Unsafe_CompareAndSwapInt`, `Unsafe_Park`, `Unsafe_Unpark` |
| `atomic_linux_x86.hpp` | os_cpu | `Atomic::cmpxchg` — 内联汇编 `lock cmpxchg` |
| `orderAccess_linux_x86.hpp` | os_cpu | `OrderAccess::fence`, `release_store` — 内存屏障 |
| `os_linux.cpp` | os | `Parker::park()`, `Parker::unpark()` — pthread 封装 |

**前置**：[09-01]

---

## 四、写作优先级与预估篇幅

| 优先级 | 文档 | 预估篇幅 | 理由 |
|--------|------|---------|------|
| **P0** | 01-ThreadState-NativeTransition | ~600行 | 全阶段基石 + 08桥梁，必须先写 |
| **P0** | 03-VM-RedefineClasses | ~500行 | 08成果的最佳应用案例，独特价值最高 |
| **P1** | 02-JNI-Reference-Management | ~400行 | 面试高频 + 实际开发常用 |
| **P1** | 04-JVM-Entry-Points | ~450行 | 理解JVM公共API的关键 |
| **P2** | 05-Reflection-Internal | ~500行 | 框架开发者必读 |
| **P2** | 06-MethodHandles-invokedynamic | ~450行 | Java 8+ 基础 |
| **P2** | 07-Unsafe-Implementation | ~400行 | 底层并发基础 |

---

## 五、和 08 阶段的对比

| 维度 | 08-safepoint | 09-native-interface |
|------|-------------|-------------------|
| 核心文件 | ~6 | ~79（实际聚焦 ~25） |
| 文档数 | 5 | 7 |
| 模块跨度 | **2 模块**（runtime + gc/shared） | **5 核心模块 + oops/os**（prims + runtime + gc/shared + os_cpu + interpreter + oops + os） |
| 核心叙事 | 一个机制（safepoint）层层深挖 | 多个独立子系统，用线程状态连接 |
| 与前置的连接 | 自包含（依赖07） | ★ 强烈依赖 08（01桥梁 + 03直接复用 VM_Operation 框架） |
| 写作风格 | 01是骨架，02-04是零件，05是串联 | 01是桥梁，02-07是独立专题 |
| 最大价值 | begin/end 协议 + GCLocker 双层门禁 | ★ JNI线程状态 + VM_Operation 应用案例 |

---

## 六、不要做的事情

- ❌ 写 JNI API 使用教程（`GetStringUTFChars` 用法）
- ❌ 把 01 写成 [02] 的重复——01 聚焦状态转换，不是 poll 机制重述
- ❌ 把 03 写成 JVMTI 规范翻译——聚焦 VM_Operation 框架的应用，不是 JVMTI API 解释
- ❌ 每篇文档都从头解释 thread state——[09-01] 写完后，后续文档直接引用
- ❌ 忽略 JNI 和 08-safepoint 的连接——这是本阶段和 08 的"遗传基因"
- ❌ 忽略跨模块属性——06 的 linkResolver.cpp 在 interpreter/，07 的 CAS 在 os_cpu/，05 的 method.cpp 在 oops/
- ❌ 把 NativeLookup、StackWalker、JVMTI 事件分发等"有各自价值但不属于本阶段主线"的主题强行塞进来——详见 §八 排除清单

---

## 七、跨模块依赖矩阵

| | prims | runtime | gc/shared | os_cpu | interpreter | classfile | oops | os |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **01** ThreadState | jni.cpp | interfaceSupport, safepoint.cpp, sharedRuntime.cpp | — | — | — | — | — | — |
| **02** JNI-Ref | jni.cpp | jniHandles.cpp/hpp | oopStorage.hpp | — | — | — | — | — |
| **03** RedefineClasses | jvmtiRedefineClasses, jvmtiEnv.cpp | vmOperations.hpp, vmThread.cpp | — | — | — | — | — | — |
| **04** JVM-Entry | jvm.cpp, jvm.hpp | — | — | — | — | javaClasses.cpp | — | — |
| **05** Reflection | reflection.cpp, jvm.cpp, nativeLookup.cpp | — | — | — | — | — | method.cpp | — |
| **06** MethodHandles | methodHandles.cpp/hpp | — | — | — | linkResolver.cpp | — | — | — |
| **07** Unsafe | unsafe.cpp/hpp | — | — | atomic_linux_x86, orderAccess_linux_x86 | — | — | — | os_linux.cpp |

★ 注意：
- `jniHandles.cpp/hpp` 在 `runtime/`，但通过 `jni.cpp` 公开接口——这是 runtime→prims 的桥梁文件
- `oopStorage.hpp` 在 `gc/shared/`，JNI 引用管理需要它作为底层存储——这是 prims→gc 的桥梁
- `method.cpp` 在 `oops/`，05 需要它来理解 `Method::invoke()` ——这是 prims→oops 的桥梁
- `os_linux.cpp` 在 `os/`，07 的 Parker 实现在此——这是 prims→os 的桥梁

---

## 八、显式排除的主题（为什么不做）

以下主题有各自的价值，但本阶段**刻意不包含**：

| 主题 | 排除原因 |
|------|---------|
| **JVMTI 事件分发机制**（JvmtiExport::post_*, JvmtiEventController） | 事件分发是"JVMTI API 实现"层面，不是"JVM 内部机制"层面。和 08/07 无直接连接。如果将来需要，可作为 09 的扩展文档 |
| **JVMTI Agent 生命周期**（Agent_OnLoad/Attach, JvmtiAgentThread） | 同上——是 JVMTI API 使用模式，不是 JVM 内核 |
| **NativeLookup 独立文档** | native 方法查找涉及 ResolvedMethodTable + 系统属性（`java.library.path`）+ OS 动态链接（`dlopen/dlsym`）。太偏 OS 层，不适合在 JVM 分析系列中独立成篇。相关分析分散在 04（JVM_* 注册）和 05（反射的 native 绑定） |
| **WhiteBox / CDS / Forte** | 测试工具 / 性能分析器 / 启动优化——和本阶段"JNI/JVM 交互面"的核心叙事无关 |
| **StackWalker** | 虽然是 JVM 内部实现，但它更适合放在"运行时反射/调试"专题，不属于 JNI 线程状态这条主线 |

---

## 九、每篇文档的深度问题（写 prompt 时必须覆盖）

以下问题不要求在 README 中回答——它们用于驱动每篇文档的 prompt，确保文档不只是"解释代码"，而是"追问为什么"。

### [01] ThreadState-NativeTransition

1. `_thread_in_native_trans` 窗口期内，线程能执行什么操作？如果它此时撞到 `mprotect` 的 SIGSEGV 会怎样？
2. `transition_from_native()` 先 poll 再改 state，反过来（先改 state 再 poll）有什么问题？（与 [01-Safepoint-Protocol] 的"先改 _state 再 arm polling"的对称性对比）
3. `check_safepoint_and_suspend_for_native_trans()` 函数名暗示它处理"挂起"和"safepoint"两种场景——两者分别触发什么代码路径？

### [02] JNI-Reference-Management

1. JNIHandleBlock 的 `_top`/`_bottom`/`_free_list` 指针的关系是什么？block 满了怎么分配下一个？
2. GlobalRef 的 OopStorage 和 GC 的 `process_roots()` 怎么对接？哪个 GC 阶段遍历它？
3. PushLocalFrame/PopLocalFrame 的实现涉及指针回滚还是内存释放？为什么 PushLocalFrame 要求 `capacity >= 16`？

### [03] VM-RedefineClasses

1. `allow_nested_vm_operations()` 返回 true——嵌套的 GC 怎么在一个已经在进行的 safepoint 中执行？（VMThread 已经在 safepoint 中，`begin()` 再被调用会 assert？还是 VM_Operation 框架有特殊路径？）
2. redefine 期间 `merge_cp_and_rewrite()` 修改了 method entry point——已经编译的 nmethod 怎么处理？（code cache flush？deoptimization？）
3. 为什么 `VM_RedefineClasses` 不 override `doit_prologue()`？（默认 return true 意味着什么？）

### [04] JVM-Entry-Points

1. `ThreadInVMfromNative` 构造/析构函数中做了什么？析构时如果发现 safepoint 挂起，会触发什么？
2. 302 个 JVM_* 函数中有多少需要 `ThreadInVMfromNative`？有没有例外？
3. `JVM_StartThread` 内部如何绕开常规的 JNI→native 状态转换？新线程启动时的状态到底是什么？

### [05] Reflection-Internal

1. Inflation 阈值 15 是谁定的？为什么不是 10 或 20？这个阈值在什么场景下可以调整？
2. `GeneratedMethodAccessor` 生成的 bytecode 具体长什么样？它是一个完整的 class 还是方法片段？
3. 反射调用的 `Object[]` 参数拆包过程中，做了多少次 `jobject` ↔ `oop` 转换？每次转换的句柄开销有多大？

### [06] MethodHandles-invokedynamic

1. `LambdaForm` 的 Name 节点树在什么时候转成 bytecode？转译过程（LambdaForm → bytecode）在哪里？
2. invokedynamic 的 bootstrap method 返回的 `CallSite` 对象存在哪？怎么避免被 GC 回收？
3. MethodHandle 的 `invokeBasic` 如何最终走到 `linkToStatic`/`linkToVirtual`？谁做的 dispatch？

### [07] Unsafe-Implementation

1. `Unsafe.putOrderedInt()` 对应的 `OrderAccess::release_store()` 在 x86 上是 `mov` 还是带 barrier？如果 x86 的 TSO 天然保证 store-store order，为什么还需要 StoreStore barrier？
2. `Parker` 的 counter 机制怎么避免 lost wakeup 问题？`park()` 检查 counter==1 和 `pthread_cond_wait()` 之间有没有窗口？
3. `Unsafe.defineAnonymousClass()` 和普通类加载的差别在哪？它创建的类为什么不受 ClassLoader 管理？
