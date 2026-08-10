Plan and write README.md for phase 15-core-native (libjava.so). Two-step: FIRST verify source, THEN write README with verified content.

## Phase context (continuity MUST be explicit)
15 covers the most FREQUENTLY called native methods in Java. `System.arraycopy` alone is called billions of times per day in production JVMs. `Object.hashCode` is called on every HashMap.get(). `Object.getClass` is called by every reflective framework. These are the "last mile" native bridge — the methods that a Java developer calls every day without thinking about what happens beneath.

Connects to:
- 01-jvm-startup: System.initProperties initializes java.class.path via native
- 02-class-loading: Class.forName(String) → native → FindClass → class loading chain
- 03-object-model: Object.hashCode() → native → markOop identity hash in object header
- 04-interpreter: every `aload_0` → getClass → native → what does it actually do?
- 05-jit-compiler: C2 intrinsifies System.arraycopy → direct memmove without JNI overhead
- 09-native-interface: the JNI_ENTRY/JVM_ENTRY macros used by ALL these methods
- 14-zip-jimage: ClassLoader.defineClass1 → covered in 14 bridge doc

## Step 1: Source code verification (MANDATORY first)

### Read and report on these files:

**Array.c** (src/java.base/share/native/libjava/Array.c):
1. `Java_java_lang_reflect_Array_newArray()` — how are reflective arrays created from native? JNI NewObjectArray or AllocObject + manual init?
2. `Java_java_lang_reflect_Array_getLength()` — simple JNI GetArrayLength?

**Class.c** (src/java.base/share/native/libjava/Class.c):
3. `Java_java_lang_Class_forName0()` — exact signature. Does it call JVM_FindClassFromCaller or JVM_FindLoadedClass? What's the classloader parameter?
4. `Java_java_lang_Class_isAssignableFrom()` — instanceof checks at native level. Direct Klass::is_subclass_of or through JVM?
5. `Java_java_lang_Class_isInstance()` — same as isAssignableFrom but object-level.
6. `Java_java_lang_Class_getName0()` — how does the binary name get converted to Java name? "java/lang/Object" → "java.lang.Object"?

**Float.c / Double.c** (src/java.base/share/native/libjava/):
7. `Java_java_lang_Float_floatToRawIntBits()` — pure C union {float f; int i} or calls JVM? If pure C, why does it need to be native at all?
8. `Java_java_lang_Double_longBitsToDouble()` — inverse conversion. Same question.

**Object.c** (src/java.base/share/native/libjava/Object.c):
9. `Java_java_lang_Object_hashCode()` — delegates to JVM_IHashCode? What JVM_ENTRY function?
10. `Java_java_lang_Object_getClass()` — delegates to JVM_GetClass? What's the relationship to Klass*?
11. `Java_java_lang_Object_notify()` / `notifyAll()` / `wait()` — how do these bridge to ObjectMonitor (07-thread-lock)?

**Runtime.c** (src/java.base/share/native/libjava/Runtime.c):
12. `Java_java_lang_Runtime_availableProcessors()` — how does it determine CPU count? `sysconf(_SC_NPROCESSORS_ONLN)`? or cgroup-aware reading `/sys/fs/cgroup/cpu/cpu.cfs_quota_us`? Check which OpenJDK version added cgroup awareness.
13. `Java_java_lang_Runtime_gc()` — how does System.gc() call into G1GC? JVM_GC or Universe::heap()->collect()?
14. `Java_java_lang_Runtime_maxMemory()` / `totalMemory()` / `freeMemory()` — how do these read from CollectedHeap?

**String.c** (src/java.base/share/native/libjava/String.c):
15. `Java_java_lang_String_intern()` — how does it insert into StringTable? Is StringTable lock-free or mutex-protected?

**System.c** (src/java.base/share/native/libjava/System.c):
16. `Java_java_lang_System_arraycopy()` — the single most important native method. What dispatch mechanism? Is isPrimitiveArray check → memmove for primitives? What about Object[] → type checking needed?
17. `Java_java_lang_System_identityHashCode()` — vs Object.hashCode. How does identity hashCode bypass overridden hashCode()?
18. `Java_java_lang_System_initProperties()` — how are system properties set at startup? Which properties are set by this native method vs Java code?
19. `Java_java_lang_System_nanoTime()` — clock_gettime(CLOCK_MONOTONIC)? How does it differ from System.currentTimeMillis?

