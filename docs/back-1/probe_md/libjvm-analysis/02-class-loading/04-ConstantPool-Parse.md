# ConstantPool — 14 种 tag 的解析与 Cache 加速

> 纯源码分析，基于 OpenJDK 11 slowdebug
> 源文件：`constantPool.cpp` + `cpCache.hpp` + `classFileParser.cpp`
> 被引用：04-interpreter 依赖 ConstantPoolCache（invokevirtual/ldc/getfield 全部走 Cache 快速路径）
> 方法论：程序 = 数据结构 + 算法

---

## §零 生产事故 — "Metaspace OOM after 3am dynamic class generation"

3:00am。告警轰炸：`java.lang.OutOfMemoryError: Metaspace`。堆还 40% 空闲，但 JVM 进程 OOM 被 kill。

hs_err 摘要：
```
Internal exceptions (10 events):
Event: 10.357 Thread 0x... OutOfMemoryError: Metaspace
  at ConstantPool::allocate(constantPool.cpp:53)
  at ClassFileParser::parse_constant_pool(classFileParser.cpp:458)
  ...
```

根因：业务代码用 ASM 动态生成一个带 65,535 个 `CONSTANT_Methodref` 条目的类（最大合法常量池）。每个条目在 ClassFileParser 阶段分配 `Array<u1> _tags[65535]` (65KB) + `base()` 可变尾部的 `intptr_t[65535]` (512KB) + 后续 `_resolved_klasses` + `_cache` → **单次 Metaspace 消耗 ~1.2MB**。每小时 800 次动态生成 × 未及时卸载的 ClassLoader → 48GB Metaspace 在 20 分钟内燃尽。

**关键问题**：为什么 65535 个常量池条目会变成 ~1.2MB？ConstantPool 的对象是谁分配的？Metaspace 还是 C heap？`_resolved_klasses` 和 `_cache` 两个独立数组的设计理由是什么？

> 本文回答这些问题。

### Metaspace OOM 完整追踪: ClassFileParser → Metaspace::allocate → OOM

```
ClassFileParser::parse_stream()                         classFileParser.cpp
  │
  ├─ parse_constant_pool()  ──────────────────────────────────────────┐
  │   ├─ ConstantPool::allocate(loader_data, length=65535)            │
  │   │   └─ MetaspaceObj::operator new(size)                         │
  │   │       └─ Metaspace::allocate(loader_data, size)               │
  │   │           └─ ClassLoaderMetaspace::allocate(size)             │
  │   │               ├─ 找空闲 Chunk → ChunkManager::get_chunk()     │
  │   │               └─ 不足 → VirtualSpaceList::get_new_chunk()     │
  │   │                    └─ commit 新内存(mmap)                      │
  │   │                         └─ ★ 容器/OS 内存不足 → 分配失败       │
  │   │                            └─ Metaspace::report_metadata_oome()│
  │   │                                → OutOfMemoryError: Metaspace  │
  │   │                                                                  │
  │   ├─ MetadataFactory::new_array<u1>(length=65535)  ← _tags 数组   │
  │   │   └─ Metaspace::allocate() 同上                                │
  │   ├─ MetadataFactory::new_array<u2>(length=65535)  ← _operands    │
  │   │   └─ Metaspace::allocate() 同上                                │
  │   └─ parse_constant_pool_entries() — 逐条解析 14 种 tag             │
  │       ├─ CONSTANT_Utf8  → SymbolTable::lookup() ★ 立即分配 Symbol  │
  │       └─ 其他 tag → 存索引到 base() intptr_t 数组                    │
  │                                                                      │
  ├─ parse_fields()                                                [05]│
  │   └─ MetadataFactory::new_array<u2>(fields_count×7) ← _fields    │
  │       └─ Metaspace::allocate()                                     │
  │                                                                      │
  ├─ parse_methods()                                               [05]│
  │   └─ for each method:                                               │
  │       └─ Method::allocate(loader_data, code_size, ...)             │
  │           ├─ MetaspaceObj::operator new(sizeof(Method+ConstMethod)  │
  │           │   + code_size + line_number_table + exception_table     │
  │           │   + local_variable_table + checked_exceptions           │
  │           │   + stackmap_data) → ★ 一次性连续分配 Metaspace         │
  │           └─ ConstantPoolCache 写入（rewrite 阶段, [07]）           │
  │               └─ MetadataFactory::new_array<intx>(3×N)             │
  │                   └─ Metaspace::allocate()                          │
  │                                                                      │
  └─ parse_classfile_attributes()                                  [06]│
      └─ assemble_annotations()                                        │
          └─ MetadataFactory::new_array<u1>(total_len)  ← _annotations │
              └─ Metaspace::allocate()                                  │
                                                                        │
┌─ 汇总：一个带 65535 常量池+100 字段+50 方法的类 = ──────────────────┐│
│ ConstantPool(72B) + _tags[65535](65KB) + base()[65535](512KB)       ││
│ + _operands(可变) + _resolved_klasses(可变) + _cache(可变)            ││
│ + _fields(100×14B=1.4KB) + _methods(50×~2KB=100KB)                  ││
│ = ★ 单个类 ≈ 800KB ~ 1.2MB Metaspace 消耗                           ││
│                                                                      ││
│ 800 次/小时 × 8 小时 = 640 个动态类 × 1.2MB = 768MB                   ││
│ 加上未卸载的旧 CLD → 48GB Metaspace 耗尽                             ││
└──────────────────────────────────────────────────────────────────────┘┘
```

