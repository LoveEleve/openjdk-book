# 01-Class-String: Class.forName + String.intern + Float.floatToRawIntBits

> **阶段**：[15-core-native]
> **前置**：[09-native-interface]（JNI_ENTRY/JVM_ENTRY 宏机制）、[03-object-model]（markOop, object header）、[02-class-loading]（FindClass, system dictionary, class loader hierarchy）
> **配套**：[00-System-Arraycopy]（System.c + Object.c Hot 路径）、[02-Runtime-Throwable]（Runtime.gc, fillInStackTrace）、[03-JNI-Utility]（jni_util.c 工具层）
> **后续依赖本文**：[16-nio-network]（Class.forName 的 class resolution 是所有 Java 代码运行的基础）
> **阅读收益**：追踪 Class.forName0 从 Java 到 native 的完整 7 步调用链——理解 forName0 的 caller-classloader 陷阱（OSGi CNFE #1 根源）、VerifyClassname 的 null byte 注入防御、String.intern 在 metaspace StringTable 中的 lock-free CAS 实现（15x faster than Java heap dictionary）、Class.isAssignableFrom 的 JNI subtype check、Float.floatToRawIntBits 的纯 C union 零开销重解释

---

## §〇 生产场景 — ClassNotFoundException in OSGi

```
java.lang.ClassNotFoundException: com.example.Foo
    at java.lang.Class.forName0(Native Method)
    at java.lang.Class.forName(Class.java:348)
    at com.example.Main.init(Main.java:23)
```

`Class.forName("com.example.Foo")` 编译通过且 `Foo.class` 存在于 classpath 中——但运行时失败。

Root cause：`Class.forName0` 在 **Class.c:137** 调用 `JVM_FindClassFromCaller(env, clname, initialize, loader, caller)`。`caller` 参数是**调用者的 Class 对象**——JVM 使用 CALLER 的 classloader，不是当前线程的 context classloader。在 OSGi 中，每个 bundle 有其自己的 PrivateClassLoader 和受限的可见性。调用代码的 bundle classloader 可能不 export `com.example.Foo`，即使 Foo 存在于另一个 bundle 的 classloader 中。`forName` 解析 CALLER 的 bundle → Foo 未从该 bundle export → CNFE。

这是 OSGi ClassNotFoundException 的 #1 根源：开发者假设 `Class.forName` 使用 context classloader（在 OSGi 中通常是 bootstrap/osgi framework loader 且 CAN see exported packages）。它不是——它使用 lexical caller 的 loader。微妙的区别：`Class.forName("Foo")` 在代码编译的 lexical scope 中解析 `Foo`，而不是在运行时部署环境中。

**三步诊断**：

```bash
# 1. 确认调用者的 classloader
jcmd <pid> VM.class_hierarchy | grep com.example.Foo
# 如果 Foo 已加载 → 显示 Foo 的 loader; 如果未加载 → 查看调用者 bundle 的 loader

# 2. 验证 caller 的 classloader 能否看到 Foo
# JVM 启动时添加: -XX:+TraceClassLoading -XX:+TraceClassResolution
# 搜索日志中的 forName0 调用:
rg "forName0.*com.example.Foo" trace.log

# 3. GDB 断点验证 ClassLoader chain
gdb -ex "break Class.c:137" \
    -ex "break jvm.cpp:795" \
    -ex "run" \
    -ex "print clname" \
    -ex "print caller" \
    -ex "print loader" \
    --args java -cp app.jar com.example.Main
```

**反事实**：如果 `forName0` 使用 context classloader 而非 caller 的 classloader → OSGi 环境中 context classloader 通常设为启动类加载器，能看见所有 exported 包 → Foo 能找到。但这也意味着任意代码可以通过 `Class.forName("sun.misc.Unsafe")` 加载 JDK 内部类（caller 是 RestrictedBundleLoader 但 context loader 是 BootstrapLoader）→ 安全边界破坏。HotSpot 团队选择 **lexical security**（调用栈中最近的代码决定可用类）而非 **runtime convenience**（谁设了 context loader 谁说了算）。这是 JVM 沙盒安全模型的基础。

---

## §一 全链路源码走读 — forName + intern + getClass + floatToRawIntBits

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, JNI parameter marshalling), **03-object-model** (markOop), **05-jit-compiler** (C2 intrinsics). This doc: **how the most-called native methods actually work** — how Class.forName and String.intern function from VerifyClassname sanitization to JVM_FindClassFromCaller's caller-classloader resolution, and from JVM_InternString to ConcurrentHashTable's lock-free intern path.

前置: [00-System-Arraycopy] (arraycopy dispatch mechanism), [02-class-loading] (FindClass chain), [14-zip-jimage] (ClassLoader bridge)

### 1.1 forName0 参数协议 (Class.c:98–144)

`Class.forName0` 接收 5 个参数，从 Java 层的 `Class.forName0(String, boolean, ClassLoader, Class)` 逐级传递到 native：

```c
JNIEXPORT jclass JNICALL
Java_java_lang_Class_forName0(JNIEnv *env, jclass this, jstring classname,
                              jboolean initialize, jobject loader, jclass caller)
```

参数含义：
- `classname`：jstring → `GetStringUTFRegion` 转换为 UTF-8 C string (Class.c:123)
- `initialize`：jboolean → 是否执行 `<clinit>` (static initializer)
- `loader`：jobject → 指定的 classloader (NULL = bootstrap loader)
- `caller`：jclass → 调用者的 Class 对象（由 Java 层 `Reflection.getCallerClass()` 提供）

### 1.2 VerifyFixClassname — 斜杠格式检测 (Class.c:125–130)

```c
if (VerifyFixClassname(clname) == JNI_TRUE) {
    /* slashes present in clname, use name b4 translation for exception */
    (*env)->GetStringUTFRegion(env, classname, 0, unicode_len, clname);
    JNU_ThrowClassNotFoundException(env, clname);
    goto done;
}
```

`VerifyFixClassname` (Class.c:42, defined in `libverify.so`) 检测 classname 中的 "/"。Java 层的 `forName` 应该使用 "." 格式 (`com.example.Foo`)，但某些工具（ASM, ByteBuddy）直接调用 `forName0` → 传入 slashed name (`com/example/Foo`)。如果检测到 "/" → 立即抛出 ClassNotFoundException。

