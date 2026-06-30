# 友元与继承访问控制

封装是 C++ 面向对象设计的基石——private 成员只能被类自己的成员函数访问。但有时候两个类需要紧密协作，一个类需要访问另一个类的私有数据，却又不能把那些数据公开（公开会向全代码库敞开大门）。`friend` 关键字就是为这种场景设计的：精准授权，而不是撤掉整面墙。

## friend 的本质

`friend` 是一条声明语句，写在类定义内部，表示"我授权指定的那个类或函数访问我的私有成员"。授权方主动声明，被授权方被动获得——这不是双向通道，也不是可传递的关系。

HotSpot 中最经典的单向 friend 设计是 ResourceArea 和 ResourceMark：

```cpp
// resourceArea.hpp
class ResourceArea : public Arena {
    friend class ResourceMark;
    friend class DeoptResourceMark;
    friend class VMStructs;
    // ...
};
```

ResourceMark 不在 ResourceArea 的继承体系中，也不是它的内部类。ResourceMark 是一个 RAII 守护类——构造时保存 ResourceArea 的内部指针位置，析构时回滚。为了完成这个保存/回滚操作，ResourceMark 需要直接读写 ResourceArea 的私有偏移量字段。如果这些字段公开，任何代码都能破坏 ResourceArea 的内部状态；如果用 protected，所有 Arena 子类都能访问（不必要地扩大了访问范围）。friend 精准地只让 ResourceMark 进门。

友元也可以授权给函数而非整个类。当某个操作需要同时访问两个类的私有数据时，友元函数是最合适的选择：

```cpp
class Matrix {
    friend Vector operator*(const Matrix& m, const Vector& v);
};

class Vector {
    friend Vector operator*(const Matrix& m, const Vector& v);
};

// 友元函数可以同时访问 Matrix 和 Vector 的私有成员
Vector operator*(const Matrix& m, const Vector& v) {
    // 直接访问 m.data[][] 和 v.data[]
}
```

`operator*` 需要直接访问两者的内部数组，但它本身不适合作为 Matrix 或 Vector 的成员函数——它是两个类之间的操作。声明为双方的友元函数正好解决了"第三方操作需要访问双方私有数据"的矛盾。

## 单向且不可传递

友元关系有三个关键性质。第一，单向——A 声明 B 是 friend，只意味着 B 能访问 A 的 private，A 不能反向访问 B。第二，不继承——B 的子类不是 A 的友元，除非 A 显式声明。第三，不传递——如果 A 是 B 的友元，B 是 C 的友元，C 不会自动获得 A 的访问权。每个友元关系都是独立授权的，这保证了访问控制的精确性——每扇门都是锁着的，只对名单上的人打开。

## 双向 friend 设计模式

当两个类互相需要操作对方的私有数据时，两端都要写 `friend class`。HotSpot 的 EventLog 和 Events 之间就是这种双向关系：

```cpp
// events.hpp
class EventLog : public CHeapObj<mtInternal> {
    friend class Events;

private:
    EventLog* _next;
    EventLog* next() const { return _next; }
};

class Events : AllStatic {
    friend class EventLog;

private:
    static EventLog* _logs;
    static StringEventLog* _messages;
};
```

EventLog 声明 Events 为 friend，因为 Events 需要维护全局日志链表——通过 `_next` 指针遍历所有 EventLog 节点。EventLog 的 `_next` 和 `next()` 都是 private，外部不可见，但 Events 作为友元可以直接读取它们来推进链表。

反过来，Events 也声明 EventLog 为 friend。EventLog 的构造函数中有这样一段代码：

```cpp
EventLog::EventLog() {
    ThreadCritical tc;
    _next = Events::_logs;       // 访问 Events 的私有静态成员
    Events::_logs = this;        // 把自己插入全局链表的头部
}
```

每个 EventLog 子类实例在构造时把自己插入 Events 维护的全局日志注册表。写入 `Events::_logs`（一个私有静态指针）必须得到 Events 的授权，所以 EventLog 需要是 Events 的 friend。

两个类各管一摊数据——EventLog 管理自己的 `_next` 链表节点，Events 管理全局注册表 `_logs`。但它们的操作互相穿插：Events 遍历节点链表需要访问 EventLog 的 `_next`，EventLog 注册自己需要访问 Events 的 `_logs`。双向 friend 让这种设计得以存在，而不需要把内部数据公开。

## VMStructs 的通用友元

