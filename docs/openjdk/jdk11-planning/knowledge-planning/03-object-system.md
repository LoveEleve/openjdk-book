# 域 03: 对象与系统 — 知识规划

> 源码路径: java.base/share/classes/java/lang/{Object,System,Runtime,ProcessBuilder,Process,ClassValue,ThreadGroup,SecurityManager}.java + java/lang/ref/(10 文件) + jdk/internal/misc/{VM,Signal}.java + java.base/unix/classes/java/lang/ProcessImpl.java
> 源码量: ~22 文件 / ~13,000 行 | 非巨型域
> 写作层: Layer 1(前置: 域 01 字符串、06 异常)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| Object.java (559 行) | **Object 方法契约**: hashCode native(109)、equals(157,引用比较)、clone native(222)、toString(245)、notify/wait native(282/307)、finalize 空实现(558)——JVM 级方法,Java 侧只是声明 | High |
| java/lang/ref/Reference.java | **引用对象状态机**: referent(151,GC 特殊处理)、queue(161)、next(171)——active/pending/inactive 三态;ReferenceHandler 线程(190,守护线程处理 pending 链);Cleaner 分派 | High |
| java/lang/ref/{Soft,Weak,Phantom}Reference.java | **引用强度梯度**: 软引用(内存不足回收)/弱引用(GC 即回收)/虚引用(仅跟踪,get 恒 null,配合 Cleaner) | High |
| java/lang/ref/ReferenceQueue.java | **引用队列**: 引用入队机制,轮询/阻塞移除 | Medium |
| java/lang/ref/{Cleaner,Finalizer,FinalReference}.java | **清理机制**: Cleaner(JDK9+,基于 PhantomReference 的清理回调)、Finalizer(历史 finalize 实现,JDK9 弃用)、FinalReference | Medium |
| System.java (2234 行) | **系统门面**: arraycopy native(535)、nanoTime native(440)、currentTimeMillis native(396)、getProperty、getSecurityManager(375)、console(244)、静态块 registerNatives(102,VM 驱动初始化) | High |
| Runtime.java (1498 行) | **运行时门面**: getRuntime(70)、exit(111)、addShutdownHook(211,Shutdown 钩子链)、freeMemory/totalMemory native(618 等)、exec(312,委托 ProcessBuilder) | High |
| ProcessBuilder.java (1301) | **进程启动器**: start(1070)→ProcessImpl.start(1107);重定向/环境变量/工作目录 | High |
| unix/ProcessImpl.java | **fork+exec 实现**: native forkAndExec,进程句柄管理与 wait | High |
| Process.java (583) | 进程抽象接口: getOutputStream/getInputStream/waitFor/destroyForcibly | Medium |
| jdk/internal/misc/VM.java | **VM 状态门面**: booted 标志(93)、saveAndRemoveProperties(187,保存系统属性供 JDK 内部用)、getSavedProperty(159)、initialize native(415) | Medium |
| jdk/internal/misc/Signal.java | **信号处理**: 注册 native 信号处理器,handler 分发 | Low |
| ClassValue.java (769) | **类级值缓存**: ClassValueMap 缓存,类卸载时清理 | Low |
| ThreadGroup.java (1088) | **线程组**: 树结构,uncaughtException 处理链 | Low |
| SecurityManager.java (1453) | **安全管理器**: checkPermission 体系(JDK11 起默认禁用) | Low |

*15 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | Object 方法契约 | 1 (Object) | 面试必考(hashCode/equals 契约、finalize 弃用) |
| P1 | 四种引用与状态机 | 5 (Reference/Soft/Weak/Phantom/Queue) | 面试重头(引用强度、泄漏排查);框架基础(缓存/Spring) |
| P1 | System/Runtime 门面 | 2 (System/Runtime) | 面试常问(nanoTime vs currentTimeMillis、shutdownHook);生产(时间戳、钩子) |
| P2 | 进程启动 | 3 (ProcessBuilder/Process/ProcessImpl) | 生产(外部命令)、面试偶尔(为什么 exec 慢) |
| P2 | VM 初始化与属性 | 1 (VM) | 衔接内部卷启动流程 |
| P3 | Signal/ClassValue/ThreadGroup/SecurityManager | 4 | 面试低频,使用层 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | Object 契约(hashCode/equals/toString/clone/finalize) | 面试必考(hashCode-equals 契约违反后果、clone 浅拷贝、finalize 弃用原因);一切类的行为基线 |
| 🔴 Deep | 四种引用与 ReferenceHandler | 面试高频(软/弱/虚引用区别、ThreadLocal 泄漏关联);生产(缓存设计、Cleaner 替代 finalize) |
| 🔴 Deep | System 门面(arraycopy/nanoTime/currentTimeMillis/console) | 面试常问(时间 API 选择);生产高频 |
| 🟡 Working | Runtime 与 shutdownHook | 面试偶尔;生产(优雅停机钩子) |
| 🟡 Working | 进程启动 | 生产(调用外部工具);面试偶尔 |
| 🟢 Surface | VM/Signal/ClassValue/ThreadGroup/SecurityManager | 面试低频;VM 细节衔接内部卷 |

## 04 聚类

### 依赖图(域内)
```
Object(契约) ←── 一切类(含 ref/Reference 家族)
System(门面) ←── Runtime(门面) ←── ProcessBuilder ←── ProcessImpl(平台)
VM(启动状态) ←── System/整个 JDK 初始化
Reference 家族 ←── Cleaner/Finalizer(清理回调)
ThreadGroup ←── Thread(域 11 衔接)
```

### 教学顺序与文章拆分(3 篇)

1. **Object 的方法契约与对象生命周期** — hashCode/equals/toString/clone/finalize 契约;四种引用状态机与 ReferenceHandler
2. **System 与 Runtime 门面** — arraycopy/nanoTime/currentTimeMillis/getProperty;exit/shutdownHook/内存查询
3. **进程与本地交互** — ProcessBuilder 启动流程、fork+exec、VM 初始化属性、Signal

> 前置: 域 01(toString 格式)、06(异常契约)。跨层: Object native 方法(内部卷 06-oops markOop hash 位);VM 初始化(内部卷 30-jvm-entry);ThreadGroup 关联域 11
