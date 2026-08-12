# 域 04: Logging — 全视角提问验证

> 13 KP / 🔴3 + 🟡5 + 🟢5 | 37 文件/5,292行 | 拆 2 篇文章

## 维度 1: 开发者

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| D1 | `LOG_TAGS(gc, region, task, phases, heap)` 宏展开后生成什么？LogTagSet 对象怎么初始化？ | ✅ 01 §2 |
| D2 | `-Xlog:gc*=debug:gc.log:filesize=10M,filecount=5` 的完整解析流程——selection→output→options | ✅ 01 §3 + 02 §2 |
| D3 | LogFileOutput 的 rotate 触发——size 怎么检测？有没有信号触发？ | ✅ 02 §1 — size 记账(_current_size>=_rotate_size)+ jcmd rotate 手动;jdk11u 无 SIGUSR2 信号轮转 |

## 维度 2: 性能工程师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| P1 | LogDecorations 的缓存——每毫秒/纳秒避免 clock_gettime 的开销有多大？ | ✅ 02 §3 |
| P2 | LogMessageBuffer 的 1024B 缓冲——什么日志会超过 1024B？怎么处理溢出？ | ✅ 02 §3 — 溢出按 2 倍 realloc 增长,不 truncate、无 MESSAGE_OVERFLOW(logMessageBuffer.cpp:29-37,96-121;大纲旧稿"truncate+`... (truncated)`"为编造,写作期已修正) |
| P3 | LogDecorations 缓存优化——避免每条日志调 clock_gettime 的性能收益？ | ✅ 02 §3 |

## 维度 3: SRE/运维

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| S1 | `jcmd <pid> VM.log` 的全部选项——output/output_options/what/decorators/disable/list/rotate | ✅ 02 §4(无 enable 子命令;what 任一出现即重配) |
| S2 | `gc.log` 文件过大 → jcmd 切换到新文件——旧文件的最后几条消息会丢失吗？ | ✅ 02 §1 — rotate 在写信号量保护下 fclose+rename+fopen,排队消息不丢;配置切换下一帧生效 |

## 维度 4: 架构师

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| A1 | 为什么 JVM 不用 log4j/slf4j 等 Java 日志库？— 启动时 Java 运行时还未就绪 | ✅ 01 §1 |
| A2 | Tag 比 Module 好在哪里？— 一条日志属于多个 tag 的能力 | ✅ 01 §1 |
| A3 | OutputList 的多输出链表——为什么不是单输出 + 多个 Output 线程？ | ✅ 02 §1 |

## 维度 5: 学生

| # | 问题 | 覆盖? |
|:--:|------|:--:|
| L1 | `-Xlog:gc*` vs `-verbose:gc` 的区别？— 一个是 ULF 语法, 一个是旧 GC 日志语法 | ✅ 01 §3 |
| L2 | LogLevel 的 Trace/Debug/Info 和 log4j 的 TRACE/DEBUG/INFO 是一样的吗？ | ✅ 01 §2 |

---

## 审查结论

| 维度 | 问题数 | 全覆盖 | 状态 |
|------|:--:|:--:|:--:|
| 开发者 | 3 | 3 | ✅ |
| 性能工程师 | 2 | 2 | ✅ |
| SRE/运维 | 2 | 2 | ✅ |
| 架构师 | 3 | 3 | ✅ |
| 学生 | 2 | 2 | ✅ |
| **合计** | **12** | **12** | ✅ |

> 2 处初审 ⚠️ 已修复（P2 LogMessageBuffer overflow — 实际是惰性堆分配 1024B+2 倍 realloc 增长,非 truncate;D3 signal(SIGUSR2) — jdk11u 无信号轮转,只有 size 自动 + jcmd rotate 手动）。**12/12 全覆盖。**
