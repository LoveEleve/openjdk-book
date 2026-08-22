# 04 · JNI、JVMTI、JFR 与诊断

> 目标：判断候选人是否能解释 JVM 如何把内部状态安全、低成本、可恢复地暴露给外部世界。

## 1. JNI Handle 为什么不是“给 oop 加一层指针”这么简单？

**主问题**

GC 会搬移 Java 对象。native 代码拿到的对象地址为什么不能直接保存？Handle、JNIHandleBlock、局部引用和全局引用分别保护什么？

**必须回答**

- oop 可能在 GC 后改变地址；
- handle 提供稳定间接层，GC 更新 handle 指向；
- local/global/weak global 的生命周期不同；
- JNI transition 与 safepoint、异常和 thread state 互相约束。

**追问**

1. 为什么 JNI local reference 可以批量释放？
2. weak global reference 为什么不能像 global reference 一样阻止回收？
3. Fast JNI 路径省掉了什么检查，又由谁保证前置条件？
4. native 线程 attach 后，JNIEnv 为什么是线程相关的？

**源码路线**

`JNIHandleBlock` → `JNIHandles` → `jni_NativeInterface` → `ThreadInVMfromNative/ThreadToNativeFromVM`。

## 2. JVMTI capability 与 event enable 为什么是两套状态？

**主问题**

Agent 声明了 `can_generate_method_entry_events`，为什么 VM 还不一定马上发 MethodEntry？

**必须回答**

- capability 是“允许做什么”；
- event callback 是“谁接收”；
- user enabled 是“用户想不想接收”；
- phase、线程级开关和 interp_only 共同决定“现在是否真的发布”；
- 全局 `JvmtiExport::should_post_*` 是发布端的低成本快照。

**追问**

1. 为什么 capability 不能等到事件触发时再临时检查？
2. 为什么 MethodEntry 可能强制线程回到解释器？
3. 多个 env 同时启用/关闭同一事件时，全局标志如何重算？
4. 编译线程产生的 compiled-method-load 为什么不能直接回调 agent？

**源码路线**

`JvmtiManageCapabilities` → `JvmtiEnv::SetEventNotificationMode` → `JvmtiEventController::recompute_enabled` → `JvmtiExport::post_*`。

## 3. Attach、JVMTI agent 和 Java agent 为什么有三条加载语义？

**主问题**

`-agentpath`、`VirtualMachine.loadAgentPath`、`VirtualMachine.loadAgent` 看起来都叫加载 agent，为什么最终符号、阶段和失败后果不同？

**必须回答**

- 启动路径调用 `Agent_OnLoad`；
- native attach 路径调用 `Agent_OnAttach`；
- Java agent 实际加载 instrument/JPLIS 库，再解析 JAR 和 `agentmain`；
- 启动失败可能终止 VM，attach 失败通常只把错误码返回工具；
- attach 协议本身是 socket + NUL 参数 + completion status。

**追问**

1. self-attach 为什么默认被禁止？打开属性后改变了哪一层？
2. AttachListener 为什么由文件和信号按需唤醒？
3. `Agent_OnAttach` 返回非零时，错误经过哪些层才变成 Java 异常？
4. 如果目标 VM 正在 safepoint 或加载库需要改变栈执行权限，谁负责协调？

**源码路线**

`VirtualMachine.attach` → `VirtualMachineImpl` → AttachListener socket → `load_agent` → `JvmtiExport::load_agent_library`/JPLIS。

## 4. JFR 为什么不能简单等价于“事件对象加一个环形队列”？

**主问题**

高频事件、线程局部写入、定期采样、metadata、chunk rotation 和最终文件写出为什么要分层？

**必须回答**

- 事件定义、事件实例、线程局部缓冲和 chunk writer 是不同层次；
- fast path 不能在每次事件上拿全局锁或做复杂分配；
- metadata 必须与事件编码保持版本/字段一致；
- rotation、flush、checkpoint 和最终输出有不同触发条件；
- Java/JNI/VM 事件从不同入口汇合到 recorder。

**追问**

1. 为什么 JFR 事件可以先写入线程本地 buffer，再异步落盘？
2. 如果 metadata checkpoint 丢失，消费者还能正确解析旧事件吗？
3. 定期采样为什么需要独立的 sampler/service thread，而不是让业务线程自采？
4. leak profiler 如何避免把观察行为变成新的分配热点？

**源码路线**

`JfrRecorder` → `JfrEventSetting`/metadata → thread-local buffer → `JfrChunkWriter` → repository/stream。

## 5. SA 为什么能用同一套上层逻辑同时读 core 和活进程？

**主问题**

core 是文件快照，活进程是 ptrace。为什么 SA 的对象、线程和符号读取逻辑可以复用？

**必须回答**

- `ps_prochandle` 把“按地址读内存、按名字找符号”抽象出来；
- core 用 ELF PT_LOAD + map array + pread；
- live process 用 `/proc/<pid>/maps` + ptrace attach + PTRACE_PEEKDATA；
- 符号表通过 symtab/dynsym 和哈希查找，最后做 base + offset；
- 上层只依赖地址空间与类型元数据，不依赖数据源的具体实现。

**追问**

1. core 段尾的分数页为什么要补零？
2. ptrace 非对齐读取为什么要拆成前段/整字/尾段？
3. debuglink/build-id 缺失时，符号解析退化成什么？
4. 活进程 attach 期间为什么必须暂停，哪些数据仍然可能不一致？

**源码路线**

`Pgrab`/`ptrace` 或 core ELF loader → `ps_prochandle` → map lookup/read → symbol table → HotSpot type database。

## 6. hs_err 为什么要把“报告自己可能崩溃”当成一等问题？

**主问题**

错误处理运行在最危险的上下文里。为什么 vmError 使用 first-error CAS、STEP、超时、专用 decoder 和无限阻塞，而不是普通日志框架？

**必须回答**

- 多线程同时崩溃时只能有一个报告者；
- 崩溃线程可能持有任意锁，错误路径不能依赖普通锁；
- 每个 STEP 要能标记当前失败位置；
- Decoder、寄存器打印、CodeCache 反查和文件写入自身都可能失败；
- 报告的目标是尽可能留下诊断证据，不是保证优雅恢复。

**追问**

1. 为什么失败线程不继续运行，而是 `infinite_sleep`？
2. 递归错误和并发错误有什么不同的处理路径？
3. 为什么错误线程要绕过共享 decoder 锁？
4. 如果报告超过全局超时，继续打印的收益与风险是什么？

**源码路线**

`VMError::report_and_die` → first-error CAS → `report`/STEP → Decoder/CodeCache/OS context → log file → `os::die`。
