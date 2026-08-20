# 11-cds/01-cds-overview-dump 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 CDS dump 端为什么不是“把类序列化到文件”，而是“构造一份以后能被固定地址 mmap 的共享内存镜像”

## 1. 选题判断

现稿已经有 dump 入口、region 布局、filemap 头、classlist 等大量事实，但结构仍偏“流程账单 + 格式说明”：先 preload，再 compact，再讲 region，再讲 header。读者能记住很多名词，却不一定真正抓住 CDS 的根问题。

真正的读者困惑是：

**JVM 为什么不能简单把已经解析好的 `InstanceKlass`/`Method` 序列化到磁盘，下次再读回来？CDS dump 端真正构造的到底是“类数据文件”，还是“一份未来要被 mmap 到固定地址的内存镜像”？**

如果这个困惑没有打穿，后面所有 region、magic、read-only/read-write、narrow_klass_base 都会显得像格式细节，而不是围绕同一个目标服务。

## 2. 一句话顿悟

**CDS dump 端的核心不是“保存类”，而是“把一批已经链接好的类元数据压成一份未来可直接 mmap 的进程内存镜像”。这要求 dump 时就冻结 metaspace 对象集、清掉运行期不可共享状态、把对象搬到连续区域、按只读/可写/可执行属性分区，并让指针关系以固定基址为前提成立。换句话说，CDS 产物不是 class 的离线描述，而是 HotSpot 未来想直接映射进地址空间的一段预制内存。**

## 3. 总图

```text
-Xshare:dump
  │
  ├─ preload_classes(classlist)
  │    └─ 仍走正常 class loading / linking
  │
  ├─ link_and_cleanup_shared_classes
  │    └─ 把漏网类补链接、准备稳定对象集
  │
  ├─ VM_PopulateDumpSharedSpace::doit (VM thread)
  │    ├─ Metaspace::freeze
  │    ├─ rewrite_nofast_bytecodes / remove_unshareable
  │    ├─ ArchiveCompactor::copy_and_compact
  │    ├─ dump_symbols / dump_java_heap_objects
  │    └─ write regions into archive file
  │
  ├─ archive layout
  │    ├─ mc / rw / ro / md core spaces
  │    ├─ string regions
  │    └─ open archive heap regions
  │
  └─ file header + path/config validation basis
       └─ future mmap must recreate same assumptions
```

## 4. 结构大纲与字数预算

### 第一节：开场事故——为什么每次启动都重复解析同一批核心类

目标约 1200 字。

- 从 1000+ 核心类每次都走 class loading / verifier / linking 开场
- 强调重复劳动不在 `.class` 文件本身，而在“解析并构造 HotSpot 运行时元数据”
- 引出 CDS 想缓存的不是字节流，而是解析后的 VM 内存形态

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：
1. 只缓存 `.class` 原文
2. 把 `InstanceKlass` 等对象逐个序列化到文件
3. dump 时不冻结 metaspace，对象边 dump 边继续增长

要落出的结论：
- 缓存 class 文件没跳过最贵的 VM 构造阶段
- 逐对象序列化解决不了进程内指针关系与地址假设
- 对象集不冻结，compaction 与重定位就没有稳定前提

### 第三节：入口——`-Xshare:dump` 为什么是一条独立启动路径

目标约 1500 字。

- `MetaspaceShared::preload_and_dump`
- classlist 路径来源：默认 `lib/classlist` 或 `SharedClassListFile`
- `preload_classes` 仍走正常类加载与 `try_link_class`
- 纠偏：dump 不是跳过类加载，而是先完整走一遍，再把产物留下

### 第四节：为什么真正的重头戏在 VM 线程里的 `VM_PopulateDumpSharedSpace::doit`

目标约 2200 字。

- `Metaspace::freeze()` 的两个原因
- 收集已加载类、`rewrite_nofast_bytecodes_and_calculate_fingerprints`
- `remove_unshareable_in_classes`
- `ArchiveCompactor::initialize + copy_and_compact`
- 纠偏：这不是“递归序列化对象图”，而是“压实 + 重定位 + 分区写入”的镜像构造

### 第五节：region 布局——为什么要按读写/执行/堆对象分区

目标约 1900 字。

- `mc/rw/ro/md` 四个 core spaces
- string regions / open archive heap regions
- 为什么 `ro` 可以只读共享，`rw` 保留运行期 patch 空间，`mc` 需要执行权限
- 纠偏：JDK 11u 不是旧资料里常说的 `od` 五区模型

### 第六节：固定基址与指针假设——为什么 dump 端就要关心 `narrow_klass_base`

目标约 1800 字。

- dump 时预留共享区与临时 class space
- `Universe::set_narrow_klass_base((address)_shared_rs.base())`
- 共享区基址、compressed class space 与指针关系
- 让读者看懂“为什么以后加载时必须尽量映射到同一地址”

### 第七节：文件头与校验——为什么 archive 不是“能读出来就行”

目标约 1700 字。

- `filemap.hpp` 头注释与 magic `0xF00BABA2`
- header / CRC / shared path table / later validation 的意义
- 这些校验本质上是在检查“未来 mmap 场景是否仍满足 dump 当时的假设”

### 第八节：classlist——为什么 dump 端仍然复用完整类加载管线

目标约 1500 字。

- `ClassListParser` 只做行解析
- 真正加载在 `ClassLoaderExt::load_one_class`
- `try_link_class` 提前 link 以重写字节码、建 cpCache
- 纠偏：classlist 不是直接声明“要写哪些二进制块”，而是驱动一次真实类加载

### 第九节：误解澄清与收网

目标约 1200 字。

至少回答：
1. CDS dump 是否只是把 class 文件缓存到另一个文件
2. CDS 是否在 dump 时跳过类加载与链接
3. `copy_and_compact` 是否等于逐对象序列化
4. archive 是否只是 4/5 个区
5. 只读区和可写区为什么要分开
6. dump 时为什么必须冻结 metaspace

## 5. 失败方案必须写进正文

1. 只缓存 `.class` 原文
2. 把 `InstanceKlass` 等对象逐个序列化到文件
3. dump 时不冻结 metaspace，对象集边长边写

## 6. 证据清单

- `share/memory/metaspaceShared.cpp:1632-1696`：`preload_and_dump`
- `share/memory/metaspaceShared.cpp:1699-1735`：`preload_classes`
- `share/classfile/classListParser.cpp:46-125`：classlist parser
- `share/memory/metaspaceShared.cpp:1333-1475`：`VM_PopulateDumpSharedSpace::doit`
- `share/memory/metaspaceShared.hpp:66-85`：region 枚举
- `share/memory/filemap.hpp:36-42`：archive header 注释与 magic
- `share/memory/metaspaceShared.cpp:280-317`：共享区与临时 class space、`narrow_klass_base`
- `share/memory/metaspaceShared.cpp:1458-1472`：四个 core spaces + heap archive regions 写出

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦 dump 端；load 端的 mmap、header/path 校验细节和字典登记放到 `02-cds-load-shared.md`
- 允许提到字符串区与 open archive heap region，但不展开 Java heap archive 恢复逻辑
- 不把 CDS 讲成“缓存 class 文件”，也不把它讲成“普通对象序列化系统”

## 8. 完成后 review

- 删除代码后，能否复述“CDS dump 产物是可 mmap 的内存镜像，不是类的离线描述文件”
- 是否把 `freeze`、`copy_and_compact`、region 分区、固定基址假设串成一条主线
- 是否明确纠正了 class 缓存、逐对象序列化、旧版 region 模型等误解
- 是否完成删码测试、禁用词、file:line、链接、版本边界检查
