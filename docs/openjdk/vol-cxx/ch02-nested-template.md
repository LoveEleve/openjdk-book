# 嵌套模板类

ch01 讲了单层模板类，但 HotSpot 中出现了更复杂的嵌套——一个模板类内部又定义了一个模板类。`EventLogBase<T>` 在 vol-01 ch03 eventlog_init 中首次出现时，它内部嵌套的 `EventRecord<X>` 是理解整个事件日志结构的关键。

## 外层模板内嵌内层模板

语法上可以直接把 `template<...>` 写在外层类的定义体内部。下面是 HotSpot 中 `events.hpp` 的真实定义（为突出结构删除了其他成员）：

```cpp
template <class T> class EventLogBase : public EventLog {
  template <class X> class EventRecord : public CHeapObj<mtInternal> {
   public:
    double  timestamp;
    Thread* thread;
    X       data;
  };

 protected:
  EventRecord<T>* _records;
};
```

注意两个关键点。第一，内层模板 `EventRecord` 有自己独立的模板参数 `X`，和外层的 `T` 互不干扰。第二，`_records` 声明为 `EventRecord<T>*`，用外层的 `T` 绑定内层的 `X`。这意味着当你实例化 `EventLogBase<StringLogMessage>` 时，编译器先确定 `T = StringLogMessage`，然后把内层模板 `EventRecord<X>` 实例化为 `EventRecord<StringLogMessage>`，其中的 `data` 成员变成 `StringLogMessage` 类型。

## 内外层模板参数的绑定关系

外层 `T` 不直接约束内层 `X` 的合法值——你完全可以在其他地方写 `EventRecord<int>`。但在这个类的设计中，`_records` 只使用 `EventRecord<T>`，所以实际生成的代码中内层 `X` 始终等于外层 `T`。这是一种"通过使用模式来约束"的设计，不是语法强制。

构造函数中分配环形缓冲区时也体现了这一点：

```cpp
_records = new EventRecord<T>[length];
```

编译器计算出 `EventRecord<T>` 的大小，在堆上分配 `length` 个连续的对象。这是模板实例化的又一个好处——数组元素的大小在编译时就完全确定了。

## StackObj：禁止堆分配的基类

`StackObj` 是 HotSpot 中一个简单但有重要用途的基类。它的全部意义在于**重载 `operator new` 使其无法被调用**：

```cpp
class StackObj ALLOCATION_SUPER_CLASS_SPEC {
 private:
  void* operator new(size_t size) throw();
  void* operator new [](size_t size) throw();
  void  operator delete(void* p);
  void  operator delete [](void* p);
};
```

`operator new` 被放在 `private` 区且只有声明没有定义（实现在 `allocation.cpp` 中直接调用 `ShouldNotCallThis()`）。这意味着任何试图用 `new StackObj` 或 `new` 派生类的操作都会触发编译错误或链接错误。这强制使用者只能在栈上或作为其他对象的成员来创建它。

## CHeapObj——带 NMT 标签的堆分配基类

`StackObj` 的对应物是 `CHeapObj`——一个模板类，用于标记对象应该在 C-Heap 上分配并附带 NMT（Native Memory Tracking）标签：

```cpp
template <MEMFLAGS F> class CHeapObj ALLOCATION_SUPER_CLASS_SPEC {
 public:
  ALWAYSINLINE void* operator new(size_t size) throw() {
    return (void*)AllocateHeap(size, F);
  }
  // ... 多个 new 重载 ...
  void  operator delete(void* p)     { FreeHeap(p); }
};
```

模板参数 `MEMFLAGS` 实际上是一个枚举 `MemoryType`，包含 `mtInternal`、`mtThread`、`mtGC` 等值。`EventRecord` 继承自 `CHeapObj<mtInternal>`，意味着所有 `EventRecord` 对象的内存分配都会被 NMT 追踪并归类到 `mtInternal` 类别下。

```cpp
template <class X> class EventRecord : public CHeapObj<mtInternal> {
```

这个设计模式在 HotSpot 中大量使用：定义一个通用内存管理机制（`CHeapObj`），通过模板参数传入分类标签，编译期生成带不同追踪标记的分配器，零运行时开销。

## 为什么需要嵌套模板

你可能会问：为什么 `EventRecord` 要嵌套在 `EventLogBase` 内部，而不是放在外面作为独立的模板类？单独定义 `template<class X> class EventRecord` 在语法上完全可行。

答案是**访问控制**和**语义归属**。`EventRecord` 不需要被 `EventLogBase` 之外的代码知道或使用——它是环形缓冲区的一个内部实现细节。把它放在类内部，一方面限制了它的可见范围（类似 Java 的内部类），另一方面明确表达了"它是 EventLogBase 的一部分"这个设计意图。

此外，`EventLogBase` 的 `print` 方法可以直接访问 `EventRecord` 的 `timestamp`、`thread`、`data` 成员，而无需通过 getter/setter。这种紧凑的耦合在一个内部细节类上是合理的：

```cpp
void print(outputStream* out, EventRecord<T>& e) {
  out->print("Event: %.3f ", e.timestamp);
  if (e.thread != NULL) {
    out->print("Thread " INTPTR_FORMAT " ", p2i(e.thread));
  }
  print(out, e.data);
}
```

如果 `EventRecord` 是外部定义的独立类，这种直接访问要么需要把成员设为 public（破坏封装），要么把 `EventLogBase` 声明为 friend class（增加不必要的耦合声明）。嵌套类的 private 成员对其外围类自动可见——这是 C++ 嵌套类的一个微妙但重要特性。

