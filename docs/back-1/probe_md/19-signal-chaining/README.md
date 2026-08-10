# 19 — Signal Chaining: libjsig.so + libjvm.so

> BUILD_LIBJSIG → libjsig.so。JVM 信号处理器与第三方库信号处理器共存机制：三阶段协议、sigaction 拦截、链式回退、6 个信号逐个安装、跨 CPU 平台信号识别。

## 概述

Signal Chaining 是 HotSpot JVM 解决"我的信号处理器和第三方库（JNI agent、性能分析工具、调试器）的信号处理器如何共存"的完整方案。核心机制分为三层：

1. **libjsig.so 层**（`src/java.base/unix/native/libjsig/jsig.c`，342 行）：通过 `LD_PRELOAD` 插入，拦截 `sigaction()`/`signal()` 调用，保存第三方处理器到 `sact[]` 数组，让 JVM 的处理器优先生效
2. **JVM 安装层**（`src/hotspot/os/linux/os_linux.cpp`，~250 行相关代码）：`install_signal_handlers()` → `set_signal_handler()` 三路决策，逐个安装 6 个信号，保存被替换的处理器到 `sigact[]`
3. **JVM 分派层**（`src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp`，~390 行）：`JVM_handle_linux_signal()` 信号识别 → `chained_handler()` 链式回退 → `call_chained_handler()` 调用第三方处理器

## BUILD_LIBRARY 目标

| .gmk 文件 | 目标 | NAME | .so | 模块 |
|-----------|------|------|-----|------|
| `make/lib/Lib-java.base.gmk:139` | BUILD_LIBJSIG | jsig | libjsig.so | java.base |

HotSpot 信号处理核心（`install_signal_handlers`、`set_signal_handler`、`chained_handler`、`JVM_handle_linux_signal`）编译进 `libjvm.so`。

libjsig.so 通过 `$(call SetupJdkLibrary, BUILD_LIBJSIG, ...)` 构建（`Lib-java.base.gmk:139-149`），编译参数：
- `OPTIMIZATION := LOW` — 低优化级别（保证信号处理正确性）
- `LIBS_linux := $(LIBDL)` — 链接 `libdl.so`（用于 `dlsym(RTLD_NEXT)`）
- 构建后为每个 JVM variant 子目录创建符号链接 `libjsig.so → ../libjsig.so`

## 源码规模

| 源文件 | 行数 | 角色 |
|--------|:---:|------|
| `src/java.base/unix/native/libjsig/jsig.c` | 342 | libjsig.so 实现：三阶段协议、sigaction/signal 拦截 |
| `src/hotspot/os/linux/os_linux.cpp` | 7,117 | 信号链核心（~300 行信号相关） |
| `src/hotspot/os/linux/os_linux.hpp` | 328 | 信号函数声明 |
| `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` | 976 | x86 信号识别与分派（~390 行） |
| `src/hotspot/os/posix/os_posix.cpp` | 2,271 | preinstalled handler 管理（~10 行相关） |
| `src/hotspot/share/runtime/thread.hpp` | ~3,500 | SignalHandlerMark RAII（13 行） |
| `src/hotspot/share/runtime/globals.hpp` | ~2,500 | 3 个 JVM 标志 |
| **总计** | **~14,034** | |

## 核心架构

```
用户进程
│
├── LD_PRELOAD=libjsig.so ──────────────┐
│  (拦截 sigaction/signal 调用)          │ Phase 19
│                                        │
├── libjvm.so ──────────────────────────┤
│  ├── install_signal_handlers()         │ Phase 19
│  │   └── set_signal_handler()×6        │
│  │       ├── 路1: 直接安装             │
│  │       ├── 路2: 保存到 sact[] (jsig)  │
│  │       └── 路3: 保存到 sigact[] (posix)│
│  │                                     │
│  ├── JVM_handle_linux_signal() ───┐    │ Phase 19
│  │   ├── 信号识别 (SIGSEGV/BUS/...) │   │
│  │   ├── JVM 内部处理             │    │
│  │   └── 未识别 → chained_handler()│   │ Phase 19
│  │       └── call_chained_handler()│   │
│  │           └── sigact[sig] 处理器 │   │
│  └── SignalHandlerMark (RAII)     │    │ Phase 19
│                                     │
└── 第三方库 (JNI agent, profiler)    │    │
   └── sigaction() 被 libjsig 拦截     │────┘
```

