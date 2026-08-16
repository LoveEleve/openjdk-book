# 01. GC 怎么在每次 oop 访问时悄悄插入 barrier？— BarrierSet + Access API

> 🔴 Deep | 5 KP 中的 GC↔Compiler 桥
> 读者处境: `obj.field = value` —— 这是一条普通的 Java 赋值语句。但在 JVM 眼里——这需要插入 GC write barrier(写屏障)——标记 dirty card(老年代→新生代更新)、转发指针(G1 的 SATB 快照)、或调用 GC specific code。这个 barrier 怎么注入——而不让每次 oop 访问变慢？

### 1. "Access<> 模板——编译期的 barrier 分派"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **文件位置错(重要)**: access.hpp/accessBackend.hpp/accessDecorators.hpp 在 **share/oops/**(非 share/gc/shared)
> - **"编译期静态分派,零运行时开销" 错(重要)**: 真实=**5 步模板管线**(access.hpp:63-92 注释: 默认装饰器/类型归约/Pre-runtime dispatch/Runtime-dispatch/Barrier resolution+patch/Post-runtime dispatch)+ **RuntimeDispatch 函数指针缓存**(accessBackend.hpp:452-459: 函数指针初始指向 resolve 函数,首次调用 resolve 后 patch 成 BarrierSet::AccessBarrier 函数,access.inline.hpp:284-288)——**运行时分派**(switch bs->kind() :218-235,因 GC 是启动时 flag 选的);**运行时分派三副面孔(第 3 轮修正)**: VM 内部 C++=函数指针缓存(一次间接调用);解释器模板=BarrierSetAssembler **虚函数调用**(access_store_at macroAssembler_x86.cpp:5478: AS_RAW 显式调基类/否则 bs->store_at 虚调,:5466-5475);C1/C2=编译期 barrier 机器码(热路径零间接调用)——"解释器/JIT 直插"表述错
> - **"三层架构 (barrierSet.hpp:49-74)" 简化**: 真实骨架=BarrierSet(FakeRtti :58-71 + Name 枚举 :50-55 + **三子组件 :72-74** ✓ + AccessBarrier 嵌套模板 :166-299 默认委托 RawAccessBarrier);特化链 G1→ModRef→BarrierSet→RawAccessBarrier(g1BarrierSet.hpp:88-108)
> - **装饰器不是 12 种**: 6 组约 24 个(内部 3+build-time 2+rt 1 / MO 6 / AS 3 / ON 4 / IN 2 / IS 3 / ARRAYCOPY+PTR 若干,accessDecorators.hpp:51-255);AS_RAW 旁路( :139-145 "bypass runtime function pointer dispatching")
> - **行号漂移**: access.hpp Access 类 :94-95(大纲 80-200);accessBackend.hpp RuntimeDispatch :461+(大纲 40-200);barrierSet.inline.hpp 只有 60 行(大纲 40-120)

场景: 编译代码或解释器读/写 oop field——必须经过 Access API。编译器看到 `Access<IS_DEST_UNINITIALIZED|MO_RELAXED>::store(obj, &field, value)`→在 C++ 模板展开阶段解析 Decorator→选择 BarrierSet 后端→inline 生成汇编。

**Access API 装饰器体系** (`access.hpp:80-200`):
```cpp
template <DecoratorSet decorators>
class Access : public AccessBackend<decorators> {};
// Decorators: 12 种 flags OR 在一起
IS_DEST_UNINITIALIZED | IN_HEAP | MO_RELAXED | ... |
AS_RAW | STRONG_BARRIER | ...
```
- 源码: `access.hpp:80-200` + `accessDecorators.hpp:40-120` DecoratorSet 定义
- 关键设计: Decorator 是编译期常量——12 个 bit flags 打包成一个 template parameter。编译器在 Access<decorators>::store() 调用处: (1) 检查 decorators 匹配(BarrierStrength=STRONG→走 GC barrier, NONE→raw access), (2) 选择 BarrierSet 的 store 实现(G1BarrierSet vs CardTableModRef), (3) inline 全部展开——零运行时开销
- [C++: template metaprogramming—SFINAE + enable_if——Access<> 的每个方法 overload 有多版本(runtime decorator check + compile-time decorator check)。编译器消除不匹配的 overload——最终生成的代码中只有一条路径]

**三层架构** (`barrierSet.hpp:49-74`):
```
Access<decorators>::store()
  → AccessBackend<decorators>::store()      // 装饰器预处理
    → BarrierSet::store(decorators, addr, val) // BarrierSet backend
      → G1BarrierSet::store(...) 或 CardTableModRefBS::store(...)
        → 对应的 write barrier (card mark/SATB/cross-generational)
```
- 源码: `accessBackend.hpp:40-200` 后端 dispatcher + `barrierSet.inline.hpp:40-120` BarrierSet 具体方法
- 关键设计: 三层不是运行时多态(virtual)而是编译期静态分派——Access<> 到 AccessBackend<> 再根据 BarrierSet Type 用 FakeRtti 做 static_cast——编译器在编译 nmethod 时就知道了精确的 BarrierSet 类型

