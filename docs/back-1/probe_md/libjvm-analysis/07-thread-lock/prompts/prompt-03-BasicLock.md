# PROMPT: 请撰写 P0-03 BasicLock-Synchronizer.md

## 一、任务

撰写一篇 500-550 行的深度 JVM 源码分析文档，主题：**轻量级锁(BasicLock) + 锁膨胀(inflate) + hashCode 六种策略**。

目标读者：已读过 [01-ObjectMonitor] enter/exit 的读者，现在需要理解 synchronized 的**前两级优化**——轻量锁和偏向锁之间的桥梁。注意：轻量锁机制是 GC-**无关**的（Serial/Parallel/G1 通用），不是 G1 特有。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（Region=4MB, 2048个）
- 64 位 Linux x86

## 三、源文件与关键函数（已验证行号）

| 文件 | 函数 | 行号 |
|------|------|:---:|
| `synchronizer.cpp` | `fast_enter()` | 265 |
| `synchronizer.cpp` | `slow_enter()` | 340 |
| `synchronizer.cpp` | `inflate()` | 1403 |
| `synchronizer.cpp` | `deflate_idle_monitors()` | 1747 |
| `synchronizer.cpp` | `get_next_hash()` | 678 |
| `synchronizer.cpp` | `FastHashCode()` | 719 |
| `basicLock.hpp` | `BasicLock` 类 | 31-46 |
| `basicLock.hpp` | `BasicObjectLock` 类 | 57-78 |
| `markOop.hpp` | 64位位布局 | 30-58 |

## 四、完整源文件内容

请仔细阅读以下源码后撰写文档。所有源码片段必须含精确行号。

### 4.1 fast_enter + slow_enter (synchronizer.cpp:265-400)

```cpp
// synchronizer.cpp:265 — fast_enter()
void ObjectSynchronizer::fast_enter(Handle obj, BasicLock* lock, bool attempt_rebias, TRAPS) {
  if (UseBiasedLocking) {
    if (!SafepointSynchronize::is_at_safepoint()) {
      BiasedLocking::Condition cond = BiasedLocking::revoke_and_rebias(obj, attempt_rebias, THREAD);
      if (cond == BiasedLocking::BIAS_REVOKED_AND_REBIASED) {
        return;  // ★ 偏向锁获取成功, 直接返回!
      }
    } else {
      assert(!attempt_rebias, "can not rebias toward VM thread");
      BiasedLocking::revoke_at_safepoint(obj);
    }
    assert(!obj->mark()->has_bias_pattern(), "biases should be revoked by now");
  }

  // ★ 轻量锁获取: CAS 将 BasicLock* 安装到对象头
  slow_enter(obj, lock, THREAD);
}

// synchronizer.cpp:340 — slow_enter()
void ObjectSynchronizer::slow_enter(Handle obj, BasicLock* lock, TRAPS) {
  markOop mark = obj->mark();                           // 读当前对象头

  if (mark->is_neutral()) {                              // ★ unlocked?
    // Anticipate successful CAS — the ST of the displaced mark into
    // the lock record is visible to other threads before the CAS.
    // CAS success → ST of the lock record is enforced per memory model.
    lock->set_displaced_header(mark);
    if (mark == obj->cas_set_mark((markOop) lock, mark)) {
      TEVENT(slow_enter: release stacklock);
      return;                                            // ★ 轻量锁获取成功!
    }
    // Fall through to inflate() ...
  } else if (mark->has_locker() &&                       // ★ 轻量锁已在?
             THREAD->is_lock_owned((address)mark->locker())) {
    assert(lock != mark->locker(), "must not re-lock the same lock");
    assert(NULL != mark->locker(), "should not be null pointer");
    lock->set_displaced_header(NULL);                    // ★ 重入: displaced_header=NULL
    return;
  }

  // ★ 膨胀为重量锁
  lock->set_displaced_header(markOopDesc::unused_mark());
  ObjectSynchronizer::inflate(THREAD, obj(), inflate_cause_monitor_enter);
}
```

### 4.2 inflate() (synchronizer.cpp:1390-1550) — 完整函数

