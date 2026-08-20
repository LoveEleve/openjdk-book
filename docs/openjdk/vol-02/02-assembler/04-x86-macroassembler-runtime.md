# 04. MacroAssembler：它如何把指令拼成 JVM 运行时

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[03 — x86 指令集](03-x86-assembler-instruction-set.md)：单条指令和编码模板；[01 — CodeBuffer/Label](01-codebuffer-abstract-assembler.md)
> → **后续**：[03-arguments-flags — 标志系统](../03-arguments-flags/01-flag-definition-system.md)：这些运行时模板如何被 flags 选择
> 关联域：13-jit、18-safepoint、06-oops、23-stub、45-math-library

## 单条指令会了，JVM 运行时怎么办

上一篇我们已经看到：

- `mov` 搬数据
- `jmp/call` 组织控制流
- `lock cmpxchg` 支撑原子操作
- SSE/AVX 处理浮点和向量
- `mfence` 表达某些内存序列化

但这些还不够生成一段真正能运行的 Java 机器码。

JIT 生成的方法还必须处理更多上下文：

- 进入 C++ VM 函数前，GC 如何知道当前 Java 栈帧在哪里
- 调用返回后，异常标志由谁检查
- 方法入口和循环回边如何配合 safepoint
- 当前线程的栈空间是否足够继续执行
- 64 位地址如何压缩成 32 位 oop
- CPU 支持 AES/SHA 时，如何把硬件能力变成模板代码

单条 `call` 只会跳到一个地址；它不会自动保存 JavaThread 的 last Java frame，也不会自动检查异常。

单条 `test` 只会比较一个值；它不会自动知道这是 safepoint poll。

单条 `shr` 只会移位；它不会自动理解 heap base、compressed oop 和 null 编码。

这些“指令之外的协议”，就是 `MacroAssembler` 负责拼起来的。

先画出本篇主线：

```text
JIT 语义
  │
  ▼
MacroAssembler 运行时模板
  ├─ call_VM：保存 Java 状态 → 进入 C++ → 恢复/查异常
  ├─ safepoint_poll：低成本检查 → slow path
  ├─ stack banging：在进入深调用前探测栈边界
  ├─ compressed oop：地址 ↔ 32 位表示
  └─ intrinsic：CPU 能力 → 硬件指令模板
```

一句话先记住：

**MacroAssembler 不是“更大的 Assembler”，而是把机器指令、ABI、JavaThread 状态、GC 约束和异常协议封装成可复用运行时模板的边界层。**

---

## 一、为什么 Assembler 还不够：机器码必须对 JVM 负责

### 1.1 直接 `call` C++ 会漏掉什么

假设 JIT 生成的代码需要调用一个 VM runtime 函数。

最直觉的做法是：

```text
把参数放进 ABI 规定的寄存器
call C++ 函数
拿返回值
继续执行
```

如果这只是普通 native 程序，可能已经够了。

但 Java 线程进入 C++ VM 之后，JVM 的 GC、异常、栈遍历仍然可能发生。此时 HotSpot 必须知道：

- 这条 Java 代码从哪里进入 C++
- 进入 C++ 前的 Java 栈指针是什么
- Java 帧的 frame pointer 在哪里
- GC 扫描时应该从哪个位置找到 Java 根
- C++ 返回后是否有待处理异常

单条 `call` 不会保存这些信息。

如果不登记 last Java frame，GC 在扫描线程栈时可能只看到“当前正在 C++”，却找不到进入 C++ 之前的 Java 帧边界。

于是，`MacroAssembler` 的运行时调用模板必须把两个世界接起来：

```text
生成的 Java 机器码
       │
       ├─ 遵守 Linux System V AMD64 ABI
       ├─ 登记 JavaThread 的 last Java frame
       ├─ 调用 VM/C++ 函数
       ├─ 清理 Java 帧状态
       └─ 检查异常并回到正确 continuation
```

### 1.2 `MacroAssembler` 的职责边界

可以把两层职责分开：

```text
Assembler
  → 发出 mov/call/test/shr 等具体机器码

MacroAssembler
  → 把多条指令按 JVM 协议组合成一个有语义的模板
```

例如：

