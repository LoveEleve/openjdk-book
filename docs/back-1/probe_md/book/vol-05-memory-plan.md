# 第五卷：内存 — 元空间与对象模型 — 详细规划

> 覆盖：Metaspace（VSL/ChunkManager/BlockFreelist/Arena/ChunkPool）、OOP 对象模型、Klass 体系、压缩指针
> 基于 `book/JVM-Source-Code-Book-Plan.md` §一 第 22-25 章骨架，展开为章节级详细规划

---

## §〇 分析资产扫描结果

### 现有文档资产

| # | 文档 | 行数 | 归属 | 核心内容 |
|---|------|:---:|------|---------|
| 1 | `01-jvm-startup/docs/03-Metaspace.md` | 717 | 启动 Phase | Metaspace 启动初始化全链路: global_initialize 9 步序列 → VSL (8MB) + CCS (1GB) → ChunkManager 三层 free list → lazy commitment 诊断 |
| 2 | `01-jvm-startup/docs/21-Universe-Type-System.md` | 1,212 | 启动 Phase | genesis 创世(TypeArrayKlass×8+ObjectArrayKlass)+compute_offsets(31个核心类偏移)+universe_post_init(10预分配异常+known methods) |
| 3 | `01-jvm-startup/docs/04-SymbolTable.md` | 685 | 启动 Phase | HashtableEntry 24B+双分配器+PERM_REFCOUNT |
| 4 | `01-jvm-startup/docs/05-StringTable.md` | 672 | 启动 Phase | ConcurrentHashTable+OopStorage+GC weak ref |
| 5 | `27-memory-extra/docs/00-VirtualSpace-Layer.md` | 1,457 | 内存 Phase | mmap 保留→VirtualSpace 分页提交→VSN bump-pointer 完整的 4 层架构 |
| 6 | `27-memory-extra/docs/01-Arena-ResourceArea.md` | 1,463 | 内存 Phase | Amalloc() bump-pointer+ChunkPool 四级缓存+ResourceMark 三层水位线 |
| 7 | `27-memory-extra/docs/02-Metaspace-Internals.md` | 1,515 | 内存 Phase | ChunkManager 三级池→SpaceManager→BlockFreelist→BinaryTreeDictionary→OccupancyMap |
| | **合计** | **7,721** | | |

### 覆盖缺口

经核实 7 篇现有文档 vs 第 5 卷 4 章的规划：

| 章节 | 现有覆盖 | 缺口 |
|------|---------|------|
| 第22章 Metaspace 综述 | 启动初始化有覆盖 (03-Metaspace) | 缺 PermGen→Metaspace 历史演进叙事、运行时分配全景 (首次 alloc→触发 GC) |
| 第23章 Metaspace 分配器 | **充分覆盖** (27-memory-extra 3 篇, 4,435行) | ChunkPool 与 Arena 的连接需补充、ResourceMark + Safepoint 交互 |
| 第24章 OOP 对象模型 | 部分覆盖 (21-Type 中的 Klass 创建) | **主要缺口**: oopDesc 逐字节分析(mark word+klass pointer) 无专属文档、Klass 继承体系完整展开 |
| 第25章 压缩指针 | 零星覆盖 (02-G1-Heap, 03-Metaspace) | **严重缺口**: 无专属文档、x86 汇编编码/解码指令缺失、基址/零基址模式选择逻辑未展开 |

### 源文件清单

#### OOP 模型（第24章核心）

| 文件 | 行数 | 角色 |
|------|:---:|------|
| `share/oops/oop.hpp` | 341 | oopDesc 顶层类型 + OopHandle |
| `share/oops/oop.inline.hpp` | 513 | Oop 访问器内联实现 |
| `share/oops/markOop.hpp` | 398 | **Mark Word** 32/64位编码（biased/hash/lock/age/gc） |
| `share/oops/klass.hpp` | 732 | **Klass 基类**：vtable 长度+layout helper+OopMapBlock |
| `share/oops/klassVtable.hpp` | 355 | **虚函数表**声明 |
| `share/oops/klassVtable.cpp` | 1,673 | 虚函数表重写(override)算法 |
| `share/oops/instanceKlass.hpp` | 1,492 | **InstanceKlass 头**：字段布局+itable+注解+方法排序 |
| `share/oops/instanceKlass.cpp` | 4,072 | 实例类完整实现 |
| `share/oops/arrayKlass.hpp` | 150 | ArrayKlass 抽象基类 |
| `share/oops/objArrayKlass.hpp` | 188 | 对象数组 Klass |
| `share/oops/typeArrayKlass.hpp` | 152 | 原始类型数组 Klass |
| `share/oops/constantPool.hpp` | 1,032 | **常量池**内部结构 |
| `share/oops/method.hpp` | 1,189 | Method 对象（字节码+参数+异常表） |
| `share/oops/constMethod.hpp` | 564 | ConstMethod（不可变方法数据） |
| `share/oops/symbol.hpp` | 275 | **Symbol**: UTF-8 字符串池 |
| `share/utilities/accessFlags.hpp` | 290 | JVM 16 个访问标志位 |
| `share/oops/compressedOops.inline.hpp` | 84 | **压缩指针编码/解码实现** |
| `share/memory/universe.hpp` | 559 | Universe::_narrow_oop 配置 |

