# 02. 参数解析 + 平台 JVM 加载

> **前置依赖**:[40-launcher/01 — java MyApp 在命令行后发生了什么事？— 启动流程](01-launch-flow.md):JLI_Launch、ParseArguments、jvm.cfg 与 `dlopen` 的主骨架;[25-gc-framework/02 — new Object() 走到了哪？— CollectedHeap + 分配路径](openjdk/vol-02/25-gc-framework/02-collected-heap.md):本篇只讨论 launcher,不重复 VM 内部参数初始化
> → **后续**:[41-zip-jimage/01 — ZIP 文件读取 — JAR 里的类怎么被找到](openjdk/vol-02/41-zip-jimage/01-zip.md)
> 关联域: 40-launcher/01(主流程)、09-memory-core(动态库/路径)、30-jvm-entry(JNI 桥)

上篇把流程画成了 `main.c → JLI_Launch → LoadJavaVM → ParseArguments → JavaMain`。本篇把两个容易被一句话带过的细节拆开:

1. `@argfile`、`JDK_JAVA_OPTIONS`、classpath `*` 到底在哪一层展开;
2. `jvm.cfg` 如何选 VM 变体,平台层如何找到 `libjvm.so`,为什么有时还要重启 launcher 才能让 `LD_LIBRARY_PATH` 生效。

---

## 1. 参数预处理 — argfile 和环境变量先于 ParseArguments

### `JDK_JAVA_OPTIONS` 插在用户 argv 前面

上篇 `main.c` 的 Unix 分支已经看到 `JLI_AddArgsFromEnvVar(args, JDK_JAVA_OPTIONS)`(main.c:190-200)。它不是把环境变量当成普通字符串传给 JVM,而是先调用 `args.c` 的 `expand()` 把它拆成参数,再逐个放入 `JLI_List`。

`JLI_AddArgsFromEnvVar`(src/java.base/share/native/libjli/args.c:470-489):

```c
// args.c:470-489(截取核心,逐字)
JNIEXPORT jboolean JNICALL
JLI_AddArgsFromEnvVar(JLI_List args, const char *var_name) {
    char *env = getenv(var_name);

    if (firstAppArgIndex == 0) {
        // Not 'java', return
        return JNI_FALSE;
    }

    if (relaunch) {
        return JNI_FALSE;
    }

    if (NULL == env) {
        return JNI_FALSE;
    }

    JLI_ReportMessage(ARG_INFO_ENVVAR, var_name, env);
    return expand(args, env, var_name);
}
```

关键是插入时机: `main.c` 先把 `argv[0]` 加进列表,再调用这个函数,最后才把用户自己的 `argv[1..]` 逐个追加。因此 `JDK_JAVA_OPTIONS` 是**前置参数**,用户命令行在它之后。

### argfile 不是 shell 展开,而是 launcher 自己递归读取

`JLI_PreprocessArg`(args.c:409-451):

```c
// args.c:409-451(截取核心,逐字)
JNIEXPORT JLI_List JNICALL
JLI_PreprocessArg(const char *arg, jboolean expandSourceOpt) {
    JLI_List rv;

    if (firstAppArgIndex > 0) {
        // In user application arg, no more work.
        return NULL;
    }
...
    if (arg[0] != '@') {
        checkArg(arg);
        return NULL;
    }

    if (arg[1] == '\0') {
        // @ by itself is an argument
        checkArg(arg);
        return NULL;
    }

    arg++;
    if (arg[0] == '@') {
        // escaped @argument
        rv = JLI_List_new(1);
        checkArg(arg);
        JLI_List_add(rv, JLI_StringDup(arg));
    } else {
        rv = expandArgFile(arg);
    }
    return rv;
}
```

这段逻辑有三个边界:

- `@file` → 读取并展开 argfile;
- `@@value` → 转义成字面量 `@value`;
- 单独的 `@` → 当普通参数处理,不是空文件引用。

