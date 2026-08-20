# 04-storage-alloc 重写规划

> 状态：本轮已按一轮闭环执行；保留该 plan 作为后续二轮 consistency pass 的工件
> 适用规范：`docs/openjdk/WRITING-GUIDELINES.md`
> 目标：把当前“allocator/hash table/overflow 说明文”重写成一篇围绕“信号里不能随便 malloc，但又必须把调用栈身份在有限内存下安全保存”的机制文章

## 1. 读者困惑

- 采样信号里不能安全走普通 malloc，那 async-profiler 每次怎么保存调用栈？
- 为什么需要同时有 `LinearAllocator` 和 `CallTraceStorage` 两层，而不是一个大数组或一条栈一份拷贝？
- 相同调用栈为什么不会被每次都完整复制？
- `--memlimit` 到了之后，系统为什么不是淘汰旧数据，而是显式进入 overflow？
- `storage_overflow` 和 `storeCallTrace()` 返回 `NULL` 到底是不是同一条降级链？

## 2. 一句话顿悟

**async-profiler 把“保存采样栈”拆成了两层：`LinearAllocator` 只负责在 signal-friendly 的 chunk 里顺序物化唯一 trace，`CallTraceStorage` 负责按完整帧序列 hash 复用 trace 身份并累计计数；内存到顶时停止接收新 trace 身份，用显式 `storage_overflow` 暴露降级，而不是让热路径继续乱分配。**

## 3. 总图

```text
recordSample()
  → 复用的 ASGCT_CallFrame 临时缓冲区
    → CallTraceStorage.put()
      → LongHashTable：trace 身份 / samples / counter
      → LinearAllocator：唯一 CallTrace 物化
        → collectSamples / collectTraces
          → FrameName / flamegraph / JFR / OTLP
```

## 4. 关键边界

- 热路径避免普通 malloc 和不可控库分配，但 Linux 下仍可在边界场景使用 `OS::safeAlloc()` 的裸 mmap syscall。
- `LinearAllocator` 不是“永不分配”，而是把常态分配压成 chunk 内 CAS 推进，把边界扩容压到受控 OS 映射路径。
- `CallTraceStorage` 的去重是“完整 `ASGCT_CallFrame` 序列按 hash 复用”，不是 flamegraph Trie，也不是前缀树压缩。
- `memlimit` 当前不是逐出旧记录，而是停止接收新 trace，并通过 `OVERFLOW_TRACE_ID` 暴露降级。
- `storage_overflow` 与 `storeCallTrace()==NULL` 不是同一条降级链。

## 5. 本轮重写主线

1. 用“signal 里不能随便 malloc，但每次又得保存栈”开场。
2. 否定：每次样本直接 malloc、所有线程共用一个大锁数组、到达 memlimit 后淘汰旧数据。
3. 先讲 `LinearAllocator` 解决“如何安全拿到一段连续空间”。
4. 再讲 `CallTraceStorage` 解决“为什么不重复存相同完整栈”。
5. 最后讲 memlimit / overflow / allocator failure 三种边界如何区分。
6. 收网时明确 flamegraph/JFR/OTLP 都只是后续消费者，不是这里的存储结构本身。