HotSpot 中有一个特殊的调试工具叫 Serviceability Agent（SA）——它允许外部工具（如 jmap、jstack）在运行时检查 JVM 内部数据结构，而不需要 JVM 进程配合（通常通过读取 core dump 或 attach 到进程）。这意味着 SA 需要访问 JVM 几乎所有核心类的私有字段。

实现这一点的方式是声明 `VMStructs` 作为通用友元：

```cpp
// klass.hpp
class Klass : public Metadata {
    friend class VMStructs;
    friend class JVMCIVMStructs;
    // ...
};

// thread.hpp
class Thread {
    friend class VMStructs;
    // ...
};
```

`VMStructs` 类通过友元授权，可以遍历和打印所有类的私有成员（字段名、类型、偏移量），生成 SA 代理所需的元数据表。没有 friend 机制，这些字段必须全部设为 public——把 JVM 内部状态暴露给所有调用方，而不是只暴露给特定工具类。

这种设计体现了 friend 的核心哲学：不是不信任外部代码，而是定义一套精确的信任边界。SA 需要看到一切，所以授予全部访问权；业务代码只需要看到接口，所以 private 成员被隐藏。两个目标在同一个类定义中和平共处。

## Handle 子系统的 friend 设计

HandleMark 和 HandleArea 之间也采用相同的单向 friend 模式：

```cpp
// handles.hpp
class HandleArea : public Arena {
    friend class HandleMark;
    friend class NoHandleMark;
    friend class ResetNoHandleMark;

    int _handle_mark_nesting;
    int _no_handle_mark_nesting;
    HandleArea* _prev;
};
```

HandleMark 构造时保存 HandleArea 的分配位置，析构时回滚。它需要直接操作 `_handle_mark_nesting` 和 `_no_handle_mark_nesting` 这两个嵌套计数器——如果嵌套使用 HandleMark，只有最外层的析构才真正回滚。这些内部状态对外部代码毫无意义，但对 HandleMark 是实现正确性的关键。

## public / protected / private 继承

继承也可以带访问控制修饰，但它和成员访问控制容易混淆。核心规则是：**继承的访问修饰只影响外部代码通过子类指针访问父类成员时的可见性，不影响子类内部对父类成员的访问**。

```cpp
class Base {
public:    void pub();
protected: void prot();
private:   void priv();
};

class PubChild : public Base    {};  // pub→public, prot→protected
class ProtChild : protected Base {};  // 所有 public/protected → protected
class PrivChild : private Base   {};  // 所有 public/protected → private
```

用 `PubChild` 的例子：外部代码可以通过 `PubChild` 对象调用 `pub()`——因为 `pub` 在父类中是 public，public 继承后保持 public。子类内部也可以调用 `prot()`。

用 `ProtChild` 的例子：外部代码不能通过 `ProtChild` 对象调用 `pub()` 或 `prot()`——protected 继承把父类的所有 public 成员都变成了 protected。但子类内部仍然可以访问父类的 public 和 protected 成员，只是从外部看它们被"压窄"了。

用 `PrivChild` 的例子：private 继承把父类的一切都变为 private。外部完全看不到任何 Base 接口。即使再往下一层——PrivChild 的子类也无法访问 Base 的成员，因为它们在 PrivChild 中已经是 private 了。

HotSpot 中绝大多数继承是 public。private 继承偶尔用于"用已有类的功能但不暴露其接口"的场景——类似组合，但需要在子类内部调用父类方法。它比组合更紧密，比 public 继承更隐蔽。

## 子类内部访问规则的总结

无论继承方式是 public、protected 还是 private，子类内部遵循同样的规则：永远可以访问父类的 public 和 protected 成员，永远不能直接访问父类的 private 成员。

这就是为什么 EventLog 把 `_next` 设为 private 并授予 Events 友元。它的子类（EventLogBase、具体日志类）不需要访问 `_next`——维护链表是 Events 的职责。把 `_next` 设为 protected 会让所有子类无意中获得一个它们不应该使用的入口点。设为 private + friend Events 精确表达了设计意图：只有 Events 有权维护链表。

理解了这个规则后回看 ResourceMark 和 ResourceArea：ResourceMark 声明为 ResourceArea 的 friend，而不是让其继承或通过 protected 访问，原因相同——ResourceMark 是工具类，不是子类，它需要访问 ResourceArea 但不需要在 ResourceArea 的类层次中拥有位置。friend 比继承更精确地表达了这种"工具-资源"关系。
