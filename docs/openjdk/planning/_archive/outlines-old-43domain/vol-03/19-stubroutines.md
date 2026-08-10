# StubRoutines（桩程序）— 文章大纲

> vol-03 · 域 19 · 🟡 B | 拓扑排序 #19
> 依赖：Assembler + CodeCache
>
> **→ 从 CodeCache**：CodeCache 是代码的"堆"——但堆里放的是编译后的 Java 方法。还有一种代码不是 Java 方法编译来的——是 JVM 启动时用 MacroAssembler 手工生成的几百字节 stub。StubRoutines 篇。

## 叙事计划

**开篇场景**：Java 方法调 native 方法——不是直接跳过去。中间需要一个"适配器"把 Java 调用约定的寄存器映射到 C 调用约定。JVM 在启动时用 `StubGenerator` 生成这些适配器——几百字节的小段机器码（stub），存在 CodeCache 里，每次 JNI 调用走一遍。StubRoutines 就是这些预生成代码的管理器。

**第一层：StubGenerator——用 MacroAssembler 生成 stub**

`StubGenerator`（`stubCodeGenerator.hpp:97`，持有 `MacroAssembler* _masm`）是平台特定的——x86 实现在 `cpu/x86/stubGenerator_x86_64.cpp`。在 JVM 初始化时生成各种 stub：`generate_call_stub()`（Java 调 native 的入口，`:208`）、`generate_atomic_cmpxchg_long()`（CAS 的汇编实现，`:656`）等。

`StubCodeGenerator` 是 RAII 包装——构造时设 CodeBuffer，析构时把生成的代码 flush 到 CodeCache。生成的 stub 返回一个 `address`——之后 C++ 代码直接 `call(stub_address)` 跳转。

**第二层：StubRoutines——全局 stub 注册表**

`StubRoutines`（`stubRoutines.hpp`）用一堆全局函数指针管理所有已生成的 stub 地址：`_call_stub_return_address`、`_forward_exception_entry`、`_atomic_cmpxchg_long_entry` 等。`stubRoutines_init1()` 和 `stubRoutines_init2()`（两阶段初始化——`universe_init()` 前后分别调用）填充这些指针。

**设计权衡**

一、预生成 vs 运行时动态生成。预生成 stub 避免每次调用都完整生成适配器——几百字节的 stub 在 CodeCache 里常驻。代价是 CodeCache 空间占用——但 stub 总量通常 <1MB。

二、Initialize vs lazy init。一次性初始化所有 stub 确保 JVM 启动后即时可用。代价是启动时间多了一些 stub 生成——但 stub 生成很快（几百行 MacroAssembler）。

## 核心悬念

**Java 调 native 方法时中间发生了什么——不是直接跳转，是几段预生成的 stub 做参数搬移、调用转换、异常处理。**

**→ 下一域**：stub 也到位了、CodeCache 也管好了——现在看 JVM 默认的 GC 算法：G1。不是传统的分代模型——堆被切成 2048 个 Region，每次回收只挑垃圾最多的那几个。G1 GC 篇见。

## 预估

1 篇，2 层递进，预估 1000-1200 行。
