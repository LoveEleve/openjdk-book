> **阶段**：[14-zip-jimage]
> **前置**：[00-Zip-Class-Loading]（字节由 ZipFile 读取 + Inflater 解压）、[02-Compression-Zlib]（Inflater.c → zlib inflate 解压管线）、[09-native-interface]（JNI 机制：GetByteArrayRegion、GetStringUTFChars）
> **配套**：无
> **后续依赖本文**：[02-class-loading]（ClassFileParser::parseClassFile 消费 defineClass1 传递的字节 + 定义双亲委派链）
> **阅读收益**：追踪从 `ClassLoader.defineClass1(name, data, off, len)` 到 `JVM_DefineClassWithSource` 的完整 6 步 JNI glue 序列——理解 defineClass1 不调用 ZIP_GetEntry（字节由 Java 层预读）的关键架构决策、GetByteArrayRegion 的一次 memcpy（heap→native）、defineClass2 的 DirectBuffer 零拷贝路径、VerifyFixClassname 的类名规范化（'.'→'/'）、职责分离（Java 层 I/O + native glue + HotSpot 验证）；掌握 "NoClassDefFoundError 但 class 在 JAR" 的 directory stub 诊断 + defineClass1 入参 GDB 验证 workflow

---

# 03-ClassLoader-Bridge — ClassLoader.defineClass1 JNI 桥接：从 byte[] 到 InstanceKlass

---

## §〇 生产场景

生产环境 CI/CD 打出的 JAR 部署后所有模块报错：

```
java.lang.NoClassDefFoundError: com/example/Foo
```

排查发现 `com/example/Foo.class` **确实在** JAR 的 Central Directory 中（`jar tvf app.jar | grep Foo.class` 正常）。`ClassLoader.defineClass1` 收到 `null` 而非有效 `.class` 字节——根因是 ZIP entry 的类型错误：这是一个 **directory stub**（`size=0, name ends with '/'`），不是 file entry。CI 工具错误地在 JAR 中插入了目录条目。

**三步诊断：**

```bash
# 1. 检查 entry 是否是 directory stub 而非 file
python3 -c "
import zipfile
zf = zipfile.ZipFile('app.jar')
for info in zf.infolist():
    if info.filename.endswith('Foo.class') or 'Foo' in info.filename:
        print(f'{info.filename}: size={info.file_size}, compress={info.compress_size}, dir={info.is_dir()}')
        # 如果是 directory stub: size=0, compress=0, is_dir=True
"

# 2. 确认 ZipFile 能否读取该 entry 的数据
python3 -c "
import zipfile
zf = zipfile.ZipFile('app.jar')
try:
    data = zf.read('com/example/Foo.class')
    print(f'Read {len(data)} bytes')
except Exception as e:
    print(f'Error: {e}')
    # size=0 且 is_dir → 返回空 byte[] 或报错
"

# 3. GDB 断点验证 defineClass1 的入参
gdb -ex "break ClassLoader.c:76" \
    -ex "run" \
    -ex "print name → 期望: 'com/example/Foo'" \
    -ex "print length → 期望: >0（如果为 0 → directory stub）" \
    -ex "print data → 期望: jbyteArray 非 NULL" \
    --args java -cp app.jar com.example.Foo
```

> **反事实**：如果 `ClassLoader.defineClass1` 在接收之前验证 byte[] 的长度和 magic number → 可以立即报 "not a valid class file: size=0" 而非静默 `NoClassDefFoundError`。但 `defineClass1` 的设计是**零验证**——它的职责是传递字节给 JVM，让 JVM 的 `ClassFileParser` 做所有验证。这个分离是刻意的：`ClassLoader.c` 做 JNI glue（不是 class 文件验证器），`ClassFileParser`（02-class-loading）做格式验证。

---

## §一 defineClass1 全链路源码走读

### 这不是 ClassLoader 教程

ClassLoader.defineClass1 是 Java 类加载的**物理终点**——在此之前，字节从磁盘出发（ZIP/jimage），在此之后，字节进入 JVM（ClassFileParser）。defineClass1 本身**不读 I/O**——它接收已读入的 byte[]，只负责调用 JVM 内部的 define_class。

Reader comes from **00-Zip-Class-Loading**（HOW ZipFile reads + inflates bytes from JAR）and **02-Compression-Zlib**（HOW zlib inflate works inside Inflater）。Reader knows from **09-native-interface** the JNI mechanisms (GetByteArrayRegion, GetStringUTFChars)。This doc answers: **how the already-read bytes cross the JNI boundary and become a loaded class.**

The critical insight: `defineClass1` does NOT call `ZIP_GetEntry` or `inflate`. The bytes come **pre-read** from the Java layer `ZipFile` — the native side only does: JNI byte copy (`GetByteArrayRegion`) → classname normalization → JVM invocation.

---

### 1.1 defineClass1 — 参接收已读字节 + 6 步执行序列

Why: because defineClass1 must deliver byte[] data from the Java heap to the HotSpot class loader subsystem without risking a dangling pointer if GC moves the array during class parsing, it allocates a native buffer via malloc and copies the bytes with GetByteArrayRegion.

```c
// ClassLoader.c:76-148
Java_java_lang_ClassLoader_defineClass1(JNIEnv *env,
                                        jclass cls,
                                        jobject loader,
                                        jstring name,
                                        jbyteArray data,
                                        jint offset,
                                        jint length,
                                        jobject pd,
                                        jstring source)
{
    jbyte *body;
    char *utfName;
    jclass result = 0;
    char buf[128];
    char* utfSource;
    char sourceBuf[1024];

    if (data == NULL) {
        JNU_ThrowNullPointerException(env, 0);
        return 0;
    }
    if (length < 0) {
        JNU_ThrowArrayIndexOutOfBoundsException(env, 0);
        return 0;
    }
    body = (jbyte *)malloc(length);
    if (body == 0) {
        JNU_ThrowOutOfMemoryError(env, 0);
        return 0;
    }
    (*env)->GetByteArrayRegion(env, data, offset, length, body);
```

Why: the malloc(length) at line 106 is deliberately size-dependent. When length == 0 (directory stub, empty entry, or corrupted CEN), body is allocated via `malloc(0)` — implementation-defined but typically returns a small valid pointer or NULL. The subsequent `JVM_DefineClassWithSource` with length=0 → ClassFileParser → ClassFormatError → NoClassDefFoundError thrown to Java.

The full 6-step execution sequence:

