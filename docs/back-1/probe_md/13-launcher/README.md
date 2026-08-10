# 13 — The Launcher (libjli.so)

> `bash$ java -jar app.jar` 开始之前，0.05 秒内发生的事情。

## §〇 上手指南

### 3-tier reading paths

| 层级 | 目标读者 | 阅读路径 |
|------|---------|---------|
| **入门** | 新手，"`java MyClass` 到底发生了什么？" | 直接读 §一 ASCII 流程图；然后 §五 面试题 1 |
| **进阶** | 熟悉 JVM 内部，想理解启动链 | 读完 §一，然后按顺序读 §二 的 5 个设计决策 |
| **专家** | 要 debug 实际问题或做定制化 | 读完全部，重点看 §六 生产场景 + §八 深层问题 |

### 前置知识

必须理解 [01-jvm-startup](../01-jvm-startup/README.md) §一 — 即 `JNI_CreateJavaVM()` 和 `Threads::create_vm()` 的关系。

**一句话本质：** `bash$ java Main` → libjli.so 的 `JLI_Launch()` → 解析参数 → 找到 libjvm.so → dlopen → 调用 `JNI_CreateJavaVM` → 加载 Main.class → 调用 `main()`。这约 0.05 秒是整个 01-12 讲的网关。

### 核心术语表

| 术语 | 定义 | 首次出现 |
|------|------|---------|
| **JLI** | Java Launcher Infrastructure，即 libjli.so | java.c:220 `JLI_Launch()` |
| **dlopen** | POSIX 系统调用，加载动态共享库到进程地址空间 | java_md_solinux.c:571 |
| **dlsym** | POSIX 系统调用，根据函数名字符串在动态库中找到函数地址 | java_md_solinux.c:624 |
| **/proc/self/exe** | Linux 内核提供的伪文件，符号链接到当前进程的可执行文件 | java_md_solinux.c:687-689 |
| **JavaVMInitArgs** | JNI 标准结构体，传给 `JNI_CreateJavaVM` 的参数集合 | java.c:1524 |
| **manifest** | JAR 文件中的 `META-INF/MANIFEST.MF`，含 Main-Class 等元信息 | manifest_info.h:169-175 |
| **classpath wildcard** | `cp foo/*.jar` 中的 `*`，在启动时展开为目录下所有 .jar | wildcard.c:27-86 |
| **InvocationFunctions** | 三个函数指针的结构体：CreateJavaVM、GetDefaultJavaVMInitArgs、GetCreatedJavaVMs | java.h:83-87 |
| **jvm.cfg** | JRE 配置文件，定义可用的 JVM 变种（-server、-client 等） | java.c:2039-2083 |
| **LaunchMode** | LM_CLASS(1)、LM_JAR(2)、LM_MODULE(3)、LM_SOURCE(4) | java.h:231-237 |

### 环境准备

```bash
# 编译 libjli（随 JDK 一起）
cd openjdk11 && make jdk

# 用 GDB 跟踪 java 命令的启动
gdb --args java -Xms8g -jar app.jar
(gdb) break JLI_Launch
(gdb) break LoadJavaVM
(gdb) run

# 查看 java 二进制和它所依赖的 .so
ldd $(which java)

# 查看 libjli.so 导出的符号
nm -D $JAVA_HOME/lib/jli/libjli.so | grep JLI
```

---

## §一 The `java` Command Lifecycle（验证过的流程图）