**反事实**：如果没有这个检查 → ASM 生成的字节码意外传入 `"com/example/Foo"` → `JVM_FindClassFromCaller` 在 classloader 中查找 slashed name → 按 JVM spec 应拒绝 (forName 必须用 "." 格式) → 但某些历史 JVM 版本可能错误地接受 slashed name → 隐藏的双重 parse path 安全问题。

### 1.3 VerifyClassname — null byte 注入防御 (Class.c:132–135)

```c
if (!VerifyClassname(clname, JNI_TRUE)) {  /* expects slashed name */
    JNU_ThrowClassNotFoundException(env, clname);
    goto done;
}
```

`VerifyClassname` (Class.c:41, extern from `libverify.so`) 执行三大类检查：

1. **Null byte injection**：拒绝包含 `\0` 的 name (`"java.lang.Object\0evil"`)。C string 以 `\0` 为终止符。`JVM_FindClassFromCaller` 使用 C string → `"java.lang.Object\0evil"` 在 C 层看起来就是 `"java.lang.Object"` → 绕过 classname 限制 → 加载任意类。
2. **UTF-8 validity**：拒绝非法 UTF-8 字节序列 → 防止通过畸形 UTF-8 构造意外代码点。
3. **Identifier check**：每个 name component 必须是有效 Java identifier。

**arrayAllowed 参数**：`JNI_TRUE` 允许 classname 以 `[` 开头（数组类名如 `[Ljava.lang.String;`）。`forName0` 传入 `JNI_TRUE` —— 允许 `"[[I"` 用 forName 创建多维数组。

> **Beginner Callout 1 — VerifyClassname**：Class.c:41 declares `extern jboolean VerifyClassname(char *utf_name, jboolean arrayAllowed)`. Called at Class.c:132 before invoking JVM_FindClassFromCaller. Validates that the class name: (a) contains no null bytes (prevents `java.lang.String\0evil` injection), (b) uses valid Java identifier characters, and (c) follows the slashed binary name format (`com/example/Foo`). Returns JNI_FALSE for invalid names → throws ClassNotFoundException.

### 1.4 JVM_FindClassFromCaller — caller's classloader (Class.c:137 → jvm.cpp:795–823)

这是 OSGi CNFE 的根源——JVM 使用 **caller 的参数** 的 classloader，不是 context classloader：

```c
cls = JVM_FindClassFromCaller(env, clname, initialize, loader, caller);
```

在 `jvm.cpp:795-823` 中：

```c
JVM_ENTRY(jclass, JVM_FindClassFromCaller(JNIEnv * env, const char *name,
        jboolean init, jobject loader, jclass caller))
    JVMWrapper("JVM_FindClassFromCaller throws ClassNotFoundException");
    if (name == NULL || (int) strlen(name) > Symbol::max_length()) {
        THROW_MSG_0(vmSymbols::java_lang_ClassNotFoundException(), name);
    }
    TempNewSymbol h_name = SymbolTable::new_symbol(name, CHECK_NULL);
    oop loader_oop = JNIHandles::resolve(loader);
    oop from_class = JNIHandles::resolve(caller);
    oop protection_domain = NULL;
    if (from_class != NULL && loader_oop != NULL) {
        protection_domain = java_lang_Class::as_Klass(from_class)->protection_domain();
    }
    Handle h_loader(THREAD, loader_oop);
    Handle h_prot(THREAD, protection_domain);
    jclass result = find_class_from_class_loader(env, h_name, init, h_loader,
                                                 h_prot, false, THREAD);
    return result;
JVM_END
```

关键细节：当 `caller != NULL && loader_oop != NULL` 时，JVM 提取 caller 的 **protection domain** — 这是基于代码签名的安全权限集。caller 的 protection domain 不能看到其 classloader 的可见性之外的类。→ 02-class-loading: find_class_from_class_loader inserts into system dictionary.

> **Beginner Callout 2 — Caller ClassLoader**：`Class.forName` uses the CALLER's classloader — determined by the `caller` parameter passed from Java's `Class.forName0()` via `Reflection.getCallerClass()`. NOT the current thread's `Thread.getContextClassLoader()`. This follows lexical scoping: the class loading environment is determined by WHERE the code compiles, not WHO runs the current thread. Source: Class.c:137 — JVM_FindClassFromCaller.

### 1.5 Class.isAssignableFrom — JNI type hierarchy check (Class.c:156–163)

```c
JNIEXPORT jboolean JNICALL
Java_java_lang_Class_isAssignableFrom(JNIEnv *env, jobject cls, jobject cls2)
{
    if (cls2 == NULL) {
        JNU_ThrowNullPointerException(env, 0);
        return JNI_FALSE;
    }
    return (*env)->IsAssignableFrom(env, cls2, cls);
}
```

JNI `IsAssignableFrom` 检查 `cls2` (子类 candidate) 是否能赋值给 `cls` (父类 target)。等价于 Java: `cls.isAssignableFrom(cls2)` ↔ `cls2 extends cls` 或 `implements cls`。

内部实现：JVM 读取两者的 `Klass*` → 在 cls2 的 super type hierarchy 中查找 cls 是否存在于某处。如果是接口检查 → 遍历 cls2 的所有 interfaces 及其 transitive supers。核心函数是 `Klass::is_subtype_of()` —— JVM 缓存了 secondary super types 在 klass 的数组中提供 O(1) 检查。

**Counterfactual**：纯 Java 实现（`for (Class<?> c = cls2; c != null; c = c.getSuperclass())` 循环）→ 每次迭代一次 JNI GetSuperclass 调用 ~100ns JNI overhead。深度 10 的 hierarchy 中 ~1µs。JNI IsAssignableFrom 一次调用 ~50ns (包括 Klass 虚函数 dispatch)。对于 JIT 编译器（每秒数百万 subtype 检查）→ **~20x faster in native**。

### 1.6 String.intern — 最短的 native 方法 (String.c:30–33)

全文件中最短的 native 方法——4 行，单行委托：

```c
JNIEXPORT jobject JNICALL
Java_java_lang_String_intern(JNIEnv *env, jobject this)
{
    return JVM_InternString(env, this);
}
```

在 `jvm.cpp:3542-3549` 中：

