# HANDOFF — OpenJDK 源码分析大纲阶段

> 2026-08-07 | 上下文过长，新会话交接
> 25/38 域大纲完成 + 全部 Pass 0+1 探索笔记

---

## ⚡ 你的第一个行动（立即执行，不是读完才做）

**当前状态**：vol-04 域 25 ci 刚完成。下一步：**域 26 JIT Framework**。

```
步骤 1: 读三份规划文件（5 分钟）
  Read /data/workspace/source-code/openjdk-book/docs/openjdk/planning/00-domain-list.md
  Read /data/workspace/source-code/openjdk-book/docs/openjdk/planning/01-book-plan.md  
  Read /data/workspace/source-code/openjdk-book/docs/openjdk/planning/04-approach-selection.md

步骤 2: 读方法论文档（2 分钟）
  Read /data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/talk-method/source-code-analysis/methodology/zh/01-三层循环框架.md
  Read /data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/talk-method/source-code-analysis/methodology/zh/02-依赖顺序与分解原则.md

步骤 3: 开始域 26 JIT Framework 的 Pass 0+1
  按照 §四 9 步流程执行（Pass 0 git log → Pass 1 包扫描+继承树+≥5标记问题 → #{N}-pass1.md → 大纲）
  
步骤 4: 深审 + 呈报用户
  输出方法论声明块 → grep 逐条验证 → 检查桥+前向引用 → 用户确认
```

**验证你读对了**：打开 vol-04 最后一个域大纲，确认是 `25-ci.md`。如果下一个文件不是 `26-jit-framework.md`，说明进度对齐正确。

**关键提醒**：
- jdk11u 是**裁剪版**（仅 G1/x86/linux），不是官方完整版 — 域清单 §代码库范围声明 有完整差异
- 每次深审前**必须**输出方法论声明块（含 01/03/05 + 单域节奏）
- 有 12+ 处编造名称的前科（§三）— 每个机制名必须 grep 验证

---

## §零 核心约束（新 AI 必须逐条遵守）

| # | 约束 | 来源 |
|:--:|------|------|
| 1 | **一次一个域** — 写完一个域大纲 → 深审 → 修复 → 用户确认 → 才下一个 | 两次批写违规被用户爆炸 |
| 2 | **每域先 Pass 0+1 再大纲** — git log + 包扫描 + 继承树 + ≥5 标记问题 | 跳 Pass 0+1 三次复发 |
| 3 | **每声明 grep 源码验证** — 机制名/行号/默认值全部确认 | 12+ 处编造名称 |
| 4 | **每深审前输出方法论声明** — 含 01/03/05 + 单域节奏 | 无声明=无约束 |
| 5 | **叙事桥不可缺** — 每域有入桥(→ 从) + 出桥(→ 下一/→ 卷) | 桥缺失是系统性错误 |
| 6 | **前向引用禁止** — 大纲不能引用 >5 域后的概念 | Assembler 开篇违规 |
| 7 | **版本越界检查** — JDK11 的 AsyncLogWriter 不存在 | Logging 域编造 |

---

## §一 当前进度

**25/38 域大纲完成**，全部 Pass 0+1 探索笔记就绪。

| 卷 | 域 | 状态 | 文件数 |
|------|:--:|:--:|:--:|
| vol-01 地基 | 8 | ✅ | 8 大纲 + 3 Pass1 |
| vol-02 并发 | 4 | ✅ | 4 大纲 + 0 Pass1（早于 Pass 0+1 流程强制前完成，经过多轮深审） |
| vol-03 内存 | 9 | ✅ | 9 大纲 + 0 Pass1（同上）|
| vol-04 类加载/执行 | 4 | ✅ | 4 大纲 + 4 Pass1 |
| **合计** | **25** | | |

**剩余 13 域**：vol-04 域 26-31（JIT Framework / SharedRuntime / C1 / C2 / Deoptimization / MethodHandles）+ vol-05 7 域（可观测性集群）。

**当前域**：vol-04 域 25 ci 完成。下一个：域 26 JIT Framework。

---

## §二 关键路径 + 快速启动

```bash
# 1. 项目根目录
/data/workspace/source-code/openjdk-book/

# 2. 域清单（38域全貌）
docs/openjdk/planning/00-domain-list.md

# 3. 书级规划（6卷结构）
docs/openjdk/planning/01-book-plan.md

# 4. 方案选择（17A+20B+1C）
docs/openjdk/planning/04-approach-selection.md

# 5. 大纲目录
docs/openjdk/planning/outlines/vol-0[1-5]/

# 6. 方法论文档
/data/workspace/source-code/book/成长之路/tmp-question/training-camp/source-code/analysis/talk-method/source-code-analysis/methodology/zh/

# 7. JDK 源码（裁剪版 — 仅 G1/x86/linux）
# 注意: 本仓库是裁剪版 jdk11u（提交 0312fc9b22），非官方完整版
# 缺失: ZGC/Epsilon/CMS/Parallel/Serial GC + ARM/PPC/Zero CPU + Windows/BSD OS
# 域清单 §代码库范围声明 记录了完整差异
/data/workspace/jdk11u/
```

