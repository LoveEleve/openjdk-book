# vol-cxx ch05 虚函数与纯虚函数

阅读 HotSpot 中 EventLog 日志系统源码时，会遇到这样的声明：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 62 行
virtual void print_log_on(outputStream* out) = 0;
```

这是纯虚函数。要理解它为什么这样设计，需要搞清楚虚函数的分发机制。

## virtual 函数与 vtable 分发

C++ 中，声明为 `virtual` 的成员函数通过 vtable（虚函数表）进行运行时分发。每个包含虚函数的类都有一个隐藏的 vtable 指针，指向该类的虚函数表。调用 `obj->foo()` 时，编译器不直接跳转到某个固定地址，而是先通过对象的 vtable 指针查表，再跳转到对应的函数实现。

对比非虚函数：

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
ptr->foo(); // 调用 A::foo() —— 编译器根据指针类型 A* 静态绑定
```

改为虚函数后：

```cpp
class A {
 public:
  virtual void foo() { /* A's foo */ }
};
class B : public A {
 public:
  virtual void foo() { /* B's foo */ }
};
A* ptr = new B();
ptr->foo(); // 调用 B::foo() —— 运行时通过 vtable 动态分发
```

这就是多态：通过基类指针调用虚函数，实际执行的是子类版本。

## 纯虚函数 = 0

在虚函数声明后加 `= 0`，表示这个函数是"纯虚的"——基类不提供实现，必须由子类 override。

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

EventLog 声明了 `print_log_on` 为纯虚函数。因为具体的日志格式取决于子类——有的日志记录固定长度字符串，有的记录结构化数据——打印方式各不相同。基类无法给出一个"默认打印方式"，所以干脆不实现，强制子类来定义。

## 抽象类不能被实例化

包含纯虚函数的类称为"抽象类"。抽象类不能被直接实例化：

```cpp
EventLog log;  // 编译错误！抽象类不能实例化
EventLog* ptr; // 可以声明指针
```

抽象类只能作为基类使用。必须创建实现了所有纯虚函数的子类，才能实例化对象。

## 子类实现纯虚函数

HotSpot 中 EventLogBase 是 EventLog 的子类，它实现了 `print_log_on`：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 71 行
template <class T> class EventLogBase : public EventLog {
  // ...
 public:
  void print_log_on(outputStream* out);  // 实现纯虚函数
};
```

而更具体的子类 FormatStringEventLog 继承自 EventLogBase，继承了这个实现。

这个继承体系的核心设计意图：EventLog 作为抽象接口，定义"日志必须能被打印"这个契约；EventLogBase 提供环形缓冲区 + 遍历打印的通用实现；FormatStringEventLog 只关心固定字符串的存储格式。三者各司其职。

## 多态的实际运用

在 Events::print_all 中，通过基类指针遍历所有已注册的日志：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.cpp 第 53-58 行
void Events::print_all(outputStream* out) {
  EventLog* log = _logs;         // 基类指针
  while (log != NULL) {
    log->print_log_on(out);      // 多态调用 —— 自动分发给子类版本
    log = log->next();           // 链表遍历
  }
}
```

`_logs` 链表中的每个节点可能是 StringEventLog、ExtendedStringEventLog 等不同子类对象。但代码只使用 `EventLog*` 基类指针，调用 `print_log_on` 时会自动分发到各子类的实际实现。这就是多态的核心价值：用一套代码操作不同类型的对象，无需逐个判断运行时类型。

## 为什么基类用纯虚函数

HotSpot 中大量使用纯虚函数来定义接口合约。EventLog 告诉所有子类："你可以用任何方式存储和格式化日志数据，但必须能通过 `print_log_on(OutputStream*)` 打印出来。" 这相当于 Java 中的 interface。

工厂模式创建不同子类实例，外部代码只持有 `EventLog*` 指针，不必关心具体是哪种日志实现。新增一种日志格式只需新增一个子类，不需要修改 Events::print_all 等已有代码。
