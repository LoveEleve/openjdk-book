# VTable / Inline Cache — Pass 0+1 探索笔记

> vol-04 · 域 24 · 🟡 B | 2026-08-07

## Pass 0: 设计上下文

**关键 git 提交**：
- `942001236f` JDK-8024368: private 方法也占用 vtable 索引——子类可能定义同名 private 方法，不能重用父类的 vtable slot
- `3e3414dbf3` JDK-8203837: 将 IC cleaning 从 nmethod unloading 中分离——之前卸载 nmethod 时同步清理 IC，耦合了两套生命周期
- `4105c99e43` JDK-8216541: CompiledICHolders 释放太晚导致内存泄漏
- `4f6059033c` JDK-8226798: itable 初始化崩溃——接口方法表的并发初始化有 race condition

**演进趋势**：vtable/itable 机制本身稳定（Java 的虚方法分派逻辑不变），bug 集中在并发安全（itable 初始化）和生命周期管理（IC holder 释放）。

## Pass 1: 结构扫描

### 包结构
```
oops/klassVtable.hpp       — klassVtable(虚方法表) + klassItable(接口方法表)
oops/klassVtable.cpp       — 初始化 + 复制 + 重写逻辑
code/compiledIC.hpp/cpp    — CompiledIC(JIT 内联缓存) + ICStub + InlineCacheBuffer
code/icBuffer.hpp/cpp      — InlineCacheBuffer(IC 占位桩管理)
```

### 继承/关系图
```
Klass
  ├── klassVtable (vtableEntry[])     — 虚方法表
  │     └── used by: linkResolver(vtable_index resolution)
  │                 C1/C2 (编译时生成 vtable 偏移量直接调用)
  └── klassItable (itableEntry[])     — 接口方法表
        └── used by: linkResolver(itable_index resolution)

CompiledIC                             — 编译后代码中的内联缓存点
  ├── set_to_monomorphic()             — 单态：只见过一个 receiver 类型
  ├── set_to_megamorphic()             — 超多态：退化回 vtable 查找
  ├── used by: C1_GraphBuilder (生成 IC 占位桩)
  │            C2_Matcher (优化内联缓存布局)
  └── managed by: InlineCacheBuffer    — IC stub 创建/淘汰/重用
```

### 基本元素分解

1. **vtable**：`klassVtable`（`klassVtable.hpp:43`）——`vtableEntry[]` 数组，`_tableOffset` 记录在 Klass 内的偏移。`initialize_vtable()` → `copy_vtable_to()`（父类复制 + 子类覆盖）。`method_at(i)` 通过偏移直接读取——invokevirtual `index=3` = `vtable[3]`。

2. **itable**：`klassItable`——接口方法表。接口方法没有固定 vtable 偏移（不同接口的同一方法在不同类中可能占不同 vtable 位置），需要通过 itable 查找 `(klass, method_name)` → `Method*` 的映射。

3. **vtableEntry**：`vtableEntry`（`:190`）——存 `Method*` 的封装。`patched_*` 方法支持运行时动态 patch（如 `final` 方法优化→直接调用而非虚查表）。

4. **CompiledIC**：`CompiledIC`（`compiledIC.hpp:164`）——编译后 call site 的运行时缓存。编译时填一个 `ICStub` 占位→第一次调用时解析实际类型→patch 为直接跳转。`is_monomorphic()` / `is_megamorphic()` 判定当前状态。

5. **ICStub**：`ICStub`（`:62`）——IC 的"待解析"占位桩。第一次调时触发 `ICStub::finalize()` 解析 receiver 的实际类型，然后 `set_to_monomorphic()` 改写 call site。

6. **InlineCacheBuffer**：`InlineCacheBuffer`（`:384`）——管理 IC stub 的创建和淘汰。`create_transition_stub()` 生成过渡桩，旧 IC 被淘汰时 `queue_for_release()` 延迟释放（正在执行的线程可能还在用）。

7. **IC 拆离 nmethod 卸载**：JDK-8203837 把 IC cleaning 从 `nmethod::flush()` 中分离出来——之前卸载 nmethod 时同步清理 IC，导致 CodeCache 操作和 IC 操作耦合。分离后 IC 有自己的清理周期。

### 标记问题（≥5）

1. **vtable 和 itable 为什么分开？** vtable 用偏移直接索引（O(1)），itable 需要额外查找——为什么不能把接口方法也放进 vtable？接口方法在哪个 vtable 位置？不同实现的同一接口方法可能在不同类中占不同位置。

2. **private 方法为什么占 vtable slot？** JDK-8024368——子类可能定义同名 private 方法。编译器需要区分：`invokespecial` vs `invokevirtual` 在 vtable 分配时的影响。

3. **IC 从 monomorphic 退化到 megamorphic 的条件是什么？** 见过多少个不同 receiver 类型才退化？退化后的 `set_to_clean()` 怎么重置成"可重新学习"状态？

4. **ICStub 和 CompiledIC 的生命周期关联是什么？** nmethod 被 unload 时，它包含的 CompiledIC 怎么清理？IC stub 是 CodeCache 中独立的 blob——释放时机和 nmethod 不同。

5. **itable 并发初始化的 race condition 是什么？** JDK-8226798——两个线程同时走 `klassItable::initialize_itable_for_interface()`——哪里会出现 race？怎么修复的？

6. **InlineCacheBuffer 的 stub 重用机制是什么？** stub 用完了怎么办——是在 CodeCache 中分配新空间还是有预分配池？被淘汰的 stub 什么时候真正释放？

7. **final 方法的 vtable 优化是什么？** `vtableEntry::patched_*` 允许运行时把 final 方法的 vtable 条目 patch 成直接调用——跳过 vtable 间接寻址。这和 JIT 的 `CHA (Class Hierarchy Analysis)` 是什么关系？
