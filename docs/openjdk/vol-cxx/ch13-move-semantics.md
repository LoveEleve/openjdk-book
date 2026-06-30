# 移动语义与右值引用

C++11 之前，拷贝是唯一的数据转移方式——哪怕源对象马上要销毁，也必须深拷贝一份。移动语义改变了这一切：对于"即将消亡"的临时对象，直接窃取其内部资源而非拷贝，避免昂贵的深拷贝开销。本章从 HotSpot 的 Handle 体系自然引出移动的核心思想。

## 从 HotSpot 出发：Handle 的转移语义

HotSpot 的 Handle 类封装了指向 Java 对象的间接指针（`oop*`），用于 GC 期间的安全引用。Handle 体系不依赖 C++11 的移动语义——因为 HotSpot 编译时使用 `-std=c++98`——但 Handle 之间的赋值行为本质上就是"转移所有权"：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/handles.hpp — Handle 类
class Handle {
 private:
  oop* _handle;                    // 指向 HandleArea 中 oop 的指针

 public:
  Handle()                            : _handle(NULL) {}
  Handle(oop obj);                    // 在 HandleArea 中分配
  Handle(Thread* thread, oop obj);    // 在指定线程的 HandleArea 分配

  // 赋值——源 Handle 保持有效（拷贝 oop 指针值），而非"移动后置空"
  Handle& operator=(const Handle& h) {
    if (_handle != NULL) *_handle = h();
    return *this;
  }

  oop operator()() const {           // 隐式获取 oop 值
    return (_handle != NULL) ? *_handle : oop(NULL);
  }
};
```

`Handle` 的赋值是值拷贝（拷贝 `oop` 值本身，而非指针的所有权），但我们可以从这个设计中看到移动语义的雏形：**Handle 不拥有它指向的 oop**，它只是一个间接层。当你"交给"另一个 Handle 时，语义上发生了所有权的视角转移——这正是 `std::move` 想要表达的概念。HotSpot 用简单的方式（值拷贝 + HandleMark 批释放）实现了同样的目的，而 C++11 用右值引用提供了语言级的支持。

## 值类别：左值、右值、将亡值

C++11 定义了三种值类别，用一个图最清晰：

```
                           表达式
                              │
              ┌───────────────┼───────────────┐
              ▼                               ▼
          glvalue                           rvalue
    (泛左值——有标识)                   (右值——可移动)
              │                               │
        ┌─────┴─────┐                 ┌───────┴───────┐
        ▼           ▼                 ▼               ▼
     lvalue      xvalue            prvalue
    (左值)      (将亡值)           (纯右值)

左值 (lvalue)：有名字、有地址、表达式结束后依然存在
  int x = 42;        // x 是左值——有名字，可取 &x
  int* p = &x;       // *p 也是左值——解引用得到有名字对象
  arr[3]             // 数组元素是左值
  ++x                // 前缀++返回左值（修改后自身）

纯右值 (prvalue)：临时对象、字面量、没有标识
  42, 3.14, true     // 字面量
  a + b              // 算术表达式结果是临时值
  std::string("hi")  // 显式创建的临时对象
  x++                // 后缀++返回右值（旧值副本）

将亡值 (xvalue)：有标识但即将被移动的对象
  std::move(x)       // 显式标记"可以被移走"
  std::string&& r = std::string("bye");  // r 本身是左值，但绑定的是将亡值
```

**判断口诀**：能用 `&` 取地址且表达式结束后还存在的是左值；`std::move` 的结果是将亡值（xvalue——即将消亡的左值）；其余临时对象是纯右值（prvalue——马上消失）。

## 右值引用 T&& 语法

```cpp
int a = 42;
int&  lref = a;      // 左值引用：只绑定左值
// int&  lref2 = 42; // 错误：左值引用不能绑右值

int&& rref = 42;     // 右值引用：只绑定右值
// int&& rref2 = a;  // 错误：右值引用不能直接绑左值

int&& rref3 = std::move(a);  // OK: std::move 将左值转为右值
```

注意一个微妙点：**右值引用变量本身是左值**。`int&& rref = 42;` 中的 `rref` 有名字、可以取地址 `&rref`，因此 `rref` 是左值。要把 `rref` 当作右值传递，需要再次 `std::move(rref)`。

## std::move 的本质：cast，不是移动

`std::move` 不执行任何移动操作。它是**无条件将参数转为右值引用**的 `static_cast`：

```cpp
// std::move 简化实现
template<typename T>
typename std::remove_reference<T>::type&& move(T&& t) noexcept {
  return static_cast<typename std::remove_reference<T>::type&&>(t);
}

