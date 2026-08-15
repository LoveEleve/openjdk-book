# 04. Runtime1 + FrameMap — C1 runtime 与栈帧

> 🔴 Deep | 11 KP 中的 2 个核心机制
> 读者处境: C1 编译的代码遇到 `new Object()`——不能原生分配——call `Runtime1::new_instance`→C++→TLAB 分配。Runtim1 是 C1 编译代码的"逃生口"。

> ⚠️ 写作期修正(2026-08-15, vol-02/14-c1-compiler/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"new_instance(JavaThread*, ciKlass*)" 半对(重要)**: 签名=`(JavaThread*, Klass*)`(c1_Runtime1.cpp:346,**Klass* 非 ciKlass**——编译代码传运行时 Klass);**JRT_ENTRY 家族**(JNI 兼容入口,08-03 已证 IRT 是解释器/JRT 是 JNI 通道);结果经 **`thread->set_vm_result(obj)`** TLS 返回(:358,非 return oop);**这是慢路径**——`_new_instance_slowcase_cnt` 命名说明一切,TLAB 快速路径是编译代码内联的(LIRGenerator new 处理),TLAB 满/类未初始化才跳 Runtime1
> - **"monitorenter→ObjectSynchronizer::fast_enter" 半对**: 真实=**SharedRuntime::monitor_enter_helper/monitor_exit_helper**(c1_Runtime1.cpp:693-716);monitorenter=JRT_BLOCK_ENTRY,monitorexit=**JRT_LEAF**
> - **"OopMap 在 FrameMap" 错(重要)**: OopMap **在 LinearScan 阶段构建**(init_compute_oop_maps c1_LinearScan.cpp:2415 + compute_oop_map :2432-2442,new OopMap(frame_size, arg_count));FrameMap 只提供槽位偏移
> - **"C1 stub c1_Runtime1.cpp:200-500" 行号偏**: StubID 枚举=RUNTIME1_STUBS 宏(c1_Runtime1.hpp:40-65+,new_instance/fast_new_instance/monitorenter/monitorexit/throw_*/handle_exception/slow_subtype_check);generate_blob(:194,buffer_blob 编译 stub 存 CodeCache,blob_for :279,_blobs[number_of_ids] hpp:123)
> - **行号**: c1_Runtime1.cpp **1494 行**;hpp 202;x86 1604;c1_FrameMap.cpp 330/hpp 287/x86 374
> - **"Runtime1 vs InterpreterRuntime 区别" ✓ 半对**: 底层共享(allocate_instance/SharedRuntime 助手);通道不同=JRT_ENTRY(Runtime1)vs IRT_ENTRY(InterpreterRuntime,08-03)
> - **缺机制(重要)**: ①patch_code(:834/:1271)懒链接: access_field_patching_id/load_klass_patching_id/load_mirror_patching_id resolve+patch 编译代码地址;②FrameMap 构造(:156)/framesize(:190-191 monitor_base 对齐);③x86 寄存器编号约定(initialize :160-206,rax=3/rbx=2)+caller_save 数组(:203-206);④慢路径计数全部 NOT_PRODUCT
> - **实证**: 14-c1-runtime-frame-demo.txt(nmethod header stub code=48/oops=8/metadata=8;慢路径计数 release 不可观察,-XX:-UseTLAB 是间接对照)
> - **悬念指向 15-c2 ✓**(15-c2-compiler/01 "C2 Ideal Graph — Node + Type + IGVN")

### 1. Runtime1 — C1 的 C++ 后援

场景: C1 编译代码→`new MyClass()`→JIT 代码: `call Runtime1::new_instance(thread)`→C++→`InstanceKlass::allocate_instance(THREAD)`→分配对象→return oop→JIT 继续。

**Runtime1** (`c1_Runtime1.hpp.cpp` + `cpu/x86/c1_Runtime1_x86.cpp`):
- `Runtime1::new_instance(JavaThread*, ciKlass*)`: TLAB 分配→满→GC→new TLAB
- `Runtime1::new_type_array` / `new_object_array`: 数组分配
- `Runtime1::monitorenter` / `monitorexit`: 同步块——`ObjectSynchronizer::fast_enter()`
- `Runtime1::access_field_patching`: 字段访问的"lazy linking"——首次访问→resolve field→patch 编译代码中的 field offset
- [C++: Runtime1 与 InterpreterRuntime 的区别——都是 C++ runtime。InterpreterRuntime 从解释器调用——Runtime1 从 C1 编译代码调用。但共享底层——比如 `new_instance` 都调 `InstanceKlass::allocate_instance`。区别: C1 的 call 是直接的 `call Runtime1::new_instance`——不需要解释器 dispatch]
- `Runtime1::patch_code(JavaThread*, ciMethod*)`: 方法链接——invokevirtual 的 target method 尚未 resolve→call Runtime1→resolve→**patch 编译代码中的 call 地址**——下次 direct call

**C1 stub** (`c1_Runtime1.cpp:200-500`):
- Stub 生成——`StubAssembler`——生成 stub 代码——保存在 CodeCache——C1 编译代码 call stub→stub call C++→stub return→JIT resume

### 2. FrameMap — C1 栈帧布局

**FrameMap** (`c1_FrameMap.hpp.cpp`):
- Caller save: registers 必须由调用者保存——RAX/RCX/RDX/RSI/RDI/R8-R11——C1 使用后 push→call→pop restore
- Callee save: RBX/RBP/R12-R15——被调方法必须保存——C1 entry 时 push→exit 时 pop
- [C++: Frame layout——`[return address][saved RBP][spill slots][monitor slots][locals][operand stack]`。`FrameMap::spill_slot_for(interval)`→栈上分配 spill slot——LinearScan spill 时用]
- OopMap: `FrameMap::oop_map_slot(int index)`——每个栈 slot 是否存 OOP→GC 扫描用

---

### 核心悬念

**"C1 不自行分配对象——call Runtime1→C++→TLAB→return oop。首次 invoke→Runtime1 resolve→patch 编译代码——下次 direct call。"** — C1 把复杂操作 delegate 到 C++——编译代码保持简单——毫秒级编译。与 InterpreterRuntime 同底层但直接调用。域 14 完成。下一篇: C2——超优化编译器。

> → domain 15: [C2 Compiler — C2 的 IdealGraph: parse→optimize→register→code](../15-c2-compiler/01-c2-ideal-graph.md)
