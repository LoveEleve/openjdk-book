# 前置概念：什么是 Stub？JVM 中为什么需要手写汇编桩？

> **本文定位**：背景知识文章。本文从最基础的问题出发——JVM 为什么有"手写汇编桩"这种东西——建立第一个最小知识点：stub 的本质。你要理解的是 JVM 运行时有一段"不来自 C++ 源码编译、也不来自 JIT 即时编译"的机器码，它解决 C++ 调用约定和 Java 编译代码调用约定之间的不兼容。
>
> 本文是一本电子书的章节——不限制长度。每一行源码都被拆开、每一步数据结构的变化都被展示。
>
> **阅读提示**：本文是最小知识点链的起点。后续文章每一篇都会明确引用前面的概念。读完本文后，你只需要知道"stub 是什么"和"address 是什么"——不需要理解它是怎么生成的、存在哪里。那些是后续文章的主题。

---

## 1. 场景：解释器想调用一段编译好的 Java 方法

### 1.1 HotSpot 中所有 C++ → Java 的调用都走同一个入口

在 HotSpot 源码中，只要 C++ 代码需要调用 Java 方法，最终都会走到 `JavaCalls::call_helper()`（`javaCalls.cpp:346`）：

```cpp
void JavaCalls::call_helper(JavaValue* result, const methodHandle& method, ...) {
  address entry_point = method->from_interpreted_entry();  // 简化：实际获取逻辑更复杂，最终效果是跳到可执行入口
  // ... 准备好参数 ...
  StubRoutines::call_stub()(          // ← 调用 call_stub 跳进 Java 帧
    &link,                            // 参数1: JavaCallWrapper*
    result_val_address,               // 参数2: result 的地址
    result_type,                      // 参数3: 返回值类型
    method(),                         // 参数4: Method*
    entry_point,                      // 参数5: 编译代码入口地址
    parameter_address,                // 参数6: 参数数组指针
    args->size_of_parameters(),       // 参数7: 参数个数
    thread                            // 参数8: Thread*
  );
}
```

这行代码的注解（`javaCalls.hpp:225-226`）说得很清楚：**"All calls to Java have to go via JavaCalls."**

举个例子——JVM 启动过程中，`Threads::create_vm()`（`thread.cpp:3702`）里有一条关键调用链：

```
Threads::create_vm()                          // thread.cpp:3702
  ├── init_globals()                          // thread.cpp:3846
  │     └── stubRoutines_init1()              // init.cpp:110  ← 这里创建 call_stub
  │            └── 创建 call_stub 机器码，入口存入 _call_stub_entry
  │
  └── initialize_java_lang_classes()          // thread.cpp:3914
        └── call_initPhase1()                 // thread.cpp:3674
              └── JavaCalls::call_static()    // 调用 System.initPhase1()
                    └── JavaCalls::call_helper()
                          └── StubRoutines::call_stub()(args...)
                                └── 跳进 call_stub 的 x86 机器码
```

注意顺序：**`stubRoutines_init1()` 在 `call_initPhase1()` 之前执行**——System 类被初始化之前，call_stub 必须已经生成。如果此时 `_call_stub_entry` 还是 NULL，`call_helper` 会 `call` 到一个 NULL 地址，CPU 崩溃。整个 JVM 启动流程里，call_stub 的初始化必须排在所有 Java 方法调用之前——这就是为什么 `stubRoutines_init1()` 在 `init_globals()` 里排在如此靠前的位置（第 110 行，排在 CodeCache 初始化之后、universe 和解释器初始化之前）。

```cpp
void JavaCalls::call_helper(JavaValue* result, const methodHandle& method, ...) {
  address entry_point = method->from_interpreted_entry();
  // ... 准备好参数 ...
  StubRoutines::call_stub()(          // ← 这里要"调用"一个东西
    &link,                            // 参数1: JavaCallWrapper*
    result_val_address,               // 参数2: result 地址
    result_type,                      // 参数3: BasicType
    method(),                         // 参数4: Method*
    entry_point,                      // 参数5: 编译代码入口
    parameter_address,                // 参数6: 参数数组
    args->size_of_parameters(),       // 参数7: 参数个数
    thread                            // 参数8: Thread*
  );
}
```

`call_helper` 是一个普通的 C++ 函数。它做的事情是：**找到入口地址，跳过去**。"入口地址"可能是解释器的入口，也可能是 JIT 编译后的机器码入口——`call_helper` 不关心是哪个。

### 1.2 问题：直接 `call entry_point` 会崩溃

