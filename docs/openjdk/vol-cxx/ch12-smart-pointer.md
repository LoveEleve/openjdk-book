# 智能指针：unique_ptr / shared_ptr / weak_ptr

GC 堆上的 Java 对象会被 GC 移动——所以 HotSpot 不能直接持有 `oop*` 裸指针。JVM 用 Handle 体系解决这个问题：Handle 是一个"oop 指针的指针"，GC 移动对象时只需更新 Handle 指向的那个 oop，所有引用方自动跟进。这和 C++11 智能指针"管理裸指针生命周期"的思想异曲同工——但 HotSpot 的 Handle 有自己的特殊性（GC 安全点集成、全局 Handle 表），所以没有直接使用标准库。

## HotSpot 的 Handle：GC 安全点上的智能引用

```cpp
// jdk11u-copy/src/hotspot/share/runtime/handles.hpp 第 64-100 行
class Handle {
 private:
  oop* _handle;  // 指向 handle area 中的 oop 指针槽位

 public:
  Handle(Thread* thread, oop obj);  // 构造：在 handle area 分配槽位
  Handle(Thread* thread, Handle* handle);

  oop operator() () const { return _handle == NULL ? NULL : *_handle; }
  oop operator->() const { return *_handle; }

  // 禁止拷贝——每个 Handle 是一个独立的槽位
  Handle(const Handle& h) = delete;
  void operator=(const Handle& h) = delete;
};
```

Handle 的设计要点：
- **双重间接**：`Handle → oop* → oopDesc`，GC 移动对象时只改中间那个 `oop*`
- **不可拷贝**（C++11 `= delete`）：拷贝会创建指向同一槽位的新 Handle，破坏所有权模型
- **局部性**：Handle 分配在线程的 HandleArea（Arena 内存），HandleMark 析构时整体回滚

这本质上是一个"作用域绑定的智能引用"——生命周期由 RAII HandleMark 管理，所有权不可拷贝。这与 `unique_ptr` 的设计哲学一致：独占、不可拷贝、离开作用域自动释放。

## C++11 标准库的智能指针全景

C++11 提供了三种智能指针，解决裸指针的三大问题——忘记 delete（泄漏）、异常不安全（提前 return/抛异常跳过 delete）、所有权模糊（谁来 delete？）。

| 类型 | 所有权 | 拷贝 | 释放时机 | 额外开销 |
|------|--------|------|---------|---------|
| `unique_ptr` | 独占 | 禁止，只能 move | 离开作用域 | 零（与裸指针等大） |
| `shared_ptr` | 共享 | 允许，引用计数 +1 | 最后一个 shared_ptr 析构 | 两个指针 + 原子计数 |
| `weak_ptr` | 不拥有 | 允许，不影响计数 | 不负责释放 | 与 shared_ptr 配合 |

## unique_ptr：独占所有权的零开销抽象

```cpp
#include <memory>

// 基本使用
std::unique_ptr<int> p1(new int(42));
auto p2 = std::make_unique<int>(42);  // C++14，推荐

*p1 = 100;           // 像裸指针一样使用
int* raw = p1.get(); // 获取裸指针（不转移所有权）

// 不可拷贝，只能移动
// auto p3 = p1;     // 编译错误！拷贝构造被 = delete
auto p3 = std::move(p1);  // OK：所有权转移
assert(p1 == nullptr);    // p1 现在是空

// 自定义删除器
auto file_deleter = [](FILE* f) { if (f) fclose(f); };
std::unique_ptr<FILE, decltype(file_deleter)> f(fopen("test.txt", "r"), file_deleter);
```

### unique_ptr 的底层实现

```cpp
template<typename T, typename Deleter = std::default_delete<T>>
class unique_ptr {
    T* ptr_;              // 一个裸指针，无额外开销
    Deleter deleter_;     // 如果 Deleter 是空类（默认删除器），EBO 优化为 0 字节
public:
    unique_ptr(const unique_ptr&) = delete;
    unique_ptr& operator=(const unique_ptr&) = delete;
    unique_ptr(unique_ptr&& other) noexcept : ptr_(other.release()) {}

    ~unique_ptr() { if (ptr_) deleter_(ptr_); }

    T* release() noexcept { T* p = ptr_; ptr_ = nullptr; return p; }
    T* get() const noexcept { return ptr_; }
    T& operator*() const { return *ptr_; }
    T* operator->() const noexcept { return ptr_; }
};
```

