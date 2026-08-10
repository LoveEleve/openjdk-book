# Launcher (libjli.so) — 第一遍产出

> vol-06 · 域 39 · 🟡 B | Pass 1 扫描完成
> 源码：`java.c` (2390行) + `java_md_solinux.c` (855行) + `args.c`/`parse_manifest.c`/`wildcard.c`

## 函数调用链

```
main() (java.c)
  │
  └── JLI_Launch(argc, argv, ...)              java.c:242
       │
       ├── SelectVersion()                      java.c:295
       │     └── 处理 -version:1.x → 递归调用 JLI_Launch
       │
       ├── CreateExecutionEnvironment()         java_md_solinux.c:304
       │     └── 定位 JRE: JAVA_HOME→lib/→jvm.cfg→LD_LIBRARY_PATH
       │
       ├── SetJvmEnvironment()                  java.c:826
       │     └── 设置 CLASSPATH/模块路径等环境变量
       │
       ├── LoadJavaVM(jvmpath, &ifn)            java_md_solinux.c:553
       │     ├── dlopen("libjvm.so", RTLD_NOW+RTLD_GLOBAL)  :559
       │     ├── dlsym(libjvm, "JNI_CreateJavaVM")           (line ~600)
       │     ├── dlsym(libjvm, "JNI_GetDefaultJavaVMInitArgs")
       │     └── dlsym(libjvm, "JNI_GetCreatedJavaVMs")
       │
       ├── ParseArguments(&argc, &argv, ...)    java.c:1301
       │     ├── -Dkey=value → AddOption()
       │     ├── -cp / -classpath → SetClassPath()
       │     ├── -jar app.jar → parse_manifest.c::ParseManifest()
       │     ├── -m module/class → 模块模式
       │     ├── -X 前缀 → JVM option (通过 _JAVA_OPTIONS 传)
       │     └── wildcard.c → 展开 classpath 通配符 "lib/*.jar"
       │
       ├── JVMInit() / ContinueInNewThread()    java_md_solinux.c
       │     └── 在新线程中调 ifn.CreateJavaVM → 进入 HotSpot
       │
       └── LoadMainClass() + GetStaticMethodID("main") + CallStaticVoidMethod
             → 执行 main() 方法
```

## 基本元素分解

1. **JLI_Launch** — libjli 唯一入口函数。`java` 命令的 `main()` 直接调用它。参数：argc/argv（命令行）、jargc/jargv（`_JAVA_OPTIONS` 等预装参数）、appclassc/appclassv（应用 classpath）。`java.c:242`

2. **CreateExecutionEnvironment** — 平台相关函数。定位 JRE 安装路径：读 `/proc/self/exe` → 找到 `java` 二进制位置 → 回溯 `../lib/` → 找 `jvm.cfg`（JVM 配置）。设置 `LD_LIBRARY_PATH` 使 dlopen 能定位 libjvm.so 及其依赖。`java_md_solinux.c:304`

3. **LoadJavaVM** — dlopen/dlsym 加载 JVM。`dlopen(jvmpath, RTLD_NOW+RTLD_GLOBAL)` 加载 libjvm.so → `dlsym` 获取三个 JNI 接口函数：`JNI_CreateJavaVM`、`JNI_GetDefaultJavaVMInitArgs`、`JNI_GetCreatedJavaVMs`。存入 `InvocationFunctions` 结构。`java_md_solinux.c:553`

4. **ParseArguments** — 命令行参数解析。四种模式：`-jar`（JAR 模式→调用 `ParseManifest`）、`-m`（模块模式→`java.base` 起点）、class（直接类名→拼接 CLASSPATH）、source（源文件模式→编译+执行）。`-D` 系统属性存为 `JVM option`、`-X` 前缀直接传 JVM。`java.c:1301`

5. **Args 模块** — `args.c` 处理参数文件（`@file` 语法→从文件读取额外参数）、`--module-path`/`--add-modules` 等长选项。支持 @argfile 中递归引用其他 argfile（最多 16 层嵌套）。`args.c`