假设解释器对 `String.hashCode()` 的调用发现：这个方法已经被 C2 编译器编译成 x86 机器码了，入口在 `0x7fdc00400000`。

`call_helper` 能不能直接 `call 0x7fdc00400000`？**不能。** 因为寄存器对不上。

看看 `call_helper` 在 `call` 指令执行前的寄存器状态：

```
call_helper 准备调用时:

  rdi = 0x7fdc01000000  ← JavaCallWrapper* 的地址
  rsi = 0x7fff12340000  ← result 的地址
  rdx = 12              ← T_OBJECT 的枚举值
  rcx = 0x7fdc03000000  ← Method* 指针
  r8  = 0x7fdc00400000  ← 编译代码入口地址
  r9  = 0x7fff12350000  ← 参数数组的地址

  栈上: [rbp+16] = 参数个数 = 0（无参方法）
       [rbp+24] = Thread* 指针
```

这些全是**C 调用约定**的值——`call_helper` 是 C++ 编译出来的，它按 C ABI 把参数放到 `rdi/rsi/rdx/rcx/r8/r9` 里。

但编译后的 `String.hashCode()` **不认这套寄存器含义**。C2 编译器生成的 x86 代码从这几个寄存器里读"它以为的"值：

```
编译后的 String.hashCode() 执行时期望:

  rbx = Method* (hashCode 自己的 Method 对象)
        ← 现在 rbx 存的是 call_helper 的某个局部变量，不是 Method*。
          编译代码读 rbx → 读到 0xdeadbeef → 当作 Method* 解引用 → 段错误

  r13 = sender_sp (调用者的栈指针，GC 扫描栈时需要)
        ← 现在是垃圾值。GC 扫描到这个帧时，r13 指向某个随机位置，
          GC 把随机地址当成 oop 扫描 → 读到不可读内存 → 段错误

  r15 = JavaThread* (当前线程指针)
        ← 可能是垃圾值。编译代码里的 safepoint 检查会写 r15
          → 写到随机地址 → 内存损坏
```

**直接 `call 0x7fdc00400000`，CPU 会跳过去执行——但编译代码读到的 `rbx`、`r13`、`r15` 全是垃圾值，第一条用到这些寄存器的指令就会崩溃。**

### 1.3 答案：需要一个"翻译器"

在 `call_helper`（C 帧）和编译代码（Java 帧）之间，需要一段代码做翻译：

1. 把 C ABI 传过来的参数（现在在 rdi/rsi/rdx/rcx/r8/r9 和栈上）搬到 Java 帧约定的位置
2. 把 `rbx` 的正确值（`Method*`）写进去
3. 把 `r13` 的正确值（sender SP）写进去
4. 确保 `r15` 指向正确的 `JavaThread*`
5. 然后才 `call` 到编译代码入口

做完这些之后：
```
编译后的 String.hashCode() 执行时:

  rbx = 0x7fdc03000000  ← Method* (call_helper 传的 method())
  r13 = 0x7fff1233FF00  ← sender_sp (call_stub 设置的)
  r15 = 0x7fdc05000000  ← JavaThread* (call_helper 传的 thread)
  r8  = 0x7fdc00400000  ← 编译代码入口
```

这段翻译代码就是 **call_stub**——第一篇文章的主角。

---

## 2. stub 是什么？三个属性

### 2.1 stub 是一段机器码，存在内存里

call_stub 的本质：一段 x86 机器码。像这样：

```
0x7fdc00100000:  55            push rbp
0x7fdc00100001:  48 89 E5      mov  rbp, rsp
0x7fdc00100004:  48 83 EC 60   sub  rsp, 96
0x7fdc00100008:  4C 89 4D F8   mov  [rbp-8], r9
...（约 200 条指令）
0x7fdc00100120:  FF D1         call rcx
0x7fdc00100122:  48 8D 65 A0   lea  rsp, [rbp-96]
...
0x7fdc00100150:  5D            pop  rbp
0x7fdc00100151:  C3            ret
```

这点很重要：**它不是 C++ 函数，它是字节**。C++ 编译器没编译过它（它是在 JVM 启动时动态生成的）。JIT 编译器也没编译过它（它不是 Java 字节码翻译出来的）。它是 HotSpot 开发者**用汇编器逐条写出来**的，在 JVM 启动时一次性生成，之后永不改变。

### 2.2 stub 的入口存为一个地址

因为 stub 是存在内存里的机器码，调用它的方式就是**跳转到它的第一条指令**。

这个入口地址在 HotSpot 中的类型是 `address`：

```cpp
// globalDefinitions.hpp:141
typedef unsigned char* address;
```

