# 异常处理与 noexcept

C++ 异常机制将正常流程与错误处理解耦——`throw` 之后程序自动沿调用栈向上查找 `catch`，沿途销毁所有已构造的局部对象。但 HotSpot 编译时使用 `-fno-exceptions`，完全不依赖 C++ 异常。本章需要理解：C++ 异常是怎么工作的，以及 HotSpot 用什么替代了它。

## 核心论点：HotSpot 不用 C++ 异常

HotSpot 的 make/compile 配置中显式设置了 `-fno-exceptions`。这不是粗心的遗漏，而是深思熟虑的工程决策。四个原因：

| 原因 | 说明 |
|------|------|
| **性能** | 异常的正常路径零开销，但抛出路径代价极高（栈展开+EH表查找），JVM 不能容忍不可预测的延迟 |
| **代码可控性** | 异常是"不可见的控制流"——分析代码时看不出哪里会跳转，不利于 C2 编译器、GC 等高性能组件 |
| **ABI 兼容性** | 异常在不同编译器/平台间的实现差异大，JVM 要跨平台，用异常有风险 |
| **替代品足够** | `guarantee`/`vmassert`/`fatal`/`ShouldNotReachHere` 提供了更强的错误检测和报告能力 |

## HotSpot 的替代方案：fail-fast 宏体系

HotSpot 用一套宏实现"尽早崩溃，充分报告"的 fail-fast 策略。源码位于 `jdk11u-copy/src/hotspot/share/utilities/debug.hpp`：

```cpp
// 1. guarantee：release 中也会执行的断言（替代异常抛出）
#define guarantee(p, ...)                                           \
do {                                                                \
  if (!(p)) {                                                       \
    report_vm_error(__FILE__, __LINE__, "guarantee(" #p ") failed", \
                    __VA_ARGS__);                                   \
    BREAKPOINT;                                                     \
  }                                                                 \
} while (0)

// 2. vmassert：只在 debug 构建生效（release ⇒ 零开销空宏）
#ifdef ASSERT
#define vmassert(p, ...) \
  do { if (!(p)) { report_vm_error(...); BREAKPOINT; } } while (0)
#else
#define vmassert(p, ...)
#endif

// 3. fatal：无条件报告致命错误并终止
#define fatal(...)                              \
do {                                            \
  report_fatal(INTERNAL_ERROR, __FILE__,        \
               __LINE__, __VA_ARGS__);          \
  BREAKPOINT;                                   \
} while (0)

// 4. ShouldNotReachHere：标记逻辑上不可能到达的代码
#define ShouldNotReachHere()                    \
do {                                            \
  report_should_not_reach_here(__FILE__,        \
                               __LINE__);       \
  BREAKPOINT;                                   \
} while (0)
```

**对比：C++ 异常 vs JVM 错误处理**

| 场景 | C++ 异常 | HotSpot 等价 |
|------|---------|-------------|
| 内部不变量被破坏 | `throw InvariantError()` | `guarantee(false, "invariant broken")` |
| 调试断言 | `#include <cassert>` | `vmassert(cond, "msg")` (release 零开销) |
| 不可恢复错误 | 不适用 | `fatal("Out of metaspace memory")` |
| 逻辑死路 | `default: throw;` | `ShouldNotReachHere()` |
| 调用者处理 | `try/catch` 栈展开 | 不支持——程序崩溃，生成 hs_err 文件 |

**HotSpot 实例**。`constantPool.hpp` 中检查常量池完整性：

```cpp
// jdk11u-copy/src/hotspot/share/oops/constantPool.inline.hpp
void constantPool::klass_at_put(int which, Klass* k) {
  guarantee(tag_at(which).is_klass(), "Corrupted constant pool");
  // ...
}

// jdk11u-copy/src/hotspot/share/oops/instanceKlass.hpp
void set_local_interfaces(Array<Klass*>* a) {
  guarantee(_local_interfaces == NULL || a == NULL, "Just checking");
}
```

所有宏最终都走 `report_vm_error` → 生成 `hs_err_pid<pid>.log` 文件 → `BREAKPOINT`。没有 `catch`，没有恢复——fail-fast，把完整上下文写进文件，然后崩溃。

## C++ 异常机制：栈展开（Stack Unwinding）

