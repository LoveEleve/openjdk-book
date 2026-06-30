# STL 容器与算法

打开 HotSpot 源码，你不会看到 `#include <vector>`，不会看到 `std::map`，不会看到 `std::string`。你看到的是 `GrowableArray`、`Hashtable`、`ResourceHashtable`、`KVHashtable`——JVM 自己造了一整套容器。这不是开发者不懂 STL，恰恰相反：他们太懂了，所以知道 STL 在 JVM 的约束下无法工作。

本章从 STL 的设计哲学出发，深入容器内部实现，最后回答那个核心问题：HotSpot 为什么不用 STL。

## STL 六大组件全景

STL 不是"一锅容器"，而是六个正交组件的精密配合：

```
┌──────────────────────────────────────────────────────────────┐
│                        STL 六大组件                           │
├───────────┬──────────────────────────────────────────────────┤
│ 容器       │ vector, deque, list, map, set, unordered_map ... │
│ 算法       │ sort, find, binary_search, partition, copy ...   │
│ 迭代器     │ 容器与算法之间的粘合剂——算法通过迭代器操作容器      │
│ 仿函数     │ 函数对象（重载 operator()），替代函数指针          │
│ 适配器     │ stack, queue, priority_queue——改变容器接口        │
│ 分配器     │ allocator<T>——控制内存如何分配和释放              │
└───────────┴──────────────────────────────────────────────────┘
```

核心设计原则：**算法通过迭代器操作容器，算法不知道容器的存在，容器不知道算法的存在。** 这是解耦的极致——同一个 `sort` 可以排序 `vector`、`deque`、甚至原生数组。但这也意味着 STL 无法做侵入式优化——而 HotSpot 恰恰需要侵入式设计。

## 序列容器：内部实现

### vector —— 三指针实现

`vector` 的底层不是魔法，就是三个指针：

```cpp
// GCC libstdc++ vector 核心数据结构（简化）
template<typename T>
class vector {
    T* _M_start;           // 指向第一个元素
    T* _M_finish;          // 指向最后一个元素的下一个位置
    T* _M_end_of_storage;  // 指向分配内存的末尾

    size_t size() const     { return _M_finish - _M_start; }
    size_t capacity() const { return _M_end_of_storage - _M_start; }
};
```

```
低地址                              高地址
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ E1 │ E2 │ E3 │ E4 │    │    │    │    │
└────┴────┴────┴────┴────┴────┴────┴────┘
  ↑              ↑                  ↑
_M_start       _M_finish    _M_end_of_storage
[────── size() ──────]
[──────────── capacity() ────────────────]
```

三个指针就能表达动态数组的全部状态。`size()` 是一次减法，`capacity()` 也是一次减法——都是 O(1)。但 `push_back` 在 `_M_finish == _M_end_of_storage` 时必须扩容。

**vector 扩容策略（两份实现）：**

| 实现 | 增长因子 | 说明 |
|------|---------|------|
| GCC libstdc++ | 2x | `new_cap = old_cap * 2`，简单但内存复用差 |
| MSVC | 1.5x | `new_cap = old_cap + old_cap / 2`，可复用释放内存 |

**为什么 1.5x 能复用内存？** 使用 2x 时，释放了 N 字节后下一次需要 2N 字节——之前释放的永远不够用。1.5x 满足 k < φ ≈ 1.618 时，历史释放内存之和终将超过下一次分配需求。GCC 历史上用过 2x，MSVC 选了 1.5x，两者都是循环倍增——摊销 O(1)。

**摊销分析——为什么 push_back 是均摊 O(1)：** 从容量 1 开始倍增到 N，总拷贝次数 = 1 + 2 + 4 + ... + N/2 ≈ N。分摊到 N 次 push_back，每次 O(1)。

### deque —— 分段连续

`deque` 不是一整块连续内存，而是一个"中控器"（指针数组）+ 多个固定大小的缓冲区（通常 512 字节）：

```
中控器（map）:
┌────┬────┬────┬────┬────┐
│ B0 │ B1 │ B2 │ B3 │ B4 │  ← 每个指向一个缓冲区
└──┼─┴──┼─┴──┼─┴──┼─┴──┼─┘
   ↓     ↓     ↓     ↓     ↓
  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐
  │E │ │E │ │E │ │E │ │E │  ← 每个缓冲区是连续数组（512B）
  └──┘ └──┘ └──┘ └──┘ └──┘
```

两端插入 O(1)：在头部缓冲区前再加一块或尾部后加一块即可，不需要移动已有元素。但 `operator[]` 需要先定位到正确的块再定位块内偏移——比 vector 多一步间接寻址。

