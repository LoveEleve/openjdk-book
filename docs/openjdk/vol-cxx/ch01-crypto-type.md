# 模板类与模板参数

在 Java 里写 `List<String>` 的时候，JVM 只认 `List`，尖括号里的 `String` 在编译后被擦除。C++ 的模板走的是另一条路——它不擦除，而是在编译时把尖括号里的东西直接替换进代码，替每种参数组合生成一套独立的类的完整定义。这一章从最基础的语法开始，讲解 C++ 模板编译期代码生成的机制，以及它在 HotSpot 源码中的实际运用。

## 类型模板参数——编译期占位符

`template <class T>` 是最常见的模板声明。尖括号里的 `T` 不是一个真实存在的类型，而是一个占位符——编译器在读到这行时，不会去任何地方查找名为 `T` 的类型，只是记下"这里有个位置留给未来的类型"。你可以把它类比为编译期的宏，但比宏多了完整的类型检查。

HotSpot 中 `events.hpp` 的 `EventLogBase` 直接展示了这种语法：

```cpp
template <class T> class EventLogBase : public EventLog {
  template <class X> class EventRecord : public CHeapObj<mtInternal> {
   public:
    double  timestamp;
    Thread* thread;
    X       data;
  };

 protected:
  Mutex           _mutex;
  const char*     _name;
  int             _length;
  int             _index;
  int             _count;
  EventRecord<T>* _records;
  // ...
};
```

这里的 `T` 在使用时才确定。`Events::_messages` 的类型是 `StringEventLog`，它最终展开为 `EventLogBase<StringLogMessage>`——编译器拿着这个实例化请求，把 `EventLogBase` 定义中的每个 `T` 都替换成 `StringLogMessage`，生成一份全新的类定义。

`typename` 和 `class` 在声明模板参数时完全等价。`template <class T>` 和 `template <typename T>` 没有任何语义差异。历史上 `class` 先出现（为了少引入一个新关键字），后来标准委员会补充了 `typename` 以更清晰地表达"这是一个类型参数"。在实际代码中两者混用是常见的——你完全可以根据上下文选择读起来更自然的那一个。

## 非类型模板参数——编译期常量占位符

模板参数不一定是类型。`template <size_t N>` 声明了一个**非类型模板参数**——尖括号里的 `N` 不是类型，而是一个编译期常量。编译器在实例化时必须拿到 `N` 的具体值，就像函数调用时必须传入实参一样。

HotSpot 的 `FormatBuffer` 是理解非类型模板参数的最佳例子。`formatBuffer.hpp` 中它的定义是：

```cpp
template <size_t bufsz = FormatBufferBase::BufferSize>
class FormatBuffer : public FormatBufferBase {
 public:
  inline FormatBuffer(const char* format, ...) ATTRIBUTE_PRINTF(2, 3);
  inline void append(const char* format, ...) ATTRIBUTE_PRINTF(2, 3);
  char* buffer() { return _buf; }
  int size() { return bufsz; }

 private:
  FormatBuffer(const FormatBuffer &); // prevent copies
  char _buffer[bufsz];

 protected:
  inline FormatBuffer();
};
```

注意 `_buffer[bufsz]` 这行。C++ 的栈数组长度必须是编译期常量，而模板参数 `bufsz` 正好满足这个要求。编译器为每个不同的 `bufsz` 值生成一个数组长度不同的类——这就是非类型模板参数的核心应用场景：让编译期常量驱动代码生成。

`size()` 成员函数也直接返回 `bufsz`——它不是一个运行时计算的数字，而是直接嵌入机器码的常量。对于 `FormatBuffer<256>`，`size()` 生成的汇编代码等价于 `mov eax, 256`。

## 默认模板参数

和非类型模板参数的默认值结合，提供了极大的灵活性。`FormatBuffer` 的声明中 `bufsz = FormatBufferBase::BufferSize` 就是一个默认值，其中 `FormatBufferBase::BufferSize` 被定义为 `256`。这意味着：

```cpp
FormatBuffer<> f;           // bufsz = 256（使用默认值）
FormatBuffer<128> f_small;  // bufsz = 128（显式指定）
FormatBuffer<512> f_large;  // bufsz = 512（显式指定）
```

