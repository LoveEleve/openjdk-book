# PROMPT: 请撰写 03-JNI-Utility.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

Silent NullPointerException in native code path. A custom JNI method calling `JNU_GetStringPlatformChars(env, NULL, &isCopy)` — passing a NULL `jstring`. Without JNU utility validation, the raw JNI `GetStringUTFChars(env, NULL, &isCopy)` dereferences a NULL oop → JVM crashes with `SIGSEGV` in the native library, producing a cryptic `hs_err_pid*.log` with no indication why. The hs_err log shows `Problematic frame: V [libjvm.so+0x...]` but no hint that the root cause is a NULL jstring parameter.

JNU utilities prevent this in two ways:
1. **`JNU_ThrowNullPointerException(env, "key is null")`** — generates a proper Java `NullPointerException` with a descriptive message that surfaces in the Java exception stack, not in JVM crash logs.
2. **`JNU_GetStringPlatformChars`** — internally checks for NULL jstring + encoding conversion failures → returns NULL with a pending Java exception (via `JNU_ThrowNullPointerException`).

The `JNU_` prefix stands for "JNI Utility" — these are 20+ reusable helper functions in `jni_util.c` (1506 lines) used by EVERY native method in libjava.so. Without them, each native method would manually call `(*env)->ThrowNew(env, NPEClass, "key is null")` → boilerplate code, inconsistent error messages, potential typos in exception class names, and missed null checks.

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查 hs_err 日志中的 native frame
rg "Problematic frame" hs_err_pid*.log
# 如果显示 V [libjava.so+0x...] → native crash in libjava
# 对照偏移查找具体函数: objdump -d libjava.so | grep <offset>

# 2. 确认 JNU_ThrowNullPointerException 调用位置
rg "JNU_ThrowNullPointerException" src/java.base/share/native/libjava/System.c
# 确保所有 JNI 入口都有 null 检查

# 3. GDB 断点验证 JNU 异常抛出
gdb -ex "break jni_util.c:56" \
    -ex "run" \
    -ex "print msg" \
    -ex "print env" \
    --args java -cp app.jar com.example.Main