- `call` 只负责发出调用指令
- `call_VM` 负责保存 Java frame、传 JavaThread、调用 C++、清理状态、查异常
- `testb` 只负责测试位
- `safepoint_poll` 负责测试线程状态，并在异常时跳到 slow path
- `shrq` 只负责移位
- `encode_heap_oop` 负责处理 zero-based、heap base、null 和验证

所以阅读 MacroAssembler 时，不能只问“它发出了几条指令”，还要问：

**这些指令合起来，替 JVM 维护了哪个不变量？**

---

## 二、`call_VM`：JIT 如何安全进入 C++ VM

### 2.1 中间 `call` 为什么不是多余的

HotSpot 的 `call_VM` 入口位于 `macroAssembler_x86.cpp:2311` 附近：

```cpp
// macroAssembler_x86.cpp:2311-2325
void MacroAssembler::call_VM(Register oop_result,
                             address entry_point,
                             bool check_exceptions) {
  Label C, E;
  call(C, relocInfo::none);
  jmp(E);

  bind(C);
  call_VM_helper(oop_result, entry_point, 0, check_exceptions);
  ret(0);

  bind(E);
}
```

第一次看会觉得奇怪：

```text
call(C)
  → 进入 C
  → helper 调 C++
  → ret
  → 回到 jmp(E) 后面
```

为什么不直接 `call_VM_helper`？

关键在 `call(C)` 留在栈上的返回地址。

`call` 会把“下一条指令地址”压入栈。这个返回地址成为一个稳定的 Java PC 记录点，后面 `set_last_Java_frame` 可以让 JVM 通过 JavaThread 找到它。

因此中间 call 的意义不是多跑一次控制流，而是给 JVM 建立一个可遍历的 Java 调用现场：

```text
Java 机器码
  │ call(C)
  │ 栈上留下返回地址
  ▼
call_VM_helper
  │
  ├─ 登记 last Java frame
  ├─ 调 C++ VM 函数
  ├─ 恢复 Java frame 状态
  └─ 检查异常
  ▼
ret 回到 jmp(E) 后面
```

这是一种典型的“多一条指令，换一个运行时不变量”的设计。

### 2.2 JavaThread 为什么是 VM 函数的参数

进入 C++ 前，`call_VM_base` 会把当前线程传给被调用函数：

```cpp
// macroAssembler_x86.cpp:2515-2526
NOT_LP64(push(java_thread); number_of_arguments++);
LP64_ONLY(mov(c_rarg0, r15_thread));

set_last_Java_frame(java_thread, last_java_sp, rbp, NULL);
```

Linux System V AMD64 ABI 下，前几个整数参数通过寄存器传递，`c_rarg0` 对应第一个参数寄存器。

因此 VM 函数能够拿到当前 `JavaThread*`，再从中读取：

- 线程状态
- pending exception
- Java frame anchor
- 栈和 safepoint 相关状态
- GC/运行时需要的线程局部信息

这比让每个 C++ 函数自己重新查当前线程更明确，也符合 HotSpot 的调用约定。

### 2.3 `set_last_Java_frame`：让 GC 不在 C++ 边界迷路

进入 C land 前，MacroAssembler 调用 `set_last_Java_frame`。

源码注释在 `macroAssembler_x86.cpp:5558-5562` 附近说明了目的：

```text
进入 C land 时，把最后一个 Java frame 的 rbp 和 rsp
记录到线程本地 JavaThread 对象中。
离开 C land 时，再把 last Java fp 清零。
这样才能正确遍历线程栈。
```

这条协议很容易被低估。

Java 线程进入 C++ 后，当前执行栈不再只是 Java 帧：

```text
Java frame
   │
   ▼
VM runtime / C++ frame
   │
   ▼
更多 native 调用
```

GC 或异常处理如果只看当前 C++ 栈，可能无法直接判断 Java 帧从哪里开始。

`JavaThread` 中的 last Java frame 就像一个锚点：

```text
JavaThread
  ├─ last_Java_sp
  ├─ last_Java_fp
  └─ last_Java_pc / 返回地址关系
```

有了它，线程暂时进入 C++ 并不会让 Java 栈变成不可遍历的黑洞。

### 2.4 返回之后为什么还要查异常

VM 函数可能：

- 正常返回一个 oop 或 primitive
- 设置 pending exception
- 修改线程状态
- 触发 safepoint 或其他运行时动作

因此 `call_VM` 不能只看 CPU 返回寄存器。

