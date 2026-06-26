# 第3章：JNI_CreateJavaVM —— HotSpot 的入口

上一章结束在 `InitializeJVM` 的这行：

```c
r = ifn->CreateJavaVM(pvm, (void**)penv, &args);
```

`ifn->CreateJavaVM` 是第一章 `dlsym` 解析的函数指针，指向 `jni.cpp:4098` 的 `JNI_CreateJavaVM`。本章沿着这个入口走进去——从外层包装器到 `JNI_CreateJavaVM_inner`，经过两把原子锁，到达整个 Volume 1 的核心调用：`Threads::create_vm`。

---

## 此刻的进程与线程

进入 `JNI_CreateJavaVM` 之前，回顾一下当前的进程和线程状态：

**1 个进程。** 从你在终端执行 `java` 开始，OS 创建了一个进程。到现在，还是这一个进程。

**2 个线程。** 第一章的 `pthread_create` 之后：

```
OS 进程 (PID=xxx)
├─ 主线程（pid=原始线程）
│     main() → JLI_Launch() → JVMInit() → ContinueInNewThread()
│     → CallJavaMainInNewThread() → pthread_create() → pthread_join()
│     状态：阻塞在 pthread_join，等待 Java 线程结束
│
└─ Java 线程（pid=tid）
      ThreadJavaMain() → JavaMain() → InitializeJVM()
      → ifn->CreateJavaVM() → JNI_CreateJavaVM()    ← 现在在这里
      状态：正在执行，即将创建 JVM
```

主线程在 `pthread_join` 上阻塞睡觉，Java 线程扛着所有工作。这个 Java 线程目前只是一个普通 POSIX 线程——它还不是 HotSpot 的 `JavaThread` 对象。`Threads::create_vm` 要做的第一件事，就是把这个 OS 线程包装成 HotSpot 的 `JavaThread`。

---

## JNI_CreateJavaVM() 外层包装器

`JNI_CreateJavaVM` 只有 14 行，在 `jni.cpp:4098-4111`：

```c
_JNI_IMPORT_OR_EXPORT_ jint JNICALL JNI_CreateJavaVM(JavaVM **vm, void **penv, void *args) {
    jint result = JNI_ERR;
    result = JNI_CreateJavaVM_inner(vm, penv, args);
    return result;
}
```

`_JNI_IMPORT_OR_EXPORT_` 展开为 `JNIEXPORT`（`__attribute__((visibility("default")))`），这是 libjvm.so 导出给外部调用的公共符号。按照 JNI 规范，`JNI_CreateJavaVM` 是创建 JVM 的唯一入口。

外层包装器只做两件事：调用 `_inner`，返回结果。中间没有其他逻辑。

> Windows 构建会在 `_inner` 调用外包裹 `__try/__except` 做 SEH 异常保护——Linux 构建不编译这段。

---

## JNI_CreateJavaVM_inner() 全貌

`JNI_CreateJavaVM_inner` 在 `jni.cpp:3952-4096`，145 行，4 个核心阶段：