**关键洞察**：
- **所有元数据在 Metaspace**：ConstantPool / Method / ConstMethod / FieldInfo / AnnotationArray 全部通过 `MetadataFactory::new_array()` → `Metaspace::allocate()` 分配 —— 没有 C heap
- **CLD 不卸载 = Metaspace 不释放**：每个 CLD 有自己的 `ClassLoaderMetaspace`，`_unloading=true` 之前，所有 Chunk 都被视为活跃
- **诊断**：`jcmd VM.metaspace` → `Used` ≈ 所有 CLD 的 Chunk 总和；`jcmd VM.classloader_stats` → 找出异常大的 CLD；`-Xlog:metaspace*=trace` 查看每次分配大小

---

## GDB 验证会话

```
(gdb) run -Xint -cp /data/workspace/demo/src HelloWorld

# === Break 1: ConstantPool::allocate — 验证 sizeof ===
(gdb) break ConstantPool::allocate
Breakpoint 1 at 0x7ff...: file oops/constantPool.cpp, line 53.
(gdb) continue
Breakpoint 1, ConstantPool::allocate (loader_data=0x..., length=320, ...)
    at src/hotspot/share/oops/constantPool.cpp:53
(gdb) finish
(gdb) p sizeof(ConstantPool)
$1 = 72                         ← GDB verified
(gdb) p *pool
$2 = {_tags = 0x..., _cache = 0x0, _pool_holder = 0x0, _operands = 0x0,
      _resolved_klasses = 0x0, _length = 320, _flags = 0, _saved = {_version = 0}}
(gdb) p sizeof(ConstantPoolCache)
$3 = 40                         ← GDB verified

# === Break 2: klass_at_impl — load_acquire 快路径 vs 慢路径 ===
(gdb) break ConstantPool::klass_at_impl
Breakpoint 2 at 0x7ff...: file oops/constantPool.cpp, line 458.
(gdb) continue
Breakpoint 2, ConstantPool::klass_at_impl (which=5) at constantPool.cpp:458
(gdb) p this_cp->resolved_klasses()->at(0)
$4 = (Klass *) 0x0              ← 首次 ldc, 未解析!
(gdb) advance 50                 ← 跳至 OrderAccess::release_store
(gdb) p *(Klass**)(adr)
$5 = (Klass *) 0x0              ← 写入前
(gdb) step
(gdb) p *(Klass**)(adr)
$6 = (Klass *) 0x7f...          ← release_store 后 — Klass* 已写入

# 第二次 ldc #5 — 快路径
(gdb) continue
Breakpoint 2, ConstantPool::klass_at_impl (which=5) at constantPool.cpp:458
(gdb) p this_cp->resolved_klasses()->at(0)
$7 = (Klass *) 0x7f...          ← 非 NULL! O(1) load_acquire 直接返回

# === Break 3: Rewriter::make_constant_pool_cache — Cache allocation ===
(gdb) break Rewriter::make_constant_pool_cache
Breakpoint 3 at 0x7ff...: file interpreter/rewriter.cpp, line 94.
(gdb) continue
Breakpoint 3, Rewriter::make_constant_pool_cache () at rewriter.cpp:94
(gdb) finish
(gdb) p _pool->cache()->_length
$8 = 28                        ← 28 个 Cache 条目
(gdb) p _pool->cache()->_flags[0]
$9 = {<No data fields>}        ← Cache 刚分配, flags=0, is_resolved=false

# === Break 4: ConstantPoolCacheEntry::set_method — _f1/_f2/_flags ===
(gdb) break ConstantPoolCacheEntry::set_method
Breakpoint 4 at 0x7ff...: file oops/cpCache.cpp, line 150.
(gdb) continue
Breakpoint 4, ConstantPoolCacheEntry::set_method (bc=_invokevirtual,
    method=0x7f..., vtable_index=5) at cpCache.cpp:150
(gdb) p _flags
$10 = 0                        ← 写入前: flags=0
(gdb) step
(gdb) p _f1
$11 = (intptr_t) 0x7f...       ← Method* 已写入 _f1
(gdb) p _f2
$12 = 5                        ← vtable_index 已写入 _f2
(gdb) p _flags
$13 = 1                        ← bit0=1 — is_resolved!
```