`check_exceptions` 参数控制返回后的异常检查。如果发现线程上挂着 pending exception，生成代码就不能继续执行原来的普通路径，而要转向异常 continuation。

这条边界也解释了 `call_VM` 和普通 `call` 的差异：

```text
普通 call：
  ABI 调用 + 返回值

call_VM：
  ABI 调用
  + JavaThread 参数
  + last Java frame
  + VM 状态转换
  + exception check
  + oop result 处理
```

### 2.5 返回后的完整收尾链

`call_VM_base` 在 C++ 返回后还要做一串不能省略的收尾动作。

```text
C++ 返回
  │
  ├─ 恢复/重新取得 JavaThread
  ├─ reset_last_Java_frame
  ├─ 处理 popframe / early return 等控制请求
  ├─ 检查 Thread::pending_exception
  └─ 如果有 oop 返回值，从线程结果槽取出
```

源码在 `macroAssembler_x86.cpp:2547-2576` 附近可以看到这条顺序：

- 先 `reset_last_Java_frame`
- 再检查 `popframe` 和 `earlyret`
- 根据 `check_exceptions` 检查 `pending_exception`
- 最后通过 `get_vm_result` 取出 VM 返回的 oop

顺序很重要。

如果先把 last Java frame 清掉，再忘记处理 pending exception，生成代码可能会沿正常路径继续执行；如果先取返回值却没有恢复线程状态，GC 或后续栈遍历又可能看到一个已经过期的 Java frame anchor。

因此 `call_VM` 的完整模型不是“call 前登记、call 后返回”，而是一个成对协议：

```text
进入 C land：登记 Java frame
      ↓
执行 VM 函数：线程状态可能变化
      ↓
离开 C land：清理 Java frame
      ↓
处理控制请求、异常和 oop 结果
      ↓
回到生成代码的正常 continuation 或异常入口
```

这也是为什么 `call_VM` 不能被普通 `call` 替代：它维护的是跨语言边界的不变量，而不是单纯的控制流。

### 2.6 `call_VM_leaf`：不是所有 C 函数都需要完整 Java frame

MacroAssembler 还提供 `call_VM_leaf_base` 和 `call_VM_leaf`。

“leaf” 的含义不是“这个函数一定很简单”，而是它表示一类不需要完整 Java frame 协议的调用路径。

阅读时必须先确认调用方的上下文：

- 当前是不是解释器路径
- C 函数会不会触发 safepoint
- 是否需要返回 oop
- 是否需要设置 last Java frame
- 是否允许阻塞或抛异常

不能把 `call_VM_leaf` 当成 `call_VM` 的“更快版本”，也不能随便把任意 VM 函数替换成 leaf 调用。

### 2.7 失败方案：只遵守 ABI，不登记 Java 状态

假设生成代码只做：

```text
mov 参数寄存器
call C++
```

它可能在没有 GC、没有异常、没有栈遍历的简单测试里工作。

但当 C++ 调用期间发生：

- GC 扫描
- safepoint
- 异常传播
- 栈遍历
- VM 状态检查

JVM 就无法可靠找到“进入 C++ 之前的 Java 现场”。

所以 `call_VM` 的核心不是多了几条汇编，而是把 ABI 之外的 JVM 运行时协议补齐。

---

## 三、safepoint poll 与栈保护：方法入口为什么还要可 patch

### 3.1 JDK 11u 的 thread-local poll

前面信号文章讲过旧式全局 polling page + SIGSEGV 的模型。

但在 JDK 11u HotSpot 的典型路径里，`MacroAssembler::safepoint_poll` 会优先使用 thread-local poll：

```cpp
// macroAssembler_x86.cpp:3744-3758
void MacroAssembler::safepoint_poll(Label& slow_path,
                                     Register thread_reg,
                                     Register temp_reg) {
  if (SafepointMechanism::uses_thread_local_poll()) {
#ifdef _LP64
    assert(thread_reg == r15_thread, "should be");
#endif
    testb(Address(thread_reg, Thread::polling_page_offset()),
          SafepointMechanism::poll_bit());
    jcc(Assembler::notZero, slow_path);
  } else {
    cmp32(ExternalAddress(SafepointSynchronize::address_of_state()),
          SafepointSynchronize::_not_synchronized);
    jcc(Assembler::notEqual, slow_path);
  }
}
```

