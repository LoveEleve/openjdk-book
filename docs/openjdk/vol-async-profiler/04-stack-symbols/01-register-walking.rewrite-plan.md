# 01-register-walking 重写规划

> 状态：deep review 完成，待修订同步
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“StackFrame 访问器 + FP 行走说明”重写成一篇围绕“采样信号只给了寄存器快照，为什么 profiler 必须先把平台寄存器、序言/尾声、stub、syscall 中断这些底层差异压平，才能安全地迈出第一步 callchain”的机制文章

## 1. 读者困惑

- 为什么信号处理器拿到 `ucontext` 后，还不能直接说“这就是栈”？
- `StackFrame` 为什么不是简单的 PC/SP/FP getter，而要有 `arg0`、`link`、`ret`、`checkInterruptedSyscall`、`unwindStub` 这些接口？
- x64、AArch64、i386 等架构为什么必须各写一个适配文件？
- frame pointer walker 为什么不是“沿着 rbp/x29 链走”这么简单？
- `unwindPrologue()` / `unwindStub()` / `unwindAtomicStub()` 到底在修复什么中间态？
- 采样器为什么宁可提前停止，也不能继续“猜”下一帧？

## 2. 一句话顿悟

**寄存器快照不是现成栈帧链。async-profiler 先用各架构的 `StackFrame` 适配器把 `ucontext` 映射成统一的 pc/sp/fp/arg/link 语义，再在进入 walker 之前识别函数序言、尾声、stub、syscall 中断和栈边界，确保第一步 native callchain 至少是“安全可走”的，而不是“看起来像能走”。**

## 3. 总图

```text
signal/ucontext
  → arch-specific StackFrame
    → pc / sp / fp / args / link / ret
      → prologue / epilogue / stub / syscall 边界修正
        → defensive walkFP / native frame recovery
          → 遇到 CodeHeap 或 JVM 专属边界后交给更高层 walker
```

## 4. 版本与范围边界

- 重点是“寄存器快照怎样进入第一层 native callchain”，不是完整 JIT/Java 逻辑帧恢复。
- 文章要用真实文件名：当前 x86-64 在 `stackFrame_x64.cpp`，32 位 x86 在 `stackFrame_i386.cpp`。
- `walkFP()` 主要服务 native callchain；遇到 CodeHeap 后会把解释权交给上层 JVM/VM walker。
- 不把 frame pointer walker 简化成“找 0x55 push rbp”；当前实现还处理序言/尾声、stub、atomic stub、中断 syscall 等特殊点。
- `ret()`、`arg0()` 等访问器是调用约定桥，不是随便提供的工具函数。

## 5. 现稿方法论差距审计

- 开篇已有“拿到的是寄存器快照”，但整体仍偏 x64 访问器说明文，缺少“为什么不能直接把 ucontext 当 stack trace”的主冲突厚度。
- 文件名与架构边界不准：当前实现是 `stackFrame_x64.cpp`，不是 `stackFrame_x86.cpp`。
- `StackFrame` 的角色还没完全拉升到“架构调用约定适配器 + 中间态修复器”。
- `unwindPrologue()`、`unwindStub()`、`unwindAtomicStub()`、`checkInterruptedSyscall()` 没形成同一条“修复中间态”的叙事链。
- `walkFP()` 章节偏遍历步骤清单，没有把“为什么宁可提前停，也不能继续猜下一帧”作为失败方案讲透。
- x64 与 AArch64 的差异还缺少统一对照，容易让读者误以为 link register/ret 行为在所有架构一致。

## 6. 重写策略

1. 用“采样信号只给了寄存器，不给栈回溯结果”的事故困惑开篇。
2. 推演并否定：直接把 ucontext 当 stack trace、只看 FP 链、只识别 `push rbp` 就够、所有架构都按 x64 解释。
3. 给出总图：架构适配 → 中间态修复 → 防御性 native frame 行走 → 遇到 JVM 边界后上交。
4. 分层讲：
   - `StackFrame` 如何屏蔽平台布局差异；
   - x64/AArch64 等寄存器与 link/ret 差异；
   - prologue/epilogue/stub/syscall 中断如何修复；
   - `walkFP()` 的边界检查如何构成“宁可停下也不乱走”的安全策略。
5. 收网时明确：本篇解决的是“第一步 native callchain 可信”，不是完整 Java 栈恢复。

## 7. 结构大纲

### 第一节：事故开场——采样信号给了寄存器，却没给你 StackTrace

回答：为什么 `ucontext` 不是现成调用链。

预估字数：900-1100

### 第二节：先排除四个错误直觉——直接读寄存器就够、只看 FP 链、只认 `push rbp`、所有架构都一样

预估字数：1600-2000

### 第三节：第一层——`StackFrame` 是架构调用约定适配器，不只是 getter 集合

证据：`stackFrame.h` + `stackFrame_x64.cpp` / `stackFrame_aarch64.cpp`。

回答：pc/sp/fp/link/args/ret 的统一语义，真实文件名与平台差异。

### 第四节：第二层——序言、尾声、stub、syscall 中断为什么都要先修正

证据：各架构 `unwindPrologue()` / `unwindStub()` / `ret()` / `checkInterruptedSyscall()`。

回答：中间态修复，不让 walker 从“半个栈帧”起步。

### 第五节：第三层——`walkFP()` 为什么宁可提前停，也不能继续猜下一帧

证据：`stackWalker.cpp:73-120`。

回答：CodeHeap 边界、对齐、dead zone、MAX_FRAME_SIZE、stack bottom。

### 第六节：收网——native callchain 的第一步可信，后面 JVM walker 才有意义

桥接 ELF 符号/帧命名或更高层 walker。

## 8. 必须展开的失败方案

1. `ucontext` 里的寄存器已经等于一份完整 stack trace。
2. 只要沿着 FP 链走，就不会出错。
3. x64 的 `push rbp` 识别足够解释所有平台。
4. 遇到可疑帧时继续猜下一帧，总比提前停好。
5. native callchain 走出来就等于 Java/JIT 逻辑栈也完整了。

## 9. 证据清单

- `src/stackFrame.h`
- `src/stackFrame_x64.cpp`
- `src/stackFrame_aarch64.cpp`
- 必要时补 `stackFrame_i386.cpp` / 其他架构对照
- `src/stackWalker.cpp:73-120`
- `src/stackWalker.cpp` 中 `unwindAtomicStub` / syscall 相关调用点

## 10. 完成后检查

1. 删除代码块后仍能复述“寄存器快照 → 架构适配 → 中间态修正 → 防御性 FP 行走”。
2. 至少展开 4 个失败方案。
3. 不再误用不存在的 `stackFrame_x86.cpp` 文件名。
4. 不把 FP walker 简化成 `0x55`/`push rbp` 检测。
5. 明确 `StackFrame` 与 `walkFP()` 的职责边界。
6. 每个 `file:line` 重新核对，链接、结构标记和禁用词通过。
