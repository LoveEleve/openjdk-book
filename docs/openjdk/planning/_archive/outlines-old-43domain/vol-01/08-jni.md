# JNI 层 — 文章大纲

> vol-01 · 域 08 · 🟡 B | 拓扑排序 #8 | vol-01 末篇
> 依赖：OS（线程创建）+ OOPs（对象模型）+ Java Class Mirrors（类型桥接）

## 叙事计划

**开篇场景**：你写 JNI 代码时调了 `env->FindClass("java/lang/String")`，JVM 在 C++ 层找到 `java_lang_String` 对应的 `InstanceKlass`、返回一个 `jclass`。但你拿到的不是指针——是 JNI 句柄（handle）。JNI 层不直接把 C++ oop 暴露给 native 代码——中间隔了一层句柄管理，防止 native 代码持有过时指针碰上 GC。

**第一层：JNI 函数表——230 个函数指针**

`JNIEnv*` 指向 `JNINativeInterface_` 结构体（`jni.h:214`）——230 个函数指针。`env->FindClass()` 实际是 `(*env)->FindClass(env, name)`，通过函数表间接调用。`JNI_CreateJavaVM` 返回的 `JavaVM*` 也是同样的包装模式（`jni.h:1917`，`JavaVM_` 结构体只含单个 `functions` 指针，C++ 内联方法转发到 `JNIInvokeInterface_`）。

**第二层：JNI 句柄——local 和 global 引用**

`jobject` 不是 oop 指针——是 JNI 句柄表中的索引。Local 引用在 native 方法返回时自动释放（通过 `JNIHandleBlock` 栈），global 引用需要手动 `DeleteGlobalRef`。每个 `JNIHandleBlock` 固定 32 个槽位（`jniHandles.hpp:138`），链式扩展到下一块——总容量只受内存限制，不是固定上限。

`JNIHandles::make_local()` / `make_global()` 把 oop 包装成 jobject，`resolve()` 反向取出 oop。这一层就是 GC 安全的关键——GC 通过 JNI 句柄表找到所有 native 代码持有的对象引用，不当垃圾回收。

**第三层：jni.cpp——JVM 侧的实现**

`jni.cpp`（4463 行）是所有 JNI 函数在 HotSpot 侧的实现体。以 `jni_FindClass()` 为例：字符串类名 → `SystemDictionary::resolve_or_null()` → 返回 Klass → 用 `java_lang_Class::create_mirror()` 创建 mirror → 包装成 local 引用返回。每个 JNI 函数都遵循"查内部 HR → 包装成 JNI 类型"的模式。

**第四层：Critical Native——跳过句柄的快速通道**

`GetPrimitiveArrayCritical()` / `GetStringCritical()` 直接返回原始数组指针——跳过句柄层。代价是获取期间 JVM 进入"critical 模式"——不能触发 GC（GC 如果移动数组，native 代码的指针就野了）。必须成对调用 `Release*Critical()`。

**设计权衡**

一、句柄 vs 直接指针。句柄保护 native 代码免受 GC 对象移动的影响。代价是每次 JNI 调用多一次句柄表查找。Critical Native 跳过句柄但阻止 GC——只适合极短操作。

二、local 引用自动释放 vs 手动管理。自动释放简化了常见场景（native 方法返回后引用自动清理）。但 PushLocalFrame/PopLocalFrame 让调用方在长循环中手动释放，避免超出容量。

## 核心悬念

**Java 的 `System.loadLibrary()` 加载 .so 后，`env->FindClass()` 到底怎么从字符串变成 JVM 里的 Klass——中间经过函数表、句柄表、类加载器三道关卡？**

**→ 卷 02**：native 代码能操作 Java 对象了，但 100 个线程同时跑——JVM 怎么管理它们的生命周期、怎么让它们停下来、怎么协调 `synchronized`？并发骨架篇见。

## 预估

1 篇，4 层递进，预估 1500-2000 行。
