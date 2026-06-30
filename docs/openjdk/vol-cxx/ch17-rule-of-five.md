# Rule of 3/5/0 与构造语义

HotSpot 中 `StackObj`、`CHeapObj`、`ResourceObj` 不只是一个分类标记——它们通过继承来**强制分配策略**。`StackObj` 把 `operator new` 声明为 private 禁止堆分配，`CHeapObj` 把 `operator new` 重载到 `malloc`，`ResourceObj` 把 `operator new` 重载到 Arena。这种"继承改变分配行为"的设计是 Rule of 3/5/0 在工程实践中的教科书级应用。本章从编译器的合成决策出发，走向 NRV、placement new 和 HotSpot 分配器。

## HotSpot 源码切入点：三种分配基类

```cpp
// jdk11u-copy/src/hotspot/share/memory/allocation.hpp 第 219-228 行
class StackObj ALLOCATION_SUPER_CLASS_SPEC {
 private:
  void* operator new(size_t size) throw();
  void  operator delete(void* p);
  // operator new[] / delete[] 也声明为 private
};

// 第 137-158 行
class CHeapObj {
 public:
  void* operator new(size_t size) throw();
  void  operator delete(void* p);
  // 走 C Heap (os::malloc / os::free)
};

// 第 161 行起
class ResourceObj {
 public:
  void* operator new(size_t size, Arena* arena) throw();
  // 走 ResourceArea (Arena bump-pointer)
};
```

三种基类的设计核心：通过**继承**让子类自动获得正确的 `operator new`——编译器在编译期就确定了调用哪个分配函数（零开销抽象，无虚函数调用）。

## Rule of 3：如果有自定义析构/拷贝/赋值之一，三个全写

**法则：** 如果类需要自定义析构函数、拷贝构造函数或拷贝赋值运算符之一，几乎肯定需要三个全部。

```cpp
// 违反 Rule of 3 的典型：管理资源但只写了析构
class BadString {
  char* _data;
 public:
  BadString(const char* s) { _data = new char[strlen(s)+1]; strcpy(_data, s); }
  ~BadString() { delete[] _data; }
  // 没写拷贝构造！编译器生成 bitwise copy
};

BadString s1("hello");
BadString s2 = s1;    // s2._data == s1._data → 指向同一堆内存
// 析构时 double free → 崩溃
```

**编译器何时合成拷贝构造？** 四个触发条件：

| 条件 | 说明 |
|------|------|
| 成员对象有非平凡拷贝构造 | 编译器合成版：调用成员的拷贝构造 |
| 基类有非平凡拷贝构造 | 编译器合成版：调用基类的拷贝构造 |
| 有虚函数 | 必须正确复制 vptr（拷贝 vptr 指向当前类的 vtable） |
| 有虚基类 | 必须正确处理 vbptr 和虚基类子对象 |

**关键提示（C++11 后）：** 如果类声明了移动构造或移动赋值，编译器**不会**生成隐式拷贝构造和拷贝赋值。这是 C++11 的规则——声明移动语义意味着对象有"独特所有权语义"，默认 bitwise copy 可能破坏它。

## Rule of 5：C++11 加上移动构造/移动赋值

```cpp
class RuleOfFive {
  char* _data;
  size_t _size;
 public:
  ~RuleOfFive() { delete[] _data; }                // 1. 析构

  RuleOfFive(const RuleOfFive& o)                  // 2. 拷贝构造
    : _size(o._size) { _data = new char[_size]; memcpy(_data, o._data, _size); }

  RuleOfFive& operator=(const RuleOfFive& o) {     // 3. 拷贝赋值
    if (this != &o) { delete[] _data; _size = o._size;
                      _data = new char[_size]; memcpy(_data, o._data, _size); }
    return *this;
  }

  RuleOfFive(RuleOfFive&& o) noexcept              // 4. 移动构造
    : _data(o._data), _size(o._size) { o._data = nullptr; o._size = 0; }

  RuleOfFive& operator=(RuleOfFive&& o) noexcept { // 5. 移动赋值
    if (this != &o) { delete[] _data; _data = o._data; _size = o._size;
                      o._data = nullptr; o._size = 0; }
    return *this;
  }
};
```

**移动的核心：** 转移资源所有权，源对象置为"空"状态（`nullptr`），防止双重释放。

## Rule of 0：值语义成员让编译器自动生成

