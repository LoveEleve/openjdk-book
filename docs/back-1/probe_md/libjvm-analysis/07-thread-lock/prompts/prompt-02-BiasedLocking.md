# PROMPT: 请撰写 P0-02 BiasedLocking.md

## 一、任务

撰写一篇 500-550 行的深度 JVM 源码分析文档，主题：**偏向锁(BiasedLocking)全机制**。

目标读者：已读过 [03-BasicLock-Synchronizer] `fast_enter`/`slow_enter`/`inflate` 和 [01-ObjectMonitor] `enter`/`exit` 的读者，现在需要理解锁升级路径的**最前端优化**——为什么大多数 `synchronized` 获取都是同一个线程重入（文献报告 >80%），从而可以一次 CAS 后就再也不碰对象头。注意：偏向锁机制是 GC-**无关**的（Serial/Parallel/G1 通用）。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（Region=4MB, 2048个）
- 64 位 Linux x86

## 三、源文件与关键函数（已验证行号）

| 文件 | 函数 | 行号 |
|------|------|:---:|
| `biasedLocking.hpp` | `BiasedLocking` 类 + `Condition` 枚举 | 148-193 |
| `biasedLocking.hpp` | `BiasedLockingCounters` 类（7 个计数器） | 111-145 |
| `biasedLocking.cpp` | `revoke_bias()` | 155 |
| `biasedLocking.cpp` | `update_heuristics()` | 321 |
| `biasedLocking.cpp` | `HeuristicsResult` 枚举 (4 种) | 313 |
| `biasedLocking.cpp` | `bulk_revoke_or_rebias_at_safepoint()` | 374 |
| `biasedLocking.cpp` | `VM_RevokeBias` 类 | 495 |
| `biasedLocking.cpp` | `VM_BulkRevokeBias` 类 | 566 |
| `biasedLocking.cpp` | `revoke_and_rebias()` ★ 主入口 | 624 |
| `biasedLocking.cpp` | `revoke_at_safepoint()` | 751 |
| `markOop.hpp` | `biased_lock_pattern=5`, biased 访问器 | 154,173-203 |
| `markOop.hpp` | `encode(JavaThread*, age, epoch)` | 313-319 |
| `globalDefinitions.hpp` | `UseBiasedLocking`, 6 个 `-XX:` 参数 | 964-987 |
| `interpreterRuntime.cpp` | `monitorenter()` → fast_enter(attempt_rebias=true) | 786 |
| `macroAssembler_x86.cpp` | `biased_locking_enter()` 汇编快速路径 | 1110-1299 |
| `synchronizer.cpp` | `fast_enter()` 调用 `revoke_and_rebias` | 265 |
| `synchronizer.cpp` | `FastHashCode()` 调用 `revoke_and_rebias`(false) | 719 |

## 四、完整源文件内容

请仔细阅读以下源码后撰写文档。所有源码片段必须含精确行号。

### 4.1 biasedLocking.hpp 核心定义 (:111-193)

```cpp
// biasedLocking.hpp:111-145 — 7 个计数器
class BiasedLockingCounters {
 private:
  int _total_entry_count;             // 总获取次数
  int _biased_lock_entry_count;       // 命中偏向的次数（★ 快速路径命中率）
  int _anonymously_biased_lock_entry_count; // 首次获取匿名偏向
  int _rebiased_lock_entry_count;     // 重偏向次数
  int _revoked_lock_entry_count;      // 撤销次数
  int _fast_path_entry_count;         // 快速路径
  int _slow_path_entry_count;         // 慢速路径 = total - fast_path
};

// biasedLocking.hpp:148-193 — BiasedLocking 类 (继承 AllStatic)
class BiasedLocking : AllStatic {
public:
  enum Condition {                     // L161-165
    NOT_BIASED = 1,                    // 对象已经没有偏向了
    BIAS_REVOKED = 2,                  // 偏向已撤销 (对象现在是 neutral)
    BIAS_REVOKED_AND_REBIASED = 3      // ★ 偏向已撤销并重偏向给新线程
  };

  static Condition revoke_and_rebias(Handle obj, bool attempt_rebias, TRAPS);
  static void revoke_at_safepoint(Handle obj);
  static void revoke_at_safepoint(GrowableArray<Handle>* objs);
  static void revoke(GrowableArray<Handle>* objs);
  static bool enabled();
};
```

