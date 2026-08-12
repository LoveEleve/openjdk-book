# 03. nmethod 生命周期 — 扫除器怎么判断一段代码不需要了

> **前置依赖**:[02 — nmethod 结构](02-nmethod-structure.md):状态机(not_installed→in_use→not_entrant→zombie→unloaded)、`make_not_entrant_or_zombie` 的互斥协议、nmethodLocker 与 `stack_traversal_mark` 的语义都在上一篇;本篇回答"谁在什么时候推进这些状态"
> → **后续**:[04 — Relocation 与 Inline Cache](04-relocation-ic.md)
> 关联域: 18-safepoint(sweeper 的标记阶段挂在 safepoint 收尾)、20-vmops(空间告急时补栈扫描的 `VM_MarkActiveNMethods`)、22-deopt(uncommon trap 触发失效)

## 代码的"死"不能当场执行

一段编译代码被判死刑时,栈上可能还有线程正在执行它——死可以,但**不能当场死**: 得先让它不可进入(not_entrant),等所有活跃帧消失(zombie),最后空间才能真正归还(unloaded)。谁负责盯着这个过程?**NMethodSweeper(扫除器)**: 在 safepoint 标记"谁还活着",在普通时间清扫"谁可以死",用一个**热度计数器**决定"谁该被牺牲"。这篇把 02 篇的状态机接通电源: 四种死法、清扫的 epoch 协议、与 GC 的交接、以及 CodeCache 满时的应急。

## 1. 四种死法: 谁在给 nmethod 判死刑

### 判死刑的四个入口

nmethod 变成 not_entrant 的入口有四个(来源见 sweeper.hpp:48-51 的注释原文 "made not-entrant by (i) the sweeper, (ii) deoptimization, (iii) dependency invalidation, and (iv) being replaced by a different method version"):

1. **分层替换**(tiered replacement): 新版本编译好上线,旧版本 `make_not_used()`(02 篇讲过,ciEnv.cpp:1072);
2. **deoptimization(uncommon trap)**: 编译代码自己踩到假设失效点;
3. **依赖失效**(dependency invalidation): 类层次变化动摇了编译时的假设;
4. **sweeper 自己**: 方法长期不热 + CodeCache 空间紧张(本篇 §2)。

入口 1 在 02 篇讲过;2、3 是本节主角;4 的完整机制是整篇 §2。

### uncommon trap: 代码自己承认赌输了

C2 编译时会在"赌注"位置插入 uncommon trap 桩——代码执行到这里,说明某个乐观假设(类型预测、空指针不触发、常量不可能变)错了。陷阱被踩中后走进 `UncommonTrapBlob`(codeBlob.hpp:642,注释原文 "currently only used by Compiler 2"),它调用 `Deoptimization::uncommon_trap`(deoptimization.cpp:2095,blob 的生成见 sharedRuntime_x86_64.cpp:3182-3219),再进 `uncommon_trap_inner`(:1526)。注意 trap 携带的 **action 编码**决定了这个 nmethod 该不该死(deoptimization.cpp:1794-1837,截取核心,省略注释):

```cpp
// deoptimization.cpp:1794-1837(截取核心,省略注释)
    bool make_not_entrant = false;
    bool make_not_compilable = false;
    bool reprofile = false;
    switch (action) {
    case Action_none:
      // Keep the old code.
      update_trap_state = false;
      break;
    case Action_maybe_recompile:
      // Do not need to invalidate the present code, but we can
      // initiate another
      ...
    case Action_reinterpret:
      // Go back into the interpreter for a while, and then consider
      // recompiling form scratch.
      make_not_entrant = true;
      ...
      reprofile = true;
      break;
    case Action_make_not_entrant:
      ...
      make_not_entrant = true;
      break;
    case Action_make_not_compilable:
      // Give up on compiling this method at all.
      make_not_entrant = true;
      make_not_compilable = true;
      break;
```

[实证:] demo 的 LogCompilation 日志(materials/logs/hotspot.log)里 49 个 `<uncommon_trap .../>` 事件带着 `action='make_not_entrant'`——比如 `reason='range_check' action='make_not_entrant'`(C2 把边界检查优化掉后赌输)和 `reason='class_check'`——action 不是概念,是日志里真实存在的编码。

