# 05. 什么时候做 Young？什么时候做 Mixed？— 策略与集合选择

> **前置依赖**:[26-g1-gc/02 — 应用还在跑——你怎么知道谁活着？— 并发标记 + SATB](02-concurrent-marking.md):remark 后 `_next_marked_bytes` 就位,本篇的 Mixed GC 靠它选 Old Region;[26-g1-gc/04 — new Object() 在 G1 里走到哪？— 分配与晋升](04-allocation.md):分配路径与 humongous 触发 Concurrent Start;[26-g1-gc/03 — Region A 里谁引用了 Region B？— RSet + CardTable 并发细化](03-rem-set.md):CSet 扫描依赖 RSet
> → **后续**:[26-g1-gc/06 — G1BarrierSet + Pre/Post Write Barrier](06-g1-barrier.md)
> 关联域: 26-02(标记)、26-03(RSet)、26-04(分配)、25-gc-framework(GC 框架)

G1 的暂停不是"每次全堆"。它有三种形态: **Young-only**(只收年轻代)、**Mixed**(年轻代 + 选中的老年代 Region)、**Full**(全堆压缩)。应用能给 G1 的核心输入,几乎只有一条**软目标**:尽量让每次暂停不超过目标毫秒(G1 尽力逼近,但并不保证)。本篇要回答的是:

1. 这一条暂停目标,是怎么被同时用来决定"什么时候标记""什么时候 Mixed""这一次收哪几个 Region"三件事的;
2. 有没有哪一步,是脱离了暂停目标、单独拍脑袋定规则的。

核心在 `G1Policy` 这个策略层:它把"历史样本 → 时间预测 → 时间预算"做成一条公用管道,然后用在三处——`G1IHOPControl` 管标记时机,`next_gc_should_be_mixed` 管 Mixed 判定,`G1CollectionSet::finalize_*` 管 CSet 选择。

---

## 1. 开场——一条暂停目标,三件不同的事

`MaxGCPauseMillis` 传给 G1 之后,G1 实际要回答三个互不相同的问题:

1. **什么时候启动并发标记?** 标记需要时间,而且标记期间应用还在分配。启动太晚,标记还没跑完堆就塞爆,只能 Full GC;启动太早,老年代利用率低,平白推进一次标记周期。
2. **标记完了之后,下一次 GC 该不该做成 Mixed?** 不是标记完就必然进一长串 Mixed——如果剩下的老年代可回收空间比例太低,继续收反而不划算。
3. **如果是 Mixed,这一次暂停到底收哪几个 Old Region?** 可回收的 Region 一堆,但暂停预算有限,必须挑最值得收的。

这三个问题看起来是三个独立模块:一个管 IHOP,一个管判定,一个管 chooser。但往下读会发现,它们共用同一件事:**把历史观察变成预测,再把预测折算成暂停预算,最后在预算内排优先级。**

这也埋下本篇最后要验证的判断:如果哪一步规则是真的拍脑袋定的、跟暂停目标无关,那它一定是被另外的机制接住的——比如 min/max 之外的内置兜底。

---

## 2. 两个朴素方案为什么都不成立

在看源码之前,先想清楚"如果让一个不熟悉 G1 的人来设计,他会怎么做",以及为什么那样做会坏。

### 方案一:等老年代快满才启动标记

直觉上,标记是给 Mixed GC 备料,那把料备得越晚越好,免得白标一场。于是:老年代没满就先不标记,满了再启动。

问题在于**标记跟分配是赛跑**。从启动标记到标记结束,应用线程始终在分配、在晋升。如果老年代已经用了 90%,而标记还需要跑完整个对象图,那么标记期间晋升进来的对象很可能把剩下的 10% 吃光。堆一满,只能停下整个世界做 Full GC——这恰恰是 G1 想尽量避免的。

所以启动阈值不能只看"现在用了多少",还要看"从现在到标记完成,还会再涨多少"。这正是 IHOP 的起点(详见第三节)。

### 方案二:标记完了就连续收,把老年代清得越干净越好

直觉上,既然标记结果已经就位,那 Mixed GC 应该"一口气把标记出来的可回收 Region 全收完",直到没有候选为止。