```
bash$ java -Xms8g -jar app.jar
 │
 ▼
┌────────────────────────────────────────────────────────────────┐
│ java.c:220  JLI_Launch(argc, argv, ...)                       │
│   签名:                                                        │
│   JNIEXPORT int JNICALL                                       │
│   JLI_Launch(int argc, char **argv, int jargc,                │
│              const char** jargv, int appclassc,               │
│              const char** appclassv, const char* fullversion, │
│              const char* dotversion, const char* pname,       │
│              const char* lname, jboolean javaargs,            │
│              jboolean cpwildcard, jboolean javaw, jint ergo)  │
│                                                               │
│   局部变量: int mode=LM_UNKNOWN, char *what=NULL              │
│            InvocationFunctions ifn (三个函数指针)               │
│            char jvmpath[MAXPATHLEN], jrepath[MAXPATHLEN]      │
└──────┬─────────────────────────────────────────────────────────┘
       │
       ▼ ① java.c:278  SelectVersion(argc, argv, &main_class)
       │   ┌─────────────────────────────────────────────────────┐
       │   │ 解析命令行参数中的 -jar 标记 (java.c:1114-1115)      │
       │   │ 如果是 JAR 文件，调用 JLI_ParseManifest()             │
       │   │   (parse_manifest.c:577)                             │
       │   │ 提取 META-INF/MANIFEST.MF 中的 Main-Class 属性       │
       │   │ (parse_manifest.c:616-617)                           │
       │   │ 失败时报告: JAR_ERROR2 "Unable to access jarfile %s" │
       │   │           (emessages.h:65)                           │
       │   │           JAR_ERROR3 "Invalid or corrupt jarfile %s" │
       │   │           (emessages.h:66)                           │
       │   └─────────────────────────────────────────────────────┘
       │
       ▼ ② java_md_solinux.c:304  CreateExecutionEnvironment()
       │   ┌─────────────────────────────────────────────────────┐
       │   │ a) java_md_solinux.c:325 SetExecname(*pargv)       │
       │   │    → 在 Linux 上读 /proc/self/exe (line 687-689):   │
       │   │      const char* self = "/proc/self/exe";           │
       │   │      len = readlink(self, buf, PATH_MAX);          │
       │   │    → 得到例如: .../jdk/bin/java                     │
       │   │                                                    │
       │   │ b) java_md_solinux.c:330 GetJREPath(jrepath,...)   │
       │   │    → GetApplicationHome() (java_md_common.c:74):   │
       │   │      TruncatePath() 找到最后一个 /bin/ 之后截断      │
       │   │      (java_md_common.c:56-58):                     │
       │   │        p = findLastPathComponent(buf, "/bin/");    │
       │   │        *p = '\0';                                  │
       │   │    → 得到 jrepath = .../jdk                         │
       │   │    → 验证 .../jdk/lib/libjava.so 存在 (line 532)   │
       │   │    → 失败输出 JRE_ERROR1 (emessages.h:91):         │
       │   │      "Error: Could not find Java SE Runtime        │
       │   │       Environment."                                 │
       │   │                                                    │
       │   │ c) java.c:2100  ReadKnownVMs(jvmcfg)               │
       │   │    → 读取 .../jdk/lib/jvm.cfg                       │
       │   │    → 解析 -server KNOWN / -client IGNORE 等行       │
       │   │    → 填充全局数组 knownVMs[] (java.c:166)           │
       │   │                                                    │
       │   │ d) java_md_solinux.c:351 GetJVMPath()              │
       │   │    → jrepath + "/lib/" + jvmtype + "/libjvm.so"    │
       │   │    → 例如: .../jdk/lib/server/libjvm.so            │
       │   │    → 用 stat() 验证文件存在 (line 504)              │
       │   │    → 失败输出 CFG_ERROR8 (emessages.h:88):         │
       │   │      "Error: missing '%s' JVM at '%s'."            │
       │   └─────────────────────────────────────────────────────┘
       │
       ▼ ③ java.c:300  LoadJavaVM(jvmpath, &ifn)
       │   ┌─────────────────────────────────────────────────────┐
       │   │ java_md_solinux.c:564-645                           │
       │   │                                                    │
       │   │ a) dlopen(jvmpath, RTLD_NOW + RTLD_GLOBAL)        │
       │   │    (line 571)                                      │
       │   │    RTLD_NOW:  立即解析所有未定义符号                 │
       │   │    RTLD_GLOBAL: 符号全局可见（供后续加载的 .so 使用）│
       │   │    失败输出 (line 618-619):                         │
       │   │      DLL_ERROR1 "Error: dl failure on line %d"     │
       │   │      DLL_ERROR2 "Error: failed %s, because %s"     │
       │   │                                                    │
       │   │ b) dlsym(libjvm, "JNI_CreateJavaVM") (line 624)   │
       │   │    → ifn->CreateJavaVM = (CreateJavaVM_t) result   │
       │   │    → 类型: jint (*)(JavaVM**, void**, void*)       │
       │   │      (java.h:79)                                   │
       │   │                                                    │
       │   │ c) dlsym(libjvm, "JNI_GetDefaultJavaVMInitArgs")  │
       │   │    (line 630)                                      │
       │   │                                                    │
       │   │ d) dlsym(libjvm, "JNI_GetCreatedJavaVMs")         │
       │   │    (line 637)                                      │
       │   └──────────────┬──────────────────────────────────────┘
       │                  │ 三个函数指针已填充到 ifn 中
       │                  │ ifn.CreateJavaVM = JNI_CreateJavaVM 的地址
       ▼
       │ ④ java.c:333  ParseArguments(&argc, &argv, &mode, &what, &ret, jrepath)
       │   ┌─────────────────────────────────────────────────────┐
       │   │ 遍历 argv，按 '-' 前缀分类 (java.c:1307)            │
       │   │                                                    │
       │   │ -jar      → mode = LM_JAR (line 1317-1319)        │
       │   │ -cp       → mode = LM_CLASS, SetClassPath(line 1347)│
       │   │            → 调用 JLI_WildcardExpandClasspath()     │
       │   │              (wildcard.c:303)                       │
       │   │              → opendir() + readdir() 展开 *.jar     │
       │   │ -m        → mode = LM_MODULE (line 1325)           │
       │   │ --source  → mode = LM_SOURCE (line 1333)           │
       │   │ --module  → mode = LM_MODULE (line 1320-1321)      │
       │   │ -Xms8g    → AddOption("-Xms8g", NULL) (line 977)   │
       │   │ -Dkey=val → AddOption("-Dkey=val", NULL) (line 1472)│
       │   │                                                    │
       │   │ 非 '-' 参数 → 停止解析，作为 what (类名/jar名)       │
       │   │ (line 1476-1477)                                   │
       │   │ 如果 mode 仍为 LM_UNKNOWN，默认 LM_CLASS (line 1491) │
       │   │                                                    │
       │   │ 所有 JVM 选项 → 全局数组 options[] (java.c:99)      │
       │   │ AddOption 若数组满则 ×2 扩容 (java.c:938-948)       │
       │   │ AddOption 同时解析 -Xss/-Xmx/-Xms 提取栈/堆大小      │
       │   │ -Xss → threadStackSize (line 954-966)              │
       │   │ -Xmx → maxHeapSize (line 969-974)                  │
       │   │ -Xms → initialHeapSize (line 976-981)              │
       │   └─────────────────────────────────────────────────────┘
       │
       ▼ ⑤ java.c:338  如果 mode == LM_JAR: SetClassPath(what)
       │  (JAR 文件名本身成为 classpath)
       │
       ▼ ⑥ java.c:344  SetJavaCommandLineProp(what, argc, argv)
       │    → 设置 -Dsun.java.command=app.jar arg1 arg2...
       │
       ▼ ⑦ java.c:348  SetJavaLauncherProp()
       │    → 设置 -Dsun.java.launcher=SUN_STANDARD
       │
       ▼ ⑧ java_md_solinux.c:820  SetJavaLauncherPlatformProps()
       │    → 设置 -Dsun.java.launcher.pid=<getpid()>
       │
       ▼ ⑨ java.c:354  JVMInit(&ifn, threadStackSize, argc, argv, mode, what, ret)
       │   ┌─────────────────────────────────────────────────────┐
       │   │ java_md_solinux.c:830-837                          │
       │   │ → ShowSplashScreen()                               │
       │   │ → ContinueInNewThread(ifn, ...)                    │
       │   │   (java.c:2338-2375)                               │
       │   │   → CallJavaMainInNewThread(stackSize, &args)      │
       │   │     (java_md_solinux.c:772-814)                    │
       │   │     → pthread_create(&tid, &attr, ThreadJavaMain,  │
       │   │                      args)  ──创建新线程             │
       │   │       (line 786)                                   │
       │   └─────────────────────────────────────────────────────┘
       │
       ▼ (在新线程中)
  java.c:405  JavaMain(void* _args)
       │
       ▼ Ⓐ java.c:428  InitializeJVM(&vm, &env, &ifn)
       │   ┌─────────────────────────────────────────────────────┐
       │   │ java.c:1522-1548                                   │
       │   │ 设置 JavaVMInitArgs:                                │
       │   │   args.version  = JNI_VERSION_1_2;                  │
       │   │   args.nOptions = numOptions;                       │
       │   │   args.options  = options;  ← 之前收集的所有JVM参数  │
       │   │   args.ignoreUnrecognized = JNI_FALSE;             │
       │   │                                                    │
       │   │ r = ifn->CreateJavaVM(pvm, (void**)penv, &args);  │
       │   │ (line 1545)                                        │
       │   │ ┃───────────────────────────────────────────────    │
       │   │ ┃ 🔴 从这一行开始，进入 01-jvm-startup §一           │
       │   │ ┃    即 JNI_CreateJavaVM() 内部                     │
       │   │ ┃    → Threads::create_vm()                        │
       │   │ ┃    → 类加载器初始化                                │
       │   │ ┃    → 系统类预加载                                  │
       │   │ ┃    → VM 完全就绪                                   │
       │   │ ┃───────────────────────────────────────────────    │
       │   │                                                    │
       │   │ 失败输出 JVM_ERROR1 (emessages.h:60):               │
       │   │   "Error: Could not create the Java Virtual        │
       │   │    Machine."                                        │
       │   └─────────────────────────────────────────────────────┘
       │
       ▼ ㊱ java.c:523  mainClass = LoadMainClass(env, mode, what)
       │   ┌─────────────────────────────────────────────────────┐
       │   │ java.c:1623-1650                                   │
       │   │ 调用 sun.launcher.LauncherHelper.checkAndLoadMain() │
       │   │ 传入 USE_STDERR, mode(1=CLASS/2=JAR), name          │
       │   │                                                    │
       │   │ 这是 JVM 生命周期中第一次 Java 类加载！               │
       │   │ LauncherHelper 内部会调用 FindClass(mainClassName)  │
       │   │   → 触发双亲委派 → 最终由 bootstrap loader 加载       │
       │   │                                                    │
       │   │ 失败输出 CLS_ERROR1 (emessages.h:68):               │
       │   │   "Error: Could not find the main class %s."        │
       │   └─────────────────────────────────────────────────────┘
       │
       ▼ ㊲ java.c:532  appClass = GetApplicationClass(env)
       │   (JavaFX 支持，非 JavaFX 则返回 mainClass)
       │
       ▼ ㊳ java.c:536  mainArgs = CreateApplicationArgs(env, argv, argc)
       │   → 将 char** 转为 Java String[]
       │
       ▼ ㊴ java.c:560  mainID = GetStaticMethodID(mainClass, "main", 
       │                                   "([Ljava/lang/String;)V")
       │   签名格式: "(" + args + ")" + return_type
       │       ( [Ljava/lang/String;  = String数组)  V = void
       │
       ▼ ㊵ java.c:566  CallStaticVoidMethod(env, mainClass, mainID, mainArgs)
       │
       │   ╔══════════════════════════════════════════════════════╗
       │   ║  🟢 从这里开始，正式进入 Java 世界                    ║
       │   ║      执行用户的 public static void main(String[] args)║
       │   ╚══════════════════════════════════════════════════════╝
       │
       ▼ ㊶ java.c:572  ret = (ExceptionOccurred == NULL) ? 0 : 1
       │   → 如果 main() 抛异常，返回非零
       │
       ▼ ㊷ java.c:374-380  LEAVE()
           → (*vm)->DetachCurrentThread(vm)
           → (*vm)->DestroyJavaVM(vm)
           → return ret
```

