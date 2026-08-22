# 03-gc-collectors · GC 与回收策略

## 覆盖域（vol-02）

`25-gc-framework`（BarrierSet/CollectedHeap/ReferenceProcessor/WorkGang）、`26-g1-gc`（G1 全链）、`18-references-finalization`（intervie 域）、`06-gc-collectors`（intervie 域）

## 题目清单

1. 垃圾回收器有哪些？怎么选？——Serial/Parallel/CMS/G1/ZGC/Shenandoah；吞吐 vs 延迟
2. 什么情况会触发 Full GC？——老年代分配失败、Metaspace 阈值、`System.gc()`、promotion failure、concurrent mode failure
3. `System.gc()` 一定立刻执行吗？——`DisableExplicitGC`、RMI 周期调用、G1 特判
4. 什么是 STW？为什么不能消除？——并发移动对象需要一致窗口；ZGC 只能缩短不能消除
5. G1 和 CMS 的核心区别？——Region + RSet + SATB vs 不压缩 + incremental update；暂停预算
6. 什么是晋升失败？为什么危险？——年轻代对象不能复制进老年代；GC 退化、Full GC
7. 强/软/弱/虚引用的区别？——ReferenceProcessor 四阶段；软引用按访问间隔；Phantom 排 final 之后
8. 对象什么时候进入老年代？——动态年龄判定、空间分配担保、大对象直接进老年代；`-XX:MaxTenuringThreshold`、`-XX:SurvivorRatio`
9. 为什么新生代要分 Eden/S0/S1 三个区域？——复制算法的"to-space"留空；`from/to` 交换；标记复制效率
10. 三种基础 GC 算法（标记-清除/复制/标记-整理）的适用场景？——CMS 碎片 vs 复制 vs 整理；各自 trade-off

## 回答框架提示

不要只列回收器名字。选型部分的"OS 视角"可以看 `/proc/<pid>/maps` 中 GC 线程数和堆区域分布。版本差异：JDK 8 默认 Parallel，JDK 11 默认 G1，JDK 15 偏向锁禁用，JDK 18 移除。