## 文档拆分方案（3 篇，按执行流顺序）

### 依赖关系

```
00 (libjsig 拦截层) ──→ 01 (JVM 安装层) ──→ 02 (JVM 分派层)
```

### 推荐阅读顺序

00 → 01 → 02

---

### 00 — libjsig 拦截层：三阶段协议

**覆盖 .so**：libjsig.so

**源文件**：
- `src/java.base/unix/native/libjsig/jsig.c` (:1-342)

**行号范围**：全文 342 行

**关键符号**：
| 符号 | 行号 | 简述 |
|------|:---:|------|
| `sact[]` | :58 | 保存第三方信号处理器的数组（`struct sigaction[MAX_SIGNALS]`） |
| `os_signal` | :77 | 原始 `signal()` 函数指针（`dlsym(RTLD_NEXT, "signal")`） |
| `os_sigaction` | :78 | 原始 `sigaction()` 函数指针（`dlsym(RTLD_NEXT, "sigaction")`） |
| `jvm_signal_installing` | :80 | 三阶段协议标志：JVM 正在安装信号（Phase 1） |
| `jvm_signal_installed` | :81 | 三阶段协议标志：JVM 已完成信号安装（Phase 2→3） |
| `signal_lock()` | :98 | pthread mutex 加锁 |
| `signal_unlock()` | :109 | pthread mutex 解锁 |
| `call_os_signal()` | :113 | 调用原始 `signal()` |
| `save_signal_handler()` | :144 | 保存处理器到 `sact[]` |
| `set_signal()` | :164 | 调用原始 `signal()` 安装处理器 |
| `call_os_sigaction()` | :236 | 调用原始 `sigaction()` |
| `sigaction()` (interposed) | :251 | 被拦截的 `sigaction()` |
| `signal()` (interposed) | :212 | 被拦截的 `signal()` |
| `JVM_begin_signal_setting()` | :319 | JVM 调用：标记开始安装 |
| `JVM_end_signal_setting()` | :327 | JVM 调用：标记安装完成 |
| `JVM_get_signal_action()` | :335 | JVM 调用：获取保存的处理器 |

**边界**：
- 包含：三阶段协议状态机、sigaction/signal 拦截逻辑、pthread 同步、sact[] 存储、dlsym(RTLD_NEXT) 机制、MAX_SIGNALS 差异（Solaris malloc vs Linux 静态数组）
- 不包含：JVM 如何调用 `JVM_begin_signal_setting()` / `JVM_end_signal_setting()` / `JVM_get_signal_action()`（留给 01）
- 不包含：信号分派和链式回退（留给 02）

---

### 01 — JVM 信号安装：install_signal_handlers

**覆盖 .so**：libjvm.so（HotSpot 内部）

**源文件**：
- `src/hotspot/os/linux/os_linux.cpp` (:594-686, :5214-5515)
- `src/hotspot/os/linux/os_linux.hpp` (:170-180)
- `src/hotspot/os/posix/os_posix.cpp` (:1718-1732)
- `src/hotspot/share/runtime/thread.hpp` (:2313-2325)
- `src/hotspot/share/runtime/globals.hpp` (:883, :896, :900)

**行号范围**：
- `signal_sets_init()`：:594-686
- `install_signal_handlers()`：:5413-5515
- `set_signal_handler()`：:5329-5411
- 相关函数声明 + 上下文：~100 行
- `save_preinstalled_handler()` / `get_preinstalled_handler()`：:1718-1732

**关键符号**：
| 符号 | 行号 | 简述 |
|------|:---:|------|
| `signal_sets_init()` | :594 | 初始化 `unblocked_sigs` 和 `vm_sigs` 信号集 |
| `install_signal_handlers()` | :5413 | 安装全部 6 个信号处理器的主入口 |
| `set_signal_handler(sig, set_installed)` | :5329 | 单个信号安装，三路决策 |
| `hotspot_sigmask()` | :702 | 设置线程信号掩码 |
| `sigact[NSIG]` | posix:1718 | 保存被 JVM 替换的原始处理器 |
| `save_preinstalled_handler()` | posix:1727 | 保存处理器到 sigact[] |
| `get_preinstalled_handler()` | posix:1720 | 获取 sigact[] 中的处理器 |
| `SignalHandlerMark` | thread.hpp:2313 | RAII guard：进入/离开信号处理器 |
| `jdk_misc_signal_init()` | :3142 | `jdk.internal.misc.Signal` 支持 |
| `UseSignalChaining` | globals.hpp:900 | 启用 jsig 三阶段协议（默认 true） |
| `ReduceSignalUsage` | globals.hpp:883 | 不安装 SHUTDOWN/BREAK 信号（-Xrs） |
| `AllowUserSignalHandlers` | globals.hpp:896 | 允许用户替换 JVM 信号处理器 |

