# 15 init_globals 衔接——门面初始化：GC 屏障桩、JIT 阈值、标志位与寄存器名

> **本文定位**：`init_globals()` 第 10-13、15-16 步——在 `universe_init`（宇宙内核就绪）与 `interpreter_init`（解释器模板上架）之间，完成五项门面级初始化：GC 屏障汇编桩、JIT 编译触发阈值、JVM_ACC 标识位、调试 GC 压力和寄存器命名。这五步中只有一个是"大"的（JIT 阈值），其余四项都是一句话级别的死数据配置——但它们共同构成了解释器和 JIT 编译器"出手"前的最后一组门面就绪。
>
> **前置依赖**：[ch12 三表就绪](openjdk/vol-01/ch12/02-string-table-create.md)、[ch10 G1 BarrierSet](openjdk/vol-01/ch10)、[ch09 universe_init](openjdk/vol-01/ch09)

---

## 0. 全景——五个衔接调用的职责和顺序

```
init_globals():
   9: universe_init()             ← ch09+ch10+ch12 覆盖完毕
  10: gc_barrier_stubs_init()     ← 本章 §1
  11: interpreter_init()          → ch14（本章暂不展开）
  12: invocationCounter_init()    ← 本章 §2
  13: accessFlags_init()          ← 本章 §3
  14: templateTable_init()        → ch14
  15: InterfaceSupport_init()     ← 本章 §4
  16: VMRegImpl::set_regName()    ← 本章 §5
  17: SharedRuntime::generate_stubs()  → ch17
```

| 步 | 函数 | 源头 | 实质 | 规模 |
|---|------|------|------|------|
| 10 | gc_barrier_stubs_init | barrierSet.cpp:44 | 委托 BarrierSetAssembler 生成屏障汇编代码 | 1 行 |
| 12 | invocationCounter_init | invocationCounter.cpp:169 | 设置三个 JIT 编译触发阈值 | 重初始化（非平凡） |
| 13 | accessFlags_init | accessFlags.cpp:74 | 断言 sizeof(AccessFlags)==4 | 1 行 |
| 15 | InterfaceSupport_init | interfaceSupport.cpp:264 | 调试 GC 压力随机种子（仅 ASSERT 模式） | 4 行 |
| 16 | VMRegImpl::set_regName | vmreg_x86.cpp:31 | 填充 CPU 寄存器名称数组 | ~30 行 |

---

## 1. gc_barrier_stubs_init——GC 屏障的汇编代码生成

### 1.1 源码

```cpp
void gc_barrier_stubs_init() {
  BarrierSet* bs = BarrierSet::barrier_set();
#ifndef ZERO
  BarrierSetAssembler* bs_assembler = bs->barrier_set_assembler();
  bs_assembler->barrier_stubs_init();
#endif
}
```

### 1.2 逐行解释

- **获取 `BarrierSet`**：`barrier_set()` 返回全局单例——在 `universe_init` 里 G1 已经把 `G1BarrierSet` 创建并注册好了
- **获取汇编器**：`barrier_set_assembler()` 返回具体 GC 的汇编代码生成器——G1 返回 `G1BarrierSetAssembler`
- **生成桩代码**：`barrier_stubs_init()` 生成 GC 屏障的汇编桩——包括写屏障（card mark）和 SATB 屏障。这些桩代码会被 JIT 编译器和解释器内联到 Java 代码的引用写入点

### 1.3 G1 屏障桩如何被用到

```
引用写入点（Java 代码 obj.field = value）:
  JIT/解释器 → 插入调用 → 屏障桩（barrier stub）
    → 写屏障: 将 card table 中对应字节标记为 dirty
    → SATB 屏障: 将旧值推入 SATB 队列
```

---

## 2. invocationCounter_init——JIT 编译阈值的建立

### 2.1 源码

```cpp
void invocationCounter_init() {
  InvocationCounter::reinitialize(DelayCompilationDuringStartup);
}
```

### 2.2 reinitialize——三个阈值的公式

```cpp
void InvocationCounter::reinitialize(bool delay_overflow) {
  // 状态机初始化
  def(wait_for_nothing, 0, do_nothing);
  if (delay_overflow) {
    def(wait_for_compile, 0, do_decay);          // 延迟编译——计数器衰减
  } else {
    def(wait_for_compile, 0, dummy_invocation_counter_overflow);
  }

  // 三个触发阈值
  InterpreterInvocationLimit = CompileThreshold << number_of_noncount_bits;
  InterpreterProfileLimit =
    ((CompileThreshold * InterpreterProfilePercentage) / 100) << number_of_noncount_bits;

  if (ProfileInterpreter) {
    // Profiling 模式下回边由 MethodData 计数器触发，不走 InvocationCounter 计数位段——不 << shift
    InterpreterBackwardBranchLimit =
      (CompileThreshold * (OnStackReplacePercentage - InterpreterProfilePercentage)) / 100;
  } else {
    // 默认路径（ProfileInterpreter 默认 false）——走移位计数
    InterpreterBackwardBranchLimit =
      ((CompileThreshold * OnStackReplacePercentage) / 100) << number_of_noncount_bits;
  }
}
```

### 2.3 三个阈值各自的角色

