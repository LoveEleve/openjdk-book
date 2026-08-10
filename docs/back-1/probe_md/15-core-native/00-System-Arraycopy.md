# 00-System-Arraycopy: System.arraycopy + Object.hashCode + System.nanoTime

> **阶段**：[15-core-native]
> **前置**：[09-native-interface]（JNI_ENTRY/JVM_ENTRY 宏机制）、[03-object-model]（markOop, object header, identity hash 存储位置）、[05-jit-compiler]（C2 intrinsics: 如何替换 native call 为 CPU 指令）
> **配套**：[01-Class-String]（Class.forName, String.intern）、[02-Runtime-Throwable]（Runtime.gc, Throwable.fillInStackTrace）、[03-JNI-Utility]（jni_util.c 工具层）
> **后续依赖本文**：[16-nio-network]（DirectByteBuffer native operations 同样使用 JVM_ENTRY）
> **阅读收益**：追踪 System.arraycopy 从 RegisterNatives 到 memmove 的完整 5 步分发链——理解 RegisterNatives 绑定机制、JVM_ArrayCopy 的 Klass 虚分派（primitive → memmove / Object → type check）、Object.hashCode 与 System.identityHashCode 共享 JVM_IHashCode 的设计、memmove vs memcpy 的 spec 合规选择、C2 intrinsic 如何将 arraycopy 编译为 REP MOVS；掌握 "ArrayStoreException" 的 type-check 诊断路径

---

## §〇 生产场景 — ArrayStoreException at Object[] arraycopy

```
Exception in thread "main" java.lang.ArrayStoreException: java.lang.Integer
    at java.lang.System.arraycopy(Native Method)
    at com.example.Main.process(Main.java:42)
```

`src` 是 `Object[]` 包含 `Integer` 对象。`dst` 声明为 `Object[]` 但在编译时声明的类型是假象——JVM 在运行时保留数组的实际组件类型。`dst.getClass().getComponentType()` 返回 `String.class`。`System.arraycopy(src, 0, dst, 0, len)` 进入 native at **System.c:41** → `JVM_ArrayCopy` at **jvm.cpp:328** → `s->klass()->copy_array()` at **jvm.cpp:340**。对于 Object 数组，分发到 `objArrayKlass::copy_array()`，逐元素检查 `dst->klass()->component_type()->is_assignable_from(src_elem_class)`。`Integer.class` 不可赋值给 `String.class` → `ArrayStoreException`。

修复：用正确类型分配目标 (`new String[src.length]`)，或用 `dst.clone()` 在覆盖前保留原类型。绝不要将 `String[]` 引用通过 `Object[]` 变量传入 `System.arraycopy` 并期望存储非 String 元素。

**三步诊断**：

```bash
# 1. 确认 src 和 dst 的运行时类型
jshell -c "src.getClass().getComponentType(); dst.getClass().getComponentType();"
# 输出: class java.lang.Integer vs class java.lang.String — 类型不匹配

# 2. 验证 arraycopy 调用代码
rg "arraycopy" App.java
# 找到 src (Object[] 但实际存储 Integer) 和 dst (声明 Object[] 但运行时 String[])

# 3. GDB 断点验证类型检查路径
gdb -ex "break System.c:41" \
    -ex "break jvm.cpp:340" \
    -ex "run" \
    -ex "print src" \
    -ex "print dst" \
    --args java -cp app.jar com.example.Main
```

**反事实**：如果 Object[] 的 arraycopy 使用 memmove 而不做类型检查 → `Integer` 静默滑入 `String[]`（JVM 内部 oop 引用赋值无类型检查，因为 JNI `SetObjectArrayElement` 不做类型验证）→ 后续代码读取 `dst[0].charAt(0)` 时触发 `ClassCastException` → 症状远离根因数行代码。JVM 在 copy_array 阶段逐元素类型检查的代价是每个元素 ~10ns（一次虚表 dispatch + 类型检查），但带来的收益是 ArrayStoreException 在赋值点即时抛出的精确诊断。

---

## §一 全链路源码走读 — arraycopy + hashCode + nanoTime

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, JNI parameter marshalling), **03-object-model** (markOop, object header, identity hash storage), **05-jit-compiler** (C2 intrinsics). This doc: **how the most-called native methods actually work** — from the C function pointer in System.c to the C2-generated `REP MOVS` instruction.

### 1.1 RegisterNatives — 函数指针直接绑定 (System.c:38–42, :46–51)

`System.c:38-42` 定义 `JNINativeMethod` 数组——将 Java 方法名绑定到 JVM 内部 C 函数指针。这是在类加载的 `registerNatives()` 调用期间执行的一次性注册：

```c
#define OBJ "Ljava/lang/Object;"
static JNINativeMethod methods[] = {
    {"currentTimeMillis", "()J",              (void *)&JVM_CurrentTimeMillis},
    {"nanoTime",          "()J",              (void *)&JVM_NanoTime},
    {"arraycopy",     "(" OBJ "I" OBJ "II)V", (void *)&JVM_ArrayCopy},
};
#undef OBJ
```

`System.c:46-51` 调用 JNI 标准 API `RegisterNatives` 一次完成绑定：

```c
JNIEXPORT void JNICALL
Java_java_lang_System_registerNatives(JNIEnv *env, jclass cls)
{
    (*env)->RegisterNatives(env, cls,
                            methods, sizeof(methods)/sizeof(methods[0]));
}
```

绑定后每次 Java 调用 `System.arraycopy` 时直接跳转到对应的函数指针——无需按名称查找符号表。

> **Beginner Callout 1 — RegisterNatives**：System.c:38-42 registers `arraycopy`, `currentTimeMillis`, `nanoTime` with explicit function pointers via `RegisterNatives`. Without this, JNI would search for `Java_java_lang_System_arraycopy` in the shared library symbol table every call. `RegisterNatives` allows: (a) direct function pointer binding — cached at registration time, zero symbol lookup overhead; (b) reusing JVM internal functions — `JVM_IHashCode` is used by BOTH `Object.hashCode` and `System.identityHashCode`; (c) clean naming — no `Java_*` prefix required.

### 1.2 JVM_ArrayCopy — Klass 虚分派 (jvm.cpp:328–341)

因为 `JVM_ArrayCopy` 定义在 `libjvm.so` 中的 `jvm.cpp` —— 它不是 `libjava.so` 中的符号。`RegisterNatives` 允许跨 .so 的函数指针绑定，而 JNI 命名约定 (`Java_java_lang_System_arraycopy`) 仅在共享库内的符号表中查找。JVM_Entry 接收 `jobject` 参数（已包装 oop），解析为 `arrayOop`，然后分派给 Klass 的虚函数：

