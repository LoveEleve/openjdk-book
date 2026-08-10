# 第 0 章：C++ in HotSpot — 模板、分配器、惯用法

阅读 HotSpot C++ 源码，你会遇到三件意外的事：

1. **没有 STL** — 没有 `std::vector`、没有 `std::map`、没有 `std::string`
2. **到处都是宏** — `LOG_TAG_LIST` 展开成 100+ 个枚举值的开关矩阵
3. **RAII 无处不在** — 从锁到内存到线程状态，全用构造/析构管理

这章不教你 C++ 语法。它回答：**"HotSpot 的 C++ 为什么长成这样？"**

---

## 0.1 为什么 HotSpot 不用 STL？

> **核心结论**：STL 的三个"标准行为"与 HotSpot 的三个"刚需"冲突。

### 冲突矩阵

| 维度 | 标准 C++ STL | HotSpot 的刚需 | 冲突后果 |
|------|-------------|---------------|---------|
| 分配器 | `std::allocator<T>` 调用 `::operator new`（最终到 `malloc`） | 多级分配器：Arena（bump pointer）、C_HEAP（含 NMT tag）、Metaspace | STL 容器无法感知 NMT 内存类型追踪 (`allocation.hpp:160-171`) |
| 容器销毁 | 析构时释放所有内存 | 大量临时计算数据希望用 Arena 批量回滚（`ResourceMark` 析构即全部 free） | `std::vector::push_back` 会导致增量 `malloc`，无法享受 bump-pointer 的 O(1) 分配 |
| 编译时间 | 头文件模板实例化，每个翻译单元编译各自副本 | 大型项目（200+ .cpp 链接一个 .so）编译时间是工程问题 | 模板膨胀使每个 .o 文件膨胀，链接阶段还要去重 |
| 线程安全 | 标准容器不做同步保证 | 某些容器需要无锁读取 (`ConcurrentHashTable`) | `std::unordered_map` 的迭代器失效语义与无锁编程不兼容 |
| 对象模型 | 模板类型在编译期绑定 | CodeBlob → CompiledMethod → nmethod 用 vtable 做运行时多态 | STL 的静态多态与 OOP 层次不兼容 |

### 设计原理

HotSpot 的容器库本质是一个**正交的三层抽象**：

```
┌──────────────────────────────────────────────┐
│  存储策略        Arena     C_HEAP    Stack    │
│  (allocation.hpp:360-366)                    │
├──────────────────────────────────────────────┤
│  内存追踪        MEMFLAGS 标记系统              │
│  (allocation.hpp:160-171)                    │
├──────────────────────────────────────────────┤
│  容器类型        GrowableArray  Hashtable     │
│                  ConcurrentHashTable          │
└──────────────────────────────────────────────┘
```

STL 将这三层塞进同一个模板参数里（`std::vector<T, Allocator>`），HotSpot 将它们**正交分离**。这意味着同一个 `GrowableArray<int>` 可以在每次使用时选择不同的存储策略，而不是在类型实例化时就钉死。

**关键代码** — `ResourceObj::allocation_type` 枚举 (`allocation.hpp:360-366`)：

```cpp
enum allocation_type {
    STACK_OR_EMBEDDED = 0,  // 栈上，自动释放
    RESOURCE_AREA,           // 线程局部 Arena，批量回滚
    C_HEAP,                  // C 堆，需手动 free
    ARENA                    // 自定义 Arena
};
```

同一个类通过 `operator new` 重载决定分配位置——不是改类型，而是改构造参数。

**具体示例** — `GrowableArray` 的三种用法 (`growableArray.hpp:127`, `heapInspection.cpp:58`, `heapShared.cpp:92`)：

```cpp
// ① 默认：线程 ResourceArea — 函数返回自动回收
GrowableArray<Method*> methods;  // arena = NULL → ResourceArea

// ② C_HEAP：C 堆分配 — 需手动 delete
new(ResourceObj::C_HEAP, mtInternal) GrowableArray<KlassInfoEntry*>(4, true)

// ③ 自定义 Arena：绑定到特定 Arena 生命周期
new(&my_arena) GrowableArray<int>(100)
```

> **对读者的提问**：如果你在 STL 中要支持"同一类型的容器有时在栈上分配、有时在特定内存池分配"，你需要写几个模板实例化？

---

## 0.2 Arena 分配器 — JVM 的 malloc 替代品

> **本章最重要的设计原则**：在 VM 内部，"分配快" 比 "释放快" 重要 10 倍。一个编译阶段的临时数据可达数百 MB，但阶段结束后全部作废——逐个 `free` 是浪费 CPU。Arena + ResourceMark 的批量回收正是为此而生。

### 2.0 核心数据结构

Arena 是 HotSpot 使用频率最高的分配器。它的设计哲学是：**对于临时计算数据，分配快比释放快更重要**。

```
Arena (arena.hpp:93-159)
  ├── _first → Chunk(256B)  →  Chunk(1KB)  →  Chunk(32KB) → ...
  │              (tiny)           (init)         (default)
  ├── _chunk ──────────────────────────────────→ 指向当前正在分配的 Chunk
  ├── _hwm ──────────────────────→ 当前 Chunk 内的高水位标记
  └── _max ──────────────────────→ 当前 Chunk 的结束地址
```

Arena 是一个 **Chunk 单向链表**，每个 Chunk 是堆上分配的连续内存块（`arena.hpp:45`）。`_chunk` 指向当前正在使用的新块，`_hwm` 和 `_max` 分别标记已用和可用空间的边界。

### 2.1 Arena::Amalloc — bump-pointer 极速分配

```
Amalloc(128 字节)
  │
  ├── _hwm + 128 ≤ _max ?
  │     YES → old = _hwm; _hwm += 128; return old;  ← 一次比较 + 一次加法，无系统调用
  │     NO  → grow(128)  ← 分配新 Chunk，插入链表尾部
```

**关键代码** (`arena.hpp:145-159`)：

