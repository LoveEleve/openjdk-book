## 全视角提问验证：Threads (域17)

> 域: 大域 (~10900 行, 16 文件) | 4 篇大纲 | 目标 30+ 题, 5+ 身份

| # | 身份 | 子主题 | 问题 | 大纲覆盖 |
|:--:|------|------|------|:--:|
| 1 | 开发者 | Thread 层次 | Thread→JavaThread→NonJavaThread→NamedThread 的精确继承链？JavaThread 和 NonJavaThread 是否可以互转？ | ✅ 篇1-§1,§2,§3 |
| 2 | 开发者 | JavaThread 字段 | JavaThread 的 _anchor/_deopt_nmethod/_vframe_array 之间有什么关系？deopt 时怎么用？ | ✅ 篇1-§2 |
| 3 | 开发者 | trans_and_fence | trans_and_fence 在 x86 上具体是什么指令？为什么需要 StoreLoad fence？ | ✅ 篇2-§2 |
| 4 | 开发者 | Thread-SMR | ThreadsListHandle 的 fast_path 和 nested_path 怎么区分？什么时候走 nested？ | ✅ 篇3-§1 |
| 5 | 开发者 | smr_delete | smr_delete 后 Thread 对象什么时候真正被 delete？to_delete_list 的清理时机？ | ✅ 篇3-§1 |
| 6 | 开发者 | Handshake | HandshakeState::process_by_self 和 try_process_by_vmThread 的区别？谁决定用哪个？ | ✅ 篇3-§2 |
| 7 | 开发者 | RAII 守卫 | ThreadInVMfromJava 从构造到析构的完整生命周期？析构时怎么检查 async exception？ | ✅ 篇4-§1 |
| 8 | 开发者 | termination | JavaThread 的 termination 四状态——_vm_exited 和 _thread_terminated 的区别？ | ✅ 篇2-§3 |
| 9 | 性能工程师 | TLAB | TLAB 在 Thread 基类中——所有线程类型都有 TLAB？WorkerThread 的 TLAB 被用到吗？ | ⚠️ 篇1-§1 提及 TLAB 字段，WorkerThread 细节少 |
| 10 | 性能工程师 | polling_page | polling_page 的 mprotect 开销——safepoint 频率高时有影响吗？ | ⚠️ 篇2-§4 有机制描述，无性能数据 |
| 11 | 性能工程师 | smr 统计 | Thread-SMR 的统计指标(_tlh_time_max/_deleted_thread_time_max)怎么解读？ | ⚠️ 篇3-§1 有机翻描述，无解读方法 |
| 12 | SRE/运维 | 线程泄漏 | 怎么判断有 Thread 泄漏？JavaThread 数量超过预期——从哪个字段查？ | ⚠️ 未覆盖诊断视角 |
| 13 | SRE/运维 | 线程 dump | jstack 如何获取线程状态？它走的是 Thread-SMR 还是 safepoint 路径？ | ⚠️ 篇3-§2 有 Handshake，jstack 实现路径未展开 |
| 14 | 架构师 | 为什么分 JavaThread/NonJavaThread | 为什么不能用一个 Thread 类表示所有线程？JavaThread 和 NonJavaThread 的本质区别是什么？ | ✅ 篇1-§2,§3 |
| 15 | 架构师 | thread state vs safepoint | 为什么设计 5 状态而非 3 状态（Java/Native/Blocked 就够了）？为什么需要 _thread_in_vm 和 _thread_blocked 分开？ | ✅ 篇2-§1,§2 |
| 16 | 架构师 | Handshake vs safepoint | Handshake 能替代 safepoint 吗？哪些场景必须用 safepoint 不能用 Handshake？ | ✅ 篇3-§2(对比表) |
| 17 | 架构师 | hazard_ptr vs reference count | Thread-SMR 选 hazard pointer 而非 reference count 的原因？refcount 有什么问题？ | ✅ 篇3-§1 |
| 18 | 研究者 | smr vs RCU | Thread-SMR 和 Linux RCU 的实现差异？hazard_ptr scan 和 grace period 的区别？ | ⚠️ 篇3-§1 有类比，实现对比未深入 |
| 19 | 研究者 | 与其他 JVM 对比 | V8 isolate 的线程模型 vs HotSpot——单线程 isolate 和多线程共享 VM 的 tradeoff？ | ❌ |
| 20 | 子系统开发者 | 与 GC 交互 | GC worker thread 遍历 JavaThread 栈时——如果目标线程正在 trans_and_fence 中间怎么办？ | ✅ 篇2-§2(mfence), 篇4-§1(trans_and_fence 原子性) |
| 21 | 子系统开发者 | objectMonitor cache | ObjectMonitor 缓存链——怎么从 per-thread cache 取而不锁全局 freelist？ | ⚠️ 篇1-§1 提及字段，缓存算法未展开 |
| 22 | 学生 | 线程 vs OS thread | Java 的 Thread 和 OS 的 pthread 是一一对应吗？Green thread 还存在吗？ | ✅ 篇1-§4(OSThread) |
| 23 | 学生 | 为什么叫 JavaThread | JavaThread 是存 Thread oop 的 C++ 对象——为什么不是一个而是两个对象？ | ✅ 篇1-§2(_threadObj) |
| 24 | 学生 | non-Java thread 怎么工作 | 编译器线程和 GC 线程——它们和 Java 线程有什么区别？有 thread state 吗？ | ✅ 篇1-§3 |
| 25 | 学生 | polling_page | polling_page 是什么？为什么读一个地址能让线程停住？ | ✅ 篇2-§4 |

## 覆盖汇总

| 状态 | 数量 | 占比 |
|:--:|:--:|:--:|
| ✅ 覆盖 | 18 | 72% |
| ⚠️ 部分覆盖 | 6 | 24% |
| ❌ 未覆盖 | 1 | 4% |
| **总计** | **25** | **100%** |

### ⚠️ 需补全项 (6)

| # | 缺失内容 | 补全方式 |
|:--:|------|------|
| 9 | WorkerThread TLAB 使用 | 篇1-§3 补充: WorkerThread(GCTaskThread) 分配 VM objects→_tlab 用于 GC internal allocation |
| 10 | polling_page 性能 | 篇2-§4 补充: mprotect 调用频率 = safepoint 频率(~10/秒 in G1) → ~10 syscalls/sec → 可忽略 |
| 11 | smr 统计解读 | 篇3-§1 补充: _tlh_time_max 高→ThreadsList wait 时间→线程频繁进出→考虑减少 JVMTI agent |
| 12 | 线程泄漏诊断 | 篇3 补充: jcmd Thread.print 统计→对比 ThreadsList::length()→差值 = 未退出的 threads |
| 13 | jstack 实现路径 | 篇3-§2 补充: jstack→VM_ThreadDump→for each thread→Handshake(GetOneFrameClosure)→self-exec |
| 18 | smr vs RCU 实现对比 | 篇3-§1 补充: RCU grace period 基于 quiescent state(所有 CPU 已过 context switch)——SMR 基于 hazard ptr scan——各线程显式声明无指针 |

### ❌ 完全未覆盖 (1)
| # | 缺失 | 补全 |
|:--:|------|------|
| 19 | V8 isolate 对比 | 篇1-§3 补充: V8 isolate 是单线程 execution context——不共享 VM state。HotSpot 多线程共享→需要 Thread-SMR+Handshake→复杂度更高但吞吐更好 |

**补充后预期: 24/25 (96%)**
