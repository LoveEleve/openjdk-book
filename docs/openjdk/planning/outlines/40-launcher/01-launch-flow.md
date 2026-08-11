# 01. java MyApp 在命令行后发生了什么事？ — 启动流程

> 🔴 Deep | 1 KP 中的入口
> 读者处境: `java -cp myapp.jar MyMain` — 这个 `java` 命令本身是 C 程序。它加载 JVM→启动 Java 主类。读者会 JNI 调用但不一定理解 libjli→libjvm 的 dlopen 桥。

### 1. "三阶段 — parse→load→invoke"

场景: `java MyMain` 键入回车后——C 程序 `JLI_Launch` 首先解析参数(classpath/options/class)→找 JVM library→dlopen libjvm.so→JNI_CreateJavaVM→invoke main()。

**JLI_Launch 主流程** (`java.c:242-362`):
```
1. SelectVersion (java.c:295) — 检查 JRE 版本要求
2. CreateExecutionEnvironment (java_md_solinux.c:304-363) — 找 jrepath→读 jvm.cfg→选 server/client→jvmpath
3. LoadJavaVM (java_md_solinux.c:553-608) — dlopen(jvmpath)→dlsym JNI_CreateJavaVM
4. ParseArguments (java.c:1301-1520) — 解析 -cp/-jar/-m/--module→mode(LM_CLASS/LM_JAR/LM_MODULE)
5. JavaMain (java.c:413-578) — InitializeJVM→ifn->CreateJavaVM(即JNI_CreateJavaVM)→LoadMainClass→GetStaticMethodID("main")→CallStaticVoidMethod
[C++: java.c 2390 行纯 C，通过 JNI 桥(JNI_CreateJavaVM)连接 C++ HotSpot JVM]
[C++: InvocationFunctions 结构体(java.h)存放三个函数指针: CreateJavaVM/GetDefaultJavaVMInitArgs/GetCreatedJavaVMs]
```
- 源码: `java.c:242-362` (JLI_Launch) + `java_md_solinux.c:304-363` (CreateExecutionEnvironment) + `java_md_solinux.c:553-608` (LoadJavaVM)
- 关键设计: libjli 是**纯 C library**——Java 代码被执行前还没有可用的 JVM。libjli 通过 dlopen 动态加载 libjvm.so 而非静态链接——支持多 JVM 变体(server/client/minimal)从 jvm.cfg 选择。`InvocationFunctions` 结构体是纯 C 的函数指针表——不需要 C++ ABI 就能调用 JVM。

### 2. "三种启动模式 — class/jar/module"

场景: `java MyMain` vs `java -jar app.jar` vs `java -m mymodule/MyMain`——同一个 java 命令，ParseArguments 内发出。

**ParseArguments 模式分发** (`java.c:1301-1400`):
```
class:  java MyMain           → mode = LM_CLASS → FindClass(MyMain)
jar:    java -jar app.jar     → mode = LM_JAR  → parse META-INF/MANIFEST.MF→Main-Class
module: java -m mymodule/Main → mode = LM_MODULE → FindClass via module path
source: java --source 11 X.java → mode = LM_SOURCE → 单文件源码模式(JDK 11+)
```
- 源码: `java.c:1321-1360` (-jar → LM_JAR) + `java.c:1324-1333` (--module → LM_MODULE) + `java.c:1334-1344` (--source → LM_SOURCE)
- 关键设计: `mode` 是 `LM_UNKNOWN/LM_CLASS/LM_JAR/LM_MODULE/LM_SOURCE` 枚举——ParseArguments 中 `checkMode()` 确保用户不能同时指定两种模式（如 `-jar` + `-m` 会报错）。classpath wildcard 展开在 ParseArguments 之前——由 `JLI_WildcardExpandClasspath()` 在 JLI_Launch 入口完成。

---

### 核心悬念

**"JLI_Launch → CreateExecutionEnvironment(dlopen libjvm.so) → ParseArguments(三种模式) → JavaMain(JNI_CreateJavaVM→FindClass→main)——libjli 是 JVM 的纯 C 启动 stub。"** — 下一篇: 参数解析 + 平台 JVM 加载。

> → [02-args-platform.md](02-args-platform.md)
