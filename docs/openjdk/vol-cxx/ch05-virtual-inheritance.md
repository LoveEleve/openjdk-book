# 虚函数、纯虚函数与多态

C++ 的虚函数机制让"通过基类指针调用子类方法"成为可能——这是面向对象多态的核心。要真正理解虚函数，不能停留在"有虚函数就多一个指针"的表面，而要追问：这个指针指向什么？它是怎么工作的？

## virtual 关键字与 vtable 机制

`virtual` 关键字告诉编译器：这个函数的调用不要静态绑定，要运行时查表分发。

C++ 中声明为 `virtual` 的成员函数通过 vtable（虚函数表）进行运行时分发。vtable 的本质是一张**函数指针数组**——每个含有虚函数的类都有一个独立的 vtable，存储在只读数据段（`.data.rel.ro`），编译期由编译器创建，程序加载时随可执行文件一起映射到内存。

vtable 的结构如下（以 GCC Itanium ABI 为例）：

```
vtable 布局：
┌─────────────────────────────────┐
│ vtable[-2]: offset_to_top (0)  │  ← 虚基类相关
├─────────────────────────────────┤
│ vtable[-1]: type_info ptr      │  ← RTTI（运行时类型信息）
├─────────────────────────────────┤  ← vptr 指向这里
│ vtable[0]:  第一个虚函数地址     │  ← 按声明顺序排列
├─────────────────────────────────┤
│ vtable[1]:  第二个虚函数地址     │
├─────────────────────────────────┤
│ vtable[2]:  第三个虚函数地址     │
├─────────────────────────────────┤
│ ...                             │
└─────────────────────────────────┘
```

vptr 指向 vtable[0]（第一个虚函数），而不是 vtable 的起始地址。vtable[-1] 存储 type_info 指针，供 `typeid` 和 `dynamic_cast` 使用。

对比非虚函数和虚函数：

```cpp
class A {
 public:
  void foo() { /* A's foo */ }
};
class B : public A {
 public:
  void foo() { /* B's foo */ }
};
A* ptr = new B();
ptr->foo();  // 调用 A::foo()——编译期根据指针类型 A* 静态绑定
```

```cpp
class A {
 public:
  virtual void foo() { /* A's foo */ }
};
class B : public A {
 public:
  void foo() override { /* B's foo */ }
};
A* ptr = new B();
ptr->foo();  // 调用 B::foo()——运行时通过 vtable 动态分发
```

## 虚函数调用的实际过程：两次指针解引用

虚函数调用的开销到底有多大？以 `ptr->f()` 为例，编译器将其转换为：

1. 从对象首部取出 vptr（一次内存访问）
2. 从 vtable 中取出对应的函数指针（第二次内存访问）
3. 通过函数指针调用

对应 x86_64 汇编：

```asm
; b->func() 的简化汇编
mov rax, [rdi]          ; 1. 从对象首地址取 vptr
mov rax, [rax]          ; 2. 从 vtable[0] 取函数地址
call rax                ; 3. 间接调用
```

两次指针解引用就是虚函数调用的全部额外开销。相比直接调用（0 次内存访问），虚函数调用多了 2 次内存访问，且因为目标地址只有在运行期才知道，编译器无法内联——这是真正的开销所在，而不是指令条数。

关键点：编译期确定 slot 偏移，运行期查表。编译器知道 `f` 是第一个虚函数对应 slot 0，但不知道 vptr 指向哪个类的 vtable——直到程序执行时才能确定。

单继承下的 vtable 布局：

```
class Base {
 public:
  int b_val;
  virtual void f() { }
  virtual void g() { }
  virtual void h() { }
};

class Derived : public Base {
 public:
  int d_val;
  void f() override { }      // 重写 f
  virtual void k() { }       // 新增虚函数
};
```