```c
JVM_ENTRY(jstring, JVM_InternString(JNIEnv * env, jstring str))
    JVMWrapper("JVM_InternString");
    JvmtiVMObjectAllocEventCollector oam;
    if (str == NULL) return NULL;
    oop string = JNIHandles::resolve_non_null(str);
    oop result = StringTable::intern(string, CHECK_NULL);
    return (jstring) JNIHandles::make_local(env, result);
JVM_END
```

`StringTable::intern()` 从 Java oop 直接操作——无需额外的 JNI 包装/解包。它在 metaspace (native memory) 中的 `ConcurrentHashTable<StringTableConfig>` 内搜索。流程：

1. 计算 hash (与 `String.hashCode()` 相同的算法)
2. 在 ConcurrentHashTable 中搜索 hash bucket
3. 如果找到 matching entry (via content equality) → 返回 existing interned string
4. 如果未找到 → CAS 插入新 entry → 返回新 entry

锁策略：lookup 是 lock-free (只读, no CAS needed)，insert 是 CAS-based (无锁写，但可能 retry on contention)。

> **Beginner Callout 3 — StringTable**：A `ConcurrentHashTable<StringTableConfig>` stored in metaspace (native memory, not Java heap). Stores every interned string as a `weakHandle` — the string is a GC root, never collected as long as the table entry exists. Lock-free on reads (no CAS required for lookup), CAS-based on writes (insert only if not present). Average O(1) lookup, ~10ns per intern call. Source: `src/hotspot/share/classfile/stringTable.cpp`.

**Counterfactual**：如果 StringTable 在 Java heap → 每次 intern 需要 3 次 JNI 穿越 (lookup→insert→return) × 50ns = ~150ns。Metaspace：CAS ~10ns → **15x faster**。而且如果 Java 实现（如 WeakHashMap<String,String>）→ 每次 intern 创建 new String 对象（即使已存在）→ GC overhead 1-5% → WeakHashMap 的 get/put 都需要 hashCode() 计算 → 对 intern 的字符串 hash 不是免费的 → ConcurrentHashTable in metaspace → CAS ~10ns → 5x faster than Java dictionary。

### 1.7 Object.getClass — JNI GetObjectClass (Object.c:57–65)

```c
JNIEXPORT jclass JNICALL
Java_java_lang_Object_getClass(JNIEnv *env, jobject this)
{
    if (this == NULL) {
        JNU_ThrowNullPointerException(env, NULL);
        return 0;
    } else {
        return (*env)->GetObjectClass(env, this);
    }
}
```

JNI `GetObjectClass` 读取 oop header 中的 `Klass*` 指针——Java 代码无法解引用原始内存地址来读取对象布局。`Klass*` 返回后包装为 `jclass` global reference 返回给 Java。

**Counterfactual**：如果 getClass 是纯 Java 实现 → Java 需要访问原始对象 header 以读取 Klass* → 不可能——Java 的安全模型禁止直接内存解引用。即使是 `Unsafe.getInt(oop)` 也需要知道 header 偏移量 = 64 字节（oop header size），且返回值需要解释为 `Klass*` → Java 无法表示 C++ 指针。

### 1.8 Class.getName0 — binary name conversion (Class.c:168–183)

`getName0` 通过 RegisterNatives 注册（Class.c:54-79) → 调用 `JVM_GetClassName` (jvm.cpp:598-606)。JVM 内部读取 `Klass::external_name()` → 将内部 binary name `"java/lang/Object"` 转换为 Java dotted name `"java.lang.Object"` (替换 `/` 为 `.`)。

对于数组类：`"[Ljava/lang/String;"` → `"java.lang.String[]"` (复杂重写规则)。对于 primitive 类：`"I"` → `"int"`, `"J"` → `"long"`。

**追问**：为什么不在 Java 层做转换 (String.replace('/','.'))？→ 因为 Class 对象本身是 native 数据结构 (klassOop) → 读取 class name 需要访问 native Klass* 的 symbol → 必须走 JNI/JVM。转换本身可以在 Java 做——但既然已经穿透 native 读取 name → 自然在 native 完成转换，避免二次 JNI 调用做 String.replace。

**Counterfactual**：如果 className 返回 raw binary name (`"java/lang/Object"`) → Java 代码中 `class.getSimpleName()` + `class.getPackage()` + `Class.forName` 都期望 "." 格式 → 传入 raw binary name → forName 失败 (VerifyFixClassname 拒绝 "/") → 整个 Java 反射生态崩溃。Binary→Java name 转换是 JVM spec 要求的标准化格式变换——不是设计选择，是 Java SE spec §4.2.1 强制要求。

### 1.9 Float.floatToRawIntBits — pure C union, zero JVM calls (Float.c:49-56)

这是所有 `libjava.so` native 方法中最独特的一个——它不调用任何 `JVM_*` 函数，不使用 JNI（除了参数接收），不访问 Java heap：

```c
JNIEXPORT jint JNICALL
Java_java_lang_Float_floatToRawIntBits(JNIEnv *env, jclass unused, jfloat v)
{
    union {
        int i;
        float f;
    } u;
    u.f = (float)v;
    return (jint)u.i;
}
```

CPU 层面：32-bit 浮点值在 XMM 寄存器中 → `movd` 指令 copy 到通用寄存器 → 返回。零 cycle 计算开销 (1 cycle 寄存器复制)。C2 进一步 intrinsify 为 `MoveF2INode` → 在 IR 图中只是一个类型标注变换 → 生成**零**汇编代码。

> **Beginner Callout 4 — C union**：Float.c:49-56 uses `union { int i; float f; }` to reinterpret the same 32 bits as int vs float. Java has no union type — this is a C-language-only operation. The CPU does nothing: the 32 bits stay in the same register, only the interpretation changes. C2 intrinsifies this to `MoveF2INode` — no code generation, just a type change in the compiler's IR graph.

**追问**：为什么不是 `Float.floatToIntBits`（纯 Java 方法）而是 raw variant？→ `floatToIntBits` 额外做了 NaN canonicalization: 所有 NaN 变体 (`0x7fc00000, 0x7fc00001, ..., 0x7fffffff`) 折叠为单一规范 NaN `0x7fc00000`。这个操作可以用 Java 的 `Float.intBitsToFloat + Float.floatToRawIntBits` 组合实现。raw variant 需要 C union 获取原始 bits → 不可替代的 native 需求。

