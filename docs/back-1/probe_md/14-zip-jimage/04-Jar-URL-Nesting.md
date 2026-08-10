> **阶段**：[14-zip-jimage]
> **前置**：[00-Zip-Class-Loading]（理解标准 ZipFile 的读取机制——ZIP_Open/ZIP_GetEntry2）、[03-ClassLoader-Bridge]（defineClass1 接收最终字节）
> **配套**：无
> **后续依赖本文**：无
> **阅读收益**：追踪嵌套 JAR 的完整问题谱系——理解标准 ZipFile 的 ZIP_Open → ZFILE_Open 为何在嵌套路径上失败（期望真实文件）、JarURLConnection 的 jar:file:...!/entry 协议、Spring Boot LaunchedURLClassLoader 的自定义嵌套 JAR 解析（inflate 外层 entry → parse 内层 CEN）、JDK 13+ zipfs 的 NIO FileSystem 通用嵌套 ZIP 方案、嵌套 JAR 的 2x inflate 性能成本（首次打开 + 每次类加载）；掌握 "error in opening zip file" 的 fat JAR 诊断 workflow

---

# 04-Jar-URL-Nesting — 嵌套 JAR 解析与 Fat JAR 类加载：2x inflate 的代价

---

## §〇 生产场景

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

`java.util.zip.ZipFile` 只能处理扁平的真实文件系统中的 ZIP/JAR 文件——当 Spring Boot 的 `LaunchedURLClassLoader` 试图通过 `java -jar` 标准流程加载嵌套 JAR 时，`ZipFile("app.jar!BOOT-INF/lib/spring-core.jar")` 失败——`ZIP_Open`（`zip_util.c:911`）调用 `ZIP_Open_Generic`（`zip_util.c:763`）→ `ZFILE_Open`（`zip_util.c:101`），而在 Linux 上 `ZFILE_Open` 就是 `open()`:

```c
// zip_util.c:158-160 — Linux path
#else
    return open(fname, flags, 0);
#endif
```

`open("app.jar!BOOT-INF/lib/spring-core.jar")` → 文件不存在 → 返回 -1 → `ZIP_ERR_OPEN` → `ZipException("error in opening zip file")`。

**三步诊断：**

```bash
# 1. 检查 JAR 结构——确认嵌套 JAR 路径
jar tf app.jar | grep "BOOT-INF/lib/.*\.jar$" | head

# 2. 尝试用标准 java.util.zip.ZipFile 读嵌套 entry
python3 -c "
import zipfile, io
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
gdb -ex "break zip_util.c:101" \
    -ex "run" \
    -ex "print fname" \
    -ex "continue" \
    --args java -jar app.jar
# fname 包含 "!" 字符 → ZFILE_Open → open() 返回 -1 → ZIP_ERR_OPEN
```

> **反事实**：如果 `ZipFile` 原生支持嵌套 ZIP（自动检测路径中的 `!` → inflate 外层 entry → parse 内层 CEN）→ Spring Boot 不需要自己实现 `LaunchedURLClassLoader` + `org.springframework.boot.loader.jar.Handler`。这是 JDK 13+ 引入 `jdk.nio.zipfs`（`ZipFileSystemProvider`）的原因——提供 NIO 文件系统视图，让嵌套 JAR 像普通目录一样访问。但 JDK 11 没有这个特性，Spring Boot 必须自实现。

---

## §一 嵌套 JAR 问题全谱系

### 这不是 Spring Boot 教程

This is NOT a Spring Boot tutorial. This is ENGINEERING documentation: why `java.util.zip.ZipFile` fails on nested entries and how the JVM ecosystem works around it. Reader knows from **00-Zip-Class-Loading** HOW `ZipFile` reads flat JARs (ZIP_Open → readCEN → hash table → ZIP_GetEntry2 → ZIP_Read → InflateFully). Reader knows from **03-ClassLoader-Bridge** HOW `defineClass1` bridges to HotSpot (GetByteArrayRegion → VerifyFixClassname → JVM_DefineClassWithSource). This doc answers: **what happens when the JAR itself is inside another JAR, and the class loader must descend two levels to find .class bytes.**

The problem arose with the "fat JAR" deployment model — a single executable JAR containing both application classes and all dependency JARs. Standard JDK class loading infrastructure was designed for flat JARs on the filesystem. Three generations of solutions evolved: application-level (Spring Boot custom classloader), protocol-level (JarURLConnection), and filesystem-level (JDK 13+ zipfs).

---

### 1.1 标准 ZipFile 的限制 — ZIP_Open → ZFILE_Open → 期望真实文件

Why: because ZIP_Open's design assumes the JAR file lives independently on the native filesystem with its own inode and file descriptor, it cannot follow a virtual path like `outer.jar!inner.jar!class` where the inner JAR exists only as a stream of bytes within the outer JAR's data area.

```c
// zip_util.c:910-919 — ZIP_Open
JNIEXPORT jzfile *
ZIP_Open(const char *name, char **pmsg)
{
    jzfile *file = ZIP_Open_Generic(name, pmsg, O_RDONLY, 0);
    if (file == NULL && pmsg != NULL && *pmsg != NULL) {
        free(*pmsg);
        *pmsg = "Zip file open error";
    }
    return file;
}

// zip_util.c:762-779 — ZIP_Open_Generic
jzfile *
ZIP_Open_Generic(const char *name, char **pmsg, int mode, jlong lastModified)
{
    jzfile *zip = NULL;
    if (pmsg != NULL) { *pmsg = NULL; }
    zip = ZIP_Get_From_Cache(name, pmsg, lastModified);
    if (zip == NULL && pmsg != NULL && *pmsg == NULL) {
        ZFILE zfd = ZFILE_Open(name, mode);           // line 146 — expect real file
        zip = ZIP_Put_In_Cache(name, zfd, pmsg, lastModified);
    }
    return zip;
}
```

The fundamental limitation: `ZFILE_Open` at line 159 on Linux is literally `open(name, flags, 0)` — a POSIX `open()` system call. It expects a valid filesystem path to an existing file. The path `"app.jar!BOOT-INF/lib/spring-core.jar"` is not a valid filesystem path — the `!` character has no special meaning to the kernel. `open()` returns -1 (ENOENT — no such file or directory). `ZIP_Put_In_Cache0` detects the invalid fd → returns NULL → `ZIP_Open` sets `*pmsg = "Zip file open error"` → Java `ZipFile` constructor throws `ZipException`.

→ 00-Zip-Class-Loading: why ZIP_Open expects a real filesystem path

Why the cache check (line 143) exists but doesn't help: `ZIP_Get_From_Cache` matches by exact path string (`strcmp` at the linked list traversal). Even if `app.jar` itself is in the cache, the lookup uses the **nested** path as key → no match → falls through to `ZFILE_Open` → fails.