#### Metaspace（第22-23章核心）

| 文件 | 行数 | 角色 |
|------|:---:|------|
| `share/memory/metaspace.cpp` | 2,045 | 全局入口+ClassLoaderMetaspace |
| `share/memory/metaspace.hpp` | 496 | Metaspace 对外接口 |
| `share/memory/virtualspace.cpp` | 1,580 | ReservedSpace→VirtualSpace→CommittedRegion |
| `share/memory/virtualspace.hpp` | 241 | VirtualSpace 类声明 |
| `share/memory/arena.cpp` | 525 | Arena bump-pointer 分配器 |
| `share/memory/arena.hpp` | 256 | Arena 类声明 |
| `share/memory/resourceArea.cpp` | 89 | ResourceArea 实现 |
| `share/memory/resourceArea.hpp` | 264 | ResourceArea 声明 |
| `share/memory/allocation.hpp` | 577 | C_HEAP_OBJ/ARENA_OBJ/NEW_RESOURCE_ARRAY 宏 |
| `share/memory/metaspace/virtualSpaceList.*` | 644 | VSL 链表管理 |
| `share/memory/metaspace/virtualSpaceNode.*` | 829 | VSN 节点管理 |
| `share/memory/metaspace/chunkManager.*` | 956 | ChunkManager 三级池 |
| `share/memory/metaspace/spaceManager.*` | 774 | Block 级分配器 |
| `share/memory/metaspace/blockFreelist.hpp` | 93 | 空闲块链表 |
| `share/memory/metaspace/metachunk.*` | 348 | Metachunk 生命周期 |
| `share/memory/metaspace/smallBlocks.hpp` | 89 | 小对象块管理 |
| `share/memory/metaspace/occupancyMap.hpp` | 243 | 占位图 |
| `share/memory/metaspace/metaspaceStatistics.hpp` | 188 | 统计收集 |
| `share/memory/binaryTreeDictionary.hpp` | 395 | 二叉树字典（CMS 空闲列表） |

---

## §一 章节级详细规划

### 第 22 章：Metaspace — 从 PermGen 死亡到元空间新生  [目标 ~3,000 行]

> **叙事钩子**: "生产环境 Metaspace OOM: 128MB 上限被 3000 个动态代理类打爆"

#### 22.1 PermGen 为什么必须死 (叙事+历史)
- JDK 6/7 PermGen 的三个致命伤: 固定大小 + ClassLoader 泄漏 + 类卸载与 GC 耦合
- `-XX:MaxPermSize=256m` → OOM → JVM 崩溃的真实案例
- JDK 8 JEP 122: Remove the Permanent Generation 的设计动机
- 反事实: 如果保留 PermGen → JDK 8 Stream/Lambda 大量动态类会让 PermGen 更频繁 OOM

#### 22.2 Metaspace 高层架构全景
- 三层架构图: JVM 全局 (Metaspace::global_initialize) → ClassLoader 级 (ClassLoaderMetaspace) → 物理层 (VirtualSpace)
- 四个关键概念: Reserved(虚拟地址) vs Committed(物理页) vs Used(实际分配) vs Capacity(可用上限)
- `Metaspace::global_initialize()` 9 步序列 (`share/memory/metaspace.cpp:1391-1494`)
- 两个独立 VSL: 数据 VSL (VIRTUALSPACEMULTIPLIER × InitialBootClassLoaderMetaspaceSize = 8MB) + CCS VSL (1GB)
- `Metaspace::allocate()` 入口: `share/memory/metaspace.cpp:962` — ClassLoader → SpaceManager 分派

