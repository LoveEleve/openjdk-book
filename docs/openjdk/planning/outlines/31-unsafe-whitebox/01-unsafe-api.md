# 01. Unsafe — JVM 底层 API

> 🔴 Deep | 1 KP 中的核心底层
> 读者处境: `AtomicInteger.compareAndSet(0,1)` → `Unsafe.compareAndSwapInt(obj, offset, 0, 1)` → JVM `Unsafe_CompareAndSwapInt`。这些是 Java 并发核心——CAS/park/unpark/putOrderedObject——全通过 Unsafe 暴露。
>
> ⚠️ 写作期修正(2026-08-13, vol-02/31-unsafe-whitebox/01 已按真实源码成文 151 行,本大纲为规划期产物,机制描述以文章为准):
> - **CAS 单路径错(JDK8 形态)**: 大纲的 "jint* addr=(jint*)((address)p+offset); Atomic::cmpxchg(x,addr,e)==e" 是 JDK8 旧版;JDK11 是**双路径**(unsafe.cpp:907-918): obj==NULL→RawAccess<>::atomic_cmpxchg(堆外裸地址),obj!=NULL→HeapAccess<>::atomic_cmpxchg_at(堆内字段,**带 GC barrier**,06-05 access API);index_oop_from_field_offset_long(unsafe.cpp:122-135,p==NULL 返回裸地址,32 位截断处理);assert_field_offset_sane(:914,debug 校验)
> - **行号全漂**: unsafe.cpp 共 1122 行;CAS 家族 :876-938、Park :939-955、Unpark :960-984、AllocateInstance :365-368、DefineAnonymousClass0 :830-862(+impl :741 起)、方法表 :1035-1109(40 条)、JVM_RegisterJDKInternalMiscUnsafeMethods :1116-1121(RegisterNatives 注册)、UNSAFE_ENTRY=JVM_ENTRY :64-70(interfaceSupport.inline.hpp:558-566,ThreadInVMfromNative);大纲 "40-200/300-400/400-550/500-600" 全错
> - **"getUnsafe 检查 caller class loader" 半对**: **jdk.internal.misc.Unsafe.getUnsafe() 无任何检查**(return theUnsafe,Unsafe.java:88-91,靠模块系统封闭,java.base 内部包);**sun.misc.Unsafe 才有**(@CallerSensitive+Reflection.getCallerClass+VM.isSystemDomainLoader,sun_misc_Unsafe.java:95-102,抛 SecurityException("Unsafe"),jdk.unsupported 模块,委托 jdk.internal.misc);名字检查非能力检查——反射拿 theUnsafe 可绕(实证)
> - **"allocateInstance 直接 allocate+zero fill" 半对**: 实际 = env->AllocObject(JNI 分配不调构造器,带 ThreadToNativeFromVM,unsafe.cpp:365-368);字段初始化器也不执行(实证 x=0)
> - **"~200 方法" 错**: 方法表 `jdk_internal_misc_Unsafe_methods` 实为 40 条(unsafe.cpp:1035-1109)
> - **JIT intrinsic 接线(大纲未提)**: 注释 unsafe.cpp:1112-1115 "The optimizer looks at names and signatures to recognize individual functions"——C2 按名字+签名认领 intrinsic(13-jit 域)
> - **park/unpark(大纲细节补全)**: Parker 是 per-thread 等待原语(01-os/03 拆过 futex 实现,**与 19 域 monitor 等待的 ParkEvent 是两套东西**);Unpark 用 ThreadsListHandle+cv_internal_thread_to_JavaThread(线程已死静默跳过,17-03 SMR);"幽灵 unpark"(target 终止后 Parker 类型稳定内存被复用)注释原话
> - **defineAnonymousClass**: JDK11 **无 deprecated 标记**(JDK15 JEP371 Hidden Classes 后废弃);host class 提供访问上下文,Lambda metafactory 使用
> - **实证**: 08-unsafe-demo.txt(getUnsafe SecurityException/反射取 theUnsafe/String.value offset=12(mark 8+压缩 klass 4)/CAS 成功/allocateInstance x=0/pageSize 4096/addressSize 8)

### 1. "CAS — 原子比较并交换"

场景: `Unsafe_CompareAndSwapInt(obj, offset, expected, newVal)` → 原子操作——在 x86 上是 `lock cmpxchg`。

**Unsafe CAS** (`unsafe.cpp:40-200`):
```cpp
UNSAFE_ENTRY(jboolean, Unsafe_CompareAndSwapInt(JNIEnv*, jobject, jlong offset, jint e, jint x))
  oop p = JNIHandles::resolve(obj);
  jint* addr = (jint*)((address)p + offset);
  return Atomic::cmpxchg(x, addr, e) == e;
UNSAFE_END
```
- 源码: `unsafe.cpp:40-200` CAS + `unsafe.hpp:30-80` 声明
- 关键设计: Unsafe 没有安全检查——直接读 oop+offset→指针算术。只有 JDK 内部类才能拿到 Unsafe 实例(通过 `Unsafe.getUnsafe()` 检查 caller class loader)
- [x86: `Atomic::cmpxchg` = `lock cmpxchgl [addr], newVal`。CAS 失败→调用者(Java 自旋循环)重试。`putOrderedInt` 可选——用 `xchg`(`lock`隐含)或简单 `mov`(store-store barrier即可)]

### 2. "park/unpark — LockSupport 底层"

场景: `LockSupport.park()` → `Unsafe.park(false, 0)` → `Parker::park()`(域19)。

**park/unpark** (`unsafe.cpp:500-600`):
```
Unsafe_Park(isAbsolute, time):
  → Parker::park(isAbsolute, time) // 如果 permit=0→cond_wait
Unsafe_Unpark(thread):
  → Parker::unpark(thread)          // set permit=1→cond_signal
```
- 源码: `unsafe.cpp:500-600` park/unpark
- 关键设计: park/unpark 用 permit 语义——先 unpark 后 park 有效。与 Object.wait/notify 不同——不需要先持有锁

### 3. "allocateInstance + defineAnonymousClass"

**allocateInstance** (`unsafe.cpp:300-400`):
```
Unsafe_AllocateInstance(Class klass):
  → bypass constructor:直接 allocate+zero fill instance
  → 用于 deserialization(不调构造器)
```
- 源码: `unsafe.cpp:300-400` allocate instance
**defineAnonymousClass** (`unsafe.cpp:400-550`):
```
Unsafe_DefineAnonymousClass(host, bytes, cp_patches):
  → ClassFileParser parse bytes→create InstanceKlass
  → 返回匿名类(无名称,仅能通过返回的 Class 引用访问)
  → 用于 Lambda expression (lambda metafactory)
```

---

### 核心悬念

**"Unsafe 暴露 JVM 底层~200方法——CAS/park/unpark/allocateInstance/defineAnonymousClass——绕过安全检查仅限 JDK 内部使用。"** — 下一篇: WhiteBox + Forte。

> → [02-whitebox-forte.md](02-whitebox-forte.md)