```c
JVM_ENTRY(void, JVM_ArrayCopy(JNIEnv * env, jclass ignored, jobject src, jint src_pos,
        jobject dst, jint dst_pos, jint length))
    JVMWrapper("JVM_ArrayCopy");
    if (src == NULL || dst == NULL) {
        THROW(vmSymbols::java_lang_NullPointerException());
    }
    arrayOop s = arrayOop(JNIHandles::resolve_non_null(src));
    arrayOop d = arrayOop(JNIHandles::resolve_non_null(dst));
    assert(oopDesc::is_oop(s), "JVM_ArrayCopy: src not an oop");
    assert(oopDesc::is_oop(d), "JVM_ArrayCopy: dst not an oop");
    s->klass()->copy_array(s, src_pos, d, dst_pos, length, thread);
JVM_END
```

`JNIHandles::resolve_non_null()` 将 `jobject` (JNI 的间接引用) 解引用为原始 `oop` (raw heap pointer)。然后 `s->klass()->copy_array()` 是虚函数调用——根据数组的实际元素类型分派到 `TypeArrayKlass::copy_array()` (primitive) 或 `ObjArrayKlass::copy_array()` (object)。→ 09-native-interface for JVM_ENTRY macro details.

> **Beginner Callout 2 — JNI_ENTRY vs JVM_ENTRY**：`JNI_ENTRY` = enter native from Java code — slow path, JNIEnv wrapping of oop→jobject, safepoint check. `JVM_ENTRY` = JVM internal entry — fast path, direct oop access, no JNI marshalling. `JVM_LEAF` = no safepoint check for pure functions like `nanoTime`. System.c:38 uses `RegisterNatives` to bind Java methods directly to `JVM_ENTRY` function pointers. Source: `src/hotspot/share/prims/jvm.cpp`.

### 1.3 Primitive Path — memmove 快速路径

当 src 和 dst 都是相同的 primitive 数组类型时，`TypeArrayKlass::copy_array()` 调用 `memmove`——纯内存复制，零 per-element bounds check。CPU 将复制向量化为 32 字节 SIMD move（在支持 AVX 的 x86 上是 YMM 寄存器）。1M ints (4MB) 复制：~10µs (受 DDR4 带宽 ~40GB/s 限制)。

**反事实**：1M ints 的 Java for 循环复制——每个迭代 1 bounds check + 1 byte load + 1 byte store —— 总共 3,000,000 操作：~4ms。memmove：0.1ms。**40x faster**。

> **Beginner Callout 3 — memmove vs memcpy**：Java spec says arraycopy "copies as though to a temporary array first" — meaning overlapping src and dst must work. `memcpy` is UB on overlap (C standard: memory areas must not overlap). `memmove` handles overlap by checking direction (src < dst → copy backwards). The direction check is 1 CPU branch → ~1% overhead on non-overlapping case, but guarantees correctness for the spec-required overlapping behavior.

### 1.4 Object Path — 逐元素类型检查

`ObjArrayKlass::copy_array()` 对每个待拷贝的 oop 执行：
1. 从 src[i] 读取 oop，查找其 `Klass*`
2. 调用 `dst->klass()->component_type()->is_assignable_from(src_elem_klass)`
3. 兼容 → 赋值到 dst[j]；不兼容 → `ArrayStoreException`

`null` 可赋给任何类型。`String[] dst = new String[1]; src[0] = null;` → 无异常，因为 null 对所有引用类型都是合法的。子类型多态被支持：`Object[] dst = new Object[1]; src[0] = new Integer(5);` → 通过检查（Integer extends Object）。

**反事实**：如果类型检查推迟到每次后续读取而非赋值时 → 数组可能有数百万元素。如果第 1 个元素是错误的类型但从未被读过 → 静默数据损坏。`ArrayStoreException` 在赋值时抛出确保 **fail-fast**——Java 内存安全保证的核心：不可能通过数组存储破坏类型系统。

### 1.5 Object.hashCode — 从 RegisterNatives 到 markOop (Object.c:43)

`Object.c:42-48` 将 `hashCode` 注册为 `JVM_IHashCode`：

```c
static JNINativeMethod methods[] = {
    {"hashCode",    "()I",    (void *)&JVM_IHashCode},
    {"wait",        "(J)V",   (void *)&JVM_MonitorWait},
    {"notify",      "()V",    (void *)&JVM_MonitorNotify},
    {"notifyAll",   "()V",    (void *)&JVM_MonitorNotifyAll},
    {"clone",       "()Ljava/lang/Object;", (void *)&JVM_Clone},
};
```

`jvm.cpp:609-613` 调用 `ObjectSynchronizer::FastHashCode`：

```c
JVM_ENTRY(jint, JVM_IHashCode(JNIEnv * env, jobject handle))
    JVMWrapper("JVM_IHashCode");
    return handle == NULL ? 0 : ObjectSynchronizer::FastHashCode(THREAD,
        JNIHandles::resolve_non_null(handle));
JVM_END
```

`FastHashCode()` 从对象头部 mark word 读取 identity hash：如果 hash 已计算 → 直接返回。如果未计算（lazy allocation）→ 生成新 hash（基于 park-unpark nonce + XOR），通过 lock-free CAS 写入 markOop 的 25-bit hash 字段，然后返回。→ 03-object-model for markOop layout.

25 bits = 33,554,432 种可能值。对数十亿对象的堆，碰撞必然发生——HashMap 靠链地址法（链表→红黑树）处理碰撞，hash 只需要均匀分布不需要唯一。

**反事实**：如果 hash 存储在 Java int 字段而非 markOop → 每个对象增加 4 字节（+4 对齐 = 8 字节）。20GB heap with 2 billion objects → 16GB overhead just for hashcode。markOop already exists in header for lock state / GC age / biased locking metadata — adding hash costs 0 bytes。

> **Beginner Callout 4 — markOop**：The identity hash code (25 bits) is stored in the object header's mark word — NOT in a Java int field. Every object already has a mark word for lock state, GC age, and biased locking metadata. Storing the hash there has ZERO space overhead (vs. adding a Java int field would add 4 bytes → 8 bytes with alignment to EVERY object). `ObjectSynchronizer::FastHashCode()` at jvm.cpp:609 reads from markOop offset.

### 1.6 System.identityHashCode — 绕过虚分派 (System.c:54–57)

这是 `libjava.so` 中最短的 native 方法——单行调用转发：

```c
JNIEXPORT jint JNICALL
Java_java_lang_System_identityHashCode(JNIEnv *env, jobject this, jobject x)
{
    return JVM_IHashCode(env, x);
}
```

`Object.hashCode()` 和 `System.identityHashCode()` 最终都调用相同的 `JVM_IHashCode → ObjectSynchronizer::FastHashCode`。唯一的区别是路径：
- `obj.hashCode()`：Java 层 `invokevirtual` → 虚方法分派 → 如果子类重写 `hashCode()` 则调用重写版本（可能返回常量或随机值）→ 永远不会到 native
- `System.identityHashCode(obj)`：直接 native 调用 `JVM_IHashCode(env, x)` → 绕过所有 Java 层方法覆盖 → **始终** 返回 markOop hash

