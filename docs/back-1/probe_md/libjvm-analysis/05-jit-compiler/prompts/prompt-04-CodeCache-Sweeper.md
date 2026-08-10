# PROMPT: 请撰写 04-CodeCache-Sweeper.md

## 一、任务

撰写一篇深度的 JVM 源码分析文档，主题：**CodeCache 空间管理 + NMethodSweeper 清理 — nmethod 从 alive→not_entrant→zombie→unloaded→freed 的完整生命周期**。

### 核心故事线（禁止做源码翻译机！）

"CodeCache is full. Compiler has been disabled." — 每条 JVM 日志都是这个。CodeCache 从 240MB 的 97% 涨到 100% 时，CompileBroker 拒绝接收新编译——热方法 forever 解释执行。3 分钟后 CodeCache → 85%（Sweeper 清理了 zombie nmethods），但 QPS 已经掉了 80%。

nmethod 是 JVM 中最复杂的生命周期对象——从"编译器分配 CodeCache 空间"到"GC 回收 zombie nmethod"共 5 个阶段。CodeCache 是 JVM 的"第二个堆"——和 Java 堆一样管理空间。

**读者前提**：从 [01-Pipeline] §八（PhaseOutput::install_code()——CodeCache::allocate() + nmethod 构造）和 [02-Inline] §五（内联→nmethod 大小→CodeCache 容量）进入本文。读者知道编译完成后 nmethod 存放在 CodeCache 中，本文回答：**CodeCache 怎么管理这段空间？nmethod 怎么从 alive 变成 freed？Sweeper 怎么在后台清理？**

### 你需要知道的（零 GC/CodeCache 背景的工程师必须理解 5 个概念）

#### 概念 1：nmethod（编译后方法）

nmethod = "native method" 的缩写，实际上是"编译后的 Java 方法"。包含：机器码（x86 指令流）、OopMap（GC root 信息）、ExceptionCache（异常处理器表）、deopt info（去优化元数据）。nmethod 继承 `CompiledMethod` → `CodeBlob`。每个 nmethod 有约 2-200KB，取决于 inline 深度。

#### 概念 2：CodeBlob（代码块基类）

CodeBlob 是所有编译后代码块的基类——`nmethod`（Java 方法）、`RuntimeStub`（runtime 辅助函数）、`BufferBlob`（adapter/stub 代码）、`SingletonBlob`（DeoptimizationBlob/UncommonTrapBlob/SafepointBlob）。所有 CodeBlob 共享 CodeCache 存储。

#### 概念 3：CodeCache 三段布局

CodeCache 分为 3 个独立段：(1) **Non-profiled** —— no nmethods（compile level < 4，不包含 profile 数据的 nmethod）；(2) **Profiled** —— nmethods with profile data（C1 L2/L3 编译的带 profile 的 nmethod）；(3) **Non-method** —— adapters、stubs、buffered blobs（非 Java 方法的代码块）。每段有独立的内存分配器和 free list。

#### 概念 4：Zombie / Not-Entrant

**not_entrant** = 新版本被编译——C2 重新编译了相同的方法 → 新 nmethod → 旧 nmethod 被标记 not_entrant → 正在执行旧 nmethod 的线程可以完成，但新调用链不再进入旧 nmethod。**zombie** = not_entrant + 所有线程已退出此 nmethod → 可以被 Sweeper 回收。

#### 概念 5：NMethodSweeper（后台清理器）

NMethodSweeper 不是独立线程——它在每次 safepoint 时被触发（`SafepointSynchronize::begin()` → `NMethodSweeper::sweep_code_cache()`）。它扫描所有 zombie nmethod → 从 CodeCache 中释放空间 → 更新 free list。Sweep 周期 = 每 `NmethodSweepFraction`（默认 16）个 safepoints 执行 1 次。

---

**本文是 05-jit-compiler 阶段的第 4 篇。前置：[01-Pipeline] §八（nmethod 构造 + CodeCache::allocate()）、[02-Inline] §五（内联→nmethod 大小）。读者知道编译完的方法存在 CodeCache 中。配套：[05-Deoptimization]（deopt 导致 nmethod 变 zombie）。**