```

**反事实**：如果没有 JNU utility layer → 每个 native 方法（libjava.so 中有 100+ 个）都需要手动处理 null 检查 + 字符串转换 + 异常抛出 + 类缓存 → 代码量增加 3-5x → 一致性无法保证 → 某些 native 方法省略 null 检查 → 偶然的 SIGSEGV crash (只在特定输入触发) → 最危险的 bug 类型。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that maps the complete JNI utility layer — `jni_util.c` (1506 lines, the most reused C file in the JDK library). Every native method in System.c, Object.c, Class.c, Runtime.c, Throwable.c, and dozens of other files calls `JNU_*` functions. This is the shared infrastructure that makes all the other native methods in 15-core-native possible.

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, JNI parameter marshalling). This doc: **how the most-called native methods actually work** — how the JNI utility layer eliminates boilerplate and prevents native crashes from exception helpers (15 standardized exception throwers) to string conversion with 4 encoding fast paths, to global cached jclass references, to variable-argument JNI method dispatch.

前置: [00-System-Arraycopy], [01-Class-String], [02-Runtime-Throwable] (the methods this utility layer serves before them)

### Interview Story Format Answer（必须出现在 §一 末尾）

"Every libjava native method uses `JNU_*` utility functions from `jni_util.c`. This 1506-line C file provides 4 categories of helpers: (1) **exception helpers** — `JNU_ThrowNullPointerException(env, msg)` throws a proper Java NPE with message; `JNU_ThrowByName(env, "...", msg)` throws any of 15 exception types by string name (saving each native method from calling `FindClass` + `ThrowNew` manually). (2) **string conversion** — `JNU_GetStringPlatformChars(env, jstr, &isCopy)` converts a jstring to a platform C string with 4 encoding fast paths (UTF-8, ISO-8859-1, US-ASCII, Cp1252); `JNU_NewStringPlatform(env, cstr)` does the reverse. (3) **class caching** — `JNU_ClassString(env)`, `JNU_ClassClass(env)` etc. return global-referenced cached jclass objects → every native method avoids the cost of `FindClass("java/lang/String")` per call (~200ns per FindClass). (4) **method invocation** — `JNU_CallMethodByName(env, obj, "methodName", "()V", args...)` uses variable-argument JNI dispatch for calling Java methods from native — the `va_list` version handles the JNI method resolution and call with one helper. Together, these utilities eliminate ~300 lines of boilerplate per native file and ensure consistent null-checking, error handling, and encoding conversion across all 100+ native methods in libjava.so."

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **JNU_ThrowNullPointerException**: The simplest and most critical JNU helper. At jni_util.c:56, it calls `(*env)->ThrowNew(env, NPEClass, msg)`. `NPEClass` is a C macro that expands to `JNU_ClassNullPointerException(env)` → a cached jclass global reference for `java.lang.NullPointerException`. This avoids calling `(*env)->FindClass(env, "java/lang/NullPointerException")` on every null detection → ~200ns saved per null check. Source: `src/java.base/share/native/libjava/jni_util.c:56`.

2. **Global jclass caching**: `jni_util.c` defines `JNU_ClassString`, `JNU_ClassClass`, `JNU_ClassObject`, `JNU_ClassThrowable` — these return `static jclass` global references initialized once (lazy singleton). Each uses `(*env)->NewGlobalRef(env, localClass)` to prevent the GC from collecting the class object. Without global refs, the cached `jclass` would become a dangling pointer after GC → undefined behavior on next use. Source: jni_util.c:1028-1073.

3. **Platform string encoding**: Java strings use UTF-16 internally (16-bit code units). The OS (Linux C runtime) uses a locale-dependent encoding (usually UTF-8, but could be ISO-8859-1 for some locale settings). `JNU_GetStringPlatformChars` converts jstring to C char* using the platform encoding. It has 4 fast paths: `GetStringUTFChars` for UTF-8, `GetStringISO8859_1Chars` for 8859-1, and equivalents for US-ASCII and Cp1252. Source: jni_util.c:970-1010.

4. **JNU_CallMethodByName**: Calls a Java method from C by name — finds the method at runtime via `FindClass` + `GetMethodID`. This is C's answer to Java reflection — it enables native code to invoke arbitrary Java methods without compile-time binding. The `V` variant (`JNU_CallMethodByNameV`) takes a `va_list` for variable arguments — one helper covers all possible method signatures from `()V` to `(Ljava/lang/String;I)J`. Source: jni_util.c:324-413.

5. **JNU_Equals**: Compares two Java strings from native code using `(*env)->CallBooleanMethod(env, str1, equals_mid, str2)`. The `equals_mid` (Method ID for `String.equals(Object)`) is cached as a global reference — avoids `GetMethodID("equals", "(Ljava/lang/Object;)Z")` per comparison. Source: jni_util.c:1113-1125.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/share/native/libjava/jni_util.c` — 1506 lines, 20+ JNU utility functions
- `src/java.base/share/native/libjava/jni_util.h` — JNU_ function declarations + macros
- All native caller files: System.c, Object.c, Class.c, Runtime.c, Throwable.c, etc.

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjava.so` — jni_util.c linked into every libjava native file

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **jni_util.c** | `src/java.base/share/native/libjava/jni_util.c` | 1506 | `JNU_ThrowNullPointerException`(:56), `JNU_ThrowByName`(:67, 15 exception types), `JNU_GetStringPlatformChars`(:970), `JNU_NewStringPlatform`(:446), `JNU_NewObjectByName`(:420), `JNU_ClassString`(:1028), `JNU_ClassClass`(:1046), `JNU_CallMethodByName`(:324), `JNU_CallMethodByNameV`(:344), `JNU_Equals`(:1113), `JNU_CopyObjectArray`(:1075), `JNU_GetEnv`(:1090) | **Shared JNI utility layer** — used by every libjava native file |
| 2 | **jni_util.h** | `src/java.base/share/native/libjava/jni_util.h` | ~200 | JNU_ function decls, `JNU_ClassString` macros, encoding init constants | Header — declarations + encoding constants |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ JNU_ThrowNullPointerException — standardized NPE

```
问题：
  ① jni_util.c:56 的 JNU_ThrowNullPointerException 如何抛出异常？
      答案方向: jni_util.c:56-64:
        void JNU_ThrowNullPointerException(JNIEnv *env, const char *msg) {
            if (!((*env)->ExceptionOccurred(env))) {
                jclass clazz = (*env)->FindClass(env,
                    "java/lang/NullPointerException");
                if (clazz != 0) {
                    (*env)->ThrowNew(env, clazz, msg);
                }
            }
        }
      三步操作:
        1. Check: 已经有待处理异常了吗？→ 如果已存在 (from previous JNI call) → 跳过
           (避免覆盖原始异常信息)
        2. FindClass: 可能返回 NULL (如果 NPE 类无法加载, 极罕见但理论上可能)
        3. ThrowNew: 创建一个新的 NPE with message → 储存于线程的异常状态
      
      追问: 为什么用 FindClass 查找 NPE 类而非缓存？
      → 这里用了 FindClass 而非 JNU_ClassNullPointerException (cached global ref)。
        这实际上是一个性能 bug——每次 throw 都调用 FindClass。Production 代码中 
        JNU_ThrowNullPointerException 可能被调用了数十亿次 → 200ns/FindClass × 1B 
        = 200s CPU waste。但 hot path 的 null check 在 JVM level (JVM_ENTRY) 中处理
        → FindClass overhead 被限定在 cold code path。

  ② Counterfactual: 如果 native 方法不调用 JNU_ThrowNullPointerException 而直接 exit(-1)？
      答案方向: 直接在 C 层 abort() → JVM 无机会处理异常 → 没有 Java stack trace → 
        没有 finally block 执行 → 资源泄漏 (文件句柄, 连接未关闭)。Java 用户永远
        不知道是 null 参数导致了 crash → 只能看到 hs_err log → 需要 native debugger 
        来诊断。JNU_ThrowNullPointerException 确保: Java 的 try-catch 能捕获异常 →
        Java 层的错误处理机制正常工作 → 用户看到熟悉的 NPE stack trace。