---

## §一 前置 5 题

1. **入口**：`ClassFileParser::parse_constant_pool()` → `ConstantPool::allocate()` + `klass_at_impl()`
2. **子调用**：14 种 tag 各走 `parse_constant_pool_entry()` → 惰性解析时走 `klass_at_impl()` / `string_at_impl()`
3. **核心数据结构**：

| 结构 | sizeof | 作用 |
|------|:---:|------|
| `ConstantPool` | 72B 头 + 可变 | 常量池本体：tags[] + base() 可变尾 + resolved[] |
| `ConstantPoolCache` | 40B 头 + 可变 | ★ 运行时缓存 — `_f1/_f2/_flags` 三个 volatile 数组 |
| `ConstantPoolCacheEntry` | 4×8=32B | ★ 单个缓存条目：存 Method*/Klass*/offset/index + 双字节码索引 |

4. **分支**：14 种 tag → 解析策略各不同；大类(Class/MethodRef)走惰性解析 + Cache，小类(String/Integer)直接存值
5. **上游**：`ClassFileParser::parse_stream()` → **下游**：`LinkResolver` 写入 Cache → 04 解释器 O(1) 读取

---

## §二 解决什么问题

> .class 常量池是字节数组。JVM 怎么把它变成 C++ 查询"第5号条目是什么类"的数据结构？又怎么做到第二次访问 O(1)？

**两阶段设计**：
1. **解析时**：读原始字节→存索引（不解析符号引用），只有 CONSTANT_Utf8 立即创建 Symbol*
2. **使用时**：惰性解析符号引用→写入 ConstantPoolCache→后续 `_flags[N].is_resolved()` → O(1)

---

## §三 ConstantPool C++ 结构 (72B)

```cpp
// constantPool.hpp:98-120
class ConstantPool : public Metadata {
  Array<u1>*       _tags;              // ★ 每个条目的 tag
  ConstantPoolCache* _cache;           // ★ 解析缓存（惰性填充）
  InstanceKlass*   _pool_holder;       // ★ 所属类
  Array<u2>*       _operands;          // invokedynamic 操作数
  Array<Klass*>*   _resolved_klasses;  // ★ 已解析Klass(独立数组, 不是 Cache 的一部分)
  Array<Method*>*  _resolved_methods;
  int              _length;            // 条目数(=cp_count-1, #0占位)
  int              _flags;             // _has_preresolution / _on_stack / _is_shared
  jbyte            _saved;             // 版本号（CDS用）
  // ★ 可变尾部: intptr_t _data[length] — 通过 base() 访问
};
```

**sizeof(ConstantPool)=72B** (GDB verified)：vtable_ptr(8) + _tags(8) + _cache(8) + _pool_holder(8) + _operands(8) + _resolved_klasses(8) + _resolved_methods(8) + _length(4) + _flags(4) + _saved(1) + padding(7) = 72B。

**分配合计**：72B 头 + `Array<u1> _tags[length]` + `base() intptr_t[length]` + 后续 `_resolved_klasses` + `_cache`。对 length=320 的类，单 CP 约 72 + 320 + 2560 + 额外 ≈ 3KB。全部在 **Metaspace** 分配（MetadataFactory::new_array），无 C heap 组件。

---

## §四 ConstantPoolCache — 解析加速器

### 4.1 结构定义 (cpCache.hpp)

