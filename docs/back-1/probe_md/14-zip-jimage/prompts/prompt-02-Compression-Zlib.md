# PROMPT: 请撰写 02-Compression-Zlib.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

生产环境应用启动到第 127 个类加载时崩溃：

```
java.util.zip.ZipException: invalid stored block lengths
```

**这不是 CRC 校验错误。** 这是 zlib 的 `inflate()` 在解压 DEFLATE 流时内部失败 —— 压缩数据本身在结构和逻辑上已损坏（不是磁盘位翻转，而是 compressor 输出了无效的 DEFLATE 流）。zlib `inflate()` 返回 `Z_DATA_ERROR` → `checkInflateStatus`（`Inflater.c:144`）检测到 → 抛出 `ZipException`。根因：JAR 被不兼容的压缩工具构建（非标准 DEFLATE 实现），或文件在复制过程中被截断在压缩数据中间。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 DEFLATE 流的完整性
python3 -c "
import zipfile, zlib
zf = zipfile.ZipFile('app.jar')
for info in zf.infolist():
    data = zf.read(info.filename)
    if info.compress_type == zipfile.ZIP_DEFLATED:
        # 重新压缩 → 解压验证 DEFLATE 流
        raw = zf.open(info).read()
        try:
            zlib.decompress(raw, -8)  # raw deflate
        except zlib.error as e:
            print(f'{info.filename}: {e} — DEFLATE stream corrupt')
"

# 2. 确认压缩方法——是否为 STORED 误标记为 DEFLATED
python3 -c "
import zipfile
zf = zipfile.ZipFile('app.jar')
for info in zf.infolist():
    if info.compress_type == zipfile.ZIP_DEFLATED and info.compress_size == info.file_size:
        print(f'{info.filename}: compressed={info.compress_size} == uncompressed={info.file_size} — possible STORED')
"

# 3. GDB 断点验证 inflate() 返回码
gdb -ex "break Inflater.c:144" \
    -ex "run" \
    -ex "print ret" \
    -ex "print strm->msg" \
    -ex "print strm->total_in" \
    --args java -cp app.jar com.example.Main
```

**反事实**：如果 zlib 的 `inflate()` 对错误更宽容（如跳过损坏块继续前进）→ 可能返回部分解压数据 → `ClassFileParser::parseClassFile` 收到残缺的 class 字节 → `ClassFormatError`（magic 不匹配）或更糟：magic 巧合匹配但字节码随机 → JVM 崩溃（SIGSEGV 在 C2 编译时）。OpenJDK 捆束 zlib 1.2.11（`zlib.h:26`）源码而非依赖系统库，确保所有平台的 inflate 错误报告行为一致——不会出现"Linux 通过、Windows 失败"的跨平台压缩兼容问题。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE DEFLATE/inflate pipeline from `java.util.zip.Inflater.inflate()` to zlib's `inflate()`. This is NOT a compression algorithm tutorial (LZ77 theory, Huffman tree construction). This is ENGINEERING documentation: how the JDK binds zlib 1.2.11 (source-bundled, `zlib.h:26`), manages `z_stream` state across JNI calls, and handles errors.

Reader knows from **00-Zip-Class-Loading** WHERE `InflateFully` is called in the ZIP read path. Reader knows from **01-Jimage-Format** that jimage's decompressor reuses `ZIP_InflateFully` via `dlopen`. This doc answers: **what happens INSIDE zlib when class bytes are DEFLATE-compressed and must be inflated at load time.**

### Beginner Callout Boxes（文档中必须出现的 4 个 callout 框）

1. **DEFLATE / inflate**：DEFLATE = LZ77（后向引用，在 32KB 滑动窗口内找重复字符串）+ Huffman 编码（将高频字符映射为短码）。inflate = 反向过程：从 Huffman 码表→原始字节流 + 复制后向引用。ZIP 默认压缩方法 method=8 = DEFLATE。STORE（method=0）= 无压缩。zlib 提供 C 实现：`inflateInit2_` → `inflate` → `inflateEnd`。

2. **zlib 1.2.11 bundled**：JDK 不是链接系统 zlib（`apt install zlib1g-dev`），而是把 zlib 1.2.11 完整的 C 源码**复制到** `src/java.base/share/native/libzip/zlib/` 目录下（~22 文件，包括 `inflate.c`、`deflate.c`、`crc32.c`、`adler32.c`、`zutil.c` 等）。`zlib.h:26` 明确版本："`zlib 1.2.11, January 15th, 2017`"。捆绑保证：任何 JDK 构建在编译时使用的 zlib 和运行时的 zlib 是同一版本（实际是同一源码编译的）。消除跨平台版本不匹配。

3. **CRC32 vs Adler-32**：双重校验机制。**Adler-32**：zlib 在 `inflate()` 期间自动计算（`z_stream.adler` 字段），在 DEFLATE 流末尾验证——捕获解压算法错误（如 Huffman 码表损坏）。**CRC32**：存储在 ZIP CEN header 的 `CENCRC` 字段（`zip_util.h:102`），在解压后由 Java 层 `ZipFile` 独立计算（`CRC32.c:58`）——捕获磁盘损坏、网络传输错误。二者正交：Adler-32 保护 stream integrity，CRC32 保护 storage integrity。

4. **z_stream 状态机**：`Inflater.c` 管理 `z_stream` 对象的完整生命周期。`init`（`Inflater.c:58`）→ `inflateInit2` 分配 `z_stream` + 初始化。`doInflate`（`Inflater.c:128`）→ 设置 `next_in/next_out/avail_in/avail_out` → 调用 `inflate()`。`end`（`Inflater.c:298`）→ `inflateEnd` + `free(strm)`。关键：`z_stream` 状态在多次 `inflate()` 调用间保持（缓存 Huffman 树状态），避免重复 `inflateInit2`（~1μs/class × 3000 classes = 3ms 优化）。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots：
- `src/java.base/share/native/libzip/` — `Inflater.c`、`CRC32.c`、`zip_util.c`（InflateFully/ZIP_InflateFully）
- `src/java.base/share/native/libzip/zlib/` — zlib 1.2.11 源码捆绑（`zlib.h`、`inflate.c`、`crc32.c`、`adler32.c`、`zutil.c`、`inftrees.c`、`inffast.c`、`inflate.h` 等 ~22 文件）

Build：`make jdk`

Key binary：
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libzip.so` — 包含 Inflater.c + zlib + zip_util.c 的全部编译产物

