# PROMPT: 请撰写 01-Jimage-Format.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

生产环境 JDK 部分升级：运维用 `yum update` 更新了 `java` 二进制（JDK 17），但 `lib/modules` 文件残留为 JDK 11 的构建。

```
java.lang.module.FindException: Module java.base not found
```

**这不是 classpath 错误。** `lib/modules` 文件被 `JIMAGE_Open`（`jimage.cpp:59`）打开时，`ImageFileReader::open()`（`imageFile.cpp:369`）验证 header：
- Magic number：期望 `0xCAFEDADA`（`imageFile.hpp:445`），实际值不匹配 → 返回 `JIMAGE_BAD_MAGIC`（`jimage.hpp:69`）
- Version：期望 `MAJOR=1, MINOR=0`（`imageFile.hpp:449-451`），实际值不匹配 → 返回 `JIMAGE_BAD_VERSION`（`jimage.hpp:71`）

根因：部分 JDK 升级——`java` 二进制被替换但模块镜像文件未替换。不同 JDK 主版本的 jimage 格式可能不兼容。所有 `java.base` 的类通过模块路径加载 → `JIMAGE_FindResource` 失败 → `FindException`。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查 jimage 版本头
jimage info $JAVA_HOME/lib/modules
# 输出: Magic: 0xCAFEDADA, Major: 1, Minor: 0 (正常)
# 输出: JIMAGE_BAD_MAGIC 或 JIMAGE_BAD_VERSION (异常)

# 2. 确认 java 二进制版本 vs modules 文件版本
java -version                                      # JDK 17?
readelf -p .comment $JAVA_HOME/bin/java | head     # 编译版本
stat --format='%Y' $JAVA_HOME/lib/modules          # modules 修改时间

# 3. GDB 断点验证 JIMAGE_Open 的 header 验证
gdb -ex "break imageFile.cpp:381" \
    -ex "break imageFile.cpp:384" \
    -ex "run" \
    -ex "print _F → 期望: 0xCAFEDADA" \
    -ex "print _major_version → 期望: 1" \
    -ex "print _minor_version → 期望: 0" \
    --args java -p $JAVA_HOME/lib/modules -m java.base