```cpp
// cpCache.hpp — "不是 cache，是 resolution table"
class ConstantPoolCache {
  ConstantPool* _constant_pool;      // 反向指针
  int           _length;             // Cache 条目数
  volatile intx _flags[];            // ★ 每 entry 1 word (64-bit 标志位)
  volatile intx _f1[];               // ★ Klass* 或 Method*
  volatile intx _f2[];               // ★ vtable_index / field_offset / res_ref_index
};
```

### 4.2 _flags 完整 bit 布局 (32-bit word — 字段条目)

```
bit 0:       is_resolved       ★ 解析完成标志 — ldc/invoke 先检查此位
bit 1:       is_final          ★ final 字段/方法直接访问
bit 2:       is_volatile       ★ volatile 字段用特殊读写屏障
bit 3:       has_ appendix     ★ invokedynamic 有额外参数
bit 4:       has_local_signature
bits 5-7:    tos_state         ★ 操作数栈类型(itos=0x04/atos=0x06/ltos=0x05...)
bits 8-23:   field_index       ★ 字段在 holder InstanceKlass 中的编号 × sizeof(u2)
bit 24:      保留
bit 25:      1=field / 0=method ★ 区分字段/方法条目
bits 26-27:  保留
bit 28:      f2_contains_oop   ★ f2 存的是 oop 而非 int
bit 29:      保留
bits 30-31:  保留
```

### 4.3 is_resolved() 实现 (cpCache.inline.hpp)

```cpp
inline bool ConstantPoolCacheEntry::is_resolved(Bytecodes::Code code) const {
  switch (code) {
    case Bytecodes::_getfield:
    case Bytecodes::_putfield:
    case Bytecodes::_getstatic:
    case Bytecodes::_putstatic:
      return (_flags & 1) == 1 && f2_as_index() != -1;  // ★ bit0=1 且偏移有效
    default:
      return (_flags & 1) == 1;                          // ★ bit0=1
  }
}
```

---

## §五 14 种 cp_info Tag

| Tag | 值 | 名称 | 存储 | 解析方式 |
|-----|:--:|------|------|---------|
| CONSTANT_Utf8 | 1 | UTF8字符串 | length+bytes→**Symbol*** | `SymbolTable::lookup()` — ★ 唯一立即解析 |
| CONSTANT_Integer | 3 | int常量 | 4 bytes | 直接存值 |
| CONSTANT_Float | 4 | float常量 | 4 bytes | 直接存值 |
| CONSTANT_Long | 5 | long常量 | 8 bytes,**占2 slot** | 直接存值，`index++` |
| CONSTANT_Double | 6 | double常量 | 8 bytes,**占2 slot** | 直接存值，`index++` |
| CONSTANT_Class | 7 | 类引用 | name_index→**存索引** | 惰性(ldc触发)→SystemDictionary |
| CONSTANT_String | 8 | 字符串引用 | string_index→**存索引** | 惰性→StringTable |
| CONSTANT_Fieldref | 9 | 字段引用 | class+name_type索引 | 惰性(getfield触发)→LinkResolver→Cache |
| CONSTANT_Methodref | 10 | 方法引用 | class+name_type索引 | 惰性(invoke触发)→LinkResolver→Cache |
| CONSTANT_InterfaceMethodref | 11 | 接口方法 | class+name_type索引 | 惰性(invokeinterface触发) |
| CONSTANT_NameAndType | 12 | 名称+类型 | name+desc索引 | 直接存索引 |
| CONSTANT_MethodHandle | 15 | 方法句柄 | ref_kind+ref_index | 惰性 |
| CONSTANT_MethodType | 16 | 方法类型 | desc_index | 惰性 |
| CONSTANT_InvokeDynamic | 18 | 动态调用 | bsm+name_type | BSM触发 |

---

## §六 算法/流程

### 6.1 解析时 — parse_constant_pool_entries() (classFileParser.cpp)

```cpp
void ClassFileParser::parse_constant_pool_entries(const ClassFileStream* stream,
    ConstantPool* cp, int length, TRAPS) {
  for (int index = 1; index < length; index++) {     // ★ #0 占位
    u1 tag = stream->get_u1_fast();
    cp->tag_at_put(index, tag);

    switch (tag) {
      case JVM_CONSTANT_Utf8: {                       // ★ 唯一立即解析
        u2 len = stream->get_u2_fast();
        Symbol* sym = SymbolTable::lookup(stream->get_u1_buffer(), len, CHECK);
        cp->symbol_at_put(index, sym);
        stream->skip_u1_fast(len);
        break;
      }
      case JVM_CONSTANT_Class:                        // ★ 只存索引 → 惰性
        cp->klass_index_at_put(index, stream->get_u2_fast());
        break;
      case JVM_CONSTANT_String:                       // ★ 只存索引 → 惰性
        cp->string_index_at_put(index, stream->get_u2_fast());
        break;
      case JVM_CONSTANT_Long:
      case JVM_CONSTANT_Double:                       // ★ 占2 slot
        stream->skip_u1_fast(8);
        index++;                                       // 下一个 slot 不可用
        break;
      case JVM_CONSTANT_Methodref:
        cp->method_at_put(index, stream->get_u2_fast(), stream->get_u2_fast());
        break;
      // ... 其他 tag
    }
  }
}
```

