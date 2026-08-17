# 01. java MyApp 在命令行后发生了什么事？— 启动流程

> **前置依赖**:[35-dcmd/02 — jcmd 可以做什么？— 内置命令详解](openjdk/vol-02/35-dcmd/02-builtin-commands.md):理解 HotSpot 服务命令如何进入 JVM;[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md):JNI_CreateJavaVM 之后的 VM 初始化;[09-memory-core/01 — Universe + CollectedHeap](openjdk/vol-02/09-memory-core/01-universe-heap.md):Java heap 在 VM 内的初始化语境
> → **后续**:[40-launcher/02 — 参数解析与平台 JVM 加载](02-args-platform.md)
> 关联域: 30-jvm-entry(JNI_CreateJavaVM)、21-shared-runtime(线程/VM 生命周期)、36-attach(另一个本地入口)

敲下 `java -cp myapp.jar MyMain` 时,JVM 还没有启动。此时运行的是一个本地 launcher:它先把操作系统传进来的参数整理成 JLI 能理解的数组,再找到 JRE 和 `libjvm.so`,用 `dlopen`/`dlsym` 取出 JNI 入口,最后才创建 JVM 并调用 Java 的 `main`。

这条链路要分清三个文件层次:

- `main.c` 是 `java` 可执行文件的薄入口;
- `share/native/libjli/java.c` 是跨平台的 JLI 主流程;
- `unix/native/libjli/java_md_solinux.c` 是 Linux/Solaris 等 Unix 平台的 JRE/JVM 路径与动态库实现。

大纲把主流程全写成 `java.c`;当前 JDK 11 源码树的实际路径是 **`share/native/libjli/java.c`**,而 `share/native/launcher/main.c` 只负责把参数交给 `JLI_Launch`。

---

## 1. 最外层入口 — `main.c` 只负责准备 argv

### `main` 到 `JLI_Launch`

Unix 启动器的 `main`(src/java.base/share/native/launcher/main.c:97-104,183-223,243-251):

```c
// main.c:97-104,183-223,243-251(截取核心,逐字)
JNIEXPORT int
main(int argc, char **argv) {
    int margc;
    char **margv;
    int jargc;
    char **jargv;
    const jboolean const_javaw = JNI_FALSE;
...
#else /* *NIXES */
    {
        // accommodate the NULL at the end
        JLI_List args = JLI_List_new(argc + 1);
        int i = 0;

        // Add first arg, which is the app name
        JLI_List_add(args, JLI_StringDup(argv[0]));
        // Append JDK_JAVA_OPTIONS
        if (JLI_AddArgsFromEnvVar(args, JDK_JAVA_OPTIONS)) {
...
        }
        // Iterate the rest of command line
        for (i = 1; i < argc; i++) {
            JLI_List argsInFile = JLI_PreprocessArg(argv[i], JNI_TRUE);
...
        }
        margc = args->size;
        // add the NULL pointer at argv[argc]
        JLI_List_add(args, NULL);
        margv = args->elements;
    }
#endif /* WIN32 */

    return JLI_Launch(margc, margv,
                      jargc, (const char **) jargv,
                      0, NULL,
                      VERSION_STRING,
                      DOT_VERSION,
                      (const_progname != NULL) ? const_progname : *margv,
                      (const_launcher != NULL) ? const_launcher : *margv,
                      jargc > 0,
                      const_cpwildcard, const_javaw, 0);
}
```

`main.c` 做的事比“把 `argc/argv` 传下去”多一点:

- Unix 上先把 `JDK_JAVA_OPTIONS` 加进参数列表;
- 每个命令行参数都经过 `JLI_PreprocessArg`,因此 `@argfile` 之类的预处理在 JLI 主流程之前完成;
- 最后调用 `JLI_Launch`,把 `margv`、预置 Java 参数、版本、launcher 名称等一起交出去。

所以 `java` 的入口不是 C++ main,也不是 `JNI_CreateJavaVM`。**第一跳是 launcher 自己的参数整理,第二跳才是 JLI。**

---

## 2. JLI_Launch — 先选 JRE/JVM,再解析应用命令

### 主流程的真实顺序