```cpp
void* Amalloc(size_t x, AllocFailType alloc_failmode = AllocFailStrategy::EXIT_OOM) {
    assert(is_power_of_2(ARENA_AMALLOC_ALIGNMENT), "should be a power of 2");
    x = ARENA_ALIGN(x);                                             // ← 对齐
    if (!check_for_overflow(x, "Arena::Amalloc", alloc_failmode))
      return NULL;
    if (_hwm + x > _max) {
      return grow(x, alloc_failmode);                               // ← 慢路径
    } else {
      char *old = _hwm;
      _hwm += x;                                                    // ← 快路径
      return old;
    }
}
```

**快路径只执行一条比较 `_hwm + x > _max` 和一条加法 `_hwm += x`**。无锁、无系统调用、无 `malloc` 内部的自旋锁竞争。对比 `malloc(128)` 在 glibc ptmalloc2 中需要遍历 bins → 尝试 fastbins → 切分 chunk → 可能 `sbrk/mmap`（需查阅 `man 3 malloc`）。

### 2.2 Arena::grow — Chunk 链扩展

当当前 Chunk 耗尽时，`grow()` 分配一个新的 Chunk 并链接到链表尾部：

**关键代码** (`arena.cpp:356-375`)：

```cpp
void* Arena::grow(size_t x, AllocFailType alloc_failmode) {
    size_t len = MAX2(x, (size_t) Chunk::size);      // 至少 32KB（_LP64 下 slack=40）
    Chunk *k = _chunk;
    _chunk = new (alloc_failmode, len) Chunk(len);    // 分配新 Chunk
    if (k) k->set_next(_chunk);                       // 接到链表尾部
    else _first = _chunk;
    _hwm  = _chunk->bottom();
    _max =  _chunk->top();
    void* result = _hwm;
    _hwm += x;                                        // 在新 Chunk 上做 bump-pointer
    return result;
}
```

Chunk 的大小分级 (`arena.hpp:65-69`)：

| 类型 | 大小（_LP64） | 用途 |
|------|:---:|------|
| `tiny_size` | 256-40=216B | Arena 的第一个 Chunk，小请求避免浪费 |
| `init_size` | 1K-40=984B | 默认的第一个 Chunk 大小 |
| `medium_size` | 10K-40 | 中等大小 |
| `size`（默认） | 32K-40 | 后续 Chunk 的默认大小 |

每种大小都减去 `slack=40`（`arena.hpp:59`），这是为了**防止 glibc 的 buddy-system 将相邻 Chunk 合并**。`slack` 估计了 `sizeof(Chunk)` 头大小 + glibc 内部 malloc 头的开销（≈40 字节），使每个 Chunk 的实际分配大小不会正好是 2 的幂次，从而避免 buddy-system 的合并优化（2 的幂次 buddy 合并是 ptmalloc 的已知行为）。

### 2.3 ResourceMark — RAII 批量回滚

Arena 不提供单个对象的 `free` —— 你分配的所有临时数据，在 `ResourceMark` 析构时**一次性全部回收**。

**关键代码** (`resourceArea.hpp:73-164`)：

```cpp
class ResourceMark: public StackObj {
    ResourceArea *_area;    // 线程的 ResourceArea
    Chunk *_chunk;          // 保存的 Arena chunk
    char *_hwm, *_max;      // 保存的水位

    void reset_to_mark() {
        if (_chunk->next()) {
            _chunk->next_chop();    // ★ 删除构造之后分配的后续 Chunk
        }
        _area->_chunk = _chunk;     // ★ 回滚到保存的 chunk
        _area->_hwm = _hwm;         // ★ 回滚 hwm
        _area->_max = _max;
    }

    ~ResourceMark() {
        debug_only(_area->_nesting--;)
        reset_to_mark();
    }
};
```

**工作原理**：构造时保存 `_hwm`、`_chunk`、`_max` 三个指针；析构时全部恢复。如果你在 `ResourceMark` 作用域内分配了 10MB 临时数据，析构一个函数什么都不做——只是把指针移回去。**O(1) 释放**。

**典型用法** (`resourceArea.hpp:31-41`)：

```cpp
// 线程的 ResourceArea 永久存在，每段"临时计算"用 ResourceMark 分隔
{
    ResourceMark rm;                            // 保存当前状态
    int foo[] = NEW_RESOURCE_ARRAY(int, 64);    // Arena 分配
    // ... 此处可以分配任意临时对象 ...
}                                               // 析构 → 全部回收
```

### 2.4 Afree — 有条件的 LIFO 释放

Arena 提供了 `Afree()`，但它**只在释放的是最近分配的对象时才有效** (`arena.hpp:202-211`)：

```cpp
void Afree(void *ptr, size_t size) {
    if (ptr == NULL) return;               // 兼容 free(NULL) 语义
    if (((char*)ptr) + size == _hwm)      // ★ 只有释放的对象紧邻 _hwm 时才回退
        _hwm = (char*)ptr;
    // 否则什么都不做（内存"泄漏"但 ResourceMark 析构时会回收）
}
```

**设计理由**：绝大多数临时分配满足 LIFO 顺序（类似调用栈的局部变量），所以 `Afree` 只处理最常见情况。对于不满足 LIFO 的释放，等 `ResourceMark` 析构时批量回收。

> **边缘场景警告**：如果你 `Amalloc(10)` → `Amalloc(20)` → `Afree(第一个10)`，第二个分配不会被回收——`Afree` 只回收紧邻 `_hwm` 的对象。这种"中间释放"的内存碎片会在 Arena 中形成"空洞"，直到 `ResourceMark` 析构时才彻底清除。在循环中频繁创建和释放大小不等的 Arena 对象时，碎片化可能导致虚拟内存浪费。

### 小结对照