Key zlib version：
- `zlib.h:26` — "`zlib 1.2.11, January 15th, 2017`"（捆绑）

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **Inflater.c** | `src/java.base/share/native/libzip/Inflater.c` | 305 | `Java_..._Inflater_init`(:58), `doInflate`(:128), `checkInflateStatus`(:144), `Java_..._inflateBytesBytes`(:188), `Java_..._Inflater_end`(:298), `Java_..._Inflater_reset` | JNI 桥接到 zlib inflate——4 种 buffer 组合适配（byte[]/DirectBuffer） |
| 2 | **zip_util.c** (部分) | `src/java.base/share/native/libzip/zip_util.c` | 1697 | `InflateFully`(:1404), `ZIP_InflateFully`(:1545), `ZIP_ReadEntry`(:1486) | ZIP 原生 inflate 路径——直接调用 zlib inflate，不经 JNI |
| 3 | **zlib/zlib.h** | `src/java.base/share/native/libzip/zlib/zlib.h` | ~1900 | Version `1.2.11`(:26), `Z_OK/Z_STREAM_END/Z_DATA_ERROR/...` 常量，`z_stream` struct，`inflateInit2_`/`inflate`/`inflateEnd` 声明 | zlib API 头文件 |
| 4 | **zlib/inflate.c** | `src/java.base/share/native/libzip/zlib/inflate.c` | ~1500 | `inflateInit2_`, `inflate`, `inflateEnd`, `inflateReset2` | DEFLATE 解压算法实现 |
| 5 | **zlib/crc32.c** | `src/java.base/share/native/libzip/zlib/crc32.c` | ~500 | `crc32` (带 CRC-32 表的查表实现) | CRC32 校验值计算 |
| 6 | **zlib/adler32.c** | `src/java.base/share/native/libzip/zlib/adler32.c` | ~200 | `adler32` | Adler-32 校验值计算（zlib stream 内部使用） |

**关键澄清**：
- zlib 1.2.11 **源码级别捆绑**——非系统库。`zlib.h:26` 明确版本。
- `InflateFully`（`zip_util.c:1404`）用 `-MAX_WBITS`（raw deflate），`ZIP_InflateFully`（`zip_util.c:1545`）用 `MAX_WBITS`（zlib wrapper）

---

## §四 Deep Dive Question Groups（≥5，EXACT questions + answer directions）

### 4.1 ★★★ Inflater.c JNI bridge — 4 buffer combinations

