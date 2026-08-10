# PROMPT: 请撰写 03-ClassLoader-Bridge.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

生产环境 CI/CD 打出的 JAR 部署后所有模块报错：

```
java.lang.NoClassDefFoundError: com/example/Foo
```

但排查发现 `com/example/Foo.class` **确实在** JAR 的 Central Directory 中（`jar tvf app.jar | grep Foo.class` 正常）。`ClassLoader.defineClass1` 收到 `null` 而非 `.class` 字节——根因是 ZIP entry 的类型错误：这是一个 **directory stub**（`size=0, name ends with '/'`），不是 file entry。CI 工具错误地在 JAR 中插入了目录条目。

**三步诊断**（直接写进 §〇）：

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
    # size=0 且 is_dir → 可能返回空 bute[] 或报错
"

# 3. GDB 断点验证 defineClass1 的入参
gdb -ex "break ClassLoader.c:76" \
    -ex "run" \
    -ex "print className → 期望: 'com/example/Foo'" \
    -ex "print length → 期望: >0（如果为 0 → directory stub）" \
    -ex "print data@4 → 期望: 0xCAFEBABE（如果不是 → 不是有效的 .class 字节）" \
    --args java -cp app.jar com.example.Foo
```

**反事实**：如果 `ClassLoader.defineClass1` 在接收之前验证 byte[] 的长度和 magic number → 可以立即报 "not a valid class file: size=0" 而非静默 `NoClassDefFoundError`。但 `defineClass1` 的设计是**零验证**——它的职责是传递字节给 JVM，让 JVM 的 `ClassFileParser` 做所有验证。这个分离是刻意的：`ClassLoader.c` 做 JNI glue（不是 class 文件验证器），`ClassFileParser`（02-class-loading）做格式验证。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE Java→native bridge for class definition: from `ClassLoader.defineClass1(String name, byte[] data, int off, int len)` to `JVM_DefineClassWithSource` entering HotSpot. **The critical insight**: `defineClass1` does NOT call `ZIP_GetEntry` or `inflate`. The bytes come **pre-read** from the Java layer `ZipFile` — the native side only does: JNI byte copy (`GetByteArrayRegion`) → classname verification → JVM invocation.

Reader knows from **00-Zip-Class-Loading** HOW ZipFile reads + inflates bytes from JAR. Reader knows from **02-Compression-Zlib** HOW zlib inflate works inside Inflater. Reader knows from **09-native-interface** the JNI mechanisms (`GetByteArrayRegion`, `GetStringUTFChars`). This doc answers: **how the already-read bytes cross the JNI boundary and become a loaded class.**

### Beginner Callout Boxes（文档中必须出现的 4 个 callout 框）

1. **defineClass1**：JNI 入口函数 `Java_java_lang_ClassLoader_defineClass1`（`ClassLoader.c:76`）。接收参数：`jstring name`（类名，如 "com.example.Foo"）、`jbyteArray data`（**已经在 Java 层读好的 .class 字节**）、`jint offset`、`jint length`、`jobject pd`（ProtectionDomain）。注意：data 来自 Java 层 `ZipFile.getInputStream().readAllBytes()`，不是 native 代码读取的。源码：`ClassLoader.c:76-148`。

2. **JNI GetStringUTFChars**：将 Java `jstring`（UTF-16 编码）转换为 C `char*`（UTF-8 / Modified UTF-8）。`defineClass1` 用它将 classname 从 Java `String` 转为 C string。注意：Modified UTF-8 ≠ 标准 UTF-8（对 U+0000 和 supplementary characters 处理不同）→ JVM 内部不总是标准兼容。源码：`ClassLoader.c:93`。

3. **SetByteArrayRegion** / **GetByteArrayRegion**：JNI 函数用于 Java `byte[]` 和 C `char*` 之间的数据拷贝。`GetByteArrayRegion`（`ClassLoader.c:113`）：`(*env)->GetByteArrayRegion(env, data, offset, length, (jbyte*)body)` ——从 Java heap 拷贝 `length` 字节到 native buffer `body`。这是一次 memcpy（heap → native）。`defineClass2` 用 `GetDirectBufferAddress` 实现零拷贝。

4. **JVM_DefineClassWithSource**：HotSpot 内部函数，接收 native 端的 class 字节后执行完整的类定义流程：`SystemDictionary::define_class` → `ClassLoaderData::add_class` → `ClassFileParser::parseClassFile`（02 领域）。这里 `defineClass1` 的职责结束——后续是 HotSpot 的事情。源码调用：`ClassLoader.c:136`。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots：
- `src/java.base/share/native/libjava/ClassLoader.c` — defineClass1/2、findBootstrapClass、findLoadedClass0
- HotSpot `src/hotspot/share/prims/jvm.cpp` — `JVM_DefineClassWithSource`、`JVM_DefineClass`、`JVM_FindClassFromBootLoader`
- Java 层：`java.lang.ClassLoader`、`java.util.zip.ZipFile`、`java.util.zip.Inflater`

Build：`make jdk`

Key binary：
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjava.so` — 包含 `ClassLoader.c` 的编译产物
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 包含 `JVM_DefineClassWithSource`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **ClassLoader.c** | `src/java.base/share/native/libjava/ClassLoader.c` | 523 | `Java_..._defineClass1`(:76), `Java_..._defineClass2`(:151), `Java_..._findBootstrapClass`(:218), `Java_..._findLoadedClass0`(:251) | ClassLoader JNI 桥接——接收已读字节，传递到 JVM |
| 2 | **jvm.cpp** (HotSpot) | `src/hotspot/share/prims/jvm.cpp` | — | `JVM_DefineClassWithSource`, `JVM_DefineClass`, `JVM_FindClassFromBootLoader` | HotSpot 类定义入口 |
| 3 | **java.util.zip.ZipFile** (Java) | `src/java.base/share/classes/java/util/zip/ZipFile.java` | — | `getEntry()`, `getInputStream()` | **字节读取实际发生处**——通过 native Inflater 解压 |
| 4 | **java.util.zip.Inflater** (Java) | `src/java.base/share/classes/java/util/zip/Inflater.java` | — | `inflate()` → JNI `Inflater.c:188` → zlib `inflate()` | Java 到 native inflate 的入口 |

