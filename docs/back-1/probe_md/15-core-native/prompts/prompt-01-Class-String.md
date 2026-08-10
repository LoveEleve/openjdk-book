# PROMPT: 请撰写 01-Class-String.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

`ClassNotFoundException: com.example.Foo` in OSGi environment. `Class.forName("com.example.Foo")` compiles and `Foo.class` exists in the classpath — yet it fails.

Root cause: `Class.forName0` at Class.c:98 calls `JVM_FindClassFromCaller(env, clname, initialize, loader, caller)` at Class.c:137. The `caller` parameter is the **caller's Class object** — the JVM uses the CALLER's classloader, not the current thread's context classloader. In OSGi, each bundle has its own PrivateClassLoader with restricted visibility. The calling code's bundle classloader may not export `com.example.Foo` even though Foo exists in another bundle's classloader. `forName` resolves against the CALLER's bundle → Foo is not exported from that bundle → CNFE.

This is OSGi ClassNotFoundException #1 root cause: developers assume `Class.forName` uses the context classloader (which in OSGi is typically the bootstrap/osgi framework loader and CAN see exported packages). It doesn't — it uses the lexical caller's loader. The subtle distinction: `Class.forName("Foo")` resolves `Foo` in the lexical scope of wherever that line of code compiles, not in the runtime deployment environment.

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认调用者的 classloader
jcmd <pid> VM.class_hierarchy | grep com.example.Foo
# 如果 Foo 已加载 → 显示 Foo 的 loader; 如果未加载 → 查看调用者 bundle 的 loader

# 2. 验证 caller 的 classloader 能否看到 Foo
# 在 JVM 启动时添加: -XX:+TraceClassLoading -XX:+TraceClassResolution
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

**反事实**：如果 `forName0` 使用了 context classloader 而非 caller 的 classloader → OSGi 环境中 context classloader 通常设置为启动类加载器，能看见所有 exported 包 → Foo 能找到。但这也意味着任意代码可以通过 `Class.forName("sun.misc.Unsafe")` 加载 JDK 内部类（caller 是 RestrictedBundleLoader 但 context loader 是 BootstrapLoader）→ 安全边界破坏。HotSpot 团队选择 **lexical security**（调用栈中最近的代码决定可用类）而非 **runtime convenience**（谁设了 context loader 谁说了算）。这是 JVM 沙盒安全模型的基础。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the reflection native bridge (`Class.forName0`, `Class.isAssignableFrom`, `Class.isInstance`) and the string interning native path (`String.intern`). This is the Warm tier of libjava.so — methods called 10⁶–10⁸ times daily that link Java's reflection API to the JVM's internal class resolution system and metaspace-based StringTable.

Reader completed **09-native-interface** (JNI_ENTRY/JVM_ENTRY macros, JNI parameter marshalling), **03-object-model** (markOop), **05-jit-compiler** (C2 intrinsics). This doc: **how the most-called native methods actually work** — how Class.forName and String.intern function from VerifyClassname sanitization to JVM_FindClassFromCaller's caller-classloader resolution, and from JVM_InternString to ConcurrentHashTable's lock-free intern path.

前置: [00-System-Arraycopy] (arraycopy dispatch mechanism), [02-class-loading] (FindClass chain), [14-zip-jimage] (ClassLoader bridge)

### Interview Story Format Answer（必须出现在 §一 末尾）

"`Class.forName0` at Class.c:98 calls `JVM_FindClassFromCaller` at Class.c:137 — the JVM resolves the class name in the **caller's** classloader, not the current thread's context classloader. This is by design: it follows lexical scoping — `Class.forName('Foo')` in your code should resolve `Foo` in YOUR bundle/package context, not in whatever context some framework installed on the thread. The native implementation first validates the classname with `VerifyClassname` (Class.c:132, catches null-bytes and malformed names), then delegates to `find_class_from_class_loader` in jvm.cpp:795 which resolves caller's protection domain and inserts the class into the system dictionary. `Class.getName0` converts internal binary names (`java/lang/Object`) to Java dotted names (`java.lang.Object`). `String.intern` at String.c:32 is a single-line delegate to `JVM_InternString` which calls `StringTable::intern()` — a `ConcurrentHashTable<StringTableConfig>` in metaspace (native memory) with lock-free reads and CAS-based writes. Counterfactual: if StringTable lived in Java heap, every intern would need 3 JNI crossings (lookup→insert→return) at ~50ns each = ~150ns. Metaspace: CAS atomic ~10ns → 15x faster. Float.floatToRawIntBits at Float.c:49-56 is pure C union reinterpretation — zero JVM calls, zero computation, C2 intrinsifies it to nothing (same register, different type interpretation)."

