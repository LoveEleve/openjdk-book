# 15 · 异常、反射、StackWalk 与运行时调用边界：深度题目

## 1. 编译代码里的一行空指针，为什么会让整个信号系统参与进来？

`a.length` 在 C2 编译代码中只是一条 `mov` 指令，实际执行时 SIGSEGV。为什么 JVM 不是先检查空、再走异常，而是让 CPU 崩溃、再由信号处理器翻译成 Java NPE？

回答必须覆盖：

- 隐式异常检查（implicit null check）与显式检查的取舍；
- `needs_explicit_null_check` 为什么与访问位移/页边界有关；
- 信号处理器如何按 `si_addr`/归属区分 STACK_OVERFLOW、IMPLICIT_NULL、IMPLICIT_DIVIDE_BY_ZERO；
- `continuation_for_implicit_exception` 按 faulting pc 归属解释器/编译代码/桩的不同处理；
- nmethod 的 `ImplicitExceptionTable` 查不到时为什么不是 NPE 而是走崩溃报告。

追问：如果对象引用带压缩 oop 偏移，隐式 null check 的前提为什么会改变？如果访问位移超过一个页面大小，为什么编译器必须改生成显式检查？

源码入口：`share/runtime/sharedRuntime.cpp:796`、`share/code/nmethod.cpp:1986`、`os_cpu/linux_x86/os_linux_x86.cpp:358`、`share/asm/assembler.cpp:300`。

## 2. 显式异常为什么会像接力一样逐帧向外传？

`athrow` 或普通异常不是一次性跳到 handler，而是先从编译代码逃逸、经过 exception blob、再逐帧找 handler。这条接力链为什么必须存在？

回答必须覆盖：

- C2 为什么倾向内联 catch、只有逃逸才交运行时；
- `RethrowNode`/`rethrow_C` 的时机：callee 帧已移除、当前帧是 caller；
- `raw_exception_handler_for_return_address` 按返回地址归属编译代码/调用桩/解释器的分派；
- exception blob 与 `handle_exception_C` 的职责分工；
- 每一帧 handler 不命中时如何继续向外层找，以及对 deopt 帧的特殊处理。

追问：如果 C2 把所有异常都交给运行时逐帧查表，会损失什么性能优势？如果异常在编译代码内部被内联 catch 接住，为什么不需要进任何运行时？

源码入口：`share/opto/runtime.cpp:1447`、`share/runtime/sharedRuntime.cpp:454`、`cpu/x86/sharedRuntime_x86_64.cpp:3900`、`share/code/compiledMethod.cpp:137`。

## 3. 真正的 crash 与可挽救的 Java 异常，界线到底画在哪？

SIGSEGV 本身无法区分“空指针”和“VM 自己写崩了”。HotSpot 靠什么把这条界线画得足够可靠？

回答必须覆盖：

- nmethod 的 `ImplicitExceptionTable` 查不到 continuation 时代表什么；
- faulting pc 不在任何已知代码归属时信号处理器怎么处置；
- `ExceptionCache` 的只读快路径与假阴性语义；
- 为什么“读不锁、允许 miss”不会破坏正确性；
- 结果：可查到的走 Java 异常，查不到的走 hs_err 崩溃报告。

追问：如果一个 agent 或 JNI 覆盖了关键信号处理器，为什么 VM 的关键信号保护会失去作用？查不到异常表是否总代表“真崩溃”？

源码入口：`share/code/nmethod.cpp:1986`、`share/code/compiledMethod.hpp:43`、`os_cpu/linux_x86/os_linux_x86.cpp:358`。

## 4. `Method.invoke` 为什么最后会落到 `JavaCalls`，而不是某种“反射专用调用通道”？

反射调用看起来和普通调用不同，为什么 HotSpot 最终仍用 `JVM_InvokeMethod` → `Reflection::invoke_method` → JavaCalls 完成，而不是造一套专门反射的调用器？

回答必须覆盖：