`address` = `unsigned char*`——就是一个指向内存的指针。不是 `void*`（因为 `unsigned char*` 可以按字节做指针算术，写机器码时需要）。不是 `int`（不能把地址当整数存——64 位系统上 int 装不下 8 字节地址）。

从源码中 `stubRoutines.cpp:47-71` 可以看到，这些字段在 C++ 层面被显式初始化为 NULL：

```cpp
address StubRoutines::_call_stub_entry                          = NULL;  // line 51
address StubRoutines::_call_stub_return_address                 = NULL;  // line 50
address StubRoutines::_forward_exception_entry                  = NULL;  // line 54
address StubRoutines::_atomic_xchg_entry                        = NULL;  // line 62
// ... 二十多个字段全是 NULL
```

> **注意**：不是所有 StubRoutines 字段初始都是 NULL。例如 arraycopy 相关的字段（`_jbyte_arraycopy`、`_jint_arraycopy` 等，`stubRoutines.cpp:84-101`）初始就指向纯 C++ 实现的慢速拷贝函数——这是兜底方案。等 `initialize2()` 生成了 SSE/AVX 加速版本后，这些字段会被覆盖成快的。但本文关注的 call_stub、forward_exception、atomic 桩——它们的入口点**初始全是 NULL**，必须在 `initialize1()` 里填充。

### 2.3 stub 存在 code cache 中

"存在内存里"具体是哪块内存？是 code cache。

你现在不需要知道 code cache 是什么（第 3 篇文章会详细讲），只需要知道：**code cache 是一块带执行权限的内存（PROT_EXEC），JVM 专门用它存放"不是 .so 里的、运行时生成的"可执行代码。** JIT 编译的 Java 方法存在这里，stub 也存在这里。

```
JVM 进程的内存布局:

  高地址
  ...
  [code cache]          ← stub 和 JIT 编译代码都在这里（~240MB）
      0x7fdc00100000: call_stub 的机器码
      0x7fdc00100200: forward_exception 的机器码
      0x7fdc00400000: String.hashCode() JIT 编译后的机器码
  ...
  [libjvm.so]           ← HotSpot C++ 代码（call_helper 等）
  [Java heap]           ← Java 对象
  低地址
```

---

## 3. C++ 怎么跳到 stub 上执行？—— 函数指针

### 3.1 不能写 `goto`，你只能"把地址当函数来调"

`_call_stub_entry` 存的值是 `0x7fdc00100000`——call_stub 第一条指令的地址。

C++ 不能写 `goto _call_stub_entry`（非法的）。也不能写 `_call_stub_entry()`（编译器说：`unsigned char*` 不是函数）。

你需要告诉编译器：**这个地址上有一段代码，它接受哪些参数、返回什么——把它当成函数来调。**

C 语言的机制是**函数指针**：

```cpp
// 第一步：定义一个类型，描述"这段代码长什么样"
typedef void (*CallStub)(
  address   link,              // 参数1
  intptr_t* result,            // 参数2
  BasicType result_type,       // 参数3
  Method* method,              // 参数4
  address   entry_point,       // 参数5
  intptr_t* parameters,        // 参数6
  int       size_of_parameters,// 参数7
  TRAPS                        // 参数8
);
// CallStub 的含义：指向一个"接受 8 个参数、返回 void 的函数"的指针

// 第二步：把 _call_stub_entry 强转成函数指针
CallStub func_ptr = (CallStub)(_call_stub_entry);
// _call_stub_entry 是 unsigned char*，值是 0x7fdc00100000
// func_ptr       是 CallStub，          值是 0x7fdc00100000
// 值没变——类型变了。编译器现在知道"这个地址上的代码接受 8 个参数"

// 第三步：像调用普通函数一样调用它
func_ptr(&link, result_val_address, result_type, method(),
         entry_point, parameter_address, args->size_of_parameters(), thread);
```

**CPU 做了什么**：把 8 个参数按 C 调用约定装入寄存器和栈，然后 `call 0x7fdc00100000`，跳到 call_stub 的机器码执行。

**这就是 `StubRoutines::call_stub()` 做的事**——一个包装器，把地址强转成函数指针：

```cpp
static CallStub call_stub() {
  return CAST_TO_FN_PTR(CallStub, _call_stub_entry);  // = (CallStub)(_call_stub_entry)
}
```

`call_helper` 看到的只是一个普通的 C++ 函数调用——它不知道、也不需要知道 `call_stub` 是汇编写的还是 C++ 编译的。函数指针的魔力：**调用方只需要知道"参数类型"和"返回类型"，被调方是汇编还是 C++ —— 不重要。**

