# PROMPT: 请撰写 04-Jar-URL-Nesting.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

Spring Boot fat JAR 部署到生产环境，启动时报错：

```
java.util.zip.ZipException: error in opening zip file
```

应用是 Spring Boot 2.x 打包的 fat JAR（`spring-boot-maven-plugin`）。内部结构：
```
app.jar
├── META-INF/MANIFEST.MF (Main-Class: org.springframework.boot.loader.JarLauncher)
├── BOOT-INF/
│   ├── classes/  (应用类)
│   └── lib/      (依赖 JAR)
│       ├── spring-core.jar
│       ├── spring-boot.jar
│       └── ...
└── org/springframework/boot/loader/  (Spring Boot loader 类)
```

`java.util.zip.ZipFile` 只能处理扁平的真实文件系统中的 ZIP/JAR 文件——当 Spring Boot 的 `LaunchedURLClassLoader` 试图通过 `java -jar` 标准流程加载嵌套 JAR 时，`ZipFile("app.jar!BOOT-INF/lib/spring-core.jar")` 失败——`ZIP_Open`（`zip_util.c:911`）调用 `ZFILE_Open`（`zip_util.c:100`），它期望一个真实的文件路径 → `open("app.jar!BOOT-INF/lib/spring-core.jar")` → 文件不存在 → 返回 `ZIP_ERR_OPEN`。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查 JAR 结构——确认嵌套 JAR 路径
jar tf app.jar | grep "BOOT-INF/lib/.*\.jar$" | head

# 2. 尝试用标准 java.util.zip.ZipFile 读嵌套 entry
python3 -c "
import zipfile
zf = zipfile.ZipFile('app.jar')
# spring-core.jar 作为 ZIP entry 存在，但 ZipFile 不把它当 ZIP
info = zf.getinfo('BOOT-INF/lib/spring-core.jar')
print(f'spring-core.jar: compressed={info.compress_size}, uncompressed={info.file_size}')
# 它的内容就是 spring-core.jar 的字节——需要再解压一次，找到内层 CEN
inner_data = zf.read('BOOT-INF/lib/spring-core.jar')
try:
    inner_zf = zipfile.ZipFile(io.BytesIO(inner_data))
    print(f'Inner JAR entries: {len(inner_zf.infolist())}')
except Exception as e:
    print(f'Cannot open inner JAR: {e}')
"

# 3. GDB 断点验证 ZIP_Open 失败
gdb -ex "break zip_util.c:100" \
    -ex "run" \
    -ex "print name" \
    -ex "continue" \
    --args java -jar app.jar
