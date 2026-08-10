# PROMPT: 请撰写 04-JVM-Entry-Points.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**JVM Entry Points — `JVM_ENTRY`/`JVM_LEAF` 宏系统、170+ JVM_* 函数的统一门面、以及 `ThreadInVMfromNative` 在每个入口的 RAII 角色**

### 核心故事线（禁止做源码翻译机！）

[01-ThreadState-NativeTransition] 拆解了线程从 native 返回 Java 时的状态转换——`ThreadInVMfromNative` ctor 里 `trans_from_native(_thread_in_vm)` + poll safepoint。但你有没有想过：**是谁在调用 `ThreadInVMfromNative`？** 答案是 170+ 个入口函数，每一个都用完全相同的宏把 RAII 对象构造出来。

[02-JNI-Reference-Management] 解释了 jobject 的本质（`oop*`）、GlobalRef 的 OopStorage 存储、以及它们如何成为 GC Root。但 JNI API 层（`jni_NewGlobalRef`）和 JVM 内部入口（`jvm.cpp`）之间是什么关系？如果用电路比喻——JNI API 是外部接口，JVM_* 函数是内部总线，每个 `JVM_ENTRY` 宏是一模一样的"变压器电路"：把 native 侧的 `JNIEnv* + jobject` 转成 VM 内部的 `Klass* + Handle + Thread*`。

**本文是 09 阶段的"架构文档"**：[01][02] 讲的是穿越边界的两个维度（控制面的线程状态、数据面的引用安全），本文讲的是**所有入口遵循的统一协议——三态宏系统、Handle 创建的代价、TRAPS 异常传播、以及信号处理器如何把 SIGSEGV 转成 Java 异常（PC 劫持，不是 setjmp/longjmp！）**。理解了本文的宏展开，你就获得了阅读 `jvm.cpp` 3834 行代码的"统一解码器"。

### 核心叙事线

1. **★ `JVM_ENTRY`/`JVM_END` 的完整宏展开 — 每一行注入的代码** — 这是全文的"解码器"。`JVM_ENTRY(result_type, header)` 展开后会注入：`JavaThread* thread` 声明、`ThreadInVMfromNative __jvm_invm(thread)` RAII 构造、`HandleMarkCleaner __hmc(thread)` Handle 作用域、以及（取决于宏变体）`ResourceMark`、`JvmtiVMObjectAllocEventCollector` 等。**每展开一个宏，都要回答"为什么这条语句不能少"。** `JVMWrapper` trace 是**显式写在函数体内的**（不是宏注入的）——只有部分关键函数手动加了它（如 `JVM_GetEnclosingMethodInfo` 中 `jvm.cpp:3748`）。例：`HandleMarkCleaner` 不写会怎样？→ JVM_ENTRY 内创建的 Handle 会永久占据 HandleArea → 内存泄漏。`ThreadInVMfromNative` 不写 → `_thread_in_native` 状态下操作 JVM 内部对象 → [01]§二的断言 fire。追问：**`JVM_LEAF` 为什么不注入 `ThreadInVMfromNative`？** → LEAF 函数是纯计算（如 `JVM_GetVersion`、`JVM_AvailableProcessors`），不触碰 JVM 堆，不需要状态转换。但如果 LEAF 函数错误地操作了 JVM 对象 → 没有 `current_thread_in_native()` 断言保护 → 隐式 bug。

2. **★★★ 8 个代表性函数的深挖 — 4 个分类 × 2 个函数** — 不要只贴源码。对每个函数追问"它在 JDK 源码中对应的 `native` 声明在哪里"→"它调用了哪个子系统"→"返回值的 jobject 后面是什么 oop"。分类：(a) **线程/同步类**：`JVM_StartThread`（L2920+）→ `os::create_thread` → `Thread::start`；追问：新线程启动时的 `_thread_state` 初始值是什么？为什么从 `_thread_new` 转到 `_thread_in_vm` 而不是 `_thread_in_Java`？(b) **GC/内存类**：`JVM_GC` → `Universe::heap()->collect()`；追问：作为 JVM 入口触发 GC 和 G1Policy 自主决定 GC 的区别——谁会等待 safepoint？谁不需要？(c) **类加载类**：`JVM_DefineClass`（`jvm.cpp:957-962`）→ `jvm_define_class_common`（`jvm.cpp:894`）→ `SystemDictionary::resolve_from_stream`（`jvm.cpp:943`）；追问：defineClass 的 bytes 是从 JNI 层传进来的 `jbyte*`——它们在哪被复制？是堆上还是 C-heap？为什么必须复制？(d) **工具/信息类**：`JVM_CurrentTimeMillis` → `os::javaTimeMillis`；`JVM_GetClassName` → `InstanceKlass::external_name`；追问：LEAF 函数能不能访问 TLS（thread-local storage）？→ 不经过 `ThreadInVMfromNative` → `Thread::current()` 仍然是安全的（TLS 是 OS 管理的），但 `JavaThread::current()->thread_state()` 读到的可能是 `_thread_in_native`。