---

## §二 First-Principles 设计决策

### 1. 为什么用 dlopen() 而不是静态链接？

**如果自己从零设计：** libjvm.so 约 20MB。静态链接：每个 `java` 可执行文件 = 一次完整的 HotSpot 拷贝。动态链接：30KB 的 libjli.so + 20MB 共享库 → OS 在所有 JVM 进程间共享 libjvm.so 的物理内存页。

**libjli 的做法：** `LoadJavaVM()`（java_md_solinux.c:564-645）在运行时 dlopen libjvm.so，而不是在编译时链接。这样：
- 多个 JVM 进程共享同一份 libjvm.so 代码段 → 约 90% 内存节省
- 可以在运行时选择 -server 或 -client JVM（基于 jvm.cfg）
- libjli.so 本身只有 ~100KB，启动后即完成使命

### 2. 为什么用 /proc/self/exe 而不是 JAVA_HOME 环境变量？

**如果自己从零设计：** JAVA_HOME 是显式环境变量，用户必须正确设置。如果用户有多个 JDK（例如 JDK 8 和 JDK 11），JAVA_HOME 可能指向错误的版本。

**libjli 的做法：** `SetExecname()`（java_md_solinux.c:660-706）在 Linux 上读取 `/proc/self/exe`：
```c
// java_md_solinux.c:687-689
const char* self = "/proc/self/exe";
int len = readlink(self, buf, PATH_MAX);
```
这是内核提供的指向当前进程可执行文件绝对路径的符号链接。零配置，永远指向实际运行的 `java` 二进制，包括通过符号链接调用的情况。然后 `GetApplicationHome()` → `TruncatePath()` 向上走两级目录找到 JRE 根。

### 3. 为什么 JLI_Launch() 与 JavaMain() 分离，且在新线程中运行？

