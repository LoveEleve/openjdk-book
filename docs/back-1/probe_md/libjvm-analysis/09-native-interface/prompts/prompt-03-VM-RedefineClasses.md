# PROMPT: 请撰写 03-VM-RedefineClasses.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**VM_RedefineClasses — 以 JVMTI 类重定义为案例，验证 [08-safepoint] 阶段学到的 VM_Operation 框架的通用性**

### 核心故事线（禁止做源码翻译机！）

[08-01] 拆解了 safepoint 的 begin/end 协议——`SafepointSynchronize::begin()` 中 `Threads_lock->lock()` 冻结所有 JavaThread。[08-03] 拆解了 VM_Operation 框架——`Mode` 决策（`_safepoint` vs `_no_safepoint`）、`VMOperationQueue` 的 add/remove、`VMThread::loop()` 的事件循环、`doit_prologue()` 门禁。但 [08-03] 里所有例子都是 GC 的 `VM_Operation` 子类（`VM_G1CollectForAllocation`、`VM_CollectForMetadataAllocation`）——读者学完后可能会问："这套框架是不是 GC 专用的？"

**本文的使命就是用非 GC 的 VM_Operation 子类——`VM_RedefineClasses`——验证这套框架的通用性。** 读者已经知道 `Mode::_safepoint`、`VMOperationQueue`、`doit_prologue()`、`evaluate()`→`doit()` 的调用链，现在换一个完全不同的操作对象：不是 GC，而是 JVMTI 的类重定义。框架的每一环都照样工作——因为它本来就设计成通用的。

更关键的是：`VM_RedefineClasses::allow_nested_vm_operations()` 返回 `true`，这意味着 redefine 进行中 GC 还可以发生。**这引出了全书唯一的一个问题：嵌套的 GC VM_Operation 怎么在一个已经在进行的 safepoint 中执行？** VMThread 已经在 safepoint 里了，`begin()` 再被调用不会 assert 吗？答案是 VM_Operation 框架有一个特殊的嵌套执行路径——`execute()` 的 else 分支（`vmThread.cpp:747-779`），正是为 `allow_nested_vm_operations() == true` 设计的。

**本文的核心叙事线不是"redefine 怎么修改 class file"——那是 JVMTI 手册的内容。本文的叙事线是"把 [08-01][08-02][08-03] 学到的每一个机制点，在 VM_RedefineClasses 上重新验算一遍"。** 从 `JvmtiEnv::RedefineClasses()` 调用 `VMThread::execute()` 入队，到 `VMThread::loop()` 取出并执行，到 `doit()` 中的 `MetadataOnStackMark`、到嵌套 GC 的特殊路径，到 `doit_epilogue()` 回到 JavaThread——每一步都和 [08] 的 GC 路线做对比。

### 核心叙事线

1. **★ `VM_RedefineClasses` 的类层次 — 重写 [08] 学到的每个虚函数** — `VM_RedefineClasses` 继承 `VM_Operation`（`jvmtiRedefineClasses.hpp:338`）。`evaluation_mode()` **不 override**——继承基类默认返回 `_safepoint`（`vmOperations.hpp:195`）。`allow_nested_vm_operations()` override 返回 `true`（`jvmtiRedefineClasses.hpp:538`）。**`doit_prologue()` override（`jvmtiRedefineClasses.cpp:115-181`）做参数校验 + `lock_classes()` + `load_new_class_versions()`——如果失败返回 false → 操作不入队。** 这和 [08-03] 中 `VM_GC_Operation::doit_prologue()` 获取 `Heap_lock` 完全不同——证明 `doit_prologue()` 是每个子类自由定义的"门禁"，不是什么"GC 专用入口"。

2. **★★ 从 JVMTI API 到 VM_Operation 入队 — 完整路径** — `JvmtiEnv::RedefineClasses()`（`jvmtiEnv.cpp:457-462`）→ 构造 `VM_RedefineClasses op(class_count, class_defs, jvmti_class_load_kind_redefine)` → `VMThread::execute(&op)`（`vmThread.cpp:686`）→ `op->doit_prologue()` → 入 `_vm_queue` → 获取 ticket → 阻塞等待 `VMOperationRequest_lock`。★ 对比 `JvmtiEnv::RetransformClasses()`（`jvmtiEnv.cpp:393-451`）：redefine 的 class bytes 由调用方提供，retransform 的 class bytes 由 `JvmtiClassFileReconstituter` 从 VM 内部反编译恢复——两者最终都走到同一个 `VM_RedefineClasses` op，只是 `_class_load_kind` 不同。

