# 前置概念：OopStorage —— 不绑 HandleMark 的 oop 槽位池

> **本文定位**：背景知识文章。你要理解的是 `universe_init` Line 692 创建的那个叫 "VM Weak Oop Handles" 的 OopStorage 实例。SystemDictionary 用它存 class loader 的 oop 引用——这些引用需要活到 JVM 关闭，但 Handle 活不过函数调用栈。
>
> 本文从设计推演出发——如果你来设计这个容器，你会怎么做？每一步都是"最简单的方案为什么不行，下一步怎么修"。
>
> **前置依赖**：Handle 的机制见 [ch03/background/handles-all.md](../../ch03/background/handles-all.md)。

---

## 1. SystemDictionary 有个需要永远记住的地址

`AppClassLoader` 是一个 Java 对象，存在堆上。SystemDictionary 需要随时知道它在哪。

先不想 OopStorage——如果你是 HotSpot 的开发者，你会怎么写？最朴素的想法——声明一个 `static` 字段：

```cpp
// 假想代码——SystemDictionary 里实际没有这个字段，是 OopStorage 在管
static oop _java_system_loader;
```

`oop` = `oopDesc*`——指向堆上 Java 对象头的 C++ 裸指针（4 或 8 字节）。没有 GC 时，没问题。

但 GC 发生了。G1 把 Eden 的活对象拷到 Survivor 区——对象的物理地址变了。ParallelGC 把 Old 区的活对象压缩到一起消碎片——物理地址又变了。`_java_system_loader` 还指着旧地址。

```
GC 前：_java_system_loader = 0x7fdc01000000 → AppClassLoader 对象
GC 后：AppClassLoader 被移到 0x7fdc02000000
       _java_system_loader 仍是 0x7fdc01000000 → 野指针！
```

**为什么 GC 不更新它？** GC 只更新它"知道"的那些指针——线程栈上的局部变量、JNI 句柄块里的、HandleArea 上的。`_java_system_loader` 是一个普通的 C++ `static` 变量——GC 不知道它存在。

**那用 Handle 呢？** Handle 把 oop 存进线程 HandleArea 的槽位。GC 扫描 HandleArea 时更新槽位。Handle 只存槽位地址——永远通过 `*_handle` 间接读——拿到最新值。

```
裸 oop:   _java_system_loader → [AppClassLoader]  ← GC 移动后悬空
Handle:   Handle → 槽位(oop*)  → [AppClassLoader]  ← GC 更新槽位，安全
```

（Handle/HandleArea/HandleMark 机制见 [ch03/background/handles-all.md](../../ch03/background/handles-all.md)）

但 HandleArea 是 Arena（栈式分配器）。HandleMark 构造时记录当前水位，析构时回滚——HandleMark 期间分配的所有槽位全部回收。

```cpp
HandleMark hm;
Handle obj(thread, some_oop);   // 从 Arena 分配槽位
// ... 函数体 ...
// hm 析构 → Arena 回滚 → obj 的槽位没了！
```

一个 `static` 字段不存在于任何 HandleMark 作用域——它需要永久存活。

**需要什么：** GC 能扫描到（像 HandleArea），但生命周期不受 HandleMark 限制（不像 HandleArea）。OopStorage 就是这个容器。

| | GC 知道在哪吗 | 活多久 |
|---|---|---|
| 裸 `static oop` | 不知道 | 永久（但不安全） |
| Handle | 知道（扫描 HandleArea） | 当前 HandleMark 作用域 |
| **需要的** | 知道 | 手动控制 |

---

## 2. 先不管内部实现——想接口

你需要一个地方把 oop 放进去，GC 帮你更新。接口很直观：

```cpp
oop* slot = storage->allocate();   // 给我一个槽位地址
*slot = my_oop;                      // 写入 oop
// ... 任意长时间，GC 发生多次 ...
storage->release(slot);            // 还回去
```

`allocate` 返回的是一个 `oop*`——一个指针的指针。你在上面写 `*slot = class_loader_oop`——把 class loader 的堆地址存进去。GC 调用 `oops_do` 遍历所有分配出去的槽位，更新里面的 oop。

和 Handle 的区别：这里没有 HandleMark。槽位的生命周期由 `allocate` / `release` 控制。GC 同样知道怎么找到这些槽位。

方向是对的。在进入内部实现之前，先看一眼 OopStorage 对象本身长什么样——它有哪些字段，这些字段做什么用。内部实现（Block、链表、数组）是后面展开的内容，这里只需要知道大致的分工。

```
OopStorage 对象:
  _name = "VM Weak Oop Handles"

  _active_array ──→ Block*[]          所有 Block 的主索引，GC 遍历入口（第 5.4 节）
  _allocation_list ──→ 双向链表       非满 Block 的池，allocate 从这里取（第 5.1 节）
  _deferred_updates ──→ 单向链表      状态变更的 Block，release 推入、持锁消费（第 5.2 节）

  _allocation_mutex ──→ 锁           保护 allocation_list 和 Block 创建
  _active_mutex ──→ 锁               保护 _active_array 扩容和空 Block 删除
  _allocation_count ──→ 计数器       当前已分配但未释放的 slot 数量（volatile，原子操作）
  _protect_active ──→ SingleWriterSynchronizer  _active_array 扩容时保护旧指针数组不被过早删除（第 5.5 节）
  _concurrent_iteration_active ──→ bool  并发遍历标记，防删空 Block 与并行 GC 冲突
```

`_name` 是一个标识字符串。`_allocation_count` 是每次 allocate 时 `Atomic::inc`、release 时 `Atomic::dec` 的全局计数——用原子操作保证并发安全，不需要锁。GC 通过 `_active_array` 找到所有 Block 遍历。

下面从最简单的内部实现开始——怎么管理这些 oop 槽位。

---

## 3. 版本 1：逐槽 malloc

```cpp
oop* allocate() {
    oop* slot = (oop*)malloc(sizeof(oop));  // 8 字节
    *slot = NULL;
    return slot;
}
void release(oop* slot) {
    free(slot);
}
```

写起来简单。但如果你需要 10 个槽位——就是 10 次 `malloc(8)`。这 10 个 8 字节的块散落在堆的各处——没有统一的位置让你快速知道"哪个槽还是空闲的"。你想知道哪个 slot 可以用——需要 O(n) 遍历所有已分配槽位。

而且 `free` 之后留一个小洞——长时间运行，碎片越来越严重。

**版本 1 结论：行不通。需要打包管理。**

---

## 4. 版本 2：64 个槽一次分配——Block