```cpp
class RuleOfZero {
  std::string name;               // string 正确管理拷贝/移动/析构
  std::vector<int> data;          // vector 同样
  std::unique_ptr<Impl> pImpl;   // unique_ptr 是非拷贝但可移动
 public:
  // 不需要写任何特殊成员函数！编译器自动生成的都正确
};
```

**理念：** 用标准库类型管理资源，让编译器合成的特殊成员函数自然正确。Rule of 0 不是"什么都不做"，而是"把正确的行为委托给已正确实现的值语义成员"。

## =default 与 =delete 的精确语义

### 编译器合成特殊成员函数的完整条件表

| 条件 | 默认构造 | 拷贝构造 | 拷贝赋值 | 析构 | 移动构造 | 移动赋值 |
|------|:--:|:--:|:--:|:--:|:--:|:--:|
| 没有自定义 + 无阻碍 | 合成 | 合成 | 合成 | 合成 | 合成 | 合成 |
| 有虚函数 | 合成（设 vptr） | 合成（复制 vptr） | 合成 | 合成（设 vptr） | 合成 | 合成 |
| 有虚基类 | 合成（设 vbptr） | 合成 | 合成 | 合成 | 合成 | 合成 |
| 成员有自定义 X | 合成（调成员 X） | 合成（调成员 X） | 合成（调成员 X） | 合成（调成员 X） | — | — |
| 已自定义 X | **不合成 X** | **不合成 X** | **不合成 X** | **不合成 X** | **不合成** | **不合成** |
| 声明移动操作 | — | **隐式删除** | **隐式删除** | — | — | — |
| 声明析构/拷贝/移动任一个 | — | — | — | — | **不合成** | **不合成** |

**=default 的语义：** 显式要求编译器合成。效果与隐式合成相同，但意图明确：

```cpp
class Example {
 public:
  Example() = default;                         // 显式要求编译器合成默认构造
  Example(const Example&) = default;           // 显式要求编译器合成拷贝构造
  Example& operator=(Example&&) = default;     // 显式要求编译器合成移动赋值
};
```

**=delete 的语义：** 显式禁止特定操作。HotSpot 用此禁止 StackObj 的 new/delete：

```cpp
class StackObj {
  void* operator new(size_t) = delete;   // 禁止 new StackObj→编译错误
  void operator delete(void*) = delete;  // 禁止 delete →编译错误
};

class NonCopyable {
  NonCopyable(const NonCopyable&) = delete;            // 禁止拷贝
  NonCopyable& operator=(const NonCopyable&) = delete;
};
```

**关键规则：声明了移动操作后拷贝操作被隐式删除。** 如果你需要两者共存，必须显式 `= default` 拷贝操作。

## NRV（Named Return Value Optimization）：编译器消灭拷贝

```cpp
HeavyObject create() {
    HeavyObject obj;    // 栈上局部变量
    obj.setup();
    return obj;         // 按值返回
}

HeavyObject result = create();  // 调用方
```

**没有 NRV 时：** `create()` 栈帧构造 obj → 拷贝到调用者提供的临时位置 → 拷贝构造 result。两次拷贝。

**NRV 优化后（GCC -O2）：**

```
// 编译器将函数签名转换为：
void create(HeavyObject* __result) {   // 隐藏参数：返回存储位置
    new (__result) HeavyObject();      // 直接在调用者的位置构造！
    __result->setup();                 // 初始化和操作都在原地
    // ★ 0 次拷贝——obj 就是 __result
}
```

**C++ 标准演变：**

| 标准 | Copy Elision 行为 |
|------|-------------------|
| C++98/11 | 允许但不强制（编译器可选） |
| C++14 | 允许但不强制 |
| **C++17** | **强制** copy elision（纯右值场景）；NRV 仍可选但主流编译器都做 |

**NRV 生效条件：**
- 返回的是函数内**局部自动变量**（非参数，非全局）
- 返回类型和局部变量类型一致（忽略 cv 限定符）
- 函数通常只有单一返回路径（多路径可能抑制，取决于编译器实现）

**不能触发 NRV：**
```cpp
HeavyObject copy_of(HeavyObject param) { return param; }  // 返回参数→不触发
HeavyObject& get_ref() { static HeavyObject obj; return obj; }  // 返回引用→不触发
```

**验证 NRV（地址对比法）：**