HashMap 内部使用 identityHashCode 以避免可变 key 的 hashCode 随时间变化时的无限循环。

**反事实**：如果 identityHashCode 调用 `obj.hashCode()`（通过 Java 虚分派）→ 子类 `class AlwaysZero { @Override int hashCode() { return 0; } }` → identityHashCode 返回 0 → 所有此类对象在 HashMap 中映射到同一个 bucket → resize 时暴力扫描 O(n) per put → live-lock。

### 1.7 System.nanoTime / currentTimeMillis — JVM_LEAF (jvm.cpp:275–283)

这两个都是 `JVM_LEAF`——最快的 JVM 入口类型，零 safepoint check：

```c
JVM_LEAF(jlong, JVM_CurrentTimeMillis(JNIEnv * env, jclass ignored))
    JVMWrapper("JVM_CurrentTimeMillis");
    return os::javaTimeMillis();
JVM_END

JVM_LEAF(jlong, JVM_NanoTime(JNIEnv * env, jclass ignored))
    JVMWrapper("JVM_NanoTime");
    return os::javaTimeNanos();
JVM_END
```

两个不同的 OS 时钟，根本不同的保证：

| | currentTimeMillis | nanoTime |
|---|---|---|
| **OS call** | `gettimeofday()` / `clock_gettime(CLOCK_REALTIME)` | `clock_gettime(CLOCK_MONOTONIC)` |
| **Nature** | Wall clock | Monotonic clock |
| **NTP adjustment** | Can jump forward/backward | Never goes backward |
| **Use case** | Timestamps, dates | Performance measurement, timeouts |

**反事实**：如果用 `currentTimeMillis * 1000000` 模拟 nanoTime → NTP 调整或闰秒导致负间隔或 wildly incorrect intervals。「nanoTime 返回微秒精度值乘以 1000」——错误。nanoTime 调用的是 `CLOCK_MONOTONIC`，这是完全不同的时间基准。

### 1.8 C2 Intrinsic — arraycopy → REP MOVS

C2 编译器在编译时识别特定的 native 方法调用签名，并替换为 IR 节点，这些节点生成直接的 CPU 指令——没有函数调用，没有 JNI 边界跨越。对于 `System.arraycopy(int[], int[], ...)`：

```
CallSite: System.arraycopy(intArr, 0, destArr, 0, 1024)
    → C2 recognizes: known int[] types, known length
    → Injects ArrayCopyNode into IR graph (replaces CallNativeNode)
    → Assembler emits: CLD + REP MOVSD (x86, 4-byte chunks)
```

消除的开销：JNI call (~20ns) + safepoint check + jobject/oop 包装 + 虚分派。Intrinsic path：inline `REP MOVS` → ~5ns total。对于小型数组 (4-16 elements)：~10x faster。

> **Beginner Callout 5 — intrinsic**：C2 recognizes specific native methods at compile time and replaces them with IR nodes that generate direct CPU instructions — no function call, no JNI boundary crossing. `System.arraycopy(int[], int[], ...)` → C2's `ArrayCopyNode` → assembler emits `REP MOVS` (x86). `Object.hashCode()` → direct field read at known header offset (the `MovI` node). `Float.floatToRawIntBits` → same register, different interpretation (zero code generated, just `MoveF2INode`).

> **Beginner Callout 6 — JVM_LEAF**：JVM_LEAF is the fastest JVM entry type — zero safepoint check, used for pure functions that cannot trigger GC. `JVM_CurrentTimeMillis` (jvm.cpp:275) and `JVM_NanoTime` (jvm.cpp:280) both use `JVM_LEAF` because reading the OS clock never allocates memory or touches Java objects. The vDSO (`man 7 vdso`) maps `clock_gettime()` directly into userspace — no syscall, ~20-30ns. Compare: full JNI call ~50ns, safepoint check ~5ns, vDSO clock read ~25ns → with JVM_LEAF eliminating the safepoint check, nanoTime is ~5x faster than a JNI_ENTRY path.

> **Beginner Callout 7 — 手动册线索**：核心 syscall 的权威参考。`man 3 memmove` — C 标准库内存复制（重叠安全，`System.arraycopy` 的 primitive path）；`man 3 memcpy` — 非重叠内存复制（不满足 Java spec 的重叠要求）；`man 7 vdso` — Linux 虚拟动态共享对象（`clock_gettime` 的零 syscall 路径）；`man 3 clock_gettime` — POSIX 时钟读取（`CLOCK_MONOTONIC` vs `CLOCK_REALTIME`）；`man 3 posix_memalign` — 对齐内存分配（`memmove` 的 SIMD 对齐前提）。JNI 规范（Oracle docs: "JNI Functions" chapter）— `RegisterNatives`、`GetStaticFieldID`、`SetStaticObjectField` 的精确语义。

**反事实**：如果 C2 不做 intrinsic → 每次 arraycopy 走 JNI。10 element int[] copy → JNI call ~50ns (JNI boundary + safepoint + marshalling) + memmove ~5ns = ~55ns。Intrinsic: inline REP MOVS → ~5ns total。大型数组的延迟受内存带宽限制而非调用开销——1MB copy ~10µs intrinsic vs ~15µs JNI → 仅 1.5x。所以 intrinsic 的最大价值是高频小数组复制（每秒钟数百万次微数组处理）。

**C2 在什么条件下放弃 intrinsify**：类型未知（megamorphic call site → 同一个 arraycopy 对 int[] 和 Object[] 都调用）→ 长度过大（>LARGE_LOOP_SIZE, C2 switches to full runtime call）→ `-XX:-UseArrayCopyIntrinsics` explicitly disabled。

### 1.9 ★ Mermaid: arraycopy dispatch sequence diagram

```
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────┐  ┌──────────────┐
│  Java App        │  │  Native libjava  │  │  JVM Core (jvm.cpp) │  │  C2 Compiler │
└────────┬────────┘  └────────┬─────────┘  └──────────┬──────────┘  └──────┬───────┘
         │                    │                       │                    │
         │ System.arraycopy() │                       │                    │
         │───────────────────►│                       │                    │
         │                    │ RegisterNatives       │                    │
         │                    │ System.c:41           │                    │
         │                    │ bound → JVM_ArrayCopy │                    │
         │                    │──────────────────────►│                    │
         │                    │                       │ JVM_ArrayCopy      │
         │                    │                       │ jvm.cpp:328-341    │
         │                    │                       │                    │
         │                    │                       │ s->klass()->       │
         │                    │                       │ copy_array()       │
         │                    │                       │ jvm.cpp:340        │
         │                    │         ┌────────────►│                    │
         │                    │         │             │                    │
         │                    │         │isPrimitive  │                    │
         │                    │         │ Array?      │                    │
         │                    │         │             │                    │
         │                    │    YES  │             │  NO (Object[])     │
         │                    │         │             │                    │
         │                    │         ▼             ▼                    │
         │                    │   TypeArrayKlass  ObjArrayKlass            │
         │                    │   ::copy_array()  ::copy_array()           │
         │                    │         │             │                    │
         │                    │    memmove()    per-element type check     │
         │                    │    (vectorized)  is_assignable_from?       │
         │                    │         │        ┌────┴────┐               │
         │                    │         │       YES        NO              │
         │                    │         │        │          │              │
         │                    │         │    copy oop   ArrayStore         │
         │                    │         │    reference   Exception         │
         │                    │         │        │          │              │
         │                    │         └────────┴──────────┘              │
         │                    │                  │                         │
         │◄───────────────────┴──────────────────┘              ┌──────────┴───────┐
         │                     return                            │ ArrayCopyNode    │
         │                                                       │ → REP MOVS       │
         │                                                       │ (if int[] known) │
         │                                                       └──────────────────┘
```

