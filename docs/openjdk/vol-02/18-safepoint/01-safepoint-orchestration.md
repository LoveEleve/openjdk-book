# 01. JVM 怎么让所有线程同时停住？— Safepoint 编排

> **前置依赖**:[01-os/04 — 一个 SIGSEGV,五件事一起做 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):轮询页的信号侧已拆过——本篇的"arm 轮询页"细节引用它,不重复;[17-threads/01 — 线程层级与生命周期](openjdk/vol-02/17-threads/01-thread-hierarchy.md):JavaThread 状态机与 ThreadSafepointState 的宿主;[24-frame/03 — Deopt 重建 + GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md):栈锚 walkable 的消费方;[09-memory-core/01 — Universe + CollectedHeap](openjdk/vol-02/09-memory-core/01-universe-heap.md):GC 是 safepoint 最大的消费者
> → **后续**:[18-safepoint/02 — 轮询与验证器](02-polling-verifiers.md):线程怎么"看到"安全点
> 关联域: 25-gc(STW 依赖它)、20-vmops(VM 操作触发它)、19-sync(monitor deflation 在 cleanup)

## 一个让 200 个线程"同时"停住的指挥系统

GC 要扫描所有线程的栈、重排对象——扫描期间**不能有任何线程在改堆**。这不是"请各位暂停一下"的礼貌请求,而是硬性纪律: 全世界必须在同一瞬间停摆,做完事再一起放行。实现它的是一套**三态全局状态 + 每线程到达协议**的编排系统——`SafepointSynchronize`。这一篇拆指挥端(VM 线程的 begin/end)与响应端(Java 线程的 block),以及停摆窗口里的维护任务。

## 1. 三态机: 全世界的"红灯"

全局状态 `_state` 只有三档(safepoint.hpp:61-66):

```cpp
// safepoint.hpp:61-66(截取核心,逐字)
  enum SynchronizeState {
      _not_synchronized = 0,                   // Threads not synchronized at a safepoint
                                               // Keep this value 0. See the comment in do_call_back()
      _synchronizing    = 1,                   // Synchronizing in progress
      _synchronized     = 2                    // All Java threads are stopped at a safepoint. Only VM thread is running
  };
```

`_state` 是 **`static volatile`**(safepoint.hpp:107,注释明说 "Threads might read this flag directly, without acquiring the Threads_lock")——Java 线程在轮询路径上**直接读这个值**,不碰锁;volatile 读在 x86 上就是一条 mov。`_not_synchronized` 取 **0 是刻意的**(:63 注释 "Keep this value 0. See the comment in do_call_back()"): `do_call_back()` 的判定是 `_state != _not_synchronized`(safepoint.hpp:170-172)——与 0 比较可以编译成最短的 `test` 指令,省一条指令。

**关键的第二个全局量是 `_safepoint_counter`**(safepoint.hpp:112-119): 注释说得很直白——"This counter is used for fast versions of jni_Get<Primitive>Field. **An even value means there is no ongoing safepoint operations.** The counter is incremented ONLY at the beginning and end of each safepoint"。它有三个消费者:

1. **JNI 字段访问的汇编快速路径** `jniFastGetField`(jniFastGetField.hpp:29-49): 偶数时**投机读取字段值**,读完**再读一次 counter 做二次校验**——两次相同说明读取期间没发生 safepoint,直接返回;不同(期间 safepoint 开始了,counter 变奇数)就重走慢路径——防止读取途中 GC 移动了对象。这不是"一条 testb 就直读",而是"投机读 + 双加载校验";
2. **编译侧的安全点检测**: `ciMethodData::has_safepointed()`(ciMethodData.cpp:59-81)——ci 层记下编译开始时的 counter,结束时不同就说明**编译期间发生过 safepoint**(12-ci 域"编译与 GC 互不干扰"的检测手段);
3. **依赖上下文断言**: `dependencyContext`(dependencyContext.hpp:121-127)在依赖解析期间断言 counter 未变——"safepoint happened" 会触发断言。

