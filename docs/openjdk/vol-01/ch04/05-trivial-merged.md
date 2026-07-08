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

### 谁持有 AccessFlags 对象

`AccessFlags` 被三处复用——Method、Klass 各自内嵌一个 `AccessFlags` 对象，Field 只存低 16 位：

```cpp
// method.hpp:79
AccessFlags       _access_flags;        // Method 里有完整的 AccessFlags 对象（4 字节）

// instanceKlass.hpp
AccessFlags       _access_flags;        // Klass 里也有完整的 AccessFlags 对象（4 字节）

// fieldInfo.hpp:195
void set_access_flags(u2 val) { _shorts[access_flags_offset] = val; }
                                            // Field 只存 u2（2 字节，只要低 16 位）
```

为什么 Field 只要低 16 位？因为字段不需要 HotSpot 内部标志（不需要"排队等编译""RedefineClasses 状态"等），只要 Java 标准的 public/private/static/volatile 等，这些全在低 16 位。而 Method 和 Klass 需要高 16 位的 HotSpot 内部标志，所以用完整的 `AccessFlags` 对象。

同一个 `AccessFlags` 类，放在 Method 里就是方法标志，放在 Klass 里就是类标志——具体用哪些位取决于它被谁持有。断言 `sizeof(AccessFlags) == sizeof(jint)` 保护的就是 Method 和 Klass 里这个 4 字节字段——确保不会因为误加虚函数变成 8 字节，破坏 Method/Klass 的内存布局。

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

### DelayCompilationDuringStartup 参数

参数 `DelayCompilationDuringStartup` 是 `reinitialize()` 的入参，控制启动时编译器的行为。它是个 `develop` flag（`globals.hpp:1378`），默认 `true`：

```cpp
develop(bool, DelayCompilationDuringStartup, true,
        "Delay invoking the compiler until main application class is loaded")
```

意思是"延迟编译——直到主应用类加载完才开始编译"。为什么需要它？JVM 启动时要加载几百个 JDK 核心类（`java.lang.Object`、`java.lang.String` 等），这些类的方法会被频繁调用，计数器很快达到阈值。如果此时就触发 JIT 编译，CPU 会被编译线程占满，启动反而变慢——而且启动时很多类还没加载完，编译出来的代码可能不完整。

所以启动时传 `true`：计数器溢出时不编译，只调 `do_decay` 衰减（减半），让方法继续跑解释器。等到主应用类加载完，JVM 调 `CompilationPolicy::completed_vm_startup()`（`compilationPolicy.cpp:89`，从 `jni.cpp:442` 的 `FindClass` 触发）把 `_in_vm_startup` 设为 false，然后重新调 `reinitialize(false)` 切换到正常模式——计数器溢出就真正触发编译。

### InvocationCounter 的 _counter 字段

`InvocationCounter` 用一个 32 位整数 `_counter` 同时存三样东西——方法调用次数、进位标志、状态：

```
_counter（32 位）:
  bit 0-1: state（状态，2 位）
  bit 2:  carry（进位标志，1 位）
  bit 3-31: count（调用计数，29 位）
```

为什么要塞在一个 int 里？注释说"For space reasons"——因为 `InvocationCounter` 嵌在 `MethodCounters` 对象里，每个方法都有一个，省 1 个字段就省很多内存。

**state**（2 位）——就两个值：
- `wait_for_nothing`（0）——不编译
- `wait_for_compile`（1）——计数器溢出时触发编译

**carry**（1 位）——进位标志，sticky 的——一旦设了就不清。

举个具体例子。假设方法 `foo()` 被调了 10000 次，计数器达到阈值——这时候做两件事：

1. 触发编译——让 JIT 把 foo() 编译成机器码
2. 设 carry=1——记住"foo() 曾经热过"

为什么要记住？因为编译完后计数器不会清零，而是被衰减减半（从 10000 变成 5000）。如果后来这个方法很久没被调用，计数可能降到很低。但只要 carry=1，JVM 就知道"它曾经热过，已经编译过了"。

实际用处：如果后来发生了 RedefineClasses（热替换类），旧的编译代码失效了，JVM 要决定"要不要重新编译 foo()"。如果 carry=0（从来没热过），不编译。如果 carry=1（曾经热过），重新编译——因为已经证明过这个方法会频繁调用，没必要等它再攒 10000 次。

简单说：carry 是"曾经热过"的永久标记，让 JVM 下次不用重新从零开始攒计数。

**count**（29 位）——实际的方法调用计数。`count = _counter >> 3`——右移 3 位去掉低 3 位的 state 和 carry，只留计数部分。每次方法被调用，count 加 1（实际上加的是 `count_grain`，也就是 `1 << 3`，这样不会干扰低 3 位）。

所以 `number_of_noncount_bits = 3`——低 3 位不是计数，是状态和 carry。阈值也要左移 3 位才能和 count 比较（因为 count 在高位）。

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

**profile 数据是什么？** 就是你写 Java 代码时 JVM 偷偷帮你收集的"运行时情报"。比如一个方法里有 `if (x instanceof String)` 分支，JVM 会记录"这个分支 90% 的时间走 true"。再比如 `List list = new ArrayList()`，JVM 会记录"这个变量 99% 的时候是 ArrayList 类型"。这些情报叫 profile，给 C2 编译器做优化用。所以 `InterpreterProfileLimit = 2000` 意思是：方法被调 2000 次后开始收集这些情报，攒够了 8000 次再编译，C2 就有了足够的情报做激进优化。

那 C2 怎么用这些情报？举个例子：

```java
if (x instanceof String) {
    // true 分支
} else {
    // false 分支
}
```

