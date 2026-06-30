# 可变参数

C 从诞生之初就有一个独特的能力：函数可以接收不确定个数、不确定类型的参数。最经典的例子是 `printf("value is %d, name is %s", 42, "hello")`——`printf` 根本不知道你会传几个参数，是什么类型，全凭格式字符串在运行时解读。HotSpot 的日志系统、错误消息格式化、字符串构造全都建立在这个机制之上。

## 声明可变参数函数

在函数声明中，`...` 放在所有固定参数之后，表示"后面还有任意数量的参数"：

```cpp
void foo(const char* format, ...);
```

`...` 必须出现在最后一个固定参数之后。这是因为 `va_start` 宏需要以最后一个固定参数为锚点，计算出可变参数在栈（或寄存器）中的起始位置。

可变参数函数有一个硬性约束：调用方和函数本身必须对参数个数和类型达成一致。C 语言没有运行时类型信息，`...` 把类型安全完全交给了程序员。调用 `printf("%d", "hello")` 不会在编译时报错（除非用了 `ATTRIBUTE_PRINTF`），运行时行为未定义。这就是为什么几乎所有可变参数函数都以格式字符串开头——它是双方约定类型的唯一凭据。

## va_list 四件套

`<stdarg.h>` 提供了访问可变参数的标准接口。四个东西，缺一不可：

```cpp
#include <stdarg.h>

void foo(const char* format, ...) {
    va_list ap;             // 声明一个 va_list 变量
    va_start(ap, format);   // 初始化：ap 指向 format 后面的第一个可变参数

    // 通过 ap 读取参数...
    int x = va_arg(ap, int);     // 按 int 类型读取下一个参数，指针前移
    double d = va_arg(ap, double); // 按 double 读取下一个

    va_end(ap);             // 清理 va_list
}
```

`va_start(ap, last_fixed)` 以最后一个固定参数 `format` 的地址为基准，加上它的大小，计算出第一个可变参数的位置。这个计算和平台强相关——在 x86-64 上，前 6 个整数参数在寄存器中（rdi, rsi, rdx, rcx, r8, r9），浮点参数在 xmm 寄存器中，超出的才入栈。`va_list` 内部封装了寄存器遍历与栈遍历的复杂逻辑，让调用方不必关心。

`va_arg(ap, type)` 从当前位置读取一个 type 类型的值，然后把 ap 前进到下一个参数位置。"下一个位置"的计算同样依赖 type 的大小和对齐——读 `char` 前进 1 字节，读 `double` 前进 8 字节，读 `struct` 前进整个结构体大小。传错类型不会报错，只会让后续参数的读取全部错位，是可变参数最隐蔽的 bug 来源。

`va_end(ap)` 做清理工作。在大多数平台上它展开为空操作，但标准要求必须调用——某些实现中 `va_list` 可能持有动态分配的资源。

HotSpot 中很少直接使用 `va_arg`——它太容易出错，而且参数类型在编译时就被格式字符串决定了。正确的做法是把 `va_list` 交给 `vsnprintf` 族函数，让它们统一处理。

## 栈帧中的可变参数

理解可变参数必须理解栈帧布局。在传统 x86 调用约定中，参数从右向左压栈，最右边的参数（第一个可变参数）比最后一个固定参数离栈顶更远。`va_start` 从最后一个固定参数的地址开始，向高地址方向扫描，就能顺次访问所有可变参数。

x86-64 System V ABI（Linux 所用）引入了寄存器传参，让事情变复杂了。前 6 个整数参数通过 rdi/rsi/rdx/rcx/r8/r9 传递，前 8 个浮点参数通过 xmm0-xmm7 传递。编译器在函数入口处为可变参数函数生成一段"寄存器保存区"（register save area）——把这 6 个通用寄存器的值转储到栈上，这样 va_list 只需要遍历栈就能访问所有参数。这段寄存器保存区通常紧挨着 rbp（帧指针）的特定偏移位置。

GDB 验证：用 `info frame` 查看当前帧的 saved registers，用 `x/16gx $rbp-偏移` 查看寄存器保存区的内容，可以直观地看到参数在栈上的排列。

## vsnprintf 与 jio_vsnprintf

`vsnprintf` 是 printf 家族的底层函数，它不接收 `...`，而是接收 `va_list`：

```cpp
int vsnprintf(char* buf, size_t n, const char* fmt, va_list ap);
```

标准库的 `vsnprintf` 在不同平台上返回值含义不一致：有些平台返回应写入的长度（即使被截断），有些返回 -1。HotSpot 封装了自己的 `jio_vsnprintf` 来统一这个行为：

```cpp
// jvm.h
JNIEXPORT int jio_vsnprintf(char* str, size_t count, const char* fmt, va_list args);
```

它的语义是：总是以 null 结尾（buffer 满了也保证最后一个字节是 '\0'），被截断时返回 -1。这两个保证让调用方不必检查平台差异。

在 HotSpot 内部，`FormatBuffer` 的构造函数正是用 `jio_vsnprintf` 将可变参数写入内部缓冲区：

