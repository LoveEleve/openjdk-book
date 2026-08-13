# 01. Java 怎么绕过一切检查摸内存？— Unsafe: JVM 底层 API

> **前置依赖**:[08-interpreter/04 — LinkResolver + Rewriter](openjdk/vol-02/08-interpreter/04-linkresolver-rewriter.md):Unsafe 的 native 方法注册走 JNI 通道,解析链 08 域刚拆完;[06-oops/05 — 每次引用读写,GC 都在旁听](openjdk/vol-02/06-oops/05-access-api-barrier.md):CAS 的 HeapAccess 双路径是 access API 的消费者;[19-sync/03 — Enter/Exit 与 Wait/Notify](openjdk/vol-02/19-sync/03-enter-exit-wait.md):park/unpark 的 Parker 是锁等待的地基
> → **后续**:[31-unsafe/02 — JVM 开发的测试利器](02-whitebox-forte.md):WhiteBox 测试后门与 Forte 栈采样
> 关联域: 19-sync(park/unpark)、13-jit(Unsafe intrinsic)、42-core-native(JNI 通道)、06-oops(access API)

## 并发、反射、序列化、Lambda,都踩在同一个后门上

`AtomicInteger.compareAndSet` 的底层是 `Unsafe.compareAndSwapInt`;`LockSupport.park` 的底层是 `Unsafe.park`;反序列化框架绕过构造器建对象用的是 `Unsafe.allocateInstance`;Lambda 表达式的类由 `Unsafe.defineAnonymousClass` 生成。JDK 自身的"高级功能"几乎全靠 `sun.misc.Unsafe`(JDK 9 起为 `jdk.internal.misc.Unsafe`)——它是 JVM 对 JDK 内部开放的底层 API: 不检查访问权限、直接算指针、原子操作、原生内存。这一篇拆它: 两条入口通道与权限模型、CAS 的堆/堆外双路径、park/unpark 的 permit 语义、绕过构造器的分配,以及 JIT 怎么认领这些方法。

[实证:] Temurin 11 的 UnsafeDemo(materials/commands/08-unsafe-demo.txt): ①普通类调 `sun.misc.Unsafe.getUnsafe()` 直接 `SecurityException(Unsafe)`——caller 检查在;②反射取 `theUnsafe` 后:`String.value` 字段偏移 12(mark word 8B + 压缩 klass 指针 4B 的对象头)、`compareAndSwapInt` 数组元素成功、`allocateInstance` 拿到 x=0 的实例(构造器与字段初始化器都没执行)、`pageSize=4096`/`addressSize=8`。

## 1. 两条通道: 模块保护 vs caller 检查

### jdk.internal.misc.Unsafe: 无检查,靠模块

JDK 11 的实现类是 `jdk.internal.misc.Unsafe`(java.base 模块内部包,`jdk.internal` 的类只能被模块系统认可的内部调用者引用)——它的 `getUnsafe()` 就是 `return theUnsafe`(Unsafe.java:88-91),**没有任何运行时检查**: 门卫是模块系统本身(非 java.base 的模块无法引用 jdk.internal 包)。所有 native 方法注册在 hotspot 侧(unsafe.cpp:1035-1109 的方法表 `jdk_internal_misc_Unsafe_methods`,40 条),由 `JVM_RegisterJDKInternalMiscUnsafeMethods` 用 JNI `RegisterNatives` 注册(unsafe.cpp:1116-1121)——**入口宏 `UNSAFE_ENTRY` = `JVM_ENTRY`**(unsafe.cpp:64-70),即走 JNI 通道(ThreadInVMfromNative 状态转换)。

### sun.misc.Unsafe: 双保险,getUnsafe 有 caller 检查

`sun.misc.Unsafe`(jdk.unsupported 模块)是留给外部世界(不依赖模块的内部)的兼容壳,委托给 jdk.internal.misc.Unsafe。它的 `getUnsafe()` 有真正的权限检查(sun_misc_Unsafe.java:95-102,截取核心,逐字):

```java
// sun_misc_Unsafe.java:95-102(截取核心,逐字)
    @CallerSensitive
    public static Unsafe getUnsafe() {
        Class<?> caller = Reflection.getCallerClass();
        if (!VM.isSystemDomainLoader(caller.getClassLoader()))
            throw new SecurityException("Unsafe");
        return theUnsafe;
    }
```

`@CallerSensitive` + `Reflection.getCallerClass()` 拿到调用者的类,`VM.isSystemDomainLoader` 检查它是否由**引导类加载器**(系统域)加载——只有 JDK 自己的类能通过,普通应用类直接抛 `SecurityException("Unsafe")`。但这是**名字检查,不是能力检查**: 反射拿 `theUnsafe` 字段照样能用(JDK 测试的惯用手法,实证里就是这么拿到的——JDK 11 默认的 `--illegal-access=permit` 过渡模式下反射非导出包仅告警、仍可用;JDK 16+ 强封装后需 `--add-opens`)。所以这个检查防的是"误用",不是"绕过"。