```
问题：
  ① Inflater.c 的 4 个 inflate JNI 入口函数分别适配什么 buffer 组合？
     答案方向：java.util.zip.Inflater 支持 4 种 Java buffer 类型：
       1. inflateBytesBytes(byte[] input, int off, int len, byte[] output, int ooff, int olen)
          → Java_..._inflateBytesBytes (Inflater.c:188)
          → GetPrimitiveArrayCritical(input) + GetPrimitiveArrayCritical(output)
          → 双端都是 byte[] → 需要 pin 内存防止 GC 移动
       2. inflateBytesBuffer(byte[] input, long outputAddr, int olen)
          → Java_..._inflateBytesBuffer
          → GetPrimitiveArrayCritical(input) + DirectBuffer address (指针直接可用)
       3. inflateBufferBytes(long inputAddr, int len, byte[] output, int ooff, int olen)
          → Java_..._inflateBufferBytes
          → DirectBuffer address + GetPrimitiveArrayCritical(output)
       4. inflateBufferBuffer(long inputAddr, int len, long outputAddr, int olen)
          → Java_..._inflateBufferBuffer
          → 双端 DirectBuffer → 零拷贝(双端指针直接可用)

     追问：为什么用 GetPrimitiveArrayCritical 而非 GetByteArrayRegion？
     → GetPrimitiveArrayCritical 返回直接指针（可能 pin heap），避免 memcpy。
     GetByteArrayRegion 拷贝一次（heap→native）。inflate 性能关键路径 ——
     3000 classes × 4KB → 12MB 输入数据，memcpy 额外成本 ~0.05ms/class。
     GetPrimitiveArrayCritical 零拷贝但有约束：调用期间不能执行其他 JNI 调用或阻塞操作。

  ② Counterfactual：如果所有 inflate 都走 byte[] → native memcpy → inflate 路径？
     答案方向：DirectBuffer 的优势消失 —— 每次 inflate 都要 memcpy 输入+输出。
     DirectBuffer 场景（NIO FileChannel.map 或 Unsafe.allocateMemory 返回的 buffer）
     → 数据已经在 native 内存 → 无需拷贝 → 零开销到达 z_stream。但 DirectBuffer
     需要应用显式使用 —— class loading 场景中 Java ZipFile 生成的是 byte[]，不是 DirectBuffer。
     所以 class loading 实际走的是 inflateBytesBytes（双端 byte[] 路径，有 GetPrimitiveArrayCritical pin）。
```

### 4.2 ★★★ inflateInit2_ — windowBits + raw vs wrapper

```
问题：
  ① inflateInit2_ 的 windowBits 参数决定什么？
     答案方向：windowBits = 滑动窗口大小（2^windowBits 字节）+ 格式选择。
       - positive (e.g., MAX_WBITS=15): zlib wrapper（2 字节 header + adler32 trailer）
       - negative (e.g., -MAX_WBITS=-15): raw deflate（无 header/trailer）
       - 0: 自动检测（zlib 内部尝试 zlib/gzip/raw 格式）
     在 ZIP 路径中：
       - InflateFully(zip_util.c:1404): inflateInit2(&strm, -MAX_WBITS) = raw deflate
         因为 ZIP spec §4.4.4 规定本地文件数据是 raw deflate 流
       - ZIP_InflateFully(zip_util.c:1545): inflateInit2(&strm, MAX_WBITS) = zlib wrapper
         因为被 jimage 的 ImageDecompressor 调用时，数据带 zlib header

     追问：为什么 ZIP 用 raw deflate 而非 zlib wrapper？→ ZIP 格式在 CEN header
     中已有独立的 CRC32 和 size 字段 → 不需要 zlib 的 header（存储未压缩大小）和
     trailer（adler32）。raw deflate 节省每个 entry 的 6 字节（2 header + 4 trailer）。

  ② Counterfactual：如果 ZIP 用的 raw deflate 被误用 MAX_WBITS 而非 -MAX_WBITS 去解压？
     答案方向：inflateInit2(MAX_WBITS) 期望 zlib header → 前 2 字节必须是
     有效的 zlib header（CMF+FLG）。raw deflate 没有这 2 字节 → 前 2 字节是
     压缩数据的开头（可能是 Huffman 编码的任意字节）→ inflate 返回 Z_DATA_ERROR
     → checkInflateStatus → "invalid stored block lengths" 或 "invalid block type"。
     反之：zlib wrapper 用 -MAX_WBITS 解压 → 2 字节 header 被当作 raw deflate 开头
     → 也是 Z_DATA_ERROR。正确的 windowBits 是正确解压的前提。
```

### 4.3 ★★★ doInflate + checkInflateStatus — the inflate loop

