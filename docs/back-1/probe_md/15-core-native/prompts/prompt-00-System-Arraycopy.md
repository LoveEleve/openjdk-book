# PROMPT: 请撰写 00-System-Arraycopy.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

`java.lang.ArrayStoreException: java.lang.Integer` at `System.arraycopy(src, 0, dst, 0, len)`.

`src` is `Object[]` containing `Integer` objects. `dst` is declared `Object[]` at compile time, but at runtime its actual type is `String[]`. Java arrays carry their component type at runtime — it's stored in the `Klass*` pointer in the object header; `dst.getClass().getComponentType()` returns `String.class` regardless of the local variable's declared type. `System.arraycopy(src, 0, dst, 0, len)` enters native at System.c:41 → `JVM_ArrayCopy` at jvm.cpp:328 → `s->klass()->copy_array()`. For Object arrays, this dispatches to `objArrayKlass::copy_array()`, which iterates element-by-element checking `dst->klass()->component_type()->is_assignable_from(src_elem_class)`. `Integer.class` is not assignable to `String.class` → `ArrayStoreException`.

Fix: allocate destination with correct type (`new String[src.length]`) or use `dst.clone()` before overwrite. Never pass a `String[]` reference through an `Object[]` variable into `System.arraycopy` expecting to hold non-String elements.

**三步诊断**（直接写进 §〇）：

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

**反事实**：如果 Object[] 的 arraycopy 使用 memmove 而不做类型检查 → `Integer` 静默滑入 `String[]`（JVM 内部 oop 引用赋值无类型检查，因为 JNI `SetObjectArrayElement` 不做类型验证）→ 后续代码读取 `dst[0].charAt(0)` 时触发 `ClassCastException` → 症状远离根因数百行代码。JVM 在 copy_array 阶段逐元素类型检查的代价是每个元素 ~10ns（一次虚表 dispatch + 类型检查），但带来的收益是 ArrayStoreException 在赋值点即时抛出的精确诊断。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the THREE most-called native methods in the JVM: `System.arraycopy`, `Object.hashCode`, and `System.identityHashCode`. Together they account for >99% of all native calls in a typical Java application. This is NOT a tutorial on what these methods DO — it's ENGINEERING documentation on HOW the JVM implements them in source-code-specific detail.

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, JNI parameter marshalling), **03-object-model** (markOop, object header, identity hash storage), **05-jit-compiler** (C2 intrinsics). This doc: **how the most-called native methods actually work** — from the C function pointer in System.c to the C2-generated `REP MOVS` instruction.

### Interview Story Format Answer（必须出现在 §一 末尾）

"System.arraycopy is registered via `RegisterNatives` at System.c:41 to `JVM_ArrayCopy` (jvm.cpp:328). At the JVM level, `s->klass()->copy_array()` dispatches based on array type: primitive arrays hit `memmove` — pure memory copy with zero per-element bounds checks, CPU-vectorized to 32-byte SIMD moves, ~100x faster than Java loop. Object arrays hit `objArrayKlass::copy_array()` which checks each element's type against the destination's component type — this is why `System.arraycopy(src_with_Integers, 0, stringArray, 0, 10)` correctly throws `ArrayStoreException` before polluting the destination. C2 further intrinsifies known-type primitive arraycopy to `REP MOVS` on x86, eliminating ALL call overhead. `Object.hashCode` and `System.identityHashCode` both call `JVM_IHashCode` (jvm.cpp:609) → `ObjectSynchronizer::FastHashCode` reads the 25-bit identity hash from the object header's markOop field. The key difference: `obj.hashCode()` goes through virtual dispatch (subclass can override to return constant/random value), while `System.identityHashCode(obj)` calls the JVM function directly, bypassing overrides so HashMap can avoid infinite loops on mutable keys."

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **JNI_ENTRY vs JVM_ENTRY**: `JNI_ENTRY` = enter native from Java code — slow path, JNIEnv wrapping of oop→jobject, safepoint check. `JVM_ENTRY` = JVM internal entry — fast path, direct oop access, no JNI marshalling. `JVM_LEAF` = no safepoint check for pure functions like `nanoTime`. System.c:38 uses `RegisterNatives` to bind Java methods directly to `JVM_ENTRY` function pointers. Source: `src/hotspot/share/prims/jvm.cpp`.

2. **markOop**: The identity hash code (25 bits) is stored in the object header's mark word — NOT in a Java int field. Every object already has a mark word for lock state, GC age, and biased locking metadata. Storing the hash there has ZERO space overhead (vs. adding a Java int field would add 4 bytes → 8 bytes with alignment to EVERY object). `ObjectSynchronizer::FastHashCode()` at jvm.cpp:609 reads from markOop offset.

