# PROMPT: 请撰写 00-Zip-Class-Loading.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

生产环境凌晨 3 点告警：应用启动失败，所有类加载崩溃。

```
java.util.zip.ZipException: invalid entry CRC (expected 0xabcd1234 but got 0xdeadbeef)
```

**这不是 zlib 解压错误。** 这是 CRC32 验证在 Java 层 `java.util.zip.ZipFile` 读取 entry 时失败——解压完成了，但解压后字节的 CRC32 与 ZIP Central Directory 中存储的 `CENCRC`（`zip_util.h:102`）不匹配。根因：JAR 文件在磁盘写入或网络传输中被截断/损坏——某个 entry 的数据区域发生了位翻转。错误发生在每次尝试加载该 entry 对应的 `.class` 文件时，直到 JAR 被替换。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 全 JAR CRC 验证——逐 entry 检查
jar tvf app.jar > /dev/null
# 输出: java.util.zip.ZipException: invalid entry CRC — 定位损坏的 entry 名

# 2. 确认 JAR 的 CEN 是否可读——CEN 损坏 → 全部 entry 不可读
python3 -c "
import zipfile
zf = zipfile.ZipFile('app.jar')
for info in zf.infolist():
    try:
        zf.read(info.filename)
    except Exception as e:
        print(f'{info.filename}: {e}')
"

# 3. GDB 断点验证 CRC32 校验路径
gdb -ex "break CRC32.c:58" \
    -ex "break zip_util.c:1172" \
    -ex "run" \
    -ex "print entry->crc" \
    -ex "print computed_crc" \
    --args java -cp app.jar com.example.Main
```

**反事实**：如果 CRC32 校验放在 native `ZIP_Read` 完成时（而非延迟到 Java 层 `ZipFile` 读取后）→ 校验失败立即抛出 native 错误，无需回到 Java 层构造异常对象 → 节省 ~0.01ms/entry。但代价：native 错误无法携带 Java 异常消息的丰富上下文（entry 名、期望 CRC、实际 CRC）→ 诊断信息退化。HotSpot 团队选择 Java 层校验是为了更好的错误报告。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE path from `ZipFile zf = new ZipFile("/path/to/app.jar")` to `byte[] classBytes` arriving at `ClassLoader.defineClass1()`. This is NOT a ZIP format tutorial. We won't explain Phil Katz's original PKZIP spec. This is ENGINEERING documentation: how HotSpot reads `.class` bytes from JAR files in source-code-specific detail.

Reader comes from **13-launcher** (classpath→JAR paths) + **02-class-loading** (ClassFileParser). Reader knows HOW the classpath resolves to JAR paths and HOW ClassFileParser parses bytes. This doc answers: **how do bytes get from DISK to PARSER.**

The native code lives in `src/java.base/share/native/libzip/zip_util.c` (1697 lines, **not** multiple files like `ZipEntry.c`—there is no such file). All ZIP logic: open, CEN hash table, entry lookup, inflate, lock, cache — one monolithic C file.

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **ZIP Central Directory (CEN)**：位于 ZIP 文件末尾的结构，列出所有 entry 的 name、offset、CRC32、size、compression method。`readCEN`（`zip_util.c:568`）一次性解析全部 CEN 构建哈希表。不是二分搜索——是链式哈希表（chained hash table）。哈希函数 = Java 标准 `String.hashCode()`（`h = 31*h + c`），表大小 `tablelen = (total/2) | 1` 刻意奇数。

2. **CEN header / LOC header**：CEN header = 46 字节 central directory header（签名 `0x02014b50`），包含 entry 的所有元数据。LOC header = 30 字节 local file header（签名 `0x04034b50`），在 entry 数据前，包含冗余的压缩信息。`ZIP_GetEntryDataOffset`（`zip_util.c:1304`）懒加载解析 LOC header 计算实际数据偏移——避免打开 JAR 时读取全部 LOC header。

3. **Chained hash table**（链式哈希表）：`readCEN` 构建：对每个 entry 计算 `hashN(name)` → `hsh % tablelen` → `entries[i].next = table[hsh]` → `table[hsh] = i`。冲突解决：链表（非开放寻址）。查找：`ZIP_GetEntry2` 中 `hsh % tablelen` 定位桶 → 遍历链表匹配 hash + `equals(name)`。平均 O(1)，最坏 O(n)。

4. **ZIP_GetFromCache**：全局 `static jzfile *zfiles` 链表（`zip_util.c:68`）缓存已打开的 JAR 句柄。每次 `ZIP_Open` 先查缓存：匹配 `name + lastModified` → 命中则 `refs++` 直接返回（~100ns）。未命中：`ZFILE_Open` + `readCEN` → 插入链表。最大引用数 `MAXREFS = 0xFFFF`。

5. **DEFLATE / inflate**：DEFLATE = LZ77 + Huffman 编码。`InflateFully`（`zip_util.c:1404`）用 `-MAX_WBITS`（raw deflate，无 zlib/gzip header）。`ZIP_InflateFully`（`zip_util.c:1545`）用 `MAX_WBITS`（带 zlib header）。两者都是 zlib 1.2.11（捆绑在 JDK 中，`zlib.h:26`）。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots：
- `src/java.base/share/native/libzip/` — `zip_util.c`、`zip_util.h`、`Inflater.c`、`CRC32.c`
- `src/java.base/share/native/libzip/zlib/` — zlib 1.2.11 源码捆绑（`zlib.h`、`inflate.c`、`crc32.c` 等 ~22 文件）

Build：`make jdk`

Key binary：
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libzip.so` — `zip_util.c` 的编译产物

