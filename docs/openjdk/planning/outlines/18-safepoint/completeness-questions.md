## 全视角提问验证：Safepoint (域18)

> 域: 普通域 (~2296 行, 7 文件) | 2 篇大纲 | 目标 20+ 题, 5+ 身份

| # | 身份 | 子主题 | 问题 | 大纲覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | begin() | begin() spinning→blocking 的精确转换条件？_defer_thr_suspend_loop_count 默认多少？ | ✅ 篇1-§2 |
| 2 | 开发者 | safepoint_counter | _safepoint_counter 从奇数→偶数发生在 end() 的哪一步？为什么要在 _state 复位之前？ | ✅ 篇1-§1 |
| 3 | 开发者 | polling | thread_local_poll 中 `local_poll()` 读的是什么字段？在哪更新？ | ✅ 篇2-§1 |
| 4 | 开发者 | _poll_bit | _poll_bit=8 怎么区分 armed/disarmed？mprotect 保护的是整页还是部分？ | ✅ 篇2-§1 |
| 5 | 开发者 | NoSafepointVerifier | NoSafepointVerifier 怎么检测 safepoint 发生过？counter 怎么避免假阳性？ | ✅ 篇2-§2 |
| 6 | 开发者 | cleanup tasks | 7 项 cleanup task 的执行顺序——顺序有要求吗？为什么 CLD purge 必须最后？ | ✅ 篇1-§3 |
| 7 | 性能工程师 | safepoint 延迟 | SafepointStats 中的 time_to_spin/time_to_sync ——哪个主要贡献 safepoint pause？ | ✅ 篇1-§2(phase1/phase2) |
| 8 | 性能工程师 | thread_local_poll vs global | 从 -XX:+UseThreadLocalSafepoints 的性能提升——在少线程 vs 多线程下的差异？ | ✅ 篇2-§1(3000x对比) |
| 9 | 性能工程师 | critical native | critical native 线程让 safepoint 等多久？超时后的行为？ | ✅ 篇2-§3 |
| 10 | SRE/运维 | safepoint 日志 | `-XX:+PrintSafepointStatistics` 输出的关键字段：vmop_name/sync_time/total_time——怎么判断 "safepoint 过长"？ | ⚠️ 篇1-§2 有 statistics 描述，无具体日志格式 |
| 11 | SRE/运维 | GC pause = safepoint？ | GC log 中的 "Total time for which application threads were stopped" 和 safepoint time 的关系？ | ⚠️ 篇1-§2 提及 GC 用 safepoint，无 GC log 对照 |
| 12 | 架构师 | 为什么 polling 不基于 timer | Linux timer signal 可以打断线程——为什么不用 SIGALRM/SIGPROF 触发 safepoint 而非要 polling？ | ⚠️ 篇2-§1 有机制对比，无 timer 方案讨论 |
| 13 | 架构师 | spinning→blocking 两阶段 | 为什么需要 spinning 阶段？直接 blocking 有什么问题？ | ✅ 篇1-§2 |
| 14 | 架构师 | thread_local_poll 引入 | JDK10 引入 thread local poll 的驱动因素？Shenandoah GC 的频繁 safepoint ？ | ⚠️ 篇2-§1 提及快慢，无 driver 说明 |
| 15 | 研究者 | safepoint vs handshake | 有了 Handshake，safepoint 还有必要吗？哪些场景必须用 safepoint？ | ✅ 篇2-§3(对比), 域17 03 |
| 16 | 研究者 | page trap vs IPI | Global page trap 的 mprotect→TLB shootdown 和 IPI 的 all-CPU 中断对比？ | ⚠️ 篇2-§1 有 [内核: mprotect] 注释，无 IPI 对比 |
| 17 | 子系统开发者 | VM_Operation 编排 | VM_Operation::evaluate_at_safepoint() 和 begin() 的交互？嵌套 safepoint 可能吗？ | ⚠️ 篇1-§1 有 begin/state，VM_Operation 交互未展开 |
| 18 | 学生 | 什么叫 safepoint | "安全点"是什么意思？为什么叫 safe？怎么保证所有线程都到？ | ✅ 篇1-§1,§2 |
| 19 | 学生 | GC 为什么需要 safepoint | 为什么 GC 扫描栈不能等线程在别的时间停？safepoint 提供什么别的方案没有的？ | ✅ 篇1-§3(cleanup tasks) |
| 20 | 学生 | polling 在哪插入 | JIT 在什么位置插入 polling 指令？循环回边/方法返回/任何地方？ | ✅ 篇2-§1 |

## 覆盖汇总

| 状态 | 数量 | 占比 |
|:--:|:--:|:--:|
| ✅ 覆盖 | 14 | 70% |
| ⚠️ 部分覆盖 | 6 | 30% |
| ❌ 未覆盖 | 0 | 0% |
| **总计** | **20** | **100%** |

### ⚠️ 需补全项 (6)

| # | 缺失内容 | 补全方式 |
|:--:|------|------|
| 10 | PrintSafepointStatistics 日志格式 | 篇1-§2 补充: vmop_name + sync_time(从begin到synchronized) + total_time = 参考阈值(>100ms→排查) |
| 11 | GC pause vs safepoint time | 篇1-§2 补充: GC pause = safepoint time + GC work time. Safepoint begin→synchronized=VM op 同步开销, GC work=实际标记/复制 |
| 12 | 为什么不用 timer signal | 篇2-§1 补充: timer signal 是异步的——线程可能在 VM 临界区(持有锁)→不能停。polling 让线程自主决定什么时候安全 |
| 14 | thread_local_poll JDK10 driver | 篇2-§1 补充: Shenandoah GC 的 Barrier 需要频繁全局同步——global page trap 的 mprotect 开销变成 bottleneck |
| 16 | page trap vs IPI | 篇2-§1 补充: mprotect TLB shootdown 广播到所有核刷新→类似 IPI——但 mprotect 的延迟在 µs 级而 IPI 在 ns 级。safepoint 频率低(10/s)→µs 开销可接受 |
| 17 | VM_Operation 编排 | 篇1-§2 补充: begin() 是由 VM_Operation::evaluate() 调用的——VM thread 检查是否有 pending operation→调 safepoint→执行 op→end。嵌套 safepoint 不可——_state == _synchronized 时 begin() 无操作 |

**补充后预期: 20/20 (100%)**