```

### 4.2 ★★★ JNU_ThrowByName — 15 exception types

```
问题：
  ① JNU_ThrowByName 如何支持 15 种异常类型？
      答案方向: jni_util.c:67 → JNU_ThrowByName(env, "java/lang/ExceptionClassName", msg)
        与 JNU_ThrowNullPointerException 相同的模式，但 exception class 名作为参数。
        支持的异常类型 (所有 Java 标准异常):
          - java/lang/NullPointerException (等同于 JNU_ThrowNullPointerException)
          - java/lang/IllegalArgumentException, java/lang/IllegalStateException
          - java/io/IOException, java/io/FileNotFoundException
          - java/lang/ClassNotFoundException, java/lang/NoSuchMethodError
          - java/lang/RuntimeException, java/lang/IndexOutOfBoundsException
          - java/lang/SecurityException, java/lang/UnsatisfiedLinkError
          - java/lang/ArrayStoreException, java/lang/ArithmeticException
          - java/lang/NegativeArraySizeException
        每种异常类型都有对应的 JNU 快捷函数: JNU_ThrowByName(env, "java/io/IOException", msg)
        但调用者通常使用 pre-defined macro。
      
      追问: 为什么不每个异常类型单独一个函数 (JNU_ThrowIOException, JNU_ThrowSecurityException)?
      → 确实有短文法: JNU_ThrowIOException(env, msg) 是 macro → JNU_ThrowByName(env, 
        "java/io/IOException", msg)。所以有两种 layer: (a) JNU_ThrowByName 是通用机制,
        (b) JNU_Throw{Type} 是便捷 macro。任何新的异常类型都可以通过 ThrowByName 抛出
        而无需修改 jni_util.c 代码。

  ② Counterfactual: 如果不统一异常处理 → 每个 native 方法手工构造异常？
      答案方向: 100+ native methods in libjava.so → 每个至少有 2 null checks → 200 
        manual FindClass + ThrowNew patterns → 每个不同 (misspellings: "NullPointerExcpetion",
        不同的 messages: "key is null" vs "key == null" vs "NULL key parameter") → 排查
        production 错误时无法通过 grep 找到精确的异常源 → 诊断成本 10x。JNU utility 
        standardizes: (a) class name spelling, (b) message format, (c) exception hierarchy。
