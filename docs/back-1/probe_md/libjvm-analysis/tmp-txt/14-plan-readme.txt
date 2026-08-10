Plan and write README.md for phase 14-zip-jimage (libzip.so + libjimage.so). Two-step: FIRST verify all source code, THEN write README with verified content.

## Phase context (continuity MUST be explicit)
The reader finished 13-launcher — they know how `java -jar app.jar` resolves to a JAR file path. They finished 02-class-loading — they know how ClassFileParser parses .class bytes into InstanceKlass. But the PHYSICAL I/O bridge between "JAR on disk" and "bytes in memory" has NEVER been explained. This is that bridge.

14 sits at the intersection:
```
13-launcher → resolves classpath to JAR files
    ↓
14-zip-jimage → reads .class bytes from JAR/jimage
    ↓
02-class-loading → ClassFileParser parses bytes into InstanceKlass
```

## Step 1: Source code verification (MANDATORY — must complete first)

### libzip source files to read and report on:

**ZipEntry.c** (src/java.base/share/native/libzip/ZipEntry.c):
1. Find `ZIP_GetEntry()` — signature, parameters, return type. What does it return for a class name like "com/example/Foo.class"?
2. Find `ZIP_GetFromFileDescriptor()` — how does it read ZIP entries from an already-opened file descriptor?
3. How does the JVM locate a specific ZIP entry by name? The Central Directory lookup mechanism.

**zip_util.c** (src/java.base/share/native/libzip/zip_util.c):
4. Find `ZIP_Open()` — how does the JVM "open" a JAR at the native level? What data structures are created?
5. Find `ZIP_GetEntry()` internals — binary search or linear scan over Central Directory?
6. How does the JVM cache ZIP file handles? `ZIP_GetFromCache` mechanism — important for startup performance (re-reading JAR Central Directory is expensive).
7. Find `ZIP_Lock` / `ZIP_Unlock` — how does concurrent class loading from the same JAR work?

**Inflater.c** (src/java.base/share/native/libzip/Inflater.c):
8. Find the native inflate function — how does DEFLATE decompression work per-entry?
9. How does the JVM handle `java.util.zip.Inflater` caching at the native level? `inflateInit2_`/`inflate`/`inflateEnd` calls.
10. zlib linkage: bundled or system library? Which version?

**CRC32.c** (src/java.base/share/native/libzip/CRC32.c):
11. Is CRC32 verified during class loading or only on explicit `ZipFile.getEntry()` calls?
12. Find `ZIP_CRC32` usage — when is it called during class byte reading?

### libjimage source files to read and report on:

**jimage.cpp** (src/java.base/share/native/libjimage/jimage.cpp):
13. Find `JIMAGE_Open()` — what is the "closed world" assumption? How does it make jimage O(1) lookup vs ZIP's O(log n)?
14. Find `JIMAGE_FindResource()` — how does it map "java/lang/Object.class" to an offset in the jimage file?
15. Find `JIMAGE_GetResource()` — does it decompress inline or return raw bytes?

**imageFile.cpp** (src/java.base/share/native/libjimage/imageFile.cpp):
16. What is the jimage binary format? Header magic number? Location table? String table?
17. How does the location table enable O(1) resource lookup? Exact string hash → index calculation.

**imageDecompressor.cpp** (src/java.base/share/native/libjimage/imageDecompressor.cpp):
18. Compression algorithm — DEFLATE plus pre-processing? How does jimage pre-process class data before compression?
19. Why pre-processing? "Shared strings extracted, individual strings compressed separately" → explain.

### ClassLoader bridge:

**ClassLoader.c** (src/java.base/share/native/libjava/ClassLoader.c):
20. Find `Java_java_lang_ClassLoader_defineClass1()` — how does it call ZIP/jimage to read bytes?
21. Does it call ZIP_GetEntry directly or through Java-layer ZipFile?
22. JDK 9+ module path: does it use jimage or ZIP for application classes?

### Report format per finding:
```
Function: ZIP_GetEntry at ZipEntry.c:XXX, zip_util.c:YYY
Position in class loading: ClassLoader.defineClass1 → ZIP_GetEntry → read from JAR
Mechanism: binary search over Central Directory (O(log n) entries)
Parameters: jstring entryName → "com/example/Foo.class"
Returns: jboolean (success/failure), bytes written to jbyteArray
```

---

## Step 2: Write README.md (after Step 1 reports complete)

Write to: probe_md/14-zip-jimage/README.md. Target: 500+ lines.

### Quality mandate
- **Depth**: every claim backed by Step 1 source line numbers. "ZIP_GetEntry uses binary search" → line number in zip_util.c.
- **Breadth**: cover ZIP entry reading + jimage O(1) lookup + zlib decompression + CRC32 verification + ClassLoader bridge
- **Interview**: 6+ questions with concrete, source-backed answers that can be delivered in 60 seconds
- **Continuity**: explicit "from 13" and "to 02" transition with source-level handoff points
- **First principles**: every design decision derived from "if you designed class storage from scratch..."
- **Beginner**: define ZIP Central Directory, DEFLATE/inflate, jimage location table, CRC32, zlib before they appear in the text