### list —— 双向链表

每个节点是一个独立堆分配，包含两个指针（prev/next）+ 数据。插入/删除 O(1)（已知位置），但遍历是灾难——每次 `++it` 都是一次随机内存访问，缓存预取完全失效。

**实际性能对比（遍历 100 万元素求和）：**

| 容器 | 时间 | cache miss 率 | 原因 |
|------|------|--------------|------|
| `vector<int>` | ~1 ms | ~6% | 连续内存，预取友好 |
| `deque<int>` | ~2 ms | ~15% | 分段连续，块间跳跃 |
| `list<int>` | ~20 ms | >90% | 每次 ++it 都大概率 cache miss |

这就是为什么**90% 的场景默认用 vector**。即使需要"中间插入"，在小数据量下 vector 的缓存优势也通常压倒 list 的 O(1) 理论优势。

## 关联容器：红黑树 vs 哈希表

### map —— 红黑树

`std::map` 的底层是红黑树（Red-Black Tree）——一种自平衡二叉搜索树，保证：

- 每个操作 O(log n)
- 元素按键**有序**排列
- 中序遍历即升序

每个节点包含：key、value、left 指针、right 指针、parent 指针、颜色（红/黑）。内存开销 ≈ 3 个指针 + 1 个枚举，比 unordered_map 紧凑。

**RB-tree 平衡保证：** 最长路径不超过最短路径的 2 倍（性质 4：红节点子节点必黑；性质 5：任意路径黑节点数相等）。这保证了 O(log n) 的上界。

### unordered_map —— 哈希表

双向迭代器用拉链法：一个 bucket 数组 + 每个 bucket 的单链表。哈希函数将 key 映射到 bucket 索引，负载因子（size / bucket_count）超过阈值（通常 1.0）时触发 rehash。

**时间复杂度：** 平均 O(1)，最坏 O(n)（所有 key 冲突到同一 bucket），rehash 时 O(n)。

**关键区别：**

| 维度 | map | unordered_map |
|------|-----|---------------|
| 查找/插入 | O(log n) | O(1) 平均 |
| 遍历顺序 | 有序（key 升序） | 无序（bucket 顺序） |
| 内存占用 | 较小 | 较大（bucket 数组） |
| 缓存友好 | 差（指针跳转） | 差（指针跳转） |
| 适合场景 | 需要有序遍历、范围查询 | 纯键值查找 |

## 迭代器失效规则表

这是 C++ 中最容易出错的陷阱。以下表格必须在每次写 STL 代码时心里有数：

| 容器 | 操作 | 失效的迭代器 | 说明 |
|------|------|-------------|------|
| vector | push_back (未扩容) | end() | 内存连续，新元素在末尾 |
| vector | push_back (扩容) | **全部** | 重新分配内存，旧空间释放 |
| vector | insert | 插入位置及之后 | 插入需要移动后续元素 |
| vector | erase | 被删及之后 | 删除需要移动后续元素 |
| deque | push_front/back | 全部（元素引用仍有效） | 中控器可能重新分配 |
| deque | insert/erase 中间 | 全部 | 两端之间操作导致全局失效 |
| list | insert | **不失效** | 链表插入只修改指针 |
| list | erase | 仅被删元素 | 其他节点指针不受影响 |
| map/set | insert | **不失效** | 树节点不移动 |
| map/set | erase | 仅被删元素 | 红黑树删除局部调整 |

**核心规则：** 连续内存容器（vector）的插入/删除会导致迭代器大面积失效；节点容器（list/map/set）只在被删除元素的迭代器失效。编写代码时，`erase(it)` 后 **永远用 `it = c.erase(it)` 的返回值更新迭代器**。

## STL 算法库分类

算法库是 STL 的精华——它们通过迭代器与容器解耦：

| 类别 | 典型算法 | 复杂度 | 说明 |
|------|---------|--------|------|
| 非修改序列 | find, count, search, all_of, any_of | O(n) | 不修改元素 |
| 修改序列 | copy, transform, replace, fill, generate | O(n) | 原地修改或输出 |
| 排序 | sort, stable_sort, partial_sort, nth_element | O(n log n) | 改变元素顺序 |
| 二分查找 | lower_bound, upper_bound, binary_search | O(log n) | 要求有序 |
| 分区 | partition, stable_partition | O(n) | 按条件重排 |
| 集合操作 | merge, set_union, set_intersection | O(n+m) | 要求有序 |
| 堆操作 | make_heap, push_heap, pop_heap | O(log n) | 优先级队列底层 |