Key global state（`zip_util.c`）：
- `static jzfile *zfiles = 0`（line 68）— 全局 JAR 句柄缓存链表
- `static void *zfiles_lock = 0`（line 69）— 缓存链表操作锁

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **zip_util.c** | `src/java.base/share/native/libzip/zip_util.c` | 1697 | `ZIP_Open`(:911), `ZIP_Open_Generic`(:763), `ZIP_Get_From_Cache`(:789), `ZIP_Put_In_Cache0`(:841), `readCEN`(:568), `findEND`(:329), `findEND64`, `hash`(:424)/`hashN`(:436), `ZIP_GetEntry`(:1145)/`ZIP_GetEntry2`(:1172), `newEntry`(:1010), `ZIP_Lock`(:1284)/`ZIP_Unlock`(:1293), `ZIP_Read`(:1340), `InflateFully`(:1404), `ZIP_InflateFully`(:1545), `ZIP_FindEntry`(:1469), `ZIP_ReadEntry`(:1486), `ZIP_Close`(:925), `ZIP_GetEntryDataOffset`(:1304) | **主文件**：所有 ZIP/JAR 逻辑——打开、CEN 解析、哈希表、entry 查找、读取、解压、缓存、并发控制 |
| 2 | **zip_util.h** | `src/java.base/share/native/libzip/zip_util.h` | 287 | `jzentry` struct, `jzcell` struct, `jzfile` struct, CEN/LOC/END 字段宏 | 数据结构 + ZIP 格式常量 |
| 3 | **Inflater.c** | `src/java.base/share/native/libzip/Inflater.c` | 305 | `Java_..._Inflater_init`(:58), `doInflate`(:128), `checkInflateStatus`(:144), `Java_..._inflateBytesBytes`(:188) | JNI 桥接到 zlib inflate |
| 4 | **CRC32.c** | `src/java.base/share/native/libzip/CRC32.c` | 72 | `Java_..._CRC32_update`(:37), `ZIP_CRC32`(:58) | JNI 桥接到 zlib crc32 — **注意：CRC32 验证在 Java 层 ZipFile，非 native 类加载路径** |

**关键澄清**：
- **无 `ZipEntry.c`** — 所有 ZIP entry 逻辑在 `zip_util.c` 中
- **ZIP 查找是哈希 O(1)，非二分搜索** — `readCEN` 构建哈希表（`zip_util.c:568`），`ZIP_GetEntry2` 做 `hash % tablelen` + 链式查找（`zip_util.c:1172`）
- **CRC32 验证在 Java 层** `java.util.zip.ZipFile`，不在 native 类加载路径中

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ ZIP_Open — how does the JVM "open" a JAR?

