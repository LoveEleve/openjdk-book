# Phase 15: Core Native Bridge — libjava.so

> **libjava.so = Java 标准库的"最后一英里"。** System.arraycopy 是 Java 调用频率最高的 native 方法——每天几百亿次。它不走复杂的 JNI 参数解析——直接 memmove 复制字节。Object.hashCode 是一个 C 层的函数指针调用——跳转到 JVM 内部的 markOop hash 生成器。Class.forName 在 native 层完成 FindClass 调用——这是 Java reflection 的入口。

---

## §〇 上手指南

### 3-Tier Reading Path

| Tier | 读者 | 阅读量 | 重点 |
|------|------|:---:|------|
| 🥉 Bronze | 想理解为什么 System.arraycopy 这么快 | §二.1 + §四 00-System-A* | 30min |
| 🥈 Silver | 想理解 JNI 到 JVM 的完整调用链 | §二全篇 + §一 + §三 | 2h |
| 🥇 Gold | 想诊断生产问题 | §六 + §二 + source diving | 1天 |

### 前置阅读

| Phase | 需要理解的内容 | 本 Phase 用到 |
|-------|---------------|-------------|
| 09-native-interface | JNI_ENTRY / JVM_ENTRY 宏, JNI 参数 marshalling | 每个 native 方法的第一行 |
| 03-object-model | markOop, object header, identity hash 存储位置 | Object.hashCode → markOop |
| 02-class-loading | FindClass, system dictionary, class loader hierarchy | Class.forName → FindClass |
| 14-zip-jimage | ClassLoader.defineClass1 bridge, module path | ClassLoader 桥接到本 phase |

### 核心术语

| 术语 | 定义 | 出现位置 |
|------|------|---------|
| **JNI_ENTRY** | enter native from Java — slow path with parameter marshalling, oop→jobject wrapping | System.c:38, Object.c:43 |
| **JVM_ENTRY** | JVM internal entry — fast path, no JNI marshalling, direct oop access | jvm.cpp:328, jvm.cpp:609 |
| **JVM_LEAF** | JVM entry with no safepoint check — fastest, for pure functions like nanoTime | jvm.cpp:275 |
| **intrinsic** | C2 replaces native call with direct CPU instruction — no call overhead | §二.1, §二.3 |
| **markOop** | identity hash stored in object header's mark word (25 bits) | §二.2 |
| **memmove** | raw memory copy — no bounds check per element, CPU-vectorized | §二.1 |
| **StringTable** | interned string storage — ConcurrentHashTable in metaspace | §二.4 |
| **RegisterNatives** | JNI mechanism to bind Java native methods to C function pointers at registration time | System.c:38, Object.c:42 |

---

## §一 Native Method Density Map

| Tier | Methods | 日调用量 | 关键源码文件 | 桥接目标 |
|------|---------|:---:|------|------|
| 🔥 Hot | `System.arraycopy`, `Object.hashCode`, `Object.getClass`, `System.nanoTime`, `System.currentTimeMillis` | 10⁹–10¹⁰ | System.c, Object.c | JVM_ArrayCopy, JVM_IHashCode, JVM_NanoTime (JVM_LEAF) |
| 🟡 Warm | `Class.forName0`, `Class.getName0`, `String.intern`, `Throwable.fillInStackTrace`, `System.identityHashCode` | 10⁶–10⁸ | Class.c, String.c, Throwable.c | JVM_FindClassFromCaller, JVM_InternString, JVM_FillInStackTrace |
| 🟢 Cool | `Runtime.gc`, `Runtime.maxMemory`, `Array.newInstance`, `Float.floatToRawIntBits` | 10³–10⁶ | Runtime.c, Array.c, Float.c | JVM_GC, JVM_MaxMemory, pure C union |
| ⚪ Cold | `Object.notify/wait`, `Runtime.exit`, `Double.longBitsToDouble` | <10³ | Object.c, Runtime.c, Double.c | JVM_MonitorWait, JVM_Halt, pure C union |

> **关键观察**: `System.arraycopy`, `Object.hashCode`, `Object.getClass` 三者占据了 Java 程序 native 调用量的 >99%。它们的设计是 JVM 性能的瓶颈路径——每个优化直接体现在用户可感知的墙上时钟时间上。

### 完整源文件表

| 文件 | 行数 | 关键函数 | 调用热度 | 桥接方式 |
|------|:---:|------|:---:|------|
| System.c | 455 | `arraycopy`(RegisterNatives→JVM_ArrayCopy), `identityHashCode`(→JVM_IHashCode), `nanoTime`(RegisterNatives→JVM_NanoTime), `initProperties`(→GetJavaProperties+JVM_InitProperties) | 🔥 Hot | RegisterNatives + 直接 JVM_* 调用 |
| Object.c | 66 | `hashCode`(RegisterNatives→JVM_IHashCode), `getClass`(→GetObjectClass), `wait/notify/notifyAll`(RegisterNatives→JVM_Monitor*) | 🔥 Hot | RegisterNatives + JNI GetObjectClass |
| Class.c | 187 | `forName0`(→JVM_FindClassFromCaller), `isAssignableFrom`(→JNI IsAssignableFrom), `isInstance`(→JNI IsInstanceOf), `getPrimitiveClass`(→JVM_FindPrimitiveClass) | 🟡 Warm | RegisterNatives + JNI IsInstanceOf/IsAssignableFrom |
| String.c | 44 | `intern`(→JVM_InternString), `isBigEndian`(union hack) | 🟡 Warm | 直接 JVM_InternString |
| Runtime.c | 72 | `gc`(→JVM_GC), `availableProcessors`(→JVM_ActiveProcessorCount), `maxMemory`(→JVM_MaxMemory) | 🟢 Cool | 直接 JVM_* 调用 |
| Throwable.c | 51 | `fillInStackTrace`(→JVM_FillInStackTrace) | 🟡 Warm | 直接 JVM_FillInStackTrace |
| Array.c | 208 | `newArray`(→JVM_NewArray), `getLength`(→JVM_GetArrayLength), typed get/set(→JVM_*PrimitiveArrayElement) | 🟢 Cool | 直接 JVM_* 调用 |
| Float.c | 57 | `floatToRawIntBits`(C union), `intBitsToFloat`(C union) | 🟢 Cool | **纯 C — 无 JVM 调用** |
| Double.c | 61 | `longBitsToDouble`(C union), `doubleToRawLongBits`(C union) | 🟢 Cool | **纯 C — 无 JVM 调用** |
| jni_util.c | 1506 | `JNU_ThrowNullPointerException`, `JNU_NewStringPlatform`, `JNU_GetStringPlatformChars`, `JNU_NewObjectByName`, `JNU_ClassString`, `JNU_ClassClass`, `JNU_Equals` | — (utility) | JNI 标准 API |