```

**反事实**：如果 jimage 格式是向后兼容的（新 JDK 能读旧 modules 文件）→ 部分升级不会导致启动失败 → 但运行时可能出现 `NoSuchMethodError`（旧类缺少新方法）。OpenJDK 团队选择 fail-fast 策略：宁可启动时 `FindException`，不可运行 2 小时后 `NoSuchMethodError`。header 验证实现这一策略。

---

## §一 Task + Narrative + De-glamorization + Beginner Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE jimage module image format: header layout, perfect hashing mechanism, location table, string table, and decompressor pipeline. This is NOT a tutorial on perfect hashing theory. This is ENGINEERING documentation: how the JDK's `lib/modules` file provides O(1) strict class lookup — the replacement for `rt.jar` / `classes.jsa`.

Reader knows from **13-launcher** HOW classpath resolves to JAR/module paths. Reader knows from **00-Zip-Class-Loading** HOW ZIP's hash table works (O(1) average, chained). This doc answers: **how does jimage achieve strict O(1) lookup with perfect hashing — and why that matters.**

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **Perfect hashing（完美哈希）**：在所有 key 预先已知时构造的哈希函数，保证无碰撞 → O(1) 严格上限，无退化到 O(n) 的可能。jimage 的完美哈希：`hash_code(path, HASH_MULTIPLIER=0x01000193)` → `hash % table_length` → redirect_table[index]。如果 `redirect_table[index] = 0` → NOT_FOUND；`< 0` → 直接命中（`index = -1 - value`）；`> 0` → 冲突（用 `value` 做二次哈希种子）。

2. **HASH_MULTIPLIER = 0x01000193**：`imageFile.hpp:162` 定义的素数。关键属性：最小化 32-bit 哈希碰撞。与 Java `String.hashCode()` 不同（后者用 31），jimage 选择 `0x01000193` 因为它与 table_length 的模运算分布更均匀。源码：`imageFile.cpp:59-67`——逐字符 `hash = hash * HASH_MULTIPLIER + c`。

3. **Location table**（位置表）：8 字节/entry 的结构，存储每个资源的偏移 + 解压后大小 + 压缩后大小 + 属性。属性用 kind:length:value 编码（可变长）。`find_location_index`（`imageFile.cpp:464`）通过完美哈希查到的 index 直接索引 location table → 获得 offset + size → 无需额外搜索。

4. **Redirect table**（重定向表）：完美哈希的核心。`u4[table_length]` 数组。每个入口有三种状态：`value < 0` = 直接索引（`index = -1 - value`），`value > 0` = 二次哈希种子，`value == 0` = NOT_FOUND。在 jimage 构建时预计算——所有 key 已知 → 可以找到无碰撞的哈希函数参数。

5. **Magic number 0xCAFEDADA**：`imageFile.hpp:445`。4 字节文件头标识。类似 CAFEBABE（class 文件 magic）但故意不同——如果 class loader 误以 jimage 为 class 文件 → 立即失败。版本字段紧随其后：MAJOR=1, MINOR=0（`imageFile.hpp:449-451`）。

---

## §二 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux.

Source roots：
- `src/java.base/share/native/libjimage/` — `jimage.cpp`、`imageFile.cpp`、`imageFile.hpp`、`imageDecompressor.cpp`、`jimage.hpp`
- `src/java.base/unix/native/libjimage/` — 平台特定部分

Build：`make jdk`

Key binary：
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/libjimage.so` — jimage 读取库
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/modules` — 模块镜像文件（jimage 格式）

Key constants（`imageFile.hpp`）：
- `IMAGE_MAGIC = 0xCAFEDADA`（line 445）
- `MAJOR_VERSION = 1, MINOR_VERSION = 0`（lines 449-451）
- `HASH_MULTIPLIER = 0x01000193`（line 162）

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:--:|-------|------|
| 1 | **jimage.cpp** | `src/java.base/share/native/libjimage/jimage.cpp` | 217 | `JIMAGE_Open`(:59), `JIMAGE_Close`(:76), `JIMAGE_FindResource`(:112), `JIMAGE_GetResource`(:159), `JIMAGE_PackageToModule` | jimage C API 入口 |
| 2 | **imageFile.cpp** | `src/java.base/share/native/libjimage/imageFile.cpp` | 571 | `ImageFileReader::open()`(:369), `find_location`(:447), `find_location_index`(:464), `get_resource`(:533), `verify_location`, `find_image`(:255), `ImageStrings::find`(:75), `ImageStrings::hash_code`(:59) | 镜像文件读写、完美哈希查找、属性解析 |
| 3 | **imageFile.hpp** | `src/java.base/share/native/libjimage/imageFile.hpp` | 585 | `ImageHeader`, `ImageLocation`, `ImageStrings`, `ImageFileReader`, `ImageFileReaderTable`, `IMAGE_MAGIC`, `MAJOR_VERSION`, `HASH_MULTIPLIER` | jimage 格式定义 + 数据结构 |
| 4 | **imageDecompressor.cpp** | `src/java.base/share/native/libjimage/imageDecompressor.cpp` | 376 | `ImageDecompressor::decompress_resource`(:142), `ZipDecompressor::decompress`(:197), `SharedStringDecompressor::decompress_resource`(:213), `image_decompressor_init`(:83) | jimage 解压管线（zip + shared-string） |
| 5 | **jimage.hpp** | `src/java.base/share/native/libjimage/jimage.hpp` | 193 | `JIMAGE_Open_t`, `JIMAGE_NOT_FOUND`, `JIMAGE_BAD_MAGIC`, `JIMAGE_BAD_VERSION`, `JIMAGE_CORRUPTED` | jimage 公共 API 类型定义 + 错误码 |

**关键澄清**：
- jimage 使用**完美哈希**——`HASH_MULTIPLIER = 0x01000193`（`imageFile.hpp:162`），magic `0xCAFEDADA`，version MAJOR=1 MINOR=0
- jimage decompressor **dlopen libzip.so** 复用 `ZIP_InflateFully`（`imageDecompressor.cpp:83`）
- jimage 索引通过 **mmap** 映射（`imageFile.cpp:394`），与 ZIP 的 `read()` 不同

---

## §四 Deep Dive Question Groups（≥6，EXACT questions + answer directions）

### 4.1 ★★★ JIMAGE_Open — magic + version + mmap

```
问题：
  ① JIMAGE_Open(jimage.cpp:59) 的完整打开序列是什么？
     答案方向：委托给 ImageFileReader::open()（imageFile.cpp:369）：
       1. 验证 header（imageFile.cpp:381-384）：
           magic check: CGET(u4, 0) == IMAGE_MAGIC(0xCAFEDADA) → 失败 → JIMAGE_BAD_MAGIC
           version check: major == MAJOR_VERSION(1) && minor == MINOR_VERSION(0) → 失败 → JIMAGE_BAD_VERSION
       2. mmap 索引段（imageFile.cpp:394）：
           _index_data = mmap(NULL, map_size, PROT_READ, MAP_SHARED, fd, index_offset)
           — 映射 redirect table + location table + attribute data + strings table
       3. 设置指针（imageFile.cpp:395-400）：
           _redirect_table = _index_data + redirect_offset
           _offsets_table = _index_data + offsets_offset
           _locations_data = _index_data + locations_offset
           _strings_data = _index_data + strings_offset
       4. 注册到 _reader_table（全局共享表，imageFile.cpp:411）

     追问：为什么索引用 mmap 而不是 read？→ 索引需要重复随机访问
     （每次 JIMAGE_FindResource = redirect_table[index] + location_table[index] +
     strings_table[patch_offset]）→ mmap 利用 page cache，零拷贝，无需 lseek+read 对。

  ② Counterfactual：如果 header 验证失败后不报错，而是尝试兼容读取？
     答案方向：可能读到错误的 redirect_table 偏移 → index 全部错位 →
     find_location 返回随机位置 → get_resource 读到的字节不是 class 文件 →
     ClassFormatError（比 FindException 更晚、更难诊断）。
     fail-fast 在 header 阶段：JIMAGE_BAD_MAGIC/BAD_VERSION → 立即知道根因。
