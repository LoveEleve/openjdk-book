# 01. JVM 怎么表示一个栈帧？— Physical Frame

> 🔴 Deep | 3 KP 中的栈帧表示
> 读者处境: GC 需要扫描所有线程的栈——每个 slot 可能是 oop。要安全地读栈，必须先知道每个帧的格式：哪些 slot 是 oop？这个帧是编译的还是解释的？caller 在哪？
>
> ⚠️ 写作期修正(2026-08-13, vol-02/24-frame/01 已按真实源码成文 238 行,本大纲为规划期产物,机制描述以文章为准):
> - **"frame 三字段" 错**: 共享 _sp/_pc/_cb+deopt 三态(frame.hpp:50-65,枚举 not_deoptimized/is_deoptimized/unknown :57-61),**x86 附加 _fp 与 _unextended_sp(frame_x86.hpp:110-120)**——注释: interpreter/adapters 扩展 caller 帧,oopMap 按扩展前 sp 记录,故需双 sp;别写"32 字节三字段"
> - **"compiled sender = *rbp / *(rbp+8)" 错**: 真实=**sender_sp = unextended_sp + _cb->frame_size()(编译期元数据,一跳到位)**,sender_pc = *(sender_sp-1),saved_fp = *(sender_sp-2)(frame_x86.cpp:451-483);不是 rbp 链现场走
> - **"interpreter sender = *[method_locals-2]" 半对**: sender_sp = this->sender_sp()(raw sp),unextended_sp = interpreter_frame_sender_sp()(**fp[-1],帧内保存的 caller sp**,frame_x86.cpp:431-446);偏移表 frame_x86.hpp:60-73(link=0/return=1/sender_sp=2;解释器侧 sender_sp=-1/method=-2/mdp=-3/cache=-4/locals=-5/bcp=-6/initial_sp=-7)
> - **"四种帧" 简化错**: sender 分派**只有三路**(entry/interpreter/compiled,frame_x86.cpp:488-503),JNI native 帧也是 nmethod 走 compiled;兜底是纯 C 帧(注释 "the marshaling code for native methods")
> - **"find_blob 二分搜索" 错**: CodeHeap 段映射(segmap)链式回跳一次到位(heap.cpp:456-483: 地址→段号→段标记记"距块首段数"→回跳),非 O(log N);x86 段=128B(CodeCacheSegmentSize=64 TIERED_ONLY(+64),globals_x86.hpp:40)
> - **"Interpreter::oop_map_cache()" 不存在(编造)**: 缓存挂在 **Klass 上**(InstanceKlass::_oop_map_cache,instanceKlass.hpp:247,per-class 懒分配);mask 现场算=Method::mask_for(method.cpp:237)→OopMapCache::compute_one_oop_map(oopMapCache.cpp:597),按 (method,bci) 推导
> - **oops_do 行号漂移**: oops_do_internal(frame.cpp:1115-1130,分派 interpreted/entry/CodeCache);oops_interpreted_do(:890-958: monitor 块→native temp oop→方法 mirror→调用点参数→mask 遍历 locals+表达式栈);oops_code_blob_do(:976-990)→**OopMapSet::oops_do(compiler/oopMap.cpp:288)**→all_do(:298+: cb->oop_map_for_return_address(pc) :302,derived 先处理 :307-340);OopMapValue 四型 oopMap.hpp:69-73(oop/narrowoop/callee_saved/derived)
> - **栈顶入口(大纲未提)**: Thread::last_frame(thread.hpp:1879-1883)=_anchor.make_walkable+pd_last_frame(thread_linux_x86.cpp:30-34);JavaFrameAnchor(thread.hpp:984);构造时 deopt 判定=get_deopt_original_pc(frame_x86.inline.hpp:44-60,set_pc 后 _deopt_state=unknown frame.cpp:157)
> - 实证: materials/commands/24-frame-demo.txt(jstack 两行 at=帧链+vframe 产物;Compiler.codelist hot(I)I 双版本 level4/3;三段 CodeHeap 1098 blobs/653 nmethods/359 adapters(适配器也是 BufferBlob→non-nmethods 段,codeBlob.cpp:262);PrintInterpreter 271 codelets 平均 358B)

### 1. "我是哪种帧？" — 四种帧类型

场景: 线程执行 `new Object()` ——可能正在解释器中执行(interpreter frame)、可能在 C2 编译代码中(compiled frame)、可能在 JNI 中(native frame)、也可能是 VM 内部 C 代码(C frame)。每种帧格式不同。

