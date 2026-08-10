# 04-JVM-Entry-Points — JVM_ENTRY/JVM_LEAF 宏系统、170+ JVM_* 函数的统一门面、ThreadInVMfromNative 在每个入口的 RAII 角色

> **元信息**
> - 标准环境：OpenJDK 11 slowdebug build，`-Xms8g -Xmx8g -XX:+UseG1GC`，64-bit Linux x86
> - 跨模块说明：`runtime/`（interfaceSupport 宏定义 + 状态转换）+ `prims/`（jvm.cpp 全部入口 + jni.cpp RegisterNatives）+ `classfile/`（javaClasses.cpp 字段偏移）+ `os/`（os_linux.cpp 线程创建）
> - 前置文档：[09-01 ThreadState-NativeTransition]（控制面 — ThreadInVMfromNative ctor/dtor）、[09-02 JNI-Reference-Management]（数据面 — jobject/oop、JNIHandles）
> - 前瞻文档：[09-05 Reflection]（jvm_get_method_common + slot offset）
> - 地位：09 阶段架构文档，阅读顺序第三
> - 阅读收益：获得阅读 `jvm.cpp` 3834 行代码的"统一解码器"——看懂任何一个 `JVM_ENTRY` 宏展开后的全部注入代码。理解 170+ 个 JVM_* 函数如何通过同一套宏系统完成 native→VM 状态转换、Handle 生命周期管理、异常传播。掌握 JVM_StartThread 为何绕过 JVM_ENTRY 的常规路径、SIGSEGV 如何通过信号处理器+PC 劫持转成 NullPointerException

---

## §〇 源文件清单（跨 prims + runtime + classfile + os）

| # | 文件 | 路径 | 模块 | 核心宏/函数（已验证行号） | 本文角色 |
|---|------|------|------|---------------------|---------|
| 1 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | runtime | `JVM_ENTRY`(:558-565)、`JVM_LEAF`(:588-592)、`JVM_QUICK_ENTRY`(:578-585)、`JVM_ENTRY_NO_ENV`(:568-575)、`JVM_END`(:603)、`VM_ENTRY_BASE`(:424-429)、`VM_LEAF_BASE`(:405-411)、`ThreadInVMfromNative`(:266-274)、`transition_from_native`(:158-177)、`transition_and_fence`(:136-148) | ★★★ 宏系统定义 — 全文的"解码器" |
| 2 | `jvm.cpp` | `src/hotspot/share/prims/jvm.cpp` | prims | JVM_StartThread(:2890-2981)、JVM_GC(:461-466)、JVM_DefineClass、JVM_CurrentTimeMillis、JVM_GetClassName、JVM_MonitorWait(:616-630)、JVM_TotalMemory(:481-485)、JVM_Halt(:455-458)、JVM_FindClassFromBootLoader(:771-791)、jvm_get_method_common、全部 170+ 入口 | ★★★ 所有 JVM_* 函数的实现 |
| 3 | `jvm.hpp` | `src/hotspot/share/prims/jvm.hpp` | prims | JVM_* 函数声明 + `JVMWrapper` 宏(:258-261) | ★★ 公共 API 声明 |
| 4 | `javaClasses.cpp` | `src/hotspot/share/classfile/javaClasses.cpp` | classfile | `compute_offsets`、`java_lang_reflect_Method::slot`(:2773)、`java_lang_Class::as_Klass`(:1386) | ★★ 字段偏移预计算 |
| 5 | `javaClasses.hpp` | `src/hotspot/share/classfile/javaClasses.hpp` | classfile | `java_lang_Thread::_thread_status_offset`(:359)、`java_lang_reflect_Method::slot_offset`(:601) | ★★ 静态偏移量定义 |
| 6 | `jni.cpp` | `src/hotspot/share/prims/jni.cpp` | prims | `jni_RegisterNatives`(:3046-3083) | ★★ JVM_* 注册到 Method 对象的 JNI 入口 |
| 7 | `os_linux.cpp` | `src/hotspot/os/linux/os_linux.cpp` | os | `os::create_thread`(:965-1098)、`thread_native_entry`(:885-963) | ★★ 线程创建的 OS 接口 |
| 8 | `thread.cpp` | `src/hotspot/share/runtime/thread.cpp` | runtime | `JavaThread::run()`(:1927-1941)、`Thread::call_run()`(:427) | ★★ 线程启动入口 — `_thread_new`→`_thread_in_vm` |
| 9 | `handles.hpp` | `src/hotspot/share/runtime/handles.hpp` | runtime | `HandleMark`(:240-270)、`HandleMarkCleaner`(:305-311)、`Handle`(:64-100) | ★ Handle 作用域 |
| 10 | `exceptions.hpp` | `src/hotspot/share/utilities/exceptions.hpp` | utilities | `TRAPS`(:198)、`CHECK_NULL`(:225)、`HAS_PENDING_EXCEPTION`(:217)、`CHECK`(:220) | ★★ 异常传播宏 |

---

## §一 ★★★ JVM_ENTRY/JVM_END 宏 — 170+ 函数的"统一解码器"

### ❓ 为什么需要宏而不是抽象基类或模板？

`jvm.cpp` 中有 170+ 个函数，每个都需要在进入时做完全相同的四件事：① 从 `JNIEnv*` 取出 `JavaThread*`；② 创建 `ThreadInVMfromNative` 切换线程状态；③ 创建 `HandleMarkCleaner` 管理 Handle 生命周期；④ 声明 `THREAD` 别名用于异常传播。如果用 C++ 模板或基类：
- 模板无法处理 `extern "C"` 链接（JNI 要求的 C linkage）
- 基类需要在每个函数中显式创建、传递子对象，代码量不比宏少
- 宏保证一致性——170+ 函数不可能有某个忘了切状态或创建 HandleMark

**宏的本质**：它不是代码生成器，而是**协议强制器**——任何用 `JVM_ENTRY` 包裹的函数，自动获得正确的线程状态转换 + Handle 管理 + 异常传播管道，零犯错空间。

### 1.1 完整宏展开图 — JVM_ENTRY → JVM_END 的所有注入代码

以 `JVM_ENTRY(jobject, JVM_GetClassName(JNIEnv *env, jclass cls))` 为例：

```cpp
// ===== JVM_ENTRY 部分（interfaceSupport.inline.hpp:558-565）=====
// L558: #define JVM_ENTRY(result_type, header)
// L559: extern "C" {                                          // ① C linkage — JNI 要求，否则 dlsym 找不到
// L560:   result_type JNICALL header {                        // ② 函数签名 + JNICALL 调用约定
// L561:     JavaThread* thread=JavaThread::thread_from_jni_environment(env);
//      │                                                       ③ ★ 从 JNIEnv* 反推 JavaThread*
//      │                                                          实现: (JavaThread*)((intptr_t)env - jni_environment_offset)
//      │                                                          为什么必须：env 是调用者传进来的，不是 TLS
//      │                                                          JVM_ENTRY_NO_ENV 则用 JavaThread::current() (TLS)
// L562:     MACOS_AARCH64_ONLY(ThreadWXEnable __wx(WXWrite, thread));
//      │                                                       ④ macOS ARM W^X 策略：临时允许写可执行页
// L563:     ThreadInVMfromNative __tiv(thread);
//      │                                                       ⑤ ★★★ RAII 对象 — ctor: _native(4)→_native_trans(5)→_vm(6)
//      │                                                          dtor: _vm(6)→_vm_trans(7)→_native(4)
//      │                                                          [01]§二 已完整拆解
// L564:     debug_only(VMNativeEntryWrapper __vew;)
//      │                                                       ⑥ ASSERT only: GCALotAtAllSafepoints 时触发 GC
// L565:     VM_ENTRY_BASE(result_type, header, thread)
//      │
//      └── VM_ENTRY_BASE 展开 (L424-429):
//            TRACE_CALL(result_type, header)                  ⑦ 统计：_number_of_calls++ + CountRuntimeCalls >0 时计数
//            HandleMarkCleaner __hm(thread);                   ⑧ ★★★ Handle 作用域 — 入口 push()，出口 pop_and_restore()
//            Thread* THREAD = thread;                          ⑨ TRAPS 别名 — THREAD 和 thread 指向同一对象
//            os::verify_stack_alignment();                     ⑩ 栈对齐检查（assert only）
//            /* begin of body */                               ⑪ — 宏结束，用户代码开始 —

// ===== 用户代码（以 JVM_GetClassName 为例）=====
//     JVMWrapper("JVM_GetClassName");         // ⑫ ★ 函数体内显式写的 trace 标记（不是宏注入！）
//     Klass* k = ...                          // ⑬ 实际业务逻辑
//     return (jstring) JNIHandles::make_local(env, result);  // ⑭ 把 oop 转成 jobject

// ===== JVM_END 部分（L603）=====
// #define JVM_END } }                          ⑮ 闭合函数体和 extern "C" 块
//                                                → __tiv dtor 按声明逆序执行:
//                                                  ① __hm dtor → HandleMark::pop_and_restore()
//                                                  ② __tiv dtor → trans_and_fence(_vm, _native)
```

