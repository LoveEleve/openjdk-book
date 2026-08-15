# 04. Runtime1 + FrameMap — C1 runtime 与栈帧

> **前置依赖**:[14-c1-compiler/03 — LinearScan + LIR → x86 码](03-c1-register-codegen.md):分配的 LIR 是 runtime 调用的载体;[08-interpreter/03 — 解释器怎么安全地调 C++?— InterpreterRuntime](openjdk/vol-02/08-interpreter/03-interpreter-runtime.md):IRT_ENTRY 家族在这篇,JRT 是它的对照;[09-memory-core/01 — Universe + CollectedHeap: JVM 的"宇宙大爆炸"](openjdk/vol-02/09-memory-core/01-universe-heap.md):allocate_instance 的对象分配底层
> → **后续**:[15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md):14 域收官,进入 C2
> 关联域: 19-sync(monitorenter 底层)、24-frame(帧布局)

## 编译器不会什么都自己干

`new Object()`、`monitorenter`、数组越界检查失败、首次调用方法……C1 编译代码遇到这些**复杂/罕见**的操作时,不是内联生成所有机器码,而是 **`call Runtime1::xxx` 跳到 C++**——Runtime1 是 C1 编译代码的"逃生口"。这篇拆两层: **Runtime1**(stub 清单、JRT_ENTRY 家族、慢路径语义)与 **FrameMap**(帧布局与 caller/callee save、OopMap 的真实构建位置)。顺带纠正大纲两个点: `new_instance` 的参数是 **`Klass*` 不是 ciKlass**;OopMap **不在 FrameMap 里构建**,而在 LinearScan 阶段。

## 1. Runtime1: 编译代码的 C++ 逃生口

Runtime1 的入口表由 **RUNTIME1_STUBS 宏**一次性生成(c1_Runtime1.hpp:40-65): `new_instance`/`fast_new_instance`/`new_type_array`/`new_object_array`/`new_multi_array`、`monitorenter`/`monitorexit`、`throw_range_check_failed`/`throw_div0_exception`/`throw_null_pointer_exception`、`handle_exception`、`slow_subtype_check`、`register_finalizer` 等。编译时 `generate_blob`(c1_Runtime1.cpp:194)把这些 stub 的**机器码编译进 CodeCache 的 blob**([实证](planning/outlines/00-jvm-tools/materials/commands/14-c1-runtime-frame-demo.txt)的 nmethod header 里 `stub code = 48` 就是内嵌 stub),运行时 `blob_for`(:279)取入口地址。

runtime 函数用 **JRT_ENTRY 家族**(JNI 兼容入口,08-03 域的 IRT_ENTRY 是解释器侧的对应物):

```cpp
// c1_Runtime1.cpp:346-359(截取核心,逐字)
JRT_ENTRY(void, Runtime1::new_instance(JavaThread* thread, Klass* klass))
  NOT_PRODUCT(_new_instance_slowcase_cnt++;)

  assert(klass->is_klass(), "not a class");
  Handle holder(THREAD, klass->klass_holder()); // keep the klass alive
  InstanceKlass* h = InstanceKlass::cast(klass);
  h->check_valid_for_instantiation(true, CHECK);
  // make sure klass is initialized
  h->initialize(CHECK);
  // allocate instance and return via TLS
  oop obj = h->allocate_instance(CHECK);
  thread->set_vm_result(obj);
JRT_END
```

三个关键点: **①参数是 `Klass*`(不是 ciKlass**——编译代码传的是运行时 Klass);②结果经 **`thread->set_vm_result(obj)`**(TLS)返回,不是函数返回值——这是 JRT_ENTRY 通道的约定(call 方从 vm_result 读回);③**这是慢路径**: `_new_instance_slowcase_cnt` 命名已经说明——TLAB 快速路径是**编译代码内联**的(LIRGenerator 的 new 处理直接内联 TLAB bump),只有 TLAB 满/类未初始化等才跳 Runtime1。`new_type_array`/`new_object_array`(:361-396)同理走 `oopFactory::new_*`;`monitorenter`(:693-704,JRT_BLOCK_ENTRY)与 `monitorexit`(:706-716,**JRT_LEAF**)都转 **`SharedRuntime::monitor_enter_helper/monitor_exit_helper`**(不是大纲说的 ObjectSynchronizer::fast_enter 直调)。**懒链接在 `patch_code`**(:834/:1271): 首次调用/字段访问时 resolve 目标并 **patch 编译代码里的地址**(access_field_patching_id/load_klass_patching_id/load_mirror_patching_id 等 stub),之后直接调用。

