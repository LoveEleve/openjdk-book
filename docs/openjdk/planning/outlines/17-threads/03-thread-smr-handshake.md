# 03. 线程退出了，别人怎么不 crash？— Thread-SMR 与 Handshake

> 🔴 Deep | 4 KP 中的并发安全
> 读者处境: 线程 A 拿着线程 B 的 JavaThread*——但 B 已退出。如果 A 继续用 B 的指针→use-after-free。JVM 的 Thread-SMR 怎么防止这种 crash？
>
> ⚠️ 写作期修正(2026-08-13, vol-02/17-threads/03 已按真实源码成文~170 行,本大纲为规划期产物,机制描述以文章为准):
> - **"ThreadsListHandle(threadSMR.hpp:37-84)" 错**: :37-84 是文件头注释的用法示例;ThreadsListHandle 类在 **:272**(包 SafeThreadsListPtr :200——注释原话 "叶子场景用稳定 hazard ptr,嵌套场景用引用计数" :198-200);ThreadsList 在 :158(_threads 数组/_next_list,_length)
> - **"acquire_stable_list(threadSMR.hpp:120-121)"**: :120-121 是 fast/nested path 声明;无锁快路径本体=SafeThreadsListPtr::acquire_stable_list_fast_path(threadSMR.cpp:384-427): **发布 tagged(:402-403)→重读 _java_thread_list 校验(:408-411)→cmpxchg 去 tag(:416-421)**;全局指针 _java_thread_list volatile(threadSMR.hpp:108)+xchg_java_thread_list(:139)
> - **tagged 语义(大纲"tag 表示已扫描"错)**: tagged=**未验证**,扫描方看到 tagged 会 **CAS 置 NULL 使其失效**(ScanHazardPtrGatherProtectedThreadsClosure,threadSMR.cpp:256-266 "This exchange attempts to invalidate the hazard ptr"),读者输掉竞争就重试;untagged=稳定受保护(线程被 AddThreadHazardPointerThreadClosure 收进表 :270-271);tag 技巧 thread.hpp:162-170(最低位)
> - **"smr_delete: 把 thread 加入 to_delete_list" 错**: **_to_delete_list 装的是旧 ThreadsList 快照**(threadSMR.hpp:116),不是线程;smr_delete(threadSMR.cpp:944-1010)=delete_lock+set_delete_notify(Atomic::inc :937-939)→**is_a_protected_JavaThread(:966)**→没人保护 break→`delete thread`(:1006);被保护→delete_lock wait(:993-997)等 release_stable_list 唤醒
> - **读者释放双检查**: release_stable_list(threadSMR.cpp:471 起,:500-509 无锁读 delete_notify,false 直接返回,true 才 release_stable_list_wake_up(:897))
> - **Handshake**: HandshakeState(handshake.hpp:55-101:_operation volatile :57/_semaphore :59/_thread_in_process_handshake :60);HandshakeClosure :36-45;process_self_inner(handshake.cpp:417-434):trywait 或 wait_with_safepoint_check→load_acquire→**先 clear_handshake 再 do_handshake**(:430)→signal;try_process_by_vmThread(:481-516):has_operation(:486)→possibly_vmthread_can_process(:491)→**claim_handshake_for_vmthread=_semaphore.trywait+复查(:470-479,大纲"CAS 独占"错)**→vmthread_can_process(:505)→do→clear→_success;Handshake::execute(:381-389)ThreadLocalHandshakes→VM_HandshakeAllThreads
> - 悬念指向 04-interface-support.md(标题 "04. interfaceSupport——线程状态转换的 RAII 守卫")✓

### 1. "你保护我的指针" — Thread-SMR hazard pointer

场景: JVMTI agent 调用 GetThreadInfo(thread) → 需要访问 JavaThread*。但 target 线程可能在另一个 CPU 上退出。

**ThreadsListHandle — RAII 保护** (`threadSMR.hpp:37-84`):
```
ThreadsListHandle tlh;  // 构造: 获取当前 ThreadsList 的 stable 引用
// ... 安全使用 JavaThread* ...
// 析构: 释放 ThreadsList 引用
```
- 关键设计: ThreadsListHandle 不是锁——它不减慢读路径。原理: 每个线程发布一个 hazard pointer 指向当前 ThreadsList。删除者检查所有线程的 hazard pointer——如果没人指向旧 list→可以 free
- [C++: 与 RCU(Read-Copy-Update) 同构: (1) 更新者创建新 ThreadsList→xchg 替换全局指针。(2) 旧 list 放入 to_delete_list。(3) 等所有读者的 hazard_ptr 过期。(4) free 旧 list。Linux kernel 的 RCU 用 `synchronize_rcu` 等一个 grace period——JVM 用 hazard ptr scan 检测 grace period]

**acquire_stable_list 快慢路径** (`threadSMR.hpp:120-121`):

场景: 一个正常运行的 JVM 有 200 个线程——JVMTI agent 每秒查询 100 次线程信息。如果每次都要加锁→200×100=20000 次锁获取/秒→性能灾难。快路径必须无锁。