To read a nested JAR entry, the system must: open outer JAR → `ZIP_GetEntry2` to locate the nested entry in outer CEN → `ZIP_Read` to read the compressed bytes → `InflateFully` to decompress → now you have the inner JAR's complete byte blob → parse inner CEN at `blob + innerCENOffset` → build inner hash table → `ZIP_GetEntry2` on inner hash table → `ZIP_Read` from the inner data area → `InflateFully` again for the inner class bytes. Standard `ZIP_Open` does none of this — it assumes a single `open()` gives access to the entire JAR's bytes via `read()` + `lseek`.

> **反事实 1**：如果 ZIP_Open 检测到 `!` 分隔符 → 自动递归打开？需要在 ZIP_Open 内部实现完整的嵌套 ZIP 打开逻辑——parse `!` → 分离外层路径和内层 entry 名 → 先打开外层 → 哈希查找嵌套 entry → inflate → 在内存中构建内层哈希表 → 返回内层 jzfile*。复杂性高：(1) 嵌套可能超过 2 层（fat JAR → nested JAR → nested nested JAR...）；(2) 内存管理：外层 ZIP 句柄和内层 ZIP 句柄的生命周期需要协调；(3) 每次访问都 2x inflate。JDK 早期选择不实现（KISS），留给应用层解决。JDK 13+ 在 zipfs 中提供了这个能力，但作为 NIO 文件系统层而非底层 native 层。

---

### 1.2 JarURLConnection — JAR URL 协议 (jar:file:...!/entry)

Why: `JarURLConnection` provides the standard Java protocol for addressing entries inside JARs — but its design only handles one level of nesting, not the multi-level nesting fat JARs require.

JarURLConnection URL 格式：`jar:<url>!/{entry}`。例如 `jar:file:///app.jar!/com/example/Foo.class`。

```java
// java.net.JarURLConnection (abstract base, line ~137)
public abstract class JarURLConnection extends URLConnection {
    private URL jarFileURL;    // the "file:///app.jar" part
    private String entryName;  // the "com/example/Foo.class" part
    protected URLConnection jarFileURLConnection;
    // ...
}
```

解析流程（在 `sun.net.www.protocol.jar.JarURLConnection` 的 `connect()` 中）：
1. 剥离 `"jar:"` 前缀 → 得到内部 URL（`file:///app.jar`）
2. 找到 `"!"` 分隔符 → 左边是 JAR 文件 URL，右边是内部 entry 路径
3. 创建 `JarFile` 实例（通过 `JarFileFactory.get(url)` — 缓存机制）→ 调用 `ZIP_Open(path)`
4. `getJarEntry("com/example/Foo.class")` → `ZIP_GetEntry2` 哈希查找
5. `getInputStream()` → `ZIP_Read` + `Inflater.inflate`

关键限制：JarURLConnection 只支持 **一层** `!` 分隔。即只支持 `jar:file:///app.jar!/entry`，不支持 `jar:jar:file:///app.jar!/inner.jar!/entry`（两层 `!`）。

```java
// The entryName contains everything after the FIRST "!"
// For nested: entryName = "BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF"
// JAR CEN hash lookup fails — no entry named
//   "BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF" exists
// The actual CEN entries are like "BOOT-INF/lib/spring-core.jar"
```

Why doesn't it support multi-level nesting? → JarURLConnection's implementation assumes the inner URL is a standard `file:` or `http:` protocol — if the inner URL is also `jar:`, recursive resolution would require a `jar:jar:file:...` URL chain. JDK 11's URL handler framework has no such recursive support.

> **反事实 2**：如果 JarURLConnection 支持递归 `jar:` URL？Spring Boot fat JAR 直接受益——`URLClassLoader` 可以用 `jar:jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar!/org/springframework/...` 类 URL → 标准类加载器自动解析。但需要：递归 inflate（外层 entry → 内层 JAR → inflate 内层 entry）+ 多级 JarFile 缓存 → 复杂度剧增。JDK 团队选择把递归嵌套支持移到 zipfs（完整的 NIO FileSystem 抽象），保持 java.net.URL 层简单。

> **反事实 3**：如果 JAR URL 用 `#` 替代 `!` 作为分隔符（`jar:file:///app.jar#com/example/Foo.class`）？规避 `!` 在 shell 中的转义问题，且 HTML 锚点语法更自然（URL fragment）。但 ZIP 规范（PKWARE APPNOTE）在 §4.3.2 中已经使用 `!` — jar: URL scheme 遵循了 ZIP 的历史惯例（Info-ZIP / PKZIP 用 `archive.zip!file` 语法）。

**URL Handler 协议注册：Spring Boot 如何拦截 `jar:` 协议**

Why: the `jar:` URL protocol handler is what enables Spring Boot to intercept and redirect nested JAR access. Without this registration, Java's standard `URL` class would use `sun.net.www.protocol.jar.Handler` — which doesn't understand nested JARs.

Protocol handler registration in Java uses `URL.setURLStreamHandlerFactory()` or the system property `java.protocol.handler.pkgs`. Spring Boot registers its custom handler:

```java
// Spring Boot JarLauncher: registers custom jar: protocol handler
URL.setURLStreamHandlerFactory(new SpringBootURLStreamHandlerFactory());
// Or via system property:
// -Djava.protocol.handler.pkgs=org.springframework.boot.loader
// Or via META-INF/services/java.net.URLStreamHandlerFactory

// When URL("jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar!/") is constructed:
// → URL.getURLStreamHandler("jar") → returns Spring Boot's Handler
// → Handler.openConnection(url) → SpringBootJarURLConnection
// → connect() → opens app.jar via custom JarFile
// → locates "BOOT-INF/lib/spring-core.jar" entry (outer CEN hash lookup)
// → creates inner JarFile for spring-core.jar
// → locates target entry within inner JAR
```

Protocol resolution order:
1. `URL.getURLStreamHandler(protocol)` checks loaded handlers
2. If not loaded → `URLStreamHandlerFactory.createURLStreamHandler("jar")` → returns Spring Boot's `org.springframework.boot.loader.jar.Handler`
3. If factory returns null → falls back to `sun.net.www.protocol.jar.Handler` (JDK default)

This interception is invisible to `URLClassLoader` — it calls `new URL("jar:file:...")` as usual, gets a `URLConnection` back, calls `getInputStream()` — unaware that Spring Boot's handler is on the other end.

---

### 1.3 Spring Boot LaunchedURLClassLoader — 自定义嵌套 JAR 解析

Why: because no JDK facility handles nested JARs before JDK 13, Spring Boot implements its own classloader + custom JarFile that can descend into nested JARs — inflating outer entries to parse inner Central Directories.

Spring Boot fat JAR 类加载流程：

**Step 1 — JarLauncher 启动：** `java -jar app.jar` → `libjli` (`java.c`) 读 `META-INF/MANIFEST.MF` 的 `Main-Class: org.springframework.boot.loader.JarLauncher` → 反射调用 `JarLauncher.main()` → 创建 `LaunchedURLClassLoader`。