**frame 的三字段** (`frame.hpp:50-63`):
```cpp
class frame {
  intptr_t* _sp;      // 栈指针 — 帧的底部(最低地址)
  address   _pc;      // PC — 下条要执行的指令
  CodeBlob* _cb;      // 哪个 CodeBlob 拥有这个 PC
  deopt_state _deopt_state; // not_deoptimized/is_deoptimized/unknown
};
```
- 源码: `frame.hpp:50-63` 字段定义
- 关键设计: frame 是最小化的——只有 3 个字段(+deopt flag)。不需要存方法名/行号/局部变量——这些都通过 _pc→_cb→nmethod 反向追踪得到(sp→bcp 反向)。frame 是"栈上已存在的 slots 的视图"——不分配额外内存
- [x86: x86_64 上 frame 的三个字段占 32 bytes(sp=8+pc=8+cb=8)→完美契合 L1 cache line 的一半。GC 遍历栈时顺序访问 frame→L1 hit rate high]

**四种帧的 sender 逻辑** (`frame_x86.inline.hpp:40-100`):
```
compiled frame:
  sender_sp = *rbp    // rbp 始终指向 caller 的 rbp
  sender_pc = *(rbp+8)// caller 的 return address
  → 跟 frame(rbp) 即构造 caller frame

interpreter frame:
  sender_sp = *[method_locals - 2] // 存 call 前的 sp(在 interpreter entry 保存)
  sender_pc = *(sender_sp + return_offset)
  → 跟从解释器帧的 sp 和存储的 sender_sp 计算

native frame (JNI):
  sender_sp = thread->last_Java_sp() // anchor frame 存
  sender_pc = thread->last_Java_pc() // 再次从 JavaFrameAnchor 拿
```
- 源码: `frame_x86.inline.hpp:40-100` 每种帧的 sender 计算
- [x86: compiled frame 的 rbp chain 类似 C 标准调用约定——`push rbp; mov rbp,rsp`。rbp 本身存 caller 的 rbp。从当前 frame 到 caller 的遍历 = 读当前 rbp→取 [rbp]→caller rbp→取 [rbp+8]→caller pc→构造 frame]

**帧类型判断** (`frame.cpp:60-120`):
```
frame(sp, pc) constructor:
  1. _cb = CodeCache::find_blob(pc) — 如果 pc 在 CodeCache→compiled frame
  2. Interpreter::contains(pc) → interpreter frame
  3. StubRoutines::contains(pc) → stub frame (类似 compiled)
  4. pc 在 native code → native frame
```
- 关键设计: find_blob 用二分搜索(CodeCache 中 blob 按地址排序)→O(log N)。interpreter contains 用范围检查简单(interpreter code 在 CodeCache 的固定位置)

### 2. "这个 slot 是 oop 吗？" — OopMap 与 GC 扫描

场景: GC 扫描 compiled frame——有个堆栈 slot 存了一个 oop 指针。怎么知道它是 oop 还是 int？

**oops_do 流程** (`frame.cpp:200-350`):
```
compiled frame oops_do:
  1. 从 _cb(CompiledMethod) 取 OopMapSet
  2. OopMap 找到 pc 对应的 OopMap
  3. 遍历 OopMap 的每个 slot entry:
     - 类型=oop → OopClosure->do_oop(slot_address)
     - 类型=derived_oop → derived pointer update
     - 类型=callee_saved → 受 reg 的 oop 特殊处理
  4. 对于每个 oop 的值→如果有值→标记对象
```
- 源码: `frame.cpp:200-350` compiled frame oops_do + interpreter frame oops_do
- 关键设计: OopMap 是编译时(JIT)生成的——编译器在 safepoint 位置记录"这个 slot 有 oop X"。不是"遍历所有 slots 试 oop"——那样不准确(可能把 int 值误判为 oop 导致 GC mark invalid)——必须是精确式 OopMap

**Interpreter frame oops_do**:
```
解释器帧所有 locals slot 都可能是 oop→by OopMapCache
Interpreter::oop_map_cache()->lookup(method, bci) → callee mask
```
- 关键设计: 解释器不需要"编译时生成的 OopMap"——解释器状态是活的。OopMapCache 根据当前 bci 和方法签名动态计算 oop mask

---

### 核心悬念

**"Frame 用 sp/pc/cb 三字段表示物理栈帧——sender() 按帧类型从不同位置读取 caller 信息。OopMap 精确标注 GC-可见的 oop slots。"** — 但编译代码内联了 3 层——怎么看到源级方法？下一篇: Virtual Frame。

> → [02-virtual-frame.md](02-virtual-frame.md)
