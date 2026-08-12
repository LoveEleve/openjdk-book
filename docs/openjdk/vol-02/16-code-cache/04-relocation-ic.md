# 04. Relocation 与 Inline Cache — 机器码怎么认识自己

> **前置依赖**:[02 — nmethod 结构](02-nmethod-structure.md):调用点 `movq rax,imm64; call` 的固定形态、IC 四态与入口检查;relocation 段的位置([03 — nmethod 生命周期](03-nmethod-lifecycle.md)里 GC 的 `oops_do`/类卸载都靠它)
> → **后续**:[05 — Dependencies 与 Deopt](05-dependencies-deopt.md)
> 关联域: 18-safepoint(poll reloc 标注轮询指令)、22-deopt(IC 清理与 deopt 的配合)、25-gc(嵌入 oop 的更新)

## 机器码里藏着一串"地址"

GC 搬走对象后,嵌在机器码里的 oop 指针必须跟着改;方法调用从"每次查 vtable"变成"直接 call"需要补丁。但**机器码自己不知道自己身上哪里有地址**——"这段代码的哪个偏移嵌着一个 oop"是编译期的事实,靠编译时同步记录的 **relocation 表**保存下来。这篇拆三层: 压缩编码的 relocation 流(relocInfo)、读写指令的 C++ 包装(NativeInst)、以及改调用点的 MT 安全机制(ICBuffer)。

## 1. relocInfo: 一行半字,一条重定位

### 16 位能装什么

一条重定位记录只有 16 位(relocInfo.hpp:75-83,逐字):

```cpp
// relocInfo.hpp:75-83(逐字)
// A relocInfo is represented in 16 bits:
//   4 bits indicating the relocation type
//  12 bits indicating the offset from the previous relocInfo address
//
// The offsets accumulate along the relocInfo stream to encode the
// address within the CodeBlob, which is named RelocIterator::addr().
// The address of a particular relocInfo always points to the first
// byte of the relevant instruction (and not to any of its subfields
// or embedded immediate constants).
```

注意这个"4+12"是通用格式,平台会再切走几位做 format:x86-64 的 `format_width = 2`(relocInfo_x86.hpp:38-41),所以实际布局是 **4 位类型 + 2 位 format + 10 位偏移**(`offset_width = nontype_width - format_width`,relocInfo.hpp:432),单条记录覆盖的最大偏移是 1024 字节(`offset_limit = (1 << offset_width) * offset_unit`,relocInfo.hpp:344)。format 位是 x86 特有的需求——一条指令可能含多个可重定位常量(注释 relocInfo.hpp:89-94 原文 "Any machine (such as Intel) whose instructions can sometimes contain more than one relocatable constant needs format codes"),format 告诉读取方"这条 reloc 对应指令里的哪个操作数"。

**关键设计 (斜体)**: *16 位固定宽度让每条记录恒为 2 字节;偏移是 delta 编码——每条只记"距上一条重定位多远",地址沿流累积(`RelocIterator::next` 里 `_addr += addr_offset`,relocInfo.hpp:585),这样 10 位偏移就能表达任意长度的连续 reloc 序列。GC 遍历 relocation 时本来就是顺序访问,顺序解码没有额外成本;代价是只能顺序读(按 PC 定位也是从起点顺序推进,`set_limits`,relocInfo.cpp:196),但没有消费方需要随机索引。*

### 16 种类型: 编号全部用完

类型枚举(relocInfo.hpp:257-275,截取核心,逐字):

```cpp
// relocInfo.hpp:257-275(截取核心,逐字)
  enum relocType {
    none                    =  0, // Used when no relocation should be generated
    oop_type                =  1, // embedded oop
    virtual_call_type       =  2, // a standard inline cache call for a virtual send
    opt_virtual_call_type   =  3, // a virtual call that has been statically bound (i.e., no IC cache)
    static_call_type        =  4, // a static send
    static_stub_type        =  5, // stub-entry for static send  (takes care of interpreter case)
    runtime_call_type       =  6, // call to fixed external routine
    external_word_type      =  7, // reference to fixed external address
    internal_word_type      =  8, // reference within the current code blob
    section_word_type       =  9, // internal, but a cross-section reference
    poll_type               = 10, // polling instruction for safepoints
    poll_return_type        = 11, // polling instruction for safepoints at return
    metadata_type           = 12, // metadata that used to be oops
    trampoline_stub_type    = 13, // stub-entry for trampoline
    runtime_call_w_cp_type  = 14, // Runtime call which may load its target from the constant pool
    data_prefix_tag         = 15, // tag for a prefix (carries data arguments)
    type_mask               = 15  // A mask which selects only the above values
  };
```