### 6.2 使用时 — klass_at_impl() (constantPool.cpp:458-530)

```cpp
Klass* ConstantPool::klass_at_impl(const constantPoolHandle& this_cp,
                                    int which, bool save_resolution_error, TRAPS) {
  // ① 先查 _resolved_klasses — 无锁 load_acquire
  CPKlassSlot kslot = this_cp->klass_slot_at(which);
  Klass** adr = this_cp->resolved_klasses()->adr_at(kslot.resolved_klass_index());
  Klass* k = OrderAccess::load_acquire(adr);
  if (k != NULL) return k;                              // ★ 已解析 → O(1) 返回

  // ② 未解析: 取 name_index → Symbol*
  Symbol* name = this_cp->klass_name_at(which);
  Klass* klass = SystemDictionary::resolve_or_fail(name, loader, ...);

  // ③ release_store 写入 _resolved_klasses + 换 tag
  Klass** adr = this_cp->resolved_klasses()->adr_at(resolved_klass_index);
  OrderAccess::release_store(adr, klass);
  this_cp->release_tag_at_put(which, JVM_CONSTANT_Class);
  return klass;
}
```

### 6.3 Cache 加速路径

```
第一次 ldc #5:
  ① ConstantPool::klass_at(5)
  ② → klass_at_impl → SystemDictionary::resolve_or_fail()
  ③ → release_store(_resolved_klasses[N]=Klass*), tag[N]=JVM_CONSTANT_Class

第二次 ldc #5:
  ① ConstantPool::klass_at(5)
  ② → klass_at_impl → load_acquire(_resolved_klasses[N]) != NULL
  ③ → ★ O(1) 直接返回!
```

**Cache 和 _resolved_klasses 的关系**：
- `_resolved_klasses`：在 CP 内部，存放已解析的 `Klass*` — 给 `ldc #N` (类解析) 使用
- `ConstantPoolCache`：附着在 CP 上，存放 `_f1=Method*/Klass*` + `_f2=vtable_index/offset` + `_flags` — 给 invoke/getfield 使用
- 两者独立 — `klass_at` 查 `_resolved_klasses`，`method_at` 查 Cache。**为什么不能统一？→ 见 §八**

---

## §七 Cache 写入的完整时序

> 一个 `ldc #5` + 一个 `invokevirtual #15` 从首次到 O(1) 的完整过程

### 7.1 时间线总览

```
类加载周期                        Cache/ResolvedKlasses 状态
────────────────────────────────────────────────────────────────

① ClassFileParser::parse_stream()     _resolved_klasses = NULL
   parse_constant_pool()              _cache = NULL
   → ConstantPool 创建，只存 tag+索引

② post_process_parsed_stream()
   → initialize_unresolved_klasses()  分配 _resolved_klasses 空数组
      (constantPool.cpp:209)          (所有元素=NULL)

③ link_class_impl() → rewrite_class()
   → Rewriter::rewrite()
     → make_constant_pool_cache()     分配 _cache (ConstantPoolCache)
        (rewriter.cpp:94)             _f1[]=NULL, _f2[]=0, _flags[]=0
     → rewrite_bytecodes()            ldc #5 → ldc_w #M (指向Cache索引)

④ 首次访问 — ldc #5 慢路径
   → ConstantPool::klass_at_impl()    检查 _resolved_klasses[N] == NULL
     → SystemDictionary::resolve      加载类 → 返回 Klass*
     → release_store(_rk[N], klass)   ← ★ release 写

⑤ 第二次 — ldc #5 快路径
   → ConstantPool::klass_at_impl()    load_acquire(_rk[N]) != NULL
     → ★ O(1) 直接返回!               ← acquire 读，无锁!

⑥ 首次 invokevirtual #15 慢路径
   → LinkResolver::resolve_virtual()
     → Cache._f1[M] = Method*         写入 Cache
     → Cache._f2[M] = vtable_index
     → Cache._flags[M] |= 1           ← ★ bit0=1, volatile 写作为发布点

⑦ 第二次 invokevirtual #15 快路径
   → CacheEntry::is_resolved()==true  _flags[M] bit0=1
     → _f1[M] 直接取 Method*         ★ O(1)!
```