// move(string&)   → string&&
// move(string&&)  → string&&
```

真正的"移动"发生在移动构造函数或移动赋值运算符被调用时。`std::move` 的作用仅仅是把左值标记为"可以移动"。

### 汇编验证：移动比拷贝少一次深拷贝

对比拷贝构造和移动构造的汇编：

```cpp
void copy_test(const std::vector<int>& src) {
  std::vector<int> dst = src;   // 拷贝：分配新内存 + memcpy 所有元素
}

void move_test(std::vector<int>&& src) {
  std::vector<int> dst = std::move(src);  // 移动：交换三个指针
}
```

```asm
; copy_test 的核心操作（简化）：
call operator new[]          ; 1. 分配新堆内存（malloc）
call memcpy                  ; 2. 拷贝 N 个 int（O(N)）

; move_test 的核心操作（简化）：
mov rax, [rdi]               ; 1. 读取 src 的内部指针
mov [rsi], rax               ; 2. 写入 dst 的内部指针
mov qword ptr [rdi], 0       ; 3. 把 src 的内部指针置 null
; 没有 malloc，没有 memcpy——O(1)，仅三条 mov
```

`std::vector` 的移动构造只交换三个指针（begin、end、capacity），时间 O(1)——与元素数量无关。

## 移动构造函数与移动赋值运算符

```cpp
class Buffer {
  char* data_;
  size_t size_;
 public:
  Buffer(const char* s = "") : size_(strlen(s)), data_(new char[size_+1]) {
    strcpy(data_, s);
  }

  // 拷贝构造：深拷贝
  Buffer(const Buffer& other)
    : size_(other.size_), data_(new char[size_+1]) {
    std::copy(other.data_, other.data_ + size_ + 1, data_);
  }

  // 移动构造：窃取资源，源对象置空
  Buffer(Buffer&& other) noexcept
    : size_(other.size_), data_(other.data_) {
    other.data_ = nullptr;   // 让 other 可以安全析构
    other.size_ = 0;
  }

  // 移动赋值——经典写法，有自赋值检查
  Buffer& operator=(Buffer&& other) noexcept {
    if (this != &other) {           // 自移检查（虽然少见）
      delete[] data_;               // 释放旧资源
      data_ = other.data_;          // 窃取
      size_ = other.size_;
      other.data_ = nullptr;        // 源置空
      other.size_ = 0;
    }
    return *this;
  }

  ~Buffer() { delete[] data_; }
};
```

**移动后源对象的状态**：`other.data_` 被设为 `nullptr`，让其析构函数安全执行但不释放已移走的资源（`delete[] nullptr` 是 no-op）。标准把它称为"有效但未指定状态"（valid but unspecified）——可以安全销毁，可以重新赋值，但不能假设有之前的值。

## 完美转发 std::forward 与万能引用

万能引用（forwarding reference）是 `T&&` 用于模板推导时的特殊行为——它可以绑定左值也可以绑定右值：

```cpp
template<typename T>
void wrapper(T&& arg) {      // T&& 是万能引用（不是右值引用）
  foo(std::forward<T>(arg)); // 完美转发：保持 arg 的原始值类别
}
```

**引用折叠规则**是这背后的机制：

```
T&  + &  → T&      只要有左值引用参与，结果就是左值引用
T&  + && → T&
T&& + &  → T&
T&& + && → T&&     只有全是右值引用，结果才是右值引用
```

当传入左值时 `T` 推导为 `T&`，引用折叠后 `T& &&` → `T&`（左值引用）。传入右值时 `T` 推导为 `T`（非引用），`T&&` 保持为右值引用。`std::forward` 利用这个机制有条件地恢复原始值类别：

```cpp
// 调用分析
std::string s("hello");
wrapper(s);                     // T=string&,  T&&=string&,  forward→string&  (左值)
wrapper(std::string("bye"));    // T=string,   T&&=string&&, forward→string&& (右值)
wrapper(std::move(s));          // T=string,   T&&=string&&, forward→string&& (右值)
```

**`std::move` vs `std::forward` 的简洁区分**：

| | std::move | std::forward |
|---|----------|-------------|
| 行为 | 无条件转为右值 | 有条件地转（左值保持左值，右值转为右值） |
| 使用场景 | "我确定这个值不再需要了" | "我不知道原始是左值还是右值，原样转发" |
| 典型用法 | `v2 = std::move(v1)` | `foo(std::forward<T>(arg))` |

## Rule of 5（与 Rule of 3 的扩展）

Rule of 3（C++98）：如果自定义了析构、拷贝构造、拷贝赋值中的一个，大概率需要全部三个。Rule of 5（C++11）在此基础上增加移动构造和移动赋值：

```cpp
class Resource {
  int* data_;
 public:
  Resource(int v) : data_(new int(v)) {}
  ~Resource() noexcept { delete data_; }          // ① 析构