```cpp
// 五种膨胀原因 (注意: 源码注释写的"三种"是旧的，实际 5 种):
// inflate_cause_vm_internal  = 0   // VM 内部原因 (如 hashCode 膨胀、JNI monitor 操作)
// inflate_cause_monitor_enter = 1  // monitorenter 竞争 → slow_enter → inflate ★ 最常见
// inflate_cause_wait         = 2  // Object.wait() 需要 ObjectMonitor
// inflate_cause_notify       = 3  // Object.notify() 需要 ObjectMonitor
// inflate_cause_hash_code    = 4  // System.identityHashCode()
ObjectMonitor* ObjectSynchronizer::inflate(Thread * Self, oop object,
                                           const ObjectSynchronizer::InflateCause cause) {
  EventJavaMonitorInflate event;

  for (;;) {    // ★ 经典的 inflate 循环
    const markOop mark = object->mark();

    // ① 已是膨胀态? → 直接返回已有 ObjectMonitor
    if (mark->has_monitor()) {
      ObjectMonitor * inf = mark->monitor();
      return inf;
    }

    // ② 正在被其他线程膨胀中? → 自旋等待
    if (mark == markOopDesc::INFLATING()) {
      ReadStableMark(object);
      continue;
    }

    // ③ 尝试"安装" INFLATING 标记——抢膨胀权
    if (mark->has_bias_pattern() ||        // 仍是偏向状态?
        (mark == markOopDesc::INFLATING()) // INFLATING?
       ) {
      continue;
    }

    // ★ CAS 安装 INFLATING 标记
    if (object->cas_set_mark(markOopDesc::INFLATING(), mark) != mark) {
      continue;  // CAS 失败 → 别人抢了
    }

    // ★ CAS 成功 → 我来膨胀!
    ObjectMonitor * m = (cause == inflate_cause_vm_internal)
                          ? new ObjectMonitor()
                          : omAlloc(Self);  // ★ 从全局 ObjectMonitor 池分配

    m->Recycle();  // 重置 ObjectMonitor
    m->set_object(object);

    // ★ 关键: 计算 displaced header
    // 保存膨胀前的 markOop 到 ObjectMonitor._header
    m->set_header(mark->has_locker()
                    ? markOopDesc::unused_mark()   // 轻量锁被持有
                    : (mark->has_bias_pattern()
                        ? markOopDesc::prototype()  // 偏向状态
                        : mark));                   // 无锁状态(含 hashCode)

    // ★★ CAS 将 ObjectMonitor* 安装到对象头
    if (object->cas_set_mark(markOopDesc::encode(m), markOopDesc::INFLATING())
        != markOopDesc::INFLATING()) {
      // CAS 失败 → 释放 ObjectMonitor（极其罕见）
      m->set_object(NULL);
      omRelease(Self, m, true);
      continue;
    }

    // ★ 膨胀成功!
    if (cause != inflate_cause_vm_internal) {
      m->_owner = NULL;     m->_recursions = 0;
      m->_Responsible = NULL;
    }
    return m;
  }
}
```

### 4.3 get_next_hash + FastHashCode (synchronizer.cpp:678-780)

