# vol-cxx ch09 友元与访问控制

C++ 的 `friend` 关键字允许一个类声明另一个类/函数可以访问自己的 private 成员。HotSpot 中到处可见这种设计——核心类和工具类之间通过 friend 建立紧密的协作关系。

## `friend class` —— 授予私有访问权

```cpp
class EventLog : public CHeapObj<mtInternal> {
  friend class Events;  // Events 可以访问 EventLog 的 private 成员

 private:
  EventLog* _next;

  EventLog* next() const { return _next; }

 public:
  EventLog();
  virtual void print_log_on(outputStream* out) = 0;
};
```

EventLog 的 `_next` 是 `private`，`next()` 也是 `private`。但 Events 类声明为 friend，所以 Events 内部可以访问它们：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.cpp 第 42-49 行
EventLog::EventLog() {
  ThreadCritical tc;
  _next = Events::_logs;       // 构造函数可以访问自己的 _next（没问题）
  Events::_logs = this;        // 但这里是 Events 的私有成员！
}
```

实际上 EventLog 能访问 Events 的 `_logs`，是因为 Events 也声明了 EventLog 为 friend：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 174-175 行
class Events : AllStatic {
  friend class EventLog;  // EventLog 也可以访问 Events 的 private 成员

 private:
  static EventLog* _logs;
  static StringEventLog* _messages;
  // ...
};
```

这是"双向 friend"设计：EventLog 和 Events 互相授予对方的私有访问权。EventLog 把自己插入 Events 维护的全局日志链表，Events 调用 EventLog 的 `print_log_on` 遍历打印。两个类各管一摊数据（EventLog 管内存在 `_next` 链表，Events 管注册表 `_logs`），但操作时又需要交叉访问对方私有数据——friend 正好满足这种既独立又紧密协作的关系。

## 单向关系

friend 是定向的——A 声明 B 是 friend，只说明 B 能访问 A 的私有成员，反过来不行。上面的设计需要两边都写 `friend class` 才能互访。

常规情况下，friend 是单向的。ResourceArea 的例子：

```cpp
// jdk11u-copy/src/hotspot/share/memory/resourceArea.hpp 第 44-47 行
class ResourceArea: public Arena {
  friend class ResourceMark;
  friend class DeoptResourceMark;
  friend class VMStructs;
  // ...
};
```

ResourceMark 可以操作 ResourceArea 的内部数据，但 ResourceArea 不能反向访问 ResourceMark 的私有成员。这正是 ResourceMark 和 ResourceArea 之间的"工具类关系"——ResourceMark 是外部工具，需要操作 ResourceArea 内部状态来完成保存/回滚。

## Handle 子系统中的 friend 设计

HandleArea 和 HandleMark 之间也是类似的单向 friend：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/handles.hpp 第 173-214 行
class HandleArea: public Arena {
  friend class HandleMark;         // HandleMark 可以操作 HandleArea 的内部
  friend class NoHandleMark;
  friend class ResetNoHandleMark;
  int _handle_mark_nesting;
  int _no_handle_mark_nesting;
  HandleArea* _prev;
  // ...
};
```

HandleMark 不在 HandleArea 的继承体系中，但作为守护类需要窥探和管理 HandleArea 的内部状态——这正是 friend 的典型用例。

## AllStatic —— 纯静态工具类

Events 继承的 `AllStatic` 是 HotSpot 定义的一个特殊基类：

```cpp
// jdk11u-copy/src/hotspot/share/memory/allocation.hpp 第 335-338 行
class AllStatic {
 public:
  AllStatic()  { ShouldNotCallThis(); }
  ~AllStatic() { ShouldNotCallThis(); }
};
```

`AllStatic` 是一个标记类——它的构造函数和析构函数都调用 `ShouldNotCallThis()`（触发断言失败）。这意味着继承 AllStatic 的类只包含静态成员，永远不应该被实例化。Events 的所有成员都是 `static`，它只是充当命名空间。

## private / protected / public 继承

C++ 中继承自带访问控制修饰。但注意：继承中的访问控制**只影响"外部通过子类指针能否访问父类成员"**，不影响子类内部的访问。

```cpp
class Base {
 public:
  void pub();
 protected:
  void prot();
 private:
  void priv();
};

class PubChild : public Base    {};  // pub() 仍是 public, prot() 仍是 protected
class ProtChild : protected Base {}; // pub() 和 prot() 都变成 protected
class PrivChild : private Base   {}; // 所有父类成员都变成 private
```

HotSpot 中绝大多数继承是 `public`。`private` 继承偶尔用于实现"用已有类但不暴露其接口"的场景，但相对少见。

子类内部永远可以访问父类的 `public` 和 `protected` 成员，无论继承方式是 public/protected/private。只有 `private` 成员子类内部也无法访问——除非使用了 friend。这就是为什么 EventLog 的 `_next` 设为 private 并授予 Events 为 friend：它的子类 EventLogBase 不需要访问 `_next`，只有友元 Events 需要用来维护全局日志链表。

## friend 只能由类自己授予

一个常见的误解是"子类继承父类的 friend 关系"。实际上 friend 关系不继承——B 是 A 的 friend，不意味着 B 的子类也自动是 A 的 friend。每个类的 friend 列表独立管理，互不影响。如果需要子类也能访问，必须在每个类中分别声明。
