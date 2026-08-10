Append 5 sections to 04-interpreter/README.md after existing §六. Read full README first.

## Quality mandate
- **Depth**: every interview question must have a concrete, specific answer — not "see doc X", but "doc X §Y explains that the interpreter has 3 separate entry points because combining them would add branches to the hottest code path in the JVM"
- **Breadth**: cover ALL 6 docs — don't leave any doc out of the interview table or production map
- **Interview readiness**: the reader should be able to stand in front of a whiteboard and draw the interpreter's dispatch loop after reading the interview table
- **Continuity**: explicitly show how 04 fits in the chain: 03(objects)→04(executes bytecode on objects)→05(JIT replaces interpreter)
- **First principles**: each audit question should start from "if you were designing a bytecode interpreter from scratch..." and then show how JVM's design is the natural consequence of simple principles
- **Beginner-friendliness**: every term used in §七~§十一 must have been defined in §〇. If not, add it there first.

## Existing structure (preserve ALL)
§〇 上手指南 → §一 执行模型 → §二 三层模型 → §三 文件索引 → §四 数据结构 → §五 探针 → §六 计划文档

## Existing docs (use exact names)
00-Interpreter-Overview.md (400 lines) — 三道入口 + 执行语义
01-TemplateInterpreter-Init.md (685 lines) — 模板生成 + 宏驱动
02-Stack-Frame.md (418 lines) — 栈帧布局 + TOS 状态机
03-MethodEntry.md (330 lines) — 方法入口 + safepoint 轮询
04-Bytecode-Dispatch.md (396 lines) — 指令分派 + invoke 语义
05-InterpreterRuntime.md (328 lines) — 慢路径 + 计数器 + JIT 触发

## APPEND these at END (do NOT modify existing):

### §七 面试高频问题 (8 questions)

For each: the question, which doc answers it, and WHAT SPECIFIC INSIGHT the doc provides that makes the answer compelling to an interviewer.

| 面试问题 | 文档 | 核心洞察 |
|----------|------|----------|
| "JVM 怎么执行字节码？模板解释器为什么比 switch-case 快？" | 01-TemplateInterpreter-Init §dispatch | 256 条目跳转表 = O(1) 分发。每个字节码独立代码路径 → CPU 分支预测不受其他字节码影响。switch-case = 200 个 cmp+jmp → 平均 100 次比较 → CPU BTB 被污染 |
| "解释器怎么发现 '该 JIT 了'？" | 05-InterpreterRuntime §counters | 双计数器：InvocationCounter 触发全方法编译，BackEdgeCounter 触发 OSR 编译热循环。safepoint 时 counter 衰减——防止 10 分钟前的热方法浪费编译资源 |
| "TOS 状态机是什么？为什么需要？" | 02-Stack-Frame §TOS | 编译时类型安全而非运行时检查。每个 Template 有 _tos_in/tos_out → 模板生成器静态选择正确变体 → 零运行时开销。对比：运行时检查 = 每字节码 +3 条指令 × 10⁸/s |
| "解释器三道入口（正常/异常/返回）为什么分开？" | 00-Interpreter-Overview §entry | 正常入口创建帧 + 分配局部变量。异常入口只在栈顶异常引用 → 跳到 handler bci。返回入口只恢复调用者帧 → 零分配。如果合并 = 每次都要 switch → 热路径不可接受 |
| "invokevirtual 怎么找到目标方法？" | 04-Bytecode-Dispatch §invoke | CP cache 三层加速：Uninitialized→Resolved→Virtual。第一次=LinkResolver 解析+写入缓存。之后=直接读 Method*+entry point → O(1) vs O(n) vtable 搜索 |
| "explain 方法中出现 return/new/monitor 怎么处理？" | 05-InterpreterRuntime | 慢路径=回调 C++ Runtime。resolve_ldc→ConstantPool 字符串, _new→TLAB 快速分配, monitorenter→fast_enter→BiasedLocking→轻量锁→膨胀。每个函数 ≤50 lines C++ |
| "safepoint 轮询在解释器中怎么工作的？" | 03-MethodEntry §safepoint | 每字节码都 testl 太贵（cache miss ~200 cycles）。只在跳转指令处插入：goto/if*/tableswitch/return。for(;;) 必须在循环底播测 → 这就是为什么空循环也会到 safepoint |
| "JVM 的调试 agent 怎么钉住解释器的？" | 00-Interpreter-Overview §agent | NotifyFramePop 置位 JavaThread::_at_breakpoint → deopt 禁止 → 方法永远解释执行 → 延迟 100x。一线生产故障："加了 jdwp 后 P99 从 200ms→5s" |

### §八 生产故障 (7 scenarios)

| 生产场景 | 症状 | 文档 | 诊断路径 |
|---------|------|------|---------|
| Agent 钉住解释器 | jdwp 后延迟 3x | 00 §agent | `jstack <PID>` → 找到 _at_breakpoint=true → 验证 NotifyFramePop → 无修复（agent 行为），只能去掉 agent |
| Hot 方法不 JIT | CPU 高温，perf 显示 interpreter 时间 >80% | 05 §counters | `-XX:+PrintCompilation` → 检查是否有 `made not compilable` → `-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining` |
| Safepoint 超时 | GC 日志 "Safepoint took 8000ms" | 03 §safepoint | `jstack` 找到在解释器中的线程 → 查看 bci 是否在长循环内 → 确认循环包含 goto/if* → 加 `-XX:+SafepointTimeout` 定位具体字节码 |
| 同步方法性能退化 | 大量 BLOCKED 在 monitorenter | 04+05 | `-XX:+PrintBiasedLockingStatistics` → 大量 revocation → `-XX:BiasedLockingStartupDelay=0` 关闭延迟 |
| StackOverflowError 缺栈信息 | 栈溢出但 jstack 无调用链 | 02 §frame | 检查 yellow/red zone → 确认 -Xss 大小 → 验证 guard page 是否被 mprotect 保护 |
| TieredStopAtLevel=0 生产用 | 全方法解释执行 | 05 §JIT trigger | `-XX:+PrintFlagsFinal | grep TieredStopAtLevel` → 0=纯解释 → 改 4=C2 JIT |
| 反射性能回归 | Method.invoke() 50x 慢于直接调用 | 04 §invoke | `Method.setAccessible(true)` 跳过安全检查 → 但无法跳过 methodOop dispatch → 用 MethodHandle 代替 |