**关键澄清**：
- `defineClass1` **不调用 ZIP_GetEntry** — 字节已由 Java 层 ZipFile 读取
- 完整链：Java ZipFile.getInputStream() → native Inflater.inflateBytesBytes（Inflater.c:188）→ zlib inflate → byte[] → ClassLoader.defineClass1(bytes)

---

## §四 Deep Dive Question Groups（≥4，EXACT questions + answer directions）

### 4.1 ★★★ defineClass1 — receives pre-read bytes from Java

```
问题：
  ① ClassLoader.c:76 的 defineClass1 完整参数验证 + 执行序列是什么？
     答案方向：
       1. 参数校验 (ClassLoader.c:82-89)：name 非 NULL → GetStringUTFChars
       2. 分配 native buffer (ClassLoader.c:106)：body = (jbyte*)malloc(length)
          → length == 0 → body = NULL（目录 entry、空 class 文件等）
       3. 拷贝字节 (ClassLoader.c:113)：GetByteArrayRegion(env, data, offset, length, body)
          → 从 Java heap 拷贝到 native buffer（一次 memcpy）
       4. 类名规范化 (ClassLoader.c:123)：VerifyFixClassname(utfName)
          → 将 '.' 替换为 '/'（Java 内部使用 '/' 作为包分隔符）
       5. 调用 JVM (ClassLoader.c:136)：JVM_DefineClassWithSource(env, utfName, loader, body, length, pd, utfSource)
          → 进入 HotSpot
       6. 清理 (ClassLoader.c:138)：free(body)（释放 native buffer）

     追问：为什么需要 malloc + GetByteArrayRegion（拷贝）而不是直接传指针？
     → Java heap 中的 byte[] 可能被 GC 移动 → 如果在 JVM_DefineClassWithSource
     处理期间（可能触发 GC）GC 移动了 byte[] → 指针失效 → SIGSEGV。
     GetByteArrayRegion 将字节拷贝到稳定的 native buffer → 不受 GC 影响。
     但 defineClass2 用 GetDirectBufferAddress 零拷贝——因为 DirectBuffer
     的内存由 Unsafe.allocateMemory 分配，不在 GC heap 中，GC 不移动。

  ② Counterfactual：如果 defineClass1 自己调用 ZIP_GetEntry 直接从 JAR 读字节？
      答案方向；native 代码处理 I/O（fopen + lseek + read + inflate）→ 
      每一步都可能失败（文件不存在、CEN 损坏、inflate 错误）→ 
      需要 native 错误码 → Java 异常映射 → 比 Java 层处理更复杂和脆弱。
      现有设计：Java 层 ZipFile 做 I/O + 解压 + CRC32 校验（Java 异常处理丰富）→ 
      defineClass1 只做 JNI glue（稳定的接口）→ 关注点分离。
      native 处理所有 I/O 的代价：错误报告质量退化（strm->msg vs Java ZipException 
      带 entry 名、期望/实际 CRC 等丰富上下文的异常）。
      
      量化反事实——如果 defineClass1 调用 ZIP_GetEntry 而非接收预读字节，产生 2 个具体问题：
      (1) 错误处理：zlib inflate 在 native 代码中失败 → SIGABRT 或 return NULL → 无 Java IOException → 无 ClassNotFoundException → JVM 继续运行但缺失类 → 5 分钟后首次使用时 NoClassDefFoundError → 症状远离根因。Java 层 ZipFile 的 inflate 失败抛出有 entry 名的 ZipException → ClassLoader 捕获 → 精确报告哪个 JAR 的哪个 entry 损坏。
      (2) 并发：10 线程从同一 JAR 加载类 → 10 并发 ZIP_GetEntry 调用 → 单一 ZIP 句柄 mutex → 序列化读取 → 类加载 10x 慢。Java 层 ZipFile：每个线程有自己的 InputStream → 并发 inflate → 并行类加载。
```

