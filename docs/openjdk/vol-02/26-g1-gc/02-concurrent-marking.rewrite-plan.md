# 26-g1-gc/02-concurrent-marking 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
> 目标：解释 G1 为什么敢在应用线程还在修改对象图时并发标记，以及 SATB、并发标记线程、双 bitmap、remark/cleanup 各自怎样保证“旧世界快照不丢、并发期间不乱、最后统计可入账”

## 1. 选题判断

现稿已有很强事实基础：
- `write_ref_field_pre` / `enqueue`
- `SATBMarkQueue(Set)`
- `G1ConcurrentMarkThread::run_service`
- `mark_from_roots`
- `make_reference_grey`
- 双 bitmap
- `remark` / `finalize_marking` / `cleanup`

但当前正文仍偏“SATB 一节 + 循环一节 + bitmap 一节 + remark 一节”的机制并列。真正该打穿的读者困惑更集中：

**应用线程在并发标记期间还在不断改引用，G1 为什么还敢说自己最终能知道‘标记开始时谁活着’？它为什么不追当前世界，而要坚持追‘旧世界快照’？SATB、TAMS、双 bitmap、remark 各自到底在补哪一个漏洞？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**G1 并发标记的关键不是“标得多快”，而是“先冻结旧世界，再允许应用继续改图”。SATB pre-barrier 记录的是被覆盖掉的旧引用，不是新引用；`_next_top_at_mark_start` 划出本轮该看的对象边界；并发线程只往 `_next_mark_bitmap` 里画本轮结果，remark 再在 STW 下把剩余 SATB buffers 和线程根补齐，最后把这轮 bitmap 与每个 Region 的 `_next_marked_bytes` 一起安装成下一轮 pause 的决策依据。**

## 3. 总图

```text
标记开始前
  initial-mark pause
    └─ 记录 TAMS / 打开 SATB 队列

并发期间
  mutator 写引用
    └─ pre-write barrier 把旧值 enqueue 到 SATB queues
  G1ConcurrentMarkThread
    └─ drain SATB -> 扫灰对象 -> 在 next bitmap 置位

remark (STW)
  ├─ 重扫线程根
  ├─ drain 剩余 SATB buffers
  ├─ swap_mark_bitmaps
  └─ 把 liveness 入账到 Region

cleanup
  └─ 回收空 Region / 更新后续记账状态
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——应用线程还在改图，G1 为什么还敢并发标记

目标约 1200 字。

- 从“边标边改引用”的丢对象风险切入
- 点出：真正目标不是追当前世界，而是保住标记开始时的旧世界
- 埋主线：SATB 是冻结旧世界的协议，不是追新引用的协议

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 只要并发线程标得够快，就能追上 mutator 当前对象图
2. 只要在写引用后记下新值，就能补齐并发遗漏

结论：
- 追当前世界本身就是不断移动的目标
- SATB 的关键是保住“被覆盖掉的旧边”，而不是追逐新边

### 第三节：SATB——为什么 pre-write barrier 记的是旧值

目标约 2200 字。

- `write_ref_field_pre`
- `IS_DEST_UNINITIALIZED` / `AS_NO_KEEPALIVE`
- `enqueue`
- Java 线程本地 SATB 队列 vs 共享队列
- 说明多标无害、漏标致命

### 第四节：并发标记线程——为什么 root region 必须先扫完再进入常规并发循环

目标约 2100 字。

- `run_service`
- `sleep_before_next_cycle`
- phase 切换
- root region 扫描前不加入 STS 的约束
- 收回“并发不是随时任意切入”的主线

### 第五节：`mark_from_roots` 与 `make_reference_grey`——为什么 below-finger 才入灰栈

目标约 2300 字。

- `mark_from_roots`
- worker 并发度
- `make_reference_grey`
- `mark_in_next_bitmap` / `par_mark`
- `global finger` / `is_below_finger`
- typeArray 的特殊路径

### 第六节：双 bitmap 与 TAMS——为什么本轮结果不能直接覆盖上一轮结果

目标约 2000 字。

- `_mark_bitmap_1/_mark_bitmap_2`
- `_prev_mark_bitmap/_next_mark_bitmap`
- `_next_top_at_mark_start` / `_prev_top_at_mark_start`
- 为什么“本轮 under-construction”与“上一轮 completed”必须分开
- 路标：位图记录的是旧世界边界内的活性结果

### 第七节：remark 与 cleanup——为什么最后仍然必须 STW 补漏和入账

目标约 2300 字。

- `remark`
- `finalize_marking`
- `completed_buffers_num()==0`
- `swap_mark_bitmaps`
- `Update Remembered Set Tracking Before Rebuild`
- `cleanup` / `Update Remembered Set Tracking After Rebuild`
- 说明 remark 不是“再做一遍并发标记”，而是关闭快照窗口并安装结果

### 第八节：误解澄清与收网

目标约 1300 字。

至少回答：
1. SATB 是否记录新引用
2. 并发标记是否在追“当前最新对象图”
3. 双 bitmap 是否只是为了实现方便
4. remark 是否只是日志里的一个短 STW 尾声
5. cleanup 是否负责重新计算全部 liveness

## 5. 失败方案必须写进正文

1. 认为并发标记能直接追上 mutator 的当前对象图
2. 认为 pre-write barrier 应该记录新值而不是旧值
3. 认为 remark 只是收尾日志，不承担关键正确性职责

## 6. 证据清单

- `src/hotspot/share/gc/g1/g1BarrierSet.inline.hpp:36`：`write_ref_field_pre`
- `src/hotspot/share/gc/g1/g1BarrierSet.cpp:61`：`enqueue`
- `src/hotspot/share/gc/g1/satbMarkQueue.hpp:45`：`SATBMarkQueue(Set)`
- `src/hotspot/share/gc/g1/g1ConcurrentMarkThread.cpp:247`：`run_service`
- `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:973`：`mark_from_roots`
- `src/hotspot/share/gc/g1/g1ConcurrentMark.inline.hpp:213`：`make_reference_grey`
- `src/hotspot/share/gc/g1/g1ConcurrentMarkBitMap.inline.hpp:81`：`par_mark`
- `src/hotspot/share/gc/g1/heapRegion.inline.hpp:243`：`note_start_of_marking`
- `src/hotspot/share/gc/g1/heapRegion.inline.hpp:248`：`note_end_of_marking`
- `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1139`：`remark`
- `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1178`：`swap_mark_bitmaps` + update tracking before rebuild
- `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1214`：overflow restart
- `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1858`：`finalize_marking`
- `src/hotspot/share/gc/g1/g1ConcurrentMark.cpp:1356`：`cleanup`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64 / G1`
- 本篇聚焦并发标记与 SATB，不展开 RSet/card table 的细节
- 屏障汇编/解释器插桩只在必要处点边界，不扩成 barrier lowering 专题
- 实测日志只用来印证阶段，不取代源码主线
- 下一篇应自然承接“老年代引用是怎么被反向记账的”

## 8. 完成后 review

- 删除代码后，能否复述“G1 并发标记不是追当前世界，而是保住旧世界快照”
- 是否清楚解释 pre-write barrier 为什么记录旧值
- 是否讲清 TAMS、double bitmap、remark 各自补的漏洞
- 是否说明 liveness 入账发生在 remark/cleanup 交界而不是并发循环任意时刻
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