```
Base vtable:                      Derived vtable:
┌──────────────────┐              ┌──────────────────┐
│ type_info(Base)  │              │ type_info(Derived)│
├──────────────────┤ ← vptr       ├──────────────────┤ ← vptr
│ &Base::f()       │ slot 0       │ &Derived::f()    │ slot 0 ← 被覆盖
├──────────────────┤              ├──────────────────┤
│ &Base::g()       │ slot 1       │ &Base::g()       │ slot 1 ← 未重写，继承
├──────────────────┤              ├──────────────────┤
│ &Base::h()       │ slot 2       │ &Base::h()       │ slot 2 ← 未重写，继承
└──────────────────┘              ├──────────────────┤
                                  │ &Derived::k()    │ slot 3 ← 新增，追加
                                  └──────────────────┘
```

派生类重写虚函数时，覆盖原 slot 的函数指针；新增虚函数时，追加到 vtable 末尾分配新 slot。Base 子对象和 Derived 共享同一个 vptr——对象中只有一个 vptr，放在对象最前面。

## 对象内存布局：vptr 在哪儿？

对于含有虚函数的类，vptr 通常放在对象的最前面（偏移 0）。这样编译器不需要知道对象的实际类型就能从固定偏移读取 vptr。

```
Derived 对象（64 位系统）：
┌──────────────────┐  offset 0
│ vptr → vtable    │  8 bytes
├──────────────────┤  offset 8
│ b_val            │  4 bytes
├──────────────────┤  offset 12
│ d_val            │  4 bytes
└──────────────────┘
sizeof(Derived) = 16
```

如果一个类没有任何虚函数，对象中就只有数据成员，没有任何额外开销。虚函数的代价只有一个 vptr（8 字节），而不是虚函数代码本身的大小——函数代码只存在于代码段，不占用对象空间。

## 纯虚函数与抽象类

在虚函数声明后加 `= 0`，表示这个函数是"纯虚的"——基类不提供实现，子类必须覆盖。

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 49-63 行
class EventLog : public CHeapObj<mtInternal> {
  friend class Events;

 private:
  EventLog* _next;

  EventLog* next() const { return _next; }

 public:
  EventLog();

  virtual void print_log_on(outputStream* out) = 0;  // 纯虚函数
};
```

EventLog 声明 `print_log_on` 为纯虚函数。不同的日志子类——有的记录固定长度字符串，有的记录结构化数据——打印方式各不相同。基类无法给出一个"默认的打印方式"，所以干脆不实现，强制子类自己定义。

包含纯虚函数的类称为**抽象类**。抽象类不能被直接实例化：

```cpp
EventLog log;   // 编译错误！抽象类不能实例化
EventLog* ptr;  // 可以声明指针
```

派生类如果不覆盖所有纯虚函数，自身也保持为抽象类。

## override 和 final（C++11）

C++11 引入了 `override` 关键字，解决了一个容易出错的问题：派生类"想覆盖"基类虚函数，但因为签名不匹配而悄悄变成了"定义一个不相关的新函数"。

```cpp
class Base {
 public:
  virtual void process(int x);
};

class Derived : public Base {
 public:
  // 错误：参数类型 long 不匹配，这变成了一个新函数而不是覆盖
  // void process(long x);  // 编译器不会警告

  // 正确：用 override 让编译器检查
  void process(int x) override;  // OK
  // void process(long x) override;  // 编译错误！基类没有这个签名
};
```

`override` 解决的问题：
- 基类改变了虚函数签名 → 编译错误，立即发现
- 拼写错误（如 `proces` 而不是 `process`）→ 编译错误
- 忘记 `const`：`func()` vs `func() const` → 编译错误

`final` 有两个用途：

```cpp
class Base final { };  // 禁止派生
// class Derived : public Base {};  // 编译错误