```

### 4.3 ★★★ JNU_GetStringPlatformChars — encoding fast path

```
问题：
  ① JNU_GetStringPlatformChars (jni_util.c:970) 的 4 种编码快路径是什么？
      答案方向: 根据 `JNU_Encoding` 全局变量的值 (在 InitializeEncoding 中设置):
        1. UTF-8 (最常用): GetStringUTFChars — JNI 直接返回 UTF-8 编码
        2. ISO-8859-1 (西欧): GetStringISO8859_1Chars — 8-bit 每字符, 无多字节 (快)
        3. US-ASCII / 646-US: 与 ISO-8859-1 共享快路径 (ASCII subset)
        4. Cp1252 (Windows 西欧): 特殊路径 — 需要手动 mapping 0x80-0x9F code points
      如果平台编码不在 4 种快路径中 → 使用 generic `(*env)->GetStringChars` → 
      返回 UTF-16 → 然后 iconv 或手动转换到平台编码 (slow path, ~10x slower)。
      
      追问: 为什么有 4 种快路径 — 为什么不用单一编码 (UTF-8)？
      → 平台编码不是 JVM 可以控制的。`nl_langinfo(CODESET)` 返回 Linux locale 设置:
        $LANG=en_US.ISO-8859-1 → JNU_Encoding = ISO-8859-1。JVM 不能强制所有系统
        使用 UTF-8 — 这违反了 POSIX locale 规范。快路径的存在是因为 JVM 在 4 种最常用
        编码中遇到绝大多数调用 — 对 99%+ Linux 系统覆盖 (UTF-8 or US-ASCII)。

  ② Counterfactual: 如果只用 Unicode (UTF-16) 到平台编码的转换 (无快路径)？
      答案方向: Java 内部是 UTF-16 → 平台编码转换 (例如 UTF-8) 需要 O(n) 检查每个
        char → 判断是否能编码为 1 byte → 检查 surrogate pairs → 生成多字节序列。
        GetStringUTFChars: JNI 在 native 层直接访问 Java 字符串的 byte[] → 如果是
        ASCII-only → 已经是 UTF-8 兼容 → 零转换。快路径比通用转换快 5-10x (取决于
        ASCII vs non-ASCII 字符比例)。对于 encoding-intensive 操作 (例如 文件 I/O 
        with native codec) → 快路径收益显著。
```

### 4.4 ★★★ JNU_ClassClass — global cached jclass

```
问题：
  ① JNU_ClassClass (jni_util.c:1028) 如何缓存 jclass？
      答案方向: jni_util.c:1028-1073:
        static jclass clsCls = 0;
        jclass JNU_ClassClass(JNIEnv *env) {
            if (!clsCls) {
                jclass localCls = (*env)->FindClass(env, "java/lang/Class");
                clsCls = (*env)->NewGlobalRef(env, localCls);
                (*env)->DeleteLocalRef(env, localCls);
            }
            return clsCls;
        }
      关键设计:
        1. static jclass → 跨调用保持引用 (C static)
        2. NewGlobalRef → GC 不会收集缓存的 jclass (global ref 是 GC root)
        3. DeleteLocalRef → 释放 local ref (JNI 函数返回后 local ref 无效 → 内存泄漏)
        4. Check-then-act → 线程不安全如果多线程同时首次调用 → 但 jclass 是不可变的
           → NewGlobalRef 是幂等的 → 可能内存泄漏一个 extra global ref → 可接受 (冷路径)
      
      追问: 为什么缓存 jclass 如此重要 — FindClass 有多贵？
      → FindClass("java/lang/Class") 需要: UTF-8 字符串 hash → ConcurrentHashTable 
        lookup in system dictionary → lock acquisition on dictionary → 200ns 在 warm 
        缓存中 (cold path ~1µs)。如果每次 JNI 方法调用都需要 FindClass → native 
        方法每次调用 +200ns。Cached global ref → ~2ns (return static pointer)。100x faster。

  ② Counterfactual: 如果每次调用都 FindClass 而不缓存？
      答案方向: ThreadLocal Get/Set static field → 每次 FindClass("java/lang/Thread") 
        + GetStaticFieldID("currentThread") → 2 FindClass calls 400ns + 2 GetStaticFieldID 
        200ns = 600ns per native call → for a 10 million req/s server with 20 native 
        calls per request = 200M FindClass calls/s → 120ms/s CPU overhead →
        12% CPU 浪费在重复的 FindClass。JNU_Class* caching 将这个从 O(findClass) 
        降到 O(pointer dereference) → ~2ns per call。