**如果自己从零设计：** 主线程直接初始化 JVM 并调用 main()，简单直接。

**libjli 的做法：** 
- `JLI_Launch()`（java.c:220-355）在原始线程中运行：设置路径、加载 libjvm、解析参数。
- `JVMInit()`（java_md_solinux.c:830-837）→ `ContinueInNewThread()`（java.c:2338-2375）→ `CallJavaMainInNewThread()`（java_md_solinux.c:772-814）创建一个新线程来执行 `JavaMain()`。

原因（java.c:202-204 注释）：
> Running Java code in primordial thread caused many problems. We will create a new thread to invoke JVM. See 6316197 for more information.

新线程的好处：
- 原始线程的栈可以在 JVM 热身后被回收
- pthread 属性可精确控制（栈大小、guard page 关闭 at line 784）
- 避免在 primordial 线程上运行 Java 代码的各种信号处理问题

### 4. 为什么 -Xms/-Xmx 在 libjli 和 libjvm 中都要解析？

**如果自己从零设计：** 只在 libjvm 中解析，libjli 只是透传字符串。

**libjli 的做法：** `AddOption()`（java.c:932-982）在将选项存入全局 options[] 数组的同时，也会解析 `-Xmx` 和 `-Xms` 的值：
```c
// java.c:969-981
if (JLI_StrCCmp(str, "-Xmx") == 0) {
    jlong tmp;
    if (parse_size(str + 4, &tmp)) maxHeapSize = tmp;
}
if (JLI_StrCCmp(str, "-Xms") == 0) {
    jlong tmp;
    if (parse_size(str + 4, &tmp)) initialHeapSize = tmp;
}
```
这些值之后传给 `ShowSettings()`（java.c:1912-1927）用于打印 VM 设置。libjli 做浅层解析（提取数值用于诊断输出），libjvm 做深层解析（实际分配堆内存）。

### 5. 为什么通过搜索 JRE 目录树来找 libjvm.so？

**如果自己从零设计：** 硬编码路径，比如 `/usr/lib/jvm/java-11/lib/server/libjvm.so`。

**libjli 的做法：** `GetJVMPath()`（java_md_solinux.c:490-511）动态组装路径：
```c
JLI_Snprintf(jvmpath, jvmpathsize, "%s/lib/%s/" JVM_DLL, jrepath, jvmtype);
```
其中 `jvmtype` 来自 jvm.cfg（通常是 `server`），`JVM_DLL` 是平台相关的库名（Linux 上是 `libjvm.so`，macOS 上是 `libjvm.dylib`）。这使同一套代码支持所有 POSIX 平台的路径约定。

### 6. 为什么 classpath 通配符在启动时展开而不是延迟到类加载时？

**libjli 的做法：** `JLI_WildcardExpandClasspath()`（wildcard.c:303-320）在 JVM 启动前就展开所有 `*.jar` 通配符：
```c
// wildcard.c:222-231 — 只匹配 .jar / .JAR
static int isJarFileName(const char *filename) {
    int len = (int)JLI_StrLen(filename);
    return (len >= 4) && (filename[len - 4] == '.') &&
           (equal(filename + len - 3, "jar") || equal(filename + len - 3, "JAR"));
}
```
然后把展开后的完整路径作为 `-Djava.class.path` 传给 JVM。好处：启动时一次性枚举，类加载器不需要知道通配符的存在 — 它看到的是解析好的完整路径。

---

## §三 源文件清单

| 文件 | 完整路径 | 行数 | 角色 |
|------|---------|:---:|------|
| **java.c** | `java.base/share/native/libjli/java.c` | 2415 | 核心：JLI_Launch、ParseArguments、JavaMain、InitializeJVM、LoadMainClass |
| **args.c** | `java.base/share/native/libjli/args.c` | 715 | @argfile 展开、JDK_JAVA_OPTIONS 环境变量 |
| **java_md_solinux.c** | `java.base/unix/native/libjli/java_md_solinux.c` | 879 | Linux/Solaris 平台：dlopen/dlsym、/proc/self/exe、JRE路径发现、新线程创建 |
| **java_md_common.c** | `java.base/unix/native/libjli/java_md_common.c` | 371 | Unix 通用：GetApplicationHome、TruncatePath、FindExecName |
| **parse_manifest.c** | `java.base/share/native/libjli/parse_manifest.c` | 722 | ZIP/JAR 解析：读取 META-INF/MANIFEST.MF、提取 Main-Class |
| **wildcard.c** | `java.base/share/native/libjli/wildcard.c` | 394 | classpath 通配符 `*` → 展开为目录下所有 .jar 文件 |
| **java.h** | `java.base/share/native/libjli/java.h` | 278 | 核心头文件：InvocationFunctions、LaunchMode、JavaMainArgs 定义 |
| **manifest_info.h** | `java.base/share/native/libjli/manifest_info.h` | 195 | manifest 数据结构和 ZIP 文件格式常量 |
| **emessages.h** | `java.base/share/native/libjli/emessages.h` | 123 | 所有错误消息字符串的宏定义 |

---

## §四 文档规划

### 推荐的 4 篇核心文档

| # | 文档名 | 核心问题 | 生产场景 |
|---|--------|---------|---------|
| 00 | **Libjli-Overview.md** | `java MyClass` 到 `JNI_CreateJavaVM` 的完整调用链 | 排查 "不能启动 JVM" 的所有可能根因 |
| 01 | **Argument-Parsing.md** | `ParseArguments()` 如何区分 JVM 选项、启动器选项和应用参数 | 为什么 `-Xms` 被识别但 `--my-app-flag` 被传给 main() |
| 02 | **JVM-Loading.md** | libjli 如何找到、加载并调用 libjvm.so | "Could not find libjvm.so" — 找 JRE 的全路径排查 |
| 03 | **Main-Class-Loading.md** | JAR manifest 解析 + LoadMainClass + main() 调用链 | "Could not find or load main class" 的 5 种根因 |