### 4.2 markOop.hpp 偏向位编码（完整，已验证）

```cpp
// markOop.hpp:154 — 偏向锁位模式
enum { biased_lock_pattern = 5 };   // 二进制: 101 (lock=01 + biased_lock=1)

// markOop.hpp:173 — 判断是否为偏向模式
bool has_bias_pattern() const {
  return (mask_bits(value(), biased_lock_mask_in_place) == biased_lock_pattern);
}

// markOop.hpp:176-184 — 偏向持有者
JavaThread* biased_locker() const {
  return (JavaThread*) ((intptr_t)
    (mask_bits(value(), ~(biased_lock_mask_in_place | age_mask_in_place | epoch_mask_in_place))));
}
bool is_biased_anonymously() const {
  return (has_bias_pattern() && (biased_locker() == NULL));
}

// markOop.hpp:313-319 — 偏向锁 encode
static markOop encode(JavaThread* thread, uint age, int bias_epoch) {
  intptr_t tmp = (intptr_t) thread;
  assert(UseBiasedLocking && ((tmp & (epoch_mask_in_place | age_mask_in_place
                                     | biased_lock_mask_in_place)) == 0),
         "misaligned JavaThread pointer");
  return (markOop) (tmp | (bias_epoch << epoch_shift)
                         | (age << age_shift)
                         | biased_lock_pattern);
}
```

**64 位 biased 位布局** (和 `markOop.hpp:47` 注释完全一致，注意 `cms_free:1` 在 bit 7，G1GC 下无意义)：

```
63                                                    10 9  8 7 6 5 4 3 2 1 0
┌────────────────────────────────────────────────────┬──────┬─┬───┬─────────┐
│              JavaThread*:54                         │epoch:2│c│age:4│ 1 0 1 │
└────────────────────────────────────────────────────┴──────┴─┴───┴─────────┘
                                                       free:1 (CMS专用,G1忽略)
                                                    biased_lock=1, lock=01
```

> **关键约束**：JavaThread* 嵌入 markOop 需要 epoch(bit9-8)、cms_free(bit7)、age(bit6-3)、lock/biased(bit2-0) 全部为 0 → **低 10 bit 必须为 0** → JavaThread 对象最小 **1024 字节对齐**（实际 `biased_lock_alignment = 2 << (epoch_shift+epoch_bits) = 2048`）。注释中的 "256 bytes" 是 32-bit VM 的旧值。

### 4.3 revoke_bias() — 核心撤销逻辑 (biasedLocking.cpp:155-310)

```cpp
// biasedLocking.cpp:155 — revoke_bias(oop obj, bool allow_rebias, bool is_bulk, ...)
static BiasedLocking::Condition revoke_bias(oop obj, bool allow_rebias,
    bool is_bulk, JavaThread* requesting_thread, JavaThread** biased_locker) {
  markOop mark = obj->mark();
  if (!mark->has_bias_pattern()) return BiasedLocking::NOT_BIASED; // L157: 已不是偏向

  uint age = mark->age();
  markOop biased_prototype   = markOopDesc::biased_locking_prototype()->set_age(age);
  markOop unbiased_prototype = markOopDesc::prototype()->set_age(age);

  JavaThread* biased_thread = mark->biased_locker();               // L200

  if (biased_thread == NULL) {                                     // L201: ★ 匿名偏向
    if (!allow_rebias) obj->set_mark(unbiased_prototype);          // L206
    return BiasedLocking::BIAS_REVOKED;
  }

  // L217-240: 偏向线程已死亡 → 直接设 mark (allow_rebias→biased_prototype, else→unbiased)
  bool thread_is_alive = (requesting_thread == biased_thread) ? true
                       : ThreadsListHandle().includes(biased_thread);
  if (!thread_is_alive) {
    obj->set_mark(allow_rebias ? biased_prototype : unbiased_prototype);
    return BiasedLocking::BIAS_REVOKED;
  }

  // L265-301: ★ 偏向线程还活着 → 遍历其栈帧, 找到对应的 Lock Record
  GrowableArray<MonitorInfo*>* cached_monitor_info = get_or_compute_monitor_info(biased_thread);
  BasicLock* highest_lock = NULL;
  for (int i = 0; i < cached_monitor_info->length(); i++) {
    MonitorInfo* mon_info = cached_monitor_info->at(i);
    if (mon_info->owner() == obj) {        // ★ 匹配到了！对象在偏向线程的栈上
      // 找到最高（最外层）的 Lock Record
      BasicLock* lock = mon_info->lock();
      if (highest_lock == NULL || lock < highest_lock) {
        highest_lock = lock;
      }
    }
  }
  if (highest_lock != NULL) {
    // ★ 对象正被偏向线程持有 → 升级为轻量锁!
    highest_lock->set_displaced_header(unbiased_prototype);  // L279: displaced header = unobias
    obj->set_mark(markOopDesc::encode(highest_lock));        // L281: ★ lock=00, 指向栈
    // ... 其他 Lock Record 设 displaced_header=NULL (重入标记)
  } else {
    // 对象未被持有 → 直接恢复为 neutral (allow_rebias→biased_prototype, else→unbiased)
  }
  return BiasedLocking::BIAS_REVOKED;                                    // L309
}
```