### 核心叙事线 — "CodeCache：JVM 的第二个堆"

1. **★★ nmethod 的 5 个生命周期状态** — alive → not_entrant → zombie → unloaded → freed。每个状态转换的触发条件 + 执行线程 + 代码引用。
2. **★★ CodeCache 的 3 段布局** — Non-profiled（no nmethod）、Profiled（profiled nmethod）、Non-method（adapters/stubs）。每段的独立 free list + 分配策略。
3. **★★ NMethodSweeper 的后台清理** — sweep cycle（每 NmethodSweepFraction=16 个 safepoint 执行 1 次）→ zombie 检测 → 标记 → flush queue → CodeCache::free()。
4. **★ Emergency Flush** — CodeCache 满到 99% → 紧急 flush → 标记所有 zombie + 强制回收。3 种触发场景：allocation 失败、CodeCache 接近上限、-XX:StartAggressiveSweepingAt=80。
5. **★ Speculative Disconnect** — 如果 nmethod 在首次 N 次调用内被 deopt（SpecTrapLimit）→ 标记为"不稳定"→ 永不再编译——防止 CodeCache 被 deopt→recompile 循环填满。

### 验证报告
- `sverklo_search "nmethod CodeCache CodeBlob sweeper zombie not_entrant lifecycle"` → nmethod.cpp codeCache.cpp sweeper.cpp
- `codegraph query "NMethodSweeper::sweep_code_cache nmethod::make_not_entrant CodeCache::allocate"` → 核心函数
- `rg -n "alive\|not_entrant\|zombie\|unloaded\|make_not_entrant\|can_be_zombie\|flush_dependencies" nmethod.cpp nmethod.hpp` → 生命周期状态

## 二、标准环境

- OpenJDK 11 slowdebug build
- `-Xms8g -Xmx8g -XX:+UseG1GC -XX:+PrintCompilation -XX:+UnlockDiagnosticVMOptions`
- 64 位 Linux x86
- ★ GDB 在 slowdebug build 中验证（`#ifdef ASSERT` 全部生效）
- ★ `jcmd <PID> Compiler.CodeHeap_Analytics` 查看 CodeCache 使用情况

## 三、聚焦源文件

| # | 文件 | 完整路径 | 模块 | 核心方法/类（需验证行号） | 本文角色 |
|---|------|---------|------|---------------------|---------|
| 1 | `nmethod.cpp` | `src/hotspot/share/code/nmethod.cpp` | code | `nmethod::nmethod()`(构造器)、`make_not_entrant()`、`can_be_zombie()`、`make_zombie()`、`flush()` | ★★★ nmethod 生命周期 |
| 2 | `nmethod.hpp` | `src/hotspot/share/code/nmethod.hpp` | code | nmethod 类定义(:28-836)、状态枚举 `in_use`/`not_entrant`/`zombie`/`unloaded` | ★★ 状态定义 |
| 3 | `codeCache.cpp` | `src/hotspot/share/code/codeCache.cpp` | code | `CodeCache::allocate()`、`CodeCache::free()`、`CodeCache::contains()`、`initialize()`(三段布局) | ★★★ CodeCache 空间管理 |
| 4 | `codeCache.hpp` | `src/hotspot/share/code/codeCache.hpp` | code | `CodeCache` 类(:43-140)、`CodeHeap` 段定义、分段常量 | ★★ 接口定义 |
| 5 | `sweeper.cpp` | `src/hotspot/share/runtime/sweeper.cpp` | runtime | `NMethodSweeper::sweep_code_cache()`、`handle_safepoint_request()`、`possibly_flush()` | ★★★ 清理逻辑——safepoint 触发式清理 |
| 6 | `codeBlob.cpp` | `src/hotspot/share/code/codeBlob.cpp` | code | `CodeBlob` 基类、`CodeBlob::flush()` | ★★ CodeBlob 生命周期 |
| 7 | `compiledMethod.cpp` | `src/hotspot/share/code/compiledMethod.cpp` | code | `CompiledMethod::flush()`、`is_alive()` | ★★ 已编译方法接口 |
| 8 | `compileBroker.cpp` | `src/hotspot/share/compiler/compileBroker.cpp` | compiler | `CompileBroker::compile_method()`——"CodeCache full" 检查 | ★★ 编译触发→CodeCache 容量检查 |

