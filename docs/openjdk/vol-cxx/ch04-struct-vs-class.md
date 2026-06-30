# struct 与 class

在 C++ 中，`struct` 和 `class` 只有**一个**区别：默认访问控制不同。除此之外，它们完全相同——都可以有成员函数、构造函数、析构函数、继承关系、虚函数、访问控制修饰符。

## 唯一的区别

`struct` 的成员默认是 `public`，`class` 的成员默认是 `private`。仅此而已。下面两种写法效果完全相同：

```cpp
struct Foo {              //   class Foo {
  int x;                  //    private:
  void bar();             //      int x;
};                        //      void bar();
                          //   };
```

左边用 `struct`，`x` 和 `bar()` 都是 public。右边用 `class`，必须显式写 `public:`，否则它们都是 private。

这个区别也影响继承：`struct Foo : Bar` 默认是 public 继承，`class Foo : Bar` 默认是 private 继承。但显式写出继承类型后（如 `: public Bar`），两者完全等价。

## 其他所有能力完全相同

这是初学者最容易产生的误解——以为 `struct` 是 C 时代的数据聚合体、`class` 才是面向对象的类。在 C++ 中，`struct` 可以做到 `class` 能做的一切：

- 定义成员函数（包括虚函数）
- 声明构造函数和析构函数
- 使用 public/private/protected 访问控制
- 继承其他类
- 包含模板成员

HotSpot 中的 `StackObj` 就是用 `class` 定义的基类，但它的所有关键操作（`operator new` 重载）都在 `private` 区——这说明 `class` 被用来表达"有访问控制的封装体"。而如果某个类型只是几个字段的简单聚合，用 `struct` 更自然。

## 何时用 struct，何时用 class

HotSpot 源码中有一个非正式的惯例：**纯数据聚合用 struct，带行为封装的用 class**。但这只是一个阅读源码时帮助你快速判断类型意图的经验法则，不是语言规则。

有意思的是 `EventRecord`：

```cpp
template <class X> class EventRecord : public CHeapObj<mtInternal> {
 public:
  double  timestamp;
  Thread* thread;
  X       data;
};
```

它在 `class` 中把所有字段写在 `public:` 之后。从最终效果看，这和用 `struct` 完全一样——所有成员公开，没有需要保护的数据。但作者选择了 `class`，可能是因为这个类型需要配合继承体系（它继承自 `CHeapObj<mtInternal>`），或者团队风格要求所有继承其他类的类型统一用 `class`。

你可能会注意到 `timestamp`、`thread`、`data` 三个字段没有被任何封装函数包裹——它们在 `EventLogBase::print()` 中直接被访问：

```cpp
void print(outputStream* out, EventRecord<T>& e) {
  out->print("Event: %.3f ", e.timestamp);
  if (e.thread != NULL) {
    out->print("Thread " INTPTR_FORMAT " ", p2i(e.thread));
  }
  print(out, e.data);
}
```

这是 C++ 惯用的"轻量数据载体"模式：类型只是用来把几个相关数据打包在一起，行为由外部函数处理。这种场景下，用 `struct` 或全 public 的 `class` 都是合理的。

## HotSpot 中的 struct 使用

HotSpot 代码库里 `class` 的使用频率远高于 `struct`，但 `struct` 并未缺席。在 `allocation.hpp` 中，`AllocStats` 就继承自 `StackObj`（一个 `class`）：

```cpp
class AllocStats : StackObj {
```

这里用 `class` 而不是 `struct` 也是合理的——`AllocStats` 有复杂的构造函数和统计方法，不是纯数据聚合。

而在模板编程中，两者也可以混用。`EventLogBase<T>` 是一个 `class`，但内嵌的 `EventRecord<X>` 却像 `struct` 一样将数据公开。这种混用并不罕见——外围类关注封装（环形缓冲区的实现细节被隐藏），内嵌类只是数据载体。

## 和 C 中 struct 的关系

C 语言中的 `struct` 只是一个数据聚合体，不能有成员函数，没有访问控制。许多从 C 转到 C++ 的程序员最初保持这个习惯：数据用 `struct`，行为用 `class`。但在 HotSpot 这种大型 C++ 项目中，`class` 已经成为默认选择——只有在确实只需要一个轻量数据容器时，`struct` 才被使用。

这个设计哲学的根源可以追溯到 Bjarne Stroustrup 对 C++ 的初始设计：`class` 和 `struct` 的区别被刻意最小化，让程序员可以根据语义意图而非语法限制来选择。在阅读 HotSpot 源码时，关注类型的**实际行为**比关注它用 `class` 还是 `struct` 声明更有意义。