### 4.4 update_heuristics() — 启发式判断 (biasedLocking.cpp:321-371)

```cpp
// biasedLocking.cpp:313 — 四种启发式结果
enum HeuristicsResult {
  HR_NOT_BIASED    = 1,
  HR_SINGLE_REVOKE = 2,   // ★ 单对象撤销 — 但分两条子路径:
                           //   self-revoke (biased_locker==THREAD) → 直接 revoke_bias, 无 safepoint!
                           //   other-revoke → 发 VM_RevokeBias → safepoint
  HR_BULK_REBIAS   = 3,   // ★ 批量重偏向 (epoch++, 1 次 safepoint)
  HR_BULK_REVOKE   = 4    // ★ 批量永久撤销 (禁用该类偏向, 1 次 safepoint)
};

// biasedLocking.cpp:321 — update_heuristics(oop o, bool allow_rebias)
static HeuristicsResult update_heuristics(oop o, bool allow_rebias) {
  markOop mark = o->mark();
  if (!mark->has_bias_pattern()) return HR_NOT_BIASED;

  Klass* k = o->klass();
  jlong cur_time = os::javaTimeMillis();
  jlong last_bulk_revocation_time = k->last_biased_lock_bulk_revocation_time();
  int revocation_count = k->biased_lock_revocation_count();

  // ★ 时间衰减: 距上次批量操作 > BiasedLockingDecayTime(25s) → 重置计数器
  if ((revocation_count >= BiasedLockingBulkRebiasThreshold) &&
      (revocation_count <  BiasedLockingBulkRevokeThreshold) &&
      (last_bulk_revocation_time != 0) &&
      (cur_time - last_bulk_revocation_time >= BiasedLockingDecayTime)) {
    k->set_biased_lock_revocation_count(0);
    revocation_count = 0;
  }

  if (revocation_count <= BiasedLockingBulkRevokeThreshold) {
    revocation_count = k->atomic_incr_biased_lock_revocation_count();  // ★ 原子递增
  }

  if (revocation_count == BiasedLockingBulkRevokeThreshold) return HR_BULK_REVOKE;  // L362
  if (revocation_count >= BiasedLockingBulkRebiasThreshold)  return HR_BULK_REBIAS;  // L365
  return HR_SINGLE_REVOKE;                                                            // L370
}
```

**关键阈值** (globals.hpp:964-987)：

| 参数 | 默认值 | 含义 |
|------|:---:|------|
| `UseBiasedLocking` | `true` | 主开关 |
| `BiasedLockingStartupDelay` | `0` | 启动延迟(ms), 以前默认 4000 |
| `BiasedLockingBulkRebiasThreshold` | `20` | ★ 触发批量重偏向的每类撤销次数 |
| `BiasedLockingBulkRevokeThreshold` | `40` | ★ 触发永久批量撤销的每类撤销次数 |
| `BiasedLockingDecayTime` | `25000` | 时间衰减窗口(ms), 重置计数器 |

### 4.5 bulk_revoke_or_rebias_at_safepoint() (biasedLocking.cpp:374-484)