问题在于**每次暂停都有目标毫秒的上限**。老年代里可回收的 Region 可能有几十上百个,单次暂停的预算根本装不下;硬塞的话,单次 Mixed 超时,暂停目标形同虚设。反过来,如果根本不做 Mixed、只做 Young-only,那些有回收价值的 Region 又会一直赖在老年代里,堆占用不断上升。

G1 的做法是:既不全收,也不全不收,而是**在"单次暂停预算内按收益挑 Region"**——收益高的先收,收益低的留着,并且用 min/max 两个边界兜底。这里的"收益"不是简单的存活率,而是"可回收字节 / 预测耗时"(详见第六节)。

这两个朴素方案的共同盲点是:它们都把"什么时候标记""收多少"看成了和暂停目标无关的独立常数。G1 的策略层恰恰相反,所有决定都以暂停预算为锚。

---

## 3. IHOP——为什么启动阈值是"安全线减预计分配量"

### 静态 IHOP:固定百分比

最省事的实现是把启动阈值设成一个固定百分数。`G1StaticIHOPControl` 就是干这个的:

```cpp
// g1IHOPControl.hpp:94-97(截取核心,逐字)
size_t get_conc_mark_start_threshold() {
  guarantee(_target_occupancy > 0, "Target occupancy must have been initialized.");
  return (size_t) (_initial_ihop_percent * _target_occupancy / 100.0);
}
```

`_target_occupancy` 是"标记该结束、回收该开始"时的堆占用上限,`_initial_ihop_percent` 默认 45(`InitiatingHeapOccupancyPercent`,gc_globals.hpp:223)。也就是 non-young 占用(老年代 + humongous)超过目标容量的 45% 时,启动并发标记。

但这个固定值有个明显缺陷:它不闻不问"标记要跑多久、期间要涨多少"。标记慢 + 分配快,45% 早就太晚;标记快 + 分配慢,45% 又太早。

### 自适应 IHOP:从安全线反推

`G1AdaptiveIHOPControl` 把上面那两个朴素坑都补上了。它的核心成员(g1IHOPControl.hpp:109-125):

```cpp
// g1IHOPControl.hpp:109-125(截取核心,逐字)
class G1AdaptiveIHOPControl : public G1IHOPControl {
  size_t _heap_reserve_percent; // Percentage of maximum heap capacity we should avoid to touch
  size_t _heap_waste_percent;   // Percentage of free heap that should be considered as waste.

  const G1Predictions * _predictor;

  TruncatedSeq _marking_times_s;
  TruncatedSeq _allocation_rate_s;

  size_t _last_unrestrained_young_size;
```

它维护两个截断序列(`TruncatedSeq`,只保留最近样本):

- `_marking_times_s`:每次从 initial mark 到第一个 Mixed 的时长;
- `_allocation_rate_s`:标记期间老年代的晋升/分配速率。

真正决定启动阈值的是 `get_conc_mark_start_threshold`(g1IHOPControl.cpp:123-139):

```cpp
// g1IHOPControl.cpp:123-139(截取核心,逐字)
size_t G1AdaptiveIHOPControl::get_conc_mark_start_threshold() {
  if (have_enough_data_for_prediction()) {
    double pred_marking_time = _predictor->get_new_prediction(&_marking_times_s);
    double pred_promotion_rate = _predictor->get_new_prediction(&_allocation_rate_s);
    size_t pred_promotion_size = (size_t)(pred_marking_time * pred_promotion_rate);

    size_t predicted_needed_bytes_during_marking =
      pred_promotion_size +
      _last_unrestrained_young_size;

    size_t internal_threshold = actual_target_threshold();
    size_t predicted_initiating_threshold = predicted_needed_bytes_during_marking < internal_threshold ?
                                            internal_threshold - predicted_needed_bytes_during_marking :
                                            0;
    return predicted_initiating_threshold;
```

逐项拆:

- **预测标记期间的晋升量** `pred_promotion_size = 预测标记时长 × 预测晋升速率`,这正是"从现在到标记完成还会涨多少"。
- 还要**加上 `_last_unrestrained_young_size`**:IHOP 阈值本身锚定在"GC 结束时 non-young 占用"上,但标记期间 young 代还会继续膨胀并占用空间,所以把最近一次无约束 young 大小也算进去(保守估计:无标记/无 Mixed 干扰时的 young 往往偏大)。`src/hotspot/share/gc/g1/g1IHOPControl.cpp:157`
- **安全线** `actual_target_threshold` 不是堆容量,而是两个约束取较小值:从总容量里扣掉 `_heap_reserve_percent`(为晋升失败预留)和 `_heap_waste_percent`(永远收不回的废空间)后的余量,以及从目标占用里扣掉 waste 后的余量——取两者中更保守的一个。`src/hotspot/share/gc/g1/g1IHOPControl.cpp:100-116`

启动阈值 = **安全线 − 标记期间预计占用的空间**。分配越快、标记越慢、young 越大,这个差就越小(阈值低,提前标记);反过来阈值就高,可以晚点标记。

这里要澄清一个常见误记:网上资料常说"IHOP 默认 45%、范围 25-45%"——"范围 25-45%"是编造的。真实情况是:`InitiatingHeapOccupancyPercent` 默认 45,而 `G1UseAdaptiveIHOP` 默认 true(g1_globals.hpp:48),默认走自适应路径,阈值会在 45% 这个初始百分比的基础上,按上面的公式动态移动。

疑问自然产生:**"预测"到底怎么从历史序列里算出来?** 这需要 `G1Predictions`,它就是底下那根公用管道。

---

## 4. G1Predictions——暂停预算从哪来

`G1Predictions` 把历史样本翻译成一个实际可用的预测值。它的公式是"均值 + sigma×标准差":

```cpp
// g1Predictions.hpp:41-59(截取核心,逐字)
double stddev_estimate(TruncatedSeq const* seq) const {
  double estimate = seq->dsd();
  int const samples = seq->num();
  if (samples < 5) {
    estimate = MAX2(seq->davg() * (5 - samples) / 2.0, estimate);
  }
  return estimate;
}

double get_new_prediction(TruncatedSeq const* seq) const {
  return seq->davg() + _sigma * stddev_estimate(seq);
}
```

- `davg()`:样本均值;
- `dsd()`:样本标准差。样本不足 5 个时,实际标准差不可靠,于是用"均值缩放"补一个估计——`MAX2(均值 × (5−样本数) / 2, 实际stddev)`:样本越少,这个补偿系数越大(0 个样本时是 2.5 倍均值,4 个样本时降到 0.5 倍),到第 5 个样本起直接用真实标准差;
- `_sigma`:置信系数。乘以标准差,给预测值留出安全余量。

换句话说,预测值永远比均值更悲观一点——**这是有意的**:如果暂停时间预测得比实际短,预算就会超额,暂停就会超时。宁可预测长一点,让 G1"少收几个 Region 也要守暂停目标"。

`G1Policy` 通过 `G1Analytics` 把这条管道细化成各种 cost:处理每张 card 的耗时 `_cost_per_card_ms_seq`、复制每字节的耗时 `_cost_per_byte_ms_seq`、每个 young/old Region 的固定开销 `_young_other_cost_per_region_ms_seq` 等(g1Analytics.cpp:222-306)。于是**任何一个"预测某阶段的耗时 X 毫秒"的需求,底层都是同一套 `get_new_prediction`**。IHOP 用它预测标记时长,暂停选择用它预测收一个 Region 的耗时——这就是第三节末尾埋的"公用管道"。

---

## 5. Mixed 判定——为什么标记完不是连续做一长串

标记结束后,候选 Region 已经被并发标记点亮了,但 G1 并不会立刻进入"连续 Mixed"。

### cleanup 结尾的一次决策

`record_concurrent_mark_cleanup_end`(g1Policy.cpp:987-994)负责拍板:

- 先 `cset_chooser()->rebuild(...)`:把本轮到期的候选 Region 重新填进 chooser;
- 再 `next_gc_should_be_mixed(...)`:问"下一次 GC 要不要做成 Mixed"。

