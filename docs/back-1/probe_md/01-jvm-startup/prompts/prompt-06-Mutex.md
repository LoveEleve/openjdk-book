# PROMPT: 请撰写 06-Mutex.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

## §〇 Production Scenario

Thread A: `Compile_lock`(nonleaf+3) → `MethodCompileQueue_lock`(nonleaf+4) — 升序 OK。Thread B: `MethodCompileQueue_lock` → `Compile_lock` — 降序 VIOLATION → `set_owner_implementation()` 检测 `this->_rank <= locks->_rank` → `fatal("acquiring lock %s/%d out of order")` → assert 崩溃 + hs_err_pid.log → 开发者立即定位死锁。没有 rank 系统 → 经典 deadlock → 进程静默挂起 → sgdb 才能分析。

## §一 Task + Narrative + Beginner Callouts

### Interview

"`mutex_init()` at `mutexLocker.cpp:194` 用 `def()` 宏创建 ~90 个全局 Mutex/Monitor: `def(var, type, pri, vm_block, safepoint_check)` 展开 = `var = new type(Mutex::pri, #var, vm_block, safepoint_check)`。`type` 是 `PaddedMutex` 或 `PaddedMonitor`——加 `DEFAULT_CACHE_LINE_SIZE - sizeof(Mutex)` bytes padding 防 false sharing。Rank 系统 10 级: `event(0)→access(1)→tty(3)→special(4)→suspend_resume(5)→vmweak(7)→leaf(9)→safepoint(19)→barrier(20)→nonleaf(21+900)→native(922)`。`Mutex::lock()` → `assert_locked_rank()` 检查 `this->_rank > Thread::current()->_last_lock_rank`。底层 PlatformMonitor = pthread_cond_t + pthread_mutex_t。三层获取: ① `TryFast`: CAS LockByte (LockWord 最低 1 bit) → 成功立即返回。② `TrySpin`: 指数退避自旋 20 次。③ `ILock`: `AcquireOrPush` (CAS 抢锁或将 Self 推入 cxq contention queue) → `ParkCommon(ESelf)` → `pthread_cond_wait` → 醒来后 Self 成为 `_OnDeck` → spin 抢 LockByte。解锁 `IUnlock`: `release_store` 清零 LockByte → `storeload` fence → 检查 `_OnDeck` → `unpark` (pthread_cond_signal) → 后继者从 cxq/EntryList 选。MutexLocker RAII: `StackObj` 栈分配→构造 `lock()`→析构 `unlock()`→C++ 析构顺序保证 LIFO。"

### Callouts（≥7）

1. **Rank 10 级**: event→access(留级位)→tty→special→suspend_resume(+2 gap)→vmweak(+2)→leaf(+2)→safepoint(+10 gap)→barrier→nonleaf(+900 扩展空间)→native。
2. **def() 宏**: `#define def(var, type, pri, vm_block, safepoint_check) { var = new type(Mutex::pri, #var, vm_block, safepoint_check); _mutex_array[_num_mutex++] = var; }`
3. **PaddedMutex**: `CACHE_LINE_PADDING = DEFAULT_CACHE_LINE_SIZE - sizeof(Mutex)` bytes `_padding[]` → 防相邻锁共享 cache line 导致的 false sharing。
4. **LockWord**: `union SplitWord { intptr_t FullWord; void* Address; }` — LSB=LockByte, rest=cxq ParkEvent*。ParkEvent 256B 对齐 → 低 8 bit 为 0 → 不冲突。
5. **cxq/EntryList/OnDeck**: 竞争线程入 cxq(CAS spin 头插) → unpark 时批量 transfer to EntryList → 选 OnDeck(仅 OnDeck 线程可竞争 LockByte)。
6. **PlatformMonitor = pthread_cond_t**: `park()`: `pthread_cond_wait` → OS 调度。`unpark()`: `pthread_cond_signal` → 信号在释放 mutex 后发送防 futile wakeup。
7. **MutexLocker RAII**: `MutexLocker ml(lock)` → 构造 `lock->lock()` → 作用域结束析构 `lock->unlock()`。`MutexUnlocker`: 构造 `unlock()` → 析构 `lock()` — 临时释放模式。
8. **SafepointCheckRequired**: `_safepoint_check_never` (持有不检查)→`_safepoint_check_sometimes`→`_safepoint_check_always` (必须检查)。NOT_PRODUCT only。