### Beginner Callout Boxes（文档中必须出现的 6 个 callout 框）

1. **JNI_ENTRY vs JVM_ENTRY**: `JNI_ENTRY` = enter native from Java code — slow path, JNIEnv wrapping of oop→jobject, safepoint check. `JVM_ENTRY` = JVM internal entry — fast path, direct oop access, no JNI marshalling. `JVM_LEAF` = no safepoint check for pure functions like `nanoTime`. Class.c:98 uses `JNIEXPORT` (JNI convention) but internally calls `JVM_FindClassFromCaller` (JVM_ENTRY). Source: `src/hotspot/share/prims/jvm.cpp`.

2. **StringTable**: A `ConcurrentHashTable<StringTableConfig>` stored in metaspace (native memory, not Java heap). Stores every interned string as a `weakHandle` — the string is a GC root, never collected as long as the table entry exists. Lock-free on reads (no CAS required for lookup), CAS-based on writes (insert only if not present). Average O(1) lookup, ~10ns per intern call. Source: `src/hotspot/share/classfile/stringTable.cpp`.

3. **Caller ClassLoader**: `Class.forName` uses the CALLER's classloader — determined by the `caller` parameter passed from Java's `Class.forName0()` via `Reflection.getCallerClass()`. NOT the current thread's `Thread.getContextClassLoader()`. This follows lexical scoping: the class loading environment is determined by WHERE the code compiles, not WHO runs the current thread. Source: Class.c:137 — JVM_FindClassFromCaller.

4. **C union**: Float.c:49-56 uses `union { int i; float f; }` to reinterpret the same 32 bits as int vs float. Java has no union type — this is a C-language-only operation. The CPU does nothing: the 32 bits stay in the same register, only the interpretation changes. C2 intrinsifies this to `MoveF2INode` — no code generation, just a type change in the compiler's IR graph.

5. **VerifyClassname**: Class.c:41 declares `extern jboolean VerifyClassname(char *utf_name, jboolean arrayAllowed)`. Called at Class.c:132 before invoking JVM_FindClassFromCaller. Validates that the class name: (a) contains no null bytes (prevents `java.lang.String\0evil` injection), (b) uses valid Java identifier characters, and (c) follows the slashed binary name format (`com/example/Foo`). Returns JNI_FALSE for invalid names → throws ClassNotFoundException.

6. **intrinsic (JIT 内联化)**: C2 compiler replaces certain native method calls with direct CPU instructions at compile time — bypassing JNI overhead entirely. Float.floatToRawIntBits → native JNI call (~50ns) OR C2 intrinsic → register move (~0.5ns). 100x faster. System.arraycopy → native memmove OR C2 intrinsic → REP MOVS (vectorized x86 copy). C2 recognizes ~200 intrinsic methods. If a method is NOT intrinsified (e.g., on a cold path), the native JNI fallback is used.

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots:
- `src/java.base/share/native/libjava/` — Class.c (187 lines), String.c (44 lines), Float.c (57 lines)
- `src/hotspot/share/prims/jvm.cpp` — JVM_FindClassFromCaller (:795-823), JVM_InternString (:3542)
- `src/hotspot/share/classfile/stringTable.cpp` — `StringTable::intern()` implementation
- `src/hotspot/share/classfile/systemDictionary.cpp` — `find_class_from_class_loader()` — resolves class in caller's loader
- `src/hotspot/share/classfile/classLoaderData.cpp` — ClassLoaderData::add_class()

Build: `make jdk`