```cpp
// formatBuffer.hpp
template <size_t bufsz>
FormatBuffer<bufsz>::FormatBuffer(const char* format, ...) : FormatBufferBase(_buffer) {
    va_list argp;
    va_start(argp, format);
    jio_vsnprintf(_buf, bufsz, format, argp);
    va_end(argp);
}
```

`bufsz` 是模板参数，编译期确定缓冲区大小，杜绝了栈溢出风险。

## 两层设计：log → logv

HotSpot 的日志系统有一条清晰的设计原则：接收 `...` 的公开接口只做参数展开，真正的业务逻辑在接收 `va_list` 的内部函数中。这层间接是工程必然——`va_list` 只能向下传递，不能再展开回 `...`。

如果底层函数 A 已经拿着 `va_list`，它无法调用接收 `...` 的函数 B——`...` 只能从调用栈的固定参数位置初始化。所以必须提供 `logv` 这种接收 `va_list` 的版本作为真正的实现入口。以下是 Events 日志系统的完整转发链：

Events::log 是用户入口——它在 `...` 和 `va_list` 之间做转换：

```cpp
// events.hpp
inline void Events::log(Thread* thread, const char* format, ...) {
    if (LogEvents && _messages != NULL) {
        va_list ap;
        va_start(ap, format);
        _messages->logv(thread, format, ap);
        va_end(ap);
    }
}
```

`_messages->logv` 是实际实现——它接收 `va_list`，加锁、取时间戳、写入环形缓冲区：

```cpp
// events.hpp
void logv(Thread* thread, const char* format, va_list ap) ATTRIBUTE_PRINTF(3, 0) {
    if (!this->should_log()) return;
    double timestamp = this->fetch_timestamp();
    MutexLockerEx ml(&this->_mutex, Mutex::_no_safepoint_check_flag);
    int index = this->compute_log_index();
    this->_records[index].thread = thread;
    this->_records[index].timestamp = timestamp;
    this->_records[index].data.printv(format, ap);
}
```

`printv` 再调用 `jio_vsnprintf` 完成最终的格式化输出。整条链路是：`Events::log(...)` → `_messages->logv(fmt, va_list)` → `data.printv(fmt, va_list)` → `jio_vsnprintf(_buf, 256, ...)`。每一层职责分明——Events 做条件过滤，logv 做并发保护，printv 做缓冲区写入，jio_vsnprintf 做字符串格式化。

注意 `log` 上的 `ATTRIBUTE_PRINTF(3, 4)` 和 `logv` 上的 `ATTRIBUTE_PRINTF(3, 0)`。前者告诉 GCC 第 3 个参数（format）是格式字符串，检查从第 4 个参数开始的可变参数类型。后者的可变参数序号是 0——因为 `logv` 接收的是 `va_list`，GCC 不向后追查，格式检查在这一层截止。

## ATTRIBUTE_PRINTF 的类型检查

在 ch07 中已经见过 `ATTRIBUTE_PRINTF` 的宏定义。它在可变参数场景中起着关键的安全兜底作用。没有它，`printf` 家族函数是 C 语言中最危险的安全漏洞来源之一——类型不匹配的行为完全未定义。

有了 `ATTRIBUTE_PRINTF(3, 4)`，GCC 在编译时会检查：第 3 个参数是格式串，第 4 个参数与第一个 `%` 说明符类型是否匹配，第 5 个与第二个 `%` 是否匹配，以此类推。写 `Events::log(t, "%d %s", "wrong_type", 42)` 时，GCC 会发现第 4 个参数期望 `int` 但得到 `const char*`，立即报错。

这是编译期静态检查弥补 C 语言运行时类型缺失的典型案例。C++ 的可变参数模板（variadic templates）在语言层面解决了类型安全问题，但 HotSpot 基于 C++98/11 的代码大量使用 C 风格可变参数，`ATTRIBUTE_PRINTF` 就成了唯一的类型防线。

## C++11 的替代方案

C 风格可变参数有三个根本缺陷：类型不安全、无法在编译期确定参数个数、`va_list` 只能向下传。C++11 提供了两种替代方案。

`std::initializer_list` 允许函数接收任意数量的同类型参数：

```cpp
void log(std::initializer_list<int> values) {
    for (int v : values) { ... }
}

log({1, 2, 3, 4});  // 所有参数类型相同
```

类型安全、编译期可确定个数，但限制是——所有参数必须是同一类型。对于 printf 风格的格式字符串场景，这不够用。

可变参数模板（variadic templates）是 C++11 引入的真正解决方案：

```cpp
template<typename... Args>
void log(const char* fmt, Args&&... args) {
    printf(fmt, std::forward<Args>(args)...);
}

log("%d %s", 42, "hello");  // 类型安全，每个参数独立推导
```

编译器在实例化时为每个参数独立推导类型，任何类型不匹配都在编译期暴露。没有 va_list 的栈扫描开销，参数通过语言本身的完美转发机制（`std::forward`）传递。

HotSpot 没有广泛使用可变参数模板，原因有二：代码基于 C++98 兼容性（大部分代码在 C++11 之前就已定型），以及 C 风格可变参数在 printf 格式化场景中的便利性——`vsnprintf` 已经解决了格式化问题，替换整个链路的收益不足以说服 JDK 维护者重构所有日志代码。