---

## §二 First-Principles Design Decisions

### 1. Why System.arraycopy in native instead of Java?

```
Java loop: 1 array bounds check per iteration
Native memmove: 0 checks per byte → 1 vectorized copy

1M element copy:
  Java:  1M bounds checks → ~10ms
  memmove: 1 vectorized copy → ~0.1ms
     Speedup: ~100x
```

Why memmove not memcpy? Java spec says arraycopy "copies as though to a temporary array first" — meaning overlapping source and destination must work correctly. memcpy is undefined behavior on overlap (C standard: "memory areas must not overlap"). memmove handles overlap by checking direction (src < dst → copy backwards) before the same vectorized copy loop. Overhead: ~1% for non-overlapping case — the direction check is 1 CPU branch — acceptable for the correctness guarantee.

**Source**: System.c:41 — `arraycopy` is registered as `JVM_ArrayCopy` via `RegisterNatives`. The actual implementation at jvm.cpp:328-341 uses `JVM_ENTRY` and delegates to `klass()->copy_array()`:

```c
// jvm.cpp:340
s->klass()->copy_array(s, src_pos, d, dst_pos, length, thread);
```

`Klass::copy_array()` is dispatched based on array type at runtime:
- **Primitive arrays**: `typeArrayKlass::copy_array()` → `memmove` — pure memory copy, no per-element type check
- **Object arrays**: `objArrayKlass::copy_array()` → type check each element against destination's component type, then copy oop references

**C2 further intrinsifies this**: When the JIT knows both src and dst are primitive arrays of known type at compile time, it replaces the JNI call with direct `REP MOVS` (x86) or equivalent SIMD instructions. This eliminates 100% of call overhead.

### 2. Why Object.hashCode delegates to JVM_IHashCode?

Hash code is stored in the object header's mark word (markOop). The JVM owns the object header — Java code cannot dereference raw memory addresses to read it.

**Source**: Object.c:43 — `hashCode` is registered as `JVM_IHashCode` via `RegisterNatives`. The JVM implementation at jvm.cpp:609-613:

```c
JVM_ENTRY(jint, JVM_IHashCode(JNIEnv* env, jobject handle))
    // as implemented in the classic virtual machine; return 0 if object is NULL
    return handle == NULL ? 0 :
        ObjectSynchronizer::FastHashCode(THREAD,
            JNIHandles::resolve_non_null(handle));
JVM_END
```

`ObjectSynchronizer::FastHashCode()` reads the identity hash from markOop. If the hash hasn't been computed yet (lazy allocation), it computes and stores it into the mark word's 25-bit hash field. This is the same function called by `System.identityHashCode()` (System.c:56).

**C2 intrinsic**: The JIT can replace `Object.hashCode()` with a direct field read when it knows the object layout. The hash is stored at a fixed offset in the object header.

### 3. Why Float.floatToRawIntBits is native?

Java has no `union` type. C allows zero-cost bit-level reinterpretation:

```c
// Float.c:49-56
union {
    int i;
    float f;
} u;
u.f = (float)v;
return (jint)u.i;
```

This is a **pure register-level operation** — the CPU just reinterprets the same 32 bits as `int` instead of `float`. Zero memory access, zero computation. C2 further intrinsifies this to nothing: the value stays in the same register, just the interpretation changes. Equivalent to `movd` on x86.

The difference from `Float.floatToIntBits` (Java method in the same class): `floatToRawIntBits` preserves NaN values as-is, while `floatToIntBits` collapses all NaN variants to a single canonical NaN. Both are native for the same reason — Java can't do bit-level type reinterpretation.

Same pattern for `Double.longBitsToDouble` at Double.c:37-46.

### 4. Why String.intern needs native?

`StringTable` is a JVM-internal hash table (`ConcurrentHashTable<StringTableConfig>`) stored in **metaspace** (native memory, not Java heap). Java code cannot directly access native memory.

**Source**: String.c:32 — single-line delegate:

```c
JNIEXPORT jobject JNICALL
Java_java_lang_String_intern(JNIEnv *env, jobject this)
{
    return JVM_InternString(env, this);
}
```

`JVM_InternString` (jvm.cpp:3542) → `StringTable::intern()` → search existing entry (return if found) or insert new entry and return it. The table uses `ConcurrentHashTable` — lock-free reads, CAS-based writes.

The StringTable must be native because:
1. It lives in native memory (metaspace), not Java heap
2. It uses CAS for concurrent access — Java has `AtomicReferenceFieldUpdater` but not CAS on raw native pointers
3. It must survive GC — interned strings are strong GC roots, tracked from native

如果将 StringTable 放在 Java 堆：每次 intern() 需要 3 次 JNI 穿越（lookup→insert→return），每次 oop↔jstring 包装 ~50ns → 3×50ns = ~150ns per intern。在 metaspace 中：CAS 原子操作 ~10ns → ~15x faster。这就是为什么 StringTable 不能放在 Java 堆——intern 的热路径需要 JVM 内部级别的延迟。

### 5. Why System.identityHashCode bypasses overridden hashCode()?

```java
// User code
class SneakyKey {
    @Override public int hashCode() { return (int)(Math.random() * 1000); }
}
SneakyKey key = new SneakyKey();
key.hashCode();                 // Returns random value → changes every call
System.identityHashCode(key);   // Returns stable value from markOop
```

`obj.hashCode()` is virtual dispatch — if a subclass overrides it, the overridden version runs. `System.identityHashCode(obj)` is **native** (System.c:54-57) — it calls `JVM_IHashCode(env, x)` directly, which reads the identity hash from markOop:

```c
JNIEXPORT jint JNICALL
Java_java_lang_System_identityHashCode(JNIEnv *env, jobject this, jobject x)
{
    return JVM_IHashCode(env, x);
}
```

This is the **same** JVM_IHashCode function used by `Object.hashCode()`. The only difference is that `Object.hashCode()` goes through virtual dispatch (which may be overridden), while `System.identityHashCode()` goes directly to native and reads the raw markOop hash. HashMap uses identityHashCode internally to avoid infinite loops when a mutable key's hashCode changes.

### 6. Why Throwable.fillInStackTrace is native?

Stack walking requires reading **native frames**: C2-compiled methods (their compiled code is in nmethod), interpreter frames, and native C frames. Java code cannot dereference raw stack pointers or read nmethod metadata.

**Source**: Throwable.c:46-51:

```c
JNIEXPORT jobject JNICALL
Java_java_lang_Throwable_fillInStackTrace(JNIEnv *env, jobject throwable, jint dummy)
{
    JVM_FillInStackTrace(env, throwable);
    return throwable;
}
```

`JVM_FillInStackTrace` at jvm.cpp:525-529:

```c
JVM_ENTRY(void, JVM_FillInStackTrace(JNIEnv* env, jobject receiver))
    Handle exception(thread, JNIHandles::resolve_non_null(receiver));
    java_lang_Throwable::fill_in_stack_trace(exception);
JVM_END
```

`java_lang_Throwable::fill_in_stack_trace()` walks the thread's Java stack frame by frame, extracting method name, class name, file name, and line number from each frame's metadata (nmethod or Method*). Works through C2-compiled frames because nmethod stores the source-level debug info needed for deoptimization.

### 7. Why Runtime.availableProcessors is native?

Must call OS-level APIs — `sysconf(_SC_NPROCESSORS_ONLN)` on Linux/Unix, or read cgroup limits (`/sys/fs/cgroup/cpu/cpu.cfs_quota_us`). Java has no direct system call API.

**Source**: Runtime.c:69-72:

```c
JNIEXPORT jint JNICALL
Java_java_lang_Runtime_availableProcessors(JNIEnv *env, jobject this)
{
    return JVM_ActiveProcessorCount();
}
```

`JVM_ActiveProcessorCount` at jvm.cpp:507-510:

```c
JVM_ENTRY_NO_ENV(jint, JVM_ActiveProcessorCount(void))
    return os::active_processor_count();
JVM_END
```

`os::active_processor_count()` is platform-specific. On Linux, since JDK 10, it reads cgroup CPU limits from cgroupfs to correctly report available CPUs inside Docker/Kubernetes containers. Before JDK 10, it only called `sysconf(_SC_NPROCESSORS_ONLN)` which returns the **host** CPU count — a critical bug for containerized deployments.

Note: `JVM_ENTRY_NO_ENV` — no JNIEnv needed, this is a pure OS query with no Java heap access.

### 8. Why System.nanoTime doesn't just return System.currentTimeMillis × 10⁶?

Two different OS clocks with fundamentally different guarantees:

| | System.currentTimeMillis | System.nanoTime |
|---|---|---|
| **OS call** | `gettimeofday()` or `clock_gettime(CLOCK_REALTIME)` | `clock_gettime(CLOCK_MONOTONIC)` |
| **Nature** | Wall clock | Monotonic clock |
| **NTP adjustment** | Can jump forward/backward | Never goes backward |
| **Use case** | Timestamps, dates | Performance measurement, timeouts |

**Source**: jvm.cpp:275-283:

```c
JVM_LEAF(jlong, JVM_CurrentTimeMillis(JNIEnv* env, jclass ignored))
    return os::javaTimeMillis();
JVM_END

JVM_LEAF(jlong, JVM_NanoTime(JNIEnv* env, jclass ignored))
    return os::javaTimeNanos();
JVM_END
```

Both use `JVM_LEAF` — the fastest JVM entry type, no safepoint check. If you measured latency with `currentTimeMillis * 1000000`, NTP adjustments or leap seconds would cause negative or wildly incorrect intervals. `nanoTime` is monotonic by contract.

### 9. Why does RegisterNatives exist instead of name-based lookup?

Notice that System.c, Object.c, and Class.c all call `RegisterNatives` in their static initializer to bind Java methods to native function pointers at registration time, rather than relying on JNI's default name-based lookup (`Java_package_Class_methodName`).

**Source**: System.c:38-42 registers arraycopy, currentTimeMillis, nanoTime with explicit function pointers. Object.c:42-48 does the same for hashCode, wait, notify, notifyAll, clone. Class.c:54-79 registers 20+ methods.

Without `RegisterNatives`, JNI would search for a C function named `Java_java_lang_System_arraycopy` in the shared library symbol table. This is slower (dynamic symbol lookup) and requires exact naming. `RegisterNatives` allows:
1. **Direct function pointer binding** — zero symbol lookup overhead at native call time (the function pointer is cached after the first call anyway, but the intent is clear)
2. **Reusing JVM internal functions** — e.g., `JVM_ArrayCopy` is used by both System.arraycopy and other internal paths
3. **Clean naming** — JVM functions don't need `Java_*` prefix

---

## §三 Source Files Table