3. **★ `TRAPS` / `CHECK` / `CHECK_NULL` 异常传播协议** — 每个 JVM_ENTRY 函数签名中都有 `JVM_ENTRY(ret_type, name)` 展开后注入 `TRAPS`（即 `JavaThread* THREAD`）。CHECK_NULL 宏展开是 `if (THREAD->has_pending_exception()) return NULL;`——一个隐式的早期返回。**为什么不用 C++ exception？** JVM 不能用 C++ exception 穿过 native 帧（JNI 规范禁止，且 unwinding 无法正确处理 HandleMark）。`TRAPS` 协议的代价：每个可能抛异常的函数调用后都要写 `CHECK_NULL` / `CHECK_false`，忘记写 → pending exception 被吞掉 → 崩溃或行为异常。追问：**`THREAD` 和 `thread` 是同一个变量吗？** JVM_ENTRY 注入 `JavaThread* thread`（RAW），TRAPS 注入 `JavaThread* THREAD = thread`——两者是别名。区别是语义约定：`thread` 用在"当前线程就是 JavaThread"的场景，`THREAD` 用在"传给子函数需要 `TRAPS` 签名"的场景。

4. **★★★ `ThreadInVMfromNative` 在 JVM_ENTRY 出口的 dtor — 如果 safepoint 在等待会怎样？** — 每个 JVM_ENTRY 的 JVM_END 闭包后，`ThreadInVMfromNative` 栈对象析构 → `trans_and_fence(_thread_in_vm, _thread_in_native)` → `transition_and_fence`（`interfaceSupport.inline.hpp:136`）。与 [01]§二 `transition_from_native` 对比：入口保证线程安全进入 VM（poll + block），出口保证状态回退时的跨 CPU 可见性。`transition_and_fence` 内部：设置过渡状态 `(from+1)` → `serialize_thread_state_with_handler`（x86: `lock; addl` fence 或序列化页写入）→ `SafepointMechanism::block_if_requested(thread)` → 最终状态。★ 关键发现：出口**仍然会 poll safepoint**（L144 `block_if_requested`）——如果 VMThread 正发起 safepoint，线程会在返回 native 前被阻塞，而不是带着 `_thread_in_native_trans` 离开。追问：**如果 JVM_ENTRY 内的 CHECK_NULL 触发了早期返回，`ThreadInVMfromNative` 仍然被析构吗？** → 是——RAII 保证 dtor 一定执行。追问：**x86 上 `storestore()` 是真正的 CPU fence 吗？** → 不是——`OrderAccess::storestore()` 在 x86 上只是 `compiler_barrier()`（`orderAccess_linux_x86.hpp:41`）。真正的硬件同步靠 `transition_and_fence` 内的 `serialize_thread_state_with_handler`（`UseMembar` 时用 `lock; addl` fence，否则用序列化页写入）。

5. **★ JVM_StartThread 的"绕过"路径 — 为什么不是所有线程都经过 JVM_ENTRY？** — `JVM_StartThread` 调 `os::create_thread` → 新线程入口是 `java_start(Thread*)` → 此函数**直接设置** `_thread_state = _thread_in_vm`（因为没有从 native 进来，不需要 `trans_from_native`）→ 然后调用 `Thread::start` 真正的 `run()`。**新线程的 first frame 不是 Java frame 也不是 native frame——是 VM frame**。追问：如果有人在 `JVM_StartThread` 中尝试 `HandleMark hm` —— 当前线程是调用 `start` 的线程，不是被创建的线程。新线程的 HandleArea 在哪初始化？→ `Thread::Thread()` 构造函数中。

6. **★ `javaClasses.cpp` 中的 native 方法注册 — JDK 源码的 `native` 声明怎么找到 JVM_* 函数** — JDK 类（如 `java.lang.System`）在 `<clinit>` 中调用 `RegisterNatives` → `jni_RegisterNatives` → `Method::set_native_function` 将 `JVM_XXX` 函数指针写入 `Method::_native_function` 字段。`javaClasses.cpp` 的 `compute_offsets()`（L100+）计算 `java.lang.reflect.Method` 等类的字段偏移——供 JVM_* 函数通过 `java_lang_reflect_Method::slot(reflected)` 访问 Method 对象。**这不是 "JDK 调用 JVM_*"的简单映射——这是 JNI RegisterNatives 协议，涉及 Method 对象上的函数指针替换。** 追问：如果不调用 `RegisterNatives`，JVM 怎么找到 native 方法？→ 回退到 `NativeLookup::lookup()`（dlsym 动态查找），但在产品 JVM 中 `RegisterNatives` 是主路径。

