# 01. JVM 怎么表示一个栈帧？— Physical Frame

> 🔴 Deep | 3 KP 中的栈帧表示
> 读者处境: GC 需要扫描所有线程的栈——每个 slot 可能是 oop。要安全地读栈，必须先知道每个帧的格式：哪些 slot 是 oop？这个帧是编译的还是解释的？caller 在哪？

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
