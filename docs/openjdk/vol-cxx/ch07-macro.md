# vol-cxx ch07 宏与预处理器

HotSpot 大量使用预处理器宏来减少重复代码、实现条件编译和定义类型标记。阅读源码时遇到大写标识符几乎都是宏。

## `#define` 简单宏

最基本的宏替换，将标识符替换为值或代码片段：

```cpp
#define INCLUDE_JVMTI 1
```

预处理器在编译前执行纯文本替换。所有 `INCLUDE_JVMTI` 出现的地方都会被替换为 `1`。

## `#define` 函数式宏

带参数的宏，用 `\` 续写多行：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/mutexLocker.cpp
#define def(var, type, pri, vm_block, safepoint_check_allowed ) {      \
  var = new type(Mutex::pri, #var, vm_block, safepoint_check_allowed); \
  assert(_num_mutex < MAX_NUM_MUTEX, "increase MAX_NUM_MUTEX");        \
  _mutex_array[_num_mutex++] = var;                                    \
}
```

这个 `def` 宏在 `mutex_init()` 中被大量调用，用于创建和注册全局锁。注意 `#var` 是预处理器特有的"字符串化"操作——`def(tty_lock, ...)` 会把 `#var` 变成 `"tty_lock"`。没有这个宏，mutex_init 中的每个锁都需要四行重复代码。

另一个例子是 handles.hpp 中用宏批量生成 Handle 子类：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/handles.hpp 第 103-117 行
#define DEF_HANDLE(type, is_a)                   \
  class type##Handle: public Handle {            \
   protected:                                    \
    type##Oop    obj() const                     { return (type##Oop)Handle::obj(); } \
    type##Oop    non_null_obj() const            { return (type##Oop)Handle::non_null_obj(); } \
   public:                                       \
    type##Handle ()                              : Handle()                 {} \
    inline type##Handle (Thread* thread, type##Oop obj); \
    type##Oop    operator () () const            { return obj(); } \
    type##Oop    operator -> () const            { return non_null_obj(); } \
  };

DEF_HANDLE(instance, is_instance_noinline)
DEF_HANDLE(array, is_array_noinline)
DEF_HANDLE(objArray, is_objArray_noinline)
```

这里 `##` 是"标记粘贴"操作符——`type##Handle` 中 `type` 为 `instance` 时变成 `instanceHandle`。四行宏调用生成了四个完整的类定义。

## CHECK 宏的 `(void)(0` 语法

HotSpot 的异常处理宏是最精妙的宏应用。所有可能抛出异常的函数都把 `Thread*` 作为参数传来传去，调用方用 CHECK 宏检查是否有异常挂起：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/exceptions.hpp 第 220-226 行
#define CHECK                    THREAD); if (HAS_PENDING_EXCEPTION) return       ; (void)(0
#define CHECK_(result)           THREAD); if (HAS_PENDING_EXCEPTION) return result; (void)(0
#define CHECK_0                  CHECK_(0)
#define CHECK_NULL               CHECK_(NULL)
#define CHECK_false              CHECK_(false)
```

使用示例：

```cpp
int result = some_function(args, CHECK_0);
// 展开后大致为：
// int result = some_function(args, THREAD); if (HAS_PENDING_EXCEPTION) return 0; (void)(0
```

关键技巧在于末尾的 `(void)(0`。因为 `some_function(args, THREAD)` 后面有 `);`，合起来就是 `(void)(0);`，这是一个无害的空语句。如果直接写成 `THREAD); if (...) return;`，调用语句末尾还会多出一个分号变成空语句，但加 `(void)(0` 吃掉了那个分号，语法更严谨。

还有一个细节：CHECK 宏在第一部分 `THREAD)` 后没有 `;`，所以调用者的分号会补上。这种写法保证了宏展开后始终是一个完整语句。

## 条件编译

`#ifdef` / `#ifndef` / `#endif` 在 HotSpot 中随处可见，最典型的是 debug 构建专用代码：

```cpp
// jdk11u-copy/src/hotspot/share/runtime/mutexLocker.hpp 第 209-215 行
#ifdef ASSERT
void assert_locked_or_safepoint(const Monitor * lock);
void assert_lock_strong(const Monitor * lock);
#else
#define assert_locked_or_safepoint(lock)
#define assert_lock_strong(lock)
#endif
```

debug（`ASSERT` 定义时）构建中，这两个是真实的函数调用，会检查锁状态。release 构建中它们变成空宏，编译后完全不产生任何指令，零运行时成本。

类似的模式在 `macros.hpp` 中大量出现，如按平台条件编译：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/macros.hpp 第 396-407 行
#ifdef ASSERT
#define DEBUG_ONLY(code) code
#define debug_only(code) code
#else
#define DEBUG_ONLY(code)
#define debug_only(code)
#endif
```

```cpp
// jdk11u-copy/src/hotspot/share/utilities/macros.hpp 第 56-66 行
#if INCLUDE_JVMTI
#define JVMTI_ONLY(x) x
#define NOT_JVMTI(x)
#else
#define JVMTI_ONLY(x)
#define NOT_JVMTI(x) x
#endif
```

在 JVMTI 未包含的构建中，`JVMTI_ONLY(do_something())` 展开为空，功能干净地被裁剪掉。

## `ATTRIBUTE_PRINTF` —— 编译时格式检查

HotSpot 中任何接收 printf 风格格式串的函数都会标注这个属性：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/compilerWarnings.hpp 第 44-46 行
#ifndef ATTRIBUTE_PRINTF
#define ATTRIBUTE_PRINTF(fmt,vargs)  __attribute__((format(printf, fmt, vargs)))
#endif
```

使用方式：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 161 行
void log(Thread* thread, const char* format, ...) ATTRIBUTE_PRINTF(3, 4);
```

参数 `(3, 4)` 表示第 3 个参数是格式字符串，从第 4 个开始是可变参数。GCC 会在编译时检查格式串和后续参数类型是否匹配——如果代码写了 `log(t, "%d", "hello")`（"%d" 期望 int 但传了 char*），编译时立即报错。这弥补了 `va_list` 没有类型安全检查的缺陷。

## THROW_MSG 宏

抛出异常时使用的宏：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/exceptions.hpp 第 250-251 行
#define THROW_MSG(name, message)                    \
  { Exceptions::_throw_msg(THREAD_AND_LOCATION, name, message); return; }
```

展开后是一个用 `{}` 包裹的复合语句块。`THREAD_AND_LOCATION` 展开为 `THREAD, __FILE__, __LINE__`，提供了当前线程、文件和行号信息，用于异常诊断。紧跟着 `return;` 保证抛出异常后立即从当前函数返回。