---

### 1.10 ★ 面试 Story Format 答案

**Q: "从 `System.arraycopy(src,0,dst,0,1_000_000)` 到 memmove 完成的完整叙事是什么？"**

System.arraycopy 在 **System.c:38-42** 通过 `RegisterNatives` 注册到 `JVM_ArrayCopy` (jvm.cpp:328) —— 一次性的函数指针绑定，消除所有后续调用时的符号查找开销。当 Java 代码调用 `System.arraycopy(src, 0, dst, 0, 1_000_000)` 时，JNI 调用自动跳转到这个已注册的函数指针。

在 **jvm.cpp:340**，`s->klass()->copy_array()` 是虚函数分派——JVM 读取 src 数组对象的 header 中的 Klass* 指针，然后 call 正确的 copy_array 实现。对于 int[] (primitive 数组)，这是 `TypeArrayKlass::copy_array()` → 调用 `memmove`——纯内存复制，零 per-element bounds check，CPU 将其向量化为 32 字节 SIMD moves。1M ints (4MB) 在大约 0.1ms 内复制完成。

如果 src 是 Object[]，则分派到 `ObjArrayKlass::copy_array()`——对每个元素，检查 src 元素的类是否可赋值给 dst 的组件类型。`Integer.class` 不可赋给 `String.class` → 即时 `ArrayStoreException`。这就是生产场景中 ArrayStoreException 的来源。C2 进一步将已知类型 primitive arraycopy intrinsify 为 `REP MOVS`——消除 JNI 调用开销并直接生成 CPU 指令。对于高频的小数组复制，这是 10x 的速度提升。

Object.hashCode (Object.c:43 → RegisterNatives 绑定到 JVM_IHashCode) 和 System.identityHashCode (System.c:54-57 → 直接调用 JVM_IHashCode(env, x)) 都最终调用相同的 `ObjectSynchronizer::FastHashCode()` 从 markOop 读取 25-bit identity hash。区别在于：obj.hashCode() 通过虚分派可以被 override，而 identityHashCode 直接读 header → 提供 HashMap 需要的不可变 hash。

---

## §二 Standard Environment + Source Files

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/share/native/libjava/` — System.c (455 lines), Object.c (66 lines), Float.c (57 lines)
- `src/hotspot/share/prims/jvm.cpp` — JVM_ArrayCopy (:328), JVM_IHashCode (:609), JVM_NanoTime (:280), JVM_CurrentTimeMillis (:275)
- `src/hotspot/share/oops/klass.hpp` — `Klass::copy_array()` virtual dispatch
- `src/hotspot/share/oops/objArrayKlass.cpp` — `objArrayKlass::copy_array()` per-element type check
- `src/hotspot/share/oops/typeArrayKlass.cpp` — `typeArrayKlass::copy_array()` memmove for primitives
- `src/hotspot/share/runtime/synchronizer.cpp` — `ObjectSynchronizer::FastHashCode()`

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjava.so` — System.c + Object.c compiled

### Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **System.c** | `src/java.base/share/native/libjava/System.c` | 455 | `registerNatives`(:46, binds arraycopy/hashcode via RegisterNatives), `identityHashCode`(:54, →JVM_IHashCode), `initProperties`(:166, →GetJavaProperties+JVM_InitProperties), `setIn0/setOut0/setErr0`(:393-421, SetStaticObjectField bypasses final) | Hot path native — arraycopy, identityHashCode, nanoTime, currentTimeMillis |
| 2 | **Object.c** | `src/java.base/share/native/libjava/Object.c` | 66 | `registerNatives`(:50, binds hashCode/clone via RegisterNatives), `getClass`(:57, →JNI GetObjectClass at :64), `wait/notify/notifyAll`(:42-48, →JVM_Monitor*) | Hot path — hashCode, getClass, monitor operations |
| 3 | **jvm.cpp** | `src/hotspot/share/prims/jvm.cpp` | ~3600 | `JVM_ArrayCopy`(:328), `JVM_IHashCode`(:609), `JVM_NanoTime`(:280), `JVM_CurrentTimeMillis`(:275) | JVM internal entry point — all libjava native methods delegate here |
| 4 | **Float.c** | `src/java.base/share/native/libjava/Float.c` | 57 | `floatToRawIntBits`(:49, pure C union — zero JVM calls), `intBitsToFloat`(:39, union reinterpretation) | Cool — pure C, no JVM dependency |
| 5 | **klass.hpp** | `src/hotspot/share/oops/klass.hpp` | ~800 | `Klass::copy_array()` virtual dispatch, `is_assignable_from()` type check | Object model — array type check decision point |
| 6 | **synchronizer.cpp** | `src/hotspot/share/runtime/synchronizer.cpp` | ~3000 | `ObjectSynchronizer::FastHashCode()` — reads/generates identity hash from markOop | markOop hash generation + caching |

## §三 Performance Analysis

### 3.1 memmove Performance: Primitive Array Copy

1M element int[] copy (4MB): `memmove` → ~0.1ms (DDR4 bandwidth ~40GB/s limited). Java loop: 1M bounds checks + 1M loads + 1M stores → ~10ms. Speedup: **~100x**.

The key factor: `memmove` copies in 32-byte SIMD chunks (256-bit YMM registers on AVX-capable x86). Each cycle processes 32 bytes → 1M ints = 4MB = 128,000 32-byte chunks. At ~3-4 cycles per 32-byte chunk (pipeline depth + memory latency) → ~400,000 cycles → ~0.1ms at 4GHz. The Java loop cannot be auto-vectorized by C2 into `REP MOVS` because the JIT doesn't recognize "copy entire array" semantics from a general-purpose loop.

### 3.2 Object[] Copy Performance

1M element Object[] copy: each element requires: (a) read src[i]'s oop → (b) `is_assignable_from()` Klass virtual dispatch → (c) oop write to dst[j]. ~10ns per element (2 memory reads + 1 virtual call + 1 write) → ~10ms for 1M elements. Compare: primitive `memmove` of same number of references (8MB on 64-bit) → ~0.2ms → **50x slower**. The type check is the bottleneck — virtual dispatch cannot be branch-predicted easily because different elements may have different types.