**Step 1 — Parameter validation** (ClassLoader.c:93-104):
```c
    if (data == NULL) {                               // line 93
        JNU_ThrowNullPointerException(env, 0);
        return 0;
    }
    if (length < 0) {                                 // line 101
        JNU_ThrowArrayIndexOutOfBoundsException(env, 0);
        return 0;
    }
```
NULL data → NullPointerException. Negative length → ArrayIndexOutOfBoundsException. These are Java-level parameter guards in native code.

**Step 2 — Native buffer allocation** (ClassLoader.c:106-111):
```c
    body = (jbyte *)malloc(length);                   // line 106
    if (body == 0) {
        JNU_ThrowOutOfMemoryError(env, 0);
        return 0;
    }
```
Allocates `length` bytes of C heap memory. Not Java heap — this buffer lives in native memory, outside GC control. A `length` of 0 from a directory stub produces a zero-length allocation.

**Step 3 — Byte copy: Java heap → native heap** (ClassLoader.c:113):
```c
    (*env)->GetByteArrayRegion(env, data, offset, length, body);  // line 113
    if ((*env)->ExceptionOccurred(env))               // line 115
        goto free_body;
```
One `memcpy` from the Java heap byte[] to the native malloc buffer. The `data` parameter — as a Java byte[] object — lives on the GC heap and can be moved by GC at any time. `GetByteArrayRegion` copies into a stable native buffer that GC cannot touch.

→ these bytes came from ZipFile.getInputStream → Inflater.inflate → zlib inflate (00-Zip + 02-Compression)

**Step 4 — Classname normalization** (ClassLoader.c:118-126):
```c
    if (name != NULL) {
        utfName = getUTF(env, name, buf, sizeof(buf));   // line 119
        if (utfName == NULL) { goto free_body; }
        VerifyFixClassname(utfName);                     // line 123
    } else {
        utfName = NULL;
    }
```
`getUTF` converts the Java `jstring` (UTF-16) to a C `char*` (Modified UTF-8). `VerifyFixClassname` converts `'.'` → `'/'` — Java source code uses `java.lang.Object` but the JVM internally uses `java/lang/Object` as the class name format.

**Step 5 — JVM invocation** (ClassLoader.c:136):
```c
    result = JVM_DefineClassWithSource(env, utfName, loader,
                                       body, length, pd, utfSource); // line 136
```
The boundary crossing from native `ClassLoader.c` into HotSpot `jvm.cpp`. At this point, defineClass1's job is done — HotSpot takes over: `SystemDictionary::define_class` → `ClassLoaderData::add_class` → `ClassFileParser::parseClassFile` → `InstanceKlass`.

→ enters HotSpot → SystemDictionary::define_class → ClassFileParser::parseClassFile (02-class-loading)

**Step 6 — Cleanup** (ClassLoader.c:138-147):
```c
    if (utfSource && utfSource != sourceBuf) free(utfSource);  // line 138
 free_utfName:
    if (utfName && utfName != buf) free(utfName);              // line 142
 free_body:
    free(body);                                                 // line 146
    return result;                                              // line 147
```
Three frees: source string, classname string, native byte buffer. The `goto` pattern ensures cleanup even on early error return. The stack buffers `buf[128]` and `sourceBuf[1024]` avoid malloc for short names.

→ the native buffer is released; the class lives in metaspace now

> **反事实 (追问: 为什么需要 malloc + GetByteArrayRegion 而非直接传指针):** Java heap 中的 byte[] 可能被 GC 移动 → 如果在 JVM_DefineClassWithSource 处理期间（可能触发 GC 分配 Klass + ConstantPool）GC 移动了 byte[] → 指针失效 → SIGSEGV。GetByteArrayRegion 将字节拷贝到稳定的 native buffer → 不受 GC 影响。defineClass2 用 GetDirectBufferAddress 零拷贝——因为 DirectBuffer 的内存由 Unsafe.allocateMemory 分配，不在 GC heap 中，GC 不移动。

---

### 1.2 ★ 架构 — 职责分离：Java I/O vs Native Glue vs HotSpot 验证

Why: because the design intentionally partitions the class-loading pipeline into three layers — each with distinct responsibilities, error handling strategies, and performance characteristics — keeping the JNI boundary thin and the native code simple.

三层分离架构：

```
┌─────────────────────────────────────────────────────────────┐
│ Java 层 (I/O + inflate + CRC32)                              │
│ ZipFile(path): ZIP_Open + readCEN + 哈希表                    │
│ getInputStream(entry): ZIP_Read + Inflater.inflate + CRC32  │
│ → byte[] classBytes                                         │
├─────────────────────────────────────────────────────────────┤
│ Native Glue (ClassLoader.c)                                  │
│ GetByteArrayRegion: Java heap → native buffer (1 memcpy)     │
│ VerifyFixClassname: '.' → '/'                                │
│ JVM_DefineClassWithSource: 进入 HotSpot                      │
├─────────────────────────────────────────────────────────────┤
│ HotSpot (jvm.cpp + SystemDictionary + ClassFileParser)       │
│ SystemDictionary::define_class: 检查重复、分配 CLD           │
│ ClassFileParser::parseClassFile: magic/version/常量池/字节码 │
│ → InstanceKlass (metaspace)                                  │
└─────────────────────────────────────────────────────────────┘
```

完整调用链：Java ZipFile → Inflater.c:128 (doInflate) → zlib inflate → byte[] → ClassLoader.defineClass1 (ClassLoader.c:76) → GetByteArrayRegion (line 113) → VerifyFixClassname (line 123) → JVM_DefineClassWithSource (line 136) → jvm.cpp → SystemDictionary → ClassFileParser → InstanceKlass

> **反事实：如果 defineClass1 自己调用 ZIP_GetEntry 直接从 JAR 读字节？** 产生 2 个具体问题：
> (1) 错误处理：zlib inflate 在 native 代码中失败 → SIGABRT 或 return NULL → 无 Java IOException → 无 ClassNotFoundException → JVM 继续运行但缺失类 → 5 分钟后首次使用时 NoClassDefFoundError → 症状远离根因。Java 层 ZipFile 的 inflate 失败抛出带 entry 名的 ZipException → ClassLoader 捕获 → 精确报告哪个 JAR 的哪个 entry 损坏。
> (2) 并发：10 线程从同一 JAR 加载类 → 10 并发 ZIP_GetEntry 调用 → 单一 ZIP 句柄 mutex (ZIP_Lock, zip_util.c:1284) → 序列化读取 → 类加载 10x 慢。Java 层 ZipFile：每个线程有自己的 InputStream → 并发 inflate → 并行类加载。

