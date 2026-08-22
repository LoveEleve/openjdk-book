# 01. JVM 怎么让所有线程同时停住？— Safepoint 编排

> **前置依赖**:[01-os/04 — 一个 SIGSEGV,五件事一起做 — 信号与安全点](openjdk/vol-02/01-os/04-signals-and-safepoint.md):轮询页的信号侧已拆过——本篇的"arm 轮询页"细节引用它,不重复;[17-threads/01 — 线程层级与生命周期](openjdk/vol-02/17-threads/01-thread-hierarchy.md):JavaThread 状态机与 ThreadSafepointState 的宿主;[24-frame/03 — Deopt 重建 + GC 扫描](openjdk/vol-02/24-frame/03-deopt-gc-scan.md):栈锚 walkable 的消费方;[09-memory-core/01 — Universe + CollectedHeap](openjdk/vol-02/09-memory-core/01-universe-heap.md):GC 是 safepoint 最大的消费者
> → **后续**:[18-safepoint/02 — 轮询与验证器](02-polling-verifiers.md)
> 关联域: 25-gc(STW 依赖它)、20-vmops(VM 操作触发它)、19-sync(monitor deflation 在 cleanup)

GC 要扫描所有线程的栈、重排对象——扫描期间**不能有任何线程在改堆**。这不是"请各位暂停一下"的礼貌请求，而是硬性纪律：全世界必须在同一瞬间停摆，做完事再一起放行。实现它的是一套**三态全局状态 + 每线程到达协议**的编排系统——`SafepointSynchronize`。

本篇要回答的核心问题:

1. safepoint 是“信号驱动”还是“轮询协作”？
2. `_safepoint_counter` 的奇偶语义在哪里被消费？
3. VMThread 怎么逐线程点名、等所有人都安全了才放行？
4. cleanup 的 7 项维护为什么必须塞进停摆窗口？

答案先压成一句话：**safepoint 是“VM 线程持锁当门闩、所有线程排队进门”的集体停摆：`_safepoint_counter` 偶数时无 safepoint、奇数时正在 safepoint；begin() 锁线程表 + 亮黄灯 + 武装轮询 + 逐线程点名 + 三档等待；每个线程在 native 返回 / 轮询 / 阻塞点到达 block() 排队卡在 Threads_lock；end() 解除武装 + 放行。cleanup 的 7 项维护利用“全世界静止”做不含并发干扰的操作。**

---

## 1. 三态机：全世界的“红灯”

全局状态 `_state` 只有三档：

```cpp
// safepoint.hpp:61-66(截取核心,逐字)
enum SynchronizeState {
    _not_synchronized = 0,                   // Threads not synchronized at a safepoint
    _synchronizing    = 1,                   // Synchronizing in progress
    _synchronized     = 2                    // All Java threads are stopped at a safepoint
};
```

`_state` 是 static volatile，Java 线程在轮询路径上**直接读这个值**，不碰锁。`_not_synchronized` 取 0 是刻意的：`do_call_back()` 的判定 `_state != _not_synchronized` 可以编译成最短的 `test` 指令。

### 第二个全局量：`_safepoint_counter`

`safepoint.hpp:112-119` 的注释说得很直白：它用于 JNI 快速字段访问，**even = 没有正在进行的 safepoint**；它只在 begin 和 end 各 +1，且两次递增间持着 Threads_lock，保证配对。

`_safepoint_counter` 有三个消费者：

1. **JNI 字段访问汇编快速路径** `jniFastGetField`：偶数时投机读字段，读完再读一次 counter 做二次校验——两次相同说明没发生 safepoint，直接返回；否则重走慢路径。
2. **编译侧安全点检测** `ciMethodData::has_safepointed()`：ci 层记下编译开始时的 counter，结束时不同就说明编译期间发生过 safepoint。
3. **依赖上下文断言** `dependencyContext`：依赖解析期间断言 counter 未变——如果编译期依赖在 safepoint 期间发生变化，相关 deopt 信息必须重新验证。

所以 counter 不只是“轮询计数”，它是多个依赖安全点语义的消费者共享的红绿灯。

---

## 2. begin(): VM 线程的指挥

`begin()`(safepoint.cpp:155)只能由 VM 线程执行，流程是：

1. **`Threads_lock->lock()`**：先锁线程表，保证同步期间没有线程启动或退出；
2. **`_waiting_to_block = nof_threads`**：要等的人数，每有一个线程到安全点就减一；
3. **`_state = _synchronizing`**：亮黄灯；
4. **武装轮询机制**：JDK11 x86_64 默认走 thread-local poll，给每个线程置本地 poll 标志；全局轮询页（`PageArmed=1` + `make_polling_page_unreadable()`）是另一条路，但不是 x86 默认路径；
5. **`os::serialize_thread_states()`**：只在 `!UseMembar` 时执行，让线程状态互相可见；
6. **逐线程点名**：遍历所有线程，`examine_state_of_thread()` 判定每个线程的处境：
   - 已挂起或已安全 → `roll_forward(_at_safepoint)`，`_waiting_to_block` 减一；
   - `_thread_in_vm` → `_call_back`，让它继续跑到自愿阻塞点；
   - 其他 → 保持 `_running`，靠轮询或状态转换自然到达。

每轮扫完，没停完就进入等待，三档递进：

```cpp
// safepoint.cpp:388-398(截取核心,逐字)
++steps;
if (ncpus > 1 && steps < safepoint_spin_before_yield) {
  SpinPause();     // MP-Polite spin
} else if (steps < _defer_thr_suspend_loop_count) {
  os::naked_yield();
} else {
  os::naked_short_sleep(1);
}
```

