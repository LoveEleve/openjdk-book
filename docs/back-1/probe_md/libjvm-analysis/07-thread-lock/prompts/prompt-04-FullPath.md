# PROMPT: 请撰写 P0-04 Synchronized-Full-Path.md

## 一、任务

撰写一篇 420-480 行的 JVM 源码串联文档，主题：**synchronized 从 monitorenter 字节码到 OS mutex 的完整调用链（四条路径 + exit 回程）**。

**特殊定位**：这是本系列"读的第 1 篇，写的第 4 篇"——目标读者是第一次接触 JVM 锁实现的人。文档不深入任何单一机制（01/03/02 已经干了这个活），而是把所有路径**串起来**，每一步标注引用的详细文档。读完后，读者应该能画出一张完整调用链，并知道遇到细节问题去哪个文档查。

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC`（Region=4MB, 2048个）
- 64 位 Linux x86

## 三、源文件与关键函数（已验证行号）

### 3.1 Enter 侧完整调用链

| 层 | 文件 | 函数 | 行号 | 说明 |
|:---:|------|------|:---:|------|
| 1 | `templateTable_x86.cpp` | `TemplateTable::monitorenter()` | 4354 | 解释器模板代码生成入口 |
| 2 | `interp_masm_x86.cpp` | `InterpreterMacroAssembler::lock_object()` | 1152 | 汇编生成：调用 `biased_locking_enter` + CAS `slow_enter` |
| 3 | `macroAssembler_x86.cpp` | `MacroAssembler::biased_locking_enter()` | 1110 | ★ 汇编七阶段偏向锁快速路径 |
| 4 | `interpreterRuntime.cpp` | `InterpreterRuntime::monitorenter()` | 786 | 解释器慢速路径入口 → `fast_enter(attempt_rebias=true)` |
| 5 | `synchronizer.cpp` | `ObjectSynchronizer::fast_enter()` | 265 | ★ 锁入口调度 | 尝试偏向锁 → 失败则 `slow_enter` |
| 6 | `biasedLocking.cpp` | `BiasedLocking::revoke_and_rebias()` | 624 | ★ 偏向锁撤销/重偏向主入口 |
| 7 | `synchronizer.cpp` | `ObjectSynchronizer::slow_enter()` | 340 | ★ 轻量锁 CAS / 重入检查 / inflate |
| 8 | `synchronizer.cpp` | `ObjectSynchronizer::inflate()` | 1403 | ★ 轻量→重量膨胀：INFLATING 双 CAS 协议 |
| 9 | `objectMonitor.cpp` | `ObjectMonitor::enter()` | 266 | ★ 重量锁获取：CAS _owner / 重入 / 自旋 / EnterI |
| 10 | `objectMonitor.cpp` | `ObjectMonitor::EnterI()` | 454 | ★ 重量锁慢路径：CXQ 入队(LIFO) / park |
| 11 | `os_posix.cpp` | `PlatformEvent::park()` | 1998 | OS 层 park → `pthread_cond_wait` |

### 3.2 Exit 侧完整调用链

| 层 | 文件 | 函数 | 行号 | 说明 |
|:---:|------|------|:---:|------|
| E1 | `templateTable_x86.cpp` | `TemplateTable::monitorexit()` | 4470 | 解释器模板代码生成出口 |
| E2 | `interp_masm_x86.cpp` | `InterpreterMacroAssembler::unlock_object()` | 1261 | 汇编生成：调用 `fast_exit` |
| E3 | `synchronizer.cpp` | `ObjectSynchronizer::fast_exit()` | 283 | 偏向锁=空操作 / 轻量锁=CAS restore |
| E4 | `objectMonitor.cpp` | `ObjectMonitor::exit()` | 921 | ★ 重量锁释放：QMode 唤醒策略 + unpark |

### 3.3 辅助文件

| 文件 | 关键内容 | 行号 |
|------|------|:---:|
| `markOop.hpp` | 64 位位布局 + lock 状态判断 + INFLATING(0) | 37-154, 215-227 |
| `basicLock.hpp` | BasicLock(8B) + BasicObjectLock(16B) | 31-78 |
| `biasedLocking.hpp` | `BiasedLocking` 类 + `Condition` 枚举 | 148-193 |
| `objectMonitor.hpp` | ObjectMonitor 全部字段（~216B）| 128-199 |
| `globals.hpp` | `UseBiasedLocking` + 相关阈值 | 964-987 |

## 四、三条重要源码（Enter 侧关键调用点）

### 4.1 TemplateTable::monitorenter() — 字节码入口 (templateTable_x86.cpp:4354-4449)

```cpp
// templateTable_x86.cpp:4354 — 解释器为 monitorenter 字节码生成的机器码模板
void TemplateTable::monitorenter() {
  // ... 分配监视器槽位 (BasicObjectLock) ...
  __ lock_object(rmon);   // L4440: ★ 进入 InterpreterMacroAssembler::lock_object()
}
```

### 4.2 InterpreterMacroAssembler::lock_object() — 汇编生成 (interp_masm_x86.cpp:1152-1230)

```cpp
// interp_masm_x86.cpp:1152 — 生成获取锁的 x86 机器码
void InterpreterMacroAssembler::lock_object(Register lock_reg) {
  if (UseHeavyMonitors) {
    call_VM(noreg, CAST_FROM_FN_PTR(address, InterpreterRuntime::monitorenter), ...); // L1156
    return; // 跳过所有快速路径，直接走重量锁
  }
  if (UseBiasedLocking) {
    biased_locking_enter(lock_reg, obj_reg, swap_reg, tmp_reg, false, done, &slow_case); // L1179
  }
  // L1195-1200: ★ 轻量锁快速路径: CAS BasicLock* → obj->mark()
  movptr(tmp_reg, obj_reg);
  movptr(tmp_reg, Address(tmp_reg, oopDesc::mark_offset_in_bytes()));
  lock(); cmpxchgptr(lock_reg, Address(obj_reg, oopDesc::mark_offset_in_bytes()));
  jcc(Assembler::zero, done);  // CAS 成功 → done
  bind(slow_case);
  call_VM(noreg, CAST_FROM_FN_PTR(address, InterpreterRuntime::monitorenter), ...); // L1225
  bind(done);
}
```

### 4.3 InterpreterRuntime::monitorenter() — 慢速路径 (interpreterRuntime.cpp:786-805)

```cpp
// interpreterRuntime.cpp:786 — 解释器慢速路径: 汇编 CAS 失败后进入
IRT_ENTRY_NO_ASYNC(void, InterpreterRuntime::monitorenter(JavaThread* thread, BasicObjectLock* elem))
  Handle h_obj(thread, elem->obj());
  if (UseBiasedLocking) {
    ObjectSynchronizer::fast_enter(h_obj, elem->lock(), true, CHECK); // L800-802: attempt_rebias=true
  } else {
    ObjectSynchronizer::slow_enter(h_obj, elem->lock(), CHECK);       // L803-804
  }
