# 01. 采样信号只给了寄存器，为什么还能走出 native 调用链 —— `StackFrame`、中间态修正与防御性 FP 行走

> **前置依赖**：[03-jvm-integration/03 —— 采样拿到的是地址，为什么最后能看到 Java 方法名](../03-jvm-integration/03-vmstructs-stackwalk.md)：知道完整的地址恢复要经过地址归属、walker 选路和后续帧命名。
> → **后续**：ELF/符号解析与帧命名
>
> 本篇基于当前 async-profiler 源码。重点是“寄存器快照怎样迈出第一步 native callchain”，不把 `ucontext` 误当成现成栈回溯结果，也不把 FP walker 简化成“扫一条 rbp 链”。

## 采样信号给了寄存器，却没给你 StackTrace

场景：采样信号打断一个正在运行的线程，profiler 从 `ucontext` 里拿到 PC、SP、FP 和一组平台相关寄存器。用户最后却希望看到的是一串可信的调用链。但 `ucontext` 本身并不会附赠一份现成 `StackTrace`。

它真正给你的只有：

```text
被打断那一刻的寄存器快照
  → 当前 PC / SP / FP / 参数寄存器 / link register（如有）
    → 也许正落在方法序言、尾声、stub 或被 EINTR 打断的 syscall 中间态
      → 还没变成任何可靠的 callchain
```

如果这时候直接把 `ucontext` 当成“已经有了当前栈帧”，后面就会立刻踩进两个坑：

- 平台调用约定不同：x64 没有 link register，AArch64 有；参数寄存器位置也不同；
- 被打断点可能正处于函数序言、尾声、stub 或中断 syscall 的半成品状态，当前 `sp/fp/pc` 还没稳定落到下一层 walker 能直接吃的形态。

因此，本篇真正要回答的不是“寄存器怎么取出来”，而是：**为什么 async-profiler 必须先把寄存器快照适配成统一接口，再修正那些处于中间态的 frame，最后才敢沿 FP 链迈出第一步 native callchain。**

*关键设计（斜体）：* *寄存器快照不是调用链。只有先解决架构差异与中间态修正，native callchain 的第一步才可信。* [模式: 快照先适配，再行走]

## 先推翻四个最容易把寄存器行走讲轻的直觉

### `ucontext` 里的寄存器已经等于一份完整 stack trace

不成立。`ucontext` 只保存“此刻 CPU 寄存器是什么”，不保存“下一帧在哪、上一帧怎么回去、当前 PC 是否位于序言一半”。它最多给了你原材料，不给成品。

### 只要沿着 FP 链走，就不会出错

也不成立。即使某个平台通常保留 frame pointer，当前 PC 也可能还卡在序言还没把 FP 安好、尾声刚把 SP 调整回来、stub 有特殊返回布局、或 signal 正好打在原子/系统调用过渡点上。沿着“看起来像 FP”的值硬走，只会把未知内存当成下一帧。

### 只认 `push rbp` / `mov rbp, rsp` 这一种模式就够了

这是把 x64 的一个典型序言当成了全部平台和全部代码形态。当前实现里 x64、i386、AArch64 各自都有不同的寄存器布局、return 语义、link register 语义和 stub 识别方式。更不用说 AArch64 根本不是靠 `push rbp` 这种指令模式来理解帧。

### 遇到可疑帧时继续猜下一帧，总比提前停好

恰恰相反。async-profiler 在这里的第一原则不是“尽可能多走几帧”，而是“不要因为栈行走把被打断线程或 profiler 自己带崩”。一旦对齐、栈界、dead zone、CodeHeap 边界或中间态修正不成立，宁可立刻停止，也不能继续猜。

## 第一层：`StackFrame` 不是 getter 集合，而是架构调用约定适配器

`src/stackFrame.h:16-63` 给出的接口表面上很朴素：`pc()`、`sp()`、`fp()`、`arg0()`、`link()`、`ret()`、`checkInterruptedSyscall()`、`unwindStub()`、`unwindPrologue()`……