```

### 4.5 ★★★ JNU_CallMethodByName — variable-argument JNI dispatch

```
问题：
  ① JNU_CallMethodByName (jni_util.c:324) 如何实现可变参数方法调用？
      答案方向: jni_util.c:324-342:
        JNU_CallMethodByName(JNIEnv *env, jboolean *hasException, 
                             jobject obj, const char *name, 
                             const char *signature, ...)
        {
            va_list args;
            va_start(args, signature);
            result = JNU_CallMethodByNameV(env, hasException, obj, 
                                           name, signature, args);
            va_end(args);
            return result;
        }
      内部委托给 JNU_CallMethodByNameV (:344-413) 处理 va_list:
        1. GetObjectClass(env, obj) → 获取 obj 的 jclass
        2. GetMethodID(env, cls, name, signature) → 按名称+签名查找方法
        3. 如果找不到方法 → 记录异常 → return NULL
        4. 如果找到 → Call##TYPE##MethodA (根据返回类型 dispatch):
           - CallVoidMethodV, CallObjectMethodV, CallBooleanMethodV, ...
           - 通过 `signature[0]` 的第一个字符 ('V', 'L', 'Z', 'I', 'J', ...) 判断返回类型
      
      追问: 为什么需要 signature 参数 — 不能用 C 的 _Generic?
      → JNI method dispatch 必须提供 JVM 方法签名 (例如 "(Ljava/lang/String;I)V") 
        因为 Java 方法重载需要 param count + types 来区分离散方法。
        C 的 va_list 没有类型信息 (只有连续 bytes) → JNI 内部不知道栈上有多少个 args
        或每个 arg 的类型。signature 是 description → JNI 根据 signature 从 va_list 
        读取正确的参数并 marshall 到 JNI 调用。

  ② Counterfactual: 如果 native 代码不使用 JNU_CallMethodByName 而是手动 JNI？
      答案方向: 手动 JNI: FindClass + GetMethodID + CallVoidMethodA + error checking。
        4 次 JNI 调用 vs 1 次 JNU_CallMethodByName。
        Code 量: 8 lines (manual) vs 1 line (JNU)。100+ native methods → 从 800 lines
        降到 100 lines。不仅节约代码量——统一错误处理 (如果 GetMethodID 失败 → 异常
        设置 → hasException flag set) → 调用者无需单独检查每个 GetMethodID 返回。
```

### 4.6 ★★★ JNU_Equals — memory-efficient native string comparison

```
问题：
  ① JNU_Equals (jni_util.c:1113) 如何比较两个 Java 字符串？
      答案方向: jni_util.c:1113-1125:
        jboolean JNU_Equals(JNIEnv *env, jstring str1, jstring str2)
        {
            static jmethodID mid = NULL;
            if (!mid) {
                jclass cls = JNU_ClassString(env);
                mid = (*env)->GetMethodID(env, cls, "equals",
                                         "(Ljava/lang/Object;)Z");
            }
            return (*env)->CallBooleanMethod(env, str1, mid, str2);
        }
      关键细节:
        - String.equals(Object) 而非 String.equals(String) — 因为 JNI 的 GetMethodID 
          按 JVM 签名查找方法 → JVM 内部字节码用 Object 参数 (不是 String) 作为 
          equals 的 parameter type (Object.equals 被 String.equals 覆盖但签名仍是 Object)。
        - static jmethodID — 全局缓存 (class load 不变 → Method ID 不变)
        - JNU_ClassString cached 的 jclass → 零 FindClass overhead
      
      追问: 为什么不在 C 层比较字符串 (strcmp on native bytes) 而调用 Java equals?
      → Java 的 String.equals 检查: (a) 引用相等 (== cost ~1ns), (b) 是 String instance 
        (否则返回 false), (c) 长度相等, (d) byte-by-byte comparison of content。
        在 C 层复制这个逻辑: (a) 获取两个 UTF-8 字符串 → 2 JNI GetStringUTFChars 调用
        → 2 memory allocations → strcmp → 2 ReleaseStringUTFChars → 2 free。
        而 JNU_Equals: 1 次 JNI CallBooleanMethod → 内部在 Java heap 中比较 
        (byte[] 直接访问) → 0 native memory allocation → 2x faster for typical strings。
