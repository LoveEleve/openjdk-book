# 02. nmethod 结构 — 一段编译方法里装了什么

> **前置依赖**:[01 — CodeBlob 与 CodeHeap](01-codeblob-heap.md):nmethod 是 CompiledMethod 的具体形态,住在 CodeHeap 的段里;CodeBuffer 的三段在这里变成最终的连续布局
> → **后续**:[03 — nmethod 生命周期](03-nmethod-lifecycle.md)
> 关联域: 13-jit(编译产物落地)、15-c2(调用点与入口生成)、22-deopt(依赖 scopes/pcs 重建栈帧)、06-oops(常量池解析出来的 Method 落到这里)

## 编译产物不是裸机器码

C2 花几百毫秒编译一个方法,产物是几 KB 机器码。但如果它只是机器码,GC 就不知道哪些字节里嵌着对象指针(要跟着堆的移动更新),deopt 也不知道"这个 PC 在执行哪个 Java 方法的哪一行",调用方更不知道该从哪个地址进。所以 nmethod 是一整块**自描述的代码**:机器码 + 让 GC、deopt、JVMTI、IC 都能读懂它的元数据,全部装在同一块连续内存里。这篇拆它的骨架: 三扇门(入口)、八段身(布局)、状态机与并发协议。

## 1. 三扇门: 入口与 inline cache

### 为什么要三个入口

调一个编译方法,如果调用方已经验证过接收者类型,就不该再验一遍;如果方法正在执行中(OSR),还要能从中间进入。三个入口对应三种进入方式(nmethod.hpp:90-93,逐字):

```cpp
// nmethod.hpp:90-93(逐字)
  // offsets for entry points
  address _entry_point;                      // entry point with class check
  address _verified_entry_point;             // entry point without class check
  address _osr_entry_point;                  // entry point for on stack replacement
```

- `_entry_point` — **带类型检查的入口**。方法代码开头有一段 IC 检查序列: 接收者实际 Klass 与期望 Klass 不符就跳走。调用方还没有把握时走这里;
- `_verified_entry_point` — **免检入口**。已验证过类型的调用方直连这里,跳过检查直接进入代码;
- `_osr_entry_point` — **OSR 入口**,从解释器栈上"热替换"进编译代码的中间位置。OSR 的判据是 `_entry_bci != InvocationEntryBci`(nmethod.hpp:63,is_osr_method :270)——普通编译是"从第 0 条字节码进",OSR 是"从第 N 条字节码进"。

静态方法没有接收者要验,两个入口重合: `entry_point() == _verified_entry_point()`(nmethod.cpp:775-776 的 assert)。

### 未验证入口的 x86 真身

C2 对非静态方法在代码最前面插入一个 MachUEPNode(Unverified Entry Point,output.cpp:89-91),x86-64 的编码(x86_64.ad:1685-1692,逐字):

```cpp
// x86_64.ad:1685-1692(截取核心,逐字)
  if (UseCompressedClassPointers) {
    masm.load_klass(rscratch1, j_rarg0);
    masm.cmpptr(rax, rscratch1);
  } else {
    masm.cmpptr(rax, Address(j_rarg0, oopDesc::klass_offset_in_bytes()));
  }

  masm.jump_cc(Assembler::notEqual, RuntimeAddress(SharedRuntime::get_ic_miss_stub()));
```

- `j_rarg0` 是第一个参数寄存器(x86-64 是 rdi),即**接收者 this**;`[rdi + 8]` 是接收者的 Klass 指针;
- **期望的 Klass 在 rax 里**——不是入口代码自己嵌入的常量,而是调用方的动态调用点传给它的;
- 比较不等 → 跳 `get_ic_miss_stub`(sharedRuntime.hpp:218-220): IC miss,重新解析并更新调用方的缓存;相等 → 落入后面的 nop 区,进入正式代码。

入口的偏移关系: `_entry_point = code_begin() + CodeOffsets::Entry`(Entry 恒为 0),`_verified_entry_point = code_begin() + CodeOffsets::Verified_Entry`——即"未验证入口代码的长度"(compile.cpp:932-937,compile.hpp:608 注释原文 "Size of unvalidated entry point code")。UEP 尾部的 nop 是把 verified entry 对齐到 4 字节,让后面的补丁(§3)可以原子写(x86_64.ad:1696-1697 注释原文 "these NOPs are critical so that verified entry point is properly 4 bytes aligned for patching")。

