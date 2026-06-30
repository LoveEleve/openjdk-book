# 运算符重载

C++ 允许程序员为自定义类型定义运算符的行为——`+`、`==`、`[]`、`()` 都可以被重载。这不是语法糖，而是让自定义类型获得与内置类型同等表现力的语言机制。但正如 Java 之父 James Gosling 所说："I left out operator overloading because I had seen too many people abuse it in C++。"权力和责任从来都是绑定的。

## 从 HotSpot 出发：oop 的 operator->

HotSpot 的 oop（ordinary object pointer）是对 GC 堆中对象指针的封装。真正的对象是 `oopDesc*` 裸指针，但 JVM 用 `oop` 类包装了一层，通过 `operator->` 让 oop 像裸指针一样使用，同时隐藏 GC 期间对象可能移动的复杂性：

```cpp
// jdk11u-copy/src/hotspot/share/oops/oopsHierarchy.hpp — oop 类定义
class oop {
  oopDesc* _o;
 public:
  oopDesc* obj() const { return _o; }

  // 核心重载：让 oop 像指针一样使用
  oopDesc* operator->() const { return obj(); }

  // 赋值操作符
  oop& operator=(const oop& o) { _o = o.obj(); return *this; }

  // 比较操作符
  bool operator==(const oop o) const  { return obj() == o.obj(); }
  bool operator!=(const oop o) const  { return obj() != o.obj(); }
  bool operator==(void *p) const      { return obj() == p; }
  bool operator!=(void *p) const      { return obj() != p; }
};

// 使用：oop 完全透明地像指针一样工作
oop my_obj = ...;
my_obj->mark();   // operator-> 返回 oopDesc*，然后编译器自动访问成员
my_obj->klass();  // 完全像裸指针一样自然
```

这段代码展示了操作符重载的核心理念：**让封装后的类型拥有和裸指针一样的语法体验**。在 x86 上，编译器优化后 oop 的 `operator->` 产生的代码与直接使用裸指针完全相同，零运行时开销。

## 成员重载 vs 非成员重载

操作符重载可以是成员函数（`a.operator+(b)`）或非成员函数（`operator+(a, b)`）。选择标准：

```
操作符是否必须修改左操作数(this)？
  ├── 是（=、+=、++、[]、->）→ 必须是成员函数
  └── 否
       ├── 左操作数可能是非类类型？— 是（如 cout << obj、5 + a）→ 非成员
       └── 需要访问私有成员？— 是 → 非成员 + friend，否 → 非成员
```

**成员函数的硬性要求**：C++ 标准规定 `=`、`[]`、`()`、`->` 以及类型转换操作符**必须是成员函数**——因为它们的语义依赖于 `this` 必须是一个类对象，非成员函数无法满足这一约束。

为什么 `+` 推荐用非成员？对称性：

```cpp
class Complex {
  double re_, im_;
 public:
  Complex(double r = 0, double i = 0) : re_(r), im_(i) {}

  // 成员函数版本——5 + a 无法编译！因为 5.operator+(a) 不合法
  Complex operator+(const Complex& rhs) const {
    return Complex(re_ + rhs.re_, im_ + rhs.im_);
  }
};

// 非成员函数版本——左右参数完全对称
Complex operator+(const Complex& lhs, const Complex& rhs) {
  return Complex(lhs.re() + rhs.re(), lhs.im() + rhs.im());
}
// Complex result = 5 + a;  // OK: 5 隐式构造 Complex(5)，对称工作
// Complex result = a + 5;  // OK
```

## operator= 与自赋值检查

赋值操作符是最容易写出 bug 的重载。自赋值 `s = s` 看似不可能发生，但在指针别名场景下很常见：

```cpp
void dedup(String arr[], int i, int j) {
  arr[i] = arr[j];  // 如果 i == j，这就是自赋值！
}
```

经典实现：

```cpp
class String {
  char* data_;
  size_t size_;
 public:
  String(const char* s = "") {
    size_ = strlen(s);
    data_ = new char[size_ + 1];
    strcpy(data_, s);
  }

  // 赋值操作符——必须检查自赋值
  String& operator=(const String& other) {
    if (this == &other) return *this;  // 自赋值保护

    delete[] data_;                     // 释放旧资源
    size_ = other.size_;
    data_ = new char[size_ + 1];       // 分配新资源
    strcpy(data_, other.data_);         // 拷贝数据
    return *this;                       // 返回引用支持 a = b = c
  }
};
```

