# 第3章：JNI_CreateJavaVM —— HotSpot 的入口

上一章结束在 `InitializeJVM` 的这行：

```c
r = ifn->CreateJavaVM(pvm, (void**)penv, &args);
```

`ifn->CreateJavaVM` 是第一章 `dlsym` 解析的函数指针，指向 `jni.cpp:4098` 的 `JNI_CreateJavaVM`。本章沿着这个入口走进去——从外层包装器到 `JNI_CreateJavaVM_inner`，经过两把原子锁，到达整个 Volume 1 的核心调用：`Threads::create_vm`。

---

## 此刻的进程与线程

进入 `JNI_CreateJavaVM` 之前，回顾一下从敲键盘到现在的进程和线程状态。

**2 个进程。** 终端执行 `java` 时，Shell 调用 `fork` 创建子进程，子进程 `exec` 替换成 `java` 二进制——所以有两个进程：

```
终端进程 (shell, 例如 bash)
│  执行了 fork + exec，Shell 还活着，等待 Java 进程退出
│
└─ Java 进程 (PID=xxx, 即 java 可执行文件)
```

<img src="/docs/openjdk/vol-01/ch03/assets/Clipboard_Screenshot_1782478472.png" alt="进程与线程模型" style="max-width:100%">

Shell 进程要等 Java 进程退出后收集退出码、显示新的命令提示符。Java 进程是我们关注的主角。

**Java 进程内有 2 个线程。** 第一章的 `pthread_create` 之后：

```
Java 进程 (PID=xxx)
├─ 原始线程 (pid=LWP-1)               ← 永远是个裸 pthread
│     main() → JLI_Launch() → JVMInit() → ContinueInNewThread()
│     → CallJavaMainInNewThread() → pthread_create()
│     状态：阻塞在 pthread_join，等待新线程结束
│
└─ 新 pthread (pid=LWP-2)             ← 即将被包装为 JavaThread
      ThreadJavaMain() → JavaMain() → InitializeJVM()
      → ifn->CreateJavaVM() → JNI_CreateJavaVM()    ← 现在在这里
```

原始线程在 `pthread_join` 上阻塞，新 pthread 扛着所有工作。这个新 pthread 目前只是一个普通 POSIX 线程——它还不是 HotSpot 的 `JavaThread` 对象。`Threads::create_vm` 要做的第一件事，就是把这个 OS 线程包装成 HotSpot 的 `JavaThread`。

> `pthread_create` 之前，Java 进程确实只有 1 个线程（主线程），此时"进程"和"它的唯一线程"在执行路径上是等价的。`pthread_create` 之后，进程变成了 2 个线程，进程和线程就不再是等价概念。

### 原始线程 vs JavaThread vs Java Thread 对象

三个概念经常混淆，先区分清楚：

| 概念 | 是什么 | 例子 |
|------|--------|------|
| OS 线程 | 操作系统创建的线程，内核调度的单位 | `pthread_create` 创建的 POSIX 线程 |
| `JavaThread` | HotSpot C++ 对象，包装一个 OS 线程，可以在上面执行 Java 字节码 | `Threads::create_vm` 内部把当前的 pthread 包装成的 `JavaThread` |
| Java `Thread` 对象 | Java 层 `new Thread().start()` 创建的对象 | `Thread t = new Thread(() -> {}); t.start();` |

图中的两个 OS 线程：

- **原始线程**——永远是个裸 pthread，不会变成 `JavaThread`。它的使命是 `pthread_join` 等待，最终拿退出码。
- **新 pthread**——即将被 `Threads::create_vm` 包装成 `JavaThread`。内部 `os::create_main_thread()` 会创建 `JavaThread` 对象，把它和当前 OS 线程绑定。

从 HotSpot 内部看，`Threads::create_vm` 创建的 `JavaThread` 和 Java 代码中 `new Thread().start()` 创建的 `JavaThread`，**C++ 层面没有区别**——都是 `JavaThread` 实例，都有 `JNIEnv`、栈守卫页、线程状态机，在 jstack、JVMTI、JVM 调度上地位平等。之所以叫"主"线程，纯粹是因为它执行了 `main(String[] args)`——从 Java 程序员视角它是入口线程，从 JVM 内部视角它只是 `JavaThread` 列表里的第一个。

---

## 动手验证：strace 追踪 fork + exec + clone

上面的进程树形图不是推论，可以用 `strace` 在系统调用层面验证。`strace` 能追踪进程的每一次系统调用——包括进程创建和程序加载。

让它追踪 bash 执行 `java -version` 的完整过程：

```
strace -f -e trace=clone,execve
       bash -c '/data/workspace/jdk11u-copy/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java -version; true'
```

`-f` 追踪子进程，`-e trace=clone,execve` 只看进程相关的系统调用。末尾的 `; true` 是为了让 bash 必须 fork 子进程（否则 bash 会把最后一个命令直接 exec 而不 fork）。本机实际输出：

```
execve("/usr/bin/bash", ["bash", "-c", "/data/workspace/jdk11u-copy/buil"...], 0x7ffc5ed2d858 /* 68 vars */) = 0
clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7feabeaafa10) = 1584511
[pid 1584511] execve("/data/workspace/jdk11u-copy/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java", ["/data/workspace/jdk11u-copy/buil"..., "-version"], 0x5580490706d0 /* 68 vars */) = 0
```

三行输出对应三件事：

1. `execve("/usr/bin/bash", ...)` — bash 启动。`strace` 用 `execve` 把自己替换成 bash
2. `clone(child_stack=NULL, flags=SIGCHLD)` — bash fork 出一个子进程。flag 里没有 `CLONE_THREAD`，说明创建的是进程（新 PID），不是线程
3. `execve(".../jdk/bin/java", ...)` — 子进程把自身代码替换为 java 二进制。加 `-version` 是因为 hardcoded_argv 设的就是这个

之后 java 内部会调用 `clone3(CLONE_THREAD)` 创建 JVM 线程——那些 flag 和这里的 `SIGCHLD` 完全不同。

`clone` 的 flag 是关键——`SIGCHLD` 且没有 `CLONE_THREAD`，说明创建的是**进程**（新 PID），不是线程。如果 `strace` 继续追踪，后面进入 java 内部，会看到 `clone3(CLONE_THREAD)`——那些是 JVM 创建的线程，和 java 进程共享 PID。

用同样的命令追踪 CLion 启动 java，输出几乎一样——CLion 也是通过 fork + exec 启动 java 进程。

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

