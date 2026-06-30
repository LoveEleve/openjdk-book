# vol-cxx ch08 可变参数 (va_list / ...)

C 风格的可变参数 `...` 配合 `va_list` 是 HotSpot 中格式化日志的基础机制。理解它才能看懂 Events::log 和 FormatBuffer 的实现。

## 声明与基本用法

如果函数参数个数不定，末尾用 `...` 表示：

```cpp
void foo(const char* format, ...);
```

最前面的 `format` 是固定参数，它告诉函数后面有多少个额外参数、各自是什么类型。所以可变参数函数几乎都像 `printf` 那样，第一个参数是格式字符串。

## va_list 四件套

在函数体内，用 `va_list` + 四个宏来访问可变参数：

```cpp
#include <stdarg.h>

void foo(const char* format, ...) {
  va_list ap;                // 声明 va_list 变量
  va_start(ap, format);      // 初始化：ap 指向 format 后面的第一个可变参数
  // 通过 ap 使用参数...
  va_end(ap);                // 清理
}
```

`va_start(ap, last_fixed)` 以最后一个固定参数为基准，计算可变参数的起始位置。x86-64 调用约定下，前 6 个参数放寄存器，多余的放栈——`va_list` 内部封装了寄存器与栈的遍历逻辑。

`va_arg(ap, type)` 按类型读取下一个参数并前移指针，但 HotSpot 代码中很少直接使用它，而是把 `va_list` 传给 `vsnprintf` 族函数：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/formatBuffer.hpp 第 72-78 行
template <size_t bufsz>
FormatBuffer<bufsz>::FormatBuffer(const char * format, ...) : FormatBufferBase(_buffer) {
  va_list argp;
  va_start(argp, format);
  jio_vsnprintf(_buf, bufsz, format, argp);  // 委托给 vsnprintf 处理
  va_end(argp);
}
```

FormatBuffer 的构造函数接收 `format, ...`，初始化 `va_list`，然后交给 `jio_vsnprintf` 完成实际的格式化输出。`va_list` 在这里只是一个"参数包"的中转站。

## jio_vsnprintf —— HotSpot 的 vsnprintf

HotSpot 不直接调用标准库的 `vsnprintf`，而是封装了一层：

```cpp
// jdk11u-copy/src/hotspot/share/include/jvm.h 第 1169-1170 行
JNIEXPORT int
jio_vsnprintf(char *str, size_t count, const char *fmt, va_list args);
```

注释说明了它的行为差异：保证 null 结尾（即使被截断），截断时返回 -1 而不是期望的长度。统一的语义避免了不同平台 `vsnprintf` 返回值含义不统一的问题。

## 为什么分两层：log(...) → logv(... va_list)

HotSpot 的 FormatStringEventLog 提供了两个日志写入方法，参数形式不同：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 150-166 行
void logv(Thread* thread, const char* format, va_list ap) ATTRIBUTE_PRINTF(3, 0) {
  if (!this->should_log()) return;
  double timestamp = this->fetch_timestamp();
  MutexLockerEx ml(&this->_mutex, Mutex::_no_safepoint_check_flag);
  int index = this->compute_log_index();
  this->_records[index].thread = thread;
  this->_records[index].timestamp = timestamp;
  this->_records[index].data.printv(format, ap);  // va_list 直接传给底层
}

void log(Thread* thread, const char* format, ...) ATTRIBUTE_PRINTF(3, 4) {
  va_list ap;
  va_start(ap, format);
  this->logv(thread, format, ap);  // 展开 ... 为 va_list，然后委托
  va_end(ap);
}
```

`log` 接收 `...`，用 `va_start` 构造 `va_list`，然后调用 `logv`。分两层有两个原因：

第一，`va_list` 只能向下传递，不能"再展开回 `...`"——如果一个函数已经拿到 `va_list`，它无法调用接收 `...` 的函数，只能调用接收 `va_list` 的函数。所以提供 `logv` 作为底层入口，让 `EventMark` 等其他组件可以直接传 `va_list`。

第二，加锁、取时间戳等通用逻辑放在 `logv` 中，`log` 只做参数展开，避免重复代码。

Events 类的静态方法也是同样的两层设计：

```cpp
// jdk11u-copy/src/hotspot/share/utilities/events.hpp 第 213-220 行
inline void Events::log(Thread* thread, const char* format, ...) {
  if (LogEvents && _messages != NULL) {
    va_list ap;
    va_start(ap, format);
    _messages->logv(thread, format, ap);  // 委托给 EventLogBase 的 logv
    va_end(ap);
  }
}
```

Events::log 接收用户传入的 `...`，展开为 `va_list`，交给底层 `_messages->logv` 处理。用户调用 `Events::log(thread, "Thread added: %p", p)` 时，代码路径是：Events::log → FormatStringEventLog::logv → FormatBuffer::printv → jio_vsnprintf。

## ATTRIBUTE_PRINTF 的格式检查

注意 `log` 和 `logv` 上都标注了 `ATTRIBUTE_PRINTF`。`log` 的 `ATTRIBUTE_PRINTF(3, 4)` 表示第 3 个参数（format）是格式字符串，从第 4 个开始是可变参数。`logv` 的 `ATTRIBUTE_PRINTF(3, 0)` 则不同——因为 `va_list` 已经是一个参数包，不需要后续检查，所以可变参数起始位填 0。

GCC 在编译时据此检查格式匹配，如果代码写 `Events::log(t, "%d", "hello")` 会立即报错。这是 va_list 缺少类型安全这一缺陷的重要补偿。
