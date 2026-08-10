# 03-JNI-Utility: jni_util.c — JNI Utility Layer

> **阶段**：[15-core-native]
> **前置**：[09-native-interface]（JNI 函数: ThrowNew, FindClass, GetStringUTFChars, GetMethodID — JNU_* 函数内部使用这些 JNI API）
> **配套**：[00-System-Arraycopy]（System.c 使用本层）、[01-Class-String]（Class.c 使用本层）、[02-Runtime-Throwable]（Runtime.c + Throwable.c 使用本层）
> **后续依赖本文**：所有后续 Phase 的 native 文件都使用 JNU_* 工具层
> **阅读收益**：遍历 jni_util.c 的 5 大功能类别（异常安全、字符串转换、类缓存、方法调用、字段访问）——理解 JNU_ThrowNullPointerException / JNU_ThrowByName 的 15 种异常标准化、JNU_GetStringPlatformChars 的 4 编码快路径（UTF-8/8859-1/646-US/Cp1252）、JNU_Class* 的全局 jclass 缓存（NewGlobalRef + lazy singleton）、JNU_CallMethodByName 的 va_list JNI 可变参数 dispatch；掌握 "native SIGSEGV from NULL jstring" 的生产故障诊断

---

## §〇 生产场景 — Silent NullPointerException in native code path

Silent NullPointerException in native code path. A custom JNI method calling `JNU_GetStringPlatformChars(env, NULL, &isCopy)` — passing a NULL `jstring`. Without JNU utility validation, the raw JNI `GetStringUTFChars(env, NULL, &isCopy)` dereferences a NULL oop → JVM crashes with `SIGSEGV` in the native library, producing a cryptic `hs_err_pid*.log` with no indication why. The hs_err log shows `Problematic frame: V [libjvm.so+0x...]` but no hint that the root cause is a NULL jstring parameter.

JNU utilities prevent this in two ways:
1. **`JNU_ThrowNullPointerException(env, "key is null")`** — generates a proper Java `NullPointerException` with a descriptive message that surfaces in the Java exception stack, not in JVM crash logs.
2. **`JNU_GetStringPlatformChars`** — internally checks for NULL jstring + encoding conversion failures → returns NULL with a pending Java exception (via `JNU_ThrowNullPointerException`).

The `JNU_` prefix stands for "JNI Utility" — these are 20+ reusable helper functions in `jni_util.c` (1506 lines) used by EVERY native method in libjava.so. Without them, each native method would manually call `(*env)->ThrowNew(env, NPEClass, "key is null")` → boilerplate code, inconsistent error messages, potential typos in exception class names, and missed null checks.

**三步诊断**：

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

## §一 全链路源码走读 — jni_util.c 1506 lines 全覆盖

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, JNI parameter marshalling). This doc: **how the most-called native methods actually work** — how the JNI utility layer eliminates boilerplate and prevents native crashes from exception helpers (15 standardized exception throwers) to string conversion with 4 encoding fast paths, to global cached jclass references, to variable-argument JNI method dispatch.

前置: [00-System-Arraycopy], [01-Class-String], [02-Runtime-Throwable] (the methods this utility layer serves before them)

### 1.1 Exception Helpers — JNU_ThrowNullPointerException + JNU_ThrowByName (jni_util.c:44-149)

`JNU_ThrowByName` is the central exception-throwing mechanism — 15 exception types, all delegating to the same 4-line core:

```c
JNIEXPORT void JNICALL
JNU_ThrowByName(JNIEnv *env, const char *name, const char *msg)
{
    jclass cls = (*env)->FindClass(env, name);
    if (cls != 0) /* Otherwise an exception has already been thrown */
        (*env)->ThrowNew(env, cls, msg);
}
```

Three-step operation:
1. `FindClass`: Lookup exception class by fully-qualified name (e.g. `"java/lang/NullPointerException"`)
2. Null check: If `cls == 0` → FindClass already set a pending exception (e.g. `NoClassDefFoundError`) → skip ThrowNew to avoid overwriting the existing exception
3. `ThrowNew`: Create a new exception instance with the given message → store in thread's pending exception state

Each concrete exception type has a thin wrapper:

```c
JNIEXPORT void JNICALL
JNU_ThrowNullPointerException(JNIEnv *env, const char *msg)
{
    JNU_ThrowByName(env, "java/lang/NullPointerException", msg);
}
```

The full catalog of 15 standardized exception throwers (all at jni_util.c:55-149):

```
JNU_ThrowNullPointerException          → java/lang/NullPointerException
JNU_ThrowArrayIndexOutOfBoundsException → java/lang/ArrayIndexOutOfBoundsException
JNU_ThrowOutOfMemoryError              → java/lang/OutOfMemoryError
JNU_ThrowIllegalArgumentException      → java/lang/IllegalArgumentException
JNU_ThrowIllegalAccessError            → java/lang/IllegalAccessError
JNU_ThrowIllegalAccessException        → java/lang/IllegalAccessException
JNU_ThrowInternalError                 → java/lang/InternalError
JNU_ThrowNoSuchFieldException          → java/lang/NoSuchFieldException
JNU_ThrowNoSuchMethodException         → java/lang/NoSuchMethodException
JNU_ThrowClassNotFoundException        → java/lang/ClassNotFoundException
JNU_ThrowNumberFormatException         → java/lang/NumberFormatException
JNU_ThrowIOException                   → java/io/IOException
JNU_ThrowNoSuchFieldError              → java/lang/NoSuchFieldError
JNU_ThrowNoSuchMethodError             → java/lang/NoSuchMethodError
JNU_ThrowStringIndexOutOfBoundsException → java/lang/StringIndexOutOfBoundsException
JNU_ThrowInstantiationException        → java/lang/InstantiationException
```

