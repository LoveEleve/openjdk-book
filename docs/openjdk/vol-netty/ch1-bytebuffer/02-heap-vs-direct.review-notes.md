# Netty Ch1-02 HeapBuffer vs DirectBuffer — 正文深审记录

## 第一轮：事实与源码审

- 核对 HeapBuffer/DirectBuffer 的分配分叉、native address、Deallocator、Cleaner、Bits 额度统计与 wrap 共享数组语义。
- 核对当前 jdk11u 的 `Bits.MAX_MEMORY` 初始化和 `MaxDirectMemorySize` 默认语义，删除“默认简单等于 -Xmx”的旧式断言。
- 明确 `MaxDirectMemorySize` 限制的是 direct buffer 总 capacity，不等于所有 native memory 总量。

## 第二轮：因果审

- 将“DirectBuffer 更快”修正为“为某些 native IO 路径减少堆数组到临时 direct buffer 的转换机会”。
- 明确“直接地址”不等于“绝对零拷贝”。
- 明确 GC、Cleaner、Deallocator 三者不是同一个事件。
- 明确 Bits 的 System.gc/引用处理/指数退避是失败后的尝试，不是 Cleaner 释放的确定性保证。

## 第三轮：结构审

- 按“选择困惑 → HeapBuffer → DirectBuffer → Cleaner → Bits 限额 → wrap → trade-off”组织。
- 未提前展开 Netty 引用计数和池化，只作为 Ch4 导航。
- wrap 与 DirectBuffer 分开处理，避免把“共享数组”和“native address”混成同一类零拷贝。

## 第四轮：读者审

- 删除代码块后，Heap/Direct 的选择、回收差异、OOM 原因和 wrap 共享语义仍能复述。
- 覆盖误解：零拷贝、MaxDirectMemorySize、Cleaner、wrap copy、堆外无限空间。
- 用生命周期图和对比表降低概念跳跃。

## 第五轮：边界审

- 明确本文基于 JDK 11、Linux/x86_64，但没有把 native IO 路径的所有复制行为绝对化。
- 明确 direct memory 额度、GC 回收延迟和进程其他 native 内存的边界。
- 明确 Ch1-03/Ch4 是后续展开，不把后文实现当作本篇已证事实。

## 第六轮：方法论审

- 篇级依赖规划已落盘：`02-heap-vs-direct.rewrite-plan.md`。
- 正文位于 `vol-netty`，未修改 `vol-02`/`vol-java`。
- 禁用词扫描通过。
- 当前篇幅以问题闭环、深度和广度为准，不以 8000 字作为硬门槛。
- 独立复核 `Direct-X-Buffer.java.template` 确认 `Deallocator.run()` 在 `freeMemory` 后调用 `Bits.unreserveMemory`，正文未遗漏额度归还语义。
- 独立复核 `Bits.java` 确认 reserve 失败路径先等待引用处理，再触发 `System.gc()` 与 9 次退避，不存在“直接 System.gc 后固定等待”的过度简化。
- 当前未发现需要返工的高风险事实问题。