```

### 4.2 ★★★ Perfect hashing — HASH_MULTIPLIER + redirect table

```
问题：
  ① ImageStrings::find(imageFile.cpp:75) 的完美哈希查找完整流程？
     答案方向：
       1. hash = hash_code(path, HASH_MULTIPLIER=0x01000193)（imageFile.cpp:59）
          → hash = 1; for each char c: hash = hash * 0x01000193 + c
       2. index = hash % table_length（imageFile.cpp:83）
       3. value = redirect_table[index]（imageFile.cpp:88）
       4. 三种 case：
          - value < 0: return -1 - value（直接命中，imageFile.cpp:92）
          - value > 0: index = hash_code(path, value) % table_length（二次哈希，imageFile.cpp:95-98）
          - value == 0: NOT_FOUND
       5. verify_location(path) 确认无假阳性（imageFile.cpp:96 — 在二次哈希成功后）

     追问：为什么完美哈希还需要 verify_location？→ 虽然 redirect_table 预计算了无碰撞的
     哈希函数，但 index 可能指向另一个 key（极罕见的情况下散列种子仍可能冲突）。
     verify_location 是防御层——匹配属性中的模块/包/基/扩展名。

  ② Counterfactual：如果 jimage 用 ZIP 的普通链式哈希（O(1)平均）而非完美哈希（O(1)严格）？
     答案方向：3000 个模块类。ZIP 哈希：平均 1-2 次 probe，最坏 ~10 次（碰撞链长度取决于负载因子）。
     jimage 完美哈希：总是 1 次 redirect table lookup + 最多 1 次二次哈希。但关键差异是
     可预测性——实时系统（如 safety-critical Java）需要确保类加载延迟有严格上限。
     ZIP 哈希的最坏延迟不可预测（取决于 JAR 构建工具的 CEN 顺序 + hashN 碰撞）。
     jimage 的最坏延迟在构建时已知——可验证。成本：完美哈希需要在构建时预计算
     （jlink 阶段），增加构建时间但消除运行时不确定性。
