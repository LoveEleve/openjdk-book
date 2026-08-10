# Core Native (libjava.so) — 第一遍产出

> vol-06 · 域 41 · 🟡 B | Pass 0+1 扫描完成
> 源码：`java.base/share/native/libjava/` 40+文件 + `unix/native/libjava/`

## 继承/调用结构

```
Java 层 native 方法声明 (@HotSpotIntrinsicCandidate)
  │
  ▼
libjava.so (JDK side — thin C wrappers)
  ├── System.c:54  Java_java_lang_System_identityHashCode  → JVM_IHashCode
  ├── System.c:47  Java_java_lang_System_registerNatives
  ├── System.c:166 Java_java_lang_System_initProperties    (读 /proc 等)
  ├── Object.c:51  Java_java_lang_Object_registerNatives
  │                Object.c:43  {"hashCode", (void*)&JVM_IHashCode}
  ├── String.c:30  Java_java_lang_String_intern            → JVM_InternString
  ├── Throwable.c:47 Java_java_lang_Throwable_fillInStackTrace → JVM_FillInStackTrace
  ├── Array.c      Reflection Array get/set (8 type-specialized)
  ├── Class.c      forName0 → JVM_FindClassFromCaller
  ├── Runtime.c    gc/exit/totalMemory etc → JVM_*
  ├── Thread.c     currentThread/sleep → JVM_*
  └── jni_util.c   JNI utility: exception check, string conversion
  │
  ▼
jvm.cpp (HotSpot side — actual implementation)
  ├── JVM_ArrayCopy     → TypeArrayKlass::copy_array / ObjArrayKlass::copy_array
  ├── JVM_IHashCode     → ObjectSynchronizer::FastHashCode → markOop hash
  ├── JVM_InternString  → StringTable::intern
  └── JVM_FillInStackTrace → java_lang_Throwable::fill_in_stack_trace
  │
  ▼
Platform layer (unix/native/libjava/)
  ├── java_props_md.c      → 读 /proc 系统属性, LD_LIBRARY_PATH, locale
  ├── ProcessImpl_md.c     → fork+exec
  └── io_util_md.c         → 平台文件 I/O
```

## 基本元素分解

1. **JVM_* 快速通道** — Object.c 用函数指针 `(void*)&JVM_IHashCode` 注册 native 方法（`Object.c:43`），Java 调用 Object.hashCode() 时直接跳 JVM_IHashCode——不经过 JNIEnv 函数表。System.c/String.c/Throwable.c/Runtime.c 同样走 `JVM_*` 中转。`JVM_*` 函数在 `jvm.cpp` 实现（HotSpot）。

2. **System.c** — `identityHashCode`(`:54`)、`initProperties`(`:166`)、`setIn0/setOut0/setErr0`。`initProperties` 调用 `java_props_md.c` 读 `/proc/version`、`/proc/self/exe`、locale 等构建 Java 系统属性。

3. **Object.c** — `registerNatives`(`:51`) 注册 `hashCode`/`getClass`/`notify`/`notifyAll`/`wait`/`clone` 的 JVM 函数指针映射。`getClass`(`:58`) 直接调 `JVM_GetCallerClass`。

4. **String.c:30** — `String_intern` → `JVM_InternString` → `StringTable::intern()`（域 17 详述）。2 行代码：JNI 包装 + 调 JVM。

5. **Throwable.c:47** — `fillInStackTrace` → `JVM_FillInStackTrace` → 棧帧回溯 + `BacktraceBuilder`。注释（`:44`）：返回值是 `this` 自身——支持链式 `throw e.fillInStackTrace()`。

6. **jni_util.c** — JNI 类型转换工具：`jstring→char*`、异常检查 `JNU_ThrowNullPointerException`、method ID 缓存。被 libjava 所有 native 方法共享。

7. **Array.c** — Reflection Array 的 8 个类型特化的 get/set + getLength（`java.lang.reflect.Array` 的 native 方法）。注意：`System.arraycopy` 的 JVM_ArrayCopy 入口在 HotSpot 侧 `jvm.cpp`——不在 Array.c 中。

## 标记问题（≥5）

1. **[设计决策] 为什么 Object.c 用函数指针表而不是直接 call？** — `Object.c:43` 的 `{"hashCode", "()I", (void*)&JVM_IHashCode}` 通过 `registerNatives` 在 JNI 初始化时一次性注册所有 native 方法——后续调用 Object.hashCode() 时 JVM 直接跳函数指针，省去每次查找。代价：每个 native 方法需要手动维护函数指针表。

2. **[JVM_ArrayCopy 在哪？]** — libjava.so 的 Array.c 只含 `java.lang.reflect.Array` 的反射 get/set。真正的 `System.arraycopy` → `JVM_ArrayCopy` 在 HotSpot 的 `jvm.cpp`（不在 libjava 中）。这意味着 arraycopy 是"纯 HotSpot native"——libjava 完全不参与。

3. **[initProperties 为什么复杂？]** — `System.c:166` 的 `initProperties` 调 `java_props_md.c` 读 `/proc/version`（OS 版本）、`/proc/self/exe`（java 二进制路径）、`setlocale`（locale）、`LD_LIBRARY_PATH` 等。这是 JVM 启动过程中唯一读 `/proc` 的代码——所有 Java 系统属性来自这里。

4. **[跨域] Object.hashCode 的返回值和 Synchronization 的关系** — `JVM_IHashCode` 调用 `ObjectSynchronizer::FastHashCode()` → 从 `markOop` 的 hash 位读出 identity hash。如果 mark word 已被偏向锁占用（biased lock pattern），hash 需要从别处获取（`BiasedLocking::revoke_and_rebias` 后重新计算）。这说明 Object.hashCode 和 Synchronization 域（vol-02）有超预期的耦合。

5. **[Throwable.fillInStackTrace 的性能]** — `Throwable.c:47` 的 `JVM_FillInStackTrace` 需要遍历整个栈帧链（从当前帧到方法入口）——每条帧记录 method+BCI+line number。对于深层栈（如 Spring Boot 80 层），单次 fillInStackTrace 可消耗 ~1μs——这是异常昂贵的根本原因。优化方案（JEP 358: Helpful NullPointerExceptions）需要更精确的 BCI 但成本可控。
