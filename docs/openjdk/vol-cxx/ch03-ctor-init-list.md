# 构造函数与初始化列表

构造函数中冒号后面的部分叫做初始化列表（member initializer list）。在 HotSpot 源码中，你经常看到构造函数体为空——只有一个大括号 `{}`，所有工作都在初始化列表中完成了。这种写法不是风格偏好，而是 C++ 对象模型中初始化与赋值之间本质差异的体现。这一章从基本语法开始，讲解初始化列表的机制、陷阱和在 HotSpot 中的实际运用。

## 初始化列表的基本语法

初始化列表紧跟在构造函数参数列表的右括号之后，以冒号开头，各项用逗号分隔，最后是函数体：

```cpp
Foo() : _a(0), _b("hello") {}
```

HotSpot 中 `formatBuffer.hpp` 的 `FormatBufferBase` 给出了一个极简的例子：

```cpp
class FormatBufferBase {
 protected:
  char* _buf;
  inline FormatBufferBase(char* buf) : _buf(buf) {}
};
```

函数体是空的——初始化列表 `_buf(buf)` 已经完成了所有需要做的事：把参数 `buf` 存到成员 `_buf` 中。没有任何额外的指令需要执行。

## 初始化 vs 赋值——两种写法的本质差异

下面两段代码看起来效果一样，但编译器的处理完全不同：

```cpp
// 写法 A——初始化列表
Foo::Foo(int x) : _x(x) {}

// 写法 B——函数体内赋值
Foo::Foo(int x) {
    _x = x;  // 这是赋值，不是初始化
}
```

对 `int _x` 这样的基本类型，两种写法生成的机器码通常相同，差异只是风格问题。但对于类类型成员，差异就大了：初始化列表直接调用对应类型的构造函数完成初始化；函数体内赋值意味着成员**先被默认构造**，然后再被**拷贝赋值**，多了一次默认构造加一次赋值的开销。

对于一个持有 `std::string` 成员的类来说，初始化列表中写 `_name(name)` 只调用一次拷贝构造函数。而在函数体内写 `_name = name` 则需要先调用 `std::string` 的默认构造函数创建空字符串，再调用拷贝赋值运算符覆盖它。随着对象层次变深，这种差异会累积成可测量的性能损失。

## 三种必须使用初始化列表的场景

大部分情况下初始化列表是效率推荐而非语法必须，但有三种场景中初始化列表是**唯一的选择**。

第一种是 `const` 成员。`const` 修饰的变量一旦创建就不能被修改，而赋值是修改行为。C++ 规定 `const` 成员只能在初始化列表中初始化：

```cpp
class ImmutableConfig {
  const int _version;
 public:
  ImmutableConfig(int ver) : _version(ver) {}  // 必须用初始化列表
  // ImmutableConfig(int ver) { _version = ver; }  // 编译错误！
};
```

第二种是引用成员。引用在定义时必须绑定到一个已有对象，不能在函数体内"重新绑定"：

```cpp
class Logger {
  std::ostream& _out;
 public:
  Logger(std::ostream& out) : _out(out) {}  // 必须用初始化列表绑定
  // Logger(std::ostream& out) { _out = out; }  // 编译错误！
};
```

第三种是无默认构造函数的类类型成员。编译器在进入构造函数体之前，会尝试对每个类类型成员调用其默认构造函数。如果某个成员的类没有默认构造函数（即所有构造函数都要求参数），编译器就无法完成这个步骤，导致编译错误。唯一的解决办法是在初始化列表中显式调用该成员的一个有参构造函数：

```cpp
class NoDefaultCtor {
 public:
  NoDefaultCtor(int x);
  // 没有 NoDefaultCtor() 默认构造函数
};

class Container {
  NoDefaultCtor _obj;
 public:
  Container() : _obj(42) {}  // 必须用初始化列表传入参数
};
```

## 父类构造函数调用——只能在初始化列表中

调用父类的构造函数也必须在初始化列表中完成。没有语法能把父类构造调用放在函数体内部。HotSpot 中 `FormatStringEventLog` 的子类构造展示了这个语法：

```cpp
template <size_t bufsz>
class FormatStringEventLog : public EventLogBase< FormatStringLogMessage<bufsz> > {
 public:
  FormatStringEventLog(const char* name, int count = LogEventsBufferEntries)
    : EventLogBase< FormatStringLogMessage<bufsz> >(name, count) {}
};
```

