# 第3章：Atomic::xchg 原子守卫

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

