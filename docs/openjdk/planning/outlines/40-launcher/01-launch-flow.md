# 01. java MyApp 在命令行后发生了什么事？— 启动流程

> 🔴 Deep | 1 KP 中的入口
> 读者处境: `java -cp myapp.jar MyMain` — 这个 `java` 命令本身是 C 程序。它加载 JVM→启动 Java 主类。

### 1. "三阶段 — parse→load→invoke"

场景: java 命令首先解析参数(classpath/options/class)→找 JVM library(dlopen libjvm.so)→call JNI_CreateJavaVM→invoke main()。

**主流程** (`libjli/java.c:200-1000 + unix/java_md_solinux.c:40-400`):
```
1. JLI_Launch(args)
   → ParseArguments: classpath, memory, module-path, main class
   → CreateExecutionEnvironment: find jvm.cfg→select variant(server/client)
   → LoadJavaVM: dlopen(libjvm.so)→dlsym(JNI_CreateJavaVM)→CreateJavaVM
   → InvokeMain: JNI→find main class→getStaticMethodID("main")→CallStaticVoidMethod
```
- 源码: `libjli/java.c:200-1000` + `unix/libjli/java_md_solinux.c:40-400`
- 关键设计: libjli 是纯 C library——Java 代码在被之前的库(JNI)还没有可用的 JVM。不是 Java→不是 C++——是纯 C 的启动 stub。libjli 通过 dlopen 动态加载 libjvm.so——支持多 JVM 变体(server/client/minimal)

### 2. "三种启动模式"

```
class: java MyMain
jar:   java -jar app.jar  → 解析 META-INF/MANIFEST.MF→Main-Class
module: java -m mymodule/MyMain → 解析 --module-path
```
- 源码: `libjli/java.c:600-1200`

---

### 核心悬念

**"JLI_Launch→ParseArguments→LoadJavaVM(dlopen)→InvokeMain(JNI)——java 命令的三阶段启动。"** — 下一篇: 参数解析。

> → [02-args-wildcard.md](02-args-wildcard.md)