```
问题：
  ① ZIP_Open(zip_util.c:911) 的第一步做什么？不是 fopen——是什么？
     答案方向：ZIP_Open 委托给 ZIP_Open_Generic(zip_util.c:763)。
     先查缓存：ZIP_Get_From_Cache(zip, name, &lm, JNI_TRUE) 遍历全局 zfiles 链表。
     命中 → refs++，直接返回。未命中 → ZFILE_Open(name) + ZIP_Put_In_Cache0。

     追问：ZFILE_Open 是什么？→ zip_util.c:100，平台相关的文件打开。
     Linux: open(name, O_RDONLY|O_BINARY) → 返回 fd。不是 openat。不是 mmap。
     整个 JAR 文件通过 read() 系统调用读取，不 mmap 映射。

  ② Counterfactual：如果 JAR 用 mmap 映射而不是 read() 会怎样？
     答案方向：mmap 优势：零拷贝（数据直接到用户空间）、page cache 复用。
     劣势：JAR 不可变但 jimage 更需要 mmap（jimage 确实用 mmap，imageFile.cpp:394）。
     ZIP 用 read() 因为：ZIP entry 是碎片化读取（每个 class 加载时只读一个 entry 的数据区
     + 首 CEN，不是全 JAR 顺序读）→ mmap 的预读（readahead）对碎片访问无效。
     成本对比：read() = syscall + copy_from_user (~1μs/4KB)，mmap = page fault (~2μs/4KB 首次)。
```

### 4.2 ★★★ readCEN — Central Directory hashing

```
问题：
  ① readCEN(zip_util.c:568) 如何构建哈希表？不是二分搜索——是哈希表。
     答案方向：步骤：
       1. findEND(zip_util.c:329)：从文件末尾反向扫描 `PK\x05\x06` 签名找 END header
       2. 检查 Zip64 扩展：CEN 偏移 > 0xFFFFFFFF → findEND64 读取 Zip64 end locator
       3. malloc(cenlen) 分配内存 → 一次性读入整个 CEN（ZFILE_read）
       4. 遍历 CEN entries：对每个 entry 调用 hashN(name) 计算 Java 哈希
          → hsh % tablelen → entries[i].next = table[hsh] → table[hsh] = i
       5. collectMetaNames：收集 META-INF/ 名称用于签名验证
     源码证据：zip_util.c:685 tablelen = (total/2) | 1（刻意奇数减少碰撞）
     zip_util.c:735 entries[i].hash = hashN(cp, nlen)
     zip_util.c:736 hsh = entries[i].hash % tablelen

     追问：为什么 tablelen = (total/2) | 1？→ 负载因子 ~2.0（total entries / tablelen）。
     高负载因子 = 更长的冲突链 = 更多遍历。但 hashN 用的是 Java hash
     （与 String.hashCode() 完全相同，h = 31*h + c）→ 分布良好 → 长链概率低。
     `| 1` 确保奇数 → hash%odd 分布更均匀（偶数表大小丢失最低位的熵）。

  ② Counterfactual：如果二分搜索替代哈希表（先排序 CEN entries）？
     答案方向：ZIP 规范不保证 CEN entries 排序。JDK 不控制所有 ZIP 生成器
     （maven shade、gradle、jar 工具可能产生任意顺序）。二分搜索需要先排序
     → O(n log n) 一次性 + O(log n) 每次查找。
     哈希：O(n) 构建 + O(1) 平均查找。3000 entries → 哈希：~3000 次 hashN + 链表插入；
     二分：~3000×log2(3000) ≈ 36000 次比较排序 + 12 次比较查找。
     哈希构建比排序快 12x，每次查找快 6-12x。且哈希不需要 CEN 有序——更通用。
```

### 4.3 ★★★ ZIP_GetEntry2 — hash lookup + chain walk

```
问题：
  ① ZIP_GetEntry2(zip_util.c:1172) 的完整查找序列是什么？
     答案方向：
       1. hsh = hashN(name, ulen) — 计算目标 entry 的哈希值
       2. idx = zip->table[hsh % zip->tablelen] — 定位哈希桶
       3. 遍历链：while(idx != ZIP_ENDCHAIN) { zc = &zip->entries[idx]; ... }
       4. 链内匹配：if(zc->hash == hsh) { 读 CEN header 验证 full name }
       5. 匹配成功 → newEntry(zip, zc, ACCESS_RANDOM) 构造 jzentry
       6. 匹配失败 → idx = zc->next 继续链遍历
       7. 链结束 → zip->entries[idx].next == ZIP_ENDCHAIN → 返回 NULL（entry 不存在）
     源码：zip_util.c:1178-1259。注意 newEntry 可能触发磁盘 I/O
     （读 CEN header 获取完整 name + 元数据），不只是内存操作。

     追问：为什么匹配需要两层——先 hash 再 equals？→ 哈希碰撞。
     hashN 输出 32-bit → 两个不同字符串可能同哈希。equals 比较（zc->hash == hsh
     然后 strcmp(name, ze->name)）确保精确匹配。不跳过 strcmp。

  ② Counterfactual：如果不用哈希表——直接线性扫描 CEN？
     答案方向：3000 entries → 平均扫描 1500 entries 才命中。
     每个 entry 扫描 = 读 CEN header（可能磁盘 I/O）。1500 次 / 1 次哈希 = 750x 慢。
     rt.jar 启动加载 3000+ 类 → 哈希：~3000×0.1μs = 0.3ms。
     线性扫描：~3000×75μs = 225ms。225ms 额外启动时间——用户可感知。
```

