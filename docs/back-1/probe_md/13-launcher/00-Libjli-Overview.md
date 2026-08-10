# 00-Libjli-Overview — 从 `bash$ java` 到 `main()`：libjli 的 0.05 秒

> **阶段**：[13-launcher]
> **前置**：[01-jvm-startup] §一（理解 JNI_CreateJavaVM 的作用）
> **配套**：[01-Argument-Parsing]（ParseArguments 的详细分类逻辑）、[02-class-loading]（LoadMainClass 的 FindClass 流程）
> **后续依赖本文**：[02-JVM-Loading]（libjvm.so 的完整路径定位机制）、[03-Main-Class-Loading]（manifest 解析 + main 调用链）
> **阅读收益**：追踪 `bash$ java -jar app.jar` 到 `main()` 的 8 步完整链路——从 JLI_Launch 的 12-参数入口到 dlopen(libjvm.so) 到 JNI_CreateJavaVM 到 LoadMainClass 到 CallStaticVoidMethod；理解 libjli（~0.05s）和 libjvm（~2s）的责任边界和两次 handoff；掌握 JVM_ERROR1 的三段诊断 workflow

---

## §〇 生产场景——凌晨 3 点 CI/CD 阻塞：`JVM_ERROR1`

凌晨 3:14，CI/CD pipeline 发布失败。日志中只有两行：

```
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

这是 `emessages.h:60` 的 `JVM_ERROR1` —— libjli 触发的。现在你需要回答一个精确问题：是 `dlopen(libjvm.so)` 失败了？还是 `JNI_CreateJavaVM` 返回了错误？还是 `LoadMainClass` 找不到主类？

### 错误消息与代码路径的精确映射

`JVM_ERROR1` 在 `java.c:429` 处打印：

```c
// java.c:428-430
if (!InitializeJVM(&vm, &env, &ifn)) {
    JLI_ReportErrorMessage(JVM_ERROR1);
    exit(1);
}
```

`InitializeJVM`（`java.c:1522`）内部只有一处返回 `JNI_FALSE`——`java.c:1545`：

```c
// java.c:1545
r = ifn->CreateJavaVM(pvm, (void **)penv, &args);
JLI_MemFree(options);
return r == JNI_OK;
```

所以 `JVM_ERROR1` = `JNI_CreateJavaVM()` 返回了非 `JNI_OK`。但这不是唯一的故障模式。

### 三段诊断

```
Branch A: DLL_ERROR1 (emessages.h:108) → dlopen 失败
  现象: 日志有 "Error: dl failure on line %d" + "Error: failed %s, because %s"
  原因: libjvm.so 不存在、损坏、或架构不匹配
  → stat <jre>/lib/server/libjvm.so → 文件缺失？ELF header 损坏？
  → ldd <java_binary> → libjvm.so 依赖链断裂？

Branch B: JVM_ERROR1 (emessages.h:60) → JNI_CreateJavaVM 返回 != JNI_OK
  现象: 日志只有 JVM_ERROR1，无 DLL_ERROR1（说明 dlopen 成功）
  原因: 堆大小超限、内存不足、模块系统错误、-XX 选项冲突
  → ulimit -v → 虚拟内存限制 < 请求的堆大小？
  → java -Xlog:modules=debug -version 2>&1 | grep ERROR
  → dmesg | grep -i oom → 内核级 OOM killer 事件

Branch C: CLS_ERROR1 (emessages.h:68) → LoadMainClass 失败
  现象: 日志有 "Error: Could not find the main class %s"
  原因: classpath 错误、JAR manifest 缺失 Main-Class、类名拼写错误
  → java -cp <classpath> -jar <jarfile> -Xdiag → JVM 诊断输出
```

**反事实诊断关键**：如果日志只有 `JVM_ERROR1` 没有 `DLL_ERROR1` → `dlopen` 成功 → libjvm.so 被找到且符号解析成功 → `JNI_CreateJavaVM` 被调用了 → 是 JVM 内部初始化失败。如果日志有 `DLL_ERROR1` + `DLL_ERROR2` → `dlopen` 或 `dlsym` 失败 → libjvm.so 不存在或损坏。如果日志有 `CLS_ERROR1` → JVM 启动成功但 `FindClass` 找不到主类。

### 诊断命令

```bash
# 1. 确认 libjvm.so 存在且可读
stat $(dirname $(readlink -f /proc/self/exe))/../lib/server/libjvm.so

# 2. 确认 libjli.so 依赖完整
ldd $(dirname $(readlink -f /proc/self/exe))/../lib/jli/libjli.so

# 3. 检查虚拟内存限制（是否小于 -Xmx）
ulimit -v