| 需求 | 标准 C++ 做法 | HotSpot 做法 | 设计理由 |
|------|-------------|------------|---------|
| 临时对象 | `std::vector<T>` + `delete` | `GrowableArray<T>` + `ResourceMark` | 批量回收 O(1) vs 逐个 free O(n) |
| 极速小分配 | `new T()` → `malloc` | `Amalloc()` → bump-pointer | 一条比较 + 一条加法 vs glibc 内部锁竞争 |
| 分配器全局替换 | 重载 `operator new` | `Arena` 链表 + `ResourceMark` 回滚 | Arena 天然支持批量回收，`operator new` 不行 |
| 内存类型追踪 | 额外包装 + 全局状态 | MEMFLAGS 参数 + NMT | 分配时标注，运行时可查询（NMT） |

---

## 0.3 模板惯用法

### 3.1 GrowableArray — 非类型安全基类 + 类型安全模板壳

HotSpot 的 `GrowableArray` 不是 `std::vector` 的简单替代品，而是**类型擦除 + 再包装**的经典模式。

**层次结构** (`growableArray.hpp:79,155`)：

```
GenericGrowableArray (growableArray.hpp:79)
  │  _len, _max, _arena — 非类型安全的底层存储
  │  raw_allocate() — 按字节分配
  │
  └── GrowableArray<T> (growableArray.hpp:155)
        E* _data — 类型安全的元素数组
```

**为什么这样做？**

```cpp
// GenericGrowableArray 没有元素类型信息 — 只管理字节
class GenericGrowableArray : public ResourceObj {
protected:
    int    _len;       // 当前长度
    int    _max;       // 最大容量
    Arena* _arena;     // NULL=ResourceArea, (Arena*)1=C_HEAP, 其他=指定 Arena
};

// GrowableArray<T> 在基类之上封装类型安全
template<class E> class GrowableArray : public GenericGrowableArray {
private:
    E*     _data;      // 类型安全的元素数组指针
};
```

**设计理由**：
1. **避免模板代码膨胀** — 所有非类型相关的方法（容量增长、内存分配策略）放在 `GenericGrowableArray`，只需编译一次
2. **三态 Arena 指针** (`growableArray.hpp:85-104`)：
   - `_arena == NULL` → 使用线程的默认 ResourceArea（`raw_allocate(thread, ...)`）
   - `_arena == (Arena*)1` → 使用 C_HEAP（带 MEMFLAGS 追踪）
   - `_arena > (Arena*)1` → 使用指定 Arena（例如编译器的自定义 Arena）

   ```cpp
   bool on_C_heap() { return _arena == (Arena*)1; }
   bool on_stack () { return _arena == NULL;      }
   bool on_arena () { return _arena >  (Arena*)1;  }
   ```

3. **线程本地快速路径** (`growableArray.hpp:143-147`)：

   ```cpp
   // 如果 arena 是当前线程的 ResourceArea，直接取线程局部指针
   void* raw_allocate(Thread* thread, int elementSize) {
       assert(on_stack(), "fast ResourceObj path only");
       return (void*)resource_allocate_bytes(thread, elementSize * _max);
   }
   ```

### 3.2 Hashtable — 表+桶+链表三层分离

HotSpot 的 Hashtable 将传统 `std::unordered_map` 拆解为**三个独立的 C++ 类，各自独立模板化**：

```
HashtableBucket<F> (hashtable.hpp:121)
  │  只有一个 _entry 指针 — 链表头
  │
BasicHashtable<F> (hashtable.hpp:142)
  │  _table_size, _buckets[], _free_list — 桶数组 + 内存管理
  │  不关心键/值类型
  │
Hashtable<T, F> (hashtable.hpp:246)
      _literal — 键（通常是 Symbol*）
      不存储值 — 键即值（Symbol table 模式）
```

**关键代码**：

```cpp
// 第一层：桶 — 只有一个指针
template <MEMFLAGS F> class HashtableBucket : public CHeapObj<F> {
    BasicHashtableEntry<F>* _entry;  // ← 链表头，使用 order-access 保证多处理器可见性
};

// 第二层：表 — 管理桶数组，不知道键/值类型
template <MEMFLAGS F> class BasicHashtable : public CHeapObj<F> {
    HashtableBucket<F>* _buckets;    // 桶数组
    int _table_size;
    BasicHashtableEntry<F>* _free_list; // 空闲 Entry 链表，避免逐个 malloc
};

// 第三层：键类型 — 添加键的概念
template <class T, MEMFLAGS F> class Hashtable : public BasicHashtable<F> {
    // T 通常是 Symbol*
    // 继承关系：HashtableEntry<T,F> → BasicHashtableEntry<F>
};
```

**设计理由**：
- **桶可以单独共享** — CDS（Class Data Sharing）中，桶数组可以被多个 Hashtable 实例共享，只需不同的桶数组指针
- **Entry 池化** — `_free_list` 预先分配 Entry 数组，避免逐个 malloc（尤其重要：SymbolTable 的 Entry 数量可达几十万）
- **CRTP 在 Hashtable 中的应用** — `HashtableEntry<T,F>` 继承 `BasicHashtableEntry<F>` 并添加 `_literal` 字段，通过模板参数在编译期完成类型安全，无需 vtable 开销

**Entry 的指针复用技巧** (`hashtable.hpp:46-96`)：

```cpp
// _next 的 bit 0 用作 shared 标记 — 因为指针是 4/8 字节对齐的，bit 0 始终为 0
BasicHashtableEntry<F>* _next;

bool is_shared() const {
    return ((intptr_t)_next & 1) != 0;  // bit 0 偷用来标记 shared entry
}

void set_shared() {
    _next = (BasicHashtableEntry<F>*)((intptr_t)_next | 1); // 不会修改实际指针
}
```

> **指针位偷取 (pointer-bit stealing) 的边界条件**：这种优化基于"所有堆分配指针按 sizeof(void*) 对齐"的假设。在 x86-64 上，`malloc` 保证 16 字节对齐，最低 4 位始终为 0，偷取 1 位是安全的。但如果你在嵌入系统中使用 1 字节对齐的平台（某些 ARM Cortex-M），这个技巧会造成指针损坏且编译器不会发出任何警告。

