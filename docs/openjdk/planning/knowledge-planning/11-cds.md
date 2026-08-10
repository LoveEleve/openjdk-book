# 域 11: CDS — 知识规划

> 源码路径: memory/filemap.* + heapShared.* + metaspaceShared.* + classfile/classListParser.* + sharedPathsMiscInfo.* + systemDictionaryShared.* + compactHashtable.* + prims/cdsoffsets.* | 源码量: ~17 文件 / ~9,000 行 | 中型域
> 拆 2 篇

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| memory/filemap.hpp.cpp | **FileMap — CDS archive 文件管理**: .jsa 文件的 header/magic/version/CRC, region mapping, shared space 的 mmap, validation | High |
| memory/metaspaceShared.hpp.cpp | **MetaspaceShared — 共享 Metaspace**: dump time (序列化 Klass), runtime (map shared spaces), link_and_serialize, relocate_pointers | High |
| classfile/classListParser.hpp.cpp | **ClassListParser — 类列表解析**: classlist 文件格式, 预加载类名列表, 启动时加载顺序 | High |
| classfile/systemDictionaryShared.hpp.cpp | **SystemDictionaryShared — 共享类字典**: shared class 的查找/验证, 共享类的 SystemDictionary 入口 | High |
| classfile/sharedPathsMiscInfo.hpp.cpp | **SharedPathsMiscInfo — 共享路径检查**: classpath 一致性验证, CRC 检查, agent path 对比 | Medium |
| memory/heapShared.hpp.cpp | **HeapShared — 共享 Heap 对象**: shared string/array/interned objects, shared heap 的 map/access | Medium |
| classfile/compactHashtable.hpp.cpp | **CompactHashtable — 紧凑哈希表**: shared archive 中的 Symbol/String hashtable, 序列化/反序列化, mmap 后直接查找 | High |
| prims/cdsoffsets.hpp.cpp | **CDSOffsets — CDS 偏移表**: FileMapHeader 的内存结构偏移, 跨版本兼容, SA 访问 | Low |

*8 个知识点*

## 02 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)
| KP | 为什么🔴 |
|----|---------|
| FileMap — archive + mmap | .jsa 文件格式——magic/version/CRC/region table→mmap 到 Metaspace 预留地址。mmap 后直接当内存读——Klass/Method/Symbol 已就绪——跳过 ClassFileParser |
| MetaspaceShared — dump/load | dump 时序列化 Klass/Method→relocate pointers (修正为 archive 偏移)→write。load 时 mmap→map shared spaces→SystemDictionaryShared::find 查共享类 |
| CompactHashtable — mmap-ready hashtable | SymbolTable/StringTable 的共享版本——序列化为 mmap 可读格式——offset 基于 archive base→mmap 后直接 O(1) 查找 |

### 🟡 Working — 有设计但非核心 (3 KP)
| KP | 说明 |
|----|------|
| ClassListParser — 启动类列表 | classlist 的解析和预加载排序 |
| SystemDictionaryShared — 共享类字典 | shared class 的查找和验证 |
| SharedPathsMiscInfo — 路径验证 | classpath CRC/agent path 一致性检查 |

### 🟢 Surface — 了解即可 (2 KP)
| KP | 说明 |
|----|------|
| HeapShared — 共享字符串 | String interning 的 CDS 版本 |
| CDSOffsets — SA 访问 | Debug tool offsets |

## 03 聚类 — 教学顺序与文章拆分

### 教学顺序

```
1. CDS 全景 — 什么是 CDS, dump vs load, archive 格式
2. Dump 端 — MetaspaceShared::preload_and_dump, ClassList, 序列化
3. Load 端 — FileMap::mmap, MetaspaceShared::map_shared_spaces, CompactHashtable
```

### 文章拆分建议

2 篇:

- **01-cds-overview-dump.md** — CDS 全景 + Dump 端 (序列化 Klass→archive)
- **02-cds-load-shared.md** — Load 端 (mmap archive→shared spaces→CompactHashtable)