```
问题：
  ① doInflate(Inflater.c:128) 的完整调用序列是什么？
     答案方向：5 步序列：
       1. 设置 z_stream 输入：strm->next_in = input_buf + input_off
          strm->avail_in = input_len (Inflater.c:131-132)
       2. 设置 z_stream 输出：strm->next_out = output_buf + output_off
          strm->avail_out = output_len (Inflater.c:133-134)
       3. 调用 zlib：ret = inflate(strm, Z_PARTIAL_FLUSH) (Inflater.c:140)
          → Z_PARTIAL_FLUSH = 2（刷新所有当前可用输入，尽量填满输出）
          → 实际执行：读 Huffman 码表 → 解码 → LZ77 后向引用复制
       4. 更新 Java buffer 位置：release input/output array (Inflater.c:117-118)
       5. 检查状态：checkInflateStatus(env, this, ret, strm, inputConsumed)
          (Inflater.c:143)

     追问：Z_PARTIAL_FLUSH 和 Z_FINISH 的区别？
     → Z_PARTIAL_FLUSH：尽可能解压当前缓冲区，在不读完所有输入时可以返回。
     Z_FINISH：必须解压完所有输入直到遇到 Z_STREAM_END。
     Java Inflater 支持流式解压 → 调用者可能多次调用 inflate() → 
     不能用 Z_FINISH（第一次调用就结束）。Z_PARTIAL_FLUSH 允许分块消费。

  ② checkInflateStatus(Inflater.c:144) 处理哪些返回码？
     答案方向：全部 5 种 inflate 返回码：
       - Z_OK (0): 正常 → 部分或全部输出已填充 → 返回给 Java
       - Z_STREAM_END (1): 输入全部解压完成 → 设置 finished=true → 返回给 Java
       - Z_NEED_DICT (2): 需要预置字典 (ZIP 不使用 preset dictionary)
         → ZipException("preset dictionary needed")
       - Z_DATA_ERROR (3): 输入数据损坏 → 
         ZipException(strm->msg → "invalid stored block lengths" / "invalid block type" / ...)
       - Z_MEM_ERROR (4): 内存不足 → ZipException("out of memory")
       - Z_BUF_ERROR / Z_STREAM_ERROR 等其他 → ZipException("internal error")

  ③ Counterfactual：如果 checkInflateStatus 不输出 strm->msg 而只输出通用错误？
     答案方向：strm->msg（例如 "invalid stored block lengths"）指向 zlib 内部
     的精确错误位置——指明是 Huffman 树构建失败、LZ77 引用越界、还是块长度字段损坏。
     通用 "corrupt data" 错误 → 无法区分"压缩工具 bug" vs "文件截断" vs "磁盘坏道"。
     strm->msg 是诊断 key——在 "invalid stored block lengths" 的案例中确认了
     DEFLATE 流的 stored block（不压缩块）的长度字段损坏。
```

### 4.4 ★★★ CRC32 vs Adler-32 — dual integrity verification

```
问题：
  ① CRC32 和 Adler-32 在 ZIP/inflate 流程中分别何时计算？各自捕获什么错误？
     答案方向：
       Adler-32：zlib inflate() 在解压期间自动更新 strm->adler 字段。
       在 zlib wrapper（ZIP_InflateFully 使用 MAX_WBITS）中，末尾 4 字节是
       存储的 adler32 值 → inflate() 在遇到 Z_STREAM_END 时自动验证 →
       不匹配 → Z_DATA_ERROR。捕获：解压算法执行错误（Huffman 表损坏、
       LZ77 引用长度超过窗口大小、inflate 实现 bug）。
       
       CRC32：存储在 ZIP CEN header 中（CENCRC at zip_util.h:102）。
       Java 层 ZipFile 在解压完成后，对解压后的字节计算 CRC32（CRC32.c:58）
       → 与 CENCRC 比较 → 不匹配 → ZipException("invalid entry CRC")。
       捕获：磁盘坏道、网络传输截断、RAM bit flip、CEN header 损坏。
       
       两者的独立性：Adler-32 在 inflate() 期间 → 保护压缩数据本身的 stream 完整性。
       CRC32 在解压后（在 uncompressed 数据上）→ 保护存储层面的数据完整性。
       即使 inflate 成功但存储损坏 → CRC32 仍然捕获。

  ② Counterfactual：如果只保留 Adler-32 去掉 CRC32 会怎样？
     答案方向：Adler-32 只在 zlib wrapper 模式（MAX_WBITS）存在。
     ZIP raw deflate（-MAX_WBITS）没有 Adler-32 trailer → 无 stream 内校验。
     如果去掉 CRC32 → 整个 ZIP 格式失去 per-entry 完整性校验 → 
     磁盘损坏导致一个 entry 的 class 字节被静默修改 → ClassFormatError
     或 JVM 崩溃（字节码随机位翻转）。Adler-32 是 32-bit 弱校验
     （碰撞概率 ~2^-32，但对短数据不够强），CRC32 也是 32-bit 但有多项式优势。
     双重校验并非冗余——各自覆盖不同阶段。
```