### 4.2 ★★★ Architecture — separation of concerns

```
问题：
  ① "字节读取"和"类定义"的完整职责分离是什么？
     答案方向：
       Java 层负责：
         - ZipFile(path)：打开 JAR（native ZIP_Open）
         - ZipFile.getEntry(name)：查找 entry（native ZIP_GetEntry2 哈希查找）
         - ZipFile.getInputStream(entry)：读取 + Inflater.inflate（native zlib inflate）
         - ZipFile CRC32 校验（native crc32 via CRC32.c:58）
         - byte[] classBytes = is.readAllBytes()
       Native 层（ClassLoader.c）负责：
         - GetByteArrayRegion 拷贝字节（Java heap → native）
         - VerifyFixClassname（类名规范化）
         - JVM_DefineClassWithSource 进入 HotSpot
       HotSpot 负责：
         - SystemDictionary::define_class
         - ClassFileParser::parseClassFile（02 领域——格式验证、字节码语义检查）
       这个分离是刻意的：I/O + 压缩 + 校验在 Java 层（错误消息丰富），
       JNI glue + JVM 类注册在 native（性能关键 + JVM 内部访问）。

  ② Counterfactual：如果全部类加载逻辑都在 native 完成（包括 I/O + inflate + CRC32）？
     答案方向：存在的方案——Oracle JRockit 的某些版本确实在 native 层处理了更多
     JAR 读取。但代价是：异常消息退化（native error codes → 没有 Java 异常的堆栈跟踪）、
     调试困难（没有 Java 调试器可见的中间状态）、代码维护（native C 代码远比 Java 复杂）。
     HotSpot 的选择是 pragmatic：Java 层做 80% 的 dirty work（有异常、有 GC、
     有调试器），native 层只做 JNI glue + JVM 内部（必须 native 的部分）。
```

### 4.3 ★★★ defineClass2 — zero-copy via DirectBuffer

```
问题：
  ① defineClass2(ClassLoader.c:151) 和 defineClass1 的关键区别是什么？
     答案方向：defineClass2 接收 `jobject data`（ByteBuffer），而非 `jbyteArray data`。
       1. 获取 DirectBuffer address (ClassLoader.c:168)：
          body = (jbyte*)GetDirectBufferAddress(env, data)
          → 如果 ByteBuffer 不是 direct → 返回 NULL → GetByteArrayRegion 回退
       2. DirectBuffer 路径：**零拷贝**——body 直接指向 native 内存
          （Unsafe.allocateMemory 分配的内存，不在 GC heap）。
       3. 非 direct 路径（ClassLoader.c:182）：回退到 GetByteArrayRegion → memcpy
       4. 之后序列与 defineClass1 完全相同（VerifyFixClassname → JVM_DefineClassWithSource）
     
     追问：defineClass2 在什么场景使用？→ ClassLoader.defineClass(String, ByteBuffer, ProtectionDomain)
     可以用 NIO FileChannel.map 映射 class 文件为 MappedByteBuffer（DirectBuffer）→ 
     传给 defineClass2 → 零拷贝进入 JVM。但 ZIP/JAR 场景中 ZipFile 返回的是 byte[]，
     不是 DirectBuffer → 实际 class loading 走 defineClass1。

  ② Counterfactual：如果 defineClass1 也用 GetPrimitiveArrayCritical 做零拷贝？
     答案方向：GetPrimitiveArrayCritical 锁定（pin）GC heap 中的 byte[] → 
     返回直接指针 → 零拷贝。但风险：JVM_DefineClassWithSource 可能触发 GC
     （类加载过程中需要分配 Klass + ConstantPool 等 GC 堆对象）→ 
     如果 byte[] 被 pin → GC 无法移动它 → 可能导致堆碎片或延迟。
     因此选择安全的一字节拷贝（~0.02μs/class for 4KB）而非 risky 的零拷贝。
```