```cpp
// biasedLocking.cpp:374 — bulk_revoke_or_rebias_at_safepoint()
static BiasedLocking::Condition bulk_revoke_or_rebias_at_safepoint(
    oop o, bool bulk_rebias, bool attempt_rebias_of_object, JavaThread* requesting_thread) {
  assert(SafepointSynchronize::is_at_safepoint(), "must be done at safepoint");

  Klass* k_o = o->klass();

  if (bulk_rebias) {
    // ★ 批量重偏向: class 的 prototype_header.epoch++
    // → 所有旧 epoch 的偏向自动失效 → 线程下次获取时 CAS rebias
    klass->set_prototype_header(klass->prototype_header()->incr_bias_epoch());

    // 遍历所有线程栈: 更新该类对象的 markOop epoch 到新 epoch
    for (JavaThread *thr = ...) {
      for (MonitorInfo* mon_info : thr->cached_monitor_info()) {
        if (owner->klass() == k_o && mark->has_bias_pattern()) {
          owner->set_mark(mark->set_bias_epoch(cur_epoch));  // L424
        }
      }
    }
    revoke_bias(o, attempt_rebias_of_object && ..., true, requesting_thread, NULL);
  } else {
    // ★ 批量撤销: class 的 prototype_header 设为 unbiased (lock=01)
    // → 该类从此禁用偏向锁
    klass->set_prototype_header(markOopDesc::prototype());    // L443

    // 遍历所有线程栈: 强制撤销该类所有偏向对象
    for (JavaThread *thr = ...) {
      for (MonitorInfo* mon_info : thr->cached_monitor_info()) {
        if (owner->klass() == k_o && mark->has_bias_pattern()) {
          revoke_bias(owner, false, true, requesting_thread, NULL);  // L454
        }
      }
    }
  }
  // L469-476: 如果 attempt_rebias_of_object, 重偏向给 requesting_thread
  return status_code;
}
```

### 4.6 revoke_and_rebias() ★ 主入口 (biasedLocking.cpp:624-738)

> **`attempt_rebias` 语义先导**：此参数贯穿整个 `revoke_and_rebias` 函数，必须在理解源码前搞清楚：
>
> | caller | `attempt_rebias` | 含义 |
> |------|:---:|------|
> | `monitorenter`（解释器/汇编） | `true` | "我想把偏向转给我自己" → 走 epoch 过期重偏向 / 匿名偏向 CAS 获取 |
> | `hashCode` / `wait` / `notify` | `false` | "我只要撤销偏向就行，不用重偏向给我" → 走匿名撤销 / 直接撤销路径 |

```cpp
// biasedLocking.cpp:624 — revoke_and_rebias(Handle obj, bool attempt_rebias, TRAPS)
BiasedLocking::Condition BiasedLocking::revoke_and_rebias(Handle obj, bool attempt_rebias, TRAPS) {
  // ⚠️ 注意: 以下快速 CAS 和第二步 update_heuristics 之间非原子!
  // 另一线程可能在此间隙 CAS 改变对象头。update_heuristics 会重新读 markOop 来防御。

  // ★ 第一步: 尝试快速 CAS 撤销/重偏向 (无 safepoint!)
  markOop mark = obj->mark();

  if (mark->is_biased_anonymously() && !attempt_rebias) {         // L632
    // 匿名偏向: CAS 设为 unbiased → 成功即返回 BIAS_REVOKED
    markOop unbiased_prototype = markOopDesc::prototype()->set_age(mark->age());
    if (obj->cas_set_mark(unbiased_prototype, mark) == mark) return BIAS_REVOKED; // L642-646
  } else if (mark->has_bias_pattern()) {                          // L648
    Klass* k = obj->klass();
    markOop prototype_header = k->prototype_header();
    if (!prototype_header->has_bias_pattern()) {                  // L651: 类已永久禁用偏向
      // CAS 设为 prototype_header → BIAS_REVOKED
      obj->cas_set_mark(prototype_header, mark);
      return BIAS_REVOKED;
    } else if (prototype_header->bias_epoch() != mark->bias_epoch()) { // L662: epoch过期
      if (attempt_rebias) {
        // CAS 重偏向给当前线程 → BIAS_REVOKED_AND_REBIASED
        markOop rebiased = markOopDesc::encode((JavaThread*) THREAD, mark->age(),
                                                prototype_header->bias_epoch());
        if (obj->cas_set_mark(rebiased, mark) == mark) return BIAS_REVOKED_AND_REBIASED; // L675-676
      } else {
        // CAS 撤销 → BIAS_REVOKED
        ...
      }
    }
  }

  // ★ 第二步: 快速 CAS 都失败了 → 走启发式 (代码见 §4.4)
  HeuristicsResult heuristics = update_heuristics(obj(), attempt_rebias);  // L689

  if (heuristics == HR_SINGLE_REVOKE) {                                    // L692
    // ★ 分两条子路径:
    if (mark->biased_locker() == THREAD &&
        prototype_header->bias_epoch() == mark->bias_epoch()) {
      // 路径 2a: SELF-REVOKE — 撤销自己, 直接遍历自己栈, 无 safepoint!
      // 场景: 线程 T 持有偏向给 T 的对象, 然后调 hashCode → FastHashCode → revoke_and_rebias(false)
      Condition cond = revoke_bias(obj(), false, false, (JavaThread*) THREAD, NULL); // L709
      return cond;
    } else {
      // 路径 2b: OTHER-REVOKE — 撤销别人, 必须发 VM_RevokeBias → safepoint!
      VM_RevokeBias revoke(&obj, (JavaThread*) THREAD);                     // L718
      VMThread::execute(&revoke);
      return revoke.status_code();
    }
  } else {
    // ★ 批量操作 → 发 VM_BulkRevokeBias → safepoint!
    // HR_BULK_REBIAS: epoch++ (该类的旧偏向全部失效)
    // HR_BULK_REVOKE: prototype_header 设为 unbiased (该类从此禁用偏向)
    VM_BulkRevokeBias bulk_revoke(&obj, (JavaThread*) THREAD,
      (heuristics == HR_BULK_REBIAS), attempt_rebias);
    VMThread::execute(&bulk_revoke);
  }
}
```

