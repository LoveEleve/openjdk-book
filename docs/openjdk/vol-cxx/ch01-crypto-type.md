# 模板类与模板参数

阅读 vol-01 ch03 eventlog_init 时，我们第一次遇到了模板类。`FormatBuffer` 和 `EventLogBase` 都用到了模板——如果只读过 Java 泛型，C++ 模板的机制会带来几个意外。

## 模板类的基本语法

`template <class T> class Foo { ... };` 声明了一个模板类。尖括号里的 `T` 是一个**类型占位符**——编译器不会在任何地方查找一个叫 `T` 的真实类型，而是等到实例化时把 `T` 替换成具体类型。你可以把它理解成"编译期宏"，但它拥有完整的类型检查。

在 HotSpot 中，EventLogBase 直接展示了这种语法：

```cpp
template <class T> class EventLogBase : public EventLog {
  // ... 成员列表 ...
};
```

这里的 `T` 在使用时才确定。比如 `Events::_messages` 是 `StringEventLog*` 类型，而 `StringEventLog` 是 `FormatStringEventLog<256>` 的 typedef，最终实例化为 `EventLogBase<FormatStringLogMessage<256>>`。编译器在读到这行时，不会修改 `EventLogBase` 的原始定义，而是**复制一份定义**并把所有 `T` 替换成 `FormatStringLogMessage<256>`，生成一个全新的类。

## 模板实例化——两个不同的类

`Foo<int>` 和 `Foo<char*>` 是**两个完全不同的类**。它们共享同一份源码模板，但编译后得到两套独立的成员变量、成员函数、虚函数表。从二进制角度看，它们和手写的两个不同类没有区别。

这个事实解释了 `EventLogBase<FormatStringLogMessage<256>>` 和 `EventLogBase<FormatStringLogMessage<512>>` 的关系——前者生成长度为 256 的环形缓冲区类，后者生成长度为 512 的版本。它们是独立的类，不共享任何运行时的类型信息。

## 默认模板参数

模板参数可以有默认值，和函数参数一样。`FormatBuffer` 的定义展示了这个用法：

```cpp
template <size_t bufsz = FormatBufferBase::BufferSize>
class FormatBuffer : public FormatBufferBase {
  // ...
  char _buffer[bufsz];
};
```

`FormatBufferBase::BufferSize` 被定义为 `256`，因此 `FormatBuffer<>` 等价于 `FormatBuffer<256>`。HotSpot 中频繁使用的 `err_msg` 类型别名正是这样定义的：

```cpp
typedef FormatBuffer<> err_msg;
```

你可以根据需要指定不同的大小——比如 `FormatBuffer<128>` 用于更短的栈缓冲区，节省栈空间。

## 成员函数定义：内联与类外

模板类的成员函数可以写在类定义内部（隐式内联），也可以写在类外。写在类外时，每一处定义前都必须重新写 `template<...>`，并且函数名前需要加上类模板的完整限定名。

FormatBuffer 同时演示了两种方式。`buffer()` 和 `size()` 直接定义在类内，而构造函数和 `append()` 定义在类外：

```cpp
template <size_t bufsz>
FormatBuffer<bufsz>::FormatBuffer(const char * format, ...) : FormatBufferBase(_buffer) {
  va_list argp;
  va_start(argp, format);
  jio_vsnprintf(_buf, bufsz, format, argp);
  va_end(argp);
}
```

注意构造函数初始化列表 `: FormatBufferBase(_buffer)` 把 `_buffer` 传给父类——因为 `_buffer` 是在 `FormatBuffer` 中声明的内存数组，而父类 `FormatBufferBase` 只需要一个 `char*` 指针指向它。

## 和 Java 泛型的本质区别

如果你从 Java 过来，最需要记住的区别只有一条：**C++ 模板没有类型擦除**。

Java 的 `ArrayList<Integer>` 和 `ArrayList<String>` 在运行时是同一个类——泛型类型参数在编译后被擦除为 `Object`，JVM 不知道 `T` 曾经是什么。C++ 则相反：`FormatBuffer<256>` 和 `FormatBuffer<512>` 编译后是完全独立的两套代码，编译器为每个不同的模板参数组合都生成一份完整的类定义。这意味着 C++ 可以对模板参数做任何直接操作——取它的大小（`sizeof(T)`）、作为数组长度（`char _buffer[bufsz]`）——这些在 Java 中都是不可能的。

代价是编译时间更长（多次实例化），二进制体积更大（每个实例化生成一份代码）。但对 HotSpot 这种对运行时性能有极致要求的基础设施来说，这完全是值得的。

## 模板类中禁止拷贝

在 FormatBuffer 类的 private 区，有一行看起来奇怪的声明：

```cpp
private:
  FormatBuffer(const FormatBuffer &); // prevent copies
```

这是 C++ 中经典的"禁止拷贝"模式。拷贝构造函数被声明在 private 区但不提供实现——如果有人试图拷贝 `FormatBuffer` 对象，编译器会报错（外部代码无法访问 private 构造函数），或者链接器报错（友元尝试拷贝但找不到实现）。

为什么要禁止拷贝？`FormatBuffer` 内部持有 `char _buffer[bufsz]` 数组和 `char* _buf` 指针（指向 `_buffer`）。如果允许拷贝，拷贝后的对象中 `_buf` 仍然指向原来对象的 `_buffer`，产生悬空指针。这种模式在持有原始指针的 C++ 类中非常常见。

在 C++11 之后，这个模式的标准写法是 `FormatBuffer(const FormatBuffer &) = delete;`，但 HotSpot 需要兼容较老的编译器，所以保留了旧式写法。你可以把它理解为："这个类的实例是唯一的，不能复制。"