`next_gc_should_be_mixed`(g1Policy.cpp:1084-1103)的判断门槛:

1. 候选非空(还有没收完的 Old Region);
2. 剩余可回收字节占堆的比例 **严格大于** `G1HeapWastePercent`(默认 5,g1_globals.hpp:241)。

```cpp
// g1Policy.cpp:1091-1102(截取核心,逐字)
size_t reclaimable_bytes = cset_chooser()->remaining_reclaimable_bytes();
double reclaimable_percent = reclaimable_bytes_percent(reclaimable_bytes);
double threshold = (double) G1HeapWastePercent;
if (reclaimable_percent <= threshold) {
  // ... log: reclaimable percentage not over threshold
  return false;
}
return true;
```

为什么宁可放着可回收空间不收?注释说得很直白:"G1 愿意放弃回收,以避免昂贵的 GC"。候选里剩的可回收空间已经不足堆的 5%,继续收的收益摊不满一次暂停,不如回到 Young-only 让标记周期重新开始。

### Mixed 阶段内部的"每轮复检"

进到 Mixed 阶段后,也不是"开头定了 Mixed 就连着收到底"。每个 **Mixed** 暂停结束后,`record_collection_pause_end` 都会再调一次 `next_gc_should_be_mixed`(g1Policy.cpp:611-620,只在非 Young-only 暂停末尾执行):只要候选为空、或可回收占比掉到 5% 以下,就 `set_in_young_only_phase(true)` 并清空候选,回到 Young-only 基线。

这就是"Mixed 阶段会自然结束"的机制:不是靠计数器,而是靠**每轮过了之后再问一遍"还值不值得继续"**。

### 候选 Region 怎么才算"值得"

`rebuild` 填候选时,`CollectionSetChooser::add_region` 有条件过滤(collectionSetChooser.cpp:285-287):

- 不是 pinned Region;
- `live_bytes()` 低于阈值——`mixed_gc_live_threshold_bytes = GrainBytes * G1MixedGCLiveThresholdPercent / 100`,默认 85%(collectionSetChooser.hpp:104-105),存活超过一个 Region 的 85% 就基本没回收价值,跳过;
- 该 Region 的 RSet 是完整的(`is_complete()`),因为 Mixed 里要把它的入边扫干净,不完整的 RSet 没法安全搬走。

于是,真正进 chooser 的只是"存活率够低、RSet 完整、没被 pin 住"的候选。接下来就是本篇的压轴:在暂停预算里挑。

---

## 6. CSet 选择——先扣固定的,再按收益排可选的

`G1Policy::finalize_collection_set`(g1Policy.cpp:1143-1146)把整个 CSet 选择拆成两步:

```cpp
// g1Policy.cpp:1143-1146(截取核心,逐字)
void G1Policy::finalize_collection_set(double target_pause_time_ms, G1SurvivorRegions* survivor) {
  double time_remaining_ms = _collection_set->finalize_young_part(target_pause_time_ms, survivor);
  _collection_set->finalize_old_part(time_remaining_ms);
}
```

**Young 是必须收的**,没有讨价还价——它不只是为了回收,更是为了让对象按代龄晋升、把年轻代空出来给下一步分配。所以预算分配顺序是:

1. `finalize_young_part`:先扣掉 base time——它是 "RS update(pending cards) + RS scan(predicted cards) + constant other time" 三项预测之和(g1Policy.cpp:812-818),不是固定位数;再把所有 young Region 的预测耗时扣掉,剩下的时间才是能花在 old 上的;
2. `finalize_old_part`:在剩余的这些毫秒里,按收益从大到小挑 Old Region。

### finalize_young_part:预算从 target 里一步步抠

`G1CollectionSet::finalize_young_part`(g1CollectionSet.cpp:356-398):

```cpp
// g1CollectionSet.cpp:364-366,385(截取核心,逐字)
size_t pending_cards = _policy->pending_cards();
double base_time_ms = _policy->predict_base_elapsed_time_ms(pending_cards);
double time_remaining_ms = MAX2(target_pause_time_ms - base_time_ms, 0.0);
...
time_remaining_ms = MAX2(time_remaining_ms - _inc_predicted_elapsed_time_ms, 0.0);
```