尽管 HotSpot 不用异常，但理解其机制是读懂 C++ 代码的必备功。当 `throw` 执行时，运行时系统不会像 C 的 `longjmp` 那样直接跳——它会**逐个析构栈上的局部对象**：

```cpp
struct Tracer {
  std::string _name;
  Tracer(const std::string& n) : _name(n) {
    std::cout << "Ctor: " << _name << std::endl;
  }
  ~Tracer() { std::cout << "Dtor: " << _name << std::endl; }
};

void layer3() {
  Tracer t("layer3");
  throw std::runtime_error("boom");  // 从这里抛出
}

void layer2() {
  Tracer t("layer2");
  layer3();                           // layer3 抛异常后，下面代码不执行
}

void layer1() {
  Tracer t("layer1");
  layer2();
}

int main() {
  try { layer1(); }
  catch (const std::exception& e) {
    std::cout << "Caught: " << e.what() << std::endl;
  }
}
```

**输出：**

```
Ctor: layer1
Ctor: layer2
Ctor: layer3
Dtor: layer3      ← 栈展开：先析构 layer3 的 t
Dtor: layer2      ← 再析构 layer2 的 t
Dtor: layer1      ← 最后析构 layer1 的 t
Caught: boom
```

**关键观察**：析构按构造的逆序执行（LIFO）。layer3 → layer2 → layer1 各层在 `throw` 之后的代码**永不执行**——这正是栈展开的本质：沿着调用栈向上回溯，调用每个栈帧中已构造对象的析构函数，直到匹配到 `catch` 或程序终止。

### 栈展开中的析构——RAII 的基石

栈展开是 RAII 在异常路径上的核心保证：**即使因异常非正常退出作用域，局部对象的析构仍然被调用**。对比没有 RAII 的手动管理：

```cpp
// 无 RAII：异常路径上所有 delete 都不会执行 → 泄漏
void dangerous() {
  Resource* r1 = new Resource();       // ①
  Resource* r2 = new Resource();       // ② 如果这里抛异常，r1 泄漏
  risky_operation();                   // ③ 抛异常
  delete r2;                           // 永不执行
  delete r1;                           // 永不执行
}

// RAII 自动清理：异常 → 栈展开 → unique_ptr 析构 → delete
void safe() {
  std::unique_ptr<Resource> r1(new Resource());
  std::unique_ptr<Resource> r2(new Resource());
  risky_operation();  // 抛异常 → 栈展开 → r2 析构 → r1 析构 → 全部释放
}
```

编译器通过 **EH 表**（Exception Handling Tables，DWARF 格式的 `.eh_frame` 段）记录每个函数中有哪些需要析构的对象及其位置。当栈展开发生时，运行时依据这些元数据找到该析构哪些对象。

```bash
$ readelf -S ./stack_unwind | grep eh_frame
  [14] .eh_frame_hdr    PROGBITS   00000000000009e0  000009e0
  [15] .eh_frame        PROGBITS   0000000000000a20  00000a20
```

### setjmp/longjmp vs C++ 异常

C 语言用 `setjmp/longjmp` 实现非本地跳转，但它们不调用析构函数——这是本质区别：

```c
/* C: longjmp 直接跳——跳过所有析构 */
#include <setjmp.h>
jmp_buf env;
void f() {
  char* buf = malloc(4096);  // 如果 longjmp 跳走，buf 泄漏！
  if (setjmp(env) == 0) g();
  else /* 错误路径 */;
  free(buf);
}
void g() { longjmp(env, 1); }  // 直接跳回 setjmp，跳过 free
```

C++ 异常替代了这个机制：栈展开代替 `longjmp` 的粗暴跳转，析构函数替代 `free` 的手动释放。

## 异常安全三级别

David Abrahams 在 1998 年提出的经典分类，后纳入 C++ 标准：

### 基本保证（Basic Guarantee）

异常不泄漏资源，所有对象保持可析构状态，但状态可能已改变：

```cpp
// push_back 失败：vector 仍可用，但元素没有被添加
std::vector<int> v;
try { v.push_back(42); }  // 可能抛 bad_alloc
catch (...) { /* v 仍然是有效的空 vector */ }
```

### 强保证（Strong Guarantee / Commit-or-Rollback）

异常抛出后，程序状态**完全恢复**到调用前——像数据库事务：