counter 只在 begin/end 各 +1,且两次递增间持着 Threads_lock,保证配对。

## 2. begin(): VM 线程的指挥

`begin()`(safepoint.cpp:155)只能由 **VM 线程**执行(:158 assert),流程:

1. **`Threads_lock->lock()`**(:169)——先锁线程表: 保证同步期间**没有线程启动或退出**(注释 :167-168),这把锁要一直持有到 end() 才放;
2. `_waiting_to_block = nof_threads`(:185)——**要等的人数**,每有一个线程"到安全点"就减一;
3. **`_state = _synchronizing`**(:242)——亮黄灯;
4. **武装轮询机制**(:244-268): JDK11 有两条路,而 **x86_64 默认走 thread-local poll**(`THREAD_LOCAL_POLL` 宏定义于 globalDefinitions_x86.hpp:68,SafepointMechanism 构造时 `set_uses_thread_local_poll`,safepointMechanism.cpp:37-39)——给每个线程置本地 poll 标志(`arm_local_poll`,:244-252);编译代码/解释器的轮询是 `testb` **线程自己的 `_polling_page` 字段**(macroAssembler_x86.cpp:3744-3756,interp_masm_x86.cpp:832-834 "Thread-local Safepoint poll")——**不触发 SIGSEGV**。全局轮询页(`PageArmed=1` + `os::make_polling_page_unreadable()` + `Interpreter::notice_safepoints()`,:260-268)是另一条路——01-os/04 讲的 SIGSEGV 轮询页正是它,但对 JDK11 x86 来说不是默认路径;
5. **`os::serialize_thread_states()`**(:257)——只在 `!UseMembar` 时执行(x86 默认 UseMembar=true 走正常 membar): 让所有线程先写自己的状态到**同一内存页**,再 mprotect 序列化这些写(:219-226 注释,比逐线程 membar 便宜)——这是无 membar 平台的替代品;
6. **逐线程点名**: 主循环遍历所有线程,`examine_state_of_thread()`(safepoint.cpp:1045)判定每个线程的处境:
   - **已挂起或已安全**(native/blocked 等,safepoint_safe :760-774)→ `roll_forward(_at_safepoint)`——`signal_thread_at_safepoint()` 把 `_waiting_to_block` 减一(:1108);
   - **_thread_in_vm**(正在 VM 里)→ `_call_back`(让它继续跑到自愿阻塞点,:1088-1090);
   - **其他**(Java/native 过渡)→ 保持 `_running`,靠轮询或状态转换自然到达(:1093-1099)。
   每轮扫完,没停完就进入**等待**,三档递进(safepoint.cpp:390-398):

```cpp
// safepoint.cpp:388-398(截取核心,逐字)
          // Instead of (ncpus > 1) consider either (still_running < (ncpus + EPSILON)) or
          // ((still_running + _waiting_to_block - TryingToBlock)) < ncpus)
          ++steps ;
          if (ncpus > 1 && steps < safepoint_spin_before_yield) {
            SpinPause() ;     // MP-Polite spin
          } else
            if (steps < _defer_thr_suspend_loop_count) {
              os::naked_yield() ;
            } else {
              os::naked_short_sleep(1);
            }
```

**关键设计 (斜体)**: *大纲说的"两阶段 spin→block"实际是**三档递进**: `SpinPause()`(PAUSE 指令,少线程没到、乐观等)→ `naked_yield()`(让出 CPU,`_defer_thr_suspend_loop_count`=4000 次前,safepoint.cpp:148)→ `naked_short_sleep(1)`(放弃本轮;注释 :338-339 提醒: OS 常把"短睡"取整到 10ms,睡过头反而拖慢)。:327-378 的大注释把权衡讲透了: 自旋耗 CPU,但上下文切换同样贵——VM 线程优先级还高于普通 Java 线程,自旋太久会饿死还没到达的 mutator。档位越低,说明剩下的线程越少、越可能"马上到"。*