**启动新会话第一步**：
```bash
Read /data/workspace/source-code/openjdk-book/docs/openjdk/planning/00-domain-list.md
Read /data/workspace/source-code/openjdk-book/docs/openjdk/planning/01-book-plan.md
Read /data/workspace/source-code/openjdk-book/docs/openjdk/planning/04-approach-selection.md
ls /data/workspace/source-code/openjdk-book/docs/openjdk/planning/outlines/vol-04/
```

---

## §三 踩坑清单（关键教训）

### 编造名称（12+ 处，所有已有大纲均为补救后版本）

| 域 | 原宣称 | 实际 | 发现轮次 |
|------|------|------|:--:|
| OS | `CommitLimiter` 控制 overcommit | 不存在 | R1 |
| OS | `numa_alloc_onnode` + `mbind` | `numa_set_bind_policy` | R2 |
| OS | `sched_setaffinity` 设 CPU 亲和性 | `bind_to_processor()=return false` | R2 |
| OS | `LD_PRELOAD libjsig.so` | JVM 在 install_signal_handlers 中协作 | R2 |
| OS | `signal_init` | `initialize_jdk_signal_support` | R2 |
| OS | `PlatformParker → ObjectMonitor` | `PlatformParker → Parker → Unsafe.park()` | R3 |
| Assembler | `CodeCacheFullException` | warning "Compiler has been disabled" | R2 |
| Assembler | `call(entry, reloc)` | `call_literal(entry.target(), entry.rspec())` | R2 |
| Logging | `AsyncLogWriter` 异步日志 | JDK17+ 特性，JDK11 不存在 | 版本越界 |
| Arguments | `Arguments::parse()` at `:3761` | `parse_vm_init_args()` at `:2196` | R1 |
| CodeCache | `NMethodSweeper.hpp` | 文件不存在 | R2 |
| PerfData | magic `0xc0c0feca` | `0xcafec0c0` | 域清单错误 |

### 批量写作违规（两次）

1. **第一次**：vol-03 #14-16 一次写 3 域 → 用户爆炸 → 回退逐一深审
2. **第二次**：vol-03 #17-19 一次写 3 域 → 用户爆炸 "你tmd，方法论没用吗？"

**模式**：纠正后有效几个域，切换 volume 后复发。对策：强制前置方法论声明确认单域节奏。

### Pass 0+1 跳步骤（三次复发）

1. vol-01：跳 Pass 0+1 → 6 个编造
2. vol-03：跳 Pass 0+1 → 批量写 + 偏薄大纲
3. vol-04 #22-24：跳 Pass 0+1 → 回退补做，从 2-4 层扩充到 5-7 层

**Pass 0+1 的价值**（对比数据）：
- VTable/IC：跳步版 2 层 → Pass 1 后 5 层（+itable/final patching/IC-nmethod 分离）
- Interpreter：跳步版 6 层薄 → Pass 1 后 6 层厚（+InvocationCounter/GC barrier/TosState）
- ClassFile：跳步版 4 层 → Pass 1 后 7 层（+Dictionary/CLD/ModuleEntry/well-known）

### 叙事桥缺失（系统性错误）

每重写大纲时桥丢失。模式：Edit 工具替换正文时未保留桥 → 需要每次深审检查 `grep "→ "`。

### 行号/文件名错误

- `::3761` → 实际 `::2196`（Arguments::parse）
- `stubCodeGenerator.hpp:102` → 实际 `:97`（StubGenerator）
- 域清单中 magic `0xc0c0feca` → 实际 `0xcafec0c0`

---

## §四 每个域的正确执行流程

```
1. 读域清单确认位置 + 方案
2. Pass 0: git log --grep 了解设计变更历史
3. Pass 1: 包扫描 + 核心类声明 + 继承树 + ≥5 标记问题 + 交叉关联
4. 写 #{N}-pass1.md 探索笔记
5. 写 #{N}-{name}.md 大纲（头含 "→ 从" 桥 + 脚含 "→ 下一" 桥）
6. 输出方法论声明块（自执行协议）
7. grep 逐条验证声明
8. 深审（桥 + 前向引用 + 行号 + 编造名称）
9. 用户确认 → 下一域
```

---

## §五 域 26-38 剩余清单

| # | 域 | 🔴/🟡 | 方案 | 卷 |
|:--:|-----|:---:|:--:|:--:|
| 26 | JIT Framework | 🔴 | A | vol-04 |
| 27 | SharedRuntime | 🟡 | B | vol-04 |
| 28 | C1 Compiler | 🔴 | A | vol-04 |
| 29 | C2 Compiler | 🔴 | A | vol-04 |
| 30 | Deoptimization | 🟡 | B | vol-04 |
| 31 | MethodHandles | 🔴 | A | vol-04 |
| 32-38 | JVMTI~JFR | 🟡 | B/C | vol-05 |

---

*新 AI 从域 26 JIT Framework Pass 0+1 开始。严格逐域执行，先 Pass 0+1 再大纲。*