**跨模块说明**：CodeCache 管理跨 code/（nmethod.cpp 生命周期 + codeCache.cpp 空间分配）+ runtime/（sweeper.cpp 后台 safepoint 触发式清理）+ code/（codeBlob.cpp 基类）。sweeper.cpp 在 runtime/ 中是因为 NMethodSweeper 作为 safepoint 操作被 VM runtime 协调，而非 CodeCache 本地线程。compileBroker.cpp 在 compiler/ 模块是上游——编译触发时检查 CodeCache 容量。

## 四、必须深度走读的核心概念

> 以下不是答案——是必须从源码中挖掘答案的问题列表。每道题先定位源文件行号，再回答"为什么"，最后用 3-5 行关键源码做引证。

### 4.1 ★★★ nmethod 的 5 个生命周期状态

```
问题：
  ① nmethod 从 alive 到 freed 经过哪些状态？每个状态的触发条件是什么？
      线索: nmethod.hpp 的状态枚举 + nmethod.cpp 的 make_not_entrant/make_zombie/flush
      答案方向:
        alive → not_entrant: C2 重编译同一方法 → 新 nmethod 调用旧 nmethod 的 make_not_entrant()
        not_entrant → zombie: can_be_zombie() == true（所有线程已退出此 nmethod + 无栈引用）
        zombie → unloaded: 类被卸载 → nmethod 的 metadata 失效 → 标记 unloaded
        unloaded → freed: Sweeper 调用 flush() → CodeCache::free() 回收空间
      追问: 为什么需要 not_entrant 中间状态？→ 旧 nmethod 的机器码可能在线程栈上（线程在执行中）→
      不能立即回收——必须等所有线程退出。not_entrant = "不再接受新进入，但已有的执行可以完成"。

  ② can_be_zombie() 检查什么条件？
      线索: nmethod.cpp can_be_zombie
      答案方向: (a) state == not_entrant; (b) 线程栈上没有对此 nmethod 的 PC 引用（所有线程已退出）；
      (c) 没有激活的依赖（dependency_context 已清空）。条件全部满足 → 返回 true → Sweeper 可以标记 zombie。
      追问: 如何检查"线程栈上没有引用"？→ 遍历所有 JavaThread 的栈帧 → 查找是否有 PC 落在此 nmethod 的
      地址范围内（CodeCache::contains(pc) && nmethod_at(pc) == this）。

  ③ make_not_entrant() 的原子性——如果线程正在执行此 nmethod 时被标记 not_entrant？
      答案方向: make_not_entrant() 使用原子操作（CAS）设置状态。正在执行的线程不受影响——它们已经
      在 nmethod 内部（PC 在机器码中）。但 nmethod 的 `_entry_point` 被替换为 VerifiedEntryPoint
      → 新进入的线程先检查 nmethod 状态 → 如果 not_entrant → 跳转到新 nmethod 或解释器。
```

### 4.2 ★★ CodeCache 3 段布局

```
问题：
  ① 为什么分成 3 段而不是 1 个大段？
      线索: codeCache.cpp initialize + codeCache.hpp 分段常量
      答案方向: 3 段 = 3 种不同用途的代码块，彼此隔离：(a) Non-profiled nmethod：C2 编译的代码——
      体积大、频率高、生命周期长；(b) Profiled nmethod：C1 L2/L3 编译——体积小、走 profile 收集、
      生命周期短（C2 重编译后废弃）；(c) Non-method：adapters/stubs——体积很小、永久存活。
      隔离的好处：一段满了不会影响另一段——Non-profiled 满 ≠ Non-method 满。独立 free list → 
      分配查找更快（不用在大池子里找不同大小的空闲块）。

  ② CodeCache::allocate(int size) 怎么选择段？
      答案方向: 根据 CodeBlob 类型：nmethod → 如果是 profiled 级 → CodeCache::profiled_segment()；
      如果不是 → non_profiled_segment()；RuntimeStub/BufferBlob → non_method_segment()。
      每个段的 `CodeHeap::allocate(size)` 独立分配——first-fit 扫描 free list → 如果找不到 →
      触发 `NMethodSweeper::handle_full_code_cache()` 紧急清理。

  ③ CodeCache 的默认大小是多少？怎么调整？
      答案方向: 默认：tiered 编译下 ReservedCodeCacheSize = 240MB（堆 < 2GB 时按比例缩减）。
      3 段分割：Non-profiled(40%) + Profiled(40%) + Non-method(20%)。调整：`-XX:ReservedCodeCacheSize=512m`
      扩大总量；`-XX:NonProfiledCodeHeapSize=256m` / `-XX:ProfiledCodeHeapSize=256m` 调整各段。
```