3. **★★★ `VMThread::execute()` 中的嵌套路径 — 如何在一个 safepoint 内再执行另一个 VM_Operation** — `execute()` 的第 747 行开始有一个 `else` 分支（当调用方是 VMThread 自己时触发）：检查外层 op 的 `allow_nested_vm_operations()` → 如果内层 op 需要 safepoint 但当前不处于 safepoint → 调用 `SafepointSynchronize::begin()` + `op->evaluate()` + `SafepointSynchronize::end()`；如果当前已经在 safepoint → **直接 call `op->evaluate()`，不再调 begin/end**。追问：**嵌套 GC 在 redefine 中发生时，VMThread 的确在 safepoint 中——`begin()` 不重复调用，跳过了 `Threads_lock->lock()`**（否则会死锁）。这就是 `allow_nested_vm_operations()` 的真正含义：允许内层 op 绕过 `begin()/end()`，直接 `doit()`。

4. **★★ `doit()` 内部 — redefine_single_class + MetadataOnStackMark + 为什么必须在 safepoint 中** — `doit()`（`jvmtiRedefineClasses.cpp:183-239`）：创建 `MetadataOnStackMark`（L204：标记所有栈上的 Method* 防止过早清理）→ 循环调用 `redefine_single_class()`（L208-210）→ `MethodDataCleaner` 清理已死的 MethodData → `ResolvedMethodTable` 更新 JSR-292 条目 → `JvmtiExport::set_has_redefined_a_class()`（L226）。★ 关键在于：Method 的 `_from_compiled_entry` 被替换时，所有线程必须停止执行→ 如果不停止→ 线程可能正在执行旧方法的已编译代码（nmethod，在 code cache 中）→ 修改入口点会导致不一致状态。追问：**已编译的 nmethod 怎么处理？** → `redefine_single_class()` 调用 `method->set_code(NULL)` 清除 nmethod 关联→ 触发 `Flushable` 清理→ nmethod 在 GC 时被回收或显式 flush。

5. **★★ `merge_cp_and_rewrite()` — Constant Pool 合并在 safepoint 中安全吗？** — `merge_cp_and_rewrite()`（`jvmtiRedefineClasses.cpp:1567-1703`）：创建新的合并 CP → 分配 `_index_map_p` 映射数组（`scratch CP index → merge CP index`，L1608-1614）→ `merge_constant_pools()`（L1620）→ `rewrite_cp_refs()` 重写字节码中的 CP 索引（L1686-1689）→ `set_new_constant_pool()` 替换 scratch CP（L1693-1699）。★ 为什么必须在 safepoint 中？→ 修改 CP 引用时，没有线程在执行旧 CP 的解析——如果不用 safepoint→ 一个线程正在 `ldc` 读取旧 CP 条目→ 另一个线程替换 CP→ 读到中间状态的 CP→ 崩溃。追问：**merge 的大小怎么规划？** → `old_cp->length() + scratch_cp->length()`（L1570）→ 最坏情况是所有旧 + 新条目→ 完成后用 `set_new_constant_pool()` 缩小到实际大小。

6. **★ `doit_prologue()` 的"锁"策略 — 不是 Heap_lock，是 `RedefineClasses_lock`** — `lock_classes()`（L153）：获取 `RedefineClasses_lock`，标记所有目标类 `is_being_redefined(true)`。`load_new_class_versions()`（L156）：**在 JavaThread 上执行（不是 VMThread）**——做 class parsing、linking、CP merging、bytecode rewriting。追问：为什么不在 `doit()` 中做？→ `doit_prologue()` 在 JavaThread 上执行→ 可以安全分配 Handle、抛异常、等锁（不是 safepoint）。如果放在 `doit()` 中→ 在 VMThread 上执行→ 不能分配 Handle、不能等任意锁→ 非常受限。

7. **★ `doit_prologue()` 失败 → `doit()` 不执行 — 和 GC 对比** — 如果 `load_new_class_versions()` 失败（L157-177）：→ 释放已创建的 `_scratch_classes` → `unlock_classes()` → 返回 `false` → `VMThread::execute()` 的 L698-700 直接 `return` **不入队**。对比 GC 的 `doit_prologue()`：如果 `skip_operation()` 返回 false → GC 也不入队。验证了 [08-03] 学到的框架规则：`doit_prologue() == false` → 操作取消。

8. **★ 嵌套 safepoint 的"GC 在 redefine 中发生"具体场景** — redefine `load_new_class_versions()` 中分配 Metaspace（创建新的 ConstantPool、Method、Bytecodes 等）→ 如果 Metaspace 满 → `MetadataAllocationFailALot` → 触发 `VM_CollectForMetadataAllocation` → 此 GC VM_Operation 的 `allow_nested_vm_operations()` 也是 `true` → 走嵌套执行路径 → 直接 `evaluate()` → GC 执行 → `Universe::heap()->collect()` `MetadataAllocationFailALot` → Metaspace 释放 → redefine 继续。