### 00 — Libjli-Overview.md 详细规格

- **核心 ❓**: 凌晨 3 点发布系统报 `Error: Could not create the Java Virtual Machine` → CI/CD 阻塞 → 你需要从 `JLI_Launch()` 源码定位：是 `dlopen(libjvm.so)` 失败，还是 `JNI_CreateJavaVM()` 返回错误？
- **生产场景**: 任何启动错误，先看 00 的流程图定位到具体阶段
- **源文件**:
  - `src/java.base/share/native/libjli/java.c` (JLI_Launch, LoadJavaVM, LoadMainClass)
  - `src/java.base/unix/native/libjli/java_md_solinux.c` (dlopen, dlsym, /proc/self/exe)
  - `src/java.base/unix/native/libjli/java_md_common.c` (GetExecName, TruncatePath)
- **前置条件**: 01-jvm-startup §一（理解 JNI_CreateJavaVM 的作用）
- **范围边界**: 
  - 包含：JLI_Launch → JavaMain → CallStaticVoidMethod
  - 不包含：JNI_CreateJavaVM 内部（那是 01 的范畴）
  - 不包含：系统类预加载（那是 02-class-loading 的范畴）
  - 不包含：模块系统初始化（那是 04 的范畴）

### 01 — Argument-Parsing.md 详细规格

- **核心 ❓**: 生产多版本 JDK 共存——`-XX:+UseZGC` 被识别为 JVM 选项但 JDK 11 不支持 ZGC → 应该早失败还是传给 JVM 让它失败？`ParseArguments()` 的分类逻辑是什么？
- **生产场景**: 参数传递错误、JVM 选项被吞掉、通配符不展开
- **源文件**:
  - `src/java.base/share/native/libjli/java.c` (ParseArguments, AddOption)
  - `src/java.base/share/native/libjli/args.c`
  - `src/java.base/share/native/libjli/wildcard.c`
- **前置条件**: 00、理解 argv/argc 的传统 C 约定

### 02 — JVM-Loading.md 详细规格

- **核心 ❓**: 运维脚本设了 `JAVA_HOME=/opt/jdk17`，但同事在 shell 中设了 `JAVA_HOME=/opt/jdk11`——`java` 命令到底加载了哪个 JDK 的 `libjvm.so`？从 `/proc/self/exe` 到 `dlopen` 的完整路径定位机制是什么？
- **生产场景**: JDK 损坏、JAVA_HOME 错、多版本冲突
- **源文件**:
  - `src/java.base/unix/native/libjli/java_md_solinux.c` (SetExecname, CreateExecutionEnvironment, LoadJavaVM, GetJREPath, GetJVMPath)
  - `src/java.base/unix/native/libjli/java_md_common.c` (GetApplicationHome, TruncatePath)
  - `src/java.base/share/native/libjli/java.c` (ReadKnownVMs, CheckJvmType)
- **前置条件**: 00、理解 POSIX dlopen/dlsym API

### 03 — Main-Class-Loading.md 详细规格

- **核心 ❓**: JAR manifest → Main-Class → FindClass → GetStaticMethodID → CallStaticVoidMethod
- **生产场景**: "Could not find or load main class"、"No main method found"、manifest 损坏
- **源文件**:
  - `src/java.base/share/native/libjli/parse_manifest.c` (JLI_ParseManifest, find_file, inflate_file)
  - `src/java.base/share/native/libjli/manifest_info.h` (manifest 数据结构和 ZIP 文件格式常量)
  - `src/java.base/share/native/libjli/java.c` (SelectVersion, LoadMainClass, JavaMain)
- **前置条件**: 00、02-class-loading（类加载器机制）

---

## §五 面试问题