**安装的 6 个信号**：
| # | 信号 | 行号 | 处理器 | 平台差异 |
|---|------|:---:|--------|---------|
| 1 | SIGSEGV | :5467 | `JVM_handle_linux_signal()` | 所有平台 |
| 2 | SIGPIPE | :5472 | `SIG_IGN` (忽略) | 所有平台 |
| 3 | SIGBUS | :5477 | `JVM_handle_linux_signal()` | 所有平台 |
| 4 | SIGILL | :5482 | `JVM_handle_linux_signal()` | 所有平台 |
| 5 | SIGFPE | :5487 | `JVM_handle_linux_signal()` | 所有平台 |
| 6 | SIGTRAP | :5489 | `JVM_handle_linux_signal()` | **仅 PPC64**（x86/ARM/AArch64 不安装） |
| 7 | SIGXFSZ | :5495 | `JVM_handle_linux_signal()` | 所有平台 |

**set_signal_handler 三路决策**：
```
set_signal_handler(sig, set_installed)
│
├─ 路1: AllowUserSignalHandlers=true 或 set_installed=false
│   → 不安装，跳过（用户自行管理）
│
├─ 路2: UseSignalChaining=true (默认)
│   → 调用 JVM_begin_signal_setting() 进入 Phase 1
│   → sigaction(sig, &jh, &oldAct) — JVM 处理器安装到内核
│   → save_preinstalled_handler(sig, oldAct) — 旧处理器保存到 sigact[]
│   → JVM_end_signal_setting() 进入 Phase 3
│   → 第三方库后续 sigaction() 调用 → 保存到 sact[]（不安装到内核）
│
└─ 路3: UseSignalChaining=false
    → sigaction(sig, &jh, &oldAct) — 直接安装，旧处理器丢弃
```

**边界**：
- 包含：signal_sets_init、install_signal_handlers、set_signal_handler 三路决策、sigact[] 管理、SignalHandlerMark RAII、3 个 JVM 标志含义、与 libjsig 的 JVM_begin/JVM_end 调用
- 不包含：libjsig.so 内部实现（留给 00）
- 不包含：JVM_handle_linux_signal 信号识别（留给 02）
- 不包含：chained_handler 链式回退（留给 02）

---

### 02 — 信号分派与链式回退

**覆盖 .so**：libjvm.so（HotSpot 内部）

**源文件**：
- `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` (:271-650)
- `src/hotspot/os/linux/os_linux.cpp` (:5255-5310)
- `src/hotspot/os/posix/os_posix.cpp` (:1718-1732)

**行号范围**：
- `JVM_handle_linux_signal()`：os_linux_x86.cpp:271-660 (~390 行)
- `chained_handler()`：os_linux.cpp:5301-5310
- `call_chained_handler()`：os_linux.cpp:5255-5299

**关键符号**：
| 符号 | 行号 | 简述 |
|------|:---:|------|
| `JVM_handle_linux_signal()` | x86:271 | x86 信号分派主入口 |
| `signalHandler()` | (平台相关) | 平台级信号处理器入口 |
| `chained_handler()` | :5301 | 链式回退入口（检查 UseSignalChaining） |
| `call_chained_handler()` | :5255 | 实际调用 `sigact[]` 或 `sact[]` 中的处理器 |
| `sigact[]` | posix:1718 | preinstalled handler 存储（01 保存，02 调用） |
| `sact[]` | jsig.c:58 | libjsig 保存的第三方处理器（01 保存，02 调用） |

