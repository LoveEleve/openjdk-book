# 03. deopt 怎么从编译帧重建解释器帧？— Deopt 重建 + GC 扫描

> **前置依赖**:[24-frame/02 — Virtual Frame](02-virtual-frame.md):vframe/compiledVFrame 的 locals/expressions/monitors 是重建的原料;[24-frame/01 — Physical Frame](01-physical-frame.md):解释器帧的偏移表(unpack 的目标格式);[17-threads/02 — JavaThread 状态](openjdk/vol-02/17-threads/02-javathread-state.md):deopt 在 Java→VM 转换点发生
> → **后续**:25-gc(GC Framework——RegisterMap+OopMap 在这里被消费)
> 关联域: 16-code-cache(made not entrant)、19-sync(BasicLock 迁移)、22-deopt

## 编译版本说失效就失效,栈上的帧怎么办

C2 的优化建立在"所见即所得"的假设上: 调用点是单态的、类型是精确的、值不会被改。假设一旦被打破(新类型出现、类被重新定义),编译代码必须作废——但**栈上还挂着按旧假设执行的帧**。实证(24-deopt-demo.txt,OpenJDK 11): `DeoptDemo::total` 268ms 编译完成(C1+C2),270ms 传进 Circle 触发类型检查失败,紧接着两个编译版本 `made not entrant`,再按新画像重新编译。中间那一下"活帧怎么回解释器"就是这一篇的主题: vframeArray 把编译帧的源级状态全量搬走、StackValue 按类型安全取值、MonitorChunk 把监视器挪到 C 堆,最后在栈上重建一串解释器帧。

## 1. vframeArray: 把编译帧"打包"到 C 堆

### 结构: 元素数组 + 原始帧快照

vframeArray 是 CHeapObj(vframeArray.hpp:121,注释 "this can be a ResourceObj if we don't save the last one... but it does make debugging easier"),关键字段(vframeArray.hpp:142-156,截取核心,逐字):

```cpp
// vframeArray.hpp:142-156(截取核心,逐字)
  JavaThread*                  _owner_thread;
  vframeArray*                 _next;
  frame                        _original;          // the original frame of the deoptee
  frame                        _caller;            // caller of root frame in vframeArray
  frame                        _sender;

  Deoptimization::UnrollBlock* _unroll_block;
  int                          _frame_size;

  int                          _frames; // number of javavframes in the array (does not count any adapter)

  intptr_t                     _callee_registers[RegisterMap::reg_count];
  unsigned char                _valid[RegisterMap::reg_count];

  vframeArrayElement           _elements[1];   // First variable section.
```

**关键设计 (斜体)**: *_original 是"栈上那个要被拆的编译帧"的快照,后面重建解释器帧时以它为栈基准;`_elements[1]` 是柔性数组的惯用法——每个元素对应一个内联层(一层一个解释器帧),数组跟在固定头部之后分配。为什么非放 C 堆不可?create_vframeArray 的注释说得很直白(deoptimization.cpp:1209-1211): "Since the Java thread being deoptimized will eventually adjust it's own stack, the vframeArray containing the unpacking information is allocated in the C heap."——**deopt 流程马上要调整线程自己的栈**,打包的数据不能依赖栈内存存活。*

### 元素: 一个内联层 → 一个解释器帧

每个 vframeArrayElement(vframeArray.hpp:50-63)装一个虚拟帧的全部源级状态: _frame(unpack 目标解释器帧)、_bci/_reexecute(决定执行入口)、_method、_monitors、_locals、_expressions。

### fill_in: 三步搬移

fill_in(vframeArray.cpp:60-109,截取核心,逐字):

```cpp
// vframeArray.cpp:60-109(截取核心,逐字)
void vframeArrayElement::fill_in(compiledVFrame* vf, bool realloc_failures) {

// Copy the information from the compiled vframe to the
// interpreter frame we will be creating to replace vf

  _method = vf->method();
  _bci    = vf->raw_bci();
  _reexecute = vf->should_reexecute();
#ifdef ASSERT
  _removed_monitors = false;
#endif

  int index;

  {
    ResourceMark rm;
    HandleMark hm;
    // Get the monitors off-stack

    GrowableArray<MonitorInfo*>* list = vf->monitors();
    if (list->is_empty()) {
      _monitors = NULL;
    } else {

      // Allocate monitor chunk
      _monitors = new MonitorChunk(list->length());
      vf->thread()->add_monitor_chunk(_monitors);

      // Migrate the BasicLocks from the stack to the monitor chunk
      for (index = 0; index < list->length(); index++) {
        MonitorInfo* monitor = list->at(index);
        assert(!monitor->owner_is_scalar_replaced() || realloc_failures, "object should be reallocated already");
        BasicObjectLock* dest = _monitors->at(index);
        if (monitor->owner_is_scalar_replaced()) {
          dest->set_obj(NULL);
        } else {
          assert(monitor->owner() == NULL || (!monitor->owner()->is_unlocked() && !monitor->owner()->has_bias_pattern()), "object must be null or locked, and unbiased");
          dest->set_obj(monitor->owner());
          monitor->lock()->move_to(monitor->owner(), dest->lock());
        }
      }
    }
  }

  // Convert the vframe locals and expressions to off stack
  // values. Because we will not gc all oops can be converted to
  // intptr_t (i.e. a stack slot) and we are fine. This is
  // good since we are inside a HandleMark and the oops in our
  // collection would go away between packing them here and
  // unpacking them in unpack_on_stack.
```