| 阈值 | 含义 | 触发什么 | 默认值（64 位 `CompileThreshold=10000`） |
|------|------|---------|------|
| `InterpreterInvocationLimit` | 方法被调多少次后让 JIT 接手 | 方法级编译（C1 或 C2） | 10000 << shift |
| `InterpreterBackwardBranchLimit` | 循环回边多少次后走 OSR | 栈上替换（On-Stack Replacement） | ≈ 14000 |
| `InterpreterProfileLimit` | Profiling 多少次后检查阈值 | 触发 Profiling 记录的收集 | 约 2000 |

### 2.4 delay_overflow 的语义——启动期间缓编译

`DelayCompilationDuringStartup` 默认 true——在 `def(wait_for_compile, 0, do_decay)` 中将计数器衰减。启动期大量类加载和方法解析会触发"假"的计数器超限——衰减策略让计数器按一定比率回落，给解释器足够时间在启动完成后再触发 JIT。

### 2.5 与 interpreter_init 的关系——已在解释器初始化中执行

`AbstractInterpreter::initialize()` 内部**已调用**了 `InvocationCounter::reinitialize(DelayCompilationDuringStartup)`——而 `init_globals` 中 `interpreter_init`（第 11 步）在 `invocationCounter_init`（第 12 步）**之前**。所以实际上阈值在第 11 步时已初始化完成，第 12 步是防御性重复调用——两次调用参数完全一致，无副作用。

---

## 3. accessFlags_init——JVM_ACC 原子位的存活断言

### 3.1 源码

```cpp
void accessFlags_init() {
  assert(sizeof(AccessFlags) == sizeof(jint), "just checking size of flags");
}
```

### 3.2 解释

`AccessFlags` 是每个类/方法/字段的修饰符位集——public/protected/static/final 等的"原子位压缩标记"。它必须是 4 字节（与 JVM_ACC_* 常量位域一致）。这个"初始化"只是编译时断言——确认结构体大小正确。

---

## 4. InterfaceSupport_init——调试 GC 压力（仅 ASSERT）

### 4.1 源码

```cpp
void InterfaceSupport_init() {
#ifdef ASSERT
  if (ScavengeAlot || FullGCALot) {
    srand(ScavengeAlotInterval * FullGCAlotInterval);
  }
#endif
}
```

### 4.2 解释

生产环境（`ASSERT` 未定义）下一句空函数。`ScavengeAlot`/`FullGCAlot` 是调试选项——每个 safepoint 或分配内存间隙都触发一次 Young GC 或 Full GC，用于压力测试 GC 子系统和安全点协调机制。`srand` 为两个间隔值设置随机种子。

---

## 5. VMRegImpl::set_regName——寄存器名称注册

### 5.1 源码

```cpp
void VMRegImpl::set_regName() {
  Register reg = ::as_Register(0);
  int i;
  for (i = 0; i < ConcreteRegisterImpl::max_gpr; ) {
    regName[i++] = reg->name();       // "RAX", "RBX", ...
#ifdef AMD64
    regName[i++] = reg->name();
#endif
    reg = reg->successor();           // 下一个通用寄存器
  }

  FloatRegister freg = ::as_FloatRegister(0);
  for (; i < ConcreteRegisterImpl::max_fpr; ) {
    regName[i++] = freg->name();
    regName[i++] = freg->name();
    freg = freg->successor();
  }

  XMMRegister xreg = ::as_XMMRegister(0);
  for (; i < ConcreteRegisterImpl::max_xmm; ) {
    regName[i++] = xreg->name();      // "XMM0", "XMM1", ...
    regName[i++] = xreg->name();
    xreg = xreg->successor();
  }
}
```

### 5.2 解释

`regName[i]` 是全局静态字符串数组——JVM 用它在打印诊断信息（OopMap、栈帧解码、JIT 调试输出）时将寄存器编号转为人可读的名称。三类寄存器依次填充：

| 寄存器类 | 例子 | 用途 |
|---------|------|------|
| 通用寄存器（GPR） | RAX, RBX, RCX, ... | 方法参数、局部变量、操作数 |
| 浮点寄存器（FPR） | ST0, ST1, ... (x87) | 浮点操作 |
| XMM 寄存器 | XMM0-XMM15 | SSE/AVX 向量操作 |

每个寄存器占两个槽位（`regName[i++] = name; regName[i++] = name;`）——支持 64 位 VMReg 的双注册编码表示。

---

## 6. 小结——init_globals 衔接层的角色

```
init_globals 衔接层:
  gc_barrier_stubs_init   → 生成 GC 屏障桩（G1 写屏障/JIT 内联的基础）
  invocationCounter_init  → 设置 JIT 阈值（三个 limit + 启动衰减）
  accessFlags_init        → 断言修饰符大小（一条 assert）
  InterfaceSupport_init   → 调试 GC 压测配置（仅 ASSERT 模式）
  VMRegImpl::set_regName  → 寄存器名称表（诊断打印用）

一句话: 这五步是"门面初始化"——全部是死数据的预配或委托桩生成，
        没有分配 Java 对象、没有创建线程、没有任何"创世"概念——
        它们的存在使得解释器和 JIT 可以立刻拿到正确的阈值、
        屏障桩、标志位大小，直接"上架"。
```