这里需要分清两条路径：

```text
thread-local poll：
  读取当前 JavaThread 对象里的 polling 字段

非 thread-local poll：
  读取全局 SafepointSynchronize 状态
```

当前 thread-local 路径的正常成本是：

- 从线程对象的固定偏移读取 poll 字段
- 测试指定 bit
- 没有请求时继续执行

当 VM 要求线程进入 safepoint 或 handshake，相关线程状态会使 poll 命中，代码跳到 slow path。

这和上一篇讲的“旧全局 polling page 通过 SIGSEGV 分流”必须分开：

- 旧模型：改页面权限，依靠 fault
- 当前模型：修改线程本地状态，依靠普通 load/test/jcc

因此阅读 JDK 11u 源码时，不能把旧文章中的信号页模型直接套到所有 safepoint poll 上。

### 3.2 方法入口为什么必须至少 5 字节

`verified_entry` 附近有一条非常关键的注释：

```cpp
// macroAssembler_x86.cpp:5842-5847
// Initial instruction MUST be 5 bytes or longer so that
// NativeJump::patch_verified_entry will be able to patch out
// the entry code safely.
```

这不是为了美观，也不只是指令对齐。

JVM 运行时可能需要修改方法入口，例如：

- 类重定义后切换入口
- 去优化后跳转到替代路径
- 编译代码失效后切换目标

x86 的近跳转通常需要 5 字节：

```text
E9 + rel32
```

因此入口前几条机器码必须预留足够连续空间，让 `NativeJump::patch_verified_entry` 能够整体替换入口。

这形成另一种“运行时模板纪律”：

```text
生成阶段：入口至少满足 patch 长度
运行阶段：需要时可把入口替换成跳转
```

如果入口只有 2、3 字节，运行时 patch 可能覆盖半条指令，线程同时执行时就会看到损坏的机器码。

### 3.3 stack banging：入口先确认栈还够不够

方法入口还可能执行栈保护检查。

`assembler.cpp:121-151` 的 `generate_stack_overflow_check` 会在 `UseStackBanging` 开启时，按页面间隔写入栈的 shadow zone 附近。

它的目的不是初始化数据，而是尽早触碰页面：

```text
方法即将建立新栈帧
    │
    ▼
按页触碰 shadow zone
    │
    ├─ 页面可用 → 继续进入方法
    └─ 触碰保护区 → 进入栈溢出处理
```

这种设计把“深栈帧可能一次跨过多个保护页”的问题提前处理。

需要注意实现边界：源码注释明确区分了 Java 代码和 VM/native 代码；stack banging 主要由 Java 入口使用，不能写成所有 native/VM 调用都通过同一机制检测栈溢出。

### 3.4 失败方案：poll、patch 和 stack bang 混成一个检查

它们都出现在入口附近，但职责不同：

- poll：检查 VM 是否要求线程协作暂停
- patch-safe entry：保证运行时能替换方法入口
- stack bang：提前触碰栈边界，发现栈空间不足

如果把三者混在一起，读者会误以为“入口的一条指令同时完成 safepoint、类重定义和栈保护”。

更准确的理解是：

**MacroAssembler 在一个入口模板里叠加多个独立协议，每个协议都有自己的状态、触发条件和失败路径。**

---

## 四、压缩 oop：一个 32 位值如何代表 64 位对象地址

### 4.1 为什么要压缩 Java 堆引用

在 64 位 JVM 中，普通对象引用可能占 64 位。

如果对象字段、数组元素和栈上的引用全部保存 64 位，引用密度会下降，堆中大量空间会被指针本身占据。

开启 `UseCompressedOops` 后，Java 堆中的引用可以用 32 位表示，代价是每次加载/存储时需要在机器码中编码/解码。

MacroAssembler 的职责是把这个表示协议变成稳定模板。

### 4.2 zero-based 与 heapbase 两种数学

`encode_heap_oop` 位于 `macroAssembler_x86.cpp:5536-5548` 附近。

压缩引用的数学分两种主要模式。

#### zero-based

如果 `narrow_oop_base()` 为 null，堆地址可以直接通过右移压缩：

```text
narrow = address >> shift
address = narrow << shift
```

对象按 8 字节对齐时，低 3 位恒为 0，右移 3 位即可把地址压缩成更小的偏移表示。

#### heapbase