#### 22.3 VirtualSpaceList — 虚拟空间链表 (基于 27-memory-extra/docs/00)
- `ReservedSpace::initialize()`: `mmap(NULL, size, PROT_NONE, MAP_NORESERVE|MAP_PRIVATE)` — 仅保留不提交
- `VirtualSpace::expand_by()`: `os::commit_memory(base+committed, size)` — 分步提交物理页
- `VirtualSpaceNode` 的 commit/uncommit 粒度: page_size (4KB) → medium_chunk_size (8KB) → commit_alignment
- `VirtualSpaceList::get_new_chunk()` 扩容: current node 用尽 → new VirtualSpaceNode → expand → commit
- 诊断: `/proc/<pid>/smaps` 中 Rss=0 是 lazy commitment 的铁证

#### 22.4 ChunkManager — 三级 Metachunk 管理 (基于 27-memory-extra/docs/02)
- 三级池: Specialized (< 1KB) + Small (< 4KB) + Medium (< 8KB) — 固定大小 free list
- Humongous: ≥ 8KB → 红黑树管理 (BinaryTreeDictionary, `share/memory/binaryTreeDictionary.hpp`)
- `ChunkManager::chunk_freelist_allocate()`: LIFO free list → 命中 → bump-pointer 子分配; 未命中 → VSL expansion
- `ChunkManager::return_chunk()`: 返还到对应池 → 超过池上限 → uncommit → 归还 OS
- 数据 CM (`_chunk_manager_metadata`) vs 类 CM (`_chunk_manager_class`) 的差异

#### 22.5 BlockFreelist + SpaceManager
- SpaceManager: `current_chunk` bump-pointer 缓存 → 用尽 → `ChunkManager::chunk_freelist_allocate()`
- BlockFreelist: 释放的块不立即归还 CM → 延迟批量返还 (`purge()`)
- SmallBlocks: 小对象 (< 256B) 的专用 free list
- OccupancyMap: bit-per-chunk 追踪每个 chunk 的 committed 状态

#### 22.6 MetaspaceGC — 阈值管理与 GC 触发
- `_capacity_until_GC` 的动态计算: `MAX2(MetaspaceSize, committed * (1 + MinMetaspaceFreeRatio/100))`
- `MetaspaceGC::compute_new_size()` → 新 committed 上限 → 触发 Full GC
- `-XX:MetaspaceSize` vs `-XX:MaxMetaspaceSize` 的交互

#### 22.7 CompressedClassSpace — 压缩类指针的独立 VSL
- 为什么 CCS 独立: Klass* 压缩需要连续的 32-bit 可寻址空间
- CCS VSL 的创建: `allocate_metaspace_compressed_klass_ptrs()` (`metaspace.cpp:825`)
- 数据空间 8MB vs 类空间 1GB 的 chunk 大小对比
- 压缩指针数学: `Klass* = base + (offset << shift)`, 32-bit offset → 最大 32GB 类空间
- 保护页: CCS reserve 包含 `CompressedClassSpaceSize + protection_domain` → implicit null check

---

### 第 23 章：Metaspace 分配器链 — ChunkPool → Arena → 快速路径  [目标 ~3,500 行]

> **叙事钩子**: "压测时 Metaspace 分配延迟 p99 飙升到 5ms → strace 发现大量 mmap(MAP_FIXED)"

#### 23.1 分配器全景 — 从 malloc 到 mmap 的六层金字塔
```
Layer 1: Amalloc() — bump-pointer 零锁快速路径
Layer 2: Arena::grow() — chunk 链表追加
Layer 3: ChunkPool::allocate() — 4 级缓存 LIFO free-list
Layer 4: SpaceManager::allocate() — Block 级分配器
Layer 5: ChunkManager::chunk_freelist_allocate() — 三级池
Layer 6: VirtualSpaceList::get_new_chunk() → os::commit_memory() → mmap
```

#### 23.2 Arena 分配器 (基于 27-memory-extra/docs/01)
- `Arena::Amalloc(x)`: bump-pointer → 剩余不足 → `grow(x)` → 分配新 chunk
- `Arena::grow()`: `ChunkPool::allocate()` → `os::malloc()` → 新 chunk 追加到链表头
- 1KB 首次分配: `Chunk::init_size = 1KB`, 后续按公式增长
- `Amalloc()` vs `Amalloc_4()` 对齐语义: 默认 2×sizeof(void*) 对齐, `Amalloc_4()` 强制 4 字节对齐
- Arena::Afree(): 只设置标记, 不释放内存 (Arena 析构时一并释放)

#### 23.3 ChunkPool — 四级缓存 (基于 27-memory-extra/docs/01)
- 四级: tiny (< 1KB) + small (< 4KB) + medium (< 8KB) + large (≥ 8KB)
- `ChunkPool::allocate()`: LIFO free-list → 命中 O(1) → 未命中 `os::malloc()`
- `ChunkPool::free()`: 返还到 free-list 头 → 超过池上限 → `os::free()` 归还 OS
- `chunkpool_init()` 在 `vm_init_globals()` 中的位置 (`init.cpp:92`) — 在 mutex_init 之后, 为后续 Metaspace 分配提供缓存