IRT_END
```

## 五、文章结构（严格遵循）

```
§〇 阅读导航 — 本文定位
  - 如果你是"第一次系统研究 JVM 锁"的读者，先读这篇。
  - 读完本文，你会有一张完整调用链地图，然后按需深入 01/03/02。
  - 三个阅读路径：5 分钟速览 → 30 分钟理解 → 2 小时精通
  - 源文件清单（enter 11 函数 + exit 4 函数 + 辅助 5 文件）

§一 全景 Mermaid — 从 monitorenter 到 park()
  1.1 全链路时序图（5 层纵深）
      templateTable → interp_masm → biased_locking_enter → revoke_and_rebias → fast_enter 
      → slow_enter → inflate → ObjectMonitor::enter → EnterI → park
  1.2 每步标注：文件:行号 + 引用文档+章节 + 关键操作
  1.3 对象头状态变化辅助图：101(biased) → 00(locked) → 10(inflated)
  1.4 ★ 四条路径分叉图：偏向命中 / 轻量成功 / 轻量膨胀 / 直接重量

§二 路径 A: 偏向锁获取 — 同一线程反复重入
  2.1 前提: 对象已经是偏向状态 (lock=101)，持有者==当前线程
  2.2 调用链: monitorenter → biased_locking_enter() Phase2 → 1 次 xor + 1 次 jcc → done
  2.3 代价: 0 次 CAS，~3 条指令。详见 [02-BiasedLocking] §三.2
  2.4 源码摘录: macroAssembler_x86.cpp:1160-1174（Phase2 的 xorptr+jcc 路径）

