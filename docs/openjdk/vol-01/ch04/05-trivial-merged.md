# 4.5 四个 trivial 函数合并

4.4 讲了 `classLoader_init1` 和 `os_init_globals`。接下来 init_globals 里的代码涉及编译策略、代码缓存、CPU 检测等重量级子系统，那些放到后续章节。本节合并讲 4 个 trivial 函数——它们在 init_globals 里散布在不同位置，每个只有几行，但背后各有小机制。

---

## accessFlags_init：一个 sizeof 断言

```cpp
/* === src/hotspot/share/utilities/accessFlags.cpp:74 === */

void accessFlags_init() {
  assert(sizeof(AccessFlags) == sizeof(jint), "just checking size of flags");
}
```

就一行断言：确认 `AccessFlags` 类的大小等于 `jint`（4 字节）。

### AccessFlags 类

`AccessFlags` 用一个 `jint`（32 位）存储类/方法/字段的访问标志。你在 Java 里写的 `public static final` 编译成 class 文件后就是这些位：

```cpp
/* === src/hotspot/share/utilities/accessFlags.hpp:102 === */

class AccessFlags {
 private:
  jint _flags;                          // 唯一的字段，32 位
 public:
  bool is_public()    const { return (_flags & JVM_ACC_PUBLIC) != 0; }
  bool is_private()   const { return (_flags & JVM_ACC_PRIVATE) != 0; }
  bool is_static()    const { return (_flags & JVM_ACC_STATIC) != 0; }
  // ... 几十个 is_xxx() 方法
  void atomic_set_bits(jint bits);
  void atomic_clear_bits(jint bits);
};
```

整个类**只有一个字段** `jint _flags`，没有虚函数，没有其他成员。断言就是确保这一点——如果有人加了虚函数（会有 vtable 指针，多 8 字节）或其他字段，`sizeof` 就不等于 4 了。

### 三组标志位

32 位分成三组（`accessFlags.hpp:36-98`）：

**Java 标准标志（低 16 位）**——写在 class 文件里的，Java 规范定义的：

| 标志 | 值 | 含义 |
|------|------|------|
| `JVM_ACC_PUBLIC` | 0x0001 | public |
| `JVM_ACC_PRIVATE` | 0x0002 | private |
| `JVM_ACC_PROTECTED` | 0x0004 | protected |
| `JVM_ACC_STATIC` | 0x0008 | static |
| `JVM_ACC_FINAL` | 0x0010 | final |
| `JVM_ACC_SYNCHRONIZED` | 0x0020 | synchronized |
| `JVM_ACC_NATIVE` | 0x0100 | native |
| `JVM_ACC_ABSTRACT` | 0x0400 | abstract |
| ... | ... | ... |

**HotSpot 内部标志（高 16 位）**——不出现在 class 文件里，JVM 运行时自己用的。按用途分三类：

Method 标志（方法的）：
- `JVM_ACC_QUEUED`（0x01000000）——排队等编译
- `JVM_ACC_NOT_C2_COMPILABLE`（0x02000000）——不允许 C2 编译
- `JVM_ACC_HAS_MONITOR_BYTECODES`（0x20000000）——含 synchronized 字节码
- `JVM_ACC_IS_OLD`（0x00010000）——RedefineClasses 替换过
- `JVM_ACC_IS_OBSOLETE`（0x00020000）——RedefineClasses 废弃
- `JVM_ACC_ON_STACK`（0x00080000）——栈上还有引用（不能删）

Klass 标志（类的）：
- `JVM_ACC_HAS_FINALIZER`（0x40000000）——有 finalize() 方法
- `JVM_ACC_IS_CLONEABLE_FAST`（0x80000000）——实现 Cloneable 可优化
- `JVM_ACC_IS_SHARED_CLASS`（0x02000000）——CDS 共享类

Field 标志（字段的）：
- `JVM_ACC_FIELD_ACCESS_WATCHED`（0x00002000）——JVMTI 监视字段访问
- `JVM_ACC_FIELD_STABLE`（0x00000020）——@Stable 注解

### CAS 操作

多线程可能同时修改同一个方法的标志（如编译队列标志 `JVM_ACC_QUEUED`），所以 `atomic_set_bits` / `atomic_clear_bits` 用 CAS 保证原子性（`accessFlags.cpp:30-48`）：

```cpp
void AccessFlags::atomic_set_bits(jint bits) {
  jint old_flags, new_flags, f;
  do {
    old_flags = _flags;
    new_flags = old_flags | bits;
    f = Atomic::cmpxchg(new_flags, &_flags, old_flags);
  } while(f != old_flags);
}
```

`Atomic::cmpxchg` 是 CAS——比较 `_flags` 是否还是 `old_flags`，是就替换成 `new_flags`，不是就重试。

---

## invocationCounter_init：编译阈值计算

```cpp
/* === src/hotspot/share/interpreter/invocationCounter.cpp:169 === */

void invocationCounter_init() {
  InvocationCounter::reinitialize(DelayCompilationDuringStartup);
}
```

转调 `reinitialize()`（`invocationCounter.cpp:138-167`）——设置方法调用的编译阈值：解释器执行一个方法多少次后触发 JIT 编译。

### InvocationCounter 的 _counter 字段

`InvocationCounter` 用一个 `unsigned int _counter` 同时编码计数和状态（`invocationCounter.hpp:44-45`）：

```
_counter（32 位）:  [count | carry | state]
                    |31  3|   2   | 1 0 |
```