```

### 4.3 ★★★ Location table — O(1) guaranteed resource offset

```
问题：
  ① location table 的结构是什么？find_location_index 如何用完美哈希的 index 直接定位？
     答案方向：location table 是属性流编码的数组（imageFile.cpp:464-478）：
       1. 定位：imageFile.cpp:470 → offset of location = get_location_offset(index)
       2. 读取属性：循环解析 kind/length/value 三元组
          - ATTRIBUTE_END (0): 结束
          - ATTRIBUTE_OFFSET (1): 资源数据中的偏移
          - ATTRIBUTE_UNCOMPRESSED (2): 解压后大小
          - ATTRIBUTE_COMPRESSED (3): 压缩后大小（0=未压缩）
          - ATTRIBUTE_MODULE (4): 所属模块名
          - ATTRIBUTE_PARENT (5): 父包名
          - ATTRIBUTE_BASE (6): 基名（类名）
          - ATTRIBUTE_EXTENSION (7): 扩展名（.class）
       3. 返回 size + locationIndex（imageFile.cpp:529-531）

     追问：为什么用属性流而非固定大小 struct？→ 空间效率。
     大部分资源只有 OFFSET + UNCOMPRESSED 两个属性（不需要 MODULE/PARENT/BASE）。
     属性流编码用 1+1+N 字节（kind+length+value）→ 2-8 字节/资源，
     vs 固定 struct 的 24 字节/资源。3000 resources → 6KB vs 72KB。

  ② Counterfactual：如果 jimage 用 ZIP 的 CEN entry 风格（固定大小 header）存储资源元数据？
     答案方向：ZIP CEN header = 46 字节/entry（固定字段）+ 可变长 name + extra + comment。
     jimage location table = 2-8 字节/资源（属性流）。3000 resources → jimage：6-24KB，
     ZIP CEN：~180KB。且 jimage 的属性可以嵌套（PARENT 引用 MODULE string table offset）
     → 进一步减少重复字符串。
```

### 4.4 ★★★ String table — shared deduplication

```
问题：
  ① jimage 的 strings table（imageFile.hpp:138 — "Each string is unique"）存储什么？
     答案方向：全局去重的 UTF-8 字符串。包括：
       - 模块名："java.base", "java.logging" 等
       - 包名："java/lang", "java/util" 等
       - 类名："Object", "String" 等
       - 常量池字符串（如 "([B)V", "Code", "java/lang/Object" 等——由 SharedStringDecompressor 外部化）
     每个字符串存储一次 → 所有资源通过 offset 引用 → 零冗余。

     追问：为什么 ZIP 不这样做？→ ZIP CEN 中每个 entry 独立存储 name（不跨 entry 共享）。
     "java/lang/Object" 可能在 500+ entries 中作为引用 → ZIP 存 500 次。
     jimage 存 1 次。这是 jimage 整体压缩率高于逐类 DEFLATE 的关键之一。

  ② Counterfactual：如果 strings table 不存在，所有字符串 inline 在 resource data 中？
     答案方向：常量池字符串重复（500+ 引用 "java/lang/Object"）→ 
     DEFLATE 压缩可以部分消除（LZ77 后向引用在 32KB 窗口内检测到重复）。
     但 DEFLATE 是流压缩（32KB 窗口）→ 跨资源的重复无法检测。
     jimage 的全局 strings table 是文件级别的去重 → 压缩率比 DEFLATE 高 10-15%。
```

### 4.5 ★★★ imageDecompressor — dlopen libzip.so + decompressor chain

```
问题：
  ① image_decompressor_init(imageDecompressor.cpp:83) 为什么 dlopen("libzip.so")？
     答案方向：为了复用 ZIP_InflateFully（zip_util.c:1545）——避免 jimage 自己实现 zlib inflate。
     dlopen 获取函数指针：ZIP_InflateFully_t = dlsym(libzip, "ZIP_InflateFully")
     → 存储在 ZipDecompressor 的函数指针成员中。解压时通过函数指针调用：
     ZIP_InflateFully(compressed_data, compressed_size, uncompressed_data, &uncompressed_size)

     追问：为什么不静态链接 libzip？→ 模块化设计。libjimage.so 是独立的共享库，
     不一定与 libzip.so 在同一进程空间。dlopen 在运行时按需加载。
     如果 jimage 应用场景不需要 ZIP 解压（例如仅读取 stored 资源）→ 永不触发 dlopen。

  ② Counterfactual：如果 jimage 有自己的 inflate 实现而不是复用 libzip 的？
     答案方向：代码重复 → jimage 需要自己的 InflateFully（~50 行）+
     链接 zlib 或捆绑自己的 inflate 代码 → zlib 版本可能不同 → 版本不匹配风险。
     复用 libzip：一个 zlib 1.2.11，一个 inflate 管线，零重复。
     dlopen 成本：~0.01ms 首次调用，之后函数指针调用 ~5ns。