**JVM_handle_linux_signal 信号识别路径**：
```
JVM_handle_linux_signal(sig, info, ucVoid)
│
├── SIGSEGV (x86:350-530)
│   ├── Stack Overflow → StackOverflowError stub (Yellow zone) 或 fatal (Red zone)
│   ├── _thread_in_Java → Safepoint polling page → 恢复执行
│   ├── _thread_in_Java → implicit null → NullPointerException stub
│   └── _thread_in_vm / _thread_in_native → 检查是否安全点
│
├── SIGBUS (x86:350-530)
│   ├── _thread_in_Java → MappedByteBuffer / Unsafe access
│   └── _thread_in_vm → unsafe access
│
├── SIGFPE (x86:477)
│   └── _thread_in_Java → divide by zero → ArithmeticException stub
│
├── SIGILL / SIGTRAP (x86:520-545)
│   └── 调试/插桩信号
│
├── JNI_FastGetField slowcase (x86:530)
│
├── Memory serialize page (x86:542)
│
├── 已识别且已处理 → 返回 true (x86:626)
│
└── 未识别 → 尝试信号链 (x86:632)
    └── chained_handler(sig, info, ucVoid)
        └── call_chained_handler(actp, sig, info, ucVoid)
            ├── sigact[] → 调用原始处理器
            └── sact[] → 调用 libjsig 保存的第三方处理器
```

**两套 handler 存储协作**：
| 存储 | 位置 | 保存时机 | 内容 | 调用时机 |
|------|------|---------|------|---------|
| `sigact[NSIG]` | `os_posix.cpp:1718` | JVM 安装时（sigaction 返回的 oldAct） | JVM 安装前已存在的处理器 | JVM 无法处理信号时回退 |
| `sact[MAX_SIGNALS]` | `jsig.c:58` | JVM 安装后第三方调用 sigaction() | 第三方库注册的处理器 | JVM 无法处理信号时回退 |

**边界**：
- 包含：JVM_handle_linux_signal 全部信号识别路径、线程状态检查、栈溢出检测、chained_handler 链式回退、call_chained_handler 两套存储调用、sact[] 与 sigact[] 协作
- 不包含：install_signal_handlers 安装流程（留给 01）
- 不包含：libjsig.so 三阶段协议实现（留给 00）

---

## 源码文件总表

| 文件 | 行数 | 覆盖文档 | 行号范围 | 内容 |
|------|:---:|:---:|------|------|
| `src/java.base/unix/native/libjsig/jsig.c` | 342 | **00** | :1-342 | libjsig.so 全部实现 |
| `src/hotspot/os/linux/os_linux.cpp` | 7,117 | **01, 02** | :594-686, :3142-3158, :5214-5520 | 信号集初始化、安装、链式回退 |
| `src/hotspot/os/linux/os_linux.hpp` | 328 | **01** | :170-180 | 信号函数声明 |
| `src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp` | 976 | **02** | :271-660 | x86 信号识别与分派 |
| `src/hotspot/os/posix/os_posix.cpp` | 2,271 | **01, 02** | :1718-1732 | sigact[] 管理 |
| `src/hotspot/share/runtime/thread.hpp` | ~3,500 | **01** | :2313-2325 | SignalHandlerMark RAII |
| `src/hotspot/share/runtime/globals.hpp` | ~2,500 | **01** | :883, :896, :900 | 3 个 JVM 标志 |

## JVM 标志表

| 标志 | 类型 | 默认值 | globals.hpp 行号 | 说明 |
|------|------|:---:|:---:|------|
| `UseSignalChaining` | `product(bool)` | `true` | :900 | 启用 libjsig 三阶段协议。JVM 安装时调用 `JVM_begin_signal_setting()`/`JVM_end_signal_setting()` 通知 libjsig；`chained_handler()` 在 JVM 无法处理信号时调用链式处理器 |
| `ReduceSignalUsage` | `product(bool)` | `false` | :883 | 不安装 SHUTDOWN1/2/3 + BREAK_SIGNAL 信号处理器（对应 `-Xrs`）。`signal_sets_init()` 中跳过 vm_sigs 设置；`hotspot_sigmask()` 中不设置 vm_sigs 到线程掩码 |
| `AllowUserSignalHandlers` | `product(bool)` | `false` | :896 | 允许用户用 `sigaction()` 替换 JVM 安装的信号处理器。`set_signal_handler()` 中跳过安装，打印 "Info: AllowUserSignalHandlers is activated, all active signal checking is disabled" |