0-15 全部分配完毕。按用途分几族:

- **对象引用**: `oop_type`/`metadata_type`——嵌在代码里的 oop 或 Klass*/Method*,GC 与类卸载的更新对象(16-03 的 `do_unloading_oops` 遍历的就是它);
- **调用点**: `virtual_call_type`(带 IC 的虚调用)/`opt_virtual_call_type`(静态绑定,无缓存)/`static_call_type`/`static_stub_type`/`runtime_call_type`(到固定 C 函数的 call)/`runtime_call_w_cp_type`(目标可能从常量池加载)——16-02 里 `CompiledIC` 构造时就是在调用点 PC 处找 `virtual_call_type`(compiledIC.cpp:196-201);
- **地址引用**: `internal_word_type`(blob 内地址)/`external_word_type`(固定外部地址)/`section_word_type`(跨段引用);
- **safepoint**: `poll_type`/`poll_return_type`——标注轮询指令的位置(01 域讲过 safepoint 轮询);
- **基础设施**: `data_prefix_tag`(前缀,携带数据)、`none`(填充)。

### prefix 与 filler: 格式的补丁手段

16 位装不下的信息靠两种补充记录:

- **prefix**(`data_prefix_tag`): 每条 reloc 前至多一条前缀,携带 1 个或多个半字的附加数据(比如 oop 在 oops 表里的索引)。读取时 `advance_over_prefix` 先跳过前缀再读真正的 reloc(relocInfo.cpp:222-237);10 位以内的数据直接压进前缀本身("immediate",注释 relocInfo.hpp:350-352);
- **filler**(`none`): 三种用途(注释 relocInfo.hpp:337-343 原文 "to skip large spans of unrelocated code (this is rare) / to pad out the relocInfo array to the required oop alignment / to disable old relocation information")——其中"跳过大段无重定位代码"就是 offset 超限时的出口: 插一条 `filler_relocInfo()`(relocInfo.hpp:458-460),它的偏移填 `offset_limit - offset_unit`(最大合法值),把地址一下子推过无 reloc 的区域。

### RelocIterator: 顺序解码器

读取方是 `RelocIterator`(构造 relocInfo.cpp:128-155): 给定 nmethod 和 begin/limit 两个 PC,从 `content_begin` 开始累积偏移;`next()` 每步推进一条记录,`reloc()` 按类型生成对应的轻量对象。两条典型用法:

- **GC 更新嵌入 oop**: `nmethod::oops_do`(nmethod.cpp:1578-1608)从 `oops_reloc_begin()` 开始遍历,遇到 `oop_type` 就检查它是"immediate"(oop 直接嵌在指令里,`oop_index()==0`,relocInfo.hpp:941)→ 直接 `f->do_oop(r->oop_addr())`;索引式的 oop 走 oops 表(02 篇讲过);
- **定位 IC**: `CompiledIC` 构造时在调用点开一个单点迭代器(compiledIC.cpp:196-201),找到 `virtual_call` reloc 后由它反推出缓存值的存放位置(`get_load_instruction`);
- **清理指向死方法的 IC**(16-03 里 sweeper 的 `cleanup_inline_caches` 就是它): `cleanup_inline_caches_impl`(compiledMethod.cpp:556-589)遍历 `virtual_call`/`opt_virtual_call`/`static_call` 三类 reloc,逐个检查缓存目标是不是 not_entrant/zombie/unloaded,是就清掉——sweeper 每轮给存活的 nmethod 打扫调用点,靠的就是这条 reloc 流。

一个细节: `oops_reloc_begin()` 不是从代码开头遍历——not_entrant 时入口处前几字节被补丁 jmp 覆盖,那里的 oop 不该被 GC 触碰,所以起点是 `verified_entry_point`(compiledMethod.cpp:234-240,注释原文 "If the method is not entrant or zombie then a JMP is plastered over the first few bytes. If an oop in the old code was there, that oop should not get GC'd")。