- `Method` 镜像里为什么保存 slot 编号而不是每次重新解析名字；
- `invoke` 五段：方法解析、参数个数、拆箱/扩宽/打包、`JavaCalls::call`、`InvocationTargetException` 包装；
- 为什么访问检查发生在 Java 侧 `Reflection.verifyAccess`，JVM 侧不重复检查；
- 结果装箱/基本类型 `narrow` 如何与参数扩宽对称；
- 为什么 `Class.isInstance`/`getMethod` 等反射元数据读取也是典型 JVM/JNI 入口。

追问：如果反射调用每次重新查方法名，会在哪里造成重复成本？`InvocationTargetException` 的作用为什么是包装目标方法本身的异常，而不是替代访问控制错误？

源码入口：`share/prims/jvm.cpp:3571`、`share/runtime/reflection.cpp:1257`、`share/runtime/reflection.cpp:1072`、`java.base/share/classes/java/lang/reflect/Method.java:499`。

## 5. `JVM_GetCallerClass` 为什么必须跳过三类内部帧？

`@CallerSensitive` 场景需要“真正的调用者”而不是反射/方法句柄辅助帧。HotSpot 为什么用 `security_next` 跳过 `Method.invoke`、`MethodAccessorImpl` 和 LambdaForm？

回答必须覆盖：

- 栈上为什么会出现反射辅助帧和 LambdaForm 帧；
- `security_next` 与普通 `vframeStream` 遍历的差异；
- `is_ignored_by_security_stack_walk` 列出的三类帧；
- frame 0/1 必须是 `_getCallerClass` intrinsic 且带 `@CallerSensitive` 的约束；
- `@CallerSensitive` 注解信息何时被收集进元数据。

追问：如果不跳过反射辅助帧，`getCallerClass` 会返回什么？为什么 `@CallerSensitive` 自身在安全与语义上都依赖这条跳过链？

源码入口：`share/prims/jvm.cpp:706`、`share/oops/method.cpp:1268`、`share/classfile/classFileParser.cpp:2172`。

## 6. StackWalker 的隐藏帧过滤，为什么是 HotSpot 和 Java 两个层各做一半？

StackWalker 需要隐藏 LambdaForm 和反射帧，为什么不是全部由 HotSpot 做，也不是全部由 Java 侧做？

回答必须覆盖：

- `JVM_CallStackWalk`/`StackWalk::walk` 与分页批量取帧；
- HotSpot 侧 `skip_hidden_frames` 只跳过 `is_hidden()`（`@LambdaForm.Hidden`）的方法；
- Java 侧 `StackStreamFactory` 按类判断是否跳过反射帧；
- 为什么 HotSpot 无法把反射帧也当 `is_hidden` 处理；
- 隐藏/可见模式 `SHOW_HIDDEN_FRAMES` 如何改变过滤行为。

追问：如果 Java 侧不滤反射帧、只靠 HotSpot 滤 LambdaForm，默认 `StackWalker` 输出会多出什么？如果 HotSpot 把 `Method.invoke` 也标记成 hidden，会破坏哪种语义？

源码入口：`share/prims/jvm.cpp:552`、`share/prims/stackwalk.cpp:332`、`share/prims/stackwalk.cpp:123`、`java.base/share/classes/java/lang/StackStreamFactory.java:249`。

## 7. 异常与反射为什么会“跨解释/编译两种世界”而不丢语义？

异常可能在解释器或编译代码中抛出，反射调用可能穿越 native/VM/Java 多层。HotSpot 用什么保证这两种跨越都不丢失方法、调用者和语义？

回答必须覆盖：

- c2i/i2c adapter 与编译代码返回地址如何衔接异常查找；
- ScopeDesc/vframe 如何把机器帧还原成字节码层语义；
- 反射的访问检查在 Java 侧、参数打包在 VM 侧、结果装箱回 Java 侧的分工；
- 栈遍历能在解释器和编译帧间往返的原因；
- `JVM_GetCallerClass`/StackWalker 与异常处理如何共享同一条帧链。

追问：如果异常查找只看机器地址、不在意 ScopeDesc，内联方法的三层调用者会怎样丢失？如果反射参数打包不走 JavaCallArguments，对象参数在 GC 期间会有什么风险？

源码入口：`share/runtime/sharedRuntime.cpp:454`、`share/code/nmethod.cpp:1986`、`share/runtime/reflection.cpp:1072`、`share/opto/runtime.cpp:1447`。