---

## 4. stub 在栈上做了什么？—— 帧

### 4.1 参数怎么传给 stub？—— C 调用约定

上一节说"CPU 把 8 个参数按 C 调用约定装入寄存器和栈"。具体来说：

```
x86_64 Linux C 调用约定 (System V AMD64 ABI):

  前 6 个整数参数 → 寄存器:
    c_rarg0 = rdi
    c_rarg1 = rsi
    c_rarg2 = rdx
    c_rarg3 = rcx
    c_rarg4 = r8
    c_rarg5 = r9

  第 7+ 参数 → 栈上:
    [rbp+16] = 参数7
    [rbp+24] = 参数8
```

为什么前 6 个在寄存器里？因为寄存器比内存快——CPU 访问寄存器是 1 个周期，访问栈内存可能是几十个周期。把常用的前几个参数放寄存器里是性能优化。

为什么是 6 个不是 4 个不是 8 个？这是 x86_64 ABI 的历史设计——`rdi/rsi/rdx/rcx/r8/r9` 这 6 个寄存器刚好够用而不太浪费。

**在 `call_helper` → call_stub 这条调用链上，参数怎么流动的**：

```
call_helper (C++ 源代码):
  StubRoutines::call_stub()(
    &link,                          → 编译器自动放入 rdi
    result_val_address,             → 编译器自动放入 rsi
    result_type,                    → 编译器自动放入 rdx
    method(),                       → 编译器自动放入 rcx
    entry_point,                    → 编译器自动放入 r8
    parameter_address,              → 编译器自动放入 r9
    args->size_of_parameters(),     → 编译器自动 push 到栈 [rbp+16]
    thread                          → 编译器自动 push 到栈 [rbp+24]
  );
  ↓ 编译器生成:
    mov rdi, [&link]
    mov rsi, [result_val_address]
    mov rdx, [result_type]
    mov rcx, [method()]
    mov r8,  [entry_point]
    mov r9,  [parameter_address]
    push [size_of_parameters]
    push [thread]
    call _call_stub_entry           ← 跳进 call_stub 的 x86 机器码

call_stub 被调用时，寄存器状态同上（call_helper 准备调用时的那张寄存器表，本节 1.2 开头）。
```

### 4.2 栈和帧 —— rbp 和 rsp 是什么

x86 CPU 用两个寄存器来管理栈：

| 寄存器 | 做什么 | 类比 |
|--------|--------|------|
| `rsp` | 永远指向栈顶——函数当前用到的栈的最低位置 | 书签，夹在你读到的那一页 |
| `rbp` | 指向当前函数的帧基址——进入函数时记下的 `rsp` 值，之后整个函数用它定位局部变量和参数 | 章节标记，不管翻了多少页，你知道"这一章从这里开始" |

栈从高地址往低地址生长。`rsp` 减小 = 往下分配空间。`rsp` 增大 = 往上释放空间。

一个 x86 函数在开始和结束时，总是在做同一组操作。以 call_stub 为例：

**进入时（建帧）—— 三条指令：**

```asm
push rbp          ; ① 把调用者的 rbp 暂存到栈上
mov  rbp, rsp     ; ② 把 rsp 当前值记作"本函数的帧基址"
sub  rsp, 96      ; ③ 往下分配 96 字节，作为本函数的局部变量区
```

**指令执行前：**

```
高地址
  [调用者的帧]             ← 调用者的 rbp
  [返回地址  ]             ← call 指令 push 的
           ↑ rsp ← 栈顶
低地址
```

**① push rbp 之后：**

```
高地址
  [调用者的帧]
  [返回地址  ]
  [saved rbp ]   ← 调用者的 rbp 被暂存在这里
        ↑ rsp
低地址
```

**② mov rbp, rsp 之后：**

```
高地址
  [调用者的帧]
  [返回地址  ]
  [saved rbp]  ← rbp（现在 rbp 指向 saved rbp，这就是"帧基址"）
        ↑ rsp
低地址
```

**③ sub rsp, 96 之后：**

```
高地址
  [调用者的帧]
  [返回地址  ]
  [saved rbp]  ← rbp（帧基址——不变了）
        ┐
        │ ← 这 96 字节是 call_stub 的"草稿纸"：
        │   [rbp-8]  存一个值
        │   [rbp-16] 存另一个值
        │   ...
        │   [rbp-96] 存浮点控制寄存器
        ┘
        ↑ rsp（栈顶——之后 push/sub 会往下继续长）
低地址
```

