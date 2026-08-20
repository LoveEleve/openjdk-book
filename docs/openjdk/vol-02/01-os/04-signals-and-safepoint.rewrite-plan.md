# 04-signals-and-safepoint 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：把“一个 SIGSEGV 的五种分流”写成一篇关于 fault 地址解释器与低成本协作机制的专题文

## 1. 读者困惑

SIGSEGV 通常意味着进程崩溃，为什么 HotSpot 却能用同一个信号完成栈溢出、safepoint、隐式空指针、内存序列化和真正崩溃五种完全不同的事情？

## 2. 一句话顿悟

**信号本身没有语义，HotSpot 通过 fault 地址、当前线程、PC 和上下文把同一个 SIGSEGV 解释成不同事件；正常路径用不可访问页换取低成本检查，异常路径再由统一 handler 负责分流。**

## 3. 结构

1. 事故开场：一个信号为什么不能直接等于崩溃
2. 信号 handler 手里有什么：sig、si_addr、PC、ucontext、当前线程
3. 第一分流：栈保护区与 StackOverflowError
4. 第二分流：polling page 与 safepoint
5. 第三分流：JIT 隐式 null check
6. 第四分流：memory serialize page
7. 最终分流：hs_err 与真正崩溃
8. libjsig 信号链与 kill -3
9. 总图收网：地址分类器 + 低成本 page fault 机制

## 4. 必须展开的失败方案

- 每个机制安装独立 SIGSEGV handler，导致互相覆盖
- 每次 poll 都读取普通 flag 并分支
- JIT 为每次 null check 生成显式比较跳转
- 把所有 SIGSEGV 都当成可恢复异常
- safepoint handler 不检查 fault 地址和 PC

## 5. 证据清单

- `os_cpu/linux_x86/os_linux_x86.cpp:268`：统一信号入口
- `:357-397`：栈溢出分流
- `:431`：polling page 分流
- `:483-485`：隐式 null 分流
- `:508-510`：memory serialize page 分流
- `:617` 附近：VMError 崩溃路径
- `os_linux.cpp:5177`：libjsig 安装与信号链
- `os.hpp:427-431`：polling page 判定
- `os_linux.cpp:5720`：polling page 保护
- `os.cpp:339/361`：SIGBREAK 与 kill -3

## 6. 版本与边界

- 结论限定为 OpenJDK 11u Linux x86_64 HotSpot
- `test [polling_page], rax` 的机器码尺寸与性能数字依赖汇编器、CPU 和代码形态
- TLB shootdown 与内存序列化页的解释应区分源码事实和硬件机制推导
- 信号链不能保证第三方 handler 一定安全，libjsig 只提供协作机制

## 7. 字数预算

- 正文目标：`9000-13000`
- 叙述性正文目标：`6000+`

## 8. 完成后检查

- 删除代码后仍能复述五阶段分流
- 每段代码前有动机
- 明确区分 JVM 可解释 fault 与真正 crash
- 至少 3 个失败方案完整推演
- 禁用词、版本边界、file:line 全部复核