| 问题 | 对应文档 | 答案（基于验证过的源码） |
|------|---------|----------------------|
| **Q1**: "`java MyClass` 和 `main()` 之间发生了什么？" | 00 | 分两段。第一段是 libjli（~0.05s）：`JLI_Launch()` 解析你的命令行 → 分离 `-Xms8g`（JVM 标志）和 `app.jar`（你的应用）→ 通过 `/proc/self/exe` 找到 JRE 安装路径 → `dlopen(libjvm.so)` → `dlsym("JNI_CreateJavaVM")` → 调用。第二段是 libjvm（~2s）：`JNI_CreateJavaVM()` 内部，[01-jvm-startup §一] 详细解释——创建堆、加载 Object 类、启动编译线程。最后 libjli 重新接管：`LoadMainClass()` → `FindClass(mainClassName)` → `CallStaticVoidMethod()` → 进入 `main()`。两段总计约 2.05 秒，libjli 占 2% 时间但 100% 的启动错误信息。<br><br>```mermaid<br>sequenceDiagram<br>    participant bash as bash<br>    participant libjli as libjli.so (13)<br>    participant libjvm as libjvm.so (01)<br>    participant app as app.main()<br>    bash->>libjli: JLI_Launch(argc, argv)<br>    libjli->>libjli: ParseArguments()<br>    libjli->>libjli: /proc/self/exe → JRE root<br>    libjli->>libjvm: dlopen(libjvm.so)<br>    libjli->>libjvm: JNI_CreateJavaVM(args)<br>    Note over libjvm: 建堆 加载 Object 启动编译线程 (~2s)<br>    libjvm-->>libjli: return 0<br>    libjli->>app: CallStaticVoidMethod(main)<br>``` |
| **Q2**: "java 是如何找到 libjvm.so 的？" | 02 | 因为没有 JAVA_HOME 环境变量 `java` 也能启动。秘密是 `/proc/self/exe`——Linux 内核为每个进程提供的符号链接，指向实际的可执行文件。libjli 从它出发向上遍历目录找 `lib/libjava.so` → 确认这是 JRE → 拼出 `lib/<arch>/server/libjvm.so` 路径 → `stat()` 验证文件存在 → `dlopen()` 加载。<br><br>源码：java_md_solinux.c:687-689 `readlink("/proc/self/exe")` → java_md_common.c:87 `TruncatePath()` 找到最后一个 `/bin/` 截断 → java_md_solinux.c:523 `GetApplicationHome()` → java_md_solinux.c:532 验证 `lib/libjava.so` → java.c:2100 `ReadKnownVMs()` 读 jvm.cfg → java_md_solinux.c:499 拼路径 → java_md_solinux.c:504 `stat()`. |
| **Q3**: "`-jar` 和 `-cp` 的执行路径有什么不同？" | 01 | java.c:1317-1319 `-jar` → mode = LM_JAR，what = jar 文件名；java.c:1341-1347 `-cp` → mode = LM_CLASS，SetClassPath(value)。关键差异：java.c:338-340，如果是 LM_JAR，`SetClassPath(what)` 将 JAR 文件本身设为 classpath，覆盖命令行 classpath。另外，java.c:1114-1115，`-jar` 标志触发 `SelectVersion()` 中的 manifest 解析。 |
| **Q4**: "classpath 通配符 `*` 是何时展开的？" | 01 | `opendir` 枚举 1000 个 JAR 需要 ~2ms——这就是大 classpath 启动慢的根因之一。这也是 Java 9+ 模块系统的动机——不再需要通配符展开就能找到所有模块。<br><br>展开在启动时，不在类加载时。`ParseArguments()` → `SetClassPath()` (java.c:997) 调用 `JLI_WildcardExpandClasspath()` (wildcard.c:303)。wildcard.c:177 用 `opendir()` + `readdir()` 枚举目录，wildcard.c:222-231 `isJarFileName()` 只匹配 `.jar` / `.JAR` 结尾的文件。展开后的完整路径 → `-Djava.class.path=` 传给 JVM。注意：manifest 中的 `Class-Path` 属性不支持通配符（wildcard.c:70-71）。 |
| **Q5**: "为什么 libjli 要在新线程中启动 JVM？" | 00 | java.c:202-204 注释说明："Running Java code in primordial thread caused many problems." java_md_solinux.c:786 `pthread_create(&tid, &attr, ThreadJavaMain, args)` 创建新线程。原因：(1) primordal 线程的栈可能被 JVM 热身后不可预测地覆盖；(2) 可以设置自定义栈大小（java_md_solinux.c:781-783 `pthread_attr_setstacksize`）；(3) 可以关闭 pthread guard page（line 784），避免浪费内存。 |
| **Q6**: "`LoadMainClass()` 到底怎么加载主类的？" | 03 | java.c:1623-1650。它不直接调用 `FindClass()`。而是通过 JNI 调用 Java 层 helper：`sun.launcher.LauncherHelper.checkAndLoadMain()` (line 1634-1640)。这个方法接收 `USE_STDERR`、`mode`（1=CLASS/2=JAR/3=MODULE/4=SOURCE）、和类名/JAR名。Helper 内部：(1) 如果是 JAR，读 manifest 的 Main-Class；(2) 调用 `FindClass(mainClassName)`，这触发双亲委派；(3) 验证 main 方法存在 |

---

## §六 生产场景

| 场景 | 症状（源码中的精确错误字符串） | 对应文档 | 诊断步骤 |
|------|------------------------------|---------|---------|
| **libjvm.so 找不到** | `Error: could not find libjava.so` (emessages.h:98, java_md_solinux.c:559) 或 `Error: missing 'server' JVM at '...'` (emessages.h:88, java_md_solinux.c:352) | 02 | (1) `readlink -f /proc/self/exe` 确认 bin 位置；(2) 向上找 `lib/libjava.so` 是否存在；(3) 找 `lib/server/libjvm.so` 是否存在；(4) 检查 jvm.cfg 是否损坏 |
| **主类找不到** | `Error: Could not find the main class %s.` (emessages.h:68, CLS_ERROR1) | 03 | (1) 检查 classpath 是否包含主类（`-cp` 或 CLASSPATH）；(2) 检查类名是否带 package（`com.example.Main`）；(3) 检查 .class 文件的目录结构是否匹配包名；(4) 如果是 -jar，检查 META-INF/MANIFEST.MF 中 Main-Class 属性；(5) 检查 manifest 中的 Class-Path 属性 |
| **JAR manifest 损坏** | `Error: Unable to access jarfile %s` (emessages.h:65, JAR_ERROR2) 或 `Error: Invalid or corrupt jarfile %s` (emessages.h:66, JAR_ERROR3) | 03 | parse_manifest.c:577 `JLI_ParseManifest()` 流程：(1) 打开 JAR 文件 (line 588) → 失败=JAR_ERROR2；(2) `find_file()` 在 ZIP 目录中找 `META-INF/MANIFEST.MF` (line 603) → 失败=JAR_ERROR3；(3) `inflate_file()` 解压 (line 607) → 失败=JAR_ERROR3；(4) `parse_nv_pair()` 提取属性 (line 613) |
| **JNI_CreateJavaVM 失败** | `Error: Could not create the Java Virtual Machine.` + `Error: A fatal exception has occurred. Program will exit.` (emessages.h:60, JVM_ERROR1) | 00 | java.c:1545 `ifn->CreateJavaVM()` 返回非 JNI_OK → JVM_ERROR1。诊断命令：<br>1. `ulimit -v` — 检查虚拟内存限制是否小于请求的堆大小<br>2. `ldd $(dirname $(readlink -f /proc/self/exe))/../lib/jli/libjli.so` — 检查 libjli 的依赖是否完整<br>3. `java -Xlog:modules=debug -version 2>&1 \| grep ERROR` — 检查模块系统加载错误<br>4. `strace -e openat java -Xms128m -jar app.jar 2>&1 \| grep ENOENT` — 找出缺失的文件 |
| **JVM 类型别名循环** | `Error: Corrupt jvm.cfg file; cycle in alias list.` (emessages.h:81, CFG_ERROR1) | 02 | java.c:770-777，`CheckJvmType()` 解析别名链时，如果 loopCount 超过 knownVMsCount，报告 CFG_ERROR1 |