Key binary: `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjava.so` — Class.c + String.c compiled

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **Class.c** | `src/java.base/share/native/libjava/Class.c` | 187 | `forName0`(:98, →JVM_FindClassFromCaller at :137), `isAssignableFrom`(:156, →JNI IsAssignableFrom at :162), `isInstance`(:147, →JNI IsInstanceOf at :152), `getPrimitiveClass`(:166, →JVM_FindPrimitiveClass) | 🟡 Warm — reflection native bridge |
| 2 | **String.c** | `src/java.base/share/native/libjava/String.c` | 44 | `intern`(:30-33, single-line delegate to JVM_InternString) | 🟡 Warm — string interning |
| 3 | **jvm.cpp** | `src/hotspot/share/prims/jvm.cpp` | ~3600 | `JVM_FindClassFromCaller`(:795-823), `JVM_InternString`(:3542) | JVM internal entry — class resolution + string interning |
| 4 | **Float.c** | `src/java.base/share/native/libjava/Float.c` | 57 | `floatToRawIntBits`(:49, C union), `intBitsToFloat`(:39, C union) | 🟢 Cool — pure C, zero JVM calls |
| 5 | **stringTable.cpp** | `src/hotspot/share/classfile/stringTable.cpp` | ~600 | `StringTable::intern()` — `ConcurrentHashTable` lookup + CAS insert | Interned string storage — metaspace, lock-free |
| 6 | **systemDictionary.cpp** | `src/hotspot/share/classfile/systemDictionary.cpp` | ~2000 | `find_class_from_class_loader()` — resolves class in caller's loader, inserts into system dictionary | Class resolution — called by JVM_FindClassFromCaller |

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ Class.forName0 — caller classloader resolution

```
问题：
  ① forName0 (Class.c:98-144) 的完整参数链是什么？
      答案方向: Class.c:98 签名: forName0(env, this, classname, initialize, loader, caller)
        - classname: jstring → GetStringUTFRegion 转换为 UTF-8 C string (Class.c:123)
        - initialize: jboolean → 是否执行 <clinit> (static initializer)
        - loader: jobject → 指定的 classloader (或 NULL = bootstrap loader)
        - caller: jclass → 调用者的 Class 对象（由 Java 层 Reflection.getCallerClass() 提供）
      验证步骤:
        1. VerifyFixClassname (Class.c:125) — 检测 name 中的 "/" → 如果存在，拒绝
           （Java 层 forName 应使用 "." 格式，但 native 接收 slashed name）
        2. VerifyClassname (Class.c:132) — 检测 null 字节 + 非法字符
        3. JVM_FindClassFromCaller (Class.c:137) — 在 caller 的 classloader 中查找
      
      追问: 为什么要两次验证（VerifyFixClassname + VerifyClassname）？
      → VerifyFixClassname 检查 name 中是否有 "/" —— Java 层的 forName 应该用 "."
        格式，但某些工具（如 ASM, ByteBuddy）直接调用 forName0 → 传入 slashed name
        → VerifyFixClassname 拒绝。VerifyClassname 检查更基础的安全：null-byte,
        超长 name, 非法 UTF-8 字符。两层防御：语义正确性 + 安全边界。

  ② Counterfactual: 如果 forName 使用 context classloader 而非 caller 的？
      答案方向: OSGi 环境中，context classloader 通常设为 bootstrap/osgi framework 
      loader → 能看到所有 exported 包 → forName("com.example.Foo") 成功。但在 RPC 
      框架中 (ServerSocket 线程 pool 中 context loader = bootstrap → 能加载 
      "sun.reflect.Reflection" → 绕过 `@CallerSensitive` 安全检查。Caller-classloader
      方案保证：调用栈中最接近的代码决定可用类 → 符合 Java 栈内省安全模型。
      源码: Class.c:137 → JVM_FindClassFromCaller(env, clname, initialize, loader, caller)
      caller 参数来自 Java 层 `Reflection.getCallerClass()` 的结果。
```

### 4.2 ★★★ VerifyClassname — security sanitization