### 4.4 ★★★ ZIP_GetFromCache — handle reuse across class loads

```
问题：
  ① ZIP_GetFromCache(zip_util.c:789) 的缓存策略是什么？
     答案方向：全局 zfiles 链表，每元素 = jzfile*。查找条件：
       1. name 匹配（strcmp）
       2. lastModified 匹配（JAR 文件未变）
       3. refs < MAXREFS（0xFFFF，未溢出）
     命中 → zip->refs++ → 返回 zip。未命中 → 返回 NULL → 调用者执行 ZFILE_Open。
     避免重复读取 Central Directory（rt.jar 的 CEN ~200KB，机械盘 ~0.5ms）。

  ② Counterfactual：如果移除缓存——每次 ZipFile 构造都重新 readCEN？
     答案方向：3000 类 × 0.5ms/CEN = 1.5s 纯磁盘 I/O。
     且不是每个 JAR 都只被读一次——rt.jar 被读 3000 次（每个类一次 ZipFile 操作路径）。
     缓存后：首次 readCEN 0.5ms → 后续 2999 次 ~100ns（内存链表 + strcmp + refs++）。
     这是 JVM 从"分钟启动"到"秒启动"的关键优化之一。源码：zip_util.c:789-835。

     追问：MAXREFS=0xFFFF 的限制意义？→ 防止 native 内存无限增长。
     如果 65535 个 ZipFile 并发打开（每个缓存一个）→ 每个 CEN buffer ~100KB
     → ~6.5GB native 内存。上限强制 long-running 应用正确地 close() ZipFile 对象。
```

### 4.5 ★★★ ZIP_Read + InflateFully — the read-decompress pipeline

```
问题：
  ① 从 ZIP entry 获取解压后的 .class 字节的完整 I/O 序列是什么？
     答案方向（以 ZIP_ReadEntry zip_util.c:1486 为例）：
       1. ZIP_GetEntryDataOffset(zip, entry) — 懒加载 LOC header 解析
          计算数据起始偏移 = LOC header 末尾 + filename + extra field
       2. 如果 entry->csize == 0（STORED，无压缩）：
          直接 ZIP_Read 循环读取 → memcpy 到输出 buffer
       3. 如果 entry->csize > 0（DEFLATE 压缩）：
          调用 InflateFully(zip, entry, buffer, bufferLen)（zip_util.c:1404）
          内部：inflateInit2(&strm, -MAX_WBITS) → 流式 inflate → inflateEnd

     追问：为什么用 -MAX_WBITS？→ raw deflate 格式（无 zlib header，无 gzip header）。
     ZIP specification §4.4.4 规定本地文件数据是 raw deflate 流。
     -MAX_WBITS = -15（1<<15 = 32768 字节窗口），抑制 zlib/gzip wrapper 的 2 字节 header。

  ② Counterfactual：如果每次 inflate 都重新 init/reset 而非保持 z_stream 状态？
     答案方向：z_stream 状态（next_in/next_out/avail_in/avail_out/adler）在多次
     inflate 调用间保持 → 无需 re-init。但如果重新 init（inflateEnd + inflateInit2）
     → 每次 ~1μs 额外开销 × 3000 classes = 3ms。不大，但 z_stream 状态保持是免费优化。
     InflateFully 的 while(count > 0) 循环支持跨多个 deflate stream 的 entry
     （虽然本版未实际实现多 stream ZIP entry）。
```

### 4.6 ★★★ ZIP_Lock/ZIP_Unlock — concurrent class loading

