# 嵌套模板类

单层模板类已经足够强大，但 HotSpot 中出现了更复杂的结构——一个模板类内部又定义了一个模板类。`EventLogBase<T>` 内部的 `EventRecord<X>` 是理解事件日志环形缓冲区设计的关键。这一章从嵌套模板的基本语法讲起，逐步展开到它的设计目的和 HotSpot 中的实际运用。

## 外层模板内嵌内层模板的基本语法

在 C++ 中，嵌套模板类就是把一个 `template<...>` 声明写在另一个模板类的定义体内部。语法本身没有特殊规则——外层和内层各自有独立的模板参数声明，互不干扰。

`events.hpp` 中 `EventLogBase` 的真实定义为这个语法提供了最直接的例子（为突出结构省略了辅助方法）：

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
};
```

注意内层模板 `EventRecord` 有自己独立的模板参数 `X`，这个 `X` 和外层的 `T` 在语法层面没有任何关联——你可以单独写 `EventRecord<int>` 或 `EventRecord<std::string>`，和 `EventLogBase<T>` 的 `T` 完全无关。但在实际使用中，`_records` 被声明为 `EventRecord<T>*`，用外层的 `T` 来绑定内层的 `X`。这意味着当编译器实例化 `EventLogBase<StringLogMessage>` 时，它先把 `T = StringLogMessage`，然后发现 `_records` 的类型是 `EventRecord<StringLogMessage>*`，于是把内层模板实例化为 `EventRecord<StringLogMessage>`，其中 `data` 成员变成 `StringLogMessage` 类型。

## 用外层 T 绑定内层 X——一种常见的设计模式

外层的 `T` 不直接约束内层 `X` 的合法值——从语法上说，你可以在类外部用 `EventLogBase<int>::EventRecord<double>` 创建一个内层参数和外层参数不同的类型。但在这个类的设计中，只有 `EventRecord<T>` 这个组合被实际使用——`_records` 的声明和构造函数中的 `new EventRecord<T>[length]` 都只用到了这个组合。

这种"通过使用模式来约束，而非语法强制"的设计在 C++ 模板中非常常见。它赋予了设计灵活性（内层模板在理论上可以被独立使用），同时又通过实际使用模式明确了设计意图。

## 参数流动——从外层到底层

回头看 HotSpot 中 `events.hpp` 的完整参数流动路径，它清晰地展示了模板参数如何跨越多层嵌套传递：

```
FormatBuffer<bufsz>                     // bufsz 决定缓冲区大小
  └─ FormatStringLogMessage<bufsz>     // 空壳继承，用于类型区分
       └─ EventLogBase<T>               // T = FormatStringLogMessage<bufsz>
            └─ EventRecord<T>           // 内层模板，T 绑定为日志消息类型
                 └─ CHeapObj<mtInternal> // 内层继承，内存追踪标签
