# C 与 C++ 互操作

HotSpot 本质上是一个 C/C++ 混合体。VM 核心是 C++，但系统调用层需要 C 的 ABI 稳定性；JNI（Java Native Interface）是 Java 与本地代码的桥梁，必须用 C 链接约定才能被 JVM 通过 `dlsym` 动态查找。理解 C 与 C++ 的互操作，是理解 JNI 实现和 HotSpot 系统调用层的基础。

## extern "C" 的本质

`extern "C"` 是一个**链接指示（linkage specification）**。它只做一件事：**告诉 C++ 编译器不要对这个名字做 Name Mangling，改用 C 的链接约定。**

```cpp
// jdk11u-copy/src/java.base/share/native/include/jni.h 第 47-49 行
#ifdef __cplusplus
extern "C" {
#endif

// ... 所有 JNI 类型和函数声明 ...
// JNIEXPORT void JNICALL Java_java_lang_System_registerNatives(JNIEnv*, jclass);

#ifdef __cplusplus
}
#endif
```

整个 `jni.h` 被 `extern "C"` 包裹。C 编译器看它时 `#ifdef __cplusplus` 跳过包裹，直接编译；C++ 编译器看它时 `extern "C"` 生效，所有 JNI 函数使用 C 链接。同一个头文件，两种编译器，同一套 ABI。

## Name Mangling 详解

**问题：** C 不支持函数重载，每个函数名在 `.o` 中就是它本身。C++ 支持重载、命名空间、成员函数——同一个名字可能有多个版本，所以编译器必须把名字"改编"为包含完整类型信息的唯一字符串。

**GCC/Clang（Itanium C++ ABI）规则：**

| 原始声明 | 改编后符号 | 编码含义 |
|---------|-----------|---------|
| `void foo()` | `_Z3foov` | `_Z`=C++前缀, `3`=名字长度, `foo`=名字, `v`=void |
| `void foo(int)` | `_Z3fooi` | `i`=int |
| `void foo(int, double)` | `_Z3fooid` | `i`=int, `d`=double |
| `void foo(char*, long)` | `_Z3fooPCl` | `Pc`=char\*, `l`=long |
| `void Foo::bar()` | `_ZN3Foo3barEv` | `N`=嵌套开始, `3Foo3bar`=Foo::bar, `E`=嵌套结束 |

**GCC vs MSVC 对比：**

| 特性 | GCC/Clang (Itanium ABI) | MSVC |
|------|------------------------|------|
| 前缀 | `_Z` | `?` |
| 名字长度 | 编码在函数名前 (`3foo`) | 不编码长度 |
| 参数类型 | 紧凑单字符编码 | 完整类型名 |
| 命名空间 | `N...E` 嵌套 | `@` 分隔 |
| `void foo(int)` 示例 | `_Z3fooi` | `?foo@@YAXH@Z` |

**核心结论：** 不同编译器的改编规则互不兼容。GCC 编译的 `.o` 文件中符号是 `_Z3fooi`，MSVC 的是 `?foo@@YAXH@Z`——链接器无法匹配。这就是为什么对外接口（如 JNI、动态库 API）**必须**用 `extern "C"` 暴露——C 的 ABI 是所有编译器的公分母。

## C++ 调 C：头文件保护标准写法

```c
// mylib.h —— 同时兼容 C 和 C++ 的标准头文件
#ifndef MYLIB_H
#define MYLIB_H

#ifdef __cplusplus
extern "C" {
#endif

int library_init(void);
int library_process(const char* data, int len);
void library_cleanup(void);

#ifdef __cplusplus
}
#endif

#endif
```

**`__cplusplus` 宏：** C++ 编译器定义此宏（值为标准版本号，如 `201103L` 表示 C++11），C 编译器不定义。利用这个差异可以让同一个头文件被两种编译器正确处理：

| 编译器 | `__cplusplus`? | 效果 |
|--------|---------------|------|
| GCC (`gcc`) | 未定义 | `extern "C" { ... }` 部分被跳过，头文件正常编译 |
| G++ (`g++`) | 已定义 (`201103L`) | `extern "C"` 生效，所有函数使用 C 链接约定 |

## C 调 C++：不透明指针模式