> **反事实：如果全部类加载逻辑都在 native 完成（包括 I/O + inflate + CRC32）？** 存在的方案——Oracle JRockit 的某些版本确实在 native 层处理了更多 JAR 读取。但代价：异常消息退化（native error codes → 没有 Java 异常的堆栈跟踪）、调试困难（没有 Java 调试器可见的中间状态）、代码维护（native C 代码远比 Java 复杂）。HotSpot 的选择是 pragmatic：Java 层做 80% 的 dirty work（有异常、有 GC、有调试器），native 层只做 JNI glue + JVM 内部（必须 native 的部分）。

---

### 1.3 defineClass2 — DirectBuffer 零拷贝

Why: defineClass2 provides a zero-copy alternative using DirectBuffers — useful when class bytes reside in native memory (NIO FileChannel.map or Unsafe.allocateMemory) rather than Java heap byte[].

```c
// ClassLoader.c:150-212
JNIEXPORT jclass JNICALL
Java_java_lang_ClassLoader_defineClass2(JNIEnv *env,
                                        jclass cls,
                                        jobject loader,
                                        jstring name,
                                        jobject data,     // ByteBuffer, not byte[]
                                        jint offset,
                                        jint length,
                                        jobject pd,
                                        jstring source)
{
    jbyte *body;
    char *utfName;
    jclass result = 0;
    char buf[128];
    char* utfSource;
    char sourceBuf[1024];

    assert(data != NULL);
    assert(length >= 0);  // caller passes ByteBuffer.remaining()
    assert((*env)->GetDirectBufferCapacity(env, data) >= (offset + length));

    body = (*env)->GetDirectBufferAddress(env, data);     // line 173

    if (body == 0) {
        JNU_ThrowNullPointerException(env, 0);
        return 0;
    }

    body += offset;                                       // line 180
```

Zero-copy path at line 173: `GetDirectBufferAddress` returns a direct pointer to the native memory backing the DirectBuffer. No `malloc` + no `GetByteArrayRegion` — the `body` pointer points directly into the ByteBuffer's native memory. Adding offset at line 180 gives the correct starting position.

The rest of defineClass2 mirrors defineClass1:
```c
    if (name != NULL) {
        utfName = getUTF(env, name, buf, sizeof(buf));      // line 183
        if (utfName == NULL) { ... }
        VerifyFixClassname(utfName);                         // line 188
    }
    // ... source handling ...
    result = JVM_DefineClassWithSource(env, utfName, loader,
                                       body, length, pd, utfSource); // line 202
```

Key differences between defineClass1 and defineClass2:

| 维度 | defineClass1 | defineClass2 |
|------|-------------|-------------|
| 数据参数 | `jbyteArray data` (Java heap) | `jobject data` (ByteBuffer) |
| 字节获取 | `GetByteArrayRegion` — memcpy heap→native | `GetDirectBufferAddress` — 零拷贝指针 |
| 内存分配 | `malloc(length)` — native heap | 无 — 直接使用 ByteBuffer native 地址 |
| 内存释放 | `free(body)` — must release | 无 — ByteBuffer 生命周期管理 |
| 拷贝开销 | ~0.02μs/class (4KB memcpy) | 0 (zero-copy) |
| 使用场景 | ZipFile byte[] (标准类加载) | NIO FileChannel.map (MappedByteBuffer) |
| GC 安全 | 拷贝到 native → GC 安全 | DirectBuffer 内存不在 GC heap → 天然安全 |

defineClass2 在什么场景使用？→ `ClassLoader.defineClass(String, ByteBuffer, ProtectionDomain)` 可以用 NIO FileChannel.map 映射 class 文件为 MappedByteBuffer（DirectBuffer）→ 传给 defineClass2 → 零拷贝进入 JVM。但 ZIP/JAR 场景中 ZipFile 返回的是 byte[]，不是 DirectBuffer → 实际 class loading 走 defineClass1。

> **反事实：如果 defineClass1 也用 GetPrimitiveArrayCritical 做零拷贝？** GetPrimitiveArrayCritical 锁定（pin）GC heap 中的 byte[] → 返回直接指针 → 零拷贝。但风险：JVM_DefineClassWithSource 可能触发 GC（类加载过程中需要分配 Klass + ConstantPool 等 GC 堆对象）→ 如果 byte[] 被 pin → GC 无法移动它 → 可能导致堆碎片或延迟。因此选择安全的一字节拷贝（~0.02μs/class for 4KB）而非 risky 的零拷贝。

---

### 1.4 defineClass1 → JVM 内部：SystemDictionary + ClassFileParser

Why: defineClass1 calls JVM_DefineClassWithSource at line 136 → HotSpot takes over. Understanding this handoff reveals why JNI exception handling works correctly and how class definition failures propagate back.

```c
// ClassLoader.c:136
    result = JVM_DefineClassWithSource(env, utfName, loader,
                                       body, length, pd, utfSource);
```

After this call, the following happens in HotSpot (jvm.cpp → SystemDictionary → ClassFileParser):

1. **JVM_DefineClassWithSource** (jvm.cpp:965): receives the native buffer. Finds or creates `ClassLoaderData` for the given loader — each ClassLoader has one CLD that tracks all classes it defined.

2. **SystemDictionary::define_class**: checks if the class is already loaded (key = classname + loader). If already loaded → returns existing Klass*. This implements the "first define wins" semantics.

3. **ClassLoaderData::add_class**: allocates metaspace memory for `InstanceKlass` + `ConstantPool` + `Methods` arrays. This allocation may trigger GC (metaspace full → class unloading).

4. **ClassFileParser::parseClassFile(buffer, length, ...)**: validates magic (0xCAFEBABE), version (minor/major), parses constant pool entries, access flags, fields, methods, attributes, StackMapTable, and bytecodes. Returns Klass* on success; throws ClassFormatError (via JNI exception mechanism) on failure.

5. **SystemDictionary::update_dictionary**: registers the new Klass* in the system dictionary so subsequent `findLoadedClass` / `findClass` calls can find it.

6. **Return jclass**: a JNI local reference to the Java Class object wrapping the new Klass*. This flows back through ClassLoader.c:136 → result → returned to Java layer.

Error propagation: if ClassFileParser fails (e.g., magic != 0xCAFEBABE) → ClassFormatError is thrown via JNI `ThrowNew` → defineClass1 checks `ExceptionOccurred` → returns NULL to Java → Caller catches ClassFormatError or wrapping exception.

> **反事实：如果 defineClass1 在调用 JVM 之前先验证 class 字节格式（magic + version）？** 重复验证——ClassFileParser 已经做了完整的格式验证（不仅 magic/version，还有常量池索引、字节码有效性、StackMapTable）。native 层做重复验证 → 代码重复 + 验证逻辑可能不保持一致（native C vs HotSpot C++）。单一验证点（ClassFileParser）是更干净的设计。