三步: ①method/bci/reexecute 抄过来;②监视器——从 vf 的 MonitorInfo 列表逐个把 BasicLock 搬进 MonitorChunk(owner 引用 + 锁状态 move_to,注意"object must be null or locked, and unbiased"断言——编译优化过的锁要么是 null 要么持锁);③locals/expressions——**先把 oop 转成 intptr_t 存**(注释点破原因: HandleMark 作用域里 oop 会失效,打包阶段绝不能留 Handle——值转裸槽,unpack 时再包回 Handle)。

## 2. StackValue: 带类型的栈槽

### 不是 union,是两个字段

大纲以为 StackValue 用 union 共享 int/Handle——**不是**。定义在 stackValue.hpp:31-53(截取核心,逐字):

```cpp
// stackValue.hpp:31-53(截取核心,逐字)
class StackValue : public ResourceObj {
 private:
  BasicType _type;
  intptr_t  _integer_value; // Blank java stack slot value
  Handle    _handle_value;  // Java stack slot value interpreted as a Handle
 public:

  StackValue(intptr_t value) {
    _type              = T_INT;
    _integer_value     = value;
  }

  StackValue(Handle value, intptr_t scalar_replaced = 0) {
    _type                = T_OBJECT;
    _integer_value       = scalar_replaced;
    _handle_value        = value;
    assert(_integer_value == 0 ||  _handle_value.is_null(), "not null object should not be marked as scalar replaced");
  }

  StackValue() {
    _type           = T_CONFLICT;
    _integer_value  = 0;
  }
```

**关键设计 (斜体)**: *类型与值分开存,Handle 与 intptr_t 各占一个字段(语义上互斥但不是 union——scalar replaced 的 oop 需要同时记 Handle 和标记,union 装不下)。`StackValue()` 无参构造造出 **T_CONFLICT**——fill_in 里对应的注释是 "A dead local. Will be initialized to null/zero."(vframeArray.cpp:130): 编译器标注的**死槽**(变量生命周期已结束),unpack 时初始化为零/空。大纲说"保守扫描不回收"是传歪了——冲突槽既不参与 GC 保守扫描也不参与值恢复,它就是"这个槽作废"。*

### create_stack_value: Location 编码 → 真实值

类型分派在 StackValue::create_stack_value(stackValue.cpp:37): 先看 ScopeValue 是 LocationValue(栈/寄存器位置)还是 ConstantOopReadValue(常量)还是 ObjectValue(scalar replaced)。Location 的取址逻辑(stackValue.cpp:48-55,截取核心,逐字):

```cpp
// stackValue.cpp:48-55(截取核心,逐字)
    // First find address of value

    address value_addr = loc.is_register()
      // Value was in a callee-save register
      ? reg_map->location(VMRegImpl::as_VMReg(loc.register_number()))
      // Else value was directly saved on the stack. The frame's original stack pointer,
      // before any extension by its callee (due to Compiler1 linkage on SPARC), must be used.
      : ((address)fr->unextended_sp()) + loc.stack_offset();
```

**寄存器里的值 → `reg_map->location()` 找它被压栈的位置;栈上的值 → `unextended_sp + stack_offset`**——又是 01 篇那个"unextended_sp 对 oopMap"约定的用武之地。拿到地址后按 Location 类型取宽窄(int_in_long/float_in_dbl 做窄化,narrowoop 解码成 oop,stackValue.cpp:60-110)。

StackValueCollection(stackValueCollection.hpp:30-50)就是它的容器: ResourceObj + GrowableArray<StackValue*>,带 int_at/obj_at 等类型化访问器——unpack 时按槽位类型取。

## 3. MonitorChunk: 监视器的 C 堆中转站