### 4.5 ★★★ zlib bundled vs system library

```
问题：
  ① zlib.h:26 — "zlib 1.2.11, January 15th, 2017" 为什么是 JDK 的一部分？
     答案方向：OpenJDK 把 zlib 1.2.11 完整的源码复制到 `src/java.base/share/native/libzip/zlib/`
     目录。编译时：`make jdk` → `gcc -c inflate.c deflate.c crc32.c adler32.c zutil.c ...`
     → 静态链接到 `libzip.so`。运行时：不依赖 `libz.so.1`（系统 zlib）。

     追问：为什么不 link `-lz` 用系统 zlib？
     → (a) 版本锁定：DEFLATE 格式稳定（RFC 1951），但 zlib 实现细节可能变化。
     JDK 需要可重复的行为：相同输入在任何平台上产生相同的错误消息（strm->msg）。
     (b) 跨平台一致性：Linux glibc 自带 zlib、macOS 自带 zlib、Windows 无系统 zlib。
     捆绑消除"这个平台有、那个没有"的构建矩阵。
     (c) 安全审计：JDK 安全团队审计固定版本 → CVE 响应确定。

  ② Counterfactual：如果 JDK 用系统 zlib（link -lz）会怎样？
     答案方向：生产环境风险场景：
     - 运维升级系统 zlib（`apt upgrade zlib1g`）→ libz.so.1 从 1.2.11 升级到 1.2.13
     → inflateInit2_ 的参数语义微妙变化 → JDK 的 `Inflater.c` 期望 1.2.11 行为
     → 某些边缘 case（如窗口 buffer 溢出时的返回码不同）→ ClassNotFoundException
     对特定 class（恰好用了特定的 DEFLATE 边缘）。
     - Linux 发行版的 zlib 可能打了本地补丁（如 Debian 的安全补丁）→ 改变了
     inflate 错误恢复路径 → 同样的损坏 JAR 在 Debian 上通过、CentOS 上失败。
     捆绑消除系统差异的整类问题。成本：~200KB 额外的 libzip.so 大小。
```

---

## §五 Article Structure

