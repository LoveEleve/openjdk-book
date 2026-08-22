# 01-memory-model · JVM 内存模型与运行时区域

## 覆盖域（vol-02）

`06-oops`（对象头）、`09-memory-core`（Universe/VirtualSpace）、`10-metaspace`（Metaspace）、`25-gc-framework`（CollectedHeap）、`24-frame`（栈帧）、`13-memory-metaspace`（intervie 域）

## 题目清单

1. JVM 内存区域分几块？——三层视角：规范五区；进程地址空间映射（`/proc/<pid>/maps` 各段）；HotSpot 的 `init_globals` 与 `Metaspace::global_initialize`
2. 堆和栈的区别？——生命周期与所有者；进程视角（pthread 栈 vs mmap 堆）；`Thread::_tlab`/`JavaFrameAnchor`
3. 什么是 GC Roots？——遍历起点集合；`Universe::oops_do`、OopMap、InstanceRefKlass 特殊路径
4. 什么是 OopMap？为什么 GC 需要它？——编译帧静态标注 vs 解释器现场算 mask
5. 什么是 SafePoint？和 OopMap 的关系？——暂停点 vs 暂停点的 oop 状态表
6. 对象头里的 mark word 到底是什么？——`Klass::prototype_for_object`、biasable prototype、`_metadata`
7. 什么是直接内存/堆外内存？DirectBuffer 在哪？——Unsafe `RawAccess<>` 与 `HeapAccess<>` 的边界；`Dirty direct buffers` 清扫机制

## 回答框架提示

每题的"进程/OS 视角"是本组特色：读 `/proc/<pid>/maps` 看堆/栈/共享库段；`cat /proc/<pid>/status` 看 `VmSize/VmRSS/Threads`。不要只给规范答案。