**展开后的完整等效代码**：

```cpp
extern "C" {                                                              // ① C linkage
  jobject JNICALL JVM_GetClassName(JNIEnv *env, jclass cls) {            // ② 函数签名
    JavaThread* thread = JavaThread::thread_from_jni_environment(env);   // ③ 取线程
    MACOS_AARCH64_ONLY(ThreadWXEnable __wx(WXWrite, thread);)            // ④ 条件编译
    ThreadInVMfromNative __tiv(thread);     // ★⑤ 状态: _native → _vm
    debug_only(VMNativeEntryWrapper __vew;)  // ⑥ ASSERT 检查
    /* VM_ENTRY_BASE begin */
    InterfaceSupport::_number_of_calls++;    // ⑦ 计数器
    HandleMarkCleaner __hm(thread);          // ★⑧ Handle 作用域
    Thread* THREAD = thread;                 // ⑨ TRAPS 别名
    os::verify_stack_alignment();            // ⑩ 栈检查
    /* user code begin */
    JVMWrapper("JVM_GetClassName");          // ⑫ 显式 trace（仅 ASSERT 下有效）
    // ... 业务逻辑 ...
    /* user code end */
    /* VM_ENTRY_BASE end */
    /* ★ ~__hm() → pop_and_restore HandleMark */       // ⑧ dtor
    /* ★ ~__tiv() → trans_and_fence(_vm, _native) */   // ⑤ dtor
  }                                                                    // 闭函数体
}                                                                      // 闭 extern "C"
```

### 1.2 每条注入代码的"为什么不能少"

| 注入项 | 宏来源 | 如果省略的后果 | 为什么必须 |
|--------|--------|---------------|-----------|
| `extern "C"` | JVM_ENTRY L559 | `nm libjvm.so \| grep JVM_StartThread` 返回 `_Z15JVM_StartThreadP7JNIEnv...`（C++ mangled name），`dlsym(handle, "JVM_StartThread")` 失败 → JDK 无法找到 native 实现 → `UnsatisfiedLinkError` | JNI 规范要求 C linkage。JVM_StartThread 是通过 `RegisterNatives` 注册的（不查 dlsym），但 JVM_LEAF 函数如 JVM_GetVersion **真的**走 dlsym 查找 |
| `JavaThread* thread` | JVM_ENTRY L561 | 无法知道当前是哪个 Java 线程，后续所有操作都基于 `thread` 对象（阻塞 safepoint、访问 HandleArea、设置 pending exception） | `thread_from_jni_environment(env)` 利用 `JNIEnv` 结构体在 `JavaThread` 对象内部的固定偏移。这比 `Thread::current()` 快（不用 TLS 查找）。`JVM_ENTRY_NO_ENV` 变体用 `JavaThread::current()`（TLS），因为那些函数没有 `JNIEnv*` 参数 |
| `ThreadInVMfromNative __tiv` | JVM_ENTRY L563 | 线程保持在 `_thread_in_native(4)` 中操作 JVM 内部对象 → GC 可能正在移动这些对象 → 读野指针。或者触发 `current_thread_in_native()` 断言（如 `make_global` L103）→ assert 崩溃 | [01]§二：`_thread_in_native` 中线程被 safepoint 视为"已到达"→ GC 自由移动对象。必须切换到 `_thread_in_vm` 才能安全访问 JVM 堆 |
| `HandleMarkCleaner __hm` | VM_ENTRY_BASE L426 | JVM_ENTRY 内创建的 Handle 永久占据线程的 HandleArea → 每个 JVM 入口调用增加 ~N 个 Handle → HandleArea 只增不减 → 最终 OOM。即使对象已无用，GC 仍扫描它们 | Handle 在 `HandleArea`（Arena）中分配，Arena 只记录 top 指针。HandleMarkCleaner ctor 调用已有 HandleMark 的 `push()` 保存当前 top，dtor 调用 `pop_and_restore()` 回滚。不写 → Arena 永远不回滚 |
| `Thread* THREAD = thread` | VM_ENTRY_BASE L427 | 无法传递给需要 `TRAPS` 签名的子函数。`THREAD` 是 `thread` 的别名 | `TRAPS` 展开为 `Thread* THREAD`。子函数通过 `THREAD->has_pending_exception()` 检查和 `THREAD->set_pending_exception()` 设置异常 |

### ❓ ThreadInVMfromNative 的 RAII 生命周期精确区间是什么？

```
JVM_ENTRY 开始
  │
  ├─ JavaThread* thread = ...       // L561
  ├─ ThreadInVMfromNative __tiv     // L563 ctor: _native→_native_trans→poll→_vm   ★ 进入
  ├─ HandleMarkCleaner __hm          // L426 ctor: push HandleMark
  ├─ Thread* THREAD = thread        // L427
  │
  ├─ [用户代码]                      // ← 整个业务逻辑在此区间内
  │    ├─ 可以创建 Handle（__hm 保护）
  │    ├─ 可以访问 JVM 堆（__tiv 保护）
  │    ├─ 可以通过 CHECK_NULL 传播异常（THREAD 可用）
  │    └─ 可以用 JNIHandles::make_local 返回 jobject
  │
  ├─ [用户代码结束]
  │
  ├─ ~__hm()                         // dtor: pop_and_restore HandleMark   ★ 释放 Handle
  └─ ~__tiv()                        // dtor: _vm→_vm_trans→_native       ★ 退出
JVM_END
```

**关键**：`__tiv` 的 ctor 在 `__hm` 之前执行，dtor 在 `__hm` 之后执行。这保证了 Handle 操作全程在 `_thread_in_vm` 中进行（ctor 先切状态，dtor 后恢复）。

### 1.3 JVM_LEAF 展开对比 — 缺了什么、多了什么危险

```
JVM_ENTRY 展开（L558-565）:               JVM_LEAF 展开（L588-592）:
  extern "C" {                              extern "C" {
    result_type JNICALL header {              result_type JNICALL header {
      thread_from_jni_environment(env)         VM_Exit::block_if_vm_exited();  ← ① 多：VM 退出检查
      ThreadInVMfromNative __tiv      ← ★     VM_LEAF_BASE(...)              ← ★ 展开
      VM_ENTRY_BASE(...)              ← ★         TRACE_CALL
        TRACE_CALL                                debug_only(NoHandleMark)    ← ② 禁止 Handle！
        HandleMarkCleaner              ← ★        os::verify_stack_alignment
        Thread* THREAD                ← ★         /* begin of body */
        os::verify_stack_alignment
```

**JVM_LEAF 缺少的关键项**：

| 缺失项 | 为什么可以缺 | 如果错误使用了会导致什么 |
|--------|------------|----------------------|
| `ThreadInVMfromNative` | LEAF 函数承诺不碰 JVM 堆，在 `_thread_in_native` 中安全 | 如果 LEAF 内访问了 JVM 堆上的 oop → GC 可能正在移动此对象 → 读野指针。**没有断言保护**（`current_thread_in_native()` 断言只存在于需要 `_thread_in_vm` 的函数中） |
| `HandleMarkCleaner` | LEAF 不创建 Handle | 如果在 LEAF 中 `HandleMark hm` → `assert(_handle_mark_nesting > 0)` 失败（`NoHandleMark` 在 ctor 中递减了 nesting）→ crash |
| `Thread* THREAD` | LEAF 不传播异常 | 如果 LEAF 中 `CHECK_NULL` → 编译错误（`THREAD` 未定义） |

**JVM_LEAF 添加的关键项**：

| 添加项 | 作用 | 来源 |
|--------|------|------|
| `VM_Exit::block_if_vm_exited()` | 如果 JVM 正在退出，阻塞调用者直到退出完成 | 防止 LEAF 函数在 JVM 退出过程中访问已释放资源 |
| `debug_only(NoHandleMark __hm)` | 禁止在此作用域内创建 Handle | `NoHandleMark` ctor 递减 `_handle_mark_nesting`，任何 Handle 构造都会 assert 失败 |

### ❓ JVM_LEAF 的危险 — 具体场景

**场景**：有人在一个 LEAF 函数中调用了 `Universe::heap()->is_in_reserved(obj)`：

```cpp
JVM_LEAF(jboolean, JVM_SomeLeafFunction(JNIEnv *env, jclass cls, jobject obj))
    // 线程在 _thread_in_native(4) 中
    oop o = JNIHandles::resolve(obj);           // ← 读取 oop*
    // GC 此时发生？→ oop 被移动 → o 变成野指针
    if (Universe::heap()->is_in_reserved(o)) {   // ← 没有断言保护！
        // 这段代码在 _thread_in_native 中执行 — 静默错误
    }
JVM_END
```

**为什么比 `JVM_ENTRY` 中同样的错误更危险？** `JVM_ENTRY` 有 `ThreadInVMfromNative` → 线程在 `_thread_in_vm` 中。如果 `_thread_in_vm` 中尝试访问已被 GC 移动的 oop → 虽然也可能出错，但至少 `make_global` 此类函数有 `current_thread_in_native()` 断言做防御。LEAF 中完全没有这类保护——**全凭约定和 code review**。