`JLI_Launch`(src/java.base/share/native/libjli/java.c:241-362):

```c
// share/native/libjli/java.c:241-362(截取核心,逐字)
JNIEXPORT int JNICALL
JLI_Launch(int argc, char **argv,
           int jargc, const char **jargv,
...
    SelectVersion(argc, argv, &main_class);

    CreateExecutionEnvironment(&argc, &argv,
                               jrepath, sizeof(jrepath),
                               jvmpath, sizeof(jvmpath),
                               jvmcfg, sizeof(jvmcfg));
...
    if (!LoadJavaVM(jvmpath, &ifn)) {
        return (6);
    }
...
    if (!ParseArguments(&argc, &argv, &mode, &what, &ret, jrepath)) {
        return (ret);
    }
...
    return JVMInit(&ifn, threadStackSize, argc, argv, mode, what, ret);
}
```

顺序和大纲“parse→load→invoke”不一样: **JLI 先确定要加载哪个 JVM,加载成功后才解析 Java 应用模式。** 具体顺序是:

1. `SelectVersion` 检查版本选择相关参数;
2. `CreateExecutionEnvironment` 找 JRE、读 `jvm.cfg`,决定 JVM 类型与路径;
3. `LoadJavaVM` 动态加载 JVM 并拿 JNI 函数指针;
4. `ParseArguments` 解析 `-cp/-jar/-m/--source` 等 launcher 选项;
5. `JVMInit` 创建 JVM、加载主类并调用 `main`。

这不是纯粹的“参数先全部解析完再加载 VM”。JLI 需要先知道 JVM 路径,因为后续某些选项解析和 JVM 初始化依赖这个环境。

### `CreateExecutionEnvironment`: 读 `jvm.cfg`,不是凭文件名猜 server/client

Unix 平台实现(src/java.base/unix/native/libjli/java_md_solinux.c:304-363):

```c
// java_md_solinux.c:304-363(截取核心,逐字)
CreateExecutionEnvironment(int *pargc, char ***pargv,
                           char jrepath[], jint so_jrepath,
                           char jvmpath[], jint so_jvmpath,
                           char jvmcfg[],  jint so_jvmcfg) {
...
    SetExecname(*pargv);

    if (!GetJREPath(jrepath, so_jrepath, JNI_FALSE)) {
        JLI_ReportErrorMessage(JRE_ERROR1);
        exit(2);
    }
    JLI_Snprintf(jvmcfg, so_jvmcfg, "%s%slib%sjvm.cfg",
            jrepath, FILESEP, FILESEP);
    if (ReadKnownVMs(jvmcfg, JNI_FALSE) < 1) {
        JLI_ReportErrorMessage(CFG_ERROR7);
        exit(1);
    }

    jvmpath[0] = '\0';
    jvmtype = CheckJvmType(pargc, pargv, JNI_FALSE);
...
    if (!GetJVMPath(jrepath, jvmtype, jvmpath, so_jvmpath)) {
        JLI_ReportErrorMessage(CFG_ERROR8, jvmtype, jvmpath);
        exit(4);
    }
```

这里至少有四步:

- 根据 executable 名称建立 launcher 环境;
- 找到实际 JRE 路径;
- 读取 `$JRE/lib/jvm.cfg` 中的 known VM 描述;
- 结合命令行和配置选择 `jvmtype`,再拼出 `jvmpath`。

因此“server/client 从 jvm.cfg 选择”这个概念是对的,但它发生在 **平台适配层 `java_md_solinux.c`**,而不是跨平台 `java.c`。

---

## 3. LoadJavaVM — `dlopen` 加载 `libjvm.so`,`dlsym` 找 JNI 入口

### 动态库桥接

`LoadJavaVM`(src/java.base/unix/native/libjli/java_md_solinux.c:553-627):

