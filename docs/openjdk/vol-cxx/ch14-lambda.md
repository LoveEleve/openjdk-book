# Lambda 表达式与闭包

HotSpot 的 C++ 代码库历史跨越 C++98 到 C++11，所以你会在源码中看到两种风格：旧的仿函数（functor）+ 宏，以及某些较新工具代码中的 lambda。理解 lambda 的本质——它只是编译期生成的匿名仿函数类——就能看懂这两者的等价关系。

## HotSpot 的仿函数传统：为什么少用 lambda？

HotSpot 中广泛使用仿函数作为回调机制。以 GC 容器的遍历为例：

```cpp
// jdk11u-copy/src/hotspot/share/gc/g1/g1CollectedHeap.cpp
// 典型的 HotSpot 回调模式——通过函数对象（仿函数）配合迭代
class G1CollectedHeap {
  // ...
  void object_iterate(ObjectClosure* cl);
};

// ObjectClosure 是一个带有 operator() 的抽象基类（仿函数模式）
// jdk11u-copy/src/hotspot/share/gc/shared/collectedHeap.hpp
class ObjectClosure : public Closure {
 public:
  virtual void do_object(oop obj) = 0;
};
```

如果 C++11 lambda 能直接上场，上面的代码可以简化为：

```cpp
// 假设 HotSpot 接受了 lambda（实际它没有，因为需要兼容旧编译器和调试器）
g1h->object_iterate([](oop obj) {
    // 就地定义回调逻辑
});
```

但 HotSpot 选择不用 lambda，原因有三：
1. **编译时间**：lambda 每次定义都是独立的匿名类型，大量使用会显著增加编译时间
2. **调试器友好度**：仿函数有明确的类名和虚函数调用链；lambda 调试时需要记住编译器生成的匿名类名
3. **C++98 兼容**：HotSpot 在 JDK 9+ 才升级到 C++11，但内部很多基础代码仍保持 C++98 兼容风格

## Lambda 语法全解

完整的 lambda 语法：

```
[capture](parameters) mutable -> return_type { body }
│       │           │        │           │
│       │           │        │           └─ 函数体
│       │           │        └─ 尾置返回类型（通常可省略）
│       │           └─ mutable：允许修改值捕获的副本
│       └─ 参数列表（可省略）
└─ 捕获列表（最重要）
```

最小形式的 lambda：

```cpp
auto f1 = []{};                   // 空 lambda，什么都不做
auto f2 = []{ return 42; };       // 无参数时可省略 ()
auto f3 = [](int x){ return x*2; }; // 标准形式
auto f4 = [](int x) -> double {     // 显式返回类型
    return x * 3.14;
};
```

## 捕获方式详解

捕获列表决定了 lambda 是"引用外部变量"还是"拥有外部变量的副本"——这是闭包（closure）的本质。

```cpp
int a = 1, b = 2, c = 3;

// = 值捕获所有——只读副本
auto by_value = [=]{ return a + b + c; };
// lambda 成员：int _a(a), _b(b), _c(c);
// operator() const → 不能修改 _a, _b, _c

// & 引用捕获所有——可修改外部变量
auto by_ref = [&]{ a += b; c *= 2; };
// lambda 成员：int& _a(a), int& _b(b), int& _c(c);

// 混合捕获
auto mixed = [a, &b]{ return a + b; };  // a 值捕获，b 引用捕获
auto mixed2 = [=, &c]{ return a + b + c; };  // 默认值捕获，c 例外引用
auto mixed3 = [&, a]{ return a + b + c; };   // 默认引用，a 例外值

// this 捕获——访问成员变量
struct S {
    int x = 42;
    auto make_lambda() {
        return [this]{ return x; };  // 等价于 [=]{ return x; }
        // C++14: [*this]——捕获 this 的副本（安全但拷贝整个对象）
    }
};

// C++14 初始化捕获——最灵活
auto p = std::make_unique<int>(42);
auto init_cap = [p = std::move(p)]{ return *p; };
// 把 unique_ptr 移动到 lambda 内部（C++11 做不到）
```

## 底层实现：编译器生成的匿名仿函数类

lambda 的本质是编译器自动生成一个匿名类，捕获变量成为类成员，函数体成为 `operator()`。

```cpp
// 你写的
int a = 100, b = 200;
auto lambda = [a, &b](int x) -> int {
    return a + b + x;
};

// 编译器生成的（逻辑等价）
class __lambda_12345 {
private:
    int a;     // 值捕获 → int 成员（副本）
    int& b;    // 引用捕获 → int& 成员（引用）
public:
    __lambda_12345(int _a, int& _b) : a(_a), b(_b) {}
    int operator()(int x) const {  // 默认 const！← mutable 改变这点
        return a + b + x;
    }
};
auto lambda = __lambda_12345(a, b);  // 栈上构造，捕获那时 a,b 的值
```