3. **memmove vs memcpy**: Java spec says arraycopy "copies as though to a temporary array first" — meaning overlapping src and dst must work. `memcpy` is UB on overlap (C standard: memory areas must not overlap). `memmove` handles overlap by checking direction (src < dst → copy backwards). The direction check is 1 CPU branch → ~1% overhead on non-overlapping case, but guarantees correctness for the spec-required overlapping behavior.

4. **intrinsic**: C2 recognizes specific native methods at compile time and replaces them with IR nodes that generate direct CPU instructions — no function call, no JNI boundary crossing. `System.arraycopy(int[], int[], ...)` → C2's `ArrayCopyNode` → assembler emits `REP MOVS` (x86). `Object.hashCode()` → direct field read at known header offset (the `MovI` node). `Float.floatToRawIntBits` → same register, different interpretation (zero code generated, just `MoveF2INode`).

5. **RegisterNatives**: System.c:38-42 registers `arraycopy`, `currentTimeMillis`, `nanoTime` with explicit function pointers via `RegisterNatives`. Without this, JNI would search for `Java_java_lang_System_arraycopy` in the shared library symbol table every call. `RegisterNatives` allows: (a) direct function pointer binding — cached at registration time, zero symbol lookup overhead; (b) reusing JVM internal functions — `JVM_IHashCode` is used by BOTH `Object.hashCode` and `System.identityHashCode`; (c) clean naming — no `Java_*` prefix required.

---

## §二 Standard Environment

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

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **System.c** | `src/java.base/share/native/libjava/System.c` | 455 | `registerNatives`(:46, binds arraycopy/hashcode via RegisterNatives), `identityHashCode`(:54, →JVM_IHashCode), `initProperties`(:166, →GetJavaProperties+JVM_InitProperties), `setIn0/setOut0/setErr0`(:393-421, SetStaticObjectField bypasses final) | 🔥 Hot path native — arraycopy, identityHashCode, nanoTime, currentTimeMillis |
| 2 | **Object.c** | `src/java.base/share/native/libjava/Object.c` | 66 | `registerNatives`(:50, binds hashCode/clone via RegisterNatives), `getClass`(:57, →JNI GetObjectClass at :64), `wait/notify/notifyAll`(:42-48, →JVM_Monitor*) | 🔥 Hot path — hashCode, getClass, monitor operations |
| 3 | **jvm.cpp** | `src/hotspot/share/prims/jvm.cpp` | ~3600 | `JVM_ArrayCopy`(:328), `JVM_IHashCode`(:609), `JVM_NanoTime`(:280), `JVM_CurrentTimeMillis`(:275) | **JVM internal entry point** — all libjava native methods delegate here |
| 4 | **Float.c** | `src/java.base/share/native/libjava/Float.c` | 57 | `floatToRawIntBits`(:49, pure C union — zero JVM calls), `intBitsToFloat`(:39, union reinterpretation) | 🟢 Cool — pure C, no JVM dependency |
| 5 | **klass.hpp** | `src/hotspot/share/oops/klass.hpp` | ~800 | `Klass::copy_array()` virtual dispatch, `is_assignable_from()` type check | Object model — array type check decision point |
| 6 | **synchronizer.cpp** | `src/hotspot/share/runtime/synchronizer.cpp` | ~3000 | `ObjectSynchronizer::FastHashCode()` — reads/generates identity hash from markOop | markOop hash generation + caching |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ arraycopy dispatch — JNI to JVM boundary

```
问题：
  ① System.c:41 的 RegisterNatives 如何绑定 arraycopy 到 JVM_ArrayCopy？
      答案方向: System.c:38-42 定义 JNINativeMethod methods[] 数组：
        {"arraycopy", "(Ljava/lang/Object;ILjava/lang/Object;II)V", (void *)&JVM_ArrayCopy}
      System.c:49 调用 (*env)->RegisterNatives(env, cls, methods, 3) 一次性绑定。
      RegisterNatives 是 JNI 标准 API——将 Java 方法名绑定到任意 C 函数指针。
      绑定后 JNI 调用此方法时直接跳转到 JVM_ArrayCopy，无需按名称查找符号表。
      
      追问: 为什么 arraycopy 用 RegisterNatives 而非 JNI 默认命名约定？
      → JVM_ArrayCopy 是 JVM 内部函数（定义在 jvm.cpp），不在 libjava.so 中。
        如果按 JNI 命名约定（Java_java_lang_System_arraycopy），它根本不在
        当前 .so 的符号表中。RegisterNatives 允许绑定到跨 .so 的函数指针——
        libjava.so 调用 libjvm.so 中的 JVM_ArrayCopy。

  ② Counterfactual: 如果 arraycopy 是纯 Java 实现的？
      答案方向: 1M element byte[] copy：
        Java loop: 1 bounds check per iteration → 1,000,000 bounds checks
        + 1,000,000 byte reads + 1,000,000 byte writes → ~10ms
        Native JVM_ArrayCopy: 1 memmove call → single vectorized copy
        (32-byte SIMD per cycle) → ~0.1ms → 100x faster
      而且 C2 无法 intrinsify Java 循环为 memmove——JIT 不认识"整个数组复制"的语义。
      只有标注为 @HotSpotIntrinsicCandidate 的 native 方法才能触发 intrinsic 替换。
```

