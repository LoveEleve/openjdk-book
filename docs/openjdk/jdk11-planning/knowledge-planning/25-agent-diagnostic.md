# 域 25: Agent 与诊断机制 — 知识规划

> 源码路径: java.instrument/(10 文件:java/lang/instrument + sun/instrument) + jdk.attach/(13 文件:com/sun/tools/attach + **linux/classes/sun/tools/attach 平台实现**) + jdk.jcmd/(39 文件:sun/tools/{jcmd,jstack,jmap,jinfo,jps,jstat})
> 源码量: 62 文件 / ~15,000 行 | 非巨型域
> 写作层: Layer 5(前置: 域 04 反射、07 类加载;诊断与字节码增强)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| java/lang/instrument/Instrumentation.java | **增强接口**: addTransformer(99,可 retransform)/retransformClasses(260,已加载类重新转换)/redefineClasses(351,字节替换)/isModifiableClass(383) | High |
| sun/instrument/InstrumentationImpl.java (59) | **native 实现**: redefineClasses0(193)/retransformClasses0(167)/native agent 句柄(368-383) | High |
| sun/instrument/TransformerManager.java (41) | **转换器管理**: transformer 数组(按序 69/93)/transform 调用链(169-188,逐 transformer 尝试) | High |
| com/sun/tools/attach/VirtualMachine.java | **attach 门面**: attach(id)(194)/list(141)/detach(269)/loadAgent(535)/loadAgentPath(468) | High |
| com/sun/tools/attach/spi/AttachProvider.java | **平台 SPI**: name(101)/type(108)/attachVirtualMachine(151)/providers(247,ServiceLoader) | High |
| jdk.attach/linux/classes/sun/tools/attach/VirtualMachineImpl.java | **linux 实现**: socket_path(50,/tmp/.java_pid)/findSocketFile(73)/握手协议 | High |
| jdk.attach sun/tools/attach/HotSpotVirtualMachine.java | **执行协议**: loadAgentLibrary(86,execute("load",...))/147(load instrument 库)——attach 后的命令通道 | High |
| jdk.jcmd sun/tools/jcmd/JCmd.java | **jcmd 入口**: main(52)/executeCommandForPid(98/111)——attach+命令分发 | Medium |
| jdk.jcmd JStack/JMap/JInfo/Jps/Jstat | **诊断工具族**: attach 后执行(如 JStack 117 attach)——统一走 attach | Medium |

*9 个知识点*

## 02 聚合

| 等级 | 机制 | 文件数 | 说明 |
|:--:|------|:--:|------|
| P1 | Attach 机制(套接字+SPI) | 4 (VirtualMachine/Provider/Impl/HotSpotVM) | 面试高频(Arthas 原理);生产(诊断工具) |
| P1 | Instrumentation 与字节码增强 | 4 (Instrumentation/Impl/TransformerManager/ClassFileTransformer) | 面试高频(APM/Arthas/字节码增强) |
| P2 | 诊断工具族 | 6 (jcmd/jstack/jmap 等) | 生产(排查工具用法) |
| P3 | agent 启动细节 | 1 | 面试偶尔 |

## 03 深度分级

| 等级 | 机制 | 为什么 |
|:--:|------|------|
| 🔴 Deep | Attach 机制 | 面试高频(Arthas 怎么 attach);生产(诊断工具原理) |
| 🔴 Deep | Instrumentation 转换链 | 面试高频(字节码增强/APM 原理) |
| 🟡 Working | 诊断工具用法 | 生产(jstack/jmap/jstat 排查) |
| 🟢 Surface | agent 协议细节 | 面试低频 |

## 04 聚类

### 依赖图(域内)
```
VirtualMachine(attach) ←── AttachProvider(SPI) ←── linux VirtualMachineImpl(套接字)
HotSpotVirtualMachine(execute 协议) ←── jcmd/jstack(工具)
Instrumentation(接口) ←── InstrumentationImpl(native) ←── TransformerManager
Instrumentation ←── ClassFileTransformer(用户转换器)
agent 启动 ←── InstrumentationImpl 的 premain/agentmain
```

### 教学顺序与文章拆分(3 篇)

1. **Attach 机制** — attach 流程(找进程→套接字→握手)、linux 实现(/tmp/.java_pid 套接字)、AttachProvider SPI、HotSpotVirtualMachine 命令协议
2. **Instrumentation 与字节码增强** — addTransformer/retransform/redefine、TransformerManager 链、native 边界、agent(premain/agentmain)、Arthas/APM 原理
3. **诊断工具族与生产规范** — jcmd/jstack/jmap/jps/jstat/jinfo 的 attach 用法、JFR 衔接、排查流程

> 前置: 域 04(反射)、07(类加载)、39(JFR 衔接)。跨层: attach 的 JVMTI(内部卷 36-attach);类重定义(内部卷 28-jvmti)