### 4.1 思路

不要逐槽 `malloc`。一次 `malloc` 一大块内存，里面预切 64 个 `oop*` 大小的槽。用 64 个 bit 标记每个槽是否被占用——1 表示已占，0 表示空闲。找空闲槽时，把掩码取反，用 CPU 指令 `CTZ`（Count Trailing Zeros）找最低位 1 的位置——O(1)，一条指令完成。这块内存就是 Block。

### 4.2 为什么是 64 个槽

64 位 CPU 上一次原子操作的操作宽度是 64 位（一个 CPU word）。`uintx` 恰好是 64 位。用一个 `uintx` 变量存 64 个槽的占用状态——对这个变量的读、写、CAS 都天然是原子操作，不需要锁。

```
_allocated_bitmask (uintx = 64 bit):
  bit[0] → slot[0]    1 = 已占用   0 = 空闲
  bit[1] → slot[1]
  bit[2] → slot[2]
  ...
  bit[63] → slot[63]

例：_allocated_bitmask = 0b000...00101 (前面 60 个 0)
  slot[0] → 已占 (bit 0 = 1)
  slot[1] → 空闲 (bit 1 = 0)
  slot[2] → 已占 (bit 2 = 1)
  slot[3 ~ 63] → 空闲
```

### 4.3 Block 的物理布局和构造

Block 从 C Heap 分配。`oopStorage.cpp:316`：

```cpp
size_t OopStorage::Block::allocation_size() {
    return sizeof(Block) + block_alignment - sizeof(void*);
}
```

这一行算的不是对齐——算的是"malloc 要多少字节"。Block 约 576 字节，`allocation_size = 576 + 64 - 8 = 632`。多出的 56 字节是对齐余量。

拿内存边界 `[0, 64, 128, ...]` 来举例——假设 malloc 返回了地址 8（8 字节对齐，但对不齐 64）。`align_up` 往上跳到下一个 64 字节边界——8 → 64。8 到 64 这 56 字节被浪费了，Block 从 64 开始：

```
malloc(632) → 地址 8
align_up(8, 64) → 地址 64
地址 8 ~ 63: 浪费 56 字节
地址 64 ~ 639: Block 实体 576 字节
= 632 字节刚好用完
```

但 free 的时候必须传原始指针 8，不能传 64——`free(64)` 会因为地址不对齐 malloc 的内部记账而崩溃。所以 Block 把 `memory = 8` 存在 `_memory` 字段里。`delete_block` 用 `_memory` 来 free——56 字节浪费段也一并归还了。

```cpp
OopStorage::Block* OopStorage::Block::new_block(const OopStorage* owner) {
    size_t size_needed = allocation_size();                      // 先算大小
    void* memory = NEW_C_HEAP_ARRAY_RETURN_NULL(char, size_needed, mtGC); // malloc
    void* block_mem = align_up(memory, block_alignment);         // 在对齐后的地址
    return ::new (block_mem) Block(owner, memory);               // placement new
}
```

**为什么需要 `align_up`，为什么 `allocation_size` 要减 `sizeof(void*)`**

`malloc` 只保证 `sizeof(void*) = 8` 字节对齐，但 Block 需要 64 字节对齐。`align_up` 把地址向上取整到下一个 64 字节边界。malloc 返回值只能是 0、8、16...56 之一（8 的倍数）——从这个值跳到下一个 64 字节边界（0→0、8→64、16→64...56→64），跳跃距离最大 56（返回 8 时），最小 0（返回 0 时刚好对齐）。这 56 字节 = block_alignment(64) - sizeof(void*)(8)——`allocation_size` 多分配了这个余量。

**`::new (block_mem) Block(owner, memory)` 是 placement new——** 不重新分配内存，直接在 `block_mem` 地址上构造 Block。第二个参数 `memory` 是原始 malloc 返回的指针（不是 `block_mem`）——被存在 `_memory` 字段里。后续 `delete_block` 需要原始指针来 `free`。

构造函数（`oopStorage.cpp:206`）：

```cpp
OopStorage::Block::Block(const OopStorage* owner, void* memory) :
    _data(),                      // oop[64]，全部 NULL
    _allocated_bitmask(0),        // uintx = 64位。bit=1→已占
    _owner(owner),                // 反指所属 OopStorage
    _memory(memory),              // 原始未对齐 malloc 指针（供后续 free）
    _active_index(0),             // 在 ActiveArray（Block* 数组）中的索引
    _allocation_list_entry(),     // 嵌入式双向链表节点（第 5.1 节详讲）
    _deferred_updates_next(NULL), // 延迟更新链表指针（第 5.2 节详讲）
    _release_refcount(0)          // 释放保护计数
{
    STATIC_ASSERT(_data_pos == 0);                           // 编译期：_data 是第 1 个成员
    STATIC_ASSERT(section_size * section_count == ARRAY_SIZE(_data)); // 8×8=64
    assert(offset_of(Block, _data) == _data_pos, "invariant");
    assert(owner != NULL, "NULL owner");
    assert(is_aligned(this, block_alignment));               // 必须 64 字节对齐
}
```

8 个字段各司其职。`_data`（64 个 oop 槽位）+ `_allocated_bitmask`（64 位占用表）是 Block 的核心功能。剩下 6 个字段管理 Block 之间的关系：

- `_allocation_list_entry`：双向链表节点（`_prev`/`_next`），挂到 `_allocation_list` 上（第 5.1 节）
- `_deferred_updates_next`：单向链表指针，挂到 `_deferred_updates` 上（第 5.2 节）。每个 Block 同时嵌入两个独立链表——可分配池 + 延迟处理队列
- `_active_index`：在 `_active_array` 中的位置索引（第 5.4 节）
- `_release_refcount`：保护计数。有线程正在释放时 `is_deletable()` 检查此字段必须为 0

### 4.4 分配一个 slot

`oopStorage.cpp:301`：

```cpp
oop* OopStorage::Block::allocate() {
    uintx allocated = _allocated_bitmask;                    // ① 读掩码
    while (true) {
        unsigned index = count_trailing_zeros(~allocated);   // ② CTZ 找空闲位
        uintx new_value = allocated | bitmask_for_index(index); // ③ 目标 bit 置 1
        uintx fetched = Atomic::cmpxchg(new_value,           // ④ CAS 提交
                                        &_allocated_bitmask, allocated);
        if (fetched == allocated) return &_data[index];      // ⑤ 成功
        allocated = fetched;                                  // ⑥ 重试
    }
}
```

**走一个例子。** 掩码 `allocated = 0b00101`（slot[0] 和 slot[2] 已占，十进制 5）。