### 1.4 JVM_QUICK_ENTRY — 和 JVM_ENTRY 的唯一差异

```cpp
// JVM_QUICK_ENTRY (L578-585) vs JVM_ENTRY (L558-565)
// 唯一差异：JVM_QUICK_ENTRY 展开 VM_QUICK_ENTRY_BASE 而非 VM_ENTRY_BASE

// VM_QUICK_ENTRY_BASE (L434-439):
//   TRACE_CALL
//   debug_only(NoHandleMark __hm)     ← 禁止创建 Handle！
//   Thread* THREAD = thread
//   os::verify_stack_alignment()

// vs VM_ENTRY_BASE (L424-429):
//   TRACE_CALL
//   HandleMarkCleaner __hm(thread)    ← 允许创建 Handle
//   Thread* THREAD = thread
//   os::verify_stack_alignment()
```

**差异总结**：QUICK_ENTRY 与 ENTRY 的**所有其他注入相同**（都有 `ThreadInVMfromNative`、都有 `THREAD`），只是不创建 `HandleMarkCleaner`。使用场景：不需要分配 Handle 的入口，如 `JVM_Halt`（直接 exit，不返回）。

**实际使用**：当前 `jvm.cpp` 中没有使用 `JVM_QUICK_ENTRY`（搜索结果为 0 匹配），`JVM_Halt` 用的是 `JVM_ENTRY_NO_ENV`。这个宏是为未来扩展预留的。

### ❓ 为什么 `JVM_Halt` 不创建 Handle 但用了 `JVM_ENTRY_NO_ENV`？

```cpp
// jvm.cpp:455-458
JVM_ENTRY_NO_ENV(void, JVM_Halt(jint code))
    before_exit(thread);   // 清理
    vm_exit(code);         // 直接 exit，不返回
JVM_END
```

`JVM_Halt` 内部不创建 Handle，但用了 `JVM_ENTRY_NO_ENV`（展开为完整 ENTRY）。因为 `before_exit(thread)` 内部可能访问 JVM 堆对象 → 需要在 `_thread_in_vm` 中。如果用 LEAF → 在 `_thread_in_native` 中执行 exit 逻辑 → 可能访问已被 GC 释放的对象。

### 1.5 JVM_ENTRY_NO_ENV — 不需要 JNIEnv 参数的变体

```cpp
// JVM_ENTRY_NO_ENV (L568-575):
// 和 JVM_ENTRY 唯一的差异：
//   JVM_ENTRY:                JavaThread* thread=JavaThread::thread_from_jni_environment(env);
//   JVM_ENTRY_NO_ENV:         JavaThread* thread = JavaThread::current();
```

适用场景：函数签名中没有 `JNIEnv*` 参数。如 `JVM_GC(void)`、`JVM_TotalMemory(void)`、`JVM_Halt(jint code)`、`JVM_ActiveProcessorCount(void)`。它们通过 `JavaThread::current()` → TLS 直接获取当前线程。

### 1.6 ThreadInVMfromNative — JVM_ENTRY 上下文中的独特角色

`ThreadInVMfromNative` 的 ctor/dtor 三段式（设窗口→fence→poll→set_state，以及 dtor 的 trans_and_fence）已在 [01]§二 完整拆解。本文只讲它在 JVM_ENTRY 上下文中的两个独特角色：

**① 入口 poll safepoint — 入口和出口各一次检查**

`ThreadInVMfromNative` ctor 中 `transition_from_native` 的 `poll()` **主动探测** safepoint（因为线程刚从 native 回来，对 JVM 全局状态一无所知）。而 dtor 中 `transition_and_fence` 的 `block_if_requested()` **被动确认**——线程在 VM 中执行时 VMThread 可能 arm 了它的 poll flag，dtor 在退出前检查。这意味着 JVM_ENTRY 完成的每次 native→VM→native 往返都经过了**两次** safepoint 检查：入口 poll + 出口 block_if_requested。

**② 出口 block_if_requested — 线程不会带着中间态离开 VM**

dtor 中的 `transition_and_fence(_thread_in_vm, _thread_in_native)` 在步骤③调用 `block_if_requested(thread)` 之后才 `set_thread_state(to)`——如果 VMThread 正在发起 safepoint 并已 arm 了此线程的 poll flag，线程在**返回 native 前**被阻塞（进入 `_thread_blocked`）。这保证线程永远不会带着 `_thread_in_vm_trans`(7) 离开 VM——要么完整回到 `_thread_in_native`(4)，要么停在 `_thread_blocked`(10) 等 safepoint 结束。

> 完整的 ctor/dtor 状态转换链（三步序列、fence 类型、poll/block_if_requested 的语义差异）已在 [01]§二 中逐行走读，此处不再重复。本节只说明这些转换在 JVM_ENTRY 宏包裹下的实际触发时机。

### 1.7 HandleMarkCleaner — 为什么 JVM_ENTRY 内的 Handle 不会泄漏

`HandleMarkCleaner`（`handles.hpp:305-311`）：

```cpp
class HandleMarkCleaner: public StackObj {
 private:
  Thread* _thread;
 public:
  inline HandleMarkCleaner(Thread* thread);   // ctor: push()
  inline ~HandleMarkCleaner();                // dtor: pop_and_restore()
};
```

它不是自己创建 HandleMark——它依赖于已有的 HandleMark（在 `JavaCalls::call_helper` 中创建，或线程初始化时创建）。

**具体场景**（如果不写 HandleMarkCleaner）：

```
JVM_ENTRY_NO_ENV(void, JVM_GC(void))
    // 没有 HandleMarkCleaner!
    Handle obj(THREAD, some_oop);           // ★ 分配 Handle → Arena top++
    Handle obj2(THREAD, some_other_oop);    // ★ 再分配 → Arena top++
    Universe::heap()->collect(...);
    // 函数返回 → obj 和 obj2 的 Handle 仍在 Arena 中
JVM_END

后果：
  1. Arena top 增加了 2 个 oop* 的空间
  2. 线程下次调用 JVM_ENTRY 创建的 Handle 继续往上堆
  3. 100 次 JVM_GC 调用后 → 200 个死 Handle 占着 Arena
  4. GC 扫描线程 oops_do 时扫描这些死 Handle → 它们指向的对象还活着 → GC 不回收
  5. Arena 持续增长直到 OOM
```

**HandleMarkCleaner 的 dtor** 调用当前 HandleMark 的 `pop_and_restore()` → 回滚 Arena top 到 `push()` 时的位置 → 之后新 Handle 覆盖旧位置。

---

## §二 ★★ 异常传播机制 — TRAPS/CHECK/CHECK_NULL/SIGSEGV→NPE

### 2.1 TRAPS 类型展开 — THREAD = thread 的别名约定

```cpp
// exceptions.hpp:198
#define THREAD __the_thread__
#define TRAPS  Thread* THREAD

// interfaceSupport.inline.hpp:427 (VM_ENTRY_BASE)
Thread* THREAD = thread;

// 所以 JVM_ENTRY 展开后：
// JavaThread* thread = JavaThread::thread_from_jni_environment(env);  // 原始变量
// Thread* THREAD = thread;                                             // TRAPS 别名
```

**`THREAD` 和 `thread` 是同一个对象的两个指针变量**——指向同一个 `JavaThread` 实例。区别是**语义约定**：

| 变量 | 类型 | 用途 | 使用场景 |
|------|------|------|---------|
| `thread` | `JavaThread*` | 当前线程就是 JavaThread 时使用 | 访问 JavaThread 特有方法（`thread_state()`、Java frame 操作） |
| `THREAD` | `Thread*` | 传给需要 `TRAPS` 签名的子函数 | 子函数通过 `THREAD->set_pending_exception()` 设置异常 |

`THREAD` 是 `Thread*`（基类指针），因为被调函数只需要 `Thread` 接口的 `has_pending_exception()` 和 `set_pending_exception()`，不需要 JavaThread 的全部功能。

### 2.2 CHECK_NULL/CHECK_false/CHECK 的完整展开

```cpp
// exceptions.hpp:220-226
#define CHECK              THREAD); if (HAS_PENDING_EXCEPTION) return       ; (void)(0
#define CHECK_(result)     THREAD); if (HAS_PENDING_EXCEPTION) return result; (void)(0
#define CHECK_0            CHECK_(0)
#define CHECK_NH           CHECK_(Handle())
#define CHECK_NULL         CHECK_(NULL)
#define CHECK_false        CHECK_(false)
#define CHECK_JNI_ERR      CHECK_(JNI_ERR)
```

**以 `CHECK_NULL` 的实际使用为例**：

```cpp
// 源码写法（jvm.cpp:782）:
TempNewSymbol h_name = SymbolTable::new_symbol(name, CHECK_NULL);
Klass *k = SystemDictionary::resolve_or_null(h_name, CHECK_NULL);

// 宏展开后（CHECK_NULL = CHECK_(NULL)）:
TempNewSymbol h_name = SymbolTable::new_symbol(name, THREAD);
if (HAS_PENDING_EXCEPTION) return NULL;
(void)(0);
Klass *k = SystemDictionary::resolve_or_null(h_name, THREAD);
if (HAS_PENDING_EXCEPTION) return NULL;
(void)(0);
```