7. **★★ JVM_LEAF vs JVM_ENTRY 的微妙安全隐患** — `JVM_CurrentTimeMillis`（L1180+）用 `JVM_LEAF`：不进入 VM，不创建 Handle。但如果有人在 LEAF 函数中调了 `HandleMark hm` → `assert(_handle_mark_nesting > 0)` 失败 → crash。如果 LEAF 函数调了需要 `_thread_in_vm` 的函数（如 `Universe::heap()->is_in_reserved()`）→ 没有 `current_thread_in_native()` 断言 → 静默错误。**HotSpot 没有任何机制禁止 LEAF 函数错误操作 VM 对象——全凭约定和 code review。** 追问：**`JVM_QUICK_ENTRY` 和 `JVM_ENTRY` 的区别？** → `QUICK_ENTRY` 用于不需要 `JvmtiVMObjectAllocEventCollector` 的入口（如 `JVM_Halt`），节省 JVMTI 对象分配事件跟踪的开销。

### 禁止行为

- ❌ 把 `jvm.cpp` 全文当目录逐函数贴——这是电话簿不是文档
- ❌ 把 README 中的 8 个代表性函数列出后不追问题——每个函数必须回答"为什么需要这个入口""它调用的子系统之前学过什么"
- ❌ 忽略 `TRAPS/CHECK/CHECK_NULL` 的异常传播协议——这是 JVM 入口最特殊的语义层
- ❌ 忽略 `javaClasses.cpp` 的字段偏移计算和 JVM_* 的关系——`java_lang_reflect_Method::slot()` 是 05-Reflection 的前置知识
- ❌ 不展开 `JVM_ENTRY` 宏——这是理解所有入口函数的"统一解码器"，不加它读者看 jvm.cpp 就是天书
- ❌ 忽略 JVM_StartThread 的特殊路径——新线程不经过 `JVM_ENTRY` 宏的 `ThreadInVMfromNative`
- ❌ 忽略 [01][02] 的连接——`ThreadInVMfromNative` 的 ctor/dtor 在 [01]§二已拆解；`JNIHandles::make_local()` 在 [02]§一已分析
- ❌ 不做交叉验证——`JVM_GC` 内部 `Universe::heap()->collect()` 和 08-safepoint 的关系必须点明
- ❌ 把 170+ 个 JVM_* 函数全部列成表——这不是本文的职责。挑 8 个深挖，其余归类总结

### 要求行为

- ✅ **★ `JVM_ENTRY`/`JVM_END` 的完整宏展开图** — 展示 `JVM_ENTRY(jobject, JVM_GetClassName(JNIEnv *env, jclass cls))` 展开后的完整代码块（约 15 行），每一条注入代码标注作用
- ✅ **★ `JVM_LEAF` 的展开对比** — 和 JVM_ENTRY 展开的差异列表（缺了什么、多了什么）
- ✅ **★ 8 函数深挖 — 每函数 4 追问**：(a) JDK 中的 native 声明在哪？(b) 它调用哪几个核心子系统函数？(c) 返回的 jobject 背后是什么 oop？(d) 如果这个入口被移除，Java 层什么功能会坏？
- ✅ **★ SIGSEGV→NPE 转换机制** — 信号处理器 + ucontext PC 劫持，不是 setjmp/longjmp。`JVM_handle_linux_signal()` 中判断 si_addr → 空指针 → 构造 NPE → 修改指令指针到 `StubRoutines::forward_exception_entry()`
- ✅ **★ `javaClasses.cpp:compute_offsets` 初始化扫描** — 回答"为什么 JVM_StartThread 里 `java_lang_Thread::thread_status()` 不用查 Method 对象？"→ offset 在初始化时一次性计算好，存在静态变量中
- ✅ **★ 170+ JVM_* 函数的分类统计**（不列全名，给类别和数量）：类加载 ~20、反射 ~15、线程 ~10、IO ~8、GC ~3、系统属性 ~5、Class ~30、其他
- ✅ **★ 和 [01] 的交叉验证** — 每个 JVM_ENTRY 的 `ThreadInVMfromNative` ctor/dtor 已在 [01]§二 拆解；`trans_from_native` 的 poll 路径
- ✅ **★ 和 [02] 的交叉验证** — JVM_ENTRY 内 `JNIHandles::make_local()` 的使用（把 oop 转成 jobject 返回给 caller）
- ✅ **★ 和 [05-Reflection] 的前瞻** — `jvm_get_method_common`（反射辅助函数）在 jvm.cpp:L1620 是 05-Reflection 的前置知识
- ✅ **★ GDB 可证伪断言 ≥10 条** — 宏展开后的实际代码验证、JVM_LEAF 中 ThreadInVMfromNative 是否被构造、JVM_StartThread 新线程的初始 thread_state

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心宏/函数（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `interfaceSupport.hpp` | `src/hotspot/share/runtime/interfaceSupport.hpp` | runtime | `JVM_ENTRY`/`JVM_END`/`JVM_LEAF`/`JVM_QUICK_ENTRY` 宏定义、`ThreadInVMfromNative`类、`JVMWrapper`类 | ★★★ 宏系统定义 — 全文的"解码器" |
| 2 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | runtime | `trans_from_native`、`trans_and_fence`、`ThreadInVMfromNative` ctor/dtor(:268-273) | ★★★ 状态转换实现 — [01] 的直接应用 |
| 3 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | prims | JVM_StartThread(~L2920)、JVM_GC、JVM_DefineClass、JVM_CurrentTimeMillis(~L1180)、jvm_get_method_common(:1620)、全部 170+ 入口 | ★★★ 所有 JVM_* 函数的实现文件 |
| 4 | `jvm.hpp` | `src/hotspot/share/prims/jvm.hpp` | prims | JVM_* 函数声明 | ★★ 公共 API 声明 |
| 5 | `javaClasses.cpp` | `src/hotspot/share/classfile/javaClasses.cpp` | classfile | `compute_offsets`、`java_lang_reflect_Method::slot`(:2773)、`java_lang_Class::as_Klass` | ★★ 偏移计算 — JVM_* 访问 JDK 对象字段的基础设施 |
| 6 | `javaClasses.hpp` | `src/hotspot/share/classfile/javaClasses.hpp` | classfile | `java_lang_Thread`、`java_lang_Class` 的静态偏移量 | ★★ 字段偏移定义 |
| 7 | `jni.cpp` | `src/hotspot/share/prims/jni.cpp` | prims | `jni_RegisterNatives` — JVM_* 注册到 Method 对象的 JNI 入口 | ★★ JVM_* 如何被 JDK 类发现 |
| 8 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os | `os::create_thread`、`java_start` — JVM_StartThread 的 OS 层实现 | ★★ 线程创建的 OS 接口 |
| 9 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `Thread::start()`、JavaThread 构造函数 | ★★ 线程模型的入口 |
| 10 | `handles.hpp` | `src/hotspot/share/runtime/handles.hpp` | runtime | `HandleMark`、`HandleMarkCleaner`、`HandleArea` | ★ Handle 作用域 — JVM_ENTRY 中的 Handle 生命周期 |

