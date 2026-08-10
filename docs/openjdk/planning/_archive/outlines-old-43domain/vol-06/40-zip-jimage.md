# ZIP/JIMAGE (类文件 I/O) — 文章大纲

> vol-06 · 域 40 · 🟡 B | JDK Native | 基于 Pass 0+1
>
> **→ 从 Launcher**：libjli 确定了 main 类和 classpath——但 `.class` 文件的字节从哪读？JAR 内部、jimage 模块镜像——物理字节的读取层。

## 叙事计划

**开篇场景**：ClassLoader 要读 `java/lang/String.class`——不在文件系统，在 `modules` jimage 中 `java.base` 模块的某处。JVM 不自己读——它调 libzip/jimage 的 native 方法读字节，再传给 HotSpot 解析。

**第一层：ZIP_GetEntry + ZIP_Read — JAR 读取核心**
`zip_util.c`(1658行) 的 `ZIP_GetEntry()` 用文件名哈希 O(1) 定位——不是线性遍历。`ZIP_Read()` 从 Local Header 读压缩数据→`Inflater.c`（zlib 1.3.2, git `eece192658`）解压→返回原始字节。ZIP64 支持 4GB+ entry。`parse_manifest.c` 处理 MANIFEST.MF Main-Class。源锚：`zip_util.c`、`Inflater.c`、`parse_manifest.c`。

**第二层：jimage — JDK9+ 模块镜像**
`imageFile.hpp:409` 的 `ImageFileReader` 用预计算完美哈希 O(1) 定位：`find_location()`(`:565`) → hash → 直接 offset。`ImageStrings`/`ImageLocation`/`ImageHeader` 组成三级索引。`imageDecompressor.cpp` 支持 zip/gzip/lz4。git `8253948` 修复了 Memory leak。

**第三层：与 ClassLoader 的边界**
`defineClass1`(native) → `JVM_DefineClassWithSource` 是 JDK→HotSpot 边界。libzip/jimage 的字节通过这个点进入 HotSpot 的 `classFileParser`。

## 核心悬念

**ClassLoader 不读文件系统——它通过 zip_util.c 的哈希表（JAR）或 imageFileReader 的完美哈希（jimage）在压缩镜像中 O(1) 定位 `.class` 字节。**

→ 下一域：字节读了——`System.arraycopy`/`Object.hashCode` 这些高频 native 方法在哪？Core Native 篇。

## 预估

1 篇，3 层递进，1200-1600 行。
