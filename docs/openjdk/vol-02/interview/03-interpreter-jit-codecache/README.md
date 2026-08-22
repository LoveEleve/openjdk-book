# 03 · 解释器、JIT、帧与 CodeCache

> 目标：判断候选人是否能把字节码、IR、机器码、栈帧和反优化看成一条连续协议。

## 1. C1 和 C2 的根本差异是什么，而不是“一个快、一个强”？

**主问题**

如果只说 C1 编译快、C2 优化强，实际上没有解释任何设计。两者各自选择了什么中间表示、状态模型和优化边界？

**必须回答**

- C1 的 HIR/LIR 与 C2 Ideal Graph 的世界观差异；
- C1 显式线性化与 C2 全局图优化的代价；
- 为什么 C2 需要 Type、IGVN、控制/数据统一图；
- tiered compilation 不是固定升级阶梯，而是基于 profile、队列和资源做决策。

**追问**

1. 为什么 C1 不直接使用 C2 的 Ideal Graph？
2. 为什么 C2 Parse 期要维护 JVMState？
3. EA 的“证明可消除”与 MacroExpand 的“真正删除分配”分别发生在哪一层？
4. 如果 CodeCache 快满，编译策略为什么可能改变？

**源码路线**

`CompileBroker` → `CompilationPolicy` → C1 `IR/LinearScan/LIR` 或 C2 `Parse/Ideal/PhaseCFG/Output` → `nmethod`。

## 2. 为什么 intrinsic 必须在 Parse 期接管语义？

**主问题**

`Math.abs`、数组拷贝、加密和字符串操作可以走普通调用。为什么 C2 要在解析时识别 intrinsic，而不是先生成 Call，再由后端优化？

**必须回答**

- intrinsic 需要拿到调用点类型、控制、内存和异常语义；
- LibraryCallKit 生成的是图节点/宏节点，不是简单函数地址替换；
- 后续 MacroExpand、IGVN、类型与内存依赖必须看到这个语义；
- 不满足条件时必须回退到普通调用，不能为了快而破坏语义。

**追问**

1. intrinsic 失败时如何保证调用语义仍然正确？
2. 为什么有些 intrinsic 最后仍会展开成 runtime/library call？
3. 如果在机器码生成阶段再识别，哪些高层信息已经丢失？
4. intrinsic 与 StubRoutines 的关系是“同一个东西”吗？

**源码路线**

`Parse::do_call` → `LibraryCallKit` → `CallGenerator`/宏节点 → `PhaseMacroExpand` → `Matcher/GCM/Output`。

## 3. nmethod 为什么不能只是“机器码地址 + 长度”？

**主问题**

JIT 代码执行起来只需要入口地址。为什么 nmethod 还要携带 OopMap、scope、dependencies、relocation、exception handler、inline cache 和状态？

**必须回答**

- GC 需要 OopMap；
- 反优化需要 scope/DebugInfo 和虚拟对象状态；
- 类卸载与假设失效需要 dependencies；
- 机器码地址需要 relocation、IC 清理和 CodeCache 生命周期；
- not_entrant/zombie/unloaded 不只是布尔标志，而是执行、入口和回收阶段的协议。

**追问**

1. 代码已经 not_entrant，为什么不能立刻 free？
2. 返回地址落在一个 zombie nmethod 内时，栈遍历怎么办？
3. inline cache 的 clean 与 nmethod unloading 有什么关系？
4. 如果只保留机器码和 OopMap，反优化会缺什么？

**源码路线**

`CodeBuffer` → `CodeBlob` → `nmethod::new_nmethod` → `CodeCache::commit` → `NMethodSweeper`/`Dependencies`。

## 4. 物理帧只有一个，为什么性能分析能看到三个 Java 方法？

**主问题**

C2 把多个方法内联进一个 nmethod。机器栈上只有一个物理帧，为什么 GC、异常处理、反优化和 jstack 仍能还原多个源级调用者？

**必须回答**

- physical frame 与 vframe/vframeArray 的分层；
- pc 通过 scope 找到当前 inline tree；
- 反优化把一个 compiled frame 拆成多个解释器可见的逻辑帧；
- OopMap 解决机器 slot，DebugInfo/scope 解决源级局部状态，二者不能混为一谈。

**追问**

1. OopMap 能不能直接告诉你 inline 的方法名？
2. 一个 inline 方法有 synchronized、异常处理或 monitor 时，反优化要恢复什么？
3. 如果 nmethod 已失效但线程还在执行，什么时候允许回收？
4. deopt blob 为什么属于 runtime stub，而不是普通 nmethod？

**源码路线**

`frame::sender`/`frame::oops_do` → `nmethod::scope_desc_at` → `vframe` → `Deoptimization::unpack_frames`。

## 5. CodeCache 为什么需要 allocate/commit 两阶段？

**主问题**

为什么不让编译器直接在 CodeHeap 中生成代码，生成完就跳进去？

**必须回答**

- CodeBuffer 是可变临时工地；
- CodeBlob 是带布局、重定位、OopMap 和身份的正式对象；
- allocate 时不能让 CodeCache 观察到半构造 blob；
- commit 还涉及计数和 I-cache invalidate；
- CodeHeap 的 segmap 让 pc 可以反查 CodeBlob。

**追问**

1. 如果 commit 前另一个线程执行了 pc 反查，最坏会看到什么？
2. 为什么代码不能像 Java 对象那样随意压缩搬移？
3. 分段 CodeCache 隔离的是大小、寿命、类型，还是三者共同作用？
4. fallback 到其他 heap 会不会破坏类型语义？

**源码路线**

`CodeBuffer` → `CodeBlobLayout` → `CodeCache::allocate/commit` → `CodeHeap::allocate/find_blob_for`。
