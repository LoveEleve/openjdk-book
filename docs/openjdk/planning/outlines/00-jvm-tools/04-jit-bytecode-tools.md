# 04. 代码在 JVM 里怎么被加工 — JITWatch 与 javap

> 🟢 工具域 | 工具: JITWatch(✅ 已装)/javap | 关联 JVM 域: 13-jit、14-c1、15-c2、44-verification
> 读者处境: 你要写 JIT 编译器(域 13-15)的文章——先让 JITWatch 把"编译/内联"摊开,再让 javap 给你看字节码原貌。
> 修订: 2026-08-11 v2——JITWatch 标注待装(本机未装,需下载 jar + hsdis);编译日志先用 JDK 自带 LogCompilation 文本分析兜底

### 1. "javap: 字节码的第一现场" — 反汇编

场景: 一段 Java 代码,编译后长什么样?

- `javap -c -p ClassName`: 指令级反汇编(每个方法的字节码指令流)
- `javap -v ClassName`: 完整视图(常量池/行号表/StackMapTable/局部变量表)
- 对应: async-profiler BytecodeRewriter 改写的就是这个结构(AP-3 篇 2)——**改前改后对照 javap -v 是最好教材**
- [Java: 字节码是"紧凑指令流"(域 44 的验证对象);javap 是最直接的查看器]

关键设计: **字节码 = 文章的实证基础**: 域 44(验证)和域 08(解释器)写作时,`javap -v` 的输出(常量池/StackMapTable)是标准引用素材——async-profiler 的 rewriteStackMapTable(AP-3 篇 2)就是"插入指令后重算这张表"的活例子。

### 2. "JITWatch: 编译器在干什么" — 编译/内联可视化(✅ 已装: /opt/tools/jitwatch-ui.jar)

场景: javap 是"编译前",JITWatch 是"编译后"。

- 启用日志: `-XX:+UnlockDiagnosticVMOptions -XX:+LogCompilation -XX:+PrintAssembly`(PrintAssembly 需 hsdis)
- JITWatch 导入 `hotspot.log` → 看:
  - **Compilations**: 哪些方法被编译(C1/C2/层数/耗时)——域 13 素材
  - **Inlining**: 内联决策树(`inline`/`too big`/`hot method`)——**域 15 C2 内联的实证**
  - **Code Cache**: 代码缓存使用——域 16 素材
  - **Bytecode vs Assembly**: 源码→字节码→机器码对照(装了 hsdis 时)
- **v2 兜底(本机已有)**: JITWatch 装好前,直接文本分析 `hotspot.log`(`-XX:+LogCompilation` 生成)也能提取编译/内联决策;JFR 的 `jdk.Compilation`/`jdk.CompilerPhase` 事件是零依赖替代
- 与 async-profiler 对照: 火焰图的 `[inlined]` 帧(AP-3 篇 3 的 walkVM scope 展开)与 JITWatch 的内联树是**同一事实的两种视图**

关键设计: **内联是 JIT 的灵魂**: 火焰图的 `[inlined]` 帧和 JITWatch 的 inline 树互相印证——写作域 15 时,内联决策(方法大小/调用频次/热路径)是核心主题,两个工具各提供一半证据。

### 3. "对照与写作素材"

- **三视角看一个方法**: 源码 → javap 字节码 → JITWatch 机器码
- **两工具看内联**: JITWatch(编译决策)+ async-profiler(运行结果)
- 写作素材: 域 13-15 文章的"编译日志样例"来源;域 44 的"StackMapTable 样例"

生产注意: `-XX:+LogCompilation` 有开销(写日志),本地探索用;生产用 JFR 的编译事件(域 32)替代。

---

跨域桥: 字节码改写 = async-profiler AP-3 篇 2;内联帧 = AP-3 篇 3;代码缓存 = 域 16;编译日志 = 域 13/15 写作素材。