- `base_time_ms`:三项预测之和——`predict_rs_update_time_ms(pending_cards)` + `predict_rs_scan_time_ms(scanned_cards)` + `predict_constant_other_time_ms()`(g1Policy.cpp:812-818)。它随 pending cards 数量波动,不是固定值;
- 预算 = `target − base`;
- 再扣掉 young 部分的预测耗时(`_inc_predicted_elapsed_time_ms`),得到留给 old 的时间。

注意这里每一步都用 `< 0 就归零`(`MAX2(..., 0.0)`)兜底——即使预测值把预算扣成负数,old 部分也最多收 0 个 Region,不会出现负预算。

### finalize_old_part:min/max 双边界 + 按 gc_efficiency 挑

`G1CollectionSet::finalize_old_part`(g1CollectionSet.cpp:410-498)只在 `in_mixed_phase()` 时执行。它先取两个数值边界:

```cpp
// g1CollectionSet.cpp:414-420(截取核心,逐字)
if (collector_state()->in_mixed_phase()) {
  cset_chooser()->verify();
  const uint min_old_cset_length = _policy->calc_min_old_cset_length();
  const uint max_old_cset_length = _policy->calc_max_old_cset_length();
```

`calc_min_old_cset_length`(g1Policy.cpp:1105-1124)让本轮至少挑一批,保证即便候选 Region 都贵,也能在期望的 Mixed 次数内把它们收完——`candidates / G1MixedGCCountTarget`,默认 G1MixedGCCountTarget = 8(g1_globals.hpp:246),即最多 8 次 Mixed 收完所有候选:

```cpp
// g1Policy.cpp:1116-1123(截取核心,逐字)
const size_t region_num = (size_t) cset_chooser()->length();
const size_t gc_num = (size_t) MAX2(G1MixedGCCountTarget, (uintx) 1);
size_t result = region_num / gc_num;
if (result * gc_num < region_num) {
  result += 1;
}
return (uint) result;
```

`calc_max_old_cset_length`(g1Policy.cpp:1126-1141)给单次 Mixed 封顶,避免一次把老年代比例挤爆暂停——`堆 Region 总数 × G1OldCSetRegionThresholdPercent / 100`,默认 G1OldCSetRegionThresholdPercent = 10(g1_globals.hpp:264):

```cpp
// g1Policy.cpp:1132-1140(截取核心,逐字)
const size_t region_num = g1h->num_regions();
const size_t perc = (size_t) G1OldCSetRegionThresholdPercent;
size_t result = region_num * perc / 100;
if (100 * result < region_num * perc) {
  result += 1;
}
return (uint) result;
```

然后是挑 Region 的主循环(g1CollectionSet.cpp:422-483)。它有一个先决门控:`check_time_remaining = _policy->adaptive_young_list_length()`(g1CollectionSet.cpp:420)。默认(自适应 young 大小)下为 true,才按时间预算挑;若用户用 `-XX:NewRatio`/`-Xmn` 等把 young 代大小固定死,`adaptive_young_list_length()` 为 false,循环完全不看预算,收到 min 就停。默认路径下的完整停止条件有四个:

1. `peek()` 为空——候选用完;
2. `old_region_length() >= max_old_cset_length`——被封顶;
3. `remaining_reclaimable_bytes()` 占比掉到 `G1HeapWastePercent` 以下——剩余收益不足;
4. 预测当前 Region 耗时 `> time_remaining_ms`(超预算),且已到达 min——没必要为收益低的下一个 Region 透支暂停目标。

```cpp
// g1CollectionSet.cpp:446-480(截取核心,逐字)
double predicted_time_ms = predict_region_elapsed_time_ms(hr);
if (check_time_remaining) {
  if (predicted_time_ms > time_remaining_ms) {
    if (old_region_length() >= min_old_cset_length) {
      break; // 已到 min,超预算就停
    }
    expensive_region_num += 1; // 没到 min,再贵也得收
  }
}
...
time_remaining_ms = MAX2(time_remaining_ms - predicted_time_ms, 0.0);
cset_chooser()->pop();
add_old_region(hr);
hr = cset_chooser()->peek();
```