### 不是柔性数组,是 C 堆数组

MonitorChunk(monitorChunk.hpp:31-56): CHeapObj<mtSynchronizer>,字段 _number_of_monitors + **BasicObjectLock\* _monitors**(指针)+ _next。构造(monitorChunk.cpp:30-34,截取核心,逐字):

```cpp
// monitorChunk.cpp:30-34(截取核心,逐字)
MonitorChunk::MonitorChunk(int number_on_monitors) {
  _number_of_monitors = number_on_monitors;
  _monitors           = NEW_C_HEAP_ARRAY(BasicObjectLock, number_on_monitors, mtSynchronizer);
  _next               = NULL;
}
```

大纲说的 `_monitors[0]` 柔性数组不存在——实际是 NEW_C_HEAP_ARRAY 按需分配。**为什么监视器也要离栈**: 重建解释器帧时栈会被整体重排,BasicLock(19-sync 的轻量锁)若还挂在旧位置就悬空了;先整体搬到 C 堆,unpack 时再逐个放回新帧的 monitor 块。

### 链表挂在线程上

fill_in 里 `vf->thread()->add_monitor_chunk(_monitors)`——每个 MonitorChunk 串进 JavaThread::_monitor_chunks(thread.hpp:1023,02 篇的 19 域见过)。重建完成后 unpack 路径统一释放;**GC 也要认识它**: MonitorChunk::oops_do(monitorChunk.cpp:42-46)遍历每个 BasicObjectLock 的 oop——C 堆上的这些监视器持有对象引用,GC 扫描线程时必须覆盖(这就是"GC 扫描"标题的另一半)。

## 4. 重建: unpack_on_stack 与 deopt 全流程

### 触发链

编译代码在类型检查失败处跳进 uncommon trap blob → `Deoptimization::fetch_unroll_info`(deoptimization.cpp:139,JRT_BLOCK_ENTRY)→ fetch_unroll_info_helper(:158): 沿虚拟帧收集 chunk(compiledVFrame 列表)、处理 realloc 失败、`create_vframeArray`(:310,:1169 从 chunk 构造 vframeArray,`thread->set_vframe_array_head(array)` :315)→ 返回 UnrollBlock → 汇编层 unpack → `Deoptimization::unpack_frames`(:623,JRT_LEAF)逐个元素 `unpack_on_stack`。

### unpack_on_stack: 决定解释器从哪继续

unpack_on_stack(vframeArray.cpp:171-202,截取核心,逐字):

```cpp
// vframeArray.cpp:171-202(截取核心,逐字)
void vframeArrayElement::unpack_on_stack(int caller_actual_parameters,
                                         int callee_parameters,
                                         int callee_locals,
                                         frame* caller,
                                         bool is_top_frame,
                                         bool is_bottom_frame,
                                         int exec_mode) {
  JavaThread* thread = (JavaThread*) Thread::current();

  bool realloc_failure_exception = thread->frames_to_pop_failed_realloc() > 0;

  // Look at bci and decide on bcp and continuation pc
  address bcp;
  // C++ interpreter doesn't need a pc since it will figure out what to do when it
  // begins execution
  address pc;
  bool use_next_mdp = false; // true if we should use the mdp associated with the next bci
                             // rather than the one associated with bcp
  if (raw_bci() == SynchronizationEntryBCI) {
    // We are deoptimizing while hanging in prologue code for synchronized method
    bcp = method()->bcp_from(0); // first byte code
    pc  = Interpreter::deopt_entry(vtos, 0); // step = 0 since we don't skip current bytecode
  } else if (should_reexecute()) { //reexecute this bytecode
    assert(is_top_frame, "reexecute allowed only for the top frame");
    bcp = method()->bcp_from(bci());
    pc  = Interpreter::deopt_reexecute_entry(method(), bcp);
  } else {
    bcp = method()->bcp_from(bci());
    pc  = Interpreter::deopt_continue_after_entry(method(), bcp, callee_parameters, is_top_frame);
    use_next_mdp = true;
  }
  assert(Bytecodes::is_defined(*bcp), "must be a valid bytecode");
```

重建的每个解释器帧需要决定"从哪个字节码继续": 三选一——**重执行**(should_reexecute,当前字节码还没生效,比如分配失败前)、**继续**(normal case,从 bci 之后的指令继续)、**同步入口**(SynchronizationEntryBCI,挂在 synchronized 方法 prologue)。对应解释器的三个 deopt 入口模板。之后按 on_stack_size 算好帧大小、按 StackValueCollection 逐个写槽、把 MonitorChunk 的 BasicLock 放回新帧的 monitor 块、把 callee 参数接上——一串解释器帧在旧编译帧的位置上"长"出来。