关键设计点：
- **拷贝 = delete**：编译期禁止拷贝，确保所有权唯一
- **EBO（空基类优化）**：默认删除器 `std::default_delete` 是空类，通过 `[[no_unique_address]]` 或 EBO 占 0 字节
- **零开销**：`sizeof(unique_ptr<T>) == sizeof(T*)` 当 Deleter 是空类时

### 汇编验证：unique_ptr 优化后与裸指针零开销

```cpp
#include <memory>
int deref_raw(int* p) { return *p; }
int deref_unique(std::unique_ptr<int>& p) { return *p; }
```

用 `g++ -O2 -std=c++17` 编译后：

```asm
; deref_raw:
    mov eax, DWORD PTR [rdi]    ; 从 rdi 加载 *p
    ret

; deref_unique:
    mov eax, DWORD PTR [rdi]    ; 完全相同！编译器透视了 unique_ptr
    ret
```

编译器在优化后直接消解了 `unique_ptr` 的包装，生成的汇编与裸指针完全一致。零开销抽象名副其实。

## shared_ptr：引用计数与共享所有权

```cpp
auto s1 = std::make_shared<int>(42);  // 引用计数 = 1
auto s2 = s1;                          // 引用计数 = 2
auto s3 = s1;                          // 引用计数 = 3
s2.reset();                            // s2 放弃，引用计数 = 2
s3.reset();                            // s3 放弃，引用计数 = 1
s1.reset();                            // 引用计数 = 0，对象被 delete

// 获取引用计数（仅用于调试）
std::cout << "use_count = " << s1.use_count() << std::endl; // 0
```

### 控制块（Control Block）结构

shared_ptr 对象本身存储**两个指针**——指向对象和指向控制块：

```
shared_ptr 对象（16 字节，x86_64）
┌──────────────────────┐
│  T* ptr_             │ ───►  ┌─────────────┐
│                       │      │  T object    │
├──────────────────────┤      └─────────────┘
│  control_block* ctrl_ │ ───►  ┌─────────────────────┐
└──────────────────────┘       │  shared_count        │ ← 强引用计数 (atomic)
                                │  weak_count          │ ← 弱引用计数 (atomic)
                                │  Deleter             │ ← type-erased deleter
                                │  Allocator           │ ← type-erased allocator
                                └─────────────────────┘
                                    控制块 (control block)
```

控制块包含四个部分：
1. **shared_count**：强引用计数，`std::atomic<long>`，原子操作维护
2. **weak_count**：弱引用计数，`std::atomic<long>`，所有 weak_ptr 的计数
3. **Deleter**：类型擦除的删除器（通过虚函数/函数指针实现）
4. **Allocator**：类型擦除的分配器（同上）

### 控制块的创建时机

控制块在哪创建取决于构造方式：

```cpp
// 方式 1：shared_ptr<T>(new T(...))
//   创建 2 次分配：T 对象 + 控制块（分别在堆上）
std::shared_ptr<int> sp1(new int(42));

// 方式 2：make_shared<T>(...)
//   创建 1 次分配：T 对象 + 控制块 一起分配
auto sp2 = std::make_shared<int>(42);

// 方式 3：shared_ptr<T>(unique_ptr<T>)
//   从 unique_ptr 转移，只创建控制块
std::unique_ptr<int> up(new int(42));
std::shared_ptr<int> sp3 = std::move(up);
```

`make_shared` 一次性分配（对象 + 控制块），带来三个好处：一次 malloc（而非两次）、更好的缓存局部性（对象和控制块相邻）、异常安全（不会因赋值顺序导致泄漏）。

### 线程安全的两层含义

