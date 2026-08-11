# 域 40: Launcher (libjli.so) — 知识规划

> 源码: share/native/libjli/ + unix/native/libjli/ + share/native/launcher/ + unix/native/launcher/ | 21文件/~7960行 | 🟡 大域

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| libjli/java.c (2390行) | **java.c — JVM 启动主流程**: JLI_Launch→ParseArguments→LoadJavaVM(libjvm.so)→InvokeMain(main class), application class path 构建, module system(--module-path), 三种启动模式(class/jar/module) | High |
| libjli/args.c | **args.c — 参数解析**: JLI_AddArgsFromEnvVar, JLI_AddArgsFromAppDir, expand_argv, wildcard expansion, @argfile 支持 | Medium |
| libjli/wildcard.c | **wildcard.c — 通配符展开**: class path wildcard(*→*.jar expansion), directory traversal | Medium |
| libjli/parse_manifest.c | **parse_manifest.c — MANIFEST 解析**: Main-Class 提取 from META-INF/MANIFEST.MF, SplashScreen-Image, JAR manifest attributes | Medium |
| libjli/jli_util.* | **jli_util — 工具函数**: JLI_MemAlloc/JLI_StringDup/JLI_StrTok, OS-specific helpers | Low |
| unix/libjli/java_md_solinux.c | **平台适配 (Unix/Linux)**: CreateExecutionEnvironment→find jvm.cfg→select JVM variant(server/client), LoadJavaVM(dlopen libjvm.so), SetJvmEnvironment, JVM_MAXPATHLEN checks | High |
| unix/launcher/jexec.c | **jexec — 执行 jar**: #!/usr/bin/jexec support, kernel binfmt_misc | Low |

*7 知识点*

## 02 聚合 — P1/P2

### P1 (≥5)
| KP | 出现文件 |
|----|---------|
| Java 启动流程 (parse→load→invoke) | java.c, args.c, unix/java_md_solinux.c, wildcard.c, parse_manifest.c |

### P2 (2-4)
| KP | 出现文件 |
|----|---------|
| 参数展开 (wildcard/argfile) | args.c, wildcard.c |
| 平台 JVM 加载 (dlopen) | unix/java_md_solinux.c, unix/libjsig/ |

### P3 (=1)
| KP | 出现文件 |
|----|---------|
| JLI 工具函数 (MemAlloc/StringDup/StrTok) | jli_util.c |
| MANIFEST 解析 (Main-Class提取) | parse_manifest.c |
| 启动画面 (splash screen) | splashscreen_stubs.c |
| jexec (kernel binfmt_misc) | unix/launcher/jexec.c |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| JLI_Launch → LoadJavaVM → InvokeMain 三阶段 | `java` 命令的完整入口——(1) ParseArguments:解析 classpath/memory options/main class (2) CreateExecutionEnvironment:找 jvm.cfg→选择 server/client→dlopen libjvm.so→dlsym JNI_CreateJavaVM (3) InvokeMain:call main method via JNI。这是 JDK 和 JVM 的唯一启动路径——没有 libjli→JVM 不能用 |

### 🟡 Working (2 KP)
| KP | 为什么 🟡 |
|----|---------|
| Wildcard + argfile | 通配符展开 `lib/*`→逐个.jar；@argfile逐行读取展开参数——但选JVM变体+启动是主流程的子流程 |
| MANIFEST 解析 | parse_manifest.c 提取 META-INF/MANIFEST.MF 中 Main-Class——但仅用于 `java -jar` 模式 |

### 🟢 Surface (3 KP)
| KP | 为什么 🟢 |
|----|---------|
| JLI 工具函数 | jli_util.c 的 JLI_MemAlloc/JLI_StringDup——简单 C 包装器，无算法复杂度 |
| 启动画面 | splashscreen_stubs.c——Java 层真正实现，C 侧仅有环境变量桩 |
| jexec | unix/launcher/jexec.c——Unix kernel binfmt_misc 集成，极边缘用例 |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | Java 启动流程 | "`java MyApp` 在命令行后发生了什么事？" |
| 2 | 参数解析 + 平台加载 | "classpath 通配符 * 怎么展开？jvm.cfg 怎么选 server/client？" |

**聚类决策**: 将"参数解析"和"平台JVM加载"合并为第2篇——两者共享相同的数据流(参数→env→选JVM变体→dlopen)，分开反而断链。第1篇是纯三阶段管道(parse→load→invoke)，是教学入口。