**退出时（拆帧）—— 做相反的事：**

```asm
mov  rsp, rbp     ; 释放局部变量区（rsp 拉回 rbp 位置）
pop  rbp          ; 恢复调用者的 rbp
ret               ; 弹出返回地址，跳回去
```

至此调用者拿回它原来的 rbp，栈恢复到进入函数前的样子——调用者完全不知道这个函数在栈上做了什么。

> **关键**：建帧不是为了 GC——它就是一个函数在 x86 上分配局部变量的标准操作。call_stub 建帧，call_helper 也建帧，所有 C 函数都建帧。call_stub 的帧之所以叫 entry_frame，只是因为它在 C 帧和 Java 帧之间的特殊位置——名字是给 GC 看的，操作和任何函数一样。

### 4.3 stub 收到参数后，往栈上建一个中间帧

call_stub 被调用时，栈的顶端是 `call_helper` 的 C 帧。call_stub 做的第一件事是在栈上"画"出一片新区域。

**执行 `call _call_stub_entry` 指令的瞬间**，CPU 自动做了两件事：
1. `push` 下一条 C++ 指令的地址（返回地址）到栈上
2. 跳转到 call_stub 的机器码

再加上 `call_helper` 调用 `call_stub(...)` 时 C 编译器自动 push 的第 7、8 个栈参数，此时栈上已经有三层了：

```
call_helper 在 C 栈上调用 StubRoutines::call_stub()(...) 之后、
call_stub 第一条指令执行之前:

高地址
  ...                             ← call_helper 的局部变量等
  [rbp+24] Thread*                ← C 编译器 push 的第 8 参数
  [rbp+16] size_of_parameters     ← C 编译器 push 的第 7 参数
  [rbp+8]  返回地址                ← call 指令自动 push
  [rbp+0]  ← rsp, rbp 还指向 call_helper 的帧
低地址
```

然后 call_stub 的前三条指令执行——"画"出 entry_frame：

```asm
push rbp          ; ① 保存 call_helper 的 rbp 到栈上
                  ;    rsp -= 8，现在栈上多了一个 "[rbp+0] saved old rbp"

mov  rbp, rsp     ; ② rbp 切换到新帧——从现在起 rbp 指向 entry_frame 的基址

sub  rsp, 96      ; ③ 往下分配 96 字节——rsp -= 96
                  ;    这 96 字节就是 entry_frame 的工作区
```

**执行完这三条指令后**：

```
高地址
  ...                             ← call_helper 的局部变量
  [rbp+24] Thread*                ← 第 8 参数（栈传）
  [rbp+16] size_of_parameters     ← 第 7 参数（栈传）
  [rbp+8]  返回地址               ← call 指令 push 的
  [rbp+0]  saved old rbp          ← ① push rbp 保存的 call_helper 的 rbp
        ↑
        现在 rbp 指向这里 —— entry_frame 的基址
  [rbp-8]                         ┐
  [rbp-16]                        │
  ...                             │ ③ sub rsp, 96 分配的
  [rbp-88]                        │ 96 字节工作区
  [rbp-96] ← rsp                  ┘
低地址
```

这 96 字节的每个 8 字节槽位有明确分工：

```
[rbp-8]  parameters          ← ① 从 r9 搬过来的 intptr_t* 参数数组指针
[rbp-16] entry_point         ← 从 r8 搬过来的编译代码入口地址
[rbp-24] method              ← 从 rcx 搬过来的 Method*
[rbp-32] result_type         ← 从 rdx 搬过来的 BasicType
[rbp-40] result              ← 从 rsi 搬过来的 result 地址
[rbp-48] call_wrapper        ← 从 rdi 搬过来的 JavaCallWrapper*
[rbp-56] rbx_save            ← ② 保存 call_helper 的 rbx 值
[rbp-64] r12_save            ← 保存 call_helper 的 r12 值
[rbp-72] r13_save            ← 保存 call_helper 的 r13 值
[rbp-80] r14_save            ← 保存 call_helper 的 r14 值
[rbp-88] r15_save            ← 保存 call_helper 的 r15 值
[rbp-96] mxcsr_save          ← 保存浮点控制寄存器值
```

**做完这两步之后，call_stub 还没跳进 Java。还有两件事要做：**

（注：前两步——保存 C ABI 参数、保存 callee-saved 寄存器——是在 entry_frame 的 96 字节槽位上操作的。下面两步是在 entry_frame **下方**继续操作栈。）

**第三步：push Java 参数到栈上。**