### 2. "BarrierSet 三层子组件——Assembler/C1/C2"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/01 已按真实源码成文):
> - **三子组件 (barrierSet.hpp:72-74)** ✓ 行号对(_barrier_set_assembler/_barrier_set_c1/_barrier_set_c2);构造注入 make_barrier_set_assembler/c1/c2(:105-118,COMPILER1/2_PRESENT 门控)
> - **"C2 的 Ideal 图会包含 BarrierSetC2::ideal_node() 节点" 编造**: barrierSetC2.hpp 无 ideal_node;真实=BarrierSetC2 虚方法 store_at/load_at(barrierSetC2.hpp:166-188)→G1BarrierSetC2::pre_barrier/post_barrier(g1BarrierSetC2.cpp:175/:372)用 **IdealKit** 生成节点序列(与汇编版同构: marking 检查→旧值→buffer→满则 make_leaf_call write_ref_field_pre_entry :267-268);**节点在 Ideal 图里可优化**: g1_can_remove_pre/post_barrier(:86/:306)+ReduceInitialCardMarks 跳过"刚分配未发布对象"的卡标记(:391-398)
> - **三视角注入(大纲漏,重要)**: 汇编层=BarrierSetAssembler(x86 默认 load_at/store_at barrierSetAssembler_x86.cpp:34-130;解释器模板 do_oop_store templateTable_x86.cpp:146-158→store_heap_oop macroAssembler_x86.cpp:5501→虚分派);C1=G1BarrierSetC1 pre/post LIR(g1BarrierSetC1.cpp:51/:110)+Runtime1 blob 慢路径(:194-221);C2=graphKit.cpp:56 _barrier_set + :1606 分派
> - 素材: 25-gc-barrier-demo.txt(gc+phases 阶段树/Update RS;C1 1248/1344 vs C2 576 nmethod 尺寸;flag 盘点 ReduceInitialCardMarks {C2 product}/UseCondCardMark {product})

场景: 写 barrier 有三个"视角"：(1) Assembler 层——手写汇编 stub 中的 barrier。(2) C1——快速编译器生成 barrier 指令。(3) C2——优化编译器生成 highly optimized barrier。

**BarrierSet 的三个子组件** (`barrierSet.hpp:72-74`):
```cpp
class BarrierSet {
  BarrierSetAssembler* _barrier_set_assembler; // 桩层
  BarrierSetC1*        _barrier_set_c1;        // C1 编译器侧
  BarrierSetC2*        _barrier_set_c2;        // C2 编译器侧
};
```
- 源码: `barrierSet.hpp:72-74` + 子组件 virtual 接口
- 关键设计: 每个 GC implementation 提供一组 barrier 实现——G1BarrierSet 自带 G1BarrierSetAssembler/G1BarrierSetC1/G1BarrierSetC2。编译器在生成代码时通过 BarrierSet 的对应子组件注入 barrier——C2 的 Ideal 图会包含 BarrierSetC2::ideal_node() 节点→在寄存器分配前优化 barrier 冗余

### 3. "CardTable——1 byte per 512 bytes"
> ⚠️ 写作期修正(2026-08-15, vol-02/25-gc-framework/01 已按真实源码成文):
> - **card_shift=9/card_size=512** ✓ 在 **cardTable.hpp:231-232**(大纲 80-150 漂移);CardValues :95-102(clean=-1/dirty=0/precleaned=1/claimed=2/deferred=4);byte_for :153-158
> - **store_check 汇编**(cardTableBarrierSetAssembler_x86.cpp:88-132): shrptr(obj, card_shift) :97 + byte_map_base 位移寻址(:101-117,simm32 或 ArrayAddress)+ movb dirty(:130);UseCondCardMark 先 cmpb 后 movb(:120-128,默认关);G1 的 oop_store_at 只对 in_heap+val 非空做 post barrier(:134-153)
> - **"G1SATBCardTableLogging/Parallel CardTableExtension" 过期(JDK8 名)**: JDK11 G1 用 G1BarrierSet+DirtyCardQueue(share/gc/g1/dirtyCardQueue.hpp:46+,PtrQueue 线程本地 index/buf,Set 收集),G1-only 构建无 Parallel 分支
> - 卡标记行为实证: 2 亿次老对象引用写后 -Xlog:gc+phases=debug 的 Update RS 阶段处理卡片(素材 A 段)

场景: G1 和 CardTableModRef 都用 card table——每 512 bytes(2^9)的 heap 空间用 1 byte 标记。写 barrier 通过直接内存写入标记脏卡片——无函数调用。

**CardTable 脏卡标记** (`cardTable.hpp:80-150 + cardTableBarrierSet.hpp:50-130`):
```cpp
jbyte* card_addr = card_table->byte_for(p);
*card_addr = CardTable::dirty_card_val(); // 单 mov 指令
```
- 源码: `cardTable.hpp:80-150` card size calculation + `cardTableBarrierSet.inline.hpp:50-100` write_ref_array barrier
- 关键设计: card_shift = 9 (512 bytes)——每 512 bytes 一个 card。card 的 dirty mark 是 byte 写——x86 上 1 cycle。DirtyCardQueue 批量收集这些脏卡片→GC 时处理(G1 处理 G1SATBCardTableLogging, Parallel 处理 CardTableExtension)
- [x86: card marking 被编译器生成: `shr rsi, 9; mov byte [rsi + card_table_base], 0`——全 inline——无函数调用、无指针跟踪。512 byte granularity 平衡: 太粗(4KB)→太多 false sharing; 太细(64B)→card table 太大+扫描太多卡片]

---

### 核心悬念

**"Access<> 模板 + 12 Decorator flags → BarrierSet backend → C2 优化——GC barrier 在编译期静态展开，零运行时 overhead。CardTable 用 1 byte/512 bytes→直接内存写入标记脏卡片。"** — 但 new Object() 从 Java 代码到 OS 内存走了哪些层？下一篇: CollectedHeap + 分配路径。

> → [02-collected-heap.md](02-collected-heap.md)
