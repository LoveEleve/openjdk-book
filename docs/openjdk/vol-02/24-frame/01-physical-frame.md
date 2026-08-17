# 01. JVM 怎么表示一个栈帧？— Physical Frame

> **前置依赖**:[23-stub/01 — StubRoutines 全局桩](openjdk/vol-02/23-stub/01-stub-entry.md):桩与解释器代码一样都是 CodeCache 里的 blob,frame 的 pc 反查依赖这套东西;[16-code-cache/01 — CodeBlob 与 CodeHeap](openjdk/vol-02/16-code-cache/01-codeblob-heap.md):nmethod/CodeHeap 是帧的载体;[17-threads/01 — Thread 层次](openjdk/vol-02/17-threads/01-thread-hierarchy.md):JavaFrameAnchor 是栈遍历的入口
> → **后续**:[24-frame/02 — Virtual Frame](02-virtual-frame.md):编译代码内联了三层,物理帧看不到源级方法,下一篇解决
> 关联域: 16-code-cache(OopMap 生成)、25-gc(oops_do 消费)、22-deopt(patch_pc 消费者)

## 栈上每一个"激活",都需要一张门票

GC 要扫描线程栈上的引用——它不知道栈上哪个 slot 是 oop,哪个是普通整数;`jcmd Thread.print` 要打印调用栈——它不知道上一帧在哪;性能分析要采方法栈——它不知道当前执行到哪个方法。所有这些问题的共同起点是同一个 C++ 对象: `frame`——一个表示"栈上某个方法激活"的轻量视图。这一篇拆它: 一个 frame 对象装了什么、怎么判断自己是哪种帧、怎么找到上一帧、GC 怎么靠它精确扫描 oop。

## 1. 一张门票五个字段: 共享 3 个,x86 加 2 个

### 声明

frame 的共享字段在 frame.hpp:50-65(截取核心,逐字):

```cpp
// frame.hpp:50-65(截取核心,逐字)
class frame {
 private:
  // Instance variables:
  intptr_t* _sp; // stack pointer (from Thread::last_Java_sp)
  address   _pc; // program counter (the next instruction after the call)

  CodeBlob* _cb; // CodeBlob that "owns" pc
  enum deopt_state {
    not_deoptimized,
    is_deoptimized,
    unknown
  };

  deopt_state _deopt_state;

 public:
```

_sp 是栈指针、_pc 是下一条要执行的指令地址、_cb 是"拥有"这个 pc 的 CodeBlob——nmethod 或解释器代码或桩。_deopt_state 记这个帧是否被标记反优化(not_deoptimized/is_deoptimized/unknown 三态,unknown 是"还没查过"的惰性状态)。**没有方法名、没有行号、没有局部变量**——这些都能从 _pc → _cb → nmethod 反向拿到,帧对象只存"怎么找到它们"的钥匙。

x86 还多了两个平台字段(frame_x86.hpp:110-120,截取核心,逐字):

```cpp
// frame_x86.hpp:110-120(截取核心,逐字)
  // an additional field beyond _sp and _pc:
  intptr_t*   _fp; // frame pointer
  // The interpreter and adapters will extend the frame of the caller.
  // Since oopMaps are based on the sp of the caller before extension
  // we need to know that value. However in order to compute the address
  // of the return address we need the real "raw" sp. Since sparc already
  // uses sp() to mean "raw" sp and unextended_sp() to mean the caller's
  // original sp we use that convention.

  intptr_t*     _unextended_sp;
  void adjust_unextended_sp() NOT_DEBUG_RETURN;
```

**关键设计 (斜体)**: *_unextended_sp 的存在理由全在这段注释里: 解释器/适配器会"扩展"caller 的帧(参数区在 caller 的 sp 之上),而 oopMap 是按扩展前的 sp 记录的——所以一个帧要同时记住"原始 sp"(unextended_sp,对 oopMap)和"真实 sp"(sp,算返回地址)。这是 GC 精确性的地基,少一个字段就多一分误判。*

### 构造: pc 一进来就定类型

所有构造最终走 init(frame_x86.inline.hpp:44-60): 填字段 → `CodeCache::find_blob(pc)` 反查 _cb → 检查 `CompiledMethod::get_deopt_original_pc`——如果 pc 在反优化桩里,把 _pc 换回原始 pc 并标记 is_deoptimized。deopt_state 不是猜的: 构造时就从代码结构里读出来。