### §九 评审矩阵 (6 docs)

| # | 文档 | 生产故障可直接参考？ | 面试题可直接回答？ | "为什么这样设计"？ | GDB？ | 评级 |
|---|------|:---:|:---:|:---:|:---:|:---:|
| 00 | 00-Interpreter-Overview | ✅ agent 钉 VM | ✅ 三道入口 | ⚠️ 常规描述为主 | ⚠️ 无 GDB session | 🟡 |
| 01 | 01-TemplateInterpreter-Init | ⚠️ 无生产场景 | ✅ dispatch O(1) | ⚠️ why 栈对象？why 宏驱动？ | ⚠️ 无 GDB session | 🟡 |
| 02 | 02-Stack-Frame | ⚠️ 缺 TOS 状态机 | ✅ 布局+局部表 | ⚠️ why per-TOS? | ⚠️ 仅 sizeof | 🟡 |
| 03 | 03-MethodEntry | ✅ safepoint 超时 | ✅ poll 机制 | ⚠️ why 只在跳转处 poll？ | ✅ | 🟡 |
| 04 | 04-Bytecode-Dispatch | ✅ invoke 反射慢 | ✅ invoke 语义 | ⚠️ CP cache 加速？ | ⚠️ 无 GDB session | 🟡 |
| 05 | 05-InterpreterRuntime | ✅ TieredStopAtLevel | ✅ 双计数器 | ⚠️ 双计数器 vs 单计数器？ | ✅ | 🟡 |

### §十 深度审计问题（15 道，从第一性原理出发）

Tier 1 入口模型:
1. "如果你要设计一个字节码解释器，你会把所有入口合并成 1 个还是 3 个？合并的代价是什么？→ 00 §entry"
2. "为什么 JVM 不在解释器入口处加一个全局的 'check for JIT' 检查？每次都要检查 counter 不浪费吗？→ 05 §counters"

Tier 2 模板生成:
3. "为什么模板解释器在启动时生成机器码而不是预编译到 libjvm.so 中？→ 01 §generation"
4. "为什么 DEF_ALL_INTERPRETER_TYPES 用宏而不是 C++ 模板/虚函数？→ 01 §macros"
5. "每个字节码对应一个独立函数有什么好处？合并相似字节码（如 iload_0/iload_1/iload）不行吗？→ 01 §dispatch"

Tier 3 TOS + 帧:
6. "如果不用 TOS 状态机，每次字节码执行前查操作数栈顶部类型，性能开销多大？→ 02 §TOS"
7. "解释器栈帧为什么需要 sender_sp 和 unextended_sp 两个栈指针？→ 02 §frame"

Tier 4 Safepoint + Invoke:
8. "如果每字节码都做 safepoint poll，为什么 JVM 没这么做？→ 03 §safepoint"
9. "invokeinterface 的 itable 搜索比 invokevirtual 的 vtable 慢多少？为什么不能合并？→ 04 §invoke"

Tier 5 计数器 + JIT:
10. "为什么需要 BackEdgeCounter 而不只是在方法入口计数？→ 05 §counters"
11. "计数器在 safepoint 时衰减——这个设计解决什么问题？不衰减会怎样？→ 05 §decay"
12. "如果 -XX:TieredStopAtLevel=0, 为什么解释器直接执行比 C2 慢 100x？→ 05 §performance"
13. "解释器怎么处理 invokestatic 的 clinit？如果 clinit 正在运行，第二次遇到同一个类的 invokestatic 怎么办？→ 05 §clinit"
14. "为什么 synchronized 方法的解释器入口和普通方法不同？→ 03 §sync"
15. "如果代理设置了 NotifyFramePop, 为什么 JVM 禁止编译该方法？→ 00 §agent"

### §十一 阶段连接

| 前一阶段 | 传递给 04 什么 | 04 如何消费 |
|----------|-------------|------------|
| 01-jvm-startup | 模板解释器在 create_vm() 的 interpreter_init() 中初始化 (Phase 14) | 01 文档解释模板是怎么生成的 |
| 02-class-loading | ClassFileParser 解析后的 InstanceKlass/Method/CP | 02+04 使用 Method::_from_interpreted_entry 作为入口点 |
| 03-object-model | oop/klass 层次结构，TLAB | 字节码操作对象——aload 读 oop，getfield 读 offset，putfield 写 offset |
| 12-cpu-layer | CPU 级 dispatch 机制 (movzbl+jmp) | 01 文档引用但不重复——04 关心的是"为什么 jmp 而不是 call"，12 关心的是"jmp 如何影响 BTB" |

与 [01/18] 和 [12/02] 的边界：04 解释**运行时语义**（为什么三道入口？为什么双计数器？为什么 per-TOS？），01/18 解释**模板数据结构**（Template 的字段含义），12/02 解释 **CPU 级执行**（x86 movzbl 怎么变成 jmp 地址的）。