```
问题：
  ① VerifyClassname (Class.c:41 extern, 定义于 classloader/check_class_name.cpp) 检查什么？
      答案方向: 三大类检查:
        1. Null byte injection: 拒绝包含 '\0' 的 name ("java.lang.Object\0evil")。
           为什么关键: C string 以 '\0' 为终止符。JVM_FindClassFromCaller 使用 
           C string → "java.lang.Object\0evil" 在 C 层看起来就是 "java.lang.Object" →
           绕过 classname 限制 → 加载任意类。
        2. UTF-8 validity: 拒绝非法的 UTF-8 字节序列 → 防止通过畸形 UTF-8 构造
           意外的代码点（surrogate half, invalid continuation byte）。
        3. Identifier check: 每个 name component 必须是有效 Java identifier。
      
      追问: arrayAllowed 参数的含义？
      → JNI_TRUE: 允许 classname 以 '[' 开头（数组类名，如 "[Ljava.lang.String;"）。
        JNI_FALSE: 禁止数组语法。forName0 传入 JNI_TRUE —— 允许 "[[I" 用 forName 创建多维数组。

  ② Counterfactual: 如果 VerifyClassname 被跳过（no sanitization）？
      答案方向: 恶意代码可传入 "java.lang.String\0attack" → JVM_FindClassFromCaller 
      只看到 "java.lang.String" → 返回 String.class → 但上层 Java 代码期望的是 
      "attack" 类 → 类型混乱。或者传入 "com/example/Foo" (slashed name, JNI_TRUE 
      arrayAllowed) → JVM_FindClassFromCaller 在当前类路径中查找 slashed name → 
      按 JVM spec 应拒绝（forName 必须用 "." 格式）但某些历史 JVM 版本接受 slashed 
      name → 隐藏的双重 parse path 安全问题。VerifyClassname 在 JVM 边界强制统一格式。
```

### 4.3 ★★★ String.intern — metaspace ConcurrentHashTable

```
问题：
  ① String.c:32 的 intern 如何到达 StringTable？
      答案方向: String.c:30-33 — 全文件中最短的 native 方法 (4 lines):
        JNIEXPORT jobject JNICALL
        Java_java_lang_String_intern(JNIEnv *env, jobject this) {
            return JVM_InternString(env, this);
        }
      JVM_InternString (jvm.cpp:3542) → StringTable::intern() →
        1. 计算 hash (StringTable::hash_string — same as String.hashCode())
        2. 在 ConcurrentHashTable 中搜索 hash bucket
        3. 如果找到匹配 (same string content via equals) → 返回 existing entry
        4. 如果未找到 → CAS 插入 new entry → 返回 new entry
      锁策略: lookup 是 lock-free (只读), insert 是 CAS (无锁写, 但可能重试)。
      
      追问: StringTable 为什么在 metaspace 而非 Java heap？
      → §二.4 from README: 如果 StringTable 在 Java heap → 每次 intern 需要
        3 次 JNI 穿越 (lookup→insert→return) × 50ns/次 = 150ns。
        在 metaspace: CAS ~10ns → 15x faster。
        intern 的热路径需要 JVM 内部级别的延迟 → metaspace 直接访问。

  ② Counterfactual: 如果 intern 是纯 Java 实现 (WeakHashMap<String,String>)？
      答案方向: 
        - 每次 intern 创建 new String 对象（即使已存在）→ GC overhead 1-5%
        - WeakHashMap 的 get/put 都需要 hashCode() 计算 → 对 intern 的字符串
          计算 hash 不是免费的 → 字符串的 hash 是 lazy cache 在 String.value 中的 int field
          → 但 WeakHashMap 中不缓存 hash → 每次 lookup 计算 hash ~50ns
        - ConcurrentHashTable 在 metaspace → CAS 操作 ~10ns → 5x faster
        - ConcurrentHashMap in Java 用分段锁 → contention on hash bucket
        - 结论: native 实现性能优势 ~15x-50x (取决于 contention level)
```

### 4.4 ★★★ Class.isAssignableFrom — JNI type hierarchy check

```
问题：
  ① isAssignableFrom (Class.c:156-163) 的 JNI 调用是什么？
      答案方向: Class.c:162 → (*env)->IsAssignableFrom(env, cls2, cls)
      JNI IsAssignableFrom 检查 cls2 (子类 candidate) 是否能赋值给 cls (父类 target)。
      等价于 Java: cls.isAssignableFrom(cls2) ←→ cls2 extends cls 或 implements cls。
      内部: JVM 读取两者的 Klass* → 遍历 cls2 的 super type hierarchy → 
      查找 cls 是否在 hierarchy 中。如果是接口检查 → 遍历 cls2 的所有 interfaces
      及其 transitive supers。
      
      追问: 为什么 isAssignableFrom 是 native 而非 Java？
      → 需要访问 Klass* 的 super hierarchy + interface table —— 这些是 JVM 内部
        数据结构 (存储在 Klass 的 vtable + itable 中)。Java 代码无法遍历 Klass* 
        的 C++ 指针链。JVM 在 native 层用 Klass::is_subtype_of() 虚函数做快速
        subtype 检查 (缓存了 secondary super types 在 klass 的数组中)。

  ② Counterfactual: 如果 isAssignableFrom 是 Java 实现（用 getSuperclass() + getInterfaces() 循环）？
      答案方向: `for (Class<?> c = cls2; c != null; c = c.getSuperclass())` 循环 
      每次迭代需要一次 JNI GetSuperclass 调用 + 一次 JNI GetObjectClass → 每次迭代
      ~100ns JNI overhead。在深度 10 的 hierarchy 中 ~1µs。JNI IsAssignableFrom 一次
      调用 ~50ns (包括 Klass 虚函数 dispatch)。对于 JIT 编译器 (每秒数百万 subtype 
      检查) → 20x faster in native。实际上 C2 调用 subtype_check IR node 直接走 
      Klass::is_subtype_of 而非 JNI call。
```