### 禁止行为

- ❌ 把 `jvmtiRedefineClasses.cpp` 的 4000 行当"源码注释翻译"——只聚焦 `VM_RedefineClasses` 类的方法覆盖 + VM_Operation 框架交互
- ❌ 解释 JVMTI 规范（RedefineClasses 能改什么、不能改什么、JVM TI 版本兼容性）——这属于 JVMTI 手册的内容，和本文的"VM_Operation 框架验证"主线无关
- ❌ 深入解释 `merge_cp_and_rewrite()` 的 CP 条目合并算法——只需要解释"为什么在 safepoint 中做"，不需要解释 "CONSTANT_String 怎么映射"
- ❌ 忘记 [08-03] 的 VM_Operation 框架——每提到一个框架点，必须引用 [08-03] 的具体节
- ❌ 忽略 `doit_prologue()` 的"在 JavaThread 上执行"这一关键——它决定了 prologue 能做什么（Handle、异常、等锁）和 `doit()` 的本质差异
- ❌ 忽略嵌套 VM_Operation 的 `execute()` else 分支——这是答案"嵌套 GC 在 safepoint 内怎么执行"的唯一出处
- ❌ 只讲 RedefineClasses 不讲 RetransformClasses——两者的区别（class bytes 来源）能体现 `_class_load_kind` 的作用
- ❌ 不做和 GC VM_Operation 的逐项对比——每分析一个 `VM_RedefineClasses` 的方法，必须对比 [08-03] 中 GC 子类的对应方法
- ❌ 忽略 [01-ThreadState] 和 [09-04] 的前置知识——`ThreadInVMfromNative` 在调用 `VMThread::execute()` 前已经构造好

### 要求行为

- ✅ **★ `VM_RedefineClasses` 类层次图** — 展示继承关系、每个 override 的行号、每个虚函数的默认值和 override 值
- ✅ **★ 完整的时间线** — JavaThread 调用 → doit_prologue → 入队 → VMThread 取出 → begin() → doit() → end() → epilogue → 返回。标注每个阶段的线程身份（JavaThread vs VMThread）和线程状态
- ✅ **★ 嵌套 VM_Operation 执行流程图** — `execute()` L747 else 分支的 4 条路径：需要 safepoint + 不在 safepoint → begin/evaluate/end；需要 safepoint + 已在 safepoint → 直接 evaluate；不需要 safepoint + 不在 safepoint → 直接 evaluate；不需要 safepoint + 已在 safepoint → 直接 evaluate
- ✅ **★ 和 GC VM_Operation 的逐项对比表** — `evaluation_mode`, `doit_prologue`, `doit`, `doit_epilogue`, `allow_nested_vm_operations`, 是否持有 Heap_lock, ticket 等待行为
- ✅ **★ GDB 可证伪断言 ≥10 条** — 嵌套 GC 在 redefine 中的调用栈、`_state` 在 safepoint 中的值、`MetadataOnStackMark` 的效果验证
- ✅ **★ 和 [08-01][08-02][08-03] 的交叉引用** — 每个 VM_Operation 框架点都精确引用节号
- ✅ **★ 和 [09-01] 的连接** — `ThreadInVMfromNative` 在 JVMTI 调用前已构造，保证线程在 `_thread_in_vm` 状态

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `jvmtiRedefineClasses.hpp` | `src/hotspot/share/prims/jvmtiRedefineClasses.hpp` | prims | `VM_RedefineClasses` 类定义(:338)、`allow_nested_vm_operations()`(:538)、`doit_prologue()`(:534)、`doit()`(:535)、`doit_epilogue()`(:536) | ★★★ 本文主角 — VM_Operation 子类定义 |
| 2 | `jvmtiRedefineClasses.cpp` | `src/hotspot/share/prims/jvmtiRedefineClasses.cpp` | prims | `doit_prologue()`(:115-181)、`doit()`(:183-239)、`doit_epilogue()`(:241-264)、`merge_cp_and_rewrite()`(:1567-1703)、`redefine_single_class()`、`load_new_class_versions()` | ★★★ 实现文件 — 全部核心逻辑 |
| 3 | `vmOperations.hpp` | `src/hotspot/share/runtime/vmOperations.hpp` | runtime | `VM_Operation::Mode` 枚举(:136-141)、基类虚函数默认值(:180-196)、`evaluate()`(:171) | ★★ 基类框架定义 |
| 4 | `vmThread.cpp` | `src/hotspot/share/runtime/vmThread.cpp` | runtime | `execute()`(:686-780) 含嵌套 else 分支(:747-779)、`loop()`(:465-659)、`evaluate_operation()`(:411-443) | ★★★ 入队+嵌套路径 |
| 5 | `vmOperations.cpp` | `src/hotspot/share/runtime/vmOperations.cpp` | runtime | `VM_Operation::evaluate()`(:58-77) → `doit()` | ★ evaluate→doit 桥接 |
| 6 | `jvmtiEnv.cpp` | `src/hotspot/share/prims/jvmtiEnv.cpp` | prims | `RedefineClasses()`(:457-462)、`RetransformClasses()`(:393-451) | ★★ JVMTI 入口 → VM_Operation 构造 |
| 7 | `safepoint.cpp` | `src/hotspot/share/runtime/safepoint.cpp` | runtime | `SafepointSynchronize::begin()`、`end()` | ★ 嵌套场景中 begin/end 的调用条件 |
| 8 | `interfaceSupport.inline.hpp` | `src/hotspot/share/runtime/interfaceSupport.inline.hpp` | runtime | `ThreadInVMfromNative` ctor/dtor (:268-273) | ★ JVMTI 调用前已构造 |