### 3.3 ConcurrentHashTable — 读端无锁设计

`ConcurrentHashTable` (`concurrentHashTable.hpp:36`) 是 HotSpot 的高级模板容器，与 `Hashtable` 的根本区别：**找操作无锁，插入/删除只在必要时加锁**。

```cpp
template <typename VALUE, typename CONFIG, MEMFLAGS F>
class ConcurrentHashTable : public CHeapObj<F> {
    // CONFIG 模板参数包含：
    //   - VALUE 的分配/释放策略
    //   - 哈希函数
    //   - 查找/删除的函数对象
    // 所有策略通过模板参数注入，零运行时开销
```

设计要点：
1. **read-side wait-free** — 使用 `GlobalCounter` + RCU 风格的内存回收，读者永远不被阻塞
2. **CONFIG 模板参数** — 将分配策略、哈希函数、查找逻辑全部编译期注入，避免虚函数开销
3. **增长使用 BucketsOperation** (`concurrentHashTableTasks.inline.hpp:36`) — 后台线程安全的桶扩容

---

## 0.4 placement new — 在 mmap 上构造对象

### 4.0 什么是 placement new

标准 C++ 中，`new T()` 同时做两件事：调用 `operator new` 分配内存，再调用构造函数。`placement new` 是语法 `new (addr) T(args)`，**跳过内存分配**，只在指定的内存地址上调用构造函数。

HotSpot 大量使用它，因为内存的来源可能是：CodeCache 的 mmap、Metaspace 的虚拟空间、Arena 的 bump-pointer 区域。这些内存**已经由子系统分配好**，只需要在上面构造 C++ 对象。

### 4.1 nmethod — 在 CodeCache 上构造编译后的方法

`nmethod` 是 JIT 编译产物的 C++ 表示。其 C++ 对象和 JIT 机器码、元数据一起**嵌入在同一块连续内存中**（CodeCache 的 mmap 区域）。

**关键代码** (`nmethod.hpp:55`, `nmethod.cpp:641-643`)：

```cpp
// nmethod 的 operator new 被重载 — 不从堆分配，从 CodeCache 分配
void* nmethod::operator new(size_t size, int nmethod_size, int comp_level) throw () {
    return CodeCache::allocate(nmethod_size, CodeCache::get_code_blob_type(comp_level));
}
```

**nmethod 在 CodeCache 中的三段内存布局**：

```
┌──────────────────────────────────────────────────────────────┐
│  header_begin()                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  nmethod C++ 对象 (operator new 从这里分配)              │ │
│  │  _header_size 字节                                      │ │
│  ├─────────────────────────────────────────────────────────┤ │
│  │  _consts_offset → 常量数据 (metadata, reloc info)       │ │
│  ├─────────────────────────────────────────────────────────┤ │
│  │  code_begin() → 编译后的机器码 (x86/ARM 指令)           │ │
│  │  _code_end                                              │ │
│  └─────────────────────────────────────────────────────────┘ │
│  data_end()                                                  │
└──────────────────────────────────────────────────────────────┘
```

**构造代码** (`nmethod.cpp:500`)：

```cpp
// size = sizeof(nmethod), nmethod_size = 整块内存的总大小
nm = new (nmethod_size, comp_level) nmethod(method(), compiler, ...);
//     ^^^^^^^^^^^^^^^^^^^^^^^^^^^    ^^^^^^^ 在 CodeCache 上调用构造函数
//     传递给重载的 operator new     构造参数
```

### 4.2 Metachunk — 在 Metaspace 虚拟空间上构造

`Metachunk` 是 Metaspace 中管理元数据（类、方法）的分配单元。Metaspace 通过 `mmap` / `VirtualSpaceNode` 预先分配大块虚拟内存，然后使用 placement new 在其上构造 Metachunk 管理结构。

**关键代码** (`virtualSpaceNode.cpp:446`, `chunkManager.cpp:434`)：

```cpp
// VirtualSpaceNode 分配大块 mmap 后，在其上构造 Metachunk
Metachunk* result = ::new (chunk_limit) Metachunk(chunk_type, is_class(), chunk_word_size, this);

// ChunkManager 也是同样的模式 — 合并 free chunk 时：
Metachunk* target_chunk = ::new (p) Metachunk(target_chunk_index, is_class(), target_chunk_word_size, vsn);
```

> **对读者的提问**：如果用标准 `new Metachunk()` 代替 `::new (addr) Metachunk()`，后果是什么？提示：`nmethod` 的 `CodeCache::allocate` 返回内存来自一个 mmap'd 区域，不在 glibc 的堆上。
>
> **placement new 的安全风险**：`placement new` 跳过了内存分配，也跳过了所有安全检查。如果你在一个已被释放的地址上调用 `new (addr) T()`，会造成隐蔽的内存破坏——旧数据和新建对象的数据交织在一起，可能数小时后才表现为随机崩溃。HotSpot 在 DEBUG 构建中通过 `ZapResourceArea` 用垃圾字节填充已回收区域来检测这种误用（`resourceArea.hpp:146`）——任何在已填充区域上构造的对象，其 vtable 和成员变量都会被垃圾值覆盖，导致可预测的 crash 而非难以复现的数据损坏。

### 4.3 总结对照

| 场景 | 标准 C++ 做法 | HotSpot 做法 | 设计理由 |
|------|-------------|------------|---------|
| JIT 编译产物 | `new nmethod()` + 单独的 CodeBuffer | `new (codecache_ptr) nmethod()` + 内嵌机器码 | nmethod 和其机器码在同一块 mmap 中，便于 CodeCache::flush 彻底释放 |
| Metaspace 元数据 | heap-allocate 每个管理结构 | `::new (mmap_ptr) Metachunk()` | Metaspace 虚拟内存已分配，无需二次 malloc |
| Arena 中的对象 | placement new 在 Arena::Amalloc 的返回地址 | `new (&arena) Foo()` | ResourceObj 的 operator new 重载自动选择分配策略 |
| DeoptResourceMark | 栈上 RAII | 堆上分配（`CHeapObj` 继承） | 去优化栈帧已被替换，不能在栈上构造，必须堆分配 (`resourceArea.hpp:195`) |