## 2. NativeInst: 指令的 C++ 视角

### 补丁的本质: 找到字节,改掉字节

relocation 告诉你"这里有个 oop/调用目标",但读写它需要知道指令的确切格式——这就是 `NativeInstruction` 家族(nativeInst_x86.hpp:52 起)的职责: 每个类包装一种 x86 指令,提供定位偏移和读写方法。三个主角:

- **NativeCall**(nativeInst_x86.hpp:156): 5 字节 call。`instruction_size = 5`,位移在 `displacement_offset = 1`(:160-162);`set_destination(dest)` 就是把 `dest - return_address()` 写进位移(:172-177);
- **NativeMovConstReg**(nativeInst_x86.hpp:253): `REX.W B8 + imm64`,10 字节(:262-269)。`data()`/`set_data()` 读写 8 字节立即数(:273-274)——GC 更新嵌入 oop、IC 更新缓存 Klass 都走它;
- **NativeJump**(nativeInst_x86.hpp:494): 5 字节无条件跳转(`0xe9` + rel32)。

### 原地补丁的写序技巧

改一个 5 字节 call 的位移,难点在**并发执行**: 正在执行这条 call 的线程可能读到"一半新、一半旧"的位移。对齐的情况下(call 位移 4 字节对齐,不会跨缓存行)一次写完即可;不对齐时,`set_destination_mt_safe`(nativeInst_x86.cpp:261 起)用三步写序:

```cpp
// nativeInst_x86.cpp:277-297(截取核心,逐字)
  } else if ((uintptr_t)instruction_address() / 4 ==
             ((uintptr_t)instruction_address()+1) / 4) {
    // Tricky case:  The instruction prefix lies within a single cache line.
    intptr_t disp = dest - return_address();
#ifdef AMD64
    guarantee(disp == (intptr_t)(jint)disp, "must be 32-bit offset");
#endif // AMD64

    int call_opcode = instruction_address()[0];

    // First patch dummy jump in place:
    {
      u_char patch_jump[2];
      patch_jump[0] = 0xEB;       // jmp rel8
      patch_jump[1] = 0xFE;       // jmp to self

      assert(sizeof(patch_jump)==sizeof(short), "sanity check");
      *(short*)instruction_address() = *(short*)patch_jump;
    }
    // Invalidate.  Opteron requires a flush after every write.
    wrote(0);
```

三步的语义: ① 先把前 2 字节改成 `jmp rel8 -2`(**跳到自身**,任何线程走进来都会原地自旋,不会执行半补丁的位移);② 写后 3 字节位移;③ 最后把前 2 字节换成 opcode+位移高 2 字节——完成。每一步之间做 ICache 失效("Opteron requires a flush after every write")。补丁期间线程要么还在旧指令上(已完整读过),要么自旋到补丁完成,绝不执行半成品。

**关键设计 (斜体)**: *"跳到自身"是原地补丁的经典自旋栅栏——正在执行这条指令的线程不需要任何锁,靠 2 字节原子写保证不看到半成品;补丁线程之间由 Patching_lock 或 safepoint 互斥(nativeInst_x86.cpp:265-266 的 assert)。*

## 3. IC 补丁的 MT 安全: 过渡桩

### 问题: 调用点有两个字段

02 篇讲过调用点形态: `mov rax, imm64`(缓存 Klass)+ `call target`。补丁一个 IC 要改**两个字段**——如果把"新目标 + 旧缓存"组合暴露出去,执行线程会用错的缓存做类型检查。直接原地改两处没有原子性可言。解决办法是**不让调用点出现半成品**: 先在别处把新状态组装好,再让调用点一次切换。

### ICBuffer: out-of-line 组装,一次性切换

`InlineCacheBuffer` 是一个 `StubQueue`(icBuffer.cpp:112-119,容量 `InlineCacheBufferSize = 10K`,globals.hpp:412),专门放过渡桩。补丁流程(`create_transition_stub`,icBuffer.cpp:172-194,截取核心,逐字):

