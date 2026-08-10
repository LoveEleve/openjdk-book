# Launcher (libjli.so) — 文章大纲

> vol-06 · 域 39 · 🟡 B | JDK Native | 基于 Pass 0+1
> Pass 1 产出：9 基本元素 / 7 标记问题
>
> **→ 从卷 01**：卷 01 从 `JNI_CreateJavaVM` 开始讲 HotSpot——但谁调了它？`java` 命令的 `main()` → `JLI_Launch()` → dlopen JVM → `CreateJavaVM`。Launcher 篇。

## 概念依赖

先修：卷 01 OS 抽象层（dlopen/dlsym 是 POSIX API）、JNI 层（`JNI_CreateJavaVM` / FindClass / GetStaticMethodID / CallStaticVoidMethod 均在此域）。

Launcher 是 JVM 的大门——它是 JDK 侧唯一直接调用 `JNI_CreateJavaVM` 的代码，也是 Java 程序执行前"最后一段 C 代码"。

## 叙事计划

**开篇场景**：`bash$ java -jar app.jar`。在 `app.main()` 被执行之前，`java` 二进制中的 `JLI_Launch()` 要完成五件事：找到 JVM → 加载 JVM → 解析参数 → 创建 JVM → 调用 main。全程不到 50ms，但包含了动态链接、文件 I/O、字符串解析、JNI 调用的完整链条。

**第一层：JLI_Launch — java.c 的五步流水线**

`JLI_Launch()`（`java.c:242`）是 libjli 的唯一入口——没有其他函数。五步：

1. `SelectVersion()`（:295）：检查 `-version:1.x` → 在 jvm.cfg 中找匹配版本 → 递归调用 JLI_Launch 重启
2. `CreateExecutionEnvironment()`（:297）：平台相关——Linux 上 `readlink("/proc/self/exe")` → 找到 `java` 二进制位置 → 回溯 `../lib/` → 定位 `libjvm.so` 路径 → 设置 `LD_LIBRARY_PATH`
3. `LoadJavaVM()`（:313）：`dlopen(libjvm.so, RTLD_NOW+RTLD_GLOBAL)` → `dlsym` 获取 `JNI_CreateJavaVM` / `JNI_GetDefaultJavaVMInitArgs` / `JNI_GetCreatedJavaVMs`
4. `ParseArguments()`（:344）：解析 `-cp/-jar/-D/-X/-m/--module-path` → 产出 `main_class` + JVM options
5. `JVMInit()` → `CreateJavaVM` → `LoadMainClass(FindClass)` → `GetStaticMethodID("main")` → `CallStaticVoidMethod`

关键设计：步骤 2-4 的顺序不是任意的——`CreateExecutionEnvironment` 必须先于 `LoadJavaVM`（需要知道 libjvm.so 在哪），`LoadJavaVM` 必须先于 `ParseArguments`（`-J` 选项的参数在加载 JVM 后处理）。

**第二层：CreateExecutionEnvironment — "libjvm.so 在哪？"**

`CreateExecutionEnvironment()`（`java_md_solinux.c:304`）是平台相关的路径查找。核心逻辑：

1. `readlink("/proc/self/exe", ...)` → 读 `java` 二进制路径（可能含符号链接）
2. `realpath()` → 去符号链接 → 得到真实路径（如 `/usr/lib/jvm/jdk-11/bin/java`）
3. 回溯两级目录 → `../lib/` → 构造 `$JAVA_HOME/lib/`
4. 读 `jvm.cfg`（文本配置：`-server KNOWN` / `-client IGNORE`）
5. 拼接 libjvm.so 全路径：`$JAVA_HOME/lib/server/libjvm.so`
6. 设置 `LD_LIBRARY_PATH`——确保 dlopen 能解析 libjvm.so 的依赖（如 libjava.so）

设计洞察：`/proc/self/exe` 不是"总是正确"——Docker 容器中 `/proc/self/exe` 可能指向宿主机路径。这是 `JAVA_HOME` 环境变量存在的根本原因：绕过 `/proc/self/exe` 的不确定性。

**第三层：LoadJavaVM — dlopen + dlsym 的三指针**

`LoadJavaVM()`（`java_md_solinux.c:553`）：

