# 域 03: Arguments & Flags — 全视角提问验证

> 12 KP / 🔴4 + 🟡4 + 🟢4 | ~31 文件/~15,000行 | 拆 2 篇文章

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | `PRODUCT_FLAG(bool, UseG1GC, true, ...)` 这行宏展开后会生成什么代码？写出至少 3 处不同的代码位置 | ✅ 01 §1 |
| D2 | arguments.cpp 的 `parse_each_vm_init_arg()` 怎么识别 `-XX:+` vs `-XX:-` vs `-XX:`= — 单遍扫描的完整流程？ | ✅ 02 §1 |
| D3 | `jvmFlagConstraintList.cpp` 的三阶段 check — AfterParse, AfterErgo, AfterMemoryInit 分别什么时候触发？ | ✅ 02 §3 |

## 维度 2: 性能工程师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| P1 | Ergo 设置的 ParallelGCThreads — 8*CPU_COUNT/8 的公式为什么除以 8？多 GC 线程的收益递减？ | ✅ 02 §2 |
| P2 | Flag_writelock 在 flag 读取路径上的开销 — 为什么普通 flag 读取不需要锁？ | ✅ 02 §4 |

## 维度 3: SRE/运维

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| S1 | `-XX:+PrintFlagsFinal` vs `-XX:+PrintFlagsInitial` — 两个的差异是什么？Ergo 调整了多少 flag？ | ✅ 02 §4 — PrintFlagsFinal=Ergo后, Initial=Ergo前, diff=Ergo修改痕迹 |
| S2 | jcmd VM.set_flag 修改 MANAGEABLE flag — 修改后对正在运行的 GC/JIT 有什么影响？ | ✅ 02 §4 |
| S3 | `-XX:MaxRAMFraction=4` vs `-Xmx4g` — 当两者都指定时哪个优先？理由是什么？ | ✅ 02 §2 — ARG > ERGO 优先级 |

## 维度 4: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | 为什么不用 JSON/YAML config 文件定义 flag 而用 C++ 宏？— 前者更易读易写但牺牲了多少？ | ✅ 01 §1 |
| A2 | Origin 的 5 级层次 (DEFAULT→ARG→ERGO→MANAGEABLE→INTERNAL) — 为什么不只用 "user" vs "system" 两级？ | ✅ 01 §2 |
| A3 | 6 个平台 flag 文件通过 GLOBALS_EXTENSION 聚合 — 为什么这个扩展点是宏注入而不是虚函数或配置文件？ | ✅ 01 §3 |

## 维度 5: 学生

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| L1 | `-Xms`, `-Xmx`, `-XX:+UseG1GC` 的区别 — 为什么有的用 `-X` 有的用 `-XX:`？ | ✅ 02 §1 |
| L2 | 什么是 Ergonomics？— JVM 为什么需要"自动调节" flag？ | ✅ 02 §2 |
| L3 | `-XX:+UnlockExperimentalVMOptions` 为什么不默认启用？— 实验性 flag 的风险 | ✅ 01 §1 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 性能工程师 | 2 | 2 | ✅ |
| SRE/运维 | 3 | 3 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| 学生 | 3 | 3 | ✅ |
| **合计** | **14** | **14** | ✅ |

> 1 处初审 ⚠️ 已修复（S1 PrintFlagsFinal vs Initial — 02 §4 已补诊断命令）。**14/14 全覆盖。**