① `allocated = 0b00101`

② `~0b00101 = 0b11010`。CTZ = 1（bit 1 是第一个空闲位）。slot[1] 空闲。

③ `bitmask_for_index(1) = 0b00010`。`new_value = 0b00101 | 0b00010 = 0b00111`。

④ `cmpxchg(0b00111, &_allocated_bitmask, 0b00101)`。如果掩码还是 0b00101，写入 0b00111。

⑤ 返回 `0b00101` = 成功 → 返回 `&_data[1]`。

⑥ 返回 `0b00111≠0b00101` = 另一个线程抢先了（比如把 slot[3] 占了）。新值 0b00111 存到 allocated，重试。`~0b00111 = 0b11000`。CTZ = 3。slot[3] 空闲。

**为什么是 CAS 不是 `|=`？** `|=` 不是原子的——它分解为"读 → 改 → 写"三步。释放线程也在并发操作同一个 `_allocated_bitmask`。如果 allocate 用 `|=`：

```
t1: Thread A (allocate) 读出 _allocated_bitmask = 0b00101    (slot[0]和[2]已占)
t2: Thread B (release)  CAS 把 slot[0] 清零 → 0b00100        (读同一份掩码，成功)
t3: Thread A (allocate) 基于 t1 的拷贝做 |= 0b00010 → 写入 0b00111

结果: _allocated_bitmask = 0b00111
bit[0]=1 → slot[0] 仍被标记"已占"——但 B 在 t2 已经释放了它！
→ slot[0] 永远收不回来——槽位泄漏
```

A 在 t1 读到的拷贝里 bit[0]=1。B 在 t2 改完了掩码。但 A 在 t3 写的还是 t1 的旧拷贝——`|=` 把 bit[0]=1 又写回去了，**覆盖了 B 的释放**。CAS 不会——写入前先校验"掩码现在还是我的那份拷贝吗？"，不是就重读。

---

## 5. 一个 Block 不够——三种组织方式

Block 只有 64 个槽。需要更多槽时——创建更多 Block。三个数据结构分别负责：**找到可分配 Block**、**推迟状态变更**、**GC 遍历入口**。

---

### 5.1 `_allocation_list`——双向链表，串起可分配的 Block

`allocation_list` 是一个双向链表，串起所有**非满**的 Block（还有空闲 slot 可以分配）。Block 的 `_allocation_list_entry` 字段是嵌入式的链表节点——`_prev` 和 `_next` 两个指针直接在 Block 体内，不额外分配内存。

注意区分：`_allocation_list` 不是 Block 的"主索引"——Block 从这上面 unlink 了（满了或被删了），它还在 `_active_array` 里。`_allocation_list` 只是"哪些 Block 还有空位可分配"的工作链表。

```
_allocation_list:
  Block_A ←──→ Block_B ←──→ Block_C
 [3/64占]   [15/64占]   [62/64占]

- head() → Block_A：分配时从链表头取
- push_back(block)：新 Block 加入链表尾部——优先消耗已有的非满 Block
- unlink(block)：Block 满了，从链表摘除；Block 空->要删，也摘除
```

操作 `push_back`（`oopStorage.cpp:74`）：

```cpp
void OopStorage::AllocationList::push_back(const Block& block) {
    const Block* old = _tail;
    if (old == NULL) {
        _head = _tail = &block;                              // 空链表→首元素
    } else {
        old->allocation_list_entry()._next = &block;         // 旧尾.next = 新块
        block.allocation_list_entry()._prev = old;           // 新块.prev = 旧尾
        _tail = &block;                                      // 更新尾指针
    }
}
```

操作 `unlink`（`oopStorage.cpp:86`）——在链表中间摘除一个节点：

```cpp
void OopStorage::AllocationList::unlink(const Block& block) {
    const AllocationListEntry& entry = block.allocation_list_entry();  // Block 体内嵌入的链表节点
    const Block* prev_blk = entry._prev;     // 前一个 Block
    const Block* next_blk = entry._next;     // 后一个 Block
    if (prev_blk != NULL) prev_blk->allocation_list_entry()._next = next_blk;  // 前驱.next = 后继
    if (next_blk != NULL) next_blk->allocation_list_entry()._prev = prev_blk;  // 后继.prev = 前驱
    if (_head == &block) _head = next_blk;   // 摘除的是头→更新头
    if (_tail == &block) _tail = prev_blk;   // 摘除的是尾→更新尾
    entry._prev = entry._next = NULL;        // 清除摘除节点的指针
}
```

**需要 `_allocation_mutex` 保护。** push_back、unlink 都不是线程安全的——多个线程同时改链表指针会损坏结构。

---

### 5.2 `_deferred_updates`——单向链表，推迟状态变更

释放 slot 后，Block 状态可能变了。比如你释放了满 Block 的一个 slot——这个 Block 从"满的"变成"还有空位"——应该被加回 `_allocation_list` 让 allocate 使用。

但释放线程不能自己去改 `_allocation_list`。`_allocation_list` 是一个双向链表——它的 `push_back` 和 `unlink` 要同时改 `_head`、`_tail`、前驱的 `_next`、后继的 `_prev` 四个指针。如果释放线程（没锁）和 allocate 线程（有锁）同时改这四个指针——链表就断了。分配线程以"我持有锁所以没人跟我抢"的假设在操作链表，但释放线程没锁也在操作——两条写入互相覆盖。所以规则是：**只有持 `_allocation_mutex` 的线程才能改 `_allocation_list`。**

`OopStorage::release()` 全程没有 `MutexLocker`——它不持这个锁。所以它不能改 `_allocation_list`。所以释放线程只做一件事：把 Block 推到一个单独的延迟链表上。稍后持锁线程来消费。这就叫 `_deferred_updates`。

这个链表就是一个单向链表——`_deferred_updates` 是头指针，初始值为 `NULL`（空链表）。没有伪节点、没有预分配的空 Block。每个 Block 通过自己的 `_deferred_updates_next` 字段串起来：

```
_deferred_updates:
  Block_X → Block_Y → Block_Z → NULL
 [变空了]   [从满→非满]  [从满→非满]
```

**谁 push？** 释放线程。释放 slot (无锁) → 清 bitmask → 发现 Block 状态变了（满→非满，或非空→全空）→ 通过 CAS 把 Block 推到链表头。不需要锁，一次原子操作完成。