### 4.5 ★★★ Class.getName0 — binary name conversion

```
问题：
  ① Class.getName0 如何做 name 格式转换？
      答案方向: getName0 (Class.c:168-183, via RegisterNatives) → 调用 JVM_GetClassName
      (jvm.cpp:598-606)。JVM 内部: 读取 Klass::external_name() → 将内部 binary 
      name "java/lang/Object" 转换为 "java.lang.Object" (替换 '/' 为 '.')。
      对于数组类: "[Ljava/lang/String;" → "java.lang.String[]" (复杂重写规则)。
      对于 primitive 类: "I" → "int", "J" → "long"。
      
      追问: 为什么不在 Java 层做转换 (String.replace('/','.'))？
      → 因为 Class 对象本身是 native 数据结构 (klassOop) → 读取 class name 需要
        访问 native Klass* 的 symbol → 必须走 JNI/JVM。转换本身可以在 Java 做——
        但既然已经穿透 native 读取 name → 自然在 native 完成转换，避免多一次
        JNI 调用做 String.replace。

  ② Counterfactual: 如果 className 返回 raw binary name ("java/lang/Object")？
      答案方向: Java 代码中 class.getSimpleName() + class.getPackage() + 
      Class.forName 都期望 "." 格式 → 传入 raw binary name → forName 失败
      (VerifyFixClassname 拒绝 "/") → 用户代码 getSimpleName() 返回 "java/lang/Object"
      而非 "Object" → 整个 Java 反射生态崩溃。Binary→Java name 转换是 JVM spec
      要求的标准化格式变换——不是设计选择，是 Java SE spec §4.2.1 强制要求。
```

### 4.6 ★★★ Float.floatToRawIntBits — pure C, zero JVM

```
问题：
  ① Float.floatToRawIntBits (Float.c:49-56) 为什么不需要任何 JVM 调用？
      答案方向: 这是所有 libjava.so native 方法中最独特的一个——它不调用 JVM_* 函数，
      不使用 JNI (除了参数接收)，不访问 Java heap。完整源码:
        union { int i; float f; } u;
        u.f = (float)v;
        return (jint)u.i;
      这 3 行完成了 100% 的工作。CPU 层面: 32-bit 浮点值在 XMM 寄存器中 → 
      `movd` 指令 copy 到通用寄存器 → 返回。零 cycle 计算开销 (1 cycle 寄存器复制)。
      C2 进一步 intrinsify 为 MoveF2INode → 在 IR 图中只是一个类型标注变换 → 
      生成零汇编代码。这是 C union 对 Java 类型系统的最直观补充。
      
      追问: 为什么不是 Float.floatToIntBits（纯 Java 方法）而是 raw variant？
      → floatToIntBits 额外做了 NaN canonicalization: 所有 NaN 变体 (0x7fc00000,
        0x7fc00001, ..., 0x7fffffff) 折叠为单一规范 NaN 0x7fc00000。
        这个操作可以用 Java 的 Float.intBitsToFloat + Float.floatToRawIntBits 组合
        实现。raw variant 需要 C union 获取原始 bits → 不可替代的 native 需求。
```

---

## §五 Article Structure