**sort 的底层——Introsort（内省排序）：**

```
sort() = Introsort
  ├── QuickSort（默认策略）
  │     递归深度过大时自动切换到 HeapSort
  ├── HeapSort（防退化解）
  │     保证 O(n log n) 最坏情况
  └── InsertionSort（小规模优化）
         子数组 < 16 个元素时用插入排序（常数因子小）
```

不是纯快排——纯快排最坏 O(n²)，Introsort 通过监控递归深度，自动切换到堆排序保证上界。

## string 实现：从 COW 到 SSO

### COW（Copy-On-Write，C++11 已废弃）

C++98 时代，GCC 的 `std::string` 采用 COW：多个 string 对象共享同一块底层缓冲区，引用计数管理生命周期，仅在修改时触发"写时拷贝"。

**为什么废弃？三个致命缺陷：**

1. **多线程下的引用计数开销反超拷贝。** 原子操作 + 跨核心缓存同步的成本在高并发场景超过直接深拷贝。
2. **`operator[]` 无法区分读/写。** 返回 `char&` 时编译器不知道调用者会不会改——要么过度分离（读也拷贝），要么引入代理对象（更复杂、更多 bug）。
3. **C++11 移动语义是更好的答案。** 不需要"假装共享"来避免拷贝——直接移动：`std::move(s)` 偷走缓冲区指针，O(1)。

### SSO（Small String Optimization）

现代实现（GCC libstdc++）用 SSO：字符串 ≤ 15 字节时存在 `string` 对象**内部**的栈缓冲区中，零堆分配：

```
短字符串 "hello"（SSO）：           长字符串（堆分配）：
┌──────────────────────┐           ┌──────────────────────┐
│ _M_local_buf:        │           │ ptr  ───────────────→ 堆内存
│  h e l l o \0 ...   │           │ length: 50            │
├──────────────────────┤           │ capacity              │
│ length: 5            │           └──────────────────────┘
│ ptr → _M_local_buf   │           超过 15 字节 → 一次堆分配
└──────────────────────┘
```

SSO 阈值：GCC 15 字节，MSVC 15 字节，Clang（libc++）22 字节。大多数程序中的短字符串（字段名、日志标签等）完全不需要堆分配。

## 容器选型决策矩阵

```
需要随机访问（O(1)索引）？
  ├─ Yes → 需要双端操作？
  │          ├─ Yes → deque
  │          └─ No  → vector（默认首选）
  └─ No  → 需要有序遍历？
              ├─ Yes → map / set
              └─ No  → 需要 O(1) 查找？
                         ├─ Yes → unordered_map / unordered_set
                         └─ No  → list（仅频繁中间插入删除的场景）
```

**重要警告：** 当数据量 < 100 时，`vector<pair<key, value>>` + 二分查找可能比 `map` 和 `unordered_map` 都快——连续内存的缓存优势碾压 O(log n) vs O(1) 的理论差异。

## HotSpot 为什么不用 STL

这不是 STL 不好，是 JVM 的约束太特殊：

### 1. 无异常环境

HotSpot 编译时使用 `-fno-exceptions`。STL 通过异常报告错误：
- `vector::at()` 越界抛 `std::out_of_range`
- `map::at()` 键不存在抛 `std::out_of_range`
- 内存分配失败抛 `std::bad_alloc`

在无异常环境中，这些全部是编译错误或运行时崩溃。HotSpot 使用断言 (`guarantee`) + 返回错误码替代异常传播（见第 7 章 CHECK 宏）。

### 2. 启动时无动态内存

JVM 启动早期阶段（`Threads::create_vm` 之前），全局 `operator new` 尚未初始化。STL 容器在构造时可能通过 `Allocator` 申请内存——在 `new` 可用之前调用 `std::vector::push_back` 会直接崩溃。HotSpot 的自建容器通过 Arena 分配器解决这个问题——Arena 在 JVM 启动的最早阶段就可以使用。

### 3. 确定性析构与 GC 安全点

STL 容器的析构函数在离开作用域时隐式执行——释放内存、调用元素析构函数。但 HotSpot 的 GC 安全点（safepoint）要求：线程在 GC 期间不能执行不可控的操作。一个 `std::vector` 在函数返回时的隐式析构可能发生在 GC 安全点内——这是不可接受的。ResourceMark 的批量释放（O(1) 回滚水位线）完全可控。

### 4. 编译时间与调试符号膨胀

