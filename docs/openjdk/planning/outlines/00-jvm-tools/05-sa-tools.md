# 05. 钻到 JVM 肚子里看对象 — jhsdb 与 Serviceability Agent

> 🟢 工具域 | 工具: jhsdb(hsdb/clhsdb/jsnap) | 关联 JVM 域: 46-sa-postmortem、06-oops、09-memory、38-perfdata、19-sync
> 读者处境: 你要写 SA(域 46)和对象模型(域 06)的文章——jhsdb 能让你直接"看" Klass、对象头、堆布局。
> 修订: 2026-08-11 v3——补 jsnap(PerfData 域 38,含 sun.rt._sync_* 锁计数=域 19 实证)

### 1. "SA 是什么" — Serviceability Agent

场景: jmap/jstack 是"黑盒输出",SA 是"白盒查看"。

- **SA**(Serviceability Agent): 一组能**直接解析 JVM 内部数据结构**的 API/工具——对象头、Klass、符号表、堆布局
- `jhsdb hsdb <pid>`: GUI——Object Histogram/Inspect(看对象头: mark word + klass)/Stack Memory(栈)/Heap 浏览
- `jhsdb clhsdb <pid>`: 命令行版(SA 的调试器界面)
- 其他: `jhsdb jmap/jstack/jinfo`(SA 版,不依赖 attach API;`jmap --histo/--binaryheap`、`jstack --locks/--mixed`、`jinfo --flags/--sysprops`)
- **v3 新增 `jhsdb jsnap --all <pid>`**: 直接输出 PerfData 性能计数器(域 38)——实测含 `sun.rt._sync_Inflations/_sync_Parks` 等锁计数器(域 19 实证,与 async-profiler lockTracer AP-2 对照)
- [Java: SA 用 Java 实现,通过 /proc/pid/mem 读取目标进程内存(域 46)——"从外部读 JVM 内存"的技术]

关键设计: **SA = 写作域 06/46 的"显微镜"**: hsdb 的 Inspect 能展开对象头(mark word 的锁状态位、klass 指针)——域 06 的"对象布局"文章可以直接引用 SA 截图。async-profiler 的 vmStructs(AP-3 篇 3)和 SA 是**同一目标的两条路**: 都读 JVM 内部结构,SA 是官方工具,vmStructs 是运行时自解析。

### 2. "用 hsdb 看什么" — 三个探索任务

场景: 每个任务产出写作素材。

- **看对象头**: 找一个对象 Inspect → mark word(锁状态: biased/lightweight/heavyweight)+ klass 指针——域 06 素材
- **看堆布局**: Heap 浏览 → 老年代/新生代地址区间;`clhsdb` 的 `universe` 命令——域 09 素材
- **看类结构**: 按 Klass 地址查类 → 字段布局/父类——域 06/07 素材
- **看栈**: 线程栈帧(与 jstack 对照: SA 读内存 vs JVMTI 问 JVM)
- **v3 看 PerfData**: `jsnap --all` → `sun.rt._sync_*`/`sun.gc.*` 计数器——域 38 素材,锁计数器与 JMC LockInstancesPage 对照(域 19)

关键设计: **SA vs 其他工具的差异**: jmap 问"JVM 给我统计",SA 问"我直接读你的内存"——域 46 的核心就是这种"从外部读"的能力(含 crash 后的 core dump 分析,SA 也能读 core)。

### 3. "对照与写作素材"

- **三路读 JVM 内部**: SA(jhsdb)/vmStructs(async-profiler)/JVMTI(jcmd)——域 46/28 写作的对照框架
- **对象布局**: hsdb Inspect(官方视角)vs vmStructs 偏移(运行时自解析)——域 06 两种实证
- 写作素材: 域 46(SA 架构)、域 06(对象头截图)、域 09(堆布局)

生产注意: SA 读目标进程内存需同用户/权限;在线使用有干扰,crash 后读 core dump 是 SA 的杀手锏场景(域 46 主打)。

---

跨域桥: 内部结构解析 = async-profiler AP-3 篇 3(vmStructs);对象头 = 域 06;堆布局 = 域 09;core dump = 域 46;锁状态位 = 域 19(与 Arthas thread -b 对照)。
