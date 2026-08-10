# 域 21: SharedRuntime — 知识规划

> 源码路径: hotspot/share/runtime/sharedRuntime.* + sharedRuntimeTrans/Trig/Math + hotspot/cpu/x86/sharedRuntime_x86*
> 源码量: 8 文件 / ~13,000 行 | 🔴 大域（大量平台层代码）

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| sharedRuntime.hpp:47-350 + sharedRuntime.cpp | **SharedRuntime — 编译代码↔VM 桥接器**: generate_stubs(IC miss/wrong_method/resolve*/deopt blob/safepoint handler), resolve_helper(符号引用→直接引用+patch call site), handle_ic_miss_helper(IC miss→megamorphic upgrade), reresolve_call_site(类重定义重新解析), monitor_enter/exit_helper | High |
| sharedRuntime.hpp:181-206 | **异常处理**: raw_exception_handler_for_return_address(找nmethod异常表), compute_compiled_exc_handler(PC→handler), ImplicitExceptionKind(NULL/DIV0/STACK_OVERFLOW), continuation_for_implicit_exception(隐式异常→是恢复正常还是抛异常), throw_StackOverflowError_common(delayed vs immediate) | High |
| sharedRuntime.hpp:95-179 + sharedRuntimeTrans.cpp + sharedRuntimeTrig.cpp + sharedRuntimeMath.hpp | **Math/Tanscendental 函数**: lmul/ldiv/lrem(64-bit整数运算平台fallback), dsin/dcos/dtan/dlog/dexp/dpow(超越函数——平台无指令时fallback), d2i/d2l(浮点→整数转换含IEEE rounding), fmod_winx64(Win CRT bug workaround), montgomery_multiply(RSA crypto加速) | Medium |
| sharedRuntime.hpp:80-86 + sharedRuntime.cpp:generate_stubs | **Runtime Stubs 生成**: wrong_method_blob(IC发现错误klass→回退到resolve), ic_miss_blob(IC miss→vtable查表→patch IC), resolve_virtual/static/opt_virtual_call_blob(符号引用解析+patch), deopt_blob(逆优化入口), polling_page_safepoint_handler_blob(SIGSEGV→safepoint处理) | High |
| cpu/x86/sharedRuntime_x86_64.cpp | **x86_64 调用约定**: generate_c2i_adapter(编译→解释: 刷洗寄存器→准备locals→跳解释器), generate_i2c_adapter(解释→编译: 设callee target→跳编译入口), frame_complete offset(栈帧何时算完整), OopMap 生成(GC roots for compiled frame), 参数传递(rdi/rsi/rdx/rcx/r8/r9→stack overflow) | High |
| cpu/x86/sharedRuntime_x86.cpp + sharedRuntime_x86_32.cpp | **x86 通用 + x86_32 调用约定**: common x86 generate_* stubs, x86_32 cdecl calling convention(参数全栈传递, eax/edx/ecx caller-saved) | Medium |

*6 个知识点*

## 02 聚合 — 跨文件汇总

### P1 — 系统级共识
| KP | 出现文件 |
|----|---------|
| Runtime Stubs (resolve/miss/wrong_method/deopt/safepoint handlers) | sharedRuntime.*, cpu/x86/sharedRuntime_x86*.cpp(含IC miss assembly wrapper) |

### P2 — 局部重要
| KP | 出现文件 |
|----|---------|
| c2i/i2c Adapter (调用桥) | cpu/x86/sharedRuntime_x86_64.cpp, sharedRuntime.cpp(adapter框架) |
| Exception Handling | sharedRuntime.hpp(声明), sharedRuntime.cpp(实现), cpu/x86/sharedRuntime_x86*.cpp(平台handler) |

### P3 — 孤立
| KP | 文件 |
|----|------|
| Math/Trancendental | sharedRuntimeTrans.cpp, sharedRuntimeTrig.cpp, sharedRuntimeMath.hpp |
| Monitor helpers | sharedRuntime.hpp(monitor_enter/exit_helper), synchronizer.cpp(被调方) |

## 03 深度分类

