# 01. jobject 在 JVM 内部怎么存的？— JNI Handle 系统

> 🔴 Deep | 2 KP 中的引用管理
> 读者处境: Java 调 native method——传入 `jobject obj`。这个 `jobject` 不是直接指向 oop——而是**handle**(间接指针)。GC 可能移动 oop→但 jobject 不变→JNIHandles 解引用时指向新位置。

> ⚠️ 写作期修正(2026-08-14, vol-02/27-jni/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **行号全漂**: jniHandles.hpp 共 207 行,JNIHandles 类 :35-126,JNIHandleBlock :132-205(block_size_in_oops=32);jniHandles.cpp 共 664 行: make_local :52-87/make_global :101-122/make_weak_global :125-146/destroy :168-185/initialize :203-210;weak tag 常量在 jniHandles.hpp:55-66(weak_tag_size=1/alignment=2/value=1)
> - **"Local handle 自动释放(Native 返回后 pop)" 半对**: 真实=**native 方法返回时 `_top` 清零**(templateInterpreterGenerator_x86.cpp:1163-1166 + sharedRuntime_x86_64.cpp:2652-2656 编译代码 "reset handle block",critical native 例外),不是"弹出";块内容留着,GC 的 oops_do 只遍历 _top 以内(jniHandles.cpp:453-478);PushLocalFrame/PopLocalFrame 才动链(_pop_frame_link,jni.cpp:746-783)
> - **resolve 伪代码错(RawAccess/无锁解释)**: 真实 resolve_impl(jniHandles.inline.hpp:52-66)用 **NativeAccess**(jweak 走 ON_PHANTOM_OOP_REF 通道);**assert(!current_thread_in_native())(:55)——resolve 必须在非 native 状态**,大纲"resolve 在 native code 中调用/thread in native"方向反了(JNI 函数入口 ThreadInVMfromNative 先转 VM 状态);null 规范化注释 :61-62;resolve :68-74
> - **"OopStorage(域 25)" 归属错**: OopStorage 在 share/gc/shared/oopStorage.*,通用 off-heap 引用容器;JNIHandles::initialize(jniHandles.cpp:203-210)建 **"JNI Global"/"JNI Weak" 两个实例**(JNIGlobalAlloc_lock/JNIGlobalActive_lock);allocate 持 _allocation_mutex(:410-477,Block+位图 _allocated_bitmask oopStorage.cpp:208),release 无锁(:675-683);GC 弱清除=weakProcessor.cpp:37(WeakProcessor 阶段写 NULL)
> - **缺机制(重要)**: ①**jobject 参数=参数帧里 oop 槽的地址**(sharedRuntime_x86_64.cpp:1157-1180 "An oop arg. Must pass a handle not the oop itself",解释器走签名处理器 templateInterpreterGenerator_x86.cpp:932-947);is_frame_handle 识别栈上引用(jniHandles.cpp:270-278);实证: 传回 Java 再传回 native 的引用 GetObjectRefType=1(JNILocalRefType);**把参数当 global handle 传 DeleteGlobalRef 会 SIGSEGV**;②allocate_handle 四段分配链(:481-546): _last 块末槽→free list(槽内嵌 next :521)→_last->_next→rebuild_free_list 或追加新块;rebuild 启发式(:548-575,"空闲不到一半就按缺额算 _allocate_before_rebuild");③jweak 对齐=weak_tag_alignment=2 非 8 字节;④JavaCallWrapper 在 VM 调 Java 时切换 active_handles(javaCalls.cpp:65-154)
> - **实证**: 27-jni-handles-demo.txt(NewGlobalRef refType=2/NewWeakGlobalRef 地址 lsb=1 refType=3/参数变 local ref=1/deleteGlobal+GC 后 NewLocalRef(weak)=NULL/SIGQUIT "JNI global refs: 29, weak refs: 1" 基线 28/0)
> - **悬念指向 02-jni-fast-path ✓**(正确,保留)

### 1. "三层 Handle — global/local/weak"

场景: JNI_GetObjectArrayElement 返回 jobject→它是 local handle。如果你要跨多次 native 调用持有它→必须升级为 global handle。如果你想要 GC 可回收的引用→weak global handle。

**三种 Handle 类型** (`jniHandles.hpp:34-80 + jniHandles.cpp:52-80`):
```
Global handle:     OopStorage 分配, 跨 native 调用持久, 必须手动 DeleteGlobalRef
Local handle:      per-thread JNIHandleBlock 链表, 自动释放(Native返回后pop)
Weak global handle: OopStorage 分配 + 1-bit tag区分, GC 可选回收(自动null)
```
- 源码: `jniHandles.hpp:34-80` 声明 + `jniHandles.cpp:50-200` make_global/make_local/destroy
- 关键设计: local handle 释放是自动的——native 返回时 JVM 销毁当前 frame 的 local handle block→所有 local ref 无效。这是 JNI 规范要求——不需要手动 DeleteLocalRef(但手动 delete 减少内存压力)
- 关键设计: Global handle 存在 OopStorage(域25)——无锁并发存储。`make_global(oop)` → OopStorage::allocate→store oop→return handle。`destroy_global(handle)` → OopStorage::release→GC 不再跟踪此引用
- [C++: weak global 用 1-bit tag:`weak_tag_value=1, weak_tag_mask=1`。handle 地址最低位=1→is_jweak→GC 可以在标记/清理时选择是否保留。`resolve(handle)` 先 `handle &= ~weak_tag_mask`(清除tag)再读 oop]

### 2. "resolve — handle→oop 解引用"

场景: JNI 函数接收 jobject→需要拿到 oop→JNIHandles::resolve(handle)

**resolve 流程** (`jniHandles.inline.hpp:40-80`):
```cpp
inline oop JNIHandles::resolve(jobject handle) {
  oop* ptr = jobject_ptr(handle); // handle → pointer
  oop result = RawAccess<>::oop_load(ptr); // read oop value
  return result; // GC-safe:oop 任何时候都可能移动→但 handle 总是指向最新位置
}
```
- 源码: `jniHandles.inline.hpp:40-80` resolve + `jniHandles.hpp:42-43` jobject_ptr
- [C++: resolve 不需要 lock——handle 指向的 slot 是 GC-可见的(GC knows to update it when moving oop)。resolve 在 Native code 中调用→thread in _thread_in_native状态→GC 不能在这个线程中发生→read oop without barrier]

### 3. "OopStorage — Handle 的底层存储"

**OopStorage 分配** (`oopStorage.hpp:40-150`):
```
Global handles → OopStorage::allocate() → _global_handles storage
Weak handles   → OopStorage::allocate() → _weak_global_handles storage
Local handles  → per-thread JNIHandleBlock(常规 C-heap, 非 OopStorage)
```
- 关键设计: Local handle 不需要 OopStorage——因为其生命周期极短(单 native frame)。Global/Weak handle 需要 OopStorage 因为它们生命周期与 GC cycle 重叠——GC 在并发标记/复制阶段必须访问它们

---

### 核心悬念

**"JNIHandles 三层: global(OopStorage,持久), local(线程栈,自动释放), weak(OopStorage+tag,GC可选清理)。resolve 无锁解引用——handle→oop via GC-safe pointer。"** — 下一篇: JNI 函数调用 + Fast Path。

> → [02-jni-fast-path.md](02-jni-fast-path.md)