  Resource(const Resource& o)                     // ② 拷贝构造
    : data_(new int(*o.data_)) {}
  Resource& operator=(const Resource& o) {        // ③ 拷贝赋值
    if (this == &o) return *this;
    delete data_;
    data_ = new int(*o.data_);
    return *this;
  }

  Resource(Resource&& o) noexcept                 // ④ 移动构造
    : data_(o.data_) { o.data_ = nullptr; }
  Resource& operator=(Resource&& o) noexcept {    // ⑤ 移动赋值
    if (this != &o) {
      delete data_;
      data_ = o.data_;
      o.data_ = nullptr;
    }
    return *this;
  }
};
```

**编译器自动生成规则**：一旦你声明了拷贝构造、拷贝赋值、移动构造、移动赋值或析构中的任一，编译器就不会自动生成移动操作。如果你声明了移动操作但没有声明拷贝操作，拷贝操作会被自动标记为 `=delete`。

## RVO/NRVO vs std::move —— 编译器比 move 更聪明

返回局部对象时，**不要写 `return std::move(x)`**——这会妨碍编译器优化：

```cpp
// 错误：std::move 阻止了 NRVO
Heavy makeHeavy() {
  Heavy h;
  return std::move(h);  // BAD! 强制移动，阻止 NRVO
}

// 正确：让编译器做 RVO/NRVO
Heavy makeHeavy() {
  Heavy h;
  return h;  // 编译器直接在调用方栈帧上构造 h——零拷贝
}
```

RVO（Return Value Optimization）/ NRVO（Named RVO）是编译器直接在调用方的内存位置构造返回值对象，完全消除拷贝和移动。C++17 起 RVO 在特定情况下是强制的——而 `std::move(h)` 会把这个优化路径堵死，强制执行一次移动构造。

```
无 RVO：makeHeavy() 栈帧 → 拷贝到临时 → 拷贝到 caller 栈帧（两次拷贝）
有 RVO：直接在 caller 栈帧构造（零拷贝）
std::move(h)：makeHeavy() 栈帧 → 移动到 caller（一次移动，比零次差）
```

`std::move` 只在**你想要从非临时对象转移所有权**时才用——比如 `v2 = std::move(v1)`、`vec.push_back(std::move(local_obj))`。返回局部变量时，相信编译器。

## HotSpot 的 Handle 体系与移动语义的对比

回到起点。HotSpot 的 Handle 实现了类似移动的效果，但走的是不同的路：

| 维度 | C++11 移动语义 | HotSpot Handle |
|------|---------------|---------------|
| 所有权模型 | 移动后源对象为"移后"状态 | 拷贝 oop 值，源 Handle 不变 |
| 内存释放 | 依赖 std::unique_ptr/析构 | 依赖 HandleMark 批量回滚 |
| 异常安全 | 依赖 noexcept 声明 | HandleArea 基于 Arena，不涉及异常 |
| 性能特征 | O(1) 指针交换 | O(1) 值拷贝 + HandleArea 标记 |
| 设计哲学 | 语言级资源窃取 | 设计模式级资源管理 |

Handle 不需要"移动后清空源对象"——因为 Handle 不拥有它指向的 oop。Handle 是一个**观察者**，而不是**所有者**。HandleMark 统一管理所有 Handle 的内存（Arena 回滚），不需要 C++11 移动语义来解决资源管理问题。这是另一种哲学：用更简单的机制实现可预测的行为。

## 小结 checklist

- [ ] 能区分左值、右值、将亡值三种值类别并举例
- [ ] 理解 `std::move` 是 cast 不是移动，真正的移动发生在移动构造/赋值被调用时
- [ ] 能手写移动构造函数和移动赋值运算符（包括源对象置空）
- [ ] 理解万能引用 `T&&` 的引用折叠规则
- [ ] 能区分 `std::move`（无条件转右值）和 `std::forward`（有条件转发）
- [ ] 能说出 Rule of 5 包含哪五个函数
- [ ] 知道为什么 `return std::move(local)` 是错误做法
- [ ] 能用汇编解释移动比拷贝少了深拷贝（无 malloc/memcpy，仅指针交换）
- [ ] 理解 HotSpot Handle 不依赖 C++11 移动语义的设计原因

> *详细讲解参见 C++ 教程:*
> - [右值引用与移动语义](../my-openjdk/cpp/stage1-C++11基础/C++高级-04-C++11新特性全解.md) (第六节)
> - [完美转发与引用折叠](../my-openjdk/cpp/stage1-C++11基础/C++高级-13-引用与const—C++的指针演进.md) (第三节)