### Required sections

#### §〇 上手指南
- 3-tier reading paths (入门/进阶/专家)
- Prerequisites: 13-launcher (classpath resolution), 02-class-loading (ClassFileParser). "13 告诉你 .class 文件在哪个 JAR 里。14 告诉你 JAR 里的字节怎么读出来。02 告诉你怎么解析这些字节。"
- 3-sentence essence: "ClassLoader.defineClass1('com/example/Foo') → native code reads /path/to/app.jar → searches ZIP Central Directory for 'com/example/Foo.class' → inflates DEFLATE-compressed bytes → returns raw byte[] to Java → ClassFileParser parses it."
- Core terminology table: ZIP Central Directory, DEFLATE/inflate, zlib, jimage location table, CRC32, JIMAGE_Open, defineClass1, ZIP cache

#### §一 The Physical Class Loading Path (verified ASCII diagram from Step 1)
```
Java layer: ClassLoader.loadClass("com.example.Foo")
  → ClassLoader.defineClass1(name, bytes, offset, length) [jni native]
    → ClassLoader.c: Java_java_lang_ClassLoader_defineClass1() at line:XXX
      → [JDK 8 path] ZIP_GetEntry(jarfile, "com/example/Foo.class") at ZipEntry.c:XXX
        → zip_util.c: ZIP_GetFromCache() at line:XXX — cache lookup
        → zip_util.c: binary search Central Directory at line:XXX
        → Inflater.c: inflate() at line:XXX — DEFLATE decompression
        → CRC32.c: verify CRC32 at line:XXX (if enabled)
        → return inflated bytes to Java
      → [JDK 9+ jimage path] JIMAGE_FindResource("java/lang/Object") at jimage.cpp:XXX
        → imageFile.cpp: location_table[name_hash] at line:XXX — O(1) lookup
        → imageDecompressor.cpp: decompress class data at line:XXX
        → return raw bytes to Java
  → ClassFileParser::parseClassFile(bytes) [02-class-loading entry]
```
Every step has file:line from Step 1 verification.

#### §二 First-Principles Design Decisions (≥5, derived from Step 1)

1. **Why ZIP instead of raw .class files?** "A JRE 8 has 3000+ .class files. Raw files on disk: 3000 x 4KB blocks (even if each .class is 500 bytes) = 12MB wasted space + 3000 open/read/close syscalls at startup. ZIP: 1 open syscall for rt.jar → 1 Central Directory read (~200KB) → random access all 3000 entries → O(log n) search per class. 3000 → 1 open = 3000x reduction in syscalls. Plus: 30-50% compression savings."

2. **Why jimage instead of ZIP for JDK 9+?** "ZIP Central Directory = O(log n) binary search. jimage location table = hash-based O(1) direct lookup. For 3000+ module classes: ZIP = log₂(3000) ≈ 12 comparisons per class. jimage = 1 hash + 1 read. 12x faster class lookup. Plus: jimage pre-processes class data (shared string extraction) for better compression than raw DEFLATE."

3. **Why DEFLATE (zlib) not LZ4/Snappy/LZMA?** "DEFLATE: 50% compression ratio, 100MB/s decompress on modern CPU. LZ4: 300MB/s decompress but only 40% compression → 20% larger JARs. LZMA: 70% compression but 20MB/s decompress → 5x slower class loading. DEFLATE = best balance of size/speed. Plus: zlib is bundled in every OS since 1995 — zero deployment cost."

4. **Why cache ZIP file handles (ZIP_GetFromCache)?** "JAR Central Directory is ~200KB for rt.jar. Reading it takes ~0.5ms of disk I/O. 3000 classes × 0.5ms = 1.5s if uncached. Cache: 1 read for rt.jar → 3000 x 0s cached lookups = 0ms. This is why JVM startup drops from 'minutes' to 'seconds' when ZIP handles are cached."

5. **Why CRC32 verification?** "DEFLATE has its own Adler-32 checksum — but that only catches decompression errors, not disk corruption or bit rot. CRC32 on each ZIP entry is independent of DEFLATE's checksum → catches corrupted JARs BEFORE ClassFileParser sees bad bytes → VerifyError → startup crash."
6. **Why separate libzip.so from libjvm.so?** "libjvm.so is 20MB. libzip.so is ~150KB (mostly zlib). Linking zlib into libjvm.so would bloat JVM 150KB for every deployment → multi-JVM deployments: 10 JVMs × 150KB each = 1.5MB wasted per server."

