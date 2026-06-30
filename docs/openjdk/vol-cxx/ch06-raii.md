# RAII 资源获取即初始化

RAII（Resource Acquisition Is Initialization）是 C++ 最核心的资源管理哲学，也是 C++ 区别于 Java/C# 等语言的根本特性之一。核心思想：**构造函数获取资源，析构函数释放资源**。C++ 保证无论以何种方式离开作用域（正常 return、异常抛出、goto），析构函数都会执行。

## RAII 的本质：确定性析构

为什么 C++ 用 RAII 而 Java 用 try-finally？因为 C++ 的析构函数是**确定性的**——编译器知道析构函数何时必须被调用。

在 Java 中：

```java
Lock lock = new ReentrantLock();
lock.lock();
try {
    // 临界区
} finally {
    lock.unlock();  // 必须写，容易遗忘
}
```

在 C++ 中：

```cpp
{
    std::lock_guard<std::mutex> lock(mtx);  // 构造：加锁
    // 临界区
}  // 析构：自动解锁——不需要写finally
```

C++ 对象的生命周期与作用域绑定。栈对象在离开作用域时，析构函数被编译器自动插入。异常发生时，栈展开过程会按逆序调用所有已构造对象的析构函数。这就是确定性析构的威力——资源释放不需要程序员记得，编译器不会忘。

对比 C 语言的显式释放：

```c
/* C 语言：每个错误路径都要手动释放所有已获取的资源 */
void process(const char* path) {
    FILE* fp = fopen(path, "r");
    if (!fp) return;

    char* buf = malloc(BUFSIZ);
    if (!buf) {
        fclose(fp);         // 错误路径 1
        return;
    }

    pthread_mutex_lock(&g_mutex);
    if (some_error) {
        pthread_mutex_unlock(&g_mutex);  // 错误路径 2
        free(buf);
        fclose(fp);
        return;
    }

    pthread_mutex_unlock(&g_mutex);  // 正常路径
    free(buf);
    fclose(fp);
}
// 3 种资源，3 种释放方式，3 个 return 路径——最多 9 个释放点，极易遗漏
```

## HotSpot RAII 三件套

HotSpot 是 RAII 的工业级应用典范。JVM 中锁、Arena 内存、GC 句柄等资源必须正确释放，手动管理在几十万行的代码量下绝无可能。

### MutexLockerEx——锁守卫

HotSpot 中最典型的 RAII 就是锁守卫：

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

构造时加锁，析构时解锁。使用极其简洁：

```cpp
{
  MutexLockerEx ml(&some_lock, Mutex::_no_safepoint_check_flag);
  // 临界区代码
  // 即使这里 return、抛异常，锁也会自动释放
}  // ml 析构，自动解锁
```

构造函数也可传 NULL，此时 MutexLockerEx 是一个 no-op 锁守卫——在可选加锁的场景中非常方便，调用方不需要用 if/else 包裹 `MutexLockerEx` 的声明。

### ResourceMark——Arena 内存守卫

HotSpot 中大量临时数据分配在 ResourceArea（线程本地的 Arena 内存）中。Arena 不跟踪单独的内存块，而是在一块大内存中线性增长。ResourceMark 利用这个特性实现高效的批量释放：

```cpp
// jdk11u-copy/src/hotspot/share/memory/resourceArea.hpp 第 73-164 行
class ResourceMark: public StackObj {
 protected:
  ResourceArea *_area;
  Chunk *_chunk;
  char *_hwm, *_max;        // 高水位标记和上限
  size_t _size_in_bytes;

  void initialize(Thread *thread) {
    _area = thread->resource_area();
    _chunk = _area->_chunk;     // 保存当前 chunk 指针
    _hwm = _area->_hwm;         // 保存当前高水位标记
    _max = _area->_max;         // 保存当前上限
    _size_in_bytes = _area->size_in_bytes();
  }

  ~ResourceMark() {
    reset_to_mark();  // 析构时回滚
  }

  void reset_to_mark() {
    if (_chunk->next()) {
      _area->set_size_in_bytes(size_in_bytes());
      _chunk->next_chop();        // 砍掉 _chunk 之后的所有 chunk
    }
    _area->_chunk = _chunk;       // 恢复保存的 chunk
    _area->_hwm = _hwm;           // 恢复水位线
    _area->_max = _max;           // 恢复上限
    if (ZapResourceArea) memset(_hwm, badResourceValue, _max - _hwm);
  }
};
```

使用模式：

```cpp
{
  ResourceMark rm;                      // 1. 打快照：记住 Arena 当前水位线
  int* arr = NEW_RESOURCE_ARRAY(int, 1000);
  char* buf = NEW_RESOURCE_ARRAY(char, 4096);
  // 使用 arr 和 buf...
}  // 2. rm 析构：Arena 水位线回滚，上面所有分配全部归还
```

ResourceMark 的构造是 O(1)（只是保存几个指针），析构也是 O(1)（回滚水位线）。不管中间在 Arena 中分配了多少个对象，释放都是常数时间——比逐个释放高效得多。这正是 Arena + Mark 模式的威力：用一次 O(1) 的回滚代替 N 次 O(1) 的释放。

