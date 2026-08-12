# 02. JIMAGE 模块镜像 — 为什么 JDK 不用 ZIP

> **前置依赖**:[41-zip-jimage/01 — ZIP 文件读取](01-zip.md):ZIP 的打开/查找/读取全管道——jimage 处处是它的反面
> → **后续**:[42-core-native/01 — JNI 工具层与系统属性](openjdk/vol-02/42-core-native/01-jni-system.md)(第 2 批收官域)
> 关联域: 07-classfile-classloader(类加载器读 jrt:/ 镜像)、30-jvm-entry(启动时 JIMAGE_Open)、43-nio-net(jrt 文件系统)

## 把 JDK 打包成一块"硬盘"

JDK 9 起,java.base 等模块不再装在 rt.jar,而是打进 `lib/modules`——一个 **jimage 镜像文件**。同样是"文件名 → 数据"的映射问题,ZIP 用了"目录放末尾 + 打开时建哈希表 + 按需 seek 读",jimage 反着来: **索引前置、查找用预计算的最小完美哈希、数据可以整个 mmap 进来**。这篇拆开 libjimage: 打开映射、完美哈希查找、资源读取与解压,以及那个始终悬着的问题——为什么 JDK 对自己的镜像不用 ZIP。

## 1. 打开: 整个镜像进地址空间

### 校验头部,映射文件

`ImageFileReader::open`(imageFile.cpp:369-412)的流程: 只读打开 → 取文件大小 → 读 28 字节 `ImageHeader`(7 个 u4: magic/版本/标志/资源数/表长/两段大小,imageFile.hpp:322-328)校验(`IMAGE_MAGIC = 0xCAFEDADA`、主版本 1,imageFile.hpp:445-451)→ 算索引大小 → **mmap 文件** → 在映射区里切出四段:

```cpp
// imageFile.cpp:396-413(截取核心,逐字)
    // Retrieve length of index perfect hash table.
    u4 length = table_length();
    // Compute offset of the perfect hash table redirect table.
    u4 redirect_table_offset = (u4)header_size;
    // Compute offset of index attribute offsets.
    u4 offsets_table_offset = redirect_table_offset + length * (u4)sizeof(s4);
    // Compute offset of index location attribute data.
    u4 location_bytes_offset = offsets_table_offset + length * (u4)sizeof(u4);
    // Compute offset of index string table.
    u4 string_bytes_offset = location_bytes_offset + locations_size();
    // Compute address of the perfect hash table redirect table.
    _redirect_table = (s4*)(_index_data + redirect_table_offset);
    // Compute address of index attribute offsets.
    _offsets_table = (u4*)(_index_data + offsets_table_offset);
    // Compute address of index location attribute data.
    _location_bytes = _index_data + location_bytes_offset;
    // Compute address of index string table.
    _string_bytes = _index_data + string_bytes_offset;
```

四段(redirect 表 / 偏移表 / 属性数据 / 字符串表)全部由 header 里的长度字段算出地址,`index_size = header + table_length*8 + locations + strings`(imageFile.hpp:437-441)——**映射的起点与大小决定一切**。

### 映射多少: 一条语句两个世界

关键在 `map_size`(imageFile.hpp:494-497,逐字):

```cpp
// imageFile.hpp:493-497(截取核心,逐字)
    // Retrieve the size of the mapped image.
    inline u8 map_size() const {
        return (u8)(memory_map_image ? _file_size : _index_size);
    }
```

- `memory_map_image = sizeof(void*) == 8`(imageFile.cpp:44)——**64 位 JVM 默认 true**;
- true: 映射**整个文件**(`map_size = _file_size`)——资源数据也在地址空间里,读取零拷贝(§3);
- false(32 位,地址空间紧张): 只映射索引区(`map_size = _index_size`),资源数据按需 `read_at` 系统调用读。

**关键设计 (斜体)**: *64 位映射全部、32 位只映射索引,是"地址空间换系统调用"的平台权衡——64 位不缺虚拟地址,宁可让文件全进页缓存;32 位地址空间宝贵,只保证索引常驻,资源数据随用随读。*

## 2. 查找: 最小完美哈希,一跳定位

### 三种值的 redirect 表

索引的核心是 **redirect 表**: 每个槽一个 32 位有符号数,编码三种状态(注释 imageFile.hpp:98-127 是权威文档)。查找算法 `ImageStrings::find`(imageFile.cpp:75-100,截取核心,逐字):