### 4.7 汇编快速路径 逻辑翻译 (macroAssembler_x86.cpp:1110-1299)

> ⚠️ 以下为 **伪代码 / 逻辑翻译**，不是 `macroAssembler_x86.cpp` 的实际 C++ 源码。实际函数 `MacroAssembler::biased_locking_enter()` 通过 `__ movptr()`, `__ xorptr()`, `__ lock(); __ cmpxchgptr()` 等 Assembler API 直接生成 x86 机器码，而非以下注释流。这里翻译为逻辑等价物以便理解。

```cpp
// 逻辑等价: biased_locking_enter() 的六阶段决策
Phase1: andptr(tmp, biased_lock_mask); cmpptr(tmp, 5);     // 低3位==101?
        jne → cas_label;                                   // 不是偏向 → 回退到 CAS 栈锁

Phase2: xorptr(swap, mark_addr);                           // 是当前线程吗?
        je → done;                                          // ★ 是 → 0 次 CAS, 直接返回!

Phase3: xorptr(swap, temp);                                // 检查 biased_lock bit 变化
        jne → try_revoke_bias;                             // 偏向 bit 被清除 → 撤销
        andptr(tmp, epoch_mask); cmpptr(tmp, new_epoch);   // epoch 检查
        jne → try_rebias;                                  // epoch 过期 → 重偏向

Phase4: lock cmpxchgptr(swap, mark_addr);                  // ★ 匿名偏向: CAS 安装当前线程
        jne → slow_case;

try_rebias:
Phase5: lock cmpxchgptr(swap, mark_addr);                  // ★ 重偏向: CAS encode(thread,age,new_epoch)
        jne → slow_case;

try_revoke_bias:
Phase6: lock cmpxchgptr(swap, mark_addr);                  // ★ 撤销: CAS 安装 unbiased prototype
        jne → slow_case;

cas_label:
Phase7: 回退到标准 CAS 栈锁 (slow_enter 路径)
```

### 4.8 synchronizer.cpp 中的调用点

```cpp
// synchronizer.cpp:265 — fast_enter(): 每次 monitorenter 都经过这里
void ObjectSynchronizer::fast_enter(Handle obj, BasicLock* lock, bool attempt_rebias, TRAPS) {
  if (UseBiasedLocking) {
    if (!SafepointSynchronize::is_at_safepoint()) {
      Condition cond = BiasedLocking::revoke_and_rebias(obj, attempt_rebias, THREAD); // L269
      if (cond == BIAS_REVOKED_AND_REBIASED) return; // ★ 偏向锁获取成功!
    }
  }
  slow_enter(obj, lock, THREAD); // → 轻量锁/重量锁
}

// synchronizer.cpp:719 — FastHashCode(): hashCode 与偏向锁冲突
intptr_t ObjectSynchronizer::FastHashCode(Thread* Self, oop obj) {
  if (UseBiasedLocking) {
    if (obj->mark()->has_bias_pattern()) {                          // L728
      BiasedLocking::revoke_and_rebias(hobj, false, JavaThread::current()); // L735
      // ★ attempt_rebias=false: 偏向锁和 hash 不能共存 → 必须撤销
    }
  }
  // ... 后续计算 hash
}
```