argfile 内部仍然会回到 `expand()`/`JLI_PreprocessArg`,因此可以嵌套引用另一个 argfile。**展开发生在 launcher 参数数组阶段,不是 Java `main` 收到参数后再展开。**

### 环境变量和 argfile 禁止终止选项注入启动模式

`expand()`(args.c:498-588)在把 token 放入列表前会检查 `isTerminalOpt()`(args.c:453-467):

- `-jar`、`-m`、`--module`;
- `--help`、`--version`、`-X`;
- `--dry-run`、`--full-version` 等。

这些选项若从 `JDK_JAVA_OPTIONS` 或 argfile 注入,launcher 会报错退出,而不是允许环境变量悄悄改变主类启动模式。这个限制非常重要: **环境变量可以预置 VM/launcher 参数,但不能劫持“应用入口选择”。**

---

## 2. classpath wildcard — `*` 是 JLI 规则,不是 shell glob

### `JLI_WildcardExpandClasspath` 的入口

`JLI_WildcardExpandClasspath`(src/java.base/share/native/libjli/wildcard.c:302-320):

```c
// wildcard.c:302-320(截取核心,逐字)
const char *
JLI_WildcardExpandClasspath(const char *classpath)
{
    const char *expanded;
    JLI_List fl;

    if (JLI_StrChr(classpath, '*') == NULL)
        return classpath;
    fl = JLI_List_split(classpath, PATH_SEPARATOR);
    expanded = FileList_expandWildcards(fl) ?
        JLI_List_join(fl, PATH_SEPARATOR) : classpath;
    JLI_List_free(fl);
    if (getenv(JLDEBUG_ENV_ENTRY) != 0)
        printf("Expanded wildcards:\n"
               "    before: \"%s\"\n"
               "    after : \"%s\"\n",
               classpath, expanded);
    return expanded;
}
```

它先按平台 path separator 拆 classpath 的各个元素,只有检测到 `*` 才进入展开逻辑。注意这里的展开对象是 **classpath 字符串**,不是任意 JVM 参数。

### 只匹配 jar 文件,不递归目录

`wildcardFileList`(wildcard.c:245-262)和 `isWildcard`(wildcard.c:265-273)共同定义了规则:

- `*` 必须位于元素末尾;
- 前面通常是路径分隔符;
- 目录项必须通过 `isJarFileName` 检查;
- 只把匹配到的 jar 文件拼回 classpath;
- 不递归子目录,不把普通目录本身加入结果。

因此:

`java -cp "lib/*" MyMain`

不是交给 shell 的 `*` 展开,而是 launcher 自己把 `lib/*` 变成类似 `lib/a.jar:lib/b.jar` 的具体列表。`java.class.path` 从 JVM 角度看到的也是展开后的结果。

这解释了一个常见现象:在 shell 中加不加引号会影响 shell 是否先处理 `*`,但只要 `*` 以 classpath 元素形式进入 JLI,最终规则仍由 `wildcard.c` 决定,而不是由 ClassLoader 在运行时懒展开。

---

## 3. jvm.cfg — known/alias/ignore 决定 jvmtype

### `GetJREPath` 先找到 JRE 根

Unix 平台的 `GetJREPath`(java_md_solinux.c:512-550)并不只支持 `/proc/self/exe`。它通过 `GetApplicationHome` 或 `GetApplicationHomeFromDll` 找到应用/JLI 的 home,然后检查:

- `<home>/lib/libjava.so`;
- `<home>/jre/lib/libjava.so`;
- 从已加载 DLL 反推的 home。

当前 Unix 实现的关键判断在 java_md_solinux.c:518-545。**“一定通过 `/proc/self/exe` readlink 找 JRE”是平台实现的过度概括**;在不同构建/平台上,application home 和 DLL 路径都可能参与。

### `CreateExecutionEnvironment` 再读 `jvm.cfg`

`CreateExecutionEnvironment`(java_md_solinux.c:304-363)的核心已经在上篇出现,本篇只强调选择链:

1. `GetJREPath` 得到 `jrepath`;
2. 拼出 `jrepath/lib/jvm.cfg`;
3. `ReadKnownVMs` 解析配置;
4. `CheckJvmType` 扫描命令行里是否明确指定 VM 类型;
5. `GetJVMPath` 拼出 `jrepath/lib/<jvmtype>/libjvm.so`。

`GetJVMPath`(java_md_solinux.c:486-505)的路径规则是:

- `jvmtype` 含 `/` 时,直接把它当 JVM 路径的一部分;
- 否则按 `%s/lib/%s/%s` 组合 JRE、VM 类型和 `JAVA_DLL`。

所以 `jvm.cfg` 里的配置值最终影响的是一个**目录名/路径选择**,而不是直接传入 JNI 的“server/client 枚举”。

### `KNOWN`、`ALIAS`、`IGNORE`、`WARN`、`ERROR` 都是实际状态

`ReadKnownVMs` 解析的状态包括:

- `KNOWN`:可用 VM;
- `ALIAS`:把一个 VM 名映射到另一个;
- `IGNORE`:该名字被忽略并回到默认 VM;
- `WARN`:提示后回到默认 VM;
- `ERROR`:直接失败。

`CheckJvmType` 还会处理默认 VM、别名循环和显式 `-server/-client` 参数。因而大纲里仅写“`-server KNOWN` → 选 server”不完整:真实 launcher 还会处理别名、忽略、警告、错误及显式 alternate VM。

---

## 4. LoadJavaVM 与动态库环境 — 不只是 `$RPATH/$ORIGIN`

### `LoadJavaVM` 的 Unix 逻辑

上篇已经看到 `dlopen`/`dlsym`;本篇补一个平台层容易被忽略的分支:Unix 可能需要调整 `LD_LIBRARY_PATH` 并重新 exec 自己。

`java_md_solinux.c:355-364` 会根据 `RequiresSetenv(jvmpath)` 判断是否需要设置环境。若需要,代码在 java_md_solinux.c:366-465 构造新的 `LD_LIBRARY_PATH`,前缀包含 JVM 目录、JRE `lib` 和上层 `lib`;随后 java_md_solinux.c:466-482 通过 `execv/execve` 重新启动当前 launcher。

源码注释给出了原因:Unix 系统通常只在进程启动时读取 `LD_LIBRARY_PATH`,因此**运行中 `putenv` 后必须 re-exec 才能让新路径影响动态加载**。

### 不是“RPATH 消除大多数 LD_LIBRARY_PATH 操作”这么绝对

是否需要重启由 `RequiresSetenv` 和当前动态库布局决定,而不是文章可以脱离构建配置硬推。更准确的说法是:

- 如果当前环境和 JVM 的依赖库布局已经满足,launcher 不需要 re-exec;
- 如果需要补齐动态库搜索路径,launcher 先修改环境,再 exec 自己;
- 重新启动后的第二次进入会通过 `relaunch` 状态避免无限循环。

因此 `$RPATH/$ORIGIN` 可能减少这类需求,但不能替代源码中的 `RequiresSetenv` 分支。

---

## 核心悬念

**参数展开和平台加载都发生在 JVM 创建之前:** `main.c`/`args.c` 先处理 `JDK_JAVA_OPTIONS`、`@argfile` 和 classpath wildcard;平台层再用 JRE home + `jvm.cfg` 选 `jvmtype`,构造 `libjvm` 路径,必要时调整 `LD_LIBRARY_PATH` 并 re-exec,最后才回到 `dlopen`/`JNI_CreateJavaVM`。**下一篇进入域41 ZIP & JIMAGE:** launcher 找到的模块/类路径最终如何落到 ZIP 与 JIMAGE 读取。

> → [41-zip-jimage/01-zip-jimage.md](openjdk/vol-02/41-zip-jimage/01-zip-jimage.md)