```bash
$ cat > nrvo_demo.cpp << 'EOF'
#include <cstdio>
struct Big {
    char data[64];
    Big()  { printf("Big()  at %p\n", this); }
    Big(const Big& o) { printf("Big(&) from %p to %p\n", &o, this); }
    ~Big() { printf("~Big() at %p\n", this); }
};
Big create() { Big b; printf("local b at %p\n", &b); return b; }
int main() { Big result = create(); printf("result at %p\n", &result); }
EOF

$ g++ -std=c++17 -O2 -o nrvo_on nrvo_demo.cpp
$ ./nrvo_on
Big()  at 0x7fff1234    # 直接在 result 位置构造
local b at 0x7fff1234   # b 和 result 地址相同！
result at 0x7fff1234
~Big() at 0x7fff1234    # 只有一次析构——没有临时对象

$ g++ -std=c++17 -O0 -fno-elide-constructors -o nrvo_off nrvo_demo.cpp
$ ./nrvo_off
Big()  at 0x7fff1200    # create 栈帧
local b at 0x7fff1200
Big(&) from 0x7fff1200 to 0x7fff1260  # 拷贝到临时
~Big() at 0x7fff1200    # b 析构
Big(&) from 0x7fff1260 to 0x7fff1290  # 拷贝到 result
~Big() at 0x7fff1260    # 临时析构
result at 0x7fff1290
~Big() at 0x7fff1290    # result 析构
```

## 拷贝省略 vs std::move from return

**不要对 return 的局部变量用 `std::move`：**

```cpp
HeavyObject create() {
    HeavyObject obj;
    return std::move(obj);  // 错误！抑制了 NRV
}
```

`std::move(obj)` 返回一个右值引用——编译器不能再做 NRV（NRV 要求返回的是"名字"）。结果是强制调用移动构造函数（如果可用）或拷贝构造函数。移动通常比 NRV 昂贵（NRV 是 0 次操作）。

```cpp
HeavyObject create() {
    HeavyObject obj;
    return obj;             // ✓ NRV → 0 次拷贝/移动
}

HeavyObject pass_through(HeavyObject obj) {
    return std::move(obj);  // ✓ 不能触发 NRV（是参数），用 move 是对的
}
```

## placement new：在已有内存上构造

普通 `new` = 分配内存 + 调用构造。`placement new` = 只调用构造（不分配内存）。

```cpp
#include <new>

alignas(Widget) char buf[sizeof(Widget)];  // 栈上内存
Widget* w = new (buf) Widget(42);          // 在 buf 上构造 Widget

// 清理（没有对应的 placement delete！）
w->~Widget();  // 手动析构

// 内部实现：operator new(size_t, void*) 直接返回 ptr
void* operator new(size_t, void* ptr) noexcept { return ptr; }
```

**三个关键点：**
- placement new **不分配内存**（`operator new` 实现只是 `return ptr`）
- **没有 placement delete**：必须手动调用析构函数 `obj->~T()`
- 内存地址必须满足类型的**对齐要求**（用 `alignas` 确保）

## operator new/delete 重载：HotSpot 的分配策略

HotSpot 通过类级别重载 `operator new` 实现零成本分配策略选择：

```
继承 MetaspaceObj → new 走 Metaspace::allocate()
继承 CHeapObj     → new 走 os::malloc() / os::free()
继承 ResourceObj  → new 走 Arena::Amalloc() (placement new 语法)
继承 StackObj     → new 被 =delete 禁止（只能栈上实例化）
```

**CHeapObj 的 operator new（`allocation.hpp:137`）：**

```cpp
class CHeapObj {
 public:
  void* operator new(size_t size) {
    return (void*)os::malloc(size, mtInternal);  // 走 C Heap
  }
  void operator delete(void* p) {
    os::free(p);
  }
};
```

**ResourceObj 的 operator new——placement new 语法：**

```cpp
class ResourceObj {
 public:
  void* operator new(size_t size, Arena* arena) {
    return arena->Amalloc(size);   // bump-pointer 分配
  }
  void* operator new(size_t size) = delete;  // 禁止普通 new
};

// 使用：必须传入 Arena
ResourceObj* obj = new (arena) ResourceObj();
```

**StackObj 的 operator new——禁止堆分配：**

```cpp
class StackObj {
 private:
  void* operator new(size_t size) = delete;    // private + delete
  void  operator delete(void* p) = delete;
};

// MutexLockerEx 继承 StackObj
// new MutexLockerEx(...) → 编译错误！
```