**跨模块说明**：`interfaceSupport.hpp`（runtime）定义宏 → `jvm.cpp`（prims）使用宏 → `javaClasses.cpp`（classfile）提供字段偏移 → `os_linux.cpp`（os）提供线程创建。四个模块协作完成"从 Java native 声明到 JVM 内部操作"的完整链路。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ `JVM_ENTRY`/`JVM_END` 宏展开（interfaceSupport.hpp）

```
问题：
  ① JVM_ENTRY 展开后注入了哪些代码？
     线索: interfaceSupport.hpp 中 #define JVM_ENTRY(ret_type, header) 的完整定义
     答案方向: 展开后的结构（用注释标注每部分来源）：
     extern "C" {                                 // JNI 要求 C linkage（可能在 jvm.hpp 声明处）
       ret_type header {                          // 函数签名
         JavaThread* thread = JavaThread::current(); // 获取当前线程
         ThreadInVMfromNative __jvm_invm(thread);    // ★ RAII 状态切换 [01]§二
         HandleMarkCleaner __hmc(thread);            // Handle 作用域
         // NOTE: JVMWrapper 不是宏注入的——它是函数体内显式写的 trace 标记
         // NOTE: ResourceMark 取决于宏变体(JVM_ENTRY vs JVM_QUICK_ENTRY)
         // ... 用户代码 ...
       }                                             // ★ __jvm_invm dtor → 切回 native
     }

  ② ThreadInVMfromNative 的 ctor/dtor 分别做了什么？
     线索: interfaceSupport.inline.hpp:268-273
     答案方向: ctor → trans_from_native(_thread_in_vm); [01] 已分析过。
     dtor → trans_and_fence(_thread_in_vm, _thread_in_native);
     区别: 进入要 poll safepoint，退出不需要（线程马上进 native，poll 无意义）。
     追问: dtor 中的 fence 保证什么？→ 函数体内的所有写操作在状态回退前对所有 CPU 可见。

  ③ HandleMarkCleaner 不写会怎样？
     线索: handles.hpp HandleMarkCleaner 类
     答案方向: JVM_ENTRY 内创建的 Handle 生命周期由 HandleMark 管理。
     没有 HandleMarkCleaner → Handle 永远不被释放 → HandleArea 内存泄漏。
     追问: HandleMarkCleaner dtor 做了什么？→ HandleMark 析构 → 回滚 Arena 的 top 指针。

  ④ ResourceMark 和 HandleMarkCleaner 的区别？
     线索: resourceArea.hpp ResourceMark
     答案方向: ResourceMark 管理 C-heap 临时内存（ResourceObj），HandleMarkCleaner 管理
     线程本地 HandleArea（Arena 中的 Handle）。两者都需要在入口创建、出口销毁。

  ⑤ extern "C" 为什么需要？
     答案方向: JNI 函数需要 C linkage——避免 C++ name mangling。
     JDK 侧通过 dlsym(handle, "JVM_StartThread") 查找——如果没有 extern "C"，
     符号名会是 _Z15JVM_StartThreadP7JNIEnv_P8_jobject... 而不是 JVM_StartThread。
```