```
问题：
  ① ZIP_Lock(zip_util.c:1284) 保护什么？粒度是什么？
     答案方向：per-jzfile 的 JVM_RawMonitor。保护：
       - ZIP_GetEntry2 中的哈希查找 + CEN header 读取（zip_util.c:1178 获取锁）
       - ZIP_Read 中的 seek+read 原子性（zip_util.c:1340 在锁内执行）
       - ZIP_GetEntryDataOffset 中的 LOC header 懒加载（期间 JAR 文件句柄状态不变）
     不保护：readCEN 的全局 zfiles 链表操作——用独立 zfiles_lock（zip_util.c:69）。

     追问：为什么 zfiles 链表用独立锁？→ 避免死锁。
     场景：线程 A 持有 per-JAR lock → 尝试 ZIP_Open（需要 zfiles_lock）。
     线程 B 持有 zfiles_lock → 尝试 ZIP_GetEntry2（需要 per-JAR lock）。
     如果相同锁 → 死锁。独立锁 → 无循环依赖。

  ② Counterfactual：如果 ZIP 操作不加锁——多线程读同一 JAR 的不同 entry？
     答案方向：两个线程同时 ZIP_Read 不同 entry → seek 竞争。
     Thread-1: lseek(offset_foo) → Thread-2: lseek(offset_bar) → Thread-1: read()
     → Thread-1 读的是 bar 的数据而非 foo → .class 字节损坏 → ClassFormatError。
     即使 offset 正确，ZIP_GetEntryDataOffset 的懒加载 LOC 解析修改 jzfile 内部状态
     → 无锁 → 数据竞争 → UB。锁是正确性硬需求，非性能优化。
```

---

## §五 Article Structure