#### 23.4 ResourceArea — Thread-Local Mark 机制
- `ResourceMark` 嵌套: Mark 保存当前 top → `allocate_bytes()` 分配 → `~ResourceMark()` rollback
- `ResourceArea::allocate_bytes()`: 当前 chunk 不足 → 分配新 chunk → bump-pointer 递增
- Thread-local 快速路径: 无锁, 只有 chunk 分配时才进入 ThreadCritical 临界区
- 三层嵌套 Mermaid 序列图 (已有 docs/01 §六.3)
- Safepoint 场景: `~ResourceMark()` 在 Safepoint 之后自动回滚
- 去优化场景: C2 去优化到解释器时的 ResourceMark 生命周期

#### 23.5 ARENA_OBJ/C_HEAP_OBJ/NEW_RESOURCE_ARRAY 宏
- `share/memory/allocation.hpp:100-300`: 分配器选择宏
- `C_HEAP_OBJ`: 直接 `os::malloc/free`, 用于生命周期跨 ResourceMark 的对象
- `ARENA_OBJ`: 从 Arena 分配, 生命周期 ≤ 当前 ResourceMark
- `NEW_RESOURCE_ARRAY(type, size)`: 数组分配快捷方式
- 选择决策树: 生命周期 → 线程安全 → 对齐要求 → 选哪种宏

#### 23.6 分配性能诊断
- NMT: `jcmd <pid> VM.native_memory summary` → 看 Metaspace + Arena + malloc 三类
- strace: `mmap(MAP_NORESERVE)` vs `mmap(MAP_FIXED|PROT_WRITE)` 的频率
- GDB: `break Arena::grow` → 观察 chunk 分配频率
- 压测场景: 何时从 Layer 1 (Arena bump-pointer) 掉到 Layer 6 (mmap)

---

### 第 24 章：OOP 对象模型 — Java 对象的 C++ 真身  [目标 ~3,500 行]

> **叙事钩子**: "GC 后对象 identity hash code 变了 → 排查发现在 mark word 的 hash 字段被 GC 覆盖"

#### 24.1 oopDesc — 对象头的逐字节解剖
- `oopDesc` 定义: `share/oops/oop.hpp:56` — 两个成员 `_mark` (markOop) + `_metadata` (Klass*)
- **32-bit mark word**: `share/oops/markOop.hpp` — 5 字段编码:
  ```
  [ hash:25 | age:4 | biased_lock:1 | lock:2 ]
  ```
- **64-bit mark word**:
  ```
  [ unused:25 | hash:31 | unused:1 | age:4 | biased_lock:1 | lock:2 ]
  (64-bit 由于 compressed class pointers, hash 扩展到 31 bits)
  ```
- 锁状态编码: `lock=00` (轻量级锁指向栈上 LockRecord), `lock=10` (重量级锁指向 ObjectMonitor)
- GC 状态: `lock=11` (GC mark, 存储 forwarding pointer)
- 偏向锁: `biased_lock=1` → 线程 ID + epoch 存储在 mark word 中
- **klass pointer**: 32-bit (compressed) 或 64-bit (uncompressed), 指向 InstanceKlass/TypeArrayKlass/ObjArrayKlass

#### 24.2 Oop 类型层次
```
oopDesc (56B header + body)
├── instanceOopDesc — 普通对象 (header + instance fields)
├── arrayOopDesc — 数组基类 (header + length)
│   ├── typeArrayOopDesc — 原始类型数组 (bytecode: [B, [I, [J...])
│   └── objArrayOopDesc — 对象数组 (klass*[] 元素)
└── markOopDesc — 独立的 mark word 类型
```
- `oopDesc::klass()`: `_metadata.decode()` (`oop.inline.hpp:85`) — 从压缩指针解码 Klass*
- `oopDesc::mark()`: 直接返回 `_mark` 字段
- Oop 访问器: `oopDesc::obj_field(int offset)` → 通过偏移量读写字段

#### 24.3 Mark Word 状态机
- 5 种状态: Unlocked → Biased → Lightweight Locked → Heavyweight Locked → GC Marked
- **unlocked**: hash + age + 00 (last two bits)
- **biased**: thread ID (54 bits) + epoch (2 bits) + age (4 bits) + 101 (last three bits, on Linux x86)
- **lightweight**: pointer to BasicLock on stack + 00
- **inflated**: pointer to ObjectMonitor + 10
- **GC**: forwarding pointer (to promoted copy) + 11
- `markOopDesc::hash()` / `set_hash()`: hash 存储和检索
- identity hash code 的惰性生成: `ObjectSynchronizer::FastHashCode()`
- 关键约束: 偏向锁状态下无 hash 存储空间 → 已偏向对象请求 hash → 必须撤销偏向锁