---

## 0.5 X-MACRO — 代码生成术

### 5.0 什么是 X-MACRO

X-MACRO 是一个 C/C++ 预处理器技法：定义一个数据列表宏，然后用**不同的 `#define` 重新解释**这个列表，在不同位置生成不同的代码。

```
定义一次列表：
  #define MY_LIST \
    X(apple) X(banana) X(cherry)

使用方式 1 — 生成枚举：
  #define X(name) e_##name,
  enum Fruit { MY_LIST };
  #undef X

使用方式 2 — 生成字符串数组：
  #define X(name) #name,
  const char* names[] = { MY_LIST };
  #undef X

使用方式 3 — 生成 switch-case：
  #define X(name) case e_##name: return #name;
```

### 5.1 LOG_TAG_LIST — 100+ 个日志标签的一次定义、多次展开

日志系统定义了一次性的列表宏 `LOG_TAG_LIST`，包含 120+ 个标签：

**列表定义** (`logTag.hpp:34-174`)：

```cpp
#define LOG_TAG_LIST \
  LOG_TAG(add) \
  LOG_TAG(age) \
  LOG_TAG(alloc) \
  LOG_TAG(aot) \
  // ... 120+ tags ...
  LOG_TAG(vmthread) \
  LOG_TAG(vtables) \
  LOG_TAG(workgang)
```

**展开 1：生成枚举** (`logTag.hpp:199-205`)：

```cpp
enum type {
    __NO_TAG,
#define LOG_TAG(name) _##name,    // ← 重新定义 LOG_TAG 为 "在名字前面加下划线"
    LOG_TAG_LIST                  // ← 展开后变成: _add, _age, _alloc, ...
#undef LOG_TAG
    Count
};
```

**展开 2：生成字符串数组** (`logTag.cpp:31-36`)：

```cpp
const char* LogTag::_name[] = {
    "", // __NO_TAG
#define LOG_TAG(name) #name,      // ← 重新定义 LOG_TAG 为 "字符串化"
    LOG_TAG_LIST                  // ← 展开后变成: "add", "age", "alloc", ...
#undef LOG_TAG
};
```

**展开 3：生成 fuzzy_match 搜索空间**：

`fuzzy_match` 利用**运行时的 `_name[]` 数组**做模糊匹配（`logTag.cpp:47-61`）——遍历所有标签名，用 `StringUtils::similarity()` 做编辑距离比较：

```cpp
LogTagType LogTag::fuzzy_match(const char *str) {
    size_t len = strlen(str);
    LogTagType match = LogTag::__NO_TAG;
    double best = 0.5;  // 最小相似度阈值
    for (size_t i = 1; i < LogTag::Count; i++) {
        const char* tagname = LogTag::name(tag);
        double score = StringUtils::similarity(tagname, strlen(tagname), str, len);
        if (score >= best) {
            match = tag;
            best = score;
        }
    }
    return match;
}
```

**设计理由**：
1. **添加新标签只需改一行** — 在 `LOG_TAG_LIST` 中加 `LOG_TAG(newtag)`，枚举、字符串数组、`Count` 全部自动更新
2. **消除手动同步错误** — 如果不用 X-MACRO，需要同时维护枚举定义、switch-case、字符串数组三个地方，容易不一致
3. **编译期验证** — 如果 LOG_TAG 展开在某个位置不正确会导致编译错误，而不是运行时异常

> **X-MACRO 的调试困境**：当 `fuzzy_match("aloc")` 匹配到 `alloc` 而非预期的 `aloc` 时，问题不在运行时代码——它在预处理器展开阶段就已经确定。用 `g++ -E` 查看预处理输出可以看到展开后的完整枚举和字符串数组，这是调试 X-MACRO 相关 bug 的最有效方法。

### 5.2 VM_OPS_DO — 虚拟机操作枚举

VM_Operation 是 VMThread 执行的操作列表，同样使用 X-MACRO 模式：

**列表定义** (`vmOperations.hpp:48-133`)：

```cpp
#define VM_OPS_DO(template)                       \
  template(Dummy)                                 \
  template(ThreadStop)                            \
  template(ThreadDump)                            \
  template(FindDeadlocks)                         \
  // ... 60+ 操作 ...
  template(Exit)
```

**展开为枚举** (`vmOperations.hpp:143-146`)：

```cpp
enum VMOp_Type {
    VM_OPS_DO(VM_OP_ENUM)   // 展开为: VMOp_Dummy, VMOp_ThreadStop, ...
    VMOp_Terminating
};

// 其中 VM_OP_ENUM 定义为：
#define VM_OP_ENUM(type)   VMOp_##type,
```

**设计理由**：
- `VM_OPS_DO` 还可以在其他地方展开为 `switch-case`（分发操作执行器）、`print` 函数（调试输出操作名）
- 添加新 VM 操作时，只需在 `VM_OPS_DO` 中加一行，所有展开点自动同步

---

## 0.6 虚函数与多态

### 6.0 CodeBlob 家族 — 三层继承，运行时类型识别

HotSpot 的 CodeBlob 类族展示了经典 OOP 模式在性能敏感场景中的应用：

```
CodeBlob (codeBlob.hpp:86) — 所有代码块的基类
  │  _type, _size, _code_begin, _code_end, _oop_maps
  │  virtual is_nmethod() = false
  │  virtual flush()
  │
  ├── CompiledMethod (compiledMethod.hpp:134) — JIT 编译的方法
  │     _method, _deopt_handler_begin, _pc_desc_container
  │     override is_compiled() = true
  │     virtual flush() = 0
  │
  └── nmethod (nmethod.hpp:55) — 最完整的具体实现
        _entry_point, _verified_entry_point, _osr_entry_point
        _state (not_installed/in_use/not_entrant/zombie/unloaded)
        override is_nmethod() = true
```

