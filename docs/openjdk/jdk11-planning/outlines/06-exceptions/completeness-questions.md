# 域 06: 异常体系 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "异常对象里存了什么/抛异常为什么慢" — 01 篇 §1(fillInStackTrace native, Throwable.java:254/784)
- [x] "Caused by 怎么来的/根因链" — 01 篇 §2(getCause, Throwable.java:419)
- [x] "try-with-resources 关闭异常去哪了" — 01 篇 §3(suppressed, Throwable.java:902)
- [x] "堆栈为什么没打出来" — 01 篇 §4(writableStackTrace 四参构造)
- [x] "checked vs unchecked" — 02 篇 §1(RuntimeException.java:43)
- [x] "catch(Exception) 能抓 OOM 吗" — 02 篇 §2(Error 分支)
- [x] "Spring 为什么包 RuntimeException" — 02 篇 §3

## 身份 2: 生产工程师
- [x] 日志堆栈缺失排查 — 01 篇 §4 / 02 篇 §4
- [x] 异常包装规范(保留 cause)— 02 篇 §4
- [x] 吞异常反模式 — 02 篇 §4
- [x] 异常驱动控制流性能 — 01 篇 §1

## 身份 3: 框架工程师
- [x] Spring NestedRuntimeException 设计参照 — 02 篇 §3
- [x] lambda 无法抛受检异常 — 02 篇 §3(衔接域 16)

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Throwable.java:211/220/232/254/291/314/419/483/665/784/902, StackTraceElement.java:66-67/251/262, RuntimeException.java:43)/关键设计/跨层([JVM Spec]/[内部卷])/核心悬念+OUTBOUND
- [x] 无文字描述源锚

## 身份 5: 完整性缺口检查
- [x] Throwable 结构 + 类型体系两篇覆盖全部面试主战场
- [x] StackTraceElement 格式已覆盖(01 篇 §1 提及 + KP 02 聚合)
- [x] 51 个异常类归类讲(不逐类罗列)— KP §02 P2 决策
- [x] 未覆盖确认: printStackTrace 完整格式(写作时展开 01 篇 §3 输出段)
- [ ] 待办: 域 01→06 衔接的"线程异常传递"已在 06 第 2 篇 OUTBOUND 标注,域 11 写作时引用