**关键设计 (斜体)**: *Unsafe 的权限模型是"JDK 内部信任"而非"沙箱": jdk.internal.misc 靠模块系统封闭, sun.misc 靠 caller 检查拦截误用。方法本身不做任何安全检查——`getObject(obj, offset)` 不校验 offset 是否真的指向字段、不校验类型——这正是"Unsafe"名字的由来。*

## 2. CAS: 堆与堆外的双路径

### JDK 11 的签名与分派

大纲照抄的实现("`jint* addr = (jint*)((address)p + offset); return Atomic::cmpxchg(x, addr, e) == e;`")是早期 JDK(JDK 8 时代)的形态。JDK 11 的 `Unsafe_CompareAndSetInt` 是**双路径**(unsafe.cpp:907-918,截取核心,逐字):

```cpp
// unsafe.cpp:907-918(截取核心,逐字)
UNSAFE_ENTRY(jboolean, Unsafe_CompareAndSetInt(JNIEnv *env, jobject unsafe, jobject obj, jlong offset, jint e, jint x)) {
  oop p = JNIHandles::resolve(obj);
  if (p == NULL) {
    volatile jint* addr = (volatile jint*)index_oop_from_field_offset_long(p, offset);
    return RawAccess<>::atomic_cmpxchg(x, addr, e) == e;
  } else {
    assert_field_offset_sane(p, offset);
    return HeapAccess<>::atomic_cmpxchg_at(x, p, (ptrdiff_t)offset, e) == e;
  }
} UNSAFE_END
```

- **obj == NULL**: 目标是**堆外地址**(offset 就是裸地址)——`RawAccess<>::atomic_cmpxchg` 直接对指针做原子操作,无 GC 参与;
- **obj != NULL**: 目标是**堆内字段**——`HeapAccess<>::atomic_cmpxchg_at` 走 access API(06-05 拆过),**带 GC barrier**(G1 的 SATB/卡表标记等会在这个入口被触发)——同一个 CAS 语义,堆内堆外两条实现。

**关键设计 (斜体)**: *对堆内字段做 CAS 如果绕过 barrier,GC 的引用追踪就会漏掉并发写入的引用——所以堆内路径必须走 HeapAccess,堆外路径没有引用语义、走 RawAccess。这个"同一 API 双实现"的边界,就是 Unsafe 能同时服务并发工具(堆内字段)与堆外内存库(off-heap)的原因。`assert_field_offset_sane`(:914,定义 :105-118)在 debug 构建校验 offset 在对象内——**p 为 NULL(堆外)时断言体整体跳过**,只有堆内路径才校验;release 构建零检查。*

### 方法家族与 JIT 认领

同一模式覆盖全套: `compareAndExchangeInt/Long/Object`、`compareAndSetInt/Long/Object`(unsafe.cpp:876-938)、`getInt/putInt` 等 get/put 家族、`getIntVolatile/putIntVolatile`、`putOrdered*`。方法表(unsafe.cpp:1035-1109)把这些名字与签名逐一登记;unsafe.cpp:1112 的注释点明了 JIT 的接线方式:

```cpp
// unsafe.cpp:1112-1115(截取核心,逐字)
// This function is exported, used by NativeLookup.
// The Unsafe_xxx functions above are called only from the interpreter.
// The optimizer looks at names and signatures to recognize
// individual functions.
```

**解释器走 JNI 注册的入口;编译器(C2)按"名字+签名"直接认领成 intrinsic**(如 `getObject` → 内联的载荷指令),不再经过 JNI 调用——这是 13-jit 域 intrinsics 机制的接线点。`getObject`/`putObject` 的 volatile 变体与 `putOrdered*` 对应 x86 的不同内存序指令(volatile 读写在 x86 上是普通 mov + 屏障或 lock 前缀,putOrdered 是 store-store 语义的普通 store),C2 在编译期按语义生成。

## 3. park/unpark: permit 语义,与 wait/notify 不同

### 两个入口都是薄转发

`Unsafe_Park`(unsafe.cpp:939-955)与 `Unsafe_Unpark`(unsafe.cpp:960-984)直接转发给线程的 Parker——per-thread 的等待原语(01-os/03 的 threads-and-sync 拆过它的 futex 实现;注意它与 19 域 monitor 等待用的 ParkEvent 是两套东西):