### 动态调用点: 期望 Klass 从哪来

调用方的虚调用点是这样一条指令对(x86_64.ad:12834-12841,截取核心):

```cpp
// x86_64.ad:12834-12841(截取核心,省略 ins_cost 行)
instruct CallDynamicJavaDirect(method meth)
%{
  match(CallDynamicJava);
  effect(USE meth);
  ...
  format %{ "movq    rax, #Universe::non_oop_word()\n\t"
            "call,dynamic " %}
```

`movq rax, imm64`(10 字节)+ `call`(5 字节),共 15 字节——这正是 `MachCallDynamicJavaNode::ret_addr_offset()` 报告的 15(x86_64.ad:574-578): "15 bytes from start of call to where return address points"。**IC 的单态缓存值(Klass*)就写在这个 mov 的 64 位立即数里**: `CompiledIC` 构造时通过 virtual_call relocation 找到这条 load 指令(`_value = _call->get_load_instruction(r)`,compiledIC.cpp:171-179),`set_data`/`get_data` 读写的就是它。所以补丁 IC 其实只改两处: 调用的**目的地**(call 的操作数)和 mov 里的**缓存值**——指令形状从编译期就固定了,不用重排代码。

### IC 状态与入口的关系

一个调用点的 inline cache 有四种状态(compiledIC.hpp:39-48 的注释图,逐字):

```cpp
// compiledIC.hpp:39-48(截取注释图,逐字)
//         [1] --<--  Clean -->---  [1]
//            /       (null)      \
//           /                     \      /-<-\
//          /          [2]          \    /     \
//      Interpreted  ---------> Monomorphic     | [3]
//  (CompiledICHolder*)            (Klass*)     |
//          \                        /   \     /
//       [4] \                      / [4] \->-/
//            \->-  Megamorphic -<-/
//              (CompiledICHolder*)
```

- **Clean**: 缓存为 null,目标指向解析桩——首次调用时解析出真实目标再补丁;
- **Monomorphic**: 缓存为单个 Klass*。目标指向被调方法的入口: **非优化虚调用指向 `_entry_point`(未验证入口,检查在被调方做)**;只有优化/静态绑定的调用才直连 `_verified_entry_point`(compiledIC.cpp:492-496,注释 :493 "entry = method_code->verified_entry_point()" / :495 "entry = method_code->entry_point()")。`set_to_monomorphic` 在 :373-455;
- **Megamorphic**: 目标换成 vtable/itable 分发桩(VtableStubs,compiledIC.cpp:218-268)——不止一个类时不再"猜一个入口",改走查表。这个状态下缓存值不可靠(注释原文 "Cannot rely on cached_value",compiledIC.cpp:275)——vtable 分支缓存 NULL,itable 分支缓存 CompiledICHolder;
- **Interpreted**: 目标方法还没编译,缓存为 CompiledICHolder(方法+Klass),走 c2i 入口落到解释器(compiledIC.cpp:508-516)。

**关键设计 (斜体)**: *检查放在被调方入口而不是调用点——调用方只负责"报上期望的 Klass",被调方自己验真。这让调用方的补丁极小(改两个操作数即可),也让"已验证的调用方"可以永久直连免检入口;而 IC miss 时被调方一跳就能进解析器,解析器反过来再补丁调用方,形成闭环。*

## 2. 八段身: 一块内存里的自描述结构

### 布局总览

类注释就是权威布局图(nmethod.hpp:36-53,逐字):

```cpp
// nmethod.hpp:36-53(逐字)
// An nmethod contains:
//  - header                 (the nmethod structure)
//  [Relocation]
//  - relocation information
//  - constant part          (doubles, longs and floats used in nmethod)
//  - oop table
//  [Code]
//  - code body
//  - exception handler
//  - stub code
//  [Debugging information]
//  - oop array
//  - data array
//  - pcs
//  [Exception handler table]
//  - handler entry point array
//  [Implicit Null Pointer exception table]
//  - implicit null table array
```

机器码(body+桩)之外,还有重定位信息、常量、oop 表、调试信息、异常表、隐式空指针表。所有段不是各自 malloc 的——**它们在同一块 CodeHeap 块里首尾相接**,定位靠 header 里的偏移字段(nmethod.hpp:95-109,12 个 `_xxx_offset`,逐字):