**谁 pop？** 持锁线程。当 allocate 需要分配 slot、或 delete_empty_blocks 需要清理时，调 `reduce_deferred_updates()`（必须持 `_allocation_mutex`）。一次 CAS pop 一个 Block，读它的 bitmask，做相应的 `_allocation_list` 修改——满变非满则 push_front 挂回去，空了则移到尾部等删除。

为什么 push 不需要锁但 pop 需要？push 只改单向链表的头指针——一条 CAS 指令完成。pop 之后要改 `_allocation_list`（push_back、unlink）——这些操作需要锁。

---

### 5.3 `_deferred_updates` 的消费——`reduce_deferred_updates()`

必须持 `_allocation_mutex` 调用。从 `_deferred_updates` 链表头原子 pop 一个 Block，读它的 bitmask，把 Block 放回 `_allocation_list`（或移到尾部）。

**pop。** 释放线程在 push 同一链表头——pop 也必须 CAS：

```cpp
Block* block = OrderAccess::load_acquire(&_deferred_updates);
while (true) {
    if (block == NULL) return false;                     // 链表空，没事可做
    Block* tail = block->deferred_updates_next();
    if (block == tail) tail = NULL;                      // self-loop → NULL
    Block* fetched = Atomic::cmpxchg(tail, &_deferred_updates, block);
    if (fetched == block) break;                         // 抢到了
    block = fetched;                                      // 被抢，重试
}
```

**push 到 deferred 链表的完整过程——两步：竞标 + 挂链。**

问题场景：同一个 Block 上有两个线程释放不同的 slot。Thread A 释放 slot[3]，Thread B 释放 slot[7]——都检测到状态变更（之前满的，现在非满），都试图把 Block 推入 deferred。只需要推一次——推两次会重复。

**第一步——竞标。** 不是去改链表头，而是改**当前 Block 自己的 `_deferred_updates_next` 字段**——把它从 NULL 改成指向自己（self-loop，即 `this`）。只有第一个 CAS 成功的线程拿到推入权：

```cpp
if (Atomic::replace_if_null(this, &_deferred_updates_next)) {
    // 我抢到了，我负责推
} else {
    // 别人已经抢了，我跳过——不需要再推
}
```

这一步中 self-loop = **归属标记**——"这个 Block 已经有线程认领了"。

**第二步——挂链。** 拿到推入权的线程把 Block 挂到 `_deferred_updates` 头。挂链时决定 `_deferred_updates_next` 的最终位置：

```cpp
_deferred_updates_next = (head == NULL) ? this : head;
```

两步都写 `_deferred_updates_next`，不是冗余——因为步骤 1 到 2 之间链表可能被其他线程改了。

步骤 1 结束：`_deferred_updates_next = self-loop`（竞标成功时的占位值）。步骤 2 先读 `head = *deferred_list`——如果在此期间另一个线程推了新 Block 进来，head 不再是 NULL了。步骤 2 果断覆盖：`_deferred_updates_next = head`（真正的 next，不再是 self-loop）。如果 head 还是 NULL——说明没有其他人插入——步骤 2 写的 `this` 恰巧等于步骤 1 的占位值。

- 链表不空：`_deferred_updates_next = head` → 指向原来的头结点
- 链表空（head = NULL）：`_deferred_updates_next = this` → 保持 self-loop。自己是头也是尾

这一步中 self-loop = **链表尾标记**——pop 时看到 self-loop 知道这是最后一个节点。

**同一个 self-loop，两阶段不同角色。** 第一步是竞标标记（防止重复推入），如果链表在第二步刚好是空的——self-loop 从竞标标记自然地变成链表尾标记。

pop 成功后清空 `_deferred_updates_next`，然后跑全屏障再读 bitmask：

```cpp
block->set_deferred_updates_next(NULL);
OrderAccess::storeload();  // x86: lock; addl $0,0(%rsp)
```

没有这个屏障——可能读到 release 线程还没有通过 cache coherence 同步过来的旧 bitmask，误判 Block 还是满的，跳过 `push_front`——一个本该重新可分配的 Block 被漏掉了。

**读 bitmask，改 allocation_list。** 现在安全读 Block 的当前占用状态：

```cpp
uintx allocated = block->allocated_bitmask();
```

根据 Block 的空满状态决定怎么动 `_allocation_list`。三种情况：

- **已经是非满且在 allocation_list 中**——不做任何操作。这个 Block 可能因为 release 重入过 deferred，但 bitmask 现在还是非满
- **非满但不在 allocation_list 中**——之前是满的被 unlink 了，现在有空位了 → `push_front` 挂回去

```cpp
if (!is_full_bitmask(allocated) && block 不在 allocation_list 中) {
    _allocation_list.push_front(*block);
}
```

- **空了**——所有 slot 都释放了 → 摘掉，移到尾部。尾部是 `delete_empty_blocks` 的遍历起点

```cpp
if (is_empty_bitmask(allocated)) {
    _allocation_list.unlink(*block);
    _allocation_list.push_back(*block);
}
```

每次调用只处理一个 Block，返回 true。调用方（`allocate()`、`delete_empty_blocks`）循环调用直到返回 false（链表为空）。

---

### 5.4 `_active_array`——Block* 指针数组，GC 遍历入口

每创建一个 Block，它被加入 `_active_array`。这是一个 `Block*` 的数组，紧贴在 ActiveArray 对象体后，分配在 C Heap（不是 Java 堆）：

```
_active_array:
  [Block*_A]   [Block*_B]   [Block*_C]    ...
      ↓            ↓            ↓
   64个slot     64个slot     64个slot
```

- **初始容量 8**，满时 2 倍扩容
- **`push(block)`**：加入数组，记录索引。满则返回 false
- **`remove(block)`**：O(1) 交换删除——末尾 Block 搬到被删位置，`_block_count--`

`_active_array` 和前面两个链表的关系：它是 **Block 的主索引**——所有 Block 都在里面，无论满不满、在不在 allocation_list 或 deferred 上。GC 遍历 OopStorage 时只走 `_active_array`，不关心哪个 Block 在哪个链表。

**为什么需要多读者-单写者模式。** `_active_array` 有两个完全不同的使用者：

- **读者（多个 GC 线程）**：GC 在 safepoint 中遍历 OopStorage——多个 GC 工作线程同时读 `_active_array`。读操作极其频繁——每次 GC 都会走一遍。读者之间不能互相阻塞——否则拖长 GC 暂停
- **写者（单个 allocate 线程）**：allocate() 创建新 Block 时 `_active_array` 可能满了——需要扩容。创建一个更大的新数组，把指针 `_active_array` 切过去。扩容是低频事件——远少于 GC 遍历

