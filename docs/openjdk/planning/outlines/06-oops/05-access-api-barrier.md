# 05. Access API — 每次 oop.field = value 都有 GC 在旁听

> 🔴 Deep | 15 KP 中的 1 个核心机制 + OopHandle/WeakHandle
> 读者处境: `obj.field = new Object()`——JVM 不只是写内存——它在中间插入了 GC barrier。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/06-oops/05 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"编译期选、零运行时 dispatch"不准确**: 装饰器在编译期组合,但 barrier 函数由 `resolve_barrier()` **运行时解析**(access.inline.hpp:269-270;BarrierSet::AccessBarrier 注释 "automatically resolved at runtime",barrierSet.hpp:155-167);JIT 编译时 barrier 已固化,C2 直接内联生成机器码
> - **装饰器行号漂移**: accessDecorators.hpp 定义在 :129-137(内存序 MO_*)/:155(AS_RAW)/:182-183(IN_HEAP/IN_NATIVE)/:191-193(IS_ARRAY/IS_NOT_NULL),非 :30-100
> - **accessBackend.hpp 在 share/oops/ 不在 gc/shared/**: BarrierType 枚举 :60-71,AccessFunction 模板 :126-146
> - **G1 汇编序列编造**: 真实是 write_ref_field_pre(g1BarrierSet.inline.hpp:36-46,读旧值非空则 enqueue,SATB)+ write_ref_field_post(:48-56,byte_for 取卡,young 卡跳过否则慢路径);"3 条指令 2 cycles"等耗时数字删除
> - **SATB 是"开始时刻快照"不是"增量更新"**(增量更新是相反策略)
> - **SATB buffer 大小(1KB)编造**: 只讲机制(线程本地 buffer 满转全局队列,g1BarrierSet.cpp:71)
> - **OopHandle 不是 OopStorage index**: 就是 `oop*` 封装(oopHandle.hpp:38-55,注释"封装帮助命名+为未来读屏障留位");resolve=NativeAccess<>::oop_load(oopHandle.inline.hpp:31-33)
> - **WeakHandle 不是"OopHandle+weak tag"**: 是存在**弱处理 OopStorage** 的 oop*(weakHandle.hpp:45-60,"This is the vm version of jweak");强/弱=不同 OopStorage 实例,非槽位 tag
> - card_shift=9 → card_size=512(cardTable.hpp:231-232);byte_for=base[p>>card_shift](:153-158)

### 1. Access API — 模板元编程的 Barrier 装饰器

场景: `this.region = anotherRegion` (G1 GC)——JIT 生成的代码不是 `mov [rax+offset], rbx`——而是 GC barrier 包围的 store: `mov + shr card_shift + mov byte 0`——额外 2 cycles 但换来了毫秒级 GC。

**Access<> 模板** (`access.hpp:60-200` + `access.inline.hpp`):
- `Access<decorators>::load(oop, offset)` — 受 barrier 保护的 oop 加载
- `Access<decorators>::store(oop, offset, value)` — 受 barrier 保护的 oop 存储
- `Access<decorators>::atomic_cmpxchg(oop, offset, old, new)` — 受 barrier 保护的 CAS
- [C++: 模板元编程——Decorator 通过 using 组合——`Access<IN_HEAP | MO_RELAXED>::store`。编译期展开——不同 GC (G1/Z/Shenandoah) 有不同 BarrierSet 后端——编译期选——**零运行时 dispatch**]
- 源码链: `access.hpp` 模板入口 → `accessBackend.hpp` `BarrierSet::AccessBarrier<>` 分派 → `gc/shared/barrierSet.hpp` 虚基类 → `gc/g1/g1BarrierSet.hpp` G1 SATB+card table 实现

**装饰器类型** (`accessDecorators.hpp:30-100`):
- `AS_RAW`: no barrier — 用于 VM internal
- `IN_HEAP` / `IN_NATIVE`: heap object / off-heap native memory
- `MO_UNORDERED` (relaxed) / `MO_RELAXED` / `MO_ACQUIRE` / `MO_RELEASE` / `MO_SEQ_CST`: C++ memory_order 映射
- [C++: 装饰器组合——`Access<IN_HEAP | MO_UNORDERED>::load`——展开为虚函数 dispatch——虚表指针在 BarrierSet 单例——每次调用 ~1 cycle 虚函数开销]

**G1 的 pre-barrier + post-barrier** (`g1BarrierSet.hpp/inline.hpp`):
- Pre-barrier (SATB): store 前——记录旧值到 SATB buffer——concurrent mark 用
- Post-barrier (card table): store 后——写 card table entry——G1 的 remembered set
- [x86: G1 post-barrier 3 条指令——`mov [rax+offset], rbx` (store)→`shr rax, CardTable::card_shift` (card index)→`mov byte [card_table + rax], 0` (mark dirty)——额外 2 cycles——OoO CPU 上被 pipelined——实际额外延迟 ~0.5-1 cycle/store]
- [C++: SATB buffer——每 Java 线程有独立 SATB buffer (1KB)——pre-barrier 只做 `*buf++ = old_value`——buffer 满→移到全局 SATB queue→concurrent mark 处理。正常路径只需一次 store——极快]

### 2. OopHandle / WeakHandle — GC-safe OOP 引用

**OopHandle** (`oopHandle.hpp:30-80`):
- 替代 JNIHandle——OopStorage 中的 index——更轻量
- [C++: OopHandle = OopStorage 中的 slot index。GC 后 OopStorage 被批量更新 (forwarding)。`OopHandle::resolve()`→取 OopStorage→`oop* adr = storage->obj_at(index)`→return *adr]

**WeakHandle** (`weakHandle.hpp:30-80`):
- 弱引用: "仅此引用"时允许 GC 回收——resolve 返回 null
- [C++: WeakHandle = OopHandle + weak tag。OopStorage 分配时标记 slot 为 weak——GC 扫描时: slot 中 oop 只有 weak 引用→允许回收→set slot=null]

---

### 核心悬念

**"`this.field = value`——3 条 x86 指令: store+shr+mov——2 cycles 额外开销——换来 G1 的毫秒级 GC。"** — 没有 barrier——GC 全堆扫描 (stop-the-world 几分钟)。有了 card table——GC 只需扫描 dirty cards——毫秒级。下一篇: Symbol——成千上万次 "java/lang/String" 怎么只存一次。

> → [06-symbol-annotations-aux.md](06-symbol-annotations-aux.md)
