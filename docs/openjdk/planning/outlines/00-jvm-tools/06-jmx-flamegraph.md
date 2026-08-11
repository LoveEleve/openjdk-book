# 06. JMX 与火焰图: 观察 JVM 的两类眼睛 — jconsole 与采样对照

> 🟢 工具域 | 工具: jconsole/JMC MBean 浏览器/FlameGraph(✅)/perf(✅) | 关联 JVM 域: 33-jmx、18-safepoint、32-jfr
> 读者处境: 你要写 JMX(域 33)和采样交互(域 18)的文章——jconsole 给你 MBean 树,perf 给你内核视角。
> 修订: 2026-08-11 v2——perf/FlameGraph 脚本标注待装(容器未装 perf);补 JMC 自带 MBean 浏览器
> 修订: 2026-08-11 v3——perf(yum 已装 6.6.119)/FlameGraph(/opt/tools/FlameGraph/)状态更新
> 修订: 2026-08-11 v4——补 JMC 自动分析 74 条规则素材(规则→事件→域链条)

### 1. "jconsole: JMX 的窗口" — MBean 浏览

场景: 所有 JMX 数据长什么样?jconsole 是标准窗口。

- 启动: `jconsole <pid>`(需 `-Dcom.sun.management.jmxremote` 或本机自动)
- 六面板: Overview/Memory/Threads/Classes/MBeans/VM Summary
- **MBeans 页**: 完整 MBean 树(`java.lang:type=Memory`/`Threading`/`GarbageCollector`...)— 域 33 的 JMX 接口清单实证
- **JMC 替代(✅ 已装)**: JMC 自带 **MBean 浏览器**(org.openjdk.jmc.console.ui.mbeanbrowser)——同树另一消费方,可与 jconsole 对照
- 与 Arthas 对照: Arthas `jvm` 命令(AR-4 篇 3)读的 8 个 MXBean 就是这棵树——**同一 JMX,两种消费**
- [Java: JMX = MBean 服务器 + 注册表(域 33);jconsole 是标准客户端]

关键设计: **MBean 树 = 域 33 的"目录"**: 写作域 33 时,jconsole 的 MBean 树(Threading: ThreadCount/PeakThreadCount/DaemonThreadCount...)是接口清单的实证——Arthas dashboard/JvmCommand(AR-4)的每行输出都能在树上找到出处。

### 2. "perf: 内核视角的采样" — 与 JFR 对照(✅ 已装: yum 6.6.119)

场景: JFR 是 JVM 内采样,perf 是内核采样——同一个 CPU 高,两种视角。

- `perf record -g -p <pid>` / `perf report`(火焰图可用 perf script + FlameGraph 脚本)
- 与 async-profiler 的关系: async-profiler 的 CPU 引擎就是 perf_event_open 的封装(AP-2 篇 2)——**工具之下还是工具**
- 差异: perf 看内核态(系统调用/中断)+ 用户态;JFR 看 JVM 事件(GC/编译/分配)——写作域 18 时: 采样与 safepoint 的交互(栈采样只发生在安全点,域 18 的 safepoint bias)
- [Linux: perf_event_open + mmap ring buffer(AP-2 篇 2 已学)——async-profiler 把内核能力封装成 JVM 采样器]

关键设计: **三层采样视角**: perf(内核)→ async-profiler(封装内核)→ JFR(JVM 内事件)——写作域 18/32 时,这个"层层封装"是理解采样架构的主线。

### 3. "FlameGraph 脚本: 火焰图原理" — 聚合语义(✅ 已装: /opt/tools/FlameGraph/)

场景: async-profiler 直接出 HTML,脚本版让你看到聚合过程。

- Brendan Gregg 的 `stackcollapse-perf.pl`(栈折叠)+ `flamegraph.pl`(绘图)——`/opt/tools/FlameGraph/`
- 手动跑一遍: `perf script` → stackcollapse → flamegraph → 打开 HTML——**"折叠+聚合"就是火焰图生成的本质**(与 async-profiler 的 Trie 树 AP-5 篇 1 同原理)
- **替代(✅ 已装)**: JMC 自带 Flame Graph 视图直接渲染 JFR 采样——先看 JMC 版,脚本版对照
- 写作素材: 火焰图语义(x 轴占比/y 轴栈深)在域 32 采样文章中的标准插图

关键设计: **亲手做一遍火焰图**: 脚本版暴露了"栈折叠"这一步(相同前缀合并)——async-profiler 的 Trie 树(AP-5 篇 1)就是它的 C++ 版。两个实现互相印证,是"聚合算法"主题的最佳教材。

### 4. "对照与写作素材"

- **JMX 双消费**: jconsole(官方)/Arthas dashboard(工具)——域 33 素材
- **采样三视角**: perf/async-profiler/JFR——域 18/32 素材
- **聚合双实现**: FlameGraph 脚本/async-profiler Trie——域 32 素材
- **v4 规则引擎素材**: JMC Automated Analysis = 74 条规则(services 实证,见 KP 06 节)——不是黑盒提示,每条规则背后是"规则→事件→域"链条(如 LongGcPause→GCPhasePause→域 25、BiasedLockingRevocation→BiasedLock*→域 19)——写作时可引用"JMC 用哪条规则盯哪个域"作为工具侧健康维度清单

生产注意: jconsole 远程需 JMX 认证配置(域 33 的安全);perf 需 root 或 perf_event_paranoid 放开(与 async-profiler 的 fdtransfer 对照,AP-1 篇 3)。

---

跨域桥: MXBean 树 = Arthas AR-4 篇 3;采样封装 = async-profiler AP-2 篇 2;火焰图聚合 = AP-5 篇 1;safepoint bias = 域 18;JMX = 域 33。
