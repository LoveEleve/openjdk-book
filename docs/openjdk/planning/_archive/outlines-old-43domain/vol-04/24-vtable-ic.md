# VTable / Inline Cache — 文章大纲（Pass 1 修订版）

> vol-04 · 域 24 · 🟡 B | 基于 Pass 0+1 探索笔记
> Pass 1 产出：7 基本元素 / 7 标记问题
>
> **→ 从 Interpreter**：解释器执行 `invokevirtual`——但要怎么知道是 `Dog.speak()` 而不是 `Cat.speak()`？vtable O(1) 定位 + Inline Cache 篇。

## 概念依赖

依赖 OOPs（Klass 层级）+ CodeCache（IC stub 存储）。不依赖 Interpreter 或 JIT——vtable 在类链接阶段就建好了，IC 由 JIT 使用但本身是独立机制。

## 叙事计划

**开篇场景**：`Animal a = new Dog(); a.speak()`——编译时不知道 `a` 是 `Dog` 还是 `Cat`。字节码是 `invokevirtual Animal.speak`，JVM 需要在运行时找到实际类型（`Dog`）的 `speak()` 方法。两步：查 `Dog` 的 vtable 找到正确的 `Method*`（O(1) 偏移量），编译后的代码在调用点嵌入 Inline Cache——第一次调时解析类型，之后直接跳转，不再查表。

**第一层：vtable——虚方法表的物理布局**

`klassVtable`（`klassVtable.hpp:43`）是 Klass 内部的一块 `vtableEntry[]` 数组。`_tableOffset` 记录在 Klass 对象内的偏移——`method_at(i)` = `*(klass_base + _tableOffset + i * sizeof(vtableEntry))`。`initialize_vtable()` 填充：先 `copy_vtable_to()` 复制父类的 vtable（子类继承父类所有虚方法入口），再遍历子类方法——如果有 `override`，覆盖对应 entry；如果是新方法，追加到 vtable 末尾。

意外细节：`private` 方法也占 vtable slot（JDK-8024368）——子类可以定义同名 private 方法但不能覆盖。`final` 方法在 vtable 中但可以被 `patched_*` 优化为直接调用（`vtableEntry::patched_method()`）——跳过 vtable 间接寻址。

**第二层：itable——接口方法的间接查找**

`klassItable` 处理接口方法——接口方法没有固定 vtable 偏移。同一个接口的同一个方法在不同实现类中可能占不同的 vtable 位置。itable 是 `(klass, method_name)` → `itableEntry` 的映射表。`linkResolver` 做 `invokeinterface` 解析时（`linkResolver.cpp:74`），通过 `resolved_method()->itable_index()` 找到 index，在目标类的 itable 中查找具体实现。

itable 的并发初始化有 race condition（JDK-8226798）——两个线程同时为同一接口初始化 itable_entry，需要同步保护。

**第三层：CompiledIC——编译后代码的内联缓存**

`CompiledIC`（`compiledIC.hpp:164`）是 JIT 编译代码中 call site 的运行时优化器。编译时先填一个 `ICStub` 占位（未解析状态）→ 第一次调用时 `ICStub::finalize()` 解析 receiver 的实际类型 → `set_to_monomorphic()` 把 call site 改写为直接跳转到目标方法的入口地址。后续调用跳过所有解析——一次 `call` 指令直达。

当同一个 call site 遇到第二个不同的 receiver 类型时：IC 升级为 `megamorphic`——退化回 vtable 查找。`set_to_clean()` 可以把 megamorphic IC 重置为未解析状态——允许重新学习（如果之后 receiver 类型又稳定了）。

**第四层：InlineCacheBuffer——IC stub 的生命周期管理**

`InlineCacheBuffer`（`:384`）管理 IC stub 的创建、淘汰、重用。`create_transition_stub()` 在 CodeCache 中分配 stub。旧 stub 被淘汰时 `queue_for_release()` 延迟释放——可能有线程正在执行旧 stub。JDK-8203837 把 IC cleaning 从 `nmethod::flush()` 中分离：之前卸载 nmethod 时同步清理其内部所有 IC（IC 和 nmethod 强耦合），分离后 IC 有自己的清理周期——nmethod 可以独立 unload 而不影响其他 nmethod 中的 IC。

**第五层：跨域连接——谁用这些机制**

vtable 被 `linkResolver`（ClassFile 域的解析步骤）用来解析 `invokevirtual` 和 `invokeinterface` 字节码。IC 被 `C1_GraphBuilder`（`c1_GraphBuilder.cpp:2112`）在编译时嵌入调用点。C2 在优化阶段用 `CHA (Class Hierarchy Analysis)` 判断是否可以脱虚（devirtualize）——如果类层级中只有一个实现，直接把虚调用变成直接调用，连 IC 都不需要。

**设计权衡**

一、vtable vs itable 分离。vtable O(1) 但只覆盖类继承链。itable O(n) 但覆盖所有接口。Java 选择两者共存——单继承用 vtable（高频），多接口用 itable（低频但必须支持）。

二、IC monolmorphic vs megamorphic 退化。大部分 call site 只有一个 receiver 类型——IC 命中率 >90%。少数热点（`List.add()`）频繁换类型→退化避免 IC stub 爆炸。IC 还能从 megamorphic 重置——适应 receiver 类型模式变化。

## 核心悬念

**`a.speak()` 怎么找到正确的 `Dog.speak()`——编译时不知道类型，vtable O(1) 定位方法、Inline Cache 让 99% 虚调用变成一次直接跳转？**

**→ 下一域**：vtable 找方法、IC 加速调用——但 JIT 编译器需要知道当前编译的是哪个方法、有哪些字段、类层级是什么。它不能直接读 `InstanceKlass` 的内部数据结构——需要一层 ci（Compiler Interface）抽象。ci 篇见。

## 预估

1 篇，5 层递进，预估 1500-2000 行。