### 4.9 interpreterRuntime.cpp — 解释器入口 (已验证)

```cpp
// interpreterRuntime.cpp:786 — monitorenter 解释器入口
IRT_ENTRY_NO_ASYNC(void, InterpreterRuntime::monitorenter(JavaThread* thread, BasicObjectLock* elem))
  if (UseBiasedLocking) {
    ObjectSynchronizer::fast_enter(h_obj, elem->lock(), true, CHECK); // L800
    // ★ attempt_rebias=true: 解释器允许重偏向
  } else {
    ObjectSynchronizer::slow_enter(h_obj, elem->lock(), CHECK);
  }
IRT_END
```

## 五、文章结构（严格遵循）

```
§〇 源文件清单（7 个文件表格，含本文角色列）

§一 核心原理
  1.1 解决什么问题 — 为什么 80%+ 的 synchronized 获取是同一个线程？偏向锁如何把"获取"降为 0 次 CAS？
  1.2 数量级直觉 — 偏向锁获取(1次指针比较, ~1c) vs 轻量锁 CAS(~20c) vs 重量锁 park(~10000c)
  1.3 偏向锁的"为什么" — ❓ 为什么不是所有对象都适合偏向？为什么有启动延迟？

§二 数据结构
  2.1 markOop 偏向位布局: [JavaThread*:54][epoch:2][cms_free:1][age:4][101]
  2.2 偏向锁 vs 无锁的 markOop 字段对比 (偏向状态 age 还在 / hash 被驱逐 / unused 变 JavaThread*)
  2.3 匿名偏向 (biased_locker==NULL) 的含义: "谁先拿归谁"
  2.4 ★ Klass.prototype_header — 类级别偏向策略控制: `biased_locking_prototype()`(=101) vs `prototype()`(=01)，前者表示"该类允许偏向"，后者表示"该类永久禁用偏向"。bulk_revoke 的本质就是把 prototype_header 从 biased 切为 unbiased
  2.5 `biased_prototype` vs `unbiased_prototype` 的区别: 前者来自 `markOop(biased_lock_pattern=5)`，后者来自 `markOop(unlocked_value=1)`——revoke_bias 中 `allow_rebias` 控制选哪个

§三 偏向获取 — 速度的极致
  3.1 汇编快速路径: biased_locking_enter() 六阶段 (宏汇编注释翻译为伪代码)
  3.2 首次偏向 (匿名→当前线程): 1 次 CAS
  3.3 偏向重入 (同一线程再次获取): 0 次 CAS, 仅指针比较 ★
  3.4 fast_enter → revoke_and_rebias(attempt_rebias=true) 的路径
  Mermaid 决策流程图

§四 偏向撤销 — revoke_bias() 源码逐行
  4.1 三种轻量撤销: 匿名偏向 / 死线程 / 锁未被持有
  4.2 ★ 核心: 偏向持有者正在临界区 → 遍历其栈帧 → 找到最高 Lock Record → 升级为轻量锁
  4.3 displaced_header 的设置: 最外层 = unbiased_prototype, 其余 = NULL(重入)
  4.4 撤销后对象处于什么状态？→ neutral (无锁, 可重偏向或禁用偏向)

§五 revoke_and_rebias() — 主入口 + 启发式
  5.1 快速路径 (无 safepoint): 匿名撤销 / epoch过期CAS / 类禁用CAS / ★ self-revoke — 四种全无 safepoint
  5.2 HeuristicsResult 四种结果: NOT_BIASED / SINGLE_REVOKE / BULK_REBIAS / BULK_REVOKE
  5.3 update_heuristics() 阈值变迁: 0→20→40 + 时间衰减(25s)
  5.4 HR_SINGLE_REVOKE 双路径: self-revoke(无safepoint, 遍历自己栈) vs other-revoke(VM_RevokeBias safepoint)
  5.5 VM_BulkRevokeBias: BULK_REBIAS(epoch++) vs BULK_REVOKE(永久禁用)
  Mermaid 流程图: revoke_and_rebias 全路径（含 self-revoke 捷径）

§六 Epoch 机制 — 批量优雅撤销
  6.1 为什么需要 epoch？— 避免 per-object 撤销，让类级别的 epoch++ 一次性"失效"所有旧偏向
  6.2 bulk_revoke_or_rebias_at_safepoint() 的两种路径: rebias(epoch++) vs revoke(unbiased prototype)
  6.3 epoch 在栈帧遍历中的作用: 更新已锁对象的 epoch 到新值
  6.4 批量重偏向 vs 批量撤销的触发器: 撤销次数≥20→rebias, ≥40→永久禁用

§七 强制撤销触发 — 与 hashCode/wait/notify 的冲突
  7.1 hashCode 冲突: revoke_and_rebias(attempt_rebias=false) → revoke_bias → set_mark(unbiased)
  7.2 wait/notify 冲突: 必须先撤销才能 inflate 到 ObjectMonitor
  7.3 冲突矩阵表: 偏向锁 vs 各种 JVM 操作

§八 GDB 验证 + 可证伪断言 (≥8 条)
  每条含: 断言/验证命令/预期值
  Java 实验代码: 用 `-XX:+UnlockDiagnosticVMOptions -XX:+PrintBiasedLockingStatistics` 验证批量撤销阈值

§九 一句话总结 + 交叉引用
```