如果堆不在适合 zero-based 的地址范围，JVM 使用一个堆基址：

```text
narrow = (address - heap_base) >> shift
address = (narrow << shift) + heap_base
```

x86_64 MacroAssembler 使用长期保留的 heap base 寄存器保存这段基址。

### 4.3 null 为什么需要特殊路径

压缩引用不能简单把所有值都执行：

```text
sub heapbase
shr shift
```

因为 null 不是一个普通的堆地址。

源码在 heapbase 模式下会先测试引用，再通过条件移动选择 heap base，然后做减法和移位：

```cpp
// macroAssembler_x86.cpp:5536-5548（核心路径）
testq(r, r);
cmovq(Assembler::equal, r, r12_heapbase);
subq(r, r12_heapbase);
shrq(r, LogMinObjAlignmentInBytes);
```

这条路径的意图是让 null 在压缩表示中保留特殊编码，同时避免用普通分支打断常态路径。

具体 null 编码、heap base 和 shift 的取值依赖堆布局与 flags，不能把某一个数值写成所有 JVM 的固定值。

### 4.4 decode 与 load/store 的边界

`decode_heap_oop` 会把压缩值恢复成机器指针。

但实际访问对象字段时，MacroAssembler 还要区分：

- 普通压缩引用 load
- 非 null load
- 压缩引用 store
- null store
- 是否需要配合 GC barrier

因此 `encode_heap_oop`/`decode_heap_oop` 只是表示转换，不等于完整的堆引用访问协议。

GC barrier、卡表、SATB 等属于更上层的 GC 模板；本篇只把“地址表示如何变成指令序列”讲清楚。

### 4.4 load/store 模板为什么不能只调用 encode/decode

真正访问压缩引用字段时，MacroAssembler 还要把表示转换和内存访问组合起来。

`macroAssembler_x86.cpp:5490-5507` 的接口把这件事拆成不同模板：

```text
load_heap_oop
load_heap_oop_not_null
store_heap_oop
store_heap_oop_null
```

它们的差异不是为了提供更多名字，而是为了告诉生成器当前场景的前提：

- 源字段是否可能为 null
- 目标寄存器是否允许被覆盖
- 是否需要临时寄存器保存 heap base 或中间值
- 后面是否要接 GC barrier

例如 `encode_heap_oop_not_null` 在 ASSERT + `CheckCompressedOops` 下还会检查传入值不能为 null；生产路径则可以省掉这类验证。`decode_heap_oop_not_null` 也明确要求 `UseCompressedOops`，并且会改变 flags。

这说明压缩 oop 的指令模板至少包含三层：

```text
表示转换：encode/decode
内存访问：load/store
运行时约束：null 前提、临时寄存器、GC barrier、debug verify
```

如果把它们全部压成“先 shift、再 add heapbase”，就会丢掉真正影响代码正确性的前提。

### 4.5 失败方案：只做 shift

如果所有压缩引用都只做右移和左移，会失败于：

- 非 zero-based 堆需要 heap base
- null 需要特殊表示
- 不同对象对齐要求影响 shift
- load/store 还可能需要 GC barrier

所以压缩 oop 不是一个孤立的位运算，而是：

```text
堆布局决策
  → base/shift/null 编码规则
  → MacroAssembler 指令模板
  → GC/对象访问模板继续叠加 barrier
```

---

## 五、硬件 intrinsic：运行时能力如何变成机器码模板

### 5.1 “硬件加速”不是换 Java API

Java 层调用 `Cipher`、`MessageDigest` 或 `Math` 时，API 语义不应该因为 CPU 不同而改变。

变化的是实现路径：

```text
CPU 能力探测
    ↓
JVM flags / intrinsic 开关
    ↓
C2 或 StubRoutines 选择模板
    ↓
Assembler/MacroAssembler 发射 SSE/AES/SHA 指令
```

有硬件能力时走专门指令，没有时退回软件或通用路径。

### 5.2 AES/SHA 模板

x86 MacroAssembler 的 AES 文件中会把 AES 轮函数展开成：

- `aesenc`
- `aesenclast`
- `aesdec`
- `aesdeclast`
- `aeskeygenassist`

SHA-NI 路径也有对应的轮函数指令。