初始化列表中 `EventLogBase< FormatStringLogMessage<bufsz> >(name, count)` 这一项是调用父类构造函数，传入 `name` 和 `count` 两个参数。函数体同样是空的——`EventLogBase` 的构造函数完成了全部的初始化工作。

对于有多层继承的类，编译器保证的构造顺序是：先构造所有基类（从最顶层开始），再按声明顺序构造本类的成员，最后才执行当前类的构造函数体。无论初始化列表中各项的书写顺序如何，这个底层顺序不会改变。

## 初始化顺序——声明顺序决定一切

这是 C++ 中最容易被忽视但也最常见的一个陷阱。标准明确规定：成员按它们在**类中声明的顺序**初始化，和初始化列表中各项的书写顺序**完全无关**。

HotSpot 中 `EventLogBase` 的构造函数是一个很好的例子。先看它的成员声明顺序：

```cpp
protected:
  Mutex           _mutex;       // 第 1 个声明
  const char*     _name;        // 第 2 个声明
  int             _length;      // 第 3 个声明
  int             _index;       // 第 4 个声明
  int             _count;       // 第 5 个声明
  EventRecord<T>* _records;     // 第 6 个声明
```

再看它的初始化列表：

```cpp
EventLogBase<T>(const char* name, int length = LogEventsBufferEntries):
  _name(name),                          // 列表中第 1 项
  _length(length),                      // 列表中第 2 项
  _count(0),                            // 列表中第 3 项
  _index(0),                            // 列表中第 4 项
  _mutex(Mutex::event, name, false,
         Monitor::_safepoint_check_never) {  // 列表中第 5 项
  _records = new EventRecord<T>[length];
}
```

尽管 `_mutex` 在初始化列表中写在最后，但按照声明顺序，它实际是**第一个被初始化**的成员——在 `_name`、`_length` 之前。这里存在一个微妙的风险：如果 `_mutex` 的构造函数依赖于 `_name` 或 `_length` 的值（比如它的构造函数里访问了这两个成员），就会出现未定义行为——因为那个时刻它们还处于未初始化状态。在这个具体案例中，`Mutex::event` 的构造只需要 `name` 这个函数参数（从调用点传入的局部拷贝），没有依赖 `_name` 成员，所以一切正常。

再看 `FormatBuffer` 的构造函数：

```cpp
template <size_t bufsz>
FormatBuffer<bufsz>::FormatBuffer(const char * format, ...) : FormatBufferBase(_buffer) {
  va_list argp;
  va_start(argp, format);
  jio_vsnprintf(_buf, bufsz, format, argp);
  va_end(argp);
}
```

这里初始化列表只调用了父类构造函数 `FormatBufferBase(_buffer)`。父类构造完成后，`_buf` 指向了 `_buffer`。然后函数体中的 `jio_vsnprintf` 使用 `_buf`（继承自基类的成员）写入格式化内容。这是"初始化列表做连接，函数体做运算"的典型例子。

## 写一个会触发警告的不安全初始化

这个陷阱要真正理解，需要亲自构造一个反例：

```cpp
class Trap {
  int _b;   // 声明顺序：_b 先
  int _a;   // 声明顺序：_a 后
 public:
  Trap() : _a(0), _b(_a + 10) {}  // 初始化列表顺序：_a 先，_b 后
};
```

按照声明顺序，实际初始化顺序是：先 `_b(_a + 10)`，然后 `_a(0)`。初始化 `_b` 的时候 `_a` 尚未初始化，`_a + 10` 读取的是垃圾值。编译器开关 `-Wreorder` 会对此发出警告。最佳实践很简单：让初始化列表的书写顺序始终与声明顺序保持一致。

## `= default` 和 `= delete`

C++11 引入了两个简洁的语法来控制构造函数的生成行为。

`= default` 告诉编译器"使用你的默认实现"。它最常见的用途是显式声明一个默认构造函数，告诉读者"这个类可以默认构造"：

```cpp
class Simple {
  int _x = 0;
 public:
  Simple() = default;  // 明确的语义：接受编译器生成的默认版本
};
```