HotSpot 通过 typedef 把这个默认值利用到了极致：

```cpp
typedef FormatBuffer<> err_msg;
```

`err_msg` 等价于 `FormatBuffer<256>`。绝大多数调用者不需要关心缓冲区大小，直接使用 `err_msg` 即可。而当某个特殊场景需要更大的缓冲区时（比如 JVM 崩溃报告中需要容纳更长的错误描述），可以显式使用 `FormatBuffer<1024>`。默认模板参数让"合理的默认行为"零成本，同时保留了精确控制的出口。

## 模板实例化——两个完全不同的类

`FormatBuffer<256>` 和 `FormatBuffer<512>` 是什么关系？答案是**没有任何关系**。它们是两个完全独立的类，共享同一份源码模板，但编译后得到两套独立的成员变量、成员函数和虚函数表。

这件事的背后是 C++ 模板的实例化机制。当编译器遇到 `FormatBuffer<256>` 时，它做的事情是：
1. 取出 `FormatBuffer` 的模板定义
2. 把 `bufsz` 替换为 `256`
3. 编译这份替换后的代码，就像你手写了 `class FormatBuffer_256 { ... }` 一样

如果把 `FormatBuffer<256>` 和 `FormatBuffer<512>` 编译成目标文件，用 `nm -C` 查看符号表，你会看到两套完全不同的构造函数和成员函数——每个都有自己的地址和机器码。它们不共享任何运行时的类型信息。

这个事实也能解释 HotSpot 中 `events.hpp` 的另一组定义：

```cpp
template <class T> class EventLogBase : public EventLog { ... };

template <size_t bufsz>
class FormatStringEventLog : public EventLogBase< FormatStringLogMessage<bufsz> > { ... };

typedef FormatStringEventLog<256> StringEventLog;
typedef FormatStringEventLog<512> ExtendedStringEventLog;
```

`StringEventLog` 最终实例化为 `EventLogBase<FormatStringLogMessage<256>>`，`ExtendedStringEventLog` 实例化为 `EventLogBase<FormatStringLogMessage<512>>`。它们各自拥有一套独立的 `EventRecord` 环形缓冲区，元素大小不同、缓冲区总大小不同、连 `print` 方法的特化版本都不同。从二进制角度看，它们和手写的两个不同类没有任何区别。

## 和 Java 泛型的本质区别

如果你从 Java 过来，下面这行代码是最好的教学工具：

```cpp
char _buffer[bufsz];  // C++：编译期常量决定数组大小，完全合法
```

在 Java 中你永远写不出 `T[] arr = new T[n]` 让泛型参数决定数组大小。因为 Java 泛型在编译后擦除为 `Object`，运行时 `T` 已经不存在了。C++ 模板则相反：编译时 `bufsz` 被替换为具体值（如 `256`），运行时没有"模板"这个概念——只有普通的 `char _buffer[256]`。

这引出了 C++ 模板和 Java 泛型之间三个最本质的差异。

第一，**不存在类型擦除**。`ArrayList<Integer>` 和 `ArrayList<String>` 在 Java 中运行时是同一个 `ArrayList` 类。`FormatBuffer<256>` 和 `FormatBuffer<512>` 在 C++ 中编译后是两套完全独立的机器码。

第二，**模板参数可以做任何编译期操作**。取大小（`sizeof(T)`）、作为数组长度（`char _buffer[bufsz]`）、参与编译期计算（`constexpr T value = N * 2`）。Java 的泛型参数不能用于任何需要具体类型信息的操作。

第三，**特化**。C++ 可以为特定的模板参数组合写一份与众不同的实现（模板特化）。`events.hpp` 中就使用了这个特性——`EventLogBase<StringLogMessage>` 的 `print` 方法有独立的定义，和通用版本不同。Java 泛型不支持这种编译期分支。

这些差异的代价是编译时间更长（每个实例化组合都需要编译一份代码）和二进制体积更大。对 HotSpot 这种追求极致运行时性能的基础设施来说，这些代价完全值得。

## 类模板的成员函数定义位置

类模板的成员函数有两种写法：定义在类内部（隐式内联），或定义在类外部。类外部定义时，每个函数前面都必须重新写 `template<...>` 声明，并且类名后必须带模板参数。