```cpp
// synchronizer.cpp:678 — 六种 hashCode 策略
static inline intptr_t get_next_hash(Thread * Self, oop obj) {
  intptr_t value = 0;
  if (hashCode == 0) {
    // 0: Park-Miller 伪随机数生成器
    value = os::random();                    // 调用 /dev/urandom
  } else if (hashCode == 1) {
    // 1: 基于对象地址 XOR 随机数
    intptr_t addrBits = cast_from_oop<intptr_t>(obj) >> 3;
    value = addrBits ^ (addrBits >> 5) ^ GVars.stwRandom;
  } else if (hashCode == 2) {
    // 2: 始终返回 1 (测试用)
    value = 1;
  } else if (hashCode == 3) {
    // 3: 自增序列 (全局计数器)
    value = ++GVars.hcSequence;
  } else if (hashCode == 4) {
    // 4: 对象地址 (不压缩)
    value = cast_from_oop<intptr_t>(obj);
  } else {
    // 5: Marsaglia XOR-Shift 算法 (JDK8+ 默认)
    unsigned t = Self->_hashStateX;
    t ^= (t << 11);
    Self->_hashStateX = Self->_hashStateY;
    Self->_hashStateY = Self->_hashStateZ;
    Self->_hashStateZ = Self->_hashStateW;
    unsigned v = Self->_hashStateW;
    v = (v ^ (v >> 19)) ^ (t ^ (t >> 8));
    Self->_hashStateW = v;
    value = v;
  }

  value &= markOopDesc::hash_mask;  // 取低 31 位
  if (value == 0) value = 0xBAD;
  return value;
}

// synchronizer.cpp:719 — FastHashCode
intptr_t ObjectSynchronizer::FastHashCode(Thread * Self, oop obj) {
  if (UseBiasedLocking) {
    if (obj->mark()->has_bias_pattern()) {
      // ★ 偏向锁 + hashCode = 冲突！必须撤销偏向
      BiasedLocking::revoke_and_rebias(...);
      // 撤销后走下面的路径
    }
  }

  ObjectMonitor* monitor = NULL;
  markOop temp, test;

  // ★ CAS 循环: 尝试将 hashCode 安装到对象头
  markOop mark = ReadStableMark(obj);

  if (mark->is_neutral()) {                      // 无锁状态
    hash = mark->hash();                          // 已有 hashCode?
    if (hash != 0) return hash;                   // 直接返回
    hash = get_next_hash(Self, obj);              // ★ 生成新 hashCode
    temp = mark->copy_set_hash(hash);             // 嵌入 markOop
    test = obj->cas_set_mark(temp, mark);         // CAS 安装
    if (test == mark) return hash;                // 成功!
    // CAS 失败 → 膨胀后存到 ObjectMonitor._header
  } else if (mark->has_monitor()) {
    monitor = mark->monitor();
    temp = monitor->header();                     // 从 ObjectMonitor._header 读
    if (temp->is_neutral()) {
      hash = temp->hash();
      if (hash != 0) return hash;
    }
    // hashCode 未生成 → 生成后存 ObjectMonitor._header
    hash = get_next_hash(Self, obj);
    temp = mark->copy_set_hash(hash);
    // ★ 存到 ObjectMonitor._header (不在 hot path 上, 不需要 CAS)
    monitor->set_header(temp);
    return hash;
  }
  // 轻量锁被持有 → 必须膨胀
  return ObjectSynchronizer::FastHashCode(Self, obj);  // 递归: inflate 后再取
}
```

### 4.4 basicLock.hpp (完整)

```cpp
class BasicLock {
  volatile markOop _displaced_header;    // ★ 8B, 存原始 markOop
public:
  markOop displaced_header() const;
  void set_displaced_header(markOop);
  static int displaced_header_offset_in_bytes();
};

class BasicObjectLock {
  BasicLock _lock;    // ★ 8B — 前8字节必须是 BasicLock (对齐要求)
  oop       _obj;     // ★ 8B — 关联的 Java 对象
};
```

### 4.5 markOop.hpp 关键位布局

```
64 位 non-biased:
[unused:25][hash:31][unused:1][age:4][biased_lock:1][lock:2]
                                            lock=01→unlocked
                                            lock=00→stack-locked(ptr_to_BasicLock)
                                            lock=10→inflated(ptr_to_ObjectMonitor)
                                            lock=11→GC marked
```

### 4.6 deflate_idle_monitors 关键结构 (synchronizer.cpp:1747+)

注意：deflate 完整实现很长（~200 行），不需要逐行展开。重点描述机制即可。

**ObjectMonitor 全局池**（理解 inflate 的 omAlloc/omRelease 需要）：

```cpp
// 全局变量:
static ObjectMonitor* gFreeList;         // ★ 空闲 ObjectMonitor 链表（线程安全）
static volatile int gMonitorFreeCount;   // 空闲 ObjectMonitor 计数
static volatile int gMonitorPopulation;  // 全局 ObjectMonitor 总数

// omAlloc(Self): 从全局池分配（快速路径）
//   ① try: gFreeList != NULL → CAS 摘取头部 → return
//   ② 池空 → new ObjectMonitor() + gMonitorPopulation++
// 设计: inflate 绝大部分走路径①，只有池空才 new → 减少 C 堆分配

// omRelease(Self, m, fromPerThreadAlloc): 归还到全局池
//   ① 重置 ObjectMonitor → Recycle()
//   ② CAS 插入 gFreeList 头部
//   ③ gMonitorFreeCount++
```

**deflate 核心逻辑**（简化）:

```cpp
// 关键数据结构: 计数器
struct DeflateMonitorCounters {
  int nInuse;          // 正在使用的 ObjectMonitor 数
  int nInCirculation;  // 全局 ObjectMonitor 总数
  int nScavenged;      // 本次清理的 ObjectMonitor 数
};

// 核心逻辑（简化）:
void ObjectSynchronizer::deflate_idle_monitors(DeflateMonitorCounters* counters) {
  // ① 遍历全局 ObjectMonitor 链表 (gFreeList → gOmInUseList)
  // ② 对每个 ObjectMonitor:
  //    if (_count == 0) {  // 引用计数为 0 = 空闲
  //      scavenged++;       // 标记为可清理
  //      从 in-use 链表移除 → 加入 free 链表
  //      恢复对象头: object->set_mark(_header)
  //    }
  // ③ 更新 gMonitorFreeCount
}
// 触发机制: SafepointCleanupTask 在每次 safepoint 后执行
// 探针日志: MonitorDeflation(scavenged=N/inuse=M/circulating=K)
```

## 五、文章结构（严格遵循）

```
§〇 源文件清单（6 个文件表格，含本文角色列）

§一 核心原理
  1.1 解决什么问题 — 偏向锁撤销后的"中间态"，为什么不能直接变重量锁
  1.2 数量级直觉 — 轻量锁(~20 cycles CAS) vs 重量锁(~10000+ cycles park/unpark)
  1.3 锁升级的"为什么" — ❓ 为什么偏向撤销后是轻量锁而不是重量锁？

§二 数据结构
  2.1 BasicLock(8B) — 栈上 displaced header
  2.2 BasicObjectLock(16B) — 解释器栈帧中的 Lock Record 布局
  2.3 解释器栈帧中 Lock Record 的物理位置
  2.4 markOop 轻量锁位编码: lock=00 + ptr_to_BasicLock:62

§三 fast_enter() 源码逐行
  3.1 偏向锁检查 → revoke_and_rebias
  3.2 降级到 slow_enter 的条件
  Mermaid 决策流程图

§四 slow_enter() 源码逐行
  4.1 CAS 轻量锁获取: cas_set_mark(BasicLock*, unlocked_mark)
  4.2 重入检查: is_lock_owned(locker)
  4.3 膨胀入口: inflate()

§五 inflate() 完整循环
  5.1 五种膨胀原因表格 (vm_internal 0 / monitor_enter 1 / wait 2 / notify 3 / hash_code 4)
  5.2 inflate 五步循环: ①检查已有 ②检测INFLATING ③CAS安装INFLATING ④omAlloc分配 ⑤CAS安装ObjectMonitor*
  5.3 ★ omAlloc 三级分配池: ① per-thread omFreeList (快路径, 无锁) → ② 全局 gFreeList (CAS 摘取) → ③ new ObjectMonitor() (慢路径, C-Heap 分配)。为什么需要三级？→ 避免每次 inflate 都 new：大部分膨胀发生在竞争剧烈的热点锁上，inflate/deflate 频繁——缓存复用比每次都分配释放快 10 倍
  5.4 displaced_header 的三种计算路径: 轻量锁被持有/unlocked/偏向状态
  5.5 inflate 的 Mermaid 流程图

§六 hashCode 六种策略
  6.1 get_next_hash 六种策略逐策略分析 (有源码)
  6.2 策略对比表: 性能/均匀性/可预测性
  6.3 FastHashCode 三条路径: 无锁CAS / 偏向撤销 / 膨胀后存 ObjectMonitor._header
  6.4 markOop hash 冲突的完整解决矩阵: 三种锁状态下 hash 的存储位置

§七 deflate_idle_monitors
  7.1 SafepointCleanupTask 扫描机制
  7.2 _count==0 → 删除 ObjectMonitor → markOop 恢复
  7.3 探针: MonitorDeflation(scavenged/inuse/circulating)

§八 GDB 验证 + 可证伪断言 (≥8条)
  每条含: 断言/验证命令/预期值

§九 一句话总结 + 交叉引用
```

## 六、风格要求（MEMORY 方法论）

1. **❓ "为什么"驱动**: 每个大节开头必须有 `> ❓ 为什么需要X？` 的问答块，解释设计动机
2. **粒度显式标注**: 每个字段标注粒度（8B on stack / oop* / intptr_t / jint），禁止用模糊词
3. **源代码行号**: 所有源码片段标注 `synchronizer.cpp:340` 格式的精确行号
4. **"为什么"块至少 4 处**: §一(为什么轻量锁存在)、§五(为什么 inflate 需要五步循环)、§五(为什么 omAlloc 需要三级分配池)、§六(为什么需要六种 hashCode 策略)
5. **可证伪断言 ≥8 条**: 每条有具体 GDB 命令 + 预期值
6. **交叉引用**: 文末附录标注 [01-ObjectMonitor] inflate 消费端、[02-BiasedLocking] revoke 入口
7. **数量级直觉**: 至少 2 处(轻量锁 CAS 周期 vs 重量锁 park 周期)
8. **不低于 500 行、不超过 600 行**
9. **禁止编造函数名**: 所有函数必须来自 §四 提供的源码，不存在 `attempt_allocation_new_region` 式的虚构函数
10. **可验证实验**: §八必须包含可运行的 strace/jstack 验证命令（参见 01-ObjectMonitor §八 的 ContentionTest 模式）