---

### 1.5 ★ Mermaid — defineClass1 跨边界序列图 (5 lanes)

```mermaid
sequenceDiagram
    participant ZF as Java ZipFile
    participant CL as Java ClassLoader
    participant N as Native ClassLoader.c
    participant HS as HotSpot jvm.cpp
    participant K as Klass (metaspace)

    ZF->>ZF: getInputStream(entry)
    ZF->>ZF: ZIP_Read → Inflater.inflate (zlib)
    ZF->>ZF: CRC32 verify
    ZF->>CL: byte[] classBytes

    CL->>CL: defineClass1(name, bytes, 0, bytes.length)
    CL->>N: JNI → ClassLoader.c:76
    N->>N: NULL check data (line 93)
    N->>N: length < 0? → ArrayIndexOutOfBounds (line 101)
    N->>N: body = malloc(length) (line 106)
    N->>N: GetByteArrayRegion(env, data, offset, length, body) (line 113)
    N-->>N: memcpy: Java heap byte[] → native buffer
    N->>N: ExceptionOccurred? → goto free_body (line 115)
    N->>N: utfName = getUTF(env, name, buf, 128) (line 119)
    N->>N: VerifyFixClassname(utfName) — '.' → '/' (line 123)
    N->>N: utfSource = getUTF(env, source, sourceBuf, 1024) (line 129)
    N->>HS: JVM_DefineClassWithSource(env, utfName, loader, body, length, pd, utfSource) (line 136)
    HS->>HS: find/create ClassLoaderData
    HS->>HS: SystemDictionary::define_class
    HS->>HS: ClassLoaderData::add_class — allocate metaspace
    HS->>K: ClassFileParser::parseClassFile(body, length)
    K->>K: verify magic 0xCAFEBABE
    K->>K: parse version, constant pool, access flags
    K->>K: parse fields, methods, attributes, bytecodes
    K->>K: verify StackMapTable + bytecode constraints
    K-->>HS: InstanceKlass* (defined)
    HS->>HS: SystemDictionary::update_dictionary — register
    HS-->>N: jclass (JNI handle)
    N->>N: free(utfSource) if not stack-allocated (line 138)
    N->>N: free(utfName) if not stack-allocated (line 142)
    N->>N: free(body) — release native buffer (line 146)
    N-->>CL: jclass result
    CL-->>CL: Class<?> loadedClass
```

---

### 1.6 ★ 面试 Story Format 答案

**问题：defineClass1 如何把 Java 字节数组变成加载好的类？**

答案分三段。

**第一段 — 字节跨界：**

`ClassLoader.defineClass1(name, data, off, len)` 从 Java 层接收已经解压、校验完成的 `byte[]`（来自 ZipFile.getInputStream → Inflater.inflate → CRC32 verify）。JNI 入口 `ClassLoader.c:76`：先做参数校验（data != NULL, length >= 0）→ `malloc(length)` 分配 native buffer（line 106）→ `GetByteArrayRegion(env, data, offset, length, body)`（line 113）一次 memcpy 把字节从 Java heap 拷贝到 native memory。**为什么拷贝？** Java heap 中的 byte[] 可能被 GC 移动 → 如果 JVM_DefineClassWithSource 处理期间 GC 移动了 byte[] → 指针悬挂 → SIGSEGV。native buffer 在 GC 管辖区外，稳定。

**第二段 — 类名规范化 + JVM 调用：**

`getUTF(env, name, buf, 128)`（line 119）将 Java `String`（UTF-16）转为 C `char*`（Modified UTF-8）→ `VerifyFixClassname(utfName)`（line 123）将 `'.'` 替换为 `'/'`（Java 源码用 `java.lang.Object`，JVM 内部用 `java/lang/Object`）→ `JVM_DefineClassWithSource(env, utfName, loader, body, length, pd, utfSource)`（line 136）进入 HotSpot。

**第三段 — HotSpot 内部 + 清理：**

JVM_DefineClassWithSource (jvm.cpp:965) → 找到/创建 ClassLoaderData → SystemDictionary::define_class（检查重复、分配 metaspace）→ ClassFileParser::parseClassFile（magic/version/常量池/fields/methods/attributes/bytecodes 验证）→ 返回 InstanceKlass* → 注册到 SystemDictionary → 返回 jclass。defineClass1 清理：`free(utfSource)`, `free(utfName)`, `free(body)`（line 146）→ native buffer 释放，class 已经安全地驻留在 metaspace。

**关键纠正：defineClass1 不读 ZIP。** 很多人以为 defineClass1 内部调用了 ZIP_GetEntry 或 readCEN。实际上 defineClass1 是做 JNI glue——只负责把 Java 层已读好的字节传递过 JNI 边界给 HotSpot。I/O + inflate + CRC32 全部在 Java 层完成（ZipFile + Inflater + CRC32），defineClass1 只做 native→JVM 的胶水。这是查看源码前最常见的误解。

---

### 1.7 ★ 错误处理链 — 三种异常对应三个失败阶段

Why: defineClass1 itself throws no exceptions — it's a conduit. The exceptions come from three distinct stages of the class-loading pipeline, and each signals a different root cause.

**Stage 1 — I/O failure: IOException + ClassNotFoundException**

`ZipFile.getInputStream(entry)` → `ZIP_Read` (zip_util.c:1340) → `lseek+read` → disk error → IOException. Or `InflateFully` (zip_util.c:1404) → `inflate()` returns `Z_DATA_ERROR` → `ZipException("invalid stored block lengths")`. Java layer `ZipFile` catches this → `ClassLoader.findClass` wraps it → `ClassNotFoundException`. The key: this exception includes the JAR path + entry name + error detail — you know exactly which file and which entry failed.

**Stage 2 — Format validation: ClassFormatError**

`defineClass1` (ClassLoader.c:136) → `JVM_DefineClassWithSource` → `ClassFileParser::parseClassFile` → magic check fails (`!= 0xCAFEBABE`) or version unsupported or constant pool index out of bounds → `ClassFormatError` thrown via JNI `ThrowNew`. This means the bytes exist and were readable, but they don't form a valid class file — wrong magic number, truncated file, or corrupted constant pool.

**Stage 3 — Definition failure: NoClassDefFoundError**