```cpp
// unsafe.cpp:939-941(截取核心,逐字)
UNSAFE_ENTRY(void, Unsafe_Park(JNIEnv *env, jobject unsafe, jboolean isAbsolute, jlong time)) {
  HOTSPOT_THREAD_PARK_BEGIN((uintptr_t) thread->parker(), (int) isAbsolute, time);
  EventThreadPark event;
```

```cpp
// unsafe.cpp:960-984(截取核心,逐字)
UNSAFE_ENTRY(void, Unsafe_Unpark(JNIEnv *env, jobject unsafe, jobject jthread)) {
  Parker* p = NULL;

  if (jthread != NULL) {
    ThreadsListHandle tlh;
    JavaThread* thr = NULL;
    oop java_thread = NULL;
    (void) tlh.cv_internal_thread_to_JavaThread(jthread, &thr, &java_thread);
    if (java_thread != NULL) {
      // This is a valid oop.
      if (thr != NULL) {
        // The JavaThread is alive.
        p = thr->parker();
      }
    }
  } // ThreadsListHandle is destroyed here.

  // 'p' points to type-stable-memory if non-NULL. If the target
  // thread terminates before we get here the new user of this
  // Parker will get a 'spurious' unpark - which is perfectly valid.
  if (p != NULL) {
    HOTSPOT_THREAD_UNPARK((uintptr_t) p);
    p->unpark();
  }
} UNSAFE_END
```

`Unsafe_Unpark` 的细节: 传进来的 `jthread` 是 Java 线程对象——先经 `ThreadsListHandle`(17 域拆过的线程 SMR 机制)把 oop 安全地转成 `JavaThread*`,**线程已死就静默跳过**;注释解释了 permit 语义的边界情况: 目标线程在 unpark 前终止,Parker 的内存(类型稳定内存)被复用后,新用户会收到一次"幽灵 unpark"——permit 语义下完全合法。

### 与 Object.wait 的本质差异

park/unpark 不需要持有锁、没有"必须在 synchronized 块内"的约束;permit 是**一次性令牌**: 先 unpark 再 park,后者立即返回(令牌被消费)。LockSupport 就是在 Unsafe 这两个入口上加了"blocker 对象记录"(供线程转储显示等待原因)的薄封装。

## 4. allocateInstance 与 defineAnonymousClass

### allocateInstance: 绕过构造器,但不绕过分配

`Unsafe_AllocateInstance`(unsafe.cpp:365-368,截取核心,逐字):

```cpp
// unsafe.cpp:365-368(截取核心,逐字)
UNSAFE_ENTRY(jobject, Unsafe_AllocateInstance(JNIEnv *env, jobject unsafe, jclass cls)) {
  ThreadToNativeFromVM ttnfv(thread);
  return env->AllocObject(cls);
} UNSAFE_END
```

实现是 JNI 的 `AllocObject`——**分配对象并零初始化,但不调用任何构造器**(连字段初始化器都不执行;实证里 x 既不是 99 也不是 77,而是 0)。反序列化框架先造"空壳"再手工填字段,就是这个入口。注意它不是"直接 allocate+zero fill instance"的私有实现,而是复用 JNI 分配路径(带 `ThreadToNativeFromVM` 状态转换回 JNI 世界)。

### defineAnonymousClass: Lambda 的类工厂

`Unsafe_DefineAnonymousClass0`(unsafe.cpp:830-862)→ `Unsafe_DefineAnonymousClass_impl`(:741 起): 把字节数组交给类解析器生成**匿名类**——没有名字、只能通过返回的 `Class` 引用访问,host class 提供访问上下文(Lambda 表达式经由 metafactory 把合成的实现类按此方式生成)。JDK 15 的隐藏类(Hidden Classes,JEP 371)引入 `defineHiddenClass` 后它被废弃,**JDK 17 的 Unsafe 里已没有 defineAnonymousClass**(实测 Temurin 17 源码零命中);JDK 11 里还没有 deprecated 标记,但演进方向已定——Lambda 的合成类从"匿名类"迁到"隐藏类"。

## 核心悬念

Unsafe 拆完了: jdk.internal.misc 与 sun.misc 双通道(模块封闭 + caller 检查)、CAS 的堆内(HeapAccess/barrier)/堆外(RawAccess)双路径、park/unpark 的 permit 语义与线程安全转换、allocateInstance 复用 JNI 分配、方法表经 RegisterNatives 注册 + C2 按名字认领 intrinsic。它是 JDK 内部一切"高级功能"的地基,也是"绕过检查"的窗口——名字叫 Unsafe,权限模型却只有"信任"。

Unsafe 是"给 JDK 内部用的后门",那"给测试与工具用的后门"是什么?下一篇: WhiteBox——hotspot 的测试专用接口,以及 Forte(性能分析工具)怎么拿到 JVM 的内部数据。

> → [31-unsafe/02 — JVM 开发的测试利器](02-whitebox-forte.md)