**Throwable.c** (src/java.base/share/native/libjava/Throwable.c):
20. `Java_java_lang_Throwable_fillInStackTrace()` — how does JVM backtrace work? Stack walking at native level? What about C2-compiled frames — can the stack walker see through them?

**jni_util.c** (src/java.base/share/native/libjava/jni_util.c):
21. Key utility functions used by ALL libjava natives? `JNU_ThrowNullPointerException`, `JNU_GetStringPlatformChars`, `JNU_NewObjectByName`?

## Step 2: Write README.md

Output: probe_md/15-core-native/README.md (target: 500+ lines)

### Quality mandate (same as 13/14)
- Depth: every claim backed by Step 1 line numbers
- Breadth: cover ALL high-frequency native methods — System, Object, Class, String, Runtime, Throwable
- Interview: 8+ questions with concrete source-backed answers
- Continuity: explicit connections to 01-05, 09, 14
- First principles: every design decision derived from "if you designed this native bridge from scratch..."
- Beginner: JNI_ENTRY/JVM_ENTRY defined, JNI overhead explained, intrinsic substitution explained

### Required sections

#### §〇 上手指南
- 3-tier reading paths
- Prerequisites: 09-native-interface (JNI basics), 03-object-model (markOop for hashCode), 02-class-loading (FindClass for forName), 14-zip-jimage (ClassLoader bridge)
- 3-sentence essence: "libjava.so = Java 标准库的'最后一英里'。System.arraycopy 是 Java 调用频率最高的 native 方法——每天几百亿次。它不走复杂的 JNI 参数解析——直接 memmove 复制字节。Object.hashCode 是一个 C 层的函数指针调用——到 JVM 内部的 markOop hash 生成器。Class.forName 在 native 层完成 FindClass 调用——这是 Java reflection 的入口。"
- Core terminology: JNI_ENTRY (enter native from Java — slow path with parameter marshalling), JVM_ENTRY (JVM internal entry — fast path, no JNI marshalling), intrinsic (C2 replaces native call with direct CPU instruction), markOop (identity hash stored in object header), memmove (raw memory copy — no type checking), StringTable (interned string storage)

#### §一 Native Method Density Map (from Step 1)

| Tier | Methods | Call Frequency | Key File |
|------|---------|:---:|------|
| 🔥 Hot | System.arraycopy, Object.hashCode, Object.getClass, System.nanoTime | 10^9-10^10/day | System.c, Object.c |
| 🟡 Warm | Class.forName, Class.getName, String.intern, Throwable.fillInStackTrace | 10^6-10^8/day | Class.c, String.c, Throwable.c |
| 🟢 Cool | Runtime.gc, Runtime.exit, Array.newInstance, Float.floatToIntBits | 10^3-10^6/day | Runtime.c, Array.c, Float.c |
| ⚪ Cold | Object.notify/wait, RandomAccessFile, ObjectStreamClass | <10^3/day | Object.c, misc |

#### §二 First-Principles Design Decisions (≥8, derived from Step 1)

1. **Why System.arraycopy in native instead of Java?** "Java loop: 1 array bounds check per iteration. Native memmove: 0 checks per byte → 1M element copy: Java = 1M bounds checks (~10ms), memmove = 1 vectorized copy (~0.1ms). 100x faster. C2 further intrinsifies to REP MOVS on x86."

2. **Why Object.hashCode delegates to JVM_IHashCode?** "Hash code is stored in markOop (object header) — the JVM owns the header. Java can't access raw object headers. Native: JVM_IHashCode → markOop::hash() → compute OR retrieve cached hash. C2 intrinsifies: direct field read."

3. **Why Float.floatToIntBits is native?** "Java has no 'union' type. C: `union { float f; int32_t i; } u; u.f = value; return u.i;` — zero CPU cost, just a register reinterpretation. Java: no bit-level type cast. Must go native → or use Float.floatToRawIntBits which C2 intrinsifies to nothing (pure register move)."

4. **Why String.intern needs native?** "StringTable is a JVM-internal hashtable (ConcurrentHashTable) stored in metaspace. Java can't reach it. Native: JVM_InternString → StringTable::intern() → insert or find. Must be native because the table is in native memory, not Java heap."

5. **Why System.identityHashCode bypasses overridden hashCode()?** "`System.identityHashCode(obj)` vs `obj.hashCode()`. hashCode() is virtual → HashMap subclass could return constant. identityHashCode is NATIVE → calls JVM_IHashCode directly on the object header → reads the identity hash stored in markOop → never goes through Java dispatch. Used by HashMap to avoid infinite loops when hashCode() returns changing values."