### 4.3 ★★ NMethodSweeper：后台清理

```
问题：
  ① NMethodSweeper 什么时候被触发？它不是独立线程——那它在哪？
       线索: sweeper.cpp sweep_code_cache
      答案方向: NMethodSweeper 不是独立线程——它在 safepoint 时被 SafepointSynchronize::begin() 
      调用。sweep_code_cache() 的触发频率：每 NmethodSweepFraction(16) 个 safepoints 执行 1 次。
      为什么在 safepoint 中？→ 此时所有 JavaThread 停止 → 可以安全地检查 "哪些 nmethod 没有线程引用"
      → 标记 zombie → 释放空间。不在 safepoint 中做检查会有竞态风险。

  ② sweep_code_cache_impl() 做了什么？
      答案方向: (a) 遍历 CodeCache 所有 nmethod → 检查 state → 如果是 zombie 或 unloaded →
      加入 flush queue → 调用 nmethod::flush() → CodeCache::free() 回收空间；
      (b) 对 not_entrant nmethod 检查 can_be_zombie() → 如果 true → 标记为 zombie；
      (c) 更新统计计数器（swept_count, flushed_count, zombified_count）。
      追问: flush 的顺序？→ 先 flush zombie（最紧急——占用空间但无引用），再检查 not_entrant。

  ③ Sweeper 的"慢"——为什么 CodeCache 满后要 3 分钟才恢复？
      答案方向: Sweeper 每 16 个 safepoints 才执行 1 次。低负载应用 safepoint 频率 ~2/sec
      → 每 8 秒执行一次 Sweeper。如果 CodeCache 满后，需要 ~20 次 sweep 才能清理到 85% →
      20 × 8 = 160 秒 ≈ 3 分钟。加速方案：`-XX:StartAggressiveSweepingAt=80` → CodeCache 80% 满时
      转为 aggressive sweep（每 1 个 safepoint sweep 1 次）→ 清理速度 ×16。
```

### 4.4 ★ Emergency Flush：CodeCache 满后的紧急措施

```
问题：
  ① 什么触发 emergency flush？
       线索: sweeper.cpp emergency_flush + codeCache.cpp handle_full_code_cache
      答案方向: 3 种触发：(a) CodeCache::allocate() 返回 NULL（段满→分配失败）；
      (b) CodeCache 使用率接近上限（如 `_high_mark > CodeCache::max_capacity() * 0.95`）；
      (c) -XX:StartAggressiveSweepingAt=80 设定的阈值被跨越。
      追问: emergency flush 和普通 sweep 的区别？→ emergency flush 不等待 can_be_zombie()——
      标记所有 zombie + 立即 on-stack replacement (OSR) + 主动触发 safepoint 加速清理。

  ② Emergency flush 后 CodeCache 能恢复到什么程度？
      答案方向: 紧急 flush 典型恢复：CodeCache 使用率从 99% → 85-90%（释放 zombie/unloaded nmethod）。
      但不能释放 not_entrant（仍有活跃引用）或 alive nmethod。所以如果 CodeCache 全是 alive nmethod→
      紧急 flush 效果有限→ 此时只能增大 ReservedCodeCacheSize。
```

### 4.5 ★ Speculative Disconnect：不稳定 nmethod 的"黑名单"