| 文件 | 行数 | 关键函数 | 调用热度 | 桥接方式 |
|------|:---:|------|:---:|------|
| System.c | 455 | `arraycopy`(RegisterNatives→JVM_ArrayCopy), `identityHashCode`(→JVM_IHashCode), `initProperties`(→GetJavaProperties+JVM_InitProperties), `setIn0/setOut0/setErr0`(JNI SetStaticObjectField), `mapLibraryName`(string manipulation) | 🔥 Hot | RegisterNatives + 直接 JVM_* 调用 |
| Object.c | 66 | `hashCode`(RegisterNatives→JVM_IHashCode), `getClass`(→GetObjectClass), `wait/notify/notifyAll`(RegisterNatives→JVM_Monitor*), `clone`(RegisterNatives→JVM_Clone) | 🔥 Hot | RegisterNatives + JNI GetObjectClass |
| Class.c | 187 | `forName0`(→JVM_FindClassFromCaller), `isAssignableFrom`(→JNI IsAssignableFrom), `isInstance`(→JNI IsInstanceOf), `getPrimitiveClass`(→JVM_FindPrimitiveClass), `getSuperclass`(→JNI GetSuperclass) | 🟡 Warm | RegisterNatives + JNI IsInstanceOf/IsAssignableFrom |
| String.c | 44 | `intern`(→JVM_InternString), `isBigEndian`(union hack on `0xff000000`) | 🟡 Warm | 直接 JVM_InternString |
| Runtime.c | 72 | `gc`(→JVM_GC), `availableProcessors`(→JVM_ActiveProcessorCount), `maxMemory/totalMemory/freeMemory`(→JVM_*Memory) | 🟢 Cool | 直接 JVM_* 调用 |
| Throwable.c | 51 | `fillInStackTrace`(→JVM_FillInStackTrace) | 🟡 Warm | 直接 JVM_FillInStackTrace |
| Array.c | 208 | `newArray`(→JVM_NewArray), `getLength`(→JVM_GetArrayLength), `get/set`(→JVM_*PrimitiveArrayElement), `multiNewArray`(→JVM_NewMultiArray) | 🟢 Cool | 直接 JVM_* 调用 |
| Float.c | 57 | `floatToRawIntBits`(C union), `intBitsToFloat`(C union) | 🟢 Cool | **纯 C union — 无 JVM 调用** |
| Double.c | 61 | `longBitsToDouble`(C union+`jlong_to_jdouble_bits`), `doubleToRawLongBits`(C union+`jdouble_to_jlong_bits`) | 🟢 Cool | **纯 C union — 无 JVM 调用** |
| jni_util.c | 1506 | `JNU_ThrowNullPointerException`, `JNU_ThrowByName`(15种异常), `JNU_NewStringPlatform`, `JNU_GetStringPlatformChars`(4种编码快路径: UTF-8/8859-1/646-US/Cp1252), `JNU_NewObjectByName`, `JNU_ClassString/ClassClass/ClassObject/ClassThrowable`(全局缓存的 jclass), `JNU_Equals`, `JNU_CopyObjectArray`, `JNU_GetEnv`, `JNU_MonitorWait/Notify/NotifyAll` | — (utility) | JNI 标准 API |

---

## §四 Document Plan

### 00-System-Arraycopy-HashCode.md — the HOT path methods

**核心问题**: "`System.arraycopy(src, 0, dst, 0, 1000000)` — 这 100 万次复制如何在 0.1ms 内完成？"

**生产案例**: "ArrayStoreException on Object[] arraycopy — `src` 包含 Integer, `dst` 是 Object[] 但 `dst` 实际运行时类型是 String[]。JVM 隐式存储了 String.class 作为元素类型 → Integer 复制进 String[] → 类型不匹配。\n错误信息: `java.lang.ArrayStoreException: java.lang.Integer`"

**覆盖范围**:
- `System.arraycopy` dispatch: `isPrimitive → memmove / isObject → type-check + oop copy` (jvm.cpp:340 `s->klass()->copy_array()`)
- `Object.hashCode`: `JVM_IHashCode → ObjectSynchronizer::FastHashCode → markOop::hash()` (jvm.cpp:609-612)
- `Object.getClass`: `GetObjectClass` JNI call (Object.c:64)
- `System.identityHashCode`: same as hashCode but bypasses virtual dispatch (System.c:56)
- `System.nanoTime` / `currentTimeMillis`: `JVM_LEAF → os::javaTimeNanos/Millis` (jvm.cpp:275-283)
- C2 intrinsification: arraycopy → REP MOVS, hashcode → direct field read, nanoTime → direct syscall

**源码**: System.c, Object.c, jvm.cpp

### 01-Class-String-Native.md — reflection + interning

**核心问题**: "Class.forName('com.example.Foo') 在 OSGi/模块系统中抛出 CNFE 但 Foo.class 编译正常——caller-classloader 陷阱。Class.forName 用的是**调用者的** ClassLoader，不是当前线程的 context ClassLoader。这个微妙的差异是 OSGi ClassNotFoundException 的 #1 根源。"

**生产案例**: "`ClassNotFoundException: com.example.Foo` — forName0 用了错误的 classloader。使用的是调用者（caller）的 classloader，而不是当前线程的上下文 classloader —— 这个微妙差别在 OSGi/module 系统中导致 NoClassDefFoundError。"

**覆盖范围**:
- `Class.forName0`: `JVM_FindClassFromCaller(env, clname, initialize, loader, caller)` (Class.c:137) — 使用 CALLER 的 classloader
- Verification: `VerifyClassname(clname, JNI_TRUE)` before calling JVM (Class.c:132)
- `Class.isAssignableFrom`: `JNI IsAssignableFrom(cls2, cls)` (Class.c:162)
- `Class.isInstance`: `JNI IsInstanceOf(obj, cls)` (Class.c:152)
- `String.intern`: `JVM_InternString → StringTable::intern()` (String.c:32) — ConcurrentHashTable lock-free on read
- `Class.getName0`: binary name conversion — "java/lang/Object" → "java.lang.Object"

**源码**: Class.c, String.c, jvm.cpp

### 02-Runtime-Throwable.md — system + stack walking

**核心问题**: "Docker 容器中 Runtime.availableProcessors() 返回 64 而不是 2——GC 线程数错误导致 STW 暂停 10 倍于预期。JDK 10+ 增加了 cgroup 感知——但在 JDK 8/9 中，JVM 错误地读取了宿主机的 CPU 数。"

**生产案例**: "容器重启循环: `Runtime.availableProcessors()` 返回宿主机 CPU 数 (64)，但容器只有 2 CPUs。JVM 创建 64 个 GC 线程 → 62 个线程空转 + 上下文切换开销 → GC STW 时间 10x 增长。\n诊断: `java -XX:+PrintFlagsFinal | grep ParallelGCThreads` → 64。检查: `cat /sys/fs/cgroup/cpu.max`"

