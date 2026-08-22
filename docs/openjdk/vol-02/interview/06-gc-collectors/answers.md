# 06 · GC 收集器与回收策略：专家答案锚点

## 1. 不同 GC 的本质差别是它们选择维护哪一种不变量

所有收集器都要回答“谁活着”和“哪些对象可回收”，但它们选择把复杂性放在不同位置：

- Serial/Parallel 把复杂性集中在 stop-the-world 阶段，换取运行期 barrier 和并发协议更简单；
- CMS 把复杂性移到并发标记/清扫和 free list 管理，接受碎片与 remark；
- G1 把复杂性移到工作集管理、RSet、并发标记与 pause 预算；
- ZGC/Shenandoah 把复杂性进一步移到并发 relocation、load barrier 和地址语义。

所以它们不是“统一算法 + 参数”，而是对停顿、吞吐、内存额外开销、屏障成本和实现复杂度给出了不同答案。仅靠“多开 GC 线程”只能并行化 stop-the-world 工作，不能自动解决对象并发移动、地址稳定性或 write/read barrier 语义。

## 2. Serial/Parallel 的真正优势是把运行期协议压到最小

`GenCollectedHeap` 代表的代际收集路径（`share/gc/shared/genCollectedHeap.hpp:43`）通过连续空间、分代、复制与压缩把大部分复杂性留在暂停点。Parallel 只是把同样的 stop-the-world 工作并行化，不等于变成并发收集器。

这类收集器的优点不是“老旧但能用”，而是：

- mutator 热路径协议更轻；
- barrier 以 card marking 为主，状态面更小；
- 回收阶段更容易做全局精确整理和压缩；
- 对小堆、批处理、资源受限或吞吐优先场景非常有效。

代价是暂停时间仍与工作集甚至堆规模高度相关。活对象很多时，并行线程只能分摊扫描/复制/压缩，不能抹掉必须 stop-the-world 的事实。

## 3. CMS 用碎片换停顿，用恢复协议换直接整理

CMS 的核心取舍不是“并发”三个字本身，而是：**允许老年代不做压缩，以避免长时间 stop-the-world 整理**。这带来三连锁反应：

1. 并发标记和并发清扫不能完全避免浮动垃圾；
2. remark 仍需 stop-the-world，负责收束并发期间的剩余不确定性；
3. free list 分配与碎片管理成为长期复杂度来源，promotion failure 会逼迫更重的退化路径。

与 G1 的 SATB 不同，CMS 的经典思路是增量更新：在 mutator 改图时，维护“旧对象可能新增了指向未标记对象的边”这类信息。它说明不同并发收集器连“记录哪一边”都不一样。

## 4. G1 的关键不是 Region 本身，而是 pause 工作集预算化

Region 只是 G1 的地理基础设施；真正的机制核心是：

```text
并发标记告诉你谁活着
RSet 告诉你谁可能从外面指向 CSet
pause 预算决定这次只处理哪批 Region 与入边
```

这使得暂停成本从“扫完整个老年代/整堆”转成“处理本次 Collection Set 及其必要入边”。没有 RSet，Mixed GC 会退回整块 old/humongous 空间扫描；没有 SATB，并发标记就无法对 mutator 删除边保持快照语义；没有 pause budgeting，G1 只剩“堆被切成 Region”的表面特征。

所以 G1 与 Parallel 的根本差别不是“一个分块一个不分块”，而是**G1 试图把暂停工作集缩到可预算单位，并为此接受更高的元数据和 barrier 成本**。

## 5. ZGC/Shenandoah 的主矛盾是“对象正在移动，但引用语义不能破”

这一题在当前题库里属于**设计对比题**，不是要求候选人背出某个发行版源码树中一定存在的具体实现文件。因为不同 11u 发行版未必同时包含 ZGC/Shenandoah，但它们代表的低停顿收集器方向必须能从机制上说清。

低停顿收集器不是简单把标记并发化，而是要让对象在 mutator 仍运行时也能安全 relocation。难点不再是“下一次 STW 时如何压缩”，而是“当前线程读到一个引用时，这个对象是否已经搬迁、转发、染色或通过中间指针转向新地址”。

因此它们必须让 barrier 参与对象访问协议本身：

- ZGC 倾向用 colored pointer 之类的地址语义编码，让读/访问路径参与状态解析；
- Shenandoah 倾向通过转发/中间指针风格的协议，让对象头或 Brooks-style indirection 协调并发移动。

如果把这类收集器的 barrier 降回 G1 式 post-write dirty-card 记录，就无法在读路径上保证 relocation 竞态被及时修正；对象地址稳定性会先出问题。

## 6. barrier 不是一个词，而是一组不同的不变量维护协议

这里也要避免一个常见误答：不能把所有收集器都抽象成“写屏障 + 记日志”。对 G1/CMS 这样以写路径记账为主的收集器，这个模型还勉强成立；对并发 relocation 的低停顿收集器，读/访问路径本身就是协议的一部分。

“GC barrier”太宽泛。面试中至少要分清：

- card table / post-write barrier：解决跨区/跨代引用线索；
- SATB barrier：记录删除前旧值，保护并发标记快照；
- incremental update barrier：记录新增边，维护另一种并发可达性不变量；
- load/read barrier：让对象读路径参与 relocation 或状态修正；
- access barrier：把对象访问统一封装在更高层接口中，由不同 GC 落到不同具体协议。

能否批处理，取决于 barrier 保护的是什么：dirty card 可以排队后处理；对象访问时的 relocation 语义不能“稍后再说”。这就是为什么越低停顿的 collector，越容易把成本推到每次对象访问上。

## 7. 跨收集器比较的统一维度

专家级比较不应停在“谁适合低延迟”。至少要沿五个维度回答：

1. **对象何时移动**：只在 STW 移、并发移、还是几乎不移；
2. **并发程度**：只并行 STW，还是并发标记/并发清扫/并发 relocation；
3. **barrier 类型**：写卡、SATB、增量更新、读屏障、访问屏障；
4. **元数据与工作集**：free list、RSet、mark bitmap、forwarding metadata、region/page granularity；
5. **失败与退化**：promotion failure、full GC、degenerate path、OOM 前的最后自救动作。

只要沿这五个维度比较，就不会把“低停顿”误当成唯一答案。低停顿通常意味着更多 barrier、更复杂的元数据和更高的 CPU 常驻成本；高吞吐通常意味着把复杂性压回 stop-the-world 阶段。

## 评分锚点

- **合格**：能分清 STW、并行、并发、压缩、复制、清扫的基本含义。
- **良好**：能说明 G1/CMS/ZGC/Shenandoah 各自把复杂性转移到了哪里。
- **专家级**：能用“维护哪个不变量、把成本放在哪条路径、失败如何退化”三句话解释收集器差异，并明确同一种 barrier 不能跨收集器随意替换。