如果没有 `if (this == &other)` 检查，自赋值 `delete[] data_` 释放了 `other.data_`（因为 `this == &other`，所以 `other.data_` 就是 `data_` 本身），随后 `strcpy(data_, other.data_)` 从已释放的内存读取——UAF 崩溃。

**返回值为什么必须是 `String&`？** 支持连锁赋值 `a = b = c`。展开为 `a.operator=(b.operator=(c))`——`b.operator=(c)` 必须返回 `b` 的引用才能作为 `a.operator=` 的右操作数。

利用移动语义的 copy-and-swap 写法天然免疫自赋值：

```cpp
String& operator=(String other) {  // 按值传参（调用拷贝构造）
  swap(other);                     // 交换资源
  return *this;
}                                  // other 析构时释放旧资源
// 自赋值时：other 是 *this 的副本，swap 后 *this 拿回副本，other 持有原数据并析构——安全
```

## 复合赋值 += -= *= /=

复合赋值**必须是成员函数**（修改 `this`），**返回 `T&`**（支持链式调用）。最佳实践是用 `+=` 实现 `+`：

```cpp
class Vector {
  double x_, y_;
 public:
  Vector& operator+=(const Vector& rhs) {
    x_ += rhs.x_;
    y_ += rhs.y_;
    return *this;
  }

  // 非成员 + 复用 +=（DRY 原则）
  friend Vector operator+(Vector lhs, const Vector& rhs) {
    lhs += rhs;        // 复用 += 逻辑
    return lhs;        // lhs 是值拷贝，不影响原对象
  }
};
```

注意 `+` 的参数：`Vector lhs` 是按值传参——编译器会根据实参是左值还是右值自动选择拷贝或移动构造，不再需要两个重载。

## operator[] —— const 和非 const 两个版本

下标操作符**必须是成员函数**，**必须提供两个版本**（如果对象在 const 上下文还可能被使用）：

```cpp
class IntArray {
  int* data_;
  size_t size_;
 public:
  IntArray(size_t n) : size_(n), data_(new int[n]()) {}
  ~IntArray() { delete[] data_; }

  // 非 const 版本：可读可写
  int& operator[](size_t index) { return data_[index]; }

  // const 版本：只读
  const int& operator[](size_t index) const { return data_[index]; }
};

// 使用
IntArray arr(10);
arr[3] = 42;                      // 调用非 const 版本，返回 int&

const IntArray& carr = arr;
int val = carr[3];               // 调用 const 版本，返回 const int&
// carr[3] = 5;                  // 编译错误：const int& 不可赋值
```

为什么需要两个版本？如果只有非 const 版本，const 对象无法使用 `[]`——const 对象只能调用 const 成员函数。如果只有 const 版本，无法 `arr[i] = value`。调用选择由 `this` 的 const 属性决定：非 const 对象优先调非 const 版本，const 对象只能调 const 版本。

## operator() —— 函数调用操作符

`operator()` 让对象可以像函数一样被调用——也称为仿函数（functor）。C++11 的 lambda 本质上就是编译器自动生成的仿函数类：

```cpp
// Lambda 写法
auto is_even = [](int x) { return x % 2 == 0; };
auto it = std::find_if(v.begin(), v.end(), is_even);

// 编译器展开等价于：
struct __lambda_1 {
  bool operator()(int x) const { return x % 2 == 0; }
};
auto it = std::find_if(v.begin(), v.end(), __lambda_1());
```

**仿函数 vs 函数指针**：仿函数可以有状态（成员变量），函数指针不行；仿函数类型已知，编译器可以内联 `operator()`，函数指针只能间接调用。

```cpp
// 带状态的仿函数
class Accumulator {
  int sum_ = 0;
 public:
  void operator()(int x) { sum_ += x; }
  int sum() const { return sum_; }
};

Accumulator acc;
acc(10); acc(20); acc(30);
// 等同于 std::for_each(v.begin(), v.end(), std::ref(acc));
```

**汇编验证**——仿函数的 `operator()` 可以被内联。对比这段代码的编译结果：

```asm
; 仿函数：编译器确定类型 → 内联
; acc(10) 展开为: acc.sum_ += 10   （add dword ptr [rbx], 10）
; 函数指针：编译器不知道目标 → 间接调用
; (*fp)(10) 展开为: call rax      （无法内联）
```

## operator bool 与 safe bool idiom

