# ZIP/JIMAGE — 第一遍产出

> vol-06 · 域 40 · 🟡 B | Pass 1
> 源码：`zip_util.c`(1658行) + `imageFile.cpp`(571行) + `Inflater.c`

## 基本元素

1. **ZIP_GetEntry + ZIP_Read** — JAR/ZIP 文件读取核心。`ZIP_GetEntry()` 用文件名哈希在 Central Directory 中 O(1) 查找（`zip_util.c:hashN()`），`ZIP_Read()` 解压数据块。JAR 的 `META-INF/` 目录下文件用 `ZIP_Read` 直接读取。
2. **Inflater/Deflater** — zlib 包装。`Inflater.c` 封装 `inflateInit2→inflate→inflateEnd` 流程，`Deflater.c` 封装 `deflateInit2→deflate→deflateEnd`。支持 `nowrap` 模式（原始 deflate 不带 zlib header）和 gzip 模式。
3. **jimage — 完美哈希 O(1)** — `imageFile.cpp` 使用预计算完美哈希函数定位模块资源。`ImageFileReader::find_location("java.base", "java/lang/String.class")` → hash → O(1) 找到 index offset → 直接读字节。比 ZIP 的 Central Directory 查找快（无链表遍历）。
4. **imageDecompressor** — jimage 支持多种压缩：`zip`(deflate)、`gzip`、`lz4`、`lz4_legacy`。`imageDecompressor.cpp` 根据 index 中的 compress type 选择解压器。
5. **NativeImageBuffer** — JVM 和 jimage 的共享内存缓冲区。`jimage.cpp::JIMAGE_Open()` 返回 `JImageFile*` 供 Java 层调用，内部 mmap 整个 jimage 文件。

## 标记问题（≥5）

1. ZIP 哈希表碰撞→链表遍历→O(n) worst case vs jimage 完美哈希 O(1) 的设计对比
2. `Inflater.c` 的 `nowrap` 模式为什么需要——原始 deflate 不带 header 的场景
3. jimage 的 index 文件格式——`modules` 文件中的三级索引结构
4. imageDecompressor 的多格式支持——为什么同时支持 zip/gzip/lz4
5. JAR manifest 解析中的 Class-Path 空格分隔如何影响加载顺序
6. ZIP64 vs 标准 ZIP 在 libzip 中的实现差异