# name 包含 "!" 字符 → ZFILE_Open 失败 → ZIP_ERR_OPEN
```

**反事实**：如果 `ZipFile` 原生支持嵌套 ZIP（自动检测路径中的 `!` → inflate 外层 entry → parse 内层 CEN）→ Spring Boot 不需要自己实现 `LaunchedURLClassLoader` + `org.springframework.boot.loader.jar.Handler`。这是 JDK 13+ 引入 `jdk.nio.zipfs`（`ZipFileSystemProvider`）的原因——提供 NIO 文件系统视图，让嵌套 JAR 像普通目录一样访问。但 JDK 11 没有这个特性，Spring Boot 必须自实现。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the nested JAR resolution problem and its solutions: standard `ZipFile` limitations → `JarURLConnection` protocol → Spring Boot `LaunchedURLClassLoader` → JDK 13+ `zipfs`. This is NOT a Spring Boot tutorial. This is ENGINEERING documentation: why `java.util.zip.ZipFile` fails on nested entries and how the JVM ecosystem works around it.

Reader knows from **00-Zip-Class-Loading** HOW `ZipFile` reads flat JARs. Reader knows from **03-ClassLoader-Bridge** HOW `defineClass1` bridges to HotSpot. This doc answers: **what happens when the JAR itself is inside another JAR, and the class loader must descend two levels to find `.class` bytes.**

### Beginner Callout Boxes（文档中必须出现的 4 个 callout 框）

1. **Nested ZIP / fat JAR**：一个 ZIP/JAR 文件作为另一个 ZIP/JAR 文件的 entry 存在。外层 JAR 的 CEN 中有一个 entry 叫 `BOOT-INF/lib/spring-core.jar`，它的内容恰好是另一个完整的 ZIP 文件（有 CEN + LOC headers + DEFLATE 压缩的 entry）。标准 `java.util.zip.ZipFile` 只能将 `BOOT-INF/lib/spring-core.jar` 当作不透明字节流（通过 `getInputStream` 获得其压缩内容），不能将其当作内层 ZIP 去查找 entry。需要额外处理：先 inflate 外层 entry → 得到内层 ZIP 的字节 → 在内存中 parse 内层 CEN → 再 inflate 内层 entry。

2. **LaunchedURLClassLoader**：Spring Boot 的自定义 URLClassLoader 子类（`org.springframework.boot.loader.LaunchedURLClassLoader`）。标准 `URLClassLoader` 在 `-jar` 模式下用 `java.net.URLClassLoader.findClass(name)` → `URLClassPath.getResource(name)` → `JarLoader.getResource(name)`——而 `JarLoader` 只能处理扁平 JAR（调用 `java.util.jar.JarFile`）。Spring Boot 替换了整个 loader 链：自定义 `LaunchedURLClassLoader` → 自定义 `JarFile`（`org.springframework.boot.loader.jar.JarFile`）→ 自定义 `Handler`（`org.springframework.boot.loader.jar.Handler`，处理 `jar:file:...` URL 协议）。

3. **JDK 13+ zipfs**：`jdk.nio.zipfs` 模块提供的 `ZipFileSystemProvider`，将 ZIP/JAR 文件作为 NIO `FileSystem` 暴露。支持嵌套 ZIP：`FileSystems.newFileSystem(URI.create("jar:file:///app.jar"), env)` 创建顶层文件系统 → 访问 `BOOT-INF/lib/spring-core.jar` → `FileSystems.newFileSystem(innerPath, env)` 创建内层文件系统 → 最终访问 `org/springframework/...`。原理：zipfs 在读取时 inflate 外层 entry → 在内存中 parse 内层 CEN → 构建内层文件系统视图。

4. **JarURLConnection**：`java.net.JarURLConnection` extends `URLConnection`。处理 `jar:` scheme 的 URL：`jar:<url>!/{entry}`。打开时，解析 `<url>` 为 ZipFile → 定位 `{entry}` → 返回该 entry 的 InputStream。对于嵌套 JAR（`jar:file:///outer.jar!/inner.jar!/`），需要递归解析——打开 outer JAR → 定位 inner.jar entry → 打开 inner JAR → 定位目标 entry。JDK 11 的 `JarURLConnection` 仅支持**单层** `!` 分隔，不支持 `jar:jar:file:...` 递归。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

**注意**：本节内容跨 JDK 版本——JDK 11 不含 `jdk.nio.zipfs` 的嵌套支持（但 `zipfs` 模块在 JDK 9+ 已引入基础版本）。嵌套 ZIP 解析在 JDK 13+ 成熟。Spring Boot 2.x 适配 JDK 8-11（用自己的 loader）。

Source roots（JDK side）：
- `src/java.base/share/native/libzip/zip_util.c` — `ZIP_Open`、`ZIP_GetEntry2`
- `src/java.base/share/classes/java/net/JarURLConnection.java` — JAR URL 协议处理
- `src/jdk.zipfs/share/classes/jdk/nio/zipfs/ZipFileSystem.java` — JDK 13+ zipfs 实现（不在 JDK 11 中，但本 prompt 作为 contextual reference）