**关键设计 (斜体)**: *不是所有 trap 都判死刑——`Action_maybe_recompile` 让旧代码继续跑,只启动新编译;`Action_reinterpret` 回解释器冷静一段再编译(顺带重置计数器);`Action_make_not_entrant` 才是立即失效。编译器用 action 表达"这次赌输有多严重",运行时照单执行。*

### 依赖失效: 类层次动了

编译器敢做激进优化(方法内联、单实现虚调用静态绑定),前提是"类层次保持编译时的样子"。类加载会改变层次——`SystemDictionary::add_to_hierarchy` 把新类挂进继承树后,立刻清算所有赌输的代码(systemDictionary.cpp:1819,注释原文 "Now flush all code that depended on old class hierarchy"):

```cpp
// systemDictionary.cpp:1817-1819(逐字)
  // Now flush all code that depended on old class hierarchy.
  // Note: must be done *after* linking k into the hierarchy (was bug 12/9/97)
  CodeCache::flush_dependents_on(k);
```

清算链是双向的:

- **正向**(nmethod → 它依赖什么): 每个 nmethod 的 dependencies 段记录编译时假设;
- **反向**(类 → 谁依赖我): `InstanceKlass` 用 DependencyContext 维护"依赖我的 nmethod 列表",`add_dependent_nmethod`/`remove_dependent_nmethod`(instanceKlass.cpp:2105-2116)维护这份索引。

真正生效的是**反向索引**——`CodeCache::flush_dependents_on`(codeCache.cpp:1275)构造 `KlassDepChange`,`mark_for_deoptimization`(codeCache.cpp:1148)用 `DepChange::ContextStream`(dependencies.cpp:2101)把受影响的类全部找出来——遍历顺序是: 新类本身 → 父类链 → 传递闭包的接口(dependencies.cpp:2101-2131),对每个类直接查反向列表——`InstanceKlass::mark_dependent_nmethods`(instanceKlass.cpp:2103)→ `DependencyContext::mark_dependent_nmethods`(dependencyContext.cpp:62-81)遍历桶,对每个依赖它的 nmethod 调 `check_dependency_on` 逐条验证编译时假设(`spot_check_dependency_at`,dependencies.cpp:2047),命中就标记。**只在受影响类范围内查,不是全量扫描 CodeCache**。类重定义(JVMTI RedefineClasses)走同一框架的变体 `flush_evol_dependents_on`(codeCache.cpp:1292,按"方法演进"语义找受影响者)。

标记完成后 `VM_Deoptimize` 把栈上正在执行这些 nmethod 的帧也退化成解释器帧,然后 `make_marked_nmethods_not_entrant()` 统一收口(vmOperations.cpp:118-128 的 `doit`,实现见 codeCache.cpp:1259-1266)。依赖假设的细节(有哪些假设、怎么验证)是 05 篇的主题。

## 2. sweeper: 标记与清扫的两阶段协议

### 为什么不能当场回收

一个 not_entrant 的 nmethod 可能还有栈帧在执行——`make_not_entrant` 的补丁只挡住"新调用",挡不住"已在栈上的帧"。回收必须先确认: **自它变成 not_entrant 以来,没有任何一次栈扫描看到过它**。sweeper 用"traversal(遍历)编号"做这个确认(sweeper.hpp:35-58 的注释是全文最权威的机制说明,下面按它展开)。

### 阶段一: 标记——safepoint 收尾的顺风车

`sweeper.hpp:39-41` 注释原文 "Is done in 'mark_active_nmethods()'. This function is called at a safepoint and marks all nmethods that are active on a thread's stack"。常规情况下它不自己开 VM 操作,而是**挂在每个 safepoint 的收尾清理任务里**——safepoint 本来就要停所有线程,停都停了,顺手扫一遍栈几乎零额外成本(safepoint.cpp:613-631,截取核心,逐字);只有 CodeCache 空间告急时才会主动开一个 `VM_MarkActiveNMethods` 补一次栈扫描(`do_stack_scanning`,sweeper.cpp:256-263):