#### 24.4 Klass 继承体系 — 7 层继承链
```
MetaspaceObj (元空间基类)
└── Klass (share/oops/klass.hpp:70)
    ├── InstanceKlass (share/oops/instanceKlass.hpp) — Java 类的 C++ 表示
    │   ├── InstanceRefKlass — 引用类型 (Soft/Weak/Phantom/Final)
    │   └── InstanceMirrorKlass — Class 对象
    └── ArrayKlass
        ├── TypeArrayKlass — 原始类型数组 (8 种: T_BOOLEAN→T_DOUBLE)
        └── ObjArrayKlass — 对象数组
```
- `Klass::layout_helper()`: 32-bit 编码: [size | array_tag | element_type | is_oop_array | has_size]
- `InstanceKlass::_fields`: FieldInfo 数组, 每个字段的偏移量+名称+签名
- `InstanceKlass::_constants`: ConstantPool* — 常量池指针
- `InstanceKlass::_methods`: Method* 数组 — 按方法名排序
- Klass 对象存储在 Metaspace (非 Java Heap) — 这就是压缩类指针指向的位置

#### 24.5 klassVtable & klassItable — 虚函数表与接口分派
- `klassVtable`: `share/oops/klassVtable.hpp` + `cpp` (1,673行)
- vtable 初始化: `klassVtable::initialize_vtable()` — 从父类继承 → 本类方法填充/重写
- `klassVtable::put_method_at(Method*, int index)`: 在指定 slot 插入方法
- 重写 (override) 检测: 方法名+签名匹配 → 替换父类条目
- Miranda 方法: 接口方法无对应实现 → 自动生成抽象方法条目
- `klassItable`: 接口方法分派的 2 步查找 (itable → vtable)
- itable 初始化: `klassItable::initialize_itable()` — 遍历接口 → 查找实现方法 → 填充位移

#### 24.6 ConstantPool — 常量池内部结构
- `share/oops/constantPool.hpp`: 1032 行
- 常量池条目: CONSTANT_Utf8/CONSTANT_Class/CONSTANT_Methodref 等 11 种
- CPSlot: 2-slot 条目 (Long/Double) 的特殊处理
- 标签数组: `_tags[]` — 每个常量池条目 1 字节标签
- 解析缓存: `cpCache` — 已解析条目的缓存 (ConstantPoolCache)
- 操作的原子性: `atomic_compare_exchange` 保护并发解析

#### 24.7 Method & ConstMethod — 方法的完整表示
- `Method`: `share/oops/method.hpp` (1,189行)
  - `_constMethod`: 指向 ConstMethod (不可变部分)
  - `_method_data`: MethodData* (计数器+profiling)
  - `_method_counters`: MethodCounters* (调用计数器+回边计数器)
  - `_from_compiled_entry`: 编译代码入口点
  - `_code`: CompiledMethod* (编译产物)
- `ConstMethod`: `share/oops/constMethod.hpp` (564行)
  - 字节码 (`_bytecodes[]`)
  - 行号表 (LineNumberTable)
  - 局部变量表 (LocalVariableTable)
  - 异常表 (ExceptionTable)
  - 校验和 (checksum)
- 方法内联缓存 (IC): Method::_from_interpreted_entry → 缓存最近编译版本

#### 24.8 AccessFlags — JVM 16 位访问标志
- `share/utilities/accessFlags.hpp`: 290 行
- 16 个标志位: `public/private/protected/static/final/synchronized/volatile/transient/native/interface/abstract/strictfp/synthetic/annotation/enum/module`
- `set_field()` / `is_field()`: 位操作接口
- 在 class file parser 中的使用: ClassFileParser 解析 access_flags 后设置

---

### 第 25 章：压缩指针 — 从 32-bit 引用映射 64-bit 地址  [目标 ~3,000 行]

> **叙事钩子**: "32GB 堆用 35GB 堆替代后 OOM — 压缩指针失效导致对象大小膨胀 1.5×"

#### 25.1 为什么需要压缩指针
- 64-bit 引用浪费: 指针 8 字节 vs 数据 4 字节 → 对象膨胀 1.5-2×
- JVM 堆限制: 通常 ≤ 32GB → 可用 32-bit 表示 (2^32 × 8 = 32GB with 3-bit shift)
- 实际收益: 32-bit 引用减少 cache miss + 降低 GC 根扫描时间
- 实验对比: 同应用下 UseCompressedOops ON vs OFF 的堆占用差异