6. **ParseManifest** — JAR MANIFEST.MF 解析。读 `META-INF/MANIFEST.MF` → 找到 `Main-Class: com.example.App` → 设定 main_class。也支持 `Class-Path: lib/dep.jar`（JAR 内嵌 classpath）。不处理签名（签名验证在运行时）。`parse_manifest.c`

7. **Wildcard** — classpath 通配符展开。`java -cp "lib/*"` 时，`JLI_WildcardExpandClasspath()` 用 `readdir()` 遍历 lib/ → 过滤 `*.jar` → 拼接完整 classpath。通配符仅匹配 `.jar` 文件——不递归子目录。`wildcard.c`

8. **SetJvmEnvironment** — JVM 环境变量设置。将解析后的 classpath、模块路径、JVM options 写入 `CLASSPATH`、`_JAVA_OPTIONS` 等环境变量——JVM 启动时从环境变量读。`java.c:826`

9. **SelectVersion** — JDK 版本选择。处理 `-version:1.8` 类请求→在 `jvm.cfg` 中查找匹配版本→递归调用 `JLI_Launch` 用新 JVM 路径重启。JDK9+ 仅支持 `-version:1.9+`（旧版本被拒绝）。

## 标记问题（≥5）

1. **[设计决策] 为什么 libjli 不链接 libjvm.so 而用 dlopen？** — 允许多 JVM 版本共存（`-version:1.8` 指定不同版本的 libjvm.so）。代价是 JNI 函数指针需要通过 dlsym 获取——函数调用多一层间接跳转（但接口函数只调一次，开销可忽略）。`java_md_solinux.c:559`

2. **[平台抽象] CreateExecutionEnvironment 怎么知道 JVM 在哪？** — `/proc/self/exe` readlink 找到 `java` 二进制 → 去符号链接 → 回溯父目录 → 构造 `$JAVA_HOME/lib/` 路径 → 找 `jvm.cfg` → 读 `-server KNOWN` 行 → 拼接 `lib/server/libjvm.so`。这个逻辑在每次 `java` 启动时执行。`java_md_solinux.c:304-450`

3. **[参数处理] ParseArguments 为什么在 LoadJavaVM 之后？** — 因为参数解析需要知道 JVM path（`-J` 选项传给 JVM 的参数在加载前处理）。但主参数解析在 LoadJavaVM 之后——允许 JVM 选项影响参数解析（如 `-Djava.class.path`）。这是顺序敏感的：`CreateExecutionEnvironment`→`LoadJavaVM`→`ParseArguments`。`java.c:297-344`

4. **[JAR 模式] ParseManifest 的鲁棒性** — `MANIFEST.MF` 格式要求每行≤72字节、续行以空格开头。`parse_manifest.c` 处理了续行拼接、空行分隔 section、`Main-Class` vs `mainclass` 大小写兼容。但 `Class-Path` 中空格分隔的多个 JAR 路径→相对路径解析依赖当前工作目录。`parse_manifest.c`

5. **[varg 文件] @ 参数文件的递归深度限制** — `args.c` 支持 `@/path/to/args` 读取参数文件——文件中每行一个参数、`#` 开头为注释。支持递归（文件中引用另一个 @file），但深度限制为 `MAX_ARGFILES`=`16`。超过 → "too many @ files specified" 错误退出。`args.c`

6. **[通配符] classpath 通配符只展开 .jar** — `wildcard.c` 的 `isJarFileName()` 检查 `.jar` 后缀——不展开 `.zip`（即使 ZIP 也是有效 classpath）、不展开子目录、不展开 `.class` 文件。这是一个"只做一件事"的简单设计。`wildcard.c`

7. **[跨域] JLI_Launch 和 HotSpot 的边界** — `JVMInit()`（或 `ContinueInNewThread`）调用 `ifn.CreateJavaVM(&vm_args)` 后——控制权完全进入 HotSpot。libjli 的剩余职责：(1) `LoadMainClass()` 通过 FindClass 找 main 类，(2) `GetStaticMethodID(mainClass, "main", ...)` 找 main 方法，(3) `CallStaticVoidMethod` 调用 main。这三个调用都在 JVM 内部——libjli 只是驱动。