```cpp
// safepoint.cpp:613-631(截取核心,逐字)
class ParallelSPCleanupThreadClosure : public ThreadClosure {
private:
  CodeBlobClosure* _nmethod_cl;
  DeflateMonitorCounters* _counters;

public:
  ParallelSPCleanupThreadClosure(DeflateMonitorCounters* counters) :
    _counters(counters),
    _nmethod_cl(NMethodSweeper::prepare_mark_active_nmethods()) {}

  void do_thread(Thread* thread) {
    ObjectSynchronizer::deflate_thread_local_monitors(thread, _counters);
    if (_nmethod_cl != NULL && thread->is_Java_thread() &&
        ! thread->is_Code_cache_sweeper_thread()) {
      JavaThread* jt = (JavaThread*) thread;
      jt->nmethods_do(_nmethod_cl);
    }
  }
};
```

每个 Java 线程的栈都会被扫,对每个在栈上活跃的 nmethod 执行 `MarkActivationClosure`(sweeper.cpp:163-174,逐字):

```cpp
// sweeper.cpp:163-174(逐字)
class MarkActivationClosure: public CodeBlobClosure {
public:
  virtual void do_code_blob(CodeBlob* cb) {
    assert(cb->is_nmethod(), "CodeBlob should be nmethod");
    nmethod* nm = (nmethod*)cb;
    nm->set_hotness_counter(NMethodSweeper::hotness_counter_reset_val());
    // If we see an activation belonging to a non_entrant nmethod, we mark it.
    if (nm->is_not_entrant()) {
      nm->mark_as_seen_on_stack();
    }
  }
};
```

两件事: 把 hotness 重置为满血;如果这个 not_entrant 方法在栈上,`mark_as_seen_on_stack()` 把 `_stack_traversal_mark` 更新为当前 traversal 编号(nmethod.cpp:989-993,注释原文 "Set the traversal mark to ensure that the sweeper does 2 cleaning passes before moving to zombie")。

### 阶段二: 清扫——增量、可中断、不在 safepoint

`sweeper.hpp:42-47` 注释原文 "sweep_code_cache(): This function is the only place in the sweeper where memory is reclaimed. ... is not called at a safepoint. However, it stops executing if another thread requests a safepoint."。清扫线程 `sweeper_loop`(sweeper.cpp:265-278)平时睡在 `CodeCache_lock` 上,被 `notify` 唤醒后跑 `possibly_sweep` → `sweep_code_cache`:

- **增量遍历**: `_current` 游标记住上次扫到哪(`CompiledMethodIterator`,codeCache.hpp:411),一轮 sweep 从游标继续扫到末尾;扫完(游标归零)后,下一次 safepoint 标记开始时才 `_traversals++` 开启新一轮(sweeper.cpp:232-238,`_traversals` 的注释原文是 "Stack scan count, also sweep ID",sweeper.hpp:67);所以"一次完整 sweep"跨多次唤醒;
- **让位 safepoint**: 每处理一个 nmethod 都检查 `SafepointSynchronize::is_synchronizing()`,是就释放锁、`java_suspend_self` 让位(sweeper.cpp:313-324)——清扫再急也不能挡 safepoint;
- **逐方法裁决**: `process_compiled_method`(sweeper.cpp:595-686)按状态分流:
  - zombie → `flush()`(空间归还);
  - not_entrant → `can_convert_to_zombie()` 通过就 `make_zombie()`,不通过只清理它的 IC;
  - alive → `possibly_flush()` 按热度判淘汰 + 清理指向死方法的 IC。

`can_convert_to_zombie`(nmethod.cpp:999-1007)就是 02 篇留的那个判据:

```cpp
// nmethod.cpp:999-1007(逐字)
bool nmethod::can_convert_to_zombie() {
  assert(is_not_entrant(), "must be a non-entrant method");

  // Since the nmethod sweeper only does partial sweep the sweeper's traversal
  // count can be greater than the stack traversal count before it hits the
  // nmethod for the second time.
  return stack_traversal_mark()+1 < NMethodSweeper::traversal_count() &&
         !is_locked_by_vm();
}
```