**关键推论：**
- 无捕获的 lambda → `operator()` 是静态函数 → **可隐式转为函数指针**
- 有捕获的 lambda → 每个 lambda 是独立类型 → 不能用函数指针承接
- lambda 的大小 = 所有捕获变量的大小之和（考虑对齐）

### GDB 验证 lambda 的类型和大小

```bash
$ cat > lambda_test.cpp << 'EOF'
#include <iostream>

int main() {
    int a = 100, b = 200;
    auto l1 = [a, &b](int x) { return a + b + x; };
    auto l2 = [](int x) { return x * 2; };

    std::cout << "sizeof(l1) = " << sizeof(l1) << std::endl;
    std::cout << "sizeof(l2) = " << sizeof(l2) << std::endl;
    std::cout << l1(50) << std::endl;
    return 0;
}
EOF

$ g++ -std=c++11 -g -O0 -o lambda_test lambda_test.cpp
$ gdb ./lambda_test

(gdb) break main
(gdb) run

(gdb) p sizeof(l1)
$1 = 16    # int a(4字节) + int& b(8字节, 64位指针) + 4字节padding

(gdb) p sizeof(l2)
$2 = 1     # 无捕获 lambda，大小为 1 字节（占位）

(gdb) ptype l1
type = struct __lambda_12345 {
  // 闭包对象——匿名编译器生成类
}

(gdb) info locals
l1 = {a = 100, b = @0x7fffffffdabc}  # a 是副本(100)，b 是引用
l2 = {/* empty */}
```

**关键发现**：GDB 能直接显示 lambda 的成员变量——验证了"捕获变量成为成员"的底层实现。

## mutable 关键字的含义

```cpp
int counter = 0;

// 值捕获的 lambda 默认 operator() const
auto f1 = [counter]() {
    // counter++;  // 编译错误！operator() 是 const，不能修改成员
    return counter;
};

// mutable 去除 const 限制——只影响副本，不影响外部
auto f2 = [counter]() mutable {
    counter++;       // OK！修改的是 lambda 内部的副本
    return counter;
};

f2();  // counter 副本从 0 变 1，外部 counter 仍为 0
f2();  // counter 副本从 1 变 2
std::cout << counter;  // 0——外部不受影响

// mutable 的语义："值捕获的变量可以在函数体内被修改"
// 但修改的是副本，不影响原始变量
```

## std::function：类型擦除的可调用对象包装器

有捕获的 lambda 不能转为函数指针——但可以存入 `std::function`。

```cpp
#include <functional>

int base = 100;

// 函数指针——不能捕获
int (*ptr)(int) = [](int x) { return x * 2; };  // OK：无捕获

// std::function——可以捕获
std::function<int(int)> f = [base](int x) { return base + x; };  // OK
std::function<int(int)> g = [](int x) { return x + 1; };         // 也能收无捕获

// 统一存储异构可调用对象
std::vector<std::function<void(int)>> callbacks;
callbacks.push_back([](int x) { std::cout << "lambda: " << x; });
callbacks.push_back(&some_function);
// 多种来源，统一类型
```

### std::function 的 SBO（小对象优化）

```
std::function<int(int)> 对象布局（典型实现）：
┌──────────────────────────────────────┐
│  内部缓冲区（16~32 字节）              │  ← SBO：小对象直接存这里
│  （或多个函数指针）                   │
├──────────────────────────────────────┤
│  如果可调用对象 > SBO 阈值：          │
│  └──→ 堆上的实际对象（动态分配）       │
└──────────────────────────────────────┘
```

大多数 lambda（捕获少量变量）能享受 SBO，不触发堆分配。但如果 lambda 捕获了大对象（如 `std::vector`），就会退化为堆分配 + 间接调用。

### 汇编验证：std::function 的间接调用开销

```cpp
#include <functional>

template<typename F>
int apply_template(int x, F f) {
    return f(x);  // 编译器知道 F 的具体类型 → 可内联
}

int apply_function(int x, std::function<int(int)> f) {
    return f(x);  // 间接调用 → 无法内联
}
```

```asm
; apply_template（可内联）：
    ; 如果 f 是简单 lambda，整个调用可能被内联为几条指令
    lea eax, [rdi+1]       ; x + 1 直接计算
    ret

; apply_function（间接调用）：
    push rbp
    mov rbp, rsp
    mov edi, edi           ; 准备参数 x
    call [rsi+24]          ; 通过函数指针间接调用 ← 额外开销
    pop rbp
    ret
```