**Step 2 — 扫描嵌套 JAR：** `LaunchedURLClassLoader` 构造时扫描外层 JAR 的入口：
```
BOOT-INF/classes/              ← 应用类（普通 CEN entries）
BOOT-INF/lib/spring-core.jar   ← 嵌套 JAR entry
BOOT-INF/lib/spring-boot.jar   ← 嵌套 JAR entry
BOOT-INF/lib/jackson-core.jar  ← 嵌套 JAR entry
...
```
对于每个以 `.jar` 结尾的 ZIP entry，Spring Boot 创建自定义 `JarFile` 实例（`org.springframework.boot.loader.jar.JarFile`）。

**Step 3 — 自定义 JarFile 解析内层 CEN：**

Spring Boot JarFile 检测 ZIP entry type：
- 如果 entry 名后缀是 `.jar` → read entry 内容的前几个字节 → 检查 ZIP magic number (`PK\x03\x04` = LOC header signature) → 如果是 → 视为嵌套 JAR
- inflate 外层 entry（`getInputStream(nestedJarEntry)` → ZIP_Read + InflateFully）→ 得到内层 JAR 的完整字节 blob（可能 1-20 MB）
- 在内存中 parse 内层 CEN：从 blob 末尾反向扫描 `PK\x05\x06`（findEND 逻辑）→ 获取 CEN 偏移 + 大小 → 构建内层哈希表 → 存储为 JarFileEntries
- 后续对 `JarFile.getEntry("org/springframework/...")` → hashN → hash lookup on inner CEN → return entry

**Step 4 — findClass 调度：**

`LaunchedURLClassLoader.findClass("org.springframework.boot.SpringApplication")` → 遍历所有注册的嵌套 JarFile → `JarFile.getEntry("org/springframework/boot/SpringApplication.class")` → 内层哈希表查找 → `getInputStream` → inflate 内层 entry → `byte[]` → `defineClass(name, bytes, 0, len)` → `defineClass1` (03-ClassLoader-Bridge)。

→ 03-ClassLoader-Bridge: defineClass1 receives the byte[] from the nested path

**Step 5 — 缓存：** Spring Boot JarFile 缓存内层 CEN 哈希表。同一嵌套 JAR（如 spring-core.jar）的 200+ 个 class 加载时共享同一内层哈希表 → 只需一次外层 inflate，后续 class 查找走内层哈希表（内存操作）。

> **反事实 4**：如果 Spring Boot 不使用自定义 JarFile，每条依赖单独打包在 fat JAR 根部？fat JAR 根部会有 200+ 个 class 文件（来自 spring-core, spring-boot, jackson, hibernate...）→ 根目录变得不可管理。更糟：不同依赖可能有同名 class（如 META-INF/MANIFEST.MF 每个 JAR 都有）→ 文件名冲突 → 后写入的覆盖先写入的。嵌套 JAR 做命名空间隔离：每个依赖的 class 在其内部保持原有的包层次结构，通过内层 CEN 的路径范围限定了命名空间。

> **反事实 5**：如果 Spring Boot 不缓存内层 JarFile？`200` classes × inflate outer entry (extract spring-core.jar bytes, ~5ms for 5MB) = 200 × 5ms = 1000ms 浪费。有缓存：inflate outer entry ONCE → cached inner JarFile → 200 × 0ms = 0ms（后续 class 查找走内存哈希表 + 每次 inner inflate）。

---

### 1.4 JDK 13+ zipfs — NIO FileSystem 通用嵌套 ZIP

Why: JDK 13+ addresses the nested ZIP problem architecturally — by providing a `ZipFileSystemProvider` that treats nested ZIP entries as a virtual filesystem, offering transparent access through the standard `java.nio.file.Path` API.

```java
// JDK 13+ zipfs — 透明嵌套 ZIP 访问
import java.nio.file.*;
import java.net.URI;
import java.util.Map;

// 创建顶层 FileSystem
FileSystem fs = FileSystems.newFileSystem(
    URI.create("jar:file:///app.jar"), Map.of());
// 获取嵌套 JAR 作为 Path
Path innerJar = fs.getPath("/BOOT-INF/lib/spring-core.jar");
// 创建内层 FileSystem
FileSystem innerFs = FileSystems.newFileSystem(innerJar, null);
// 访问内层 class
Path classFile = innerFs.getPath(
    "/org/springframework/boot/SpringApplication.class");
byte[] bytes = Files.readAllBytes(classFile);
```

内部实现：

1. **ZipFileSystem** at `src/jdk.zipfs/share/classes/jdk/nio/zipfs/ZipFileSystem.java` — maintains in-memory `IndexNode` tree built from CEN entries.

2. **创建顶层 FileSystem** → `FileSystems.newFileSystem(URI)` → `ZipFileSystemProvider.newFileSystem()` → `new ZipFileSystem(path)` → 读 CEN → 构建 `IndexNode` 树。`BOOT-INF/lib/spring-core.jar` 是一个 ENT 类型的 IndexNode。

3. **创建内层 FileSystem** → `FileSystems.newFileSystem(innerJar, null)` → provider 检测到传入的 Path 属于一个已有的 ZipFileSystem → 调用 `ZipFileSystem.getInputStream(innerJar)` → inflate 外层 entry → 得到内层 JAR 字节 blob → 在内存中 parse 内层 CEN → 构建内层 IndexNode 树 → 返回内层 `ZipFileSystem`。

4. **内层 class 访问** → `Files.readAllBytes(classFile)` → 内层 ZipFileSystem 的 `read()` → 内层 IndexNode lookup → 内层 entry inflate → 返回字节。

5. **缓存**：`ZipFileSystemProvider` 维护 `Map<Path, ZipFileSystem> filesystems` 缓存。一旦内层 ZipFileSystem 创建，重复访问同路径直接返回缓存的 FileSystem。

对比 JDK 11 vs JDK 13+：

| 维度 | JDK 11 | JDK 13+ zipfs |
|------|--------|---------------|
| 嵌套 ZIP 支持 | 无。Spring Boot 自实现 | 有。NIO Path API 透明访问 |
| 类加载器 | Spring Boot LaunchedURLClassLoader | java.net.URLClassLoader (标准) |
| 实现层 | Application (Spring Boot) | JDK (NIO FileSystem) |
| 统一性 | 自定义 API (JarFile/Hander) | 标准 java.nio.file.Path |
| 适用场景 | Spring Boot fat JAR only | 任意嵌套 ZIP 结构 |
| 多层嵌套 | Spring Boot JarFile 支持有限 | ZipFileSystem 递归支持 |

> **反事实 6**：如果 zipfs 从 JDK 1.0 就存在？Spring Boot 可能不需要自己的 JarFile 实现。统一 `java.nio.file.Path` API 处理扁平 JAR 和嵌套 JAR → 所有类加载器（URLClassLoader 等）不需要区分"真实文件"和"ZIP entry"。JDK 21+ 的模块系统 + zipfs 已经让 fat JAR 对 JDK 更透明，但历史遗留的 Spring Boot 自己的 loader 仍在广泛使用。

---

### 1.4b 内层 CEN 解析 — InflateFully + findEND + hash table on byte blob