**关键代码** (`codeBlob.hpp:128-139`)：

```cpp
// 所有类型检查都是虚函数 — CodeCache 遍历时使用
virtual bool is_buffer_blob() const            { return false; }
virtual bool is_nmethod() const                { return false; }
virtual bool is_runtime_stub() const           { return false; }
virtual bool is_deoptimization_stub() const    { return false; }
// ... 10+ is_* 虚函数
```

**类型识别模式** — 每个子类只重写其对应的方法返回 `true`，所有其他方法继承默认的 `false`。这比 `dynamic_cast` 快（只需要一次 vtable 间接跳转，不涉及 RTTI），而且不依赖编译器 RTTI 支持（HotSpot 编译时关闭了 RTTI 以减小二进制体积）。

**安全向下转换** (`codeBlob.hpp:147-151`)：

```cpp
// 所有转换都经过 is_* 虚函数验证：
nmethod* as_nmethod_or_null() { return is_nmethod() ? (nmethod*) this : NULL; }
nmethod* as_nmethod()         { assert(is_nmethod(), "must be nmethod"); return (nmethod*) this; }
CompiledMethod* as_compiled_method_or_null() { return is_compiled() ? (CompiledMethod*) this : NULL; }
```

### 6.1 outputStream — 六层继承 + 单一虚函数

`outputStream` 是输出系统的核心抽象层次：

```
outputStream (基类)
  │  virtual void write(const char* s, size_t len) = 0;
  │
  ├── stringStream — 写入内存中的字符串缓冲区
  ├── fileStream — 写入文件
  ├── bufferedStream — 带缓冲的包装
  ├── networkStream — 网络 socket 输出
  ├── ttyStream — stdout/stderr 输出
  └── logStream — 写入 UL（统一日志）框架
```

**设计特点**：整个继承树只有一个纯虚函数 `write()`。所有格式化（`print_cr`、`print_raw`、`print`、格式化字符串）都在基类的非虚函数中实现，通过调用 `write()` 这一单一虚函数完成多态。这是典型的 **Template Method 模式** —— 骨架在基类，具体输出操作由子类实现。

### 6.2 vtable 的成本与 HotSpot 的策略

vtable 调用有两层开销：
1. **指针间接访问** — `obj->vtable[slot]()` 两次内存读取（读 vptr → 读 vtable → 跳转）
2. **无法内联** — 虚函数阻止了编译器将所有调用点内联优化

HotSpot 的应对策略：

| 策略 | 在哪用 | 原理 |
|------|--------|------|
| **CRTP 替代 vtable** | `Hashtable<T,F>` | 模板参数在编译期确定类型，无需运行时多态 |
| **is_* 虚函数 + static_cast** | `CodeBlob` | 比 `dynamic_cast` 快，不需要 RTTI |
| **少量虚函数** | `outputStream` | 只有 `write()` 虚函数，避免大面积间接调用 |
| **inline + devirtualization** | 大多数热路径 | 编译器能证明具体类型时，虚函数退化为直接调用 |

---

## 0.7 RAII 的四种面孔

HotSpot 将 RAII 发挥到极致，**所有需要配对的 acquire/release 操作都封装为 RAII 对象**。这节展示四种最常见的模式。

### 7.0 总览

```
RAII 对象              构造做什么              析构做什么              为什么需要
───────────────────────────────────────────────────────────────────────
MutexLocker            加锁                    解锁                    防止死锁/忘记解锁
ThreadBlockInVM        声明线程 blocked         恢复 _thread_in_vm     必须与 GC safepoint 协作
ResourceMark           保存 Arena 状态          回滚 Arena hwm/chunk   防止 OOM/释放临时数据
HandleMark             保存 Handle Area 状态    回滚 Handle Area       GC 安全——保护 OOP 引用
```

### 7.1 MutexLocker — 锁管理的 RAII

**关键代码** (`mutexLocker.hpp:182-205`)：

```cpp
class MutexLocker: StackObj {
    Monitor * _mutex;
public:
    MutexLocker(Monitor * mutex) {
        assert(mutex->rank() != Mutex::special, "Special ranked mutex should only use MutexLockerEx");
        _mutex = mutex;
        _mutex->lock();                    // ★ 构造时加锁
    }

    ~MutexLocker() {
        _mutex->unlock();                  // ★ 析构时解锁
    }
};
```

**锁等级（rank）系统** — HotSpot 的 `Mutex` 有一个 `rank()` 断言机制：每个锁有一个数字等级，低等级锁持有期间不能获取高等级锁。`MutexLocker` 在构造时断言 `rank != special`，防止将特殊等级的锁用于普通 RAII 模式。

**变体 MutexLockerEx** (`mutexLocker.hpp:223`) — 支持 `NULL` mutex（no-op）、支持 `lock_without_safepoint_check()`（不触发安全点检查的加锁）。这两个变体覆盖了锁使用的全部场景。

**典型用法**：

```cpp
void SymbolTable::add(Symbol* sym) {
    MutexLocker ml(SymbolTable_lock, Thread::current());
    // 锁定期间的操作...
}   // ★ 无论函数如何退出（return/异常/goto），ml 析构保证解锁
```

> **Rank 死锁风险**：HotSpot 的 Mutex 有严格的 rank 等级系统。如果你持有一个 rank=5 的锁再尝试获取 rank=3 的锁，`MutexLocker` 构造时的 `assert` 会触发崩溃。这防止了经典的"锁顺序反转死锁"——但这种保护只在 DEBUG 构建中生效。在 RELEASE 构建中，rank 检查被编译移除，死锁将以"整个 VM 无响应"的形式表现，只能用 `kill -3 <pid>` 获取线程 dump（查阅 `man 2 kill` 信号）来诊断。

### 7.2 ThreadBlockInVM — 线程状态的 RAII

**关键代码** (`interfaceSupport.inline.hpp:297-309`)：