**标志交互**：
- `ReduceSignalUsage` → 影响 `signal_sets_init()` 和 `hotspot_sigmask()`，不阻止核心信号（SIGSEGV/BUS/ILL/FPE）安装
- `AllowUserSignalHandlers` → 完全跳过 `set_signal_handler()` 安装，JVM 不注册任何信号处理器（极端模式）
- `UseSignalChaining` → 默认启用，关闭后 JVM 直接覆盖第三方处理器（不保存），丢失链式回退能力

## syscall / 库函数速查表

| 函数 | man 手册 | 使用位置 | 用途 |
|------|:---:|------|------|
| `sigaction()` | `man 2 sigaction` | jsig.c:236, os_linux.cpp:5375-5380 | 安装/获取信号处理器 |
| `signal()` | `man 2 signal` | jsig.c:113, jsig.c:164 | 简化信号处理器安装（兼容旧代码） |
| `sigfillset()` | `man 3 sigfillset` | os_linux.cpp:600 | 初始化信号集为"全部信号" |
| `sigaddset()` | `man 3 sigaddset` | os_linux.cpp:614-683 | 向信号集添加特定信号 |
| `sigemptyset()` | `man 3 sigemptyset` | jsig.c:106 | 初始化信号集为"空集" |
| `sigismember()` | `man 3 sigismember` | jsig.c:177 | 检查信号是否在信号集中 |
| `pthread_sigmask()` | `man 3 pthread_sigmask` | os_linux.cpp:708, :722 | 设置线程信号掩码 |
| `pthread_mutex_lock()` | `man 3 pthread_mutex_lock` | jsig.c:99 | libjsig 内信号操作互斥 |
| `pthread_mutex_unlock()` | `man 3 pthread_mutex_unlock` | jsig.c:110 | libjsig 内信号操作互斥 |
| `pthread_cond_broadcast()` | `man 3 pthread_cond_broadcast` | jsig.c:334 | Phase 2→3 过渡时唤醒等待者 |
| `pthread_cond_wait()` | `man 3 pthread_cond_wait` | jsig.c:306 | Phase 2 中等待 JVM 安装完成 |
| `dlsym(RTLD_NEXT, ...)` | `man 3 dlsym` | jsig.c:67-71 | 获取原始 sigaction/signal 函数指针 |

## 关键数据结构

### 1. sact[] — libjsig 第三方处理器存储

```
位置: src/java.base/unix/native/libjsig/jsig.c:58
类型: static struct sigaction sact[MAX_SIGNALS]  (Linux)
      static struct sigaction *sact = malloc(...)  (Solaris)

MAX_SIGNALS:
  - Linux/BSD: NSIG (通常 65)
  - Solaris: SIGRTMAX+1 (运行时确定，需动态分配)

内容: 第三方库通过 sigaction()/signal() 注册的信号处理器
      保存 sa_handler, sa_mask, sa_flags

生命周期:
  Phase 1 (jvm_signal_installing=true):
    sigaction() 拦截 → save_signal_handler() → sact[sig] = handler
    不调用原始 sigaction()（JVM 处理器优先生效）
  
  Phase 3 (jvm_signal_installed=true):
    sigaction() 拦截 → call_os_sigaction() → 保存 oldAct → sact[sig] = act
    真正调用原始 sigaction() 安装到内核
```

### 2. sigact[] — JVM 内部 preinstalled handler 存储

```
位置: src/hotspot/os/posix/os_posix.cpp:1718
类型: struct sigaction sigact[NSIG]

内容: JVM 安装自己的信号处理器时，sigaction() 返回的 oldAct
      即 JVM 安装前已存在的处理器（可能是 libjsig 的三阶段包装，也可能是其他）

生命周期:
  写入: save_preinstalled_handler(sig, oldAct)
        set_signal_handler() 中 sigaction() 返回 oldAct 后调用
  读取: get_preinstalled_handler(sig)
        call_chained_handler() 中获取 → 调用原始处理器
```

### 3. SignalHandlerMark — RAII 信号处理器上下文

```
位置: src/hotspot/share/runtime/thread.hpp:2313-2325
类型: class SignalHandlerMark : public StackObj

成员:
  Thread* _thread  — 进入信号处理器时所在的线程

构造: SignalHandlerMark(Thread* t)
  → _thread->enter_signal_handler()  设置线程状态为"在信号处理器中"

析构: ~SignalHandlerMark()
  → _thread->leave_signal_handler()  恢复线程原始状态

用途: JVM_handle_linux_signal() 入口创建，确保信号处理器执行期间
      线程状态正确，防止 GC/安全点冲突
```