**关键设计 (斜体)**: *`stack_traversal_mark + 1 < traversal_count` 要求这个 not_entrant 方法**连续两轮完整遍历都没被栈扫描看到**——一次不够,因为方法变 not_entrant 的那轮扫描它可能还活着,必须等"下一轮也没出现"才算数;加上从标记到清扫至少再隔一轮,一个 nmethod 从判决死刑到空间归还**至少跨 3 轮 sweep**(sweeper.hpp:57-58 注释原文 "It may take at least 3 sweeps before an nmethod's space is freed")。这就是一个 epoch 协议: 栈扫描是读阶段,清扫是写阶段,两者靠 safepoint 天然互斥。*

### 热度计数器: 谁该被牺牲

hotness 不是"调用频率"——它是"**距离上次在栈上被看到的轮数**":

- 栈扫描看到(活跃)→ `set_hotness_counter(reset_val)` 重置为满血,sweeper.cpp:168;
- 开启 `UseCodeCacheFlushing`(默认 true,globals.hpp:1976)时,每轮 sweep 对存活方法 `dec_hotness_counter()` 减 1(sweeper.cpp:695);
- 满血值 `hotness_counter_reset_val() = (ReservedCodeCacheSize < M) ? 1 : (ReservedCodeCacheSize / M) * 2`(sweeper.cpp:188-193)——CodeCache 越大,满血值越高,方法可以"凉"更久才被牺牲;
- 淘汰判据(sweeper.cpp:695-707,截取核心,逐字):

```cpp
// sweeper.cpp:695-707(截取核心,逐字)
      nm->dec_hotness_counter();
      // Get the initial value of the hotness counter. This value depends on the
      // ReservedCodeCacheSize
      int reset_val = hotness_counter_reset_val();
      int time_since_reset = reset_val - nm->hotness_counter();
      int code_blob_type = CodeCache::get_code_blob_type(nm);
      double threshold = -reset_val + (CodeCache::reverse_free_ratio(code_blob_type) * NmethodSweepActivity);
      // The less free space in the code cache we have - the bigger reverse_free_ratio() is.
      // I.e., 'threshold' increases with lower available space in the code cache and a higher
      // NmethodSweepActivity. If the current hotness counter - which decreases from its initial
      // value until it is reset by stack walking - is smaller than the computed threshold, the
      // corresponding nmethod is considered for removal.
      if ((NmethodSweepActivity > 0) && (nm->hotness_counter() < threshold) && (time_since_reset > MinPassesBeforeFlush)) {
```

阈值与**剩余空间成反比**: 空间越紧张(`reverse_free_ratio` 越大),阈值越高,更多方法落入"可以被牺牲"的区间。`MinPassesBeforeFlush=10`(globals.hpp:1260)是冷静期——刚编译的方法不被立即牺牲。真正的淘汰动作还是 `make_not_entrant()`(:715 置位,最终 `nm->make_not_entrant()` 在 :758)——sweeper 自己也是四种死法的入口之一。

### 什么时候清扫

`possibly_sweep` 的三个触发条件(注释 sweeper.cpp:327-331 原文 "(1) The code cache is getting full (2) There are sufficient state changes in/since the last sweep (3) We have not been sweeping for 'some time'"):

- **快满**: `CodeCache::allocate` 每次分配都 `NMethodSweeper::notify`(codeCache.cpp:483)——但 notify 有门槛: 只有剩余空间低于约 10%(`reverse_free_ratio >= MAX2(100/StartAggressiveSweepingAt, 1.1)`)才真正唤醒,启动初期空间充足时分配不会打扰 sweeper(sweeper.cpp:283-291);另外当 **non-profiled 堆**剩余空间 ≤10% 时会强制补一次栈扫描(`free_percent <= StartAggressiveSweepingAt`,sweeper.cpp:373-380,注释原文 "We force stack scanning only if the non-profiled code heap gets full";`StartAggressiveSweepingAt=10`,globals.hpp:1979);
- **状态变化足够多**: `report_state_change` 累计字节,超过 ReservedCodeCacheSize 的 1% 就再扫一轮(sweeper.cpp:558-575);
- **周期兜底**: 距上次清扫的"虚拟时间"超过 `ReservedCodeCacheSize / (16*M)` 轮标记(sweeper.cpp:359-368)——256MB 配置下约 15 轮 safepoint 标记必扫一次。