```cpp
// imageFile.cpp:75-101(截取核心,逐字)
s4 ImageStrings::find(Endian* endian, const char* name, s4* redirect, u4 length) {
    // If the table is empty, then short cut.
    if (!redirect || !length) {
        return NOT_FOUND;
    }
    // Compute the basic perfect hash for name.
    s4 hash_code = ImageStrings::hash_code(name);
    // Modulo table size.
    s4 index = hash_code % length;
    // Get redirect entry.
    //   value == 0 then not found
    //   value < 0 then -1 - value is true index
    //   value > 0 then value is seed for recomputing hash.
    s4 value = endian->get(redirect[index]);
    // if recompute is required.
    if (value > 0 ) {
        // Entry collision value, need to recompute hash.
        hash_code = ImageStrings::hash_code(name, value);
        // Modulo table size.
        return hash_code % length;
    } else if (value < 0) {
        // Compute direct index.
        return -1 - value;
    }
    // No entry found.
    return NOT_FOUND;
}
```

- 先 `hash_code(name)`(默认 seed 就是 `HASH_MULTIPLIER`,imageFile.hpp:174-175)取模定位槽;
- 槽值 `> 0`: 有碰撞,槽里存的是**新 seed**——换 seed 重算哈希再取模(完美哈希的"种子重试");`< 0`: 无碰撞,`-1 - value` 直接是索引;`== 0`: 不存在。

算法出处: 注释里引了论文 "A Practical Minimal Perfect Hashing Method"(imageFile.hpp:94-95)——哈希函数是 FNV-1a 变体(`useed = (useed * HASH_MULTIPLIER) ^ byte`,`HASH_MULTIPLIER = 0x01000193`,imageFile.cpp:57-68,imageFile.hpp:162)。

### verify: 最后的保险

拿到索引后,`verify_location`(imageFile.cpp:484-519)是**必做的验证**——不是可选项: 把路径按 `/module/parent/base.extension` 拆开,逐段与字符串表里的属性比对,全部吻合且到串尾才算命中。为什么必须验证?完美哈希是"给定集合无碰撞",但**任意字符串**(查询方传进来的)可以撞进同一槽——"不同字符串理论上可以 hash 到同一位置"的兜底就是这层比对。

**关键设计 (斜体)**: *ZIP 用"打开时算哈希表",jimage 用"构建时算完美哈希"——查找时零冲突、零链式遍历,一跳定位。代价是构建器(jlink)必须知道全部资源名才能算出一张无碰撞表;代价的兜底是 verify 逐段比对(路径在字符串表里全局去重,比对成本只是内存比较)。*

## 3. 读取: 压缩数据带"快递单"

### get_resource: 两条路

`get_resource`(imageFile.cpp:533-565,截取核心,逐字):

```cpp
// imageFile.cpp:533-566(截取核心,逐字)
void ImageFileReader::get_resource(ImageLocation& location, u1* uncompressed_data) const {
    // Retrieve the byte offset and size of the resource.
    u8 offset = location.get_attribute(ImageLocation::ATTRIBUTE_OFFSET);
    u8 uncompressed_size = location.get_attribute(ImageLocation::ATTRIBUTE_UNCOMPRESSED);
    u8 compressed_size = location.get_attribute(ImageLocation::ATTRIBUTE_COMPRESSED);
    // If the resource is compressed.
    if (compressed_size != 0) {
        u1* compressed_data;
        // If not memory mapped read in bytes.
        if (!memory_map_image) {
            // Allocate buffer for compression.
            compressed_data = new u1[(size_t)compressed_size];
            ...
            bool is_read = read_at(compressed_data, compressed_size, _index_size + offset);
            ...
        } else {
            compressed_data = get_data_address() + offset;
        }
        // Get image string table.
        const ImageStrings strings = get_strings();
        // Decompress resource.
        ImageDecompressor::decompress_resource(compressed_data, uncompressed_data, uncompressed_size,
                        &strings, _endian);
        ...
    } else {
        // Read bytes from offset beyond the image index.
        bool is_read = read_at(uncompressed_data, uncompressed_size, _index_size + offset);
        assert(is_read && "error reading from image or short read");
    }
}
```