让自定义类型在 `if` 条件中可用，但避免隐式转换到无关类型的危险：

```cpp
// C++98 危险方案
class Ptr98 {
  int* p_;
 public:
  operator bool() const { return p_ != nullptr; }
};

Ptr98 sp;
if (sp) {}           // OK: 期望用法
int x = sp + 5;      // DANGER! sp → bool(true=1) → 1+5=6
bool b = sp << 2;    // DANGER! 位移操作也合法了

// C++11 安全方案：explicit operator bool
class Ptr11 {
  int* p_;
 public:
  explicit operator bool() const { return p_ != nullptr; }
};

Ptr11 sp;
if (sp) {}           // OK: 条件上下文中 explicit 转换自动生效
// int x = sp + 5;  // 编译错误！无法隐式转换
// bool b = sp << 2; // 编译错误！
```

`explicit operator bool()` 只在布尔上下文（`if`、`while`、`for`、`&&`、`||`、`!`、`?:`）中自动生效——这正是 safe bool idiom 的现代解决方案。`std::unique_ptr`、`std::shared_ptr`、`std::function`、`std::ifstream` 都使用这个机制。

## 不可重载的操作符

C++ 标准规定以下操作符**不能被重载**——这是语言的底线保证：

| 操作符 | 为什么不能重载 |
|--------|---------------|
| `::` | 不是作用于对象，是编译期命名空间解析 |
| `.` | 语言保证 `.` 永远表示直接成员访问，不能被劫持 |
| `.*` | 与 `.` 同理，成员指针访问 |
| `?:` | 唯一的三元操作符，语法特殊不可泛化 |
| `sizeof` | 编译期求值，不涉及运行期对象 |
| `typeid` | 编译期/RTTI 操作 |
| `static_cast` 等四种 cast | 编译期关键字，不是表达式操作符 |
| `#` / `##` | 预处理器操作，不进入编译阶段 |

**记忆技巧**：分两类——要么是编译期就已决定的（`sizeof`、`::`、cast），要么是语言保证不被覆盖的基础语义（`.`、`?:`）。

## 为什么 HotSpot 很少用运算符重载

翻阅 HotSpot 源码，除了 oop 体系的 `operator->`、`operator==` 外，几乎看不到运算符重载的影子。原因有三：

**1. 可读性高于数学美**。JVM 的核心代码是几十万行的系统软件，由数百名工程师维护。`region.do_allocation()` 比 `region << allocation` 自文档化得多——读代码的人不需要查重载定义就能理解语义。HotSpot 选择牺牲数学表达的简洁性来换取代码的直观性。

**2. 调试友好**。运算符重载让控制流变得不透明。GDB 中 `p v[i]` 可能需要查 vtable 才能确定调用了哪个 `operator[]`——而 `v.at(i)` 可以直接看到方法名。对于需要单步调试 GC 暂停、JIT 编译的 JVM 工程师来说，每一步操作都应该是可追踪的。

**3. ostream 太重**。标准库的 `<<` 操作符需要 `<ostream>`，这个头文件编译代价巨大且会引入局部数据（`std::cout` 内部的 `ios_base::Init` 静态对象）。HotSpot 使用轻量的 `outputStream` 体系——直接调用 `st->print_cr("msg")` 而不是 `*st << "msg"`。

但 HotSpot 精准地在**关键边界**使用了运算符重载：oop 需要像指针一样工作，所以重载 `->`；GC Root 需要比较相等性，所以重载 `==`。每个重载都有工程上的充分理由——不是为了"像数学一样美丽"，而是为了**在类型安全的前提下消除语法噪音**。

## 小结 checklist

- [ ] 能说出至少 5 个不可重载的操作符及其原因
- [ ] 知道 `=`、`[]`、`()`、`->` 为什么必须是成员函数
- [ ] 能手写带自赋值检查的 `operator=`
- [ ] 能手写 `operator[]` 的 const 和非 const 两个版本
- [ ] 理解 `explicit operator bool()` 的 safe bool idiom
- [ ] 能解释 `operator->` 的 drill-down 行为
- [ ] 知道 HotSpot 为什么只在 oop 边界用运算符重载而非泛滥使用
- [ ] 理解仿函数 `operator()` 与 lambda 的关系

> *详细讲解参见 C++ 教程: [操作符重载实战](../my-openjdk/cpp/stage1-C++11基础/C++高级-14-操作符重载实战.md)*