**跨模块说明**：`jvmtiEnv.cpp`（prims）→ `VMThread::execute()`（runtime）→ `VM_RedefineClasses`（prims）→ `SafepointSynchronize::begin()`（runtime）。操作在 prims 和 runtime 之间来回穿梭，每个线程身份切换点都值得标记。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ `VM_RedefineClasses` 的类层次 — 重写 [08-03] 学到的每个虚函数

```
问题：
  ① VM_RedefineClasses 继承了 VM_Operation 的哪些虚函数？哪些 override 了？哪些没有？
     线索: jvmtiRedefineClasses.hpp:338-539, vmOperations.hpp:134-214
     答案方向:
     - type() → override → VMOp_RedefineClasses (jvmtiRedefineClasses.hpp:533)
     - evaluation_mode() → 不 override → 继承默认 _safepoint (vmOperations.hpp:195)
     - allow_nested_vm_operations() → override → true (jvmtiRedefineClasses.hpp:538)
     - doit_prologue() → override → 参数校验+lock_classes+load_new_class_versions (jvmtiRedefineClasses.cpp:115-181)
     - doit() → override → redefine_single_class × N + MethodDataCleaner (jvmtiRedefineClasses.cpp:183-239)
     - doit_epilogue() → override → unlock_classes+free _scratch_classes (jvmtiRedefineClasses.cpp:241-264)
     追问: evaluation_mode() 为什么不 override？→ _safepoint 是正确选择——必须 STW。

  ② 为什么 VM_RedefineClasses 不继承 HasThreadWorkAgent？到底怎么判定是否需要 safepoint？
     线索: vmOperations.hpp:195
     答案方向: evaluation_mode() 直接返回 _safepoint → 只要这个 op 入队，VMThread 一定调用 begin()。
     不需要额外接口。HasThreadWorkAgent 是 [08-00] 级别的概念，不在 VM_Operation 层。

  ③ allow_nested_vm_operations() 返回 true 的"嵌套"具体指什么？
     线索: vmThread.cpp:747-779 (execute 的 else 分支)
     答案方向: 指 VM_RedefineClasses::doit() 执行期间（VMThread 在 safepoint 中），
     另一个 VM_Operation（如 GC）可以通过 VMThread::execute() 的嵌套路径直接 evaluate()，
     不重复调用 begin()/end()。嵌套分两种：(a) 同层嵌套——同一个 safepoint 内执行多个 op
     → loop() 的 coalesce 机制（L560-618）; (b) 递归嵌套——op 内部发起的另一个 op→ execute() 的 else 分支。

  ④ 静态数组 (_old_methods, _new_methods, _matching_*) 为什么是 static？
     线索: jvmtiRedefineClasses.hpp:342-351
     答案方向: 这些数组在 doit 执行期间被 ClassLoaderDataGraph::classes_do() 的闭合函数使用。
     因为是回调，不支持传参→只能用 static 变量暂存。epilogue 中清零。追问: 线程安全吗？
     → 因为 doit() 在 VMThread 上执行（单线程，safepoint 中），无竞争。
```

### 4.2 ★★ `doit_prologue()` 的"在 JavaThread 上执行"策略