### 实证: 生命周期看得见的部分

[实证:] 24-deopt-demo.txt——PrintCompilation 记录了完整过程: `total` 268ms 出 C1(level 3)+C2(level 4);270ms 传入 Circle 触发类型检查失败 → C1 版 `made not entrant`;271ms 出 OSR 版(`%` = 栈上替换,替换当前循环帧);273ms C2 版也 `made not entrant`;随即按新画像重新编译。**made not entrant 之后,栈上仍挂在旧版本的帧怎么处理**: uncommon trap 只拆当前帧;其它帧(同线程更深层或别的线程)由依赖失效通知驱动——Deoptimization::deoptimize_dependents(deoptimization.cpp:800-803)→ Threads::deoptimized_wrt_marked_nmethods(thread.cpp:4625)→ 逐线程遍历所有帧,`should_be_deoptimized()` 的帧当场 deopt(thread.cpp:2847-2858)——**不是"走到栈顶才拆",是下一次 safepoint 检查时全量拆**。JFR 的 jdk.Deoptimization 事件在 JDK 11 的 metadata.xml 里不存在,PrintCompilation 是能抓到的最近观测。

## 5. GC 侧: RegisterMap 与 OopMap 的配合

### RegisterMap: 寄存器位置的账本

GC 扫描编译帧时,oop 可能在寄存器里(callee-saved)——OopMap 说"VMReg 5 是 oop",但它的**值**在哪?RegisterMap(registerMap.hpp:52-66)记的就是这个: 每个 VMReg → 保存位置。核心(registerMap.hpp:90-109,截取核心,逐字):

```cpp
// registerMap.hpp:90-109(截取核心,逐字)
  address location(VMReg reg) const {
    int index = reg->value() / location_valid_type_size;
    assert(0 <= reg->value() && reg->value() < reg_count, "range check");
    assert(0 <= index && index < location_valid_size, "range check");
    if (_location_valid[index] & ((LocationValidType)1 << (reg->value() % location_valid_type_size))) {
      return (address) _location[reg->value()];
    } else {
      return pd_location(reg);
    }
  }

  void set_location(VMReg reg, address loc) {
    int index = reg->value() / location_valid_type_size;
    assert(0 <= reg->value() && reg->value() < reg_count, "range check");
    assert(0 <= index && index < location_valid_size, "range check");
    assert(_update_map, "updating map that does not need updating");
    _location[reg->value()] = (intptr_t*) loc;
    _location_valid[index] |= ((LocationValidType)1 << (reg->value() % location_valid_type_size));
    check_location_valid();
  }
```

`_location[reg_count]` 是寄存器→地址映射,**`_location_valid` 位图**标记哪些寄存器已有记录(没记录的走 pd_location 平台默认);`_update_map` 控制遍历时是否更新(只读遍历可关掉)。它跟随 frame::sender 链一路传递——**caller 帧的 sender 处理时把被保存的寄存器位置登记进去**(01 篇 sender_for_compiled_frame 里 `OopMapSet::update_register_map(this, map)` + `update_map_with_saved_link`),所以 oopMapreg_to_location 能一路定位到最内层保存点。

**关键设计 (斜体)**: *OopMap 说"哪个 VMReg 是 oop",RegisterMap 说"这个 VMReg 的值在栈上哪里"——两张表拼起来,GC 才能从"寄存器的 oop"安全取到堆引用。这就是 01 篇 oops_do 里 `fr->oopmapreg_to_location(omv.reg(), reg_map)` 的另一半。RegisterMap 同时是 deopt 与 GC 的公共设施(create_stack_value 也用它找寄存器位置),只是用途不同: deopt 取的是"值",GC 取的是"引用"。*

## 核心悬念

deopt 三件套拆完: vframeArray 把编译帧按内联层打包到 C 堆(元素=一层的 method/bci/locals/expressions/monitors,fill_in 三步搬移);StackValue 用类型+双字段取代 union 承载带类型槽值(Location 取址: 寄存器→RegisterMap,栈→unextended_sp+offset);MonitorChunk 把 BasicLock 挪到 C 堆(挂线程链,GC 经 oops_do 认识它);unpack_on_stack 按 bci 三态决定解释器入口,重建一串解释器帧;RegisterMap 与 OopMap 拼出 GC 的精确栈扫描。帧的故事到此闭环——下一站换到 GC 本身: 这些 RegisterMap/OopMap 的消费者、线程栈扫描的执行者,是 GC Framework。

> → 25-gc(GC Framework——JVM 的垃圾回收基础架构)
