# 宏与预处理器

阅读 HotSpot 源码时，大写标识符几乎都是宏。它们用预处理器完成了 C++ 语法本身做不到的事情——从批量生成代码到条件编译、从异常传播到编译器属性标注。理解宏是打开 JVM 源码的钥匙。

## 预处理阶段

C/C++ 编译分四个阶段：预处理、编译、汇编、链接。预处理器在正式开始编译之前运行，它是一种纯文本替换引擎——不检查类型、不解析语法、不认识 C++ 结构。从它的视角看，代码只是一串 token，`#define` 告诉它"见到 A 就替换成 B"。

```cpp
#define INCLUDE_JVMTI 1
```

预处理器扫描源码，把每个 `INCLUDE_JVMTI` 替换为 `1`，然后编译器才开始工作。这意味着宏中的错误要到编译阶段才能被发现——你用宏拼出了一个语法错误的式子，预处理器不会抱怨，编译器才会报错。这也是宏调试困难的根本原因。

用 `g++ -E` 可以只看预处理输出，直观地看到宏展开后的完整代码。阅读看不懂的宏时，这是最有用的工具。

## #define 简单宏

简单宏做纯文本替换。通常用于定义常量、标记功能开关：

```cpp
#define MAX_NUM_MUTEX 128
#define ASSERT  // debug 构建标志
```

HotSpot 中大量使用这种宏来控制功能模块。`INCLUDE_JVMTI`、`INCLUDE_G1GC`、`INCLUDE_CDS` 等开关通过 `#if` 影响整块代码的编译。

## 函数式宏

带参数的宏允许传入参数并在替换中展开。多行宏用 `\` 续写：

```cpp
// mutexLocker.cpp — 锁创建宏
#define def(var, type, pri, vm_block, safepoint_check_allowed) {      \
  var = new type(Mutex::pri, #var, vm_block, safepoint_check_allowed); \
  assert(_num_mutex < MAX_NUM_MUTEX, "increase MAX_NUM_MUTEX");        \
  _mutex_array[_num_mutex++] = var;                                    \
}
```

这个 `def` 宏在 `mutex_init()` 中被反复调用，每个锁原本需要四行重复的 new + assert + 注册代码，用宏压缩成一行调用。注意 `#var`——这是预处理器特有的"字符串化"操作，`def(tty_lock, ...)` 把 `#var` 变成 `"tty_lock"`，作为锁名称传入构造器。

宏调用本身不是类型安全的——`def` 不检查 `var` 的类型是否和 `type` 匹配，这些都是编译阶段才报的错误。这一点和模板不同：模板在实例化时会做完整的类型检查。

## # 运算符 —— 字符串化

`#param` 把宏参数的内容变成 C 字符串字面量。这不是运行时操作——在预处理阶段就完成了。

```cpp
#define STR(a) #a

STR(hello)    // 展开为 "hello"
STR(42)       // 展开为 "42"
```

HotSpot 的 `guarantee` 宏中最关键的一个用法就是 `#p`——把条件表达式本身转成字符串，让错误消息自动包含被检查的表达式：

```cpp
#define guarantee(p, ...)                                          \
do {                                                               \
  if (!(p)) {                                                      \
    report_vm_error(__FILE__, __LINE__, "guarantee(" #p ") failed", \
                    __VA_ARGS__);                                  \
    BREAKPOINT;                                                    \
  }                                                                \
} while (0)
```

调用 `guarantee(ptr != NULL, "pointer must not be null")` 时，`#p` 把 `ptr != NULL` 变成字符串 `"ptr != NULL"`，最终输出 `guarantee(ptr != NULL) failed: pointer must not be null`。你不用在错误消息中重复写表达式，编译器帮你自动同步。

`#` 运算有一个关键陷阱：它阻止宏参数展开。如果传给 `STR` 的参数本身是一个宏，它不会被展开为值，而是被当作原始 token 字符串化：

```cpp
#define VERSION 11
STR(VERSION)   // 结果是 "VERSION"，不是 "11"
```

HotSpot 解决这个问题的方式是用二层间接：

```cpp
#define STR(a)  #a
#define XSTR(a) STR(a)  // 先展开参数，再字符串化

XSTR(VERSION)  // 结果是 "11"
```

`XSTR` 调用 `STR(VERSION)` 之前，参数 `VERSION` 已经被展开为 `11`，所以 `STR` 收到的是 `11` 而不是 `VERSION`。这种二次展开模式在 JVM 的头文件包含宏 `CPU_HEADER_INLINE` 中反复使用。

## ## 运算符 —— 令牌拼接

`a ## b` 将左右两个 token 合并为一个新的标识符。和 `#` 一样，它也阻止参数展开：

```cpp
#define PASTE(a, b) a ## b

PASTE(pd_, UseTLAB)  // 展开为 pd_UseTLAB
```

