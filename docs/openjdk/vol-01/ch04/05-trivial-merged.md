# 4.5 四个 trivial 函数合并

4.4 讲了 `classLoader_init1` 和 `os_init_globals`。接下来 init_globals 里的代码涉及编译策略、代码缓存、CPU 检测等重量级子系统，那些放到后续章节。本节合并讲 4 个 trivial 函数——它们在 init_globals 里散布在不同位置，每个只有几行，但背后各有小机制。

## accessFlags_init：一个 sizeof 断言

```cpp
/* === src/hotspot/share/utilities/accessFlags.cpp:74 === */

void accessFlags_init() {
  assert(sizeof(AccessFlags) == sizeof(jint), "just checking size of flags");
}
```

就一行断言：确认 `AccessFlags` 类的大小等于 `jint`（4 字节）。

`AccessFlags` 是什么？它用一个 `jint`（32 位）的位域存储类/方法/字段的访问标志。你在 Java 代码里写的 `public static final` 等修饰符，编译成 class 文件后就是这些位：

```cpp
/* === src/hotspot/share/utilities/accessFlags.hpp:36 === */

// 写入 class 文件的标准 Java 标志（低 16 位）
JVM_ACC_PUBLIC        = 0x0001,
JVM_ACC_PRIVATE       = 0x0002,
JVM_ACC_PROTECTED     = 0x0004,
JVM_ACC_STATIC        = 0x0008,
JVM_ACC_FINAL         = 0x0010,
JVM_ACC_SYNCHRONIZED  = 0x0020,
// ...

// HotSpot 内部标志（高 16 位，不出现在 class 文件里）
JVM_ACC_IS_OLD        = 0x00010000,  // RedefineClasses 替换过
JVM_ACC_IS_OBSOLETE   = 0x00020000,  // RedefineClasses 废弃
JVM_ACC_ON_STACK      = 0x00080000,  // 栈上还有引用
JVM_ACC_QUEUED        = 0x01000000,  // 排队等编译
JVM_ACC_NOT_C2_COMPILABLE = 0x02000000,  // 不允许 C2 编译
// ...
```

低 16 位是 Java 规范定义的（public/private/static 等），高 16 位是 HotSpot 内部用的（编译队列、RedefineClasses 状态等）。

这个断言确保 `AccessFlags` 类**没有任何额外字段**——只有那一个 `jint _flags`。如果有人给 `AccessFlags` 加了虚函数表指针（vtable pointer）或其他字段，`sizeof(AccessFlags)` 就不等于 `sizeof(jint)` 了，断言会失败。这是一个"防止误修改"的编译期保护。

`AccessFlags` 还提供了 `atomic_set_bits` / `atomic_clear_bits`（`accessFlags.cpp:30-48`）——用 CAS 操作原子地设置/清除标志位。因为多个线程可能同时修改同一个方法的标志（如编译队列标志），所以用 `Atomic::cmpxchg` 保证原子性。

## invocationCounter_init：编译阈值计算

```cpp
/* === src/hotspot/share/interpreter/invocationCounter.cpp:169 === */

void invocationCounter_init() {
  InvocationCounter::reinitialize(DelayCompilationDuringStartup);
}
```

转调 `reinitialize()`（`invocationCounter.cpp:138-167`），做的事：设置方法调用的编译阈值——解释器执行一个方法多少次后触发 JIT 编译。

### 三个阈值

```cpp
/* === src/hotspot/share/interpreter/invocationCounter.cpp:148-158 === */

InterpreterInvocationLimit     = CompileThreshold << number_of_noncount_bits;
InterpreterProfileLimit       = (CompileThreshold * InterpreterProfilePercentage) / 100 << number_of_noncount_bits;
InterpreterBackwardBranchLimit = (CompileThreshold * OnStackReplacePercentage) / 100;
```

| 阈值 | 含义 | 默认值 |
|------|------|--------|
| `InterpreterInvocationLimit` | 方法被调用多少次后触发 JIT 编译 | `CompileThreshold`（默认 10000） |
| `InterpreterProfileLimit` | 方法被调用多少次后开始收集 profile 数据 | `CompileThreshold * InterpreterProfilePercentage / 100`（默认 10000 * 20 / 100 = 2000） |
| `InterpreterBackwardBranchLimit` | 回边分支执行多少次后触发 OSR（栈上替换）编译 | `CompileThreshold * OnStackReplacePercentage / 100`（默认 10000 * 140 / 100 = 14000） |

`CompileThreshold` 是 JVM flag，默认 10000——方法被调用 10000 次后 JIT 编译器会把它编译成机器码。`InterpreterProfilePercentage` 默认 20——方法被调用 2000 次后开始收集 profile（哪些分支走得多、哪些类型多），这些 profile 数据给 C2 编译器做优化用。

### 状态机

```cpp
def(wait_for_nothing, 0, do_nothing);
if (delay_overflow) {
  def(wait_for_compile, 0, do_decay);
} else {
  def(wait_for_compile, 0, dummy_invocation_counter_overflow);
}
```