```
§〇 生产场景 — ClassNotFoundException: OSGi caller classloader vs context classloader
  ★ 真实错误: ClassNotFoundException: com/example/Foo
  ★ Root cause: forName0 使用 CALLER 的 classloader (lexical scope), 不是 context loader
  ★ 三步诊断: jcmd VM.class_hierarchy → TraceClassLoading → GDB Class.c:137
  ★ 反事实: 使用 context loader → 安全边界破坏

§一 ★★★ Class.forName + String.intern 全链路源码走读
  ❓ forName0 的 caller-classloader 陷阱——OSGi #1 故障根因
  ❓ String.intern 在 metaspace 中 — 为什么不在 Java heap
  1.1 forName0 参数协议 (Class.c:98) — classname, initialize, loader, caller
  1.2 VerifyFixClassname (Class.c:125) — "/" 格式检测
  1.3 VerifyClassname (Class.c:41 extern, :132 call) — null byte + UTF-8 + identifier 验证
  1.4 JVM_FindClassFromCaller (Class.c:137 → jvm.cpp:795-823)
      ├─ TempNewSymbol name → find_class_from_class_loader
      └─ caller protection domain resolution
  1.5 isAssignableFrom (Class.c:156-163) — JNI IsAssignableFrom → Klass::is_subtype_of
  1.6 String.intern (String.c:30-33) → JVM_InternString → StringTable::intern()
  1.7 StringTable::intern() — ConcurrentHashTable + lock-free lookup + CAS insert
  1.8 Class.getName0 — binary name → dotted name ("java/lang/Object" → "java.lang.Object")
  1.9 Float.floatToRawIntBits (Float.c:49-56) — C union, zero JVM calls
  1.10 ★ Mermaid: forName → class resolution + String intern paths
       Lanes: Java / Native libjava / JVM Core / System Dictionary / StringTable
  1.11 ★ 面试 Story Format 答案 — forName + intern 的完整叙事
        "Class.forName 为什么在 OSGi 中失败" + "String.intern 的 15x 性能优势"

§二 ★★★ 6 Beginner Callout 框
  2.1 JNI_ENTRY / JVM_ENTRY (entry point macros)
  2.2 StringTable (metaspace ConcurrentHashTable)
  2.3 Caller ClassLoader (lexical scope principle)
  2.4 C union (Float.c zero-cost reinterpretation)
  2.5 VerifyClassname (null byte injection prevention)
  2.6 intrinsic (C2 JIT intrinsic elimination of JNI overhead)

§三 ★★ 调用者 ClassLoader 安全性剖析
  ❓ lexical scope vs context classloader — 为什么 JVM 选前者
  ❓ 什么场景需要 context classloader 反而更重要
  3.1 Caller-classloader 的安全保证 — 栈内省 (stack introspection)
  3.2 Context-classloader 的实用性 — OSGi/JPMS 的跨 bundle 加载
  3.3 Class.forName vs ClassLoader.loadClass — 不同入口，不同语义

§四 ★ GDB 断点验证 — 6 断点完整 forName + intern trace
  断言 1: Class.c:137 JVM_FindClassFromCaller — verify classname + caller
  断言 2: Class.c:132 VerifyClassname — verify no null bytes in name
  断言 3: Class.c:162 JNI IsAssignableFrom — verify subtype check
  断言 4: String.c:32 JVM_InternString — verify single-line delegate
  断言 5: jvm.cpp:3542 JVM_InternString — verify hash table intern
  断言 6: Float.c:49 floatToRawIntBits union — verify no JVM call path

§五 ★ Cross-Reference
  ❓ 02-class-loading — find_class_from_class_loader → system dictionary
  ❓ 09-native-interface — JNI_ENTRY/JVM_ENTRY 宏，Class.c + String.c 使用
  ❓ 14-zip-jimage — ClassLoader.defineClass1 (ClassLoader.c) 与本 phase 的 class loading bridge
  ❓ 00-System-Arraycopy — Object.hashCode, System.identityHashCode (same phase, hot path)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because OSGi bundles each have their own PrivateClassLoader and `Class.forName` uses the caller's classloader (not the context classloader)..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from Class.c / String.c / Float.c / jvm.cpp, do not describe it.

3. **Mermaid** — forName + intern dual-path sequence diagram. 5 lanes: Java / Native libjava / JVM Core / System Dictionary / StringTable. Complete flow: `Class.forName("com.example.Foo")` → `forName0` → `VerifyClassname` → `JVM_FindClassFromCaller` → `find_class_from_class_loader` → system dictionary insert. Parallel: `"hello".intern()` → `String.intern` → `JVM_InternString` → `StringTable::intern()` → `ConcurrentHashTable` → CAS insert. Annotate every step with file:line.

4. **GDB session** — 6 breakpoints with exact file:line numbers:
   - `Class.c:137` JVM_FindClassFromCaller — verify classname, caller, loader
   - `Class.c:132` VerifyClassname — inspect clname for null bytes
   - `Class.c:162` IsAssignableFrom JNI — verify cls2 subtype of cls
   - `String.c:32` JVM_InternString delegate — verify single function call
   - `jvm.cpp:3542` JVM_InternString entry — verify StringTable invocation
   - `Float.c:49` floatToRawIntBits — verify no call instructions
   Each with expected variable values to verify.

5. **6 Beginner callout boxes** — exact text from §一: JNI_ENTRY/JVM_ENTRY, StringTable, Caller ClassLoader, C union, VerifyClassname, intrinsic

6. **Cross-reference at three points**:
   - At `JVM_FindClassFromCaller` → "→ 02-class-loading: find_class_from_class_loader inserts into system dictionary"
   - At `String.intern` → "→ 03-object-model: strings are objects with markOop header"
   - At `Class.forName0` → "→ 14-zip-jimage: this is where .class bytes arrive before defineClass1"

7. **Story-format interview answer** — at §一末尾: "Class.forName 为什么在 OSGi 中失败？" 叙事 + "String.intern 为什么 15x faster than Java dictionary". Two-part story: caller-classloader trap + metaspace hash table advantage.

---

## §七 Output Format

- Markdown file, named `01-Class-String.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/15-core-native/prompts/`
- 元信息头:

```
> **阶段**：[15-core-native]
> **前置**：[09-native-interface]（JNI_ENTRY/JVM_ENTRY 宏机制）、[03-object-model]（markOop, object header）、[02-class-loading]（FindClass, system dictionary, class loader hierarchy）
> **配套**：[00-System-Arraycopy]（System.c + Object.c Hot 路径）、[02-Runtime-Throwable]（Runtime.gc, fillInStackTrace）、[03-JNI-Utility]（jni_util.c 工具层）
> **后续依赖本文**：[16-nio-network]（Class.forName 的 class resolution 是所有 Java 代码运行的基础）
> **阅读收益**：追踪 Class.forName0 从 Java 到 native 的完整 7 步调用链——理解 forName0 的 caller-classloader 陷阱（OSGi CNFE #1 根源）、VerifyClassname 的 null byte 注入防御、String.intern 在 metaspace StringTable 中的 lock-free CAS 实现（15x faster than Java heap dictionary）、Class.isAssignableFrom 的 JNI subtype check、Float.floatToRawIntBits 的纯 C union 零开销重解释
```

- 目标行数: 350+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说 "forName loads a class" 而不展示 caller-classloader 的语义 — 必须展示 forName0 的 caller 参数来源 + 与 context classloader 的区别
- ❌ 不解释 VerifyClassname 的 null byte 检查 — 必须展示 "java.lang.Object\0evil" 注入攻击向量
- ❌ 忽略 OSGi/JPMS 的 caller-classloader 陷阱 — 必须展示 Lexical scope 安全原理 + OSGi 故障模式
- ❌ 不解释 StringTable 为什么在 metaspace 而非 Java heap — 必须展示 3 JNI crossing vs CAS atomic 的延迟对比
- ❌ 不展示 String.intern 的 4 行源码 — 必须完整粘贴 String.c:30-33
- ❌ 忽略 isAssignableFrom 的 subtype check 机制 — 必须展示 JNI IsAssignableFrom → Klass::is_subtype_of
- ❌ 不对 getName0 做 binary→Java name 转换说明 — 必须展示 "java/lang/Object" → "java.lang.Object" 的格式变换是 JVM spec 要求
- ❌ 不展示 Float.floatToRawIntBits 的 union 源码 — 必须粘贴 Float.c:49-56 完整 union 实现
- ❌ 不做 GDB 断点 trace — 至少 6 个断点覆盖 forName0 → intern → floatToRawIntBits
- ❌ 不要解释 C 语言基础

---

## §九 Required（≥8）

- ✅ **★ Mermaid forName + intern 双路径序列图** — 5 lanes: Java / Native / JVM Core / System Dictionary / StringTable — forName0 → VerifyClassname → JVM_FindClassFromCaller → find_class_from_class_loader; parallel: String.intern → JVM_InternString → StringTable::intern → CAS
- ✅ **★ forName0 完整源码展示** — Class.c:98-144 的完整实现（包括 VerifyClassname + memory allocation + JVM_FindClassFromCaller）
- ✅ **★ VerifyClassname null byte 检测解释** — 安全边界关键：C 层 name truncation 攻击
- ✅ **★ String.intern 最短 native 方法源码** — String.c:30-33 4 行完整展示
- ✅ **★ Counterfactual: context classloader vs caller classloader** — OSGi 安全边界 + 两种 loader 的输出对比表
- ✅ **★ 6 Beginner Callout 框** — exact text from §一: JNI_ENTRY/JVM_ENTRY, StringTable, Caller ClassLoader, C union, VerifyClassname, intrinsic
- ✅ **★ 面试 Story Format 答案** — §一末尾，"为什么 OSGi 中 Class.forName 失败" + "String.intern 为什么 15x faster"
- ✅ **★ GDB 断点 ≥6 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ Float.floatToRawIntBits union 源码** — Float.c:49-56 完整粘贴 + 零 JVM call 验证
- ✅ **★ 交叉引用** — 02-class-loading (find_class_from_class_loader), 09-native-interface (JNI_ENTRY macros), 14-zip-jimage (ClassLoader.defineClass1)

---

## §十 GDB Verification（≥6 assertions）

```
断言 1: forName0 调用 JVM_FindClassFromCaller (Class.c:137)
  (gdb) break Class.c:137
  (gdb) print clname → 期望: 类名 (例如 "com/example/Foo")
  (gdb) print initialize → 期望: JNI_TRUE 或 JNI_FALSE
  (gdb) print loader → 期望: jobject (NULL = bootstrap, 非NULL = custom loader)
  (gdb) print caller → 期望: 调用者的 jclass
  (gdb) continue
  (gdb) print cls → 期望: 返回的 jclass (非 NULL = 成功) 或 NULL (CNFE)