```

### 4.6 ★★★ SharedStringDecompressor — constant pool reconstruction

```
问题：
  ① SharedStringDecompressor::decompress_resource(imageDecompressor.cpp:213) 如何重建 class 常量池？
     答案方向：jimage 构建时把 class 常量池中的字符串外部化到全局 strings table。
     读取时逐 tag 重建：
       1. externalized_string: 从 strings table 取回 UTF-8 字符串（offset → get(k)）
       2. externalized_string_descriptor: 重建方法描述符
          — 如 "(Ljava/lang/String;I)V" 中的 "Ljava/lang/String;" 从 package/class 引用重建
       3. constant_utf8: 保留原样（未外部化的小字符串）
       4. constant_long/double: 跳过占位 slot（i++ 消耗 2 个常量池索引）
     解压整数用压缩整数编码（imageDecompressor.cpp:354）：小整数用 1-4 字节可变长表示。

     追问：为什么 class 文件常量池需要外部化？→ 重复字符串是 class 文件最大的空间浪费源。
     500 个类引用 "java/lang/Object" → 在各自的常量池中存 UTF-8 字符串 → 500×20 字节 = 10KB。
     jimage 存一次（strings table）→ + 每个引用 4 字节 offset → 2KB 总计 → 5x 压缩。

  ② Counterfactual：如果没有 SharedStringDecompressor，jimage 直接用 ZIP 的 DEFLATE 压缩每个 class？
     答案方向：Class 文件的 DEFLATE 压缩率 ~50%。SharedString 额外提供 10-15% 改进。
     但最大优势不是大小——是**加载性能**。从 strings table 取回字符串 = O(1) memory lookup。
     DEFLATE 解压 = zlib inflate 流处理 → ~20μs/class。SharedStringDecompressor 只需 memcpy
     + 整数解压 → ~5μs。整体 class 加载快 4x。
```

---

## §五 Article Structure

```
§〇 生产场景 — 部分 JDK 升级：magic/version mismatch → FindException
  ★ 真实错误消息：java.lang.module.FindException: Module java.base not found
  ★ Root cause：lib/modules header 验证失败——java 二进制 vs modules 版本不匹配
  ★ 三步诊断：jimage info → java -version vs stat modules → GDB header 断点
  ★ 反事实：向后兼容 header → 晚失败 NoSuchMethodError vs 早失败 FindException

§一 ★★★ jimage 格式全链路源码走读
  ❓ 这不是完美哈希教程——这是 JDK 的 lib/modules 如何工作
  ❓ Reader 从 00-Zip-Class-Loading 来——理解 ZIP 哈希后看 jimage 完美哈希
  1.1 JIMAGE_Open：magic 0xCAFEDADA + version 1.0 + mmap (jimage.cpp:59 → imageFile.cpp:369)
      ├─ magic check (imageFile.cpp:381) → CGET(u4,0) == 0xCAFEDADA
      ├─ version check (imageFile.cpp:384) → major==1 && minor==0
      ├─ mmap index (imageFile.cpp:394) → redirect_table + location_table + strings
      └─ 注册到 _reader_table (imageFile.cpp:411) — inc_use 引用计数
  1.2 JIMAGE_FindResource：完美哈希 O(1) 查找 (jimage.cpp:112 → imageFile.cpp:464)
      ├─ 拼接 "/java.base/java/lang/Object.class" (jimage.cpp:130-136)
      ├─ ImageStrings::find：hash_code → redirect_table → 命中/二次哈希 (imageFile.cpp:75)
      └─ get_location_offset(index) → size + offset (imageFile.cpp:470-531)
  1.3 JIMAGE_GetResource：解压 + 返回字节 (jimage.cpp:159 → imageFile.cpp:533)
      ├─ compressed_size==0：直接 memcpy
      ├─ compressed_size>0：ImageDecompressor pipeline
      └─ header chain: zip decompressor → shared-string decompressor
  1.4 ImageDecompressor pipeline (imageDecompressor.cpp:142-375)
      ├─ ZipDecompressor::decompress → 函数指针调用 ZIP_InflateFully
      └─ SharedStringDecompressor::decompress_resource → 常量池重建
  1.5 ★ Mermaid：jimage 查找路径 — lib/modules → mmap header → redirect_table[index]
      → location_table[index] → get_resource → decompressor → .class bytes
      Lanes: JVM / libjimage / Kernel (mmap) / Strings Table / Decompressor
  1.6 ★ 面试 Story Format 答案 — "jimage 如何用 O(1) 严格查找替代 ZIP O(1) 平均？"
     从完美哈希的定义 → redirect_table 的三态逻辑 → 
     与 ZIP 哈希表的对比（冲突链 vs 零冲突）→ 
     为什么只在 JDK 模块系统用（闭合世界假设）