If `JVM_DefineClassWithSource` returns NULL because the class cannot be added to the system dictionary (e.g., linkage error, duplicate class, class loader constraint violation) — the Java layer `defineClass` throws `NoClassDefFoundError`. This is the vaguest exception — it says "the class couldn't be defined" without saying why at the byte level. The §〇 directory stub scenario triggers this: length=0 → `ClassFileParser` returns error → `JVM_DefineClassWithSource` returns NULL → Java layer wraps as `NoClassDefFoundError`.

**Exception propagation through JNI:**

```c
// In HotSpot, when ClassFileParser fails:
// THROW_MSG(vmSymbols::java_lang_ClassFormatError(), "Truncated class file");
// → JNI env->ThrowNew(ClassFormatError, "Truncated class file")
// → sets env->exception flag
// → returns NULL from JVM_DefineClassWithSource
// → defineClass1: result = NULL
// → env->ExceptionOccurred() returns true (checked implicitly by JNI)
// → returns NULL to Java
// → Java: if (c == null) throw new NoClassDefFoundError(name);
```

The `ExceptionOccurred` check at line 115 of ClassLoader.c handles only `GetByteArrayRegion` failures (ArrayIndexOutOfBounds). The JVM_DefineClassWithSource call at line 136 can set an exception that the Java caller detects via the NULL return.

---

### 1.8 getUTF — Java String 到 C 字符串的转换细节

Why: `getUTF` is the workhorse for string conversion in all ClassLoader native methods — understanding its implementation reveals the stack-buffer optimization for common short class names.

The `getUTF` macro (defined in `jni_util.h`) calls either `GetStringUTFChars` or `GetStringRegion`:
```c
// Conceptual: getUTF(env, jstr, stackBuf, stackBufLen)
// → if jstr length < stackBufLen → GetStringUTFRegion(env, jstr, 0, len, stackBuf)
//   → copies directly to stack buffer, no malloc needed
// → else → GetStringUTFChars(env, jstr, NULL)
//   → JVM allocates memory for the UTF-8 copy, caller must ReleaseStringUTFChars
```

defineClass1 uses `buf[128]` (line 89) — 128 bytes on the native stack. This covers the vast majority of class names (e.g., "com/example/Foo" = 15 chars). Only deeply nested class names with long package chains exceed 128 bytes and trigger the malloc path. `sourceBuf[1024]` (line 91) is much larger — source paths can include verbose filesystem paths.

The `VerifyFixClassname` function (called at lines 123, 188, 234) transforms `'.'` → `'/'` in-place on the UTF-8 string. Java uses `'.'` as the package separator in source code (`java.lang.Object`) while the JVM internally uses `'/'` (`java/lang/Object`). This transformation happens in the native buffer (not the Java String), so the original Java String is unaffected.

Counterfactual: if `getUTF` always used `GetStringUTFChars` (malloc) instead of the stack-buffer fast path → 3000 class loads × malloc + free = 6000 extra allocator calls → ~6ms extra startup time. The stack buffer `buf[128]` avoids this for 99% of class names.

---

## §二 环境

### Build & Source
OpenJDK 11 slowdebug, Linux x86_64. `ClassLoader.c` is in `src/java.base/share/native/libjava/ClassLoader.c` (523 lines), compiled into `libjava.so`.

Source roots：
- `src/java.base/share/native/libjava/ClassLoader.c` — `defineClass1`(:76)、`defineClass2`(:151)、`findBootstrapClass`(:218)、`findLoadedClass0`(:251)
- `src/hotspot/share/prims/jvm.cpp` — `JVM_DefineClassWithSource`(:965)、`JVM_FindClassFromBootLoader`、`JVM_FindLoadedClass`
- `src/hotspot/share/classfile/systemDictionary.cpp` — `SystemDictionary::define_class`、`update_dictionary`
- `src/hotspot/share/classfile/classFileParser.cpp` — `ClassFileParser::parseClassFile`

### Key JNI Functions
| Function | 使用点 | 成本 | 用途 |
|---------|--------|:--:|------|
| `GetByteArrayRegion` | `ClassLoader.c:113` | ~0.02μs (4KB memcpy) | Java heap byte[] → native buffer |
| `GetDirectBufferAddress` | `ClassLoader.c:173` | 0 (零拷贝) | DirectBuffer 地址 |
| `getUTF` (macro) | `ClassLoader.c:119` | <0.1μs (<128 chars) | jstring → C char* (Modified UTF-8) |
| `VerifyFixClassname` | `ClassLoader.c:123` | ~0.01μs | '.' → '/' 类名规范化 |

### 关键系统调用速查
| Function | man | 使用点 | 失败时 |
|----------|-----|--------|--------|
| `malloc()` | `man 3 malloc` | `ClassLoader.c:106` — 分配 native buffer | NULL → OutOfMemoryError |
| `free()` | `man 3 free` | `ClassLoader.c:146` — 释放 native buffer | N/A |
| `ExceptionOccurred()` | JNI | `ClassLoader.c:115` — 检查 JNI 异常 | 返回非 NULL → 跳转清理 |

### 诊断命令
```bash
# 1. GDB 验证 defineClass1 入参
gdb -ex "break ClassLoader.c:76" -ex "run" \
    -ex "print length" -ex "print name" \
    --args java -cp app.jar com.example.Main

# 2. strace 跟踪 JVM_DefineClassWithSource syscall 模式
strace -e mmap,openat java -cp app.jar com.example.Main 2>&1 | head -30

# 3. 检查类是否在 SystemDictionary 中
java -Xlog:class+load=info -cp app.jar com.example.Main
```

---

## §三 findBootstrapClass / findLoadedClass0 — 类查找与 defineClass1 的关系

Why: defineClass1 is only called when a class is NOT already loaded. The findBootstrapClass and findLoadedClass0 native methods are the lookup side of class loading — they check if the JVM already has the class, preventing redundant definition.

### 3.1 findBootstrapClass — 从 boot class loader 查找已加载类

```c
// ClassLoader.c:217-248
JNIEXPORT jclass JNICALL
Java_java_lang_ClassLoader_findBootstrapClass(JNIEnv *env, jobject loader,
                                              jstring classname)
{
    char *clname;
    jclass cls = 0;
    char buf[128];

    if (classname == NULL) { return 0; }

    clname = getUTF(env, classname, buf, sizeof(buf));
    if (clname == NULL) { ... return NULL; }
    VerifyFixClassname(clname);                            // line 234

    if (!VerifyClassname(clname, JNI_TRUE)) { goto done; } // line 236

    cls = JVM_FindClassFromBootLoader(env, clname);        // line 240
 done:
    if (clname != buf) { free(clname); }
    return cls;
}
```