Java 方法不通过寄存器接收参数——它的参数存在栈上（slot 0, slot 1, ..., slot N）。所以 call_stub 要从 `parameters` 数组里把每个值读出来，逐个 `push` 到栈上：

```asm
mov  ecx, [rbp+16]              ; ecx = 参数个数（从 C 栈参数里读）
test ecx, ecx                   ; 如果是 0 个参数，跳过循环
jz   parameters_done

mov  rdx, [rbp-8]               ; rdx = parameters 数组指针（从 entry_frame 槽位读）
mov  ecx, [rbp+16]              ; ecx = 参数个数（循环计数器）
loop:
mov  rax, [rdx]                 ; rax = 取一个参数值
add  rdx, 8                     ; 指针前进（下一个参数）
dec  ecx                        ; 计数器 --
push rax                        ; push 到栈上（rsp 往下长）
jnz  loop

parameters_done:
```

效果：假设 Java 静态方法 `add(int a, int b)` 的参数是 `[42, 7]`（静态方法没有 `this`，参数数组里只有这两个 int）。栈的变化：

```
push 42 之前:                     push 42 之后:                     push 7 之后:

高地址                            高地址                            高地址
  ...                               ...                               ...
  [rbp-88]                          [rbp-88]                          [rbp-88]
  [rbp-96] ← rsp                    [rbp-96]                          [rbp-96]
                                    [42    ] ← rsp                    [42    ]
                                                                      [7     ] ← rsp
低地址                            低地址                            低地址
```

注意：`push` 把 rsp 往下推了 8 字节——`[rbp-96]` 是 entry_frame 的底部，`42` 在 `[rbp-104]`，`7` 在 `[rbp-112]`。rsp 已经跑到 entry_frame **外面**去了。

`push` 每次 `rsp -= 8` 然后写值，所以多个参数从右往左排列在栈上——参数 0 在上面（先 push），参数 N 在下面（最后 push），和 C 调用约定一致。

**这些 push 到栈上的值就是 Java 方法的参数**——和解释器调用 Java 方法时参数在栈上的位置一致。Java 方法进入后会建自己的帧（`push rbp; mov rbp, rsp`），然后用自己的 rbp 加偏移去读这些参数，完全不知道——也不需要知道——是 call_stub 还是解释器 push 进来的。

**第四步：设 Java 帧约定的寄存器 + call 跳转。**

现在栈上已经有 Java 参数了，但寄存器还是不对——各寄存器当前的值：

```
rbx = call_helper 的旧值     → Java 方法期望 rbx = Method*
r13 = call_helper 的旧值     → Java 方法期望 r13 = sender_sp
r15 = call_helper 的旧值     → Java 方法期望 r15 = JavaThread*
```

注意：这些旧值虽然在第②步**写到了 entry_frame 的槽位**里（以备将来恢复），但**寄存器本身还是旧值**。"保存"是把值写到内存——寄存器不会自动清空。

现在要覆盖它们：

```asm
mov  rbx, [rbp-24]    ; 从 entry_frame 槽位读出 Method*，覆盖 rbx
mov  r13, rsp          ; r13 = 当前栈顶——这就是 sender_sp（push 完参数后的 rsp）
mov  r15, [rbp+24]     ; r15 = JavaThread*（Thread* 是 call_helper 通过栈传的第 8 参数）
mov  rcx, [rbp-16]     ; rcx = 编译代码入口地址
call rcx               ; 跳进 Java 方法
```

**执行后的寄存器状态**：

```
rbx = 0x7fdc03000000  ← Method*（call_helper 传的 method()）
r13 = 0x7fff1233FF00  ← sender_sp（push 完 Java 参数后的栈顶）
r15 = 0x7fdc05000000  ← JavaThread*（call_helper 传的 thread）
rcx = 0x7fdc00400000  ← 编译代码入口地址
rsp = 指向栈顶 Java 参数的下方
```

**call_stub 做的四件事总结**：

```
① 把 C ABI 的 6 个寄存器参数搬到 entry_frame 栈槽位（释放寄存器）
② 保存 callee-saved 寄存器到 entry_frame 槽位（rbx/r12/r13/r14/r15 旧值）
③ push Java 参数到栈上（从 parameters 数组读出来，逐个 push）
④ 设 rbx=Method*, r13=sender_sp, r15=JavaThread* → call rcx
```

entry_frame 只是第①②步的"草稿纸"——call_stub 的本地工作区。第③步的 Java 参数是在 entry_frame **下方** push 到栈上的，第④步的跳转是最后一步。

### 4.4 Java 帧 —— 编译代码在 entry_frame 上方继续增长