### 🔴 Deep — 核心设计决策 (3 KP)
| KP | 为什么 🔴 |
|----|---------|
| Runtime Stubs 分发网络 | SharedRuntime 管的 8+ 个 stub——wrong_method(IC发现caller的klass≠cache→回退resolve)、ic_miss(IC miss→vtable walk→upgrade mono/mega)、resolve_*(符号引用解析→patch IC target)、deopt_blob(从编译回解释)。这个网络覆盖了编译代码从"第一次遇到"→"确定调用目标"→"出错了"→"退回解释"的全生命周期——是编译代码和VM之间唯一的调用桥 |
| x86_64 c2i/i2c Adapter 调用约定 | java→VM 转换的核心——c2i: 刷洗所有caller-saved寄存器→存编译帧的bcp+locals→跳解释器。i2c: 设callee target→跳编译入口。关键: 两个方向不是对称的——c2i 做了刷洗(因为解释器假设所有寄存器是"脏的")，i2c 不需要(method+bcp已经在调用约定位置)。adapter 是手写汇编——不是 C++ 函数 |
| 异常处理链路 (compiled→VM→handler) | compiled code中出现异常→查找nmethod exception handler table→调用SharedRuntime::exception_handler_for_return_address→若找到→跳handler。若未找到→unwind栈→pop编译帧→继续在caller中查找。隐式异常(NULL/DIV0)走sig handler→continuation_for_implicit_exception(是重新执行还是抛异常)。栈溢出两阶段: 先设reserved zone尝试→若溢出后真的无法恢复→抛StackOverflowError |

### 🟡 Working — 有设计但非核心 (2 KP)
| KP | 说明 | 为什么 🟡 非 🔴 |
|----|------|------|
| Math/Tranescental 函数 | lmul/ldiv/dsin/dcos等——平台无硬件指令时fallback到软件实现。Montgomery multiply 为 RSA 加速 | 是支持库——JVM 正确性不依赖它(CPU 有指令时跳过)。rsa crypto 加速是特殊需求 |
| Monitor helpers | monitor_enter_helper/exit_helper——ObjectSynchronizer 的包装——加入 biased lock + inline fast locking 优化 | 是 synchronizer(域19) 的调用端——SharedRuntime 只是提供了从编译代码到同步机制的统一入口 |

### 🟢 Surface — 了解即可 (1 KP)
| KP | 说明 |
|----|------|
| DTrace 钩子 + reguard_yellow_pages | dtrace method entry/exit 通知 + 栈yellow zone恢复 |

## 04 聚类 — 依赖图+教学顺序+文章拆分

### 依赖图
```
SharedRuntime
  ├── Runtime Stubs (IC miss/wrong_method/resolve/deopt/safepoint)
  │     └── cpu/x86 sharedRuntime_x86*.cpp (平台 stub 生成)
  ├── c2i/i2c Adapter (调用桥)
  │     └── cpu/x86 sharedRuntime_x86_64.cpp (x86_64 帧布局+寄存器约定)
  ├── Exception Handling
  │     └── Implicit Exceptions (NULL/DIV0/STACK_OVERFLOW)
  └── Math Support (transcendental + conversion)
```

### 文章拆分: 3 篇

| 篇 | 标题 | 覆盖 KP | 核心问题 | 预估 |
|:--:|------|:--:|------|:--:|
| 1 | Runtime Stubs — 编译代码求助网络 | _wrong_method_blob/_ic_miss_blob/resolve_static/virtual/opt, generate_stubs, poll stub, deopt_blob | "编译代码遇到 IC miss、找不到方法、需要 deopt——它向谁求助？" | 核心 |
| 2 | 调用桥 — c2i/i2c Adapter | x86_64 generate_c2i_adapter/generate_i2c_adapter, stack frame layout, OopMap for compiled frame, register convention | "方法从编译代码调到解释器——寄存器怎么转？栈帧怎么切？" | 核心 |
| 3 | 异常处理 + 辅助函数 | exception_handler_for_return_address, compute_compiled_exc_handler, ImplicitExceptionKind, continuation_for_implicit_exception, stack overflow two-phase, monitor_enter/exit_helper, math transcendental | "编译代码里抛了 NPE——JVM 怎么找到 handler？递归太深怎么办？" | 深度 |