### 4.2 ★★ JVM_LEAF vs JVM_ENTRY（为什么 LEAF 是危险的宏）

```
问题：
  ① JVM_LEAF 展开后缺了哪些 JVM_ENTRY 的代码？
     答案方向: 缺 ThreadInVMfromNative、HandleMarkCleaner、ResourceMark。
     ★ 原因: LEAF 函数承诺不操作 JVM 堆、不创建 Handle、不使用 ResourceObj。
     缺东西意味着不能安全操作——但没有编译器检查。

  ② 如果 LEAF 函数错误地调了 Universe::heap()->is_in_reserved() 会怎样？
     答案方向: 没有 current_thread_in_native() 断言（因为不在 _thread_in_vm 中
     就不会触发这个惯例检查）。线程在 _thread_in_native 状态，但操作了 JVM 堆上的 oop
     → 此 oop 可能正被 GC 移动 → 读到野指针。这是"静默错误"——危险在于不崩溃。

  ③ 哪些 JVM_* 使用了 JVM_LEAF？
     答案方向: JVM_GetVersion、JVM_AvailableProcessors、JVM_CurrentTimeMillis、
     JVM_NanoTime、JVM_GetClassNameUTF。共同特征：纯计算或读取 OS 信息，不碰 JVM 堆。
     追问: JVM_GetClassNameUTF 不碰堆吗？→ 它读取 InstanceKlass 的 Symbol* → Symbol
     对象在 Metaspace 中（不在堆上）→ 不需要 GC barrier → LEAF 安全。

  ④ JVM_QUICK_ENTRY 多了什么？少了什么？
     答案方向: 和 JVM_ENTRY 相同，但不创建 JvmtiVMObjectAllocEventCollector——
     省略 JVMTI 对象分配事件跟踪。用于不创建任何 Java 对象的函数（如 JVM_Halt）。
```

### 4.3 ★★ TRAPS / CHECK / CHECK_NULL 异常传播

```
问题：
  ① TRAPS 的实际类型是什么？
     线索: exceptions.hpp 中 #define TRAPS
     答案方向: TRAPS 展开为 JavaThread* THREAD。和 JVM_ENTRY 注入的
     JavaThread* thread 是同一个线程对象的两个别名。

  ② CHECK_NULL 的完整展开是什么？为什么用宏而不是函数？
     线索: exceptions.hpp 中 #define CHECK_NULL
     答案方向: #define CHECK_NULL THREAD); if (HAS_PENDING_EXCEPTION) return NULL; ((void)0
     ★ 必须是宏——因为它包含 return 语句。如果是函数，return 只退出函数
     不退出调用方。宏展开到调用方作用域中，return 能正确退出 JVM_ENTRY 函数。
     追问: HAS_PENDING_EXCEPTION 检查的是哪个字段？→ THREAD->_pending_exception != NULL。

  ③ 为什么不用 C++ exception？
     答案方向: 三重原因：(a) JNI 规范禁止异常穿过 native 帧；(b) C++ unwinding
     不会正确处理 HandleMark 栈——Handle 泄漏；(c) C++ exception 在信号处理上下文中
     行为未定义（无法在信号处理器中 throw）。JVM 用 TRAPS/CHECK 协议传播异常：
     pending_exception 存在 thread 对象上，逐层返回时靠 CHECK_NULL 宏检测并 early return。
     SIGSEGV → Java 异常的路径见 4.4（信号处理器 + PC 劫持，不是 setjmp）。

  ④ 如果 JVM_ENTRY 内忘记写 CHECK_NULL 会怎样？
     答案方向: 被调函数设置了 pending exception，但调用方没有检查 → 继续执行
     → 可能在有异常的状态下操作 JVM 对象 → assert(is_oop(obj)) 可能失败
     → 或在函数出口被 JVM_END 的 HANDLE_PENDING_EXCEPTION 捕获 → 转成 Java 异常。
     但如果中间有副作用（如修改了全局状态）→ 那些修改不会回滚 → 不一致状态。
```

### 4.4 ★★ 信号处理与异常转换 — SIGSEGV 如何变成 Java 异常