C 不能使用 C++ 的类、构造函数、异常。标准解法是用**不透明指针（Opaque Pointer）**封装：

```
C 接口头文件 (gui.h)                     C++ 实现 (gui.cpp)
┌──────────────────────┐                ┌──────────────────────┐
│ typedef struct Gui   │                │ class GuiWindow {    │
│   GuiWindow;  ← 不完整类型             │   void show();       │
│                      │                │   void setTitle();   │
│ GuiWindow* gui_      │                │ };                   │
│   window_create(...);│                └──────────────────────┘
│ void gui_window_     │                  C 指针实际指向 C++ 对象
│   destroy(GuiWindow*);                     reinterpret_cast
│ void gui_window_     │
│   show(GuiWindow*);  │
└──────────────────────┘
```

```cpp
// C 包装器实现（gui_wrapper.cpp）
extern "C" GuiWindow* gui_window_create(const char* title, int w, int h) {
    try {
        return reinterpret_cast<GuiWindow*>(new ::GuiWindow(title, w, h));
    } catch (...) {
        return NULL;  // C++ 异常不能穿过 C 边界，必须在此 catch
    }
}

extern "C" void gui_window_destroy(GuiWindow* win) {
    delete reinterpret_cast<::GuiWindow*>(win);
}

extern "C" int gui_window_show(GuiWindow* win) {
    try {
        reinterpret_cast<::GuiWindow*>(win)->show();
        return 0;
    } catch (...) {
        return -1;  // 用错误码替代异常
    }
}
```

**核心规则：C++ 异常不能穿过 `extern "C"` 边界。** C 没有异常处理机制，如果 C++ 异常逃逸到 C 代码中，结果是未定义行为（通常直接 crash）。所有包装函数必须在边界内用 try-catch 捕获所有异常，转换为错误码返回。

## extern "C" 的限制

`extern "C"` 不能用于：

| 不能用的场景 | 原因 |
|-------------|------|
| 成员函数 | 成员函数名包含类名，依赖 Name Mangling 区分 |
| 重载函数 | C 链接下所有同名函数变成同一个符号，冲突 |
| 模板函数 | 模板的实例化依赖 Name Mangling 生成不同的符号 |
| 头文件中仅声明、实现文件不写 | 声明和定义的链接不一致 → 链接错误 |

## C/C++ 函数指针的关键差异

```c
// C 语言：void foo() 表示"参数列表未指定"——可以传任意参数
void foo();              // 不是"无参数"！
foo(1, 2, 3);            // C 中编译通过（不做参数检查）

// C++ 语言：void foo() 等价于 void foo(void)——明确表示"无参数"
void foo();              // 无参数
foo(1, 2, 3);            // 编译错误！参数数量不匹配
```

这个差异在跨语言回调场景中极度危险——C 中编译通过的回调在 C++ 中可能编译失败，或者更糟：C++ 中按"无参数"定义的回调被 C 代码带参数调用，导致栈损坏。

**正确写法：** 用 `extern "C"` 声明的回调函数，明确写出 `void` 参数——C++ 侧的 `extern "C" void callback(void)` 在 C 侧也是 `void callback(void)`（C 也认 `void` 参数声明）。

## ABI 兼容性全景

C++ 的 ABI 极其脆弱。跨编译器/跨版本/跨平台的兼容性对比：

| ABI 维度 | 同一编译器同版本 | 同一编译器不同版本 | 不同编译器 |
|---------|:---:|:---:|:---:|
| C 函数符号 | ✓ | ✓ | ✓（C ABI 是公分母） |
| C++ 函数符号 | ✓ | ✘（Name Mangling 可能变） | ✘ |
| 对象布局（vtable 位置等） | ✓ | ✘（类布局可能变） | ✘ |
| 异常处理（unwind table） | ✓ | ✘ | ✘ |
| `std::string` 内存布局 | ✓ | ✘（Debug/Release 也不同） | ✘ |

**关键结论：对外暴露的 API 一律用 `extern "C"` + C 类型（指针、基础类型、POD struct）。** 不要在跨边界传递 `std::string`、`std::vector`、包含虚函数的对象——它们的二进制布局不是跨编译器的稳定合约。

## HotSpot 中的应用

### 1. os:: 系统调用包装