## 三阶段协议状态机

```
          ┌──────────────────────────────────────────────────┐
          │                 libjsig 三阶段协议                │
          └──────────────────────────────────────────────────┘

  Phase 0: 初始状态
  ┌─────────────────────────────────────┐
  │ jvm_signal_installing = false       │
  │ jvm_signal_installed  = false       │
  │                                     │
  │ sigaction() → 直接调用原始 sigaction()│
  │ 正常行为，无拦截                      │
  └──────────┬──────────────────────────┘
             │ JVM 调用 JVM_begin_signal_setting()
             ▼
  Phase 1: JVM 正在安装
  ┌─────────────────────────────────────┐
  │ jvm_signal_installing = true        │
  │ jvm_signal_installed  = false       │
  │                                     │
  │ sigaction() → save_signal_handler() │
  │   → 保存到 sact[]                   │
  │   → 不调用原始 sigaction()          │
  │   → JVM 处理器优先生效              │
  └──────────┬──────────────────────────┘
             │ JVM 调用 JVM_end_signal_setting()
             ▼
  Phase 2: 过渡状态（等待第三方线程）
  ┌─────────────────────────────────────┐
  │ jvm_signal_installing = true        │
  │ jvm_signal_installed  = false       │
  │                                     │
  │ 持有 signal_lock()                  │
  │ 广播 pthread_cond_broadcast()       │
  │ 等待所有正在执行信号操作的线程完成    │
  └──────────┬──────────────────────────┘
             │ 所有线程离开临界区
             ▼
  Phase 3: 安装完成（正常运行）
  ┌─────────────────────────────────────┐
  │ jvm_signal_installing = false       │
  │ jvm_signal_installed  = true        │
  │                                     │
  │ sigaction() → call_os_sigaction()   │
  │   → 保存 oldAct → sact[sig] = act   │
  │   → 真正安装到内核                  │
  │   → JVM 已安装完成，后续第三方处理器  │
  │     正常安装到内核（但 sact[] 有备份）│
  └─────────────────────────────────────┘
```

**Phase 2 存在的原因**（竞态窗口保护）：
- 第三方线程可能在 Phase 1 期间已进入 `sigaction()` 的临界区
- `JVM_end_signal_setting()` 在持有锁的情况下广播条件变量
- 等待所有正在执行信号操作的线程完成后才进入 Phase 3
- 防止第三方线程在 Phase 切换期间丢失信号处理器

## 与前后 Phase 的关系

### Phase 18（Agent & Instrument）

Phase 18 覆盖了 JVMTI agent 加载机制。Signal Chaining 是 agent 加载的基础设施：
- JVMTI agent（如 profiler）需要注册自己的信号处理器（如 SIGPROF 用于定时采样）
- 如果没有 libjsig，agent 的 sigaction() 会直接覆盖 JVM 的处理器，导致 JVM 失去对 SIGSEGV/BUS/ILL/FPE 的控制
- libjsig 确保 agent 的处理器保存到 sact[]，JVM 处理器优先生效，agent 处理器在 JVM 无法处理时被链式调用

### Phase 20（SA Postmortem）

Phase 20 覆盖 Serviceability Agent 的事后诊断工具。Signal Chaining 与 SA 的关系：
- SA 的 `jstack`/`jmap` 等工具通过 SIGQUIT（`-Xrs` 时）或 Attach API 与目标 JVM 交互
- `ReduceSignalUsage`（-Xrs）影响 SA 工具的信号交互路径
- 信号处理器崩溃时的 core dump 分析依赖 SA 工具，Signal Chaining 保存的 sact[]/sigact[] 信息可帮助诊断信号处理链问题

## 标准工作流

```
① 规划(本文件) → ② Prompt 写作(会话A) → ③ 文档生成(会话B) → ④ Review
```

0. 规划确认（已完成）
1. Prompt 写作：scout → reader → tracer → 汇总写出 prompt（≥450行/篇）
2. 文档生成：在新会话中读 prompt → 按指令生成文档
3. Review：自检 12 项 Checklist → 修复 gap → 标记完成

**IMPORTANT**：
- Prompt 写作和文档生成必须在不同会话中完成
- 每次最多生成 2 篇文档
- 生成前 re-read 质量锚点 `probe_md/15-core-native/prompts/prompt-00-System-Arraycopy.md`