## §四 Deep Dive Question Groups（≥6）

4.1 ★★★ Rank 层级系统完整枚举 — event→access→tty→special→suspend_resume→vmweak→leaf→safepoint→barrier→nonleaf→max_nonleaf→native，每级语义和留级原因
4.2 ★★★ def() 宏 + PaddedMutex — 宏展开→new PaddedMutex→_mutex_array→_num_mutex；cache line padding 公式
4.3 ★★★ LockWord + LockByte CAS — SplitWord union, TryFast CAS FullWord 设 LockByte, TrySpin 指数退避, ILock AcquireOrPush
4.4 ★★★ cxq/EntryList/OnDeck 三队列 — CAS 头插入 cxq, batch transfer to EntryList, OnDeck 继承者选择, unpark 语义
4.5 ★★★ PlatformMonitor pthread_cond_t — park 三态协议 (_event=1/0/-1), unpark CAS 检测, signal after mutex release
4.6 ★★★ MutexLocker 变体 — MutexLockerEx (no_safepoint_check option), MutexUnlocker (temporary unlock), GCMutexLocker (at safepoint skip)
4.7 ★★★ 死锁检测 — `set_owner_implementation()` rank check: `this->rank() <= locks->rank()` → fatal; `owned_locks` 链表维护

## §六 不要写成→应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| "mutex_init 创建锁" | "`def(Threads_lock, PaddedMonitor, barrier, true, _safepoint_check_sometimes)`→`Threads_lock=new PaddedMonitor(Mutex::barrier,\"Threads_lock\",true,_safepoint_check_sometimes);_mutex_array[n++]=Threads_lock`" |
| "CAS 获取锁" | "TryFast: `SplitWord L; L.FullWord=_LockWord.FullWord; if(L.LockByte==0 && CAS _LockWord.FullWord from L.FullWord to L.FullWord|1) return`" |
| "pthread_cond 阻塞" | "PlatformEvent::park: `if(_event==1)return; if(Atomic::cmpxchg(-1,&_event,0)==0){pthread_mutex_lock(&_mutex);while(_event!=1)pthread_cond_wait(&_cond,&_mutex);pthread_mutex_unlock(&_mutex);_event=0;}`" |

## §八 Prohibited（≥8）
❌ 不列 rank enum → ❌ 不展开 def() → ❌ 不画 LockWord → ❌ 不画 3 队列 → ❌ 不展示 TryFast/TrySpin/ILock → ❌ 不提 cache line padding → ❌ 不说 safepoint_check → ❌ 不写 GDB

## §九 Required（≥8）
✅ ★ Rank 10 级完整表 ✅ ★ def() 宏源码 + PaddedMutex 布局 ✅ ★ Mermaid: TryFast→TrySpin→ILock→park→unpark 全链路 ✅ ★ cxq/EntryList/OnDeck 队列图 ✅ ★ LockWord SplitWord 联合体 ✅ ★ MutexLocker 变体表 ✅ ★ 面试 Story ✅ ★ GDB 8 断点

## §十 GDB

断言1: mutex_init→`print _num_mutex`(~90)
断言2: tty_lock→`print tty_lock->_rank`(tty=3)
断言3: Threads_lock→`print Threads_lock->_rank`(barrier=20)
断言4: LockByte→`print _LockWord.FullWord&1`(before CAS=0)
断言5: TryFast→`print CAS result`
断言6: ILock→`print _OnDeck, _EntryList`
断言7: park→`break pthread_cond_wait`
断言8: MutexLocker→`thread->owned_locks()`(pop after ~)

路径: `docs/06-Mutex.md`

---

## §十一 Continuity

- 00-JNI-CreateJavaVM 的 `vm_init_globals` step 3 `mutex_init()` → 本文展开。
- 所有后续文档的锁（G1 SATB/DirtyCard lock, CodeCache_lock, SystemDictionary_lock）都在本文创建。
- 与 07-PerfMemory 同级（同属 vm_init_globals 子步骤）。

---

## §四 详细答案方向

### 4.1 Rank 层级系统
完整枚举: `event(0)→access(1)→tty(3)→special(4)→suspend_resume(5)→vmweak(7)→leaf(9)→safepoint(19)→barrier(20)→nonleaf(21~921)→max_nonleaf(921)→native(922)`。留级策略: access 比 special 更低（内存 barrier 可能在任何 VM 状态触发）。leaf+10 gap 为 safepoint 留排序空间。nonleaf+900 为编译器大量锁留排序空间。
追问: 如果违反 rank→`set_owner_implementation()` 检查 `this->rank()<=locks->rank()` → `fatal("out of order")`。
反事实: 无 rank → classic deadlock → 静默挂起。

