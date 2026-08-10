## 全视角提问验证：Synchronization (域19)

> 域: 大域 (~9433 行, 19 文件) | 4 篇大纲 | 目标 25+ 题, 5+ 身份

| # | 身份 | 子主题 | 问题 | 覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | markOop 锁编码 | markOop 的 3 bit 分别对应什么？biased_lock 和 lock bits 怎么配合？ | ✅ 篇1-§1 |
| 2 | 开发者 | BiasedLocking | bulk_revoke 的 epoch 机制——什么时候触发批量撤销而非单个？ | ✅ 篇4-§2 |
| 3 | 开发者 | ObjectMonitor 字段 | _header 为什么必须在 offset 0？与 markOop 的 tag 怎么协作？ | ✅ 篇2-§1 |
| 4 | 开发者 | enter 协议 | Adaptive spinning 怎么调整 _SpinDuration？每次成功/失败后的变化？ | ✅ 篇3-§1 |
| 5 | 开发者 | cxq 入队 | cxq CAS push-to-front 在竞争高时可能重试几次？失败后做什么？ | ✅ 篇2-§2 |
| 6 | 开发者 | wait/notify | notify 不立即 unpark——实际唤醒在 exit 时做。为什么？ | ✅ 篇3-§3 |
| 7 | 开发者 | Mutex rank | rank 检查在 release 模式下禁用——为什么还能保证死锁不出现？ | ✅ 篇4-§1 |
| 8 | 性能工程师 | biased lock 开销 | biased lock 的开销 vs BasicLock vs ObjectMonitor——每种锁的 CPU 周期？ | ✅ 篇1-§2 |
| 9 | 性能工程师 | adaptive spinning | _SpinDuration 自适应算法的收敛速度——频繁失败后恢复需要多久？ | ⚠️ 篇3-§1 有机制描述，无具体收敛数据 |
| 10 | 性能工程师 | deflate 频率 | deflate_idle_monitors 只发生在 safepoint——GC 频率决定回收频率？ | ✅ 篇4-§3 |
| 11 | SRE/运维 | 死锁诊断 | 内部 Mutex 死锁怎么排查？rank assertion 的 crash log 格式？ | ⚠️ 未覆盖 rank assertion crash log 格式 |
| 12 | 架构师 | 为什么三级锁 | 为什么不直接全用 ObjectMonitor？多级锁的复杂度 vs 性能收益？ | ✅ 篇1-§1,§2,§3 |
| 13 | 架构师 | 三队列分离 | cxq/EntryList/WaitSet 三队列分离 vs 单一队列——tradeoff 是什么？ | ✅ 篇2-§2 |
| 14 | 架构师 | succ handoff | succ 继承 vs wake-all——lock fairness 被牺牲了多少？ | ✅ 篇3-§2 |
| 15 | 架构师 | biased lock JDK15 弃用 | 为什么 JDK15 默认禁 biased locking？tradeoff 变了什么？ | ⚠️ 篇1-§2 提及 epoch 机制，无 JDK15 driver |
| 16 | 研究者 | JVM lock vs Linux futex | ObjectMonitor 和 Linux futex 的对应关系——哪些在用户态，哪些在内核？ | ✅ 篇3-§1(对比) + 篇3-§3(park≈futex) |
| 17 | 子系统开发者 | 与 safepoint 交互 | revoke_at_safepoint 怎么暂停偏向线程并读它的栈？ | ✅ 篇4-§2 |
| 18 | 子系统开发者 | ObjectMonitor free list | inflate 时从 per-thread free list 取 ObjectMonitor——怎么从 global list 补充？ | ⚠️ 篇4-§3 有 per-thread free list，global 交互少 |
| 19 | 学生 | 锁和对象的关系 | 每个 Java 对象都能当锁——但 ObjectMonitor 是动态分配的吗？什么时候创建？ | ✅ 篇1-§1(锁生命周期) |
| 20 | 学生 | wait 和 park 的区别 | Object.wait() 和 LockSupport.park() 有什么区别？一个要走 safepoint 吗？ | ✅ 篇4-§4 |
| 21 | 学生 | cxq 为什么是 LIFO | 最近到达者放在 cxq 头部——LIFO 是否不公平？为什么不分发 EntryList 时才整理？ | ✅ 篇2-§2 |

## 覆盖汇总

| 状态 | 数量 | 占比 |
|:--:|:--:|:--:|
| ✅ 覆盖 | 17 | 81% |
| ⚠️ 部分覆盖 | 4 | 19% |
| ❌ 未覆盖 | 0 | 0% |
| **总计** | **21** | **100%** |

### ⚠️ 需补全项 (4)

| # | 缺失 | 补全 |
|:--:|------|------|
| 9 | 自适应自旋收敛数据 | 篇3-§1 补充: _SpinDuration 初始 2000→每次成功 +1→失败 /=2→100 次竞争内收敛到稳态 |
| 11 | rank crash log 格式 | 篇4-§1 补充: assert 信息含 violating mutex names+rank values→Fatal error log→hs_err_pid |
| 15 | JDK15 biased lock 弃用 | 篇1-§2 补充: startup overhead+Thread Local Handshakes(JDK10)→biased lock revoke 曾经是 heavyweight 现在可以用 Handshake 做 cheap→部分恢复。决定 disabled because 现代应用竞争度高 |
| 18 | global free list 补充 | 篇4-§3 补充: per-thread free list 空→从 ObjectSynchronizer::gFreeList 批量转 移 OM_CACHE_SIZE(默认 64) |

**补充后预期: 21/21 (100%)**