### 4.2 ★★★ Primitive arraycopy — memmove fast path

```
问题：
  ① JVM_ArrayCopy (jvm.cpp:328-341) 如何区分 primitive 和 Object 数组？
      答案方向: jvm.cpp:340 → s->klass()->copy_array(s, src_pos, d, dst_pos, length, thread)
      Klass::copy_array() 是虚函数，根据 arrayOop 的实际 Klass 类型分派：
        - typeArrayKlass → TypeArrayKlass::copy_array() → memmove 纯内存拷贝
        - objArrayKlass → ObjArrayKlass::copy_array() → 逐元素类型检查 + oop 拷贝
      源码 (jvm.cpp:328-341):
        JVM_ENTRY(void, JVM_ArrayCopy(JNIEnv * env, jclass ignored, jobject src, jint src_pos,
                                       jobject dst, jint dst_pos, jint length))
            arrayOop s = arrayOop(JNIHandles::resolve_non_null(src));
            arrayOop d = arrayOop(JNIHandles::resolve_non_null(dst));
            ...
            s->klass()->copy_array(s, src_pos, d, dst_pos, length, thread);
        JVM_END
      
      追问: 如何判断是 primitive 还是 Object？
      → arrayOop 的 Klass* 存在对象 header。Klass::is_typeArray_klass() 和 
        Klass::is_objArray_klass() 各返回 true/false。TypeArrayKlass 的 layout_helper 
        字段编码了元素类型（T_BOOLEAN=4, T_CHAR=5, T_FLOAT=6,...）。

  ② Counterfactual: 如果 JVM 对 Object[] 也用 memmove 而不做类型检查？
      答案方向: oop 是原始指针——memmove 会直接把 src 的 oop 指针写到 dst 的数组中。
      如果 dst 是 String[] 而 src 包含 Integer oop → dst[0] 包含 Integer 的 oop 引用
      → 但 JVM 记录 dst 的 component type 为 String → 后续代码执行 
      ((String)dst[0]).charAt(0) → ClassCastException —— 但异常发生在读取点，
      而赋值发生在数百行之前的 arraycopy。诊断成本从 O(1) 变为 O(n)。100x faster
      不值得牺牲诊断性。源码验证: objArrayKlass::copy_array() 中的 type check 循环。
```

### 4.3 ★★★ Object arraycopy — per-element type check

```
问题：
  ① objArrayKlass::copy_array() 的逐元素检查逻辑是什么？
      答案方向: 对于每个待拷贝的 oop 引用：
        1. 读取 src[i] 的 oop → 查其 Klass*
        2. 调用 dst->klass()->component_type()->is_assignable_from(src_elem_class)
           → 检查 src 元素的类是否与 dst 数组的组件类型兼容
        3. 兼容 → oop 赋值到 dst[j]，不兼容 → 抛出 ArrayStoreException
      与 Java Object[].storeCheck 相同的类型层次检查——支持子类型多态。
      String[] dst = new String[1]; src[0] = null → null 通过（null 可赋值给任何类型）。
      
      追问: 为什么不直接 transcribe Java 的 aastore 字节码类型检查？
      → aastore 已在解释器中做类型检查。但 arraycopy 是批量复制——如果 aastore 
        被 intrinsify 为循环，每个元素仍需一个 aastore。JVM 在 native 层做类型检查
        是为了在一个连续检查循环中批量完成（cache-friendly）+ 在检测到第一个不兼容
        元素时立即报告 ArrayStoreException。

  ② Counterfactual: 如果类型检查推迟到后续每次读取时（而非赋值时）？
      答案方向: 数组可能有数百万个元素。如果第 1 个元素是错误的类型而第 100 万个元素
      是正确的类型，用户可能永远不读第 1 个元素而从不触发异常 → 静默数据损坏。
      ArrayStoreException 在赋值时立即抛出确保 fail-fast —— 不正确的数组状态不可能
      存在于 heap 中。这是 Java 内存安全保证的核心：不可能通过数组存储破坏类型系统。
```

### 4.4 ★★★ Object.hashCode — markOop identity hash