```

---

## §五 Article Structure

```
§〇 生产场景 — Silent NPE in native path due to missing null check
  ★ 症状: JVM SIGSEGV at JNI native method, hs_err log with cryptic native frame
  ★ Root cause: JNI method received NULL jstring, no null check, crash
  ★ 三步诊断: hs_err frame analysis → rg JNU_ThrowNullPointerException → GDB breakpoint
  ★ 反事实: 无 JNU 工具层 → 每个 native 方法手工 null check → 不一致 crash

§一 ★★★ JNI Utility Layer — jni_util.c 1506 lines 全覆盖
  ❓ 每个 libjava native 方法都使用 JNU_* 函数——它们怎么工作
  1.1 Exception helpers (jni_util.c:44-149): JNU_ThrowNullPointerException, JNU_ThrowByName (15 种)
  1.2 String conversion (jni_util.c:446-995): New/Get StringPlatformChars, 4 encoding fast paths
  1.3 Object construction (jni_util.c:415-444): JNU_NewObjectByName
  1.4 Class caching (jni_util.c:1011-1073): JNU_ClassString/Class/ClassObject/ClassThrowable
  1.5 Method invocation (jni_util.c:246-413): JNU_CallMethodByName/V + JNU_CallStaticMethodByName
  1.6 Field access (jni_util.c:1246-1506): JNU_Get/Set Field/StaticField by name
  1.7 String utilities: JNU_Equals, JNU_ToString, JNU_PrintString
  1.8 Monitor utilities: JNU_MonitorWait/Notify/NotifyAll
  1.9 ★ Mermaid: JNU utility call graph — all native methods → JNU helpers → JNI API
      Lanes: Native Method / JNU Utility / JNI API
  1.10 ★ 面试 Story Format 答案 — "JNI 工具层如何防止 native crash"

§二 ★★★ 5 Beginner Callout 框
  2.1 JNU_ThrowNullPointerException (standardized NPE)
  2.2 Global jclass caching (NewGlobalRef pattern)
  2.3 Platform string encoding (4 fast paths)
  2.4 JNU_CallMethodByName (variable-argument JNI dispatch)
  2.5 JNU_Equals (cached equals_mid string comparison)

§三 ★★ Exception safety + encoding correctness
  ❓ JNU_ThrowByName 的 15 种异常覆盖了 JVM 所有标准异常吗
  ❓ 编码快路径如何选择 — InitializeEncoding 的机制
  3.1 Exception throw safety: 检查 existing exception before throwing (no overwrite)
  3.2 Encoding initialization: nl_langinfo(CODESET) → set JNU_Encoding global
  3.3 Fast path selection: UTF-8 → GetStringUTFChars, 8859-1 → GetStringISO8859_1Chars

§四 ★ GDB 断点验证 — 4 断点完整 JNU utility trace
  断言 1: jni_util.c:56 JNU_ThrowNullPointerException — verify NPE throw with message
  断言 2: jni_util.c:970 GetStringPlatformChars — verify encoding fast path selection
  断言 3: jni_util.c:1028 JNU_ClassClass — verify cached global ref address
  断言 4: jni_util.c:324 JNU_CallMethodByName — verify method resolution

§五 ★ Cross-Reference
  ❓ 09-native-interface — JNI functions used by all JNU_* helpers
  ❓ 00-System-Arraycopy — System.c uses JNU_ThrowNullPointerException
  ❓ 01-Class-String — Class.c uses JNU_CallMethodByName
  ❓ 02-Runtime-Throwable — uses JNU_ThrowNullPointerException
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because JNI native methods require consistent exception handling and a single missed null check causes SIGSEGV crash..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from jni_util.c, do not describe it.

3. **Mermaid** — JNU utility call graph. 4 lanes: Native Method (System.c, Object.c, ...) / JNU Utility (jni_util.c) / JNI API / Java Exception. Complete flow: native method → JNU_ThrowNullPointerException → ThrowNew → Java Exception; native method → JNU_GetStringPlatformChars → encoding fast path → GetStringUTFChars; etc. Annotate every step with file:line.