---

## §七 质量审计矩阵

| 文档 | 状态 | 预期行数 | 源码覆盖 | 深度 | 可操作性 |
|------|:----:|:------:|:------:|:----:|:------:|
| 00-Libjli-Overview.md | 计划 | 400+ | java.c 全量, java_md_solinux.c 关键路径 | ★★★★★ | ★★★★★ |
| 01-Argument-Parsing.md | 计划 | 300+ | java.c ParseArguments, args.c, wildcard.c | ★★★★☆ | ★★★★★ |
| 02-JVM-Loading.md | 计划 | 350+ | java_md_solinux.c, java_md_common.c | ★★★★★ | ★★★★☆ |
| 03-Main-Class-Loading.md | 计划 | 250+ | parse_manifest.c, java.c SelectVersion/LoadMainClass | ★★★★☆ | ★★★★☆ |

---

## §八 深层问题（12题，5层难度）

### Tier 1 — 入门

1. **如果你设计 Java 启动器，你会用 dlopen 还是静态链接？你的选择对多 JVM 部署有什么影响？**
   答：dlopen 更好。libjvm.so ~20MB。静态链接 = 每个 java 进程 20MB。dlopen = 30KB libjli + OS 页面共享 20MB → 多 JVM 部署内存节省约 90%。

2. **`/proc/self/exe` 是什么？如果 `java` 是一个 shell 脚本而不是二进制文件，`/proc/self/exe` 会指向什么？**
   `/proc/self/exe` 是 Linux 内核为每个进程提供的符号链接，指向当前执行中的可执行文件。如果 `java` 是 shell 脚本，`/proc/self/exe` 会指向 `/bin/bash`（脚本解释器），而非脚本文件本身。这就是为什么 libjli 必需是 C 二进制（java_md_solinux.c:687-689）。

### Tier 2 — 理解

3. **为什么 libjli 要在 `JNI_CreateJavaVM` 之前解析 `-Xms`？JVM 反正自己也会再解析一次。**
   java.c:976-981，libjli 解析 `-Xms` 提取 `initialHeapSize` 用于 `ShowSettings()` 输出。libjli 做浅层解析（提取值），libjvm 做深层解析（实际分配）。两层解析 = fail fast + 正确执行。

4. **`SetJavaCommandLineProp()` 设置的 `-Dsun.java.command` 属性有什么用？**
   java.c:1833-1877。这个伪属性不会被导出到 Java 层，而是被 HotSpot VM 内部用于将类名和参数存储到 instrumentation 内存区域。它是一个侧信道，让 VM 在不经过 Java 层的情况下获取启动命令。

### Tier 3 — 分析

5. **如果你要调试 "Could not find or load main class"，从 `JLI_Launch` 到 `FindClass` 之间，每一步可能出错的环节是什么？**
   - SelectVersion（java.c:278）：JAR 文件无法打开 → JAR_ERROR2
   - ParseArguments（java.c:333）：模式错误或参数解析失败
   - SetClassPath（java.c:338-340）：JAR 路径无效
   - InitializeJVM（java.c:428）：`JNI_CreateJavaVM` 失败 → JVM_ERROR1
   - LoadMainClass（java.c:523）：LauncherHelper.checkAndLoadMain() 返回 null → CHECK_EXCEPTION_NULL_LEAVE → JNI_ERROR

6. **`RTLD_NOW + RTLD_GLOBAL` 在 dlopen 中意味着什么？**
   java_md_solinux.c:571。`RTLD_NOW`：加载时立即解析所有未定义符号（而非懒解析），失败立即返回 — fail fast 策略；`RTLD_GLOBAL`：libjvm.so 的符号对所有后续 dlopen 的库可见，这在 JVM 启动后加载 native 代理库（如 instrument agent）时至关重要。

### Tier 4 — 设计

7. **如果你要实现一个自定义 JVM（例如 GraalVM 的 launcher 替换 libjvm.so 为 libgraalvm.so），libjli 中需要改动什么？**
   - 最简单：改 `JVM_DLL` 宏（java_md_solinux.c:41）或 jvm.cfg 中添加新的 VM 类型
   - 中等：修改 `GetJVMPath()`（java_md_solinux.c:490-511）添加新的搜索逻辑
   - 根本：自定义 libjli 实现（符合 JNI 规范，提供 `JLI_Launch()` 入口）
   - 注意：`dlsym()` 搜索的三个符号名（`JNI_CreateJavaVM`、`JNI_GetDefaultJavaVMInitArgs`、`JNI_GetCreatedJavaVMs`）是 JNI 规范定义的，任何 JVM 实现都必须导出

8. **jvm.cfg 的设计意图是什么？为什么它快要被废弃了？**
   java.c:2039-2083 的注释说明了语法和语义。jvm.cfg 允许在一个 JRE 安装中安装多个 JVM 库（如 -server 和 -client），用于节省空间和测试便利。但在 JDK 9+ 中，client VM 已被移除，只剩下 server VM，所以 jvm.cfg 的灵活性变得多余。注释明确说明 "the mechanism will be removed in the future"（java.c:2037-2038）。

### Tier 5 — 专家

9. **为什么 libjli 从 JAR 中读取 manifest 后，又在 Java 层的 LauncherHelper 中再次读取？**
   java.c:498-521 的注释解释了原因：# bugid 5030265。C 代码中的 manifest 解析不处理 UTF-8 编码的类名。在 `ParseManifest()` 提取的 `main_class` 被放到环境变量 `_JAVA_VERSION_SET` 中（java.c:1206-1208），然后 `LoadMainClass()` 忽略这个值，调用 Java 层的 `LauncherHelper.checkAndLoadMain()` 重新解析，获得正确的 UTF-8 处理。