C2 看到 profile 说 90% 走 true，编译出来的机器码不会"删掉 else 分支"——而是把 else 分支挪走，留一个"守卫条件"：

```
if (x instanceof String) {   ← 还在，但走不通时会触发 uncommon trap
    // true 分支的机器码（优化过，很快）
}
// 走不通 → uncommon trap → 去优化(deoptimization) → 切回解释器重新执行
```

正常情况（90%）走 true 分支，很快。异常情况（10%）走 false 时会触发**uncommon trap**——JVM 立刻切回解释器，从 if 开始重新执行，走 false 分支。结果是对的，只是慢一点。

这就是"投机优化"——赌你走 true，赌错了就退回解释器跑一次。赌对 90% 的时候赚了速度，赌错 10% 的时候代价是退回解释器。uncommon trap 和去优化的完整机制后续单独讲解，这里只需知道"profile 数据让 C2 敢做投机优化"。

**OSR（On-Stack Replacement，栈上替换）是什么？** 普通 JIT 编译是"方法下一次被调用时用编译版本"。但如果一个方法里有个很长的循环（比如 `while (true) { ... }`），它可能在一次调用里跑很久很久，永远不会返回——普通 JIT 等不到"下一次调用"。OSR 解决这个问题：不用等方法返回，直接在**循环执行过程中**把解释执行的栈帧替换成编译版本的栈帧，接着跑编译后的机器码。`InterpreterBackwardBranchLimit = 14000` 就是触发 OSR 的阈值——回边分支（循环的跳转）执行 14000 次后，在循环中途切换到编译版本。

`<< number_of_noncount_bits` 是因为计数放在 `_counter` 的高 29 位，阈值也要左移 3 位才能和计数比较。

### 状态机和 carry

`reinitialize()` 里用 `def()` 注册两个状态（`invocationCounter.cpp:141-146`）：

```cpp
def(wait_for_nothing, 0, do_nothing);
def(wait_for_compile, 0, do_decay 或 dummy_invocation_counter_overflow);
```

`def(state, init_count, action)` 的三个参数：
- **state**——状态名
- **init_count**——进入这个状态时计数器的初始值（都是 0）
- **action**——计数器溢出（达到阈值）时执行什么动作

`def(wait_for_nothing, 0, do_nothing)` 意思是：状态 `wait_for_nothing` 下，计数器溢出时调 `do_nothing`——什么都不做。什么方法会处于这个状态？被标记为"不编译"的方法——比如 `-XX:CompileCommand=exclude,com.xxx.Foo::bar` 明确排除的方法，或者编译失败过的方法。这些方法即使被调几亿次也不会触发 JIT。

`def(wait_for_compile, 0, ...)` 意思是：状态 `wait_for_compile` 下，计数器溢出时执行的动作取决于 `DelayCompilationDuringStartup`：
- 启动时（`delay_overflow=true`）→ `do_decay`——不编译，衰减计数（减半）让方法继续跑
- 正常时（`delay_overflow=false`）→ `dummy_invocation_counter_overflow`——触发编译

大多数方法默认处于 `wait_for_compile` 状态。

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

JIT 编译器把 Java 方法编译成机器码时，要用 CPU 寄存器。但 JIT 内部不直接用"RAX""XMM0"这些名字——它用**整数编号**：0=RAX，1=RAX的高32位(EAX)，2=RBX，3=EBX，... 这个编号叫 VMReg。

为什么要用编号而不是直接用名字？因为 JIT 编译器要做**寄存器分配**——决定哪些变量放哪个寄存器。分配算法操作的是整数编号，不是字符串名字。比如"把变量 a 分配到寄存器 0，变量 b 分配到寄存器 4"——比"分配到 RAX、分配到 XMM0"方便。

但调试时人需要看名字——"寄存器 0"不知道是什么，"RAX"才看得懂。`regName[]` 数组就是这个翻译表：`regName[0] = "RAX"`，`regName[32] = "XMM0"`。GC 扫描 OopMap 时也要打印"这个寄存器里存的是对象引用"——打印时用 `regName[i]` 而不是裸编号。

### 四类寄存器

编号按区间连续排列：

| 编号区间 | 类型 | 寄存器 | 每个占几个 slot | 为什么 |
|---------|------|--------|----------------|--------|
| 0 开始 | GPR（通用） | RAX/RBX/.../R15（16 个） | 2 | 64 位寄存器可拆成两个 32 位（RAX 低 32 位是 EAX），JIT 寄存器分配器按 32 位 slot 分配 |
| 接着 | FPR（浮点） | ST0-ST7（8 个） | 2 | 同上 |
| 接着 | XMM（SSE/AVX） | XMM0-XMM15（16 个） | `max_slots_per_register` | XMM 寄存器更宽（128/256/512 位），按更细的 slot 分 |
| 接着 | KRegister（AVX-512 掩码） | K0-K7（8 个） | `max_slots_per_register` | AVX-512 的掩码寄存器 |

以 GPR 为例：编号 0=RAX（低32位），1=RAX（高32位），2=RBX（低32位），3=RBX（高32位）... 每个 64 位寄存器占 2 个编号。源码里 `regName[i++] = reg->name(); regName[i++] = reg->name();` 就是给同一个寄存器填两次名字——编号 0 和 1 都叫 "RAX"。

### 为什么源码在 cpu/x86 不在 share

这个函数在 `cpu/x86/vmreg_x86.cpp` 而不是 `share/`——因为不同 CPU 架构的寄存器完全不一样。x86 有 RAX/RBX/XMM0，ARM 有 R0-R14/VFP/NEON 寄存器。但调用在 `share/` 的 `init.cpp:122`——`init_globals()` 调 `VMRegImpl::set_regName()`，编译时链接到当前平台的实现。