## 六、风格要求（MEMORY 方法论）

1. **❓ "为什么"驱动**: 每个大节开头必须有 `> ❓ 为什么需要X？` 的问答块
2. **粒度显式标注**: 每个字段标注粒度（JavaThread*:54bit / epoch:2bit / age:4bit / 3bit lock），禁止"线程指针"这种模糊描述
3. **源代码行号**: 所有源码片段标注 `biasedLocking.cpp:155` 格式的精确行号
4. **"为什么"块至少 4 处**: §一(为什么需要偏向锁)、§四(为什么撤销时需要遍历栈帧)、§六(为什么 epoch 比 per-object 撤销好)、§四(为什么撤销需要 safepoint)
5. **可证伪断言 ≥8 条**: 每条有具体 GDB 命令 + 预期值
6. **数量级直觉**: 至少 2 处(偏向锁获取 1c vs 轻量锁 CAS 20c vs 重量锁 park 10000c + 三阶段周期对比)
7. **交叉引用**: 文末标注 [01-ObjectMonitor] inflate、[03-BasicLock-Synchronizer] slow_enter/fast_enter
8. **不低于 500 行、不超过 600 行**
9. **禁止编造函数名**: 所有函数名来自源码
10. **可验证实验**: §八 包含 Java 实验: `-XX:+UnlockDiagnosticVMOptions -XX:+PrintBiasedLockingStatistics` + 多线程竞争触发批量撤销（`PrintBiasedLockingStatistics` 是 diagnostic 标志，需要 `UnlockDiagnosticVMOptions`）

### 关键 "为什么" 的预期答案

| ❓ 问题 | 核心洞察（展开时基于此） |
|------|------|
| 为什么需要偏向锁？ | 大多数 Java 锁"总是同一个线程反复获取"（实测 >80%）。偏向锁把获取从每次 CAS 降为：首次 1 次 CAS 安装线程指针，之后每次只需比较指针（0 次 CAS）。轻量锁每次都得 CAS |
| 为什么撤销时遍历栈帧？ | 偏向线程可能正在临界区里——如果直接改对象头，该线程 monitorexit 时会莫名其妙看到锁状态变了。必须找到它栈上对应的 Lock Record，把对象从偏向态"升级"到轻量锁态（设置 displaced_header → CAS 栈指针到对象头） |
| 为什么 epoch 比 per-object 撤销好？ | 该类的对象频繁多线程竞争 → 每个对象单独撤销要发 N 次 VM_RevokeBias（N 次 safepoint + N 次栈遍历）。epoch++ 把 N 次 safepoint 合并为 1 次：1 次 safepoint + 1 次全线程栈遍历 + 1 次 epoch++ store。safepoint 本身的开销（Stop-The-World）远大于栈遍历——把"N 次暂停世界"变成"1 次暂停世界"是核心收益 |
| 为什么 hashCode 与偏向锁互斥？ | 偏向锁用 hash 位存 JavaThread*(54bit)，hash 本身需要 31bit 空间。两者抢同一块区域 → 必然互斥。调用 hashCode 时必须撤销偏向 |
| 为什么偏向撤销需要 safepoint (Stop-The-World)？ | 如果偏向持有者 T1 正在临界区运行，T2 不能安全地修改其栈帧或对象头——T1 可能正写对象头、可能 displaced header 在寄存器中。safepoint 确保 T1 停在已知安全点（`_thread_blocked`），且所有寄存器/栈帧状态已落盘，然后 VMThread 才能安全遍历 T1 栈帧找到 Lock Record |
| 为什么有 4 秒启动延迟(旧版) / 为什么门槛是 20/40？ | JVM 启动时大量类加载器锁只有初始化阶段需要——偏向它们产生大量无意义撤销。延迟给 warmup 留时间。20/40 是经验值：撤销次数少 = 偶发竞争，值得保留偏向；20+ = 这个类的锁被频繁多线程竞争，应该批量重偏向；40+ = 这个类的偏向已经毫无价值，永久禁用 |