```
问题：
  ① doit_prologue() 在哪个线程上执行？为什么不在 VMThread 上？
     线索: vmThread.cpp:698-700
     答案方向: 在调用 VMThread::execute() 的 JavaThread 上执行（入队前）。
     原因: (a) 可以分配 Handle—redefine 需要大量 Handle 操作（old_cp, scratch_cp, merge_cp）
     → VMThread 不创建 HandleMark；(b) 可以抛异常—如果 class bytes 无效 → THROW_MSG 返回 error；
     VMThread 不能抛异常；(c) 可以等锁—lock_classes() 等待 RedefineClasses_lock→VMThread 不能等锁。

  ② doit_prologue() 失败返回 false 的后果？
     线索: vmThread.cpp:698-700
     答案方向: execute() 立即 return→op 不入队→调用方线程不会阻塞等待 ticket。
     当前栈帧继续执行→调用方获取 op.check_error() → 错误码返回给 JVMTI agent。

  ③ load_new_class_versions() 做了什么？
     线索: jvmtiRedefineClasses.cpp:156（调用处）
     答案方向: 解析新的 class bytes（ClassFileParser）、验证、链接、merge_cp_and_rewrite()。
     全部在 doit_prologue 中完成（JavaThread 上）。如果成功→scratch_classes 数组就绪→
     然后 doit()（VMThread 上）只需要替换类的方法表→非常简单。

  ④ lock_classes() 和 RedefineClasses_lock 的作用域？
     线索: jvmtiRedefineClasses.cpp:153, 242
     答案方向: doit_prologue() 中获取 → doit_epilogue() 中释放。**跨越整个 VM_Operation 生命周期**
     （包括 doit() 期间）。目的: 防止两个线程同时 redefine 一个类。
```

### 4.3 ★★★ 嵌套 VM_Operation — GC 怎么在 redefine 期间执行

```
问题：
  ① 谁负责触发嵌套 GC？
     答案方向: redefine 在 load_new_class_versions() 或 merge_cp_and_rewrite() 中分配 Metaspace
     → Metaspace::allocate() 发现空间不足 → 触发 GC 请求 → VM_CollectForMetadataAllocation op 进入
     VMOperationQueue → 因为外层 op 的 allow_nested_vm_operations() 返回 true →
     VMThread 在 execute() 的 else 分支中拿到这个 GC op → 直接 evaluate()，不调 begin()。

  ② VMThread::execute() 的嵌套路径（L747-779）有哪几种情况？
     线索: vmThread.cpp:747-779
     答案方向: 共 4 种分支组合（需要safepoint × 已在safepoint）:
     (a) op需要safepoint + 当前在safepoint → 直接 op->evaluate()（最常用）
     (b) op需要safepoint + 当前不在safepoint → begin()+op->evaluate()+end()
     (c) op不需要safepoint + 当前在safepoint → 直接 op->evaluate()
     (d) op不需要safepoint + 当前不在safepoint → 直接 op->evaluate()
     追问: 当前不在 safepoint 怎么检测？→ SafepointSynchronize::is_at_safepoint() 返回 false。

  ③ begin() 在嵌套场景中会 assert 吗？
     线索: safepoint.cpp begin() 实现
     答案方向: 如果外层 VM_Operation 已经在 safepoint 中→_state == _synchronized →
     begin() 的开头可能有 assert(current_safepoint_state != _synchronized) 或等价检查。
     ★ 这就是为什么嵌套路径有"已在 safepoint→不调 begin()"分支——防止 assert fire。
     如果 assert 被绕过 → 第二次 begin() 会导致 Threads_lock 死锁（已经持有）。

  ④ VM_GC_Operation 有 allow_nested_vm_operations() == true 吗？
     线索: vmGCOperations.hpp VM_GC_Operation 定义
     答案方向: 只有部分 GC op override 为 true（如 VM_CollectForMetadataAllocation）。
     常规 GC（VM_G1CollectForAllocation）不需要嵌套——GC 不会触发另一个 GC。
     但 Metaspace GC 需要在 redefine 中触发 GC → 必须嵌套。
```

### 4.4 ★★ `doit()` 的核心操作 — 为什么必须在 safepoint 中

```
问题：
  ① MetadataOnStackMark 是什么？为什么必须在 doit() 开头创建？
     线索: jvmtiRedefineClasses.cpp:204
     答案方向: 标记所有线程栈上的 Method* → 防止 redefine 替换 Method 后旧 Method* 被立即
     回收→如果栈上还有 frame 引用旧 Method*→use-after-free。doit_epilogue() 析构后
     旧 Method* 才可安全回收。追问: 为什么不在 doit_prologue() 中做？→ doit_prologue
     在 JavaThread 上→此时它看不到其他线程的栈→需要 safepoint 把所有人冻结。

  ② redefine_single_class() 做了什么关键操作？
     答案方向: 将 InstanceKlass::methods() 数组中的 Method* 替换为新的 Method*；
     更新 method->set_code(NULL) 清除已编译的 nmethod；更新 vtable/itable；
     调整 Method 的 from_compiled_entry 和 from_interpreted_entry。
     追问: vtable 怎么更新？→ InstanceKlass::vtable()->adjust_method_entries()。

  ③ MethodDataCleaner 清理什么？
     线索: jvmtiRedefineClasses.cpp:212-216
     答案方向: 遍历所有类的 MethodData（MDO），删除指向已被删除方法的 MDO 条目。
     MethodData 中存储了 invocation_counter 和 branch profiling 数据→方法被删除后
     这些数据无意义→需要清理防止悬挂指针。

  ④ ResolvedMethodTable 更新是什么？
     线索: jvmtiRedefineClasses.cpp:219-222
     答案方向: JSR-292（MethodHandle / invokedynamic）解析缓存。MethodHandles 内部
     用 ResolvedMethodTable 缓存 MemberName → Method* 映射。redefine 改变了 Method*
     → 必须更新或清理这些缓存条目。
```