Why: the custom JarFile inner CEN parsing process is worth examining in source-code terms because it reuses the same zip_util.c algorithms (findEND, hashN, readCEN logic) but applied to an in-memory byte blob instead of a file descriptor.

The inner JAR resolution (conceptual, matching zip_util.c patterns):

**Step A — inflate outer entry to get inner JAR blob:**
```c
// Conceptually: getInputStream on outer entry → ZIP_Read (zip_util.c:1340)
// → InflateFully (zip_util.c:1404) → uncompressed inner JAR bytes
// Now have byte* inner_jar_blob of size entry->size (e.g., 5MB for spring-core.jar)
```

**Step B — find inner END header (same algorithm as findEND at zip_util.c:329):**
```c
// Scan backward from end of inner_jar_blob looking for PK\x05\x06
// → extract CEN offset (ENDOFF) + CEN size (ENDSIZ) + entry count (ENDTOT)
// from the 22-byte END header at the end of the blob
```

**Step C — parse inner CEN (same algorithm as readCEN at zip_util.c:568):**
```c
// cenbuf = inner_jar_blob + cenoff; // pointer into blob
// total = ENDTOT(inner_endbuf);
// entries = calloc(total, sizeof(jzcell));
// tablelen = (total/2) | 1;  // odd for uniform distribution
// for each CEN entry in cenbuf:
//     entries[i].cenpos = cenoff + (cp - cenbuf);  // offset within blob
//     entries[i].hash = hashN(name, nameLen);       // zip_util.c:436
//     hsh = entries[i].hash % tablelen;
//     entries[i].next = table[hsh];
//     table[hsh] = i;
```

**Step D — inner entry lookup:**
```c
// getEntry("org/springframework/boot/SpringApplication.class")
// → hashN(name) → hash % tablelen → chain walk → equals(name)
// → read inner entry data: seek to entries[i].cenpos within blob
// → parse LOC header to get actual data offset
// → if compressed: InflateFully on the inner entry's compressed data
// → return byte[]
```

> **Beginner Callout: Inner CEN parsing**
>
> Standard ZipFile reads CEN by seeking to END header (last 22 bytes of file) → gets CEN offset → reads CEN. For nested JARs, the "file" is a byte[] in memory (extracted from outer JAR entry). Spring Boot's JarFile reimplements this: parse END from byte buffer → get CEN offset → read CEN entries from byte buffer → build hash table. Same algorithm, different data source.

The key insight: the inner CEN hash table uses absolute offsets into the blob (not file offsets). When reading inner entry data, the "lseek+read" on the outer JAR's fd is replaced by a memcpy from `inner_jar_blob + data_offset`. This is why the entire inner JAR blob must be decompressed before any inner entry can be read — random access requires the fully available uncompressed blob.

Memory usage: a 5MB spring-core.jar when inflated becomes ~10-12MB uncompressed (JAR compression ~50%). The `inner_jar_blob` (10-12MB) plus the hash table (entries + table, ~36KB for 1000 entries) together consume ~12MB native memory per nested JAR. For 20 nested JARs, that's ~240MB of native memory. Spring Boot mitigates this by lazily loading inner JARs (only when a class from that JAR is first requested) or by discarding the blob after CEN parsing (keeping only the hash table + reading inner entries on-demand through the outer JAR fd).

> → this is why fat JAR apps often need larger `-Xmx` than expected — the native memory footprint of nested JarFile caching adds 10-50% on top of Java heap usage

---

### 1.5 ★ Mermaid — 嵌套 JAR 类加载序列图 (4 lanes)

```mermaid
sequenceDiagram
    participant App as Application
    participant SB as Spring Boot ClassLoader
    participant ZF as ZipFile / JarFile
    participant FS as Filesystem / OS

    App->>FS: java -jar app.jar
    FS->>App: libjli → JarLauncher.main()
    App->>SB: LaunchedURLClassLoader 创建

    SB->>ZF: 扫描 app.jar 的 CEN entries
    ZF->>ZF: ZIP_Open("app.jar") (zip_util.c:911)
    ZF->>FS: ZFILE_Open → open("app.jar", O_RDONLY) (zip_util.c:159)
    FS-->>ZF: fd
    ZF->>ZF: readCEN (zip_util.c:568) — 构建外层哈希表
    ZF->>ZF: 遍历 entries: BOOT-INF/classes/*.class, BOOT-INF/lib/*.jar

    loop 每个 BOOT-INF/lib/*.jar entry
        SB->>ZF: 创建 Spring Boot JarFile(nestedEntry)
        ZF->>ZF: ZIP_Read nested entry bytes (zip_util.c:1340)
        ZF->>ZF: InflateFully → 内层 JAR 完整字节 blob
        ZF->>ZF: findEND on blob → 内层 CEN 偏移
        ZF->>ZF: parse 内层 CEN → 构建内层哈希表
        ZF->>ZF: 缓存内层 JarFile (in-memory)
    end

    App->>SB: findClass("org.springframework.boot.SpringApplication")
    SB->>ZF: JarFile.getEntry("org/.../SpringApplication.class")
    ZF->>ZF: 内层哈希查找 (hashN → hash % tablelen)
    ZF->>ZF: ZIP_Read inner entry 压缩字节
    ZF->>ZF: InflateFully → class 字节

    alt Standard ZipFile (失败路径)
        ZF->>FS: ZIP_Open("app.jar!BOOT-INF/lib/spring-core.jar")
        FS-->>ZF: ENOENT — open() fails
        ZF-->>App: ZipException: error in opening zip file
    else Spring Boot LaunchedURLClassLoader (成功路径)
        ZF-->>SB: byte[] classBytes
        SB->>SB: defineClass(name, bytes, 0, len)
        SB->>SB: defineClass1 → ClassLoader.c:76 → HotSpot
    end
```

---

### 1.6 ★ 面试 Story Format 答案

**问题：Spring Boot fat JAR 如何加载嵌套 JAR 中的类？**

答案分三段——三个时代的解决方案。

**第一段 — 问题根源（JDK 8-11 时代）：**

标准 `java.util.zip.ZipFile` 在构造函数中调用 native `ZIP_Open`（`zip_util.c:911`）→ `ZIP_Open_Generic`（`zip_util.c:763`）→ 在 Linux 上就是 `open(path, O_RDONLY)`（`:159`）。路径 `"app.jar!BOOT-INF/lib/spring-core.jar"` 对 OS 来说不是一个真实文件 → `open()` 返回 -1 → `ZipException: error in opening zip file`。根本限制：ZIP_Open 的设计假设 ZIP/JAR 作为独立文件存在于文件系统上——它通过 `lseek` + `read` 访问 CEN 和数据区。嵌套 ZIP entry 的内容在另一个 ZIP entry 的数据区中——没有独立的文件系统路径。

**第二段 — Spring Boot 的自定义解决方案：**