### 可证伪断言（至少 8 条）

| # | 断言 | 验证 |
|---|------|------|
| 1 | 偏向锁命中时 `fast_enter` 在 `revoke_and_rebias` 返回 `BIAS_REVOKED_AND_REBIASED` 后直接 return | GDB break `synchronizer.cpp:271`，cond==3 后不走 slow_enter |
| 2 | 匿名偏向对象首次 CAS 获取成功后 `obj->mark()->biased_locker()` = 当前线程 | GDB: `p obj->mark()->biased_locker()` 返回后 == THREAD |
| 3 | 汇编快速路径中重入只需 1 次 `xorptr` + 1 次 `jcc`，0 次 `lock cmpxchg` | 源码 `macroAssembler_x86.cpp:1160-1173` |
| 4 | `revoke_bias` 当持有者在临界区时，`highest_lock->displaced_header()` = `unbiased_prototype` | GDB break `biasedLocking.cpp:279` 后: `p/x highest_lock->displaced_header()` |
| 5 | 批量重偏向后 klass.prototype_header.epoch 递增 1 | GDB: `p klass->prototype_header()->bias_epoch()`, 批量前 vs 后 |
| 6 | 批量撤销后 `klass->prototype_header()->has_bias_pattern()` = false | GDB: `p klass->prototype_header()->has_bias_pattern()` → false |
| 7 | self-revoke 场景: `biased_locker==THREAD` → 不发 safepoint，直接 `revoke_bias` | GDB break `biasedLocking.cpp:709`，`p cond` → BIAS_REVOKED |
| 8 | `update_heuristics` 在 `revocation_count < 20` 时返回 `HR_SINGLE_REVOKE` | GDB: 第一次撤销后 `p ret` → 2 |
| 9 | 时间衰减: `BiasedLockingDecayTime=25s` 后 revocation_count 重置为 0 | 源码 `biasedLocking.cpp:353`: `set_biased_lock_revocation_count(0)` |
| 10 | hashCode 调用后 `obj->mark()->has_bias_pattern()` = false | GDB: `FastHashCode` 返回后 `p obj->mark()->has_bias_pattern()` → false |

### 风格参考: 对标 03-BasicLock-Synchronizer.md 的质量锚点

- 03 §五 inflate 双 CAS 协议完整循环 → 02 应对标: `revoke_and_rebias` 快速 CAS × 4 (匿名/epoch/类禁用/self-revoke) + 启发式变迁的完整 Mermaid
- 03 §六 hashCode 六种策略对比表 → 02 应对标: 三阶段锁"获取代价"对比表 (~1c vs ~20c vs ~10000c) + `attempt_rebias` true/false 对比表
- 03 §四 跨线程读栈的可见性因果链 → 02 应对标: 为什么撤销时遍历栈帧的完整因果链 (不能直接改对象头 → 需要找到 Lock Record → 设置 displaced_header)
- 03 §五 INFLATING(0) 哨兵机制 → 02 应对标: epoch 哨兵机制 (epoch++ 让旧偏向失效) + HR_SINGLE_REVOKE 的 self-revoke 捷径 (不经过 safepoint)

## 七、输出格式

- Markdown 文件，命名为 `02-BiasedLocking.md`
- 元信息头（标准环境 + 源文件 + 前置 + 关联 + 阅读收益）
- 章节用 `## §X` / `### X.X` 格式
- 代码块用 ` ```cpp ` 标记
- Mermaid 图用 ` ```mermaid ` 标记