### 1.10 ★ Mermaid: forName + intern dual-path sequence diagram

```
┌──────────────┐  ┌────────────────┐  ┌─────────────────────┐  ┌────────────────────┐  ┌──────────────┐
│   Java App   │  │  Native libjava │  │  JVM Core (jvm.cpp) │  │  System Dictionary │  │  StringTable │
└──────┬───────┘  └───────┬─────────┘  └──────────┬──────────┘  └─────────┬──────────┘  └──────┬───────┘
       │                  │                       │                      │                    │
       │ Class.forName()  │                       │                      │                    │
       │──────────────────►                       │                      │                    │
       │                  │ forName0 (Class.c:98) │                      │                    │
       │                  │──────────────────────►│                      │                    │
       │                  │ VerifyFixClassname    │                      │                    │
       │                  │ (Class.c:125)         │                      │                    │
       │                  │ Check "/" in name     │                      │                    │
       │                  │──────────────────────►│                      │                    │
       │                  │ VerifyClassname       │                      │                    │
       │                  │ (Class.c:132)         │                      │                    │
       │                  │ null-byte scan        │                      │                    │
       │                  │──────────────────────►│                      │                    │
       │                  │ JVM_FindClassFrom     │                      │                    │
       │                  │ Caller (Class.c:137)  │                      │                    │
       │                  │──────────────────────►│                      │                    │
       │                  │                       │ caller's classloader │                    │
       │                  │                       │ + protection domain  │                    │
       │                  │                       │──────────────────────►                    │
       │                  │                       │ find_class_from_     │                    │
       │                  │                       │ class_loader()       │                    │
       │                  │                       │──────────────────────►                    │
       │                  │                       │                      │ insert into        │
       │                  │                       │                      │ system dictionary  │
       │                  │                       │                      │◄───────────────────│
       │                  │                       │                      │ (cached for reuse) │
       │                  │                       │◄─────────────────────│                    │
       │                  │◄──────────────────────│ return jclass        │                    │
       │◄─────────────────│ return jclass         │                      │                    │
       │                  │                       │                      │                    │
       │ "hello".intern() │                       │                      │                    │
       │──────────────────►                       │                      │                    │
       │                  │ String.intern         │                      │                    │
       │                  │ (String.c:32)         │                      │                    │
       │                  │──────────────────────►│                      │                    │
       │                  │ JVM_InternString      │                      │                    │
       │                  │ (jvm.cpp:3542)        │                      │                    │
       │                  │                       │────────────────────────────────────────────►
       │                  │                       │ StringTable::intern()                     │
       │                  │                       │ ConcurrentHashTable                       │
       │                  │                       │ lock-free lookup                          │
       │                  │                       │     ┌─────────────────────────────────►   │
       │                  │                       │     │  found? → return existing entry     │
       │                  │                       │     │  not found? → CAS insert → return    │
       │                  │                       │◄────────────────────────────────────────────
       │                  │◄──────────────────────│ return interned string                    │
       │◄─────────────────│ return interned string│                      │                    │
```

---

### 1.11 ★ 面试 Story Format 答案

**Q: "为什么 Class.forName 在 OSGi 中失败？为什么 String.intern 是 native？"**

`Class.forName0` 在 **Class.c:98** 接收 5 个参数——其中 `caller` 来自 Java 层 `Reflection.getCallerClass()`。在 **Class.c:137**，`JVM_FindClassFromCaller(env, clname, initialize, loader, caller)` 使用 **caller 的 classloader** 解析类名。在 OSGi 中，每个 bundle 有自己的 PrivateClassLoader。调用代码的 bundle classloader 可能不 export 目标类 → ClassNotFoundException。这是 JVM 安全模型的结果——遵循 lexical scoping（调用栈中最近的代码决定可用类），防止代码通过 context classloader 加载受限类。

`String.intern` 在 **String.c:30-33** 是最短的 native 方法（4 行，单行委托给 `JVM_InternString`）。`StringTable` 是存储在 **metaspace** (native memory) 中的 `ConcurrentHashTable`——Java code 无法直接访问 native memory。如果用 Java heap dictionary 替代 → 每次 intern 需要 3 次 JNI 穿越 (lookup→insert→return) × 50ns = ~150ns。在 metaspace 中：lock-free CAS ~10ns → **15x faster**。

`Float.floatToRawIntBits` 在 **Float.c:49-56** 是纯 C union 重解释——零 JVM 调用，零计算。C2 将其 intrinsify 为 `MoveF2INode`（零代码生成——同一个寄存器，不同的类型解释）。这是 C union 对 Java 类型系统的最直观补充——Java 没有 union 类型，无法在同一内存上用两种类型解释 bits。

---

### 1.12 ★ 6 Beginner Callout Boxes (Index)

> **Beginner Callout 5 — JNI_ENTRY vs JVM_ENTRY**：`JNI_ENTRY` = enter native from Java code — slow path, JNIEnv wrapping of oop→jobject, safepoint check. `JVM_ENTRY` = JVM internal entry — fast path, direct oop access, no JNI marshalling. `JVM_LEAF` = no safepoint check for pure functions like `nanoTime`. Class.c:98 uses `JNIEXPORT` (JNI convention) but internally calls `JVM_FindClassFromCaller` (JVM_ENTRY). Source: `src/hotspot/share/prims/jvm.cpp`.

> **Beginner Callout 6 — intrinsic**：C2 compiler replaces certain native method calls with direct CPU instructions at compile time — bypassing JNI overhead entirely. Float.floatToRawIntBits → native JNI call (~50ns) OR C2 intrinsic → register move (~0.5ns). 100x faster. System.arraycopy → native memmove OR C2 intrinsic → REP MOVS (vectorized x86 copy). C2 recognizes ~200 intrinsic methods. If a method is NOT intrinsified (e.g., on a cold path), the native JNI fallback is used.

---