§二 ★★★ 5 Beginner Callout 框
  2.1 Perfect hashing — 无碰撞哈希 + HASH_MULTIPLIER=0x01000193
  2.2 Redirect table — <0 命中 / >0 二次哈希 / ==0 NOT_FOUND
  2.3 Location table — 属性流编码 + O(1) offset 定位
  2.4 String table — 全局去重 + SharedStringDecompressor 引用
  2.5 Magic 0xCAFEDADA — 文件头标识 + version 字段

§三 ★★ jimage vs ZIP 对比
  ❓ 为什么 jimage 只用于模块路径而不用于 classpath？
  ❓ 如果 JAR 也用完美哈希会怎样——为什么不行？
  3.1 闭合世界 vs 开放世界（构建时已知所有 key vs 运行时可变）
  3.2 查找性能：ZIP 哈希链 1-3 probe vs jimage 1 probe 严格
  3.3 压缩率：ZIP DEFLATE ~50% vs jimage shared-string 额外 10-15%
  3.4 mmap vs read：jimage 索引随机访问 vs ZIP CEN 一次性读入

§四 ★ GDB 断点验证 — 6 断点完整 jimage trace
  断言 1: JIMAGE_Open header check (imageFile.cpp:381)
  断言 2: mmap 索引映射 (imageFile.cpp:394)
  断言 3: hash_code 计算 (imageFile.cpp:59)
  断言 4: ImageStrings::find redirect table lookup (imageFile.cpp:88)
  断言 5: find_location_index 属性流解析 (imageFile.cpp:470)
  断言 6: get_resource 解压 (imageFile.cpp:533)

§五 ★ Cross-Reference
  ❓ 00-Zip-Class-Loading — ZIP 哈希表对比（为什么 O(1) 平均 vs 严格 O(1) 重要）
  ❓ 02-Compression-Zlib — imageDecompressor 的 ZIP_InflateFully 来自 libzip
  ❓ 03-ClassLoader-Bridge — BuiltinClassLoader 通过 JIMAGE_FindResource 查找类
  ❓ 17-cds — CDS 共享归档是 jimage 的另一个替代（预加载 Klassen）
  ❓ 13-launcher — 模块路径解析决定哪些模块从 jimage 加载
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because jimage must provide strict O(1) lookup with predictable worst-case latency for real-time systems, the redirect table is pre-computed at jlink time to guarantee zero collisions rather than relying on probabilistic hash functions..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C++ code from `imageFile.cpp` / `imageFile.hpp` / `imageDecompressor.cpp`, do not describe it.

3. **Mermaid** — jimage lookup path sequence diagram. 5 lanes: JVM (BuiltinClassLoader) / libjimage / Kernel (mmap) / Strings Table / Decompressor. Complete flow: `JIMAGE_Open` → `open()` header check → mmap index → `JIMAGE_FindResource` → path assembly → `find_location_index` → `ImageStrings::find` → hash_code → redirect_table[index] → case <0: direct → location_table[index] → `JIMAGE_GetResource` → `get_resource` → compressed? → `ImageDecompressor::decompress_resource` → zip decompressor → shared-string decompressor → `.class` bytes. Annotate every step with file:line.

4. **GDB session** — 6 breakpoints with exact file:line numbers:
   - `imageFile.cpp:381` — magic check (0xCAFEDADA)
   - `imageFile.cpp:384` — version check (major==1, minor==0)
   - `imageFile.cpp:394` — mmap index
   - `imageFile.cpp:59` — hash_code computation
   - `imageFile.cpp:88` — redirect_table[index] lookup
   - `imageFile.cpp:533` — get_resource decompress

   Each with expected variable values to verify.

5. **5 Beginner callout boxes** — exact text from §一: Perfect hashing, HASH_MULTIPLIER, Location table, Redirect table, Magic number 0xCAFEDADA.

6. **Cross-reference at three points**:
   - At `JIMAGE_Open` → "→ this replaces ZIP_Open in the JDK module path; classpath still uses ZIP"
   - At `ZIP_InflateFully` call → "→ 02-Compression-Zlib: the inflate pipeline shared with ZIP path"
   - At `SharedStringDecompressor` → "→ the key innovation that makes jimage compression superior to per-class DEFLATE"