```
fast_path: 读 volatile _java_thread_list → 检查是否与当前相同 → 相同则直接返回
nested_path: 快路径不匹配 → 加 Threads_lock → 获取新 list
```
- 关键设计: 快路径是 lock-free——这是性能关键。大多数情况下线程不会退出→ThreadsList 不会变→fast_path hit。线程退出才需要 nested_path——频率极低
- source: `threadSMR.cpp:50-120` acquire_stable_list → 尝试 fast → 失败→lock→retry→分配新 ThreadsList
- [C++: fast_path 的关键是 volatile read——`ThreadsList* volatile _java_thread_list`——不经过锁的裸读。如果这个指针在两次读之间被改写了呢？没关系——ThreadsList 是 immutable 版本数组——旧版本不会被破坏。fast_path 即使读到"刚被替换的旧指针"也是安全的——旧 list 还在 to_delete_list 中等待 grace period]

**smr_delete 延迟回收** (`threadSMR.hpp:146`):

场景: 线程 A 退出——但 JVMTI agent 刚通过 ThreadsListHandle 拿到了 A 的 JavaThread*。不能立即 delete——agent 可能随时访问 A 的字段。

```
ThreadsSMRSupport::smr_delete(JavaThread* thread):
  1. 把 thread 加入 to_delete_list
  2. set_delete_notify() 双检查——减少锁获取
  3. 下一个 ThreadsListHandle acquire 时检查 delete_notify
  4. scan 所有 JavaThread 的 hazard_ptr → 确认无人保护 → free
```
- 关键设计: 删除不阻塞读——to_delete_list 累积待删线程→等时机。但内存占用有上限——`_to_delete_list_max` 统计最大值
- [C++: delete_notify 用的 double-checked locking 模式——先无锁读 `_delete_notify` flag，如果 false 则不做任何事。如果 true→加 delete_lock→重新检查→执行清理。这避免了每次 ThreadsListHandle 构造都要争锁——flag 为 false 时只需一条 load 指令]

**hazard_ptr tag 技巧** (`thread.hpp:162-170`):

场景: sweeper 需要扫描所有线程的 hazard_ptr——但不能重复扫描同一个已处理的 ptr。需要一个 tag 标记"已扫描"——但不能分配额外内存。

```
is_hazard_ptr_tagged(list): 最低位 tag(1=safe, 0=unsafe)
tag_hazard_ptr(list): list | 1
untag_hazard_ptr(list): list & ~1
```
- 关键设计: ThreadsList* 地址的低位永远是 0（alignment≥2 bytes）→ 用最低位做 tag——不额外分配内存。tag 表示 "这个 hazard ptr 是 tagged/scanned"——sweep 时避免重复扫描
- [C++: 这是 tagged pointer 技巧——利用指针对齐规则（malloc 返回至少 8-byte aligned 地址）偷用低位存元数据。在 x86_64 下指针的底 3 位永远为 0（8-byte alignment）——可以安全存 3 bits 元数据而不影响地址。所有解引用前必须 `untag_hazard_ptr`——类似 Linux kernel 的 `page->flags` 编码]

### 2. "我叫你帮我做件事" — Handshake 机制

场景: 不再用 stop-the-world safepoint 让所有线程停住——只让一个线程在安全时执行一段 callback。

**Handshake 两种执行路径** (`handshake.hpp:50-99`):
```
self-exec:    目标线程在下次 safepoint poll 时自己执行 closure
vmthread-exec: VM thread 在确保目标线程 blocked 时执行 closure
```

**HandshakeState 每线程一个** (`handshake.hpp:63-99`):
```cpp
class HandshakeState {
  HandshakeOperation* volatile _operation;  // 要执行的 closure
  Semaphore _semaphore;                     // VM thread/self 双协调
  bool _thread_in_process_handshake;        // 防重入标志
};
```
- [C++: _operation 是 volatile——写方 arm(写入操作)→读方 load(检查是否有操作)。不需要 atomic RMW 因为调用者是两个不同路径(VM thread vs self)——`claim_handshake_for_vmthread` 用 CAS 独占]

**self 执行流程** (`handshake.cpp:110-140`):
```
process_by_self(JavaThread* thread):
  1. 检查 _operation != NULL → 有操作挂起
  2. claim_handshake_for_vmthread() → 失败说明 VM thread 已在处理
  3. _semaphore.wait() → 等 VM thread 完成
  4. do_thread(thread) → 执行 closure
  5. clear_handshake(thread) → 重置状态
```

**VM thread 执行流程**:
```
try_process_by_vmThread(target):
  1. 检查目标线程状态 → _thread_in_vm？→ _not_safe
  2. claim_handshake_for_vmthread() → CAS 成功？
  3. do_thread(target) → 执行 closure
  4. _semaphore.signal() → 通知目标线程(如果它在等)
  5. 返回 _success
```

**与 safepoint 的区别**:
| | Safepoint | Handshake |
|------|------|------|
| 范围 | 所有线程 | 单个目标线程 |
| 阻塞 | 所有线程停 | 目标线程才停(或不阻塞) |
| 开销 | O(n_threads) | O(1) per thread |
| 用途 | GC, deopt, biased lock revoke | JVMTI single step, stack trace, thread dump |
- 关键设计: Handshake 是 safepoint 的轻量替代——当只需要操作一个线程时，不需要让所有线程停。但 handshake 仍然依赖 safepoint poll 点做 self-exec

---

### 核心悬念

**"Thread-SMR 用 hazard pointer 保护线程指针不 UAF——读者无锁，写者等 grace period。Handshake 用 Semaphore 协调单线程闭包执行——比 safepoint 轻量 100 倍。"** — 但线程怎么知道自己该做什么转换？下一篇: interfaceSupport RAII 守卫。

> → [04-interface-support.md](04-interface-support.md)