```
§〇 生产场景 — "invalid stored block lengths"：DEFLATE 流损坏
  ★ 真实错误消息：java.util.zip.ZipException: invalid stored block lengths
  ★ Root cause：不兼容的 ZIP compressor 或文件截断 → inflate() 返回 Z_DATA_ERROR
  ★ 三步诊断：python zlib.decompress → compress_size vs file_size → GDB inflate 返回码
  ★ 反事实：宽容错误处理 → 部分解压 → ClassFormatError 或 JVM 崩溃

§一 ★★★ DEFLATE/inflate 全管线源码走读
  ❓ 这不是压缩算法教程——这是 zlib 在 JVM 类加载中的工程结合
  ❓ Reader 从 00/01 来——理解 inflate 被调用的上下文
  1.1 Inflater.c 架构：4 种 JNI inflate 入口（byte[]/DirectBuffer 组合）
      ├─ inflateBytesBytes(Inflater.c:188): byte[] → byte[] (class loading 实际路径)
      ├─ inflateBytesBuffer: byte[] → DirectBuffer
      ├─ inflateBufferBytes: DirectBuffer → byte[]
      └─ inflateBufferBuffer: DirectBuffer → DirectBuffer (零拷贝)
  1.2 zlib 捆绑：版本 1.2.11（zlib.h:26），源码捆绑非系统库
  1.3 inflateInit2_：windowBits 参数 — -MAX_WBITS(raw deflate) vs MAX_WBITS(zlib wrapper)
      ├─ InflateFully(zip_util.c:1404): -MAX_WBITS = raw deflate for ZIP spec
      └─ ZIP_InflateFully(zip_util.c:1545): MAX_WBITS = zlib wrapper for jimage
  1.4 doInflate(Inflater.c:128)：设置 z_stream I/O → inflate(strm, Z_PARTIAL_FLUSH)
  1.5 checkInflateStatus(Inflater.c:144)：Z_OK / Z_STREAM_END / Z_NEED_DICT / Z_DATA_ERROR / Z_MEM_ERROR
  1.6 ★ Mermaid：inflate 管线 — Java ZipFile → Inflater.inflateBytesBytes → doInflate →
      inflate(strm, Z_PARTIAL_FLUSH) → 读取 Huffman 表 → LZ77 解引用 → CRC32 校验 → byte[]
      Lanes: Java / Inflater.c (JNI) / zlib inflate / z_stream state / Huffman trees
  1.7 ★ 面试 Story Format 答案 — "DEFLATE 解压在类加载期间如何工作？"
     从 Inflater.init 到 inflateInit2_ → inflate 循环 → inflateEnd 的完整叙事 +
     为什么 zlib 是捆绑的而不是系统库 + CRC32 vs Adler-32 双重校验的故事

§二 ★★★ z_stream 状态机全生命周期
  ❓ z_stream 为什么在多次 inflate 间保持？
  ❓ inflateInit2_ → inflate → inflateEnd 的完整状态转换
  2.1 init (Inflater.c:58)：calloc z_stream + inflateInit2_
  2.2 setDictionary (可选)：preset dictionary for ZIP (通常不用)
  2.3 inflate 循环：多次 doInflate 共享 z_stream 状态
  2.4 reset (Inflater.c:239)：inflateReset2 → 重置 z_stream 无需 free+realloc
  2.5 end (Inflater.c:298)：inflateEnd + free(strm) → 释放 native 内存

§三 ★★★ CRC32 vs Adler-32 — 双重校验
  ❓ Adler-32 在 inflate() 期间自动计算——如何捕获解压错误？
  ❓ CRC32 在解压后独立计算——如何捕获磁盘损坏？
  3.1 zlib Adler-32 在 inflate 期间（z_stream.adler 字段，inflateEnd 时验证）
  3.2 CRC32 在 Java 层 ZipFile 读取后在解压后字节上计算（CRC32.c:58 → zlib crc32()）
  3.3 CENCRC (zip_util.h:102) vs 计算出的 CRC32 → 不匹配 → ZipException
  3.4 为什么需要两者：stream integrity vs storage integrity

§四 ★ GDB 断点验证 — 6 断点完整 inflate trace
  断言 1: Inflater.init (Inflater.c:58)
  断言 2: inflateInit2_ 调用 (Inflater.c:78)
  断言 3: doInflate 入口 (Inflater.c:128)
  断言 4: inflate() 返回 + ret 值 (Inflater.c:140)
  断言 5: checkInflateStatus (Inflater.c:144)
  断言 6: CRC32 校验 (CRC32.c:58)

§五 ★ Cross-Reference
  ❓ 00-Zip-Class-Loading — InflateFully 的调用位置 (zip_util.c:1404)
  ❓ 01-Jimage-Format — imageDecompressor dlopen libzip calls ZIP_InflateFully (imageDecompressor.cpp:197)
  ❓ 03-ClassLoader-Bridge — defineClass1 接收解压后的 byte[]
  ❓ 13-launcher — classpath → JAR → ZipFile → Inflater
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because the ZIP specification (§4.4.4) requires raw DEFLATE streams without zlib/gzip wrappers, InflateFully uses inflateInit2 with -MAX_WBITS to suppress the 2-byte zlib header and 4-byte Adler-32 trailer..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from `Inflater.c` / `zip_util.c` / `zlib/zlib.h`, do not describe it.

3. **Mermaid** — inflate pipeline sequence diagram. 5 lanes: Java (ZipFile) / Inflater.c (JNI) / zlib inflate / z_stream state / Huffman trees. Complete flow: `Inflater.init()` → `inflateInit2_` → allocate z_stream → `Inflater.inflate()` → `inflateBytesBytes` → `GetPrimitiveArrayCritical` → `doInflate` → setup next_in/next_out/avail_in/avail_out → `inflate(strm, Z_PARTIAL_FLUSH)` → Huffman tree → LZ77 backward references → update z_stream → `checkInflateStatus` → Z_OK / Z_STREAM_END → return bytes consumed → Java CRC32 verify. Annotate every step with file:line.

4. **GDB session** — 6 breakpoints with exact file:line numbers:
   - `Inflater.c:58` — Inflater.init entry
   - `Inflater.c:78` — inflateInit2_ call (inspect windowBits)
   - `Inflater.c:128` — doInflate entry (inspect input/output buffer addresses)
   - `Inflater.c:140` — inflate() call return value
   - `Inflater.c:144` — checkInflateStatus (inspect strm->msg)
   - `CRC32.c:58` — ZIP_CRC32 computation

   Each with expected variable values to verify.

5. **4 Beginner callout boxes** — exact text from §一: DEFLATE/inflate, zlib 1.2.11 bundled, CRC32 vs Adler-32, z_stream state machine.

6. **Cross-reference at three points**:
   - At `Inflater.init` → "→ called by ZipFile.getInputStream() when first reading compressed data"
   - At `inflate(strm, Z_PARTIAL_FLUSH)` → "→ this is where the actual DEFLATE decompression happens — LZ77 backward references expanded, Huffman codes decoded"
   - At CRC32 verification → "→ 00-Zip-Class-Loading: the CRC32 stored in CEN header (zip_util.h:102) compared against computed value"

7. **Story-format interview answer** — at §一末尾："DEFLATE 解压在类加载时如何工作？" — narrative from Inflater init → inflateInit2_ → doInflate → inflate() → checkInflateStatus → CRC32 verify. Key: zlib 捆绑 1.2.11（非系统库），-MAX_WBITS/MAX_WBITS 的区别，Adler-32 在 stream 内，CRC32 在 stream 外。

---

## §七 Output Format

- Markdown file，named `02-Compression-Zlib.md`
- Output path：`/data/workspace/openjdk-cut-new/probe_md/14-zip-jimage/`
- 元信息头：

```
> **阶段**：[14-zip-jimage]
> **前置**：[00-Zip-Class-Loading]（理解 InflateFully 在 ZIP 读取路径中的位置）、[01-Jimage-Format]（理解 jimage 通过 dlopen 复用 ZIP_InflateFully）
> **配套**：无
> **后续依赖本文**：[03-ClassLoader-Bridge]（defineClass1 接收解压后的 byte[]）
> **阅读收益**：追踪从 `Inflater.init()` 到 `inflateEnd()` 的完整 DEFLATE 解压管线——理解 Inflater.c 的 4 种 JNI buffer 组合适配（byte[]/DirectBuffer）、zlib 1.2.11 源码捆绑（zlib.h:26）的设计理由、inflateInit2_ 的 windowBits 参数选择（-MAX_WBITS raw deflate vs MAX_WBITS zlib wrapper）、doInflate 的 z_stream I/O 设置 + Z_PARTIAL_FLUSH 刷新策略、checkInflateStatus 的 5 种返回码处理（Z_OK/Z_STREAM_END/Z_DATA_ERROR/...）、CRC32 vs Adler-32 的双重校验（stream integrity vs storage integrity）；掌握 "invalid stored block lengths" 的 zlib 内部错误诊断 workflow
```

- 目标行数：350+ lines

---

## §八 Prohibited（≥8）

- ❌ 不解释 DEFLATE/LZ77/Huffman 编码原理 — 这是工程文档，不是算法教程。只需说明"DEFLATE = LZ77 + Huffman"，不要展开滑动窗口算法或 Huffman 树构建
- ❌ 不说明 zlib 是捆绑而非系统库 — 必须展示 zlib.h:26 的版本行 + src 目录路径
- ❌ 忽略 Inflater.c 的 4 种 JNI 入口差异 — 必须对比 inflateBytesBytes/inflateBytesBuffer/inflateBufferBytes/inflateBufferBuffer
- ❌ 不解释 -MAX_WBITS vs MAX_WBITS 选择 — 必须展示 raw deflate (ZIP spec §4.4.4) vs zlib wrapper (jimage 复用) 的不同
- ❌ 不做 doInflate 的传参详解 — 必须展示 next_in/next_out/avail_in/avail_out 设置 + Z_PARTIAL_FLUSH 的含义
- ❌ 不列举 checkInflateStatus 的全部 5+ 返回码 — 必须展示 Z_OK / Z_STREAM_END / Z_NEED_DICT / Z_DATA_ERROR / Z_MEM_ERROR 的完整处理
- ❌ 跳过 strm->msg 的诊断价值 — 必须解释为什么 "invalid stored block lengths" 比 "corrupt data" 更有用
- ❌ 不对比 CRC32 和 Adler-32 — 必须说明它们在流程中不同阶段的不同作用
- ❌ 忘记 z_stream 状态保持 — 必须展示 init → inflate(×N) → end 的生命周期 + 为什么不需要每次 reinit
- ❌ 不要解释 ZIP 文件格式结构（00 覆盖）
- ❌ 不要解释 C 语言基础

---

## §九 Required（≥8）

- ✅ **★ Mermaid inflate 管线序列图** — 5 lanes: Java(ZipFile) / Inflater.c(JNI) / zlib inflate / z_stream state / Huffman trees — init → inflateInit2_ → doInflate → setup I/O → inflate → decompress → Z_STREAM_END → Java CRC32 verify
- ✅ **★ Inflater.c 4 种 JNI 入口对比表** — inflateBytesBytes / inflateBytesBuffer / inflateBufferBytes / inflateBufferBuffer，各自的应用场景和内存拷贝成本
- ✅ **★ inflateInit2_ windowBits 源码** — Inflater.c:58-88 的 init 函数 + zip_util.c:1419 的 InflateFully 调用 + zip_util.c:1553 的 ZIP_InflateFully 调用
- ✅ **★ doInflate 完整源码** — Inflater.c:128-142，展示 z_stream I/O 设置 + inflate() 调用
- ✅ **★ checkInflateStatus 源码** — Inflater.c:144-180，展示 5 种返回码的完整处理 + strm->msg 错误消息
- ✅ **★ zlib.h:26 版本声明展示** — "zlib 1.2.11, January 15th, 2017" + 捆绑目录结构
- ✅ **★ 4 Beginner Callout 框** — exact text from §一: DEFLATE/inflate, zlib 1.2.11 bundled, CRC32 vs Adler-32, z_stream state machine
- ✅ **★ GDB 断点 ≥6 条** — 精确到 file:line，每断点有预期变量值，覆盖 init → inflateInit2_ → doInflate → inflate() → checkInflateStatus → CRC32
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：Inflater 初始 → 解压循环 → 错误处理 → CRC 验证 + zlib 捆绑的跨平台一致性故事
- ✅ **★ CRC32 vs Adler-32 双重校验对比** — Adler-32 在 inflate 期间的 stream integrity vs CRC32 解压后的 storage integrity

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: Inflater.init 入口 (Inflater.c:58)
  (gdb) break Inflater.c:58
  (gdb) print nowrap → 期望: JNI_TRUE（显示是否 raw deflate）
  (gdb) continue
  (gdb) print strm → 期望: 非 NULL z_stream*（已 calloc 分配）

断言 2: inflateInit2_ 调用 (Inflater.c:78)
  (gdb) break Inflater.c:78
  (gdb) print strm → 期望: 非 NULL
  (gdb) print windowBits → 期望: -MAX_WBITS(-15) 或 MAX_WBITS(15)
  (gdb) continue
  (gdb) print ret → 期望: Z_OK(0) — inflateInit2_ 成功

断言 3: doInflate 入口 — I/O 设置 (Inflater.c:128)
  (gdb) break Inflater.c:128
  (gdb) print strm->next_in → 期望: 压缩数据的起始地址
  (gdb) print strm->avail_in → 期望: 压缩数据长度
  (gdb) print strm->next_out → 期望: 输出 buffer 起始地址
  (gdb) print strm->avail_out → 期望: 输出 buffer 大小

断言 4: inflate() 调用返回 (Inflater.c:140)
  (gdb) break Inflater.c:140
  (gdb) continue
  (gdb) print ret → 期望: Z_OK(0) 或 Z_STREAM_END(1) — 正常
  (gdb) print strm->total_in → 期望: 已消费的压缩字节数
  (gdb) print strm->total_out → 期望: 已输出的解压字节数

断言 5: checkInflateStatus 状态检查 (Inflater.c:144)
  (gdb) break Inflater.c:144
  (gdb) print ret → 期望: Z_OK / Z_STREAM_END / Z_DATA_ERROR / ...
  (gdb) print strm->msg → 期望: NULL（成功）或错误消息字符串（失败时）
  (gdb) print inputConsumed → 期望: 已消费的输入字节数

断言 6: CRC32 计算 (CRC32.c:58)
  (gdb) break CRC32.c:58
  (gdb) print *buf → 期望: 解压后的字节地址
  (gdb) print len → 期望: 解压后大小
  (gdb) continue
  (gdb) print crc → 期望: 32-bit CRC 值

断言 7: Z_DATA_ERROR 错误路径 — 故意用损坏的 DEFLATE 数据
  (gdb) break Inflater.c:144
  准备损坏的 JAR：dd if=/dev/urandom of=app.jar bs=1 seek=1000 count=50 conv=notrunc
  (gdb) continue
  (gdb) print ret → 期望: Z_DATA_ERROR(-3)
  (gdb) print strm->msg → 期望: "invalid stored block lengths" 等
  (gdb) continue → checkInflateStatus → throw ZipException

断言 8: InflateFully 路径 — raw deflate vs zlib wrapper (zip_util.c:1404 vs 1545)
  (gdb) break zip_util.c:1404
  (gdb) print entry->csize → 期望: >0（压缩 entry）
  (gdb) continue
  (gdb) print ret → 期望: Z_STREAM_END（成功完成，所有输入解压完毕）
  (gdb) print strm->total_out → 期望: == entry->size（解压后大小 = CEN 中存储的大小）

断言 9: Inflater.end 释放 (Inflater.c:298)
  (gdb) break Inflater.c:298
  (gdb) print strm → 期望: 非 NULL
  (gdb) continue (经过 inflateEnd + free)
  (gdb) print strm → 期望: NULL（或已释放）
```
