# 域 03: 对象与系统 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "Object 有哪些方法/为什么 native" — 01 篇 §1(Object.java:72/109/157/222/245/558)
- [x] "hashCode-equals 契约/集合失效" — 01 篇 §2
- [x] "finalize 为什么弃用" — 01 篇 §3(Cleaner/Finalizer)
- [x] "四种引用区别" — 01 篇 §4(Reference.java:151/161/171/190)
- [x] "currentTimeMillis vs nanoTime" — 02 篇 §1(System.java:396/440)
- [x] "arraycopy 为什么快" — 02 篇 §2(System.java:535)
- [x] "shutdownHook 机制" — 02 篇 §4(Runtime.java:211/111)
- [x] "Process 卡死问题/exec 底层" — 03 篇 §1-2(ProcessImpl.java:322 forkAndExec)

## 身份 2: 生产工程师
- [x] 时间跳变/耗时测量 — 02 篇 §1
- [x] 优雅停机钩子 — 02 篇 §4
- [x] 外部命令调用卡死 — 03 篇 §1
- [x] ThreadLocal 泄漏(关联引用强度)— 01 篇 §4 标注关联域 11

## 身份 3: 框架工程师
- [x] 缓存设计(软/弱引用)— 01 篇 §4
- [x] Cleaner 替代 finalize(Netty/DirectBuffer 关联)— 01 篇 §3 标注域 19/32
- [x] 进程管理(构建工具/部署脚本)— 03 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Object.java:72/109/157/222/245/282/307/558, System.java:102/396/440/535/826, Runtime.java:70/111/211/618/631/642/660, ProcessBuilder.java:1070/1107, ProcessImpl.java:187/322, VM.java:93/159/187, Reference.java:151/161/171/190/332)/关键设计/跨层([内部卷]/[JVM Spec]/[内核]/[man])/核心悬念+OUTBOUND
- [x] 无文字描述源锚(自查时 grep)
- [x] System.initializeSystemClass 已核实仅存在于注释(96/99),正文改为"VM 驱动初始化 + System.java:102 静态块 registerNatives",无编造

## 身份 5: 完整性缺口检查
- [x] 契约(01)/门面(02)/进程(03)三篇覆盖域全部面试主战场
- [x] java.lang.ref 全家族已覆盖(Reference/Soft/Weak/Phantom/Queue/Cleaner/Finalizer)
- [x] ThreadGroup/SecurityManager/ClassValue 已归 🟢 Surface(KP 注明),写作时合并进相关篇目提及
- [x] Process/ProcessImpl 平台分层已注明(unix 实现,linux 构建包含)
- [x] waitFor 机制已实测修正: wait/notify 模型(ProcessImpl.java:493-498),hasExited 由 ProcessHandleImpl.completion 回调设置(388-393),非轮询
- [x] 二次 review 修正: 管道在 native forkAndExec 内创建(std_fds 仅 Java 侧组装,226-244);LaunchMechanism Linux 默认 VFORK(83-92);VM.initialize 为静态块触发(413-415),删除编造引号;System.props 由 initPhase1 创建(1954),非懒加载;JLS §17 误引改回 Object Javadoc