### 4.5 ★★ `merge_cp_and_rewrite()` — 在 `doit_prologue`（JavaThread）中执行，不在 safepoint 中

> ★ 已通过 `codegraph callers "VM_RedefineClasses::merge_cp_and_rewrite"` 验证：
> `merge_cp_and_rewrite` 的唯一调用者是 `load_new_class_versions`（jvmtiRedefineClasses.cpp:1257），
> 而 `load_new_class_versions` 由 `doit_prologue()`（cpp:156）调用。doit_prologue 在 JavaThread 上执行、
> **safepoint 之前**。doit()（cpp:183-239，VMThread 上、safepoint 期间）**不包含** merge_cp_and_rewrite。

```
问题：
  ① ★ 为什么 merge_cp_and_rewrite 在 doit_prologue（JavaThread）而不在 doit（VMThread + safepoint）中？
     答案方向: (a) doit_prologue 在 JavaThread 上 → 可以分配 Handle + ResourceMark → CP 合并需要大量临时对象；
     (b) doit_prologue 可以抛异常 → 如果 class bytes 非法 → THROW_MSG 返回 error 给 JVMTI agent；
     (c) safepoint 中不应该做大量 Metaspace 分配（可能触发嵌套 GC）→ doit_prologue 把这些"重活"提前做完，
     doit() 只需要做轻量的 Method 表替换。追问：如果合并失败 → doit() 不执行 → 和 [08-03] 的 GC doit_prologue 返回 false 对称。

  ② 为什么 allocate 新 CP 而不是复用旧 CP？
     答案方向: 旧 CP 被多个 Method 的字节码引用（CP index 硬编码在 bytecode 中）。
     直接修改会导致 CP index 映射混乱。新 CP 分配后→rewrite_cp_refs() 遍历所有
     方法的所有字节码→把 CP index 从旧值替换为新值（按 index_map 映射）。

  ③ merge_constant_pools() 做了哪种合并？
     答案方向: 遍历 scratch_cp 的所有条目，对每个条目检查 old_cp 中是否有等价条目。
     有 → 记录映射 scratch_index → old_index（index_map[scratch_i] = old_i）；
     无 → 复制到 merge_cp → 记录映射 scratch_index → merge_index。

  ④ rewrite_cp_refs() 怎么重写字节码？
     答案方向: 遍历所有方法的 CodeBuffer→对每条指令检查 opcode→如果是 cp 引用类
     （ldc, ldc_w, getfield, invokevirtual, etc.）→取出旧的 cp_index →查 index_map
     →替换为新 cp_index→写回字节码。
```

### 4.6 ★ `RetransformClasses` 和 `RedefineClasses` 的区别

```
问题：
  ① RetransformClasses() 的 class bytes 从哪来？
     线索: jvmtiEnv.cpp:427-445
     答案方向: 检查 InstanceKlass 中是否有缓存。有缓存（cached_class_file_bytes）→ 直接读取；
     无缓存 → JvmtiClassFileReconstituter 从 VM 内部结构（CP、Methods、Fields、Attributes）
     **反编译**出 class file。反编译不能恢复所有细节（如 LineNumberTable 位置、StackMapTable 精确表示）
     → 和原始 class bytes 不等价但语义等价。追问: 哪些类有缓存？→ 通过 JvmtiClassFileReconstituter::
     get_cached_class_file() 判断。加载时有 -XX:+TraceClassLoading 就保留。

  ② 两者的 _class_load_kind 区别？
     答案方向: RedefineClasses → jvmti_class_load_kind_redefine；RetransformClasses →
     jvmti_class_load_kind_retransform。这影响 ClassFileParser 行为（如是否允许方法体变化）。

  ③ 为什么 VM_RedefineClasses 构造函数如此简单（只存 4 个字段）？
     线索: jvmtiRedefineClasses.cpp:68-76
     答案方向: 构造函数只复制参数指针（class_count, class_defs, class_load_kind）—
     不拷贝 class_bytes。bytes 是在 load_new_class_versions() 中解析的。这要求调用方
     在 VM_Operation 完成前保持 class_defs 内存有效性 — JVMTI agent 的职责。
```