等不到 `_waiting_to_block` 归零时进入**阻塞等待**: `Safepoint_lock->wait(true)`(safepoint.cpp:423,非忙等;SafepointTimeout 时带时限)——**最后一个线程到达时 `Safepoint_lock->notify_all()` 唤醒 VM 线程**(safepoint.cpp:866-867)。然后: `_safepoint_counter++`(:450,变奇数)→ `_state = _synchronized`(:453)→ `OrderAccess::fence()`(:455)→ **`do_cleanup_tasks()`**(:481,第 4 节)——cleanup 是"同步完成后、VM op 执行前"的固定环节。

[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/18-safepoint-demo.txt) `-Xlog:safepoint` 看得到完整过程: `Entering safepoint region: EnableBiasedLocking`(冒号后是**触发它的 VM 操作名**)→ `Leaving safepoint region` → `Total time for which application threads were stopped: 0.0001122 seconds, Stopping threads took: 0.0000389 seconds`(停摆总时长/停线程耗时)。`-XX:+PrintSafepointStatistics`(JDK11 已标 deprecated 但可用)给出统计表: `vmop [threads: total initially_running wait_to_block][time: spin block sync cleanup vmop] page_trap_count`——begin() 里收集的 `SafepointStats`(safepoint.hpp:92-104)的打印形态。

## 3. 响应端: 线程怎么"到达"

每种线程的停止机制不同(begin() 开头的大注释,safepoint.cpp:202-236): 编译代码与解释器靠轮询(thread-local 模式下 `testb` 线程的 poll 位;全局页模式下解释器切 dispatch 表、编译代码靠轮询页 SIGSEGV——两条路详见下一篇与 01-os/04)、native 返回时检查、阻塞线程不唤醒、VM 内线程跑到自愿阻塞点。到达的公共入口是 `block()`(safepoint.cpp:816):

```cpp
// safepoint.cpp:880-886(截取核心,逐字)
      // We now try to acquire the threads lock. Since this lock is hold by the VM thread during
      // the entire safepoint, the threads will all line up here during the safepoint.
      Threads_lock->lock_without_safepoint_check();
      // restore original state. This is important if the thread comes from compiled code, so it
      // will continue to execute with the _thread_in_Java state.
      thread->set_thread_state(state);
      Threads_lock->unlock();
```

[C++:] 这段值得细看: 线程先抢 `Safepoint_lock`,**`_waiting_to_block--` 并(若自己是最后一个)`notify_all` 唤醒 VM 线程**(:853-868);然后置 `_thread_blocked`、放掉 Safepoint_lock,去**排队抢 `Threads_lock`**——而 Threads_lock 被 VM 线程从 begin() 一路持有到 end(),所以**所有线程在此排成一队、全部卡住**;end() 里 `Threads_lock->unlock()`(safepoint.cpp:590)一次放行。**大纲说"end 里 Safepoint_lock->notify_all 叫醒等待线程"是错的**——等待线程阻塞在 Threads_lock 上,Safepoint_lock 的 notify_all 只是唤醒 VM 线程本人。阻塞前还有一件重要的事: `thread->frame_anchor()->make_walkable(thread)`(:834)——把栈锚设成"可走"(24 域: GC 扫栈的前提)。

**每线程的安全点状态** `ThreadSafepointState`(safepoint.hpp:228-277)三态: `_running`(还没到)/`_at_safepoint`(已到,如阻塞在锁上)/`_call_back`(继续跑等回调,safepoint.hpp:233-237)。`examine_state_of_thread` 的判定 + `roll_forward`(:1103)的登记,就是"点名"协议本身。

## 4. cleanup: 停摆窗口里的 7 项维护

所有线程停住后、正式干正事(如 GC)前,有个固定节目: **safepoint cleanup**。入口 `do_cleanup_tasks()`(safepoint.cpp:731): 若 GC 提供了 WorkGang 就**并行**,否则 VM 线程串行——执行 `ParallelSPCleanupTask::work`(safepoint.cpp:647): 每线程处理(deflate 线程本地 monitor + 标记活跃 nmethod,:649)+ **7 项子任务**(每项 `is_task_claimed` 保证只做一次):