以 AES 的一轮发射为例，`macroAssembler_x86_aes.cpp` 中的模板会先按 CPU 能力选择 AES 指令形式，再通过 Assembler 发射 opcode、XMM 操作数和可能的 VEX/EVEX 前缀；它不是在运行时解释 AES 算法，而是在生成阶段把一轮固定数学变换展开成机器码。

SHA 路径也是同样的层次：`macroAssembler_x86_sha.cpp` 负责把 SHA 的轮函数组织成寄存器操作和专用指令序列，Assembler 负责最终字节编码，StubRoutines 或 intrinsic 调用方负责决定何时使用这个模板。

这里的关键不是记住每条指令名，而是理解 MacroAssembler 在做什么：

```text
一轮密码算法的数学语义
    → 多条硬件指令的固定组合
    → 寄存器约束与轮密钥布局
    → 可被 intrinsic 或 StubRoutines 调用的机器码模板
```

如果 CPU 没有对应指令，JVM 不能直接发出这些字节，否则会触发非法指令。因此 CPU 探测和 flags 是模板选择的前置条件。

### 5.3 Math 与 StubRoutines 的关系

超越函数也遵循类似模式：

- Java `Math.sin` 提供稳定语义
- C2 识别 intrinsic
- StubRoutines 生成或选择平台实现
- MacroAssembler 发射 SSE2 等浮点指令

这里不能简单说“Math.sin 直接变成一条硬件 `fsin`”。OpenJDK 11u 的常见 64 位路径可能使用基于 SSE2 的软件多项式和辅助 stub，而不是 x87 的 `fsin`。

所以“硬件加速”有时不是一条神奇指令，而是：

- 更合适的 SIMD 指令
- 更紧凑的多项式模板
- 避免慢速函数调用
- 运行时根据 CPU 能力选择实现

### 5.4 生产路径和 verify 路径要分开

MacroAssembler 里还有 `verify_oop` 等调试辅助逻辑。

它们可以帮助开发者发现：

- 寄存器里的值不是合法 oop
- heap base 被破坏
- 压缩引用编码不符合预期

但不能把这些 ASSERT/debug 验证指令误认为生产代码的固定成本。

阅读 MacroAssembler 时必须先问：

```text
这是正常生成路径？
还是 ASSERT/diagnostic 验证路径？
```

这也是源码解释中非常容易混淆的一层。

---

## 六、收网：MacroAssembler 把局部指令变成运行时协议

现在把本篇的四条模板收回来：

```text
JIT 语义
    │
    ├─ 需要调用 VM
    │    → 保存 Java frame → 传 JavaThread → call C++ → 查异常
    │
    ├─ 需要暂停协作
    │    → thread-local poll → slow path
    │
    ├─ 需要访问压缩引用
    │    → base/shift/null → encode/decode → load/store 模板
    │
    └─ 需要硬件加速
         → CPU capability/flags → intrinsic → 指令序列
```

Assembler 只提供局部动作：

- mov
- call
- test
- jcc
- shr
- cmov
- AES/SHA 指令

MacroAssembler 则把它们组织成有运行时意义的模板：

- `call_VM` 把 ABI 和 JavaThread 状态连接起来
- `safepoint_poll` 把线程状态检查嵌入方法入口和回边
- `encode_heap_oop` 把堆布局决策变成机器码
- intrinsic 模板把 CPU 能力变成 Java API 背后的替代实现

如果压缩成三句话：

1. MacroAssembler 的核心工作不是发更多指令，而是维护 JVM 运行时协议。
2. 涉及 VM 调用、线程状态、对象表示或 GC 边界的模板，必须同时满足 ABI、栈、线程状态、GC、异常和 CPU 能力约束；纯算术指令不承担全部这些协议。
3. 机器码只有被放进这些协议里，才不只是一串能执行的字节，而是一段能被 JVM 安全管理的代码。

本篇结束后，Assembler 域的基础链路就闭合了：

```text
CodeBuffer
  → AbstractAssembler
  → x86 operand encoding
  → x86 instruction templates
  → MacroAssembler runtime templates
```

下一步进入 JVM 参数和 flags：

- `UseCompressedOops` 从哪里定义
- `UseAESIntrinsics` 如何解析
- `UseStackBanging` 如何影响代码生成
- flags 如何把平台能力传递给 MacroAssembler

> → [03-arguments-flags/01-flag-definition-system.md](../03-arguments-flags/01-flag-definition-system.md)