```cpp
class ThreadBlockInVM : public ThreadStateTransition {
public:
    ThreadBlockInVM(JavaThread *thread) : ThreadStateTransition(thread) {
        thread->frame_anchor()->make_walkable(thread);  // ★ 确保栈可被 GC 遍历
        trans_and_fence(_thread_in_vm, _thread_blocked); // ★ 状态转换 + 内存屏障
    }
    ~ThreadBlockInVM() {
        trans_and_fence(_thread_blocked, _thread_in_vm); // ★ 恢复到 _thread_in_vm
    }
};
```

**三种关键线程状态**：

```
_thread_in_Java      ← 正在执行 Java 字节码
_thread_in_vm        ← 正在执行 VM C++ 代码（持有 VM 内部结构）
_thread_in_native    ← 正在执行 JNI native 代码
_thread_blocked      ← 在 VM 中阻塞（等待锁/IO）
```

**为什么需要 RAII？** 线程状态转换必须与 GC safepoint 协作。如果在 `_thread_in_vm` 状态执行一个可能阻塞的操作（如 IO），GC 无法对该线程进行 safepoint（因为线程"在 VM 中"被认为可能持有内部锁），导致整个 VM 卡住。`ThreadBlockInVM` 的 RAII 确保：
1. 进入阻塞状态前，栈被标记为 walkable（GC 可以扫描其局部变量中找到的 OOP 引用）
2. 退出阻塞状态时自动恢复到 `_thread_in_vm`

**完整的状态转换家族** (`interfaceSupport.inline.hpp`)：

| RAII 类 | 进入状态 | 离开状态 | 典型使用场景 |
|---------|---------|---------|------------|
| `ThreadInVMfromJava` | `_thread_in_vm` | `_thread_in_Java` | JNI 入口 |
| `ThreadInVMfromNative` | `_thread_in_vm` | `_thread_in_native` | JNI 回调 |
| `ThreadBlockInVM` | `_thread_blocked` | `_thread_in_vm` | VM 中阻塞等待 |
| `ThreadToNativeFromVM` | `_thread_in_native` | `_thread_in_vm` | 调用 native 代码 |
| `ThreadInVMfromJavaNoAsyncException` | `_thread_in_vm` | `_thread_in_Java` | 禁止异步异常的关键路径 |

### 7.3 ResourceMark — 内存管理的 RAII（第 0.2.3 节已详述）

### 7.4 HandleMark — GC 安全引用的 RAII

Java 对象在 GC 过程中可能被移动（copying GC）。`Handle` 机制通过追踪所有到 OOP 的 C++ 引用，使 GC 能更新这些引用。`HandleMark` 管理 Handle 的批量生命周期。

**关键代码** (`handles.hpp:240-270`)：

```cpp
class HandleMark {
    Thread *_thread;
    HandleArea *_area;     // 保存的 handle area
    Chunk *_chunk;         // 保存的 arena chunk
    char *_hwm, *_max;     // 保存的水位
    HandleMark* _previous_handle_mark; // 链到前一个 HandleMark

    void initialize(Thread* thread);    // 保存当前状态
    ~HandleMark();                       // 恢复保存的状态
};
```

**与 ResourceMark 的区别**：
- `ResourceMark` 管理**任意临时 C++ 对象**的内存 — `Amalloc` 分配的数据
- `HandleMark` 管理**Handle（OOP 引用）** 的内存 — Handle 存储在专门的 `HandleArea` 中

**为什么需要两个 Mark？** Handle 的生命周期比一般临时对象长——它们在 JNI 边界、VM 入口、异常处理等场景中存活。分离两个 Arena 允许独立控制回收策略。

### 7.5 RAII 设计原则总结

HotSpot 中所有 RAII 模式遵循相同的设计模板：
1. **继承 StackObj** — 禁止 `new`/`delete`（`allocation.hpp:220-229`），强制栈上分配
2. **构造函数保存状态** — 当前值保存到成员变量
3. **析构函数恢复状态** — 即使异常/提前返回也保证恢复
4. **可嵌套** — `_nesting` 计数器 + `_previous` 链接支持嵌套作用域

> **对读者的提问**：如果有 3 层嵌套的 `ResourceMark`，最内层分配的对象能在最外层 `ResourceMark` 析构后继续使用吗？为什么？
>
> **嵌套 ResourceMark 的内存竞争场景**：考虑以下调用链——函数 A 创建 `ResourceMark rmA`，在其内调用函数 B，函数 B 创建 `ResourceMark rmB` 并分配大量临时数据，然后将其中一个指针返回给 A。此时 `rmB` 析构，Arena 回滚到 B 的进入点，但 A 仍持有那个指针。这个指针现在指向已释放的内存（或已被 `ZapResourceArea` 填充的垃圾字节）。这是 HotSpot 中最常见的内存错误模式之一——**跨 ResourceMark 边界的指针传递**。`HandleMark` 严格禁止跨边界传递 Handle 引用（`handles.hpp:235`），但 `ResourceMark` 没有这种静态检查——完全依赖开发者的纪律。

---

## 0.8 编译期计算

### 8.1 exact_log2 — 编译期已知结果的幂次对数

**关键代码** (`globalDefinitions.hpp:1154-1157`)：

```cpp
// 参数必须恰好是 2 的幂次
inline int exact_log2(intptr_t x) {
    assert(is_power_of_2(x), "x must be a power of 2: " INTPTR_FORMAT, x);
    return log2_intptr(x);  // 在 x86 上使用 BSR 指令（Bit Scan Reverse）
}
```

`exact_log2` 接受一个**在编译期或运行期为确定值的 2 的幂次**，返回其对数。
- `exact_log2(8)` → `3`
- `exact_log2(4096)` → `12`
- 当参数为编译期常量时，GCC/Clang 会在**编译期计算**结果，零运行时开销

**使用场景**：位图操作、哈希表大小计算、内存对齐。例如 `exact_log2(BitsPerWord)` 在 `bitMap.hpp` 中用于将 bit 索引转换为 word 索引。