写者切指针后，旧数组不能立即 `delete`——GC 线程可能还在读它。写者必须等到"切指针前进入的所有读者"都退出。这就是 SingleWriterSynchronizer 出现的原因——它只解决这一个问题：**写者如何知道所有旧读者都退出了**（第 5.4 节展开）。

**扩容流程。** 创建新数组 → 拷贝旧内容 → 把 `_active_array` 指针切到新数组 → **通过 SingleWriterSynchronizer 等旧读者退出** → 旧 refcount 归零 → 安全删除。

这套"写方等所有读者退出"的机制叫 SingleWriterSynchronizer——HotSpot 的一个独立工具类（`utilities/singleWriterSynchronizer.hpp`），专门用来解决"多读者一写者"的同步问题。读者进入/退出永不被阻塞，写者阻塞直到当前所有读者退出。

```cpp
void replace_active_array(ActiveArray* new_array) {
    new_array->increment_refcount();                          // ① 新数组 ref+1
    OrderAccess::release_store(&_active_array, new_array);    // ② 原子切指针
    _protect_active.synchronize();    // ③ 等旧 refcount 归零（通过 SingleWriterSynchronizer）
    // ④ 旧数组销毁
}
```

### 5.5 SingleWriterSynchronizer——写方等所有读者退出

5.3 节写的"等旧 refcount 归零"背后的机制——`_protect_active` 就是一个 `SingleWriterSynchronizer` 对象。它是 OopStorage 的成员字段，类型是 HotSpot 的独立工具类——不在 OopStorage 内部实现，在 `utilities/singleWriterSynchronizer.hpp`。

这个工具类解决一个经典的多读者-单写者问题。两个需求：

1. **读者不阻塞。** 任意多个读者同时读一块数据（`_active_array`），不能有锁——锁会阻塞 GC 线程
2. **写者不能立即删旧数据。** 写者创建了新数组、把指针切过去之后，旧数组不能马上 `delete`——还有读者正在读它。写者必须等到**指针切换前**的所有读者都退出，才能安全删除旧数组

核心问题：写者怎么区分"切换前进入的读者"和"切换后进入的读者"？切换后的读者读的是新数组——不需要等它们。

**解决方案：用 `_enter` 计数器的 bit0 做分界线。**

读者进场时，`enter()` 原子地把 `_enter` +2，记下返回值。返回值最低 bit（0 或 1）就是这个读者的"批次号"——退场时写到 `_exit[0]` 或 `_exit[1]`。+2 保证连续进场的读者拿到相同的批次号（bit0 不变）。

写者切换指针后，把 `_enter` 的 bit0 翻一下（小改动，不改变高位计数）。翻转前的 `_enter` 值就是"旧读者的目标线"——`_exit[旧批次]` 累积到这个值，说明旧读者全退了。

**走一个完整例子。**

初始：`_enter=0`，`_exit[0]=0`，`_exit[1]=0`。

读者 A 进：`enter()` → `_enter` 从 0 变 2，返回 2（bit0=0→批次 0，退场写 `_exit[0]`）。
读者 B 进：`_enter` 从 2 变 4，返回 4（bit0=0→批次 0，退场写 `_exit[0]`）。
状态：`_enter=4`，`_exit[0]=0`。

读者 A 退：`exit(2)`。`exit()` 的实参就是 `enter()` 的返回值——不是用来"加多少"的，只是用最低 bit 选槽。内部始终执行 `Atomic::add(2, &_exit[enter & 1])`。所以 `exit(2)` = `_exit[0] += 2`，从 0 变 2。此时 `_waiting_for=1`（构造函数初始值），`2 != 1`，不发信号。
状态：`_enter=4`，`_exit[0]=2`。

写者切指针后，调 `synchronize()`：
1. 翻 bit0：CAS 把 `_enter` 从 4 改成 5。同时把 `_exit[1]` 初始化成 5（和当前 `_enter` 保持一致）
2. 设 `_waiting_for = 4`——翻转前 `_enter` 的值。目标：等 `_exit[0]` 从 2 继续累加到 4
3. 阻塞，`while (_exit[0] != 4) wait()`

状态：`_enter=5`（bit0=1）。之后的新读者进：`enter()` → `_enter=7`，返回 7（bit0=1→批次 1，退场写 `_exit[1]`）。不干扰 `_exit[0]`。

读者 B 退：`exit(4)` → `_exit[0] += 2`，从 2 变 4。`4 == _waiting_for` → `_wakeup.signal()`。
写者醒，`_exit[0]=4`，旧读者 A 和 B 全退——安全删除旧数组。

**为什么能工作。** 没有锁——读者 enter/exit 都是原子加法。bit0 是天然的"断点"——翻转一次 0→1，再翻一次 1→0，两个批次交替。第一次扩容：旧读者批次 0 写 `_exit[0]`，新读者批次 1 写 `_exit[1]`。第二次扩容：翻转后批次回到 0——上一批的"新读者"变成这一批的"旧读者"，`_exit[1]` 和 `_exit[0]` 角色互换。写者始终只看当前批次对应的退出槽。

**为什么不用 GlobalCounter？** GlobalCounter 是 HotSpot 中另一个同步工具（`utilities/globalCounter.hpp`）——和 SingleWriterSynchronizer 解决同一类问题，但性能更好、支持多个写者。HotSpot 中大多数并发数据结构用它——StringTable、ConcurrentHashTable、JFR 等都调 `GlobalCounter::write_synchronize()`。

但它有一个硬限制——**不支持嵌套**。每个线程只有一个 `rcu_counter` 槽。`critical_section_begin()` 有 assert 明确禁止重复进入。OopStorage 恰好踩了这个坑：StringTable 在内部操作（插入/扩容）时处于 GlobalCounter 临界区中，这些操作有时需要创建 WeakHandle——调用 `WeakHandle::create()` → `OopStorage::allocate()`。如果 allocate 触发 `expand_active_array()`，此时线程还在 GlobalCounter 临界区内——再调 `GlobalCounter::write_synchronize()` 就死锁了。SingleWriterSynchronizer 没有这个限制——每个 OopStorage 有自己独立的 `_protect_active`，和 StringTable 的 GlobalCounter 互不干扰。

---

## 6. allocate()——三步串联

Block 有了，三个管理结构有了。allocate() 把它们串起来（`oopStorage.cpp:410`）：