```cpp
// nmethod.hpp:100-109(截取核心,逐字)
  int _consts_offset;
  int _stub_offset;
  int _oops_offset;                       // offset to where embedded oop table begins (inside data)
  int _metadata_offset;                   // embedded meta data table
  int _scopes_data_offset;
  int _scopes_pcs_offset;
  int _dependencies_offset;
  int _handler_table_offset;
  int _nul_chk_table_offset;
  int _nmethod_end_offset;
```

### 偏移链: 段与段怎么接上

这些偏移在 nmethod 构造函数里逐段算出(nmethod.cpp:685-746,截取核心,逐字):

```cpp
// nmethod.cpp:685-746(截取核心,逐字)
    _consts_offset           = content_offset()      + code_buffer->total_offset_of(code_buffer->consts());
    _stub_offset             = content_offset()      + code_buffer->total_offset_of(code_buffer->stubs());
...
    _oops_offset             = data_offset();
    _metadata_offset         = _oops_offset          + align_up(code_buffer->total_oop_size(), oopSize);
    int scopes_data_offset   = _metadata_offset      + align_up(code_buffer->total_metadata_size(), wordSize);

    _scopes_pcs_offset       = scopes_data_offset    + align_up(debug_info->data_size       (), oopSize);
    _dependencies_offset     = _scopes_pcs_offset    + adjust_pcs_size(debug_info->pcs_size());
    _handler_table_offset    = _dependencies_offset  + align_up((int)dependencies->size_in_bytes (), oopSize);
    _nul_chk_table_offset    = _handler_table_offset + align_up(handler_table->size_in_bytes(), oopSize);
    _nmethod_end_offset      = _nul_chk_table_offset + align_up(nul_chk_table->size_in_bytes(), oopSize);
```

从第一个偏移出发,后一个永远是"前一个 + 上一段的实际大小(对齐后)",最终得出整块长度。实际内存顺序:

```
header → relocation → consts → 机器码(code) → stubs(含 exception/deopt handler) → oops 表 → metadata 表 → scopes 数据 → scopes pcs → dependencies → handler table → null check table
```

对照 01 篇的四区: header+relocation 是头部区,consts+code+stubs 是 content 区,从 oops 表到 null check 表是 data 区。注意两点与直觉不同的地方:

- **consts 在机器码之前**——常量段是 content 区的第一段(CodeBuffer 的 SECT_CONSTS 排最前,顺序即最终布局)。C2 加载 double 常量就是 `movsd xmm0, [$constantaddress]`(x86_64.ad:6076-6085 "load from constant table"),x86-64 下是 rip 相对寻址,常量就放在紧邻代码之前;
- **exception/deopt handler 不在 code 区,在 stubs 区**(nmethod.cpp:718 注释原文 "Exception handler and deopt handler are in the stub section",`_exception_offset = _stub_offset + ...` :722)——它们是补丁性质的后备代码,和出站桩放一起。

### 各段干什么: 给 GC 和 deopt 的字典

- **relocation**: 压缩的重定位流——标注哪些地址存着 oop/IC 目标/调用目标,是 GC 和补丁的索引;
- **consts**: 编译期确定的 double/long/float 常量与跳转表;
- **oops 表**: 编译时嵌入的 oop 索引数组,GC 移动对象时按它更新嵌入指针。注意**索引 0 保留给 NULL**(nmethod.hpp:361-369,注释原文 "index 0 is reserved for null"),有效索引从 1 开始、真正元素从 oops_begin()[0] 开始,所以 `oop_at(i)` 读的是 `oops_begin()[i-1]`;
- **metadata 表**: 嵌入的 Klass*/Method* 索引,规则同上(索引 0 保留,NULL);
- **scopes 数据 + pcs**: deopt 的地图——下面单独讲;
- **dependencies**: 类层次假设清单(CHA 的赌注,"我赌这个类没有子类"之类),假设破了就 deopt;
- **handler table / null check table**: 异常处理范围表和隐式空指针表——x86 上解引用空指针会硬件报错,靠 pc 反查这张表决定"抛出 NPE 还是继续执行"。