### 8.2 align_up / align_down — 零分支对齐

**关键代码** (`align.hpp:43-45,58-64`)：

```cpp
// 宏版本 — 可在 enum/常量表达式中使用（编译期）
#define align_mask(alignment) ((alignment) - 1)
#define align_down_(size, alignment) ((size) & ~align_mask_widened((alignment), (size)))
#define align_up_(size, alignment)   (align_down_((size) + align_mask(alignment), (alignment)))

// 函数模板版本 — 带类型安全和运行时断言
template <typename T, typename A>
inline T align_up(T size, A alignment) {
    assert(is_power_of_2_t(alignment), "must be a power of 2");  // 运行时检查
    T ret = align_up_(size, alignment);
    return ret;
}
```

**工作原理**（以 `alignment = 16` 为例）：

```
align_up(13, 16):
  13 + (16-1) = 13 + 15 = 28
  28 & ~(10-1) = 28 & 0xFFF0 = 16  ✓

align_up(16, 16):
  16 + 15 = 31
  31 & 0xFFF0 = 16  ✓  (已对齐则不增加)

align_down(19, 16):
  19 & 0xFFF0 = 16  ✓
```

**设计特点**：
- **宏版本 `align_up_`** 可在需要编译期常量表达式的地方使用（如 `enum`、数组大小声明）
- **函数模板版本 `align_up`** 有运行时断言验证对齐是 2 的幂，防止不正确的对齐值
- `align_mask_widened()` 宏解决了符号扩展问题：当 `alignment` 是 `unsigned int` 而 `size` 是 `intptr_t` 时，取反 `~(alignment-1)` 会产生零填充而非符号扩展，导致高位失效。`widen_to_type_of` 将掩码扩展到正确宽度

**使用场景遍布整个 HotSpot** (`bitMap.hpp:199-203`, `copy.hpp:209`, `stack.inline.hpp:98`)：

```cpp
// 将位索引对齐到 word 边界
static idx_t word_align_up(idx_t bit)    { return align_up(bit, BitsPerWord); }
static idx_t word_align_down(idx_t bit)  { return align_down(bit, BitsPerWord); }

// 将字节数对齐到 HeapWord 大小
size_t count = align_up(byte_count, HeapWordSize) >> LogHeapWordSize;
```

### 8.3 页面对齐的 clamp_address_in_page

**关键代码** (`align.hpp:138-150`)：

```cpp
template <typename T>
inline T* clamp_address_in_page(T* addr, T* page_address, size_t page_size) {
    if (align_down(addr, page_size) == align_down(page_address, page_size)) {
        return addr;                              // 地址在同一页，直接返回
    } else if (addr > page_address) {
        return align_down(page_address, page_size) + page_size; // 在页面之后，返回下一页起始
    } else {
        return align_down(page_address, page_size);             // 在页面之前，返回当前页起始
    }
}
```

这个函数将任意地址 clamp 到特定页面范围内，用于 Metaspace 中判断一个对象是否位于共享只读内存区域。

### 8.4 小结：HotSpot 的编译期计算策略

| 机制 | 工具 | 使用场景 |
|------|------|---------|
| 2的幂对数 | `exact_log2` | 位图 word 索引、哈希取模 |
| 对齐计算 | `align_up` / `align_down` 宏+模板 | 对象对齐、代码偏移、页面边界 |
| 常量表达式 | `align_mask` 宏 | enum 中的对齐常量 |
| 类型安全对齐 | `align_up<T,A>` 函数模板 | 带运行时断言的通用对齐 |

---

## 小结

本章从 **8 个维度** 揭示了 HotSpot 中"非标准" C++ 模式的方法论：

| 维度 | HotSpot 做法 | 核心动机 |
|------|-------------|---------|
| **容器** | 自研 GrowableArray / Hashtable / ConcurrentHashTable | 正交分离存储策略、类型、内存追踪 |
| **分配器** | Arena bump-pointer + ResourceMark 批量回滚 | O(1) 批量回收 > 逐个 free |
| **多态** | 少量虚函数 + CRTP 静态多态 | 避免 vtable 开销，关闭 RTTI |
| **RAII** | 四种面孔：锁/线程状态/内存/GC引用 | 保证异常安全，与 GC safepoint 协作 |
| **placement new** | 在 CodeCache/Metaspace/Arena 上构造对象 | 内存来源非 glibc 堆，需跳过 `malloc` |
| **X-MACRO** | 一次定义、多次展开生成枚举+字符串+switch | 消除手动同步错误 |
| **编译期计算** | exact_log2 + align_up/down 模板 | 零运行时分支开销 |
| **类型擦除** | GenericGrowableArray + 模板壳 | 减少模板代码膨胀 |

**这一章的知识将在后续所有章节中反复出现**。当你看到 `ResourceMark rm;` 时，你应该立刻意识到：以下所有分配将被批量回收。当你看到 `new (arena) Foo()` 时，你应该知道：Foo 不来自堆，来自一个 bump-pointer 分配器。当你看到 `LOG_TAG_LIST` 时，你应该明白：这不是简单的预处理——这是一个可重新解释的代码生成矩阵。

---

> **章末练习**：
> 1. 阅读 `src/hotspot/share/memory/arena.cpp:255-268` 中 Arena 构造函数的两种重载，解释 `slack=40` 为什么是 `_LP64` 平台特定的？
> 2. 阅读 `src/hotspot/share/memory/resourceArea.hpp:129-147` 中的 `reset_to_mark()`，解释 `ZapResourceArea` 参数的作用？
> 3. 阅读 `src/hotspot/share/runtime/vmOperations.hpp:143-146`，如果你需要在 VM_OPS_DO 中新增一个 `template(RebiasAll)`，需要修改哪些地方？
> 4. 为什么 `HandleMark` 没有继承 `StackObj`（阅读 `handles.hpp:237-238` 注释）？