```cpp
oop* OopStorage::allocate() {
    MutexLockerEx ml(_allocation_mutex, ...);

    // 第一步：先消费 deferred——可能有 Block 从满变非满
    // reduce_deferred_updates: pop 一个 deferred，非满就 push_front 到 allocation_list
    // 循环：不断 pop，直到 allocation_list 有块可用或 deferred 空了
    while (reduce_deferred_updates() && (_allocation_list.head() == NULL)) {}

    // 第二步：从 allocation_list 拿一个非满 Block
    Block* block = _allocation_list.head();
    if (block == NULL) {                       // 链表空了——所有 Block 全满
        Block* new_block = Block::new_block(this); // malloc→对齐→placement new
        if (new_block != NULL) {
            _active_array->push(new_block);      // 加入 ActiveArray
            _allocation_list.push_back(*new_block); // 加入可分配链表
        }
        block = _allocation_list.head();
    }

    // 第三步：从 Block 里 CAS 抢 slot
    oop* result = block->allocate();
    Atomic::inc(&_allocation_count);
    if (block->is_full()) _allocation_list.unlink(*block);  // 满则摘除
    return result;
}
```

`reduce_deferred_updates()` 一次只 pop 一个 deferred，如果 pop 出来的 Block 现在非满了就顺手 `push_front` 回 `_allocation_list`。while 循环不断做这件事。什么时候停？两种情况：deferred 空了（返回 false 中断），或者 pop 出的 Block 被 `push_front` 后 `_allocation_list` 不再是 NULL——直接用这个 Block 分配，不用建新的。

第三步即使持锁也要 CAS——release 在锁外通过 CAS 改同一 bitmask。

---

## 7. release()——CAS 清 bit，状态变了推 deferred

### 7.1 每次释放都走这条路

释放 slot 是**不持锁**的。`OopStorage::release()`（`oopStorage.cpp:675`）：

```cpp
void OopStorage::release(const oop* ptr) {
    Block* block = find_block_or_null(ptr);                  // 根据槽位地址反查 Block
    block->release_entries(
        block->bitmask_for_entry(ptr),                       // releasing: 单 bit 掩码
        &_deferred_updates);                                 // deferred 链表头
    Atomic::dec(&_allocation_count);
}
```

`ptr` 是**槽位地址**——`&_data[index]`。allocate() 返回的就是这个地址，release() 传回的也是它。类型是 `oop*`（`oop _data[64]` 的元素类型是 `oop`，取址得 `oop*`）。

`releasing` 是一个只含一个 bit 的掩码。`bitmask_for_entry(ptr)` → 算出 ptr 在 `_data[]` 中的索引 index → 返回 `uintx(1) << index`。比如释放 slot[3] 时 `releasing = 0b1000`（bit 3 = 1）。

反查 Block 的原理：Block 的 `_data` 在偏移 0，Block 整体 64 字节对齐。`align_down(ptr, 64)` 落到 slot 所在 section 的起始位置。Block 起始可能在它之前 0~7 个 section 的任一处。用 SafeFetchN（安全内存读取——segfault 返回 0 不崩溃）逐个候选位置检查 `_owner` 字段匹配——最多 8 次。

### 7.2 release_entries 的实现

`oopStorage.cpp:575`：

```cpp
void OopStorage::Block::release_entries(uintx releasing, Block* volatile* deferred_list) {
    Atomic::inc(&_release_refcount);                         // ① 防止在此期间删除

    uintx old_allocated = _allocated_bitmask;
    while (true) {
        uintx new_value = old_allocated ^ releasing;         // ② XOR 清 bit
        uintx fetched = Atomic::cmpxchg(new_value, &_allocated_bitmask, old_allocated);
        if (fetched == old_allocated) break;
        old_allocated = fetched;
    }

    if ((releasing == old_allocated) || is_full_bitmask(old_allocated)) { // ③ 状态变更?
        // ④ CAS push 到 deferred_updates（详细见 5.2 节）
    }

    Atomic::dec(&_release_refcount);                         // ⑤ 保护结束
}
```

**两个条件各走一遍例子。**

条件 1——Block 变空了。Block 只剩 slot[0] 被占，掩码 = `0b0001`。释放 slot[0]：`releasing = 0b0001`。`old_allocated = 0b0001`。`new_value = 0b0001 ^ 0b0001 = 0b0000`。CAS 成功。`releasing(0b0001) == old_allocated(0b0001)` → **TRUE**。Block 从"有一个 slot"变全空了。

条件 2——之前满的，现在有空位了。Block 64 个 slot 全满：`old_allocated = 0xFFFFFFFFFFFFFFFF`。释放 slot[3]：`releasing = 0b1000`。CAS 成功。`is_full_bitmask(0xFFFF...FF)` → **TRUE**。释放前 Block 是满的，现在有空位了——这个 Block 又可以分配了。

① `_release_refcount` 从 0 变 1——告诉 `is_deletable()` 别在这个窗口内删 Block。如果没这个保护：bitmask 被清零了（Block 看起来空了），但⑧还没推到 deferred list——`is_deletable()` 发现 Block 全空且不在 deferred list——认为可以删了——但释放还没完成。

---

## 8. 删除空 Block

Block 从"活着"到"被删除"走一条完整的链路——前面几节分别讲了各段，这里汇总：

1. **release** 释放 slot，Block 状态变了（满→非满，或非空→全空）→ 推入 `_deferred_updates` 链表（第 7 节）
2. **reduce_deferred_updates** 消费 deferred 链表。Block 非满就挂回 `_allocation_list`，**全空就移到 `_allocation_list` 的尾部**（第 5.3 节）
3. **delete_empty_blocks** 从 `_allocation_list` 尾部遍历——尾部的都是空 Block。检查 `is_deletable()` 三个条件，通过了就删（第 8 节）

下面分两个版本（safepoint vs concurrent）和 is_deletable 条件展开。

### 8.1 delete_empty_blocks_safepoint

Safepoint 版本——所有 mutator 已暂停，不需要任何锁。

**先消费完 deferred。** Safepoint 里没人会再 release slot 了，把积压的 deferred 全处理掉——这些 deferred 会后把空 Block 移到 allocation_list 尾部：

```cpp
while (reduce_deferred_updates()) {}
```

每次 pop 一个 deferred 并更新 allocation_list。循环到链表空为止。

**检查并发迭代标志。** 即使 safepoint，并行 GC 线程可能还在遍历 `_active_array`。不能删它们正在访问的 Block：

```cpp
if (_concurrent_iteration_active) return;  // 有并行遍历→跳过，不删
```

**从尾部遍历删除。** 空 Block 已被移到尾部——从 tail 开始正好。每次 loop 重新取 `tail()`——因为上一个删了，tail 变了：