```
问题：
  ① Object.c:43 的 hashCode 如何到达 markOop？
      答案方向: Object.c:43 → RegisterNatives 绑定 "hashCode" 到 &JVM_IHashCode
      jvm.cpp:609 → JVM_ENTRY(jint, JVM_IHashCode(JNIEnv* env, jobject handle))
        return ObjectSynchronizer::FastHashCode(THREAD,
            JNIHandles::resolve_non_null(handle));
      FastHashCode() 在 synchronizer.cpp 中读取 oop 的 mark word：
        - 如果 hash 已计算 → 读取 markOop 的 25-bit hash 字段 → 直接返回
        - 如果 hash 未计算 → 生成新 hash（park-unpark-based nonce + XOR）
          → 写入 markOop 的 hash 字段（lock-free CAS）→ 返回
      25-bit hash = 33554432 种可能值。对数十亿对象的堆，碰撞必然发生——HashMap 靠
      链地址法（链表→红黑树）处理碰撞，hash 只需要均匀分布不需要唯一。
      
      追问: 为什么 hash 懒加载（lazy allocation）而非在对象创建时就生成？
      → 绝大多数对象的 hashCode() 永远不会被调用（局部变量、数组元素、不可变数据的
        transient 对象）。预计算 hash 浪费 CPU —— 一次调用 8µs × 109 个对象 = 浪费数百万秒 CPU。

  ② Counterfactual: 如果 hashCode 存储在 Java int 字段而非 markOop 中？
      答案方向: 每个对象增加 4 字节（+ 4 字节对齐 = 8 字节）。20GB heap with 
      2 billion objects → 16GB overhead just for hashcode. markOop already exists 
      in header for lock state / GC age / biased locking — adding hash costs 0 bytes.
      而且 JVM 需要访问 hash 来处理同步（biased locking uses markOop bits for 
      thread identification + hash），如果 hash 在 Java field 中 → 同步需要读取
      对象体而非 header → 额外内存访问 → ~5ns 额外延迟 per monitor enter。
```

### 4.5 ★★★ System.identityHashCode — bypassing virtual dispatch

```
问题：
  ① System.identityHashCode (System.c:54-57) 与 Object.hashCode 的区别是什么？
      答案方向: 两者最终都调用 JVM_IHashCode → ObjectSynchronizer::FastHashCode → 
      读取 markOop hash。唯一的区别是路径：
        - obj.hashCode(): Java 层 invokevirtual → 虚方法分派 → 如果子类重写 hashCode()
          则调用重写版本（可能返回常量或随机值）→ 永远不会到 native
        - System.identityHashCode(obj): 直接 native 调用 JVM_IHashCode(env, x)
          绕过所有 Java 层方法覆盖 → 始终返回 markOop hash
      源码 (System.c:54-57):
        JNIEXPORT jint JNICALL
        Java_java_lang_System_identityHashCode(JNIEnv *env, jobject this, jobject x)
            { return JVM_IHashCode(env, x); }
      这是 libjava.so 中最短的 native 方法 —— 单行调用转发。
      
      追问: HashMap 为什么需要 identityHashCode？
      → HashMap 的 resize 遍历时，如果 key 的 hashCode() 被覆盖并在 put 和 get 之间
        返回不同值（mutable key），entry 可能在错误的 bucket 中查找 → 无限循环。
        identityHashCode 提供一个不随时间变化的 hash —— 只要对象地址不变，hash 不变。

  ② Counterfactual: 如果 identityHashCode 调用 obj.hashCode()（通过 Java 虚分派）？
      答案方向: 子类 `class AlwaysZero { @Override int hashCode() { return 0; } }` → 
      identityHashCode 返回 0 → 所有此类对象在 HashMap 中映射到同一个 bucket → 
      HashMap resize 时所有 key 都在同一 bucket → 暴力扫描 O(n) per put → 
      10000 entries → 5000 probes per lookup → 500ms per put → live-lock on resize。
      identityHashCode 的本质功能（提供稳定的、不依赖程序员实现的 hash）完全失效。
```

### 4.6 ★★★ C2 intrinsic — arraycopy to REP MOVS