```c
// java_md_solinux.c:553-627(截取核心,逐字)
LoadJavaVM(const char *jvmpath, InvocationFunctions *ifn)
{
    void *libjvm;

    JLI_TraceLauncher("JVM path is %s\n", jvmpath);

    libjvm = dlopen(jvmpath, RTLD_NOW + RTLD_GLOBAL);
    if (libjvm == NULL) {
...
        return JNI_FALSE;
    }

    ifn->CreateJavaVM = (CreateJavaVM_t)
        dlsym(libjvm, "JNI_CreateJavaVM");
    if (ifn->CreateJavaVM == NULL) {
        JLI_ReportErrorMessage(DLL_ERROR2, jvmpath, dlerror());
        return JNI_FALSE;
    }

    ifn->GetDefaultJavaVMInitArgs = (GetDefaultJavaVMInitArgs_t)
        dlsym(libjvm, "JNI_GetDefaultJavaVMInitArgs");
```

`libjli` 不需要在链接阶段依赖 HotSpot C++ 符号。它只做:

1. `dlopen(jvmpath, RTLD_NOW + RTLD_GLOBAL)`(源码使用这两个 dlopen flag 的组合);
2. `dlsym("JNI_CreateJavaVM")`;
3. `dlsym("JNI_GetDefaultJavaVMInitArgs")`;
4. 后面还会取 `JNI_GetCreatedJavaVMs`。

这些函数指针放入 `InvocationFunctions`。这就是纯 C launcher 和 C++ HotSpot 之间的 ABI 桥: **launcher 不认识 JVM 内部类,只认识 JNI 导出的函数签名。**

---

## 4. ParseArguments — class/jar/module/source 是 mode,不是四条独立入口

### `ParseArguments` 先消费 launcher 选项

`ParseArguments`(src/java.base/share/native/libjli/java.c:1300-1469):

```c
// share/native/libjli/java.c:1300-1469(截取核心,逐字)
static jboolean
ParseArguments(int *pargc, char ***pargv,
               int *pmode, char **pwhat,
               int *pret, const char *jrepath) {
    int argc = *pargc;
    char **argv = *pargv;
    int mode = LM_UNKNOWN;
    char *arg;

    *pret = 0;

    while ((arg = *argv) != 0 && *arg == '-') {
        char *option = NULL;
        char *value = NULL;
        int kind = GetOpt(&argc, &argv, &option, &value);
...
        if (JLI_StrCmp(arg, "-jar") == 0) {
            ARG_CHECK(argc, ARG_ERROR2, arg);
            mode = checkMode(mode, LM_JAR, arg);
        } else if (JLI_StrCmp(arg, "--module") == 0 ||
                   JLI_StrCCmp(arg, "--module=") == 0 ||
                   JLI_StrCmp(arg, "-m") == 0) {
            REPORT_ERROR (has_arg, ARG_ERROR5, arg);
            SetMainModule(value);
            mode = checkMode(mode, LM_MODULE, arg);
        } else if (JLI_StrCmp(arg, "--source") == 0 ||
                   JLI_StrCCmp(arg, "--source=") == 0) {
            REPORT_ERROR (has_arg, ARG_ERROR13, arg);
            mode = LM_SOURCE;
...
        } else if (JLI_StrCmp(arg, "--class-path") == 0 ||
                   JLI_StrCCmp(arg, "--class-path=") == 0 ||
                   JLI_StrCmp(arg, "-classpath") == 0 ||
                   JLI_StrCmp(arg, "-cp") == 0) {
            REPORT_ERROR (has_arg_any_len, ARG_ERROR1, arg);
            SetClassPath(value);
            mode = LM_CLASS;
```

`mode` 是 `LM_UNKNOWN/LM_CLASS/LM_JAR/LM_MODULE/LM_SOURCE` 的状态,`checkMode()` 防止同一条命令同时指定冲突模式。几条典型命令在这里变成:

- `java MyMain` → 最终补成 class 模式;
- `java -jar app.jar` → `LM_JAR`;
- `java -m mymodule/Main` → `LM_MODULE`;
- `java --source 11 X.java` → `LM_SOURCE`。

因此 `-jar`、`-m`、`--source` 不是直接调用三套 JVM 入口,而是**把解析状态写进 `mode` 与 `what`,最后统一交给 JVMInit/JavaMain**。

### ParseArguments 还负责“无需启动应用就退出”的选项