[实证:] demo 的 LogCompilation 日志(materials/logs/hotspot.log)里 64 个 `<make_not_entrant .../>` 事件记录了真实的判死过程,格式 `compile_id='8' compiler='c1' level='3' stamp='0.026'`——其中 59 个是 level 3(C1 画像方法): 分层编译里"画像版本被最终版本替换"是最常见的死法,启动后几十毫秒就开始发生;同一个日志还有 `compile_kind='osr'` 的 OSR 方法被标记。而 CodeHeap_Analytics 里 "Code cache sweeper statistics"(materials/commands/jcmd-Compiler.CodeHeap_Analytics.txt)显示 `Total number of full sweeps: 0`——2.5 分钟的 demo 一次完整 sweep 都没触发: sweeper 线程常驻等待唤醒,但清扫动作是"按需 + 低频"。

## 3. GC 来了怎么办: 三处交接

### oop 更新: 谁负责改机器码里的指针

GC 移动对象后,nmethod 里嵌的 oop 必须跟着更新。这条路径**不经过 CodeCache 的 prologue/epilogue**——`CodeCache::gc_prologue()` 是空函数(codeCache.cpp:919),`gc_epilogue()` 只做 `prune_scavenge_root_nmethods()`(codeCache.cpp:921-923)。真正的工作在 GC 内部的 nmethod 遍历里,分两种情况:

- **年轻代 GC**: 只有"嵌着年轻代 oop 的 nmethod"需要处理。Serial/Parallel 维护一条 `_scavenge_root_nmethods` 单链表(codeCache.hpp:98),`register_scavenge_root_nmethod` 检测到 nmethod 含 scavengable oop 才把它挂上去(codeCache.cpp:772-777),年轻代 GC 只遍历这条链(`scavenge_root_nmethods_do`,codeCache.cpp:730);G1 的机制不同——每块 region 维护自己的"强代码根"列表,`register_nmethod`(g1CollectedHeap.cpp:5012)按引用分布把 nmethod 登记到相关 region,年轻代收集只扫这些列表;
- **全堆 GC**: 遍历全部存活 blob(`CodeCache::blobs_do`,genCollectedHeap.cpp:845-848,注释原文 "We scan the entire code cache")。无论哪条路径,最终都落到 `nmethod::oops_do`(nmethod.cpp:1578)按 relocation 表逐个更新嵌入指针——更新机制的载体是 relocation 表,这正是下一篇的主题。

### 类卸载: 依赖对象的 nmethod 跟着死

类卸载时每个存活 nmethod 都要体检: G1 在卸载阶段用 `G1CodeCacheUnloadingTask` 并行遍历(`clean_nmethod` → `do_unloading_parallel`,g1CollectedHeap.cpp:3415),核心是 `do_unloading_oops`(nmethod.cpp:1496)按 relocation 表逐个检查嵌入的 oop/metadata 是否还活着,发现已死就 `make_unloaded`(nmethod.cpp:1379-1390,注释原文 "An nmethod might be unloaded simply because one of its constant oops has gone dead. No actual classes need to be unloaded in order for this to occur.")——注意不需要类被卸载,nmethod 也会因为自己嵌的 oop 死了而死。被卸载的 nmethod 变成 unloaded 状态,之后由 sweeper 按"无栈帧"直接收尸。

### 收尸: flush 与空间归还

`process_compiled_method` 对 zombie 调用 `nmethod::flush()`(nmethod.cpp:1292-1332): 释放 ExceptionCache、从 scavenge root 链摘除、`CodeBlob::flush()`、最后 `CodeCache::free`(codeCache.cpp:553-570)→ 对应 CodeHeap 的 `deallocate`,块回到空闲链表(01 篇讲过)。至此 02 篇的五个状态走完一圈: not_installed → in_use → not_entrant → zombie → unloaded,空间回到 CodeHeap 等下一个方法。

## 4. 塞满了怎么办: 应急链路

### 分配失败的正确姿势

新方法要编译但 CodeCache 满了。分配路径(codeCache.cpp:482 起)的完整应急链:

1. **每次分配先 `NMethodSweeper::notify`**(:483)——但 notify 有门槛: 只有剩余空间低于约 10%(`reverse_free_ratio >= MAX2(100/StartAggressiveSweepingAt, 1.1)`)才真正唤醒,启动初期空间充足时分配不会打扰 sweeper(sweeper.cpp:283-291);
2. `heap->allocate` 失败 → `expand_by` 扩容(:498);扩容也失败 → 按降级路径换堆(NonNMethod → MethodNonProfiled → MethodProfiled,:510-517);
3. 全部失败 → `CompileBroker::handle_full_code_cache`(compileBroker.cpp:2292-2328):

```cpp
// compileBroker.cpp:2292-2328(截取核心,省略 xtty/PRODUCT 段)
void CompileBroker::handle_full_code_cache(int code_blob_type) {
  UseInterpreter = true;
  if (UseCompiler || AlwaysCompileLoopMethods ) {
    ...
    if (UseCodeCacheFlushing) {
      // Since code cache is full, immediately stop new compiles
      if (CompileBroker::set_should_compile_new_jobs(CompileBroker::stop_compilation)) {
        NMethodSweeper::log_sweep("disable_compiler");
      }
    } else {
      disable_compilation_forever();
    }

    CodeCache::report_codemem_full(code_blob_type, should_print_compiler_warning());
  }
}
```

`report_codemem_full`(codeCache.cpp:1365)报警告(分段时 "%s is full. Compiler has been disabled.")、打印 CodeCache 摘要,并发 JFR 的 `CodeCacheFull` 事件。**编译被暂停但方法还能跑**——解释器永远可用(`UseInterpreter = true`)。

### 恢复: 真的腾出空间才算数

编译什么时候恢复?sweep_code_cache 扫完一轮后检查(sweeper.cpp:534-544):

```cpp
// sweeper.cpp:534-544(截取核心,逐字)
  // Sweeper is the only case where memory is released, check here if it
  // is time to restart the compiler. Only checking if there is a certain
  // amount of free memory in the code cache might lead to re-enabling
  // compilation although no memory has been released. For example, there are
  // cases when compilation was disabled although there is 4MB (or more) free
  // memory in the code cache. The reason is code cache fragmentation. Therefore,
  // it only makes sense to re-enable compilation if we have actually freed memory.
  if (!CompileBroker::should_compile_new_jobs() && (freed_memory > 0)) {
    CompileBroker::set_should_compile_new_jobs(CompileBroker::run_compilation);
```

**关键设计 (斜体)**: *恢复编译的唯一依据是"这轮清扫真的腾出了字节"(freed_memory > 0)——只看空闲比例会被碎片化误导(明明有 4MB 空闲却凑不出一块连续段),只有实际归还过空间才说明清扫有效。JIT 是"锦上添花",代码缓存满了就退回解释器,系统照常工作,只是变慢。*

### 用户侧怎么看

- 运行时警告: "CodeCache is full. Compiler has been disabled." + 建议调 `-XX:ReservedCodeCacheSize=`(或分段的 `-XX:NonProfiledCodeHeapSize=` 等);
- `jcmd <pid> Compiler.CodeHeap_Analytics`: CodeCache 总览(Reserved/Committed/Unallocated)+ sweeper 统计(总清扫时间、完整 sweep 数、回收方法数与字节)+ 每段的块分布;
- `-XX:+PrintCodeCache`: 退出/触发时打印每段 size/used/max_used。

## 核心悬念

生命周期闭环了: 四种死法都通向 not_entrant,标记在 safepoint 收尾顺路做,清扫在普通线程增量做、可被 safepoint 打断,热度计数器按"距上次活跃的轮数"选拔牺牲者,GC 在年轻代只碰 scavenge root 链、全堆才全部遍历,最终 flush 把空间还给 CodeHeap。但整条链反复依赖同一个东西——**nmethod 的重定位表**: 更新嵌入 oop 靠它,do_unloading 判断 oop 死活靠它,sweeper 清理 IC 也靠它。这段机器码怎么"认识"自己身上的每一个指针、每一条调用?下一篇: Relocation 系统——机器码里的指针怎么被 JVM 跟踪和更新。

> → [04-relocation-ic.md](04-relocation-ic.md)