`call rcx` 执行后，CPU 进入编译后的 Java 方法。`call` 指令自动 push 了返回地址到栈上。Java 方法在入口处也会建自己的帧（`push rbp; mov rbp, rsp; sub rsp, frame_size`），在 entry_frame 上方继续分配 locals 区和 expression stack 区。

对 Java 方法来说，call_stub 在第③步 push 到栈上的参数就是正常的 slot 0, slot 1——和从解释器传过来的参数位置一模一样。Java 方法不知道、也不需要知道是谁调用了它。

### 4.5 完整时间线——四张图

把同一个线程栈在四个关键时刻的样子放一起看：

```
     ① call_stub(...)         ② push rbp            ③ 设好 Java 寄存器     ④ call rcx 之后
       被调用前                 mov rbp, rsp             call rcx 之前           Java 方法执行中
                              sub rsp, 96

高地址
  [call_helper 的]           [call_helper 的]         [call_helper 的]         [call_helper 的]
  [局部变量    ]             [局部变量    ]           [局部变量    ]           [局部变量    ]
  [Thread*     ]             [Thread*     ]           [Thread*     ]           [Thread*     ]
  [param_size  ]             [param_size  ]           [param_size  ]           [param_size  ]
  [返回地址    ]  ← call push [返回地址    ]           [返回地址    ]           [返回地址    ]
rbp→                rsp     [saved rbp   ]           [saved rbp   ]           [saved rbp   ]
                          rbp→              ┐        [parameters  ]           [parameters  ]
                            [parameters  ]  │        [entry_point ]           [entry_point ]
                            [entry_point ]  │        [method      ]           [method      ]
                            [method      ]  │entry   [result_type ]           [result_type ]
                            [result_type ]  │frame   [result      ]           [result      ]
                            [result      ]  │96B     [call_wrapper]           [call_wrapper]
                            [call_wrapper]  │        [rbx_save    ]           [rbx_save    ]
                            [rbx_save    ]  │        [r12_save    ]           [r12_save    ]
                            [r12_save    ]  │        [r13_save    ]           [r13_save    ]
                            [r14_save    ]  │        [r14_save    ]           [r14_save    ]
                            [r15_save    ]  │        [r15_save    ]           [r15_save    ]
                            [mxcsr_save  ]  ┘        [mxcsr_save  ]           [mxcsr_save  ]
                          rsp→                     rsp→                       [Java 参数   ]
                                                                              [返回地址    ]
                                                                           rbp→[saved rbp   ]
                                                                              [Java 帧     ]
                                                                              [locals      ]
                                                                              [expr stack  ]
                                                                           rsp→
低地址
```

四张图的变化：
- **①→②**：栈往下长了 96+8=104 字节（saved rbp + entry_frame）
- **②→③**：栈没有变——entry_frame 槽位被填入了具体值，但 rsp 位置不变
- **③→④**：栈往下长了 `Java参数大小 + 返回地址 + Java帧大小`——编译代码在 entry_frame 下方建立了自己的帧

**entry_frame 到底是什么？**

entry_frame 听起来像个特殊概念，但其实它不特殊——它就是 call_stub 这个函数自己的栈帧。只是因为这个帧"夹在 C 帧和 Java 帧之间"，HotSpot 给它取了个名字，方便 GC 识别。

在 x86_64 上，"建帧"就是三条指令：

```asm
push rbp          ; 把调用者的 rbp 压到栈上（等下返回时要恢复）
mov  rbp, rsp     ; rbp 现在指向新帧的"地基"
sub  rsp, 96      ; 在栈上往下分配 96 字节——这是 call_stub 的工作区
```

这三条指令不是 call_stub 的特殊操作——`call_helper` 也是这么建帧的，Linux 内核的函数也是这么建帧的。call_stub 的帧之所以叫 entry_frame，只是因为它的位置特殊：下面压着 C 帧，上面顶着 Java 帧。GC 遍历线程栈时，需要知道"走到这里就是从 C 到 Java 的分界"，所以给了个名字。

call_stub 需要这 96 字节做什么？存翻译过程中需要的中间数据：

```
[rbp-8]  ← 从 r9 搬过来的参数数组指针（释放 r9 寄存器）
[rbp-16] ← 从 r8 搬过来的入口地址
...      ← 更多从 C 寄存器搬过来的数据
[rbp-56] ← 保存 call_helper 的 rbx 值（等下跳进 Java 帧时 rbx 要换成 Method*，旧值存这里）
[rbp-64] ← 保存 r12
...      ← 保存 r13/r14/r15（这些都是 call_helper 用的寄存器，回来要还给它）
[rbp-96] ← 保存浮点控制寄存器
```