```
问题：
  ① C2 如何将 System.arraycopy native 调用替换为 REP MOVS？
      答案方向: C2 识别 System.arraycopy(int[], int, int[], int, int) 的调用签名 →
      匹配 intrinsic candidate → C2's graph builder 注入 ArrayCopyNode 到 IR 图中
      替代 native call node。在汇编阶段:
        - x86: REP MOVS (MOVSD for 8-byte chunks, prefixed with CLD+REP for repeat)
        - 已知类型 + 已知长度 → unrolled MOV instructions（更快的非 REP 序列）
        - 对齐检查: 8-byte aligned → MOVSD; unaligned → MOVSB
      消除的开销: JNI call overhead (~20ns) + safepoint check + oop wrapping。
      
      追问: C2 在什么条件下放弃 intrinsify？
      → 类型未知时 (megamorphic call site, same arraycopy for int[] and Object[])
      → 长度过大（>LARGE_LOOP_SIZE, C2 switches to full runtime call）
      → -XX:-UseArrayCopyIntrinsics flag explicitly disabled

  ② Counterfactual: 如果 C2 不做 intrinsic —— 每次 arraycopy 都走 JNI？
      答案方向: 10 element int[] copy → JNI call ~50ns (JNI boundary + safepoint + 
      parameter marshalling) + memmove ~5ns = ~55ns. Intrinsic: inline REP MOVS → 
      ~5ns total (no call overhead, no safepoint). 10x faster for small arrays.
      大数组延迟受限于内存带宽而非调用开销——1MB copy ~10µs intrinsic vs ~15µs JNI
      → 仅 1.5x，差别是常量 JNI overhead 20ns 被 amortized 在巨大数据上。
      所以 intrinsic 的最大价值是高频小数组复制（每秒钟数百万次微数组处理）。
```

### 4.7 ★★★ memmove vs memcpy — overlapped copy correctness

```
问题：
  ① 为什么 arraycopy 用 memmove 而非 memcpy？
      答案方向: System.arraycopy 的 Java spec（java.lang.System javadoc）：
        "If the src and dest arguments refer to the same array object, then the copying
         is performed as if the components at positions srcPos through srcPos+length-1
         were first copied to a temporary array with length components and then the 
         contents of the temporary array were copied into dest."
      → 必须支持 src 和 dst 重叠。memcpy 的 C 标准保证 (ISO C99 §7.21.2.1)：
        "If copying takes place between objects that overlap, the behavior is undefined."
      memmove 的 C 标准保证 (ISO C99 §7.21.2.2)：
        "Copying takes place as if the n characters from src are first copied into 
         a temporary array... and then copied into dest."
      memmove 的实现检查方向: 如果 src < dst → 从末尾向开头拷贝（避免源被覆盖前
      就被覆写）。选择 memmove 是因为 Java spec 明确要求这个语义。
      
      追问: memmove 的方向检查代价是多少？
      → 1 次指针对比（src < dst）→ 1 CPU branch → ~0.3ns on modern pipelined CPU。
        在 10KB 拷贝中 amortized 到 ~0.003% 开销。对非重叠情况的 cost ~1%。

  ② Counterfactual: 如果 arraycopy 用 memcpy —— 重叠拷贝何时会错？
      答案方向: src = [a,b,c,d], dst = src+2 (src 中偏移 2):
        memcpy: 复制 a → dst+0, b → dst+1 → 但 dst+0 已经是 src+2 → 覆盖了 c → 
        c 的值丢失 → 复制 c 时 dst+2 收到错误的被覆写的值 → dst = [a,b,?,?]
        memmove: 检测到 src < dst → 从末尾复制 (d, c, b, a 顺序) → dst = [a,b,a,b]
        正确。这种模式在数组左移操作 (System.arraycopy(arr, 2, arr, 0, 2)) 中非常常见。
```

### 4.8 ★★★ Float.floatToRawIntBits — zero-cost reinterpretation

```
问题：
  ① Float.floatToRawIntBits (Float.c:49-56) 为什么是 native？
      答案方向: Java 没有 C union 类型——无法在同一块内存上用两种类型 interpret bits。
      Float.c:49-56 使用 union { int i; float f; } —— 写入 f, 读取 i:
        union { int i; float f; } u;
        u.f = (float)v;
        return (jint)u.i;
      这是纯寄存器级操作 —— CPU 将同一寄存器中的 32 bits 从浮点重新解释为整数。
      零内存访问，零计算。C2 将此 intrinsify 为 MoveF2INode —— 无代码生成，
      只是 IR 图中类型标注从 float 变为 int。等价于 x86 `movd`（FPU→通用寄存器）。
      
      追问: 为什么不是 Java 的 Float.floatToIntBits 本身？
      → floatToIntBits 额外将所有 NaN 编码折叠为单一规范 NaN (0x7fc00000)。
        这是纯数学操作——可以在 Java 中实现（用 Float.isNaN + 位运算）。
        floatToRawIntBits 保留 NaN bits 原样——需要 C union 来获取原始 bits。

  ② Counterfactual: 如果 Java 有 union 类型？
      答案方向: floatToRawIntBits 可以是 Java 的一行代码：
        return Float.asBits(v).asInt();
      无需 native。但 Java 的安全模型不允许未标记的类型重解释——没有未定义行为的
      空间（不像 C: union 的类型混淆是 UB 在某些平台上的大小端差异）。
      "无 union" 是一个安全设计——不是什么性能考虑。
```

---

## §五 Article Structure

