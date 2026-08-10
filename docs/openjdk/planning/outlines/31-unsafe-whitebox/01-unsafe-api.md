# 01. Unsafe — JVM 底层 API

> 🔴 Deep | 1 KP 中的核心底层
> 读者处境: `AtomicInteger.compareAndSet(0,1)` → `Unsafe.compareAndSwapInt(obj, offset, 0, 1)` → JVM `Unsafe_CompareAndSwapInt`。这些是 Java 并发核心——CAS/park/unpark/putOrderedObject——全通过 Unsafe 暴露。

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