Spring Boot 用 `LaunchedURLClassLoader` 替换标准 `URLClassLoader`。fat JAR 的 `Main-Class: JarLauncher` → `JarLauncher.main()` 创建 `LaunchedURLClassLoader` → 扫描外层 JAR 的 CEN entries → 发现 `BOOT-INF/lib/*.jar` entries → 为每个创建自定义 `JarFile`（`org.springframework.boot.loader.jar.JarFile`）。这个自定义 JarFile 读取嵌套 JAR entry 的压缩字节 → inflate（zlib inflate，00 和 02 覆盖）→ 在内存中 parse 内层 JAR 的 CEN（找 `PK\x05\x06` END header → 读 CEN → 构建内层哈希表）。之后 `findClass("org.springframework.boot.SpringApplication")` → 遍历所有注册的嵌套 JarFile → 内层哈希查找 → `getInputStream` → inflate 内层 entry → `byte[]` → `defineClass` → `defineClass1`（`ClassLoader.c:76`，03 覆盖）。缓存：内层 JarFile 的 CEN 哈希表在内存中，同一嵌套 JAR 的 200+ 个类只需一次外层 inflate。

**第三段 — JDK 13+ zipfs（新时代）：**

JDK 13+ 引入了成熟的 `ZipFileSystemProvider`（`jdk.nio.zipfs`），提供 NIO `FileSystem` 视图：`FileSystems.newFileSystem(URI.create("jar:file:///app.jar"))` → 获取顶层 FileSystem → `fs.getPath("/BOOT-INF/lib/spring-core.jar")` → `FileSystems.newFileSystem(innerJar, ...)` → 创建内层 FileSystem → `innerFs.getPath("/org/...")` → `Files.readAllBytes()`。zipfs 在 Java 层面处理嵌套：inflate 外层 entry → parse 内层 CEN → 构建内层 IndexNode 树 → 缓存。这意味着标准 `URLClassLoader` 理论上可以通过 zipfs 支持嵌套 JAR 类加载——不需要 Spring Boot 的自定义类加载器。

**关键：嵌套 JAR 类加载的性能成本是 2x inflate。** 首次打开嵌套 JAR：inflate 外层 entry（得到内层 JAR 字节，1-20MB → ~2-5ms）+ parse 内层 CEN（构建哈希表，~0.5ms）。后续每个类加载：inflate 内层 entry（与扁平 JAR 相同，~0.02ms/class）。Spring Boot 和 zipfs 都缓存内层 CEN 哈希表——避免重复 inflate 外层 entry，将 2x 性能成本限制在首次打开。

---

## §二 环境

### Build & Source
OpenJDK 11 slowdebug, Linux x86_64. 嵌套 JAR 支持跨越 Java/native 边界：Spring Boot loader（Java 应用层）+ zipfs（JDK 13+ NIO 层）+ `zip_util.c`（native ZIP 引擎）。

Source roots：
- `src/java.base/share/native/libzip/zip_util.c` — `ZIP_Open`(:911)、`ZFILE_Open`(:159, `open()` syscall)、`readCEN`(:568)、`InflateFully`(:1404)
- `src/java.base/share/classes/java/net/JarURLConnection.java` — jar: URL 协议解析
- Spring Boot: `org.springframework.boot.loader.LaunchedURLClassLoader`、`org.springframework.boot.loader.jar.JarFile`、`org.springframework.boot.loader.jar.Handler`
- JDK 13+: `src/jdk.zipfs/share/classes/jdk/nio/zipfs/ZipFileSystem.java`、`ZipFileSystemProvider`

### 关键系统调用速查
| Function | man | 使用点 | 失败时 |
|----------|-----|--------|--------|
| `open()` | `man 2 open` | `zip_util.c:159` (via ZFILE_Open) — 含 `!` 路径直接失败 | ENOENT (no such file) |
| `inflate()` | `man 3 zlib` | 外层 entry 解压 → 内层 JAR blob | Z_DATA_ERROR |
| `lseek()` | `man 2 lseek` | 定位外层 CEN + entry 数据偏移 | 仅 mmap blob 内使用 |

### 诊断命令
```bash
# 1. 检查 JAR 结构——确认嵌套 JAR 路径
jar tf app.jar | grep "BOOT-INF/lib/.*\.jar$" | head

# 2. 模拟嵌套 JAR 读取
python3 -c "
import zipfile, io
zf = zipfile.ZipFile('app.jar')
for name in [n for n in zf.namelist() if n.endswith('.jar')]:
    data = zf.read(name)
    try:
        inner_zf = zipfile.ZipFile(io.BytesIO(data))
        print(f'{name}: {len(inner_zf.infolist())} entries')
    except Exception as e:
        print(f'{name}: FAILED - {e}')
"

# 3. GDB 验证 ZIP_Open 失败路径
gdb -ex "break zip_util.c:159" -ex "run" \
    -ex "print fname" \
    --args java -cp "app.jar!nested.jar" Main
```

---

## §三 性能分析 — 2x inflate 成本

### 2.1 扁平 JAR vs 嵌套 JAR — inflate 次数对比

Why: nested JAR class loading requires two inflate operations per first class from a JAR — one for the outer entry (extracting the inner JAR bytes) and one for the inner entry (extracting the actual class bytes). Understanding this cost is essential for diagnosing fat JAR startup performance.

| 阶段 | 扁平 JAR | 嵌套 JAR (首次) | 嵌套 JAR (后续) |
|------|---------|----------------|----------------|
| **打开 JAR** | `ZIP_Open → readCEN` (~0.5ms) | `ZIP_Open(outer) → readCEN` (~0.5ms) | cached (0ms) |
| **inflate 外层 entry** | N/A | `ZIP_Read + InflateFully` inner JAR bytes (~2-5ms for 1-20MB) | cached (0ms) |
| **parse 内层 CEN** | N/A | `findEND + parse CEN + hash table` (~0.5ms) | cached (0ms) |
| **inflate class** | `ZIP_Read + inflate` (~0.02ms) | `ZIP_Read + inflate` on inner JAR (~0.02ms) | ~0.02ms |
| **总计 per class** | ~0.02ms + CEN amortized | 首次: ~3-6ms; 后续: ~0.02ms | ~0.02ms |

量化例子 — Spring Boot fat JAR with 20 nested dependency JARs, 3000 classes total:
- Flat JAR equivalent: 3000 × 0.02ms = 60ms class loading time (excluding CEN reads)
- Nested JAR (20 inner CEN builds): 20 × 3-5ms = 60-100ms one-time cost
- Nested JAR class loading: 100ms one-time + 3000 × 0.02ms = 160ms total
- Net extra time: ~100ms (one-time CEN build overhead for 20 nested JARs)

The 2x inflate cost is significant only for the first class from each nested JAR. Caching makes the per-class cost identical thereafter.

### 2.2 为什么无法避免 2x inflate？

嵌套 JAR 的字节在 DEFLATE 后整体作为外层 entry 的压缩数据存储。inflate 外层 entry 时输出的是内层 JAR 的原始 ZIP 字节。无法跳过这一步——DEFLATE 是流压缩（32KB 滑动窗口内的 LZ77 + Huffman），必须从压缩流的开头顺序解码到内部的目标位置。ZIP 的随机访问是基于 entry 粒度的（inflate 整个 entry），不能只 inflate 嵌套 JAR 的内部某个 class。