```c
libjvm = dlopen(jvmpath, RTLD_NOW + RTLD_GLOBAL);    // :559
ifn->CreateJavaVM = dlsym(libjvm, "JNI_CreateJavaVM");  // ~:600
ifn->GetDefaultJavaVMInitArgs = dlsym(libjvm, "JNI_GetDefaultJavaVMInitArgs");
ifn->GetCreatedJavaVMs = dlsym(libjvm, "JNI_GetCreatedJavaVMs");
```

`RTLD_NOW`（立即解析所有符号—启动时知道缺少依赖）+ `RTLD_GLOBAL`（libjvm 的符号对所有后续 dlopen 可见—JDK agent 库需要）。dlopen 失败的错误消息（`:559-580`）："Error: failed to open `%s`" + `dlerror()`。每条错误消息是 libjli 唯一的用户可见输出——是唯一的"UI"。

为什么用 dlopen 而不是链接 libjvm？libjli 在编译时不链接 libjvm——`InvocationFunctions` 结构是纯函数指针。这允许 `-version:1.8` 指定不同 JVM 版本（dlopen 不同的 .so）——因为 libjli 没有任何 libjvm 的符号依赖。

**第四层：ParseArguments — 五种启动模式的分发**

`ParseArguments()`（`java.c:1301`）解析剩下的命令行，分发到五种模式：

| 模式 | 触发 | 主类来源 |
|------|------|------|
| JAR | `-jar app.jar` | `parse_manifest.c` 读 `MANIFEST.MF` → `Main-Class` |
| 模块 | `-m java.base/...` | 模块名/类名直接指定 |
| 类名 | `com.example.Main` | CLASSPATH 中搜索 `.class` |
| 源文件 | `Main.java` (JDK11+ JEP 330) | 编译→内存→执行 |
| 参数文件 | `@args.txt` | 从文件读额外参数 → 递归展开（深度≤16，`args.c`） |

关键子模块：
- `-Dkey=value` → `AddOption()` 存到 `_JAVA_OPTIONS` 环境变量
- `-cp lib/*` → `wildcard.c::JLI_WildcardExpandClasspath()` → `readdir()` 遍历 → 只匹配 `*.jar`
- `parse_manifest.c::ParseManifest()` → 读 `MANIFEST.MF` → 续行拼接（72字节限制） → 提取 `Main-Class` + `Class-Path`

**第五层：main() 的最后一公里**

`JLI_Launch` 的最后三行（`java.c:375-395`）：创建 JVM → 找 main 类 → 调 main 方法——全部通过 JNI 接口完成：

```c
(*ifn->CreateJavaVM)(&jvm, &env, &vm_args);     // 进入 HotSpot
mainClass = (*env)->FindClass(env, main_class);   // JNI FindClass
mainID = (*env)->GetStaticMethodID(env, mainClass, "main", "([Ljava/lang/String;)V");
(*env)->CallStaticVoidMethod(env, mainClass, mainID, args);
```

这三个 JNI 调用发生在 HotSpot 内部——libjli 只是一个"驱动"（知道要调什么但不知道内部实现）。`FindClass` 触发的类加载在 HotSpot 的 ClassLoader 中完成——libjli 不参与。

## 设计权衡

一、**dlopen 动态加载 vs 编译时链接**。dlopen 允许 `-version:1.8` 多版本共存，但代价是函数指针间接调用（`ifn->CreateJavaVM`）——好在 JNI 接口函数只在启动时调用一次，开销可忽略。

二、**环境变量传参 vs API 传参**。`SetJvmEnvironment()` 把 classpath、JVM options 写入环境变量（`_JAVA_OPTIONS`、`CLASSPATH`）→ JVM 从环境变量读。好处是简单（不需要修改 JNI invocation API），代价是环境变量有大小限制（通常 128KB）——超大 classpath 可能溢出。

## 核心悬念

**`java Main` 到 `main()` 之间 50ms——谁找到了 JVM、加载了它、解析了你的 `-jar` 和 `-Dfile.encoding=UTF-8`？libjli.so 的 `JLI_Launch()` → CreateExecutionEnvironment → dlopen → ParseArguments → CreateJavaVM → FindClass → main() 的七步链条。**

→ 下一域：JVM 加载完毕、main 类确定——但 `.class` 文件的字节从哪读？JAR 文件 / jimage 镜像的物理 I/O 层。

## 预估

1 篇，5 层递进 + 2 设计权衡，2000-2600 行。