```
§〇 生产场景 — ArrayStoreException at Object[] arraycopy
  ★ 真实错误消息: java.lang.ArrayStoreException: java.lang.Integer
  ★ Root cause: dst 声明 Object[] 但运行时 String[]; Integer 不能进 String[]
  ★ 三步诊断: jshell → rg arraycopy → GDB System.c:41 + jvm.cpp:340
  ★ 反事实: memmove 不做类型检查 → symptom far from cause

§一 ★★★ arraycopy + hashCode 全链路源码走读
  ❓ 这不是 API 教程——这是 JVM 如何用 memmove 复制内存
  1.1 System.c:38-42 RegisterNatives → JVM_ArrayCopy binding
  1.2 jvm.cpp:328-341 JVM_ArrayCopy → s->klass()->copy_array() dispatch
  1.3 Primitive path: typeArrayKlass::copy_array → memmove (vectorized)
  1.4 Object path: objArrayKlass::copy_array → per-element type check
  1.5 Object.c:43 hashCode → JVM_IHashCode → ObjectSynchronizer::FastHashCode
  1.6 markOop hash field — 25 bits, lazy allocation, lock-free CAS store
  1.7 System.c:54-56 identityHashCode → same JVM_IHashCode, bypasses virtual dispatch
  1.8 C2 intrinsic: ArrayCopyNode → REP MOVS; hash field direct read; floatToRawIntBits → MoveF2I
  1.9 ★ Mermaid: arraycopy dispatch tree — JNI → JVM → Klass virtual dispatch → memmove / type loop
      Lanes: Java / Native Bridge / JVM Core / C2 Compiler
  1.10 ★ 面试 Story Format 答案 — 从 RegisterNatives 到 REP MOVS 的完整叙事

§二 ★★★ 5 Beginner Callout 框
  2.1 JNI_ENTRY / JVM_ENTRY / JVM_LEAF
  2.2 markOop (object header mark word)
  2.3 memmove vs memcpy (overlap semantics)
  2.4 Intrinsic (C2 replaces native call with CPU instruction)
  2.5 RegisterNatives (JNI function pointer binding)

§三 ★★ 数组类型检查 + hashCode 性能剖析
  ❓ Primitive memmove 成本 vs Object[] element check 成本
  ❓ 为什么 hashCode 不在创建对象时预计算
  3.1 memmove 性能: 2MB copy → 0.5ms (DDR4 40GB/s bandwidth limited)
  3.2 Object[] check 性能: 1M elements → 10ms (one virtual dispatch + type check per element)
  3.3 hashCode lazy allocation: ~8µs first call, ~2ns subsequent calls (cached in markOop)

§四 ★ GDB 断点验证 — 7 断点完整 arraycopy + hashCode trace
  断言 1: System.c:41 RegisterNatives → verify JVM_ArrayCopy binding
  断言 2: jvm.cpp:340 s->klass()->copy_array() → verify dispatch
  断言 3: typeArrayKlass::copy_array memmove breakpoint → verify no per-element loop
  断言 4: objArrayKlass::copy_array type check → verify element-by-element
  断言 5: Float.c:49 floatToRawIntBits union → verify zero JVM calls
  断言 6: Object.c:43 hashCode → JVM_IHashCode → verify markOop read
  断言 7: System.c:56 identityHashCode → verify same JVM_IHashCode function

§五 ★ Cross-Reference
  ❓ 09-native-interface — JNI_ENTRY/JVM_ENTRY 宏机制，本文的每个 native 方法都使用
  ❓ 03-object-model — markOop 内存布局，identity hash 存于 header
  ❓ 05-jit-compiler — C2 intrinsics: ArrayCopyNode, hash field read, float move
  ❓ 01-class-loading — forName → Class.c:137, covered in prompt-01
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because Java spec requires overlapping-copy correctness, JVM_ArrayCopy uses memmove (not memcpy)..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from System.c / Object.c / jvm.cpp / Float.c, do not describe it.

3. **Mermaid** — arraycopy dispatch sequence diagram. 4 lanes: Java Application / Native libjava (System.c, Object.c) / JVM Core (jvm.cpp) / C2 Compiler. Complete flow: `System.arraycopy(src,0,dst,0,len)` → `RegisterNatives binding` → `JVM_ArrayCopy` → `s->klass()->copy_array()` → `isPrimitive?` → `memmove` (or `type-check loop for Object[]`). Annotate every step with file:line.

4. **GDB session** — 7 breakpoints with exact file:line numbers:
   - `System.c:41` RegisterNatives arraycopy binding — verify function pointer
   - `jvm.cpp:340` s->klass()->copy_array() — verify Klass dispatch
   - `typeArrayKlass::copy_array` memmove call — verify no per-element loop
   - `objArrayKlass::copy_array` type check loop — verify element type
   - `Object.c:43` hashCode RegisterNatives — verify JVM_IHashCode binding
   - `System.c:56` identityHashCode — verify same JVM_IHashCode call
   - `Float.c:49` floatToRawIntBits — verify union reinterpretation
   Each with expected variable values to verify.

5. **5 Beginner callout boxes** — exact text from §一: JNI_ENTRY/JVM_ENTRY/JVM_LEAF, markOop, memmove vs memcpy, intrinsic, RegisterNatives.

6. **Cross-reference at three points**:
   - At `JVM_ArrayCopy` → "→ 09-native-interface for JVM_ENTRY macro details"
   - At `ObjectSynchronizer::FastHashCode` → "→ 03-object-model for markOop layout"
   - At C2 intrinsic section → "→ 05-jit-compiler for C2 intrinsic framework"

7. **Story-format interview answer** — at §一末尾: 从 `System.arraycopy(src,0,dst,0,1_000_000)` 到 memmove 完成的叙事. Two parts: "RegisterNatives binding + JVM dispatch" + "primitive vs object type decision + 数组内存拷贝".

---

## §七 Output Format

- Markdown file, named `00-System-Arraycopy.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/15-core-native/prompts/`
- 元信息头:

```
> **阶段**：[15-core-native]
> **前置**：[09-native-interface]（JNI_ENTRY/JVM_ENTRY 宏机制）、[03-object-model]（markOop, object header, identity hash 存储位置）、[05-jit-compiler]（C2 intrinsics: 如何替换 native call 为 CPU 指令）
> **配套**：[01-Class-String]（Class.forName, String.intern）、[02-Runtime-Throwable]（Runtime.gc, Throwable.fillInStackTrace）、[03-JNI-Utility]（jni_util.c 工具层）
> **后续依赖本文**：[16-nio-network]（DirectByteBuffer native operations 同样使用 JVM_ENTRY）
> **阅读收益**：追踪 System.arraycopy 从 RegisterNatives 到 memmove 的完整 5 步分发链——理解 RegisterNatives 绑定机制、JVM_ArrayCopy 的 Klass 虚分派（primitive → memmove / Object → type check）、Object.hashCode 与 System.identityHashCode 共享 JVM_IHashCode 的设计、memmove vs memcpy 的 spec 合规选择、C2 intrinsic 如何将 arraycopy 编译为 REP MOVS；掌握 "ArrayStoreException" 的 type-check 诊断路径
```

- 目标行数: 350+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "arraycopy copies array elements" 而不展示 JVM 内部的 dispatch 机制 — 必须从 System.c:41 RegisterNatives 到 jvm.cpp:340 copy_array 到 memmove/type check 完整源码
- ❌ 不解释 RegisterNatives 为什么存在 — 必须展示它允许跨 .so 绑定 + 共享 JVM 内部函数（JVM_IHashCode 两个调用者共享）
- ❌ 不解释 memmove vs memcpy — 必须展示 Java spec 的 overlapping copy 要求 + C 标准的 UB 差异
- ❌ 忽略 Object.hashCode 和 System.identityHashCode 共用函数 — 必须展示两者都调用 JVM_IHashCode 但路径不同（virtual dispatch vs direct native）
- ❌ 不对 hashCode 做 markOop 存储解释 — 必须展示 hash 的 25-bit field + lazy allocation + lock-free CAS
- ❌ 不展示 C2 intrinsic — 必须解释 ArrayCopyNode → REP MOVS 的 JIT 替换流程
- ❌ 不解释 Float.floatToRawIntBits 的 union 模式 — 必须展示 C union 是如何绕过 Java 类型系统的
- ❌ 不做 GDB 断点 trace — 至少 7 个断点覆盖 arraycopy dispatch → hashCode markOop read
- ❌ 忘记 int 和 float 的 NaN 折叠差异 — 必须区分 floatToRawIntBits (preserve NaN bits) vs floatToIntBits (collapse to canonical NaN)
- ❌ 不要解释 C 语言基础

---

## §九 Required（≥8）

- ✅ **★ Mermaid arraycopy 分发序列图** — 4 lanes: Java / Native libjava / JVM Core / C2 Compiler — RegisterNatives → JVM_ArrayCopy → Klass::copy_array → memmove/type check → C2 intrinsic
- ✅ **★ RegisterNatives 源码展示** — System.c:38-42 JNINativeMethod 数组 + System.c:49 RegisterNatives 调用
- ✅ **★ JVM_ArrayCopy 完整源码** — jvm.cpp:328-341 JVM_ENTRY + copy_array dispatch
- ✅ **★ Object.hashCode 到 markOop 路径** — Object.c:43 RegisterNatives → jvm.cpp:609 JVM_IHashCode → ObjectSynchronizer::FastHashCode
- ✅ **★ memmove vs memcpy Counterfactual 对比** — 重叠复制场景 + C 标准语义差异表
- ✅ **★ 5 Beginner Callout 框** — exact text from §一: JNI_ENTRY/JVM_ENTRY/JVM_LEAF, markOop, memmove vs memcpy, intrinsic, RegisterNatives
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：RegisterNatives → JVM dispatch → memmove / type check → C2 intrinsic
- ✅ **★ GDB 断点 ≥7 条** — 精确到 file:line，每断点有预期变量值，覆盖 arraycopy + hashCode + floatToRawIntBits
- ✅ **★ IdentityHashCode vs HashCode 调用差异** — System.c:54-57 源码 + 虚分派解释
- ✅ **★ 交叉引用** — 09-native-interface (JVM_ENTRY), 03-object-model (markOop), 05-jit-compiler (C2 intrinsics), 01-Class-String (Class.c)

---

## §十 GDB Verification（≥7 assertions）

```
断言 1: RegisterNatives arraycopy 绑定 (System.c:41)
  (gdb) break System.c:41
  (gdb) print methods[2].name → 期望: "arraycopy"
  (gdb) print methods[2].fnPtr → 期望: &JVM_ArrayCopy
  (gdb) continue
  (gdb) print cookie → 期望: 非 NULL (RegisterNatives 成功返回)