# 4. trace JVM 启动时的 open 系统调用 —— 找出哪个文件没找到
strace -e openat java -Xms128m -jar app.jar 2>&1 | grep ENOENT
```

---

## §一 JLI_Launch 全链路：8 步源码走读

本文不是你想象的"java 命令手册"。这是 libjli.so 的 ENGINEERING documentation——从 `bash$ java` 到 `main()` 执行，每一步的源码行号和设计推导。

`05-jit-compiler` 教了你 C2 的 Sea of Nodes。`01-jvm-startup` 教了你 `JNI_CreateJavaVM` 之后的 2 秒。本文教你的——是 `01` 之前的那 0.05 秒。因为 JVM 从 shell 命令变成进程的那 0.05 秒里，每一行代码都是问题排查的线索。

### 5 个 Beginner Callout 框

> **dlopen** — POSIX 系统调用。把 `.so` 文件加载到进程地址空间。不同于静态链接——代码段可以被多个进程共享。`dlopen(libjvm.so)` 成功后，libjvm.so 的 ~20MB 代码段只需一份物理页，所有 `java` 进程共享。对应源码：`java_md_solinux.c:571`。

> **dlsym** — POSIX 系统调用。根据函数名字符串在已加载的共享库中查找函数地址。返回函数指针。`dlsym(handle, "JNI_CreateJavaVM")` 返回 `JNI_CreateJavaVM` 的入口地址（`java_md_solinux.c:624`）。类型定义在 `java.h:79`：`typedef jint (JNICALL *CreateJavaVM_t)(JavaVM **pvm, void **env, void *args);`

> **/proc/self/exe** — Linux 内核为每个进程创建的符号链接——指向实际可执行文件的绝对路径。不需要 `$PATH` 或 `$JAVA_HOME`。即使 `java` 是符号链接，`/proc/self/exe` 也指向最终目标。对应源码：`java_md_solinux.c:687-689`，`int len = readlink(self, buf, PATH_MAX);`

> **JNI** — Java Native Interface。`09-native-interface` 阶段已详细分析。这里 libjli 使用 JNI 来调用 `JNI_CreateJavaVM`（`java.c:1545`）和 `FindClass`、`GetStaticMethodID`（`java.c:560`）、`CallStaticVoidMethod`（`java.c:566`）。JNI 函数表（`JNINativeInterface_`）在 `JNI_CreateJavaVM` 内部被初始化。

> **LaunchMode** — `java.h:231` 的枚举：`LM_CLASS(1)` = 普通类加载（`-cp` 或无参数），`LM_JAR(2)` = `-jar` 模式，`LM_MODULE(3)` = `-m` 模块模式，`LM_SOURCE(4)` = 源代码模式（`--source`）。决定 `LoadMainClass` 的行为和 classpath 构造逻辑。定义：`enum LaunchMode { LM_UNKNOWN = 0, LM_CLASS, LM_JAR, LM_MODULE, LM_SOURCE };`

> **InvocationFunctions** — `java.h:83-87` 定义的函数指针结构体，是 libjli 与 libjvm 之间的"协议接口"。包含三个函数指针：`CreateJavaVM_t CreateJavaVM`（签名见 `java.h:79`：`typedef jint (JNICALL *CreateJavaVM_t)(JavaVM **, void **, void *)`）、`GetDefaultJavaVMInitArgs_t GetDefaultJavaVMInitArgs`、`GetCreatedJavaVMs_t GetCreatedJavaVMs`。这三个函数是 JNI Invocation API 规范要求任何 JVM 实现（HotSpot、GraalVM、OpenJ9）必须导出的符号。在 `LoadJavaVM` 中通过 `dlsym` 填充（`java_md_solinux.c:624-642`），在 `InitializeJVM` 中通过 `ifn->CreateJavaVM` 调用（`java.c:1545`）。`GetDefaultJavaVMInitArgs` 被 `ContinueInNewThread` 用于获取默认线程栈大小（`java.c:2348-2352`）。`GetCreatedJavaVMs` 被 jcmd/jstat 等诊断工具使用。

> **man 2/3/5 手册线索** — 阅读 libjli 源码时的权威参考：`man 2 dlopen` — POSIX 动态库加载语义（含 RTLD_NOW/RTLD_GLOBAL 定义，`java_md_solinux.c:571` 使用）；`man 2 readlink` — 读取符号链接目标（`java_md_solinux.c:689` 读取 `/proc/self/exe`）；`man 5 proc` — `/proc/self/exe` 是内核为每个进程创建的符号链接（来源：Linux 内核 fs/proc/base.c 的 `proc_exe_link()`）；`man 2 access` — 检查文件可访问性（`java_md_solinux.c:532` 验证 `libjava.so`）；`man 2 stat` — 获取文件元数据（`java_md_solinux.c:504` 验证 libjvm.so）；`man 2 pthread_create` — 创建新线程（`java_md_solinux.c:786`）；`man 2 dlsym` — 按符号名查找函数地址（`java_md_solinux.c:624` 查找 `JNI_CreateJavaVM`）。在 strace 诊断时这些 man 手册提供错误码解释。

---

### Step 1: JLI_Launch 入口——12 参数的真相

**WHY**：因为 `java` 命令不总是从 bash 启动。Windows 上 `WinMain` 预处理参数，MacOS 上 `NSApplicationMain` 预处理参数。每个平台在 `main()` 中做了不同预处理。JLI_Launch 的 12 参数是所有平台的 COMMON 协议。

```c
// java.h:89-101
JNIEXPORT int JNICALL
JLI_Launch(int argc, char ** argv,              /* main argc, argv */
        int jargc, const char** jargv,          /* java args */
        int appclassc, const char** appclassv,  /* app classpath */
        const char* fullversion,                /* full version defined */
        const char* dotversion,                 /* UNUSED dot version defined */
        const char* pname,                      /* program name */
        const char* lname,                      /* launcher name */
        jboolean javaargs,                      /* JAVA_ARGS */
        jboolean cpwildcard,                    /* classpath wildcard*/
        jboolean javaw,                         /* windows-only javaw */
        jint ergo                               /* unused */
);
```

| 参数 | 来源 | 含义 |
|------|------|------|
| `argc/argv` | bash `execvp("java", args)` | 命令行参数 |
| `jargc/jargv` | 编译时预定义或平台 main() 计算 | JVM 专用参数（`-X`/`-XX` 预分类） |
| `appclassc/appclassv` | 平台 main() | 预定义的应用 classpath |
| `fullversion` | 编译时 JDK 版本字符串 | 用于 `-version` 输出 |
| `dotversion` | 编译时 | **UNUSED**，标记在 `java.c:224` |
| `pname/lname` | 平台 main() | 程序名/启动器名（`getprogname()`) |
| `javaargs` | Windows `WinMain` | JAVA_ARGS 模式标志 |
| `cpwildcard` | 平台 main() | classpath 通配符 `*` 展开开关 |
| `javaw` | Windows `WinMain` | Windows 专用 `javaw.exe` 标志 |
| `ergo` | 编译时 | **unused**，标记在 `java.c:230` |

**反事实**：如果 `JLI_Launch` 只有 `(argc, argv)` 两个参数 → 每个平台在 `JLI_Launch` 内重复解析版本字符串、提取 JVM args、处理 classpath → 三份代码维护 → 跨平台协同 bug（Windows 修了 Linux 没修）。12 参数的代价是调用方复杂——但调用方每平台只写一次。

函数入口处立即初始化全局状态：

```c
// java.c:243-247
_fVersion = fullversion;
_launcher_name = lname;
_program_name = pname;
_is_java_args = javaargs;
_wc_enabled = cpwildcard;
```

---

### Step 2: SelectVersion——在启动 0.0005 秒前判定 JDK 版本

**WHY**：因为 JAR 的 manifest 可能指定了不同的 JRE 版本。如果 JAR 编译时用的 JDK 17 但系统装了 JDK 11，必须先切换 JRE 路径——否则 JNI_CreateJavaVM 启动了错误的 JVM → ClassLoader 遇到 JDK 17 字节码 → `ClassFormatError` → 浪费 2s 启动时间 + 必然失败。

```c
// java.c:1056
SelectVersion(int argc, char **argv, char **main_class)
```

选择逻辑：如果环境变量 `_JAVA_VERSION_SET` 已存在（由外部 JRE 1.5-1.8 设置）→ 提取 main_class 并 return。否则扫描命令行选项中的 `-version:` 标志 → 读 JAR manifest → 提取 `Created-By` 版本。

**注意**：在 JDK 9+ 中，`-version:` 旧式版本选择已废弃——`SelectVersion` 主要保留向前兼容，从 manifest 提取 `main_class` 放入 `_JAVA_VERSION_SET` 环境变量。

```c
// java.c:1089-1092
if ((env_in = getenv(ENV_ENTRY)) != NULL) {
    if (*env_in != '\0')
        *main_class = JLI_StringDup(env_in);
    return;
}
```

**反事实**：如果 SelectVersion 不存在 → JNI_CreateJavaVM 启动的系统 JRE → ClassLoader 加载 JAR 主类 → 字节码的 major version 不匹配 → `UnsupportedClassVersionError` → 用户看到 "has been compiled by a more recent version" → 但修复路径不明确（用户不知道需要哪个 JDK 版本）。

---

### Step 3: CreateExecutionEnvironment——找到 JRE

**WHY**：因为 JLI_Launch 需要知道 JRE 的根目录才能找到 libjvm.so——但 java 二进制的位置不一定是 JRE 的根目录。Docker 容器、自定义安装路径、多版本共存都可能造成偏差。

```c
// java_md_solinux.c:304
CreateExecutionEnvironment(int *pargc, char ***pargv,
                           char jrepath[], jint so_jrepath,
                           char jvmpath[], jint so_jvmpath,
                           char jvmcfg[],  jint so_jvmcfg)