7. **Story-format interview answer** — at §一末尾："jimage 如何用 O(1) 严格查找替代 ZIP O(1) 平均？" — narrative from header verification → perfect hash → location table → decompressor. Key contrast: ZIP's collision chains (probabilistic) vs jimage's redirect table (deterministic), shared strings vs per-class DEFLATE, mmap vs read.

---

## §七 Output Format

- Markdown file，named `01-Jimage-Format.md`
- Output path：`/data/workspace/openjdk-cut-new/probe_md/14-zip-jimage/`
- 元信息头：

```
> **阶段**：[14-zip-jimage]
> **前置**：[00-Zip-Class-Loading]（理解 ZIP 哈希表的工作方式——O(1) 平均但有碰撞链）、[13-launcher]（理解模块路径如何决定哪些类从 jimage 加载）
> **配套**：[02-Compression-Zlib]（imageDecompressor 的 ZIP_InflateFully 来自 libzip.dll → 同一 zlib 管线）
> **后续依赖本文**：[03-ClassLoader-Bridge]（BuiltinClassLoader 通过 JIMAGE_FindResource 查找模块类）
> **阅读收益**：追踪从 `JIMAGE_Open(lib/modules)` 到 `.class` 字节的完整 6 步查找链——理解 jimage header 的 magic 0xCAFEDADA + version 验证、完美哈希（HASH_MULTIPLIER=0x01000193 + redirect_table 三态逻辑）、location table 的属性流编码、strings table 的全局去重机制、ImageDecompressor 的 zip+shared-string 管线；掌握 "Module java.base not found" 的 JDK 部分升级诊断 workflow
```

- 目标行数：350+ lines

---

## §八 Prohibited（≥8）

- ❌ 只说"jimage 是 O(1) 查找"不展示完美哈希机制 — 必须展示 hash_code → redirect_table → 三态判断的完整源码
- ❌ 忽略 HASH_MULTIPLIER 的值和含义 — 必须展示 0x01000193 + 逐字符哈希计算 + 与 Java String.hashCode 的区别
- ❌ 不解释 redirect_table 的三种返回值 — 必须展示 value<0 直接命中、value>0 二次哈希、value==0 NOT_FOUND
- ❌ 跳过位置表和属性流的编码格式 — 必须展示 kind/length/value 三元组的解析 + ATTRIBUTE_OFFSET/UNCOMPRESSED 等类型
- ❌ 不解释 image_decompressor_init 的 dlopen("libzip.so") — 必须展示为什么复用 libzip 的 ZIP_InflateFully 而非自实现
- ❌ 忽略 SharedStringDecompressor 的常量池重建逻辑 — 必须展示 externalized_string/externalized_string_descriptor/constant_utf8 三种 tag 的处理
- ❌ 不比较 jimage 和 ZIP 在相同场景下的性能差异 — 必须列出 1 probe vs 1-3 probe、strings 去重、mmap vs read
- ❌ 不解释闭合世界假设 — 必须说明为什么 jimage 只用于 JDK 模块（构建时已知所有 key）
- ❌ 不做 header 验证失败的错误码映射 — 必须展示 JIMAGE_BAD_MAGIC / JIMAGE_BAD_VERSION / JIMAGE_NOT_FOUND / JIMAGE_CORRUPTED
- ❌ 忘记 mmap 机制解释 — imageFile.cpp:394 的 mmap 是非磁盘 I/O class 加载的关键
- ❌ 不要解释 C++ 基础
- ❌ 不要展开 ZIP 格式细节（00 覆盖）

---

## §九 Required（≥8）

- ✅ **★ Mermaid jimage 全链路序列图** — 5 lanes: JVM / libjimage / Kernel(mmap) / Strings Table / Decompressor — JIMAGE_Open → header check → mmap → JIMAGE_FindResource → hash_code → redirect_table → location_table → JIMAGE_GetResource → decompressor pipeline → byte[]
- ✅ **★ ImageStrings::find 完美哈希源码** — imageFile.cpp:75-101，展示 hash_code → redirect_table[index] → 三态判断
- ✅ **★ redirect_table 三态源码** — imageFile.cpp:88-98，展示 value<0 直接命中、value>0 二次哈希、value==0 NOT_FOUND
- ✅ **★ HASH_MULTIPLIER 源码展示** — imageFile.hpp:162 定义 + imageFile.cpp:59-67 的 hash_code 实现
- ✅ **★ Location table 属性流源码** — imageFile.cpp:470-531，展示 ATTRIBUTE_OFFSET/UNCOMPRESSED/COMPRESSED/MODULE 等解析
- ✅ **★ 5 Beginner Callout 框** — exact text from §一: Perfect hashing, HASH_MULTIPLIER, Location table, Redirect table, Magic number
- ✅ **★ image_decompressor_init 源码** — imageDecompressor.cpp:83-86，展示 dlopen("libzip.so") + dlsym("ZIP_InflateFully")
- ✅ **★ GDB 断点 ≥6 条** — 精确到 file:line，每断点有预期变量值，覆盖 header check → hash_code → redirect_table → get_resource
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事：jimage 完美哈希 O(1) 严格 vs ZIP 链式哈希 O(1) 平均 + 为什么只在 JDK 模块用（闭合世界）
- ✅ **★ jimage vs ZIP 对比表** — 查找性能、压缩率、内存模型（mmap vs read）、冲突处理（确定性 vs 概率）、适用场景（闭合 vs 开放）