6. **Why Throwable.fillInStackTrace is native?** "Stack walking requires reading native frames (C2-compiled methods, interpreter frames, C frames). Java can't dereference raw stack pointers. Native: fillInStackTrace → native StackWalk → reads thread's stack → builds StackTraceElement[]."

7. **Why Runtime.availableProcessors is native?** "Must call `sysconf(_SC_NPROCESSORS_ONLN)` (glibc) or read cgroup limits (`/sys/fs/cgroup/cpu/cpu.cfs_quota_us`). Both are OS-level interfaces. Java has no direct system call API."

8. **Why System.nanoTime doesn't just return System.currentTimeMillis * 10^6?** "currentTimeMillis = `gettimeofday()` — wall clock, drifts, NTP adjusts. nanoTime = `clock_gettime(CLOCK_MONOTONIC)` — monotonic, never goes backwards. Used for performance measurement → monotonic is required. Different clocks, different syscalls."

#### §三 Source Files Table (populated from Step 1)
| File | Lines | Key Functions | Call Tier |
|------|:---:|------|:---:|
| System.c | ~500 | arraycopy, identityHashCode, nanoTime, initProperties | 🔥 Hot |
| Object.c | ~300 | hashCode, getClass, notify, wait | 🔥 Hot |
| Class.c | ~400 | forName0, getName0, isAssignableFrom | 🟡 Warm |
| String.c | ~100 | intern | 🟡 Warm |
| Runtime.c | ~300 | availableProcessors, gc, maxMemory | 🟢 Cool |
| Throwable.c | ~200 | fillInStackTrace | 🟡 Warm |
| Array.c | ~100 | newArray, getLength | 🟢 Cool |
| Float.c / Double.c | ~100 | floatToRawIntBits, longBitsToDouble | 🟢 Cool |
| jni_util.c | ~300 | JNU_ThrowNullPointerException, etc. | — (utility) |

#### §四 Document Plan (3-4 docs)

### 00-System-Arraycopy-HashCode.md — the HOT path methods
**Core ❓**: "`System.arraycopy(src, 0, dst, 0, 1000000)` — how does this execute 1000000 copies in 0.1ms?"

**Production**: "ArrayStoreException on Object[] arraycopy — `src` contains Integer, `dst` is Object[] but `dst` was allocated as String[]. JVM implicitly stores String.class as the element type → copy of Integer into String[] → type mismatch."

**Coverage**: System.arraycopy dispatch (isPrimitive → memmove / isObject → type-check + copy), Object.hashCode (JVM_IHashCode → markOop::hash()), Object.getClass (JVM_GetClass → Klass*), System.identityHashCode, System.nanoTime (clock_gettime CLOCK_MONOTONIC).
**Source**: System.c, Object.c

### 01-Class-String-Native.md — reflection + interning
**Core ❓**: "`Class.forName('com.example.Foo')` — how does native forName call FindClass? Why not pure Java?"

**Production**: "`ClassNotFoundException: com.example.Foo` — forName0 called with wrong classloader. The caller's classloader (not the current thread's context classloader) is used — this subtlety causes NoClassDefFoundError in OSGi/module systems."

**Coverage**: Class.forName0 → JVM_FindClassFromCaller → FindClass in caller's classloader (not bootstrap), String.intern → StringTable::intern() → ConcurrentHashTable insert, Class.getName0 → binary name conversion ("java/lang/Object" → "java.lang.Object").
**Source**: Class.c, String.c

### 02-Runtime-Throwable.md — system + stack walking
**Core ❓**: "`Runtime.getRuntime().availableProcessors()` — sysconf or cgroup? How does Docker limit CPU affect this?"

**Production**: "Container restart loop: `Runtime.availableProcessors()` returns host CPU count (64) but container has 2 CPUs. JVM spawns 64 GC threads → 62 threads useless + context switching overhead → GC STW 10x longer."

**Coverage**: Runtime.availableProcessors (cgroup-aware since JDK 10+), Runtime.gc → JVM_GC → G1CollectedHeap::collect(), Runtime.maxMemory → CollectedHeap, Throwable.fillInStackTrace → native stack walk → StackTraceElement[].
**Source**: Runtime.c, Throwable.c

### 03-JNI-Utility-Layer.md — jni_util.c shared infrastructure
**Core ❓**: "Every libjava native method uses JNU_* utilities. What's in jni_util.c?"