`InvocationCounter` 有两种状态：
- `wait_for_nothing`——不编译（计数器溢出也不触发编译）
- `wait_for_compile`——计数器溢出时触发编译

`DelayCompilationDuringStartup` 是启动时为 true 的 flag——JVM 刚启动时不要急着编译，先让解释器跑一会儿，等类加载稳定了再开始编译。启动完成后重新调 `reinitialize(false)` 切换到正常模式。

`do_decay` 是延迟编译的机制——计数器溢出时不是立刻编译，而是衰减计数（减半），让方法再跑一段时间。这样能避免"刚启动时大量方法同时触发编译"导致 CPU 飙高。

## InterfaceSupport_init：调试随机种子

```cpp
/* === src/hotspot/share/runtime/interfaceSupport.cpp:264 === */

void InterfaceSupport_init() {
#ifdef ASSERT
  if (ScavengeALot || FullGCALot) {
    srand(ScavengeALotInterval * FullGCALotInterval);
  }
#endif
}
```

只有 `#ifdef ASSERT` 下才有代码——product 构建里这个函数是空的。

`ScavengeALot` 和 `FullGCALot` 是调试 flag——开启后 JVM 会在每次分配后随机触发 GC（young GC 或 full GC），用来测试代码是否正确处理 GC 移动对象。这行 `srand` 设置随机种子，让"随机触发 GC"的随机性可复现。

`InterfaceSupport` 这个模块还提供几个 ASSERT 下的验证器（都不在 `InterfaceSupport_init` 里初始化，而是在运行时按需使用）：
- `VMEntryWrapper`——从 Java 进入 JVM 时检查线程状态
- `NoSafepointVerifier`——验证 JRT_LEAF 代码段不会触发 safepoint
- `FullGCALot` / `ScavengeALot` / `ZombieALot` / `DeoptimizeALot`——调试设施，随机触发 GC / 僵尸 nmethod / 去优化

## VMRegImpl::set_regName：寄存器名表

```cpp
/* === src/hotspot/cpu/x86/vmreg_x86.cpp:31 === */

void VMRegImpl::set_regName() {
  Register reg = ::as_Register(0);
  int i;
  // GPR（通用寄存器）：RAX/RBX/RCX/RDX/RSI/RDI/RBP/RSP/R8-R15
  for (i = 0; i < ConcreteRegisterImpl::max_gpr ; ) {
    regName[i++] = reg->name();
    regName[i++] = reg->name();   // AMD64 双 slot
    reg = reg->successor();
  }
  // FPR（浮点寄存器）：ST0-ST7
  FloatRegister freg = ::as_FloatRegister(0);
  for ( ; i < ConcreteRegisterImpl::max_fpr ; ) {
    regName[i++] = freg->name();
    regName[i++] = freg->name();
    freg = freg->successor();
  }
  // XMM（SSE/AVX 寄存器）：XMM0-XMM15
  XMMRegister xreg = ::as_XMMRegister(0);
  for (; i < ConcreteRegisterImpl::max_xmm;) {
    for (int j = 0 ; j < XMMRegisterImpl::max_slots_per_register ; j++) {
      regName[i++] = xreg->name();
    }
    xreg = xreg->successor();
  }
  // KRegister（AVX-512 掩码寄存器）：K0-K7
  KRegister kreg = ::as_KRegister(0);
  for (; i < ConcreteRegisterImpl::max_kpr;) {
    for (int j = 0; j < KRegisterImpl::max_slots_per_register; j++) {
      regName[i++] = kreg->name();
    }
    kreg = kreg->successor();
  }
  // 剩余的填占位符
  for ( ; i < ConcreteRegisterImpl::number_of_registers ; i ++ ) {
    regName[i] = "NON-GPR-FPR-XMM-KREG";
  }
}
```

填充 `regName[]` 数组——把每个寄存器编号映射到名字字符串（如 "RAX"、"XMM0"）。这个数组在 OopMap 打印、OptoReg 分配、调试输出时用来把编号翻译成人类可读的名字。

四类寄存器按编号区间排列：

| 类型 | 寄存器 | 数量 | 每个占几个 slot |
|------|--------|------|----------------|
| GPR（通用） | RAX/RBX/.../R15 | 16 | 2（AMD64 双 slot） |
| FPR（浮点） | ST0-ST7 | 8 | 2 |
| XMM（SSE/AVX） | XMM0-XMM15 | 16 | `max_slots_per_register` |
| KRegister（AVX-512 掩码） | K0-K7 | 8 | `max_slots_per_register` |

AMD64 下 GPR 为什么占 2 个 slot？因为 64 位寄存器可以拆成两个 32 位用（如 RAX 的低 32 位是 EAX），JIT 编译器的寄存器分配器按 32 位 slot 分配，所以 64 位寄存器占 2 个 slot。

这个函数的源码在 `cpu/x86/vmreg_x86.cpp` 而不是 `share/`——因为不同 CPU 架构的寄存器不一样（ARM 有 VFP/NEON 寄存器，x86 有 XMM/KRegister）。但调用在 `share/` 的 `init.cpp:122`——`init_globals()` 调 `VMRegImpl::set_regName()`，编译时链接到当前平台的实现。