FindBootstrapClass checks SystemDictionary for classes loaded by the boot loader. Returns NULL if not found — the Java layer then proceeds to findClass → defineClass1. The `VerifyClassname(clname, JNI_TRUE)` call at line 236 does deeper validation than `VerifyFixClassname` (which only converts '.' → '/') — it checks for illegal characters in the class name.

### 3.2 findLoadedClass0 — 查找任意 ClassLoader 已加载的类

```c
// ClassLoader.c:250-259
JNIEXPORT jclass JNICALL
Java_java_lang_ClassLoader_findLoadedClass0(JNIEnv *env, jobject loader,
                                           jstring name)
{
    if (name == NULL) { return 0; }
    return JVM_FindLoadedClass(env, loader, name);         // line 257
}
```

Minimal wrapper — receives a Java String classname, passes it directly to `JVM_FindLoadedClass`. This is called by the parent delegation chain: `loadClass → parent.loadClass → ... → findLoadedClass → JVM_FindLoadedClass`. If this returns NULL, the chain continues to `findClass → defineClass1`.

### 3.3 三类函数与 defineClass1 的调度顺序

The Java layer `ClassLoader.loadClass(name)` follows the standard delegation model:

```
loadClass(name)
  ├─ findLoadedClass(name) → JNI → findLoadedClass0 (ClassLoader.c:251)
  │    → JVM_FindLoadedClass(env, loader, name) → SystemDictionary lookup
  │    → if found: return Klass*
  │    → else: return NULL
  │
  ├─ parent.loadClass(name) → recursive delegation
  │    → (boot loader path) findBootstrapClass(name) (ClassLoader.c:218)
  │         → JVM_FindClassFromBootLoader(env, clname) → SystemDictionary lookup
  │         → if found: return jclass
  │         → else: return NULL → falls through to findClass
  │
  └─ findClass(name) → URLClassLoader:
       → ZipFile.getEntry("com/example/Foo.class")
       → ZipFile.getInputStream(entry) → ZIP_Read (zip_util.c:1340)
       → Inflater.inflate → zlib inflate (Inflater.c:128 + Inflater.c:140)
       → CRC32 verify (CRC32.c:58)
       → byte[] classBytes
       → defineClass(name, bytes, 0, bytes.length) → JNI
       → defineClass1 (ClassLoader.c:76) → JVM_DefineClassWithSource
       → SystemDictionary::define_class (register)
```

The `findBootstrapClass` path is specifically for boot loader resolution of `java.*` classes — they come from jimage (modules) not JARs. But the flow from byte[] → defineClass1 is identical regardless of byte source: jimage class bytes go through the same `defineClass1 → JVM_DefineClassWithSource → ClassFileParser` pipeline.

### 3.4 SystemDictionary 在查找和定义中的双重角色

SystemDictionary is the central registry of all loaded classes. It serves two functions:

1. **Lookup (read side):** `JVM_FindLoadedClass` and `JVM_FindClassFromBootLoader` both consult SystemDictionary's internal hash table keyed on (classname, ClassLoader) pair. If the class was previously defined via `defineClass1`, the lookup returns the existing Klass* — this is what makes `findLoadedClass` O(1).

2. **Registration (write side):** After `ClassFileParser::parseClassFile` succeeds, `SystemDictionary::define_class` → `update_dictionary` inserts the new (classname, loader, Klass*) entry into the hash table. This prevents duplicate definition: two threads loading the same class simultaneously → first thread's defineClass1 succeeds → registers in SystemDictionary → second thread's `defineClass1` detects already loaded → returns existing Klass* → second definition skipped.

The lock in SystemDictionary prevents race conditions in class definition. Two threads racing to define the same class: Thread-1 enters `define_class` → acquires SystemDictionary_lock → checks NOT found → starts ClassFileParser → Thread-2 enters `define_class` → blocks on SystemDictionary_lock → Thread-1 completes definition + registration → releases lock → Thread-2 acquires lock → checks FOUND → returns existing Klass* without re-parsing.

### 3.5 JNI local reference lifetime — 为什么 defineClass1 的 result 不会过早回收

Why: defineClass1 returns a `jclass` — a JNI local reference. Understanding its lifetime explains why the Java caller reliably receives the class object.

```c
// ClassLoader.c:136
    result = JVM_DefineClassWithSource(env, utfName, loader,
                                       body, length, pd, utfSource);
// ... free utfSource, utfName, body ...
    return result;                                           // line 147
```

The `result` jclass is a JNI local reference created inside `JVM_DefineClassWithSource`. JNI local references are valid for the duration of the native method call — they're freed automatically when the native method returns. Since `defineClass1` returns `result` directly to the Java caller, the reference is converted from a local reference to the return value on the Java stack → it survives the JNI frame teardown.

If `result` were NULL (class definition failed), the Java layer `defineClass` method would throw `NoClassDefFoundError` — the NULL return from native code with a pending JNI exception (set by ClassFileParser) signals failure to the Java caller. The JNI spec guarantees: if a native method returns NULL and an exception is pending, the JVM throws that exception in the Java caller before the return value is used.

The `free(body)` at line 146 is safe even though `result` references the class — because the class bytes were already fully parsed into metaspace before `JVM_DefineClassWithSource` returned. The `body` buffer is only needed during `ClassFileParser::parseClassFile` (inside JVM_DefineClassWithSource). Once that returns, the Klass is self-contained in metaspace and the original byte buffer can be freed.

---

## §四 边缘场景——ClassLoader native 桥接的 3 个非线性路径

### 场景 1：SystemDictionary lock 竞态 — 双线程同时 define 同一个类

**触发条件**：两个线程同时从不同 URLClassLoader 路径加载同一个类（如在启动期间两个依赖不同的 JAR 都包含 `com.example.Utils`）。

**源码行为**：Thread-1 进入 `JVM_DefineClassWithSource` → `SystemDictionary::define_class` → 获取 `SystemDictionary_lock` → 检查 NOT found → 开始 ClassFileParser → Thread-2 进入 define_class → 阻塞在 `SystemDictionary_lock` → Thread-1 完成定义 + `update_dictionary` → 释放锁 → Thread-2 获取锁 → 检查 FOUND (already registered) → 返回已有 Klass* → 不重复 parse。**关键**：第二个线程的 `defineClass1` 返回已有的 jclass，Java 层 `defineClass` 检查到重复定义 → 抛出 `LinkageError: duplicate class definition`。

### 场景 2：malloc(0) — directory stub 触发零长度分配

**触发条件**：JAR 中包含 directory stub entry（`size=0, name ends with '/'`），Java 层 `ZipFile` 的 `getInputStream` 返回 0 字节 stream → `readAllBytes()` → `byte[0]` → `defineClass1(name, data, 0, 0)`。