```cpp
// jdk11u-copy/src/hotspot/share/runtime/os.hpp
// HotSpot 的所有系统调用通过 os:: 命名空间间接访问

// os::javaTimeMillis() → ::gettimeofday()    (Linux, C ABI)
// os::javaTimeNanos()  → clock_gettime()     (Linux, C ABI)
// os::socket()         → ::socket()          (POSIX, C ABI)
```

所有操作系统 API 都是 C ABI。HotSpot 用 C++ 封装它们，但最终调用的是 `extern "C"` 的系统函数——这正是 C++ 调 C 的典型模式。

### 2. JNI 函数表——C ABI 版的虚函数表

JNI 通过函数表实现多态分发，本质上是虚函数表在 C ABI 层面的实现：

```c
// jdk11u-copy/src/java.base/share/native/libjava/System.c 第 38-42 行
static JNINativeMethod methods[] = {
    {"currentTimeMillis", "()J",              (void *)&JVM_CurrentTimeMillis},
    {"nanoTime",          "()J",              (void *)&JVM_NanoTime},
    {"arraycopy",     "(" OBJ "I" OBJ "II)V", (void *)&JVM_ArrayCopy},
};

JNIEXPORT void JNICALL
Java_java_lang_System_registerNatives(JNIEnv *env, jclass cls) {
    (*env)->RegisterNatives(env, cls,
                            methods, sizeof(methods)/sizeof(methods[0]));
}
```

`JVM_CurrentTimeMillis` 是 C 链接函数（编译后符号不改编）。JVM 通过 `RegisterNatives` 把这个函数指针注册到方法表中，Java 调用 `System.currentTimeMillis()` 时直接跳转到 C 函数入口。

### 3. JNI 类型双面性

JNI 巧妙地让同一个类型在 C 和 C++ 中有不同实现：

```cpp
// jdk11u-copy/src/java.base/share/native/include/jni.h 第 65-80 行
#ifdef __cplusplus
// C++ 编译：jobject 是 _jobject 类（有继承层次，类型安全）
class _jobject {};
class _jclass : public _jobject {};
class _jstring : public _jobject {};
typedef _jobject*  jobject;
typedef _jclass*   jclass;
typedef _jstring*  jstring;
#else
// C 编译：全部退化为 void*（无类型信息）
typedef void*      jobject;
typedef jobject    jclass;
typedef jobject    jstring;
#endif
```

C++ 代码享受类型安全（`jstring` 不能当 `jclass` 用），C 代码保持简单（全部是 `void*`）。同一个头文件，`#ifdef __cplusplus` 实现编译期分支——这是 C/C++ 互操作的标准范式。

### 4. 信号处理函数

```cpp
// 信号处理函数必须是 extern "C"——因为 OS 内核通过 C ABI 调用它
extern "C" void sig_handler(int sig, siginfo_t* info, void* uc) {
    // 处理信号...
}

// 注册时传入函数指针
struct sigaction sa;
sa.sa_sigaction = sig_handler;  // 必须是 C 链接
sigaction(SIGSEGV, &sa, NULL);
```

### 5. JNI 调用链全景——从 Java 到 OS 系统调用

以 `System.currentTimeMillis()` 为例，追踪 C/C++ 互操作的完整链路：

```
Java 层
  java.lang.System.currentTimeMillis()    ← native 方法声明
         │
         ▼  JNI 方法表: {"currentTimeMillis", "()J", &JVM_CurrentTimeMillis}
C 边界（libjava.so, extern "C"）
  JVM_CurrentTimeMillis(JNIEnv*, jclass)  ← C 链接，符号不改编
         │
         ▼
C++ 内部（libjvm.so, C++ 链接）
  os::javaTimeMillis()                    ← C++ 链接，符号改编
         │
         ▼
OS 系统调用（C ABI）
  ::gettimeofday() / clock_gettime()      ← POSIX C API
```

**每层的互操作角色：**
- **C 边界层**：`JVM_CurrentTimeMillis` 是 `extern "C"`——JVM 通过 `dlsym("JVM_CurrentTimeMillis")` 查找，必须不改编。
- **C++ 内部层**：`os::javaTimeMillis()` 是普通的 C++ 链接——只在 libjvm.so 内部调用，不需要跨 ABI 暴露。
- **OS 调用层**：`gettimeofday` 是 POSIX C API——操作系统通过 C ABI 暴露，一直是稳定的跨语言桥接标准。

