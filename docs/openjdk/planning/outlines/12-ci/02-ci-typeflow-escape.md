# 02. ciTypeFlow + bcEscapeAnalyzer — 类型流与逃逸分析

> 🔴 Deep | 11 KP 中的 2 个核心机制
> 读者处境: C2 需要知道每个 bci 的栈+局部变量类型——从 bytecode 推导——处理分支/异常/循环。然后判断对象是否"逃逸"——决定能否栈上分配。

### 1. ciTypeFlow — 字节码类型流推导

场景: `String.length()` 方法——C2 编译前需要知道: bci=0 栈是 empty, 局部变量=this(String)。bci=5 invokevirtual——需要 receiver 类型=String——来判断能否 devirtualize。ciTypeFlow 从 bytecode 推导所有 bci 的类型状态。

**ciTypeFlow** (`ciTypeFlow.hpp.cpp`):
- 输入: ciMethod + ciMethodBlocks (基本块)
- 输出: `StateVector`——每个 bci 的栈类型+局部变量类型——`ciType*` 数组
- [C++: ciTypeFlow 的两阶段——Phase 1: flow-sensitive 分析——从 bci=0 开始——每条字节码模拟其栈+局部变量影响——类似栈操作的抽象解释。Phase 2: merge—分支汇合 (if/else 后)—`ciType::common_type(t1, t2)` 取两个分支类型的共同父类——没找到→`ciType::top` (未知)—后续 C2 需要 safe point]
- 异常处理器 (exception handler): try block→handler——`catch(Exception e)`——handler bci 的局部变量=exception object (ciInstanceKlass of Exception)—其他 locals 是 try block 的 locals——栈深=1
- 循环: 循环头的入口类型——第一次从 predecessor 推导——后续 iterations 不变——达到 fixpoint→停止
- [C++: `StateVector::meet(StateVector other)`——两个分支汇合——取 `ciType::common_type(t1, t2)`——如果 t1=String, t2=StringBuilder→common=Object (近父类)→精确度下降。类型越精确→C2 可做的优化越多 (inline/devirtualize/field exact type)]

### 2. BCEscapeAnalyzer — 对象逃逸分析

场景: `Point p = new Point(1,2); return p.x + p.y;`——p 只在当前方法内使用——不"逃逸"到外部 (不存到静态字段/不返回给调用者/不传入其他方法作为参数)——C2 可以**不分配 p**——直接算 1+2——栈上分配。

**BCEscapeAnalyzer** (`bcEscapeAnalyzer.hpp.cpp`):
- 输入: ciMethod + ciTypeFlow 的结果 (每个 bci 的类型信息)
- 输出: `_arg_escapes[]` (参数逃逸) + `_alloc_escapes[]` (方法内分配逃逸)
- NoEscape: 对象不离开方法→可以 scalar replacement (栈上分配每个 field→消除堆分配)
- ArgEscape: 对象作为参数传出去→不能消除——但调用者可能没有存——需要 inter-procedural analysis
- GlobalEscape: 对象存到 static field→其他线程可见→完全不能消除
- [C++: ConnectionGraph——`BCEscapeAnalyzer::ConnectionGraph`——节点=分配点+参数+字段——边="引用" (赋值/传参/存字段)——从每个分配点出发——DFS 找所有可达的"逃逸点"(static field/return/argument to unknown method)——到达→标记为逃逸]
- `ciMethod::scalar_replacement_possible()`: 如果 NoEscape→C2 PhaseMacroExpand 做 scalar replacement——把 `new Point` 拆成两个局部变量 `x` 和 `y`——消除堆分配——GC 压力降

---

### 核心悬念

**"`Point p = new Point(1,2); return p.x + p.y;`——p 没有逃逸——C2 不分配堆对象——拆成两个局部变量——GC 零压力。"** — ciTypeFlow 提供每个 bci 的精确类型——BCEscapeAnalyzer 判断对象去向——connection graph DFS 找逃逸点。如果 `p` 被 `list.add(p)`——arg escape——不能消除——必须分配。下一次: ciObjectFactory——ciObject 怎么管理 GC 安全问题。

> → [03-ci-factory-runtime.md](03-ci-factory-runtime.md)