## 2. 我是哪种帧: pc → blob 反查

### 类型测试器: 都是围绕 _cb/_pc 的判定

is_interpreted_frame(frame_x86.cpp:292)= `Interpreter::contains(pc())`——解释器代码是启动时生成的 271 个 codelet 组成的 blob(templateInterpreter.hpp:141,`_code->contains(pc)`);is_compiled_frame(frame.cpp:180-189)= `_cb->is_compiled() && ((CompiledMethod*)_cb)->is_java_method()`;is_native_frame(frame.cpp:165-171)= `_cb` 是 nmethod 且 is_native_method(JNI 方法也是编译产物!);is_runtime_frame/is_safepoint_blob_frame = _cb 是 runtime stub/safepoint stub。**解释器判定不依赖 _cb 而是直接问解释器代码 blob**——因为解释器帧的 pc 落在解释器 blob 里,_cb 也能反查到它,但 Interpreter::contains 是更直接的范围检查。

### find_blob: 不是二分,是段映射

`_cb = CodeCache::find_blob(pc)`(codeCache.cpp:631)→ 按地址找到所属 CodeHeap → CodeHeap::find_blob_unsafe(heap.cpp:493)→ find_start → find_block_for(heap.cpp:456-483): 地址→段号(每 128 字节一段)→ 读段标记(记录"距本块起始的段数")→ 链式回跳一次到位。**CodeHeap 按地址排序但没有二分查找**——段映射用空间换时间,一次内存访问定位块首,这正是 16-01 篇 CodeHeap 布局的用武之地。

## 3. sender: 帧链怎么走

### 分派

frame::sender(frame_x86.cpp:488-503,截取核心,逐字):

```cpp
// frame_x86.cpp:488-503(截取核心,逐字)
frame frame::sender(RegisterMap* map) const {
  // Default is we done have to follow them. The sender_for_xxx will
  // update it accordingly
  map->set_include_argument_oops(false);

  if (is_entry_frame())       return sender_for_entry_frame(map);
  if (is_interpreted_frame()) return sender_for_interpreter_frame(map);
  assert(_cb == CodeCache::find_blob(pc()),"Must be the same");

  if (_cb != NULL) {
    return sender_for_compiled_frame(map);
  }
  // Must be native-compiled frame, i.e. the marshaling code for native
  // methods that exists in the core system.
  return frame(sender_sp(), link(), sender_pc());
}
```

分派只有三路: entry(Java 调用 C 的桥)、解释器、编译帧;最后的兜底是纯 C 帧。**没有专门的"native 帧"分支**——JNI 方法的帧也是 nmethod,走 compiled 分支;注释里那个 fall-through 是原生 marshaling 代码。

### 编译帧: 帧大小是元数据,不是现场推断

sender_for_compiled_frame(frame_x86.cpp:451-483,截取核心,逐字):

```cpp
// frame_x86.cpp:451-483(截取核心,逐字)
frame frame::sender_for_compiled_frame(RegisterMap* map) const {
  assert(map != NULL, "map must be set");

  // frame owned by optimizing compiler
  assert(_cb->frame_size() >= 0, "must have non-zero frame size");
  intptr_t* sender_sp = unextended_sp() + _cb->frame_size();
  intptr_t* unextended_sp = sender_sp;

  // On Intel the return_address is always the word on the stack
  address sender_pc = (address) *(sender_sp-1);

  // This is the saved value of EBP which may or may not really be an FP.
  // It is only an FP if the sender is an interpreter frame (or C1?).
  intptr_t** saved_fp_addr = (intptr_t**) (sender_sp - frame::sender_sp_offset);

  if (map->update_map()) {
    // Tell GC to use argument oopmaps for some runtime stubs that need it.
    // For C1, the runtime stub might not have oop maps, so set this flag
    // outside of update_register_map.
    map->set_include_argument_oops(_cb->caller_must_gc_arguments(map->thread()));
    if (_cb->oop_maps() != NULL) {
      OopMapSet::update_register_map(this, map);
    }

    // Since the prolog does the save and restore of EBP there is no oopmap
    // for it so we must fill in its location as if there was an oopmap entry
    // since if our caller was compiled code there could be live jvm state in it.
    update_map_with_saved_link(map, saved_fp_addr);
  }

  assert(sender_sp != sp(), "must have changed");
  return frame(sender_sp, unextended_sp, *saved_fp_addr, sender_pc);
}
```