## C/C++ struct 的 ABI 布局差异

在互操作边界传递 struct 时，C 和 C++ 的布局可能微妙地不同：

| 特性 | C struct | C++ struct |
|------|---------|-----------|
| 成员函数 | 不允许 | 允许（与 class 的区别仅默认访问权限） |
| 构造函数/析构函数 | 不允许 | 允许 |
| 访问控制 | 全部 public | public/private/protected |
| 继承 | 不允许 | 允许（默认 public 继承） |
| 空基类优化（EBO） | 不适用 | 空基类可能不占空间 |
| `sizeof(empty_struct)` | 通常 0（GCC 扩展）或编译错误 | 至少 1（保证唯一地址） |

**实战建议：** 在 C/C++ 边界传递的结构体，定义为**纯 C struct**（无成员函数、无构造/析构、POD 类型），放在 `extern "C"` 保护的头文件中。这样 C 和 C++ 编译器产生相同的二进制布局。

## GDB 验证：nm 和 c++filt

```cpp
// test_linkage.cpp
void foo_cpp(int x) {}           // C++ 链接
extern "C" void foo_c(int x) {}  // C 链接

int main() { foo_cpp(1); foo_c(1); return 0; }
```

```bash
g++ -std=c++11 -c test_linkage.cpp -o test_linkage.o
nm test_linkage.o

# 输出：
# 0000000000000000 T foo_c         ← extern "C"，不改编，符号名 = "foo_c"
# 000000000000000b T _Z7foo_cppi   ← C++ 链接，已改编

nm test_linkage.o | c++filt
# 0000000000000000 T foo_c
# 000000000000000b T foo_cpp(int)  ← c++filt 反改编还原可读名
```

**关键发现：** 同一个编译单元中，`foo_c` 和 `foo_cpp` 分别以 C 和 C++ 链接约定共存——符号表中前者是 `foo_c`，后者是 `_Z7foo_cppi`。`extern "C"` 的作用范围仅限于它声明的函数，不影响同文件中的其他函数。

如果要验证 HotSpot 中的效果，可以在 `libjava.so` 中查看 JNI 函数的符号：

```bash
nm -D libjava.so | grep Java_java_lang_System
# 输出类似：
# 0000000000012340 T Java_java_lang_System_registerNatives
# 符号就是函数名本身——extern "C" 保证 JVM 能用 dlsym 找到它
```

> *详细讲解参见 C++ 教程: [C 与 C++ 互操作全解](../../my-openjdk/cpp/stage3-标准库与工程/C++高级-16-C与C++互操作全解.md)*

## 关键自查清单

- [ ] 能解释 Name Mangling 的原因（C++ 支持重载/命名空间/成员函数）和 GCC/Itanium ABI 编码规则
- [ ] 知道 GCC (`_Z3foov`) 和 MSVC (`?foo@@YAXXZ`) 的改编差异及跨编译器不兼容的根本原因
- [ ] 能写出同时兼容 C 和 C++ 的头文件（`#ifdef __cplusplus extern "C"` 标准保护模式）
- [ ] 理解 extern "C" 只影响符号名生成，不影响其他语义（类型检查、函数体编译方式）
- [ ] 能解释为什么 extern "C" 函数不能重载（符号冲突）、不能用于成员函数和模板
- [ ] 能画出 C 调 C++ 的不透明指针模式（前向声明 struct + `reinterpret_cast` + create/destroy 包装）
- [ ] 知道 C++ 异常不能穿过 extern "C" 边界——必须在边界内 catch 并转换为错误码
- [ ] 知道 C 中 `void foo()` 是"任意参数"，C++ 中是"无参数"——跨语言回调的关键陷阱
- [ ] 理解为什么对外 API 必须用 extern "C" + C 类型（C ABI 是所有编译器的公分母）
- [ ] 能指出 JNI 中的 extern "C" 应用：`jni.h` 整体包裹、JNI 函数表注册、`jobject` 双面类型
- [ ] 能用 `nm` 查看目标文件的符号表，用 `c++filt` 反改编——区分 C 链接 vs C++ 链接