### 4.2 def() 宏 + PaddedMutex
`def(Heap_lock, PaddedMonitor, nonleaf+1, false, _safepoint_check_sometimes)` → `Heap_lock = new PaddedMonitor(Mutex::nonleaf+1, "Heap_lock", false, _safepoint_check_sometimes); _mutex_array[_num_mutex++] = Heap_lock`。PaddedMutex: `CACHE_LINE_PADDING = DEFAULT_CACHE_LINE_SIZE(64) - sizeof(Mutex)(~48) = ~16 bytes _padding[]`。
追问: 为什么用 PaddedMutex 而非裸 Mutex？→ false sharing: 两个相邻 Mutex 在同一 cache line → 写一个使另一个 cache line 失效 → 多核性能下降 10-30%。

### 4.3 LockWord + 三层获取
LockWord: `union SplitWord { volatile intptr_t FullWord; volatile void* Address; }` — LSB=LockByte, rest=cxq ParkEvent*。TryFast: `L.FullWord=_LockWord.FullWord; if(L.LockByte==0 && CAS(_LockWord.FullWord, L.FullWord, L.FullWord|1)) return`。TrySpin: 指数退避自旋 20 次 `Knob_FixedSpin=20`，每次递减看 LockByte。ILock: `AcquireOrPush(Self)`: CAS 设置 LockByte → 成功返回；失败将 Self 推入 cxq(CAS 头插: `Self->_OnDeck=cxq; CAS cxq to Self`)。`ParkCommon(ESelf)`: `while(_OnDeck!=ESelf) ESelf->park()`。
追问: 为什么 TrySpin 只 20 次？→ 锁持有时间短（~ns），长持有用 park 更省 CPU。

### 4.4 cxq/EntryList/OnDeck
cxq: CAS 头插竞争队列，新 waiter 始终入 cxq。EntryList: unpark 时 `detach cxq → transfer to EntryList`。OnDeck: 唯一允许竞争 LockByte 的线程（`_OnDeck==Self` → `TryLock()` spin）。
追问: 为什么需要 EntryList 中间层？→ 防止 cxq 上的线程被连续 signal 但仍抢不到锁（"herd of thundering"）。

### 4.5 PlatformMonitor = pthread_cond_t
`PlatformEvent::park()`: 三态 `_event={1:直接返回, 0:需park, -1:已在park}`。`CAS _event 0→-1`→`pthread_mutex_lock(&_mutex)`→`while(_event!=1) pthread_cond_wait(&_cond,&_mutex)`→`_event=0`。`PlatformEvent::unpark()`: `xchg _event to 1, if old>=0 return`。`pthread_mutex_lock`→`if(_nParked>0) pthread_cond_signal(&_cond)`→`pthread_mutex_unlock`。
追问: 为什么 signal 在 mutex unlock 之后？→ 防 futile wakeup（被 signal 的线程立即需要 mutex，若 mutex 仍 held 则再次 sleep）。

### 4.6 MutexLocker 变体
`MutexLocker(Monitor* m)`: 构造 `m->lock()` (safepoint check)。`MutexLockerEx(Monitor* m, bool no_safepoint_check)`: 可选 `lock_without_safepoint_check()`。`MutexUnlocker(Monitor* m)`: 构造 `unlock()` → 析构 `lock()` — 临时释放。`GCMutexLocker(Monitor* m)`: at safepoint → 跳过 lock。
追问: 为什么 rank≤special 不能用 safepoint check？→ 持有 special 锁期间禁止阻塞 → safepoint check 可能触发状态转换→阻塞→死锁。

### 4.7 死锁检测与 owned_locks
`set_owner_implementation()`: `locks = get_least_ranked_lock(new_owner->owned_locks())` → `this->rank() <= locks->rank() && !at_safepoint` → `fatal("out of order")`。owned_locks 单链表: lock时 `_next = owner->_owned_locks; owner->_owned_locks=this`。unlock 时反向移出。
追问: `print_owned_locks_on_error(st)` 如何输出？→ `for(_mutex_array[i]:_mutex_array[i]->owner()!=NULL → print_on_error(st))`。