数据从 CodeBuffer/记录器搬进 nmethod 有固定顺序(nmethod.cpp:756-770): 先拷贝代码与重定位,再拷 oops/metadata 表,然后 scopes、dependencies,`CodeCache::commit(this)` 发布,最后才拷异常表——**发布之后才补最后一类数据**,因为异常表不参与 GC 与补丁,晚一点无妨。

### scopes 与 pcs: 从 PC 反推 Java 栈

deopt 时手里只有一个 PC(正在执行的机器码地址),要还原出"这是在哪个方法的哪条字节码"。两张表配合:

- **PcDesc** —— pc → scope 的索引(pcDesc.hpp:37-39,逐字):

```cpp
// pcDesc.hpp:37-39(截取核心,逐字)
  int _pc_offset;           // offset from start of nmethod
  int _scope_decode_offset; // offset for scope in nmethod
  int _obj_decode_offset;
```

每条 PcDesc 把"nmethod 内偏移"映射到"scope 记录的解码偏移";

- **ScopeDesc** —— 一条内联层的记录(scopeDesc.cpp:79-86,截取核心,逐字):

```cpp
// scopeDesc.cpp:79-86(截取核心,逐字)
    _sender_decode_offset = stream->read_int();
    _method = stream->read_method();
    _bci    = stream->read_bci();

    // decode offsets for body and sender
    _locals_decode_offset      = stream->read_int();
    _expressions_decode_offset = stream->read_int();
    _monitors_decode_offset    = stream->read_int();
```

每条 scope 记录 = 方法 + 字节码位置 + 局部变量/表达式/监视器值的解码偏移。**内联的调用者不是指针,是 `_sender_decode_offset`**——一个指向外层记录的偏移,`sender()` 按它解码出调用者(scopeDesc.cpp:152-155),`is_top()` 就是该偏移为 serialized_null(最外层,scopeDesc.cpp:149)。为什么用偏移不用指针: 这些记录是压缩流,只在需要时按偏移现解码,不驻留内存。

**关键设计 (斜体)**: *内联会让一个 PC 同时属于多个 Java 帧——PC 落在内联方法的代码里,它的"调用链"就是 sender 链。deopt 时从 PcDesc 找到最内层 scope,沿 sender 链逐层走到最外层,每层都有完整的局部变量描述,Java 栈帧就能逐帧重建。PC 是入口,scope 是地图,scopes_pcs 段是两者的接线表。*

## 3. 状态机与并发协议

### 五个正史状态

代码区比堆更危险: 一段代码可能**正在被执行**(栈上有帧)、**刚被判死刑**(依赖失效)却还不能删、**已无活帧**可回收。nmethod 用状态机管这件事,枚举在父类 compiledMethod.hpp:188-197(逐字):

```cpp
// compiledMethod.hpp:188-197(逐字)
  enum { not_installed = -1, // in construction, only the owner doing the construction is
                             // allowed to advance state
         in_use        = 0,  // executable nmethod
         not_used      = 1,  // not entrant, but revivable
         not_entrant   = 2,  // marked for deoptimization but activations may still exist,
                             // will be transformed to zombie when all activations are gone
         zombie        = 3,  // no activations exist, nmethod is ready for purge
         unloaded      = 4   // there should be no activations, should not be called,
                             // will be transformed to zombie immediately
  };
```

- `not_installed`(-1): 构造中,只有构造线程能推进状态;
- `in_use`(0): 正常服务;
- `not_used`(1): "不可进入但可复活"的过渡态。jdk11u 里它实际上不会被赋给 `_state`——`make_not_used()` 直接转调 `make_not_entrant()`(nmethod.hpp:342),分层编译新版本上线时旧代码走的就是这条路径(ciEnv.cpp:1072);
- `not_entrant`(2): 不可再进入(deopt/依赖失效/类重定义),但栈上可能还有活跃帧,不能删;
- `zombie`(3): 无活跃帧,等 sweeper 收尸;
- `unloaded`(4): 终态。

状态单调前进,不能回退。注意 `is_in_use()` 的实现是 `_state <= in_use`(nmethod.hpp:321)——把 not_installed(-1) 也算"可用",这依赖枚举按"存活程度"有序的设计: `is_alive()` 则是 `_state < zombie`(:322)。

### 转换: 互斥锁 + 双重检查,不是 CAS