HotSpot 定义了三层 `PASTE_TOKENS` 正是为了让宏参数先展开再拼接：

```cpp
#define PASTE_TOKENS(x, y)       PASTE_TOKENS_AUX(x, y)
#define PASTE_TOKENS_AUX(x, y)   PASTE_TOKENS_AUX2(x, y)
#define PASTE_TOKENS_AUX2(x, y)  x ## y
```

第一层接收参数时允许参数展开，第二层继续传递，第三层才真正执行 `##` 拼接。JVM 用这个机制实现平台相关变量的批量定义：

```cpp
#define define_pd_global(type, name, value) const type pd_##name = value;

// globals.hpp 中的使用
define_pd_global(bool, BackgroundCompilation, false);
define_pd_global(bool, UseTLAB,             false);
define_pd_global(intx, CompileThreshold,    0);
```

`define_pd_global(bool, BackgroundCompilation, false)` 展开为 `const bool pd_BackgroundCompilation = false;`。不同平台的 globals 文件通过包含相同的 `define_pd_global` 宏定义来覆盖默认值，实现了编译期平台参数配置。

## do { ... } while(0) 惯用法

这是阅读 JVM 宏必须理解的模式。为什么不直接用花括号 `{ ... }` 包装多语句宏？

考虑一个多语句交换宏：

```cpp
#define SWAP_BAD(a, b) { a ^= b; b ^= a; a ^= b; }
```

在 if-else 中使用它：

```cpp
if (condition)
    SWAP_BAD(x, y);  // 展开为：if (condition) { ... };
else                 // ↑ 末尾的分号终止了 if！
    do_something();  // 编译错误：else 没有匹配的 if
```

末尾的分号让编译器认为 if 语句结束了，后面的 else 成了孤儿。`do { ... } while(0)` 解决了这个问题：它是一条完整的语句，分号是语句的一部分，不会过早终止 if。

```cpp
#define SWAP_GOOD(a, b) do { a ^= b; b ^= a; a ^= b; } while (0)

if (condition)
    SWAP_GOOD(x, y);  // 展开为：if (condition) do { ... } while(0);
else
    do_something();   // 正确匹配
```

为什么是 `while(0)` 而不是 `while(1)`？因为 `while(0)` 保证循环体只执行一次。`while(1)` 是死循环，而且编译器可能警告"条件恒为真"。为什么不是 `while(false)`？C 标准中 `while(false)` 等价于 `while(0)`，但 `0` 是业界共识，避免了早期编译器对 `false` 作为 C 关键字的歧义。

HotSpot 中 guarantee、fatal、ShouldNotReachHere、ShouldNotCallThis 等所有多语句宏全部使用 do-while(0) 包装。

## CHECK 宏的异常传播设计

HotSpot 禁用了 C++ 异常（`-fno-exceptions`），但需要类似"检查-返回"的异常传播机制。CHECK 宏系列是最精妙的设计：

```cpp
// exceptions.hpp
#define CHECK              THREAD); if (HAS_PENDING_EXCEPTION) return       ; (void)(0
#define CHECK_(result)     THREAD); if (HAS_PENDING_EXCEPTION) return result; (void)(0
#define CHECK_0            CHECK_(0)
#define CHECK_NULL         CHECK_(NULL)
#define CHECK_false        CHECK_(false)
```

使用方式在函数调用末尾传入：

```cpp
int result = some_function(args, CHECK_0);
```

展开后变成：

```cpp
int result = some_function(args, THREAD);  // 先补完函数调用
if (HAS_PENDING_EXCEPTION) return 0;       // 检查异常，有则返回
(void)(0;                                  // 末尾的 ; 来自调用方，形成空语句
```

这里的 `(void)(0` 是点睛之笔。`some_function(args, THREAD)` 末尾没有分号，调用者的 `;` 刚好补上：`(void)(0);` 是一个无害的空表达式语句。`(void)` 强制类型转换抑制编译器的"未使用值"警告。

如果没有这个 `(void)(0`，展开后变成：

```cpp
some_function(args, THREAD);  // 调用者的 );
if (HAS_PENDING_EXCEPTION) return 0;  // 多出一个 ;
```

调用者的分号变成独立空语句，虽然语法合法，但多了一个不相关的语句节点。`(void)(0` 吃掉这个分号，让整条宏展开后始终是一个逻辑单元。

## THROW_MSG 宏

THROW_MSG 用于显式抛出异常并返回：

```cpp
#define THROW_MSG(name, message)                    \
  { Exceptions::_throw_msg(THREAD_AND_LOCATION, name, message); return; }
```

`THREAD_AND_LOCATION` 展开为 `THREAD, __FILE__, __LINE__`——当前线程指针和错误发生的源文件位置。再配合 `__func__`（函数名），异常信息可以精确定位到调用栈的每一层。