```
问题：
  ① 什么条件下 nmethod 被标记为 "speculative" 或 "unstable"？
      线索: nmethod.cpp + compileBroker.cpp 的 SpecTrapLimit
      答案方向: 如果 nmethod 在首次 N 次（SpecTrapLimit，默认 ~10）调用内被 deopt（触发 uncommon trap）
      → 标记为 "unstable" → 永不再重编译此方法（加入 CompileCommand 隐含黑名单）。
      防止：deopt→recompile→deopt→recompile 的死循环——每次 recompile 消耗 CodeCache + 编译时间。

  ② 这个机制解决了什么问题？
      答案方向: 某些方法因为不稳定的类层次（如 Java EE 框架的多个代理类）导致 CHA 假设反复破灭 →
      C2 编译 → deopt → C2 编译 → deopt → CodeCache 被爆炸式填满。SpecTrapLimit 限制每方法
      最多 deopt N 次 → 之后放弃编译 → 方法永远解释执行（虽然慢，但不崩溃 CodeCache）。
```

## 五、文章结构

```
§〇 生产场景 — CodeCache 满 + 编译器停止
  ★ "CodeCache is full. Compiler has been disabled." 日志
  ★ 10 分钟诊断：jcmd CodeHeap_Analytics → PrintInlining 定位过度内联

§一 ★★★ nmethod 生命周期 5 状态图
  ❓ 为什么需要 5 个状态而不是 3 个？
  ❓ not_entrant 的本质——"新 nmethod 接管"的中间状态
  1.1 ★ Mermaid 状态转换图——alive→not_entrant→zombie→unloaded→freed
  1.2 每个转换的触发条件 + 执行线程 + 代码引用
  1.3 ★ 面试 Story Format 答案：nmethod 生命周期 + CodeCache 空间管理

§二 ★★ CodeCache 3 段布局
  ❓ 为什么 3 段而不是 1 段？
  ❓ 每段的大小怎么调？
  2.1 Non-profiled / Profiled / Non-method 三段详解
  2.2 CodeCache::allocate() 的段选择逻辑
  2.3 CodeCache 容量监控——jcmd Compiler.CodeHeap_Analytics

§三 ★★ NMethodSweeper 清理机制
  ❓ Sweeper 不是独立线程——那它在哪执行？
  ❓ 为什么在 safepoint 中清理？
  3.1 sweep_code_cache() 的触发频率——NmethodSweepFraction
  3.2 zombie 检测 → flush queue → CodeCache::free()
  3.3 Sweeper 的"慢"——为什么 3 分钟才恢复

§四 ★ Emergency Flush
  ❓ 3 种触发场景 + 和普通 sweep 的区别
  ❓ Emergency flush 后 CodeCache 恢复的典型程度
  4.1 emergency_flush() 实现
  4.2 -XX:StartAggressiveSweepingAt=80

§五 ★ Speculative Disconnect
  ❓ 不稳定的 nmethod 怎么被"永久禁用"？
  ❓ deopt→recompile 循环的 CodeCache 危害
  5.1 SpecTrapLimit 机制
  5.2 类层次不稳定的典型生产场景

§六 ★ Production：CodeCache 满 → 诊断 → 修复 workflow
  ❓ jcmd Compiler.CodeHeap_Analytics 怎么看？
  ❓ PrintInlining 怎么定位过度内联？
  6.1 诊断 3 步：jcmd analytics → PrintInlining → CompileCommand
  6.2 修复参数：-XX:ReservedCodeCacheSize -XX:MaxInlineLevel -XX:StartAggressiveSweepingAt
  6.3 监控：-XX:+PrintCodeCache -XX:+PrintCodeCacheOnCompilation

§七 GDB 验证 + 可证伪断言 (≥10 条)
  断言 1: CodeCache::allocate() 返回非 NULL — 验证 nmethod 创建
  断言 2: make_not_entrant() 后状态为 not_entrant
  断言 3: can_be_zombie() 检查——线程栈无引用
  断言 4: sweep_code_cache() 标记 zombie → flush → free
  断言 5: CodeCache 3 段基址检查——每段独立 free list
  断言 6: emergency_flush() 触发——CodeCache 使用率 > 99%
  断言 7: SpecTrapLimit 达到——nmethod 标记 unstable
  断言 8: nmethod::flush() 后 CodeCache 空闲大小增加
  断言 9: CodeHeap_Analytics 输出验证——各段使用率
  断言 10: flush_dependencies() 后 dependent nmethod 被标记 not_entrant

§八 和 [01][02][05] 的交叉验证
  ❓ 01-Pipeline §八（CodeCache::allocate() + nmethod 构造）→ 04 的空间分配
  ❓ 02-Inline §五（Inline→nmethod 大小）→ 04 的 CodeCache 容量
  ❓ 05-Deoptimization §X（deopt 导致 nmethod 变 not_entrant）→ 04 的 not_entrant→zombie
```