```cpp
// 1. 引用计数操作是线程安全的（原子操作）
std::shared_ptr<int> sp = std::make_shared<int>(0);

void reader() {
    auto local = sp;     // 拷贝增加引用计数——原子安全
    // 使用 local...
}

void writer() {
    sp = std::make_shared<int>(42);  // 替换——原子安全
}

// 2. 指向对象的访问不是线程安全的
// 如果多个线程同时修改 *sp，需要额外同步！
```

**结论**：shared_ptr 保证"引用计数的变化是线程安全的"，但不保证"指向对象的内容是线程安全的"。共享指针不等于共享数据安全。

### 汇编验证：引用计数的原子操作开销

```cpp
#include <memory>
void copy_shared(std::shared_ptr<int>& dst, const std::shared_ptr<int>& src) {
    dst = src;
}
```

GCC -O2 生成的汇编（关键部分）：

```asm
; dst = src 的核心操作：
mov rax, QWORD PTR [rsi+8]     ; 读取 src 的控制块指针
lock add QWORD PTR [rax], 1    ; lock 前缀！原子增加引用计数
```

`lock add` 的 `lock` 前缀就是 shared_ptr 相比 unique_ptr 多出的开销——每次拷贝/析构都要经过总线锁定，确保多核缓存一致性。这也是为什么优先用 `unique_ptr`：它完全没有这个原子开销。

### make_shared 的内存布局优势

```cpp
auto sp1 = std::shared_ptr<int>(new int(42));
// 两次分配：
//   int @ 0x1000    (可能在堆的任意位置)
//   控制块 @ 0x2000  (可能在堆的任意位置)
//   访问对象可能需要两次 cache line 加载

auto sp2 = std::make_shared<int>(42);
// 一次分配：
//   [控制块][int]
//   @ 同一块连续内存
//   一次 cache line 加载就能覆盖两者
```

`make_shared` 唯一的代价：如果有 weak_ptr 存在，对象占用的内存要等所有 weak_ptr 也释放后才归还（因为对象和控制块在同一块内存）。如果对象很大且 weak_ptr 存活时间长，优先用 `new shared_ptr`。

## weak_ptr：打破循环引用

```cpp
// 问题：shared_ptr 的循环引用
struct B;
struct A {
    std::shared_ptr<B> b_ptr;
    ~A() { std::cout << "A destroyed" << std::endl; }
};
struct B {
    std::shared_ptr<A> a_ptr;  // 循环引用！
    ~B() { std::cout << "B destroyed" << std::endl; }
};

auto a = std::make_shared<A>();
auto b = std::make_shared<B>();
a->b_ptr = b;
b->a_ptr = a;  // 循环：a → b → a，两个对象都不会被释放
// 离开作用域：a 和 b 的引用计数都降为 1（从 2 降下来）
// → 永远到不了 0 → 内存泄漏
```

**解决方案：把其中一侧改为 weak_ptr。**

```cpp
struct B_Fixed {
    std::weak_ptr<A> a_ptr;  // 弱引用，不增加 shared_count
};
```

weak_ptr 的核心操作：

```cpp
std::shared_ptr<int> sp = std::make_shared<int>(42);
std::weak_ptr<int> wp = sp;

// 1. 检查对象是否还存活
if (wp.expired()) {
    // 所有 shared_ptr 已释放
}

// 2. 尝试获取 shared_ptr（原子操作）
if (auto locked = wp.lock()) {
    std::cout << *locked << std::endl;  // 安全使用
    // locked 是 shared_ptr，保证对象在锁定期间不会被释放
}

// 3. 如果对象已释放——行为
auto bad = wp.lock();
assert(bad == nullptr);  // 返回空 shared_ptr
```

`lock()` 的原子性保证了**没有 TOCTOU 竞态**：不会出现在你检查 `expired()` 返回 false 和开始使用之间的间隙中对象被另一个线程释放——`lock()` 是原子地检查并提升引用计数。

## 三者的关系与选型决策树