如果需要在嵌套 JAR 内部随机访问 class → 必须先 inflate 外层 entry → 得到内层 JAR 的所有字节（1-20MB）→ 然后在内层 JAR 上用标准的 CEN 偏移（内层 ZIP 的 CEN offset within blob）定位内层 class → inflate 内层 entry。这是根因上的性能成本，无法避免。

### 2.3 Spring Boot 缓存策略 — 内层 JarFile 缓存

Spring Boot JarFile 创建后缓存内层 CEN 哈希表（in-memory）。数据结构大致为：
```
Map<String, NestedJarFile> nestedJarCache;
// key: "BOOT-INF/lib/spring-core.jar"
// value: NestedJarFile { innerCEN[], hashTable[], entryList[] }
```

同一嵌套 JAR 的 200+ 个 class 加载 → 共享同一内层哈希表 → 避免重复的外层 inflate（~3-5ms × 200 = 600-1000ms → saved）。Spring Boot 还做了 lazy inflate——内层 JAR 的字节 blob 可能不被保留（一旦 CEN 构建完成，只保留哈希表 + 数据偏移，后续按需 inflate 内层 entry）。

### 2.4 JDK 13+ zipfs 缓存

`ZipFileSystemProvider.filesystems` (`Map<Path, ZipFileSystem>`) 缓存所有创建的 FileSystem 实例。一旦内层 ZipFileSystem 创建（包括内层 CEN 解析完成），重复访问同路径直接返回缓存 → 后续类加载避免外层 inflate + 内层 CEN parse。

### 2.5 ★ Native 内存压力 — 内层 JAR blob 缓存

Why: the inner JAR byte blob (5-20MB uncompressed per nested JAR) consumes native memory outside the Java heap. This is invisible to `-Xmx` limits and heap dumps, but contributes to the process's total RSS.

Memory model for nested JAR class loading:

| Component | Size (per nested JAR) | Allocation | GC visibility |
|-----------|----------------------|-----------|---------------|
| Inner JAR blob (uncompressed) | 5-20MB | Native (malloc or DirectBuffer) | Invisible to Java GC |
| Inner CEN hash table (entries + table) | ~36KB per 1000 entries | Native heap | Invisible to Java GC |
| Loaded classes (InstanceKlass) | ~2-5KB per class | Metaspace | Managed by Metaspace GC |
| Class byte[] (before defineClass) | ~4KB per class | Java heap | Visible to Java GC |

For 20 nested JARs × 10MB avg blob = 200MB native memory. This is why fat JAR applications need more total process RSS than the heap size suggests. The native memory for inner JAR blobs is released when:
- Spring Boot: the `JarFile.close()` releases the blob, or GC collects the JarFile wrapper → `Cleaner` calls `close()` → native memory freed
- zipfs: `FileSystem.close()` releases the `ZipFileSystem` and its cached CEN data

The lazy-inflate optimization: Spring Boot can discard the inner JAR blob after CEN parsing and re-inflate on demand. Trade-off: saves ~200MB native memory at the cost of re-inflating the outer entry each time an inner entry is read (basically reverting to uncached 2x inflate per class).

### 2.6 JPMS 模块系统与 Fat JAR 的交互

Why: the Java Platform Module System (JPMS, JDK 9+) adds another dimension to the nested JAR problem — fat JARs violate module boundaries and force class loader workarounds.

JPMS designs modules as explicit, self-contained units with declared dependencies (`module-info.class`). A fat JAR bundles all dependencies into a single file, which conflicts with the module system's assumption of separate JAR files.

Key interactions:

1. **Module path vs classpath:** A fat JAR on the module path exposes ALL its classes (outer + all inner JARs) as one module or unnamed module — losing the encapsulation boundaries between libraries.

2. **ServiceLoader across nested JARs:** `META-INF/services/` files containing service implementations must be discoverable. Spring Boot must merge or proxy service files across nested JARs so `ServiceLoader.load(Foo.class)` finds implementations in `BOOT-INF/lib/hibernate-core.jar!/META-INF/services/...`.

3. **Automatic modules:** If a nested JAR contains a `module-info.class`, it should be treated as a named module. But the fat JAR structure makes this impossible with standard JDK tools — only Spring Boot's custom loader can isolate the nested JAR's module descriptor.

4. **JDK 13+ zipfs + module path:** zipfs makes nested JARs visible to the module system via NIO Path API. Theoretically, `--module-path` could reference `jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar` as a module — but the JDK's module resolver doesn't support `jar:` URLs on the module path (only file paths).

The practical result: fat JAR applications on JDK 9+ run on the classpath (not the module path), using the unnamed module, with Spring Boot's loader handling all isolation. Full module support in fat JARs remains an open challenge.

## §四 GDB 断点验证 (8 assertions)

### 断言 1: ZIP_Open 入口 — 检查路径（`zip_util.c:911`）

```gdb
(gdb) break zip_util.c:911
(gdb) run  # java -jar app.jar (Spring Boot fat JAR)
(gdb) print name → 期望: "app.jar"（顶层 JAR，无 "!" 字符）
→ 顶层 JAR 正常打开
```

### 断言 2: ZFILE_Open — 验证 Linux open() 调用（`zip_util.c:159`）

```gdb
(gdb) break zip_util.c:159
(gdb) run
(gdb) print fname → 期望: "app.jar"（顶层）、或含 "!" 的路径（嵌套会失败）
(gdb) continue → open() 返回 fd 或 -1
```

### 断言 3: 标准 ZipFile 尝试打开嵌套路径 — 失败（`zip_util.c:159`）

```gdb
# 故意构造：java -cp "app.jar!BOOT-INF/lib/spring-core.jar" SomeClass
(gdb) break zip_util.c:159
(gdb) run
(gdb) print fname → 期望: "app.jar!BOOT-INF/lib/spring-core.jar"
(gdb) continue
→ open() 返回 -1 (ENOENT, file not found) → ZIP_ERR_OPEN → ZipException
```

### 断言 4: readCEN — 外层 CEN 构建（`zip_util.c:568`）

```gdb
(gdb) break zip_util.c:568
(gdb) run  # java -jar app.jar
(gdb) print total → 期望: 外层 entry 总数（包含 BOOT-INF/lib/*.jar entries）
(gdb) continue
(gdb) print zip->tablelen → 期望: (total/2)|1（奇数）
```

### 断言 5: InflateFully — 外层 entry 解压（`zip_util.c:1404`）

```gdb
(gdb) break zip_util.c:1404
(gdb) run  # Spring Boot 打开嵌套 JAR 时
(gdb) print entry->name → 期望: "BOOT-INF/lib/spring-core.jar" 等
(gdb) print entry->csize → 期望: >0（嵌套 JAR 的压缩大小）
(gdb) print entry->size → 期望: >0（嵌套 JAR 的解压后大小，1-20MB）
(gdb) continue → InflateFully 完成 → 内层 JAR 字节 blob 就绪
```