```
问题：
  ① SIGSEGV 如何转成 NullPointerException？机制是 setjmp 还是 PC 劫持？
     线索: os_linux.cpp 中 JVM_handle_linux_signal() 的实现
     答案方向: ★ 不是 setjmp/longjmp！实际机制是信号处理器 + ucontext PC 修改：
       - JVM 启动时注册信号处理器 JVM_handle_linux_signal() 处理 SIGSEGV
       - 信号发生 → 处理器被调用 → 判断 si_addr（故障地址）
       - 若 si_addr ∈ [0, os::vm_page_size()) → 空指针访问
         → 构造 NullPointerException → thread->set_pending_exception()
         → 修改 ucontext 的指令指针 → StubRoutines::forward_exception_entry()
         → 信号返回后 CPU 从 forward_exception_entry 继续执行
         → 此时线程仍在 _thread_in_vm 中，异常由上层 JVM_ENTRY 的 checks 处理
       - 若 si_addr 不在识别的范围内 → os::abort() → core dump
     追问: 为什么不是 setjmp/longjmp？→ setjmp 需要预先设置跳转点，而
     SIGSEGV 随时可能发生在任何指令上。信号处理 + PC 劫持更灵活：不需要
     在每条可能出错的指令前设 setjmp。

  ② JVM_ENTRY 宏内部有没有设置异常捕获？
     答案方向: JVM_ENTRY 本身不设信号处理或 setjmp。异常传播靠 TRAPS/CHECK 协议：
     - 信号处理器设置了 pending_exception 后，线程正常返回执行
     - JVM_ENTRY 内被调函数返回后，调用方检查 CHECK_NULL → 发现异常 → early return
     - 没有异常 → 正常走到 JVM_END → JVM_END 内通常没有 HANDLE_PENDING_EXCEPTION
       → 异常只在显式 CHECK 点被检测

  ③ 为什么零页范围内的地址映射到 NullPointerException？
     答案方向: 约定——Java 规范中 null 引用的访问应产生 NullPointerException。
     HotSpot 利用 OS 的零页保护（页表的第一页未映射）→ 任何对 null 对象字段的
     访问产生 SIGSEGV → si_addr 在[0, page_size)内 → 判断为 NPE。
     追问: 如果访问的是已映射但无效的地址呢？→ si_addr 不在零页范围内
     → 判断为 non-Java-level crash → fatal error → hs_err_pid.log + core dump。
```

### 4.5 ★★ 8 个代表性函数的深挖

```
问题（对每个函数问 4 个问题）:

  【1】JVM_StartThread (jvm.cpp ~L2920):
    a) JDK: java.lang.Thread.start0() native 声明
    b) 调用: os::create_thread → java_start → Thread::run()
    c) 新线程的 _thread_state 初始值？→ _thread_new → java_start 中设为 _thread_in_vm
    d) 如果移除 → 无法创建任何 Java 线程 → JVM 无法启动

  【2】JVM_GC (jvm.cpp):
    a) JDK: java.lang.Runtime.gc() / System.gc()
    b) 调用: Universe::heap()->collect(GCCause::_java_lang_system_gc)
    c) 和 G1Policy 自触发 GC 的区别？→ JVM_GC 走 VM_GC_Operation（force full gc）
    d) 如果移除 → System.gc() 变成空操作

  【3】JVM_DefineClass (jvm.cpp:957-962):
    a) JDK: ClassLoader.defineClass1()
    b) 调用: jvm_define_class_common(:894) → SystemDictionary::resolve_from_stream(:943)
    c) bytes 在哪被复制？→ 在 ClassFileParser 中复制到 C-heap ResourceObj
    d) 如果移除 → 不能加载任何类 → JVM 退化

  【4】JVM_CurrentTimeMillis (jvm.cpp ~L1180):
    a) JDK: java.lang.System.currentTimeMillis()
    b) 调用: os::javaTimeMillis() → gettimeofday / clock_gettime
    c) 为什么是 JVM_LEAF？→ 不碰 JVM 堆，纯 OS 调用
    d) 如果移除 → System.currentTimeMillis() 无实现

  【5】JVM_GetClassName (jvm.cpp):
    a) JDK: Class.getName() native
    b) 调用: InstanceKlass::external_name() → Symbol::as_C_string()
    c) 返回 String 在哪创建？→ java_lang_String::create_from_symbol → 在堆上分配
    d) 为什么不是 LEAF？→ 在堆上分配 String → 需要 GC safepoint 协调

  【6-8】: 从源码中再选 3 个有代表性的函数（如 JVM_MonitorWait → 涉及锁；JVM_GetSystemPackage → 不会导致副作用的查询；JVM_Halt → QUICK_ENTRY 的例子）
```

### 4.6 ★★ javaClasses.cpp:compute_offsets — JDK 对象字段偏移初始化