§三 路径 B: 轻量锁获取 — 无竞争时的 CAS 栈锁
  3.1 前提: 对象无锁 (lock=01)，或偏向被撤销后进入此路径
  3.2 调用链: slow_enter() → CAS BasicLock* → obj->mark() → lock=00
  3.3 代价: 1 次 lock cmpxchgptr。详见 [03-BasicLock-Synchronizer] §三+§四
  3.4 源码摘录: synchronizer.cpp:344-350（CAS 安装 BasicLock* 的三行核心）

§四 路径 C: 轻量→重量膨胀 — 竞争出现
  4.1 前提: 对象已被另一个线程轻量持有 (lock=00→other_thread_BasicLock)
  4.2 调用链: slow_enter() → inflate() → INFLATING(0) 双 CAS → ObjectMonitor::enter()
  4.3 代价: omAlloc + 1~2 次 CAS (~500-2000 cycles)。详见 [03-BasicLock-Synchronizer] §五
  4.4 源码摘录: synchronizer.cpp:1469-1533（inflate 双 CAS 的关键 10 行）

§五 路径 D: 重量锁竞争 — park 进内核
  5.1 前提: 对象已膨胀 (lock=10)，_owner 已被其他线程持有
  5.2 调用链: ObjectMonitor::enter() → TryLock() 失败 → TrySpin() 自适应自旋 → 
             EnterI() → ObjectWaiter 入 CXQ (LIFO) → park() → pthread_cond_wait
  5.3 代价: ~10000+ cycles（含上下文切换）。详见 [01-ObjectMonitor] §三+§四
  5.4 源码摘录: objectMonitor.cpp:266-315（enter 快速路径）+ 454-540（EnterI 入队 park）

§六 monitorexit — 回程的对称性
  6.1 偏向锁: fast_exit 空操作（无任何 store）。详见 [02-BiasedLocking]
  6.2 轻量锁: fast_exit → CAS restore displaced_header → 成功。详见 [03-BasicLock-Synchronizer] §四.4
  6.3 重量锁: ObjectMonitor::exit() → release_store(&_owner, NULL) → 
             检查 _cxq/_EntryList → QMode 四种唤醒策略 → unpark 继任者。
             详见 [01-ObjectMonitor] §五
  6.4 Exit 侧与 Enter 侧的对称对应表

§七 数量级对比 — 为什么设计成四级？
  7.1 四级开销对比表: 偏向重入(~1c) vs 轻量获取(~20c) vs 膨胀(~500c) vs 重量竞争(~10000c)
  7.2 每级适用场景 + 退化条件
  7.3 GC log 对比: UseBiasedLocking true vs false 的锁行为差异
      运行示例: java -XX:+UseBiasedLocking vs -XX:-UseBiasedLocking

§八 GDB 验证 + 可证伪断言 (≥8 条)
  8.1 GDB 断点链: 在 monitorenter → biased_locking_enter → fast_enter → slow_enter →
      inflate → ObjectMonitor::enter → EnterI 各设一次断点，单步走完整条链
  8.2 每条断言含: GDB 命令 + 预期值 + 验证的调用链节点
  8.3 ★ 核心验证: 用一个多线程 Java 程序，GDB 跟踪从 monitorenter 到 pthread_cond_wait 的完整路径