`SpinPause()` → `naked_yield()` → `naked_short_sleep(1)`。档位越低，说明剩下的线程越少、越可能“马上到”。注意 kernel 通常把 `sleep(1ms)` 取整到 tick 粒度（典型 4-10ms），所以这段放弃等待的实际开销可能比预期高，VMThread 不会轻易进到这一档。

等不到 `_waiting_to_block` 归零时进入阻塞等待：`Safepoint_lock->wait(true)`。最后一个线程到达时 `Safepoint_lock->notify_all()` 唤醒 VMThread。然后：

- `_safepoint_counter++`（变奇数）；
- `_state = _synchronized`；
- `OrderAccess::fence()`；
- `do_cleanup_tasks()`。

---

## 3. 响应端：线程怎么“到达”

每种线程的停止机制不同，但到达的公共入口是 `block()`(safepoint.cpp:816)。它先抢 `Safepoint_lock`，`_waiting_to_block--`，若自己是最后一个则 `notify_all` 唤醒 VMThread；然后置 `_thread_blocked`、放掉 Safepoint_lock，去排队抢 `Threads_lock`。

而 `Threads_lock` 被 VMThread 从 begin() 一路持有到 end()，所以所有线程在此排成一队、全部卡住。end() 里 `Threads_lock->unlock()` 一次放行。

这里要点破一个常见误解：等待线程是阻塞在 `Threads_lock` 上，`Safepoint_lock` 的 `notify_all` 只唤醒 VMThread 本人，而不是“叫醒等待线程”。

阻塞前还有一件重要的事：

```cpp
thread->frame_anchor()->make_walkable(thread);
```

把栈锚设成“可走”，这是 GC 扫栈的前提。

每线程的安全点状态是 `ThreadSafepointState` 三态：`_running` / `_at_safepoint` / `_call_back`。`examine_state_of_thread` 的判定 + `roll_forward` 的登记，就是“点名”协议本身。

---

## 4. cleanup：停摆窗口里的 7 项维护

所有线程停住后、正式干正事前，有个固定节目：**safepoint cleanup**。入口 `do_cleanup_tasks()`(safepoint.cpp:731)，若 GC 提供 WorkGang 就并行，否则 VMThread 串行。

`ParallelSPCleanupTask::work` 里，每线程处理（deflate 线程本地 monitor + 标记活跃 nmethod），加上 7 项子任务：

1. `DEFLATE_MONITORS`——清空闲 ObjectMonitor；
2. `UPDATE_INLINE_CACHES`——更新内联缓存；
3. `COMPILATION_POLICY`——编译策略的 safepoint 钩子；
4. `SYMBOL_TABLE_REHASH`——符号表 rehash；
5. `STRING_TABLE_REHASH`——字符串表 rehash；
6. `CLD_PURGE`——清死类加载器的 metadata；
7. `SYSTEM_DICTIONARY_RESIZE`——类字典扩容。

这些任务的共同点是“没有并发线程才能做”：rehash 时若有线程在查表，重排桶会导致 dangling；CLD purge 遍历 ClassLoaderData 链表时不能有线程在加新类加载器。safepoint 恰好提供了“全世界静止”这个保证。

至于“这个 safepoint 值不值得做”：没有待办 VM 操作时，VMThread 会主动判断要不要发一次**空 safepoint** 专门做 cleanup——`no_op_safepoint_needed` 里 `is_cleanup_needed()` 为真，或距上次 safepoint 超过 `GuaranteedSafepointInterval`。日志里的 `Entering safepoint region: Cleanup` 就是这种空 safepoint。

---

## 5. end(): 撒开栓

`end()`(safepoint.cpp:499)按相反顺序放行：

1. `_safepoint_counter++`（变偶数，JNI fast path 重新可用）；
2. 解除武装：`make_polling_page_readable()` + `PageArmed=0`，`Interpreter::ignore_safepoints()`；
3. 复位状态：逐线程 `restart()`；
4. **`Threads_lock->unlock()`**——被 block() 排队卡住的线程从这里全部放行。

日志里的 `Leaving safepoint region` 就是 end() 完成的标记。

---

## 6. 误解澄清与收网

1. **safepoint 是“发信号让人停”吗?** 不是。它是协作式轮询：VMThread 武装轮询机制，线程在轮询点 / 状态转换 / native 返回处自愿停在安全位置。
2. **`_safepoint_counter` 只用于轮询吗?** 不是。它还服务 JNI fast path 二次校验、编译期间 safepoint 检测和依赖断言。
3. **end() 用 `Safepoint_lock->notify_all` 叫醒等待线程吗?** 不是。等待线程卡在 `Threads_lock`；`Safepoint_lock` 的 notify 只唤醒 VMThread 本人。
4. **block() 只改状态吗?** 不是。它要先 `make_walkable`，再排队抢 `Threads_lock`。
5. **每次 safepoint 都值得做完整 cleanup 吗?** 不一定。VMThread 会按 `is_cleanup_needed()` 或间隔决定是否发空 safepoint。

把这一篇压成三句话:

- **safepoint 是“VMThread 持锁当门闩、所有线程排队进门”的集体停摆**。
- **`_waiting_to_block` 是点名册，`_safepoint_counter` 是红绿灯，`Threads_lock` 是门闩。**
- **cleanup 的 7 项维护利用“全世界静止”做不含并发干扰的操作，必要时由空 safepoint 承担。**

下一篇: 轮询与验证器——编译代码/解释器的轮询到底怎么实现，凭什么在无 safepoint 时零开销。

> → [18-safepoint/02 — 轮询与验证器](02-polling-verifiers.md)