Source roots（Spring Boot side — 概念参考，非 JDK 源码）：
- `org.springframework.boot.loader.JarLauncher` — fat JAR 启动器
- `org.springframework.boot.loader.LaunchedURLClassLoader` — 自定义 URLClassLoader
- `org.springframework.boot.loader.jar.Handler` — URL stream handler
- `org.springframework.boot.loader.jar.JarFile` — 自定义 ZIP 读取器

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **zip_util.c** | `src/java.base/share/native/libzip/zip_util.c` | 1697 | `ZIP_Open`(:911), `ZIP_GetEntry`(:1145), `ZIP_Read`(:1340) | 标准 ZIP 读取——**fail on nested paths**（期望真实文件） |
| 2 | **JarURLConnection.java** | `src/java.base/share/classes/java/net/JarURLConnection.java` | — | `getJarFile()`, `getJarEntry()`, `connect()` | JAR URL 协议（`jar:file:...`）的标准 Java 处理 |
| 3 | **URLClassLoader.java** | `src/java.base/share/classes/java/net/URLClassLoader.java` | — | `findClass()`, `URLClassPath` | 标准 classpath URL 的类加载器——**不支持嵌套 JAR** |
| 4 | **ZipFileSystem.java** | `src/jdk.zipfs/share/classes/jdk/nio/zipfs/ZipFileSystem.java` | — | `getFileSystem()`, `newFileSystem()`, `getPath()` | JDK 13+ zipfs — 支持嵌套 ZIP 作为 NIO FileSystem |
| 5 | **Spring Boot JarFile** (概念) | `org.springframework.boot.loader.jar.JarFile` | — | `getNestedJarFile()`, `getEntry()` | Spring Boot 自定义嵌套 JAR 支持 |

**关键澄清**：
- 标准 `ZipFile` 不处理嵌套 ZIP entry——`ZIP_Open` 期望真实文件系统路径
- Spring Boot 2.x 自己的 `JarFile` 实现检测嵌套 JAR → inflate 外层 entry → parse 内层 CEN
- JDK 13+ zipfs 在 NIO 层面解决嵌套 ZIP 的通用问题

---

## §四 Deep Dive Question Groups（≥5，EXACT questions + answer directions）

### 4.1 ★★★ Standard ZipFile limitation — why ZIP_Open fails

```
问题：
  ① 为什么标准 java.util.zip.ZipFile 无法打开嵌套 JAR entry？
     答案方向：java.util.zip.ZipFile 构造函数 → native ZIP_Open(path)（zip_util.c:911）
     → ZIP_Open_Generic(name, ...)（zip_util.c:763）
     → ZFILE_Open(name)（zip_util.c:100）→ Linux: open(name, O_RDONLY)
     → 期望 name 是真实的文件路径（如 "/path/to/app.jar"）。
     如果传入 "app.jar!BOOT-INF/lib/spring-core.jar" → open() 返回 -1（文件不存在）
     → ZIP_ERR_OPEN → ZipFile 构造失败。

     根本限制：ZIP_Open 的设计假设 ZIP/JAR 文件在文件系统上独立存在。
     它通过 ZFILE_Open 获取 fd → lseek 读 CEN → parse 哈希表。
     嵌套 ZIP entry 的内容在另一个 ZIP entry 的数据区——没有独立的文件系统路径。
     要读它需要：先打开外层 JAR → ZIP_GetEntry2 找到嵌套 entry → ZIP_Read 读取 → 
     inflate → 得到内层 JAR 的字节 blob → 在内存中 parse 内层 CEN。

  ② Counterfactual：如果 ZIP_Open 检测到 "!" 分隔符 → 自动递归打开？
     答案方向：需要在 ZIP_Open 内部实现完整的嵌套 ZIP 打开逻辑——
     parse "!" → 分离外层路径和内层 entry 名 → 先打开外层 → 哈希查找嵌套 entry
     → inflate → 在内存中构建内层哈希表。复杂性高：
     - 嵌套可能超过 2 层（fat JAR → nested JAR → nested nested JAR...）
     - 内存管理：外层 ZIP 句柄和内层 ZIP 句柄的生命周期需要协调
     - 性能：每次访问嵌套 JAR → 2x inflate（外层 entry + 内层 entry）
     JDK 早期选择不实现（KISS），留给应用层（Spring Boot）解决。
     JDK 13+ 在 zipfs 中提供了这个能力，但作为 NIO 文件系统层而非底层 native 层。
```

### 4.2 ★★★ JarURLConnection — the JAR URL protocol