### 3.3 hashCode Lazy Allocation Cost

First `hashCode()` call on an object: ~8µs (lock-free CAS into markOop + XOR nonce generation). Subsequent calls: ~2ns (read cached value from markOop at known header offset → C2 intrinsifies as direct `MovI`). Precomputing hash at object creation would waste CPU — ~99% of objects never have `hashCode()` called. For a 20GB heap with 2 billion objects: 2B × 8ns = 16 seconds wasted CPU time on hash generation.

### 3.4 Intrinsic vs JNI Fallback — Small vs Large Arrays

| Array Size | JNI Call (arraycopy) | C2 Intrinsic (REP MOVS) | Speedup |
|---|---:|---:|---:|
| 4 bytes (1 int) | ~55ns | ~5ns | 11x |
| 40 bytes (10 ints) | ~60ns | ~8ns | 7.5x |
| 4KB (1024 ints) | ~80ns | ~30ns | 2.7x |
| 4MB (1M ints) | ~10µs | ~10µs | 1.0x |

The constant JNI overhead (~20ns) dominates for small arrays. For large arrays, memory bandwidth (~40GB/s) dominates — both paths are identical in the memmove phase. C2 intrinsic's value is in the **frequency-weighted aggregate**: millions of tiny array copies per second.

### 3.5 nanoTime vs currentTimeMillis — OS Call Cost

Both use `JVM_LEAF` (no safepoint check). `clock_gettime(CLOCK_MONOTONIC)` on Linux: ~20-30ns via vDSO (no syscall, kernel data mapped into userspace). `clock_gettime(CLOCK_REALTIME)`: same cost (~20-30ns) also via vDSO. The cost is identical — the difference is only the contract: wall-clock vs monotonic. Both are ~1000x faster than a full `syscall` (~500ns) because vDSO avoids the user/kernel transition.

### 3.6 Why arraycopy Uses Direct JVM_Entry, Not Java-side Checks

The JVM_ArrayCopy at jvm.cpp:328 doesn't do bounds checking at the Java level. The checks happen inside `klass()->copy_array()`:

```c
// Inside TypeArrayKlass::copy_array (simplified):
if (src_pos < 0 || dst_pos < 0 || length < 0 ||
    src_pos + length > src->length() || dst_pos + length > dst->length()) {
    THROW(vmSymbols::java_lang_ArrayIndexOutOfBoundsException());
}
// Then: memmove(dst_base + dst_pos * elem_size, src_base + src_pos * elem_size, length * elem_size);
```

This is a **single unified bounds check** covering all 5 conditions (src_pos, dst_pos, length, src overflow, dst overflow) before the copy begins. A Java loop would need separate checks per iteration. The unified check costs ~5ns (5 comparisons + 1 branch) vs 1,000,000 × 5ns = 5ms for a loop-based approach — **1000x cheaper on bounds checking alone**.

### 3.7 RegisterNatives: Why It Exists — The Cross-.so Binding Problem

Without `RegisterNatives`, JNI resolves native methods by searching for C functions named `Java_package_Class_method` in the current shared library's exported symbol table. But `JVM_ArrayCopy` lives in `libjvm.so`, not in `libjava.so`. There is no function named `Java_java_lang_System_arraycopy` in either library.

RegisterNatives solves this at System.c:38-51:
```c
static JNINativeMethod methods[] = {
    {"arraycopy", "(Ljava/lang/Object;ILjava/lang/Object;II)V", (void *)&JVM_ArrayCopy},
};
// ...
(*env)->RegisterNatives(env, cls, methods, sizeof(methods)/sizeof(methods[0]));
```

The `&JVM_ArrayCopy` pointer is resolved at **link time** (libjava.so links against libjvm.so). The function pointer is stored in the JVM's internal method table. Every subsequent `System.arraycopy()` call jumps directly through this cached pointer — zero symbol lookup, zero dynamic resolution. If 10 billion arraycopy calls happen in a day, each saving ~5ns of symbol lookup → 50 seconds of CPU saved daily.

### 3.8 Why static final Fields Need Native setters (System.setIn0)

System.c:393-421 implements `setIn0`, `setOut0`, `setErr0` — native methods that modify `static final` fields. Java's `final` modifier is enforced by the bytecode verifier — `putstatic` to a `final` field only allowed in `<clinit>`. But JNI `SetStaticObjectField` at System.c:400:
```c
jfieldID fid = (*env)->GetStaticFieldID(env, cla, "in", "Ljava/io/InputStream;");
(*env)->SetStaticObjectField(env, cla, fid, stream);
```

JNI runs **outside** Java's access control — it directly writes to the field's memory offset in the class metadata, bypassing all verifier rules. This is the same mechanism used by `Unsafe.putObject` and `Field.set` via reflection (`Field.c`). The native method is necessary precisely because there is NO Java-level way to set a static final field after class initialization.

---

## §四 Deep-Dive Question Groups

### 4.1 ★★★ arraycopy dispatch — JNI to JVM boundary

**Q: System.c:41 的 RegisterNatives 如何绑定 arraycopy 到 JVM_ArrayCopy？**

`System.c:38-42` 定义 `JNINativeMethod` 数组，将 Java 方法签名映射到 C 函数指针。`System.c:46-51` 调用 `(*env)->RegisterNatives(env, cls, methods, 3)` 一次性绑定。`RegisterNatives` 是 JNI 标准 API——将 Java 方法名绑定到任意 C 函数指针。绑定后 JNI 调用此方法时直接跳转到 `JVM_ArrayCopy`，无需按名称查找符号表。

关键点：`JVM_ArrayCopy` 是 JVM **内部**函数（定义在 `jvm.cpp`），不在 `libjava.so` 的符号表中。如果按 JNI 命名约定 (`Java_java_lang_System_arraycopy`)，它根本不在当前 .so 中。`RegisterNatives` 允许跨 .so 的函数指针绑定——`libjava.so` 调用 `libjvm.so` 中的 `JVM_ArrayCopy`。

**Counterfactual**：如果 arraycopy 是纯 Java 实现的 1M element byte[] copy：Java loop: 1 bounds check per iteration → 1,000,000 bounds checks + 1,000,000 byte reads + 1,000,000 byte writes → ~10ms。Native JVM_ArrayCopy: 1 memmove call → 单次 vectorized copy (32-byte SIMD per cycle) → ~0.1ms → 100x faster。而且 C2 无法 intrinsify Java 循环为 memmove——JIT 不认识"整个数组复制"的语义。只有标注为 `@HotSpotIntrinsicCandidate` 的 native 方法才能触发 intrinsic 替换。

**追问**：如果使用 named JNI → ~10ns overhead per call for symbol lookup (cached after first call but still measurable). RegisterNatives: 0ns overhead on hot path.

---