### 关键 "为什么" 的预期答案（必须准确理解）

| ❓ 问题 | 核心洞察（展开时基于此） |
|------|------|
| 为什么需要轻量锁？ | 偏向锁撤销后，如果锁竞争不激烈（只有 2 个线程交替使用），直接膨胀到 ObjectMonitor 太贵——CAS 一次栈指针（~20 cycles）比分配+park（~10000 cycles）便宜 500 倍 |
| 为什么 inflate 需要五步循环？ | 多个线程可能同时竞争膨胀同一个对象——INFLATING 哨兵值充当自旋锁。谁先 CAS 安装 INFLATING，谁获得"膨胀权"。其他线程看到 INFLATING → 自旋等待。避免分配多个 ObjectMonitor |
| 为什么 omAlloc 需要三级分配池？ | inflate/deflate 在竞争热点上非常频繁——每次 inflate 都 `new ObjectMonitor()` (~216B C-Heap 分配) 开销太大。三级池：per-thread cache（0 锁开销）→ global gFreeList（1 次 CAS）→ new（系统调用）。缓存复用比每次分配释放快 10 倍 |
| 为什么 hashCode 需要六种策略？ | 不同场景需要不同的性能/均匀性折衷：Park-Miller(均匀但慢)、地址(快但可预测被利用做攻击)、XOR-Shift(快且均匀, JDK8+默认)。可切换是为了在不同部署环境调试/基准测试 |
| 为什么 slow_enter 重入检查 ≠ ObjectMonitor._recursions？ | 轻量锁重入 = `displaced_header=NULL`（没有 markOop 可 displaced），重量锁重入 = `_recursions++`。轻量锁没有 ObjectMonitor 对象来存计数器 |
| 为什么 FastHashCode 会递归？ | 轻量锁持有者正在临界区，对象头里存的是 BasicLock* 不是 hash——必须 inflate 后 hash 存 ObjectMonitor._header。递归确保最终总能取到 hash |

### 可证伪断言（至少包含以下 5 条，其余自拟 ≥3 条）

| # | 断言 | 验证 |
|---|------|------|
| 1 | 轻量锁获取成功时 `BasicLock._displaced_header` = 获取前的原始 markOop | GDB: `p lock->displaced_header()` break slow_enter 返回前 |
| 2 | 轻量锁重入时 `displaced_header = NULL` | 源码 `synchronizer.cpp:73` `set_displaced_header(NULL)` |
| 3 | inflate 膨胀中对象头先被 CAS 为 `INFLATING`，再被 CAS 为 ObjectMonitor* | 两步 CAS: `synchronizer.cpp:119` → `synchronizer.cpp:140` |
| 4 | JDK 默认 hashCode=5 (Marsaglia XOR-Shift) | 源码 `get_next_hash` 中 `else { ... }` 分支是策略 5 |
| 5 | `FastHashCode` 在对象已膨胀时 hashCode 存 `ObjectMonitor._header`（非 CAS） | 源码 `synchronizer.cpp:233` `monitor->set_header(temp)` |

### 风格参考：对标 01-ObjectMonitor.md 的质量锚点

- enter() 7 层降级 = 每个分支标注 CPU cycles + 决策树 Mermaid → inflate() 应对标：5 步循环每步标注 CAS 次数 + Mermaid
- exit() QMode 四种策略表 → hashCode 应对标：六种策略对比表
- §八 strace 实测 ContentionTest → 本文应对标：`-XX:+TraceMonitorInflation` 或 jstack 验证 inflate 发生
- 每个字段标注粒度 → BasicLock(8B on stack), _displaced_header(markOop, 8B), _lock(8B), _obj(oop*, 8B)

## 七、输出格式

- Markdown 文件
- 元信息头（标准环境 + 源文件 + 前置 + 关联 + 阅读收益）
- 章节用 `## §X` / `### X.X` 格式
- 代码块用 ` ```cpp ` 标记
- Mermaid 图用 ` ```mermaid ` 标记