**关键设计 (斜体)**: *编译帧的上一帧不是靠 rbp 链现场找的——帧大小 `_cb->frame_size()` 是编译期算好、随 nmethod 存的元数据,一跳到位;返回地址固定在 sender_sp 上方一格。这在 23-01 讲桩时见过: 桩用 enter/leave 只是为了栈回溯,真正定帧大小的从来是元数据。*

### 解释器帧: 帧内保存了 caller 的 sp

sender_for_interpreter_frame(frame_x86.cpp:431-446,截取核心,逐字):

```cpp
// frame_x86.cpp:431-446(截取核心,逐字)
frame frame::sender_for_interpreter_frame(RegisterMap* map) const {
  // SP is the raw SP from the sender after adapter or interpreter
  // extension.
  intptr_t* sender_sp = this->sender_sp();

  // This is the sp before any possible extension (adapter/locals).
  intptr_t* unextended_sp = interpreter_frame_sender_sp();

#if COMPILER2_OR_JVMCI
  if (map->update_map()) {
    update_map_with_saved_link(map, (intptr_t**) addr_at(link_offset));
  }
#endif // COMPILER2_OR_JVMCI

  return frame(sender_sp, unextended_sp, link(), sender_pc());
}
```

解释器帧在进入方法时就把 caller 的 sp 存进帧内(interpreter_frame_sender_sp,fp[-1],偏移定义在 frame_x86.hpp:69),caller 的 pc 取 `fp+1`（`return_addr_offset=1`）。**解释器帧的"帧内布局"是约定死的偏移表**——frame_x86.hpp:60-73 的枚举一口气定义了 link=0/return=1/sender_sp=2,解释器侧 sender_sp=-1/method=-2/mdp=-3/cache=-4/locals=-5/bcp=-6/initial_sp=-7……负偏移在 fp 下方(表达式栈方向),正偏移在 fp 上方(参数/返回地址方向)。

### 栈顶入口: JavaFrameAnchor

整条链的起点是线程的 JavaFrameAnchor(thread.hpp:984)——线程从 Java 转 C/VM 时把当时的 sp/pc/fp 记进 `_anchor`。Thread::last_frame(thread.hpp:1879-1883)= `_anchor.make_walkable(this)` + pd_last_frame(thread_linux_x86.cpp:30-32):

```cpp
// thread_linux_x86.cpp:30-34(截取核心,逐字)
frame JavaThread::pd_last_frame() {
  assert(has_last_Java_frame(), "must have last_Java_sp() when suspended");
  vmassert(_anchor.last_Java_pc() != NULL, "not walkable");
  return frame(_anchor.last_Java_sp(), _anchor.last_Java_fp(), _anchor.last_Java_pc());
}
```

之后就是一个无限循环: `f = f.sender(&map)` 直到 is_first_frame。栈遍历(GC/JVMTI/JFR/jstack)全是这一条链的消费者。

## 4. oops_do: GC 怎么知道哪个 slot 是 oop

### 分派

frame::oops_do_internal(frame.cpp:1115-1130): 解释器帧 → oops_interpreted_do;entry 帧 → oops_entry_do;其余(CodeCache 里)→ oops_code_blob_do。

### 编译帧: 编译时生成的精确 OopMap

oops_code_blob_do(frame.cpp:976-990)调 `OopMapSet::oops_do`(compiler/oopMap.cpp:288)。关键在 all_do(:298-303,截取核心,逐字):

```cpp
// compiler/oopMap.cpp:298-303(截取核心,逐字)
  const ImmutableOopMapSet* maps = cb->oop_maps();
  const ImmutableOopMap* map = cb->oop_map_for_return_address(fr->pc());
  assert(map != NULL, "no ptr map found");
```