#### 25.2 压缩指针的编码/解码数学
- 编码公式: `narrow_oop = (heap_oop - narrow_oop_base) >> narrow_oop_shift`
- 解码公式: `heap_oop = narrow_oop_base + (narrow_oop << narrow_oop_shift)`
- 三个全局变量: `Universe::_narrow_oop._base`, `Universe::_narrow_oop._shift`, `Universe::_narrow_oop._use_implicit_null_checks`
- `CompressedOops::encode()` / `decode()`: `share/oops/compressedOops.inline.hpp:39-72`
- Shift 选择逻辑: `Universe::narrow_oop_shift()` → 从堆大小推导 (4GB→2, 8GB→3, 16GB→4, 32GB→3)

#### 25.3 基址模式 vs 零基址模式
- **零基址模式** (`narrow_oop_base = 0`): 堆在低 32GB 地址空间 → `mmap(NULL)` + `MAP_32BIT` 请求 OS 分配低地址
  - 优势: 编码/解码简化为位移, 无需加减 base → 更快
  - 限制: 仅限堆 ≤ 4GB (32-bit no shift) 或恰好被 shift 整除的大小
- **基址模式** (`narrow_oop_base ≠ 0`): 堆在 > 32GB 地址空间 → 编码需减 base
  - 使用场景: JDK 8 之前不支持压缩类指针时, OS 不给低地址, 堆 > 32GB
- `Universe::set_narrow_oop_base()`: 在 reserve heap 时根据基址自动选择模式
- 诊断: `-XX:+UnlockDiagnosticVMOptions -XX:+PrintCompressedOopsMode`

#### 25.4 x86 汇编级编码/解码
- **编码 (store)**: 
  ```asm
  lea    rax, [rsi - 0x400000000]     ; subtract narrow_oop_base (假设 base=16GB)
  shr    rax, 3                        ; shift right by narrow_oop_shift
  mov    [rdi + 0x8], eax             ; store 32-bit narrow_oop
  ```
- **解码 (load)**:
  ```asm
  mov    eax, [rdi + 0x8]             ; load 32-bit narrow_oop
  shl    rax, 3                        ; shift left by narrow_oop_shift
  add    rax, 0x400000000             ; add narrow_oop_base
  ```
- 零基址优化: 去掉 `sub`/`add` → 仅剩 `shr/shl` → 1 周期节省
- LEA 指令技巧: `lea rax, [base + narrow*8]` → 单指令完成 shift+add
- C2 中的实现: `Compile::output()` → `Matcher::match_rule()` 生成编码/解码指令
- `macroAssembler_x86.cpp` 中的 `decode_heap_oop()` 和 `encode_heap_oop()` 实现

#### 25.5 CompressedClassPointers — 类指针压缩
- 与 CompressedOops 的差异: 类指针指向 Metaspace (非 Java Heap)
- `Klass* = narrow_klass_base + (narrow_klass << narrow_klass_shift)`
- CCS: 1GB 连续地址空间 → shift=0 → `Klass* = base + offset` (直接加法)
- CCS 分配: `allocate_metaspace_compressed_klass_ptrs()` → 在 heap reserve 之后紧邻分配
- 类指针压缩失败: `-XX:-UseCompressedClassPointers` → Klass* 回到 64-bit → 对象头从 12 字节膨胀到 16 字节
- `Universe::set_narrow_klass_base_and_shift()`: 基址由 CCS VSL 的起始地址决定

#### 25.6 压缩指针编码/解码的完整生命周期
- **写入路径**: `oop_store()` → `oopDesc::obj_field_put()` → `RawAccess<>::oop_store()` → `CompressedOops::encode()` → 32-bit store
- **读取路径**: `oop_load()` → `oopDesc::obj_field()` → `RawAccess<>::oop_load()` → `CompressedOops::decode()` → 64-bit pointer
- **GC 路径**: GC 扫描时遍历对象引用 → `decode()` → 计算 forwarding → `encode()` → 写入新位置
- **JIT 编译**: C2 在编译时将 encode/decode 转换为高效汇编指令
- **Shenandoah/ZGC**: 使用自己的 barrier 包装 encode/decode → 支持并发重映射