**覆盖范围**:
- `Runtime.availableProcessors`: `JVM_ActiveProcessorCount → os::active_processor_count()` (jvm.cpp:507-510) — JVM_ENTRY_NO_ENV, cgroup-aware since JDK 10
- `Runtime.gc`: `JVM_GC()` (Runtime.c:65) — triggers G1CollectedHeap::collect()
- `Runtime.maxMemory/totalMemory/freeMemory`: `JVM_*Memory()` (Runtime.c:47-59) — read from CollectedHeap
- `Throwable.fillInStackTrace`: `JVM_FillInStackTrace → java_lang_Throwable::fill_in_stack_trace` (Throwable.c:49, jvm.cpp:525-528) — walks thread stack, reads nmethod metadata for C2 frames

**源码**: Runtime.c, Throwable.c, jvm.cpp

### 03-JNI-Utility-Layer.md — jni_util.c shared infrastructure

**核心问题**: "每个 libjava native 方法都使用 JNU_* 工具函数。jni_util.c 里有什么？"

**覆盖范围**:
- Exception helpers (lines 44-149): `JNU_ThrowNullPointerException`, `JNU_ThrowByName` (15 exception types), `JNU_ThrowByNameWithLastError`, `JNU_ThrowIOExceptionWithLastError`
- String conversion (lines 446-995): `JNU_NewStringPlatform`, `JNU_GetStringPlatformChars`, fast paths for UTF-8/8859-1/646-US/Cp1252, `InitializeEncoding` sets up encoding dispatch
- Object construction (lines 415-444): `JNU_NewObjectByName` — FindClass + GetMethodID(<init>) + NewObjectV
- Class caching (lines 1011-1073): `JNU_ClassString`, `JNU_ClassClass`, `JNU_ClassObject`, `JNU_ClassThrowable` — all use `static jclass` + `NewGlobalRef` pattern to cache frequently-used jclass references
- Method calling (lines 246-413): `JNU_CallStaticMethodByName`, `JNU_CallMethodByName`, `JNU_CallMethodByNameV` — va_list-based generic invocation
- Field access (lines 1246-1506): `JNU_GetFieldByName`, `JNU_SetFieldByName`, `JNU_GetStaticFieldByName`, `JNU_SetStaticFieldByName`
- Misc: `JNU_Equals` (lines 1113-1125), `JNU_CopyObjectArray` (lines 1075-1088), `JNU_GetEnv` (lines 1090-1096), `JNU_MonitorWait/Notify/NotifyAll` (lines 1136-1194), `JNU_PrintString`, `JNU_PrintClass`, `JNU_ToString`

**源码**: jni_util.c (1506 lines)

---

## §五 Interview Questions

### 1. "How does System.arraycopy work?"

`System.arraycopy` is registered via `RegisterNatives` to `JVM_ArrayCopy` (System.c:41). In `jvm.cpp:328-341`, it resolves src/dst to `arrayOop`, then calls `s->klass()->copy_array()`. For primitive arrays, this is `memmove` — pure memory copy with zero per-element checks. For Object arrays, it type-checks each element against the destination's component type, then copies oop references. C2 further intrinsifies the known-type primitive case to `REP MOVS` on x86, eliminating all call overhead and bounds checking.

### 2. "Why doesn't Object.hashCode just return a Java int field?"

The identity hash code is stored in the object header's mark word (markOop) — a 25-bit field in the header that the JVM owns. A Java int field would require a full object field (4 bytes in the object body, not header), which would increase every object's size by 8 bytes (object header alignment). `JVM_IHashCode` (jvm.cpp:609) calls `ObjectSynchronizer::FastHashCode` which reads from markOop. C2 intrinsifies this to a direct header field read at a known offset.

### 3. "What's the difference between Object.hashCode and System.identityHashCode?"

`obj.hashCode()` goes through Java virtual dispatch — a subclass can override it to return anything (even a constant or random value). `System.identityHashCode(obj)` calls `JVM_IHashCode(env, obj)` directly (System.c:56) — it reads the identity hash from markOop, bypassing any Java-level overrides. Both ultimately call the same `ObjectSynchronizer::FastHashCode` function. HashMap uses `identityHashCode` internally to avoid infinite loops when a mutable key's `hashCode()` changes over time.

### 4. "Why is Float.floatToRawIntBits native?"

Java has no C `union` type. The native implementation at Float.c:49-56 uses `union { int i; float f; }` to reinterpret the same 32 bits — zero CPU cost, just a register-level reinterpretation. C2 intrinsifies this to nothing: the value stays in the same register, only the interpretation changes (equivalent to `movd` on x86). This is different from `Float.floatToIntBits` which additionally collapses all NaN encodings to a single canonical NaN.

### 5. "How does Class.forName find the class?"

