# 05-allocation · 对象分配、逃逸分析与运行时结构

## 覆盖域（vol-02）

`06-oops`（oopDesc/markOop/InstanceKlass）、`25-gc-framework`（CollectedHeap/MemAllocator）、`31-unsafe-whitebox`（Unsafe 分配）、`09-memory-core`（Arena/ResourceArea）、`15-c2-compiler`（EA/MacroExpand）

## 题目清单

1. 对象是怎么创建出来的？——TLAB bump → 慢路径 → humongous；`Klass::prototype_for_object`；`invokespecial <init>`
2. 什么是 TLAB？为什么快？——线程本地 bump pointer 无锁；`_top` 推进；空间不足走慢路径
3. 什么是逃逸分析？——EA 证明可消除 ≠ MacroExpand 真正删分配；不是栈上分配
4. OOM 有几种？——堆 OOM / Metaspace OOM / 直接内存 OOM；OOM 前通常有一次 GC 尝试
5. 什么是 `allocateInstance`？——Unsafe 绕过构造器；verifier 不管、`<init>` 不执行
6. 什么是热点代码？JIT 怎么判定？——方法调用计数器/回边计数器；`CompileThreshold`；分层编译下阈值不同
7. 什么是方法内联？为什么对性能影响大？——C2 的 `doInling`、`Inlinee` 树；`-XX:MaxInlineSize`；逃逸分析依赖内联

## 回答框架提示

本组的"OS 视角"是 TLAB 的 bump 分配 vs 全局分配锁的竞争差异。EA 部分要纠正"栈上分配"这个常见误答——C2 没有栈上分配，只有分配消除。版本差异：JDK 11 的 G1 默认和 JDK 8 的 Parallel 默认对分配/晋升路径的影响不同。

## 回答框架提示

本组的"OS 视角"是 TLAB 的 bump 分配 vs 全局分配锁的竞争差异。EA 部分要纠正"栈上分配"这个常见误答——C2 没有栈上分配，只有分配消除。版本差异：JDK 11 的 G1 默认和 JDK 8 的 Parallel 默认对分配/晋升路径的影响不同。