**Coverage**: JNU_ThrowNullPointerException (standardized NPE throwing), JNU_GetStringPlatformChars (Unicode→platform encoding), JNU_NewObjectByName (class name → constructor call), JNU_ClassClass (pre-cached java.lang.Class jclass), JNU_Equals (string comparison).
**Source**: jni_util.c

#### §五 Interview Questions (≥8, verified from Step 1)

1. "How does System.arraycopy work?" → 00: isPrimitive check → memmove for primitives → type-check loop for Object[]. C2 intrinsifies to REP MOVS on x86. 100x faster than Java loop.

2. "Why doesn't Object.hashCode just return a Java int?" → 00: hashCode is stored in markOop (25 bits identity hash). JVM owns the header. C2 intrinsic: direct field read. Java can't access raw object headers.

3. "What's the difference between Object.hashCode and System.identityHashCode?" → 00: hashCode() is virtual → HashMap can override. identityHashCode is NATIVE → bypasses virtual dispatch → reads hash directly from markOop.

4. "Why is Float.floatToIntBits native?" → 01: Java has no C union type. C `union { float f; int i; } = f; return i` is a zero-cost register reinterpretation. C2 intrinsic: pure register move.

5. "How does Class.forName find the class?" → 01: forName0 → JVM_FindClassFromCaller → FindClass in CALLER's classloader (not current thread's context classloader). This is why OSGi classloading breaks — wrong classloader.

6. "How does String.intern work?" → 01: JVM_InternString → StringTable::intern() → ConcurrentHashTable. Returns existing entry or inserts new one. StringTable is in metaspace → native access required.

7. "How does Runtime.availableProcessors work in Docker?" → 02: JDK 10+: reads cgroup cpu limits from `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` and `cpu.cfs_period_us`. Calculates `floor(cpu_quota / cpu_period)`. Pre-JDK 10: only sysconf → wrong CPU count in containers.

8. "How does Throwable.fillInStackTrace capture the stack?" → 02: native call → thread's stack walk → read each frame → extract class/method/line → build StackTraceElement[]. Works through C2-compiled frames (reads nmethod metadata).

#### §六 Production Scenarios (≥4, with Step 1 error strings)

| Scenario | Symptom | Doc | Diagnostic |
|---------|---------|-----|------------|
| ArrayStoreException | `java.lang.ArrayStoreException: java.lang.Integer` | 00 | Check `src` element type vs `dst` declared type. Object[] copy with wrong runtime type → native type check fails. |
| ClassNotFoundException OSGi | `Class.forName('Foo')` fails but `Foo.class` works | 01 | Check caller's classloader. forName uses CALLER's loader, not context classloader. |
| Container CPU miscount | GC threads = 64 on 2-CPU container | 02 | `java -XX:+PrintFlagsFinal | grep ParallelGCThreads`. Check cgroup limits: `cat /sys/fs/cgroup/cpu.max`. |
| identityHashCode loop | HashMap infinite loop on custom hashCode | 00 | Object.hashCode returns changing value → HashMap can't find entry. Fix: use System.identityHashCode for hash-based collections with mutable keys. |

#### §七 Quality Audit Matrix
3-4 planned docs, honest pre-ratings

#### §八 Deep Questions (≥12, 5 tiers)
Tier 1 Basic: "Why is System.arraycopy native instead of Java?" "Why not store hashCode in a Java int field?"
Tier 2 Design: "Why does forName use caller's classloader — security or design?" "Why STRING.intern native but STRING.concat Java?"
Tier 3 Performance: "System.arraycopy C2 intrinsic — what happens if the type is not known at compile time?" "C2 can't intrinsify all throwable.fillInStackTrace calls — why?"
Tier 4 Container: "How does cgroup v2 (unified hierarchy) differ from v1 for availableProcessors?" "How does container CPU limit affect GC thread count?"
Tier 5 Danger: "What happens if you call System.arraycopy with overlapping src and dst?" "Why is identityHashCode not sufficient for perfectly unique hashing?"

#### §九 Cross-Phase Connections
| Phase | Connection |
|-------|-----------|
| 01-jvm-startup | System.initProperties → sets java.class.path on JVM startup |
| 02-class-loading | Class.forName → FindClass in caller's classloader → system dictionary |
| 03-object-model | Object.hashCode → markOop → object header identity hash |
| 05-jit-compiler | C2 intrinsifies arraycopy to REP MOVS, Float.floatToIntBits to register move |
| 09-native-interface | JNI_ENTRY macro used by ALL libjava native functions |
| 14-zip-jimage | ClassLoader.defineClass1 → native bridge (covered in 03) |