STL 是重度模板库。`#include <vector>` 展开约 10K 行代码，`#include <map>` + `<unordered_map>` + `<string>` 轻松超过 50K 行。HotSpot 全量构建有数千个编译单元，每个 `.o` 中都包含 `std::vector<Klass*>` 的独立实例化（虽然链接器去重，但编译时间无法去重）。调试符号（DWARF）中充斥着 `std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char>>` 这种膨胀名——生成的 libjvm.so 调试符号体积可达数百 MB。

### 5. 自定义分配器需求

STL 的 `Allocator` 模型假定"每次分配独立释放"。HotSpot 的 Arena 模型是"批量标记释放"——ResourceMark 析构时回滚整个 Arena 的水位线。这种分配模式与 STL allocator 的概念模型根本冲突。

## HotSpot 自建容器

```cpp
// jdk11u-copy/src/hotspot/share/utilities/growableArray.hpp 第 219-225 行
template<class E>
int GrowableArray<E>::append(const E& elem) {
    if (_len == _max) grow(_len);  // 满了就倍增
    int idx = _len++;
    _data[idx] = elem;
    return idx;
}
```

`GrowableArray<T>` 是 HotSpot 的 `std::vector` 替代品。关键差异：

| 维度 | std::vector\<T\> | GrowableArray\<T\> |
|------|------------------|-------------------|
| 分配策略 | `Allocator`（operator new） | 三种：ResourceArea / C Heap / Arena |
| 错误处理 | 异常 | 断言 + OOM 处理 |
| 释放方式 | 逐个析构 + delete[] | ResourceMark 批量回滚或手动释放 |
| 基类 | 无（全模板） | `GenericGrowableArray`（非模板基类，减少代码膨胀） |
| 迭代器 | 标准五类迭代器 | `GrowableArrayIterator`（StackObj，仅 forward） |

ResourceHashtable 是 Hashtable 的 RAII 包装——基于 Arena 分配，Mark 析构时自动释放；KVHashtable 是 Key-Value 哈希表，用于符号表等场景。它们的设计原则都是"精确控制内存 + 无异常 + 确定性释放"。

## 汇编验证：vector push_back 的扩容

```cpp
#include <vector>
int main() {
    std::vector<int> v;
    v.push_back(42);       // 第 1 次：capacity 0→1
    v.push_back(100);      // 第 2 次：capacity 1→2，触发扩容
}
```

```bash
g++ -std=c++11 -O2 -g -o vec_test vec_test.cpp
objdump -d -M intel vec_test | grep -A 30 '<main>'
```

关键汇编片段（GCC -O2）：

```asm
; push_back 内部的容量检查
mov    rax, QWORD PTR [rbx+8]    ; rax = _M_finish
cmp    rax, QWORD PTR [rbx+16]   ; 比较 _M_end_of_storage
je     .L_expand                  ; 相等 → 跳转到扩容逻辑
; 容量足够：直接在 _M_finish 处写入
mov    DWORD PTR [rax], 0x2a     ; 写入 42
add    QWORD PTR [rbx+8], 4      ; _M_finish += sizeof(int)

.L_expand:
; 扩容路径：计算新容量、realloc、拷贝旧元素、释放旧空间
```

核心观察：**每次 push_back 都是一次 `_M_finish == _M_end_of_storage` 的指针比较 + 一次条件跳转**。扩容路径在冷分支（`unlikely`），第 6 章的性能优化告诉我们——热路径只有两三条指令。

> *详细讲解参见 C++ 教程: [STL 容器与算法](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-09-STL容器与算法.md)*
> *模板泛型基础参见 C++ 教程: [模板与泛型编程](../../my-openjdk/cpp/stage1-C++11基础/C++高级-05-模板与泛型编程.md)*

## 关键自查清单

- [ ] 能画出 vector 三指针（_M_start/_M_finish/_M_end_of_storage）的内存布局
- [ ] 能解释 vector 扩容的摊销 O(1) 证明（倍增策略）
- [ ] 能区分 GCC 2x 和 MSVC 1.5x 的增长策略及其内存复用差异
- [ ] 能说出 deque 的分段连续实现原理
- [ ] 掌握迭代器失效规则表——push_back 扩容后哪些迭代器失效？list::insert 后呢？
- [ ] 能解释 map（红黑树）和 unordered_map（哈希表）的底层差异与选型依据
- [ ] 能解释 COW 为什么被 C++11 废弃（三个致命缺陷）
- [ ] 能画出 SSO 的内存布局（15 字节阈值）
- [ ] 能说出 HotSpot 不用 STL 的 5 大原因（无异常/启动期/GC 安全点/编译膨胀/分配器不匹配）
- [ ] 能在汇编层面辨识 vector push_back 的容量检查指令序列
