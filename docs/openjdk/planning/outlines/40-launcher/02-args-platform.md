# 02. 参数解析 + 平台 JVM 加载

> 🟡 Working | 2 KP: Wildcard/argfile + JVM 变体选择
> 读者处境: 上篇看了三阶段主流程——parse→load→invoke。现在深入"参数怎么展开的？jvm.cfg 到底怎么选 server/client？"

### 1. "Wildcard + argfile — classpath 参数展开"

场景: `java -cp "lib/*" MyMain` → 通配符 `*` 怎么变成 `lib/a.jar:lib/b.jar:...`？`@argfile` 怎么把文件内容展开为命令行参数？

**Wildcard 展开** (`wildcard.c:303-320`):
```
JLI_WildcardExpandClasspath(classpath):
  if no '*' in classpath → 直接返回
  JLI_List_split(classpath, PATH_SEPARATOR ':') → 按 ':' 分割
  遍历每个元素: 含 '*'? → FileList_expandWildcards → opendir → 遍历目录 → 只匹配 *.jar/*.JAR
  JLI_List_join → 用 ':' 重新拼接
[C++: wildcard.c 394行——纯 C 实现，opendir/readdir POSIX 调用]
```
- 源码: `wildcard.c:303-320` (JLI_WildcardExpandClasspath 入口) + `wildcard.c:246-262` (wildcardFileList → WildcardIterator → opendir/readdir 遍历)
- 关键设计: 通配符**只匹配 .jar/.JAR**（不匹配 .zip、不匹配目录、不递归子目录）——这是 JVM 规范定义的行为，不是 shell glob。展开是**早期展开**（在 main 方法调用前），不是懒展开（不是 ClassLoader 时展开）。这意味着 `java.class.path` 系统属性中的 `*` 已经被替换为具体 jar 文件路径。

**argfile 支持** (`args.c:470-570`):
```
JLI_AddArgsFromEnvVar(args, "JDK_JAVA_OPTIONS"):
  getenv("JDK_JAVA_OPTIONS") → expand() 逐字符解析: 空格/引号/转义
  遇到 @ 前缀 → JLI_PreprocessArg → fopen(argfile) → 逐行读取 → 展开为独立参数
[C++: args.c 715行——支持 @/path/to/argfile + JDK_JAVA_OPTIONS 环境变量]
```
- 源码: `args.c:471-489` (JLI_AddArgsFromEnvVar) + `args.c:498-570` (expand → JLI_PreprocessArg → @argfile 逐行读取)
- 关键设计: `@argfile` 中的参数可以**嵌套**引用另一个 argfile。JDK_JAVA_OPTIONS 是**前置**参数（插入在 argv[0] 之后、用户命令行参数之前 from `main.c:190-215`），用户命令行参数可以覆盖它。`-jar`/`-m`/`--module`/`--help`/`-version` 等终止选项 (isTerminalOpt at `args.c:453-468`) 不能出现在 JDK_JAVA_OPTIONS 中——防止环境变量注入改变启动模式。

### 2. "JVM 变体选择 — jvm.cfg → dlopen"

场景: `/usr/lib/jvm/java-11-openjdk/lib/jvm.cfg` 里写 `-server KNOWN` → libjli 怎么选 server JVM→dlopen？

**CreateExecutionEnvironment** (`java_md_solinux.c:304-400`):
```
1. GetJREPath (java_md_solinux.c:513-550) — 通过 /proc/self/exe → readlink → 找 ../lib 路径
2. jvm.cfg (java_md_solinux.c:332-338) — jrepath/lib/jvm.cfg → ReadKnownVMs → 解析 "-server KNOWN\n-client IGNORE"
3. CheckJvmType → 扫描 argv 中 -server/-client → 选 jvmtype 字符串
4. GetJVMPath → jrepath/lib/server/libjvm.so → jvmpath
[C++: java_md_solinux.c 855行——so=shared object, linux=Linux, sol=Oracle Solaris]
[内核: /proc/self/exe → readlink 获取可执行文件路径——Linux 特有的进程自省机制]
```
- 源码: `java_md_solinux.c:304-363` (CreateExecutionEnvironment) + `java_md_solinux.c:513-550` (GetJREPath via /proc/self/exe) + `java_md_solinux.c:553-608` (LoadJavaVM → dlopen)
- 关键设计: jvm.cfg 的 `KNOWN` vs `IGNORE` vs `ALIAS`——`KNOWN` 是可用 JVM 变体，`IGNORE` 被静默跳过（如 client 在某些平台被忽略），`ALIAS` 映射别名。**$RPATH/$ORIGIN** 内嵌在 .so 编译时——因此大多数情况下 launcher 不需要设置 LD_LIBRARY_PATH——只有 LD_LIBRARY_PATH 中已有冲突的 libjvm.so 时才需要 exec 重新启动。

---

### 核心悬念

**"Wildcard 只匹配 *.jar 且早期展开。jvm.cfg 通过 /proc/self/exe 找到 JRE→选 jvmtype→dlopen libjvm.so→dlsym JNI_CreateJavaVM。$RPATH/$ORIGIN 消除了大多数 LD_LIBRARY_PATH 操作。"** — 下一篇: 域41 ZIP & JIMAGE。

> → 域41 ZIP & JIMAGE
