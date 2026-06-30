# struct 与 class + 访问控制

C++ 中 `struct` 和 `class` 是同一个语言机制的两个名字。它们之间的差异被刻意最小化，目的是让程序员根据**语义意图**而非**语法限制**来选择关键字。

## struct 和 class 的唯一区别：默认访问控制

下面两种写法效果完全相同：

```cpp
struct Foo {              //   class Foo {
  int x;                  //    private:
  void bar();             //      int x;
};                        //      void bar();
                          //   };
```

左边用 `struct`，`x` 和 `bar()` 默认是 public。右边用 `class`，必须显式写 `public:` 才能达到同样的效果。

这个区别也影响继承：`struct D : B` 默认是 public 继承，`class D : B` 默认是 private 继承。但一旦显式写出继承类型（如 `: public B`），两者完全等价。

除此之外，`struct` 和 `class` 没有任何区别。`struct` 可以有成员函数（包括虚函数）、构造函数、析构函数、public/private/protected 访问控制、继承、模板成员——`class` 能做的，`struct` 全部能做。

这是面试中的高频知识点。任何说"struct 不能有成员函数"或"struct 不能继承"的回答都是错误的。

## public / private / protected 三种访问控制

C++ 提供三种访问级别，其权限矩阵如下：

```
                     类内部访问    子类访问    外部访问
public                   Y           Y          Y
protected                Y           Y          N
private                  Y           N          N
```

```cpp
class Base {
public:    int pub;      // 任何人可以访问
protected: int prot;     // 自己和子类可以访问
private:   int priv;     // 只有自己可以访问
};

class Derived : public Base {
  void test() {
    pub  = 1;   // OK
    prot = 2;   // OK，子类可以访问 protected 成员
    // priv = 3; // 错误：子类不能访问 private 成员
  }
};

int main() {
  Base b;
  b.pub  = 1;   // OK
  // b.prot = 2;  // 错误：外部不能访问 protected
  // b.priv = 3;  // 错误：外部不能访问 private
}
```

访问控制的本质是**编译期检查**，不产生任何运行时代码。编译器在语义分析阶段检查访问权限，一旦编译通过，生成的机器码和不加任何访问控制时完全相同。这意味着访问控制的运行时开销为零——它纯粹是给程序员看的一个约束声明。

为什么需要 protected？考虑这个场景：基类 `Shape` 有一个 `color` 字段，`draw()` 方法需要访问 `color`，但外部不应该随意修改颜色。用 `private` 子类继承后无法访问，用 `public` 所有人都能改——`protected` 解决了这个矛盾：允许继承链路内部访问，但对类外部隐藏。

## 继承中的访问控制

继承方式决定基类成员在派生类中的最高可访问性：

| 基类成员 | public 继承 | protected 继承 | private 继承 |
|---------|------------|---------------|-------------|
| public 成员 | public | protected | private |
| protected 成员 | protected | protected | private |
| private 成员 | 不可访问 | 不可访问 | 不可访问 |

99% 的场景使用 `public` 继承表达"is-a"关系。`private` 继承极少使用，它表达的是"is-implemented-in-terms-of"（用基类的实现来实现自己，但不是那种关系）。`protected` 继承介于两者之间，几乎只在设计模式的细粒度控制中出现。

## 何时用 struct，何时用 class

虽然两者语法能力完全相同，但业界有非正式的使用惯例：

- `struct` 用于纯数据聚合（POD，Plain Old Data），类似 C 语言的用法。所有成员公开，没有或极少有成员函数。
- `class` 用于有封装逻辑、有不变量需要保护的对象。

这不是语言规则，而是阅读和理解代码时的信号。看到一个 `struct`，你可以默认预期它是"几个字段打包在一起"；看到一个 `class`，你可以预期它有封装行为。

## HotSpot 实操：EventRecord——用 class 声明，行为像 struct

HotSpot 中的 `EventRecord` 是一个有趣的例子：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 72-77 行
template <class X> class EventRecord : public CHeapObj<mtInternal> {
 public:
  double  timestamp;
  Thread* thread;
  X       data;
};
```

它用 `class` 声明，但所有字段都写在 `public:` 之后，没有任何访问控制。从最终效果看，这和用 `struct` 完全一样——所有成员公开，没有需要保护的封装边界。

为什么作者选择了 `class`？可能是因为这个类型需要配合继承体系（它继承自 `CHeapObj<mtInternal>`），或者团队风格要求所有参与继承的类型统一用 `class`。

这些字段在 `EventLogBase::print()` 中被直接访问：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 128-134 行
void print(outputStream* out, EventRecord<T>& e) {
  out->print("Event: %.3f ", e.timestamp);
  if (e.thread != NULL) {
    out->print("Thread " INTPTR_FORMAT " ", p2i(e.thread));
  }
  print(out, e.data);
}
```

这是 C++ 惯用的"轻量数据载体"模式：类型只是用来把几个相关数据打包在一起，行为由外部函数处理。这种场景下，用 `struct` 或全 public 的 `class` 都是合理的选择。

## C++11 的 = default 和 = delete

C++11 引入了两个新的构造/赋值控制语法：

```cpp
class Widget {
public:
  Widget() = default;              // 让编译器生成默认构造
  Widget(const Widget&) = delete;  // 禁止拷贝构造
  Widget& operator=(const Widget&) = delete;  // 禁止拷贝赋值
};
```