这里用了花括号 `{ ... }` 而不是 do-while(0)，因为 THROW_MSG 后面不接分号使用——它是被当作独立语句写在函数体内的。实际的 HotSpot 代码用法是：

```cpp
if (bad) THROW_MSG(vmSymbols::java_lang_InternalError(), "bad thing");
```

展开后 `{ ... }` 作为 if 的语句体，末尾的 `return;` 在花括号内，不需要外层分号来收尾。

## 条件编译

`#ifdef`、`#ifndef`、`#if`、`#else`、`#endif` 在 HotSpot 中控制哪些代码参与编译。最典型的模式是 debug 验证代码：

```cpp
#if INCLUDE_JVMTI
#define JVMTI_ONLY(x) x
#else
#define JVMTI_ONLY(x)
#endif
```

在未包含 JVMTI 的构建中，`JVMTI_ONLY(do_something())` 展开为空——整套功能在编译阶段就被裁剪掉，零运行时开销。同样的模式用于 GC 选择（G1GC_ONLY、SERIALGC_ONLY 等 8 种 GC）、编译器选择（COMPILER1_PRESENT、COMPILER2_PRESENT）、CPU/OS 平台选择（LP64_ONLY、AMD64_ONLY、LINUX_ONLY）。

debug 构建专用代码使用 `#ifdef ASSERT`：

```cpp
#ifdef ASSERT
void assert_locked_or_safepoint(const Monitor * lock);
#else
#define assert_locked_or_safepoint(lock)
#endif
```

debug 构建中这是一个真实的函数调用，检查锁状态和 safepoint 条件。release 构建中它变成空宏，完全消失在编译结果中。同样地还有 `DEBUG_ONLY` 宏：

```cpp
#ifdef ASSERT
#define DEBUG_ONLY(code) code
#else
#define DEBUG_ONLY(code)
#endif
```

## 预定义宏

编译器提供一组预定义宏，不需要 `#define` 就能使用。HotSpot 的错误报告系统依赖它们来精确记录故障位置：

- `__FILE__` ：当前源文件的完整路径字符串
- `__LINE__` ：当前行号的整数
- `__func__` ：当前函数名（C++11 标准，GCC 中与 `__FUNCTION__` 等价）
- `__DATE__`、`__TIME__` ：编译日期和时间
- `__cplusplus` ：C++ 标准版本号（如 201103L 表示 C++11）

guarantee 和 fatal 宏中用 `__FILE__` 和 `__LINE__` 标注错误位置，生成 hs_err 日志时必须知道哪个文件哪一行触发了断言。

## ATTRIBUTE_PRINTF —— 编译时格式检查

HotSpot 为每个接收 printf 风格格式串的函数标注编译器属性：

```cpp
#ifndef ATTRIBUTE_PRINTF
#define ATTRIBUTE_PRINTF(fmt, vargs) __attribute__((format(printf, fmt, vargs)))
#endif
```

使用方式：

```cpp
void log(Thread* thread, const char* format, ...) ATTRIBUTE_PRINTF(3, 4);
```

参数 `(3, 4)` 告诉 GCC：第 3 个参数是格式字符串，从第 4 个参数开始是可变参数。GCC 在编译时据此检查 `%d` 等格式说明符和后续参数类型是否匹配。如果代码写了 `log(t, "%d", "hello")`（"%d" 期望 int 但传了 char*），编译时立刻报错。

对于接收 `va_list` 的函数，可变参数序号填 0——因为 `va_list` 已经封装了参数包，编译器不向后追查。

## HotSpot 宏体系全景

JVM 的宏系统覆盖了编译的每一个环节。快速参考以下分类，遇到不认识的大写标识符按图索骥：

**断言/错误处理类**：guarantee（运行时条件检查，release 也生效）、assert（debug 专用条件检查）、fatal（无条件致命错误）、ShouldNotReachHere（逻辑不可达）、ShouldNotCallThis（禁止调用的函数）。

**条件编译类**：G1GC_ONLY / SERIALGC_ONLY 等 8 套 GC 开关、COMPILER1_PRESENT / COMPILER2_PRESENT 编译器开关、LP64_ONLY / AMD64_ONLY 等平台开关、JVMTI_ONLY 功能开关、DEBUG_ONLY 调试开关。每个开关家族包含 3-5 种变体（包含代码、包含参数、包含返回等）。

**代码生成类**：define_pd_global 平台变量生成、DEF_OOP oop 类型批量定义、CPU_HEADER 平台头文件包含。

**字符串/令牌操作类**：STR / XSTR 字符串化、PASTE_TOKENS 令牌拼接。

**结构控制类**：所有多语句宏的基础——do-while(0) 包装。

阅读 JVM 宏的思维步骤：先用 grep 定位宏定义，判断它属于哪一类，代入调用手动展开一次，最后理解设计意图——为什么这个条件必须为真？为什么这个功能需要编译开关？