```cpp
// icBuffer.cpp:172-194(截取核心,逐字)
void InlineCacheBuffer::create_transition_stub(CompiledIC *ic, void* cached_value, address entry) {
  assert(!SafepointSynchronize::is_at_safepoint(), "should not be called during a safepoint");
  assert (CompiledIC_lock->is_locked(), "");
  ...
  // If an transition stub is already associate with the inline cache, then we remove the association.
  if (ic->is_in_transition_state()) {
    ICStub* old_stub = ICStub_from_destination_address(ic->stub_address());
    old_stub->clear();
  }

  // allocate and initialize new "out-of-line" inline-cache
  ICStub* ic_stub = get_next_stub();
  ic_stub->set_stub(ic, cached_value, entry);

  // Update inline cache in nmethod to point to new "out-of-line" allocated inline cache
  ic->set_ic_destination(ic_stub);

  set_next_stub(new_ic_stub()); // can cause safepoint synchronization
}
```

- **组装**: `ICStub::set_stub`(icBuffer.cpp:71-79)把新状态写进桩——桩代码是 `lea rax, [cached_value]; jmp entry`(icBuffer_x86.cpp:52-62),缓存值就在桩的指令里;
- **切换**: `ic->set_ic_destination(ic_stub)`——**只改调用点 call 的目标**(指向桩),一次(写序)补丁完成过渡。此刻起,执行线程走到这个调用点: 先加载 mov 里的旧缓存值(无妨,马上被覆盖)→ 从桩取新 Klass → 跳新入口,全程看到的是完整新状态;
- **落地**: 下一个 safepoint 里 `update_inline_caches` 遍历桩,`ICStub::finalize`(icBuffer.cpp:50-58)把 (destination, cached_value) 真正写进调用点的 (call 目标, mov 立即数),桩清空复用——之后调用点就是常规形态,不再经过桩;
- **兜底**: 桩队列满了(`new_ic_stub`,icBuffer.cpp:120-143)→ 开 `VM_ICBufferFull` 强制一个 safepoint 清空队列,再继续。

**关键设计 (斜体)**: *两阶段是"先原子切换引用,后安全落地数据"——调用点的任何时刻要么是旧形态、要么是完整新形态(经桩),不存在中间态;真正写两个字段发生在 safepoint,那时所有线程都停着。MT 安全靠的是"切换"与"落地"分离,而不是一次更大的原子写。*

### IC miss: 补丁由谁发起

16-02 讲过检查失败跳 `ic_miss_stub`;它的终点是 `handle_wrong_method_ic_miss`(sharedRuntime.cpp:1421-1434)→ `handle_ic_miss_helper`(:1552)。helper 的三个分支:

1. **静态可绑定**(`can_be_statically_bound`)→ 直接 `reresolve_call_site`,调用点升级为优化调用(不再有 IC);
2. **应保持单态**——缓存的方法已有编译代码(`FALSE IC miss converting to compiled call`)→ `compute_monomorphic_entry` + `set_to_monomorphic`(经 ICBuffer 过渡);
3. **否则升级多态** → `set_to_megamorphic`(vtable/itable 桩,02 篇讲过;失败则 `set_to_clean`)。

整个过程在 `CompiledIC_lock` 保护下(sharedRuntime.cpp:1575),最终返回被调方法的 `verified_code_entry`,线程直接跳过去继续执行——IC miss 的代价是"一次解析 + 一次补丁",之后调用点就记住了解析结果。

## 核心悬念

自描述层到齐: relocation 流用 16 位半字压缩记录"代码哪里嵌着 oop/调用目标/轮询指令",RelocIterator 顺序解码,GC 靠它更新嵌入指针;NativeInst 家族给出读写指令的精确接口,原地补丁用"自旋栅栏"写序保证并发安全;IC 补丁则用过渡桩把"组装"和"切换"分离,让调用点永远没有半成品。但 IC 只是"运行时观测到的类型"的缓存——C2 还有一类更激进的赌注: 编译时对**类层次结构**做的假设(单实现、无子类、final 性),这类假设没有 IC 缓存兜底,破了只能整体作废重编。这些假设是什么、怎么记录、怎么验证、破了怎么收尸?下一篇: Dependencies 与 Deopt——JIT 的乐观假设。

> → [05-dependencies-deopt.md](05-dependencies-deopt.md)