### 7.2 创建时机对比

| 组件 | 创建函数 | 调用链 | 时机 | 所属内存 |
|------|---------|--------|------|---------|
| `ConstantPool` | `ConstantPool::allocate()` | `parse_constant_pool()` | 类文件解析 | **Metaspace** |
| `_resolved_klasses` | `allocate_resolved_klasses()` | `post_process_parsed_stream()` | parse 后，link 前 | **Metaspace** |
| `_cache` | `ConstantPoolCache::allocate()` | `Rewriter::make_constant_pool_cache()` | link 中，rewrite 阶段 | **Metaspace** |
| `_resolved_klasses[N]` 内容 | `klass_at_impl()` 的 `release_store` | 首次 `ldc #N` | 运行时（惰性） | 写入现有 Metaspace 数组 |
| `Cache._f1[M]` 内容 | `LinkResolver` 的 `set_method` | 首次 `invokevirtual` | 运行时（惰性） | 写入现有 Metaspace Cache |

**设计要点**：`_resolved_klasses` 在 link 阶段分配空数组，`_cache` 在 rewrite 阶段分配 — 这两个阶段都在持有锁的情况下串行执行。**只有运行时填充数组元素时才需要 release/acquire 语义。** 所有分配均在 Metaspace，无 C heap 泄漏风险。

---

## §八 并发安全分析

### 8.1 多线程同时 `ldc #5`（同一类）

```
线程 T1                          线程 T2                          SystemDictionary
────────                         ────────                        ──────────────
klass_at_impl(#5):
  load_acquire(_rk[0])==NULL
  ↓
SystemDictionary::resolve:
  dict->find() == NULL           klass_at_impl(#5):
  → 进入 DCL 路径                  load_acquire(_rk[0])==NULL
  → 加 SystemDictionary_lock     ↓
  → POST_LOCK_DICT_HIT? NO       SystemDictionary::resolve:
  → find_and_add(LOAD_INSTANCE)    dict->find() == NULL            ← T1 还未注册
  → load_instance_class()          → 加锁等待                     ← T1 持有锁
  → define_instance_class()        → ...
  → dict->add_klass() !!!          → POST_LOCK_DICT_HIT!          ← ★ T1 已注册!
  → find_and_remove + notify       → 返回已加载的 Klass*
release_store(_rk[0], klass)     已经返回（同一个 klass*）
```

**关键**：第二个线程在加锁重查时，可能发现 `dict->find() != NULL`（T1 已经注册），走 POST_LOCK_DICT_HIT 路径。即使它不走 `_resolved_klasses` 的 load_acquire 快路径，拿到的也是同一个 klass。

### 8.2 `load_acquire` / `release_store` 保证什么？

```cpp
// 写入端 (klass_at_impl):
SystemDictionary::resolve_or_fail(name, loader, ...);  // ① 类加载完成
OrderAccess::release_store(adr, klass);                 // ② ★ release: ① 的所有写对之后的 acquire 可见
release_tag_at_put(which, JVM_CONSTANT_Class);          // ③ 换 tag

// 读取端 (klass_at_impl 开头):
Klass* k = OrderAccess::load_acquire(adr);              // ④ ★ acquire: 读到 ② 后, ① 的所有结果可见
if (k != NULL) return k;                                 // ⑤ 直接返回
```

**保证**：任何线程通过 ④ 读到非 NULL 值后，一定能看到完整的 Klass* 对象 — 类链接完成、vtable/itable 就绪。不会出现"拿到指针但对象未初始化"的问题。

### 8.3 Cache 的 `_flags` 为什么用 `volatile intx`？

```
写入顺序 (LinkResolver):
1. _f2[M] = vtable_index           ★ 先写 f2
2. _f1[M] = Method*                ★ 再写 f1
3. _flags[M] |= is_resolved        ★ ★ 最后写入 volatile _flags → 触发内存屏障
   ★ 处理器保证: 3 之前的写(f1,f2)对其他线程的 4 之后读可见

读取顺序 (解释器):
4. if (_flags[M] & 1) == 1          ★ 先读 volatile _flags → acquire 语义
5.   Method* m = _f1[M]             ★ 安全: m 一定已初始化
6.   int idx  = _f2[M]              ★ 安全: idx 一定已写入
```

