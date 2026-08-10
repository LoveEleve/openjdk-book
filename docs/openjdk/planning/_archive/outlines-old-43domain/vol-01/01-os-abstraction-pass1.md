# OS 抽象层 — Pass 0+1 探索笔记

> vol-01 · 域 01 · 🔴 A | 2026-08-07

## Pass 0: 设计上下文

**关键 git 提交**：
- `75bd1e4790` cgroup v1/v2 检测重构（不再依赖 `/proc/cgroups`），修复 `cgroup.controllers` 使用、File Leak
- `ff759fc8fd` 线程栈不再使用大页（huge pages 与栈交互的坑）
- `b49e8b282c` glibc 2.27+ 的线程栈保护页计算修正
- `de91323ed2` 容器内存限制可能超过物理内存——Docker 配置错误时保护

**演进趋势**：容器感知（2018-2024 持续修改）是 OS 层最活跃的子域；信号处理和线程管理相对稳定（JDK8 时代已定型）。

**测试文件**：无（OS 层无独立单元测试——与内核交互，依赖集成环境验证）。

## Pass 1: 结构扫描

### 包结构
```
share/runtime/
  os.hpp (893行) — os: AllStatic 主类，304 static 方法
  os.cpp (468行) — 初始化、信号支持
  os.inline.hpp — 内联平台分派
  osThread.hpp/cpp — OS 线程对象

os/linux/
  os_linux.cpp (6801行) — Linux pd_* 实现体
  os_linux.hpp — Linux 友元类 + 静态字段
  cgroupSubsystem_linux.hpp/cpp — cgroup 抽象层（v1/v2）
  cgroupV1Subsystem_linux.hpp/cpp — cgroup v1 实现
  cgroupV2Subsystem_linux.hpp/cpp — cgroup v2 实现
  osContainer_linux.hpp/cpp — 容器信息收集
  osThread_linux.hpp/cpp — 线程特定数据

os/posix/
  os_posix.hpp — PlatformEvent/PlatformParker (pthread mutex+cond 基础原语)
  os_posix.cpp — POSIX 共享实现

os_cpu/linux_x86/
  os_linux_x86.cpp (951行) — JVM_handle_linux_signal 信号分发
  thread_linux_x86.hpp/cpp — 线程上下文切换
  atomic_linux_x86.hpp — 原子操作
  orderAccess_linux_x86.hpp — 内存屏障
```

### 架构图
```
          os (AllStatic — share/runtime/os.hpp)
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    Linux:: (friend)  Posix::       osThread
    os_linux.hpp      (PlatformEvent (per-thread
    os_linux.cpp       PlatformParker) OS state)
          │
    ┌─────┴──────────────┐
    ▼                    ▼
CgroupSubsystem      osContainer_linux
  ├─ V1Subsystem       (memory/cpu info)
  └─ V2Subsystem
          │
    ┌─────┴──────┐
    ▼            ▼
os_cpu/linux_x86  cpu/x86
(JVM_handle_     (assembler,
 linux_signal)    register defs)
```

### 基本元素分解

1. **内存原语**：`pd_reserve_memory` → `pd_commit_memory` → `pd_release_memory` 三段式 + `mmap`/`mprotect`/`munmap` (`os_linux.cpp:3212/3842`)
2. **线程原语**：`pd_create_thread` → `pthread_create` 包装，含栈大小计算/NMT注册/ThreadLocalStorage (`os_linux.cpp:939`)
3. **信号原语**：`install_signal_handlers` + libjsig 协作 + `JVM_handle_linux_signal` 分发(`os_linux_x86.cpp:268`)
4. **容器感知**：`init_container_support` → cgroup v1/v2 检测 → 读 `/sys/fs/cgroup/memory/memory.limit_in_bytes` (`cgroupV1Subsystem_linux.cpp:91`)
5. **同步原语**：`PlatformEvent` (pthread_cond) + `PlatformParker` (pthread_mutex+cond) (`os_posix.hpp:170/205`)
6. **系统信息**：`available_memory`/`active_processor_count`/`processor_id` (`os_linux.hpp:76-77`)
7. **NUMA**：`libnuma_dlsym` 动态加载 + `numa_set_bind_policy(MPOL_PREFERRED)` (`os_linux.cpp:3477`)

### 标记问题（≥5）

1. **为什么 reserve+commit 分开？** Java 堆需要连续地址空间（compressed oops 要求），reserve 先占坑、commit 按需分配——这个设计的 tradeoff 是什么？如果物理内存不够 commit 怎么办？

2. **信号处理中的 polling page 怎么和安全点机制交互？** `safepointMechanism.cpp:52-63` 创建 bad_page/good_page，线程读到 bad_page 触发 SIGSEGV——但线程检查 polling page 的频率是多少？在什么指令位置检查？

3. **容器感知为什么有两个 cgroup 版本？** v1 用 per-controller 挂载点（`/sys/fs/cgroup/memory/`），v2 用统一层级（`/sys/fs/cgroup/`）。JDK11 如何自动检测版本？检测失败会怎样？

4. **libjsig 和 JVM 信号处理的协作机制是什么？** `os_linux.cpp:5192` 设 `libjsig_is_loaded = true`——这个标志位如何影响后续 signal handler 安装？应用自己的 SIGSEGV handler 如何不被吞掉？

5. **PlatformEvent/PlatformParker 为什么要分两个类？** `os_posix.hpp:170/205`——一个管"等待通知"（pthread_cond），一个管"等待+互斥"（pthread_mutex+cond）。JVM 内部谁用 PlatformEvent，谁用 PlatformParker？

6. **NUMA 为什么用 dlopen 而不静态链接？** `os_linux.cpp:3425` 用 `dlvsym` 查 `libnuma_1.1` 版本——如果没有 libnuma.so 会怎样？为什么不用 `-lnuma` 编译时链接？

7. **线程栈大小计算中 glibc 版本差异怎么处理？** `os_linux.cpp:865-890` 检测 `pthread_getattr_np` + 最小栈大小——glibc 2.27 之后行为变了，JVM 怎么兼容？