`call [rsi+24]` 是一次**间接跳转**——CPU 分支预测器无法预判目标地址，可能触发流水线清空。在热点循环中，这是可测量的性能差异。这就是为什么 `std::function` 适合**存储异构回调**（类型擦除），而**模板**适合**内联的极致性能**。

## 泛型 lambda（C++14 auto 参数）

```cpp
// C++14：用 auto 参数实现泛型 lambda
auto generic = [](auto a, auto b) { return a + b; };

generic(1, 2);          // int → int
generic(1.5, 2.5);      // double → double
generic("hello"s, " world"s);  // string → string

// 等价于——只是编译器自动生成了模板 operator()
struct __generic_lambda {
    template<typename T1, typename T2>
    auto operator()(T1 a, T2 b) const { return a + b; }
};

// C++20 模板 lambda（更明确的语法）
auto templ = []<typename T>(std::vector<T> v) {
    return v.size();
};
```

## Lambda vs 仿函数：HotSpot 中的等价图景

HotSpot 的 GC `Closure` 抽象基类（仿函数模式）与 C++ lambda 的等价关系：

```cpp
// HotSpot 方式：虚函数 + 派生类（C++98 风格）
class ObjectClosure {
 public:
  virtual void do_object(oop obj) = 0;
};

class MyObjectCounter : public ObjectClosure {
  int _count = 0;
 public:
  void do_object(oop obj) override { _count++; }
  int count() const { return _count; }
};

MyObjectCounter cl;
g1h->object_iterate(&cl);
int n = cl.count();

// C++11 lambda 等价方式：
int count = 0;
g1h->object_iterate([&count](oop obj) {
    count++;
});
// count 引用捕获 → 闭包的成员是 int& → 修改 count 直接影响外部

// HotSpot 继续用第一种方式的原因：
// 1. 类型有名字 → GDB 中可设断点 ObjectClosure::do_object
// 2. 派生类可以在多个地方复用
// 3. 编译时间可控
```

lambda 的代码量更少、逻辑更就地；仿函数的调试更友好、编译更快。两者在性能上等价——编译后都是直接的函数调用（或内联），没有额外开销。

## 汇编验证：值捕获 lambda 的成员存储位置

```cpp
int a = 100, b = 200;
auto lambda = [a, &b](int x) { return a + b + x; };
```

在栈上的内存布局（x86_64）：

```
栈帧（高地址 → 低地址）：
┌─────────────┐
│  b = 200     │  ← 外部变量 b
├─────────────┤
│  a = 100     │  ← 外部变量 a
├─────────────┤
│  b 引用(8B)  │  ─┐  lambda 对象：int& _b (8 字节)
├─────────────┤   │
│  a 副本(4B)  │  ←│  lambda 对象：int _a (4 字节)
│  padding(4B) │   │  lambda 对象：对齐 padding
├─────────────┤   │
│  x（参数）   │   │  → 栈帧或者寄存器
└─────────────┘   │
                  │
    &b 引用      ←┘  指向外部 b 的地址
```

GDB 可以直接查看 lambda 内部：

```bash
(gdb) p lambda
$1 = {a = 100, b = @0x7fffffffdabc}
#     ^值副本  ^引用，指向外部 b
```

## 小结 Checklist

- [ ] lambda 语法：`[capture](params) -> ret { body }`，编译器生成匿名仿函数类
- [ ] 值捕获 `=` / `[a,b]`：变量作为 const 副本存入 lambda 成员
- [ ] 引用捕获 `&` / `[&a]`：变量作为引用存入 lambda 成员
- [ ] mutable 关键字：去除 operator() 的 const 限制，允许修改值捕获副本（不影响外部）
- [ ] 无捕获 lambda 可隐式转为函数指针；有捕获的不能
- [ ] std::function 通过类型擦除统一包装可调用对象，SBO 优化小对象
- [ ] std::function 的间接调用无法内联，热点循环优先用模板而非 std::function
- [ ] Lambda 本质 = 编译器生成的匿名仿函数类 + 捕获变量为成员 + operator()
- [ ] GDB 可验证 lambda 大小 = 捕获变量大小之和，ptype 可查看匿名类型
- [ ] HotSpot 少用 lambda 原因：编译时间、调试器友好度、C++98 遗留兼容

> *详细讲解参见 C++ 教程: [C++11 新特性全解——lambda 表达式](../../../my-openjdk/cpp/stage1-C++11基础/C++高级-04-C++11新特性全解.md)*