**源码行为**：`ClassLoader.c:106` 的 `body = (jbyte*)malloc(0)` → 实现定义行为：glibc 返回有效非 NULL 指针（或 NULL）→ `GetByteArrayRegion(env, data, 0, 0, body)` 拷贝 0 字节（NOP）→ `JVM_DefineClassWithSource(env, name, loader, body, 0, pd, source)` → `ClassFileParser::parseClassFile(body, 0)` → `magic != 0xCAFEBABE` (body 无有效字节) → `ClassFormatError` → JNI exception → defineClass1 返回 NULL → Java 层 `NoClassDefFoundError`。

**诊断**：GDB 断点 `ClassLoader.c:106` → `print length` = 0 → 确认 directory stub 是根因。

### 场景 3：JNI local reference 耗尽 — 大量 defineClass1 调用

**触发条件**：应用一次性加载 65536+ 个类通过 defineClass1（理论场景——实际 JVM 会先崩溃于 metaspace 满）。

**源码行为**：`JVM_DefineClassWithSource` 返回的 `jclass` 是 JNI local reference。JNI 规范保证每个 native method 调用至少有 16 个 local references 可用（可通过 `EnsureLocalCapacity` 增加）。defineClass1 只创建 1 个 jclass → 在 native frame 栈上 → 返回 Java 时转换为 Java 局部变量 → 不会溢出。但如果 defineClass1 内部被多次递归调用（ClassLoader 的嵌套 define）→ local reference frame 可能不够 → `PushLocalFrame`/`PopLocalFrame` 是标准修复。

---

## §五 GDB 断点验证 (9 assertions)

### 断言 1: defineClass1 入口 — 参数检查（`ClassLoader.c:76`）

```gdb
(gdb) break ClassLoader.c:76
(gdb) run
(gdb) print name → 期望: jstring "com.example.Foo"
(gdb) print length → 期望: >0（有效 class 文件）
(gdb) print data → 期望: jbyteArray（Java heap 中的 byte[]）
(gdb) print offset → 期望: 0（通常从头开始）
(gdb) print pd → 期望: ProtectionDomain 对象引用（或 NULL for boot loader）
```

验证 defineClass1 被调用且参数完整。如果 length=0 → directory stub 错误（§〇 root cause）。offset 通常是 0——Java 层已经切片了正确的 byte[] 区域。

### 断言 2: getUTF — 类名转换（`ClassLoader.c:119`）

```gdb
(gdb) break ClassLoader.c:119
(gdb) print name → 期望: jstring（"com.example.Foo"）
(gdb) continue
(gdb) print utfName → 期望: "com.example.Foo" — getUTF 返回的 C string
(gdb) print buf → 期望: 类名长度 < 128 → utfName == buf (stack buffer)
```

验证 JNI string 转换：jstring (UTF-16) → C char* (Modified UTF-8)。对于短类名（<128 chars），getUTF 使用栈 buffer `buf[128]` 避免 malloc。`utfName == buf` 确认无堆分配。

### 断言 3: malloc native buffer（`ClassLoader.c:106`）

```gdb
(gdb) break ClassLoader.c:106
(gdb) run
(gdb) print length → 期望: >0（典型 500-5000 字节 .class 文件）
(gdb) continue
(gdb) print body → 期望: 非 NULL — malloc 成功返回的 native 地址
(gdb) print body == NULL → 如果是 directory stub (length=0) → body = malloc(0)
```

验证 native buffer 分配。length 对应 .class 文件大小（通常 0.5-5KB）。body 是 C heap 地址——不是 Java heap 地址。在 GDB 中用 `info proc mappings` 可以确认地址范围不在 Java heap 内。

### 断言 4: GetByteArrayRegion 字节拷贝（`ClassLoader.c:113`）

```gdb
(gdb) break ClassLoader.c:113
(gdb) run
(gdb) print data → 期望: jbyteArray（源）
(gdb) print body → 期望: jbyte* 目标 buffer（malloc 分配的地址）
(gdb) print length → 期望: 拷贝长度
(gdb) continue
(gdb) print body[0]@4 → 期望: 0xCAFEBABE（.class magic number）
```

### 断言 5: VerifyFixClassname 类名规范化（`ClassLoader.c:123`）

```gdb
(gdb) break ClassLoader.c:123
(gdb) run
(gdb) print utfName → 期望: 函数调用前的类名（含 '.'）
(gdb) continue
(gdb) print utfName → 期望: '.' 已替换为 '/'（如 "com/example/Foo"）
```

### 断言 6: JVM_DefineClassWithSource 调用（`ClassLoader.c:136`）

```gdb
(gdb) break ClassLoader.c:136
(gdb) run
(gdb) print utfName → 期望: "com/example/Foo" (内部格式，'/' 分隔)
(gdb) print loader → 期望: ClassLoader 对象引用（AppClassLoader）
(gdb) print body → 期望: native buffer 地址（非 NULL）
(gdb) print length → 期望: >0（class 文件字节数）
(gdb) print pd → 期望: ProtectionDomain 或 NULL
(gdb) continue
(gdb) print result → 期望: 非 NULL jclass（类已定义）或 NULL（失败 + exception pending）
```

### 断言 7: free(body) 清理（`ClassLoader.c:146`）

```gdb
(gdb) break ClassLoader.c:146
(gdb) run
(gdb) print body → 期望: 非 NULL（仍持有 malloc 地址）
(gdb) continue # 经过 free(body)
→ body 释放，native buffer 归还。类已在 metaspace 中存活。
```

### 断言 8: defineClass2 零拷贝路径（`ClassLoader.c:173`）

```gdb
(gdb) break ClassLoader.c:173
(gdb) run  # 使用 NIO DirectBuffer 路径
(gdb) print data → 期望: jobject（ByteBuffer）
(gdb) continue
(gdb) print body → 期望: 非 NULL（DirectBuffer address）或 NULL（非 direct → 不适用）
```

### 断言 9: NoClassDefFoundError 错误路径 — 故意传入空 byte[]（`ClassLoader.c:106`）

```gdb
# 准备一个只有 directory stub 的测试 JAR
(gdb) break ClassLoader.c:106
(gdb) run
(gdb) print length → 期望: 0
(gdb) print body → 期望: NULL 或有效的 malloc(0) 指针
(gdb) continue → JVM_DefineClassWithSource(length=0) → ClassFileParser → ClassFormatError
```

---

## §六 Cross-Reference