```cpp
for (Block* block = _allocation_list.tail();
     block != NULL && block->is_deletable();   // 不可删就停
     block = _allocation_list.tail()) {
```

每个可删的 Block 做三件事。从 `_active_array` 移除（O(1) 交换删除），从 `_allocation_list` 摘除，然后析构 + free：

```cpp
    _active_array->remove(block);
    _allocation_list.unlink(*block);
    delete_empty_block(*block);
}
```

`delete_empty_block` 就是 `block.~Block()` 后 `FREE_C_HEAP_ARRAY(block._memory)`——前面第 4.3 节讲过的对称操作。

**为什么从尾部？为什么遇不可删就停？** 空 Block 在尾部连续排列。第一个不满足 `is_deletable()` 的 Block 之后的都不是空的。

### 8.2 delete_empty_blocks_concurrent

Concurrent 版本——mutator 还在运行，必须持锁保护。三个独有设计。

**全程持 `_allocation_mutex`。** 这是和 safepoint 版本最核心的区别：

```cpp
MutexLockerEx ml(_allocation_mutex, ...);
```

**设上限防无限循环。** 持锁期间其他线程 release slot 可能把新空 Block 推到尾部——每次迭代可能产生新的待删 Block。不设上限理论上永远删不完。用进入时 Block 总数的快照做上限：

```cpp
size_t limit = block_count();
```

**每轮迭代。** 先消费一个 deferred（可能产生新的空 Block 被移到尾部），取 tail 检查 is_deletable：

```cpp
for (size_t i = 0; i < limit; ++i) {
    reduce_deferred_updates();
    Block* block = _allocation_list.tail();
    if (block == NULL || !block->is_deletable()) return;
```

**双层锁保护 `_active_array` 移除。** `_active_array->remove` 用 `_active_mutex` 单独保护——和 `_allocation_mutex` 是两把锁，各管各的数据结构：

```cpp
    { MutexLockerEx aml(_active_mutex, ...);
      if (_concurrent_iteration_active) return;
      _active_array->remove(block);
    }
```

**临时释锁做 free。** `delete_empty_block` 调 free 可能花时间（操作系统内存管理）。持锁做 free 会阻塞所有其他 allocate/release 操作。通过 `MutexUnlockerEx` 临时释放锁：

```cpp
    _allocation_list.unlink(*block);
    { MutexUnlockerEx ul(_allocation_mutex, ...);
      delete_empty_block(*block); }
}
```

对比 safepoint 版本：多了持锁、上限、临时释锁三个环节——都因为 mutator 还在并发运行。

### 8.3 is_deletable 三条件

`oopStorage.cpp:263`。三个条件顺序执行（C 语言 `&&` 短路求值），任意一个不满足就返回 false：

```cpp
bool is_deletable() const {
    return (OrderAccess::load_acquire(&_allocated_bitmask) == 0)       // ① 全空
```

**条件① `_allocated_bitmask == 0`。** Block 的所有 64 个 slot 都空闲。最便宜的检查，先跑。

**条件② `_release_refcount == 0`。** 如果 `release_entries` 正在执行中（refcount > 0），bitmask 可能暂时为 0 但还没推到 deferred list——此时不能删。refcount 在 release_entries 开头递增、结尾递减——挡住这个窗口。

```cpp
        && (OrderAccess::load_acquire(&_release_refcount) == 0)        // ② 没人在释放
```

**条件③ `_deferred_updates_next == NULL`。** 如果 Block 还在 deferred 链表上，说明还没被 `reduce_deferred_updates` 消费——bitmask 的值虽然为 0，但 Block 不一定已经在 allocation_list 尾部。需要等消费完后 `_deferred_updates_next` 才被清空。

```cpp
        && (OrderAccess::load_acquire(&_deferred_updates_next) == NULL); // ③ 已出延迟队列
}
```

三个 `load_acquire` 保证从其他 CPU 读到最新值。顺序不是随意排的——先查最廉价的（bitmask），查到 false 就不读后面两个。

---

## 9. 回到 SystemDictionary——通过 WeakHandle 桥接 OopStorage

### 9.1 初始化

`systemDictionary.cpp:3048`——`universe_init` 第 692 行调用：

```cpp
void SystemDictionary::initialize_oop_storage() {
    _vm_weak_oop_storage = new OopStorage("VM Weak Oop Handles",
                                           VMWeakAlloc_lock, VMWeakActive_lock);
}
```

构造函数（`oopStorage.cpp:720`）创建 ActiveArray(8)、所有链表初始为空、`_allocation_count=0`。手动调 `_active_array->increment_refcount()`——把 refcount 从 0 加到 1。断言两锁 rank 顺序——`active_mutex < allocation_mutex`。同时持双锁必须先拿 active 再拿 allocation——防止死锁。两锁都设了 `_safepoint_check_never`——不在 safepoint 中被调用时不检查。

### 9.2 WeakHandle——上层不直接操作 slot

SystemDictionary 不直接调 `allocate()` / `release()`，而是通过 `WeakHandle<vm_class_loader_data>`（`weakHandle.hpp:44`）。为什么要包装一层？

- **类型安全路由。** 不同场景用不同的 OopStorage 实例——`vm_class_loader_data` 路由到 `SystemDictionary::vm_weak_oop_storage()`，`vm_string_table_data` 路由到 `StringTable::weak_storage()`。模板参数是路由键，`get_storage()` 做特化分发——调用方不需要知道底层用哪个 Storage
- **Phantom 引用语义。** GC 遍历弱引用按 phantom 时序——class loader 变成 phantom-reachable 后才清 slot。WeakHandle 的读写走 `ON_PHANTOM_OOP_REF` 屏障——保证 GC 按 phantom 时序正确处理。用裸 `oop*` 无法保证这种屏障
- **统一接口。** `create(Handle)` 传入 Java 层 Handle、`resolve()` 读 oop、`release()` 归还——调用方不碰 `oop*` 裸指针

模板定义：

```cpp
enum WeakHandleType { vm_class_loader_data, vm_string, vm_string_table_data };

template <WeakHandleType T>
class WeakHandle {
    oop* _obj;                         // OopStorage 分配的槽位地址
    static OopStorage* get_storage();  // 模板特化——根据类型返回对应 Storage
};
```

`_obj` 就是 Block 内的 `_data[index]` 地址——同一个 `oop*` 槽位。

枚举里并不直接出现 `_vm_weak_oop_storage`——那个是 OopStorage 实例字段，不是枚举值。`vm_class_loader_data` 枚举值作为模板标签——`WeakHandle<vm_class_loader_data>` 选中的特化中，`get_storage()` 返回 `SystemDictionary::vm_weak_oop_storage()`（后者返回 `_vm_weak_oop_storage` 字段）。