## 2. FrameMap: 帧布局与寄存器约定

`FrameMap` 的职责: 把"虚拟位置"(局部变量/栈槽/监视器)映射成**帧内偏移**。构造(:156)后 `_framesize` 由 monitor_base 偏移对齐算出(:190-191);x86 的寄存器编号约定在 `FrameMap::initialize`(c1_FrameMap_x86.cpp:160-206,如 `map_register(2, rbx)`/`map_register(3, rax)`,:166-167)与 **caller-save 数组**(`_caller_save_cpu_regs`,:203-206)——跨调用存活的值放 callee-save(如 rbx/r12-r15),调用点会死的放 caller-save(rax/rcx/rdx/rsi/rdi/r8-r11 等)。**OopMap 的真相**: 大纲说 "FrameMap::oop_map_slot 判断栈槽是否 OOP"——实际上 OopMap **在 LinearScan 阶段构建**(`init_compute_oop_maps` c1_LinearScan.cpp:2415 + `compute_oop_map` :2432-2442,按帧大小与参数槽数 `new OopMap`),FrameMap 只提供槽位偏移——GC 扫描编译帧时读的就是这个 OopMap([实证](planning/outlines/00-jvm-tools/materials/commands/14-c1-runtime-frame-demo.txt)的 nmethod header `oops = 8` 是 nmethod 的 oop 表)。

*关键设计: 编译代码只负责快路径(内联 TLAB/内联锁),一切"罕见但必须正确"的路径(分配失败/类型检查失败/异常/首次链接)都跳 C++*——这让编译代码保持简单,编译保持在毫秒级;runtime 与解释器共享同一批底层(allocate_instance/SharedRuntime 锁助手),只是调用通道不同(JRT vs IRT)。

## 3. 与解释器的分工 + 实证边界

解释器遇到同样的操作走 **InterpreterRuntime**(IRT_ENTRY,08-03 域),C1 编译代码走 **Runtime1**(JRT_ENTRY)——**底层共享**(都调 `InstanceKlass::allocate_instance`/`SharedRuntime` 助手),入口通道不同;Runtime1 的调用是编译代码里的直接 `call`(经 stub blob),[实证](planning/outlines/00-jvm-tools/materials/commands/14-c1-runtime-frame-demo.txt)的慢路径计数是 NOT_PRODUCT(release 不可观察),间接观察手段是 `-XX:-UseTLAB`(每次 new 都走 Runtime1::new_instance 慢路径,性能显著下降)。

## 核心悬念

14 域收官: C1 的完整画像——三大步管线(build_hir/emit_lir/emit_code_body)+ 单遍即时 Canonicalizer + 值编号(GVN)+ null/range check 消除 + LinearScan 分配(Range 链表/spill 选 use 最晚)+ LIR_Assembler 发码 + **Runtime1 逃生口**(JRT_ENTRY 家族、慢路径、懒链接 patch)+ FrameMap 帧布局(OopMap 在 LinearScan 构建)。C1 的全部目的: **毫秒级编译出"够用"的代码**。而"够用"之上的精雕细琢,是另一个编译器的事——**C2**: 它读同一份 profiling 数据,构建 IdealGraph,做 C1 做不了的全局优化。下一篇: C2 的 IdealGraph。

> → [15-c2-compiler/01 — C2 Ideal Graph: Node + Type + IGVN](openjdk/vol-02/15-c2-compiler/01-c2-ideal-graph.md)