### ❓ 为什么 CHECK_NULL 必须是宏？

因为**它包含 `return` 语句**。如果是函数：

```cpp
// 假设 CHECK_NULL 是函数（错误设计）:
void check_null(Thread* THREAD) {
    if (THREAD->has_pending_exception()) return; // ← 只退出 check_null 函数
}
// 调用方:
Klass *k = SystemDictionary::resolve_or_null(h_name, THREAD);
check_null(THREAD);  // ← 即使有异常, 只会退出 check_null, 不会退出当前 JVM_ENTRY 函数!
// 继续执行 — 在有 pending exception 的状态下操作 JVM 对象 → 崩溃
```

宏展开到调用方作用域中，`return` 正确退出当前 `JVM_ENTRY` 函数。

### 2.3 ❓ 为什么不用 C++ exception？

三重原因：

**① JNI 规范禁止**：异常不能穿过 native 帧。如果 JVM_ENTRY 函数内部 throw C++ exception，它会在 `extern "C"` 边界（native 调用方）产生未定义行为。JNI 规范第 2.9 节明确规定："Exceptions raised in native code are not handled by the JVM."

**② HandleMark 泄漏**：C++ exception unwinding 会销毁栈上的局部变量，但 `HandleMarkCleaner` 的 dtor 该不该被调用？如果 unwinding 跳过 dtor（取决于编译器实现）→ HandleArea 永远不回滚。如果调用了 dtor → 异常被传播，但调用方的 CHECK_NULL 期望的是线程上的 `_pending_exception`，不是 C++ exception。

**③ 信号处理上下文不安全**：SIGSEGV→NPE 的转换在信号处理器中发生（见 §2.4），信号处理器中不能 throw C++ exception（未定义行为）。

### 2.4 ★★ SIGSEGV→NPE — 信号处理器 + PC 劫持（不是 setjmp/longjmp！）

**机制总览**（`os_linux_x86.cpp` 的 `JVM_handle_linux_signal()`）：

```
1. SIGSEGV 发生 → 信号处理器被调用
2. 判断 si_addr（故障地址）
3. 如果 si_addr ∈ [0, os::vm_page_size())：
   ├─ 这是空指针访问 → 应产生 Java NullPointerException
   ├─ 构造 NPE → 设置 thread->set_pending_exception(npe_oop)
   └─ ★ 修改 ucontext 的指令指针 → StubRoutines::forward_exception_entry()
        → 信号返回后 CPU 从 forward_exception_entry 继续执行
4. 如果 si_addr 不在识别的范围内：
   └─ os::abort() → core dump + hs_err_pid.log
```

**为什么不是 setjmp/longjmp？**

setjmp 需要预先在每条可能出错的指令前设置跳转点。但空指针访问可以发生在任意指令上——`obj->field`、`array[index]`、`InterfaceSupport::serialize_thread_state_with_handler` 内部的内存访问等。任何地方都可能触发 SIGSEGV，无法预先放置 setjmp。

信号处理 + PC 劫持更灵活：**无需在每条指令前设置跳转点**，OS 自动在任何 SIGSEGV 触发时调用处理器，处理器修改指令指针后再返回——CPU 无缝跳转到异常处理代码。

**JVM_ENTRY 宏内部没有设置异常捕获**——JVM_ENTRY 本身不设信号处理或 setjmp。异常传播靠 TRAPS/CHECK 协议：
1. 信号处理器设置了 `pending_exception` → 修改 PC
2. CPU 从 `forward_exception_entry` 继续执行 → 此时线程仍在 `_thread_in_vm` 中
3. 上一层的 CHECK_NULL 检测到 `HAS_PENDING_EXCEPTION` → early return
4. 逐层返回直到 JNI 调用方 → Java 层抛出 NullPointerException

**线程状态视角**：SIGSEGV 发生时线程在 `_thread_in_vm` 中（因为 JVM_ENTRY 入口已经创建了 `ThreadInVMfromNative`）。信号处理器中 `thread->set_pending_exception()` 不需要状态转换——线程已经在 VM 中。

### 2.5 忘记 CHECK 的定时炸弹 — 真实场景的 Bug 模式

```
模式 1: 忘记检查，继续执行
  Klass* k = SystemDictionary::resolve_or_null(name, THREAD); // 设置了 pending exception
  // 忘记 CHECK_NULL!
  k->java_mirror();  // ← k 是 NULL，NULL->java_mirror() → SIGSEGV → 不是 NPE（不在零页范围内）→ crash

模式 2: 忘记检查，有副作用
  Handle obj = ...;
  ObjectSynchronizer::wait(obj, ms, CHECK);   // CHECK 只对 void 函数有效（return;）
  // 这里用了错误宏：wait 用 CHECK 没问题（返回 void）
  // 但如果有人改成 CHECK_NULL → 编译错误（void 函数不能 return NULL）

模式 3: 异常被吞掉，状态不一致
  // 设置了 pending exception 但没有检查
  // 继续修改了全局状态（如加载了一个类、分配了一个对象）
  // JVM_END 出口没有 HANDLE_PENDING_EXCEPTION（JVM_END 是纯 } })
  // → 异常保留在线程上 → 下个 JNI 调用可能在不同上下文中触发此异常
```

---

## §三 ★★★ 8 个代表性函数的分类深挖

### ❓ 为什么选这 8 个而不是其他？

- 覆盖 4 个分类（线程/同步、GC/内存、类加载、工具/信息）
- 覆盖 3 种宏变体（JVM_ENTRY、JVM_ENTRY_NO_ENV、JVM_LEAF）
- 覆盖不同的返回值类型（void、jlong、jobject、jclass、jstring）
- 覆盖不同的异常传播模式（CHECK、CHECK_NULL、CHECK_false）
- 覆盖"有副作用的操作"和"纯查询"两种语义

### 3.1 线程/同步类

#### 【1】JVM_StartThread（jvm.cpp:2890-2981）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_ENTRY(void, JVM_StartThread(JNIEnv* env, jobject jthread))` |
| **JDK native 声明** | `java.lang.Thread.start0()` (Thread.java) |
| **核心调用链** | `JVM_StartThread` → `new JavaThread(&thread_entry, sz)` → `Thread::start(native_thread)` → `os::create_thread` → `pthread_create` → `thread_native_entry` → `Thread::call_run()` → `JavaThread::run()` |
| **返回值** | void（无返回值，通过创建线程产生副作用） |
| **如果移除** | Java 无法创建任何线程 → JVM 无法运行 |

**追问 (b)：为什么新线程的 `_thread_state` 初始值是 `_thread_in_vm` 而不是 `_thread_in_Java`？**

新线程的第一次执行在 `thread_native_entry`（OS 层入口）→ `Thread::call_run()` → `JavaThread::run()`：

```cpp
// thread.cpp:1927-1941 — JavaThread::run()
void JavaThread::run() {
    this->initialize_tlab();            // 初始化 TLAB
    this->record_base_of_stack_pointer();
    this->create_stack_guard_pages();   // 创建栈保护页
    this->cache_global_variables();

    // ★ 关键：JavaThread ctor 初始为 _thread_new(2)
    // 这里显式转换到 _thread_in_vm(6)
    ThreadStateTransition::transition_and_fence(this, _thread_new, _thread_in_vm);
    // ...
    thread_main_inner();  // 最终调用 thread_entry → Java run() 方法
}
```

**为什么是 `_thread_in_vm` 而不是 `_thread_in_Java`？**

1. **新线程的 first frame 是 VM frame**（不是 Java frame 也不是 native frame）：TLS 还没初始化、TLAB 还没分配、栈保护页还没创建——这些都是 VM 内部操作，必须在 `_thread_in_vm` 中
2. **不需要经过 `trans_from_native`**：新线程不是从 native 代码返回的——它是由 `pthread_create` 创建的全新执行上下文，没有"前一个状态"
3. **不需要 poll safepoint**：新线程刚创建，不可能有 safepoint 已经 arm 了它的 poll flag

**★★★ JVM_StartThread 的"绕过"路径**：

`JVM_StartThread` 本身（调用者线程）正常走了 `JVM_ENTRY` 的完整流程（`ThreadInVMfromNative` → `_thread_in_vm`）。但**被创建的线程**完全绕过了 `JVM_ENTRY`——它的入口是 `thread_native_entry`，状态转换是 `_thread_new(2) → _thread_in_vm(6)`（通过 `transition_and_fence`，不是 `transition_from_native`）。

**追问 (c)：新线程的 HandleArea 在哪初始化？**

在 `Thread::Thread()` 构造函数中。每个新线程有自己的 `HandleArea`（在 `Thread` 基类构造时初始化），独立的 HandleMark 栈。`JVM_StartThread` 调用者线程的 HandleArea 与被创建线程的 HandleArea 完全独立。