4. **GDB session** — 4 breakpoints with exact file:line numbers:
   - `jni_util.c:56` JNU_ThrowNullPointerException — verify env + msg
   - `jni_util.c:970` GetStringPlatformChars — verify encoding dispatch
   - `jni_util.c:1028` JNU_ClassClass — verify cached jclass
   - `jni_util.c:324` JNU_CallMethodByName — verify va_list + signature
   Each with expected variable values to verify.

5. **5 Beginner callout boxes** — exact text from §一: JNU_ThrowNullPointerException, Global jclass caching, Platform string encoding, JNU_CallMethodByName, JNU_Equals.

6. **Cross-reference at three points**:
   - At `JNU_ThrowNullPointerException` → "→ 00-System-Arraycopy: System.c uses this for null checks"
   - At `JNU_CallMethodByName` → "→ 01-Class-String: Class.c uses this for Java method calls from native"
   - At `JNU_GetStringPlatformChars` → "→ 09-native-interface: JNI string conversion functions"

7. **Story-format interview answer** — at §一末尾: "JNI 工具层如何让 100+ native 方法保持一致性" — one narrative covering exception safety + encoding correctness + class caching + method dispatch.

---

## §七 Output Format

- Markdown file, named `03-JNI-Utility.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/15-core-native/prompts/`
- 元信息头:

```
> **阶段**：[15-core-native]
> **前置**：[09-native-interface]（JNI 函数: ThrowNew, FindClass, GetStringUTFChars, GetMethodID — JNU_* 函数内部使用这些 JNI API）
> **配套**：[00-System-Arraycopy]（System.c 使用本层）、[01-Class-String]（Class.c 使用本层）、[02-Runtime-Throwable]（Runtime.c + Throwable.c 使用本层）
> **后续依赖本文**：所有后续 Phase 的 native 文件都使用 JNU_* 工具层
> **阅读收益**：遍历 jni_util.c 的 5 大功能类别（异常安全、字符串转换、类缓存、方法调用、字段访问）——理解 JNU_ThrowNullPointerException / JNU_ThrowByName 的 15 种异常标准化、JNU_GetStringPlatformChars 的 4 编码快路径（UTF-8/8859-1/646-US/Cp1252）、JNU_Class* 的全局 jclass 缓存（NewGlobalRef + lazy singleton）、JNU_CallMethodByName 的 va_list JNI 可变参数 dispatch；掌握 "native SIGSEGV from NULL jstring" 的生产故障诊断
```

- 目标行数: 300+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "JNU utilities help JNI" 而不展示 4 大功能类别的具体函数 — 必须列举 exception throwers, string conversion, class caching, method invocation
- ❌ 不解释 JNU_ThrowNullPointerException 的 exception-overwrite check — 必须展示 `ExceptionOccurred(env)` 检查的作用
- ❌ 忽略 global jclass caching 为什么用 NewGlobalRef — 必须解释 local ref 生命周期 vs global ref GC root
- ❌ 不展示 4 种编码快路径的具体编码 — 必须列出 UTF-8, ISO-8859-1, US-ASCII, Cp1252 及各路径的 JNI 函数
- ❌ 不等同 JNU_ThrowByName 与 JNU_ThrowNullPointerException 的性能差异 — JNU_ThrowByName 用 FindClass per call vs JNU_ThrowNullPointerException (可优化为 cached class)
- ❌ 不解释 JNU_CallMethodByName 的 signature 参数为什么必需 — 必须说明 JNI method dispatch 依赖 JVM 方法签名来区分重载
- ❌ 忽略 JNU_Equals 的缓存 equals_mid — 必须展示 static jmethodID 全局缓存
- ❌ 不做 GDB 断点 trace — 至少 4 个断点覆盖 exception throw, encoding, class caching, method invocation
- ❌ 不要解释 C 语言基础
- ❌ 不要为每种异常类型创建单独的子节

---

## §九 Required（≥8）