### 4.2 ★★★ Primitive arraycopy — memmove fast path

**Q: JVM_ArrayCopy (jvm.cpp:328-341) 如何区分 primitive 和 Object 数组？**

`jvm.cpp:340` → `s->klass()->copy_array(s, src_pos, d, dst_pos, length, thread)`。`Klass::copy_array()` 是虚函数，根据 `arrayOop` 的实际 Klass 类型分派：
- `typeArrayKlass` → `TypeArrayKlass::copy_array()` → `memmove` 纯内存拷贝
- `objArrayKlass` → `ObjArrayKlass::copy_array()` → 逐元素类型检查 + oop 拷贝

判断方式：`Klass::is_typeArray_klass()` 和 `Klass::is_objArray_klass()` 各返回 true/false。`TypeArrayKlass` 的 `layout_helper` 字段编码了元素类型 (`T_BOOLEAN=4, T_CHAR=5, T_FLOAT=6, T_INT=10, T_LONG=11`)。

**Counterfactual**：如果 JVM 对 Object[] 也用 memmove 而不做类型检查 → oop 是原始指针——memmove 会直接把 src 的 oop 指针写到 dst 的数组中。如果 dst 是 String[] 而 src 包含 Integer oop → dst[0] contains Integer's oop reference → 但 JVM 记录 dst 的 component type 为 String → 后续代码执行 `((String)dst[0]).charAt(0)` → `ClassCastException` —— 但异常发生在读取点，赋值发生在数百行之前的 arraycopy。诊断成本从 O(1) 变为 O(n)。

---

### 4.3 ★★★ Object arraycopy — per-element type check

**Q: objArrayKlass::copy_array() 的逐元素检查逻辑是什么？**

对于每个待拷贝的 oop: (1) 读取 src[i] 的 oop → 查其 Klass*，(2) 调用 `dst->klass()->component_type()->is_assignable_from(src_elem_klass)` → 检查 src 元素的类是否与 dst 数组的组件类型兼容，(3) 兼容 → oop 赋值到 dst[j]，不兼容 → 抛出 ArrayStoreException。

`null` 可赋给任何类型。`String[] dst = new String[1]; src[0] = null;` → 通过（null 对所有引用类型都是合法的）。子类型多态被支持。

**追问**：为什么不直接 transcribe Java 的 aastore 字节码类型检查？→ aastore 已在解释器中做类型检查。但 arraycopy 是批量复制——JVM 在 native 层做类型检查是为了在一个连续检查循环中批量完成（cache-friendly）+ 在检测到第一个不兼容元素时立即报告 ArrayStoreException。

**Counterfactual**：如果类型检查推迟到后续每次读取时（而非赋值时）→ 数组可能有数百万个元素。如果第 1 个元素是错误的类型而第 100 万个元素是正确的类型，用户可能永远不读第 1 个元素而从不触发异常 → 静默数据损坏。ArrayStoreException 在赋值时即时抛出确保 fail-fast —— 不正确的数组状态不可能存在于 heap 中。这是 Java 内存安全保证的核心：不可能通过数组存储破坏类型系统。

---

### 4.4 ★★★ Object.hashCode — markOop identity hash

**Q: Object.c:43 的 hashCode 如何到达 markOop？**

`Object.c:42-48` → `RegisterNatives` 绑定 `"hashCode"` 到 `&JVM_IHashCode`。`jvm.cpp:609-613` → `JVM_ENTRY(jint, JVM_IHashCode(...))` → `ObjectSynchronizer::FastHashCode(THREAD, handle)`。

`FastHashCode()` 在 `synchronizer.cpp` 中读取 oop 的 mark word：
- 如果 hash 已计算 → 读取 markOop 的 25-bit hash 字段 → 直接返回
- 如果 hash 未计算（lazy allocation）→ 生成新 hash（基于 park-unpark nonce + XOR）→ lock-free CAS 写入 markOop → 返回

25-bit hash = 33,554,432 possible values。对数十亿对象的堆，碰撞必然发生——HashMap 靠链地址法（链表→红黑树）处理碰撞。

**追问：为什么 hash 懒加载而非在对象创建时就生成？** → 绝大多数对象的 `hashCode()` 永远不会被调用（局部变量、数组元素、不可变数据的 transient 对象）。预计算 hash 浪费 CPU —— 一次调用 ~8ns first call × 10⁹ 对象 = 浪费数秒 CPU time。

**Counterfactual**：如果 hashCode 存储在 Java int 字段而非 markOop 中 → 每个对象增加 4 字节 (+4 对齐 = 8 字节)。20GB heap with 2 billion objects → 16GB overhead just for hashcode。markOop already exists in header for lock state / GC age / biased locking — adding hash costs 0 bytes。而且 JVM 需要访问 hash 来处理同步 → 如果 hash 在 Java field 中 → 同步需要读取对象体而非 header → 额外内存访问 ~5ns per monitor enter。

---

### 4.5 ★★★ System.identityHashCode — bypassing virtual dispatch

**Q: System.identityHashCode (System.c:54-57) 与 Object.hashCode 的区别是什么？**

两者最终都调用 `JVM_IHashCode → ObjectSynchronizer::FastHashCode` → 读取 markOop hash。唯一的区别是路径：
- `obj.hashCode()`：Java 层 `invokevirtual` → 虚方法分派 → 如果子类重写 `hashCode()` 则调用重写版本
- `System.identityHashCode(obj)`：直接 native 调用 `JVM_IHashCode(env, x)` → 绕过所有 Java 层方法覆盖 → 始终返回 markOop hash

源码 (System.c:54-57)：单行转发——libjava.so 中最短的 native 方法。

**追问：HashMap 为什么需要 identityHashCode？** → HashMap 的 resize 遍历时，如果 key 的 hashCode() 被 override 并在 put 和 get 之间返回不同值 → entry 可能在错误的 bucket 中查找 → 无限循环。identityHashCode 提供一个不随时间变化的 hash —— 只要对象地址不变（hash 在 header 中），hash 不变。

**Counterfactual**：如果 identityHashCode 调用 `obj.hashCode()`（通过 Java 虚分派）→ 子类返回常量或随机值 → identityHashCode 返回相同的非稳定值 → 所有此类对象在 HashMap 中映射到同一个 bucket → resize 时所有 key 都在同一 bucket → 暴力扫描 O(n) per put → 10000 entries → 5000 probes per lookup → 500ms per put → live-lock on resize。

---

### 4.6 ★★★ C2 intrinsic — arraycopy to REP MOVS

**Q: C2 如何将 System.arraycopy native 调用替换为 REP MOVS？**

C2 识别 `System.arraycopy(int[], int, int[], int, int)` 的调用签名 → 匹配 intrinsic candidate → C2's graph builder 注入 `ArrayCopyNode` 到 IR 图中替代 native call node。在汇编阶段：
- x86: `REP MOVS` (`MOVSD` for 8-byte chunks，prefixed with `CLD+REP` for repeat)
- 已知类型 + 已知长度 → unrolled `MOV` instructions（更快的非 REP 序列）
- 对齐检查：8-byte aligned → `MOVSD`; unaligned → `MOVSB`