---

## §十 GDB Verification（≥8 assertions）

```
断言 1: JIMAGE_Open header check — magic (imageFile.cpp:381)
  (gdb) break imageFile.cpp:381
  (gdb) print CGET(u4, 0) → 期望: 0xCAFEDADA
  (gdb) print IMAGE_MAGIC → 期望: 0xCAFEDADA
  (gdb) continue → 如果相等，继续到 version check

断言 2: JIMAGE_Open header check — version (imageFile.cpp:384)
  (gdb) break imageFile.cpp:384
  (gdb) print _major_version → 期望: 1
  (gdb) print MAJOR_VERSION → 期望: 1
  (gdb) print _minor_version → 期望: 0
  (gdb) print MINOR_VERSION → 期望: 0

断言 3: mmap 索引映射 (imageFile.cpp:394)
  (gdb) break imageFile.cpp:394
  (gdb) print index_size → 期望: >0（索引段大小）
  (gdb) continue
  (gdb) print _index_data → 期望: 非 NULL（mmap 成功返回地址）

断言 4: hash_code 计算 (imageFile.cpp:59)
  (gdb) break imageFile.cpp:59
  (gdb) print string → 期望: "/java.base/java/lang/Object.class" 等路径字符串
  (gdb) print HASH_MULTIPLIER → 期望: 0x01000193
  (gdb) continue
  (gdb) print hash → 期望: 32-bit 哈希值（非 0）

断言 5: ImageStrings::find redirect table lookup (imageFile.cpp:88)
  (gdb) break imageFile.cpp:88
  (gdb) print index → 期望: hash % table_length 的结果
  (gdb) continue
  (gdb) print value → 期望: <0（直接命中）、>0（二次哈希种子）、或 0（NOT_FOUND）

断言 6: find_location_index 属性流解析 (imageFile.cpp:470)
  (gdb) break imageFile.cpp:470
  (gdb) print location_index → 期望: ImageStrings::find 返回的 index
  (gdb) continue
  (gdb) print offset → 期望: 资源数据中的偏移（>0）
  (gdb) print size → 期望: 解压后大小（>0）
  (gdb) print compressed_size → 期望: 0（stored）或 >0（需解压）

断言 7: get_resource 解压 (imageFile.cpp:533)
  (gdb) break imageFile.cpp:533
  (gdb) print location_index → 期望: find_location_index 返回的 index
  (gdb) print compressed_size → 期望: 0 或 >0
  (gdb) continue (如果 compressed_size > 0 → 进入 decompressor)
  (gdb) print *buffer@4 → 期望: 0xCAFEBABE（.class 文件 magic）

断言 8: image_decompressor_init 加载 libzip (imageDecompressor.cpp:83)
  (gdb) break imageDecompressor.cpp:83
  (gdb) print libzip → 期望: NULL（首次调用）
  (gdb) continue
  (gdb) print libzip → 期望: dlopen("libzip.so") 返回的 handle（非 NULL）
  (gdb) print ZIP_InflateFully → 期望: 非 NULL 函数指针

断言 9: JIMAGE_BAD_MAGIC 错误路径 — 故意损坏 magic
  (gdb) break imageFile.cpp:383
  手动修改 lib/modules 的开头 4 字节（echo "\x00\x00\x00\x00" | dd of=lib/modules bs=1 count=4 conv=notrunc）
  (gdb) print magic → 期望: ≠ 0xCAFEDADA
  (gdb) continue
  → 期望输出: JIMAGE_BAD_MAGIC 错误 → java.lang.module.FindException
```