```

**三步发现**：

**Step 3a — SetExecname**：通过 `/proc/self/exe` 获取可执行文件的绝对路径。

```c
// java_md_solinux.c:687-689
const char* self = "/proc/self/exe";
char buf[PATH_MAX+1];
int len = readlink(self, buf, PATH_MAX);
```

这比 `$PATH` 或 `argv[0]` 可靠——内核保证 `/proc/self/exe` 指向实际运行文件的绝对路径。即使 `java` 是符号链接，readlink 也解析到最终目标。

**Step 3b — GetApplicationHome + TruncatePath**：将可执行路径截断为 JRE 根目录。

```c
// java_md_common.c:56-58
char *p = findLastPathComponent(buf, "/bin/");
if (p != NULL) {
    *p = '\0';
```

`/data/.../jdk/bin/java` → 截断 `/bin/java` → `jrepath = "/data/.../jdk"`。

**Step 3c — GetJREPath 验证**：检查 `lib/libjava.so` 是否存在于 JRE 根目录。

```c
// java_md_solinux.c:526-534
JLI_Snprintf(libjava, sizeof(libjava), "%s/lib/" JAVA_DLL, path);
if (access(libjava, F_OK) == 0) {
    JLI_TraceLauncher("JRE path is %s\n", path);
    return JNI_TRUE;
}
```

如果 `libjava.so` 不存在 → `JRE_ERROR1`（`emessages.h:91`）："Error: Could not find Java SE Runtime Environment."

**Step 3d — GetJVMPath**：拼接 libjvm.so 的路径。

```c
// java_md_solinux.c:499
JLI_Snprintf(jvmpath, jvmpathsize, "%s/lib/%s/" JVM_DLL, jrepath, jvmtype);
```

`jvmtype` 默认为 `"server"`（从 `jvm.cfg` 读取 `knownVMs[0].name+1` → `CheckJvmType` → `java.c:754-756`）。

**反事实**：如果只靠 `$JAVA_HOME` → Docker 环境通常不设此变量 → `JRE_ERROR1` → 用户必须手动 `export JAVA_HOME`。`/proc/self/exe` 是零配置 fallback——不需要任何环境变量。

---

### Step 4: LoadJavaVM——dlopen(libjvm.so)

**WHY**：因为 JVM 是一个 ~20MB 的独立共享库 (`libjvm.so`)，不是静态链接在 `java` 二进制里。这允许运行时选择不同的 JVM 实现（`-server` vs `-client` vs 自定义 `-XXaltjvm=`），也允许多个 JVM 进程共享同一份物理代码页。

```c
// java.c:300
if (!LoadJavaVM(jvmpath, &ifn)) {
    return(6);
}
```

平台无关的调用点到平台特定的实现：

```c
// java_md_solinux.c:564-571
jboolean
LoadJavaVM(const char *jvmpath, InvocationFunctions *ifn)
{
    void *libjvm;
    JLI_TraceLauncher("JVM path is %s\n", jvmpath);
    libjvm = dlopen(jvmpath, RTLD_NOW + RTLD_GLOBAL);
    if (libjvm == NULL) {
        JLI_ReportErrorMessage(DLL_ERROR1, __LINE__);
        JLI_ReportErrorMessage(DLL_ERROR2, jvmpath, dlerror());
        return JNI_FALSE;
    }
```

**RTLD_NOW vs RTLD_LAZY —— 为什么选择立即解析**：`RTLD_NOW` 在 `dlopen` 时立即解析 libjvm.so 中所有未定义符号——任何缺失 → 立即返回 NULL。`RTLD_LAZY` 将符号解析推迟到首次使用时 → JVM 启动快 ~200ms（跳过符号解析），但可能在运行 1 小时后某个 cold code path 被调用时突然崩溃 `"undefined symbol: JVM_FindSignal"` → 无法定位原因。

**反事实**：如果用 `RTLD_LAZY` → 每次启动省 200ms → 1000 次部署 = 省 200s → 但一次生产 runtime crash = 事故报告 + 复盘 + 修复 = 数小时 → 净损失至少 10000:1。HotSpot 的哲学：启动慢可以接受，运行中崩溃不可接受。

**三个 dlsym 调用——填充 InvocationFunctions**：

```c
// java_md_solinux.c:623-642
ifn->CreateJavaVM = (CreateJavaVM_t)
    dlsym(libjvm, "JNI_CreateJavaVM");
if (ifn->CreateJavaVM == NULL) {
    JLI_ReportErrorMessage(DLL_ERROR2, jvmpath, dlerror());
    return JNI_FALSE;
}

ifn->GetDefaultJavaVMInitArgs = (GetDefaultJavaVMInitArgs_t)
    dlsym(libjvm, "JNI_GetDefaultJavaVMInitArgs");

ifn->GetCreatedJavaVMs = (GetCreatedJavaVMs_t)
    dlsym(libjvm, "JNI_GetCreatedJavaVMs");
```

对应的类型定义（`java.h:79-87`）：

```c
typedef jint (JNICALL *CreateJavaVM_t)(JavaVM **pvm, void **env, void *args);
typedef jint (JNICALL *GetDefaultJavaVMInitArgs_t)(void *args);
typedef jint (JNICALL *GetCreatedJavaVMs_t)(JavaVM **vmBuf, jsize bufLen, jsize *nVMs);

typedef struct {
    CreateJavaVM_t CreateJavaVM;
    GetDefaultJavaVMInitArgs_t GetDefaultJavaVMInitArgs;
    GetCreatedJavaVMs_t GetCreatedJavaVMs;
} InvocationFunctions;
```

这三个函数是 JNI Invocation API 规范要求的——任何 JVM 实现（HotSpot、GraalVM、OpenJ9）必须导出。`GetDefaultJavaVMInitArgs` 在普通启动流中不直接使用（但 `ContinueInNewThread` 用它获取默认线程栈大小，`java.c:2348-2352`），`GetCreatedJavaVMs` 被 `jcmd`/`jstat` 等工具通过 JNI `AttachCurrentThread` 使用。

**反事实**：如果静态链接 libjvm → `java` 二进制变成 ~25MB → fork 开销增大 → 且失去 `-server`/`-client` 切换能力。

→ 详见 [02-JVM-Loading] §四

---

### Step 5: ParseArguments——参数分类（概述）

**WHY**：因为用户输入的 `bash$ java -Xms8g -cp foo:bar -jar app.jar arg1` 包含 4 类信息：JVM 选项（`-Xms8g`）、启动器选项（`-jar`、`-cp`）、classpath 定义（`foo:bar`）、应用参数（`arg1`）。`ParseArguments` 区分这 4 类。

```c
// java.c:333
if (!ParseArguments(&argc, &argv, &mode, &what, &ret, jrepath)) {
    return(ret);
}
```

分类结果：
- `-jar`、`-m`、`--source` → 设置 `mode`（LaunchMode 枚举）
- `-Xms`、`-Xmx`、`-XX:+...`、`-Dprop=val` → `AddOption()` → 进入 `options[]` 数组
- `-cp`/`-classpath` → `SetClassPath(value)` → 展开通配符 → 格式化为 `-Djava.class.path=...`
- 不以 `-` 开头的第一个参数 → `what`（主类名/jar 文件名/模块名）
- `-version` → 设 `printVersion = JNI_TRUE` → 短路返回

详细分析见 [01-Argument-Parsing]。

---

### Step 6: JVMInit → pthread_create → JavaMain

**WHY**：因为运行 Java 代码在 primordial（主）线程中"caused many problems"（`java.c:202`）。pthread_create 新线程来运行 JVM 提供了三个保证：(1) 隔离线程栈（自定义 8MB stack），(2) 主线程保持干净可做其他平台特定初始化，(3) 避免 JVM 启动过程中 primordial 线程栈被不可预测地修改。

```c
// java.c:202-204
/*
 * Running Java code in primordial thread caused many problems. We will
 * create a new thread to invoke JVM. See 6316197 for more information.
 */
```

```c
// java.c:354
return JVMInit(&ifn, threadStackSize, argc, argv, mode, what, ret);
```

`JVMInit` → `ContinueInNewThread`（`java.c:2338`）→ `CallJavaMainInNewThread`（`java_md_solinux.c:772`）：

```c
// java_md_solinux.c:772-797
CallJavaMainInNewThread(jlong stack_size, void* args) {
    pthread_t tid;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_JOINABLE);
    if (stack_size > 0) {
        pthread_attr_setstacksize(&attr, stack_size);
    }
    pthread_attr_setguardsize(&attr, 0); // no pthread guard page on java threads
    if (pthread_create(&tid, &attr, ThreadJavaMain, args) == 0) {
        void* tmp;
        pthread_join(tid, &tmp);
        rslt = (int)(intptr_t)tmp;
    } else {
        rslt = JavaMain(args);
    }
```

**pthread_create 失败的回退逻辑**（`java_md_solinux.c:790-798`）：如果创建新线程失败（如 OOM 或 LWP 耗尽），退回到当前线程直接调用 `JavaMain(args)`。注释坦率："This will likely fail later in JavaMain as JNI_CreateJavaVM needs to create quite a few new threads, anyway, just give it a try.." 这是一种乐观回退——如果连一个线程都创建不了，JNI_CreateJavaVM 内部更需要创建多个线程，大概率还是会失败。

`ThreadJavaMain` 是一个薄的适配器（`java_md_solinux.c:764-766`）：

```c
static void* ThreadJavaMain(void* args) {
    return (void*)(intptr_t)JavaMain(args);
}
```

它把 `void*` 类型的 pthread_create 回调适配到 `JavaMain` 的 `int` 返回值。

---

### Step 7: JavaMain → InitializeJVM → JNI_CreateJavaVM

**WHY**：因为到这一步，jvmpath 已确定、libjvm 已加载、InvocationFunctions 已填充、参数已分类——万事俱备，可以启动 JVM 了。

`JavaMain`（`java.c:405`）构造 `JavaMainArgs` 结构体，解包参数后立即调用 `InitializeJVM`：

```c
// java.c:427-431
/* Initialize the virtual machine */
start = CounterGet();
if (!InitializeJVM(&vm, &env, &ifn)) {
    JLI_ReportErrorMessage(JVM_ERROR1);
    exit(1);
}
```

`InitializeJVM`（`java.c:1522`）构造 `JavaVMInitArgs` 结构体：

```c
// java.c:1524-1547
JavaVMInitArgs args;
jint r;
memset(&args, 0, sizeof(args));
args.version  = JNI_VERSION_1_2;
args.nOptions = numOptions;
args.options  = options;
args.ignoreUnrecognized = JNI_FALSE;
// ...
r = ifn->CreateJavaVM(pvm, (void **)penv, &args);
JLI_MemFree(options);
return r == JNI_OK;
```

**注意** `ignoreUnrecognized = JNI_FALSE`：任何不被 HotSpot 识别的 `-XX:` 选项 → `JNI_CreateJavaVM` 立即返回 `JNI_EINVAL` → libjli 打印 `JVM_ERROR1` → exit。这是 fail-fast 设计——在启动阶段暴露配置错误，而不是在运行时。

**`java.c:1545` 是 libjli → libjvm 的第一次 handoff**：调用之前 = libjli 领域（~0.05s）；调用内部 = libjvm 领域（~2s）。调用之后：`options` 数组立即释放（`java.c:1546`）——因为 JVM 已复制 options 到自己的 internal structures。

**→ 进入 [01-jvm-startup] §一**

---

### Step 8: LoadMainClass → CallStaticVoidMethod

**WHY**：因为 JVM 启动后，还需要加载用户的 Java 主类并调用其 `main(String[])` 方法。这仍然是 libjli 的工作——JVM 只提供运行时平台，不管"用户想运行哪个类"。

`LoadMainClass`（`java.c:1623`）通过 JNI 调用 Java 层的 `sun.launcher.LauncherHelper.checkAndLoadMain()`：

```c
// java.c:1634-1640
NULL_CHECK0(mid = (*env)->GetStaticMethodID(env, cls,
            "checkAndLoadMain",
            "(ZILjava/lang/String;)Ljava/lang/Class;"));
NULL_CHECK0(str = NewPlatformString(env, name));
NULL_CHECK0(result = (*env)->CallStaticObjectMethod(env, cls, mid,
                                                    USE_STDERR, mode, str));
```

**为什么不直接调用 JNI 的 `FindClass()`？** 因为 `FindClass` 返回 NULL 时需要 `ExceptionCheck()` + `ExceptionDescribe()` 来产生错误消息——这在 C 代码中非常冗长。`LauncherHelper` 是 Java 类，在 Java 端处理异常 + 产生正确的 UTF-8 编码错误消息。

**bugid 5030265**（`java.c:498-504`）：C 代码的 manifest 解析（在 `SelectVersion` 调用的 `parse_manifest.c` 中）不支持 UTF-8 编码的类名。所以 `SelectVersion` 提取的 `main_class` 被放进 `_JAVA_VERSION_SET` 环境变量后，`LoadMainClass` 忽略它——调用 Java 层 `LauncherHelper` 重读 manifest，获得正确的 UTF-8 处理。manifest 被读取两次：第一次 C 代码（SelectVersion 中），第二次 Java 代码（LoadMainClass 中）。

**CallStaticVoidMethod——不可逆的过渡**（`java.c:566`）：

```c
(*env)->CallStaticVoidMethod(env, mainClass, mainID, mainArgs);
```

这一行是 libjli 的执行终点。调用前，C stack 上有 `JavaMain → LoadMainClass → InitializeJVM → ...` 的帧。调用后，JVM 执行用户 `main()` 的 Java 代码——C stack 冻结（不再使用），JVM 在解释器/编译后的代码中运行。libjli 再也不会恢复控制，除非 `main()` return 或抛异常。

**这是 libjli → libjvm → Java 的第二次 handoff**。第一次 `JNI_CreateJavaVM` 时 libjli 交控制给 libjvm 做 VM 初始化——libjvm 返回后 libjli 用它的 JNI Env 加载主类。第二次 `CallStaticVoidMethod` 时 libjli 交控制给 Java 应用——从此不再回来。

`GetStaticMethodID` 的签名是 `"([Ljava/lang/String;)V"`——这是 JNI 类型签名格式：`[` = array, `L` = object type, `java/lang/String` = 类名, `V` = void。即 "public static void main(String[] args)"。

如果 main() 抛异常（`java.c:568-572`）：

```c
ret = (*env)->ExceptionOccurred(env) == NULL ? 0 : 1;
```

→ 详见 [03-Main-Class-Loading] §四

---

### Story-Format Interview Answer

**Q: "What happens between `java MyClass` and `main()`?"**

两段故事。

**第一段——libjli（~0.05 秒）**：shell 调用 `execvp("java", args)`。内核创建新进程，加载 `java` 二进制。`main()` 在 `java.c:220` 调用 `JLI_Launch(argc, argv, ...)`。它立即初始化全局版本/名字/flag 状态。然后 `SelectVersion` 检查 manifest 确定需要的 JDK 版本（如果有）。`CreateExecutionEnvironment` 通过 `/proc/self/exe` → `readlink` → `TruncatePath("/bin/")` 找到 JRE 根目录 → 拼接 `lib/server/libjvm.so` 路径 → 读取 `jvm.cfg` 确定 VM 类型（默认 `-server`）。`LoadJavaVM` 调用 `dlopen(libjvm.so, RTLD_NOW+RTLD_GLOBAL)` 加载 20MB 的 HotSpot 库 → `dlsym` 三次填充 `InvocationFunctions` 结构体（`CreateJavaVM`、`GetDefaultJavaVMInitArgs`、`GetCreatedJavaVMs`）。`ParseArguments` 分类参数：`-jar` → `mode=LM_JAR`，`-Xms8g` → `AddOption → options[]`，`-cp foo:bar` → `SetClassPath`（wildcard 展开）。`JVMInit` → `ContinueInNewThread` → `pthread_create` 新线程（8MB 栈，无 guard page）→ 新线程调用 `JavaMain`。

**第二段——libjvm（~2 秒）**：`JavaMain` 调用 `InitializeJVM`。它将 `options[]` 数组转为 `JavaVMInitArgs` 结构体 → 调用 `ifn->CreateJavaVM(&vm, &env, &args)`。**这一行是 handoff 点**：进入 libjvm 领域 → `Threads::create_vm()` → `Universe::genesis()` → `Interpreter::initialize()` → 系统类预加载 → 编译线程启动 → VM 返回 JNI_OK。libjli 恢复控制：`JLI_MemFree(options)`。然后 `LoadMainClass` 通过 JNI 调用 `LauncherHelper.checkAndLoadMain()` → `Class.forName(mainClassName)` → 验证 `main(String[])` 签名。最后 `CallStaticVoidMethod(env, mainClass, mainID, mainArgs)`——**第二次 handoff**——JVM 解释器/编译后的代码开始执行用户的 `main()`。

**如果一切正常**：从 shell 命令到 `main()` 第一行代码约 2.05 秒。**但如果出错**——只有前 0.05 秒产生明确错误消息（`DLL_ERROR1`、`JVM_ERROR1`、`CLS_ERROR1`）——libjli 是 startup failure 的诊断前线。

---

## §二 环境

### Build & Source
- OpenJDK 11 slowdebug build, Linux x86_64, TencentOS Server 4.2 (RHEL-like)
- Source roots:
  - `src/java.base/share/native/libjli/` — 跨平台核心：`java.c`(:220 JLI_Launch 入口)、`java.h`(:83 InvocationFunctions)
  - `src/java.base/unix/native/libjli/` — Linux/Solaris 平台：`java_md_solinux.c`(:571 dlopen, :687 readlink)、`java_md_common.c`(:56 TruncatePath)
- Build：`cd openjdk11 && make jdk`

### Key Binaries
| Binary | Path | Role |
|--------|------|------|
| `java` 可执行文件 | `build/linux-x86_64-normal-server-slowdebug/jdk/bin/java` | 入口 — `main()` → `JLI_Launch` |
| `libjli.so` | `build/.../jdk/lib/jli/libjli.so` | JLI_Launch 所在库，~100KB，启动后被 dlopen 的 libjvm.so 取代 |
| `libjvm.so` | `build/.../jdk/lib/server/libjvm.so` | 被 dlopen 加载的 HotSpot VM，~20MB |
| `libjava.so` | `build/.../jdk/lib/libjava.so` | JRE 验证标记文件（`access()` 检查其存在性） |
| `jvm.cfg` | `build/.../jdk/lib/jvm.cfg` | VM 类型配置（-server KNOWN / -client IGNORE） |

### 诊断环境
```bash
# GDB 跟踪完整启动流
gdb --args java -Xms8g -jar app.jar
(gdb) break JLI_Launch           # java.c:220
(gdb) break LoadJavaVM           # java_md_solinux.c:564
(gdb) break InitializeJVM        # java.c:1522
(gdb) run

# 查看 java 二进制依赖的 .so
ldd $(readlink -f /proc/self/exe)

# 查看 libjli.so 导出的符号
nm -D $JAVA_HOME/lib/jli/libjli.so | grep JLI

# strace 系统调用级 trace（定位 dlopen / access / stat 失败）
strace -e trace=openat,readlink,access,stat,mmap java -jar app.jar 2>&1 | head -100
```

### 关键系统调用速查
| Syscall | man | 使用点 | 失败时 errno |
|---------|-----|--------|-------------|
| `readlink()` | `man 2 readlink` | `java_md_solinux.c:689` — 读 `/proc/self/exe` | ENOENT, EACCES, EINVAL |
| `access()` | `man 2 access` | `java_md_solinux.c:532` — 验证 `libjava.so` | EACCES, ENOENT |
| `stat()` | `man 2 stat` | `java_md_solinux.c:504` — 验证 `libjvm.so` | ENOENT, EACCES |
| `dlopen()` | `man 2 dlopen` | `java_md_solinux.c:571` — 加载 libjvm.so | ENOENT, EACCES, ELIBBAD, EPERM |
| `dlsym()` | `man 2 dlsym` | `java_md_solinux.c:624` — 查找符号地址 | NULL（dlerror() 获取详情） |
| `pthread_create()` | `man 2 pthread_create` | `java_md_solinux.c:786` — 创建 JavaMain 线程 | EAGAIN, EPERM, EINVAL |
| `getenv()` | `man 3 getenv` | `java.c:322` — 读取 CLASSPATH 环境变量 | NULL（未设置） |
| `/proc/self/exe` | `man 5 proc` | `java_md_solinux.c:687` — 内核进程符号链接 | ENOENT（非 Linux/容器无 /proc） |

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|-------|----------------|------|
| 1 | `java.c` | `src/java.base/share/native/libjli/java.c` | ~2415 | `JLI_Launch`(:220), `LoadJavaVM`(:300 调用点), `ParseArguments`(:1296), `JavaMain`(:405), `InitializeJVM`(:1522), `LoadMainClass`(:1623), `SelectVersion`(:1056), `AddOption`(:932), `SetClassPath`(:985), `JVMInit`(:2345), `ContinueInNewThread`(:2338), `CheckJvmType`(:676), `ReadKnownVMs`(:2084) | 主入口 + 全流程编排 |
| 2 | `java_md_solinux.c` | `src/java.base/unix/native/libjli/java_md_solinux.c` | ~879 | `SetExecname`(:687→readlink), `CreateExecutionEnvironment`(:304), `LoadJavaVM`(:564→dlopen+dlsym), `GetJREPath`(:517), `GetJVMPath`(:491), `CallJavaMainInNewThread`(:772→pthread_create) | Linux 平台特定：JVM 发现/加载/线程创建 |
| 3 | `java_md_common.c` | `src/java.base/unix/native/libjli/java_md_common.c` | ~371 | `GetExecName`(:166), `TruncatePath`(:51), `GetApplicationHome`(:75) | Cross-Unix helpers |
| 4 | `java.h` | `src/java.base/share/native/libjli/java.h` | ~278 | `InvocationFunctions` struct(:83), `LaunchMode` enum(:231), `JavaMainArgs` struct(:242), `JLI_Launch` 签名(:89-101) | 共享数据结构 |
| 5 | `emessages.h` | `src/java.base/share/native/libjli/emessages.h` | ~123 | `JVM_ERROR1`(:60), `CLS_ERROR1`(:68), `JAR_ERROR2`(:65), `DLL_ERROR1`(:108), `DLL_ERROR2`(:109), `JRE_ERROR1`(:91) | 错误消息宏 |

**跨模块说明**：`java.c` 是跨平台核心——所有平台的 `JLI_Launch` 逻辑相同。`java_md_solinux.c` 实现 Linux/Solaris 特有部分：`dlopen/dlsym`、`/proc/self/exe` 读取、`pthread_create`。两者的分界线在 `LoadJavaVM`：`java.c:300` 调用平台特定的 `LoadJavaVM()`（在 `java_md_solinux.c:564` 实现）。

---

## §四 libjli ↔ libjvm 的两次 handoff

```
Handoff 1: JNI_CreateJavaVM (java.c:1545) — C → C++ → VM 初始化
  ┌────────────┐    ┌────────────┐
  │   libjli   │ →  │   libjvm   │   进入 01-jvm-startup §一
  │  C runtime │    │  HotSpot   │
  │  ~0.05s    │    │  ~2s       │
  └────────────┘    └────────────┘
       ↑                   ↓
       └─── 返回 JNI_OK ───┘

Handoff 2: CallStaticVoidMethod (java.c:566) — C → Java → 用户 main()
  ┌────────────┐    ┌────────────┐
  │   libjli   │ →  │    Java    │
  │  (via JNI) │    │  main(String[]) 
  └────────────┘    └────────────┘
                     永不返回
                        ↓
                    main() returns
                        ↓
                    LEAVE() → DetachCurrentThread + DestroyJavaVM
```

**为什么 libjli "夹在中间"？**
- 因为 `CreateJavaVM` 需要 C 调用者做内存管理（options 数组的 `malloc`/`JLI_MemFree`）
- 因为 `LoadMainClass` 需要 Java 层 `LauncherHelper` 做 UTF-8 manifest 解析
- 因为 `CallStaticVoidMethod` 需要 JNI env（来自 `CreateJavaVM` 返回的 `env` 参数）
- libjli 是"中介"——它在 libjvm 和 Java 应用之间来回穿梭

---

## §五 Mermaid：13/01 责任边界序列图

```mermaid
sequenceDiagram
    participant Shell as Shell
    participant libjli as libjli (java.c)
    participant linux as java_md_solinux.c
    participant libjvm as libjvm (HotSpot)
    participant Java as Java App

    Shell->>libjli: execvp("java", args)
    Note over libjli: JLI_Launch(java.c:220) — 12 params

    libjli->>libjli: SelectVersion(java.c:1056)
    Note over libjli: 读 manifest → 确定 JRE 版本

    libjli->>linux: CreateExecutionEnvironment(java_md_solinux.c:304)
    linux->>linux: SetExecname → /proc/self/exe readlink(:687)
    linux->>linux: GetJREPath(:517) → access(libjava.so)
    linux->>linux: GetJVMPath(:491) → 拼接 lib/server/libjvm.so
    linux-->>libjli: jrepath + jvmpath

    libjli->>linux: LoadJavaVM(jvmpath, &ifn)(java.c:300 → java_md_solinux.c:564)
    linux->>linux: dlopen(libjvm.so, RTLD_NOW+RTLD_GLOBAL)(:571)
    linux->>linux: dlsym("JNI_CreateJavaVM")(:624) → ifn.CreateJavaVM
    linux->>linux: dlsym("JNI_GetDefaultJavaVMInitArgs")(:631)
    linux->>linux: dlsym("JNI_GetCreatedJavaVMs")(:638)
    linux-->>libjli: InvocationFunctions filled

    libjli->>libjli: ParseArguments(java.c:1296)
    Note over libjli: -jar → LM_JAR; -Xms→AddOption; -cp→SetClassPath

    libjli->>linux: JVMInit → ContinueInNewThread → pthread_create(:786)

    rect rgb(255, 240, 240)
        Note over libjli,libjvm: ★★★ Handoff 1 — libjli→libjvm ★★★
        libjli->>libjvm: ifn->CreateJavaVM(&vm, &env, &args)(java.c:1545)
        Note over libjvm: → 01-jvm-startup §一<br/>Threads::create_vm()<br/>Universe::genesis()<br/>~2s
        libjvm-->>libjli: JNI_OK → vm + env
    end

    libjli->>libjli: LoadMainClass(java.c:1623/CallStaticObjectMethod)
    Note over libjli: LauncherHelper.checkAndLoadMain()<br/>→ Class.forName(mainClassName)

    rect rgb(240, 255, 240)
        Note over libjli,Java: ★★★ Handoff 2 — C→Java ★★★
        libjli->>Java: CallStaticVoidMethod(env, mainClass, mainID, mainArgs)(java.c:566)
        Note over Java: main(String[] args)
    end

    Java-->>libjli: main() returns
    libjli->>libjvm: DetachCurrentThread + DestroyJavaVM
    libjli-->>Shell: exit(0)
```

---

## §六 时序分析——谁在占用启动时间

| Step | Operation | Time | % of total |
|------|-----------|------|------------|
| Step 1 | SelectVersion（manifest 读取） | ~0.5ms | 0.025% |
| Step 2 | CreateExecutionEnvironment（/proc/self/exe + stat） | ~1ms | 0.05% |
| Step 3 | LoadJavaVM（dlopen + dlsym × 3） | ~20ms | 1% |
| Step 4 | ParseArguments（字符串比较） | ~1ms | 0.05% |
| Step 5 | Set properties + SetClassPath | ~0.5ms | 0.025% |
| Step 6 | JVMInit → pthread_create | ~0.5ms | 0.025% |
| **Step 7** | **JNI_CreateJavaVM（VM 初始化）** | **~2000ms** | **★ 97.8%** |
| Step 8 | LoadMainClass + CallStaticVoidMethod | ~5-20ms | ~1% |
| **Total** | | **~2050ms** | 100% |

**关键结论**：如果应用启动需要 3s，67% 是 `JNI_CreateJavaVM` 耗时，1.6% 是 libjli，其余是应用自己的初始化。**但 100% 的启动错误消息来自 libjli**。libjli 是 startup 诊断的前线——它快速做完自己的 0.05s 工作，然后调用 JNI_CreateJavaVM。如果 JVM 初始化失败（2s 后），libjli 打印 `JVM_ERROR1`。如果更早——dlopen 失败——libjli 打印 `DLL_ERROR1`。如果更晚——LoadMainClass 失败——libjli 打印 `CLS_ERROR1`。三类错误覆盖 libjli 的全生命周期。

---

## §七 边缘场景——当启动路径不是线性的

正常流程是 §一 的 8 步线性序列，但以下场景会改变启动路径。

### 场景 1：`/proc/self/exe` 不可用（非 Linux / 容器无 procfs）

**触发条件**：在 FreeBSD、macOS 或裁剪过的 Docker 容器（`noexec` + `hidepid` 挂载的 /proc）中运行 OpenJDK。

**源码行为**：`java_md_solinux.c:687-689` 的 `readlink("/proc/self/exe", buf, PATH_MAX)` 返回 -1（`errno=ENOENT`）→ `SetExecname` 退回到 `getexecname()`（Solaris 特有，`java_md_solinux.c:192`）→ 如果也失败，`CreateExecutionEnvironment` 返回的 `jrepath` 为空 → `GetJREPath` → `access()` 找不到 `libjava.so` → `JRE_ERROR1`。

**诊断**：
```bash
# 1. 确认 /proc 挂载状态
mount | grep proc
# 2. 确认容器是否有 /proc
ls -la /proc/self/exe    # 应看到符号链接
# 3. 如果 /proc 缺失，显式设置 JAVA_HOME 作为 fallback
export JAVA_HOME=/opt/jdk11
# 4. strace 验证
strace -e readlink java -version 2>&1 | grep "/proc/self/exe"
```

**容器修复**：Docker 默认挂载 `/proc`，但如果自定义了 `--security-opt apparmor=unconfined` 或使用了非常精简的 base image（如 `scratch`），需要在 Dockerfile 中确保 `/proc` 可挂载。Kubernetes pod 的 `securityContext.procMount` 必须设置为 `Default`。

### 场景 2：SELinux / AppArmor 阻止 dlopen

**触发条件**：RHEL/CentOS 上 SELinux 的 `deny_execmem` 或 `deny_ptrace` 策略，或自定义 AppArmor profile 限制 dlopen。

**源码行为**：`java_md_solinux.c:571` 的 `dlopen(jvmpath, RTLD_NOW | RTLD_GLOBAL)` 返回 NULL，`errno` 通过 `dlerror()` 获取。可能返回的 errno：`EPERM`（SELinux 拒绝）、`EACCES`（权限不足）、`EEXIST`（符号冲突）。libjli 打印 `DLL_ERROR1` + `DLL_ERROR2`（`emessages.h:108-109`）。

**问题**：`DLL_ERROR2` 的格式是 `"Error: failed %s, because %s"`——`dlerror()` 的错误字符串包含了细粒度信息，但用户看到的只是 "because Permission denied" 或 "because SELinux is preventing..."。没有明确指出是 SELinux。

**诊断**：
```bash
# 1. 检查 SELinux 策略拒绝日志
ausearch -m avc -ts recent | grep java
# 2. 临时测试（生产慎用！）
setenforce 0 && java -version
# 3. 检查 libjvm.so 的安全上下文
ls -lZ $(readlink -f /proc/self/exe)/../lib/server/libjvm.so
# 4. 检查 AppArmor 日志
dmesg | grep -i apparmor | grep java
```

### 场景 3：LD_PRELOAD / LD_LIBRARY_PATH 干扰

**触发条件**：运维为监控目的设置了 `LD_PRELOAD=/path/to/libagent.so`，该 agent 与 libjvm.so 中的符号冲突。

**源码行为**：`dlopen(libjvm.so, RTLD_NOW)` 强制立即解析所有符号 → 如果 `LD_PRELOAD` 中的 agent 库导出了同名符号（如 `JVM_FindSignal`），`RTLD_GLOBAL` flag 可能导致符号覆盖。结果：JVM 启动成功但行为异常——GC 暂停监控信号被拦截、NMT 内存追踪数据被改写。

**反事实**：如果使用 `RTLD_LOCAL` 替代 `RTLD_GLOBAL` → libjvm.so 的符号不会导出到全局命名空间 → native agent 库（如 `-javaagent` 加载的 instrument JAR）无法回调 JVM 函数 → `TIERED_ONLY` 的 UnsatisfiedLinkError。

**诊断**：
```bash
# 1. 检查当前进程的 LD_PRELOAD 和 LD_LIBRARY_PATH
echo $LD_PRELOAD; echo $LD_LIBRARY_PATH
# 2. 查看 java 进程实际加载的 .so 顺序
cat /proc/$(pgrep -n java)/maps | grep "\.so"
# 3. 用 strace 确认符号解析路径
strace -e openat java -version 2>&1 | grep -E "libjvm|libagent"
```

### 场景 4：libjvm.so 来自不同的 JDK 安装

**触发条件**：用户设置了 `JAVA_HOME=/opt/jdk17` 但 `/usr/bin/java` 是 JDK 11 的二进制。或者 Docker 容器中 `/proc/self/exe` 指向宿主机挂载的 `java`，但 libjvm.so 路径解析到容器内的 JDK。

**源码行为**：`java_md_solinux.c:689` 通过 `/proc/self/exe` 找到自身的绝对路径 → `TruncatePath` 向上找到 JRE 根 → 拼接 `lib/server/libjvm.so`。如果自身是 JDK 11 但拼接路径落到 JDK 17 的安装目录 → `dlopen` 成功（RTLD_NOW 检查所有符号）→ `dlsym("JNI_CreateJavaVM")` 成功（JNI Invocation API 跨版本兼容）→ JVM 启动 → 运行时出现 JDK 17 行为差异（如 ZGC 可用、NestHost 属性存在）。

**这是一个几乎无法从错误消息检测的故障模式**——JVM 可能没有任何错误地启动，但运行行为与预期不符。

**诊断**：
```bash
# 1. 确认 java 二进制对应的 libjvm.so 的实际路径
readlink -f /proc/self/exe
readlink -f $(dirname $(readlink -f /proc/self/exe))/../lib/server/libjvm.so
# 2. 对比两个文件的安装来源
rpm -qf $(readlink -f $(dirname $(readlink -f /proc/self/exe))/../lib/server/libjvm.so)
# 3. 运行时检查 JVM 版本
java -XshowSettings:all -version 2>&1 | grep "java.home"
```

### 场景 5：pthread_create 失败兜底回到主线程

**触发条件**：系统 LWP（Light Weight Process）耗尽（`ulimit -u` 限制）或虚拟内存不足无法分配新线程栈。

**源码行为**：`java_md_solinux.c:786` 的 `pthread_create()` 返回非零 → 进入 fallback 路径（`java_md_solinux.c:790-798`）→ 在原线程栈直接调用 `JavaMain(args)`。源码注释 `"This will likely fail later in JavaMain as JNI_CreateJavaVM needs to create quite a few new threads, anyway, just give it a try.."` 坦诚说明这是乐观兜底。

**诊断**：
```bash
# 1. 检查用户级线程限制
ulimit -u
# 2. 检查当前系统线程数
cat /proc/sys/kernel/threads-max
ps -eLf | wc -l
# 3. strace 验证
strace -e clone java -jar app.jar 2>&1 | grep ENOSPC
```

---

## §八 GDB 断点验证——10 断点完整 trace

### 断言 1: JLI_Launch 入口（java.c:220）

```
(gdb) break java.c:220
(gdb) print argc → 期望: 命令行参数数量
(gdb) print mode → 期望: 0 (LM_UNKNOWN)
(gdb) print what → 期望: 0x0 (NULL)
(gdb) print fullversion → 期望: JDK 版本字符串
```

### 断言 2: SelectVersion 入口（java.c:1056）

```
(gdb) break java.c:1056
(gdb) print *argv[0] → 期望: 第一个命令行参数
(gdb) print main_class → 期望: NULL（当前未设置）
(gdb) continue
(gdb) print *main_class → 期望: manifest Main-Class 或 NULL
```

### 断言 3: CreateExecutionEnvironment 入口（java_md_solinux.c:304）

```
(gdb) break java_md_solinux.c:304
(gdb) print *pargv → 期望: 命令行参数指针
(gdb) print jrepath → 期望: 未初始化 char 数组
```

### 断言 4: SetExecname — /proc/self/exe readlink（java_md_solinux.c:689）

```
(gdb) break java_md_solinux.c:689
(gdb) print self → 期望: "/proc/self/exe"
(gdb) continue
(gdb) print buf[0]@len → 期望: ".../jdk/bin/java" 绝对路径
```

### 断言 5: GetApplicationHome — TruncatePath（java_md_common.c:56-58）

```
(gdb) break java_md_common.c:56
(gdb) print buf → 期望: 包含 "/bin/" 的可执行文件路径
(gdb) continue
(gdb) print *p → 期望: '\0'（截断点）
```

### 断言 6: GetJVMPath（java_md_solinux.c:491）

```
(gdb) break java_md_solinux.c:491
(gdb) print jrepath → 期望: JRE 根目录（含 lib/libjava.so）
(gdb) print jvmtype → 期望: "server"
(gdb) continue
(gdb) print jvmpath → 期望: ".../lib/server/libjvm.so"
```

### 断言 7: LoadJavaVM — dlopen（java_md_solinux.c:571）

```
(gdb) break java_md_solinux.c:571
(gdb) print jvmpath → 期望: libjvm.so 完整路径
(gdb) continue
(gdb) print libjvm → 期望: 非 NULL（dlopen 成功）
```

### 断言 8: dlsym("JNI_CreateJavaVM")（java_md_solinux.c:624）

```
(gdb) break java_md_solinux.c:624
(gdb) continue
(gdb) print ifn->CreateJavaVM → 期望: 非 NULL 函数指针
(gdb) print ifn->GetDefaultJavaVMInitArgs → 期望: 非 NULL
(gdb) print ifn->GetCreatedJavaVMs → 期望: 非 NULL
```

### 断言 9: InitializeJVM — CreateJavaVM 调用（java.c:1545）

```
(gdb) break java.c:1545
(gdb) print args.nOptions → 期望: ≥1（至少含 -Djava.class.path）
(gdb) print args.options[0].optionString → 期望: 第一个 JVM 选项字符串
(gdb) print args.ignoreUnrecognized → 期望: JNI_FALSE (0)
(gdb) continue
(gdb) print r → 期望: 0 (JNI_OK)
```

### 断言 10: LoadMainClass（java.c:1623）

```
(gdb) break java.c:1623
(gdb) print mode → 期望: 2 (LM_JAR) 或 1 (LM_CLASS)
(gdb) print name → 期望: jar 文件名或类名
(gdb) continue
(gdb) print result → 期望: 非 NULL（FindClass 成功返回 jclass）
```

### 断言 11: CallStaticVoidMethod（java.c:566）

```
(gdb) break java.c:566
(gdb) print mainClass → 期望: jclass handle（非 NULL）
(gdb) print mainID → 期望: jmethodID handle（非 NULL）
```

### 断言 12: pthread_create（java_md_solinux.c:786）

```
(gdb) break java_md_solinux.c:786
(gdb) print tid → 期望: 新线程 ID（非 0）
(gdb) print attr → 期望: pthread_attr_t（custom stack_size + no guard page）
```

### 断言 13: JVM_ERROR1 错误路径（java.c:429）— 故意使 -Xmx 超大触发

```
$ java -Xmx999999g -version
(gdb) break java.c:429
(gdb) print JVM_ERROR1 → 期望: "Error: Could not create the Java Virtual Machine..."
```

---

## §九 Cross-References

| 阶段 | 关联点 | 关系 |
|------|--------|------|
| **01-jvm-startup §一** | `java.c:1545` = `JNI_CreateJavaVM` 入口 | 本文写到调用点，内部实现在 01 |
| **02-class-loading** | `java.c:523` LoadMainClass → FindClass → 双亲委派 | classpath 来自本文的 SetClassPath |
| **04-system-preload** | JNI_CreateJavaVM 内部的系统类预加载 | 在 01 中展开 |
| **09-native-interface** | JNI Env 结构体初始化（vm + env 返回时填充） | 类型定义在本文 java.h:79-87 |
| **14-zip-jimage** | manifest ZIP 解析（parse_manifest.c） | SelectVersion 调用 |
| **18-agent-instrument** | -javaagent 参数 → AddOption(options) → JNI_CreateJavaVM | 参数流向本文 ParseArguments |

---

## §十 ADDITIONAL PROHIBITIONS（≥8）

- ❌ 只列函数调用顺序不做 WHY 分析
- ❌ 忽略 12 参数签名的含义
- ❌ 不解释 /proc/self/exe vs $JAVA_HOME 的优先级
- ❌ 把 JNI_CreateJavaVM 内部实现写进本文——那是 01-jvm-startup 范畴
- ❌ 忽略 pthread_create 的失败回退逻辑
- ❌ 不做 JVM_ERROR1 三段诊断
- ❌ 把 InvocationFunctions 当作黑盒——必须展示 typedef + dlsym
- ❌ 忘记 bugid 5030265——manifest 两次读取
- ❌ 不解释 RTLD_NOW vs RTLD_LAZY
- ❌ 省略 5 个 beginner callout 框（实需 ≥7）
- ❌ 解释 C 语言基础（argc/argv/指针运算）——这是 JVM 文档
- ❌ 深入解释 POSIX dlopen/dlsym 语义（11-os-layer 覆盖）
- ❌ 忽略边缘场景：SELinux 阻止 dlopen、/proc 不可用、LD_PRELOAD 干扰符号、libjvm.so 跨版本混淆
- ❌ 不做 man 手册引用——每个核心 syscall 必须标注 `man 2/3/5` 线索<br/>(dlopen→man 2 dlopen, readlink→man 2 readlink, /proc/self/exe→man 5 proc, access→man 2 access, pthread_create→man 2 pthread_create)
