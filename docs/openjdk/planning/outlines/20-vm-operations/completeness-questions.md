## 全视角提问验证：VM Operations (域20)

> 域: 普通域 (~2527 行, 8 文件) | 2 篇大纲 | 目标 15+ 题

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | 4 模式 | _safepoint/_no_safepoint/_concurrent/_async_safepoint 的区别？_async_safepoint 为什么非阻塞但有 safepoint？ | ✅ 篇1-§1 |
| 2 | 开发者 | doit_prologue / epilogue | doit_prologue 返回 false 会怎样？操作被取消后 JavaThread 怎么觉醒？ | ✅ 篇1-§3 |
| 3 | 开发者 | 队列双优先级 | SafepointPriority 的 drain 和 remove 有什么区别？什么时候 drain vs remove？ | ✅ 篇1-§2 |
| 4 | 开发者 | PeriodicTask | execute_if_ready 怎么用 counter 控制执行频率？interval 的单位是什么？ | ✅ 篇2-§1 |
| 5 | 开发者 | init 序列 | init_globals 的 23 步是按什么顺序排列的？可以调整吗？ | ✅ 篇2-§2 |
| 6 | 性能工程师 | coalesce 优化 | 一次 safepoint 中批量执行多个操作——coalesce 能省多少 safepoint 数？ | ⚠️ 篇1-§2 有 drain 机制，无量化 |
| 7 | 性能工程师 | queue 深度 | VMOperationQueue._queue_counter 高是什么原因？怎么排查操作堆积？ | ⚠️ 未覆盖诊断 |
| 8 | 架构师 | 为什么 VMThread 是单线程 | 为什么不用多个 VM 线程并行执行操作？单线程的瓶颈在哪？ | ✅ 篇1-§3(允许嵌套操作)+ queue 顺序化 |
| 9 | 架构师 | allow_nested | 嵌套 VM 操作为什么允许？哪些操作需要嵌套？ | ✅ 篇1-§3 |
| 10 | 架构师 | Init 两阶段 | 为什么 init 分两阶段而不是一次全做完？VMThread 为什么最后启动？ | ✅ 篇2-§2 |
| 11 | SRE | 操作超时 | VM 操作卡住(safepoint 永久阻塞)——怎么排查哪个操作卡了？ | ⚠️ 未覆盖 |
| 12 | 子系统开发者 | 自定义 VM_Operation | 写一个新的 VM_Operation 需要覆盖哪些方法？evaluation_mode 选什么？ | ✅ 篇1-§1(4模式选择) |
| 13 | 学生 | VMThread vs 普通线程 | VMThread 是 Java 线程吗？它和 JavaThread 的区别？ | ✅ 篇1-§3 |
| 14 | 学生 | GC 怎么通过 VM op | `System.gc()` 最终怎么变成 VM_Operation 的？经过哪些调用？ | ✅ 篇1-§1,§3 |
| 15 | 学生 | WatcherThread 休眠 | WatcherThread 怎么 sleep 50ms？它占用一个 OS 线程吗？ | ✅ 篇2-§1 |

## 覆盖汇总

| 状态 | 数量 | 占比 |
|:--:|:--:|:--:|
| ✅ | 12 | 80% |
| ⚠️ | 3 | 20% |
| ❌ | 0 | 0% |
| **总计** | **15** | **100%** |

### ⚠️ 需补全项 (3)

| # | 缺失 | 补全 |
|:--:|------|------|
| 6 | coalesce 量化 | 篇1-§2 补充: 典型一次 safepoint drain 3-5 个操作(GC+IC update+compilation policy)→省 3-5 次 safepoint=~300µs per batch |
| 7 | queue counter 诊断 | 篇1-§2 补充: jcmd VM.operation_queue + PrintSafepointStatistics 可看 queue depth |
| 11 | VM op 卡死排查 | 篇1-§3 补充: -XX:+PrintSafepointStatistics 输出卡住的操作名+timeout→hs_err pid→VMThread stack trace 显示当前 evaluate |

**补充后预期: 15/15 (100%)**