断言 2: JVM_ArrayCopy entry (jvm.cpp:328)
  (gdb) break jvm.cpp:328
  运行: java -cp app.jar com.example.Main (触发 arraycopy)
  (gdb) print src → 期望: jobject (非 NULL)
  (gdb) print dst → 期望: jobject (非 NULL)
  (gdb) print length → 期望: >0 (要复制的元素数)

断言 3: Klass::copy_array dispatch (jvm.cpp:340)
  (gdb) break jvm.cpp:340
  (gdb) print s->klass()->name() → 期望: 数组类型名 (例如 "[I" 是 int[], "[Ljava.lang.Object;" 是 Object[])
  (gdb) continue → 进入 typeArrayKlass::copy_array 或 objArrayKlass::copy_array
  (gdb) print进入的函数名 → 期望: 区分 primitive vs Object 分派

断言 4: typeArrayKlass::copy_array memmove (typeArrayKlass.cpp)
  (gdb) break typeArrayKlass.cpp (copy_array 内 memmove 调用行)
  (gdb) print src_pos → 期望: 0 (起始位置)
  (gdb) print dst_pos → 期望: 0
  (gdb) print length → 期望: >0
  (gdb) continue 经过 memmove
  (gdb) print dst_array[0] → 期望: 与 src[0] 相同的原始值