`formatBuffer.hpp` 同时展示了两种方式。`buffer()` 和 `size()` 直接写在类内——它们是简单的访问器，显然应该内联。构造函数和 `append()` 写在类外：

```cpp
template <size_t bufsz>
FormatBuffer<bufsz>::FormatBuffer(const char * format, ...) : FormatBufferBase(_buffer) {
  va_list argp;
  va_start(argp, format);
  jio_vsnprintf(_buf, bufsz, format, argp);
  va_end(argp);
}

template <size_t bufsz>
void FormatBuffer<bufsz>::append(const char* format, ...) {
  size_t len = strlen(_buf);
  char* buf_end = _buf + len;
  va_list argp;
  va_start(argp, format);
  jio_vsnprintf(buf_end, bufsz - len, format, argp);
  va_end(argp);
}
```

类外定义的三个要点：第一，必须写 `template <size_t bufsz>` 前缀——否则编译器不知道这个函数属于哪个模板实例化。第二，类名必须写成 `FormatBuffer<bufsz>` 而不是单独的 `FormatBuffer`——类名带上模板参数才能唯一标识一个具体的类。第三，类名后的 `::` 之后才是成员函数名。

## 禁止拷贝——模板类中的资源安全模式

`FormatBuffer` 的 private 区域有一行值得注意：

```cpp
private:
  FormatBuffer(const FormatBuffer &); // prevent copies
```

如果允许拷贝 `FormatBuffer`，会引发悬空指针问题。`FormatBuffer` 继承了 `FormatBufferBase`，后者持有一个 `char* _buf` 指针指向 `FormatBuffer` 自己的 `_buffer` 数组。拷贝时，拷贝出的对象中 `_buf` 仍然指向**原对象**的 `_buffer`，当原对象销毁后这个指针就悬空了。

将拷贝构造函数声明在 private 区域并且不提供实现，可以阻止外部代码和友元类的拷贝行为。C++11 之后的标准写法是 `FormatBuffer(const FormatBuffer &) = delete;`，但 HotSpot 需要兼容较老的编译器，保留了旧式写法。

## 模板参数 `class` 和 `typename` 的区别

在声明模板参数时，`template <class T>` 和 `template <typename T>` 完全等价。`class` 是 C++ 早期为了少新增关键字而沿用的语法，`typename` 是后来标准委员会补充的更语义明确的写法。在 HotSpot 源码中两者都有使用——`EventLogBase` 用 `class`，`FormatBuffer` 用 `size_t`（非类型参数），选择哪个取决于代码风格。

需要区分的是另一个场景：在模板内部引用依赖于模板参数的类型时，必须用 `typename` 关键字告诉编译器"这是一个类型"。例如 `typename T::value_type` 中的 `typename` 是不可省略的——它和模板参数声明中的 `typename` 是两种不同的用法。这个场景将在模板元编程相关章节中详细展开。

## HotSpot 中的模板类全景

回头看 HotSpot 中 `events.hpp` 的完整模板链路，它展示了 C++ 模板的典型使用模式：

```
FormatBufferBase (非模板基类，持有 char* _buf)
  └─ FormatBuffer<bufsz> (模板类，数组长度由参数决定)
       └─ FormatStringLogMessage<bufsz> (空壳继承，用于类型区分)

EventLog (非模板基类，提供链表和打印接口)
  └─ EventLogBase<T> (模板类，T 决定日志条目类型)
       └─ FormatStringEventLog<bufsz> (组合两个模板参数形成具体日志类型)

实际使用的 typedef：
  StringLogMessage = FormatStringLogMessage<256>
  StringEventLog    = FormatStringEventLog<256> = EventLogBase<StringLogMessage>
```

这个层级结构中，模板参数从 `bufsz`（缓冲区大小）传递到 `T`（日志条目类型），每一层都通过实例化固化为具体的编译期类型。最终 `Events::_messages` 是 `StringEventLog*` 类型——一个完全确定的、没有任何模板残余的普通指针。这就是 C++ 模板的全部魔力：在编译器展开完毕后，运行时不再有任何"模板"的影子。
