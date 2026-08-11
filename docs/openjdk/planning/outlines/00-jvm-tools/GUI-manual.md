# 卷 T GUI 截图操作手册(Ubuntu 桌面执行)

> 2026-08-11 | 用途: 在 Ubuntu 桌面环境手工补 8 项 GUI 截图,补齐后交给写作会话引用
> 依据: `00-jvm-tools-execution-plan.md` 附录 G(本文件为独立可执行版)
> 说明: 本环境(容器/Xvfb)无法高效操作 GUI,命令行素材已全部采集完毕;这 8 项截图是**配图增强**,不阻塞写作(每项都有命令行替代素材)。

---

## 〇、环境准备(一次,约 5 分钟)

1. **JDK 21 LTS**(必须): JMC 9.1.2 实测需要 JDK 17+,17 会 UnsupportedClassVersionError。装好后把 JMC 的 jmc.ini 里 `-vm` 指到它:
   ```
   /opt/jmc/jmc-9.1.2_linux-x64/'JDK Mission Control'/jmc.ini
   -vm
   /path/to/jdk21/bin/java
   ```
2. **中文字体**: `sudo apt install fonts-noto-cjk`(防止乱码方块)
3. **Wayland 会话问题**: 若 Java 窗口位置/层级异常,登录时选 "Ubuntu on Xorg",或 `export _JAVA_AWT_WM_NONREPARENTING=1`
4. **工具清单**: JMC 9.1.2、MAT、JITWatch(jitwatch-ui.jar)、JDK 自带 jhsdb/jconsole —— 都直接双击/命令行启动,无需任何虚拟显示技巧
5. **采样目标**: 用 `/data/tmp/opencode/Demo.java`(三个线程: CPU 忙循环 + 疯狂分配,寿命 600 秒)或任意自建多线程程序

---

## 截图命名与交付规范

- 命名: `NN-tool-topic.png`(如 `01-jmc-wizard.png`、`03-mat-histogram.png`)
- 产出后**统一放入**: `openjdk-book/docs/openjdk/planning/outlines/00-jvm-tools/materials/screenshots/`
- 每张在 `materials/INDEX.md` 的 screenshots 表加一行(域|文件|说明|日期)
- 完成后告诉我,写作时会引用

---

## G1 — JMC 录制向导(截图 ×1:`01-jmc-wizard.png`)

**干什么**: 展示 JFR 三种开启方式中的 GUI 向导(前两种 jcmd/-XX 已在 ch01 有命令行素材)。
**步骤**:
1. `jcmd <pid> ManagementAgent.start_local` 开启 JMX 本地代理
2. 打开 JMC,左侧 JVM Browser **双击**目标 JVM(或 File → Connect 输入 `host:7091`)
3. 右键该 JVM → **Start Flight Recording…**(录制向导)
4. 向导页: 选配置模板(Continuous/Profiling)→ 时长(如 30s)→ 文件名 → Finish
5. 在向导弹出时截图;录完右键 → **Save to file**

---

## G2 — JMC 实时控制台(截图 ×1:`01-jmc-console.png`)

**干什么**: 展示 JMC 连接运行中 JVM 的实时监控(CPU/堆/线程曲线),域 33 JMX 素材。
**步骤**:
1. 目标 JVM 启动参数加(或仅本机调试用 `jcmd <pid> ManagementAgent.start_local`):
   ```
   -Dcom.sun.management.jmxremote -Dcom.sun.management.jmxremote.port=7091 \
   -Dcom.sun.management.jmxremote.authenticate=false -Dcom.sun.management.jmxremote.ssl=false
   ```
2. JMC → JVM Browser 双击进程(本地自动发现);远程 File → Connect 输入 `host:7091`
3. 自动打开 **Overview** 页签,等 CPU/堆曲线动起来后截图

---

## G3 — MAT 四视图(截图 ×4:`03-mat-overview/histogram/dominator/leak.png`)

**干什么**: 展示 MAT 核心四视图(域 37/06)。文本版已跑通(ParseHeapDump),GUI 版补视觉。
**步骤**:
1. 拿 heap dump: `jcmd <pid> GC.heap_dump /path/heap.hprof`(或 `jmap -dump:format=b,file=heap.hprof <pid>`)
2. 启动 MAT: `$MAT_HOME/MemoryAnalyzer`(JDK 17+;新版需 21)
3. File → Open Heap Dump → 选 heap.hprof(首次打开有向导,点 Finish)
4. 依次打开并截图: ① **Overview**(概览页)② **Histogram**(工具条按钮,类×对象数×Shallow/Retained)③ **Dominator Tree**(工具条按钮,最大保留对象链)④ **Leak Suspects Report**(工具条最右,一键泄漏报告)
5. 建议用 Demo 的 dump,Leak Suspects 会命中 `Demo$AllocTask.run()` 的 ArrayList(与 ch03 正文对照)