## 六、写作要求

1. **★ Mermaid nmethod 生命周期状态转换图**——5 个状态 + 转换条件 + 触发函数名
2. **★ "你需要知道的" 5 概念 callout 框**——nmethod/CodeBlob/CodeCache/Sweeper/Zombie
3. **★ CodeCache 3 段布局图**——标注段名 + 默认大小 + 存储了什么类型的 CodeBlob
4. **★ 面试 Story Format 答案**——§ 一末尾："CodeCache 满了怎么办？nmethod 生命周期？"
5. **★ 生产诊断 3 步 workflow**——jcmd analytics → PrintInlining → CompileCommand
6. **★ Sweeper 的"慢"的量化解释**——为什么 CodeCache 满后 3 分钟才恢复
7. **★ GDB 断点**——nmethod::make_not_entrant、can_be_zombie、sweep_code_cache、CodeCache::free
8. **★ 交叉引用**：01 §八（nmethod 构造）、02 §五（内联→nmethod 大小）、05 §X（deopt→not_entrant）

## 七、输出格式

- Markdown 文件，命名为 `04-CodeCache-Sweeper.md`
- 输出路径：`/data/workspace/openjdk-cut-new/probe_md/libjvm-analysis/05-jit-compiler/`
- 元信息头：
  ```
  > **阶段**：[05-jit-compiler]
  > **前置**：[01-C2-Pipeline] §八（nmethod 构造 + CodeCache::allocate()）、[02-Inline-Decision] §五（内联→nmethod 大小）
  > **配套**：[05-Deoptimization]（deopt 导致 nmethod 变 not_entrant/zombie）
  > **阅读收益**：理解 nmethod 的完整生命周期（alive→not_entrant→zombie→unloaded→freed）和 CodeCache 的 3 段布局；掌握 NMethodSweeper 后台清理机制 + emergency flush 触发条件；能用 jcmd Compiler.CodeHeap_Analytics 诊断 CodeCache 满
  ```

## 禁止行为

- ❌ 只讲 CodeCache 不讲 nmethod 生命周期——nmethod 是 CodeCache 管理的对象，两者不可分
- ❌ 不解释为什么 Sweeper 在 safepoint 中执行——这和 GC 在 safepoint 中的关系是新概念
- ❌ 忽略 Speculative Disconnect——deopt→recompile 循环是生产 CodeCache 满的核心原因之一
- ❌ 不解释 3 段布局的设计理由——只说"有 3 段"不给隔离的好处
- ❌ 不做 Sweeper 速度的量化——不说"3 分钟才恢复"的人不知道这个问题的严重性
- ❌ 不解释 not_entrant→zombie 的"所有线程已退出"怎么检查
- ❌ 忘记和 [01]（nmethod 构造）和 [02]（nmethod 大小）的连接

## 要求行为

- ✅ **★ Mermaid 5 状态转换图**——标注转换函数 + 条件 + 触发者
- ✅ **★ "你需要知道的" 5 概念 callout 框**
- ✅ **★ CodeCache 3 段布局 ASCII 图**——Non-profiled / Profiled / Non-method
- ✅ **★ jcmd Compiler.CodeHeap_Analytics 输出解读**
- ✅ **★ 生产诊断 3 步 workflow**
- ✅ **★ 面试 Story Format 答案模板**
- ✅ **★ GDB 断言 ≥10 条**
- ✅ **★ 交叉引用 01 + 02 + 05 的精确 § 号**