> **Beginner Callout 1 — JNU_ThrowNullPointerException**: The simplest and most critical JNU helper. At jni_util.c:56, it calls `JNU_ThrowByName(env, "java/lang/NullPointerException", msg)`. The `JNU_ThrowByName` at jni_util.c:44-51 uses `FindClass` + `ThrowNew` — avoiding manual `FindClass` + `ThrowNew` in every native method. The check `if (cls != 0)` ensures that if `FindClass` itself fails (e.g. the exception class can't be loaded), the original error is preserved rather than overwritten by a secondary failure.

### 1.2 String Conversion — JNU_GetStringPlatformChars encoding fast paths (jni_util.c:970-989)

Java strings use UTF-16 internally (16-bit code units). The OS (Linux C runtime) uses a locale-dependent encoding (usually UTF-8, but could be ISO-8859-1 for some locale settings). `JNU_GetStringPlatformChars` converts `jstring` to `char*` using the platform encoding:

```c
JNIEXPORT const char * JNICALL
JNU_GetStringPlatformChars(JNIEnv *env, jstring jstr, jboolean *isCopy)
{
    if (isCopy)
        *isCopy = JNI_TRUE;
    if (fastEncoding == FAST_UTF_8)
        return getStringUTF8(env, jstr);
    if (fastEncoding == FAST_8859_1)
        return getString8859_1Chars(env, jstr);
    if (fastEncoding == FAST_646_US)
        return getString646_USChars(env, jstr);
    if (fastEncoding == FAST_CP1252)
        return getStringCp1252Chars(env, jstr);
    if (fastEncoding == NO_ENCODING_YET) {
        JNU_ThrowInternalError(env, "platform encoding not initialized");
        return 0;
    } else
        return getStringBytes(env, jstr);
}
```

Four encoding fast paths, selected by the `fastEncoding` global (set during `InitializeEncoding`):

| Encoding | JNI Function | Scope | Performance |
|---|---|---|---|
| **UTF-8** | `getStringUTF8` → `GetStringUTFChars` | Default on 99%+ Linux | O(1) — JNI provides UTF-8 directly from modified-UTF-8 |
| **ISO-8859-1** | `getString8859_1Chars` → `GetStringCritical` + byte copy | Western European locales (en_US.ISO-8859-1) | O(n) — manually maps chars to bytes, truncates >0xff to `?` |
| **US-ASCII** | `getString646_USChars` → similar to 8859-1 path | Legacy US systems | O(n) — ASCII-only, rejects non-ASCII with exception |
| **Cp1252** | `getStringCp1252Chars` → `GetStringCritical` + custom mapping | Windows Western European | O(n) — special handling for 0x80-0x9F codepoints |

If the platform encoding is none of these 4 → generic slow path: `getStringBytes(env, jstr)` → `GetStringChars` (returns UTF-16) → iconv-style manual conversion to platform encoding → ~10x slower.

> **Beginner Callout 2 — Platform string encoding**: Java strings use UTF-16 internally (16-bit code units). The OS (Linux C runtime) uses a locale-dependent encoding (usually UTF-8, but could be ISO-8859-1 for some locale settings). `JNU_GetStringPlatformChars` converts jstring to C char* using the platform encoding. It has 4 fast paths: `GetStringUTFChars` for UTF-8, `GetStringISO8859_1Chars` for 8859-1, and equivalents for US-ASCII and Cp1252. Source: jni_util.c:970-989.

**Why 4 fast paths — not just UTF-8?** The platform encoding is NOT under JVM control. `nl_langinfo(CODESET)` returns the Linux locale setting: `$LANG=en_US.ISO-8859-1` → `JNU_Encoding = ISO-8859-1`. The JVM cannot force all systems to use UTF-8 — that violates POSIX locale specification. Fast paths exist because the JVM encounters these 4 encodings in the vast majority of calls — covering 99%+ Linux systems (UTF-8 or US-ASCII).

**Counterfactual: 如果只用 Unicode (UTF-16) 到平台编码的转换 (无快路径)？**
Java internal is UTF-16 → platform encoding conversion (e.g. UTF-8) requires O(n) checking each char → determine if it can encode as 1 byte → check surrogate pairs → generate multi-byte sequence. `GetStringUTFChars`: JNI directly accesses Java string's `byte[]` from native layer → if ASCII-only → already UTF-8 compatible → zero conversion. Fast path is 5-10x faster than generic conversion (depending on ASCII vs non-ASCII character ratio). For encoding-intensive operations (e.g. file I/O with native codec) → fast path benefit is significant.

### 1.3 NewStringPlatform — reverse conversion (jni_util.c:446-511)

`JNU_NewStringPlatform(env, cstr)` does the reverse — converts a platform C string to a Java `jstring`:

```c
static jstring
newSizedString8859_1(JNIEnv *env, const char *str, const int len)
{
    jchar buf[512];
    jchar *str1;
    jstring result;
    int i;
    if (len > 512) {
        str1 = (jchar *)malloc(len * sizeof(jchar));
        if (str1 == 0) {
            JNU_ThrowOutOfMemoryError(env, 0);
            return 0;
        }
    } else
        str1 = buf;
    for (i=0; i<len; i++)
        str1[i] = (unsigned char)str[i];
    result = (*env)->NewString(env, str1, len);
    if (str1 != buf)
        free(str1);
    return result;
}
```

Stack optimization for common case: `buf[512]` stack buffer handles strings ≤ 512 chars → zero heap allocation. Only strings >512 chars trigger `malloc()`. This pattern mirrors `Class.forName0`'s `buf[128]` stack buffer for class names.

### 1.4 Class Caching — JNU_ClassClass + global jclass references (jni_util.c:1011-1073)

Four cached jclass singletons, each following identical lazy-init pattern:

```c
JNIEXPORT jclass JNICALL
JNU_ClassClass(JNIEnv *env)
{
    static jclass cls = 0;
    if (cls == 0) {
        jclass c;
        if ((*env)->EnsureLocalCapacity(env, 1) < 0)
            return 0;
        c = (*env)->FindClass(env, "java/lang/Class");
        CHECK_NULL_RETURN(c, NULL);
        cls = (*env)->NewGlobalRef(env, c);
        (*env)->DeleteLocalRef(env, c);
    }
    return cls;
}
```

Key design properties:
1. **`static jclass cls`**: C static variable — persists across calls, initialized to 0
2. **`NewGlobalRef`**: Promotes the local jclass reference to a GC root → GC never collects it
3. **`DeleteLocalRef`**: Frees the local reference (JNI local refs auto-expire after native method returns, but explicit deletion prevents leak in long-running native code)
4. **Check-then-act**: Not thread-safe if multiple threads call concurrently the first time → but jclass is immutable → `NewGlobalRef` is idempotent → worst case: leak one extra global ref → acceptable (cold path only)

The four cached classes:

| Function | Cached Class | Line |
|---|---|---|
| `JNU_ClassString(env)` | `java.lang.String` | jni_util.c:1012 |
| `JNU_ClassClass(env)` | `java.lang.Class` | jni_util.c:1028 |
| `JNU_ClassObject(env)` | `java.lang.Object` | jni_util.c:1044 |
| `JNU_ClassThrowable(env)` | `java.lang.Throwable` | jni_util.c:1060 |

> **Beginner Callout 3 — Global jclass caching**: `jni_util.c` defines `JNU_ClassString`, `JNU_ClassClass`, `JNU_ClassObject`, `JNU_ClassThrowable` — these return `static jclass` global references initialized once (lazy singleton). Each uses `(*env)->NewGlobalRef(env, localClass)` to prevent the GC from collecting the class object. Without global refs, the cached `jclass` would become a dangling pointer after GC → undefined behavior on next use. Source: jni_util.c:1011-1073.

**Why caching matters — FindClass cost**: `FindClass("java/lang/Class")` requires: UTF-8 string hash → `ConcurrentHashTable` lookup in system dictionary → lock acquisition on dictionary → ~200ns in warm cache (cold path ~1µs). If every JNI method call needs `FindClass` → +200ns per native call. Cached global ref → ~2ns (return static pointer). **100x faster**.

**Counterfactual: 如果每次调用都 FindClass 而不缓存？**
ThreadLocal Get/Set static field → each `FindClass("java/lang/Thread")` + `GetStaticFieldID("currentThread")` → 2 FindClass calls (400ns) + 2 GetStaticFieldID (200ns) = 600ns per native call → for a 10 million req/s server with 20 native calls per request = 200M FindClass calls/s → 120ms/s CPU overhead → 12% CPU waste on repeated FindClass. `JNU_Class*` caching drops this from O(FindClass) to O(pointer dereference) → ~2ns per call.

### 1.5 Method Invocation — JNU_CallMethodByName / JNU_CallMethodByNameV (jni_util.c:323-413)

`JNU_CallMethodByName` is C's answer to Java reflection — call any Java method by name from native code:

```c
JNIEXPORT jvalue JNICALL
JNU_CallMethodByName(JNIEnv *env,
                     jboolean *hasException,
                     jobject obj,
                     const char *name,
                     const char *signature,
                     ...)
{
    jvalue result;
    va_list args;
    va_start(args, signature);
    result = JNU_CallMethodByNameV(env, hasException, obj, name, signature, args);
    va_end(args);
    return result;
}
```

The real work is in `JNU_CallMethodByNameV` (jni_util.c:344-413):

```c
JNIEXPORT jvalue JNICALL
JNU_CallMethodByNameV(JNIEnv *env, jboolean *hasException,
                       jobject obj, const char *name,
                       const char *signature, va_list args)
{
    jclass clazz;
    jmethodID mid;
    jvalue result;
    const char *p = signature;
    while (*p && *p != ')') p++;  // skip past parameter types
    p++;                           // point to return type char
    clazz = (*env)->GetObjectClass(env, obj);
    mid = (*env)->GetMethodID(env, clazz, name, signature);
    if (mid == 0) goto done1;
    switch (*p) {
    case 'V': (*env)->CallVoidMethodV(env, obj, mid, args); break;
    case '[': case 'L':
        result.l = (*env)->CallObjectMethodV(env, obj, mid, args); break;
    case 'Z': result.z = (*env)->CallBooleanMethodV(env, obj, mid, args); break;
    case 'B': result.b = (*env)->CallByteMethodV(env, obj, mid, args); break;
    case 'C': result.c = (*env)->CallCharMethodV(env, obj, mid, args); break;
    case 'S': result.s = (*env)->CallShortMethodV(env, obj, mid, args); break;
    case 'I': result.i = (*env)->CallIntMethodV(env, obj, mid, args); break;
    case 'J': result.j = (*env)->CallLongMethodV(env, obj, mid, args); break;
    case 'F': result.f = (*env)->CallFloatMethodV(env, obj, mid, args); break;
    case 'D': result.d = (*env)->CallDoubleMethodV(env, obj, mid, args); break;
    default:
        (*env)->FatalError(env, "JNU_CallMethodByNameV: illegal signature");
    }
done1:
    (*env)->DeleteLocalRef(env, clazz);
done2:
    if (hasException) {
        *hasException = (*env)->ExceptionCheck(env);
    }
    return result;
}
```

Dispatch logic:
1. Parse return type from signature: skip past `(...)` → first char after `)` is return type
2. `GetObjectClass(obj)` → get the receiver's jclass
3. `GetMethodID(env, clazz, name, signature)` → resolve method by name + JVM signature
4. Switch on return type char → dispatch to correct `Call##Type##MethodV`
5. Report exceptions via `hasException` flag → `ExceptionCheck(env)` after call

> **Beginner Callout 4 — JNU_CallMethodByName**: Calls a Java method from C by name — finds the method at runtime via `FindClass` + `GetMethodID`. This is C's answer to Java reflection — it enables native code to invoke arbitrary Java methods without compile-time binding. The `V` variant (`JNU_CallMethodByNameV`) takes a `va_list` for variable arguments — one helper covers all possible method signatures from `()V` to `(Ljava/lang/String;I)J`. Source: jni_util.c:323-413.

**Why is the signature parameter required?** JNI method dispatch must provide the JVM method signature (e.g. `"(Ljava/lang/String;I)V"`) because Java method overloading requires param count + types to disambiguate methods. C's `va_list` has no type information (just contiguous bytes) → JNI internally has no way to know how many args are on the stack or each arg's type. The signature is the description → JNI reads correct args from `va_list` based on the signature and marshals them to the JNI call.

**Counterfactual: 如果 native 代码不使用 JNU_CallMethodByName 而是手动 JNI？**
Manual JNI: `FindClass` + `GetMethodID` + `CallVoidMethodA` + error checking. 4 JNI calls vs 1 `JNU_CallMethodByName`. Code quantity: 8 lines (manual) vs 1 line (JNU). 100+ native methods → from 800 lines to 100 lines. Not just code savings — unified error handling (if `GetMethodID` fails → exception set → `hasException` flag) → caller doesn't need to separately check each `GetMethodID` return.

### 1.6 Object Construction — JNU_NewObjectByName (jni_util.c:415-444)

```c
JNIEXPORT jobject JNICALL
JNU_NewObjectByName(JNIEnv *env, const char *class_name,
                    const char *constructor_sig, ...)
{
    jobject obj = NULL;
    jclass cls = 0;
    jmethodID cls_initMID;
    va_list args;
    if ((*env)->EnsureLocalCapacity(env, 2) < 0) goto done;
    cls = (*env)->FindClass(env, class_name);
    if (cls == 0) goto done;
    cls_initMID = (*env)->GetMethodID(env, cls, "<init>", constructor_sig);
    if (cls_initMID == NULL) goto done;
    va_start(args, constructor_sig);
    obj = (*env)->NewObjectV(env, cls, cls_initMID, args);
    va_end(args);
done:
    (*env)->DeleteLocalRef(env, cls);
    return obj;
}
```

Class name string → `FindClass` → `GetMethodID("<init>")` → `NewObjectV`. Used for constructing Java objects from native code — the constructor signature follows the same JVM descriptor format as method signatures.

### 1.7 JNU_Equals — cached jmethodID string comparison (jni_util.c:1113-1125)

```c
JNIEXPORT jboolean JNICALL
JNU_Equals(JNIEnv *env, jobject object1, jobject object2)
{
    static jmethodID mid = NULL;
    if (mid == NULL) {
        jclass objClazz = JNU_ClassObject(env);
        CHECK_NULL_RETURN(objClazz, JNI_FALSE);
        mid = (*env)->GetMethodID(env, objClazz, "equals",
                                  "(Ljava/lang/Object;)Z");
        CHECK_NULL_RETURN(mid, JNI_FALSE);
    }
    return (*env)->CallBooleanMethod(env, object1, mid, object2);
}
```

Key details:
- Calls `String.equals(Object)` not `String.equals(String)` — because JNI `GetMethodID` resolves by JVM signature. `Object.equals(Object)` is the signature; `String.equals(Object)` overrides it but the method ID lookup uses `Object`'s signature.
- `static jmethodID` — globally cached (class loading doesn't change → method ID is stable across GC)
- `JNU_ClassObject` cached jclass → zero FindClass overhead per comparison

> **Beginner Callout 5 — JNU_Equals**: Compares two Java strings from native code using `(*env)->CallBooleanMethod(env, str1, equals_mid, str2)`. The `equals_mid` (Method ID for `Object.equals(Object)`) is cached as a global method ID — avoids `GetMethodID("equals", "(Ljava/lang/Object;)Z")` per comparison. Source: jni_util.c:1113-1125.

**Why call Java equals instead of C strcmp?** Java's `String.equals` checks: (a) reference equality (== cost ~1ns), (b) is String instance (return false otherwise), (c) length equality, (d) byte-by-byte comparison of content. Replicating this in C: (a) get two UTF-8 strings → 2 JNI `GetStringUTFChars` calls → 2 memory allocations → `strcmp` → 2 `ReleaseStringUTFChars` → 2 free. `JNU_Equals`: 1 JNI `CallBooleanMethod` → internally compares on Java heap (byte[] direct access) → 0 native memory allocation → ~2x faster for typical strings.

### 1.8 Additional Utilities — CopyObjectArray, GetEnv, IsInstanceOfByName (jni_util.c:1075-1111)

```c
JNIEXPORT jint JNICALL
JNU_CopyObjectArray(JNIEnv *env, jobjectArray dst, jobjectArray src, jint count)
{
    int i;
    if ((*env)->EnsureLocalCapacity(env, 1) < 0) return -1;
    for (i=0; i<count; i++) {
        jstring p = (*env)->GetObjectArrayElement(env, src, i);
        (*env)->SetObjectArrayElement(env, dst, i, p);
        (*env)->DeleteLocalRef(env, p);
    }
    return 0;
}
```

Element-by-element Object[] copy with local reference cleanup — prevents JNI local reference table overflow when copying large arrays. Without `DeleteLocalRef` in the loop → each `GetObjectArrayElement` creates a local ref → after 65535 elements → JNI local reference table overflows → `JNI ERROR (app bug): local reference table overflow`.

### 1.9 ★ Mermaid: JNU utility call graph

```
┌────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐  ┌──────────────────┐
│  Native Methods    │  │  JNU Utility Layer  │  │  JNI API        │  │  Java Exception  │
│  (System.c, etc.)  │  │  (jni_util.c)       │  │                 │  │                  │
└────────┬───────────┘  └──────────┬──────────┘  └────────┬────────┘  └────────┬─────────┘
         │                         │                      │                    │
  ┌──────┼────────────────────┐    │                      │                    │
  │      │                    │    │                      │                    │
  │ System.c: each native     │    │                      │                    │
  │ method entry has          │    │                      │                    │
  │ null check →              │    │                      │                    │
  │ JNU_ThrowNullPointer      │    │                      │                    │
  │ Exception(env, msg)  ─────┼───►│                      │                    │
  │                            │    │ jni_util.c:56        │                    │
  │                            │    │ → JNU_ThrowByName    │                    │
  │                            │    │   (env, "java/lang/  │                    │
  │                            │    │    NullPointer..."   │                    │
  │                            │    │   , msg)             │                    │
  │                            │    │─────────────────────►│                    │
  │                            │    │                      │ FindClass(NPE)     │
  │                            │    │                      │ ThrowNew(cls, msg) │
  │                            │    │                      │───────────────────────►
  │                            │    │                      │                    │ NPE created
  │                            │    │                      │                    │ in thread
  │                            │    │                      │                    │
  │ Class.c: jstring → C str   │    │                      │                    │
  │ JNU_GetStringPlatform      │    │                      │                    │
  │ Chars(env, jstr, &isCopy) ─┼───►│                      │                    │
  │                            │    │ jni_util.c:970       │                    │
  │                            │    │ fastEncoding check:  │                    │
  │                            │    │ ┌─ FAST_UTF_8    ───┼──► GetStringUTFChars│
  │                            │    │ ├─ FAST_8859_1   ───┼──► GetStringCritical│
  │                            │    │ ├─ FAST_646_US   ───┼──► ASCII copy       │
  │                            │    │ ├─ FAST_CP1252   ───┼──► Cp1252 mapping   │
  │                            │    │ └─ else         ────┼──► getStringBytes   │
  │                            │    │ return char*         │                    │
  │◄───────────────────────────┼────┘                     │                    │
  │                            │                          │                    │
  │ Init: lazy jclass cache    │                          │                    │
  │ JNU_ClassClass(env)   ─────┼──►                       │                    │
  │                            │    jni_util.c:1028       │                    │
  │                            │    static jclass cls = 0 │                    │
  │                            │    if (!cls) {           │                    │
  │                            │      FindClass ──────────┼──► ClassDictionary  │
  │                            │      NewGlobalRef(c)     │                    │
  │                            │    }                     │                    │
  │                            │    return cached cls     │                    │
  │◄───────────────────────────┼────                      │                    │
  │                            │                          │                    │
  │ Property init: call Java   │                          │                    │
  │ JNU_CallMethodByName       │                          │                    │
  │ (env, &ex, obj,            │                          │                    │
  │  "setProperty",            │                          │                    │
  │  "(Ljava/lang/String;      │                          │                    │
  │    Ljava/lang/String;)V",  │                          │                    │
  │  key, val)  ───────────────┼──►                       │                    │
  │                            │    jni_util.c:324-413    │                    │
  │                            │    GetObjectClass ───────┼──► jclass           │
  │                            │    GetMethodID ──────────┼──► jmethodID        │
  │                            │    switch(retType)       │                    │
  │                            │      CallVoidMethodV ────┼──► Java method      │
  │                            │    hasException check    │                    │
  │◄───────────────────────────┼────                      │                    │
```

---

### 1.10 ★ 面试 Story Format 答案

"Every libjava native method uses `JNU_*` utility functions from `jni_util.c`. This 1506-line C file provides 4 categories of helpers: (1) **exception helpers** — `JNU_ThrowNullPointerException(env, msg)` throws a proper Java NPE with message; `JNU_ThrowByName(env, "...", msg)` throws any of 16 exception types by string name (saving each native method from calling `FindClass` + `ThrowNew` manually). (2) **string conversion** — `JNU_GetStringPlatformChars(env, jstr, &isCopy)` converts a jstring to a platform C string with 4 encoding fast paths (UTF-8, ISO-8859-1, US-ASCII, Cp1252); `JNU_NewStringPlatform(env, cstr)` does the reverse. (3) **class caching** — `JNU_ClassString(env)`, `JNU_ClassClass(env)` etc. return global-referenced cached jclass objects → every native method avoids the cost of `FindClass("java/lang/String")` per call (~200ns per FindClass). (4) **method invocation** — `JNU_CallMethodByName(env, obj, "methodName", "()V", args...)` uses variable-argument JNI dispatch for calling Java methods from native — the `va_list` version handles the JNI method resolution and call with one helper. Together, these utilities eliminate ~300 lines of boilerplate per native file and ensure consistent null-checking, error handling, and encoding conversion across all 100+ native methods in libjava.so."

---

## §二 Standard Environment + Source Files

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/share/native/libjava/jni_util.c` — 1506 lines, 20+ JNU utility functions
- `src/java.base/share/native/libjava/jni_util.h` — JNU_ function declarations + macros
- All native caller files: System.c, Object.c, Class.c, Runtime.c, Throwable.c, etc.

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjava.so` — jni_util.c linked into every libjava native file

### Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **jni_util.c** | `src/java.base/share/native/libjava/jni_util.c` | 1506 | `JNU_ThrowNullPointerException`(:56), `JNU_ThrowByName`(:44, 16 exception types), `JNU_GetStringPlatformChars`(:970), `JNU_NewStringPlatform`(:475), `JNU_NewObjectByName`(:416), `JNU_ClassString`(:1012), `JNU_ClassClass`(:1028), `JNU_CallMethodByName`(:324), `JNU_CallMethodByNameV`(:344), `JNU_Equals`(:1114), `JNU_CopyObjectArray`(:1076), `JNU_GetEnv`(:1091) | Shared JNI utility layer — used by every libjava native file |
| 2 | **jni_util.h** | `src/java.base/share/native/libjava/jni_util.h` | ~200 | JNU_ function decls, encoding init constants | Header — declarations + encoding constants |

---

## §三 Exception Safety + Encoding Correctness

### 3.1 Exception Overwrite Protection

`JNU_ThrowByName` at jni_util.c:44-51 checks `if (cls != 0)` before calling `ThrowNew`. This is NOT a null check on the exception class — it's an "exception already pending" check. When JNI `FindClass` fails, it sets a pending exception (e.g. `NoClassDefFoundError`). If `ThrowNew` were called regardless → the second exception overwrites the first → the original root cause (`NoClassDefFoundError`) is lost, replaced by a misleading secondary exception. The `if (cls != 0)` check preserves the first exception — the most relevant diagnostic information.

### 3.2 Encoding Initialization — InitializeEncoding

At libjava.so load time, `InitializeEncoding` is called. It queries the platform encoding via `nl_langinfo(CODESET)`:

```
echo $LANG
# en_US.UTF-8  → fastEncoding = FAST_UTF_8
# en_US.ISO-8859-1 → fastEncoding = FAST_8859_1
# C / POSIX → fastEncoding = FAST_646_US
```

If `$LANG` is unset or unrecognized → `fastEncoding` remains at `NO_ENCODING_YET` → `JNU_GetStringPlatformChars` raises `InternalError` → prevents silent encoding corruption with wrong encoding assumptions.

### 3.3 Fast Path vs Generic Encoding Performance

| Operation | Fast Path (UTF-8) | Generic Path (iconv) | Ratio |
|---|---|---|---|
| 100-byte ASCII string | ~150ns (GetStringUTFChars) | ~1500ns (GetStringChars + iconv) | 10x |
| 100-byte non-ASCII (CJK) | ~300ns (modified-UTF-8 expansion) | ~1500ns (GetStringChars + iconv) | 5x |
| 1000-byte string | ~500ns (GetStringUTFChars) | ~10000ns (GetStringChars + iconv) | 20x |

The generic path must: (a) call `GetStringChars` → get UTF-16, (b) determine target encoding from locale, (c) convert each 16-bit char through encoding conversion table → stack-allocate or malloc output buffer. The fast path avoids steps (b) and (c) — JNI `GetStringUTFChars` directly provides the platform-encoded bytes.

### 3.4 GlobalRef Lifecycle: Why LocalRef → GlobalRef → DeleteLocalRef

```
Step 1: jclass localCls = FindClass("java/lang/String");    // local ref
Step 2: cls = NewGlobalRef(env, localCls);                   // global ref (GC root)
Step 3: DeleteLocalRef(env, localCls);                       // free local ref slot
```

Local refs are automatically freed when the native method returns — BUT `static jclass cls` persists across calls. If only `cls = localCls` (without `NewGlobalRef`) → the local ref is collected when the first `JNU_ClassString()` call returns → `cls` becomes a dangling pointer → next call dereferences freed memory → SIGSEGV. `NewGlobalRef` makes the reference a GC root → the class object is never collected → `cls` is safe to use indefinitely. `DeleteLocalRef` frees the now-unnecessary local ref slot — in a long JNI call chain, local ref table has limited capacity (~65535 entries) → leaking local refs eventually causes overflow.

---

## §四 Deep-Dive Question Groups

### 4.1 ★★★ JNU_ThrowNullPointerException — standardized NPE

**Q: jni_util.c:56 的 JNU_ThrowNullPointerException 如何抛出异常？**

`jni_util.c:55-59`:

```c
JNIEXPORT void JNICALL
JNU_ThrowNullPointerException(JNIEnv *env, const char *msg)
{
    JNU_ThrowByName(env, "java/lang/NullPointerException", msg);
}
```

Delegates to `JNU_ThrowByName` at jni_util.c:44-51:

```c
JNIEXPORT void JNICALL
JNU_ThrowByName(JNIEnv *env, const char *name, const char *msg)
{
    jclass cls = (*env)->FindClass(env, name);
    if (cls != 0) /* Otherwise an exception has already been thrown */
        (*env)->ThrowNew(env, cls, msg);
}
```

Three-step operation:
1. Check: is there already a pending exception? → If `FindClass` failed, `cls == 0` → skip ThrowNew (preserves original exception)
2. FindClass: lookup NPE class → returns NULL if class can't be loaded (extremely rare but theoretically possible)
3. ThrowNew: create new NPE with message → store in thread's exception state

**追问: 为什么用 FindClass 查找 NPE 类而非缓存？**
This uses `FindClass` rather than a cached global ref like `JNU_ClassNullPointerException`. This is actually a performance quirk — each throw calls `FindClass`. Production code could call `JNU_ThrowNullPointerException` billions of times → 200ns/FindClass × 1B = 200s CPU waste. But hot-path null checks are handled at JVM level (`JVM_ENTRY`), not via JNU → FindClass overhead is confined to cold code paths.

**Counterfactual: 如果 native 方法不调用 JNU_ThrowNullPointerException 而直接 exit(-1)？**
Direct C-level `abort()` → JVM has no chance to process exception → no Java stack trace → no `finally` block execution → resource leaks (file handles, connections not closed). Java users never know a null parameter caused the crash → only see hs_err log → need native debugger to diagnose. `JNU_ThrowNullPointerException` ensures: Java's try-catch can catch the exception → Java-layer error handling works normally → user sees familiar NPE stack trace. → 00-System-Arraycopy: System.c uses JNU_ThrowNullPointerException for null checks.

---

### 4.2 ★★★ JNU_ThrowByName — 16 exception types

**Q: JNU_ThrowByName 如何支持 16 种异常类型？**

`jni_util.c:44-51` — `JNU_ThrowByName(env, "java/lang/ExceptionClassName", msg)` — same pattern as `JNU_ThrowNullPointerException`, but exception class name is a parameter. Supported exception types:

```
java/lang/NullPointerException
java/lang/ArrayIndexOutOfBoundsException
java/lang/OutOfMemoryError
java/lang/IllegalArgumentException
java/lang/IllegalAccessError
java/lang/IllegalAccessException
java/lang/InternalError
java/lang/NoSuchFieldException
java/lang/NoSuchMethodException
java/lang/ClassNotFoundException
java/lang/NumberFormatException
java/io/IOException
java/lang/NoSuchFieldError
java/lang/NoSuchMethodError
java/lang/StringIndexOutOfBoundsException
java/lang/InstantiationException
```

Each has a convenience wrapper (jni_util.c:55-149). `JNU_ThrowByName` is the general mechanism; `JNU_Throw{Type}` macros are convenience wrappers.

**追问: 为什么不每个异常类型单独一个函数 (JNU_ThrowIOException, JNU_ThrowSecurityException)?**
There ARE per-type convenience wrappers: `JNU_ThrowIOException(env, msg)` is a macro → `JNU_ThrowByName(env, "java/io/IOException", msg)`. So there are two layers: (a) `JNU_ThrowByName` is the general mechanism, (b) `JNU_Throw{Type}` are convenience macros. Any new exception type can be thrown via `ThrowByName` without modifying jni_util.c code.

**Counterfactual: 如果不统一异常处理 → 每个 native 方法手工构造异常？**
100+ native methods in libjava.so → each has at least 2 null checks → 200 manual `FindClass` + `ThrowNew` patterns → each different (misspellings: "NullPointerExcpetion", different messages: "key is null" vs "key == null" vs "NULL key parameter") → troubleshooting production errors impossible via grep → diagnostic cost 10x. JNU utility standardizes: (a) class name spelling, (b) message format, (c) exception hierarchy.

---

### 4.3 ★★★ JNU_GetStringPlatformChars — encoding fast path

**Q: JNU_GetStringPlatformChars (jni_util.c:970) 的 4 种编码快路径是什么？**

Based on `fastEncoding` global variable value (set during `InitializeEncoding`):

1. **UTF-8** (most common): `getStringUTF8` — JNI returns modified-UTF-8 → encoding compatible with standard UTF-8 for ASCII
2. **ISO-8859-1** (Western European): `getString8859_1Chars` — 8-bit per character, no multi-byte (fast)
3. **US-ASCII / 646-US**: Shares ASCII subset with ISO-8859-1 path
4. **Cp1252** (Windows Western European): Special path — needs manual mapping of 0x80-0x9F codepoints

If platform encoding is not among the 4 fast paths → generic `getStringBytes(env, jstr)` → `GetStringChars` returns UTF-16 → manual conversion to platform encoding via iconv-equivalent logic (slow path, ~10x slower).

**追问: 为什么有 4 种快路径 — 为什么不用单一编码 (UTF-8)？**
Platform encoding is NOT under JVM control. `nl_langinfo(CODESET)` returns Linux locale setting: `$LANG=en_US.ISO-8859-1` → `JNU_Encoding = ISO-8859-1`. JVM cannot force all systems to use UTF-8 — violates POSIX locale specification. Fast paths exist because JVM encounters these 4 encodings in the vast majority of calls — covering 99%+ Linux systems (UTF-8 or US-ASCII).

**Counterfactual: 如果只用 Unicode (UTF-16) 到平台编码的转换 (无快路径)？**
Java internal is UTF-16 → platform encoding conversion requires O(n) checking each char → determine if it can encode as 1 byte → check surrogate pairs → generate multi-byte sequence. `GetStringUTFChars`: JNI directly accesses Java string's `byte[]` from native layer → if ASCII-only → already UTF-8 compatible → zero conversion. Fast path is 5-10x faster than generic conversion. For encoding-intensive operations (e.g. file I/O with native codec) → fast path benefit is significant. → 09-native-interface for JNI string conversion functions.

---

### 4.4 ★★★ JNU_ClassClass — global cached jclass

**Q: JNU_ClassClass (jni_util.c:1028) 如何缓存 jclass？**

`jni_util.c:1028-1041`:

```c
JNIEXPORT jclass JNICALL
JNU_ClassClass(JNIEnv *env)
{
    static jclass cls = 0;
    if (cls == 0) {
        jclass c;
        if ((*env)->EnsureLocalCapacity(env, 1) < 0)
            return 0;
        c = (*env)->FindClass(env, "java/lang/Class");
        CHECK_NULL_RETURN(c, NULL);
        cls = (*env)->NewGlobalRef(env, c);
        (*env)->DeleteLocalRef(env, c);
    }
    return cls;
}
```

Key design:
1. `static jclass` → persists across calls (C static)
2. `NewGlobalRef` → GC won't collect cached jclass (global ref is GC root)
3. `DeleteLocalRef` → frees local ref (JNI function returns, local ref becomes invalid → memory leak)
4. Check-then-act → thread-unsafe if multiple threads call concurrently for first time → but jclass is immutable → `NewGlobalRef` is idempotent → may leak one extra global ref → acceptable (cold path)

**追问: 为什么缓存 jclass 如此重要 — FindClass 有多贵？**
`FindClass("java/lang/Class")` requires: UTF-8 string hash → `ConcurrentHashTable` lookup in system dictionary → lock acquisition on dictionary → ~200ns in warm cache (cold path ~1µs). If each JNI method call needs `FindClass` → +200ns per native call. Cached global ref → ~2ns (return static pointer). **100x faster**.

**Counterfactual: 如果每次调用都 FindClass 而不缓存？**
ThreadLocal Get/Set static field → each `FindClass("java/lang/Thread")` + `GetStaticFieldID("currentThread")` → 2 FindClass calls 400ns + 2 GetStaticFieldID 200ns = 600ns per native call → for a 10 million req/s server with 20 native calls per request = 200M FindClass calls/s → 120ms/s CPU overhead → 12% CPU waste on repeated FindClass. `JNU_Class*` caching drops this from O(FindClass) to O(pointer dereference) → ~2ns per call.

---

### 4.5 ★★★ JNU_CallMethodByName — variable-argument JNI dispatch

**Q: JNU_CallMethodByName (jni_util.c:324) 如何实现可变参数方法调用？**

`jni_util.c:324-340`:

```c
JNIEXPORT jvalue JNICALL
JNU_CallMethodByName(JNIEnv *env, jboolean *hasException,
                     jobject obj, const char *name,
                     const char *signature, ...)
{
    jvalue result;
    va_list args;
    va_start(args, signature);
    result = JNU_CallMethodByNameV(env, hasException, obj,
                                   name, signature, args);
    va_end(args);
    return result;
}
```

Internally delegates to `JNU_CallMethodByNameV` (jni_util.c:344-413) with va_list:
1. `GetObjectClass(env, obj)` → get obj's jclass
2. `GetMethodID(env, cls, name, signature)` → find method by name + signature
3. If method not found → record exception → return NULL
4. If found → `Call##TYPE##MethodA` (dispatch by return type):
   - `CallVoidMethodV`, `CallObjectMethodV`, `CallBooleanMethodV`, `CallIntMethodV`, ...
   - Return type determined by `signature[return_type_offset]` first character ('V', 'L', 'Z', 'I', 'J', 'F', 'D', etc.)

**追问: 为什么需要 signature 参数 — 不能用 C 的 _Generic?**
JNI method dispatch MUST provide JVM method signature (e.g. `"(Ljava/lang/String;I)V"`) because Java method overloading requires param count + types to disambiguate methods. C's `va_list` has no type information (only contiguous bytes) → JNI internally doesn't know how many args on stack or each arg's type. The signature is the description → JNI reads correct args from `va_list` based on signature and marshals them to JNI call.

**Counterfactual: 如果 native 代码不使用 JNU_CallMethodByName 而是手动 JNI？**
Manual JNI: `FindClass` + `GetMethodID` + `CallVoidMethodA` + error checking. 4 JNI calls vs 1 `JNU_CallMethodByName`. Code: 8 lines (manual) vs 1 line (JNU). 100+ native methods → from 800 lines to 100 lines. Not just code savings — unified error handling (if `GetMethodID` fails → exception set → `hasException` flag set) → caller doesn't need separate checks. → 01-Class-String: Class.c uses JNU_CallMethodByName for Java method calls from native.

---

### 4.6 ★★★ JNU_Equals — memory-efficient native string comparison

**Q: JNU_Equals (jni_util.c:1114) 如何比较两个 Java 字符串？**

`jni_util.c:1114-1125`:

```c
JNIEXPORT jboolean JNICALL
JNU_Equals(JNIEnv *env, jobject object1, jobject object2)
{
    static jmethodID mid = NULL;
    if (mid == NULL) {
        jclass objClazz = JNU_ClassObject(env);
        CHECK_NULL_RETURN(objClazz, JNI_FALSE);
        mid = (*env)->GetMethodID(env, objClazz, "equals",
                                  "(Ljava/lang/Object;)Z");
        CHECK_NULL_RETURN(mid, JNI_FALSE);
    }
    return (*env)->CallBooleanMethod(env, object1, mid, object2);
}
```

Key details:
- Calls `Object.equals(Object)` — JNI signature uses `Object` as parameter type because it's `Object.equals` that `String.equals` overrides
- `static jmethodID` — globally cached (class loading doesn't change → method ID is stable)
- `JNU_ClassObject` cached jclass → zero FindClass overhead

**追问: 为什么不在 C 层比较字符串 (strcmp on native bytes) 而调用 Java equals?**
Java's `String.equals` checks: (a) reference equality (== cost ~1ns), (b) is String instance (return false otherwise), (c) length equality, (d) byte-by-byte comparison of content. Replicating this in C: (a) get two UTF-8 strings → 2 JNI `GetStringUTFChars` calls → 2 memory allocations → `strcmp` → 2 `ReleaseStringUTFChars` → 2 free. `JNU_Equals`: 1 JNI `CallBooleanMethod` → internally compares on Java heap (byte[] direct access) → 0 native memory allocation → ~2x faster for typical strings.

---

## §五 GDB Verification — 4 断点完整 JNU utility trace

### 断言 1: JNU_ThrowNullPointerException (jni_util.c:56)

```gdb
(gdb) break jni_util.c:56
(gdb) run
# 触发 native 方法传入 null 参数
(gdb) print msg                            # 期望: "key is null" 或类似消息
(gdb) print (*env)->ExceptionOccurred(env) # 期望: NULL (no pending exception)
(gdb) continue
(gdb) print (*env)->ExceptionOccurred(env) # 期望: non-NULL (NPE created)
```

### 断言 2: JNU_GetStringPlatformChars encoding fast path (jni_util.c:970)

```gdb
(gdb) break jni_util.c:970
(gdb) run
(gdb) print fastEncoding                  # 期望: FAST_UTF_8, FAST_8859_1, FAST_646_US, or FAST_CP1252
(gdb) continue                            # 进入对应的 fast path
(gdb) print jstr                          # 期望: 有效的 jstring
(gdb) print result                        # 期望: C string (NULL if failed → Java exception pending)
```

### 断言 3: JNU_ClassClass cached jclass (jni_util.c:1028)

```gdb
(gdb) break jni_util.c:1028
(gdb) run
(gdb) print cls                           # 期望: 0 (first call) 或 non-NULL (cached)
(gdb) continue                            # 跳过 FindClass + NewGlobalRef
(gdb) print cls                           # 期望: non-NULL jclass (cached global ref)
(gdb) continue                            # 第二次调用
(gdb) print cls                           # 期望: 与第一次相同地址 (cached)
```

### 断言 4: JNU_CallMethodByName (jni_util.c:324)

```gdb
(gdb) break jni_util.c:324
(gdb) run
(gdb) print name                          # 期望: 方法名 (例如 "toString", "setProperty")
(gdb) print signature                     # 期望: 方法签名 (例如 "()Ljava/lang/String;")
(gdb) print obj                           # 期望: 有效的 jobject (receiver)
(gdb) continue                            # 进入 JNU_CallMethodByNameV
(gdb) print mid                           # 期望: method ID (non-NULL)
(gdb) continue
(gdb) print result                        # 期望: 方法返回值 (type depends on signature)
```

---

## §六 ★ 面试问答 (Interview Q&A)

### Q10: "Why does every libjava native method use JNU_* utilities?"

Every native method in `libjava.so` uses `JNU_*` functions from `jni_util.c` (1506 lines, the most-reused C file in the JDK library). Five categories: (1) **Exception helpers** — `JNU_ThrowNullPointerException` and `JNU_ThrowByName` (16 exception types) standardize exception throwing across 100+ native methods, replacing manual `FindClass` + `ThrowNew` boilerplate. (2) **String conversion** — `JNU_GetStringPlatformChars` provides 4 encoding fast paths (UTF-8, ISO-8859-1, US-ASCII, Cp1252) based on platform locale, avoiding generic iconv overhead (5-10x slower). (3) **Class caching** — `JNU_ClassString`, `JNU_ClassClass`, `JNU_ClassObject`, `JNU_ClassThrowable` use `static jclass` global references (via `NewGlobalRef`) to avoid `FindClass` per call (~200ns → ~2ns). (4) **Method invocation** — `JNU_CallMethodByName`/`V` wraps `GetObjectClass` + `GetMethodID` + `Call##Type##MethodV` with return-type dispatch into one variable-argument call. (5) **Field access** — `JNU_GetFieldByName`, `JNU_SetFieldByName` encapsulate `GetFieldID` + `Get/Set##Type##Field` with signature-based dispatch. Without JNU, each native method would replicate these patterns — 3-5x code bloat, inconsistent error handling, and the risk of silent SIGSEGV from missed null checks.

### Q11: "How does JNU_ThrowNullPointerException prevent native crashes?"

`jni_util.c:56` calls `JNU_ThrowByName(env, "java/lang/NullPointerException", msg)` which at jni_util.c:44-51 uses `FindClass` + `ThrowNew`. The critical safety mechanism: `if (cls != 0)` check before `ThrowNew` — if `FindClass` itself failed (setting a pending `NoClassDefFoundError`), the original exception is preserved rather than overwritten. Without JNU, a native method receiving a NULL `jstring` and calling raw `GetStringUTFChars(env, NULL, &isCopy)` → dereferences NULL oop → SIGSEGV → hs_err log with cryptic `V [libjava.so+0x...]` native frame. No Java exception, no stack trace, no `finally` block execution. JNU converts this crash into a proper Java `NullPointerException` that surfaces in Java's exception handling — try-catch works, stack trace is meaningful, `finally` blocks execute.

### Q12: "Why cache jclass with NewGlobalRef instead of just a static pointer?"

`jni_util.c:1028-1041` uses the pattern: `static jclass cls = 0; if (!cls) { localCls = FindClass(...); cls = NewGlobalRef(env, localCls); DeleteLocalRef(env, localCls); }`. `FindClass` returns a **local reference** — automatically freed when the native method returns. If `cls = localCls` without `NewGlobalRef` → the local ref is collected when `JNU_ClassClass()` returns → `cls` becomes a dangling pointer → next call dereferences freed memory → SIGSEGV. `NewGlobalRef` promotes the reference to a **GC root** — the class object is never collected regardless of how many GC cycles occur. `DeleteLocalRef` frees the now-unnecessary local ref slot — local ref tables have fixed capacity (~65535 entries per JNI invocation) → leaking local refs in long JNI chains eventually causes overflow. The lazy-init check (`if (!cls)`) is technically thread-unsafe for the first call, but `NewGlobalRef` is idempotent — worst case is leaking one extra global ref on the cold path (acceptable).

---

> **Cross-Reference Map**
> - **09-native-interface**: JNI API calls used by all JNU_* helpers — ThrowNew, FindClass, GetStringUTFChars, GetMethodID, NewGlobalRef
> - **00-System-Arraycopy**: System.c uses `JNU_ThrowNullPointerException` at null checks
> - **01-Class-String**: Class.c uses `JNU_CallMethodByName` for Java method calls from native, `JNU_ThrowClassNotFoundException`
> - **02-Runtime-Throwable**: Runtime.c + Throwable.c use `JNU_ThrowNullPointerException` for parameter validation