### 4.7 ★ `VMThread::loop()` 中的 coalesce — 同一个 safepoint 执行多个不相关的 VM_Operation

```
问题：
  ① loop() 中 "coalesce safepoint ops" 是什么意思？
     线索: vmThread.cpp:560-618
     答案方向: VMThread 在 begin() 后、处理 _cur_vm_operation 的同时，检查 _vm_queue 是否
     有更多 safepoint-mode op 到达→把它们全部取出→在一个 safepoint 内批量执行→
     避免 begin/end 的开销。追问: 非 safepoint op 也会被 coalesce 吗？→ 不会，_no_safepoint
     和 _concurrent 的 op 单独处理。

  ② 嵌套 GC 和 coalesce GC 的区别？
     答案方向: coalesce 是 loop() 层面的——多个 op 在同一个 safepoint 中顺序执行；
     嵌套是 execute() 的 else 分支——一个 op 的 doit() 内部触发另一个 op。
     前者是"一起排队"，后者是"子调用"。追问: 类重定义 + 另一个 JVMTI 操作（如 PopFrame）
     可以 coalesce 吗？→ 可以，如果两者都是 _safepoint 模式且在 VMThread 拿到锁之前入队。
```

## 五、文章结构

```
§〇 源文件清单（跨 prims + runtime，标注模块归属和每个文件在 VM_Operation 框架中的角色）

§一 ★★★ VM_RedefineClasses 类层次 — 逐虚函数重写 [08] 的框架
  ❓ 哪些虚函数 override 了？哪些用默认值？
  ❓ 为什么 allow_nested_vm_operations() 必须是 true？
  1.1 类继承图 — VM_Operation 基类的虚函数表 + VM_RedefineClasses 的覆写
  1.2 evaluation_mode 为什么用默认 _safepoint
  1.3 allow_nested_vm_operations() = true 的"嵌套"语义
  1.4 静态数组的设计考量（为什么 static，为什么线程安全）

§二 ★★ 从 JVMTI API 到 VM_Operation 入队 — 完整路径对比 [08-03]-GC
  ❓ 和 VM_G1CollectForAllocation 入队路径有什么相同和不同？
  ❓ 为什么 redefine 需要 doit_prologue() 做大量工作而 GC 的 doit_prologue() 很简单？
  2.1 JvmtiEnv::RedefineClasses() → VMThread::execute() 的 8 步流程
  2.2 JvmtiEnv::RetransformClasses() 的特殊入口（class bytes 反编译）
  2.3 doit_prologue() 在 JavaThread 上执行的关键意义 — vs VMThread 的限制
  2.4 ticket 等待 + VM_Operation_lock 阻塞 — [08-03] 验证

§三 ★★★ doit() 内部 — modify class + 嵌套 safepoint
  ❓ MetadataOnStackMark 保护了什么？如果不用它会怎样？
  ❓ MethodData 清理为什么需要 safepoint？
  3.1 doit() 的 7 步操作（MethodMark → redefine_single_class → MDO 清理 → JSR-292 → flag → CheckClass）
  3.2 redefine_single_class() 的 method table 替换细节
  3.3 已编译 nmethod 的处理——set_code(NULL) + 后续 flush
  3.4 ★ 嵌套 GC 的精确调用栈 — 如何从 Metaspace 分配失败走到 VM_CollectForMetadataAllocation::evaluate()

§四 ★★★ 嵌套 VM_Operation 执行机制 — execute() 的 else 分支
  ❓ 为什么嵌套 GC 不重复调用 begin()？
  ❓ begin() 中有哪些 assert 会阻止第二次调用？
  4.1 execute() else 分支的 4 路径分支（需要safepoint × 已在safepoint）
  4.2 嵌套 GC 在 redefine 中的真实场景—Metaspace 分配失败
  4.3 和 coalesce（同一个 safepoint 批量执行多个 op）的区别
  4.4 allow_nested_vm_operations() 的隔离 — 为什么不是所有 op 都允许嵌套

§五 ★ merge_cp_and_rewrite() — Constant Pool 合并在 doit_prologue（JavaThread）中，不在 safepoint 中
  ❓ 为什么 merge 在 doit_prologue 而不是 doit 中？→ 因为需要 Handle + 可抛异常 + 避免 safepoint 中的重量分配
  5.1 合并算法: merge_constant_pools() + index_map 映射
  5.2 rewrite_cp_refs() 的字节码重写 — 对每条 cp 引用指令的修改
  5.3 和 doit() 的 method table 替换的关系 — prologue 做重活，doit 做轻量替换

§六 ★★ 和 [08-01][08-02][08-03] 的交叉验证
  ❓ 每一环是否和 GC VM_Operation 一致？
  ❓ VM_Operation 框架为 GC 设计——还是通用？
  6.1 [08-03]§二 VM_Operation 基类虚函数 — 逐一对标 VM_RedefineClasses
  6.2 [08-03]§三 VMOperationQueue 入队 — redefine 的入队过程验证
  6.3 [08-01]§二 Safepoint begin/end — redefine 使用 begin/end 的验证
  6.4 [09-01]§二 ThreadInVMfromNative — 调用 VMThread::execute() 前线程已进入 VM 状态

§七 GDB 验证 + 可证伪断言（≥12 条）
  断言 1: VM_RedefineClasses 的 evaluation_mode 确实是 _safepoint（GDB 观察 vmOp 的 mode 字段）
  断言 2: doit_prologue() 执行在 JavaThread 上（线程状态 _thread_in_vm）
  断言 3: doit() 执行在 VMThread 上（_state == _synchronized）
  断言 4: allow_nested_vm_operations() == true 的确认
  断言 5: RedefineClasses_lock 在 doit_prologue 获取、doit_epilogue 释放
  断言 6: MetadataOnStackMark 创建后旧 Method* 的标记状态
  断言 7: 嵌套 GC 的调用栈 — VMThread::execute() else 分支 → VM_CollectForMetadataAllocation::evaluate()
  断言 8: merge_cp_and_rewrite 后旧 CP 是否仍被引用
  断言 9: doit_epilogue() 后 _scratch_classes 被 free → 内存不可访问
  断言 10: _class_load_kind 的 jvmti_class_load_kind_redefine vs retransform 值对比
  断言 11: VMOperationQueue 中 VM_RedefineClasses 的 _next/_prev 链接验证
  断言 12: 同一个 safepoint 内执行了 redefine 的 doit() + 后续 coalesce 的 GC op

  可证伪断言 1: 如果 doit_prologue 返回 false → doit 不会执行（断点 set doit 不命中）
  可证伪断言 2: 嵌套 GC 不调用 begin() → begin() 的断点只命中一次（外层 redefine 的）
  可证伪断言 3: 已经编译的 nmethod 被 set_code(NULL) 后 → code cache 中仍存在（未 flush）
```

