# 02. JIMAGE 模块镜像 — Minimal Perfect Hashing + mmap

> 🔴 Deep | JIMAGE 读取全管道
> 读者处境: `java --module-path myapp.jar` — JVM 不仅读取 classpath 上的 JAR，还从 `modules` 文件的 `.jimage` 镜像中加载 `java.base` 模块。这个 .jimage 文件是什么？为什么比 ZIP 快？

### 1. "ImageFileReader::open — mmap 整个镜像"

场景: `jrt:/java.base/java/lang/Object.class` — JVM 启动时调用 JIMAGE_Open→ImageFileReader::open→mmap `modules` 文件→一次性内存映射。

**ImageFileReader::open** (`imageFile.cpp:369-420`):
```
ImageFileReader::open():
  → _fd = osSupport::openReadOnly(_name) — open modules 文件
  → _file_size = osSupport::size(_name) — 跨平台获取文件大小(非 lseek)
  → 读 header + 验证: _header.magic==IMAGE_MAGIC(0xCAFEDADA) && major_version==MAJOR_VERSION (imageFile.cpp:378-386)
  → _index_size = index_size() — 计算索引区域总大小(header+redirect+offsets+locations+strings)
  → _index_data = osSupport::map_memory(_fd, _name, 0, map_size()) — 内存映射索引区域
     map_size() = min(_file_size, _index_size) — 最小映射索引部分
  → 计算各段地址偏移: redirect_table/offsets_table/location_bytes/string_bytes (imageFile.cpp:398-413)
[C++: imageFile.cpp 571行 C++——osSupport::map_memory 内部调用 mmap/fstat/read 封装跨平台]
[内核: mmap(MAP_SHARED) → 内核页缓存直接映射到进程地址空间——后续资源读取时 _index_data 已就绪无需 read() 系统调用]
```
- 源码: `imageFile.cpp:369-420` (open → mmap + header 解析) + `imageFile.hpp:40-80` (header 格式定义)

- 关键设计: **map_size() 最小化内存映射范围**(`_file_size > _index_size` 时只 mmap 索引部分 = header + redirect + offsets + locations + strings)——不是整个 .jimage 文件。`memory_map_image`(64位 JVM 默认 true, `imageFile.cpp:44`=`sizeof(void*)==8`) 影响的是后续**资源读取路径**：true→资源数据在 mmap 范围内→直接从 `_index_data + offset` 读(零拷贝)，false→需要 `read_at()` 额外系统调用读资源数据。Native endian 存储——索引数据加载后无需字节序转换(X86 native 刚好是小端)。

### 2. "find_location — Minimal Perfect Hashing O(1) 查找"

场景: ClassLoader 请求 `java/lang/Object.class` — ImageFileReader::find_location 用 Minimal Perfect Hashing 在 O(1) 时间定位资源。

**MPH lookup** (`imageFile.cpp:447-480 + imageFile.hpp:93-110`):
```
ImageFileReader::find_location("/java.base/java/lang/Object.class", location):
  → hash = ImageStrings::hash_code(path, DEFAULT_SEED) — mph hash function
  → redirectIndex = hash % _table_length
  → redirect = _redirect_table[redirectIndex] — s4 (signed 32-bit)
  → if redirect == 0: return NOT_FOUND
  → if redirect < 0: locationIndex = -1 - redirect  // 无碰撞——快速路径
     else: locationIndex = hash_code(path, redirect) % _table_length // 碰撞——换 seed 再 hash
  → location_offset = _attribute_offsets[locationIndex] — 定位到 attribute data
  → verify_location(location, path) — 对比字符串确认找到正确资源
```
- 源码: `imageFile.cpp:447-480` (find_location + find_location_index) + `imageFile.cpp:484-520` (verify_location)

- 关键设计: **Minimal Perfect Hashing** (= 无碰撞、空间紧凑)。Redirect Table 用 signed 32-bit 值编码两种状态: 负数 → 无碰撞直接转索引; 正数 → 新 seed 重新 hash。`verify_location` 是最终安全网——因为不同字符串理论上可以 hash 到同一位置(即使 MPH 概率极低)。hash 函数: `HASH_MULTIPLIER = 0x01000193` (经典 FNV-1a 变体)。

### 3. "get_resource — 零拷贝解压"

场景: find_location 找到资源偏移→get_resource 将 location 指向的压缩数据解压到缓冲区。

**get_resource** (`imageFile.cpp:523-565`):
```
ImageFileReader::get_resource(location, uncompressed_data):
  → offset = location.content_offset
  → size = location.uncompressed_size
  → if location.compressed:
      ImageDecompressor::decompress_resource(compressed_data, compressed_size,
                                              uncompressed_data, uncompressed_size)
     else:
      memcpy(uncompressed_data, compressed_data, uncompressed_size)
```
- 源码: `imageFile.cpp:523-545` (get_resource → decompress or memcpy)

- 关键设计: **compressed flag 在 location 元数据中**(per-resource)——不是整个镜像的统一设置。每个 class/resource 独立决定是否压缩。`ImageDecompressor::decompress_resource` 实现了多种压缩算法(zlib deflate/gzip 等)，通过 data 首字节的 magic number 自动检测压缩类型。**零额外内存分配**——uncompressed_data 缓冲区由调用方提供→解压直接写入→无需临时 buffer。

### 4. "三段式存储 — Header + Index + Resources"

场景: .jimage 文件在磁盘上的物理布局。

**文件结构** (`imageFile.hpp:46-60`):
```
+-----------+  0x000
|  Header   |  magic(0xCAFEDADA) + version + flags + resource_count + table_length
+-----------+  header_size
| Redirect   |  s4[] — 32-bit signed redirect values
|  Table     |
+-----------+
| Attribute  |  u4[] — 32-bit offsets into attribute data
|  Offsets   |
+-----------+
| Attribute  |  compact encoded byte stream(压缩位置/大小/类型 per resource)
|   Data     |
+-----------+
|  Strings   |  以 offset 索引的 UTF-8 字符串表(去重, offset 0 = "")
+-----------+
| Resources  |  原始 class/resource 数据(可选压缩)
+-----------+
```
- 源码: `imageFile.hpp:46-60` (文件结构注释) + `imageFile.hpp:65-80` (header 字段详细格式)

- 关键设计: **三段式非 ZIP**——不是 ZIP Central Directory 模式。Index 区域是前置的(文件头后立即进入)→mmap 后不产生任何 seek。ZIP 的 CEN 在文件末尾→需要 seek 到末尾→解析→seek 回数据区。**Strings 段是全局去重的 UTF-8 字符串表**——路径字符串如 `/java.base/java/lang/` 只存一次→通过 offset 引用——节省空间。

---

### 核心悬念

**"JIMAGE = mmap 全部文件→三段式存储(Header+Index+Resources)→Minimal Perfect Hashing O(1) 无碰撞查找→per-resource compressed flag→零拷贝解压。比 ZIP 快: 无 seek、无 hash 碰撞、native endian、字符串全局去重。"** — 下一篇: 域42 Core Native。

> → 域42 Core Native