#### 【2】JVM_MonitorWait（jvm.cpp:616-630）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_ENTRY(void, JVM_MonitorWait(JNIEnv* env, jobject handle, jlong ms))` |
| **JDK native 声明** | `java.lang.Object.wait()` (Object.java) |
| **核心调用链** | `JVM_MonitorWait` → `Handle obj(THREAD, ...)` → `JavaThreadInObjectWaitState jtiows(thread, ...)` → `JvmtiExport::post_monitor_wait(...)` → `ObjectSynchronizer::wait(obj, ms, CHECK)` |
| **返回值** | void |
| **如果移除** | Java `Object.wait()` 无实现 → 所有基于 wait/notify 的并发代码失效 |

**追问 (b)：`JavaThreadInObjectWaitState` 是做什么的？**

它也是一个 RAII 对象——进入 wait 状态时设置 `JavaThread::_wait_state`，退出时恢复。JVMTI agent 通过读这个字段知道线程在等待哪个对象。这是 JVM_ENTRY 内嵌套 RAII 的另一个例子——`ThreadInVMfromNative` 负责状态转换，`JavaThreadInObjectWaitState` 负责 wait 语义。

**追问 (c)：`ObjectSynchronizer::wait(obj, ms, CHECK)` — CHECK 的作用**

`ObjectSynchronizer::wait` 内部可能因超时、中断、假唤醒而设置 `pending_exception`（如 `InterruptedException`）。`CHECK` 宏检测到此异常后 `return;`（void 函数），异常保留在 THREAD 上传播给调用者。

### 3.2 GC/内存类

#### 【3】JVM_GC（jvm.cpp:461-466）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_ENTRY_NO_ENV(void, JVM_GC(void))` |
| **JDK native 声明** | `java.lang.Runtime.gc()` / `java.lang.System.gc()` |
| **核心调用链** | `JVM_GC` → `if (!DisableExplicitGC)` → `Universe::heap()->collect(GCCause::_java_lang_system_gc)` |
| **返回值** | void |
| **如果移除** | `System.gc()` 变成空操作 |

**追问 (b)：作为 JVM 入口触发 GC 和 G1Policy 自主决定 GC 的区别**

| 维度 | JVM_GC（显式触发） | G1Policy 自主触发 |
|------|-------------------|-------------------|
| **触发条件** | Java 代码调用 `System.gc()` | Eden 区达到 `_young_list_target_length` 上限 |
| **GC Cause** | `_java_lang_system_gc` | `_g1_inc_collection_pause` 或 `_allocation_failure` |
| **VM_Operation** | `VM_GC_Operation`（强制 full GC） | `VM_G1CollectForAllocation` 或 `VM_G1IncCollectionPause` |
| **是否等待 safepoint** | 是 — `VM_GC_Operation::doit()` 需要所有线程在 safepoint | 是 — GC 永远在 safepoint 中进行 |
| **能否被禁用** | 可以通过 `-XX:+DisableExplicitGC` 禁用 | 不能禁用 |

**追问 (c)：`DisableExplicitGC` 检查的语义**

`JVM_GC` 内的 `if (!DisableExplicitGC)` 让用户可以通过 `-XX:+DisableExplicitGC` 禁止显式 GC。但即使 `DisableExplicitGC=true`，G1Policy 的自主 GC 仍然触发——因为那是保证内存可用性的，不是用户请求的。

#### 【4】JVM_TotalMemory（jvm.cpp:481-485）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_ENTRY_NO_ENV(jlong, JVM_TotalMemory(void))` |
| **JDK native 声明** | `java.lang.Runtime.totalMemory()` |
| **核心调用链** | `JVM_TotalMemory` → `Universe::heap()->capacity()` → `convert_size_t_to_jlong(n)` |
| **返回值** | jlong（堆容量，字节） |
| **如果移除** | `Runtime.totalMemory()` 返回 0 |

**追问 (b)：为什么用 JVM_ENTRY_NO_ENV 而不是 JVM_LEAF？**

`Universe::heap()->capacity()` 是在 `_thread_in_vm` 中安全的查询操作——它读 `CollectedHeap` 的内部字段，这些字段在 GC 期间可能被修改。在 `_thread_in_vm` 中读这些字段，GC 不能同时运行（safepoint 保护），所以读到的值是一致的。如果在 LEAF（`_thread_in_native`）中读 → GC 可能正在修改 → 读到不一致的值 → 可能返回负数。

### 3.3 类加载类

#### 【5】JVM_DefineClass（jvm.cpp:~957-962）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_ENTRY(jclass, JVM_DefineClass(JNIEnv *env, const char *name, jobject loader, const jbyte *buf, jsize len, jobject pd))` |
| **JDK native 声明** | `java.lang.ClassLoader.defineClass1()` |
| **核心调用链** | `JVM_DefineClass` → `jvm_define_class_common(...)` → `SystemDictionary::resolve_from_stream(...)` |
| **返回值** | jclass（新加载的 Class 对象的 LocalRef） |
| **如果移除** | 不能加载任何类 → JVM 退化 |

**追问 (b)：bytes 从 JNI 层传进来 — 在哪被复制？为什么必须复制？**

`buf` 是 `const jbyte*`——指向 native 调用者的内存。JVM 不能直接用它：
1. **GC 安全**：native 内存不在 JVM 堆上，GC 移动不会移动它。但 class 定义的过程可能触发 GC（如加载父类时），native buffer 可能已经被释放
2. **可靠性**：调用者可能在 `JVM_DefineClass` 返回前修改或释放 buffer
3. **持久性**：Klass 的某些属性（如常量池）需要在类生命周期内保持可访问

在 `ClassFileParser` 中复制到 C-heap（通过 `ResourceMark` 临时内存或 Metaspace 永久存储）。

**追问 (c)：`SystemDictionary::resolve_from_stream` 内部做了什么？**

- 从字节流解析 ClassFile → 创建 `InstanceKlass` → 验证 → 链接 → 初始化 → 注册到 SystemDictionary
- 整个过程在 `_thread_in_vm` 中进行 → 安全

#### 【6】JVM_FindClassFromBootLoader（jvm.cpp:771-791）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_ENTRY(jclass, JVM_FindClassFromBootLoader(JNIEnv* env, const char* name))` |
| **JDK native 声明** | `java.lang.ClassLoader.findBootstrapClass()` |
| **核心调用链** | `JVM_FindClassFromBootLoader` → `SymbolTable::new_symbol(name, CHECK_NULL)` → `SystemDictionary::resolve_or_null(h_name, CHECK_NULL)` → `JNIHandles::make_local(env, k->java_mirror())` |
| **返回值** | jclass（Class 对象的 LocalRef） |
| **如果移除** | 不能从 BootClassLoader 查找类 |

**追问 (c)：返回值的 jobject 背后是什么 oop？**

`k->java_mirror()` 返回的是 `java.lang.Class` 实例的 oop（堆上的对象），通过 `JNIHandles::make_local(env, oop)` 转成 jobject（LocalRef）。reader 回到 native 调用方 → 拿到 LocalRef → 可以继续用它做反射操作。LocalRef 的释放由 native 调用方的 frame 退出时处理。

**追问 (d)：CHECK_NULL 的两次使用 — 两级防御**

```cpp
TempNewSymbol h_name = SymbolTable::new_symbol(name, CHECK_NULL); // 第一级：name invalid → NULL
Klass *k = SystemDictionary::resolve_or_null(h_name, CHECK_NULL); // 第二级：class not found → NULL
```

如果 name 非法（如超长），`SymbolTable::new_symbol` 设 pending exception → CHECK_NULL 触发 → 函数返回 NULL。如果类在 boot loader 中不存在，`resolve_or_null` 返回 NULL（无异常）→ 函数返回 NULL（这次不是异常路径，是正常"类不存在"）。

### 3.4 工具/信息类

#### 【7】JVM_CurrentTimeMillis（jvm.cpp:以 JVM_LEAF）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_LEAF(jlong, JVM_CurrentTimeMillis(JNIEnv *env, jclass ignored))` |
| **JDK native 声明** | `java.lang.System.currentTimeMillis()` |
| **核心调用链** | `JVM_CurrentTimeMillis` → `os::javaTimeMillis()` |
| **返回值** | jlong（毫秒级时间戳） |
| **如果移除** | `System.currentTimeMillis()` 返回 0 或未定义值 |

**追问 (b)：为什么是 JVM_LEAF？**

- 纯 OS 调用（`os::javaTimeMillis()` → `gettimeofday` / `clock_gettime`）
- 不创建 Handle（不碰 JVM 堆）
- 不需要 THREAD（不传播异常）
- 在 `_thread_in_native` 中调用 OS 函数完全安全

**追问 (c)：LEAF 函数能不能访问 TLS（thread-local storage）？**

能——`Thread::current()` 通过 TLS 访问，TLS 是 OS 管理的（`pthread_getspecific` 或 `fs` 段寄存器偏移），不依赖 JVM 状态。在 `_thread_in_native` 中调用 `Thread::current()` 返回的仍是正确的 `JavaThread*`。但 `JavaThread::current()->thread_state()` 读到的值是 `_thread_in_native(4)`——这正是 JVM_LEAF 不设 `ThreadInVMfromNative` 的证明。

