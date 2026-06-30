# 构造函数与初始化列表

构造函数中冒号后面的部分叫做"初始化列表"（member initializer list）。在 HotSpot 源码中频繁出现，而且常和空函数体 `{}` 一起出现——这意味着构造函数的所有工作都在初始化列表中完成了。

## 基本语法

初始化列表紧跟在构造函数的参数列表右括号之后，以冒号开头，各项用逗号分隔：

```cpp
Foo() : _a(0), _b("hello") {}
```

HotSpot 中 `FormatBufferBase` 的定义给出了一个极简的例子：

```cpp
inline FormatBufferBase(char* buf) : _buf(buf) {}
```

这里函数体是空的——初始化列表 `_buf(buf)` 已经完成了所有需要做的事：把参数 `buf` 存到成员 `_buf` 中。

## 初始化列表 vs 函数体内赋值

这两者看起来效果一样，但本质完全不同。函数体内赋值意味着成员**先被默认构造**，然后再被**赋值**。初始化列表则是**直接调用该成员的构造函数**完成初始化。

对于基本类型（int、指针等），差异只是风格问题。但对于没有默认构造函数的成员对象（或引用成员、const 成员），初始化列表是唯一的选择——它们在函数体执行之前就必须被初始化。

## 父类构造函数调用

初始化列表也可以调用父类的构造函数。`EventLogBase` 没有在初始化列表中调用 `EventLog()`，因为父类使用默认构造函数。但它的子类 `FormatStringEventLog` 展示了这个语法：

```cpp
FormatStringEventLog(const char* name, int count = LogEventsBufferEntries)
  : EventLogBase< FormatStringLogMessage<bufsz> >(name, count) {}
```

注意这里用模板实例化后的类型 `EventLogBase< FormatStringLogMessage<bufsz> >` 来指定父类构造函数，传入 `name` 和 `count` 参数。函数体同样是空的——初始化工作由父类构造函数完成。

## 初始化顺序的决定因素

初始化列表中各项的顺序**不是**初始化发生的顺序。C++ 标准规定：成员按照它们在**类中声明的顺序**初始化，与初始化列表中书写的顺序无关。

这个规则在 `EventLogBase` 的构造函数中很关键：

```cpp
EventLogBase<T>(const char* name, int length = LogEventsBufferEntries):
  _name(name),
  _length(length),
  _count(0),
  _index(0),
  _mutex(Mutex::event, name, false, Monitor::_safepoint_check_never) {
  _records = new EventRecord<T>[length];
}
```

尽管 `_mutex` 出现在初始化列表最后，但它在类中声明的顺序是：

```cpp
Mutex           _mutex;
const char*     _name;
int             _length;
int             _index;
int             _count;
EventRecord<T>* _records;
```

这意味着 `_mutex` 实际**最先被初始化**，在 `_name` 和 `_length` 之前。这里存在一个隐患：如果 `_mutex` 的构造函数依赖 `_name` 或 `_length` 的值，就会出现未定义行为。幸好 `Mutex::event` 和 `name` 是在调用点就确定的值，所以即使 `_name` 还未被赋值也没问题。

## 函数体中的工作

初始化列表之外的逻辑放在函数体中。上面 `EventLogBase` 的构造函数里，`_records = new EventRecord<T>[length]` 被放在函数体中而不是初始化列表里，因为它是堆分配操作，不是简单的成员初始化。把复杂的运行时逻辑放在函数体中是一种良好的编码习惯。

另一个值得一提的模式是格式化字符串构造——FormatBuffer 的构造函数在初始化列表中把 `_buffer` 传给父类，然后在函数体中调用 `jio_vsnprintf` 完成实际的格式化工作。这是"初始化列表做连接，函数体做运算"的典型例子。

## 常见陷阱：初始化顺序引发的 bug

初始化顺序由声明顺序决定这个规则是 C++ 中最容易被忽视的陷阱之一。来看 `EventLogBase` 的成员声明：

```cpp
Mutex           _mutex;        // 第一个被构造
const char*     _name;         // 第二个被构造
int             _length;       // 第三个
int             _index;        // 第四个
int             _count;        // 第五个
EventRecord<T>* _records;      // 第六个
```

假设某个粗心的维护者把初始化列表改写成 `_mutex` 依赖 `_length` 的值，但保持声明顺序不变——这很可能在大部分平台上"恰好能工作"（因为 `_length` 的内存已被分配，只是值未确定），然后在某个特定优化级别或编译器下崩溃。编译器通常会对此类问题发出警告（`-Wreorder`），但不会报错。

最佳实践是让初始化列表的顺序与声明顺序保持一致——这样既避免了 bug，也让读者不需要切换上下文就能理解初始化流程。HotSpot 源码中大部分地方都遵循了这个惯例。

