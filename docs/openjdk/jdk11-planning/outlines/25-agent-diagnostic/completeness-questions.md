# 域 25: Agent 与诊断机制 — 完整性验证

> 全视角身份检查(≥5 身份)

## 身份 1: 面试官
- [x] "Arthas 怎么 attach" — 01 篇 §1-2(VirtualMachine.java:194, linux Impl:50/73/275)
- [x] "attach 通道(/tmp/.java_pid)" — 01 篇 §2(275)
- [x] "attach 后怎么交互(execute 协议)" — 01 篇 §3(HotSpotVirtualMachine.java:301)
- [x] "Instrumentation 能干什么" — 02 篇 §1(99/260/351/383)
- [x] "transformer 链顺序" — 02 篇 §2(TransformerManager.java:93/169-188)
- [x] "retransform vs redefine" — 02 篇 §3(InstrumentationImpl:167/193)
- [x] "premain vs agentmain" — 02 篇 §4(VirtualMachine.java:535)
- [x] "线上排查工具顺序" — 03 篇 §1/4(JStack.java:117)
- [x] "jcmd vs jstack" — 03 篇 §2

## 身份 2: 生产工程师
- [x] CPU 高排查(top+jstack)— 03 篇 §3
- [x] 死锁检测 — 03 篇 §3
- [x] 内存问题(jmap/jstat)— 03 篇 §4
- [x] /tmp 权限导致 attach 失败 — 01 篇 §2

## 身份 3: 框架工程师
- [x] APM/Arthas 原理 — 02 篇
- [x] 字节码增强技术 — 02 篇

## 身份 4: 源码方法论文审查
- [x] 场景句/源码锚(已验证 Instrumentation.java:99/111/260/351/383, InstrumentationImpl.java:59/167/193/368-383, TransformerManager.java:41/69/93/169-188, VirtualMachine.java:141/194/269/468/535, AttachProvider.java:101/108/151/247, linux VirtualMachineImpl.java:50/73/275, HotSpotVirtualMachine.java:86/94/301, JCmd.java:52/98/111, JStack.java:117)/关键设计/跨层([内部卷 36/28]/[内核]/[关联])/核心悬念+OUTBOUND
- [x] 无文字描述源锚
- [x] attach 协议(版本握手 172/PROTOCOL_VERSION 137)实测

## 身份 5: 完整性缺口检查
- [x] attach(01)/Instrumentation(02)/工具(03)三篇覆盖域全部面试主战场
- [x] jps/jstat/jinfo/jmap 并入 03 篇;AgentInitializationException 等并入 02 篇提及
- [x] 未覆盖确认: attach 的 native 实现细节(内部卷 36)、类重定义限制细节(内部卷 28)——跨层指向
- [x] 二次 review 修正: attach 触发机制锚定(QUIT 信号触发,VirtualMachineImpl.java:71 注释);premain/agentmain 加载实现锚定(loadClassAndStartAgent,InstrumentationImpl.java:525/535)
- [x] 验证通过: attach 协议版本握手(PROTOCOL_VERSION=1:137/172)、execute 抽象(301)、TransformerManager 责任链(93/169-188)、retransform/redefine native(167/193)
- [ ] 待办: 写作时验证 attach 触发流程(目标未监听时的 SIGQUIT 细节)、agentmain 的 ClassFileTransformer 时序