- **压缩资源**: `memory_map_image` 时压缩数据直接取 `get_data_address() + offset`(映射区里的地址,**零拷贝进解压器**);否则 `read_at` 读进临时缓冲。输出缓冲 `uncompressed_data` 由**调用方提供**,但解压器内部还会分配一块临时缓冲、解压完成后 `memcpy` 到调用方缓冲再释放(imageDecompressor.cpp:167-182)——调用方零分配,解压侧一次中间缓冲;
- **未压缩资源**: 走 `read_at` 读文件(即使 memory_map_image——未压缩分支没有 mmap 捷径)。

### 资源数据的"快递单": ResourceHeader

压缩数据不是裸 deflate 流——每个资源开头是 29 字节的 `ResourceHeader`(imageDecompressor.cpp:145-164): magic(`0xCAFEFAFA`)、压缩大小、解压后大小、解压器名字在字符串表的偏移、配置偏移、`is_terminal` 标志。`decompress_resource` 用 **do-while 循环**逐个剥头: 只要还是资源头(has_header),就按名字查解压器(如 ZipDecompressor,imageDecompressor.cpp:189)解一层、继续剥——**支持"解压器栈"**(一个资源可能被多个算法依次处理)。magic 不符(纯数据)就停。

**关键设计 (斜体)**: *每个资源独立决定压缩与否(压缩标志在 location 属性里,不是镜像全局配置),压缩格式又由资源自己的头描述——镜像的构建器(jlink)可以对不同资源选不同策略,读取方完全被动按头执行。*

## 4. 布局: 索引前置,对比 ZIP

### 文件结构

镜像的物理布局(注释 imageFile.hpp:112-129 是权威,截取):

```cpp
// imageFile.hpp:112-129(截取注释,逐字)
// The following is the format of the index;
//
//         +-------------------+
//         |   Redirect Table  |
//         +-------------------+
//         | Attribute Offsets |
//         +-------------------+
//         |   Attribute Data  |
//         +-------------------+
//         |      Strings      |
//         +-------------------+
//
// Redirect Table - Array of 32-bit signed values representing actions that
//                  should take place for hashed strings that map to that
//                  value.  Negative values indicate no hash collision and can be
//                  quickly converted to indices into attribute offsets.  Positive
//                  values represent a new seed for hashing an index into attribute
//                  offsets.  Zero indicates not found.
```

头部 28 字节之后依次是: redirect 表(s4×table_length)、偏移表(u4×table_length)、属性数据(location 的紧凑流)、字符串表(全局去重 UTF-8,偏移 0 保留给空串)——**索引在文件前部,数据区在索引之后**。这与 ZIP 完全相反: ZIP 的 Central Directory 在文件**末尾**,打开必须先 seek 到尾部、解析完再回来;jimage 的索引在开头,mmap 后所有元数据直接可用。

字符串表是 jimage 的省钱大法: 路径被拆成 module/parent/base/extension 四段,`/java.base/java/lang/` 这类公共前缀**全局只存一份**,所有资源按偏移引用——对比 ZIP 每个条目完整存名字。

[实证:] 素材库 `jimage info` 输出(materials/commands/jimage-info.txt)就是真实 `lib/modules` 的头部明细: `Resource Count: 29345`、`Table Length: 29345`、四个区段大小(Offsets 117380 / Redirects 117380 / Locations 605863 / Strings 642825)、`Index Size: 1483476`——1.4MB 的索引服务 29345 个资源;同一 JDK 的 `lib/modules` 实测 129557387 字节(约 123.5MB),索引只占约 1.1%。

## 核心悬念

jimage 的全管道到齐: 打开时校验头部、按 `memory_map_image` 决定映射全部还是只映射索引;查找用最小完美哈希——默认 seed 一次取模定位,碰撞槽存新 seed 重试,verify 兜底;读取时压缩资源从 mmap 零拷贝进解压器、按 29 字节资源头识别格式、支持解压器栈;布局上索引前置、字符串全局去重。与 ZIP 的对比一图流: **ZIP 尾部目录 + 打开建哈希 + seek 读;jimage 前置索引 + 构建期完美哈希 + mmap 读**。JDK 对自己用 jimage,对第三方还是用 ZIP——两种格式各得其所。下一域离开文件系统,进到 JVM 与操作系统的边界——域 42: Core Native(JNI 工具层、进程与系统属性)。

> → [42-core-native/01 — JNI 工具层与系统属性](openjdk/vol-02/42-core-native/01-jni-system.md)