## §二 Standard Environment + Source Files

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/share/native/libjava/` — Class.c (187 lines), String.c (44 lines), Float.c (57 lines), Object.c (66 lines)
- `src/hotspot/share/prims/jvm.cpp` — JVM_FindClassFromCaller (:795-823), JVM_InternString (:3542), JVM_GetClassName (:598)
- `src/hotspot/share/classfile/stringTable.cpp` — `StringTable::intern()` implementation
- `src/hotspot/share/classfile/systemDictionary.cpp` — `find_class_from_class_loader()` — resolves class in caller's loader
- `src/hotspot/share/classfile/classLoaderData.cpp` — ClassLoaderData::add_class()
- `src/hotspot/share/oops/klass.hpp` — `Klass::is_subtype_of()` — used by JNI IsAssignableFrom
- `src/hotspot/share/classfile/verification.cpp` — VerifyClassname + VerifyFixClassname (linked via libverify.so)

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjava.so` — Class.c + String.c compiled

### Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **Class.c** | `src/java.base/share/native/libjava/Class.c` | 187 | `forName0`(:98, →JVM_FindClassFromCaller at :137), `isAssignableFrom`(:156, →JNI IsAssignableFrom at :162), `isInstance`(:147, →JNI IsInstanceOf at :152), `getPrimitiveClass`(:166, →JVM_FindPrimitiveClass), `registerNatives`(:89, binds 20+ methods) | Warm — reflection native bridge |
| 2 | **String.c** | `src/java.base/share/native/libjava/String.c` | 44 | `intern`(:30-33, single-line delegate to JVM_InternString), `isBigEndian`(:36, union hack on 0xff000000) | Warm — string interning |
| 3 | **jvm.cpp** | `src/hotspot/share/prims/jvm.cpp` | ~3600 | `JVM_FindClassFromCaller`(:795-823), `JVM_InternString`(:3542), `JVM_GetClassName`(:598) | JVM internal entry — class resolution + string interning |
| 4 | **Float.c** | `src/java.base/share/native/libjava/Float.c` | 57 | `floatToRawIntBits`(:49, C union), `intBitsToFloat`(:39, C union) | Cool — pure C, zero JVM calls |
| 5 | **stringTable.cpp** | `src/hotspot/share/classfile/stringTable.cpp` | ~600 | `StringTable::intern()` — `ConcurrentHashTable` lookup + CAS insert | Interned string storage — metaspace, lock-free |
| 6 | **systemDictionary.cpp** | `src/hotspot/share/classfile/systemDictionary.cpp` | ~2000 | `find_class_from_class_loader()` — resolves class in caller's loader, inserts into system dictionary | Class resolution — called by JVM_FindClassFromCaller |
| 7 | **Object.c** | `src/java.base/share/native/libjava/Object.c` | 66 | `getClass`(:57, →JNI GetObjectClass at :64) | Hot path — getClass returns Klass* from header |

## §三 Caller ClassLoader Security Analysis

### 3.1 Lexical Scope vs Context ClassLoader

`Class.forName("Foo")` 使用 caller 的 classloader — 由 Java 层 `Reflection.getCallerClass()` 提供 `caller` 参数。这是 lexical scoping：类加载环境由代码 **编译位置** 决定，而非 **当前线程运行者**。

| Mechanism | Loader Used | Security Model | OSGi Behavior |
|---|---|---|---|
| `Class.forName(String)` | Caller's classloader (lexical) | Stack introspection — nearest caller decides visibility | CNFE if caller's bundle doesn't export target |
| `Class.forName(String, boolean, ClassLoader)` | Explicit loader parameter | Caller controls loader — same lexical scoping | Works if correct bundle's loader is passed |
| `Thread.getContextClassLoader()` | Whatever was set on the thread | Runtime configuration — fragile, can be changed anytime | Typically bootstrap/osgi framework loader, wide visibility |
| `ClassLoader.loadClass(String)` | The loader instance itself | Direct — no stack introspection | Works if correct loader is used |

### 3.2 The OSGi Failure Mode in Detail

```
OSGi Framework
 ├─ Bundle A (caller)  ← Class.forName("com.example.Foo") runs here
 │   └─ PrivateClassLoader-A  ← CANNOT see Foo (Foo is in Bundle B)
 ├─ Bundle B
 │   └─ PrivateClassLoader-B  ← CAN see Foo (Foo defined here)
 └─ Context ClassLoader = BootstrapLoader ← CAN see Foo (all exported pkgs)
```

`Class.forName("com.example.Foo")` compiles OK because Bundle B is on the compile classpath. Runtime: `forName0` → `JVM_FindClassFromCaller` → resolves in PrivateClassLoader-A → Foo is in Bundle B → ClassNotFoundException. Fix: pass Bundle B's loader explicitly: `Class.forName("com.example.Foo", true, bundleBLoader)`.

### 3.3 Security Rationale: Why Lexical Scope Wins

Java 的栈内省安全模型：`@CallerSensitive` 方法使用 `Reflection.getCallerClass()` 确定调用者的身份。如果 `forName` 使用 context classloader → 任意 RPC 框架可以通过 `Thread.setContextClassLoader(bootstrapLoader)` 然后调用 `Class.forName("sun.misc.Unsafe")` → 绕过 `@CallerSensitive` → 访问 JDK 内部 API。Lexical scoping 防止这种攻击：你只能加载你的代码 source 有权加载的类。

### 3.4 Performance: intern() Native vs Java Dictionary

| Implementation | Latency per call | Throughput (1M ops) | Memory location |
|---|---|---|---|
| Metaspace StringTable (actual) | ~10ns | ~100M/s | Native memory (metaspace) |
| Java heap ConcurrentHashMap | ~150ns | ~6.7M/s | Java heap |
| Java heap WeakHashMap (simplest) | ~500ns | ~2M/s | Java heap |

Metaspace 的 15x 优势来自：(a) 零 JNI crossing — oop 直接操作，(b) lock-free CAS vs ConcurrentHashMap 的 segment locks，(c) cache-friendly — 字符串内容和 hash table 都在连续的内存中。

### 3.5 StringTable Internals: ConcurrentHashTable Lock-free Design

`ConcurrentHashTable<StringTableConfig>` at stringTable.cpp is a **lock-free hash table** stored in metaspace. Key design properties:

- **Read path** (lookup): No locks, no CAS. Uses `load_acquire()` on the bucket array pointer — the entry pointer is published with a release-store by the writer. The reader sees either `null` (no entry) or a fully-constructed entry. Cost: ~5ns per lookup (one load-acquire + hash comparison).
- **Write path** (insert)：CAS-based. Tries to CAS the bucket head to point to the new entry. If CAS fails (another thread inserted first), restarts. Average retry rate: <1% under normal contention. Cost: ~10ns per insert.
- **GC integration**: StringTable entries are `weakHandle` — the table holds a weak reference. However, interned strings are treated as **strong GC roots** through a special `OopStorage` mechanism. Once interned, a string is never collected. This means the StringTable is effectively a **memory leak waiting to happen** if intern() is called on arbitrary dynamic strings.

### 3.6 Class.forName0 Memory Allocation Pattern

`Class.forName0` at Class.c:98-144 shows careful stack/heap memory management:

```c
char buf[128];            // Stack buffer for short names
jsize len = (*env)->GetStringUTFLength(env, classname);
if (len >= (jsize)sizeof(buf)) {
    clname = malloc(len + 1);   // Heap allocation for long names
    if (clname == NULL) {
        JNU_ThrowOutOfMemoryError(env, NULL);
        return NULL;
    }
} else {
    clname = buf;               // Stack allocation — zero heap overhead
}
(*env)->GetStringUTFRegion(env, classname, 0, unicode_len, clname);
// ... verification + JVM call ...
done:
    if (clname != buf) {
        free(clname);           // Free heap allocation if used
    }
    return cls;
```

This avoids heap allocation for the common case — class names are typically <128 characters (>99.9% of all classes). The `buf[128]` stack buffer handles: all JDK classes (`java.lang.Object` = 16 chars), all user classes, all array type signatures (`[Ljava.lang.String;` = 21 chars). Only pathological names (e.g., lambda synthetic names with 200+ character method references) trigger `malloc()`. This pattern saves ~50ns per call by avoiding heap allocator overhead.

### 3.7 getName0 Binary→Java Name Conversion Table

The conversion at jvm.cpp:598-606 handles these patterns:

| Internal Binary Name | Java External Name | Transformer |
|---|---|---|
| `java/lang/Object` | `java.lang.Object` | Replace `/` → `.` |
| `I` | `int` | Primitive type table lookup |
| `J` | `long` | Primitive type table lookup |
| `[I` | `int[]` | Array descriptor → readable format |
| `[Ljava/lang/String;` | `java.lang.String[]` | Multidimensional decomposition |
| `[[[D` | `double[][][]` | Nested multidimensional |
| `com/example/$Proxy0` | `com.example.$Proxy0` | Inner class separator preserved as `$` |

The array descriptor parser: reads `[` prefix to count dimensions, then reads the element type descriptor. For object arrays, reads `Lclassname;` between the `L` and `;`. For primitives, maps single-character descriptor to Java keyword.

### 3.8 Float.floatToRawIntBits: The C2 Intrinsic That Generates Zero Code

C2's `MoveF2INode` is the simplest intrinsic in the JVM. At the IR level:

```
Before intrinsic:
  CallNode → Float.floatToRawIntBits(floatArg)  [native call, ~50ns]

After intrinsic:
  MoveF2INode(floatArg)  [type reinterpretation, ~0ns]
```

At code generation: the x86 assembler emits `movd eax, xmm0` — a single 1-cycle instruction that copies the XMM register's low 32 bits to a general-purpose register. The bits are identical; only the CPU's interpretation changes. If C2 can prove the value stays in registers (no memory spill), the intrinsic generates **zero** additional instructions — the same register is simply treated as `int` instead of `float` by subsequent operations.

Note the contrast with `Integer.valueOf(int)` which also seems like it "should be" zero-cost: auto-boxing requires allocating a heap object (`java.lang.Integer`) — this is where the real cost lies. `floatToRawIntBits` produces a primitive `int`, not an object — no allocation, no GC.

---

## §四 Deep-Dive Question Groups

### 4.1 ★★★ Class.forName0 — caller classloader resolution

**Q: forName0 (Class.c:98-144) 的完整参数链是什么？**

`Class.c:98` 签名：`forName0(env, this, classname, initialize, loader, caller)`。验证步骤：
1. `VerifyFixClassname` (Class.c:125) — 检测 name 中的 "/" → 拒绝（Java 层 forName 应该用 "." 格式，但某些工具直接调用 forName0 → 传入 slashed name → 拒绝）
2. `VerifyClassname` (Class.c:132) — 检测 null 字节 + 非法字符
3. `JVM_FindClassFromCaller` (Class.c:137) — 在 caller 的 classloader 中查找

**追问**：为什么要两次验证（VerifyFixClassname + VerifyClassname）？
→ VerifyFixClassname 检查 "/" —— 语义正确性边界。VerifyClassname 检查 null-byte, 超长 name, 非法 UTF-8 字符 —— 安全边界。两层防御：语义正确性 + 安全边界。