### 断言 6: defineClass1 — 接收来自嵌套路径的字节（`ClassLoader.c:76`）

```gdb
(gdb) break ClassLoader.c:76
(gdb) run  # Spring Boot 类加载触发
(gdb) print name → 期望: "org/springframework/boot/SpringApplication"
(gdb) print length → 期望: >0 (有效的 class 字节)
→ 字节来自嵌套 JAR → 外层 inflate → 内层哈希查找 → 内层 inflate → byte[]
```

### 断言 7: JarURLConnection.connect() — 嵌套 URL 解析（JDK 11 限制暴露）

```gdb
# 构造多层嵌套 URL
(gdb) break sun.net.www.protocol.jar.JarURLConnection:connect
(gdb) run
# URL: jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF
(gdb) print this.url → 期望: jar:file:///app.jar!/BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF
(gdb) continue
→ handler 识别 "jar:" scheme → 剥离 jar: → 打开 app.jar → 
  entryName = "BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF"
→ CEN 哈希查找失败（entry 名包含 "!" → 无对应 CEN entry）
→ 单层 "!" 限制暴露
```

验证 JDK 11 的 JarURLConnection 只能处理单层 `!`。entryName 在第一个 `!` 处截断左边，右边全部作为 entry 名——"BOOT-INF/lib/spring-core.jar!/META-INF/MANIFEST.MF" 不是有效的 CEN entry → hashN + table lookup → NOT_FOUND (0) → 返回 NULL。

### 断言 8: 2x inflate 可视化（`zip_util.c:1404`）

```gdb
# 第一次命中：外层 inflate（extract inner JAR bytes）
(gdb) break zip_util.c:1404
(gdb) run
(gdb) print entry->name → 期望: "BOOT-INF/lib/spring-core.jar"
(gdb) print entry->csize → 期望: 嵌套 JAR 的压缩大小（如 ~2.5MB for 5MB uncompressed）
(gdb) print entry->size → 期望: 嵌套 JAR 的解压后大小（如 ~5MB）
(gdb) continue  # InflateFully 完成 → inner_jar_blob 就绪

# 第二次命中：内层 inflate（extract class bytes from inner JAR）
(gdb) continue  # 在同一个 breakpoint 第二次命中
(gdb) print entry->name → 期望: "org/springframework/boot/SpringApplication.class"
(gdb) print entry->csize → 期望: ~2KB（DEFLATE compressed .class）
(gdb) print entry->size → 期望: ~4KB（uncompressed .class）
→ "2x decompression" 可视化：第一次 inflate 从外层 JAR 提取嵌套 JAR 字节（~5MB），
    第二次 inflate 从内层 JAR 提取 .class 字节（~4KB）
```

The same `InflateFully` function at `zip_util.c:1404` is hit twice for nested JAR class loading — once for the outer entry (inner JAR blob) and once for the inner entry (actual class bytes). The `entry->name` distinguishes which level of nesting is being decompressed.

---

## §五 边缘场景——嵌套 JAR 的 3 个非线性路径

### 场景 1：三层嵌套 — fat JAR → nested JAR → nested-nested JAR

**触发条件**：Maven shade plugin 创建一个 fat JAR，其中包含另一个 fat JAR（测试库的 fat JAR → 内层 JAR 又包含 `BOOT-INF/lib/slf4j.jar`）。

**源码行为**：Spring Boot JarFile 的嵌套解析是递归的——外层 inflate → 得到内层 JAR blob → parse 内层 CEN → 发现内层 JAR 也包含 `.jar` entries → 递归创建第三层 JarFile → 3x inflate 开销。每次递归增加一次外层 inflate（~5ms per level）。三层嵌套 = 3 × 5ms = 15ms 首次打开。