```
问题：
  ① JarURLConnection 的 URL 格式 `jar:file:///app.jar!/path/inside` 如何解析？
     答案方向：java.net.JarURLConnection 解析 URL：
       1. 剥离 "jar:" 前缀 → 得到内部 URL（file:///app.jar）
       2. 找到 "!" 分隔符 → 左边是 JAR 文件 URL，右边是内部 entry 路径
       3. 创建 JarFile 实例（通过缓存：JarFileFactory.get()）→ 调用 ZIP_Open
       4. getJarEntry("path/inside") → ZIP_GetEntry 哈希查找
       5. getInputStream() → ZIP_Read + Inflater.inflate

     关键限制：JarURLConnection 只支持 **一层** "!" 分隔。即只支持
     `jar:file:///app.jar!/entry`，不支持 `jar:jar:file:///app.jar!/inner.jar!/entry`。

     追问：为什么不支持多层嵌套？→ JarURLConnection 的实现假定内部 URL
     是 file: 或其他标准协议 → 如果内部 URL 也是 jar: → 需要递归解析
     → 形成 jar:jar:file:... URL 链。JDK 11 的 URL handler 没有这种递归支持。

  ② Counterfactual：如果 JarURLConnection 支持递归 jar: URL？
     答案方向：Spring Boot 的 fat JAR 直接受益——`URLClassLoader` 可以用
     `jar:jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar!/org/springframework/...`
     类 URL → 标准类加载器自动解析。但需要：递归 inflate（外层 entry → 内层 JAR → 
     inflate 内层 entry）+ 多级 JarFile 缓存 → 复杂度剧增。JDK 团队选择把递归
     嵌套支持移到 zipfs（完整的 NIO FileSystem 抽象），保持 java.net.URL 层简单。