消除的开销：JNI call overhead (~20ns) + safepoint check + oop wrapping。

**追问：C2 在什么条件下放弃 intrinsify？** → 类型未知时（megamorphic call site → 同一个 arraycopy for int[] and Object[]）→ 长度过大（>LARGE_LOOP_SIZE, C2 switches to full runtime call）→ `-XX:-UseArrayCopyIntrinsics` explicitly disabled。

**Counterfactual**：如果 C2 不做 intrinsic —— 每次 arraycopy 都走 JNI → 10 element int[] copy → JNI call ~50ns (JNI boundary + safepoint + parameter marshalling) + memmove ~5ns = ~55ns。Intrinsic: inline REP MOVS → ~5ns total。**10x faster for small arrays**。大型数组延迟受限于内存带宽而非调用开销——1MB copy ~10µs intrinsic vs ~15µs JNI → 仅 1.5x，差别是常量 JNI overhead 20ns 被 amortized 在巨大数据上。所以 intrinsic 的最大价值是高频小数组复制。→ 05-jit-compiler for C2 intrinsic framework.

---

### 4.7 ★★★ memmove vs memcpy — overlapped copy correctness

**Q: 为什么 arraycopy 用 memmove 而非 memcpy？**

`System.arraycopy` 的 Java spec 明确要求："copies as though to a temporary array first"。必须支持 src 和 dst 重叠。`memcpy` 的 C 标准保证 (ISO C99 §7.21.2.1)："If copying takes place between objects that overlap, the behavior is undefined." `memmove` 的 C 标准保证 (ISO C99 §7.21.2.2)："Copying takes place as if the n characters from src are first copied into a temporary array... and then copied into dest." 完全匹配 Java spec。

memmove 的实现检查方向：如果 `src < dst` → 从末尾向开头拷贝（避免源被覆盖前就被覆写）。MEMCPY 不检查方向 → 从开头向末尾拷贝 → 重叠时数据损坏。

| Scenario | memcpy result | memmove result |
|---|---|---|
| src=dst+2, copy forward | `[a,b,a,b]` ✓ (no overlap) | `[a,b,a,b]` ✓ |
| dst=src+2, copy forward | `[a,b,a,b]` ✗ (c,d overwritten before read) | `[a,b,a,b]` ✓ (copies backward) |
| src=dst, nocopy | N/A | N/A |

**追问：memmove 的方向检查代价是多少？** → 1 次指针对比（`src < dst`）→ 1 CPU branch → ~0.3ns on pipelined CPU。在 10KB 拷贝中 amortized 到 ~0.003% 开销。对非重叠情况的 cost ~1%。

**Counterfactual**：如果 arraycopy 用 memcpy —— 重叠拷贝何时会错？→ src = [a,b,c,d], dst = src+2 (从 src 偏移 2 开始写)：memcpy 从开头复制 a→dst+0, b→dst+1 — 但 dst+0 is src+2 → overwrites c → c lost → 复制 c 时 dst+2 收到被复写的错误值 → dst = [a,b,?,?]。memmove 检测到 src < dst → 从末尾复制 (d, c, b, a 顺序) → dst = [a,b,a,b]。正确。这种模式在数组左移操作 (`System.arraycopy(arr, 2, arr, 0, 2)`) 中非常常见。

---

### 4.8 ★★★ Float.floatToRawIntBits — zero-cost reinterpretation

**Q: Float.floatToRawIntBits (Float.c:49-56) 为什么是 native？**

Java 没有 C union 类型——无法在同一块内存上用两种类型 interpret bits。`Float.c:49-56` 使用 `union { int i; float f; }` — 写入 f, 读取 i：

```c
JNIEXPORT jint JNICALL
Java_java_lang_Float_floatToRawIntBits(JNIEnv *env, jclass unused, jfloat v)
{
    union { int i; float f; } u;
    u.f = (float)v;
    return (jint)u.i;
}
```

这是纯寄存器级操作——CPU 将同一寄存器中的 32 bits 从浮点重新解释为整数。零内存访问，零计算。C2 将此 intrinsify 为 `MoveF2INode`——无代码生成，只是 IR 图中类型标注从 float 变为 int。等价于 x86 `movd`（FPU→通用寄存器）。

**追问**：为什么不是 Java 的 `Float.floatToIntBits` 本身？回答：`floatToIntBits` 额外将所有 NaN 编码折叠为单一规范 NaN (0x7fc00000)。这是纯数学操作——可以在 Java 中实现（用 `Float.isNaN` + 位运算）。`floatToRawIntBits` 保留 NaN bits 原样——需要 C union 来获取原始 bits。

**Counterfactual**：如果 Java 有 union 类型 → `floatToRawIntBits` 可以是 Java 的一行代码：`return Float.asBits(v).asInt();`。无需 native。但 Java 的安全模型不允许未标记的类型重解释——没有未定义行为的空间（不像 C: union 的类型混淆是 UB 在某些平台上的大小端差异）。"无 union" 是一个安全设计——不是什么性能考虑。

---

## §五 ★ Mermaid: arraycopy dispatch table

```
                          System.arraycopy(src,0,dst,0,len)
                                      │
                  System.c:41 RegisterNatives → JVM_ArrayCopy
                                      │
                         jvm.cpp:328 JVM_Entry
                                      │
                        jvm.cpp:340 s->klass()->copy_array()
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                    isPrimitive?               isObject?
                         │                         │
                         YES                       YES
                         │                         │
                  TypeArrayKlass              ObjArrayKlass
                  ::copy_array()              ::copy_array()
                         │                         │
                    memmove()                 for each element:
                    ┌─vectorized─┐            ┌──────────────────┐
                    │ 32-byte    │            │ src_elem_klass    │
                    │ SIMD moves │            │ assignable to     │
                    │ ~0.1ms/M   │            │ dst_component?   │
                    │ elements   │            │                   │
                    └────────────┘            └────┬─────────┬────┘
                                                   │         │
                                                  YES       NO
                                                   │         │
                                              copy oop    ArrayStore
                                              reference   Exception
                                                   │
                                              C2 intrinsic →
                                              REP MOVS
                                              (0ns overhead)
```

---

## §六 GDB Verification — 7 断点完整 arraycopy + hashCode trace

### 断言 1: RegisterNatives arraycopy binding (System.c:41)

```gdb
(gdb) break System.c:41
(gdb) run
(gdb) print methods[2].name     # 期望: "arraycopy"
(gdb) print methods[2].fnPtr    # 期望: &JVM_ArrayCopy (non-NULL function pointer)
(gdb) print methods[2].signature # 期望: "(Ljava/lang/Object;ILjava/lang/Object;II)V"
(gdb) continue
(gdb) print cookie              # 期望: 非 NULL (RegisterNatives success return)
```