§九 一句话总结 + 交叉引用 + 阅读路径推荐
```

## 六、风格要求（MEMORY 方法论）

1. **"阅读导航"优先**: §〇 必须说清楚"读这篇能得到什么，深入看什么"
2. **交叉引用密度最高**: 每一步标注 `详见 [XX-文档名] §Y.Y`（至少 20 处），每处精确到章节号
3. **源码行号**: 所有源码片段标注 `synchronizer.cpp:344` 格式
4. **Mermaid 图至少 2 张**: §一全链路大图 + 四条路径分叉图
5. **对象头状态可视化**: 每个路径转折点展示 markOop 位变化：`[T1:54|epoch:2|age:4|101]` → `[BasicLock*:62|00]` → `[ObjectMonitor*:62|10]`
6. **禁止编造函数名**: 所有函数名来自源码
7. **不低于 420 行、不超过 500 行**（比详细文档短，因为源码只摘关键行，深度交给引用）
8. **数量级直觉**: 至少 1 处（四级开销对比表）
9. **可证伪断言 ≥8 条**: 每条有具体 GDB 命令 + 预期值 + 标注断点位置在全链路的哪个节点

### 关键交叉引用矩阵（必须覆盖）

| 本文 § | 关键操作 | 引用文档 | 引用章节 |
|:---:|------|------|:---:|
| §二 | 偏向锁重入 0 CAS | [02-BiasedLocking] | §三.2 偏向重入 |
| §二 | 偏向锁首次获取 1 CAS | [02-BiasedLocking] | §三.3 首次偏向 |
| §三 | 轻量锁 CAS 获取 | [03-BasicLock-Synchronizer] | §三 fast_enter + §四 slow_enter |
| §三 | 轻量锁重入 mark | [03-BasicLock-Synchronizer] | §四.2 重入检查 |
| §四 | inflate INFLATING 双 CAS | [03-BasicLock-Synchronizer] | §五 inflate 完整循环 |
| §四 | omAlloc 三级分配池 | [03-BasicLock-Synchronizer] | §五.4 omAlloc |
| §五 | ObjectMonitor::enter 快速路径 | [01-ObjectMonitor] | §三 enter 源码逐行 |
| §五 | EnterI 慢路径 CXQ park | [01-ObjectMonitor] | §四 EnterI 慢路径 |
| §六 | ObjectMonitor::exit QMode | [01-ObjectMonitor] | §五 exit 源码 |
| §六 | fast_exit CAS restore | [03-BasicLock-Synchronizer] | §四.4 fast_exit |

### 四大路径的开销/触发条件对比表（§七核心产出）

| 路径 | 触发条件 | 获取操作 | 释放操作 | 代价 | 详见 |
|------|------|------|------|:---:|:---:|
| A 偏向 | obj 已偏向当前线程, epoch 有效 | 0 CAS, xorptr+jcc | 空操作 | ~3c | [02] §三.2 |
| B 轻量 | obj 无锁或偏向已撤 | 1 CAS 安装 BasicLock* | 1 CAS restore | ~40c | [03] §三+§四 |
| C 膨胀 | 轻量锁竞争出现 | inflate 双CAS+omAlloc | exit() restore | ~500c | [03] §五 |
| D 重量 | 已膨胀, owner≠self | enter+自适应自旋+park | exit()+unpark | ~10000c | [01] §三+§五 |

### 可证伪断言（至少 8 条）

| # | 断言 | 验证 |
|---|------|------|
| 1 | 偏向重入路径经过 `biased_locking_enter` Phase2 且无 `lock cmpxchgptr` | GDB break `macroAssembler_x86.cpp:1174`，单步确认无 CAS |
| 2 | 轻量锁获取后 `obj->mark()` 低2位=00 | GDB break `synchronizer.cpp:350` → `p/x obj->mark()` 低2位=00 |
| 3 | inflate 先 CAS INFLATING(0) 再 release_set_mark | GDB break `synchronizer.cpp:1479` + `synchronizer.cpp:1533` |
| 4 | 重量锁 enter 无竞争时只需 CAS _owner（不进入 EnterI）| GDB break `objectMonitor.cpp:310` |
| 5 | EnterI 中 park 走 `pthread_cond_wait` | GDB break `os_posix.cpp:1998`，bt 看到 park → pthread_cond_wait |
| 6 | monitorexit 偏向锁路径无任何 store | GDB break `interp_masm_x86.cpp:1261`，偏向对象直接 return |
| 7 | monitorexit 轻量锁路径 CAS restore displaced_header | GDB break `synchronizer.cpp:323` → `p/x displaced_header()` |
| 8 | monitorexit 重量锁路径 exit() → release_store _owner=NULL | GDB break `objectMonitor.cpp:921` → `p _owner` = NULL |
| 9 | GC log 中 `UseBiasedLocking=false` 时 `fast_enter` 直接走 `slow_enter` | `-XX:-UseBiasedLocking` 下 `-Xlog:monitorinflation=info` 无 biased 相关日志 |
| 10 | 完整断点链: 从 `templateTable_x86.cpp:4354` 单步走完所有 10 个 enter 函数 | GDB 序列化断点 + continue，验证到达 EnterI |

## 七、输出格式

- Markdown 文件，命名为 `04-Synchronized-Full-Path.md`
- 元信息头（标准环境 + 源文件 + 前置(01/03/02) + 关联 + 阅读收益）
- 章节用 `## §X` / `### X.X` 格式
- 代码块用 ` ```cpp ` 标记
- Mermaid 图用 ` ```mermaid ` 标记
- 文件输出到 `/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/07-thread-lock/`