#### §三 Source Files Table (populated from Step 1)
| File | Full Path | Lines | Core Functions | Role |
|------|-----------|:---:|-------|------|
(List ~12 files from Step 1 findings)

#### §四 Document Plan (4-5 docs)

### 00-Zip-Class-Loading.md — the ZIP/JAR physical read path
**Core question**: "ClassLoader.defineClass1('com/example/Foo.class') → how does libzip.so read those exact bytes from a JAR file on disk?"

**Production**: "Corrupted app.jar — `java.util.zip.ZipException: invalid entry CRC` at class loading time. The class was decompressed correctly per zip algorithm, but CRC32 check failed → disk corruption or network transfer error."

**Coverage**: ZIP_Open → ZIP_GetFromCache → ZIP_GetEntry (Central Directory binary search) → DEFLATE decompression → CRC32 verification → bytes returned. Concurrency: ZIP_Lock/ZIP_Unlock for multi-threaded class loading.

**Source files**: ZipEntry.c, zip_util.c, CRC32.c
**Prerequisites**: 13-launcher (classpath → JAR path)

### 01-Jimage-Format.md — JDK 9+ module image format
**Core question**: "JDK 9+ doesn't use rt.jar. How does jimage provide O(1) class lookup instead of ZIP's O(log n)?"

**Production**: "JDK upgrade → `java.lang.module.FindException: Module java.base not found` → jimage file corrupted or wrong version → JIMAGE_Open fails."

**Coverage**: JIMAGE_Open → location table (hash → offset O(1)) → string table → JIMAGE_FindResource → JIMAGE_GetResource → pre-processing (shared string extraction) → imageDecompressor. Comparison with ZIP: timing/space.

**Source files**: jimage.cpp, imageFile.cpp, imageDecompressor.cpp
**Prerequisites**: 00-Zip-Class-Loading (knows ZIP Central Directory)

### 02-Compression-Zlib.md — DEFLATE/inflate pipeline
**Core question**: "Class bytes in JARs are DEFLATE-compressed. How does zlib decompress them in real-time during class loading?"

**Production**: "`java.util.zip.ZipException: invalid stored block lengths` → corrupted compressed data within a JAR entry. zlib's inflate() fails at run-time → JVM startup blocked."

**Coverage**: Inflater.c native bridge → zlib inflateInit2_ → inflate → inflateEnd → caching (Inflater state reused across entries) → compression ratio analysis (class files: 50% typical).
**Source files**: Inflater.c, bundled zlib source
**Prerequisites**: 00

### 03-ClassLoader-Native-Bridge.md — the Java→native glue
**Core question**: "ClassLoader.defineClass1(String name, byte[] b, int off, int len) — how does this Java method translate into ZIP_GetEntry or JIMAGE_FindResource?"

**Production**: "NoClassDefFoundError: com/example/Foo — the JAR exists on classpath, the class entry exists in Central Directory, but defineClass1 returns null. Root cause: class file is a directory entry in ZIP, not a file entry."

**Coverage**: ClassLoader.c → JNI_GetStringUTFChars(classname) → path construction ("com/example/Foo" → "com/example/Foo.class") → ZIP_GetEntry vs JIMAGE_FindResource dispatch → JDK version branching (ZIP for JDK 8, jimage for JDK 9+ modules) → bytes → JNI_SetByteArrayRegion → return to Java.

**Source files**: ClassLoader.c, jni_util.h
**Prerequisites**: 00, 01, 09-native-interface (JNI basics)

### 04-Jar-URL-Nesting.md — nested JARs, Spring Boot, fat JARs
**Core question**: "Spring Boot fat JAR — app.jar contains BOOT-INF/lib/spring-core.jar as a nested ZIP entry. How does the JVM read classes from nested JARs when the standard ZipFile API only handles flat ZIPs?"

**Production**: "Spring Boot app: `ZipException: error in opening zip file` when accessing nested JAR. Standard ZipFile → ZIP_GetEntry expects a real .jar file, not a zip entry within another zip."

**Coverage**: JarURLConnection native → nested ZIP handling (Spring Boot LaunchedURLClassLoader vs standard URLClassLoader) → zipfs (JDK 13+) → performance: nested JAR = inflate outer entry → search inner Central Directory → 2x decompression per class.

**Source files**: JarURLConnection.c (or Java implementation analysis)
**Prerequisites**: 00, 03

#### §五 Interview Questions (≥8, each with verified answer from Step 1)

1. "How does the JVM read .class files from a JAR?" → 00: Central Directory binary search → entry offset → DEFLATE inflate → CRC32 verify → bytes returned. O(log n) search. ZIP_GetFromCache avoids re-reading Central Directory. Source: zip_util.c:XXX.

2. "Why jimage instead of ZIP for JDK 9+?" → 01: location table hash-based O(1) vs ZIP O(log n). 12x faster for 3000+ classes. Pre-processing (shared string extraction) compresses class data better than raw DEFLATE. Source: jimage.cpp:XXX.