```cpp
template<typename T>
class SafeContainer {
  std::vector<T> _data;
 public:
  void add(const T& val) {
    std::vector<T> copy = _data;   // ① 复制副本
    copy.push_back(val);           // ② 在副本上操作（可能失败）
    _data.swap(copy);              // ③ 成功则原子交换（noexcept）
    // 如果 ② 失败：_data 完全不变（强保证）
    // copy 析构释放临时数据
  }
};
```

### 不抛保证（Nothrow Guarantee / No-fail）

函数**绝对不会抛出异常**。典型场景：析构函数、`swap`、`operator delete`。

## noexcept 与 move_if_noexcept

C++11 引入 `noexcept`，替代了 C++98 已废弃的 `throw()` 异常规格。它同时是**修饰符**（声明函数不抛异常）和**运算符**（编译期检测表达式是否 noexcept）：

```cpp
void safe() noexcept;              // 修饰符：承诺不抛异常
void risky() noexcept(false);      // 显式表示可能抛（默认行为）
static_assert(noexcept(safe()), "");  // 运算符：true
static_assert(!noexcept(risky()), ""); // 运算符：false

// 移动构造必须标记 noexcept——否则容器宁可用拷贝
class MyClass {
 public:
  MyClass(MyClass&& other) noexcept  // 标记 noexcept！
    : data_(other.data_) { other.data_ = nullptr; }
};
```

**为什么 `noexcept` 对移动至关重要？** 这是面试绝对重点：

```
场景：vector 有 1000 个元素，push_back 触发 resize
  resize 需要：分配新内存 → 迁移 1000 个元素 → 释放旧内存

如果用移动迁移元素：移动第 500 个时抛异常！
  → 前 499 个已被移到新内存，旧内存元素处于"移后"状态
  → 无法回滚到原始状态（强保证被破坏）

std::move_if_noexcept 的选择：
  元素移动是 noexcept → 使用移动（O(1) 每元素）
  元素移动可能抛异常  → 退回到拷贝（O(n) 但安全）
```

**汇编差异**：GCC 为 `noexcept` 函数生成更简洁的栈帧——省略了异常处理元数据（`.eh_frame` 中无该函数的 entry）。通过比较 `readelf -w` 的输出可以清晰看到差异。

## 析构不能抛异常——双重异常是 terminate

C++11 规定析构函数**默认 `noexcept`**。如果在栈展开期间析构又抛出异常，两个异常同时"在传播"——C++ 无法处理，直接调用 `std::terminate()`：

```cpp
class Dangerous {
 public:
  ~Dangerous() {             // 默认 noexcept
    throw "never do this";   // → std::terminate()
  }
};

void double_trouble() {
  Dangerous d;                          // d 的析构会抛异常
  throw std::runtime_error("primary");  // 正在栈展开
  // → 双重异常 → terminate
}
```

## catch 的排序与切片陷阱

`catch` 按声明顺序匹配，派生类必须放在基类前面：

```cpp
try { throw std::runtime_error("oops"); }
catch (const std::exception& e) { ... }  // 匹配！——太宽泛了
catch (const std::runtime_error& e) { ... } // 永远不会执行
```

按值捕获导致**对象切片**（slicing）——`catch(exception e)` 永远只创建 `exception` 对象，派生类信息丢失。**始终按引用捕获**：`catch(const exception& e)`。

## 小结 checklist

- [ ] 能说出 HotSpot 不用异常的 4 个原因
- [ ] 能区别 `guarantee`、`vmassert`、`fatal`、`ShouldNotReachHere` 的适用场景
- [ ] 能画图解释栈展开的全过程（throw → 逆序析构 → catch）
- [ ] 理解 RAII 为什么是异常安全的基础
- [ ] 能说出异常安全三个级别及其标准库例子
- [ ] 理解 `noexcept` 修饰符与运算符的区别
- [ ] 能解释 `std::move_if_noexcept` 的选择逻辑
- [ ] 知道析构函数为什么不能抛异常（双重异常 → terminate）
- [ ] 能对比 `setjmp/longjmp` 与 C++ 异常的本质区别

> *详细讲解参见 C++ 教程: [异常处理与异常安全](../my-openjdk/cpp/stage3-标准库与工程/C++高级-17-C++异常处理与异常安全.md)*