但这些接口的真实职责，不是“方便你少写几个寄存器名字”。更准确地说，`StackFrame` 自己就承担了两层责任：

- 先把不同平台的 `ucontext`、调用约定和返回语义压成统一语义；
- 再把一部分中间态修正（`ret()`、`unwindStub()`、`unwindPrologue()`、`unwindEpilogue()`、`checkInterruptedSyscall()`）放在这一层完成。

也就是说，上层 `StackWalker` 并不是等到拿到一个已经完美的抽象栈帧才开始工作；`StackFrame` 本身就携带了一部分“把寄存器快照修成可走状态”的恢复逻辑：

```text
平台细节：ucontext 布局 / 参数寄存器 / link 位置 / ret 规则
  → StackFrame 统一语义：pc / sp / fp / arg / link / ret / unwind helper
    → 上层 StackWalker 不再写死平台寄存器名字
```

### x64：没有 link register，参数从寄存器来

当前 x86-64 的实现文件是 `src/stackFrame_x64.cpp`，不是不存在的 `stackFrame_x86.cpp`。在 `stackFrame_x64.cpp:21-73`：

- `pc()` 读 RIP；
- `sp()` 读 RSP；
- `fp()` 读 RBP；
- `arg0..arg3()` 读 RDI/RSI/RDX/RCX；
- `link()` 直接返回 0，因为 x86 没有专用 link register；
- `ret()` 通过 `stackAt(0)` 取返回地址，再推进 SP。

也就是说，x64 上“怎么回到上一帧”依赖的是当前栈顶保存的返回地址，而不是某个固定 link 寄存器；而且 `ret()` 还会顺带推进 SP。这个细节本身就说明：统一接口不等于统一行为。

### AArch64：有 link register，参数寄存器也不同

`src/stackFrame_aarch64.cpp:23-73` 则完全不同：

- `pc()` / `sp()` 走 AArch64 的 `ucontext` 字段；
- `fp()` 来自 x29；
- `link()` 读 x30 / lr；
- `arg0..arg3()` 读 x0..x3；
- `ret()` 直接把 `pc()` 设成 `link()`。

所以同样叫“返回上一层”，AArch64 依赖 link register，而不是 x64 那种“栈顶 slot 里取返回地址”的模型；它的 `ret()` 只改 PC，不像 x64 那样同时推进 SP。

### i386 再次说明“所有架构都按 x64 理解”会出错

`src/stackFrame_i386.cpp:13-66` 里甚至连参数获取都改成了从当前栈槽位 `stackAt(1..4)` 读取，而不是寄存器。这足以说明：如果在通用 walker 层面写死“arg0 总在某个寄存器里”，马上就会把其他架构走错。

*关键设计（斜体）：* *`StackFrame` 统一的是“如何读当前架构的调用现场”，不是“各架构寄存器刚好长得差不多”。* [模式: 架构调用约定适配器]

## 第二层：序言、尾声、stub 与中断 syscall，为什么都要先修正

寄存器接口统一之后，问题还没有结束。因为被打断线程经常不在“已经稳定落好帧”的时刻。

### `unwindPrologue()`：函数刚进来，栈帧可能只搭了一半

以 x64 为例，`src/stackFrame_x64.cpp:116-137` 的 `unwindPrologue()` 处理的是方法序言中间态：

- 若 PC 还在入口或刚到 `push rbp`，返回地址还在栈顶，直接按未完成 frame 的布局恢复；
- 若 PC 刚过 `push rbp`，又是另一种布局；
- 若 `isFrameComplete(entry, ip)` 已判断栈帧构造完成，才用 `nm->frameSize()` 去恢复 SP/FP/PC。

这说明“当前 FP/SP 看起来像某个稳定帧”并不总成立。被 signal 打断时，代码很可能正位于序言的一半。