```

### 4.3 ★★★ Spring Boot LaunchedURLClassLoader — custom nested JAR support

```
问题：
  ① Spring Boot LaunchedURLClassLoader 如何解析嵌套 JAR 中的类？
     答案方向（概念级别——Spring Boot 非 JDK 源码，但机制值得描述）：
       1. JarLauncher.main() 被 libjli 调用 → 创建 LaunchedURLClassLoader
       2. LaunchedURLClassLoader 构造时扫描 BOOT-INF/lib/*.jar (as ZIP entries)
       3. 对于每个嵌套 JAR entry，创建自定义 JarFile 实例（Spring Boot 的 JarFile）
       4. Spring Boot JarFile 检测 ZIP entry type：
          - 如果 entry 本身是 ZIP/JAR（通过检查 entry 名后缀 + magic bytes）
          → 创建 NestedJarFile（内层 ZIP 文件视图）
          → inflate 外层 entry → 在内存中 parse 内层 CEN → 构建内层哈希表
       5. findClass 时：LaunchedURLClassLoader 遍历所有注册的 JarFile
          → JarFile.getEntry("org/springframework/...") → ZIP_GetEntry 在内层 CEN
          → getInputStream → inflate → byte[] → defineClass

     追问：Spring Boot JarFile 如何检测 entry 是嵌套 JAR？
     → 检查 entry 名的后缀（.jar）→ 读取 entry 内容的前几个字节
     → 检查 ZIP magic number（PK\x03\x04 = LOC header signature）
     → 如果是 → 视为嵌套 JAR → 在内存中构建内层 ZIP 视图。

  ② Counterfactual：如果 Spring Boot 不使用自定义 JarFile，每条依赖单独打包在 fat JAR 根部？
     答案方向：fat JAR 根部会有 200+ 个 class 文件（来自 spring-core, spring-boot, 
     jackson, hibernate...）→ 根目录变得不可管理。
     更糟：不同依赖可能有同名 class（如 META-INF/MANIFEST.MF 每个 JAR 都有）
     → 文件名冲突。嵌套 JAR 做命名空间隔离：每个依赖的 class 在其内部保持
     原有的包层次结构，通过内层 CEN 的路径范围限定了命名空间。
```

### 4.4 ★★★ JDK 13+ zipfs — NIO filesystem for nested ZIP

```
问题：
  ① JDK 13+ zipfs 如何将嵌套 JAR 暴露为 NIO FileSystem？
     答案方向（概述——不在 JDK 11 中，但作为演进的参考）：
       1. 创建顶层 FileSystem：
          FileSystem fs = FileSystems.newFileSystem(URI.create("jar:file:///app.jar"), env)
       2. 获取嵌套 JAR 作为 Path：
          Path innerJar = fs.getPath("/BOOT-INF/lib/spring-core.jar")
       3. 创建内层 FileSystem：
          FileSystem innerFs = FileSystems.newFileSystem(innerJar, null)
       4. 访问内层 class：
          Path classFile = innerFs.getPath("/org/springframework/boot/SpringApplication.class")
          byte[] bytes = Files.readAllBytes(classFile)
     内部实现：ZipFileSystem 在读取 entry 时检测内容是否是 ZIP 格式
     → 如果是 → 在内存中 cache 内层 CEN → 暴露为嵌套 FileSystem。

  ② Counterfactual：如果 zipfs 从 JDK 1.0 就存在？
     答案方向：Spring Boot 可能不需要自己的 JarFile 实现。
     统一 `java.nio.file.Path` API 处理扁平 JAR 和嵌套 JAR → 
     所有类加载器（URLClassLoader 等）不需要区分"真实文件"和"ZIP entry"。
     JDK 21+ 的模块系统 + zipfs 已经让 fat JAR 对 JDK 更透明，
     但历史遗留的 Spring Boot 自己的 loader 仍在广泛使用。
```

### 4.5 ★★★ Performance — 2x inflate cost for nested JAR

```
问题：
  ① 嵌套 JAR 类加载的性能成本是什么？
     答案方向：两次 inflate 操作：
       1. 首次打开嵌套 JAR：inflate 外层 entry（spring-core.jar 的压缩字节）
          → 得到内层 JAR 的完整字节 blob（可能 1-5 MB）
          → parse 内层 CEN → 构建内层哈希表 → ~2-5ms
       2. 每次类加载：inflate 内层 entry（org/springframework/...class 的压缩字节）
          → 与扁平 JAR 相同（~0.02ms per class）
     所以嵌套 JAR 的首次打开有额外的一次 inflate 成本（2-5ms for 1-5MB 内层 JAR），
     后续每个 class 的 inflate 成本与扁平 JAR 相同。Spring Boot 还做了内层 JarFile
     缓存——同一嵌套 JAR 的多个 class 共享内层哈希表，不需要重复 inflate 外层 entry。

  ② Counterfactual：如果嵌套 JAR 无需 double-inflate——通过某种零拷贝共享外层 inflate 的压缩数据？
     答案方向：嵌套 JAR 的字节在 DEFLATE 后整体作为外层 entry 的压缩数据存储。
     inflate 外层 entry 时输出的是内层 JAR 的原始 ZIP 字节。无法跳过这一步——
     DEFLATE 是流压缩，必须从压缩流的开头顺序解码到内部的目标位置。
     ZIP 的随机访问是基于 entry 粒度的（inflate 整个 entry），不能只 inflate
     嵌套 JAR 的内部某个 class。如果需要在嵌套 JAR 内部随机访问 class →
     必须先 inflate 外层 entry → 得到内层 JAR 的所有字节 →
     然后在内层 JAR 上用标准的 CEN 偏移（内层 ZIP 的 CEN offset）定位内层 class。
     这是根因上的性能成本，无法避免。
```

---

## §五 Article Structure

```
§〇 生产场景 — Spring Boot fat JAR: ZipException "error in opening zip file"
  ★ Root cause：标准 ZipFile 用 ZIP_Open → ZFILE_Open 期望真实文件路径
  ★ 三步诊断：jar tf → python zipfile 嵌套读 → GDB ZIP_Open 失败
  ★ 反事实：如果 ZipFile 原生支持嵌套 → Spring Boot 不需要自定义 JarFile

§一 ★★★ 嵌套 JAR 问题全谱系
  ❓ 这不是 Spring Boot 教程——这是 ZIP 格式在嵌套场景下的工程处理
  ❓ Reader 从 00-Zip + 03-Bridge 来——理解扁平 JAR 的读取链路
  1.1 标准 ZipFile 的限制：ZIP_Open → ZFILE_Open → expect real file path
      ├─ zip_util.c:911 → zip_util.c:763 → zip_util.c:100
      ├─ 嵌套路径 "app.jar!BOOT-INF/lib/..." 不是有效的文件路径
      └─ ZIP_ERR_OPEN → ZipFile 构造失败
  1.2 JarURLConnection 协议：jar:file:...!/entry
      ├─ 解析 "jar:" 前缀 + "!" 分隔符
      ├─ 只支持一层嵌套（无 jar:jar:... 支持）
      └─ Java 标准 URL handler 架构
  1.3 Spring Boot LaunchedURLClassLoader — 自定义嵌套解析
      ├─ 扫描 BOOT-INF/lib/*.jar entries
      ├─ 创建自定义 JarFile → inflate 外层 entry → parse 内层 CEN
      └─ findClass → 内层 ZIP_GetEntry → inflate → byte[] → defineClass
  1.4 JDK 13+ zipfs — NIO FileSystem 通用嵌套 ZIP
      ├─ ZipFileSystemProvider → newFileSystem(URI)
      ├─ 多层嵌套：fs → innerJar → innerFs → class
      └─ 内存中 cache 内层 CEN

§二 ★★★ 性能分析 — double-inflate 成本
  2.1 首次打开嵌套 JAR：inflate 外层 entry + parse 内层 CEN ~2-5ms
  2.2 后续类加载：与扁平 JAR 相同 ~0.02ms/class
  2.3 Spring Boot caching 策略：内层 JarFile 缓存 → 共享内层哈希表

§三 ★★★ 4 Beginner Callout 框
   3.1 Nested ZIP / fat JAR — 什么是嵌套 ZIP
   3.2 LaunchedURLClassLoader — Spring Boot 自定义 loader
   3.3 JDK 13+ zipfs — NIO 文件系统视图
   3.4 JarURLConnection — JAR URL 协议处理

§四 ★ GDB 断点验证 — 验证 ZIP_Open 失败路径
  断言 1: ZIP_Open 入口 (zip_util.c:911) — inspect path
  断言 2: ZFILE_Open 失败 (zip_util.c:100) — path contains "!"
  断言 3: Spring Boot JarFile 创建 — inspect nested entry handling

§五 ★ Cross-Reference
  ❓ 00-Zip-Class-Loading — ZIP_Open/ZIP_GetEntry2 (标准化扁平读取)
  ❓ 03-ClassLoader-Bridge — defineClass1 消费最终 byte[]
  ❓ 13-launcher — LoadMainClass 在 -jar 模式下如何触发 JarLauncher
  ❓ 02-class-loading — ClassFileParser 消费类字节
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because ZIP_Open's design assumes the JAR file lives independently on the native filesystem with its own inode and file descriptor, it cannot follow a virtual path like 'outer.jar!inner.jar!class' where the inner JAR exists only as a stream of bytes within the outer JAR's data area..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from `zip_util.c` or Java code from `JarURLConnection.java`, do not describe it.

3. **Mermaid** — nested JAR resolution sequence diagram. 4 lanes: Application / ClassLoader / ZipFile / Filesystem. Flow for Spring Boot: `java -jar app.jar` → `JarLauncher.main()` → `LaunchedURLClassLoader` → scan `BOOT-INF/lib/` → create custom `JarFile` for each nested JAR → `getInputStream(nestedJarEntry)` → inflate outer → parse inner CEN → build inner hash table → `findClass("org.springframework...")` → `getEntry("org/springframework/...")` → `getInputStream` → inflate → `byte[]` → `defineClass`. Annotate where standard ZipFile fails and custom code takes over.

4. **GDB session** — 3 breakpoints:
   - `zip_util.c:911` — ZIP_Open entry (inspect path with "!")
   - `zip_util.c:100` — ZFILE_Open failure (path not real file)
   - `ClassLoader.c:76` — defineClass1 receiving bytes from nested JAR path

5. **4 Beginner callout boxes** — exact text from §一: Nested ZIP / fat JAR, LaunchedURLClassLoader, JDK 13+ zipfs, JarURLConnection.

6. **Cross-reference at three points**:
   - At `ZIP_Open` failure → "→ 00-Zip-Class-Loading: why ZIP_Open expects a real filesystem path"
   - At `LaunchedURLClassLoader.findClass` → "→ 03-ClassLoader-Bridge: defineClass1 receives the byte[] from the nested path"
   - At zipfs `newFileSystem` → "→ JDK 13+ solution that makes the nested ZIP transparent to the class loader"

7. **Story-format interview answer** — at §一末尾："Spring Boot fat JAR 如何加载嵌套 JAR 中的类？" — narrative from fat JAR structure → standard ZipFile fails → Spring Boot custom JarFile inflates outer entry → parses inner CEN → loads class. Three eras: JDK <9 (only classpath), JDK 9-12 (modules but zipfs immature), JDK 13+ (mature zipfs).

---

## §七 Output Format

- Markdown file，named `04-Jar-URL-Nesting.md`
- Output path：`/data/workspace/openjdk-cut-new/probe_md/14-zip-jimage/`
- 元信息头：

```
> **阶段**：[14-zip-jimage]
> **前置**：[00-Zip-Class-Loading]（理解标准 ZipFile 的读取机制——ZIP_Open/ZIP_GetEntry2）、[03-ClassLoader-Bridge]（defineClass1 接收最终字节）
> **配套**：无
> **后续依赖本文**：无
> **阅读收益**：追踪嵌套 JAR 的完整问题谱系——理解标准 ZipFile 的 ZIP_Open → ZFILE_Open 为何在嵌套路径上失败（期望真实文件）、JarURLConnection 的 jar:file:...!/entry 协议、Spring Boot LaunchedURLClassLoader 的自定义嵌套 JAR 解析（inflate 外层 entry → parse 内层 CEN）、JDK 13+ zipfs 的 NIO FileSystem 通用嵌套 ZIP 方案、嵌套 JAR 的 2x inflate 性能成本（首次打开 + 每次类加载）；掌握 "error in opening zip file" 的 fat JAR 诊断 workflow
```

- 目标行数：300+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说"ZipFile 不能读嵌套 JAR"不展示 WHY — 必须展示 ZIP_Open → ZFILE_Open 的期望文件路径假设
- ❌ 不解释 JarURLConnection 的 "jar:" 和 "!" 分隔符语义 — 必须展示 URL 解析流程
- ❌ 忘记提及 Spring Boot LaunchedURLClassLoader — 这是生产中最常见的嵌套 JAR 解决方案
- ❌ 不对比 JDK 11 (无 zipfs 嵌套) vs JDK 13+ (有 zipfs) — 必须展示演进路径
- ❌ 不做嵌套 JAR 的性能分析 — 必须展示 2x inflate 成本（外层 entry + 内层 entry）
- ❌ 忽略 Spring Boot JarFile 缓存策略 — 必须展示内层 JarFile 缓存如何避免重复 inflate
- ❌ 不做 fat JAR 结构图 — 必须展示 app.jar 的内部布局（META-INF / BOOT-INF/classes / BOOT-INF/lib/）
- ❌ 忘记交叉引用 00-Zip 和 03-Bridge — 必须展示标准路径失败 → 自定义路径成功 → defineClass1 消费
- ❌ 不要展开 Spring Boot 源码细节（非 JDK）
- ❌ 不要解释 ZIP 格式基础（00 覆盖）

---

## §九 Required（≥8）

- ✅ **★ Mermaid 嵌套 JAR 解析序列图** — 4 lanes: Application / ClassLoader / ZipFile / Filesystem — fat JAR → LaunchedURLClassLoader → scan BOOT-INF/lib → create custom JarFile → inflate outer → parse inner CEN → findClass → inflate inner → byte[] → defineClass
- ✅ **★ ZIP_Open failure path 源码** — zip_util.c:911 → 763 → 100，展示为什么 "!" 路径失败
- ✅ **★ Fat JAR 结构图** — app.jar / META-INF / BOOT-INF/classes / BOOT-INF/lib/*.jar / org/...loader
- ✅ **★ JarURLConnection URL 解析源码** — jar:file:...!/entry 的解析流程
- ✅ **★ Spring Boot LaunchedURLClassLoader 概述** — 自定义 JarFile → inflate outer → parse inner CEN 机制
- ✅ **★ JDK 13+ zipfs 嵌套 FileSystem 示例** — FileSystems.newFileSystem 多层嵌套
- ✅ **★ 4 Beginner Callout 框** — exact text from §一: Nested ZIP / fat JAR, LaunchedURLClassLoader, JDK 13+ zipfs, JarURLConnection
- ✅ **★ GDB 断点 ≥3 条** — 验证 ZIP_Open 失败 + 自定义路径成功
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事："Spring Boot fat JAR 如何加载嵌套 JAR 中的类？" — 从标准路径失败到 Spring Boot 方案到 JDK 13+ zipfs 的三个时代
- ✅ **★ 性能对比** — 扁平 JAR (1x inflate per class) vs 嵌套 JAR (首次 2x inflate, 后续 1x) + 缓存策略

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: ZIP_Open 入口 — 路径包含 "!" (zip_util.c:911)
  (gdb) break zip_util.c:911
  运行: java -jar app.jar (Spring Boot fat JAR)
  (gdb) print name → 期望: 普通路径（如 "app.jar"）不包含 "!"
  → 顶层 JAR 正常打开

断言 2: Spring Boot 内部创建嵌套 JAR 的 JarFile (zip_util.c:911)
  (gdb) break zip_util.c:911
  (gdb) print name → 期望: 如果是嵌套路径 → 可能包含 "!" 或其他标记
  → Spring Boot 自己的 JarFile 不调用标准 ZIP_Open

断言 3: 标准 ZipFile 尝试打开嵌套路径 — 失败 (zip_util.c:100)
  故意构造测试：java -cp "app.jar!BOOT-INF/lib/spring-core.jar" SomeClass
  (gdb) break zip_util.c:100
  (gdb) print name → 期望: "app.jar!BOOT-INF/lib/spring-core.jar"
  (gdb) continue
  → open() 返回 -1 (文件不存在) → ZIP_ERR_OPEN → ZipException

断言 4: Spring Boot JarLauncher.main() 入口 — 验证 loader 类型
  (gdb) break java.c:1634
  (gdb) print mainClassName → 期望: "org.springframework.boot.loader.JarLauncher"
  → 标准 LoadMainClass 结果 → 启动 Spring Boot loader

断言 5: defineClass1 接收来自嵌套 JAR 的字节 (ClassLoader.c:76)
  (gdb) break ClassLoader.c:76
  来自 Spring Boot LaunchedURLClassLoader 的类加载
  (gdb) print name → 期望: "org/springframework/boot/SpringApplication"
  (gdb) print length → 期望: >0 (有效的 class 字节)
  → 字节来自嵌套 JAR 的 inflate 路径

 断言 6: zipfs 嵌套 FileSystem 创建 (JDK 13+)
   (gdb) break zip_util.c:911
   使用 JDK 13+ zipfs API
   (gdb) print name → 期望: 顶层 JAR 路径（标准文件）
   → 内层 zipfs 在 Java 层处理嵌套

 断言 7: JarURLConnection.connect() — 嵌套 URL 解析
   (gdb) break JarURLConnection.java:connect()
   构造: new URL("jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF")
   (gdb) print this.url → 期望: jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF
   (gdb) continue
   → handler 识别 "jar:" scheme → 剥离外层 jar: → 打开 app.jar 为 ZipFile → locate "BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF"
   → 单层 "!" 解析限制暴露：entry 名包含 "!" 但在 CEN 哈希查找时无法找到（真实 entry 名不含 "!"）
   
 断言 8: ZipFile.<init>(File) — 嵌套提取的二次 inflate
   (gdb) break java.util.zip.ZipFile.<init>(File)
   Spring Boot LaunchedURLClassLoader 打开嵌套 JAR 时触发
   (gdb) print file → 期望: 临时文件路径或嵌套 JAR 名称
   → new ZipFile → new ZIP_Open → 独立 CEN 读取
   → "2x decompression" 可视化：第一次 inflate 从外层 JAR 提取嵌套 JAR 字节（GDB 断点 zip_util.c:1340），
      第二次 inflate 从内层 JAR 提取 .class 字节（同一断点再次命中）
```