10. **如果你在两个不同的 JRE 安装中各有一个 `java` 命令，如何确保 `java` 命令加载的是自己安装的 libjvm.so？**
    libjli 的设计就是为此。它通过 `/proc/self/exe` 定位实际执行的二进制文件（java_md_solinux.c:687-689），然后向上走找到 JRE 根目录（java_md_common.c:56-58 TruncatePath），然后加载同目录树下的 libjvm.so（java_md_solinux.c:499）。即使用户用绝对路径调用了另一个 JDK 的 `java`，libjli 也会加载那个 JDK 的 libjvm.so，而不是 JAVA_HOME 指向的那个。

11. **libjli 解析 `-Xss` 后，设置了 `threadStackSize`。这个值的下限是多少？**
    java.c:212-214: `#define STACK_SIZE_MINIMUM (64 * KB)`。在 `AddOption()` 中（java.c:954-966），如果解析出的值小于 `STACK_SIZE_MINIMUM`，则强制设为 `STACK_SIZE_MINIMUM`。这么做的目的是确保 JVM 启动代码有足够的栈空间来检查用户指定的栈大小是否合理，避免在检查之前就栈溢出。

12. **如果 `pthread_create` 失败（比如系统资源耗尽），libjli 会怎么处理？**
    java_md_solinux.c:786-798。如果 `pthread_create` 失败，launcher 会退回到当前线程中调用 `JavaMain(args)`。注释（line 791-795）说："Continue execution in current thread if for some reason (e.g. out of memory/LWP) a new thread can't be created. This will likely fail later in JavaMain as JNI_CreateJavaVM needs to create quite a few new threads, anyway, just give it a try.."

---

## §九 跨阶段连接

| 阶段 | 连接关系 |
|------|---------|
| **01-jvm-startup §一** | java.c:1545 `ifn->CreateJavaVM()` = 01 的 §一 入口 `JNI_CreateJavaVM()` → 同一个调用以 Threads::create_vm() 开始 |
| **02-class-loading** | java.c:523 `LoadMainClass()` `→` FindClass(mainClassName) — 这是 JVM 生命周期中**第一个 Java 类加载**；02 的类加载器体系中，这个调用走双亲委派 |
| **04-system-preload** | java.c:1545 JNI_CreateJavaVM 内部 → SystemDictionary::initialize() → 系统类预加载（Object, String, Class...），这在 LoadMainClass 之前 |
| **14-zip-jimage** | java.c:1114 `-jar` → SelectVersion → JLI_ParseManifest → parse_manifest.c 的 ZIP 解析器；14 处理实际的 JAR/ZIP 文件读取和 jimage 格式 |
| **18-agent-instrument** | 启动参数 `-javaagent:agent.jar` 在 ParseArguments 中转为 JVM option，传递给 JNI_CreateJavaVM，在 VM 初始化阶段由 instrument agent 机制处理 |
| **16-nio-network** | JNI_CreateJavaVM 初始化后，系统类预加载包括 java.nio 通道和网络库 — 这是在用户 main() 之前完成的 |

---

## §十 关键源码索引

### JLI_Launch 完整调用路径（纯函数名 → 文件:行号）

```
main()                            (java_md_*.c, 调用入口)
  └─ JLI_Launch()                 java.c:220
       ├─ InitLauncher()           java_md_common.c:330
       ├─ SelectVersion()          java.c:1056
       │    └─ JLI_ParseManifest() parse_manifest.c:577
       ├─ CreateExecutionEnvironment() java_md_solinux.c:303
       │    ├─ SetExecname()       java_md_solinux.c:660
       │    │    └─ readlink("/proc/self/exe")  java_md_solinux.c:689
       │    ├─ GetJREPath()        java_md_solinux.c:516
       │    │    └─ GetApplicationHome()  java_md_common.c:74
       │    │         └─ GetExecName()     java_md_solinux.c:166
       │    │         └─ TruncatePath()    java_md_common.c:50
       │    ├─ ReadKnownVMs()      java.c:2084
       │    ├─ CheckJvmType()      java.c:677
       │    └─ GetJVMPath()        java_md_solinux.c:490
       ├─ SetJvmEnvironment()      java.c:822
       ├─ LoadJavaVM()             java_md_solinux.c:564
       │    ├─ dlopen()            java_md_solinux.c:571
       │    └─ dlsym("JNI_CreateJavaVM")  java_md_solinux.c:624
       ├─ ParseArguments()         java.c:1296
       │    ├─ SetClassPath()      java.c:985
       │    │    └─ JLI_WildcardExpandClasspath()  wildcard.c:303
       │    └─ AddOption()         java.c:932
       ├─ SetJavaCommandLineProp() java.c:1833
       ├─ SetJavaLauncherProp()    java.c:1883
       ├─ SetJavaLauncherPlatformProps() java_md_solinux.c:820
       └─ JVMInit()                java_md_solinux.c:830
            └─ ContinueInNewThread() java.c:2338
                 └─ CallJavaMainInNewThread() java_md_solinux.c:772
                      └─ pthread_create()     java_md_solinux.c:786
                           └─ (新线程) JavaMain()  java.c:405
                                ├─ InitializeJVM() java.c:1522
                                │    └─ ifn->CreateJavaVM()  java.c:1545
                                │         ═══ 进入 01-jvm-startup §一 ═══
                                ├─ LoadMainClass()   java.c:1623
                                │    └─ LauncherHelper.checkAndLoadMain()
                                ├─ GetApplicationClass() java.c:1652
                                ├─ CreateApplicationArgs() java_md_common.c:368
                                ├─ GetStaticMethodID(..., "main", ...) java.c:560
                                ├─ CallStaticVoidMethod(...) java.c:566
                                │    ═══ 进入用户 Java 代码 ═══
                                └─ LEAVE() → DestroyJavaVM  java.c:370-380
```

---

**文档版本**: v1.0 — 所有行号和错误字符串均基于 `/data/workspace/openjdk-cut-new/src/` 的实际源码验证。