### `unwindEpilogue()`：函数快退出了，栈也可能只拆了一半

同样在 x64，`unwindEpilogue()`（`stackFrame_x64.cpp:179-195`）处理的是尾声：

- 若当前就是 `ret`，按返回地址恢复；
- 若当前是 `pop rbp`，则要用另一种方式还原 FP/PC/SP。

也就是说，尾声和序言一样，都属于“不能直接拿当前寄存器当稳定帧”的中间态。

### `unwindStub()`：stub 不是普通函数，返回布局也不一定普通

`unwindStub()` 在 x64（`stackFrame_x64.cpp:76-102`）和 AArch64（`stackFrame_aarch64.cpp:145-177`）都存在，但处理逻辑差异很大。它们共同要解决的问题是：某些 well-known stub、itable/vtable 路径、`InlineCacheBuffer` 或固定帧大小 stub 根本不适合按普通函数序言/尾声去理解。

而 AArch64 进一步说明这不是 x64 特例：它既要识别 `stp x29, x30, [sp, #-16]!` + `mov x29, sp` 这种 link-register 风格 stub，又要区分 fixed-size frame 与 zero-size frame。也就是说，“stub 中间态修正”在不同架构上依赖的是完全不同的机器码与调用约定知识。

所以 stub 修正不是“额外优化”，而是另一个必须先跨过的中间态门槛。否则 walker 看到的可能是一段 runtime stub 的过渡布局，而不是可直接走的 native frame。这里 `withinCurrentStack()`（`src/stackFrame.h:20-24`）也属于低层防护证据：像 x64/aarch64 的 `unwindStub()` 在尝试从 FP 恢复返回布局时，都会先用它确认当前 FP 仍然落在可信的当前栈附近，而不是盲目把任意寄存器值当作栈基址。

### `checkInterruptedSyscall()`：被 EINTR 打断时，PC 也可能不在稳定位置

`StackFrame::checkInterruptedSyscall()` 在 x64（`stackFrame_x64.cpp:207-238`）和 wall-clock 路径的 `getThreadState()` 里配合使用。它处理的是 syscall 刚返回 EINTR、或者需要回退到真正 syscall 指令位置再判断的场景。

这里同样不是统一算法：

- x64 的 Linux 分支会在特定 syscall 号与无限超时条件下，直接把 PC 回退到真正的 syscall 指令位置；
- macOS 分支则更依赖 CF/返回值约定，甚至把某些 `ret` 位置视作可以接受的中断后状态。

这再次说明：采样器面对的“当前 PC”不一定已经是用户想象中的方法内部稳定位置。它可能只是一个刚被信号打断、尚未恢复到正常控制流的系统调用边界。

换句话说，本篇到这里已经有一条统一主线：我们其实还没真正开始“行走一条完整的栈”，而是在努力把当前寄存器快照修成一个至少敢迈出第一步的状态。

换句话说，本篇到这里已经有一条统一主线：

```text
平台寄存器先适配
  → 再修正序言 / 尾声 / stub / interrupted syscall 这些中间态
    → 只有修完，后面的 native walker 才有资格开始猜“下一帧”
```

*关键设计（斜体）：* *`unwindPrologue()`、`unwindEpilogue()`、`unwindStub()`、`checkInterruptedSyscall()` 本质上都在做同一件事：别让 walker 从半个栈帧起步。* [模式: 中间态修正链]

## 第三层：`walkFP()` 为什么宁可提前停，也不能继续猜下一帧

`StackWalker::walkFP()` 位于 `src/stackWalker.cpp:73-120`。它的循环逻辑看起来很朴素：