class Parent {
 public:
  virtual void important() final;  // 禁止子类重写
};
```

实际场景：`final` 类用于值类型（不应该被继承），`final` 函数用于安全关键函数（强制所有子类使用同一实现）。

## 为什么基类析构函数必须是 virtual

这是 C++ 中最容易踩的坑。当通过基类指针删除派生类对象时，如果基类析构不是虚函数，只会调用基类的析构而不会调用派生类的析构——导致资源泄漏：

```cpp
class Base {
 public:
  ~Base() { }  // 非虚析构——危险！
};

class Derived : public Base {
  int* _data;
 public:
  Derived() : _data(new int[1000]) { }
  ~Derived() { delete[] _data; }
};

Base* p = new Derived();
delete p;  // 只调用 ~Base()，~Derived() 不执行！_data 泄漏！
```

修复方法：把基类析构声明为 `virtual`。这七个字符防止了内存泄漏。

规则：如果类可能被继承（即它有虚函数或会被作为基类使用），析构函数应该声明为 `virtual`。C++ 核心指南 C.35 明确写道：基类析构应该是 public virtual，或者 protected non-virtual。

## HotSpot 实操：EventLog 继承体系的多态

HotSpot 的 EventLog 日志系统是一个完整的多态应用实例。

EventLogBase 是 EventLog 的子类，实现了 `print_log_on`：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 71-135 行
template <class T> class EventLogBase : public EventLog {
  // ... 环形缓冲区实现 ...

 public:
  void print_log_on(outputStream* out);  // 实现 EventLog 的纯虚函数
};
```

更具体的子类 FormatStringEventLog 继承自 EventLogBase，继承了 `print_log_on` 的实现，同时提供格式化字符串的存储逻辑。

在 Events::print_all 中，多态机制驱动整个日志系统：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.cpp 第 53-58 行
void Events::print_all(outputStream* out) {
  EventLog* log = _logs;         // 基类指针
  while (log != NULL) {
    log->print_log_on(out);      // 多态调用——自动分发给子类版本
    log = log->next();           // 链表遍历
  }
}
```

`_logs` 链表中的每个节点可能是 StringEventLog、ExtendedStringEventLog 等不同子类对象。但代码只使用 `EventLog*` 基类指针，调用 `print_log_on` 时会通过 vtable 自动分发到各子类的实际实现——`Events::print_all` 一行 if 或 switch 都没有，每种子类的打印逻辑被正确调用。

这正是多态的核心价值：用一套代码操作不同类型的对象，运行时自动分发。新增一种日志格式只需新增一个子类，不需要修改已存在的遍历代码。

## HotSpot 实操：Klass 层级的虚函数

Klass 是 HotSpot 中所有 Java 类元数据的根基类，使用大量虚函数实现多态分发：

```cpp
// jdk11u-copy/src/hotspot/share/oops/klass.hpp 第 78 行
class Klass : public Metadata {
  // ...
  virtual int oop_size(oop obj) const = 0;     // 普通对象 vs 数组对象的大小不同
  virtual ModuleEntry* module() const = 0;
  virtual PackageEntry* package() const = 0;
  virtual oop protection_domain() const = 0;
  // ...
};
```

Klass 的注释（`klass.hpp:58-64`）解释了为什么有 oop/Klass 二分法：

```
// One reason for the oop/klass dichotomy in the implementation is
// that we don't want a C++ vtbl pointer in every object. Thus,
// normal oops don't have any virtual functions. Instead, they
// forward all "virtual" functions to their klass, which does have
// a vtbl and does the C++ dispatch depending on the object's
// actual type.
```

这是 JVM 设计师的一个关键决策：如果每个 Java 对象都带一个 8 字节的 vptr，数千万对象的堆就浪费了上百 MB。因此 oop（普通对象指针）没有虚函数，所有虚函数分发都委托给 Klass——Klass 有 vtable 做多态分发，而 oop 只存一个指向 Klass 的指针（压缩后仅 4 字节）。

调用链：Java 对象 → oop（无 vptr，只有 klass 指针）→ Klass（有 vptr，走 C++ 虚函数分发）。这种"二层 vtable"设计在空间效率和类型安全之间取得了平衡。