**Counterfactual**：如果 forName 使用 context classloader 而非 caller 的 → OSGi 环境中 context classloader 通常设为 bootstrap/osgi framework loader → 能看到所有 exported 包 → forName("com.example.Foo") 成功。但在 RPC 框架中 (ServerSocket 线程 pool 中 context loader = bootstrap → 能加载 `sun.reflect.Reflection` → 绕过 `@CallerSensitive` 安全检查。Caller-classloader 方案保证：调用栈中最接近的代码决定可用类 → 符合 Java 栈内省安全模型。

---

### 4.2 ★★★ VerifyClassname — security sanitization

**Q: VerifyClassname 检查什么？为什么是安全边界？**

三大类检查：
1. **Null byte injection**: 拒绝包含 `\0` 的 name (`"java.lang.Object\0evil"`)。C string 以 `\0` 为终止符 → `"java.lang.Object\0evil"` 在 C 层看起来就是 `"java.lang.Object"` → 绕过 classname 限制 → 加载任意类
2. **UTF-8 validity**: 拒绝非法的 UTF-8 字节序列 → 防止通过畸形 UTF-8 构造意外代码点
3. **Identifier check**: 每个 name component 必须是有效 Java identifier

**追问**：arrayAllowed 参数的含义？→ `JNI_TRUE` 允许 classname 以 `[` 开头（数组类名）。`forName0` 传入 JNI_TRUE —— 允许 "[[I" 用 forName 创建多维数组。

**Counterfactual**：如果 VerifyClassname 被跳过（no sanitization）→ 恶意代码可传入 `"java.lang.String\0attack"` → `JVM_FindClassFromCaller` 只看到 "java.lang.String" → 返回 String.class → 但上层 Java 代码期望的是 "attack" 类 → 类型混乱。VerifyClassname 在 JVM 边界强制统一格式，是所有 class name 输入的 sanitization 网关。

---

### 4.3 ★★★ String.intern — metaspace ConcurrentHashTable

**Q: String.c:32 的 intern 如何到达 StringTable？**

`String.c:30-33` — 全文件中最短的 native 方法 (4 lines)。`JVM_InternString` (jvm.cpp:3542) → `StringTable::intern()` → search hash bucket in `ConcurrentHashTable` → found? return existing entry : CAS insert → return new entry。

内存位置：metaspace (native memory)，不是 Java heap。StringTable entries 是 **strong GC roots** — interned strings 永远不会被回收，只要 table entry 存在。

**Counterfactual**：如果 intern 是纯 Java 实现 (WeakHashMap<String,String>) → 每次 intern 创建 new String 对象（即使已存在）→ GC overhead 1-5% → WeakHashMap 的 get/put 都需要 hashCode() 计算 → 对 intern 的字符串 hash 不是免费的 → 字符串的 hash 是 lazy cache 在 String.value 中的 int field → 但 WeakHashMap 中不缓存 hash → 每次 lookup 计算 hash ~50ns → ConcurrentHashTable in metaspace → CAS ~10ns → **~5x–15x faster**。

---

### 4.4 ★★★ Class.isAssignableFrom — JNI type hierarchy check

**Q: isAssignableFrom (Class.c:156-163) 的 JNI 调用是什么？**

```c
return (*env)->IsAssignableFrom(env, cls2, cls);
```

JNI `IsAssignableFrom` 检查 cls2 (子类 candidate) 是否能赋值给 cls (父类 target)。内部：JVM 读取两者的 `Klass*` → 在 cls2 的 super type hierarchy 中查找 cls。核心是 `Klass::is_subtype_of()` —— 虚函数提供快速 subtype 检查。

JVM 在 native 层用 `Klass::is_subtype_of()` 虚函数做快速 subtype 检查 (O(1) via cached secondary super types in klass array)。Java 代码无法遍历 Klass* 的 C++ 指针链。

**Counterfactual**：如果 isAssignableFrom 是 Java 实现（`for (Class<?> c = cls2; c != null; c = c.getSuperclass())` 循环）→ 每次迭代一次 JNI GetSuperclass 调用 + 一次 JNI GetObjectClass → ~100ns JNI overhead per iteration → 深度 10 的 hierarchy 中 ~1µs。JNI IsAssignableFrom 一次调用 ~50ns → **20x faster**。实际上 C2 调用 `subtype_check` IR node 直接走 Klass::is_subtype_of 而非 JNI call。

---

### 4.5 ★★★ Class.getName0 — binary name conversion

**Q: Class.getName0 如何做 name 格式转换？**

`getName0` (Class.c:168-183，通过 RegisterNatives) → 调用 `JVM_GetClassName` (jvm.cpp:598-606)。JVM 内部：读取 `Klass::external_name()` → 将内部 binary name `"java/lang/Object"` 转换为 `"java.lang.Object"` (替换 `/` 为 `.`)。

对于数组类：`"[Ljava/lang/String;"` → `"java.lang.String[]"` (复杂重写规则)。对于 primitive 类：`"I"` → `"int"`, `"J"` → `"long"`。

**追问**：为什么不在 Java 层做转换 (String.replace('/','.'))？→ 因为 Class 对象本身是 native 数据结构 → 读取 class name 需要访问 native Klass* 的 symbol → 必须走 JNI/JVM。既然已经穿透 native 读取 name → 自然在 native 完成转换，避免二次 JNI 调用。

---

### 4.6 ★★★ Float.floatToRawIntBits — pure C, zero JVM

**Q: Float.floatToRawIntBits (Float.c:49-56) 为什么不需要任何 JVM 调用？**

这是所有 libjava.so native 方法中最独特的一个——它不调用 JVM_* 函数，不使用 JNI (除了参数接收)，不访问 Java heap。3 行 union 代码完成 100% 的工作。

CPU 层面：32-bit 浮点值在 XMM 寄存器中 → `movd` 指令 copy 到通用寄存器 → 返回。零 cycle 计算开销 (1 cycle 寄存器复制)。C2 进一步 intrinsify 为 `MoveF2INode` → 在 IR 图中只是一个类型标注变换 → 生成零汇编代码。

**追问**：为什么不是 `Float.floatToIntBits`（纯 Java 方法）而是 raw variant？→ `floatToIntBits` 额外做了 NaN canonicalization: 所有 NaN 变体折叠为单一规范 NaN `0x7fc00000`。这个操作可以用 Java 实现。raw variant 需要 C union 获取原始 bits → 不可替代的 native 需求。

---

## §五 ★ Mermaid: forName → class resolution + String intern paths

```
Class.forName("com.example.Foo")          "hello".intern()
        │                                         │
        ▼                                         ▼
java.lang.Class.forName0(...)            java.lang.String.intern()
Class.c:98                               String.c:32
        │                                         │
        ▼                                         ▼
VerifyFixClassname → "/" check    JVM_InternString(env, this)
Class.c:125                               jvm.cpp:3542
        │                                         │
        ▼                                         ▼
VerifyClassname → null-byte scan  StringTable::intern(string, CHECK)
Class.c:132                                 stringTable.cpp
        │                                         │
        ▼                                         ▼
JVM_FindClassFromCaller(            ConcurrentHashTable<StringTableConfig>
  name, init, loader, caller)              │
Class.c:137                          ┌─────┴─────┐
        │                           found?   not found?
        ▼                             │           │
jvm.cpp:795-823                return existing   CAS insert
  • TempNewSymbol h_name                 │           │
  • caller protection domain            ◄───────────┘
  • find_class_from_class_loader    return interned
        │                           (jstring)
        ▼
System Dictionary → resolve + cache
        │ (subsequent forName calls
        │  return cached class
        │  without native call)
        ▼
return jclass
```

---

## §六 GDB Verification — 6 断点完整 forName + intern trace

### 断言 1: forName0 调用 JVM_FindClassFromCaller (Class.c:137)

```gdb
(gdb) break Class.c:137
(gdb) run
(gdb) print clname              # 期望: "com/example/Foo" (slashed format)
(gdb) print initialize          # 期望: JNI_TRUE or JNI_FALSE
(gdb) print loader              # 期望: jobject (NULL=bootstrap, non-NULL=custom)
(gdb) print caller              # 期望: 调用者的 jclass
(gdb) continue
(gdb) print cls                 # 期望: 返回的 jclass (non-NULL=success) or NULL (CNFE)
```

### 断言 2: VerifyClassname validation (Class.c:132)

```gdb
(gdb) break Class.c:132
(gdb) run
(gdb) print clname              # 期望: 类名字符串 (slashed format)
(gdb) continue
# 检查是否进入 goto done (验证失败)
# 正常情况: VerifyClassname returns JNI_TRUE → continues to line 137
(gdb) info locals               # 检查 local vars after continue
```

### 断言 3: JNI IsAssignableFrom (Class.c:162)

```gdb
(gdb) break Class.c:162
(gdb) run
(gdb) print cls2                # 期望: 子类 jclass (candidate subtype)
(gdb) print cls                 # 期望: 父类 jclass (target type)
(gdb) continue
(gdb) print <return_register>   # 期望: JNI_TRUE (if subtype) or JNI_FALSE
```

### 断言 4: String.intern → JVM_InternString (String.c:32)

```gdb
(gdb) break String.c:32
(gdb) run
(gdb) print this                # 期望: 要 intern 的 jstring
(gdb) step                      # 进入 JVM_InternString
(gdb) info functions JVM_InternString  # 验证进入的函数
```

### 断言 5: JVM_InternString → StringTable::intern (jvm.cpp:3542)

```gdb
(gdb) break jvm.cpp:3542
(gdb) run
(gdb) print str                 # 期望: jstring object
(gdb) continue                  # 进入 StringTable intern
(gdb) print result              # 期望: 返回的 jstring (已存在于 table 或新插入)
```

### 断言 6: Float.floatToRawIntBits pure C (Float.c:49)

```gdb
(gdb) break Float.c:49
(gdb) run
(gdb) print v                   # 期望: 浮点值 (例如 3.14159f)
(gdb) next                      # 经过 union assignment (line 55)
(gdb) print u.i                 # 期望: IEEE 754 32-bit int representation (0x40490fdb → 3.14159f)
(gdb) disas                     # 期望: 无 call 指令 (pure computation, no JVM function calls)
```

---

## §七 ★ 面试问答 (Interview Q&A)

### Q4: "Why is Float.floatToRawIntBits native?"

Java 没有 C union 类型。Native 实现在 **Float.c:49-56** 使用 `union { int i; float f; }` 来重解释相同的 32 bits——零 CPU 开销，只是寄存器级的重解释。C2 将其 intrinsify 为 nothing：值留在同一个寄存器中，只有解释方式变了 (等价于 x86 `movd`)。这与 `Float.floatToIntBits` 不同，后者额外将所有 NaN 编码折叠为单一规范 NaN。

### Q5: "How does Class.forName find the class?"

`Class.forName0` 在 **Class.c:98-144** 验证 class name（lines 125-135: `VerifyFixClassname`，`VerifyClassname`），然后调用 `JVM_FindClassFromCaller(env, clname, initialize, loader, caller)` 在 **line 137**。`caller` 参数是调用者的 Class 对象——JVM 使用 **caller 的 classloader**（不是当前线程的 context classloader）来查找类。在 **jvm.cpp:795-823**，`JVM_FindClassFromCaller` 从名字创建 `TempNewSymbol`，解析 caller 的 protection domain，然后委托给 `find_class_from_class_loader`。这就是为什么 OSGi/JPMS classloading 会失败——如果 caller 的 classloader 对目标类没有可见性，就会使用错误的 classloader。

### Q6: "How does String.intern work?"

`Java_java_lang_String_intern` 在 **String.c:30-33** 是单行委托给 `JVM_InternString(env, this)`。`JVM_InternString` 调用 `StringTable::intern()` 搜索 `ConcurrentHashTable<StringTableConfig>`——一个在 metaspace (native memory) 中存储的 hash table，lock-free on read, CAS-based on write。如果字符串已存在，返回已存在的 entry（deduplication）。否则，插入新 entry 并返回它。StringTable entries 是 strong GC roots——interned strings 永远不会被回收。

---

---

## §八 Cross-Reference

| Phase | Connection | Handoff Point |
|-------|-----------|--------------|
| **02-class-loading** | find_class_from_class_loader → system dictionary | `JVM_FindClassFromCaller` (Class.c:137 → jvm.cpp:822) |
| **09-native-interface** | JNI_ENTRY/JVM_ENTRY 宏 | Class.c + String.c 所有 native 方法 |
| **14-zip-jimage** | ClassLoader.defineClass1 — find + define 完整环 | ClassLoader.c:136 |
| **00-System-Arraycopy** | Object.hashCode, System.identityHashCode 共享 JVM_IHashCode | Object.c:43, System.c:56 |
| **03-object-model** | markOop, StringTable in metaspace | ConcurrentHashTable lock-free intern |

## §九 ADDITIONAL PROHIBITIONS（≥8）

- ❌ 只说 forName 是 native 不做 caller-classloader 分析——OSGi CNFE #1 根源
- ❌ 不解释 VerifyFixClassname 的 "/" 检测——防止 tool-generated bytecode 的格式错误
- ❌ 忽略 VerifyClassname 的 null byte 注入防御——`"java.lang.Object\0evil"` 的 C string 截断攻击
- ❌ 不说 StringTable 在 metaspace 而非 Java heap——GC root deletion 导致 intern string 永久存活
- ❌ 遗漏 String.intern 的 lock-free CAS 实现——ConcurrentHashTable 的 O(1) 平均查找
- ❌ 不分析 Class.forName 的 initialize 语义——`<clinit>` 可能触发死锁（两个类互相 forName）
- ❌ 不做 Class.getName 的 array class name 转换——`[Ljava.lang.String;` → `java.lang.String[]`
- ❌ 不做 man 手册引用——man 3 GetStringUTFRegion（JNI string 转换）、man 7 signal（null byte 安全问题）、JNI spec（RegisterNatives）
