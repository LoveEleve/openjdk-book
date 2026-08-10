# 02. 从编译帧回到解释器——unpack 帧重建

> 🔴 Deep | 2 KP 中的执行引擎
> 读者处境: deopt 决定已做——nmethod marked not_entrant。但当前线程的栈顶还在这个 nmethod 的 frame 中。需要反编译整个内联树(6层内联→6个解释器帧)→重建所有 locals/expressions/monitors→切回解释器。

### 1. "反编译内联树" — scope + vframeArray

场景: C2 编译时内联了 `A.bar()→B.baz()→C.qux()` —— 一个 compiled frame 包含 3 层 inline。deopt 时需要展开成 3 个解释器帧。

**ScopeDesc → vframe** (`scopeDesc.hpp` + `deoptimization.cpp:unpack_deoptimization`):
```
compiled frame ← 1 帧, 3 scope
    scope[0]=A.bar (最外层 caller)
    scope[1]=B.baz (内联层1)
    scope[2]=C.qux (最内层 callee)
→ unpack → 3 解释器帧:
    frame[2]=C.qux (最内, 先处理——从里向外建)
    frame[1]=B.baz
    frame[0]=A.bar (最外, 最后处理——第一个被解释器看到的帧)
```
- 源码: `deoptimization.cpp:700-900` unpack_deoptimization→填充 vframeArray
- 关键设计: 从最内 scope 开始 unpack——因为栈帧在内存中从高地址(最内=最先push)到低地址(最外=最后push)。C.qux 帧在最高地址→先处理→B.baz 接着→A.bar 最后→切解释器后 RSP 指向 A.bar 帧(向外)
- [x86: 栈向低地址增长——inner frame 在高地址。Unpack 分配帧顺序: innermost first→outermost last。每个帧 push 后 RSP 减小——最终 RSP 指向 outermost frame——解释器从 outermost 开始解释]

**vframeArray 结构** (`deoptimization.hpp:35`):
```cpp
class vframeArray: public CHeapObj<mtCompiler> {
  int _frames;                    // 帧数(inline深度)
  frame _original;                // 原始编译帧
  frame _caller;                  // caller 帧(再外面一层)
  vframeArrayElement* _elements;  // 每元素=一个虚拟帧的 scope info
};
```
- 源码: `vframeArray.hpp:40-80` vframeArrayElement 包含 locals/expressions/monitors arrays
- 关键设计: vframeArray 不是真实的栈——是在 C-heap 分配的 intermediate representation。Fill locals/expressions/monitors from ScopeValues→然后逐帧 allocate 真实栈帧→copy values

### 2. "怎么建一个帧？" — unpack 逐帧流程

场景: 现在有 vframeArray——每个元素对应一个 scope(locals[0..N], expressions[0..M], monitors[0..K])。需要为每个 scope 分配真实栈帧→copy values→link frames。

**unpack 每帧步骤** (`deoptimization.cpp:900-1200`):
```
for each vframeArrayElement (innermost→outermost):
  1. allocate frame (calculate frame size = locals+expressions+monitors+method+bcp+link)
  2. copy ScopeValues to locals:
     - Location::on_stack → copy from compiled frame stack position
     - Location::in_reg → copy from saved register value
     - Location::constant → store constant oop
  3. copy expressions(stack values, etc.)
  4. copy monitors(BasicLock objects for synchronized blocks)
  5. set bcp = scope.bci() (restore bytecode pointer)
  6. set method = scope.method()
  7. link: [current frame].sender_sp = [previous frame].sp  // chain
  8. push frame → rsp -= frame_size
```
- 源码: `deoptimization.cpp:900-1200` 每帧的 unpack 循环体
- 关键设计: copy locals 是最复杂的——ScopeValue 以 Location 编码表示"这个 local 存在编译帧的哪个寄存器/栈位置"。已保存的寄存器值在 DeoptimizationBlob 的 save area 中——解引用 saved_register(loc.register_number)→copy 到新帧栈
- [C++: ScopeValue 有 3 种子类型——LocationValue(寄存器/栈偏移/常量)、ConstantOopWriteValue(嵌入的常量oop)、ObjectValue(聚合对象,嵌套的 ScopeValues)。ObjectValue 用于对象字段的重建——对应 C2 的 scalarization(把对象拆成字段)。需要递归展开子ScopeValue重建完整对象]

**populate_monitors** (`deoptimization.cpp:200-350`):
```
for each MonitorValue in scope:
  1. 从 saved registers 恢复 lockee_obj(被锁的对象)
  2. allocate BasicLock in new frame
  3. BasicLock::set_displaced_header(markOop) // 恢复 displaced mark word
  4. ObjectSynchronizer::fast_enter(lockee_obj, basicLock, thread)
```
- 源码: `deoptimization.cpp:1450-1650` populate_monitors→relock
- 关键设计: deopt 后锁不能丢——如果线程在编译代码中持有锁→deopt→必须在新解释器帧中重新获得这个锁。populate_monitors 用 saved BasicLock info 重新调用 ObjectSynchronizer::fast_enter——一次性重新锁上所有 deopt 前持有的监视器

### 3. "切回去" — 最后帧的 return entry

场景: 所有帧建好了——现在需要让解释器开始执行。不是从头开始——是从 deopt 的 bci 继续。

**return entry 切換** (`deoptimization.cpp:1200-1350`):
```
最后帧建完后:
  1. 设 JavaThread::_thread_state = _thread_in_Java (解释器开始运行)
  2. 恢复 callee-saved 寄存器到新帧的调用约定
  3. 设 pc = interpreter entry (bcp → bytecode dispatch)
  4. 其余从 saved registers 恢复
  5. jmp interpreter entry — 解释器从断点开始
```
- 源码: `deoptimization.cpp:1200-1350` unpack 切換到解释器入口
- 关键设计: 解释器从正确的 bci 继续——不是从 method 入口。所有 deopt 前执行过的 bytecode 都不会被重新执行——每个 deopt 都是"精确式"——继续执行而不是回滚重来。scope.bci() 在编译时就记录了 "每个 PC 位置对应的 Java bytecode index"
- [C++: `BytecodeInterpreter::run()` 或 `TemplateInterpreter::_entry_table[bci]`——不用满入口。Template 解释器有一组 dispatch stub——按 bci 分发(`goto [dispatch_table + bci*8]`)。deopt 后的解释器执行从这个 bci 的第一条 bytecode 重新开始 dispatch]

---

### 核心悬念

**"Deopt unpack 从编译帧反编译内联树→vframeArray(虚拟帧)→逐帧分配真实栈帧+copy ScopeValues(含递归 ObjectValue 展开)+populate monitors(重新锁上)→切解释器从断点 bci 继续。所有保存在 DeoptimizationBlob 的寄存器值用来重建帧。"** — 下一篇: 域23 StubRoutines——JVM 的运行时桩库。

> → 域23 StubRoutines