#### 【8】JVM_GetClassName（推测为 JVM_ENTRY）

| 维度 | 内容 |
|------|------|
| **入口宏** | `JVM_ENTRY(jobject, ...)`（需要 Handle + oop 操作） |
| **JDK native 声明** | `java.lang.Class.getName()` |
| **核心调用链** | `JVM_GetClassName` → `InstanceKlass::external_name()` → `java_lang_String::create_from_symbol(...)` → `JNIHandles::make_local(env, result)` |
| **返回值** | jstring（类名的 String 对象的 LocalRef） |
| **如果移除** | `Class.getName()` 返回 null |

**追问 (b)：为什么不是 LEAF？**

`java_lang_String::create_from_symbol` → 在 **JVM 堆上**分配 String 对象 → 需要 GC safepoint 协调（分配可能触发 GC）。必须用 JVM_ENTRY（在 `_thread_in_vm` 中）。

**追问 (c)：返回的 jstring 背后的 oop 是什么？**

`java_lang_String::create_from_symbol` → 在堆上创建 `java.lang.String` 实例 → 返回 oop → `JNIHandles::make_local(env, oop)` → 转成 jobject（LocalRef）→ 返回给 native 调用方。reader 可以通过 `GetStringUTFChars` 等 JNI 函数读取其中的字符。

---

## §四 ★★ javaClasses.cpp — 字段偏移的"预计算"基础设施

### ❓ 为什么 JVM_StartThread 可以 `obj->int_field(offset)` 而不调 getter 方法？

```cpp
// jvm.cpp 中的实际用法（JVM_StartThread 内部）:
java_lang_Thread::thread(JNIHandles::resolve_non_null(jthread))  // 读 eetop 字段
java_lang_Thread::stackSize(JNIHandles::resolve_non_null(jthread)) // 读 stackSize 字段

// javaClasses.cpp 中 java_lang_Thread 的静态偏移量:
int java_lang_Thread::_eetop_offset = 0;
int java_lang_Thread::_stackSize_offset = 0;
int java_lang_Thread::_thread_status_offset = 0;
// ... 共 11 个字段偏移量
```

### 4.1 compute_offsets() 的初始化时机和计算流程

`compute_offsets()` 在 JVM 初始化时被调用（`jni_handles_init` 之后，`SystemDictionary` 加载之后）：

以 `java_lang_Thread::compute_offsets()` 为例（`javaClasses.cpp:1624-1629`）：

```cpp
void java_lang_Thread::compute_offsets() {
  assert(_group_offset == 0, "offsets should be initialized only once");

  InstanceKlass* k = SystemDictionary::Thread_klass();  // ① 获取 java.lang.Thread 的 Klass
  THREAD_FIELDS_DO(FIELD_COMPUTE_OFFSET);                // ② 展开宏 → 逐个字段计算 offset
}
```

`THREAD_FIELDS_DO` 宏展开为对每个字段调用 `FIELD_COMPUTE_OFFSET`：

```cpp
// javaClasses.cpp:1610-1622
#define THREAD_FIELDS_DO(macro) \
  macro(_name_offset,          k, vmSymbols::name_name(), string_signature, false); \
  macro(_group_offset,         k, vmSymbols::group_name(), threadgroup_signature, false); \
  ...
  macro(_thread_status_offset, k, "threadStatus", int_signature, false); \
  macro(_park_blocker_offset,  k, "parkBlocker", object_signature, false)
```

`FIELD_COMPUTE_OFFSET` 利用 `InstanceKlass::find_field()` → 找到 field → 取 `field->offset()` → 存入静态变量。

**为什么 offset 是 static？** 所有 `java.lang.Thread` 对象共享同一个 JVM 实例（同一个 Klass）→ 字段偏移是 JVM 全局唯一的 → 一次计算，全局复用。

### 4.2 java_lang_reflect_Method::slot — 05-Reflection 的前置知识

```cpp
// javaClasses.cpp:2773-2776
int java_lang_reflect_Method::slot(oop reflect) {
  assert(Universe::is_fully_initialized(), "Need to find another solution to the reflection problem");
  return reflect->int_field(slot_offset);  // ★ 直接通过 offset 读 int 字段
}
```

`slot` 字段在 `java.lang.reflect.Method` 对象中存储的是该方法在 `InstanceKlass::methods()` 数组中的索引。JVM_* 函数通过这个方法找到 Method 对象对应的 C++ `Method*`：

```
java.lang.reflect.Method 对象 (堆上)
  ├─ clazz: java.lang.Class (所在类)
  ├─ name: String (方法名)
  ├─ slot: int ← ★ 在 InstanceKlass::methods() 数组中的索引
  └─ ...

java_lang_reflect_Method::slot(methodObj)
  → methodObj->int_field(slot_offset) = 3  // 第 3 个方法
  → InstanceKlass::methods()->at(3) → Method*
```

这将在 [09-05 Reflection] 中展开。

---

## §五 ★ JNI RegisterNatives — JVM_* 函数如何绑定到 JDK 类

### ❓ 和 JNI API（jni.cpp 的 jni_XX 函数）是什么关系？

- **JNI API**（`jni.cpp`）：外部接口，给用户 native 代码调用（如 `env->NewGlobalRef()`）
- **JVM_* 函数**（`jvm.cpp`）：内部总线，给 JDK 核心类调用（如 `java.lang.System.gc()` 最终调 `JVM_GC`）
- **关系**：JNI API 和 JVM_* 都使用 `JVM_ENTRY`/`JNI_ENTRY` 宏进入 VM，但 JVM_* 是 JDK 专用的内部通道

### 5.1 jni_RegisterNatives 的 Method::set_native_function 流程

```cpp
// jni.cpp:3046-3083 — jni_RegisterNatives
JNI_ENTRY(jint, jni_RegisterNatives(JNIEnv *env, jclass clazz,
                                    const JNINativeMethod *methods, jint nMethods))
  Klass* k = java_lang_Class::as_Klass(JNIHandles::resolve_non_null(clazz));

  for (int index = 0; index < nMethods; index++) {
    const char* meth_name = methods[index].name;      // "start0"
    const char* meth_sig = methods[index].signature;   // "()V"
    // methods[index].fnPtr = &JVM_StartThread         // ★ C 函数指针

    // 查找 Method 对象
    TempNewSymbol name = SymbolTable::probe(meth_name, meth_name_len);
    TempNewSymbol signature = SymbolTable::probe(meth_sig, strlen(meth_sig));

    // ★ 核心：将 JVM_StartThread 的函数指针写入 Method::_native_function
    register_native(k, name, signature, (address)methods[index].fnPtr, THREAD);
  }
JNI_END
```

`register_native(k, name, sig, fnPtr, THREAD)` 最终调用 `Method::set_native_function(address function)`，将 `JVM_XXX` 的函数指针直接写入 Method 对象的元数据中。

### 5.2 哪些 JDK 核心类注册了 JVM_* 函数？

| JDK 类 | 注册的 JVM_* 函数数 | 示例 |
|--------|-------------------|------|
| `java.lang.System` | ~20 | `JVM_CurrentTimeMillis`、`JVM_GC`、`JVM_NanoTime`、`arraycopy` |
| `java.lang.Thread` | ~10 | `JVM_StartThread`、`JVM_CurrentThread`、`JVM_Sleep`、`JVM_Yield` |
| `java.lang.Class` | ~30 | `JVM_GetClassName`、`JVM_IsInterface`、`JVM_GetSuperclass` |
| `java.lang.ClassLoader` | ~5 | `JVM_DefineClass`、`JVM_FindClassFromBootLoader`、`JVM_FindLoadedClass` |
| `java.lang.reflect.*` | ~15 | `JVM_GetMethodIxModifiers`、反射辅助函数 |
| `java.io.*` | ~8 | 文件 I/O、网络 I/O |

### 5.3 和 dlsym fallback 的关系 — 谁更快？为什么？

**RegisterNatives 是主路径**：JDK 核心类在 `<clinit>` 中调用 `RegisterNatives`，将函数指针直接写入 Method 对象。后续每次 native 方法调用 → 解释器/JIT 直接读 `Method::_native_function` → `call *rax` → 零查找开销。

**dlsym fallback 是后备路径**：如果某个 native 方法没有通过 `RegisterNatives` 注册 → 解释器/JIT 在第一次调用时走 `NativeLookup::lookup()` → `dlsym(RTLD_DEFAULT, "Java_xxx_xxx")` → 动态符号查找 → 开销约 100-10000 倍于直接指针调用。但只需要查一次，之后缓存在 `Method::_native_function` 中。

---

## §六 ★ 和 [01][02] 的交叉验证

### 6.1 trans_from_native 在每个 JVM_ENTRY 入口的精确调用点

