# 03. 代码从生到死 — nmethod 生命周期与 Sweeper

> 🔴 Deep | 5 KP 中的 GC 交互
> 读者处境: Java 类被重新加载了——旧的编译方法必须失效。但栈上可能还在执行旧代码——sweeper 怎么知道什么时候可以安全回收？
>
> ⚠️ 写作期修正(2026-08-12, vol-02/16-code-cache/03 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **NMethodSweeper 在 share/runtime/sweeper.{hpp,cpp}**(非 share/code/);sweeper.hpp:35-58 类注释是机制权威(两种操作: mark_active_nmethods 在 safepoint / sweep_code_cache 不在 safepoint 且让位;"at least 3 sweeps")
> - **大纲 [C++] "make_not_entrant_or_zombie 用 Atomic::cmpxchg CAS" 错**(16-02 已证: Patching_lock 双重检查)——本篇不再抄
> - **mark_active_nmethods 不自己开 VM op**: 常规挂在 safepoint 收尾的 ParallelSPCleanupTask(ParallelSPCleanupThreadClosure,safepoint.cpp:613-631,do_cleanup_tasks :731;safepoint 同步后 :481 执行);空间告急才 do_stack_scanning→VM_MarkActiveNMethods(sweeper.cpp:256-263,vmOperations.cpp:130)
> - **MarkActivationClosure(sweeper.cpp:163-174)**: 对活跃 nmethod **set_hotness_counter(reset_val) 重置**(非 +=);not_entrant 且活跃→mark_as_seen_on_stack 设 stack_traversal_mark=traversal_count(nmethod.cpp:989-993 "2 cleaning passes")
> - **hotness**: reset_val=(ReservedCodeCacheSize<M)?1:(ReservedCodeCacheSize/M)*2(sweeper.cpp:188-193);sweep 时 dec_hotness_counter(possibly_flush :695);淘汰条件 hotness<threshold(threshold=-reset+reverse_free_ratio*NmethodSweepActivity)且 time_since_reset>MinPassesBeforeFlush(:698-716,最终 nm->make_not_entrant() :758);reverse_free_ratio=max_capacity/unallocated(codeCache.cpp:1042-1051,25% 空闲→4)
> - **触发条件**(possibly_sweep 注释 :327-331 三条): notify 有门槛(reverse_free_ratio>=MAX2(100/StartAggressiveSweepingAt,1.1) 才唤醒,sweeper.cpp:283-291;allocate :483 每次都调);free_percent<=StartAggressiveSweepingAt(10,globals.hpp:1979)强制栈扫描(:373-380);report_state_change 累计>1% 再扫(:558-575);周期 max_wait=ReservedCodeCacheSize/(16*M)(:359-368)
> - **依赖失效链**(大纲的 "Dependencies::check_all_dependencies" 与 "dependencies.cpp:240-270" 不实): SystemDictionary::add_to_hierarchy→CodeCache::flush_dependents_on(systemDictionary.cpp:1817-1819)→KlassDepChange→mark_for_deoptimization(codeCache.cpp:1148,DepChange::ContextStream+spot_check_dependency_at dependencies.cpp:2047)→VM_Deoptimize→make_marked_nmethods_not_entrant(codeCache.cpp:1259-1266);反向索引 InstanceKlass::add_dependent_nmethod/remove_dependent_nmethod(instanceKlass.cpp:2105-2116)/mark_dependent_nmethods :2103
> - **uncommon trap**: UncommonTrapBlob codeBlob.hpp:642 ✓;Deoptimization::uncommon_trap_inner deoptimization.cpp:1526;action 编码决定生死(1794-1837: none/maybe_recompile 不失效;reinterpret/make_not_entrant 失效;make_not_compilable 永不编译)
> - **GC 交互**: CodeCache::gc_prologue() 是空函数(:919),gc_epilogue 只 prune_scavenge_root_nmethods(:921-923);年轻代 Serial/Parallel 走 scavenge_root_nmethods_do(genCollectedHeap.cpp:837)只扫 _scavenge_root_nmethods 链(codeCache.hpp:98,register 条件 detect_scavenge_root_oops codeCache.cpp:772-777),G1 用 per-region strong code roots(register_nmethod g1CollectedHeap.cpp:5012);全堆 blobs_do(genCollectedHeap.cpp:845-848 "We scan the entire code cache");类卸载 G1 走 G1CodeCacheUnloadingTask→CompiledMethod::do_unloading_parallel(compiledMethod.cpp:507-527,g1CollectedHeap.cpp:3415)→do_unloading_oops(nmethod.cpp:1496)→make_unloaded(can_unload nmethod.cpp:1379-1390);**CodeCache::do_unloading(codeCache.cpp:698)在 jdk11u 无调用者**
> - **flush**: nmethod.cpp:1292-1332(非大纲的 :1611-1644): 清 ExceptionCache→drop_scavenge_root_nmethod→CodeBlob::flush→CodeCache::free(:553-570)→heap deallocate
> - **应急链**: 分配失败→expand_by(:498)→降级堆(:510-517)→CompileBroker::handle_full_code_cache(compileBroker.cpp:2292-2328: UseInterpreter=true、set_should_compile_new_jobs(stop)或 disable_compilation_forever、report_codemem_full codeCache.cpp:1365 警告+JFR CodeCacheFull);恢复: freed_memory>0 才 set_should_compile_new_jobs(run)(sweeper.cpp:534-547)
> - sweeper 线程: NearMaxPriority(compileBroker.cpp:803-815,非大纲的 "low priority"),入口 sweeper_loop(sweeper.cpp:265-278,CodeCache_lock wait/notify);sweeper 类注释"四种死法" :48-51
> - 实证: hotspot.log 64 个 `<make_not_entrant>`(59 个 level3)+49 个 `<uncommon_trap action='make_not_entrant'>`(range_check/class_check);CodeHeap_Analytics sweeper statistics 全 0(2.5min demo 无完整 sweep)

### 1. "我为什么会死？" — 四种失效场景

场景: nmethod 没法永远活着——类重定义、依赖失效、uncommon trap、CodeCache 满了都会触发回收。

**四种失效**:

| 场景 | 触发 | 状态 | 后续 |
|------|------|:--:|------|
| Uncommon trap | C2 乐观假设失效（如类型预测错误） | → not_entrant | 可能重新编译(不同假设) |
| 依赖失效 | 类层次变化（新子类出现、方法被覆盖） | → not_entrant | nmethod deopt、从 IC 清除 |
| 类重定义 | JVMTI RedefineClasses/HotSwap | → not_entrant | 全部相关 nmethod 失效 |
| CodeCache 满 | CodeHeap 无可用空间 | → 挑选淘汰 | sweeper 加速，清除冷 nmethod |

**Dependencies 通知链** (`dependencies.hpp:40-54`):
- C2 编译时收集假设 → 存为 Dependencies 对象 → 嵌入 nmethod 的 dependencies 段
- 运行时类加载（新类出现）→ SystemDictionary 通知 → `Dependencies::check_all_dependencies()` → 比较新的类层次 vs 编译时假设
- 不匹配 → DepChange → 标记相关 nmethod not_entrant → `nmethod::make_not_entrant()`
- 源码: `dependencies.cpp:240-270` DepChange::spot_check_dependency_at — 遍历 dep 列表比较
- [C++: dep 失效的 MT 安全——`make_not_entrant_or_zombie` 用 Atomic::cmpxchg 做 CAS，先读 `_state` → 如果已经是 not_entrant/zombie/unloaded 则返回 false（其他线程先做了）→ 否则 CAS not_entrant。只有一个线程成功做状态转移]

**Uncommon trap 路径** (`codeBlob.hpp:642-666`):
- C2 编译时插入 uncommon_trap（"如果走到这里，假设错了"）
- 走到 trap → UncommonTrapBlob → Deoptimization::uncommon_trap() → nmethod 标记 not_entrant
- 修改字节码 `_count` 计数器报告"这个假设失败" → 可能重新用不同 profiling 编译

### 2. sweeper: "谁还在用这段代码？"

场景: not_entrant 的 nmethod 不能立即删除——可能还有线程的栈帧在 C2 代码中执行。

**Sweeper 的 stack traversal** (`nmethod.hpp:148-153`):
```
sweeper: 
  1. 增加 sweep traversal mark (全局递增)
  2. 遍历所有 Java 线程栈 → 标记活跃 nmethod 的 stack_traversal_mark = current
  3. 扫描所有 not_entrant nmethod → stack_traversal_mark < current → 无活跃帧 → 可 zombie
```
- 源码: `nmethod.hpp:148-153` `_stack_traversal_mark` + `NMethodSweeper::mark_active_nmethods()` 
- 关键设计: stack_traversal_mark 不是简单的 "在用/不用"——它是一个 epoch 编号。sweeper 每轮增加全局标记 → 任何没有更新到当前 epoch 的 nmethod = 自上次 sweep 以来一直没被用到 → 安全回收
- [C++: 这本质是 epoch-based reclamation (类似 RCU)——不是 lock-protected reference count。不阻塞执行线程（sweeper 只读栈），不增加每次调用的开销。safepoint 时栈静止→扫描成本低。与 Linux 内核的 RCU grace period 同构——"自上次 epoch 以来没被访问"的等价判断]
- [C++: 栈扫描用 `StackFrameStream` — 从 JavaThread::last_frame() 出发，沿 frame::sender() 向上遍历（解析 compiled/interpreter/native frame 的 sender linkage）。在每个 compiled frame 中调用 `CodeCache::find_blob(pc)` 反查 nmethod——O(栈深度) 不是 O(nmethod 总数)]

**Hotness counter — 选谁淘汰** (`nmethod.hpp:155-160`):
```
_hotness_counter:
  - 扫描时如果 nmethod 有活跃栈帧 → += (ReservedCodeCacheSize / (1024 * 1024)) * 2
  - 每次 sweep → -= 1
  - 降到 0 → 冷代码 → 优先 zombie
```
- 源码: `nmethod.hpp:155-160` `_hotness_counter` + NMethodSweeper::sweep() 减量逻辑
- 关键设计: hotness 累积 = 被调用频率 × 栈深度。热点方法 hotness 高 → sweeper 保护。冷方法自然衰减→0→被回收

**Sweeper 触发条件**:
1. CodeCache 分配失败(`codeCache.cpp:280-300` report_codemem_full→sweeper 加速)
2. GC 的 SweeperClosure（GC 后清理 zombie）
3. 白盒触发(WhiteBox API)
4. 周期性(sweeper 线程)
- [C++: sweeper 线程是 `NMethodSweeper::sweeper_thread_entry()` 运行在 low priority — `os::set_native_priority(sweep_thr, NearMaxPriority)` 中较高但不卡 CompileBroker。Notifier 用 `Monitor::notify()` → `Monitor::wait(NOTIFICATION)` 实现——不用 spin-wait]

### 3. "GC 来了怎么办？" — CodeCache 与 GC 的交互

场景: Young GC 移动了对象——nmethod 里嵌的 oop 指针还在旧地址。怎么更新？

**GC 的三个交互点**:

**(a) oop 更新 — relocInfo 遍历**:
```
GC::gc_prologue() → CodeCache::gc_prologue()  // 锁 CodeCache
// GC 移动对象
// 对每个 alive nmethod → 遍历 relocInfo → isOop() → 更新 oop 指针
GC::gc_epilogue() → CodeCache::gc_epilogue()
```
- 源码: `codeCache.cpp:600-620` gc_prologue/gc_epilogue
- [C++: oop 更新走 relocInfo 压缩流——oop_at(index) 返回 `oop_begin()[index-1]`。GC 遍历所有 reloc entry→is_oop_type()→更新 `*oop_addr_at(index)`]

**(b) class unloading — nmethod purge**:
- Full GC 卸载类 → 依赖该类的 nmethod 失效
- `CodeCache::do_unloading(is_alive, unloading_occurred)` → nmethod::do_unloading_oops→检查 oop/metadata 是否 alive
- scavenge_root_nmethods: Young GC 中 nmethod 嵌的 oop 如果是根→必须标记

**(c) nmethod unloading — zombie 清理**:
- Sweeper 将 zombie nmethod 从 CodeHeap 移到 free list
- `nmethod::flush()` → 归还 CodeHeap 空间 → `CodeHeap::deallocate()`
- 源码: `nmethod.cpp:1611-1644` flush() — 清理 oop/dep/IC → 归还 CodeCache

**Scavenge root 机制** (`codeCache.hpp:98`):
- `_scavenge_root_nmethods`: 单链表——存有 scavengable oop 的 nmethod
- Young GC 必须在这些 nmethod 中标记存活对象——否则 oop 被回收但 nmethod 还在引用

### 4. CodeCache 满了怎么办？— 应急机制

场景: 生产环境 CodeCache 打到 240MB 上限——不能再编译新方法了。

**应急策略链** (`codeCache.hpp:206`):
```
CodeCache::report_codemem_full(type, print):
  1. 触发 sweeper — 立即清除 zombie/not_entrant
  2. 如果还是满 → 提高 sweeper 频率 → 清除低 hotness nmethod
  3. 如果仍然满 → 报 "CodeCache is full" → CompileBroker 暂停编译
  4. JVMCI compiler 会得到通知停止提交新编译任务
```
- [C++: CompileBroker 暂停——`CompileBroker::set_should_compile_new_jobs(false)` 后，`CompileBroker::compiler_thread_loop()` 下一次循环检查 `should_compile_new_jobs()` → spin on Monitor::wait 直到 CodeCache 有空间通知 notify。不是永久禁用——sweeper 腾出空间后 `set_should_compile_new_jobs(true)` 恢复]

**用户侧日志**:
- `CodeCache::print_summary`: 每 Heap 的 size/used/max_used + blob 数 + adapter 数
- `CodeCache::aggregate` (CodeHeap State Analytics): 粒度分析——按大小/年龄/名称统计 → 找到谁占了空间
- `-XX:+PrintCodeCache` + `-XX:+PrintCodeCacheOnCompilation`: 每次编译打印使用量
- DCmd: `jcmd <pid> Compiler.CodeHeap_Analytics`: 详细段分析

---

### 核心悬念

**"sweeper 用 stack traversal mark 判断有无活跃线程，用 hotness counter 选淘汰对象——这是一种 GC 风格的生命周期管理。"** — 但代码还需要自描述能力：那些嵌在机器码里的 oop 怎么更新的？下一篇: Relocation 系统。

> → [04-relocation-ic.md](04-relocation-ic.md)