`= default` 告诉编译器"使用默认的实现"。编译器自动生成的函数遵循特定规则——如果你没有定义任何构造函数，编译器生成默认构造、拷贝构造、拷贝赋值和析构函数。但一旦你显式定义了有参构造函数，编译器就不再自动生成默认构造函数，此时用 `= default` 可以恢复自动生成的版本。这在有继承层次的类中特别有用：派生类如果显式声明了构造函数，编译器不会自动生成默认构造函数。

`= delete` 显式禁止某个函数。被 `= delete` 的函数不能以任何方式被调用——编译期直接报错。它比 C++98 中把函数声明为 private 且不定义的做法更好：旧做法在链接期才暴露错误（错误信息晦涩），而 `= delete` 在编译期就直接给出清晰的错误信息。

`= delete` 的典型用途：
- 禁止对象的拷贝（如文件句柄、互斥锁等独占资源）
- 禁止某些参数类型的隐式转换
- 禁止不受支持的构造/赋值方式

## 封装的三重境界

封装不只是写几个 private 关键字，而是分层次的设计思维：

第一重：访问控制。用 public/private/protected 限制谁能访问什么。编译期检查，零运行时开销。这是封装最基础的层面。

第二重：抽象。只暴露接口，隐藏实现细节。外部调用 `Library::addBook()`，不关心底层是 vector 还是 list，甚至不关心存到了内存还是文件。

第三重：信息隐藏。不仅隐藏数据，还隐藏设计决策。不暴露排序算法、存储格式、是否使用缓存。修改内部实现不影响外部调用者——这就是为什么封装能降低耦合：外部代码只依赖公开接口，接口不变，内部怎么改都行。

C 语言通过前向声明和不透明指针可以模拟第一部分效果，但做不到 C++ 这样深入。C++ 把封装内建在语言中，编译器强制执行约束，而不是靠程序员的自觉。

## HotSpot 中的分配体系：StackObj vs CHeapObj vs AllStatic

HotSpot 用基类继承来统一管理所有对象的分配策略。StackObj 禁止堆分配，AllStatic 禁止任何实例化，而 CHeapObj 作为它们的对照，明确允许并**追踪**堆分配：

```cpp
// jdk11u-copy/src/hotspot/share/memory/allocation.hpp 第 175-215 行
template <MEMFLAGS F> class CHeapObj {
 public:
  void* operator new(size_t size) throw() {
    return (void*)AllocateHeap(size, F);  // 带内存类型标签的堆分配
  }
  void operator delete(void* p) { FreeHeap(p); }
};
```

`CHeapObj` 的 `operator new` 是 public 的——它故意允许堆分配。模板参数 `F` 是 `MEMFLAGS` 枚举（如 `mtGC`、`mtThread`、`mtCompiler`），分配时记录内存类型。Native Memory Tracking (NMT) 可以按类型统计内存用量，提供"这个 JVM 的 GC 占了 200MB，Compiler 占了 150MB"这样的可观测性。

三种基类构成了 HotSpot 的分配语义体系：
- `StackObj`：只允许栈分配，编译期强制——用于 RAII 守卫类
- `CHeapObj`：允许堆分配并追踪——用于长生命周期的对象
- `AllStatic`：不允许任何分配——用于纯静态工具类

## HotSpot 实操：StackObj 和 AllStatic——用访问控制阻止误用

HotSpot 中有两种特殊的基类，利用访问控制来强制执行使用约束。

StackObj 用于强制栈分配，禁止堆分配：

```cpp
// jdk11u-copy/src/hotspot/share/memory/allocation.hpp 第 219-228 行
class StackObj ALLOCATION_SUPER_CLASS_SPEC {
 private:
  void* operator new(size_t size) throw();
  void* operator new [](size_t size) throw();
  void  operator delete(void* p);
  void  operator delete [](void* p);
};
```

`operator new` 和 `operator delete` 都声明为 `private`，外部代码如果写 `new MutexLockerEx(...)` 会直接编译失败。MutexLockerEx、ResourceMark、HandleMark 等 RAII 类都继承自 StackObj，保证它们只能在栈上使用——这正是 RAII 的底层约束：生命周期必须绑定到作用域。

AllStatic 用于纯静态工具类，禁止任何实例化：

```cpp
// jdk11u-copy/src/hotspot/share/memory/allocation.hpp 第 335-339 行
class AllStatic {
 public:
  AllStatic()  { ShouldNotCallThis(); }
  ~AllStatic() { ShouldNotCallThis(); }
};
```

构造和析构函数体直接调用 `ShouldNotCallThis()`——这是一个会触发 fatal error 的函数。如果有人试图创建 `AllStatic` 的子类对象，程序会在运行时报错。

HotSpot 中 `Events` 类就继承自 `AllStatic`：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 174 行
class Events : AllStatic {
```

`Events` 的所有成员都是 `static`——它只是一个逻辑分组容器，相当于一个带有访问控制的名字空间。继承 `AllStatic` 明确表达了"这个类不应该有任何实例"的设计意图，并且在运行时提供了保护。

StackObj 和 AllStatic 是同一个设计思路的两面：利用 C++ 的访问控制机制，在编译期或运行期强制执行使用约束，把"不该做的事情"变成"做不到的事情"。