### 断言 2: JVM_ArrayCopy entry (jvm.cpp:328)

```gdb
(gdb) break jvm.cpp:328
# 运行: java -cp app.jar <trigger arraycopy>
(gdb) print src                 # 期望: jobject (non-null)
(gdb) print dst                 # 期望: jobject (non-null)
(gdb) print length              # 期望: >0
(gdb) continue
```

### 断言 3: Klass::copy_array dispatch (jvm.cpp:340)

```gdb
(gdb) break jvm.cpp:340
(gdb) print s->klass()->external_name()   # 期望: "[I" (int[]) 或 "[Ljava.lang.Object;" (Object[])
(gdb) step                              # 进入 typeArrayKlass::copy_array 或 objArrayKlass::copy_array
(gdb) info functions typeArrayKlass::copy_array  # 验证进入的函数
```

### 断言 4: typeArrayKlass::copy_array memmove (typeArrayKlass.cpp)

```gdb
(gdb) break typeArrayKlass.cpp:<memmove call line>
(gdb) run
(gdb) print src_pos             # 期望: 0
(gdb) print dst_pos             # 期望: 0
(gdb) print length              # 期望: >0
(gdb) next # 经过 memmove
(gdb) print dst_array[0]        # 期望: 与 src[0] 相同的值
```

### 断言 5: Object.c hashCode RegisterNatives (Object.c:43)

```gdb
(gdb) break Object.c:43
(gdb) run
(gdb) print methods[0].name     # 期望: "hashCode"
(gdb) print methods[0].fnPtr    # 期望: &JVM_IHashCode
(gdb) print methods[0].signature # 期望: "()I"
```

### 断言 6: JVM_IHashCode → markOop (jvm.cpp:609)

```gdb
(gdb) break jvm.cpp:609
(gdb) run
(gdb) print handle              # 期望: valid jobject
(gdb) step  # 进入 FastHashCode
(gdb) print obj->mark()->hash() # 期望: 25-bit hash value (0 to 33554431)
(gdb) print hash_result         # 期望: 与 mark()->hash() 相同的 int value
```

### 断言 7: Float.floatToRawIntBits union (Float.c:49)

```gdb
(gdb) break Float.c:49
(gdb) run
(gdb) print v                   # 期望: 浮点值 (例如 3.14159f)
(gdb) next  # 经过 union assignment (Float.c:55)
(gdb) print u.i                 # 期望: v 的 IEEE 754 32-bit 表示 (0x40490fdb → 3.14159f)
(gdb) disas                     # 期望: 无 call 指令 (pure computation, no JVM call)
```

### 断言 8: System.identityHashCode → same JVM_IHashCode (System.c:56)

```gdb
(gdb) break System.c:56
(gdb) run
(gdb) print x                   # 期望: valid jobject
(gdb) stepi                     # 进入 JVM_IHashCode
(gdb) info functions JVM_IHashCode  # 确认与 断言 6 进入同一函数地址
```

---

## §七 ★ 面试问答 (Interview Q&A)

### Q1: "How does System.arraycopy work?"

`System.arraycopy` 在 **System.c:41** 通过 `RegisterNatives` 注册到 `JVM_ArrayCopy`。在 `jvm.cpp:328-341` 中，它将 src/dst 解析为 `arrayOop`，然后调用 `s->klass()->copy_array()` (jvm.cpp:340)。对于 primitive 数组，这是 `memmove`——纯内存拷贝，零 per-element check。对于 Object 数组，它逐元素检查类型然后复制 oop 引用。C2 进一步将已知类型的 primitive 情况 intrinsify 为 `REP MOVS` on x86，消除所有调用开销和 bounds checking。

### Q2: "Why doesn't Object.hashCode just return a Java int field?"

Identity hash code 存储在对象头部的 mark word (markOop) 中——一个 JVM 拥有的 25-bit 头部字段。Java int 字段需要一个完整的对象字段（对象体中的 4 字节，不在头部）→ 每个对象大小增加 8 字节（对齐后）。`JVM_IHashCode` (jvm.cpp:609) 调用 `ObjectSynchronizer::FastHashCode` 从 markOop 读取。C2 将此 intrinsify 为在已知偏移量处的直接 header 字段读取。

### Q3: "What's the difference between Object.hashCode and System.identityHashCode?"

两者最终都调用相同的 `ObjectSynchronizer::FastHashCode`。`obj.hashCode()` 通过 Java 虚分派——子类可以覆盖它返回任意值。`System.identityHashCode(obj)` 直接调用 `JVM_IHashCode(env, obj)` (System.c:56) —— 它从 markOop 读取 identity hash，绕过任何 Java 层覆盖。HashMap 内部使用 identityHashCode 以避免可变 key 的 hashCode 随时间变化时的无限循环。

---

---

## §八 Cross-Reference

| Phase | Connection | Handoff Point |
|-------|-----------|--------------|
| **09-native-interface** | JNI_ENTRY/JVM_ENTRY 宏机制——本文每个 native 方法都使用 | System.c:38, jvm.cpp:328, jvm.cpp:609 |
| **03-object-model** | markOop 内存布局——identity hash 的 25-bit 字段存于 header | Object.c:43 → jvm.cpp:609 → ObjectSynchronizer::FastHashCode |
| **05-jit-compiler** | C2 intrinsics——ArrayCopyNode → REP MOVS, hash field direct read, MoveF2INode for float | §三.4 intrinsic vs JNI fallback |
| **01-Class-String** | Class.c:137 forName → JVM_FindClassFromCaller，相同 phase 的 warm path | Class.c:98-144 |
| **14-zip-jimage** | ClassLoader.c defineClass1 bridge——类加载终点 | ClassLoader.c:136 → jvm.cpp |

## §九 ADDITIONAL PROHIBITIONS（≥8）

- ❌ 只说 arraycopy 是 native 不做 RegisterNatives 绑定分析——必须展示 System.c:41 的函数指针数组
- ❌ 不解释 JVM_ArrayCopy 的 Klass 虚分派——primitive vs Object 的不同路径
- ❌ 忽略 memmove vs memcpy 的 spec 合规选择——Java spec 要求重叠安全
- ❌ 不量化 ArrayStoreException 的类型检查成本——~10ns per element + fail-fast 收益
- ❌ 不说 identityHashCode 绕过了虚分派——HashMap 依赖它避免可变 key 的无限循环
- ❌ 遗漏 C2 intrinsic 的条件限制——类型未知/长度过大/显式禁用
- ❌ 不做 hashCode lazy allocation 的成本分析——markOop 零空间开销 vs Java int field 的 8 bytes/object
- ❌ 不做 man 手册引用——man 3 memmove（Java spec 合规）、man 7 vdso（nanoTime 零 syscall）、man 3 clock_gettime（CLOCK_MONOTONIC）
