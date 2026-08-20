# 03-frame-naming 重写规划

> 状态：本轮按一轮闭环执行；保留该 plan 作为后续二轮 consistency pass 的工件
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“FrameName/JVMTI/demangle/style 说明文”重写成一篇围绕“采样器手里的只是 `jmethodID`、特殊 `BCI_*` 标记和 native 名字，为什么必须通过 `FrameName` 这一层把不同世界的帧身份统一翻译成人类可读、可过滤、可携带类型语义的字符串”的机制文章

## 1. 读者困惑

- 为什么 `jmethodID`、native symbol、`BCI_THREAD_ID`、`BCI_ERROR` 这些身份，不能直接拿给 flamegraph/JFR/OTLP？
- `FrameName` 为什么既做 Java 命名、又做 native demangle、又做 style/过滤，看起来像个“总出口”？
- 为什么字节码/解释器/JIT/inline 状态还要带类型后缀，而不只是普通方法名？
- `classMap`、JVMTI、demangle、thread name map 在这层分别补什么缺口？
- 为什么 `FrameName` 不能在采样热路径里直接全量完成，而要延后到输出阶段？

## 2. 一句话顿悟

**`FrameName` 真正做的不是“把名字美化一下”，而是把 profiler 内部那套轻量身份——`jmethodID`、特殊 `BCI_*`、native 符号名、线程 ID——统一翻译成不同消费者都能理解的人类字符串，并在这里集中补上类型后缀、style 变换、include/exclude 过滤与缓存。**

## 3. 总图

```text
ASGCT_CallFrame
  → jmethodID / BCI_* / native symbol / thread id
    → classMap / JVMTI / demangle / thread_names
      → javaClassName / javaMethodName / decodeNativeSymbol / typeSuffix
        → style / include / exclude
          → flamegraph / collapsed / OTLP / text output 消费的名字
```

## 4. 关键边界

- 本篇讲的是“帧身份到显示名字”的统一翻译层，不重新讲地址归属或 stack walk 本身。
- `FrameName` 不是采样热路径的一部分；命名、demangle、JVMTI 查询和 style 变换都发生在输出/消费阶段。
- `FrameName` 既处理 Java 帧，也处理 `BCI_*` 特殊帧和 native 符号名；不能把它缩成“只做 jmethodID -> 方法名”。
- `typeSuffix()` 提供的是类型语义编码，不是颜色本身；不同输出层可用这些后缀做后续消费。
- `classMap` 是预收集字典，JVMTI 是按 method/class 补全 Java 身份，demangle 负责 native 名字恢复，thread map 负责线程帧可读化。
- 输出层有时会关闭 annotate（如 flamegraph/OTLP），因为类型会通过其他结构表达；不能把所有消费者都写成同一命名策略。

## 5. 本轮重写主线

1. 用“采样器手里不是方法名，而是一堆内部身份”开场。
2. 否定：直接把 `jmethodID`/地址拿去展示、把所有逻辑拆成多个零散名字函数、在热路径里直接查 JVMTI 和 demangle。
3. 先讲 `FrameName` 作为统一翻译层的角色。
4. 再讲 Java 命名、native 命名、特殊 `BCI_*` 命名与类型后缀如何在这里汇合。
5. 最后讲 style/过滤/缓存为什么也要挂在这一层，而不是散在各个输出器里。
6. 收网时强调：它是“身份翻译层”，不是“字符串装饰器”。
