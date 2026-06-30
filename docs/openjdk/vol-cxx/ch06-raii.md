# vol-cxx ch06 RAII 模式

RAII（Resource Acquisition Is Initialization）是 C++ 中最常见的资源管理模式。核心思想：**构造函数获取资源，析构函数释放资源**。对象在栈上创建时构造函数自动调用，离开作用域时析构函数自动调用——编译器保证无论以何种方式离开作用域（正常 return、异常、goto），析构函数都会执行。

HotSpot 中处处都是 RAII，因为 JVM 中锁、Arena 内存、GC 句柄等资源必须正确释放，手动管理极易遗漏。

## MutexLockerEx —— 锁守卫

HotSpot 中最典型的 RAII 就是锁守卫。`mutexLocker.hpp` 中定义了 `MutexLocker` 和 `MutexLockerEx`：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/mutexLocker.hpp 第 224-245 行
class MutexLockerEx: public StackObj {
 private:
  Monitor * _mutex;
 public:
  MutexLockerEx(Monitor * mutex, bool no_safepoint_check = !Mutex::_no_safepoint_check_flag) {
    _mutex = mutex;
    if (_mutex != NULL) {
      assert(mutex->rank() > Mutex::special || no_safepoint_check,
        "Mutexes with rank special or lower should not do safepoint checks");
      if (no_safepoint_check)
        _mutex->lock_without_safepoint_check();  // 构造时加锁
      else
        _mutex->lock();
    }
  }

  ~MutexLockerEx() {
    if (_mutex != NULL) {
      _mutex->unlock();  // 析构时解锁
    }
  }
};
```

使用方式极其简洁：

```cpp
{
  MutexLockerEx ml(&some_lock, Mutex::_no_safepoint_check_flag);
  // 临界区代码...
  // 如果这里 return 或抛异常，锁也会自动释放
}  // ml 析构，自动解锁
```

不需要显式调 unlock，不用担心漏掉某个 return 路径。构造时也可传 NULL，此时 `MutexLockerEx` 是一个 no-op —— 在可选加锁的场景中非常方便。

## ResourceMark —— Arena 内存守卫

HotSpot 中大量临时数据分配在 ResourceArea（线程本地的 Arena 内存）中。`ResourceMark` 在构造时保存 Arena 当前状态，析构时回滚到保存的状态，一次性释放构造后分配的所有内存：

```cpp
// jdk11u-copy/src/hotspot/share/memory/resourceArea.hpp 第 73-164 行
class ResourceMark: public StackObj {
 protected:
  ResourceArea *_area;
  Chunk *_chunk;
  char *_hwm, *_max;
  size_t _size_in_bytes;

  void initialize(Thread *thread) {
    _area = thread->resource_area();
    _chunk = _area->_chunk;     // 保存当前 chunk
    _hwm = _area->_hwm;         // 保存当前高水位标记
    _max = _area->_max;
    _size_in_bytes = _area->size_in_bytes();
    debug_only(_area->_nesting++;)
  }

  ~ResourceMark() {
    debug_only(_area->_nesting--;)
    reset_to_mark();  // 析构时回滚
  }
};
```

使用模式：

```cpp
{
  ResourceMark rm;                      // 保存当前 Arena 状态
  int* arr = NEW_RESOURCE_ARRAY(int, 64);  // 在 Arena 中分配
  // 使用 arr...
}  // rm 析构，释放本次分配的所有内存
```

`rm` 离开作用域时，`~ResourceMark` 把 Arena 的高水位标记退回到构造时的位置，中间分配的内存全部"归还"。这是 C 语言 `alloca` 概念的升级版——不限于当前栈帧，可以跨函数调用在同一个 Arena 中分配。

## HandleMark —— GC 句柄守卫

HotSpot 中 Java 对象的引用用 Handle（oop 指针的指针）封装，Handle 分配在线程的 HandleArea 中。`HandleMark` 在析构时销毁作用域内创建的所有 Handle：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/handles.hpp 第 240-270 行
class HandleMark {
 private:
  Thread *_thread;
  HandleArea *_area;
  Chunk *_chunk;
  char *_hwm, *_max;
  size_t _size_in_bytes;
  HandleMark* _previous_handle_mark;

  void initialize(Thread* thread);

 public:
  HandleMark(Thread* thread) { initialize(thread); }
  ~HandleMark();
};
```

使用模式与 ResourceMark 类似：

```cpp
{
  HandleMark hm(thread);
  Handle h1(thread, some_oop);  // 创建 Handle
  Handle h2(thread, another_oop);
  // 使用 h1, h2...
}  // hm 析构，所有 Handle 失效
```

HandleMark 的设计比典型 RAII 稍复杂——它同时支持栈分配和堆分配（因为线程创建时需要堆分配一个初始 HandleMark），构造函数被设计为可以 new。

## StackObj —— 强制栈分配

RAII 对象的生命周期必须绑定到作用域，所以必须在栈上分配。HotSpot 用 `StackObj` 基类来强制这一点：

```cpp
// jdk11u-copy/src/hotspot/share/memory/allocation.hpp 第 219-228 行
class StackObj ALLOCATION_SUPER_CLASS_SPEC {
 private:
  void* operator new(size_t size) throw();    // new 是 private
  void* operator new [](size_t size) throw();
  void  operator delete(void* p);             // delete 也是 private
  void  operator delete [](void* p);
};
```

`operator new` 和 `operator delete` 都声明为 `private`，所以外部代码如果写 `new MutexLockerEx(...)` 会编译失败。MutexLockerEx、ResourceMark、HandleMark 都继承自 StackObj，保证它们只能在栈上使用。

这也是 HotSpot 中区分"堆对象"和"栈对象"的方式：继承 `CHeapObj` 的类可以在堆上分配；继承 `StackObj` 的类只能在栈上分配。