| 区域 | 位数 | 含义 |
|------|------|------|
| count | 29 位（bit 3-31） | 方法调用计数 |
| carry | 1 位（bit 2） | 进位标志——一旦设了就不清（sticky），表示计数器曾达到过大值 |
| state | 2 位（bit 0-1） | 状态——`wait_for_nothing`(0) 或 `wait_for_compile`(1) |

`number_of_noncount_bits = 3`（carry 1 位 + state 2 位），所以 `count = _counter >> 3`。

### 三个阈值

`reinitialize()` 计算三个阈值（`invocationCounter.cpp:148-158`）：

```cpp
InterpreterInvocationLimit     = CompileThreshold << number_of_noncount_bits;
InterpreterProfileLimit       = (CompileThreshold * InterpreterProfilePercentage) / 100 << number_of_noncount_bits;
InterpreterBackwardBranchLimit = (CompileThreshold * OnStackReplacePercentage) / 100;
```

| 阈值 | 含义 | 默认值（CompileThreshold=10000） |
|------|------|------|
| `InterpreterInvocationLimit` | 方法调用多少次后触发 JIT 编译 | 10000 |
| `InterpreterProfileLimit` | 调用多少次后开始收集 profile 数据 | 2000（10000 * 20%） |
| `InterpreterBackwardBranchLimit` | 回边分支多少次后触发 OSR（栈上替换）编译 | 14000（10000 * 140%） |

`CompileThreshold` 默认 10000——方法被调用 10000 次后 JIT 编译器把它编译成机器码。`InterpreterProfilePercentage` 默认 20——调用 2000 次后开始收集 profile（哪些分支走得多、哪些类型多），这些数据给 C2 编译器做优化。

`<< number_of_noncount_bits` 是因为计数放在 `_counter` 的高 29 位，阈值也要左移 3 位才能和计数比较。

### 状态机和 carry

两种状态（`invocationCounter.hpp:74-78`）：
- `wait_for_nothing`——不编译（计数溢出也不触发）
- `wait_for_compile`——计数溢出时触发编译

`carry` 位是 sticky 的——一旦方法计数器溢出过一次，carry 位就永久置 1（`invocationCounter.cpp:44-54` 的 `set_carry()`）。这样即使计数器后来被衰减（decay），JVM 仍然知道"这个方法曾经热过"。

### DelayCompilationDuringStartup 和 do_decay

```cpp
if (delay_overflow) {
  def(wait_for_compile, 0, do_decay);     // 启动时：溢出也不编译，只衰减
} else {
  def(wait_for_compile, 0, dummy_invocation_counter_overflow);  // 正常：溢出触发编译
}
```

`DelayCompilationDuringStartup` 是启动时为 true 的 flag——JVM 刚启动时不要急着编译，先让解释器跑，等类加载稳定了再编译。启动完成后重新调 `reinitialize(false)` 切换到正常模式。

`do_decay`（`invocationCounter.cpp:117-123`）——计数器溢出时不立刻编译，而是衰减计数（减半），让方法再跑一段时间。避免"刚启动时大量方法同时触发编译"导致 CPU 飙高。

---

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

`ScavengeALot` 和 `FullGCALot` 是调试 flag——开启后 JVM 在每次分配后随机触发 GC，用来测试代码是否正确处理 GC 移动对象。`srand` 设置随机种子让"随机触发 GC"可复现。

`InterfaceSupport` 模块还提供几个 ASSERT 下的验证器（不在 `InterfaceSupport_init` 初始化，运行时按需使用）：

- **VMEntryWrapper**——从 Java 进入 JVM 代码时检查线程状态是否合法
- **NoSafepointVerifier**——验证 JRT_LEAF 代码段不会触发 safepoint（JRT_LEAF 声明"这个函数不会 GC"）
- **FullGCALot / ScavengeALot / ZombieALot / DeoptimizeALot**——调试设施，随机触发 GC / 僵尸 nmethod / 去优化，专门用来发现并发 bug

这些都是 debug 构建才有的，product 构建里完全不存在。

---

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

### VMRegImpl 是什么

JVM 内部用整数编号表示寄存器（0=RAX, 1=RAX(高32位), 2=RBX, ...），这个编号叫 VMReg。`regName[]` 数组把编号映射到名字字符串——OopMap 打印、OptoReg 分配、调试输出时用来把编号翻译成人类可读的名字（如 "RAX"、"XMM0"）。

### 四类寄存器

按编号区间排列：

| 类型 | 寄存器 | 每个占几个 slot | 为什么 |
|------|--------|----------------|--------|
| GPR（通用） | RAX/RBX/.../R15（16 个） | 2 | 64 位寄存器可拆成两个 32 位（RAX 低 32 位是 EAX），JIT 寄存器分配器按 32 位 slot 分配 |
| FPR（浮点） | ST0-ST7（8 个） | 2 | 同上 |
| XMM（SSE/AVX） | XMM0-XMM15（16 个） | `max_slots_per_register` | XMM 寄存器更宽（128/256/512 位），按更细的 slot 分 |
| KRegister（AVX-512 掩码） | K0-K7（8 个） | `max_slots_per_register` | AVX-512 的掩码寄存器 |

### 为什么源码在 cpu/x86 不在 share

这个函数在 `cpu/x86/vmreg_x86.cpp` 而不是 `share/`——因为不同 CPU 架构的寄存器不一样（ARM 有 VFP/NEON 寄存器，x86 有 XMM/KRegister）。但调用在 `share/` 的 `init.cpp:122`——`init_globals()` 调 `VMRegImpl::set_regName()`，编译时链接到当前平台的实现。