```c
/* === src/hotspot/share/prims/jni.cpp === */

static jint JNI_CreateJavaVM_inner(JavaVM **vm, void **penv, void *args) {
    HOTSPOT_JNI_CREATEJAVAVM_ENTRY((void **) vm, penv, args);

    jint result = JNI_ERR;
    DT_RETURN_MARK(CreateJavaVM, jint, (const jint&)result);

    /* ═══════ 阶段1：Atomic::xchg 原子守卫 ═══════ */
    /* ... 省略 Zero/ASSERT 模式下对 Atomic::xchg 的正确性验证 ... */

    if (Atomic::xchg(1, &vm_created) == 1) {
        return JNI_EEXIST;                 // 已有 VM 在创建或已创建
    }
    if (Atomic::xchg(0, &safe_to_recreate_vm) == 0) {
        return JNI_ERR;                    // 之前创建失败且不可恢复
    }

    bool can_try_again = true;

    /* ═══════ 阶段2：Threads::create_vm ═══════ */
    result = Threads::create_vm((JavaVMInitArgs*) args, &can_try_again);

    /* ═══════ 阶段3：后处理 ═══════ */
    if (result == JNI_OK) {
        JavaThread *thread = JavaThread::current();
        *vm = (JavaVM *)(&main_vm);
        *(JNIEnv**)penv = thread->jni_environment();

        // JVMCI 编译器引导（INCLUDE_JVMCI 编译选项，通常不编译）
        RuntimeService::record_application_start();
        JvmtiExport::post_thread_start(thread);
        post_thread_start_event(thread);

        // 线程状态从 _thread_in_vm 切换到 _thread_in_native
        ThreadStateTransition::transition_and_fence(thread, _thread_in_vm, _thread_in_native);
    } else {
        // 创建失败：如果有待处理异常，调用 vm_exit_during_initialization
        if (Universe::is_fully_initialized()) {
            JavaThread* THREAD = JavaThread::current();
            if (HAS_PENDING_EXCEPTION) {
                HandleMark hm;
                vm_exit_during_initialization(Handle(THREAD, PENDING_EXCEPTION));
            }
        }
        if (can_try_again) {
            safe_to_recreate_vm = 1;       // 允许后续重试
        }
        *vm = 0;
        *(JNIEnv**)penv = 0;
        OrderAccess::release_store(&vm_created, 0);  // 释放锁
    }

    /* ═══════ 阶段4：收尾 ═══════ */
    fflush(stdout);
    fflush(stderr);
    return result;
}
```

`HOTSPOT_JNI_CREATEJAVAVM_ENTRY` 和 `DT_RETURN_MARK` 是 DTrace 探针宏。DTrace 是 Solaris 的动态跟踪框架，Linux 上禁用时这两个宏展开为空——不影响执行。

---

## 阶段1：Atomic::xchg 原子守卫 —— 为什么不能用互斥锁

两把原子锁阻止多个线程同时创建 JVM：

```c
if (Atomic::xchg(1, &vm_created) == 1) {
    return JNI_EEXIST;
}
if (Atomic::xchg(0, &safe_to_recreate_vm) == 0) {
    return JNI_ERR;
}
```

三个关键全局变量定义在 `jni.cpp:3914-3918`：

```c
volatile int vm_created = 0;              // 0=未创建，1=创建中或已创建
volatile int safe_to_recreate_vm = 1;     // 0=不可重试
struct JavaVM_ main_vm = {&jni_InvokeInterface};
```

**`vm_created`**——第一把锁。`Atomic::xchg(1, &vm_created)` 原子地把 `vm_created` 设为 1，同时返回旧值。如果旧值是 1，说明已经有线程在创建或已创建完了——返回 `JNI_EEXIST`（`-5`）。如果旧值是 0，当前线程抢到了创建权，继续执行。

**`safe_to_recreate_vm`**——第二把锁。`Atomic::xchg(0, &safe_to_recreate_vm)` 把标志位清 0，同时返回旧值。如果旧值是 0，说明上次创建失败且不允许重试——返回 `JNI_ERR`（`-1`）。如果旧值是 1，允许本次创建。

**为什么用 `Atomic::xchg` 而不是互斥锁？** 源码注释给了答案（`jni.cpp:3976-3984`）：互斥锁依赖 `Thread` 对象，此时线程系统还没初始化——`Threads::create_vm` 本身就是要创建第一个 `JavaThread`，不能在此之前的守卫代码里用互斥锁。`Atomic::xchg` 是 CPU 指令级别的原子操作（`lock xchg` 或等价指令），不依赖任何线程基础设施。

源码还解释了为什么用 `xchg` 而不是 `Atomic::add/dec`：`Atomic::add/dec` 在某些平台上依赖 `os::is_MP()` 判断是否多处理器，而初始化阶段这个函数始终返回 false。`xchg` 不受此限制。

---

## 阶段2：Threads::create_vm —— 一行代码，整个 JVM

```c
result = Threads::create_vm((JavaVMInitArgs*) args, &can_try_again);
```