**创建。** `create(Handle obj)`（`weakHandle.cpp:44`）三步：从对应 OopStorage 拿 slot → 用 phantom 屏障写入 oop → 返回 WeakHandle 包装。

```cpp
WeakHandle<T> WeakHandle<T>::create(Handle obj) {
    oop* oop_addr = get_storage()->allocate();  // allocate 一个 slot
    NativeAccess<ON_PHANTOM_OOP_REF>::oop_store(oop_addr, obj());
    return WeakHandle(oop_addr);
}
```

`get_storage()` 的模板特化（`weakHandle.cpp:35`）：

```cpp
template <> OopStorage* WeakHandle<vm_class_loader_data>::get_storage() {
    return SystemDictionary::vm_weak_oop_storage();  // → _vm_weak_oop_storage
}
```

**释放。** `release()` 用 phantom 屏障清 slot，归还给 OopStorage：

```cpp
void WeakHandle<T>::release() const {
    if (_obj != NULL) {
        NativeAccess<ON_PHANTOM_OOP_REF>::oop_store(_obj, (oop)NULL);
        get_storage()->release(_obj);  // → OopStorage::release()
    }
}
```

**读取。** `resolve()` 强引用读（告诉 GC"还在用"），`peek()` 弱引用读（不阻止回收）。

**为什么用 phantom 屏障？** Phantom 引用在 GC 标记后、回收前处理。WeakHandle 的 slot 读写走 phantom 屏障，保证 GC 遍历 OopStorage 时正确处理 phantom 引用时序。

### 9.3 GC 怎么调用 OopStorage

GC 不是直接调 OopStorage 的方法。入口在 `WeakProcessor::weak_oops_do()`（`weakProcessor.cpp:36`）：

```cpp
void WeakProcessor::weak_oops_do(BoolObjectClosure* is_alive, OopClosure* keep_alive) {
    JNIHandles::weak_oops_do(is_alive, keep_alive);
    JvmtiExport::weak_oops_do(is_alive, keep_alive);
    SystemDictionary::vm_weak_oop_storage()->weak_oops_do(is_alive, keep_alive);  // ← 这里
}
```

G1 在 `post_evacuate_collection_set()` 中调 WeakProcessor::weak_oops_do。每次 GC 的弱引用处理阶段，SystemDictionary 的 `_vm_weak_oop_storage` 被遍历。

**完整调用链：**
```
G1 post_evacuate → WeakProcessor::weak_oops_do(is_alive, keep_alive)
  → SystemDictionary::vm_weak_oop_storage()->weak_oops_do(is_alive, cl)
    → iterate_safepoint(if_alive_fn(is_alive, oop_fn(cl)))  // safepoint 中
      → iterate_impl: 遍历 _active_array 每个 Block
        → Block::iterate(IfAliveFn(OopFn(cl)))
          → Block::iterate_impl: bitmask CTZ 遍历 active slot
            → IfAliveFn::operator(): is_alive(*slot) ?
                true → closure->do_oop(slot)   // 对象存活，更新 oop
                false → *slot = NULL           // 对象死了，清空槽位
```

`IfAliveFn`（`oopStorage.inline.hpp:248`）是包装器——先判断 is_alive，死了的直接 `*ptr = NULL` 清除。class loader 被 GC 回收后，对应 WeakHandle 的 slot 被置 NULL——后续 OopStorage 的 `release` 只归还空 slot，不操作已死的 oop。

### 9.4 ~OopStorage()——析构时怎么清理

JVM 退出时需要释放 OopStorage 占用的所有资源。析构分四步（`oopStorage.cpp:747-764`）：

```cpp
OopStorage::~OopStorage() {
    // 第一步：丢弃 deferred_updates 链表——这些延迟更新不用管了
    Block* block;
    while ((block = _deferred_updates) != NULL) {
        _deferred_updates = block->deferred_updates_next();
        block->set_deferred_updates_next(NULL);  // 清空指针——防止 Block 析构时 assert 失败
    }

    // 第二步：从 allocation_list 摘除所有 Block（不删，只断链）
    while ((block = _allocation_list.head()) != NULL) {
        _allocation_list.unlink(*block);
    }

    // 第三步：释放 _active_array 的引用——构造时 +1，析构时 -1 → 归零
    bool unreferenced = _active_array->decrement_refcount();
    assert(unreferenced, "deleting storage while _active_array is referenced");

    // 第四步：遍历 active_array，逐个 Block 析构 + free
    for (size_t i = _active_array->block_count(); 0 < i; ) {
        block = _active_array->at(--i);          // 逆序遍历——无所谓顺序
        Block::delete_block(*block);              // ~Block + FREE_C_HEAP_ARRAY
    }

    ActiveArray::destroy(_active_array);          // 释放 ActiveArray 本身
    FREE_C_HEAP_ARRAY(char, _name);               // 释放名称字符串
}
```

步骤 3 的 assert 关键——如果析构时还有读者持有 `_active_array` 的引用（refcount > 1），说明有线程还在读数组数据——此时析构不安全。refcount 必须精确归零。

---

## 10. 概念链

```
裸 oop GC 不更新 → Handle 不永久 → OopStorage 槽位池
逐槽 malloc 碎片 → Block 64 槽打包 + bitmask CTZ 找空闲
CAS 防覆盖、release 不持锁 → deferred 推迟状态变更
多 Block 管理：allocation_list（可分配）| deferred_updates（推迟）| ActiveArray（GC 遍历）
allocate: 持锁 → allocation_list 头取 Block → CAS 抢 slot
release: 不持锁 → CAS 清 bit → 状态变则推 deferred
deferred 消费 → 满变非满重回 list、空则移尾等删除
is_deletable 三条件 → 安全 free
```

---

## 11. 总结

| 概念 | 职能 |
|---|---|
| Block | 64 slot + 64bit 掩码。一次分配管 64 个槽，CTZ O(1) 找空闲位 |
| _allocation_list | 双向链表。串起可分配的非满 Block，持 _allocation_mutex 操作 |
| _deferred_updates | 单向链表。release 状态变更推迟到这，持锁线程消费 |
| _active_array | Block* 数组。GC 遍历入口，RCU 扩容，读者无锁 |
| CAS | allocate/release 并发改同一 bitmask——CAS 防覆盖 |
| is_deletable | 三条件：全空 + 无释放进行中 + 已出延迟队列 |