```

每一步中，模板参数要么被直接传递（`bufsz` 从 `FormatBuffer` 一路传到 `FormatStringLogMessage`），要么被封装后传递（`FormatStringLogMessage<bufsz>` 作为一个完整类型成为 `EventLogBase` 的 `T`）。最终这个类型一路传递到 `EventRecord` 的 `data` 成员——环形缓冲区中每个条目的数据字段类型。

## 嵌套类对封闭类的访问权限

C++ 的嵌套类和 Java 的内部类有一个关键差异：C++ 的嵌套类**不能自动访问封闭类对象的非静态成员**。在 Java 中，内部类隐式持有一个外部类引用，可以直接访问 `OuterClass.this.field`。在 C++ 中，嵌套类只是一个定义在外层类作用域内的普通类——它不持有任何指向外层对象的隐式指针。

但这并不意味着嵌套类和外层类之间有一道墙。C++11 明确规定：嵌套类**可以**访问封闭类的 `private` 和 `protected` 成员，前提是通过封闭类的对象引用或指针来访问。

`events.hpp` 中的 `print` 方法演示了这个特性。`EventLogBase` 可以直接访问 `EventRecord` 的所有成员（包括 public 区的 `timestamp`、`thread`、`data`），无需 getter/setter：

```cpp
void print(outputStream* out, EventRecord<T>& e) {
  out->print("Event: %.3f ", e.timestamp);
  if (e.thread != NULL) {
    out->print("Thread " INTPTR_FORMAT " ", p2i(e.thread));
  }
  print(out, e.data);
}
```

如果 `EventRecord` 是外部定义的独立类，要么需要把成员设为 public（破坏封装），要么需要把 `EventLogBase` 声明为友元（增加耦合声明）。嵌套类的设计让内部细节类可以保持成员 public 对外层访问，同时又通过嵌套作用域限制它不被外部滥用。

这个访问规则是**单向**的——`EventRecord` 可以访问 `EventLogBase` 的私有成员，但 `EventLogBase` 并不能自动访问 `EventRecord` 的私有成员。对 `EventRecord` 来说，`EventLogBase` 只是一个定义它的作用域，不是父类。两者之间的访问权限取决于各自的 `public`/`private`/`protected` 声明，和嵌套关系本身无关。

## StackObj——禁止堆分配的基类

`StackObj` 是 HotSpot 中一个极其简单但设计意图极为明确的基类，定义在 `allocation.hpp` 中：

```cpp
class StackObj ALLOCATION_SUPER_CLASS_SPEC {
 private:
  void* operator new(size_t size) throw();
  void* operator new [](size_t size) throw();
  void  operator delete(void* p);
  void  operator delete [](void* p);
};
```

它的全部意义在于把 `operator new` 重载声明在 `private` 区域并且不提供实现。任何试图用 `new` 创建 `StackObj` 或其派生类的代码，都会触发编译错误（外部代码无法访问 private 的 `operator new`）。它的实现中调用 `ShouldNotCallThis()` 作为兜底——如果某个内部链接方式绕过了编译检查，链接器或运行时会直接终止程序。

继承 `StackObj` 的类只能在栈上创建，或者作为其他对象的成员。`ResourceMark`、`HandleMark`、`TraceTime` 这些依赖 RAII 的类都继承自 `StackObj`——它们构造时获取资源、析构时释放资源，生命周期必须和作用域严格绑定。栈分配天然保证了这种语义，堆分配则会破坏它。

## CHeapObj——带 NMT 标签的堆分配基类

和 `StackObj` 对应的是 `CHeapObj`——一个模板类，用于标记对象应该在 C-Heap 上分配，并且附带 NMT（Native Memory Tracking）追踪标签。定义在 `allocation.hpp` 中：

```cpp
template <MEMFLAGS F> class CHeapObj ALLOCATION_SUPER_CLASS_SPEC {
 public:
  ALWAYSINLINE void* operator new(size_t size) throw() {
    return (void*)AllocateHeap(size, F);
  }
  void  operator delete(void* p)     { FreeHeap(p); }
  void  operator delete [] (void* p) { FreeHeap(p); }
};
```

模板参数 `F` 的类型是 `MEMFLAGS`，它实际上是 `MemoryType` 枚举的 typedef，定义在同一文件中：

```cpp
enum MemoryType {
  mtJavaHeap,    mtClass,      mtThread,     mtThreadStack,
  mtCode,        mtGC,         mtCompiler,   mtInternal,
  mtOther,       mtSymbol,     mtNMT,        mtClassShared,
  // ... 更多类别 ...
};
typedef MemoryType MEMFLAGS;
```

`AllocateHeap` 内部记录调用栈和内存类型，使得 NMT 子系统能够计算出每种类型（如 `mtGC`、`mtThread`、`mtCompiler`）各自的内存用量。`EventRecord` 继承自 `CHeapObj<mtInternal>`，意味着所有事件日志条目的内存分配都会被归类到 `mtInternal`——VM 内部使用的通用内存类别。

这个设计模式在 HotSpot 中大量使用：定义一个通用的内存管理机制（`CHeapObj`），通过模板参数传入分类标签，编译期为每个标签生成一套带不同标记的分配器，零运行时开销。

## EventRecord 的完整继承链路

把 `EventRecord` 的完整定义铺开，可以看到嵌套模板和模板继承是如何组合工作的：

```cpp
template <class T> class EventLogBase : public EventLog {
    template <class X> class EventRecord : public CHeapObj<mtInternal> {
      public:                                        // 来自 events.hpp
        double  timestamp;                           // 日志时间戳
        Thread* thread;                              // 关联线程
        X       data;                                // 模板数据，由外层 T 绑定
    };
    // ...
    EventRecord<T>* _records;                        // 环形缓冲区指针
};