```
问题：
  ① compute_offsets() 在什么时候被调用？
     线索: javaClasses.cpp 中 compute_offsets 函数
     答案方向: JVM 初始化时（jni_handles_init 之后，SystemDictionary 加载之前）。
     一次性扫描 java.lang.Class、java.lang.Thread、java.lang.reflect.Method 等类
     → 取出每个字段的 offset → 存在静态 int 变量中。

  ② 为什么 JVM_StartThread 里 java_lang_Thread::thread_status() 不需要查 Method 对象？
     答案方向: java_lang_Thread 的字段偏移在 compute_offsets 中提前计算好
     → thread_status_offset 存为全局静态变量 → JVM_StartThread 直接通过
     threadObj->int_field(thread_status_offset) 读取 → 零 GC overhead、零方法调用。

  ③ 和 05-Reflection 的前瞻连接：
     答案方向: java_lang_reflect_Method::slot(reflected) → reflect->int_field(slot_offset)。
     这是 05-Reflection 中 "从 Method 对象找到对应的 C++ Method*"  的关键步骤。
     追问: slot 是什么？→ 在 InstanceKlass::methods() 数组中的索引。
```

### 4.7 ★ JNI RegisterNatives — JVM_* 如何绑定到 JDK Method 对象

```
问题：
  ① jni_RegisterNatives 的完整流程？
     线索: jni.cpp jni_RegisterNatives 实现
     答案方向: JDK 类调用 RegisterNatives(JNIEnv*, jclass, JNINativeMethod[],
     nMethods) → jni_RegisterNatives → 遍历每个 JNINativeMethod → Method::set_native_function
     → 写入 Method 对象的 _native_function 字段。
     追问: 为什么不直接用 dlsym？→ 太快——免去动态查找开销。JDK 知道每个 native 方法对应
     哪个 JVM_* 函数，注册表是编译时确定的。

  ② 哪些 JDK 类注册了 JVM_* 函数？
     答案方向: java.lang.System、java.lang.Class、java.lang.Thread、java.lang.ClassLoader
     等核心类。搜索 javaClasses.cpp / Thread.c / System.c 中的 registerNatives 调用。
```

## 五、文章结构