子类自动继承这些 `operator new`——编译器在编译期就确定了调用哪个分配函数，零虚函数分发开销。

## HotSpot 三种分配器全景

| 分配器 | 基类 | 内存来源 | 释放策略 | 代表使用者 |
|--------|------|---------|---------|-----------|
| **C Heap** | CHeapObj | os::malloc | os::free（一对一） | CodeBlob, NMethod |
| **Metaspace** | MetaspaceObj | Metaspace::allocate | 整体释放（类卸载或 JVM 退出） | Klass, Method, ConstantPool |
| **Arena** | ResourceObj | ResourceArea（线程本地） | Arena 析构时批量回滚 | 编译器阶段的临时节点 |
| **Stack** | StackObj | 栈（禁止 new） | 离开作用域自动析构 | MutexLockerEx, ResourceMark |

**Arena 的批量释放设计：**

Arena 不做逐块释放——它在 chunk 中线性增长（bump-pointer），ResourceMark 保存水位线，析构时一次回滚：

```cpp
// ResourceMark 的 O(1) 释放
{
  ResourceMark rm;                              // 保存水位线
  for (int i = 0; i < 1000; i++) {
    ParseNode* n = new (arena) ParseNode(i);     // 在 Arena 上分配
  }
}  // rm 析构：Arena 水位线一次回滚 → 1000 个对象全部归还
```

对比 C 的逐个 free：1000 次 `free()` vs 1 次水位线赋值 `_hwm = saved_hwm`。

## 编译器合成决策树

```
用户定义了 X？
  ├── Yes → 不为 X 合成（用户负责）
  ├── =delete → 显式禁用
  └── No → 类是否"需要" X？
            ├── 成员/基类有非平凡 X → 合成（递归调用）
            ├── 有虚函数 → 合成（管理 vptr）
            ├── 有虚基类 → 合成（管理 vbptr）
            └── 以上皆否 → trivial 声明（不产生任何代码）

特殊规则（C++11 后）：
  - 声明移动构造/赋值 → 隐式删除拷贝构造/赋值
  - 声明析构/拷贝/移动中任一个 → 不合成移动操作（需显式 =default）
```

## GDB 验证

**验证 NRV 优化效果（见上文"验证 NRV"部分）。**

**验证 operator new 重载的调用链：**

```bash
$ g++ -std=c++17 -g -O0 -o alloc_test alloc_test.cpp
$ gdb ./alloc_test

(gdb) break 'CHeapObj::operator new'
(gdb) break 'MetaspaceObj::operator new'
(gdb) break 'operator new(unsigned long, Arena*)'   # ResourceObj 的
(gdb) run
# 观察顺序：先 MetaspaceObj（new InstanceKlass），
#           再 CHeapObj（new CodeBlob），
#           最后 Arena（new(arena) ResourceObj 的 placement new）
```

**验证 placement new 的零分配行为：**

```bash
(gdb) break 'operator new(unsigned long, void*)'
(gdb) run
# 进入断点后：
(gdb) print ptr
$1 = 0x7fffffffe100     # 就是传入的缓冲区地址
# 函数体只有 "return ptr"——没有任何 malloc 调用
```

## 关键自查清单

- [ ] Rule of 3: 什么场景触发？如何正确实现拷贝构造/拷贝赋值/析构？
- [ ] Rule of 5: C++11 新增的移动构造/移动赋值与移动语义的关系？
- [ ] Rule of 0: 什么条件下编译器自动生成的特殊成员函数是全部正确的？
- [ ] =default 和 =delete 的精确语义：何时合成、何时禁止、何时隐式删除？
- [ ] NRV: 编译器如何消除返回值拷贝？生效条件和失效场景？
- [ ] 为什么 `return std::move(local_var)` 是错误的？（抑制 NRV）
- [ ] placement new: 和普通 new 的本质区别？为什么没有对应的 delete？
- [ ] operator new/delete 重载：如何通过继承实现零成本分配策略选择？
- [ ] HotSpot 三种分配器：CHeapObj/MetaspaceObj/ResourceObj 分别走什么路径？
- [ ] 编译器合成决策树：什么条件下合成、什么条件下隐式删除、什么条件下 trivial？

> *详细讲解参见 C++ 教程: [C++高级-08-构造语义与内存管理](../../../my-openjdk/cpp/stage2-对象模型深度/C++高级-08-构造语义与内存管理.md)*