// 实例化场景：
// EventLogBase<StringLogMessage>::EventRecord<StringLogMessage>
//   public:
//     double  timestamp;
//     Thread* thread;
//     StringLogMessage data;  // X = StringLogMessage
//   继承自 CHeapObj<mtInternal>  // operator new 带 mtInternal 标签
```

`EventRecord` 继承自 `CHeapObj<mtInternal>` 意味着两件事。第一，通过 `new EventRecord<T>[length]` 分配时，底层调用的是 `AllocateHeap(size, mtInternal)`，NMT 会将这块内存归入 `mtInternal` 类别。第二，析构后调用 `FreeHeap` 释放内存。整个分配/释放链路都在 NMT 的监控之下，不需要程序员手动记录。

## 为什么需要嵌套模板

你可能会问：为什么 `EventRecord` 要嵌套在 `EventLogBase` 内部？放在外面作为独立的模板类——`template<class X> class EventRecord`——在语法上完全可行。

答案在于**语义归属**和**访问控制**。`EventRecord` 是环形缓冲区的一个内部实现细节，除了 `EventLogBase` 及其子类，不需要被任何其他代码知道或使用。把它嵌套在内部，一方面限定了它的可见范围（对外部代码来说，`EventLogBase<T>::EventRecord<X>` 的路径清楚表达了所有权归属），另一方面让 `EventLogBase` 的所有方法可以直接访问 `EventRecord` 的成员，无需友元声明。

更重要的是，嵌套传达了设计意图。"这个类型是另一个类型的一部分"——这个信息在代码结构层面被直接编码，读者不需要从命名约定或注释中推断。如果你看到一个独立在外的 `EventRecord` 类，你会自然地认为它可能被多处使用；但看到 `EventLogBase<T>::EventRecord<X>`，你就知道它的全部用途都局限在那个环形缓冲区里。

## 嵌套类型在 HotSpot 中的其他应用

除了 `EventRecord`，HotSpot 中还有其他经典的嵌套类型使用场景。`ClassFileParser`（`classfile/classFileParser.hpp`）就定义了三个嵌套类作为解析过程的内部辅助类型：

```cpp
class ClassFileParser {
    class ClassAnnotationCollector;    // 收集注解——仅解析阶段使用
    class FieldAllocationCount;        // 管理字段分配计数——内部辅助
    class FieldLayoutInfo;             // 字段布局信息——封装布局逻辑
    // ...
};
```

`InstanceKlass`（`oops/instanceKlass.hpp`）定义了一个嵌套枚举来追踪类加载生命周期：

```cpp
class InstanceKlass : public Klass {
public:
    enum ClassState {
        allocated,          loaded,         linked,
        being_initialized,  fully_initialized, initialization_error
    };
    // ...
};
```

但这些是**非模板的嵌套类**——它们不涉及层层传递的模板参数。`EventLogBase<T>::EventRecord<X>` 的独特之处在于它同时运用了嵌套和模板两种机制：嵌套表达归属关系，模板提供类型灵活性。这种组合在编写高度通用的库代码时尤其有价值。