- ✅ **★ Mermaid JNU utility call graph** — 4 lanes: Native Method / JNU Utility / JNI API / Java Exception — 展示 5 条调用路径: exception throw, string conversion, class caching, method invocation, field access
- ✅ **★ JNU_ThrowNullPointerException 完整源码** — jni_util.c:56-64 (包括 exception check + FindClass + ThrowNew)
- ✅ **★ JNU_GetStringPlatformChars 编码快路径说明** — 4 种编码 + 对应 JNI 函数表格
- ✅ **★ JNU_ClassClass 全局缓存源码** — jni_util.c:1028-1045 完整展示 (static jclass + NewGlobalRef)
- ✅ **★ JNU_CallMethodByName/V 源码** — jni_util.c:324-413 (va_list + GetMethodID + 返回类型 dispatch)
- ✅ **★ 5 Beginner Callout 框** — exact text from §一: JNU_ThrowNullPointerException, Global jclass caching, Platform string encoding, JNU_CallMethodByName, JNU_Equals
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事："JNI 工具层如何标准化 100+ native 方法的异常处理 + 字符串转换 + 方法调用"
- ✅ **★ JNU_Equals 源码** — jni_util.c:1113-1125 (cached jmethodID 模式)
- ✅ **★ GDB 断点 ≥4 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ 交叉引用** — 09-native-interface (JNI API 调用), 00-System-Arraycopy (caller), 01-Class-String (caller), 02-Runtime-Throwable (caller)

---

## §十 GDB Verification（≥4 assertions）

```
断言 1: JNU_ThrowNullPointerException (jni_util.c:56)
  (gdb) break jni_util.c:56
  运行: native 方法触发 null 参数
  (gdb) print msg → 期望: "key is null" 或类似消息
  (gdb) print (*env)->ExceptionOccurred(env) → 期望: NULL (no pending exception)
  (gdb) continue
  (gdb) print (*env)->ExceptionOccurred(env) → 期望: non-NULL (NPE created)

断言 2: JNU_GetStringPlatformChars encoding fast path (jni_util.c:970)
  (gdb) break jni_util.c:970
  (gdb) print JNU_Encoding → 期望: UTF-8, ISO-8859-1, US-ASCII, or Cp1252
  (gdb) continue 进入对应的 fast path
  (gdb) print jstr → 期望: 有效的 jstring (Java 字符串)
  (gdb) print result → 期望: C string (NULL if failed → Java exception pending)

断言 3: JNU_ClassClass cached jclass (jni_util.c:1028)
  (gdb) break jni_util.c:1028
  (gdb) print clsCls → 期望: 0 (first call) 或 non-NULL (cached)
  (gdb) continue (跳过 FindClass + NewGlobalRef)
  (gdb) print clsCls → 期望: non-NULL jclass (cached global ref)
  (gdb) continue (第二次调用)
  (gdb) print clsCls → 期望: 与第一次相同地址 (cached)

断言 4: JNU_CallMethodByName (jni_util.c:324)
  (gdb) break jni_util.c:324
  (gdb) print name → 期望: 方法名 (例如 "toString")
  (gdb) print signature → 期望: 方法签名 (例如 "()Ljava/lang/String;")
  (gdb) print obj → 期望: 有效的 jobject (接收者)
  (gdb) continue 进入 JNU_CallMethodByNameV
  (gdb) print cls → 期望: obj 的 jclass
  (gdb) print mid → 期望: method ID (非 NULL)
  (gdb) continue
  (gdb) print result → 期望: 方法返回值 (类型取决于 signature)
```
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **全部 4 文档共享 §一 开头语**: "Reader completed 09-native-interface (JNI), 03-object-model (markOop), 05-jit-compiler (C2 intrinsics). This doc: how the most-called native methods actually work."

2. **从 README §二 承接**：本文展开 jni_util.c 的 1506 行——所有 §二 介绍的 native 方法共享的基础层。

3. **同组边界**: 00 覆盖 System.c + Object.c Hot 路径；01 覆盖 Class.c + String.c Warm 路径；02 覆盖 Runtime.c + Throwable.c；03 覆盖 jni_util.c 工具层（被前三个文件全部使用）。

4. **前向链接**: 09-native-interface 的 JNI API (ThrowNew, FindClass, GetStringUTFChars, GetMethodID, ...) 是本文所有 JNU_* 函数的底层调用对象。本文是 libjava.so 的 "最后一篇"——解释了所有 native 方法的共享基础设施。