```
§〇 生产场景 — 凌晨 3 点："invalid entry CRC" → JAR 损坏
  ★ 真实错误消息：java.util.zip.ZipException: invalid entry CRC (expected 0x... but got 0x...)
  ★ Root cause：JAR 磁盘损坏或网络传输截断 → CRC32 验证失败
  ★ 三步诊断：jar tvf → python zipfile CRC scan → GDB 断点 ZIP_GetEntry2 + CRC32
  ★ 反事实：如果 CRC32 在 native 完成 → 更快但错误消息退化

§一 ★★★ ZIP/JAR 字节读取全链路源码走读
  ❓ 这不是 ZIP 格式教程——这是 HotSpot 如何从 JAR 读 .class 字节
  ❓ Reader 从 13-launcher + 02-class-loading 来——这里补上中间桥梁
  1.1 ZIP_Open → ZIP_Open_Generic → ZIP_Get_From_Cache (zip_util.c:911→763→789)
      ├─ 缓存命中：refs++，~100ns 返回
      └─ 缓存未命中：ZFILE_Open + ZIP_Put_In_Cache0 → readCEN
  1.2 readCEN：从 CEN 构建哈希表 (zip_util.c:568-754)
      ├─ findEND 反扫定位 END header (zip_util.c:329)
      ├─ malloc CEN buffer + 一次性读入
      ├─ 遍历 entry：hashN → hsh % tablelen → 链式插入
      └─ collectMetaNames (签名验证用)
  1.3 ZIP_GetEntry2：O(1) 哈希查找 (zip_util.c:1172-1261)
      ├─ hashN(name) → hsh % tablelen → 链式遍历
      ├─ hash 匹配 → newEntry 读 CEN header 验证 full name
      └─ 链结束 → ZIP_ENDCHAIN → NULL (entry 不存在)
  1.4 ZIP_GetEntryDataOffset：懒加载 LOC 解析 (zip_util.c:1304)
  1.5 ZIP_Read + InflateFully：读压缩数据 + zlib 解压 (zip_util.c:1340+1404)
      ├─ csize==0 (STORED)：直接 memcpy
      └─ csize>0 (DEFLATE)：inflateInit2(-MAX_WBITS) → inflate → inflateEnd
  1.6 ★ Mermaid：ZIP 读取路径 — JAR 文件 → findEND → readCEN → hash table → 
      ZIP_GetEntry2 → newEntry → ZIP_Read → InflateFully → byte[]
      Lanes: Application / Java ZipFile / Native libzip / zlib / Disk
  1.7 ★ 面试 Story Format 答案 — "JVM 如何从 JAR 中读取 .class 文件？"
     从 ZipFile.getEntry 到 ZIP_GetEntry2 的 O(1) 哈希查找 → 
     从 ZipFile.getInputStream 到 zlib inflate 的 DEFLATE 解压 →
     从 byte[] 到 ClassLoader.defineClass1 的交付

§二 ★★★ 5 Beginner Callout 框
  2.1 ZIP Central Directory — CEN header / LOC header / END header
  2.2 Chained hash table — hashN + tablelen + chain walk
  2.3 ZIP_GetFromCache — zfiles 链表 + refs 引用计数
  2.4 DEFLATE / inflate — zlib 1.2.11 + InflateFully vs ZIP_InflateFully
  2.5 ZIP format — Phil Katz → PKZIP → JAR

§三 ★★ ZIP 并发 + 缓存
  ❓ 为什么 ZIP_Lock 是 per-jzfile 而非全局？
  ❓ zfiles_lock vs per-JAR lock — 为什么两个锁？
  3.1 ZIP_Lock/ZIP_Unlock 源码 + JVM_RawMonitor 语义
  3.2 zfiles 链表操作锁独立 — 死锁预防
  3.3 MAXREFS=0xFFFF — native 内存泄漏防护

§四 ★ GDB 断点验证 — 6 断点完整 ZIP 读取 trace
  断言 1: findEND 反扫 (zip_util.c:329)
  断言 2: readCEN 哈希表构建 (zip_util.c:568)
  断言 3: ZIP_GetEntry2 哈希查找 (zip_util.c:1172)
  断言 4: ZIP_GetFromCache 缓存命中 (zip_util.c:789)
  断言 5: ZIP_Read 压缩数据读取 (zip_util.c:1340)
  断言 6: InflateFully 解压完成 (zip_util.c:1404)

§五 ★ Cross-Reference
  ❓ 13-launcher — classpath→JAR 路径列表，本文从这里接手
  ❓ 02-class-loading — ClassFileParser 消费本文输出的 byte[]
  ❓ 14-zip-jimage 01-Jimage-Format — jimage 替代 ZIP 的方案
  ❓ 14-zip-jimage 02-Compression-Zlib — inflate 管线详解
  ❓ 14-zip-jimage 03-ClassLoader-Bridge — defineClass1 消费 byte[]
  ❓ 17-cds — AppCDS 绕过 ZIP 直接 mmap (.jsa 文件)
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because the JAR file's END header is at the end of the file and its size is unknown (comment field variable-length), findEND must scan backward from EOF in 256-byte chunks looking for the `PK\x05\x06` signature..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from `zip_util.c` / `zip_util.h` / `Inflater.c`, do not describe it.

3. **Mermaid** — ZIP read path sequence diagram. 5 lanes: Application / Java ZipFile / Native libzip (zip_util.c) / zlib / Disk. Complete flow: `new ZipFile(path)` → `ZIP_Open` → `findEND` → `readCEN` → hash table → `getEntry(name)` → `ZIP_GetEntry2` → hash lookup → chain walk → `newEntry` → `getInputStream(entry)` → `ZIP_Read` → compressed bytes → `InflateFully` → `inflateInit2` → `inflate` → uncompressed bytes → `CRC32` verify → `byte[]`. Annotate every step with file:line.

4. **GDB session** — 6 breakpoints with exact file:line numbers:
   - `findEND` entry (zip_util.c:329) — verify END signature scan
   - `readCEN` entry (zip_util.c:568) — inspect CEN buffer + hash table construction
   - `ZIP_GetEntry2` hash lookup (zip_util.c:1172) — inspect hash chain + newEntry results
   - `ZIP_GetFromCache` cache lookup (zip_util.c:789) — inspect zfiles linked list
   - `ZIP_Read` compressed read (zip_util.c:1340) — inspect entry data offset + csize
   - `InflateFully` decompress (zip_util.c:1404) — inspect z_stream state + inflated bytes

   Each with expected variable values to verify.

5. **5 Beginner callout boxes** — exact text from §一: ZIP Central Directory, CEN/LOC headers, Chained hash table, ZIP_GetFromCache, DEFLATE/inflate.

6. **Cross-reference at three points**:
   - At `ZIP_Open` → "→ 13-launcher provides the JAR path from classpath resolution"
   - At `InflateFully` → "→ 14-zip-jimage 02-Compression-Zlib for the full zlib inflate pipeline"
   - At `byte[]` returned → "→ 02-class-loading: ClassFileParser::parseClassFile consumes these bytes"

7. **Story-format interview answer** — at §一末尾：从 `new ZipFile(path)` 到 `byte[] classBytes` 的完整叙事。Two-segment story："JAR 打开 + CEN 哈希表" + "entry 查找 + 解压"。Key contrast：哈希 O(1) vs 二分 O(log n)，缓存命中 vs 重新 readCEN。

---

## §七 Output Format

- Markdown file，named `00-Zip-Class-Loading.md`
- Output path：`/data/workspace/openjdk-cut-new/probe_md/14-zip-jimage/`
- 元信息头：

```
> **阶段**：[14-zip-jimage]
> **前置**：[13-launcher]（classpath→JAR 路径，理解 JAR 从哪里来）、[02-class-loading]（理解 ClassFileParser 需要什么格式的字节输入）
> **配套**：[01-Jimage-Format]（jimage 替代 ZIP 的模块镜像方案）、[02-Compression-Zlib]（inflate 解压管线详解）
> **后续依赖本文**：[03-ClassLoader-Bridge]（defineClass1 接收本文输出的 byte[]）、[17-cds]（AppCDS 绕过本文的 ZIP 路径直接 mmap）
> **阅读收益**：追踪从 `new ZipFile(path)` 到 `byte[] classBytes` 的完整 6 步读链——理解 ZIP_Open→readCEN 的哈希表构建（非二分搜索）、ZIP_GetEntry2 的 O(1) 链式哈希查找、ZIP_GetFromCache 的句柄复用缓存、InflateFully 的 raw DEFLATE 解压、ZIP_Lock/ZIP_Unlock 的 per-JAR 并发控制；掌握 "invalid entry CRC" 的生产故障诊断 workflow
```

- 目标行数：350+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说"构造 ZipFile 对象然后调用 getEntry"而不展示 native 调用链 — 必须从 `ZIP_Open` → `readCEN` → `ZIP_GetEntry2` → `ZIP_Read` → `InflateFully` 完整源码路径
- ❌ 说"CEN 按二分搜索查找" — 必须纠正为哈希表查找，展示 `readCEN` 构建哈希表的源码 + `ZIP_GetEntry2` 的链式查找
- ❌ 引用不存在的 `ZipEntry.c` 文件 — 所有 ZIP 逻辑在 `zip_util.c`（1697 行）
- ❌ 不解释哈希函数的选择 — 必须展示 `hashN` 是 Java 标准 `h=31*h+c` 哈希，与 `String.hashCode()` 一致
- ❌ 不解释 tablelen = (total/2)|1 的设计 — 负载因子 + 奇数表大小的分布优势
- ❌ 忽略缓存机制 — 必须展示 `ZIP_GetFromCache` 的 zfiles 链表 + refs 引用计数
- ❌ 不做 CRC32 校验路径说明 — 必须澄清 CRC32 验证在 Java 层 ZipFile，不在 native 类加载路径
- ❌ 不展示并发控制 — 必须解释 ZIP_Lock/ZIP_Unlock 的 per-jzfile JVM_RawMonitor + zfiles_lock 独立锁
- ❌ 忘记 newEntry 可能触发磁盘 I/O — 不是纯内存操作，需要读 CEN header
- ❌ 不要解释 C 语言基础
- ❌ 不要展开 jimage 格式（01 覆盖）

---

## §九 Required（≥8）

- ✅ **★ Mermaid ZIP 全链路序列图** — 5 lanes: Application / Java ZipFile / Native libzip / zlib / Disk — `ZipFile(path)` → `ZIP_Open` → `findEND` → `readCEN` → hash table → `getEntry(name)` → `ZIP_GetEntry2` → chain walk → `newEntry` → `getInputStream` → `ZIP_Read` → `InflateFully` → `inflate` → `byte[]`
- ✅ **★ readCEN 哈希表构建源码** — zip_util.c:685-736，展示 tablelen、hashN、链式插入
- ✅ **★ ZIP_GetEntry2 完整查找源码** — zip_util.c:1172-1261，展示 hash%tablelen、链遍历、equals 验证
- ✅ **★ Counterfactual 对比表** — 哈希 vs 二分搜索（3000 entries：1 probe vs 12 comparisons），线性扫描（1500 avg probes），无缓存（1.5s 额外交付）
- ✅ **★ 5 Beginner Callout 框** — exact text from §一: ZIP Central Directory, CEN/LOC headers, Chained hash table, ZIP_GetFromCache, DEFLATE/inflate
- ✅ **★ GDB 断点 ≥6 条** — 精确到 file:line，每断点有预期变量值，覆盖 findEND → readCEN → ZIP_GetEntry2 → InflateFully
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：从新的 ZipFile 到 byte[] 的完整故事 + "非二分搜索而是哈希表"的关键纠正
- ✅ **★ ZIP_GetFromCache 源码展示** — zip_util.c:789-835，zfiles 链表 + refs 计数
- ✅ **★ 交叉引用** — 13-launcher（classpath→JAR）、02-class-loading（ClassFileParser）、01-JimageFormat（替代方案）、02-CompressionZlib（zlib 管线）、03-ClassLoaderBridge（defineClass1 消费）

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: findEND 反扫定位 END header (zip_util.c:329)
  (gdb) break zip_util.c:329
  (gdb) print zfd → 期望: 有效的 ZFILE 句柄
  (gdb) continue
  (gdb) print endpos → 期望: END header 在文件中的偏移（非 0）
  (gdb) print cenpos → 期望: CEN 起始偏移

断言 2: readCEN 哈希表构建 (zip_util.c:568)
  (gdb) break zip_util.c:568
  (gdb) print total → 期望: CEN entry 总数（例如 3000 for rt.jar）
  (gdb) continue
  (gdb) print zip->tablelen → 期望: (total/2)|1（奇数，例如 3000→1501）
  (gdb) print zip->table[0] → 期望: 第一个链的 head index
  (gdb) print zip->entries[0].hash → 期望: 第一个 entry 的 hashN 值

断言 3: hashN 哈希计算 (zip_util.c:436)
  (gdb) break zip_util.c:436
  (gdb) print s → 期望: entry 名称字符串（例如 "java/lang/Object.class"）
  (gdb) print n → 期望: 字符串长度
  (gdb) continue
  (gdb) print h → 期望: Java 标准哈希值（31*h+c 累积）

断言 4: ZIP_GetEntry2 哈希查找 (zip_util.c:1172)
  (gdb) break zip_util.c:1172
  (gdb) print name → 期望: 要查找的 entry 名
  (gdb) continue
  (gdb) print hsh → 期望: hashN 计算的哈希值
  (gdb) print zip->table[hsh % zip->tablelen] → 期望: 链头 index
  (gdb) print ze->name → 期望: 匹配到的 entry 完整名称

断言 5: ZIP_GetFromCache 缓存查找 (zip_util.c:789)
  (gdb) break zip_util.c:789
  (gdb) print zfiles → 期望: 全局缓存链表头（NULL 或第一个 jzfile*）
  (gdb) print name → 期望: 要查找的 JAR 文件路径
  (gdb) continue
  (gdb) print zip → 期望: NULL（首次打开）或 有效的 jzfile*（缓存命中）

断言 6: ZIP_Read 读取 entry 数据 (zip_util.c:1340)
  (gdb) break zip_util.c:1340
  (gdb) print entry->name → 期望: entry 名称
  (gdb) print entry->csize → 期望: 压缩大小（0=STORED, >0=DEFLATE）
  (gdb) continue
  (gdb) print buf[0]@16 → 期望: 前 16 字节（CAFEBABE magic 的 .class 文件）

断言 7: InflateFully 解压完成 (zip_util.c:1404)
  (gdb) break zip_util.c:1404
  (gdb) print entry->csize → 期望: 压缩数据大小（>0 表示需要解压）
  (gdb) print entry->size → 期望: 解压后大小
  (gdb) continue
  (gdb) print *buffer@4 → 期望: 0xCAFEBABE（class 文件 magic number）

断言 8: ZIP_Close 引用计数释放 (zip_util.c:925)
  (gdb) break zip_util.c:925
  (gdb) print zip->refs → 期望: ≥1
  (gdb) continue (经过 --zip->refs)
  (gdb) print zip->refs → 期望: 0（最后一次 close → freeZip 释放 native 资源）

断言 9: 缓存未命中路径 (zip_util.c:841 — ZIP_Put_In_Cache0)
  (gdb) break zip_util.c:841
  运行：java -cp newly_added.jar com.example.Main（首次打开该 JAR）
  (gdb) print name → 期望: 新 JAR 文件路径
  (gdb) continue
  (gdb) print zfiles → 期望: 链表头已更新（新 jzfile* 在链表中）
```