3. "How does DEFLATE decompression work during class loading?" → 02: zlib inflate() called per ZIP entry. Inflater state cached → reuse across entries → avoids repeated inflateInit. 50% compression for class files → 100MB/s decompress. Source: Inflater.c:XXX.

4. "What happens when a JAR is corrupted?" → 00: ZIP_GetEntry → CRC32 mismatch → `ZipException: invalid entry CRC` → ClassNotFoundException. CRC32 is independent of zlib's Adler-32 → catches disk corruption + bit rot.

5. "How does ClassLoader.defineClass1 bridge Java and native?" → 03: JNI → ClassLoader.c → classname string conversion ("com/example/Foo" → "com/example/Foo.class") → dispatch to ZIP_GetEntry or JIMAGE_FindResource based on JDK version + class source → bytes copied to Java heap via SetByteArrayRegion.

6. "Why does startup get slower with many small JARs?" → 00: each JAR = separate ZIP_Open → separate Central Directory read (0.2-0.5ms). 500 JARs × 0.5ms = 250ms of disk I/O just for ZIP opens. Solution: fewer larger JARs, AppCDS shared archive, or jimage (pre-opened at JDK build time).

7. "Why doesn't the JVM just store .class files as raw files without compression?" → §2.1: 3000 .class files × 4KB minimum block allocation = 12MB wasted. ZIP: 1 file × Central Directory = 1 open. Compression saves 30-50% disk space.

8. "How does CRC32 differ from zlib's built-in checksum?" → 02: zlib's Adler-32 catches decompression errors. CRC32 catches disk corruption (bit rot, bad sector). Both checks → defense in depth. Adler-32 during inflate, CRC32 post-inflate.

#### §六 Production Scenarios (≥4, with error messages from source)

| Scenario | Exact symptom | Doc | Diagnostic |
|---------|-------------|-----|------------|
| Corrupted JAR | `java.util.zip.ZipException: invalid entry CRC` | 00 | `jar tvf app.jar > /dev/null` — validates CRC on all entries. Re-download or re-build JAR. |
| jimage version mismatch | `java.lang.module.FindException: Module java.base not found` | 01 | `jimage info $JAVA_HOME/lib/modules` — check format version. JDK upgrade partial: new java binary + old modules file. |
| Slow startup from many JARs | Startup takes >30s, `strace -e openat` shows 500+ ZIP_Open calls | 00 | Count JARs on -cp. AppCDS: `java -Xshare:dump` then `java -Xshare:on`. |
| Spring Boot nested JAR failure | `ZipException: error in opening zip file` accessing nested JAR | 04 | Standard ZipFile cannot read nested entries. Use Spring Boot LaunchedURLClassLoader or zipfs. |

#### §七 Quality Audit Matrix (4-5 planned docs, honest pre-ratings)

#### §八 Deep Questions (≥12, first-principles, 5 tiers)

Tier 1 — ZIP structure:
1. "If you designed class storage from scratch, would you use ZIP or a custom format? What tradeoffs does ZIP impose?"
2. "Why binary search over Central Directory instead of hash table? JARs have <10K entries — hash would be faster."
3. "Why is CRC32 per-entry instead of one CRC32 for the whole JAR?"

Tier 2 — jimage format:
4. "jimage's location table is O(1). Why is O(1) so important for 3000+ entries? Binary search is only 12 comparisons."
5. "jimage pre-processes class data before compression — what exactly is pre-processed and why?"
6. "If jimage is so much better than ZIP, why is it only for JDK modules? Why not for application JARs too?"

Tier 3 — Compression:
7. "DEFLATE compression = 50% for class files. Would a compression format optimized for class files do better?"
8. "Why cache Inflater state? How much does it save per entry?"
9. "What happens if the JVM uses a different zlib version than the JAR was compressed with?"

Tier 4 — Multi-JAR:
10. "500 small JARs = 250ms startup penalty from ZIP_Open × 500. Why not merge them into 1 JAR automatically?"
11. "How does AppCDS (Class Data Sharing) bypass ZIP/jimage entirely for class loading?"
12. "How does the ZIP file handle cache interact with GC? If a JAR is unused, when is its native ZIP handle freed?"

#### §九 Cross-Phase Connections
| Phase | Connection |
|-------|-----------|
| 13-launcher | 13 resolves classpath → JAR file paths. 14 reads bytes FROM those JARs. |
| 02-class-loading | 14 returns raw .class bytes. 02's ClassFileParser consumes them. |
| 15-core-native | 14's ClassLoader.c bridge is part of libjava.so — 15 covers all of libjava.so's native methods. |
| 03-object-model | Loaded classes go through ClassFileParser (02) → InstanceKlass (03). |