所以决策不是"贪心到预算用完为止"这么简单,而是:

- **max 兜底**:绝不一次收超过堆 10% 的 Region;
- **waste 兜底**:剩余可回收空间不足 5% 就停,收益摊不满;
- **min 兜底**:超预算?只要还没到 min,贵也得收——保证候选能尽快清完、Mixed 阶段不会无限拖长。

### "收益"不是存活率,是 gc_efficiency

候选谁先谁后,由 `CollectionSetChooser` 里的 `order_regions` 决定(collectionSetChooser.cpp:41-61):按 `hr->gc_efficiency()` 降序。

而 `gc_efficiency` 的定义(heapRegion.cpp:142-154)是:

```cpp
// heapRegion.cpp:151-153(截取核心,逐字)
double region_elapsed_time_ms =
  g1p->predict_region_elapsed_time_ms(this, false /* for_young_gc */);
_gc_efficiency = (double) reclaimable_bytes() / region_elapsed_time_ms;
```

**可回收字节 ÷ 预测回收耗时**。这是一个比值:存活少、但扫起来便宜的 Region 排前面;存活多、RSet 又大的 Region 排后面。这样一来,如果暂停预算提前耗尽,被跳过的恰好就是最不划算的 Region——这正是"暂停目标约束下让回收收益最大化"的直接体现。

顺便对齐一个常见误解:有人以为候选是按 liveness 单纯排序的。不是。liveness 只决定"要不要进候选"(85% 阈值),**进了候选之后,排序用的是"每毫秒能收回来多少"**。

---

## 7. 误解澄清与收网

1. **标记完是否一定进入一长串连续 Mixed?** 不是。cleanup 末尾先问 `next_gc_should_be_mixed`(候选非空 + 可回收占比 > 5%),Mixed 阶段内每个 Mixed 暂停结束还要复检一次,占比掉下去就切回 Young-only。
2. **IHOP 是否就是固定 45%?** 不一定。45% 只是 `InitiatingHeapOccupancyPercent` 的初始值;`G1UseAdaptiveIHOP` 默认 true,实际阈值 = 安全线 − 预测标记期间占用(晋升量 + 无约束 young 大小),随历史动态移动。
3. **预测是否只用于暂停目标?** 不是。`G1Predictions` 是公用管道:IHOP 预测标记时长、`finalize` 预测单 Region 耗时、甚至 base time 也都是同一套 `get_new_prediction`。
4. **gc_efficiency 是否是单纯的 liveness?** 不是。它是"可回收字节 / 预测耗时",liveness 只在进候选时当 85% 过滤条件。
5. **单次 Mixed 是否收得越多越好?** 不是。max(堆 10%)+ waste(剩余占比 5%)+ 预算三重封顶;反过来 min 在最坏情况下保证"贵也得收几块"。另外,按预算挑只在 `adaptive_young_list_length()`(默认)下生效,固定 young 大小时收满 min 即停。

把这一篇压成三句话:

- IHOP 决定**何时标记**:安全线,减去"从现在到标记完成还会占用多少"。
- Mixed 判定决定**是否 Mixed**:候选非空,且剩余可回收占比值得一次暂停。
- CSet 选择决定**收哪些**:Young 全收,Old 在预算内按"每毫秒回收量"从大到小挑,min 保证清完、max 保证不超。

三件事背后是同一句话:**G1 把应用给的暂停软目标,在每一处都折算成时间预测与预算,然后尽量让所有选择以这个预算为锚——同时用 min/max/adaptive 三处门控兜底,避免"一个预测失误就全面脱锚"。** 但暂停目标约束的对象不是标记本身,而是"收的时候别超时"。标记、RSet、分配都已经就位——下一篇就要看 G1 写屏障了:前面反复提到的 pre/post barrier,在字节码层面到底做了什么,为什么 G1 的写屏障是"最重"的。

> → [06-g1-barrier.md](06-g1-barrier.md)