```
JVM_ENTRY 展开
  → JavaThread* thread = thread_from_jni_environment(env)   // 取线程
  → ThreadInVMfromNative __tiv(thread)                      // ctor
    → trans_from_native(_thread_in_vm)                      // [01]§二.2.1 — 入口状态转换
      → transition_from_native(thread, _thread_in_vm)       // interfaceSupport.inline.hpp:158
        → set_thread_state(_thread_in_native_trans)          // ★ 建立窗口 [01]§一.1.1
        → serialize_thread_state_with_handler(thread)        // ★ fence [01]§三.3.1
        → if (poll(thread) || is_suspend_after_native)       // ★ 安全点检查 [01]§二.2.1
            → check_safepoint_and_suspend_for_native_trans → block()
        → set_thread_state(_thread_in_vm)                    // ★ 到达 _vm

  → VM_ENTRY_BASE → HandleMarkCleaner __hm(thread)          // Handle 作用域
                  → Thread* THREAD = thread                 // 异常传播管道

  // [用户代码 —— 在 _thread_in_vm 中安全执行]
  // 可以使用 [02]§一 的 JNIHandles::make_local() 把 oop 转成 jobject
  // 可以创建 Handle（[02]§一.1.5 的 JNIHandleBlock 管理）
  // 可以通过 CHECK_NULL 传播异常

  → ~__hm()                                                 // HandleMark::pop_and_restore
  → ~__tiv()                                                // 出口状态转换
    → trans_and_fence(_thread_in_vm, _thread_in_native)     // [01]§三.3.1
      → transition_and_fence(thread, _vm, _native)
        → set_thread_state(_thread_in_vm_trans)             // from+1 = _thread_in_native?  NO!
        │                                                    // from=6(_vm) + 1 = 7(_vm_trans)
        │                                                    // ★ 不是 _native_trans(5)!
        → serialize_thread_state_with_handler               // fence
        → block_if_requested(thread)                        // ★ 出口也可以阻塞!
        → set_thread_state(_thread_in_native)               // 回到 native
```

### 6.2 trans_and_fence → transition_and_fence 在出口的完整步骤

```cpp
// interfaceSupport.inline.hpp:136-148
static inline void transition_and_fence(JavaThread *thread, JavaThreadState from, JavaThreadState to) {
    assert(thread->thread_state() == from, "coming from wrong thread state");
    assert((from & 1) == 0 && (to & 1) == 0, "odd numbers are transitions states");
    thread->set_thread_state((JavaThreadState)(from + 1));    // ① 过渡态 = from+1

    InterfaceSupport::serialize_thread_state_with_handler(thread); // ② fence

    SafepointMechanism::block_if_requested(thread);               // ③ 阻塞检测
    thread->set_thread_state(to);                                 // ④ 最终状态

    CHECK_UNHANDLED_OOPS_ONLY(thread->clear_unhandled_oops();)
}
```

**步骤详解**：

| 步骤 | 做什么 | 为什么 | 用时 |
|------|--------|--------|------|
| ① `set_thread_state(from+1)` | 设过渡态 | VMThread SPIN 看到过渡态 → 保持 `_running`，等窗口关闭 | ~2 cycles |
| ② `serialize_thread_state_with_handler` | StoreLoad fence | 保证 L422-427 的所有写操作在状态转换前对所有 CPU 可见。x86 上 `UseMembar=true` → `mfence` (~30 cycles)；否则 → `write_memory_serialize_page` (~50 cycles) | 30-50 cycles |
| ③ `block_if_requested(thread)` | 检查 + 可能阻塞 | 如果 VMThread 正发起 safepoint 并 arm 了 poll flag → 线程阻塞直到 safepoint 完成。否则零开销返回 | 0 cycles (fast path) |
| ④ `set_thread_state(to)` | 到达稳态 | 正式进入 `_thread_in_native`，VMThread 视为"已到达 safepoint" | ~2 cycles |

**★ x86 上 `storestore()` 只是 compiler_barrier，不是硬件 fence**

`OrderAccess::storestore()` 在 x86 上只是 `__asm__ volatile("" ::: "memory")`——编译器 barrier，不生成 CPU fence 指令。真正的硬件同步在 `serialize_thread_state_with_handler` 中：`OrderAccess::fence()` → `mfence` 或 `lock; addl $0, (%rsp)`。

### 6.3 JVM_ENTRY 内部创建的 Handle 和 [02] JNIHandleBlock 的关系

```
JVM_ENTRY 内创建的 Handle：
  Handle obj(THREAD, oop);  // Handle 是 oop* 的间接指针
    → 在线程的 HandleArea (Arena) 中分配 oop* 空间
    → HandleArea 由 HandleMarkCleaner 管理生命周期

JNI 层返回的 LocalRef：
  JNIHandles::make_local(env, oop);
    → 在 JNIHandleBlock._handles[32] 中分配 slot  [02]§一
    → JNIHandleBlock 由 PushLocalFrame/PopLocalFrame 管理生命周期

关系：
  - Handle 是 VM 内部使用的"安全指针"（GC 发生时自动更新）
  - LocalRef(jobject) 是 JNI 层用的"引用编号"（指向 JNIHandleBlock 中的 slot）
  - JVM_ENTRY 内：Handle 存 VM 侧 → make_local 转为 LocalRef → 返回给 native 调用方
  - 函数返回时：HandleMarkCleaner 释放 Handle → LocalRef 由调用方的 frame 管理
```

---

## §七 GDB 验证 + 可证伪断言（≥12 条）

### 断言 1：JVM_ENTRY 宏展开后的实际函数体

```bash
# 预处理 jvm.cpp 查看宏展开后的 JVM_GC 函数
cd /data/workspace/openjdk-cut-new/build/linux-x86_64-server-slowdebug/hotspot/variant-server
g++ -E -I/path/to/generated -I/path/to/src \
    -DASSERT -DLINUX -DAMD64 -D_LP64=1 \
    -include precompiled/precompiled.hpp \
    /data/workspace/openjdk-cut-new/src/hotspot/share/prims/jvm.cpp \
    2>&1 | grep -A 30 "JVM_GC" | head -50
```

**预期输出**：能看到 `extern "C"`、`ThreadInVMfromNative`、`HandleMarkCleaner` 的构造函数展开。

### 断言 2：JVM_LEAF 中 ThreadInVMfromNative 是否被构造

```gdb
(gdb) break JVM_CurrentTimeMillis
(gdb) run -Xms8g -Xmx8g
(gdb) bt
# 在断点处检查栈变量 — 不应有 ThreadInVMfromNative 对象
(gdb) info locals
# 预期：没有 __tiv 或 __jvm_invm 变量
(gdb) p thread->thread_state()
# 预期：_thread_in_native (4)
```

**可证伪**：如果 `thread_state()` 是 `_thread_in_vm(6)`，说明有隐式状态切换。

### 断言 3：JVM_StartThread 新线程的 thread_state

```gdb
(gdb) break JavaThread::run
(gdb) run -Xms8g -Xmx8g
# 在新线程的 run() 入口：
(gdb) p this->thread_state()
# 预期：_thread_new (2) — 因为 transition_and_fence 还没执行

(gdb) break thread.cpp:1941  # transition_and_fence 之后
(gdb) continue
(gdb) p this->thread_state()
# 预期：_thread_in_vm (6) — 刚完成从 _thread_new 的转换
```

**可证伪**：如果一直是 `_thread_new` → transition_and_fence 未执行；如果已经是 `_thread_in_Java` → 状态管理逻辑有误。

### 断言 4：JVM_GC 调用链上的 VM_Operation

```gdb
(gdb) break VM_GC_Operation::doit
(gdb) run -Xms8g -Xmx8g
# 在 Java 代码中调用 System.gc() → 触发断点
(gdb) bt
# 预期调用栈：
# #0  VM_GC_Operation::doit
# #1  VM_Operation::evaluate
# #2  VMThread::evaluate_operation
# #3  VMThread::loop
#
# 而调用者线程的栈：
(gdb) thread 2  # 切到调用 System.gc() 的 JavaThread
(gdb) bt
# 预期：在 SafepointSynchronize::block() 中等待
```

### 断言 5：CHECK_NULL 后的 early return

```gdb
(gdb) break jvm.cpp:782  # SymbolTable::new_symbol CHECK_NULL 之后
(gdb) commands
> silent
> p THREAD->has_pending_exception()
> # 如果返回 true → 下一行是 return NULL，不会执行 resolve_or_null
> c
> end
```

**可证伪**：如果 `has_pending_exception()=true` 但继续执行到 `resolve_or_null` → CHECK_NULL 未生效。

### 断言 6：java_lang_reflect_Method::slot 的 offset 值

```gdb
(gdb) print java_lang_reflect_Method::slot_offset
# 预期：一个正整数值（如 24, 32, 40 — 取决于 JDK 版本和对象布局）
(gdb) p/x java_lang_reflect_Method::slot_offset
# 验证：offset 在合理范围内（< InstanceKlass 的 instance_size）
```

### 断言 7：JVM_ENTRY 内 HandleMarkCleaner 清理的 HandleArea

```gdb
(gdb) break JVM_GC
(gdb) run -Xms8g -Xmx8g
(gdb) p thread->_handle_area->_hwm    # 进入前的水位
(gdb) record_hwm = thread->_handle_area->_hwm
# 在 JVM_END 之后（需要设置临时断点）:
(gdb) p thread->_handle_area->_hwm    # 应该等于 record_hwm
```