## 六、写作要求

1. **★ `VM_RedefineClasses` 类是第一个核心交付物**：读者看完继承树和每个虚函数的行号对照后，能在脑子里画出"这个类在 VM_Operation 框架中插入了哪些接口"。

2. **★ `doit_prologue()` 的"在 JavaThread 上执行"是全文最关键的架构决策**：不是偶然——它是设计决定的。prologue 在 JavaThread 上意味着可以分配 Handle、抛异常、等锁；doit 在 VMThread 上意味着这些都不行。每提到一个操作都必须标注它属于哪个阶段（prologue vs doit）和在哪个线程上。

3. **★ 嵌套 GC 是本文的"aha moment"**：读者读到 `allow_nested_vm_operations() == true` 时可能会困惑——什么叫"嵌套"？通过 Metaspace 分配失败 → GC → 直接 evaluate() 的完整故事线，让读者体验 [08-03] 中未涉及的框架高级特性。

4. **★ 和 [08-03] 的对比表必须逐项**：`evaluation_mode`、`doit_prologue` 内容、`doit` 内容、`allow_nested`、持有的锁、ticket 等待。每项都有"相同/不同/+ 解释"。

5. **★ `merge_cp_and_rewrite()` 不要深入算法细节**——这不是本文的职责。只需要解释"为什么在 safepoint 中做"和"如果不在 safepoint 做会有什么竞态风险"。

6. **★ GDB 断言必须可执行**：指定确切的 breakpoint（如 `br jvmtiRedefineClasses.cpp:115`）、运行时条件（`-agentlib:jdwp` 或自定义 JVMTI agent）、预期调用栈。

7. **RetransformClasses vs RedefineClasses**：两者的入口差异（class bytes 来源）是理解 `_class_load_kind` 的钥匙——不是 JVMTI API 对比，而是"同一个 VM_Operation 子类如何用 enum 区分两种 JVMTI 操作"。

## 七、输出格式

- Markdown 文件，命名为 `03-VM-RedefineClasses.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/09-native-interface/`
- 元信息头（标准环境 + 源文件清单 + 前置 [08-01][08-02][08-03][09-01] + 阅读收益 + "VM_Operation 框架非 GC 应用的验证"的说明）