---

## G4 — JITWatch 导入(截图 ×2:`04-jitwatch-compilations.png` / `04-jitwatch-inlining.png`)

**干什么**: 可视化 JIT: Compilations 页 + Inlining 页(域 13/15/16)。
**步骤**:
1. 生成日志: 目标程序加 `-XX:+UnlockDiagnosticVMOptions -XX:+LogCompilation` 跑 1-2 分钟 → hotspot.log
2. 启动: `java -jar jitwatch-ui.jar`(JDK 17+)
3. **必须先配 Sandbox**: Config → Sandbox → 选 JDK 目录(不配则编译视图为空)
4. 点 **Open Log** 选 hotspot.log,等解析完成
5. View → Compilations 截图;View → Inlining 截图

---

## G5 — hsdb 对象头 Inspect(截图 ×1:`05-hsdb-inspect.png`)

**干什么**: SA 可视化看对象布局: mark word/klass 指针/字段(域 06,对象头是书的重要素材)。
**步骤**:
1. 目标进程运行中: `jhsdb hsdb --pid <pid>`(崩溃转储用 `--core <core> --exe <java>`)
2. 菜单 **Tools → Object Histogram** → 找 Demo 的类(如 `Demo$BusyTask`)→ 双击某对象 → 弹 **Inspect** 窗口
3. 截图 Inspect 窗口(mark word 8 字节、klass 指针、字段值都在)
4. 参考: ch05 正文已展示 clhsdb 版(InstanceKlass 464 字节),GUI 版补"对象实例"视角

---

## G6 — hsdb 堆/类/栈(截图 ×3:`05-hsdb-histogram.png` / `05-hsdb-universe.png` / `05-hsdb-threads.png`)

**干什么**: hsdb 三视图(域 09/07/24),文本版已由 clhsdb 覆盖。
**步骤**:
1. `jhsdb hsdb --pid <pid>`
2. Tools → **Object Histogram** 截图(类级统计)
3. Windows → Console 输入 `universe` 截图(G1 分区)
4. Tools → **Threads** 截图(线程栈列表)

---

## G7 — jconsole 六面板(截图 ×2:`06-jconsole-memory.png` / `06-jconsole-mbean.png`)

**干什么**: JDK 自带经典监控(域 33),数据面已用 JMXDump 采集,补 GUI 视觉。
**步骤**:
1. 目标 JVM 开 JMX(同 G2)或本机直接 `jconsole <pid>`(本地进程自动列出)
2. 截图 **Memory** 页签(堆/非堆曲线)+ **MBeans** 页签(树,展开 `java.lang:Memory / Threading / GarbageCollector`)
3. Overview/Threads/Classes/VM Summary 按需补

---

## G8 — JMC MBean 浏览器(截图 ×1:`06-jmc-mbean.png`)

**干什么**: JMC 的 MBean Browser 与 jconsole 对照(域 33),A5 已导 26 MBean 文本树。
**步骤**:
1. JMC 连接目标 JVM(同 G2)
2. **Window → Show View → MBean Browser**(或右键 JVM → MBean Browser)
3. 展开 `java.lang:Memory / Threading / GarbageCollector` 等节点,截图

---

## 完成清单(共 14 张)

| # | 截图 | 对应文章 |
|---|---|---|
| G1 | 01-jmc-wizard.png | ch01 三种触发方式 |
| G2 | 01-jmc-console.png | ch01 实时连接 |
| G3 | 03-mat-*.png ×4 | ch03 MAT 四板斧 |
| G4 | 04-jitwatch-*.png ×2 | ch04 JITWatch |
| G5 | 05-hsdb-inspect.png | ch05 对象头 |
| G6 | 05-hsdb-*.png ×3 | ch05 三视图 |
| G7 | 06-jconsole-*.png ×2 | ch06 jconsole |
| G8 | 06-jmc-mbean.png | ch06 MBean 浏览器 |

做完后: 截图放进 `materials/screenshots/`,INDEX.md 登记,并告诉我一声——写作时会把它们补进对应文章(替换文字说明或作配图)。