OopMap 是**编译时**生成的: C2/C1 在每个 safepoint 位置记录"这个 slot 是 oop、这个寄存器是 callee-saved 的 oop……",存进 nmethod 的 oop_maps。GC 拿着当前 pc 查表,就知道栈上哪些位置是引用。OopMapValue 的类型枚举(oopMap.hpp:69-73): oop_value/narrowoop_value(压缩指针)/callee_saved_value(寄存器里的 oop 被压栈的位置)/derived_oop_value(派生指针,数组元素地址 = 基址+偏移)。遍历顺序有讲究: **derived 先处理**(oopMap.cpp:307-340)——基址先被移动之前,派生指针的偏移必须先记下来,否则基址一挪偏移就废了。

**关键设计 (斜体)**: *为什么不能"遍历所有 slot 猜哪个是 oop"?猜错了会把整数当引用传给 GC,标记算法直接崩。所以是精确式(exact scanning): 编译器在 safepoint 静态标注,GC 按表读取。这是 C2 输出的副产品——每个 safepoint 一个 OopMap,nmethod 里还有对应的 pc 区间,pc→map 的查找就靠 oop_map_for_return_address。*

### 解释器帧: 没有编译期标注,现场算 mask

解释器帧没有 OopMap——字节码是活的,解释器逐条执行,locals 的 oop 状态随 bci 变化。oops_interpreted_do(frame.cpp:890-958)的处理顺序: 帧内 monitor 块(BasicObjectLock,19-sync 的产物)→ native 方法的临时 oop 槽 → 方法 mirror(GC 根)→ 调用点的参数(在 invoke 字节码且 include_argument_oops 时)→ 最后 locals+表达式栈用 **InterpreterOopMap** 掩码:

```cpp
// frame.cpp:958-967(截取核心,逐字)
  InterpreterFrameClosure blk(this, max_locals, m->max_stack(), f);

  // process locals & expression stack
  InterpreterOopMap mask;
  if (query_oop_map_cache) {
    m->mask_for(bci, &mask);
  } else {
    OopMapCache::compute_one_oop_map(m, bci, &mask);
  }
  mask.iterate_oop(&blk);
```

mask 按 (method, bci) 现场计算: 从方法签名和字节码流推导"bci 处哪些 locals/栈槽是 oop"(Method::mask_for,method.cpp:237;计算器 OopMapCache::compute_one_oop_map,oopMapCache.cpp:597)。缓存挂在 **Klass 上**(InstanceKlass::_oop_map_cache,instanceKlass.hpp:247,per-class 一张,懒分配)——不是全局的"Interpreter::oop_map_cache"。

### 实证: 一张线程转储里能看到的全部

[实证:] materials/commands/24-frame-demo.txt——一个跑完 40 万次热循环后 sleep 的进程:

- `jcmd Thread.print` 的 main 线程两行 at: `java.lang.Thread.sleep(Native Method)` + `FrameDemo.main`(第 13 行的 sleep)——jstack 每行一个 Java 帧,由 frame 链 + vframe 层(下一篇)合成;
- `Compiler.codelist` 里 `FrameDemo.hot(I)I` 有两个 nmethod 地址区间(level 4 C2 与 level 3 C1 并存,分层编译双版本),`main` 三个——这些 nmethod 就是编译帧 _cb 的实体;
- `Compiler.codecache`: 三段 CodeHeap 共 **1098 个 blob(653 nmethod + 359 adapter)**,nmethod 们住在前两段,non-nmethods 段住解释器 blob、桩与适配器;
- `-XX:+PrintInterpreter`: 解释器代码 = **271 个 codelet、平均 358 字节**——解释器帧的 pc 就落在这块 blob 里(Interpreter::contains 判中的目标)。

## 核心悬念

物理帧拆完: 五字段门票(_sp/_pc/_cb/_fp/_unextended_sp + deopt 三态),pc→blob 反查定类型(段映射,非二分),sender 三路分派(编译帧靠 frame_size 元数据一跳到位、解释器帧靠帧内保存的 caller sp、栈顶靠 JavaFrameAnchor),GC 扫描精确化(编译帧查编译期 OopMap、解释器帧现场算 InterpreterOopMap 掩码)。但有个问题没解决: C2 把三层方法内联进一个 nmethod,物理帧只有一个——GC 扫描、反优化、性能分析看到的却应该是三个源级方法。物理帧和源级方法之间怎么映射?下一篇: Virtual Frame。

> → [24-frame/02 — Virtual Frame](02-virtual-frame.md)