```
§〇 源文件清单（跨 prims + runtime + classfile + os，标注模块归属）

§一 ★★★ JVM_ENTRY/JVM_END 宏 — 170+ 函数的"统一解码器"
  ❓ 为什么需要宏而不是抽象基类或模板？
  ❓ ThreadInVMfromNative 的 RAII 生命周期精确区间是什么？
  1.1 完整宏展开图 — JVM_ENTRY → JVM_END 的所有注入代码（每行标注"为什么"）
  1.2 JVM_LEAF 展开对比 — 缺了什么、多了什么危险
  1.3 JVM_QUICK_ENTRY — JvmtiVMObjectAllocEventCollector 省略的代价
  1.4 ThreadInVMfromNative ctor/dtor — [01]§二 的直接应用
  1.5 HandleMarkCleaner — 为什么 JVM_ENTRY 内的 Handle 不会泄漏

§二 ★★ 异常传播机制 — TRAPS/CHECK/CHECK_NULL/SIGSEGV→NPE
  ❓ 为什么 CHECK_NULL 必须是宏？
  ❓ 为什么不用 C++ exception？
  2.1 TRAPS 类型展开 — THREAD = thread 的别名约定
  2.2 CHECK_NULL/CHECK_false/CHECK 的完整展开
  2.3 SIGSEGV→NPE — 信号处理器 + PC 劫持（不是 setjmp/longjmp！）
  2.4 忘记 CHECK 的定时炸弹 — 真实场景的 Bug 模式

§三 ★★★ 8 个代表性函数的分类深挖
  ❓ 为什么选这 8 个而不是其他？
  ❓ 每个函数对应 JDK 中哪个 native 声明？
  3.1 线程/同步: JVM_StartThread + JVM_MonitorWait
  3.2 GC/内存: JVM_GC + JVM_TotalMemory
  3.3 类加载: JVM_DefineClass + JVM_FindClassFromBootLoader
  3.4 工具/信息: JVM_CurrentTimeMillis(LEAF) + JVM_GetClassName(ENTRY)
  每函数: [JDK声明] → [入口宏类型] → [调用的子系统函数] → [返回值背后的oop]

§四 ★★ javaClasses.cpp — 字段偏移的"预计算"基础设施
  ❓ 为什么 JVM_StartThread 可以 obj->int_field(offset) 而不调 getter 方法？
  4.1 compute_offsets() 的初始化时机和计算流程
  4.2 java_lang_Class::as_Klass / java_lang_reflect_Method::slot — 05 的前置知识
  4.3 为什么 offset 是 static？— 所有对象共享同一个 JVM 实例

§五 ★ JNI RegisterNatives — JVM_* 函数如何绑定到 JDK 类
  ❓ 和 JNI API（jni.cpp 的 jni_XX 函数）是什么关系？
  5.1 jni_RegisterNatives 的 Method::set_native_function 流程
  5.2 哪些 JDK 核心类注册了 JVM_* 函数
  5.3 和 dlsym fallback 的关系 — 谁更快？为什么？

§六 ★ 和 [01][02] 的交叉验证
  ❓ ThreadInVMfromNative 的 ctor/dtor 在 [01]§二 已拆解——本文只讲"为什么每个入口都需要它"
  ❓ JNIHandles::make_local() 在 [02]§一 已拆解——本文只讲"JVM_* 函数怎么用 LocalRef 返回 oop"
  6.1 trans_from_native 在每个 JVM_ENTRY 入口的精确调用点
  6.2 trans_and_fence → transition_and_fence 在出口的完整步骤
       — 过渡状态 → serialize → block_if_requested → 最终状态
       — ★ x86 上 storestore 只是 compiler_barrier，不是硬件 fence
  6.3 JVM_ENTRY 内部创建的 Handle 和 [02] JNIHandleBlock 的关系

§七 GDB 验证 + 可证伪断言（≥12 条）
  断言 1: JVM_ENTRY 宏展开后的实际函数体（查看 jvm.cpp 预处理输出）
  断言 2: JVM_LEAF 中 ThreadInVMfromNative 是否被构造 → 不被构造
  断言 3: JVM_StartThread 新线程的 thread_state → _thread_in_vm (6)
  断言 4: JVM_GC 调用链上的 VM_Operation 入队 → VMThread::execute
  断言 5: CHECK_NULL 后的 early return → pending_exception != NULL
  断言 6: java_lang_reflect_Method::slot() 的 offset 值 → compile-time constant
  断言 7: JVM_ENTRY 内 HandleMarkCleaner 清理的 HandleArea 前后对比
  断言 8: JVM_CurrentTimeMillis LEAF 中的 Thread::current() 可用性验证
  断言 9: RegisterNatives 后 Method::native_function 指针验证
  断言 10: compute_offsets 的调用栈（JVM 初始化路径）
  断言 11: JVM_ENTRY 异常路径中 ThreadInVMfromNative dtor 的执行验证
  断言 12: extern "C" 的符号名验证（nm libjvm.so | grep JVM_StartThread）

  可证伪断言 1: 如果 JVM_LEAF 内调用 Universe::heap() → 无断言保护 → 静默错误
  可证伪断言 2: JVM_ENTRY 内忘记 CHECK_NULL → pending exception 传播到下一行
  可证伪断言 3: JVM_StartThread 不经过 trans_from_native → 直接设置 _thread_in_vm
  可证伪断言 4: compute_offsets 变更 JDK 字段顺序 → offset 重算 → GDB 观察变化
  可证伪断言 5: RegisterNatives 改写 native_function 后 → 不再走 dlsym 查找
```

## 六、写作要求

1. **★ `JVM_ENTRY` 宏展开是全文第一个核心交付物**：读者看完就能"解码"jvm.cpp 中任何一行 JVM_ENTRY 代码。展开必须精确到每行代码的来源（宏定义的第几行）。

2. **★ 8 个代表性函数必须有"JDK native 声明 → JVM_ENTRY → 子系统函数"的完整链路**。每个函数的分析不是"翻译这段代码做什么"，而是"这条调用链上的每个环节，之前学过的哪个概念在这里起作用"。

3. **★ 和 [01][02] 的交叉引用必须精确到节**：[01]§二 `ThreadInVMfromNative` ctor/dtor、[01]§一 `JavaThreadState` 枚举、[02]§一 `JNIHandles::make_local()`、[02]§二 `jobject = oop*`。

4. **★ 和 [05-Reflection] 的前瞻连接**：`jvm_get_method_common` → 反射的 Method 查找机制；`java_lang_reflect_Method::slot` → oops 层的字段偏移访问。

5. **★ HandleMarkCleaner / ResourceMark 的"如果不写会怎样"必须给出具体场景**——不只是"内存泄漏"四个字，而是"在 JVM_ENTRY 内创建了 100 个 Handle，进入 JVM_END 后这些内存依然在 HandleArea 中，下次 GC 扫描线程 oops_do 时会扫到这些已死的 Handle，虽然不会造成 use-after-free（Handle 指向的对象还活着），但 HandleArea 越来越大直到 OOM"。

6. **★ GDB 验证必须可执行**：每条断言给出具体的 GDB 命令和预期输出。"预处理输出"断言应给出具体的 `g++ -E jvm.cpp` 命令。

## 七、输出格式

- Markdown 文件，命名为 `04-JVM-Entry-Points.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/09-native-interface/`
- 元信息头（标准环境 + 源文件清单 + 前置 [09-01][09-02] + 阅读收益 + "所有 JVM 入口的统一协议"的说明）