状态转换不是一次原子 CAS。`_state` 是 `volatile signed char`,`Patching_lock` 保护(nmethod.hpp:127-128,注释原文 "Protected by Patching_lock"),转换函数(nmethod.cpp:1144 起)的真实协议是:

- **先看 `_state == state` 就返回 false**——"已是终态,省得抢锁"(nmethod.cpp:1148-1153);
- 拿 `Patching_lock`(非 safepoint 锁,:1180),**锁内再看一次** `_state == state`——第二个线程已经做完就退出(:1182-1186);
- 真正做状态转移的线程还会干三件大事:
  1. `NativeJump::patch_verified_entry(entry_point(), verified_entry_point(), SharedRuntime::get_handle_wrong_method_stub())`(:1190-1193)——**把免检入口的 5 字节改写成 `jmp handle_wrong_method_stub`**,让所有已直连的调用方立刻改道;
  2. `mark_as_seen_on_stack()`(:1212-1214)——更新栈遍历标记,记录"还有没有活帧"(not_entrant 才有此步骤,顺序在状态变更之前);
  3. `_state = state`(:1217-1218),如果目标方法还指着这个 nmethod,`method()->clear_code(...)` 清掉引用(:1233-1237)。

补丁的原子性由硬件保证: x86-64 用 8 字节的 `Atomic::store` 一次写完整条 5 字节 jmp + 填充(nativeInst_x86.cpp:545-561)。

### nmethodLocker: 引用计数锁

状态机之外还有一把"软锁": 谁要在代码区做点危险事(反优化时的栈遍历 deoptimization.cpp:1546、JVMTI 的卸载事件 jvmtiImpl.cpp:920、运行时解析 sharedRuntime.cpp:1078),就给 nmethod 加一个引用计数,锁着就不许变 zombie。实现(nmethod.cpp:2035-2049,截取核心,逐字):

```cpp
// nmethod.cpp:2035-2049(截取核心,逐字)
void nmethodLocker::lock_nmethod(CompiledMethod* cm, bool zombie_ok) {
  if (cm == NULL)  return;
  if (cm->is_aot()) return;  // FIXME: Revisit once _lock_count is added to aot_method
  nmethod* nm = cm->as_nmethod();
  Atomic::inc(&nm->_lock_count);
  assert(zombie_ok || !nm->is_zombie(), "cannot lock a zombie method");
}

void nmethodLocker::unlock_nmethod(CompiledMethod* cm) {
  if (cm == NULL)  return;
  if (cm->is_aot()) return;  // FIXME: Revisit once _lock_count is added to aot_method
  nmethod* nm = cm->as_nmethod();
  Atomic::dec(&nm->_lock_count);
  assert(nm->_lock_count >= 0, "unmatched nmethod lock/unlock");
}
```

`is_locked_by_vm()` 就是 `_lock_count > 0`(nmethod.hpp:438,注释原文 "it is unsafe to remove this nmethod even if it is a zombie, since the VM or the ServiceThread might still be using it"),而 sweeper 的 `can_convert_to_zombie()` 明确要求 `!is_locked_by_vm()`(nmethod.cpp:999-1007)——锁计数非零,连 zombie 都不许变。RAII 封装在 nmethod.hpp:630-669: 构造时 lock,析构时 unlock,异常安全。

**关键设计 (斜体)**: *状态机管"代码本身该不该活",nmethodLocker 管"谁正在用所以暂时别杀"——两个层次互不干扰: 加锁只延迟淘汰,不改变状态;解锁后 sweeper 才按栈遍历标记决定收尸。计数锁不用真正的锁,就是一个 int 的原子增减: 非零即被锁(nmethod.hpp:438),sweeper 看到非零就不动它。*

## 核心悬念

nmethod 的骨架到此完整: 三扇门让"已验证/未验证/OSR"各走各的入口,IC 在调用点与入口之间闭环;八段身让 GC、deopt、JVMTI 都能读懂一段机器码;状态机从 not_installed 一路推进到 unloaded,途中靠 Patching_lock、8 字节原子补丁、引用计数保护每一处危险切换。但"谁在什么时候推进状态"还悬着: 谁发现方法变凉了?栈上的活帧怎么查?zombie 的空间怎么回到 CodeHeap?——下一篇: nmethod 生命周期——扫除器怎么判断一段代码不需要了。

> → [03-nmethod-lifecycle.md](03-nmethod-lifecycle.md)