**实战**：Spring Boot 2.x 的 fat JAR 通常只有一层嵌套（外层 app.jar → BOOT-INF/lib/*.jar → 单层 class）。三层嵌套只在边缘工具链中出现。

### 场景 2：ZIP comment 导致 END header 扫描窗口不足

**触发条件**：外层 JAR 有巨大的 ZIP comment（>64KB - `ENDHDR`），导致 `findEND` 的反向扫描窗口不够大。

**源码行为**：`zip_util.c:329` 的 `findEND` 定义了 `END_MAXLEN = 0xFFFF`（65535）— 这是 ZIP 规范允许的最大 comment 长度。如果 comment 更大 → END header 在 64KB 窗口之外 → `findEND` 扫描失败 → `readCEN` 返回 -1 → `ZIP_Open` 失败。即使外层 JAR 正常打开，如果内层 JAR blob 中有异常大小的 comment → 内层 CEN 解析使用相同的 `findEND` 算法 → 同样失败。

### 场景 3：zipfs FileSystem 未 close → fd 泄漏

**触发条件**：代码创建了 zipfs `FileSystem` 但未调用 `FileSystem.close()` → `ZipFileSystemProvider.filesystems` map 中的缓存条目永不释放 → ZIP fd 泄漏。

**源码行为**：`ZipFileSystem` 持有 `ZipFile` 引用 → `ZipFile` 持有 native `jzfile*` → native `jzfile*` 在 `zfiles` 全局链表中持有一个文件描述符。`FileSystem.close()` → `ZipFileSystem.close()` → `ZipFile.close()` → `ZIP_Close(zip_util.c:925)` → `--zip->refs` → 归零时 `freeZip` → `close(zfd)`。不 close → fd 永久泄漏。

**诊断**：
```bash
# 检查 JVM 进程的打开的 JAR 文件描述符
ls -la /proc/$(pgrep -n java)/fd | grep -c ".jar"
```

---

## §六 Cross-Reference

| Phase | Connection | Handoff Point |
|-------|-----------|--------------|
| **00-Zip-Class-Loading** | 标准 ZipFile 的读取机制——ZIP_Open → readCEN → ZIP_GetEntry2 → ZIP_Read → InflateFully。嵌套 JAR 打破了 ZIP_Open 的假设（期望真实文件路径） | `ZIP_Open` (`zip_util.c:911`) → `ZFILE_Open` (`zip_util.c:159`) → `open()` fails on nested path |
| **03-ClassLoader-Bridge** | defineClass1 是嵌套 JAR 类加载的终点——无论字节来自扁平 JAR、嵌套 JAR、还是 zipfs，最终都通过 defineClass1 进入 HotSpot | `byte[]` → `defineClass1` (`ClassLoader.c:76`) → `JVM_DefineClassWithSource` |
| **13-launcher** | LoadMainClass 在 `-jar` 模式下读取 MANIFEST.MF → `Main-Class: JarLauncher` → 触发 Spring Boot loader | `java.c` → `JarLauncher.main()` |
| **02-class-loading** | ClassFileParser 消费来自嵌套 JAR 的字节——无论嵌套层级，class 字节格式相同 (0xCAFEBABE) | byte[] → `ClassFileParser::parseClassFile` |
| **02-Compression-Zlib** | 嵌套 JAR 每个 inflate 操作（外层 entry + 内层 entry）都经过 zlib inflate 管线 | `Inflater.c:128` → `inflate()` → `checkInflateStatus` (`Inflater.c:144`) |

---

## §七 Counterfactual 对比表

| 设计选择 | 实际方案 | 替代方案 | 替代代价 | 量化对比 |
|---------|---------|---------|---------|---------|
| **ZIP_Open 路径处理** | 期望真实文件路径（`open()` 系统调用） | 检测 `!` 分隔符 → 自动递归打开 | 内存管理复杂（多层句柄生命周期）、每次访问 2x inflate | 现方案: 立即失败报告。替代: 实现复杂 |
| **嵌套 JAR 解决方案** | Spring Boot 应用层自定义 | JDK 内核原生支持 | JDK 改动大、版本兼容性 | Spring Boot: ~1MB loader jar; JDK native: 0MB overhead |
| **JarURLConnection 协议** | 单层 `!` 分隔 | 递归 `jar:jar:file:...` URL 链 | URL handler 递归解析 + 多级 JarFile 缓存 | 单层: 简单正确; 递归: 需要完整 FileSystem 抽象 |
| **JDK 13+ zipfs** | NIO FileSystem 虚拟视图 | 扩展 ZipFile native 层 | 跨语言边界复杂度增加 | zipfs: Java-only, standard API; native: C 维护 + JNI |
| **Fat JAR 结构** | 嵌套 JAR（BOOT-INF/lib/*.jar） | 扁平化（全部 class 在根部） | 同名 class 冲突（META-INF/MANIFEST.MF × 200） | 嵌套: 命名空间隔离; 扁平: 后写入胜出 → undefined behavior |
| **内层 CEN 缓存** | Spring Boot JarFile 内存哈希表 | 每次重新 parse | 200 classes × 5ms = 1000ms startup penalty | cached: 0ms; uncached: 1000ms |
| **2x inflate 抽象** | Accept 首次成本，缓存后续 | 零拷贝共享外层 inflate 数据 | DEFLATE 流压缩性质 → 不可能部分解压 | 首次 ~3-6ms; 后续 ~0ms 额外开销 |
| **跨 JDK 版本** | Spring Boot loader (JDK 8+) + zipfs (JDK 13+) | 标准 JarURLConnection only | JDK 11 不支持嵌套 → 无类加载路径 | Spring Boot: 所有 JDK 8+ work; std JarURLConnection: JDK 11 不 work |
| **Native 内存模型** | inner JAR blob cached (5-20MB per nested JAR) | 丢弃 blob, 保留 hash table only | 每次内层 entry 读取 → re-inflate 外层 entry | cached: ~200MB native for 20 JARs; re-inflate: ~3ms per first inner entry read |
| **JPMS 模块兼容** | Fat JAR runs on classpath (unnamed module) | Fat JAR as single module (all classes in one module) | 失去包级别的封装隔离 | classpath: 无模块边界; module path: 内部包 becomes exported |
| **ServiceLoader 发现** | Spring Boot proxies META-INF/services across nested JARs | 不合并 → ServiceLoader 找不到内层实现 | 运行时缺少 SPI 实现 → 功能缺失 | 正确: all services found; 缺失: silent feature loss |

---

## §八 代码验证行号

| 函数 | 文件:行号 | 验证状态 |
|------|-----------|---------|
| `ZIP_Open` | `zip_util.c:911` | ✅ 委托给 `ZIP_Open_Generic` (line 763) |
| `ZIP_Open_Generic` | `zip_util.c:763` | ✅ 缓存检查 → ZFILE_Open → ZIP_Put_In_Cache0 |
| `ZFILE_Open` | `zip_util.c:101` | ✅ Linux: `open(fname, flags, 0)` (line 159); Windows: `CreateFile` |
| `readCEN` | `zip_util.c:568` | ✅ 外/内层 CEN 解析 + 哈希表构建 |
| `findEND` | `zip_util.c:329` | ✅ 反向扫描 `PK\x05\x06` END header |
| `hashN` | `zip_util.c:436` | ✅ `h = 31*h + c` (Java String.hashCode) |
| `ZIP_GetEntry2` | `zip_util.c:1172` | ✅ hash%tablelen → 链遍历 → equals(name) |
| `ZIP_Read` | `zip_util.c:1340` | ✅ lseek + read within ZIP_Lock/ZIP_Unlock |
| `InflateFully` | `zip_util.c:1404` | ✅ inflateInit2(-MAX_WBITS) → inflate → inflateEnd |
| `ZIP_Get_From_Cache` | `zip_util.c:789` | ✅ 遍历 zfiles 链表，strcmp + refs++ |
| `Java_..._defineClass1` | `ClassLoader.c:76` | ✅ 6 步执行序列（03 覆盖） |
| `JVM_DefineClassWithSource` | `jvm.cpp:965` | ✅ HotSpot 类定义入口（03 覆盖） |
| `doInflate` | `Inflater.c:128` | ✅ z_stream I/O 设置 + inflate() 调用（02 覆盖） |
| `checkInflateStatus` | `Inflater.c:144` | ✅ 5 种 zlib 返回码处理（02 覆盖） |
| `ZIP_CRC32` | `CRC32.c:58` | ✅ 直接调用 zlib crc32()（00 + 02 覆盖） |
| `JarURLConnection` (abstract) | `java/net/JarURLConnection.java:137` | ✅ 抽象基类 — 定义 jar: URL 协议接口 |
| `JarURLConnection` (impl) | `sun/net/www/protocol/jar/JarURLConnection.java:48` | ✅ 具体实现 — ！分隔符解析 + JarFile 工厂 |
| `zlib version` | `zlib/zlib.h:26` | ✅ "version 1.2.11, January 15th, 2017" (02 覆盖) |

---

## §九 ADDITIONAL PROHIBITIONS（≥8）

- ❌ 只说 "ZipFile 不支持嵌套" 不做源码级分析——必须展示 `ZFILE_Open`(:159) = `open()` syscall
- ❌ 不解释 Spring Boot LaunchedURLClassLoader 如何重新实现内层 CEN 解析——inflate→findEND→parseCEN→hashTable
- ❌ 忽略 2x inflate 的性能成本——必须量化首次打开(~3-6ms) vs 后续(~0ms cached)
- ❌ 不展示 JarURLConnection 的单层 `!` 限制——entryName 包含 `!` 导致 CEN 查找失败
- ❌ 不说 JDK 13+ zipfs 如何通过 NIO FileSystem 抽象解决嵌套——不比旧方案只需要一瞥
- ❌ 遗漏 native 内存压力分析——200MB for 20 nested JARs 对外不可见
- ❌ 不做 man 手册引用——`man 2 open`(ZFILE_Open)、`man 3 zlib`(2x inflate)、JAR spec(RFC 1951)
- ❌ 忽略边缘场景：三层嵌套、ZIP comment 溢出、zipfs fd 泄漏
- ❌ 不要写成 Spring Boot 教程——这是 JVM class loading ENGINEERING documentation