### 4.4 ★★★ defineClass1 → JVM internal

```
问题：
  ① defineClass1 调用 JVM_DefineClassWithSource 之后——在 HotSpot 内部发生了什么？
     答案方向（hotspot 内部，本 phase 不深入但需要提及）：
       1. JVM_DefineClassWithSource (jvm.cpp) → 
          → 根据 loader 找到对应的 ClassLoaderData（每个 ClassLoader 有一个 CLD）
       2. SystemDictionary::define_class → 
          → 检查是否已加载（用 classname + loader 做 key 查 SystemDictionary）
          → 如果已加载 → 返回已有的 Klass*
       3. ClassLoaderData::add_class →
          → 创建 InstanceKlass（分配 metaspace 内存）
          → ClassFileParser::parseClassFile(buffer, length, ...) 
          → 解析 magic、version、常量池、access flags、fields、methods、attributes
          → 验证字节码
          → 返回 Klass*
       4. SystemDictionary::update_dictionary →
          → 注册到 SystemDictionary（后续 findLoadedClass / findClass 可以找到）
       5. 返回 jclass（JNI handle）→ defineClass1 返回给 Java 调用者

     追问：如果 ClassFileParser 验证失败（例如 magic != 0xCAFEBABE）？
     → ClassFileParser::verify_magic → ClassFormatError 异常 → 
     通过 JNI 异常机制回到 defineClass1 → defineClass1 返回 NULL → 
     Java 层捕获 ClassFormatError。

  ② Counterfactual：如果 defineClass1 在调用 JVM 之前先验证 class 字节格式（magic + version）？
     答案方向：重复验证——ClassFileParser 已经做了完整的格式验证（不仅 magic/version，
     还有常量池索引、字节码有效性、StackMapTable）。native 层做重复验证 →
     代码重复 + 验证逻辑可能不保持一致（native C vs HotSpot C++）。
     单一验证点（ClassFileParser）是更干净的设计。
```

---

## §五 Article Structure