`= delete` 告诉编译器"禁止生成这个函数"。任何试图调用被 `= delete` 标记的函数都会导致编译错误。HotSpot 中 `StackObj` 如果改用 C++11 风格，会是这个效果（但 HotSpot 兼容老编译器，仍用旧式写法）：

```cpp
class StackObj {
 private:
  void* operator new(size_t) = delete;      // C++11 风格
  void  operator delete(void*) = delete;   // 禁止 new 和 delete
};
```

`= delete` 的妙处在于错误信息出现在编译期，而不是链接期。旧式写法的 private 声明不提供实现——如果友元类试图拷贝，错误在链接阶段才暴露，信息含糊。而 `= delete` 的报错直接指向调用点，信息精确。

## 禁止拷贝的 C++11 写法

`events.hpp` 中的 `EventLog` 是一个 `CHeapObj<mtInternal>` 的子类。`CHeapObj` 的拷贝构造和拷贝赋值默认可用——但 `EventLog` 作为链表节点，拷贝会破坏链结构。如果用 C++11 风格阻止拷贝：

```cpp
class EventLog : public CHeapObj<mtInternal> {
  // C++11 风格禁止拷贝：
  EventLog(const EventLog&) = delete;
  EventLog& operator=(const EventLog&) = delete;
};
```

相比之下，旧式风格把拷贝构造声明在 private 区且不实现——如果内部代码或友元误用，编译不会报错，但链接时会收到一个含义不清的"undefined reference"错误。`= delete` 在编译期直接拦截，错误信息更精确，维护成本更低。

## HotSpot 中构造函数的各种模式

`EventLogBase` 的构造函数展示了初始化列表和函数体的分工。它的初始化列表承担的是简单的成员初始化——`_name(name)`、`_length(length)`、`_count(0)`、`_index(0)` 和 `_mutex(...)` 都是将值或对象直接绑定到成员。而函数体中的 `_records = new EventRecord<T>[length]` 是堆分配操作——涉及系统调用、错误处理和复杂逻辑，放在函数体中是合理的。

`FormatBuffer::FormatBuffer()`（默认构造函数）展示了"空体构造"的另一种情形：

```cpp
template <size_t bufsz>
FormatBuffer<bufsz>::FormatBuffer() : FormatBufferBase(_buffer) {
  _buf[0] = '\0';
}
```

这里的初始化列表调用父类构造函数，将 `_buf` 指向 `_buffer`。函数体只有一行：把第一个字节设为空字符，让 `_buffer` 成为一个空 C 字符串。这行代码从语义上是初始化行为（设定初始状态），但因为它涉及修改继承来的成员 `_buf`，只能放在函数体中——初始化列表只能初始化当前类自己的成员和调用父类构造，不能直接修改继承来的成员。

再看 `FormatStringEventLog` 的构造：

```cpp
template <size_t bufsz>
class FormatStringEventLog : public EventLogBase< FormatStringLogMessage<bufsz> > {
 public:
  FormatStringEventLog(const char* name, int count = LogEventsBufferEntries)
    : EventLogBase< FormatStringLogMessage<bufsz> >(name, count) {}
};
```

这里初始化列表只有一项——调用父类构造。父类 `EventLogBase` 的构造函数接收 `name` 和 `count`，然后在它自己的初始化列表中完成所有工作。`FormatStringEventLog` 自身的构造函数体因此完全为空。这种"全部代理给父类"的模式在模板层次结构中非常常见——子类只负责指定模板参数，具体的初始化逻辑全在父类中。

## 构造函数调用链的完整顺序

理解一个多层对象的构造顺序，有助于避开初始化依赖 bug。以 `FormatStringEventLog<256>` 为例，完整的构造过程是：

1. 调用 `EventLogBase<FormatStringLogMessage<256>>` 的构造函数
2. `EventLogBase` 的初始化列表开始执行（按成员声明顺序）：`_mutex` → `_name` → `_length` → `_index` → `_count`
3. `EventLogBase` 的构造函数体执行：`_records = new EventRecord<T>[length]`
4. 控制权返回到 `FormatStringEventLog` 的构造函数体（此例中为空）

最终当对象析构时，这个顺序完全逆序执行——先执行 `FormatStringEventLog` 的析构体（如果有的话），然后按声明逆序析构成员，最后析构基类。构造和析构的对称性是 C++ 对象模型中保证资源不泄漏的基础之一。