### HandleMark——GC 句柄守卫

HotSpot 中 Java 对象的引用用 Handle（oop 指针的指针）封装。GC 可能移动对象，通过 Handle 中间层，所有 GC Root 被正确追踪。Handle 分配在线程的 HandleArea 中：

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
  HandleMark hm(thread);              // 保存 Handle 区状态
  Handle class_loader(THREAD, ...);   // 在 Handle 区分配
  Handle protection_domain(THREAD, ...);
  // 使用各种 Handle
}  // hm 析构：所有中间分配的 Handle 自动释放
```

HandleMark 的设计比典型 RAII 稍复杂——它同时支持栈分配和堆分配（线程创建时需要堆分配一个初始 HandleMark），所以它不继承 StackObj，而是显式提供了 public 的 operator new。

## StackObj 基类：用访问控制强制正确用法

RAII 对象的生命周期必须绑定到作用域，因此必须在栈上分配。HotSpot 用 `StackObj` 基类来编译期保证这一点：

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

`operator new` 和 `operator delete` 都声明为 `private`，外部代码如果写 `new MutexLockerEx(...)` 会编译失败。MutexLockerEx、ResourceMark 都继承自 StackObj，保证它们只能在栈上使用。

这是 C++ 访问控制在编译期约束中的经典应用——把"不该做的事情"变成"做不到的事情"，而不是靠文档或代码审查来约束。

## C++11 的 std::lock_guard / std::unique_lock 对比

C++11 标准库提供了 `std::lock_guard` 和 `std::unique_lock`，功能上是 HotSpot 自建 `MutexLockerEx` 的"标准化版本"：

```cpp
#include <mutex>

std::mutex mtx;

// std::lock_guard：不可移动，不可解锁后重新加锁
{
    std::lock_guard<std::mutex> lock(mtx);  // 构造加锁
    // ...
}  // 析构解锁

// std::unique_lock：可移动，可手动 unlock/lock
{
    std::unique_lock<std::mutex> lock(mtx);
    // ...
    lock.unlock();  // 可以提前解锁
    // ...
    lock.lock();    // 重新加锁
    // ...
}  // 析构时如果还锁着，自动解锁
```

HotSpot 为什么要自建而不是直接用标准库的？

第一个原因是历史：HotSpot 的代码库始于 C++98 时代，`std::lock_guard` 直到 C++11 才引入。但即使到今天，HotSpot 的自建版本仍然有其价值。`MutexLockerEx` 的锁对象是 `Monitor*`（HotSpot 自己实现的），不是 `std::mutex`；它需要支持 safepoint check 的可选控制；它支持传入 NULL 变成 no-op。这些都是 JVM 的特定需求，标准库的通用实现无法直接满足。

## 异常安全与 RAII

RAII 的另一个基石价值是异常安全。考虑这段代码：

```cpp
void transfer(Account& from, Account& to, double amount) {
    from.debit(amount);
    to.credit(amount);   // 如果这行抛异常？
}
```

如果 `credit` 抛异常，`from` 的钱已经被扣了但 `to` 没有到账——数据不一致。用 RAII 可以解决：

```cpp
void transfer(Account& from, Account& to, double amount) {
    from.debit(amount);
    // RAII 回滚守卫：如果 credit 抛异常，析构中执行 rollback
    struct Rollback {
        Account& acc;
        double amt;
        bool committed = false;
        ~Rollback() { if (!committed) acc.credit(amt); }
    } guard(from, amount);

    to.credit(amount);
    guard.committed = true;  // 成功，不触发回滚
}
```

如果 `to.credit(amount)` 抛异常，栈展开调用 `guard.~Rollback()`，`committed` 为 false，执行 `from.credit(amount)` 回滚——数据一致性得到保证。

HotSpot 中这种模式随处可见。构造保存状态，析构恢复状态，异常安全自然而然地融入设计——不需要在每个错误路径写恢复代码。

## HotSpot 中的 RAII 全景

本节只展开三个最核心的例子，但 HotSpot 的 RAII 是一个完整的资源管理体系：

```
资源管理类         用途                      关键文件
─────────         ────                      ────────
ResourceMark      Arena 内存自动回滚          resourceArea.hpp:73
HandleMark        Handle 区内存自动回滚        handles.hpp:240
HandleMarkCleaner 快速版 HandleMark           handles.hpp:305
MutexLockerEx     锁自动获取/释放              mutexLocker.hpp:224
MonitorLockerEx   监视器自动获取/释放          mutexLocker.hpp:251
TraceTime         自动计时+结束后输出          timerTrace.hpp:46
EventMark         事件开始/结束标记            events.hpp:302
GCIdMark          GC ID 自动标记              gcId.hpp
```

核心设计模式是同一个：构造时标记/获取/锁定，析构时回滚/释放/解锁。这种统一的设计让整个代码库遵循同样的资源管理范式——阅读源码时，看到一个继承 StackObj 的类出现在作用域开头，立刻就知道它在管理某种资源，离开作用域时自动释放。
