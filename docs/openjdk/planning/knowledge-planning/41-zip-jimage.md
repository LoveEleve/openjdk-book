# 域 41: ZIP & JIMAGE — 知识规划

> 源码: libzip/ + libjimage/ | 17文件/~5400行(不含第三方zlib) | 🟡 普通域(2篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| libzip/zip_util.c (1658行) | **ZIP 文件读写**: ZIP_Open→readCEN(parse Central Directory)→ZIP_GetEntry(hash lookup)→ZIP_ReadEntry(inflate)→return raw bytes。支持 mmap CEN/ENDHDR、多引用计数(refs)、per-entry compressed/deflated | High |
| libzip/zip_util.h | **jzfile/jzentry 结构体**: zip open handle(CEN数组/hash表/文件名map)、per-entry metadata(compressed_size/uncompressed_size/method/offset) | High |
| libzip/zlib/ (第三方, 不计) | zlib 压缩库(not part of OpenJDK source) | — |
| libjimage/imageFile.cpp (571行) | **JIMAGE 读取**: ImageFileReader::open(mmap)→find_location(Minimal Perfect Hashing)→get_resource(uncompress)→return bytes。RedHat 贡献的 fast class lookup 格式 | High |
| libjimage/imageFile.hpp | **ImageFileReader 类声明 + 格式规范**: Header(0xCAFEDADA) + Index(Redirect Table/Attribute Offsets/Attribute Data) + Resources 三段式结构。lookup 算法: hash(path,seed)→redirect→location→verify | High |
| libjimage/imageDecompressor.cpp (376行) | **JIMAGE 解压**: get_resource时若location.compressed=1→decompress至uncompressed_data缓冲区 | Medium |
| libjimage/jimage.cpp (217行) | **JIMAGE JNI/API 入口**: JIMAGE_Open/JIMAGE_Close/JIMAGE_PackageToModule/JIMAGE_FindResource——包装 ImageFileReader 的 C 接口 | Medium |

*6 知识点*

## 02 聚合 — P1/P2/P3

### P1 (≥5文件)
| KP | 出现文件 |
|----|---------|
| 无 — 域内仅有2组源文件(ZIP/JIMAGE)，没有跨5+文件的 P1 KP |

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| ZIP 文件访问 (Open→GetEntry→ReadEntry) | zip_util.c, zip_util.h |
| JIMAGE 镜像读取 (open→find→get_resource) | imageFile.cpp, imageFile.hpp, jimage.cpp |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| JIMAGE 解压 | imageDecompressor.cpp |
| ZIP CRC32/Adler32 校验 | CRC32.c, Adler32.c |
| Deflater/Inflater (zlib wrapper) | Deflater.c, Inflater.c |
| JIMAGE 端序处理 (big/little endian) | endian.cpp, endian.hpp |

## 03 深度分类

### 🔴 Deep (2 KP)
| KP | 为什么 🔴 |
|----|---------|
| ZIP Central Directory + hash lookup | JVM 99% 的 class 文件来自 JAR/ZIP——ClassLoader 每次 getResource 都走 ZIP_GetEntry→hash→CEN→inflate。ZIP_Open 时 parse CEN→建立 hash table→O(1) per-entry lookup。zip_util.c:1658 行是整个 class loading 的数据管道。**关键**: CEN 存 offset→无需扫描整个文件。mmap CEN+ENDHDR（非整个文件）减少内存。 |
| JIMAGE Minimal Perfect Hashing (MPH) | module path 上的 classes.jsa→JIMAGE_Open→ImageFileReader::open(mmap整个文件)→find_location(hash→redirect table→location)→get_resource。Minimal Perfect Hashing(O(1) 无碰撞) 比 ZIP 的 hash table 更快且内存零拷贝。Native endian 存储→mmap 直接可用无需字节序转换 |

### 🟡 Working (2 KP)
| KP | 为什么 🟡 |
|----|---------|
| ZIP compression/decompression pipeline | Deflater/Inflater 是 zlib 的 JNI wrapper——ZIP_ReadEntry 时 if compressed→inflate。ZIP 标准格式的支持代码(STORED/DEFLATED) |
| JIMAGE API 层 (jimage.cpp) | JIMAGE_Open/JIMAGE_FindResource/JIMAGE_Close——薄包装器，核心逻辑在 ImageFileReader |

### 🟢 Surface (4 KP)
| KP | 为什么 🟢 |
|----|---------|
| CRC32/Adler32 校验 | zlib API 薄包装——仅用于 ZIP entry 完整性校验 |
| ZIP endian 处理 | 标准 ZIP endian 转换宏 |
| JIMAGE endian 处理 | endian.cpp/endian.hpp——SUN swap bytes 工具函数 |
| JIMAGE header magic (0xCAFEDADA) | 格式标识——仅一行 if 检查 |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | ZIP 文件读取 | "ClassLoader 怎么从 JAR/ZIP 文件中读取 class 字节码？ZIP_GetEntry 怎么在 10ms 内定位一个 entry？" |
| 2 | JIMAGE 模块镜像 | "module path 上的 classes.jsa 是什么格式？O(1) 无碰撞查找怎么做到？" |

**聚类决策**: ZIP 和 JIMAGE 是两种独立的文件格式(ZIP→通用压缩格式, JIMAGE→JDK 专用预编译镜像)→分别作为两篇。ZIP 篇覆盖 Central Directory+hash+inflate 全管道；JIMAGE 篇覆盖 mph+mmap+三段式存储。两者通过"class 文件数据源"的共性产生教学共鸣——读者读完 ZIP 后看 JIMAGE 会惊呼"原来不用 ZIP 也可以用 mmap 做到零拷贝解压"。