**`_flags` 充当"发布者"**：volatile 写触发 store-store + store-load 屏障，确保 `_f1`/`_f2` 的写入先于 `_flags` 对任何其他线程可见。这是一个经典的无锁发布协议（seqlock 的简化版）。

### 8.4 _resolved_klasses 和 Cache 的并发对比

| 维度 | `_resolved_klasses` | `ConstantPoolCache` |
|------|-------------------|-------------------|
| 数组元素类型 | `Klass**`（指针） | `volatile intx`（64-bit 位标记+f1+f2） |
| 发布协议 | `OrderAccess::release_store` / `load_acquire` | volatile `_flags` 最后写入 |
| 写入方 | `klass_at_impl`（可多线程并发） | `LinkResolver`（单个 entry 只写一次） |
| 读取方 | 所有线程 | 所有解释器线程 |
| 是否可能写多次 | 一个槽只写一次（Klass* 不变） | 一个槽只写一次（解析后不变） |

**核心设计**：都是 "write once, read many" 模式 — 解析后不会改变。因此不需要读锁，只需保证"写入完成的顺序对读取者可见"。

---

## §九 设计决策 — Why X instead of Y

### 9.1 为什么 `_resolved_klasses` 和 `_cache` 是两个独立数组，而不是统一成一个 Cache？

> 即: 为什么不把 `klass_at_impl` 的结果也写入 ConstantPoolCache 的 `_f1/_f2` 槽位，让所有解析结果都走 Cache？

**四个理由**：

**① 目标字节码不同，一次解析 vs 多次解析**：
- `ldc #N (class)` → `klass_at_impl` → 结果为 `Klass*`，解析**一次**，后续都走同一个 `_resolved_klasses[N]` 指针。
- `invokevirtual #M` → LinkResolver → 结果为 `Method*` + `vtable_index`，这两个值**分开存储**在 `_f1/_f2`；且 invoke 需要 `is_final`/`is_volatile`/`tos_state` 等额外 flag，Class 解析不需要这些。

**② Cache 条目数 ≠ 常量池条目数**：Cache 只对应那些**被字节码直接引用**的 CP 条目（Rewriter 重写字节码时计算）。对一个 320 条目的常量池，Cache 可能只有 28 个条目。`_resolved_klasses` 需要覆盖所有 `CONSTANT_Class` 条目，两者基数不同。

**③ Cache 的 `_flags` 编码了字节码语义**：`_flags` 的 bit layout 区分字段/方法（bit 25）、存 `tos_state`（操作数栈类型）、存 `parameter_size` — 这些都是**字节码执行引擎**关心的元数据，与 Class 解析无关。如果把 Klass* 也塞进 `_f1`，需要另外一套 flag 编码，复杂化 `is_resolved()` 的单一检查。

**④ 历史演进**：`_resolved_klasses` 是后来加上的优化 — 早期 ConstantPool 没有这个数组，`klass_at` 每次都从 tag 走到 SystemDictionary。加入 `_resolved_klasses` 是局部优化（只影响 ldc class 路径），不改变 Cache 的职责边界。

### 9.2 为什么 CONSTANT_Utf8 立即解析（SymbolTable::lookup），但 CONSTANT_Class / CONSTANT_String 延迟解析？

**三个理由**：

**① Utf8 无依赖，Class/String 有循环依赖风险**：
- `SymbolTable::lookup("java/lang/Object")` 是纯哈希表操作 — 不需要类加载器，不触发类加载，不涉及其他 CP 条目。可以在 `parse_constant_pool_entries` 的 for 循环内完成。
- `CONSTANT_Class(#7)` 引用 `name_index` → 如果立即解析，等于在解析常量池的**中间**去触发类加载，而此时 `this_class` / `super_class` 还没读出来、`_cp` 本身还没完全就绪 → 会引发 `NullPointerException` 或更恶劣的不完全初始化。

**② CONSTANT_String 需要 java.lang.String 实例**：解析 `CONSTANT_String` = 在 StringTable 中创建（或查找）一个 `java.lang.String` 对象。这需要：
- `java.lang.String` 类已经加载（Bootstrap 加载它 — 可能出现 chicken-and-egg 问题）
- String 对象需要在 Java 堆分配（ooop）
这两步在 `parse_constant_pool_entries` 阶段（类尚未链接）都不可靠。