`Class.forName0` at Class.c:98-144 validates the class name (lines 125-135: `VerifyFixClassname`, `VerifyClassname`), then calls `JVM_FindClassFromCaller(env, clname, initialize, loader, caller)` at line 137. The `caller` parameter is the caller's `Class` object — the JVM uses the **caller's classloader** (not the current thread's context classloader) to find the class. At jvm.cpp:795-823, `JVM_FindClassFromCaller` creates a `TempNewSymbol` from the name, resolves caller's protection domain, and delegates to `find_class_from_class_loader`. This is why OSGi/JPMS classloading breaks — the wrong classloader is used if the caller's classloader doesn't have visibility to the target class.

### 6. "How does String.intern work?"

`Java_java_lang_String_intern` at String.c:30-33 is a single-line delegate to `JVM_InternString(env, this)`. `JVM_InternString` calls `StringTable::intern()` which searches the `ConcurrentHashTable<StringTableConfig>` — a lock-free-on-read, CAS-based-on-write hash table stored in metaspace (native memory). If the string already exists, returns the existing entry (deduplication). Otherwise, inserts a new entry and returns it. The StringTable entries are strong GC roots — interned strings are never collected.

### 7. "How does Runtime.availableProcessors work in Docker?"

`Runtime.c:71` → `JVM_ActiveProcessorCount()` at `jvm.cpp:507-510` → `os::active_processor_count()`. Since JDK 10, on Linux with `UseContainerSupport` enabled, the implementation reads cgroup CPU limits: `cpu.cfs_quota_us / cpu.cfs_period_us` from cgroup v1 (`/sys/fs/cgroup/cpu/`) or `cpu.max` from cgroup v2. Pre-JDK 10, it only called `sysconf(_SC_NPROCESSORS_ONLN)` which returns the host CPU count — the root cause of "JVM creates 64 GC threads on a 2-CPU container" bugs. The function uses `JVM_ENTRY_NO_ENV` — no JNIEnv needed, pure OS query.

### 8. "How does Throwable.fillInStackTrace capture the stack?"

`Throwable.c:47-51` → `JVM_FillInStackTrace(env, throwable)` at `jvm.cpp:525-528` → `java_lang_Throwable::fill_in_stack_trace(exception)`. This walks the current thread's stack frame by frame, reading metadata from each frame: method name, class name, file name, and line number. For C2-compiled frames, this metadata is stored in the nmethod's `ScopeDesc` chain (the same metadata used for deoptimization). For interpreter frames, the `Method*` and BCI are read directly from the frame structure. The result is a `StackTraceElement[]` stored in the Throwable's `backtrace` field.

### 9. "Why use RegisterNatives instead of JNI name-based lookup?"

`System.c:38-42` registers `arraycopy` with `JVM_ArrayCopy` directly via `RegisterNatives`. `Object.c:42-48` does the same for `hashCode`, `wait`, `notify`, etc. This allows the native implementation to be a JVM-internal function with a short name like `JVM_ArrayCopy` instead of the JNI-required `Java_java_lang_System_arraycopy`. More importantly, it allows the same function pointer to be shared — `JVM_IHashCode` is used by both `Object.hashCode` (Object.c:43) and `System.identityHashCode` (System.c:56) without needing two differently-named functions.

### 10. "What are the three JVM entry types and when are they used?"

| Type | Macro | Safepoint Check | Use Case | Example |
|------|-------|:---:|------|------|
| `JVM_ENTRY` | Full entry with THREAD | Yes | Most native methods that access Java heap | JVM_ArrayCopy (jvm.cpp:328), JVM_IHashCode (jvm.cpp:609) |
| `JVM_ENTRY_NO_ENV` | No JNIEnv parameter | Yes | OS-level queries, no heap access needed | JVM_ActiveProcessorCount (jvm.cpp:507) |
| `JVM_LEAF` | No safepoint check | **No** | Pure functions, cannot touch heap | JVM_NanoTime (jvm.cpp:280), JVM_CurrentTimeMillis (jvm.cpp:275) |

`JVM_LEAF` is the fastest — the JVM doesn't check for GC safepoints or thread suspension. Used only for OS calls that return immediately and never access Java objects.

---

## §六 Production Scenarios

| 场景 | 症状 | 文档 | 诊断步骤 | 错误信息 |
|------|------|------|---------|---------|
| **ArrayStoreException** | `java.lang.ArrayStoreException: java.lang.Integer` | 00 | 检查 `src` 元素类型 vs `dst` 声明的运行时类型。Object[] copy 时 dst 实际类型是 String[] → Integer 复制进 String[] → 类型检查失败 (jvm.cpp:340 → objArrayKlass::copy_array type check) | `java.lang.ArrayStoreException: java.lang.Integer` |
| **ClassNotFoundException (OSGi)** | `Class.forName('Foo')` 失败但 `Foo.class` 编译通过 | 01 | 检查调用者的 classloader。forName 使用 `JVM_FindClassFromCaller` (Class.c:137) — 使用 CALLER 的 loader，不是 context classloader。OSGi bundle 的 loader 看不到 export 的包 | `java.lang.ClassNotFoundException: com/example/Foo` |
| **容器 CPU 误报** | GC 线程数 = 64 但容器只有 2 CPUs | 02 | `java -XX:+PrintFlagsFinal \| grep ParallelGCThreads` → 检查 `-XX:ActiveProcessorCount`。检查 cgroup 限制: `cat /sys/fs/cgroup/cpu.max` (cgroup v2) 或 `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` (cgroup v1)。JDK < 10 不读取 cgroup (jvm.cpp:507 → os::active_processor_count) | Pre-JDK 10: 静默失败，无错误但 GC STW 时间异常 |
| **identityHashCode 无限循环** | HashMap 在可变 key 上无限循环 | 00 | `Object.hashCode()` 被覆盖返回变化值 → HashMap 无法定位 entry → 改迭代成 infinite loop。修正: 对可变 key 的 hash-based 集合使用 `System.identityHashCode(key)` (System.c:56 → 直接从 markOop 读取) | 无异常 — 程序挂起 |
| **nanoTime 负值** | 性能测量出现负值 | 00 | 使用 `System.currentTimeMillis()` 做性能测量 → NTP 调整使 wall clock 回退 → 负间隔。修正: 使用 `System.nanoTime()` — `clock_gettime(CLOCK_MONOTONIC)` 永不回退 (jvm.cpp:280 JVM_LEAF) | 无异常 — 错误的性能数据 |
| **static final field 赋值** | 无法通过 Java 修改 System.in/out/err | 00 | `System.setIn()` 需要修改 `static final` 字段 — Java 不允许。`System.c:393-421` 中 `setIn0/setOut0/setErr0` 是 native 方法，通过 `GetStaticFieldID + SetStaticObjectField` 直接操作 JVM 内部字段，绕过 Java final 限制 | 无 — native 方法透明处理 |
| **Array.get() 类型混淆** | `java.lang.reflect.Array.get()` 返回错误类型 | 00 | Array.c:52 → JVM_GetArrayElement。Object[] 返回 jobject，primitive[] 需要类型化的 get (Array.c:56-109: getBoolean/Byte/Char/.../Double) | `java.lang.IllegalArgumentException: Argument is not an array` |
| **跨线程 wait/notify** | IllegalMonitorStateException | 02 | Object.c:44-46 将 wait/notify/notifyAll 注册为 JVM_MonitorWait/JVM_MonitorNotify — 要求当前线程持有对象 monitor。未持有 monitor 时调用 → exception | `java.lang.IllegalMonitorStateException` |

---

## §七 Quality Audit Matrix

| 文档 | 预估行数 | 源码证据密度 | 覆盖完整度 | 当前状态 |
|------|:---:|:---:|:---:|:---:|
| 00-System-Arraycopy-HashCode.md | 500+ | ⭐⭐⭐⭐⭐ (每行有 System.c/jvm.cpp 行号) | 🔥 Hot path 全覆盖 + C2 intrinsic 说明 | 待写 |
| 01-Class-String-Native.md | 400+ | ⭐⭐⭐⭐ (Class.c 187行短而清晰，但 getName0 深入需要 jvm.cpp) | 🟡 Warm path 全覆盖 + production case | 待写 |
| 02-Runtime-Throwable.md | 400+ | ⭐⭐⭐⭐ (Runtime.c 72行短而清晰，Throwable.c 51行，但深层逻辑在 jvm.cpp) | 🟢 Cool path 全覆盖 + container awareness | 待写 |
| 03-JNI-Utility-Layer.md | 350+ | ⭐⭐⭐⭐⭐ (jni_util.c 1506行, 20+ utility functions) | Utility 层全覆盖 + encoding fast paths | 待写 |

---

## §八 Deep Questions (12 questions, 5 tiers)

### Tier 1: Basic Understanding

**Q1**: "Why is System.arraycopy native instead of Java?"
→ §二.1: 1M bounds checks in Java loop vs 1 vectorized memmove. 100x speedup. Also, C2 can intrinsify to `REP MOVS` which Java code can't generate.

**Q2**: "Why not store hashCode in a Java int field instead of markOop?"
→ §二.2: A Java int field adds 4 bytes to EVERY object body (plus alignment → 8 bytes). markOop already exists in the object header — adding the hash there has zero space cost. Also, the JVM needs the hash for synchronization (biased locking uses markOop bits).

### Tier 2: Design Philosophy

**Q3**: "Why does forName use caller's classloader — is it security or design?"
→ §五.5: It's by design for correctness — `Class.forName("Foo")` in your code should resolve `Foo` in YOUR context, not the context of whoever installed a context classloader on the current thread. This follows lexical scoping: the class loading environment is determined by WHERE the code is, not WHO is running. However, it causes problems in OSGi where the caller's bundle classloader doesn't have visibility to exported packages. 如果使用 context classloader：RPC 框架可以从调用者的 classloader 上下文中加载任意类 → Java sandbox 安全边界被打破。使用 caller 的 classloader：调用栈中最接近的代码决定了可用的类——符合 Java 的栈内省安全模型。

**Q4**: "Why is String.intern native but String.concat pure Java?"
→ §二.4: StringTable is in metaspace (native memory) — Java code can't reach it directly. String.concat produces a new String object in Java heap — fully expressible in Java without native code. The "native" boundary is where the data structure lives (heap vs native memory), not a performance choice.

### Tier 3: Performance Deep-Dive

**Q5**: "What happens if System.arraycopy type is not known at C2 compile time?"
→ C2 can't intrinsify unknown-type arraycopy. The call falls through to the `JVM_ArrayCopy` JNI path (jvm.cpp:328-341) which internally dispatches based on `klass()->copy_array()`. This is still fast (one virtual dispatch + memmove for primitives, type-check loop for objects) but ~10-20% slower than a pure intrinsic. Megamorphic call sites where the same arraycopy statement handles both int[] and Object[] will never be intrinsified.

**Q6**: "C2 can't intrinsify all Throwable.fillInStackTrace calls — why?"
→ Intrinsifying stack walking would require C2 to emit code that reads the thread's stack frames, parses nmethod metadata, and builds Java `StackTraceElement` objects — all without calling into the runtime. This is essentially impossible because: (a) the stack layout is runtime-dependent, (b) nmethod metadata format changes between JVM versions, (c) building Java objects requires GC interaction. C2 intrinsifies simple things (arithmetic, memory copy), not complex runtime introspection.

### Tier 4: Container & OS Awareness

**Q7**: "How does cgroup v2 differ from v1 for availableProcessors?"
→ cgroup v1 uses separate files: `cpu.cfs_quota_us` and `cpu.cfs_period_us` in `/sys/fs/cgroup/cpu/`. cgroup v2 uses a single file: `/sys/fs/cgroup/cpu.max` with format `$MAX $PERIOD`. `os::active_processor_count()` in JDK 10+ handles both. The calculation is `floor(cpu_quota / cpu_period)`. If `cpu_quota` is -1 (no limit), returns host CPU count.

**Q8**: "How does container CPU limit affect GC thread count?"
→ `ParallelGCThreads` defaults to `availableProcessors()`. If the JVM reports only 2 CPUs from cgroup, G1GC creates ~2 parallel worker threads. But if the JVM reports 64 (pre-cgroup JDK), it creates 64 threads — 62 of them uselessly spinning on empty queues, causing context switching overhead that INCREASES GC pause time beyond what 2 threads would achieve with full work queues.

### Tier 5: Danger Zone

**Q9**: "What happens if you call System.arraycopy with overlapping src and dst?"
→ `System.arraycopy` does NOT guarantee correct overlapping-copy behavior for all cases. `memmove` (used for primitives) handles overlapping correctly (it uses a temporary buffer or copies in the right direction). However, the Object[] path uses a per-element loop — if src and dst are the SAME array and src_pos < dst_pos, elements may be overwritten before they're copied. Use `System.arraycopy` only for non-overlapping ranges, or ensure correct direction for overlapping moves.

**Q10**: "Why is identityHashCode not sufficient for perfectly unique hashing?"
→ The identity hash in markOop is 25 bits (only 33,554,432 possible values). For a 64-bit JVM heap with billions of objects, hash collisions are guaranteed. `Object.hashCode()` and `System.identityHashCode()` use the same 25-bit hash — by contract, they don't need to be unique, just well-distributed. HashMap handles collisions via chaining (linked list → red-black tree).

**Q11**: "What happens if an exception is thrown during initProperties?"
→ `System.c:166` — `initProperties` uses the `CHECK_NULL_RETURN` pattern on every step. If `GetJavaProperties(env)` fails, it returns NULL. If any `PUTPROP` macro (lines 61-74) encounters an exception, it propagates via `return NULL`. The critical consequence: if initProperties fails during JVM startup, the JVM cannot boot because `java.class.path`, `java.home`, and `file.encoding` won't be set. The launcher will report "Could not find or load main class" — a misleading error for what's actually a property initialization failure.

**Q12**: "How does the JVM set static final fields like System.in?"
→ Java's `final` modifier is enforced by the bytecode verifier — static final fields can only be written in `<clinit>`. But `System.setIn0` at System.c:394-401 uses JNI `SetStaticObjectField` which bypasses the verifier entirely — the JNI native code runs outside the JVM's Java-level access control. This is the same mechanism used by `Unsafe.putObject` and `Field.set` via reflection (`Field.c`). The native method is necessary precisely because there is NO Java-level way to set a static final field after class initialization.

---

## §九 Cross-Phase Connections

| Phase | 连接点 | 具体机制 |
|-------|-------|---------|
| 01-jvm-startup | System.initProperties | `System.c:177` calls `GetJavaProperties(env)` to get platform properties, then `System.c:355` calls `JVM_InitProperties(env, props)` (jvm.cpp:364) which iterates `Arguments::system_properties()` for -D flags and sets `sun.nio.MaxDirectMemorySize` and `sun.management.compiler`. Without this, `java.class.path`, `java.home`, `os.name`, `file.encoding` are all undefined — the JVM cannot boot. |
| 02-class-loading | Class.forName → FindClass | `Class.c:137` calls `JVM_FindClassFromCaller(env, clname, initialize, loader, caller)` which at jvm.cpp:822 calls `find_class_from_class_loader`. This inserts the class into the system dictionary (the JVM's loaded-class registry). The `caller` parameter determines which classloader is used — not the bootstrap loader, not the context classloader. Subsequent `Class.forName` calls for the same name return the cached class from the dictionary without calling native again. |
| 03-object-model | Object.hashCode → markOop | `JVM_IHashCode` (jvm.cpp:609) → `ObjectSynchronizer::FastHashCode` reads from the object header's markOop. The markOop stores: 25-bit identity hash, 2-bit biased locking epoch, 2-bit age (for GC), and lock state bits. The hash is computed lazily (only when first requested) and cached — subsequent calls read the cache directly. This is deep coupling to the object layout defined in Phase 03. |
| 04-interpreter | `aload_0` → getClass → native | Every `aload` that feeds into `getClass` ultimately calls `Object.c:64` → `(*env)->GetObjectClass(env, this)`. The interpreter executes `aload_0` as a bytecode (pushes local 0 onto stack), then `invokevirtual Object.getClass` → the native method. The native implementation calls back into JNI to read the `Klass*` pointer from the oop header and wrap it as a `jclass` global reference. |
| 05-jit-compiler | C2 intrinsifies libjava natives | C2 recognizes specific native methods and replaces them with IR (intermediate representation) nodes: `System.arraycopy(int[], int[], ...)` → `ArrayCopyNode` → assembler emits `REP MOVS`. `Object.hashCode()` → hash field read at a known header offset. `Float.floatToRawIntBits` → `MoveF2INode` (same register, different interpretation — no code generated). `System.nanoTime()` → direct `clock_gettime` syscall with `JVM_LEAF` no-safepoint guarantee. |
| 09-native-interface | JNI_ENTRY/JVM_ENTRY used by all | Every native function in libjava.so is either a JNI_ENTRY (from Java code via LibJava's C files) or a JVM_ENTRY (internal JVM functions in jvm.cpp). `System.c:38-41` uses `RegisterNatives` to bind Java method names to JVM_ENTRY function pointers, bypassing JNI name resolution. The `JVM_LEAF` variant used for `nanoTime`/`currentTimeMillis` has zero safepoint check — the fastest possible entry. |
| 14-zip-jimage | ClassLoader.defineClass1 → ClassLoader.c | `ClassLoader.c` (same directory) implements `Java_java_lang_ClassLoader_defineClass1` — the bridge that converts raw byte[] into a loaded class. It's part of the same libjava.so as `Class.c` and shares the JNI utility layer (`jni_util.c`). Class.forName (Class.c:137) and ClassLoader.defineClass1 are the two sides of class loading: finding vs defining. |

---

## §十 JVM_* Function Quick Reference

All libjava native methods ultimately delegate to JVM_* functions in `src/hotspot/share/prims/jvm.cpp`. This is the unified entry point from `libjava.so` → `libjvm.so`.

| JVM Function | jvm.cpp : line | Entry Type | Called By | What It Does |
|---|---|---|---|---|
| `JVM_CurrentTimeMillis` | 275 | JVM_LEAF | System.c:39 (RegisterNatives) | `os::javaTimeMillis()` — gettimeofday / clock_gettime(REALTIME) |
| `JVM_NanoTime` | 280 | JVM_LEAF | System.c:40 (RegisterNatives) | `os::javaTimeNanos()` — clock_gettime(MONOTONIC) |
| `JVM_ArrayCopy` | 328 | JVM_ENTRY | System.c:41 (RegisterNatives) | `klass()->copy_array()` — memmove for primitives, type-check for objects |
| `JVM_InitProperties` | 364 | JVM_ENTRY | System.c:355 | Iterate Arguments::system_properties(), set -D flags |
| `JVM_GC` | 461 | JVM_ENTRY | Runtime.c:65 | Triggers full GC via CollectedHeap |
| `JVM_ActiveProcessorCount` | 507 | JVM_ENTRY_NO_ENV | Runtime.c:71 | `os::active_processor_count()` — cgroup-aware on Linux since JDK 10 |
| `JVM_FillInStackTrace` | 525 | JVM_ENTRY | Throwable.c:49 | `java_lang_Throwable::fill_in_stack_trace()` — walk thread stack |
| `JVM_IHashCode` | 609 | JVM_ENTRY | Object.c:43 (RegisterNatives), System.c:56 | `ObjectSynchronizer::FastHashCode()` — read identity hash from markOop |
| `JVM_FindClassFromCaller` | 795 | JVM_ENTRY | Class.c:137 | `find_class_from_class_loader()` — resolve class in caller's loader |
| `JVM_InternString` | 3542 | JVM_ENTRY | String.c:32 | `StringTable::intern()` — insert or find in metaspace StringTable |

---

> **下一 Phase**: 16-nio-network — java.nio 的 native 层: epoll/kqueue 事件循环, DirectByteBuffer 的零拷贝机制, SocketChannel 的非阻塞 I/O 实现。