```
§〇 生产场景 — NoClassDefFoundError 但 class 在 JAR 中：directory stub
  ★ 真实错误消息：java.lang.NoClassDefFoundError: com/example/Foo
  ★ Root cause：ZIP entry 是 directory stub (size=0, name ends with '/') 非 file entry
  ★ 三步诊断：python zipfile is_dir() → zf.read() test → GDB defineClass1 入参
  ★ 反事实：如果 defineClass1 在前端验证 byte[] → 立即报 "not a valid class file"

§一 ★★★ defineClass1 全链路源码走读
  ❓ defineClass1 不调用 ZIP_GetEntry — 字节由 Java ZipFile 已读好
  ❓ Reader 从 00-Zip-Class-Loading 来 — 理解字节是怎么读出来的
  1.1 参数验证 (ClassLoader.c:82-89)：name 非 NULL → GetStringUTFChars
  1.2 分配 native buffer (ClassLoader.c:106)：malloc(length)
  1.3 字节拷贝 (ClassLoader.c:113)：GetByteArrayRegion → Java heap → native
  1.4 类名规范化 (ClassLoader.c:123)：VerifyFixClassname — '.' → '/'
  1.5 JVM 类定义 (ClassLoader.c:136)：JVM_DefineClassWithSource → 进入 HotSpot
  1.6 清理 (ClassLoader.c:138)：free(body)

§二 ★★★ defineClass2 — DirectBuffer 零拷贝
  2.1 GetDirectBufferAddress (ClassLoader.c:168) — 零拷贝路径
  2.2 非 direct Buffer 回退 (ClassLoader.c:182) — GetByteArrayRegion

§三 ★★★ findBootstrapClass / findLoadedClass0 — 查找已加载类
  3.1 findBootstrapClass (ClassLoader.c:218) → JVM_FindClassFromBootLoader
  3.2 findLoadedClass0 (ClassLoader.c:251) → JVM_FindLoadedClass
  3.3 SystemDictionary 查找机制 (HotSpot 内部) — 与 defineClass1 的关系

§四 ★★★ 职责分离 — Java I/O vs native glue
  ❓ 为什么 Java 层读取字节而 native 只做 glue？
  ❓ 如果 native 做所有 I/O 会怎样？
  4.1 完整调用链：Java ZipFile → Inflater.c → zlib → byte[] → defineClass1 → HotSpot
  4.2 错误处理对比：Java 异常 (ZipException/IOException) vs native 错误码
  4.3 ★ Mermaid：字节跨边界 — Java heap (byte[]) → JNI GetByteArrayRegion → native buffer (malloc) → JVM_DefineClassWithSource → HotSpot metaspace (Klass)
      Lanes: Java ZipFile / Java ClassLoader / Native ClassLoader.c / HotSpot jvm.cpp / Klass

§五 ★ GDB 断点验证 — 5 断点完整 defineClass1 trace
  断言 1: defineClass1 入口 (ClassLoader.c:76)
  断言 2: GetByteArrayRegion 字节拷贝 (ClassLoader.c:113)
  断言 3: VerifyFixClassname 类名规范化 (ClassLoader.c:123)
  断言 4: JVM_DefineClassWithSource 调用 (ClassLoader.c:136)
  断言 5: JVM_DefineClassWithSource 内部 — HotSpot jvm.cpp

§六 ★ Cross-Reference
  ❓ 00-Zip-Class-Loading — ZipFile.getInputStream→Inflater→byte[] (defineClass1 的字节来源)
  ❓ 02-Compression-Zlib — Inflater.c inflate 解压 (defineClass1 的字节已经解压)
  ❓ 02-class-loading — ClassFileParser::parseClassFile (JVM_DefineClassWithSource 的下一步)
  ❓ 09-native-interface — JNI 函数表 + GetByteArrayRegion + GetStringUTFChars 机制
  ❓ 01-Jimage-Format — jimage 路径的 class 加载也经过 defineClass1 (BuiltinClassLoader)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because defineClass1 must deliver byte[] data from the Java heap to the HotSpot class loader subsystem without risking a dangling pointer if GC moves the array during class parsing, it allocates a native buffer via malloc and copies the bytes with GetByteArrayRegion..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from `ClassLoader.c`, do not describe it.

3. **Mermaid** — defineClass1 sequence diagram. 5 lanes: Java ZipFile / Java ClassLoader / Native ClassLoader.c / HotSpot jvm.cpp / Klass. Complete flow: ZipFile.getInputStream → Inflater.inflate → byte[] classBytes → ClassLoader.defineClass1(name, bytes, off, len) → GetStringUTFChars(name) → malloc(length) → GetByteArrayRegion → VerifyFixClassname → JVM_DefineClassWithSource → SystemDictionary::define_class → ClassLoaderData::add_class → ClassFileParser::parseClassFile → InstanceKlass. Annotate every boundary crossing with file:line.

4. **GDB session** — 5 breakpoints with exact file:line numbers:
   - `ClassLoader.c:76` — defineClass1 entry (inspect classname, data length)
   - `ClassLoader.c:113` — GetByteArrayRegion (inspect source byte[], destination buffer)
   - `ClassLoader.c:123` — VerifyFixClassname (inspect classname before/after)
   - `ClassLoader.c:136` — JVM_DefineClassWithSource call (inspect all parameters)
   - HotSpot `jvm.cpp:JVM_DefineClassWithSource` — the JVM internal entry

   Each with expected variable values to verify.

5. **4 Beginner callout boxes** — exact text from §一: defineClass1, GetStringUTFChars, SetByteArrayRegion/GetByteArrayRegion, JVM_DefineClassWithSource.

6. **Cross-reference at three points**:
   - At `GetByteArrayRegion` → "→ these bytes came from ZipFile.getInputStream → Inflater.inflate → zlib inflate (00-Zip + 02-Compression)"
   - At `JVM_DefineClassWithSource` → "→ enters HotSpot → SystemDictionary::define_class → ClassFileParser::parseClassFile (02-class-loading)"
   - At `free(body)` → "→ the native buffer is released; the class lives in metaspace now"

7. **Story-format interview answer** — at §一末尾："defineClass1 如何把 Java 字节数组变成加载好的类？" — narrative from Java heap byte[] → JNI copy → native buffer → JVM_DefineClassWithSource → ClassFileParser. Key: defineClass1 不做 I/O、不做验证、不做解压——只做 glue。

---

## §七 Output Format

- Markdown file，named `03-ClassLoader-Bridge.md`
- Output path：`/data/workspace/openjdk-cut-new/probe_md/14-zip-jimage/`
- 元信息头：

```
> **阶段**：[14-zip-jimage]
> **前置**：[00-Zip-Class-Loading]（字节由 ZipFile 读取 + Inflater 解压）、[02-Compression-Zlib]（Inflater.c → zlib inflate 解压管线）、[09-native-interface]（JNI 机制：GetByteArrayRegion、GetStringUTFChars）
> **配套**：无
> **后续依赖本文**：[02-class-loading]（ClassFileParser::parseClassFile 消费 defineClass1 传递的字节 + 定义双亲委派链）
> **阅读收益**：追踪从 `ClassLoader.defineClass1(name, data, off, len)` 到 `JVM_DefineClassWithSource` 的完整 6 步 JNI glue 序列——理解 defineClass1 不调用 ZIP_GetEntry（字节由 Java 层预读）的关键架构决策、GetByteArrayRegion 的一次 memcpy（heap→native）、defineClass2 的 DirectBuffer 零拷贝路径、VerifyFixClassname 的类名规范化（'.'→'/'）、职责分离（Java 层 I/O + native glue + HotSpot 验证）；掌握 "NoClassDefFoundError 但 class 在 JAR" 的 directory stub 诊断 + defineClass1 入参 GDB 验证 workflow
```

- 目标行数：350+ lines

---

## §八 Prohibited（≥8）

- ❌ 说 defineClass1 调用 ZIP_GetEntry — 必须澄清：defineClass1 收到的是 Java 层已读好的 byte[]
- ❌ 不解释为什么需要 GetByteArrayRegion 而不是直接传指针 — 必须说明 GC heap 移动风险
- ❌ 忽略 defineClass2 的 DirectBuffer 零拷贝 — 必须对比 defineClass1（memcpy）和 defineClass2（zero-copy）
- ❌ 不展示 VerifyFixClassname — 必须说明 '.' → '/' 的转换 + 为什么 Java 用 '.' 而 JVM 用 '/'
- ❌ 跳过 JVM_DefineClassWithSource 之后的 HotSpot 内部流程概述 — 必须提及 SystemDictionary::define_class → ClassFileParser
- ❌ 不做职责分离的 WHY 分析 — 必须解释为什么 Java 层做 I/O、native 做 glue、HotSpot 做验证
- ❌ 不做 defineClass1 vs defineClass2 对比 — 必须展示两种方法的入参差异和性能差异
- ❌ 不说明 Java 层 Inflater 到 native zlib 的完整链 — 必须展示 00-Zip 和 02-Compression 与本 prompt 的关系
- ❌ 忽略 findBootstrapClass / findLoadedClass0 — 必须简要说明它们与 defineClass1 的关系
- ❌ 不要展开 ClassFileParser 内部实现（02-class-loading 覆盖）
- ❌ 不要解释 C 语言基础

---

## §九 Required（≥8）

- ✅ **★ Mermaid defineClass1 跨边界序列图** — 5 lanes: Java ZipFile / Java ClassLoader / Native ClassLoader.c / HotSpot jvm.cpp / Klass — byte[] → GetByteArrayRegion → malloc → VerifyFixClassname → JVM_DefineClassWithSource → SystemDictionary → ClassFileParser → InstanceKlass
- ✅ **★ defineClass1 完整源码** — ClassLoader.c:76-148，展示参数校验 → 字节拷贝 → 类名规范化 → JVM 调用 → 清理
- ✅ **★ defineClass2 源码** — ClassLoader.c:151-211，展示 GetDirectBufferAddress 零拷贝 + 回退路径
- ✅ **★ GetByteArrayRegion vs GetPrimitiveArrayCritical 对比** — memcpy 安全 vs pin heap 风险 + why defineClass1 选择 memcpy
- ✅ **★ 职责分离架构图** — 三层分离：Java 层（I/O + inflate + CRC32）、Native glue（ClassLoader.c）、HotSpot（JVM_DefineClassWithSource → ClassFileParser）
- ✅ **★ 4 Beginner Callout 框** — exact text from §一: defineClass1, GetStringUTFChars, GetByteArrayRegion/SetByteArrayRegion, JVM_DefineClassWithSource
- ✅ **★ GDB 断点 ≥5 条** — 精确到 file:line，每断点有预期变量值，覆盖 defineClass1 entry → GetByteArrayRegion → VerifyFixClassname → JVM_DefineClassWithSource → HotSpot internal
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：class 字节从 Java heap → JNI memcpy → native buffer → JVM internal → ClassFileParser 的完整旅程 + "defineClass1 不读 ZIP"的关键纠正
- ✅ **★ 交叉引用** — 00-Zip-Class-Loading（I/O 来源）、02-Compression-Zlib（Inflater 解压）、02-class-loading（ClassFileParser 消费）、09-native-interface（JNI 机制）、01-Jimage-Format（jimage 也经过 defineClass1）

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: defineClass1 入口 — 参数检查 (ClassLoader.c:76)
  (gdb) break ClassLoader.c:76
  (gdb) print name → 期望: jstring "com.example.Foo"
  (gdb) print length → 期望: >0（有效 class 文件）
  (gdb) print data → 期望: jbyteArray（Java heap 中的 byte[]）
  (gdb) print offset → 期望: 0（通常从头开始）

断言 2: GetStringUTFChars — 类名转换 (ClassLoader.c:93)
  (gdb) break ClassLoader.c:93
  (gdb) print name → 期望: jstring（"com.example.Foo"）
  (gdb) continue
  (gdb) print utfName → 期望: "com/example/Foo" 或 "com.example.Foo"

断言 3: malloc native buffer (ClassLoader.c:106)
  (gdb) break ClassLoader.c:106
  (gdb) print length → 期望: >0
  (gdb) continue
  (gdb) print body → 期望: 非 NULL（malloc 成功）

断言 4: GetByteArrayRegion 字节拷贝 (ClassLoader.c:113)
  (gdb) break ClassLoader.c:113
  (gdb) print data → 期望: jbyteArray（源）
  (gdb) print body → 期望: jbyte* 目标 buffer
  (gdb) print length → 期望: 拷贝长度
  (gdb) continue
  (gdb) print body[0]@4 → 期望: 0xCAFEBABE（.class magic number）

断言 5: VerifyFixClassname 类名规范化 (ClassLoader.c:123)
  (gdb) break ClassLoader.c:123
  (gdb) print utfName → 期望: 函数调用前的类名
  (gdb) continue
  (gdb) print utfName → 期望: '.' 已替换为 '/'（如 "com/example/Foo"）

断言 6: JVM_DefineClassWithSource 调用 (ClassLoader.c:136)
  (gdb) break ClassLoader.c:136
  (gdb) print utfName → 期望: "com/example/Foo" (内部格式)
  (gdb) print loader → 期望: ClassLoader 对象引用
  (gdb) print body → 期望: native buffer 地址
  (gdb) print length → 期望: >0
  (gdb) print pd → 期望: ProtectionDomain 或 NULL
  (gdb) continue
  (gdb) print result → 期望: 非 NULL jclass（类已定义）或 NULL（失败）

断言 7: free(body) 清理 (ClassLoader.c:138)
  (gdb) break ClassLoader.c:138
  (gdb) print body → 期望: 非 NULL
  (gdb) continue (经过 free)
  → body 释放，native buffer 归还

断言 8: defineClass2 零拷贝路径 (ClassLoader.c:168)
  (gdb) break ClassLoader.c:168
  (gdb) print data → 期望: jobject（ByteBuffer）
  (gdb) continue
  (gdb) print body → 期望: 非 NULL（DirectBuffer address）或 NULL（非 direct → 回退）

断言 9: NoClassDefFoundError 错误路径 — 故意传入空 byte[] (ClassLoader.c:106)
  (gdb) break ClassLoader.c:106
  准备一个只有 directory stub 的测试
  (gdb) print length → 期望: 0
  (gdb) print body → 期望: NULL
  (gdb) continue → JVM_DefineClassWithSource(length=0) → ClassFileParser → ClassFormatError
```