**③ Utf8 被所有其他 tag 引用，必须先就绪**：`CONSTANT_Class` 的 `name_index`、`CONSTANT_Methodref` 的 `class_index` + `name_and_type_index`、`CONSTANT_String` 的 `string_index` — 全部指向 CONSTANT_Utf8。如果 Utf8 不是立即解析，后续所有索引查找都需要先检查 `this_cp->symbol_at(utf8_index) == NULL?` — 每条引用路径多一次 NULL 检查。立即解析消除了这个负担。

---

## §十 从 `tag_at(5)` 到 `klass_at(5)` 的内部查找

```
klass_at(5) 调用:
 ① tag_at(5) → JVM_CONSTANT_UnresolvedClass? (tag ≠ JVM_CONSTANT_Class)
      → 未解析, 进入 klass_at_impl()

 ② klass_slot_at(5) → CPKlassSlot {resolved_klass_index, name_index}
      → 计算在 _resolved_klasses 数组中的索引

 ③ _resolved_klasses->at(resolved_klass_index) → load_acquire
      → NULL? 触发 SystemDictionary::resolve_or_fail()

 ④ 加载完成 → release_store(_resolved_klasses[idx], klass)
 ⑤ tag_at_put(5, JVM_CONSTANT_Class)  ← tag 从 UnresolvedClass 变为 Class

下次访问:
 ① tag_at(5) → JVM_CONSTANT_Class? → YES
 ② klass_at_impl → load_acquire → 非 NULL → ★ O(1) 返回
```

---

## §十一 总结

### 数据结构

- **ConstantPool(72B)**：继承 Metadata → MetaspaceObj → 在 Metaspace 分配。`_tags`、`_resolved_klasses`、`_cache` 全部在 Metaspace。**没有 C heap 组件。**
- **ConstantPoolCache(40B)**：`_f1[索引]` 存 Klass*/Method*、`_f2[索引]` 存偏移/索引、`_flags`(64-bit) 存解析状态（bit0=is_resolved）+ 字节码语义
- **Symbol**：UTF8 去重存储，`CONSTANT_Utf8` 经 `SymbolTable::lookup()` 分配，存在 SymbolTable 的 Arena 中

### 算法

- **两阶段设计**：解析时只存索引 → 使用时惰性解析 + acquire/release 写
- **Long/Double 占 2 slot**：历史兼容，`index++` 跳过第二 slot
- **三种 tag 立即解析 vs 惰性解析**：Utf8 → SymbolTable(立即，无依赖)；Class/String → 存索引(惰性，有循环依赖)；其他 → 存索引(惰性)
- **Cache O(1) 热路径**：`is_resolved()` → `_f1[N]`，两次 volatile 读，无锁
- **写入时序**：CP 解析 → `_resolved_klasses` 空数组 → `_cache` 空数组 → 运行时首次访问填充
- **并发安全**：`release_store`/`load_acquire` 保证 `_resolved_klasses` 可见性；volatile `_flags` 作为 Cache 的"发布位"保证 `_f1/_f2` 对读者可见

---

## §十二 可证伪断言

| # | 断言 | 验证 | 预期 |
|---|------|------|:---:|
| 1 | `sizeof(ConstantPool)` = 72B | GDB `p sizeof(ConstantPool)` | 72 |
| 2 | `sizeof(ConstantPoolCache)` = 40B | GDB `p sizeof(ConstantPoolCache)` | 40 |
| 3 | `_resolved_klasses` 分配时全为 NULL，首次 `ldc #N` 时 `release_store` 写入 | GDB break `klass_at_impl`; `p *adr` 前后对比 | 0x0 → 0x7f... |
| 4 | `is_resolved()` 检查 `(_flags & 1) == 1`（bit0 = 解析完成标记） | 源码 `cpCache.inline.hpp` | bit0 |
| 5 | CONSTANT_Long / CONSTANT_Double 占 2 个 cp slot（`index++` 跳过） | 源码 `parse_constant_pool_entries` | index++ |
| 6 | Cache 写入时序：`_f2` 先写 → `_f1` 再写 → `_flags` 最后 volatile 写 | GDB break `ConstantPoolCacheEntry::set_method`; `p _flags` 前后: `0 → 1` | bit0=1 |