断言 5: Object.c hashCode RegisterNatives (Object.c:43)
  (gdb) break Object.c:43
  (gdb) print methods[0].name → 期望: "hashCode"
  (gdb) print methods[0].fnPtr → 期望: &JVM_IHashCode

断言 6: JVM_IHashCode → markOop (jvm.cpp:609)
  (gdb) break jvm.cpp:609
  (gdb) print handle → 期望: 有效的 jobject
  (gdb) continue 进入 FastHashCode
  (gdb) print obj->mark() → 期望: markOop 值 (包含 hash bits)
  (gdb) print hash_result → 期望: 25-bit hash value (0-33554431)

断言 7: Float.floatToRawIntBits union (Float.c:49)
  (gdb) break Float.c:49
  (gdb) print v → 期望: 浮点值 (例如 3.14159f)
  (gdb) continue 经过 union 赋值
  (gdb) print u.i → 期望: v 的 IEEE 754 32-bit 表示 (例如 0x40490fdb → 3.14159f)
  (gdb) print → 确认无 JVM 调用发生 (无 call 指令在附近)

断言 8: System.identityHashCode → same JVM_IHashCode (System.c:56)
  (gdb) break System.c:56
  (gdb) print x → 期望: 有效的 jobject
  (gdb) stepi → 进入 JVM_IHashCode
  (gdb) print → 确认与断言 6 进入同一函数地址
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **从 README §二.1 承接**：本文展开 §二.1 的 "Why System.arraycopy in native?" 问题——从 RegisterNatives 到 memmove 的完整代码级解答。

2. **同组边界**: 本文覆盖 System.c + Object.c + Float.c 的 Hot 路径；01 覆盖 Class.c + String.c 的 Warm 路径；02 覆盖 Runtime.c + Throwable.c；03 覆盖 jni_util.c 工具层。

3. **全部文档共享 §一 开头语**: "Reader completed 09-native-interface (JNI), 03-object-model (markOop), 05-jit-compiler (C2 intrinsics). This doc: how the most-called native methods actually work."