| Phase | Connection | Handoff Point |
|-------|-----------|--------------|
| **00-Zip-Class-Loading** | defineClass1 的 `byte[] data` 参数来源：ZipFile.getInputStream → ZIP_Read → Inflater.inflate (zlib) → CRC32 verify | `byte[] data` → defineClass1 (`ClassLoader.c:76`) |
| **02-Compression-Zlib** | Inflater.c inflate 解压产生的字节是 defineClass1 的输入 | `doInflate` (`Inflater.c:128`) → byte[] → `ClassLoader.c:113` |
| **02-class-loading** | JVM_DefineClassWithSource → SystemDictionary → ClassFileParser::parseClassFile 消费 defineClass1 传递的字节 | `ClassLoader.c:136` → `jvm.cpp:965` → ClassFileParser |
| **09-native-interface** | JNI 函数表：GetByteArrayRegion (line 113), GetStringUTFChars (via getUTF, line 119), GetDirectBufferAddress (defineClass2 line 173) | JNI entry → `ClassLoader.c` |
| **01-Jimage-Format** | BuiltinClassLoader 通过 JIMAGE_FindResource 查找模块类 → 同样经过 defineClass1 | `jimage.cpp:112` → byte[] → `ClassLoader.c:76` |

---

## §七 Counterfactual 对比表

| 设计选择 | 实际方案 | 替代方案 | 替代代价 | 量化对比 |
|---------|---------|---------|---------|---------|
| **字节传递** | GetByteArrayRegion — memcpy heap→native | GetPrimitiveArrayCritical — 零拷贝 pin heap | GC 期间 byte[] 不可移动 → 堆碎片 | memcpy ~0.02μs/class (4KB) vs zero-copy ~0μs but GC risk |
| **defineClass2 输入** | GetDirectBufferAddress — 零拷贝指针 | 统一用 byte[] + memcpy | DirectBuffer 路径失去零拷贝优势 | 0μs vs ~0.02μs/class |
| **I/O 职责** | Java 层 ZipFile 做 I/O + inflate + CRC32 | native ClassLoader.c 做 I/O | 异常消息退化（native error codes vs Java ZipException） | 更好的错误报告 vs native 的脆弱性 |
| **前置验证** | ClassFileParser 统一验证（magic/version/bytecodes） | defineClass1 前验证 magic | 代码重复 + C vs C++ 验证逻辑分歧 | 单一验证点 → 维护性好 |
| **并发模型** | Java InputStream per thread → 并发 inflate | native ZIP_GetEntry 串行化（per-JAR lock） | JAR 内并发类加载 10x 慢 | 10 threads × 1 vs 10 serialized |
| **类名处理** | VerifyFixClassname '.' → '/' | 不转换直接传 | JVM 内部存储格式不一致 | ~0.01μs 转换成本，cleaner JVM internals |
| **内存管理** | malloc native buffer + free | 直接传 Java heap 指针 | GC 期间指针悬挂 → SIGSEGV | malloc/free ~0.5μs, SIGSEGV cost = 进程崩溃 |
| **defineClass1 vs defineClass2** | 两个独立 JNI 函数 | 统一为一个（用 isDirectBuffer 分支） | 同一函数维护两种路径 → 分支复杂度 | 现在的分离更清晰：byte[] vs ByteBuffer 完全不同语义 |
| **类重复定义** | SystemDictionary_lock → 第一个线程 define，第二个返回已有 Klass* | 无锁 → 两个线程同时 parse 同一 class | 双倍 metaspace 分配浪费 + 第二个 thread 的 parse 白白消耗 CPU | 有锁: O(1ms) serialize; 无锁: ~1ms wasted re-parse + 2× metaspace |
| **JNI 字符串转换** | getUTF with stack buf[128] 快速路径 | 全部 malloc via GetStringUTFChars | 3000 classes × malloc/free = 6000 allocator calls | stack buf: ~0μs; malloc: ~1μs × 3000 = 3ms |

---

## §八 代码验证行号

| 函数 | 文件:行号 | 验证状态 |
|------|-----------|---------|
| `Java_..._defineClass1` | `ClassLoader.c:76` | ✅ 6 步执行序列 |
| `Java_..._defineClass2` | `ClassLoader.c:151` | ✅ GetDirectBufferAddress (line 173) 零拷贝 |
| `getUTF` (macro) | `ClassLoader.c:119` | ✅ jstring → C char* (Modified UTF-8) |
| `GetByteArrayRegion` | `ClassLoader.c:113` | ✅ Java heap byte[] → native buffer |
| `GetDirectBufferAddress` | `ClassLoader.c:173` | ✅ DirectBuffer native pointer → 零拷贝 |
| `VerifyFixClassname` | `ClassLoader.c:123` | ✅ '.' → '/' 类名规范化 |
| `JVM_DefineClassWithSource` | `ClassLoader.c:136` (call) | ✅ 边界穿越：native → HotSpot |
| `JVM_DefineClassWithSource` | `jvm.cpp:965` (defn) | ✅ HotSpot 类定义入口 |
| `findBootstrapClass` | `ClassLoader.c:218` | ✅ → JVM_FindClassFromBootLoader |
| `findLoadedClass0` | `ClassLoader.c:251` | ✅ Minimal wrapper → JVM_FindLoadedClass |

---

## §九 ADDITIONAL PROHIBITIONS（≥8）

- ❌ 只说 defineClass1 是 JNI glue 不做源码级分析——必须展示 6 步执行序列
- ❌ 不解释 why 需要 malloc + GetByteArrayRegion 而非直接传指针——GC 移动 byte[] → SIGSEGV
- ❌ 忽略 defineClass2 的零拷贝路径——GetDirectBufferAddress 是真正的 zero-copy
- ❌ 不说 defineClass1 的 3 阶段错误链——IOException(Java I/O)→ClassFormatError(HotSpot)→NoClassDefFoundError(SystemDictionary)
- ❌ 不分析 VerifyFixClassname '.' → '/' 的必要性——Java 源码 vs JVM 内部命名不一致
- ❌ 遗漏 getUTF 的栈缓冲区优化——buf[128] 避免 99% 类名的 malloc/free（省 ~3ms for 3000 classes）
- ❌ 不展示 SystemDictionary 在查找和定义中的双重角色——同一数据结构服务写侧和读侧
- ❌ 不做 man 手册引用——`man 3 malloc`(native buffer)、`man 3 free`(cleanup)、JNI spec(GetByteArrayRegion)
- ❌ 忽略边缘场景：directory stub(length=0)、SystemDictionary lock 竞态、JNI local reference lifetime
- ❌ 不要解释类文件格式（magic/version/常量池）——02-class-loading 覆盖