`Threads::create_vm` 是 HotSpot 初始化的心脏——从此行开始，后面 28 章都在展开它内部的每一步。它接收两个参数：

- `(JavaVMInitArgs*) args`——从 `InitializeJVM` 传下来的启动参数，包含 `nOptions`（选项个数）和 `options`（选项数组）
- `&can_try_again`——传出参数，如果初始化失败但可重试则为 `true`，反之 `false`

返回值 `JNI_OK`（`0`）表示创建成功，其他值表示失败。

`Threads::create_vm` 的内部逻辑是下一章的主题，本章不展开。

---

## 阶段3：后处理 —— 填充输出参数

`Threads::create_vm` 返回 `JNI_OK` 后，JVM 已经是一个完整运行的虚拟机了。接下来把结果填进 `InitializeJVM` 传下来的输出参数：

### 成功路径

```c
JavaThread *thread = JavaThread::current();          // 获取当前线程的 Thread 对象
*vm = (JavaVM *)(&main_vm);                         // 输出 JavaVM 指针
*(JNIEnv**)penv = thread->jni_environment();         // 输出 JNIEnv 指针
```

`main_vm` 是一个全局的 `JavaVM_` 结构体实例，内嵌 `jni_InvokeInterface` 函数表——通过它可以调用 `DestroyJavaVM`、`AttachCurrentThread` 等 JNI Invocation API。

`thread->jni_environment()` 返回当前线程的 `JNIEnv*`，后续 JavaMain 中所有的 `GetStaticMethodID`、`CallStaticVoidMethod` 等都通过这个指针调用。

成功路径还做了以下收尾工作：

```c
RuntimeService::record_application_start();           // 记录应用启动时间
JvmtiExport::post_thread_start(thread);               // 通知 JVMTI agent
post_thread_start_event(thread);                      // 内部事件
ThreadStateTransition::transition_and_fence(thread,
    _thread_in_vm, _thread_in_native);                // 线程状态切换
```

线程状态从 `_thread_in_vm`（正在执行 VM 代码）切换到 `_thread_in_native`（正在执行本地代码）——因为 `JavaMain` 接下来要以 C 代码的身份通过 JNI 调 Java 方法。

> JVMCI 编译器引导、CompileTheWorld、ReplayCompiles 等代码在 `#ifdef INCLUDE_JVMCI` 和 `#ifndef PRODUCT` 条件下编译，标准 JDK 11 构建不编译或编译但不执行。

### 失败路径

```c
if (Universe::is_fully_initialized()) {
    // 有待处理异常 → vm_exit_during_initialization
}
if (can_try_again) {
    safe_to_recreate_vm = 1;                         // 允许重试
}
*vm = 0;
*(JNIEnv**)penv = 0;
OrderAccess::release_store(&vm_created, 0);           // 释放锁，memory order 保证可见性
```

`OrderAccess::release_store` 保证在其他线程看到 `vm_created = 0` 之前，`*vm = 0` 和 `*penv = 0` 的写入已经完成——防止竞争条件。

---

## 阶段4：收尾

```c
fflush(stdout);
fflush(stderr);
return result;
```

刷新标准输出和标准错误缓冲区——确保所有日志在返回前写出。防止 `printf` 输出丢失在缓冲区里。

---

## 本章总结

`JNI_CreateJavaVM_inner` 145 行，核心就一行：

```c
result = Threads::create_vm((JavaVMInitArgs*) args, &can_try_again);
```

这一行之前是两把原子锁保证单例，之后是填充 `*vm` 和 `*penv` 两个输出指针、线程状态切换、错误处理。

调用链更新：

```
main() → JLI_Launch() → JavaMain() → InitializeJVM()
       → ifn->CreateJavaVM() → JNI_CreateJavaVM()
       → JNI_CreateJavaVM_inner() → Threads::create_vm()
```

`JavaVMInitArgs`（`nOptions` + `options`）终于传到了 `Threads::create_vm` 的手上。下一章进入这个函数——HotSpot 初始化的心脏地带。