**可证伪**：如果退出后 `_hwm` 大于进入前 → Handle 泄漏。

### 断言 8：JVM_CurrentTimeMillis LEAF 中的 Thread::current() 可用性

```gdb
(gdb) break JVM_CurrentTimeMillis
(gdb) run
(gdb) p Thread::current()
# 预期：返回非空指针
(gdb) p ((JavaThread*)Thread::current())->thread_state()
# 预期：_thread_in_native (4)
```

**可证伪**：如果 `Thread::current()` 是 NULL → TLS 未初始化（但这是新线程运行时才会出现的错误）。

### 断言 9：RegisterNatives 后 Method::native_function 指针

```gdb
# 找到 java.lang.Thread 的 start0 方法
# 需要先加载 Thread 类
(gdb) p SystemDictionary::Thread_klass()->methods()->at(N)
# N 是 start0 方法在 methods 数组中的索引
(gdb) p SystemDictionary::Thread_klass()->methods()->at(N)->native_function()
# 预期：等于 &JVM_StartThread 的地址
(gdb) p/x (long)SystemDictionary::Thread_klass()->methods()->at(N)->native_function()
(gdb) p/x &JVM_StartThread
# 两值应该相等
```

### 断言 10：compute_offsets 的调用栈

```gdb
(gdb) break java_lang_Thread::compute_offsets
(gdb) run -Xms8g -Xmx8g
(gdb) bt
# 预期调用栈：
# #0  java_lang_Thread::compute_offsets
# #1  java_lang_Thread::compute_offsets  ← 仅调用一次
# #2  JavaClasses::compute_hard_coded_offsets
# #3  Threads::create_vm
# #4  JNI_CreateJavaVM
```

### 断言 11：JVM_ENTRY 异常路径中 ThreadInVMfromNative dtor 的执行验证

```gdb
(gdb) break transition_from_native
(gdb) condition 1 thread->thread_state() == _thread_in_native
(gdb) run
# 在 JVM_ENTRY 入口触发

# 然后设置 dtor 断点:
(gdb) break ThreadInVMfromNative::~ThreadInVMfromNative
# continue 到 dtor
(gdb) bt
# 预期：即使在异常路径（CHECK_NULL early return）中，dtor 仍被调用
# 验证 RAII 保证 dtor 在任何退出路径都执行
```

### 断言 12：extern "C" 的符号名验证

```bash
nm /path/to/libjvm.so | grep JVM_StartThread
# 预期输出：0000000001234567 T JVM_StartThread
# 没有 C++ mangling 前缀（_Z15JVM_StartThread...）
```

**可证伪**：如果符号名有 `_Z` 前缀 → `extern "C"` 未生效 → `RegisterNatives` 注册也会失败。

### 可证伪断言

1. **如果 JVM_LEAF 内调用 `Universe::heap()` → 无断言保护 → 静默错误**
   验证：在 `JVM_CurrentTimeMillis` 中添加 `Universe::heap()->capacity()` 调用 → GDB 运行 → 观察是否崩溃或返回错误值。

2. **JVM_ENTRY 内忘记 CHECK_NULL → pending exception 传播到下一行**
   验证：在 `JVM_FindClassFromBootLoader` 中注释掉第一个 `CHECK_NULL` → 运行 → 在 `resolve_or_null` 中 `_pending_exception` 非空 → `h_name` 可能是无效 Symbol → 行为异常。

3. **JVM_StartThread 不经过 `trans_from_native` → 直接设置 `_thread_in_vm`**
   验证：在 `transition_from_native` 设断点 → 触发 `JVM_StartThread` → 调用者线程会命中此断点。但新线程（通过 `pthread_create` 创建）不会命中 → 它走 `JavaThread::run()` 的 `transition_and_fence(_thread_new, _thread_in_vm)`。

4. **compute_offsets 变更 JDK 字段顺序 → offset 重算**
   验证：修改 `java.lang.Thread` 的字段声明顺序 → 重新编译 JDK → 运行 JVM → GDB 打印旧 offset 值 → 验证是否自动适配。

5. **RegisterNatives 改写 native_function 后 → 不再走 dlsym 查找**
   验证：在 `NativeLookup::lookup()` 设断点 → 调用已注册的 native 方法 → 断点不应命中。

---

## 附录 A：170+ JVM_* 函数的分类统计

| 类别 | 数量（约） | 典型函数 | 示例调用方 |
|------|----------|---------|-----------|
| Class 操作 | ~30 | `JVM_GetClassName`, `JVM_IsInterface`, `JVM_GetSuperclass`, `JVM_GetDeclaredClasses`, `JVM_GetClassModifiers`, `JVM_GetClassSigners` | `java.lang.Class` |
| 反射 | ~15 | `JVM_GetMethodIxModifiers`, `JVM_GetMethodIxExceptionTypes`, `JVM_GetCPMethodModifiers` | `java.lang.reflect.*` |
| 线程 | ~10 | `JVM_StartThread`, `JVM_CurrentThread`, `JVM_Sleep`, `JVM_Yield`, `JVM_Interrupt`, `JVM_HoldsLock` | `java.lang.Thread` |
| 类加载 | ~20 | `JVM_DefineClass`, `JVM_FindClassFromBootLoader`, `JVM_FindLoadedClass`, `JVM_GetClassLoader` | `java.lang.ClassLoader` |
| IO/网络 | ~8 | `JVM_OpenSocket`, `JVM_ReadFile`, `JVM_WriteFile` | `java.io.*`, `java.net.*` |
| 系统属性 | ~5 | `JVM_GetSystemPackage`, `JVM_GetSystemPackages`, `JVM_GetCallerClass` | `java.lang.System` |
| GC/内存 | ~3 | `JVM_GC`, `JVM_TotalMemory`, `JVM_FreeMemory`, `JVM_MaxMemory` | `java.lang.Runtime` |
| 同步 | ~5 | `JVM_MonitorWait`, `JVM_MonitorNotify`, `JVM_MonitorNotifyAll`, `JVM_Clone` | `java.lang.Object` |
| 系统/工具 | ~15 | `JVM_CurrentTimeMillis`, `JVM_NanoTime`, `JVM_GetVersion`, `JVM_Halt`, `JVM_AvailableProcessors` | `java.lang.System` |
| 数组 | ~5 | `JVM_ArrayCopy`, `JVM_GetArrayLength` | `java.lang.System` |
| 安全管理 | ~8 | `JVM_GetStackAccessControlContext`, `JVM_DoPrivileged` | `java.security.*` |
| 引用处理 | ~5 | `JVM_GetAndClearReferencePendingList`, `JVM_WaitForReferencePendingList` | `java.lang.ref.Reference` |
| 其他 | ~40 | 类注解、断言、信号、栈帧、字符编码等 | 各种核心类 |
| **总计** | **~170** | — | — |

---

## 附录 B：宏系统全览

```
                         VM 状态转换 RAII 对象
                         ┌────────────────────┐
                         │ ThreadInVMfromNative│ ← JVM_ENTRY / JNI_ENTRY
                         │ ThreadInVMfromJava  │ ← JRT_ENTRY / IRT_ENTRY
                         │ ThreadToNativeFromVM│ ← VM 内部调用 native
                         │ ThreadBlockInVM     │ ← safepoint block
                         └────────────────────┘

         入口宏族              基础宏族
  ┌─────────────────────┐  ┌──────────────────────┐
  │ JVM_ENTRY           │  │ VM_ENTRY_BASE        │ ← HandleMarkCleaner + THREAD
  │ JVM_ENTRY_NO_ENV    │  │ VM_LEAF_BASE         │ ← NoHandleMark (debug)
  │ JVM_LEAF            │  │ VM_QUICK_ENTRY_BASE  │ ← NoHandleMark + THREAD
  │ JVM_QUICK_ENTRY     │  │ VM_ENTRY_BASE_FROM_LEAF│
  │ JVM_END             │  └──────────────────────┘
  │                      │
  │ JNI_ENTRY            │        辅助类
  │ JNI_LEAF             │  ┌──────────────────────┐
  │ JNI_QUICK_ENTRY      │  │ HandleMarkCleaner     │ ← Handle 作用域
  │ JNI_END              │  │ VMNativeEntryWrapper  │ ← GCALotAtAllSafepoints
  │                      │  │ NoHandleMark          │ ← 禁止 Handle
  │ JRT_ENTRY / JRT_LEAF │  │ VMEntryWrapper        │ ← VerifyLastFrame
  │ IRT_ENTRY / IRT_LEAF │  └──────────────────────┘
  └─────────────────────┘
```

---

## 文档版本

- **v1.0** — 初版：JVM_ENTRY/JVM_LEAF 宏完整展开、8 个代表性函数深挖、TRAPS/CHECK_NULL 协议、SIGSEGV→NPE PC 劫持机制、javaClasses.cpp 预计算偏移、JNI RegisterNatives 流程、12 条 GDB 断言、170+ 函数分类统计