#### 25.7 压缩指针的陷阱与诊断
- 陷阱 1: 堆 > 32GB → 压缩指针自动失效 → 对象膨胀 1.5×
- 陷阱 2: 零基址失败 (OS 不给低地址) → 退化为基址模式 → 性能下降 3-5%
- 陷阱 3: CCS 与堆保留竞争 → CCS 分配失败 → CompressedClassPointers 关闭
- 诊断:
  ```bash
  java -XX:+PrintCompressedOopsMode -version  # 打印模式选择
  java -XX:+PrintFlagsFinal | grep Compressed  # 查看所有压缩指针 flag
  jhsdb jmap --heap --pid <pid>               # 查看 heap 实际配置
  ```
- GDB: `print Universe::_narrow_oop._base` + `print Universe::_narrow_oop._shift`

---

## §二 资产映射 (Asset → Chapter → 直接复用)

| 现有文档 | 行数 | → 第 22 章 | → 第 23 章 | → 第 24 章 | → 第 25 章 |
|---------|:---:|:---:|:---:|:---:|:---:|
| 01-jvm-startup/03-Metaspace | 717 | **§1-2**: 启动初始化 9 步 + CCS VSL | — | — | §2: CCS 分配 |
| 27-memory-extra/00-VirtualSpace | 1,457 | **§3**: VSL 4 层架构 + lazy commit | — | — | — |
| 27-memory-extra/01-Arena | 1,463 | — | **§2-4**: Arena+ChunkPool+ResourceMark | — | — |
| 27-memory-extra/02-Metaspace-Internals | 1,515 | **§4-6**: ChunkManager+SpaceManager+GC | — | — | — |
| 01-jvm-startup/21-Universe-Type | 1,212 | — | — | **§4**: Klass 创建流程 + offsets | — |
| **需新写的全新内容** | — | §1: PermGen 历史, §7: CCS 独立 VSL 完整展开 | §1: 六层金字塔全景, §5: 宏选择决策树 | **§1**: oopDesc 逐字节, **§3**: Mark Word 状态机, **§5**: vtable/itable, **§6-8**: ConstantPool/Method/AccessFlags | **§1-7**: 全章基本为新写 |

---

## §三 写作优先级和分步策略

### 第一批 (核心基础设施 — 第 24 章 OOP 对象模型)
**原因**: 这是当前覆盖缺口最大、且后续所有章节 (GC/编译/运行时) 都依赖的基础知识

### 第二批 (压缩指针 — 第 25 章)
**原因**: 紧接第 24 章, 完成对"Java 对象在内存中的表示"的完整叙述

### 第三批 (Metaspace 综述 — 第 22 章)
**原因**: 依赖 27-memory-extra 的 3 篇作为原料, 整合为书籍章节

### 第四批 (Metaspace 分配器 — 第 23 章)
**原因**: 依赖 27-memory-extra 的 3 篇作为原料, 整合为书籍章节

### 各批工作流

```
第 24/25 章 (全新内容):
  ① 新 prompt 写作(会话A) → ② 新 prompt 审查 → ③ 新会话文档生成 → ④ Review

第 22/23 章 (整合现有):
  ① 书稿写作(直接基于 27-memory-extra 内容) → ② 集成叙事钩子 → ③ 补充缺口 → ④ Review
```

---

## §四 关键设计决策

### 第 22/23 章复用策略
合并 27-memory-extra 的 3 篇文档到书籍中:
- `00-VirtualSpace-Layer` → 第 22 章 §3-4: VSL + VSN + commit粒度
- `01-Arena-ResourceArea` → 第 23 章 §2-4: Arena + ChunkPool + ResourceMark
- `02-Metaspace-Internals` → 第 22 章 §4-6: ChunkManager + SpaceManager + GC
- 复用但不直接拷贝: 去掉 prompt 脚手架 (GDB break 列表/Prohibited/Required/对照表), 保留技术内容, 改为书籍语气

### 第 24 章全新内容
- oopDesc 逐字节分析必须基于 `oop.hpp`, `markOop.hpp`, `compressedOops.inline.hpp`
- Mark Word 状态机需要源码级状态转换图
- Klass 继承体系需要完整 C++ 类图
- 引用自 21-Universe-Type 中 Klass 创建流程的内容作为 §4 部分

### 第 25 章全新内容
- x86 汇编必须基于实际 C2 生成的代码, 用 `-XX:+PrintAssembly` 或直接读 MacroAssembler
- 编码/解码数学必须包含 `Universe::narrow_oop_base/shift` 的设置链路 (`universe.cpp`)
- 包含零基址失败的完整修复步骤 (shuffle heap/tweak kernel/use JVM options)