1. `DEFLATE_MONITORS`——清理空闲 ObjectMonitor(19 域 deflation);
2. `UPDATE_INLINE_CACHES`——`InlineCacheBuffer::update_inline_caches()`(16 域 IC);
3. `COMPILATION_POLICY`——`CompilationPolicy::do_safepoint_work()`(13 域策略的 safepoint 钩子);
4. `SYMBOL_TABLE_REHASH`——符号表 rehash;
5. `STRING_TABLE_REHASH`——字符串表 rehash;
6. `CLD_PURGE`——清理死类加载器的 metadata;
7. `SYSTEM_DICTIONARY_RESIZE`——类字典扩容。

**关键设计 (斜体)**: *这些任务的共同点是"没有并发线程才能做": rehash 时若有线程正在查表,重排桶会导致 dangling pointer;CLD purge 遍历 ClassLoaderData 链表时不能有线程在加新类加载器。safepoint 恰好提供了"全世界静止"这个保证——所以它们被塞进停摆窗口。* 至于"这个 safepoint 值不值得做": **没有待办 VM 操作时,VM 线程会主动判断要不要发一次"空 safepoint"专门做 cleanup**——`no_op_safepoint_needed`(vmThread.cpp:440): `is_cleanup_needed()` 为真,或距上次 safepoint 超过 `GuaranteedSafepointInterval`(兜底,保证不会太久没停过)——[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/18-safepoint-demo.txt) 日志里 `Entering safepoint region: Cleanup` 就是这种空 safepoint;不值得就不做,避免每次 GC 都白付清理费。

## 5. end(): 撒开栓

`end()`(safepoint.cpp:499)按**相反顺序**放行:

1. `_safepoint_counter++`(:503,**变偶数**——JNI fast path 重新可用);
2. **解除武装**: `os::make_polling_page_readable()` + `PageArmed=0`(:527-532)、`Interpreter::ignore_safepoints()`(:534-537);
3. 复位状态: 全局 poll 模式逐个 `restart()` 线程(:554-583,注释里那段"Solaris 重启线程被抢占"的历史教训挺有意思);thread-local 模式先 `_state = _not_synchronized` 再逐线程 restart+disarm(:544-553);
4. **`Threads_lock->unlock()`**(:590)——被 block() 排队卡住的线程从这里全部放行。

[实证:](openjdk/planning/outlines/00-jvm-tools/materials/commands/18-safepoint-demo.txt) 日志里 `Leaving safepoint region` 就是 end() 完成的标记;两次 `jcmd GC.run` 触发的 `Entering safepoint region: GC_Collection` 之间,`Application time` 记录的是应用线程连续运行时长。

## 核心悬念

编排端拆完了: 三态机(`_not_synchronized=0` 省指令、volatile 直读不碰锁)双全局量(counter 偶数=JNI fast path);begin() 指挥(锁线程表→亮黄灯→武装轮询→逐线程点名→三档等待→阻塞等最后一个→counter 奇数→cleanup);block() 响应(抢 Safepoint_lock 报数、排队卡在 Threads_lock);cleanup 7 项维护;end() 放行(counter 偶数→解除武装→restart→unlock)。一句话: **safepoint 是"VM 线程持锁当门闩、200 个线程排队进门"的集体停摆**——`_waiting_to_block` 是点名册,counter 是红绿灯。

但还有一个关键问题留给了下一篇: 线程**怎么知道**该停了?编译代码/解释器的轮询(`testb` 线程的 `_polling_page`,thread-local 默认;全局页模式读 `_state` 地址,macroAssembler_x86.cpp:3756-3759)、native 返回检查——这些"轮询"本身是怎么实现的?它们凭什么**零开销**(不触发 safepoint 时)?

> → [18-safepoint/02 — 轮询与验证器](02-polling-verifiers.md)