这 96 字节就是 call_stub 的"栈上草稿纸"——写写算算用的工作区。翻译完成、`call rcx` 跳进 Java 方法后，这些数据就不需要了。等 Java 方法执行完返回 call_stub，call_stub 从这些槽位把原来的寄存器值恢复回去，然后 `pop rbp; ret`——call_helper 拿回它的 rbx/r12/r13/r14/r15，完全不知道中间发生了什么。

---

## 5. 不止 call_stub —— StubRoutines 这张表的全景

call_stub 是第一个、也是最核心的 stub。但 JVM 需要不止它一个：

| stub | 谁用 | 解决什么问题 |
|------|------|------------|
| call_stub | 解释器 → 编译代码 | C 帧和 Java 帧之间的格式翻译 |
| forward_exception | 编译代码抛异常时 | 保存编译帧信息，跳回 C++ 异常处理器 |
| catch_exception | 巨型方法调用点 | 从编译代码捕获异常继续执行 |
| atomic_xchg/cmpxchg/add | C1/C2 编译代码中 | 裸 `lock cmpxchg`——不能用 C++ 的 `std::atomic` |
| throw_StackOverflowError | 编译代码栈溢出 | 构造异常帧，跳回 C++ 抛出 StackOverflowError |
| CRC32/AES | `java.util.zip.CRC32` | `crc32` / `aesenc` CPU 指令硬件加速 |
| Math.sin/cos/exp | `java.lang.Math` | 直接调用 libm 或 SIMD 实现 |

共用同一个模式：一段存 code cache 中的机器码，入口地址存在 `StubRoutines` 的某个 `static address` 字段里。

`StubRoutines`（`stubRoutines.hpp:86`）：

```cpp
class StubRoutines : public AllStatic {   // AllStatic: 不能实例化——纯全局变量的命名空间
  // 只有初始化代码（通过 friend 权限）可以写这些字段

  static address _call_stub_entry;       // call_stub 入口
  static address _forward_exception_entry;
  static address _catch_exception_entry;
  static address _atomic_xchg_entry;
  static address _atomic_cmpxchg_entry;
  // ... 约 30 个字段
};
```

- 初始化前：call_stub 等入口点字段全是 NULL（`stubRoutines.cpp:47-52`）
- 初始化后：每个字段指向 code cache 中对应 stub 的第一条指令
- 写入方：初始化代码（通过 `friend` 权限）
- 读取方：JVM 的各个子系统（解释器、编译代码、GC、JVMTI）

---

## 6. 总结

| 概念 | 一句话 |
|------|--------|
| stub | 一段存在 code cache 中的 x86 机器码——不是 C++ 编译的、不是 JIT 编译的、JVM 启动时生成、永不改变 |
| call_stub | 从 C 帧跳进 Java 帧的桥——把 C ABI 的参数翻译成 Java 帧的约定 |
| address | `unsigned char*`——入口点的类型。`_call_stub_entry` 存的就是 call_stub 第一条指令的地址 |
| 函数指针 | 把 address 强转成 `CallStub` 类型，C++ 编译器就允许你像调用普通函数一样 `call` 到那个地址上 |
| C 调用约定 | 前 6 个参数用 rdi/rsi/rdx/rcx/r8/r9，第 7+ 用栈——`call_helper` 按这个约定传给 call_stub |
| Java 帧约定 | rbx=Method*, r13=sender_sp, r15=JavaThread*——编译代码按这个约定读寄存器 |
| entry_frame | C 帧和 Java 帧之间的中间帧——call_stub 在栈上"画"出来的 96 字节区域，栈遍历器通过它连上 C 帧 |
| StubRoutines | 约 30 个 `static address` 字段的全局表——存所有 stub 的入口地址 |

**你已经知道的概念链**：

```
解释器不能直接 call 编译代码（寄存器不兼容）
  → 需要一个 stub 做翻译（call_stub）
  → stub 是机器码，存在 code cache 中
  → 入口地址是 address（unsigned char*）
  → C++ 通过函数指针调用它（强转成 CallStub）
  → 函数指针调用时按 C 调用约定传参
  → stub 收到参数后在栈上建 entry_frame
  → 翻译完成后 call 到编译代码的 Java 帧
  → 所有 stub 的入口地址存在 StubRoutines 表中
  → call_stub 等入口点字段初始 NULL，初始化时填充
```

**接下来**：`02-stubroutines-table.md` 详细展开 StubRoutines 表的结构——有哪些字段、怎么读、怎么写。