同一个 parser 里还有 `--help`、`--version`、`-X`、`--list-modules`、`--describe-module`、`--dry-run` 等分支。遇到 `--help`/`--version` 时,函数设置输出标志后直接返回;这表示 launcher 仍可能继续初始化 JVM 来生成版本/帮助信息,但不会进入应用 `main`。

这也是为什么不能简单说“ParseArguments 只是决定 class/jar/module”:它同时决定**是否启动应用、打印什么、最终返回码是什么**。

---

## 5. JVMInit/JavaMain — JNI 创建 VM 后才真正碰 Java 类

### `JavaMain` 的第一件大事是 `InitializeJVM`

`JavaMain`(src/java.base/share/native/libjli/java.c:412-478,492-578):

```c
// share/native/libjli/java.c:412-478,492-578(截取核心,逐字)
int
JavaMain(void *_args) {
    JavaMainArgs *args = (JavaMainArgs *) _args;
    int argc = args->argc;
    char **argv = args->argv;
    int mode = args->mode;
    char *what = args->what;
...
    RegisterThread();

    /* Initialize the virtual machine */
    start = CounterGet();
    if (!InitializeJVM(&vm, &env, &ifn)) {
        JLI_ReportErrorMessage(JVM_ERROR1);
        exit(1);
    }
...
    if (printXUsage || printUsage || what == 0 || mode == LM_UNKNOWN) {
        PrintUsage(env, printXUsage);
        CHECK_EXCEPTION_LEAVE(1);
        LEAVE();
    }
...
    mainClass = LoadMainClass(env, mode, what);
    CHECK_EXCEPTION_NULL_LEAVE(mainClass);
...
    mainArgs = CreateApplicationArgs(env, argv, argc);
...
    mainID = (*env)->GetStaticMethodID(env, mainClass, "main",
                                       "([Ljava/lang/String;)V");
    CHECK_EXCEPTION_NULL_LEAVE(mainID);

    /* Invoke main method. */
    (*env)->CallStaticVoidMethod(env, mainClass, mainID, mainArgs);
```

从这里开始才进入 Java 世界:

1. `RegisterThread()` 注册 launcher 线程;
2. `InitializeJVM` 通过前面 `dlsym` 的 JNI 函数创建 VM 和 `JNIEnv`;
3. 处理 usage/version/module 等可能提前退出的状态;
4. `LoadMainClass(env, mode, what)` 按模式加载主类;
5. `GetStaticMethodID(..., "main", "([Ljava/lang/String;)V")` 找标准 main 签名;
6. `CallStaticVoidMethod` 调用 Java main。

### `java -jar` 不在 C launcher 里手写 manifest 解析

`JavaMain` 只把 `mode` 与 `what` 交给 `LoadMainClass`.不同模式的实际加载逻辑在 launcher helper/Java 侧继续展开:class 模式按类名加载,jar 模式根据 jar 的 Main-Class, module 模式走 module main。C 层负责**选择模式和传递入口标识**,不应该被描述成“C 代码自己完成所有 manifest/module 解析”。

### 为什么 main 不在 primordial thread 上直接调用

`java.c:223-227` 的注释说明 launcher 会创建新线程来执行 JavaMain,避免在 primordial thread 上运行 Java 代码带来的问题。平台函数 `CallJavaMainInNewThread` 在 Unix 的 `java_md_solinux.c:742-787` 负责这个封装。于是启动链不是“C main 直接调用 Java main”,而是:

`C main → JLI_Launch → platform launcher thread wrapper → JavaMain → JNI_CreateJavaVM → CallStaticVoidMethod(main)`。

---

## 核心悬念

**`java` 是一个分层的纯 C 启动器:** `main.c` 整理 argv,`JLI_Launch` 先找 JRE/JVM 再解析应用模式,平台层 `dlopen`/`dlsym` 把 `libjvm` 变成 JNI 函数表,`JavaMain` 创建 VM、加载主类、查找 `main` 并调用。**下一篇继续拆参数与平台差异:** `@argfile`、`JDK_JAVA_OPTIONS`、`jvm.cfg`、Linux/macOS/Windows 的 JVM 加载路径各自如何影响启动。

> → [02-args-platform.md](02-args-platform.md)