断言 2: VerifyClassname 验证 (Class.c:132)
  (gdb) break Class.c:132
  运行: java -cp app.jar com.example.Main (with bad classname if testing)
  (gdb) print clname → 期望: 类名字符串
  (gdb) continue
  (gdb) print → 检查是否进入 goto done (验证失败)
  正常情况: VerifyClassname returns JNI_TRUE → 继续到 line 137

断言 3: JNI IsAssignableFrom (Class.c:162)
  (gdb) break Class.c:162
  (gdb) print cls2 → 期望: 子类 jclass
  (gdb) print cls → 期望: 父类 jclass
  (gdb) continue
  (gdb) print result → 期望: JNI_TRUE (如果是子类型) 或 JNI_FALSE

断言 4: String.intern → JVM_InternString (String.c:32)
  (gdb) break String.c:32
  (gdb) print this → 期望: 要 intern 的 jstring
  (gdb) continue 进入 JVM_InternString
  (gdb) print str → 期望: 与 this 相同的字符串

断言 5: JVM_InternString → StringTable::intern (jvm.cpp:3542)
  (gdb) break jvm.cpp:3542
  (gdb) print str → 期望: jstring 对象
  (gdb) continue 进入 StringTable intern
  (gdb) print result → 期望: 返回的 jstring (已存在于 table 或新插入)

