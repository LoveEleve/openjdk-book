# 05. Access API — 每次 oop.field = value 都有 GC 在旁听

> 🔴 Deep | 15 KP 中的 1 个核心机制 + OopHandle/WeakHandle
> 读者处境: `obj.field = new Object()`——JVM 不只是写内存——它在中间插入了 GC barrier。

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
