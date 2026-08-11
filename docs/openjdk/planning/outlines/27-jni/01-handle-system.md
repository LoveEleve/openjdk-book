# 01. jobject 在 JVM 内部怎么存的？— JNI Handle 系统

> 🔴 Deep | 2 KP 中的引用管理
> 读者处境: Java 调 native method——传入 `jobject obj`。这个 `jobject` 不是直接指向 oop——而是**handle**(间接指针)。GC 可能移动 oop→但 jobject 不变→JNIHandles 解引用时指向新位置。

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