断言 6: Float.floatToRawIntBits (Float.c:49)
  (gdb) break Float.c:49
  (gdb) print v → 期望: 浮点值 (例如 3.14159f)
  (gdb) continue 经过 union 赋值
  (gdb) print u.i → 期望: IEEE 754 32-bit int 表示
  (gdb) disas → 期望: 无 call 指令 (pure computation, no JVM interaction)
```

---

## §十一 与 README 和同组 prompt 的连续性

1. **全部 4 文档共享 §一 开头语**: "Reader completed 09-native-interface (JNI), 03-object-model (markOop), 05-jit-compiler (C2 intrinsics). This doc: how the most-called native methods actually work."

2. **从 README §二.4 + §五.6 承接**：本文展开 String.intern → StringTable → metaspace 的完整实现。Coverage: Warm tier (Class.forName, String.intern) + Cool tier (Float.floatToRawIntBits).

3. **同组边界**: 00 覆盖 System.c + Object.c Hot 路径；01 覆盖 Class.c + String.c Warm 路径；02 覆盖 Runtime.c + Throwable.c；03 覆盖 jni_util.c 工具层。

4. **后置链接**: 02-class-loading 的 find_class_from_class_loader 由本文的 JVM_FindClassFromCaller 调用；14-zip-jimage 的 ClassLoader.defineClass1 在 forName 后接收 byte[] 定义类。