### 书籍化 (Book-ify) 原则
1. **去掉 AI 脚手架**: 去除 GDB 断点列表、Prohibited/Required/对照表等 prompt 机制残留
2. **叙事优先**: 每个 §1 以生产故障故事开场
3. **原理驱动**: 源码引用 (file:line) 作为证据, 原理是正文
4. **诊断闭环**: 每个故障场景必须有完整的排查→定位→修复链路
5. **交叉引用**: 与第 2 卷 (GC: 对象分配需知对象布局)、第 4 卷 (编译: C2 需理解压缩指针 encode/decode)、第 6 卷 (运行时: 锁需知 mark word) 建立链接

---

## §五 行数估算

| 章节 | 类型 | 估算行数 |
|:---:|------|:---:|
| 第 22 章 | 整合现有 (60% 复用) | ~3,000 |
| 第 23 章 | 整合现有 (50% 复用) | ~3,500 |
| 第 24 章 | **全新创作** | ~3,500 |
| 第 25 章 | **全新创作** | ~3,000 |
| **合计** | | **~13,000** |

---

## §六 叙事钩子设计

### 第 22 章 — "Metaspace OOM: 3000 个动态代理类打爆 128MB 上限"
```
凌晨 3 点生产告警: java.lang.OutOfMemoryError: Metaspace
→ jcmd VM.native_memory → committed 接近 128MB MaxMetaspaceSize
→ 原因排查: MyBatis Mapper 动态代理 + Spring AOP 为每个 DAO 创建 ~3 代理类
→ 深入到 VSL → ChunkManager → SpaceManager 的分配链路
→ 修复: 增加 MaxMetaspaceSize → 但根本问题是类加载器泄漏
→ 这引出了本章的核心问题: Metaspace 到底是什么? 为什么有上限? 类在 Metaspace 中如何存储?
```

### 第 23 章 — "压测 Metaspace 分配延迟 p99 飙升"
```
性能压测: Metaspace allocation 的 p99 延迟从 0.1ms 飙升到 5ms
→ strace 显示大量 mmap(MAP_FIXED) 系统调用
→ 分析: Arena bump-pointer 快速路径用完 → 新 chunk 分配 → ChunkPool 缓存不足
→ 追踪: ChunkPool → os::malloc → 系统调用链
→ 排查: ChunkPoolSize 过小导致频繁溢出到 mmap
→ 这引出了本章的核心问题: JVM 如何在保证速度的同时管理整个分配器链?
```

### 第 24 章 — "GC 后对象 identity hash code 变了"
```
Bug 报告: HashMap 中 key 在 GC 后找不到 → 怀疑 hash code 变化
→ GDB 断点在 oopDesc::mark() → 观察到 mark word 在 GC 前/后变化
→ 分析: mark word 的 hash 字段 (31 bits) 被 forwarding pointer 覆盖
→ 真相: 偏向锁状态下的对象被请求 hash → 偏向锁撤销 → mark word 重写
→ 这引出了本章的核心问题: 12/16 字节的对象头里存储着什么? 为什么 GC/锁/hash 会冲突?
```

### 第 25 章 — "35GB 堆替换 32GB 堆后内存消耗反而翻倍"
```
运维同学扩大堆: 从 -Xmx32g 改为 -Xmx35g
→ 预期: 堆多 3GB → 实际: 吃满 64GB 物理内存 → OOM Killer
→ 根因: >32GB → CompressedOops 自动失效 → 对象引用从 4 字节膨胀到 8 字节
→ 每个对象膨胀 1.5-2× → 35GB 堆实际需要 ~52GB 内存
→ 代码追踪: Universe::narrow_oop_base → CompressedOops::encode/decode
→ 这引出了本章的核心问题: 压缩指针如何用 32 位表示 64 位地址? 失效的边界在哪里?
```

---

## §七 检查清单 (跨章节)

- [ ] 第 22 章: PermGen 死亡原因 + Metaspace 高层架构 + VSL/VSN 完整分配层次
- [ ] 第 23 章: Arena→ChunkPool→ResourceMark 六层金字塔 (含所有中间层)
- [ ] 第 24 章: oopDesc 逐字节 (mark word 32/64-bit 双编码 + klass pointer), Klass 7 层继承, vtable/itable 重写算法, ConstantPool 结构, Method/ConstMethod 配对
- [ ] 第 25 章: 编码/解码数学 + 基址/零基址模式选择 + x86 汇编实现 + CCS 独立 VSL + 陷阱诊断
- [ ] 所有章节: 生产场景故障故事 (§1) + 诊断闭环 (strace/jcmd/GDB//proc)
- [ ] 交叉引用: 第 24-25 章 ↔ 第 2 卷 GC (对象分配) / 第 4 卷编译 (C2 压缩指针优化) / 第 6 卷运行时 (mark word 锁)