```
你需要管理一个堆对象的生命周期吗？
 │
 ├── 只有一个所有者？
 │   └── YES → std::unique_ptr
 │       （零开销，语义最清晰）
 │
 ├── 有多个所有者，但生命周期不对等？
 │   └── "父"用 unique_ptr，"子"用裸指针/weak_ptr
 │
 ├── 真的需要共享所有权？
 │   └── std::shared_ptr
 │       （引用计数，有额外开销）
 │       │
 │       ├── 存在循环引用？
 │       │   └── 用 weak_ptr 打破循环
 │       │
 │       └── 不需要自定义 deleter？
 │           └── 用 make_shared（一次分配）
 │
 └── 你只是"观察"一个 shared_ptr？
     └── std::weak_ptr（不增加引用计数）
```

## HotSpot Handle 体系与 C++ 智能指针对比

为什么 HotSpot 自己实现 Handle 体系而不是直接使用 C++11 智能指针？

| 维度 | HotSpot Handle | C++11 smart_ptr |
|------|---------------|-----------------|
| **双重间接** | `Handle → oop* → oopDesc` | 单间接 `ptr → Object` |
| **GC 集成** | GC 移动对象时更新 `oop*`，Handle 自动跟进 | 无 GC 概念，对象不移动 |
| **内存管理** | HandleArea (Arena) + HandleMark RAII 批量回滚 | 析构时 delete (per-object) |
| **安全点检查** | 构造时可控制 safepoint check（JVM 特有） | 无此概念 |
| **全局 Handle 表** | JNI Handle 需要跨线程存活，由全局表管理 | shared_ptr 引用计数 |
| **拷贝语义** | = delete（值槽位不可共享） | unique_ptr = delete；shared_ptr 引用计数 |
| **使用风格** | "值语义"——Handle 是栈对象，operator() 取值 | "指针语义"——operator-> 和 operator* |

核心原因：HotSpot 的 Handle 不是通用的内存管理工具，而是 **GC 安全点协议的一部分**。它的双重间接（oop 指针的指针）是为 GC 移动对象设计的，不是为"自动 delete"设计的。释放由 HandleMark/HandleArea 的 Arena 回滚机制处理，不需要引用计数。

如果 JVM 用 `shared_ptr<oopDesc>`，GC 移动对象时所有 `shared_ptr` 的裸指针都需要更新——这需要扫描整个堆来找 `shared_ptr` 对象，比更新 Handle 槽位中间层的开销大得多。

## 移动后状态与 use_count 陷阱

```cpp
// unique_ptr 移动后：源 = nullptr
auto u1 = std::make_unique<int>(42);
auto u2 = std::move(u1);
assert(u1 == nullptr);  // OK
// *u1;  // 未定义行为！

// shared_ptr 拷贝后：指向相同对象
auto s1 = std::make_shared<int>(42);
auto s2 = s1;
std::cout << s1.use_count();  // 2
// *s1 = 100; → *s2 也变成 100（同一对象）
```

## 小结 Checklist

- [ ] unique_ptr 独占所有权、零开销（优化后与裸指针汇编一致）
- [ ] unique_ptr 禁止拷贝（= delete）、支持移动（move）
- [ ] 默认删除器通过 EBO 优化为 0 字节
- [ ] shared_ptr 通过控制块的原子引用计数共享所有权
- [ ] 控制块包含 shared_count、weak_count、type-erased Deleter/Allocator
- [ ] make_shared 一次分配对象+控制块，但有 weak_ptr 延迟释放代价
- [ ] weak_ptr 的 lock() 原子地检查并提升引用计数，解决 TOCTOU 竞态
- [ ] 循环引用用 weak_ptr 打破：父→子 shared_ptr，子→父 weak_ptr
- [ ] HotSpot Handle 是 GC 安全点协议的专用设计（双重间接），不是通用智能指针
- [ ] 优先用 unique_ptr（零开销），次要 shared_ptr，观察用 weak_ptr

> *详细讲解参见 C++ 教程: [C++基础-动态内存分配](../../../my-openjdk/cpp/stage0-基础语法/C++基础-动态内存分配.md)*
> *详细讲解参见 C++ 教程: [C++11 新特性全解——智能指针](../../../my-openjdk/cpp/stage1-C++11基础/C++高级-04-C++11新特性全解.md)*