1. 取出当前 PC、FP、SP；
2. 若地址已进入 CodeHeap，通常停止 native FP 行走；但若这是 depth 0 且 `frame.unwindAtomicStub(pc)` 成功，就允许先跨过这个特殊原子 stub 再继续；
3. 把当前 PC 放进 callchain；
4. 检查下一个 FP 是否还在栈界内；
5. 检查 FP 是否对齐；
6. 用 `SafeAccess::load()` 从 FP 槽位读返回地址；
7. 更新 SP/FP，继续下一帧。

关键不在“它循环了几步”，而在“它在哪些地方坚决不往下猜”。源码把这些停止条件写得非常重：

- `CodeHeap::contains(pc)`：说明已经进入 JVM/JIT 专属世界，native FP walker 不再继续；
- `fp < sp || fp >= sp + MAX_FRAME_SIZE || fp >= bottom`：下一帧超出当前合理栈界；
- `!aligned(fp)`：frame pointer 没对齐；
- `inDeadZone(pc)`：返回地址落在明显不可信区域。

这背后的原则非常硬：**walkFP 不是“尽量多走几帧”，而是“只走那些自己还能证明是可信的帧”。**

如果它在这些边界上选择继续猜：

- 轻则会把随机内存当成返回地址；
- 重则会因为越界解引用把 profiler 自己打崩；
- 更糟的是，错误帧还会污染后面的 CodeHeap/符号解析，生成看起来“像真的”假栈。

所以当前实现宁可提前停，也不让一个可疑帧把整条 callchain 带歪。这不是保守，而是异步采样工具的生存条件。

*关键设计（斜体）：* *walkFP 的第一目标不是完整，而是可信：只要对下一帧的安全性失去证据，就立刻停止。* [模式: 防御性 native frame 行走]

## 第四层：本篇解决的是“native 第一跳可信”，不是完整 Java 栈恢复

把本篇压缩成一句话：

```text
signal/ucontext
  → StackFrame 先统一架构寄存器语义
    → 再修正序言/尾声/stub/syscall 中间态
      → walkFP 只在证据充分时迈出下一帧
        → 遇到 CodeHeap/JVM 边界时交给更高层 walker
```

换一种不看图的复述方式：

- `StackFrame` 解决“当前架构怎么读 PC/SP/FP/args/link”；
- `unwind*` 系列解决“当前是不是还在半个帧里”；
- `checkInterruptedSyscall()` 解决“当前 PC 是否还卡在系统调用边界”；
- `walkFP()` 解决“native callchain 的第一步能不能安全迈出去”；
- 到了 CodeHeap/JVM 专属地址，才轮到更高层 walker 去恢复 Java/JIT 逻辑帧。

本篇的一句话困惑是：**为什么 async-profiler 明明已经拿到了 PC、SP、FP，还不能直接说自己已经拿到调用链？**

本篇的一句话顿悟是：**因为寄存器快照只是原材料；只有先把平台调用约定统一，再把序言、尾声、stub 和被中断 syscall 这些中间态修正掉，native callchain 的第一跳才可信。**

*关键设计（斜体）：* *本篇解决的不是“完整栈已经恢复”，而是“第一层 native frame 至少可安全、可信地走出来”。* [模式: 第一跳可信，再交上层]

[跨层标注：Linux/macOS `ucontext`——被打断线程的寄存器快照；`StackFrame`——架构调用约定适配器；`unwindPrologue` / `unwindStub` / `checkInterruptedSyscall`——中间态修正链；`walkFP`——防御性 native frame 行走；CodeHeap——JVM/JIT 边界]

## 下一篇：地址已经拿到了，为什么还要 ELF/.symtab/GNU hash 才能变成函数名

这一篇先把“寄存器快照怎样变成可信的 native 第一跳”讲清。下一篇继续进入地址到名字的恢复：

- ELF 的 `.symtab`、`.dynsym`、GNU hash 在解决什么问题；
- 为什么地址归属到某个库之后，仍然不能直接得到函数名；
- Java/JIT/native 三类帧的命名为什么还要继续分家。

**→ 下一篇：ELF 符号解析与地址到函数名。**
