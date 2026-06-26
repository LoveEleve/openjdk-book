# 第3章：后处理与收尾

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

`JavaVMInitArgs`（`nOptions` + `options`）终于传到了 `Threads::create_vm` 的手上。

`Threads::create_vm` 返回后的运行时统计、JVMTI 通知、线程状态切换等——这些是 JVM 完全初始化之后的收尾工作，涉及调试接口、性能监控等独立子系统。等走完 Vol 1 核心流程（`init_globals` → `universe_init`）之后再回来理解它们。

下一章进入 `Threads::create_vm`——HotSpot 初始化的心脏地带。
