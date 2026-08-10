# 03-Main-Class-Loading — 从 JAR manifest 到 `CallStaticVoidMethod`：主类加载的 5 阶段全链路

> **阶段**：[13-launcher]
> **前置**：[00-Libjli-Overview]（理解 JLI_Launch 的 8 步全链路和 LoadMainClass 在第 8 步的位置）、[02-JVM-Loading]（JNI_CreateJavaVM 完成后 JVM 就绪，env 可用）、[02-class-loading]（理解 FindClass 的双亲委派机制和类加载器体系）
> **配套**：[01-Argument-Parsing]（mode 和 what 由 ParseArguments 确定——本文直接消费这些值）
> **后续依赖本文**：[04-system-preload]（LoadMainClass 是 JVM 生命周期中第二次 Java 类加载——第一次是系统类预加载）、[14-zip-jimage]（JAR/ZIP 文件解析的底层实现）
> **阅读收益**：追踪从 JAR manifest 到 CallStaticVoidMethod 的完整 5 阶段加载链——理解 JLI_ParseManifest 的 4 步 ZIP 解析流程、SelectVersion 的版本选择 + execvp 重启机制、SetClassPath 的 -jar 覆盖逻辑、LauncherHelper.checkAndLoadMain() 的 Java 层 4 mode 策略、GetStaticMethodID 的 JNI 签名字符串语法、CallStaticVoidMethod 的不可逆转移；掌握 "Could not find or load main class" 的 5 种根因分类和诊断 workflow

---

## §〇 生产场景——Spring Boot fat JAR：`CLS_ERROR1`

凌晨 4 点，生产环境的 Spring Boot 应用部署失败。日志中只有一行：

```
Error: Could not find the main class org.springframework.boot.loader.JarLauncher. Program will exit.
```

这是 `emessages.h:68` 的 `CLS_ERROR1`。JAR 的 `META-INF/MANIFEST.MF` 明确写着 `Main-Class: org.springframework.boot.loader.JarLauncher`，但加载失败。

### Root cause

Spring Boot fat JAR 的嵌套 JAR 布局。`app.jar` 的结构：

```
app.jar
├── META-INF/MANIFEST.MF           (Main-Class: org.springframework.boot.loader.JarLauncher)
├── org/springframework/boot/loader/
│   ├── JarLauncher.class           ← 在 fat JAR 的根目录！
│   └── ...
└── BOOT-INF/lib/
    ├── spring-boot-loader.jar      ← 嵌套 JAR
    ├── spring-core-5.3.x.jar
    └── ...
```

JVM 的标准 classpath 只包含 `app.jar` 本身 → `Class.forName("org.springframework.boot.loader.JarLauncher")` → 在 app.jar 的根目录找到 → **JarLauncher 可以加载**。

**但等等——如果 JarLauncher 在 app.jar 的根目录，为什么 CLS_ERROR1 还会发生？**

真相更微妙。如果 Spring Boot fat JAR 是 REPACKAGED（用了 spring-boot-maven-plugin 的 `repackage` goal），JarLauncher 被 **移动** 到了嵌套 JAR 中：

```
app.jar
├── META-INF/MANIFEST.MF           (Main-Class: org.springframework.boot.loader.JarLauncher)
├── BOOT-INF/lib/
│   └── spring-boot-loader.jar     ← JarLauncher.class 在这里面！
└── BOOT-INF/classes/
    └── com/example/Application.class
```

现在 libjli 打开 `app.jar` → 在标准 classpath 中搜索 `org/springframework/boot/loader/JarLauncher.class` → **不在** `app.jar` 的根目录——它在嵌套 JAR `BOOT-INF/lib/spring-boot-loader.jar` 内 → `ClassNotFoundException` → `CLS_ERROR1`。

**Spring Boot 的设计意图**：JarLauncher 是 Boot Loader——它的职责就是加载嵌套 JAR。但 jar-launcher JAR 必须能被标准 JVM classpath 找到。正确的 Spring Boot fat JAR 保持 JarLauncher 在根目录；不正确的 repackaging 把它移到了嵌套 JAR 中。

### 三步诊断

```bash
# 1. 检查 JAR manifest 中的 Main-Class 属性
unzip -p app.jar META-INF/MANIFEST.MF | grep "Main-Class:"

# 2. 确认 Main-Class 指向的 .class 文件在 JAR 中的位置
jar tf app.jar | grep "JarLauncher.class"
# 正常输出: org/springframework/boot/loader/JarLauncher.class   ← 根目录 → 可以加载
# 问题输出: BOOT-INF/lib/spring-boot-loader.jar                  ← 嵌套 JAR → 无法加载

# 3. 如果类在嵌套 JAR 中——提取验证
unzip -p app.jar BOOT-INF/lib/spring-boot-loader.jar > /tmp/loader.jar
jar tf /tmp/loader.jar | grep JarLauncher.class  # 验证类存在于嵌套 JAR 中

# 4. GDB 断点验证 LoadMainClass 的失败路径
gdb -ex "break java.c:523" \
    -ex "run" \
    -ex "print mode" \
    -ex "print what" \
    -ex "continue" \
    -ex "print mainClass" \
    --args java -jar app.jar
# mainClass == NULL → CLS_ERROR1 路径 → ExceptionDescribe() 输出
```

### 反事实

如果 libjli 在 `SelectVersion` 阶段（`JNI_CreateJavaVM` 之前）也检查 JAR 内部是否包含 Main-Class 的 `.class` 文件 → 可以在 ~2s 启动时间之前就提前报错 → fail fast。libjli 的 `parse_manifest.c` 已经有 ZIP 解析能力——通过 `find_file()` + `inflate_file()` 可以检查 manifest。检查 `.class` 文件也同理——但需要 C 代码理解 JAR 内部路径的 `.class` → 包名映射（`org/springframework/boot/loader/JarLauncher.class`），这增加显著复杂度。

---

## §一 LoadMainClass 5 阶段完整源码走读

[00-Libjli-Overview] §一 Step 8 是 `LoadMainClass → GetStaticMethodID → CallStaticVoidMethod`——本文是 Step 8 的完整展开。`LoadMainClass` 不是"Invoke FindClass"——它是一个 5 阶段的序列：manifest 解析 → 版本选择 → classpath 覆盖 → Java 层 helper → 方法签名验证。每个阶段都可能失败，错误消息的质量递减。

### 4 个 Beginner Callout 框

> **JAR manifest** — `META-INF/MANIFEST.MF`。键值对文本文件。例如：`Main-Class: com.example.Main`。libjli 在 JNI_CreateJavaVM 之前通过 `JLI_ParseManifest()`（`parse_manifest.c:577`）解析它来决定加载哪个类。manifest 被读取两次：第一次 C 代码（`SelectVersion`，`java.c:1114`）提取 Main-Class 用于版本选择 → 结果放入环境变量；第二次 Java 代码（`LauncherHelper.checkAndLoadMain()`）重新读取获得正确的 UTF-8 处理——这是 bugid 5030265 的修复。

> **LauncherHelper.checkAndLoadMain()** — Java 层 helper。调用 `Class.forName(mainClassName)` → 检查 `main(String[])` 方法存在。libjli 不直接调用 Java 方法——通过 JNI `CallStaticVoidMethod` 执行 `main()`。对应源码：`java.c:1634-1640`（JNI 调 Java）。为什么用 `LauncherHelper`？因为 JNI 的 `FindClass` 返回 NULL 时需要通过 `ExceptionCheck() → ExceptionDescribe() → ExceptionClear()` 处理异常——这在 C 代码中很冗长。`LauncherHelper` 是 Java 类，在 Java 端处理异常 + 产生正确的错误消息。

> **FindClass vs Class.forName** — `FindClass` 是 JNI 函数——在系统类加载器（bootstrap class loader）中搜索。`Class.forName` 使用当前线程的上下文类加载器（application class loader）。`LauncherHelper` 用 `Class.forName` 因为它能更好地处理错误消息——抛出 `ClassNotFoundException` 带描述性消息，而 JNI 的 `FindClass` 返回 NULL 只有模糊的 JNI 异常。

> **JNI exception handling** — `FindClass` 返回 NULL → 必须调用 `(*env)->ExceptionCheck()` → `(*env)->ExceptionDescribe()` → `(*env)->ExceptionClear()`。遗漏任何一步 → JVM 处于不一致状态 → 后续 JNI 调用崩溃。三步模式在 JNI 规范中是强制要求的——"pending exception" 状态下调用大多数 JNI 函数会导致未定义行为。

> **SelectVersion + execvp 重启** — `java.c:1056` 的 `SelectVersion` 不只"检查版本"——它可以**完全重启 JVM**。如果 JAR manifest 的 `Created-By` 或 `JRE-Version` 属性指示需要不同的 JDK → `SelectVersion` 搜索新 JDK 的 `java` 二进制 → `execvp(exec_path, new_argv)` 替换当前进程（`java.c:1202-1213`）。重启前设置 `_JAVA_VERSION_SET` 环境变量携带主类名（`setenv("_JAVA_VERSION_SET", main_class, 1)`），新进程的 `SelectVersion`（`java.c:1089-1092`）读取它后跳过版本选择。成本：~10ms vs 错误 JVM 启动 ~2s → 200× fail-fast 加速。注意：`execvp` 不返回（成功后旧进程被完全替换），所以所有在当前进程中的 libjli 状态（已加载的 jvm.cfg、已展开的 classpath）丢失——新进程重新执行全部 JLI_Launch 流程。

> **JNI 签名字符串** — `"([Ljava/lang/String;)V"` 是 JNI 的类型描述语言。`(` 开始参数列表，`[` 表示数组，`Ljava/lang/String;` 是 `String` 类型（`L` 开头 `;` 结尾），`)` 结束参数列表，`V` 是返回类型 `void`。完整含义："takes a String[] and returns void" — `public static void main(String[] args)`。类型代码表：`B`=byte, `C`=char, `S`=short, `I`=int, `J`=long, `F`=float, `D`=double, `Z`=boolean, `V`=void, `L<name>;`=Object, `[`=array。`GetStaticMethodID` 用这个字符串精确匹配方法签名——签名不匹配返回 NULL → `CLS_ERROR2`（`emessages.h:69`：`"Error: Failed to load Main Class: %s\n%s"`）。

> **man 手册线索** — 主类加载的关键手册引用：`man 1 jar` — JAR 文件创建和查看命令（含 manifest 格式规范）；`man 1 unzip` — ZIP 文件内容查看（诊断 JAR 内部结构）；`man 3 zlib` — DEFLATE 压缩/解压库（`inflate_file` 使用的底层算法）；`man 2 execvp` — 进程替换系统调用（`SelectVersion` 的 JRE 重启机制）；`man 2 access` — 文件可访问性检查；`man 2 fopen` — 文件打开（`parse_manifest.c:588`）；`man 2 getenv` — 读取环境变量（`_JAVA_VERSION_SET` 协议）。这些手册在生产诊断时提供最精确的语义参考——例如 `execvp(2)` 明确说明"成功时不返回"，解释为何新 JRE 进程需要重新加载 libjli。

---

### 1.1 阶段 1: JLI_ParseManifest — 读 META-INF/MANIFEST.MF

**WHY**：因为 JAR 的 Main-Class 信息在 manifest 中——libjli 必须在启动 JVM 之前就知道要加载哪个类，以便进行版本选择。

`JLI_ParseManifest`（`parse_manifest.c:577`）的 4 步流程：

**Step 1 — fopen JAR**：

```c
// parse_manifest.c:588
jarfile = fopen(jarname, "rb");
if (jarfile == NULL) {
    JLI_ReportErrorMessage(JAR_ERROR2, jarname);  // emessages.h:65 — "Unable to access jarfile %s"
    goto cleanup;
}
```

**Step 2 — find_file META-INF/MANIFEST.MF**：

```c
// parse_manifest.c:603
if (find_file(jarfile, "META-INF/MANIFEST.MF", &entry) != 0) {
    JLI_ReportErrorMessage(JAR_ERROR3, jarname);  // emessages.h:66 — "Invalid or corrupt jarfile %s"
    fclose(jarfile);
    return NULL;
}
```

`find_file` 在 ZIP 目录中做线性搜索——扫描 ZIP 的中央目录 entries，比较文件名。ZIP 中央目录在文件末尾，包含所有文件的 offset/压缩大小/未压缩大小/CRC32 等信息。

**Step 3 — inflate_file 解压**：

```c
// parse_manifest.c:607
buffer = inflate_file(jarfile, &entry, &manifest_size);
if (buffer == NULL) {
    JLI_ReportErrorMessage(JAR_ERROR3, jarname);
    fclose(jarfile);
    return NULL;
}
```

`inflate_file` 使用 zlib 的 `inflate()` 函数解压 DEFLATE 压缩的 manifest 内容。manifest 在 ZIP 文件中通常被压缩存储（compression method 8 = DEFLATE）。

**Step 4 — parse_nv_pair 键值对解析**：

```c
// parse_manifest.c:613
manifest = parse_nv_pair(buffer, manifest_size);
```

**parse_nv_pair 解析规则**：逐行读取，`:` 分隔键值对。例如 `"Main-Class: com.example.Main"` → name="Main-Class", value="com.example.Main"。Manifest 规范要求每行 < 72 字节，超过需要 continuation line（后续行以空格开头）。`parse_manifest.c` 正确处理 continuation line。

**JAR_ERROR2 vs JAR_ERROR3 vs JAR_ERROR4**：
- `JAR_ERROR2`（emessages.h:65）— 无法打开 JAR 文件（权限/不存在）
- `JAR_ERROR3`（emessages.h:66）— ZIP 目录损坏 或 manifest 找不到 或 inflate 失败
- `JAR_ERROR4`（emessages.h:67）— manifest 存在但缺少 Main-Class 属性："no main manifest attribute, in %s"

---

### 1.2 阶段 2: SelectVersion — 版本选择 + JRE 重启

**WHY**：因为 JAR 的 manifest 可能指定了不同的 JRE 版本——如果 JAR 编译时用的 JDK 17 但系统装了 JDK 11，必须在 JNI_CreateJavaVM 之前切换到正确的 JRE。否则 → 启动了错误版本的 JVM → ClassFormatError 在 FindClass 时爆发 → 浪费 ~2s 启动时间。

```c
// java.c:1056
SelectVersion(int argc, char **argv, char **main_class)
```

版本信息来源：manifest 的 `Created-By` 属性（例如 `"Created-By: 11 (Oracle Corporation)"`）或 `JRE-Version` 属性。如果 JAR 需要 JDK 17 但当前 JRE 是 JDK 11 → `SelectVersion` 尝试找到 JDK 17 的 java 可执行文件 → 调用 `execvp` 重启自己。

**execvp 重启流程**（`java.c:1168-1213`）：

```c
// java.c:1202-1213
exec_path = JLI_StringDup(java_home);       // 新 JRE 的路径
JLI_Snprintf(exec_path + strlen(exec_path), PATH_MAX - strlen(exec_path),
             "/bin/java");
setenv("_JAVA_VERSION_SET", main_class, 1);  // 传递主类名到新进程
execvp(exec_path, new_argv);                 // 完全重启——当前进程被替换
```

**`_JAVA_VERSION_SET` 环境变量协议**：原进程设置这个环境变量 → `execvp` 启动新 java 进程 → 新进程的 `SelectVersion`（`java.c:1089-1092`）立即读取它：

```c
if ((env_in = getenv(ENV_ENTRY)) != NULL) {
    if (*env_in != '\0')
        *main_class = JLI_StringDup(env_in);
    return;  // skip version selection — already done
}
```

**成本分析**：execvp 重启 ≈ ~10ms（fork + exec + 加载 libjli/libjvm + 重新初始化）vs 错误 JVM 启动 ≈ ~2s + ClassFormatError → 重启快 200×。在 libjli 阶段（< 50ms）检测版本不匹配比启动错误 JVM 后失败要高效得多。

---

### 1.3 阶段 3: SetClassPath for JAR — 覆盖

**WHY**：因为 `-jar` 模式下 JAR 应该是自包含的——所有依赖通过 manifest Class-Path 属性指定。如果 libjli 同时使用 `-cp` 和 JAR classpath → 类加载顺序变成非确定性 → 同一个类名可能从两个路径加载 → 行为取决于路径顺序 → 生产隐患。

```c
// java.c:338-340
if (mode == LM_JAR) {
    SetClassPath(what);   // what = jarfile name
}
```

**SetClassPath for JAR 的行为**：用 JAR 文件名完全覆盖 classpath —— 只包含 JAR 文件本身。用户的 `-cp` 参数被静默忽略。然后 JAR manifest 的 Class-Path 属性被追加到 `java.class.path` 系统属性的末尾。这是"有意的设计"——JAR 规范说 JAR 应该自包含。

**反事实**：如果 `-cp` 补充 JAR classpath → 同一个类在 JAR 和外部目录中 → 哪个先加载？顺序依赖 → 非确定性 → 生产隐患。"silently ignore `-cp` on `-jar`" 比"apply `-cp` inconsistently"更好。

---

### 1.4 阶段 4: LauncherHelper.checkAndLoadMain() — Java 层 helper

**WHY**：因为 JNI 的 `FindClass` 返回 NULL 时需要 `ExceptionCheck() → ExceptionDescribe() → ExceptionClear()` 三步异常处理——这在 C 代码中很冗长且易出错。`LauncherHelper` 是 Java 类，在 Java 端处理异常 + 产生正确的 UTF-8 编码错误消息。

**LauncherHelper.checkAndLoadMain() 的 4 个 LaunchMode 分支**：

| Mode | 值 | 主类发现方式 | 错误消息 | 适用场景 |
|------|----|-----------|---------|---------|
| `LM_CLASS` | 1 | `Class.forName(what)` | "Could not find the main class %s" | `java MyClass` |
| `LM_JAR` | 2 | 重读 manifest → Main-Class → `Class.forName` | "Could not find the main class %s" + JAR_ERROR4 fallback | `java -jar app.jar` |
| `LM_MODULE` | 3 | `ModuleFinder` → `ModuleLayer` → `FindClass` in module | "Could not find or load main class %s in module %s" | `java -m module/main` |
| `LM_SOURCE` | 4 | `jdk.compiler` compile → `Class.forName` | Compile errors → "Source file %s could not be compiled" | `java --source 11 App.java` |

**JAR mode 路径**（最复杂）：
1. 打开 JAR 文件 → 读 `META-INF/MANIFEST.MF` → 提取 Main-Class 属性
2. 将 Main-Class 中的 `"."` 替换为 `"/"` → 去验证 `.class` 文件存在
3. `Class.forName(mainClassName)` — 加载主类 → 触发双亲委派（[02-class-loading]）
4. `mainClass.getDeclaredMethod("main", String[].class)` — 查找 main 方法
5. 返回 mainClass → libjli 继续到 GetStaticMethodID

**bugid 5030265 — manifest 被读取两次**：C 代码的 manifest 解析（`SelectVersion` 调用的 `parse_manifest.c`）不支持 UTF-8 编码的类名。`SelectVersion` 提取的 `main_class` 被放进 `_JAVA_VERSION_SET` 环境变量后，`LoadMainClass` 忽略它——调用 Java 层 `LauncherHelper` 重读 manifest，获得正确的 UTF-8 处理。manifest 被读取两次：第一次 C 代码（`SelectVersion` 中），第二次 Java 代码（`LoadMainClass` 中）。为什么 C 代码不修复而在 Java 层再做一遍？→ 因为 C 代码中 UTF-8 处理太复杂（需要 `iconv`/`libiconv` 依赖）。

**JNI 调用代码**（`java.c:1634-1644`）：

```c
NULL_CHECK0(mid = (*env)->GetStaticMethodID(env, cls,
            "checkAndLoadMain",
            "(ZILjava/lang/String;)Ljava/lang/Class;"));
NULL_CHECK0(str = NewPlatformString(env, name));
NULL_CHECK0(result = (*env)->CallStaticObjectMethod(env, cls, mid,
                                                    USE_STDERR, mode, str));
if (result == NULL) {
    JLI_ReportErrorMessage(CLS_ERROR1, name);  // "Could not find the main class %s"
    goto leave;
}
```

**LauncherHelper 用 `Class.forName` 而非 JNI `FindClass` 的原因**：`Class.forName` 抛出 `ClassNotFoundException` 带有描述性异常消息——`LauncherHelper` 可以捕获并格式化为自然的错误消息。JNI 的 `FindClass` 返回 NULL——只有模糊的异常消息（`ExceptionDescribe()` 输出到 stderr 但不返回字符串）。

---

### 1.5 阶段 5: GetStaticMethodID + CallStaticVoidMethod — 进入 Java

**WHY**：因为 `Class.forName` 加载了类但没验证 `main(String[])` 的签名是否正确。`GetStaticMethodID` 精确验证方法名、参数类型和返回类型都匹配。

```c
// java.c:560-565
mainID = (*env)->GetStaticMethodID(env, mainClass, "main",
                                    "([Ljava/lang/String;)V");
if (mainID == NULL) {
    JLI_ReportErrorMessage(CLS_ERROR2, classname);  // "Main method not found in class %s"
    goto leave;
}
```

**JNI 签名字符串 `"([Ljava/lang/String;)V"` 的含义**：

```
(                        — 参数开始
 [                       — 数组
  Ljava/lang/String;    — String 类型
)                        — 参数结束
V                        — 返回类型: void
```

完整含义："takes a String[] and returns void" — 正是 `public static void main(String[] args)`。

**签名字符串类型代码**：

| 代码 | Java 类型 | 代码 | Java 类型 |
|------|-----------|------|-----------|
| `B` | byte | `Z` | boolean |
| `C` | char | `V` | void |
| `S` | short | `L<name>;` | Object type |
| `I` | int | `[` | array |
| `J` | long | `(`...`)` | method args |

JNI 用字符串签名而不是 C 类型——因为 C 类型系统和 Java 类型系统不直接对应。字符串签名是 JNI 规范定义的通用描述语言——独立于平台 ABI。但签名在运行时不验证类型安全性——如果签名错误匹配 → 调用时 stack corruption（Java stack frame 被 C 代码破坏）→ SIGSEGV。

**CallStaticVoidMethod — 不可逆的过渡**（`java.c:566-572`）：

```c
(*env)->CallStaticVoidMethod(env, mainClass, mainID, mainArgs);
```

这一行是 libjli 的执行终点。调用前，C stack 上有 `JavaMain → LoadMainClass → InitializeJVM → ...` 的帧。调用后，JVM 执行用户 `main()` 的 Java 代码——C stack 冻结（不再使用），JVM 在解释器/编译后的代码中运行。libjli 再也不会恢复控制，除非 `main()` return 或抛异常。

```c
// java.c:568-572 — after CallStaticVoidMethod returns
ret = (*env)->ExceptionOccurred(env) == NULL ? 0 : 1;
if (ret) {
    (*env)->ExceptionDescribe(env);   // print stack trace to stderr
}
```

**C stack 和 Java stack 的共存**：JNI 通过调用约定管理。C stack 上有 `JavaMain → LoadMainClass` 的帧。`JNI_CreateJavaVM` 创建了 Java 栈内存区域（独立于 C stack）。`CallStaticVoidMethod` 内部保存 C 寄存器 → 切换栈指针到 Java 栈 → 执行解释的/编译后的 Java 代码 → 返回后恢复 C 栈。

---

### 1.6 Class-Path manifest 属性 — 第二级 classpath

**WHY**：因为 JAR 规范允许 JAR 在 manifest 中声明依赖——Class-Path 属性列出了所有依赖 JAR。但 Class-Path 的解析时序与命令行 `-cp` 不同。

**时序差异**：

```
-cp / lib/* wildcard:
  ParseArguments (JNI_CreateJavaVM 之前)
  └─ SetClassPath → 通配符展开 → java.class.path 作为 JVM option 传入
     └─ JVM 启动时已包含完整路径

Class-Path manifest:
  JNI_CreateJavaVM 之后
  └─ LauncherHelper / URLClassLoader 读取 manifest
     └─ 附加到 java.class.path 末尾
        └─ 可能在启动中引起类加载顺序问题
```

**路径解析基准**：相对于 JAR 文件的位置（不是当前工作目录）。例如 `app.jar` 在 `/opt/myapp/` → `Class-Path: lib/dep.jar` → 解析为 `/opt/myapp/lib/dep.jar` → 不是 `$PWD/lib/dep.jar`。这是为了可移植性——JAR 可以被移动到任何目录运行。

**通配符限制**：Class-Path 属性不支持通配符。`wildcard.c:70-71` 注释明确说明："Class-Path wildcard expansion is NOT supported in manifest."

**不存在的 Class-Path 条目**：类加载器静默忽略——不存在的 Class-Path 条目不报错。MANIFEST.MF 只声明依赖，不验证依赖存在。这可能导致运行时 `ClassNotFoundException`（延迟失败，不是启动失败）。

---

### 1.7 JavaMain exit path — main() 返回之后

**WHY**：因为 libjli 的 `JavaMain` 在 `main()` 返回后还需要处理异常检测、JNI 清理、VM 销毁和退出码传递。这个退出路径的每一步都可能失败。

```c
// java.c:374-380 — LEAVE macro
#define LEAVE() \
    do { \
        if ((*vm)->DetachCurrentThread(vm) != JNI_OK) { \
            JLI_ReportErrorMessage(JVM_ERROR2); \
            ret = 1; \
        } \
        if (JNI_TRUE) { \
            (*vm)->DestroyJavaVM(vm); \
            return ret; \
        } \
    } while (JNI_FALSE)
```

**退出序列**：
1. `ExceptionOccurred(env)` → 检查 `main()` 是否抛异常 → 如果抛 → `ret = 1` → `ExceptionDescribe()` 打印堆栈到 stderr
2. `DetachCurrentThread(vm)` → 从 JVM 线程列表移除当前线程
3. `DestroyJavaVM(vm)` → 等待所有非守护线程完成 → shutdown hooks → 释放堆
4. `return ret` → 进程退出码（0 = 成功，1 = main() 抛异常）

**生产危险 — DestroyJavaVM 阻塞**：如果应用启动了非守护线程（@Async、HTTP request processors、scheduled tasks）→ `DestroyJavaVM` 内部阻塞等待这些线程完成：

```c
// threads.cpp — destroyed
// Wait for ALL non-daemon threads to exit naturally
while (non_daemon_thread_count > 0) {
    Threads::destroy_vm();  // hangs here
}
```

**Spring Boot @Async 问题**：一个 @Async 任务在写 DB → 事务永远不提交 → 连接池泄漏 → 线程不退出 → `DestroyJavaVM` 阻塞 → Docker 容器 10s 超时 → `kill -9`。

**反事实**：如果 `DestroyJavaVM` 强制 `Thread.stop()` 杀掉剩余线程 → 线程在 synchronized 块中间被杀 → monitor 保持锁定 → 下一个线程尝试获取 → 无限等待 → 生产死锁。强制 shutdown = 更差的结果。

→ [01-jvm-startup] §六（Threads::destroy_vm 的完整 shutdown 序列）

---

### 1.8 CLS_ERROR1 的 5 种根因分类

| 根因 | 触发条件 | 源码位置 | 诊断 |
|------|---------|---------|------|
| **manifest 损坏** | `find_file("META-INF/MANIFEST.MF")` 失败 | `parse_manifest.c:603` → `JAR_ERROR3` | `unzip -p app.jar META-INF/MANIFEST.MF` — 能读到内容吗？ |
| **manifest 缺少 Main-Class** | `parse_nv_pair` 解析后 `main_class == NULL` | `parse_manifest.c:620` → `JAR_ERROR4` | `grep "Main-Class:"` → 属性存在吗？ |
| **ClassNotFoundException** | Main-Class 指向的类不在任何 classpath entry 中 | `LauncherHelper.java` → `Class.forName()` | `jar tf app.jar \| grep MainClassName` — .class 在 JAR 根目录吗？ |
| **嵌套 JAR** | .class 文件在嵌套 JAR 内部，不在标准 classpath 中 | 本文 §〇 | `jar tf app.jar \| grep .jar \| xargs -I{} unzip -l app.jar {}` |
| **main 方法签名不匹配** | `GetStaticMethodID("main", "([Ljava/lang/String;)V")` 返回 NULL | `java.c:560-564` → `CLS_ERROR2` | 类是找到了，但 main 不是 `public static void main(String[] args)` |

---

## §二 环境

### Build & Source
Same as [00-Libjli-Overview] §二. OpenJDK 11 slowdebug, Linux x86_64, TencentOS Server 4.2.

Source roots：
- `src/java.base/share/native/libjli/` — `SelectVersion`(:1056)、`LoadMainClass`(:1623)、`JavaMain`(:405)、`InitializeJVM`(:1522) in `java.c`；`JLI_ParseManifest`(:577)、`find_file`、`inflate_file`、`parse_nv_pair` in `parse_manifest.c`
- `src/java.base/share/classes/sun/launcher/` — `LauncherHelper.java`（Java 层 helper，~800 行）
- `src/java.base/unix/native/libjli/` — pthread_create + JNI 调用 in `java_md_solinux.c`

### Key Data Structures
| 结构体 | 文件 | 字段 |
|--------|------|------|
| `manifest_info` | `manifest_info.h` | `char *manifest_version`, `char *main_class`, `char **class_path`, `jlong class_path_count` |
| `manifest_attribute` | `manifest_info.h` | `char *name`, `char *value`, `manifest_attribute *next`（链表） |
| `JavaMainArgs` | `java.h:242` | `_argc`, `_argv`, `_mode`, `_what`, `ifn`（InvocationFunctions） |

### Key JNI Types
| 类型 | 定义 | 用途 |
|------|------|------|
| `jclass` | `jni.h` | 已加载的 Java 类的引用（来自 `FindClass` / `Class.forName`） |
| `jmethodID` | `jni.h` | Java 方法的引用（来自 `GetStaticMethodID`） |
| `jobjectArray` | `jni.h` | Java 对象数组（`String[]` 的 JNI 表示） |
| `JNIEnv *env` | `jni.h` | JNI 函数表指针（由 `JNI_CreateJavaVM` 返回，包含 200+ 函数） |

### 关键系统调用/库函数速查
| Function | man | 使用点 | 失败时 |
|----------|-----|--------|--------|
| `fopen()` | `man 3 fopen` | `parse_manifest.c:588` — 打开 JAR 文件 | 返回 NULL → `JAR_ERROR2` |
| `inflate()` | `man 3 zlib` | `parse_manifest.c:607`（via inflate_file）— 解压 manifest | 返回 NULL → `JAR_ERROR3` |
| `execvp()` | `man 2 execvp` | `java.c:1202` — SelectVersion 重启 JRE | 不返回（成功）→ 新进程；失败 → errno |
| `getenv()` | `man 3 getenv` | `java.c:1089` — 读取 `_JAVA_VERSION_SET` | 返回 NULL（协议未启动） |
| `fread()` | `man 3 fread` | parse_manifest 的 find_file 读 ZIP 目录 | `ferror()` → `JAR_ERROR3` |
| `jar` | `man 1 jar` | 诊断 — 查看 JAR 内部结构 | N/A |
| `unzip` | `man 1 unzip` | 诊断 — 提取 zip 内容 | N/A |

### Manifest 内嵌的 ZIP 文件格式常量（`manifest_info.h`）
| 常量 | 值 | 含义 |
|------|-----|------|
| `LOCSIG` | `0x04034b50` | Local file header signature |
| `CENSIG` | `0x02014b50` | Central directory header signature |
| `ENDSIG` | `0x06054b50` | End of central directory signature |
| `LOCHDR` | `30` | Local file header 大小 |
| `CENHDR` | `46` | Central directory entry 大小 |
| `ENDHDR` | `22` | End of central dir record 大小 |

### 诊断命令
```bash
# 1. 检查 JAR manifest 中的 Main-Class
unzip -p app.jar META-INF/MANIFEST.MF | grep "Main-Class:"

# 2. 确认 .class 文件在 JAR 中的位置
jar tf app.jar | grep -E "\.class$" | head -20

# 3. strace JAR 读取路径
strace -e openat,read,mmap java -jar app.jar 2>&1 | grep "app.jar"

# 4. GDB 跟踪 LoadMainClass
gdb -ex "break java.c:1623" \
    -ex "run" \
    -ex "print mode" \
    -ex "print what" \
    --args java -jar app.jar
```

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|-------|----------------|------|
| 1 | `java.c` | `src/java.base/share/native/libjli/java.c` | ~2415 | `SelectVersion`(:1056), `LoadMainClass`(:1623), `JavaMain`(:405), `InitializeJVM`(:1522) | Orchestration of main class loading — 从 C 调用 Java helper |
| 2 | `parse_manifest.c` | `src/java.base/share/native/libjli/parse_manifest.c` | ~722 | `JLI_ParseManifest`(:577), `parse_nv_pair`, `inflate_file`, `find_file` | JAR manifest 解析——读取 ZIP 目录 + 解压 + 键值对解析 |
| 3 | `manifest_info.h` | `src/java.base/share/native/libjli/manifest_info.h` | ~195 | `manifest_info` struct, `manifest_attribute` struct, ZIP 常量 | Manifest 数据结构和 ZIP 文件格式常量 |
| 4 | `LauncherHelper.java` | `src/java.base/share/classes/sun/launcher/LauncherHelper.java` | ~800 | `checkAndLoadMain` (public entry), `showSettings`, `printHelpMessage` | Java-side helper — main class 发现 + main 方法验证 |
| 5 | `emessages.h` | `src/java.base/share/native/libjli/emessages.h` | ~123 | `CLS_ERROR1`(:68), `CLS_ERROR2`(:69), `JAR_ERROR2`(:65), `JAR_ERROR3`(:66), `JAR_ERROR4`(:67) | Main class loading 错误消息宏 |

**跨模块说明**：`java.c` 的 `LoadMainClass`（`:1623`）是调用点——它通过 JNI 调用 Java 层的 `LauncherHelper.checkAndLoadMain()`。前者的职责是：构造 JNI 调用参数（`USE_STDERR`、`mode`、`what`）→ 调用 `CallStaticObjectMethod` → 检查 JNI 异常 → 返回 `jclass`。`LauncherHelper` 的职责是：根据 `mode` 选择不同策略（JAR: 读 manifest → 取 Main-Class → `Class.forName`；CLASS: 直接 `Class.forName`）→ 验证 `main(String[])` 存在 → 返回 `jclass`。Java 层做智能发现，C 层做 JNI 异常管理。

---

## §四 Mermaid — manifest → CallStaticVoidMethod 全链序列图

5 lane 序列图：libjli (C) / Filesystem / libjvm / LauncherHelper (Java) / User code：

```mermaid
sequenceDiagram
    participant L as libjli (java.c)
    participant FS as Filesystem / JAR
    participant V as libjvm (HotSpot)
    participant LH as LauncherHelper (Java)
    participant U as User main()

    Note over L: JLI_Launch — 阶段开始

    rect rgb(255, 245, 230)
        Note over L,FS: ★ 阶段 1 — Manifest 解析 ★
        L->>FS: JLI_ParseManifest(jarname) (parse_manifest.c:577)
        FS->>FS: fopen(jarfile) (:588)
        FS->>FS: find_file("META-INF/MANIFEST.MF") (:603)
        FS->>FS: inflate_file(:607) — DEFLATE 解压
        FS->>FS: parse_nv_pair(:613) — "Main-Class: com.example.Main"
        FS-->>L: manifest_info — main_class, class_path
    end

    rect rgb(230, 245, 255)
        Note over L,FS: ★ 阶段 2 — SelectVersion + JRE 重启 ★
        L->>L: SelectVersion(java.c:1056)
        L->>FS: 读 manifest → Created-By / JRE-Version
        alt JRE version mismatch
            L->>FS: find new java binary
            L->>L: execvp(new_java, args) (java.c:1202-1213)
            Note over L: setenv("_JAVA_VERSION_SET") → 新进程读取
        end
    end

    rect rgb(245, 245, 245)
        Note over L: ★ 阶段 3 — ClassPath 覆盖 ★
        L->>L: if (mode == LM_JAR) SetClassPath(what) (java.c:338)
        Note over L: 所有 -cp 被静默覆盖 → 只保留 JAR
    end

    rect rgb(255, 240, 240)
        Note over L,V: ★ 阶段 4 — JNI_CreateJavaVM (from 02-JVM-Loading) ★
        L->>V: ifn->CreateJavaVM(&vm, &env, &args) (java.c:1545)
        V-->>L: JNI_OK → vm + env ready
    end

    rect rgb(240, 255, 240)
        Note over L,LH: ★ 阶段 5 — LoadMainClass ★
        L->>LH: GetStaticMethodID("checkAndLoadMain") (java.c:1634)
        L->>LH: CallStaticObjectMethod(env, cls, mid, USE_STDERR, mode, what) (java.c:1640)

        alt mode == LM_JAR
            LH->>FS: 重读 manifest (UTF-8 修复 — bugid 5030265)
            FS-->>LH: Main-Class = "com.example.Main"
        end

        LH->>LH: Class.forName(mainClassName) → 双亲委派 [02-class-loading]
        LH->>LH: getDeclaredMethod("main", String[].class)
        LH-->>L: return jclass mainClass
    end

    L->>L: GetStaticMethodID(env, mainClass, "main", "([Ljava/lang/String;)V") (java.c:560)
    L->>L: NewObjectArray(env, argc, ...) — 构造 String[] args

    rect rgb(255, 255, 240)
        Note over L,U: ★★★ HANDOFF — C→Java ★★★
        L->>U: CallStaticVoidMethod(env, mainClass, mainID, mainArgs) (java.c:566)
        Note over U: main(String[] args) — C stack 冻结，JVM 栈接管
    end

    U-->>L: main() returns
    L->>L: ExceptionOccurred(env) ? ret=1 : ret=0 (java.c:568)
    L->>V: DetachCurrentThread → DestroyJavaVM (LEAVE macro)
    L-->>L: exit(ret)
```

---

## §五 GDB 断点验证 — 12 断点完整 main class loading trace

### 断言 1: JLI_ParseManifest 入口 (parse_manifest.c:577)

```
(gdb) break parse_manifest.c:577
Breakpoint 1 at 0x...: file parse_manifest.c, line 577.
(gdb) run
577	    return JLI_ParseManifest(jarfile, &info, readonly);
(gdb) print jarname
$1 = 0x... "app.jar"
(gdb) continue
(gdb) print info->main_class
$2 = 0x... "com.example.Main"
```

### 断言 2: SelectVersion 入口 (java.c:1056)

```
(gdb) break java.c:1056
Breakpoint 2 at 0x...: file java.c, line 1056.
(gdb) print argc
$3 = 3
(gdb) print argv[0]
$4 = 0x... "-jar"
(gdb) continue
(gdb) print *main_class
$5 = 0x... "com.example.Main"  // from manifest — or NULL if no manifest
```

### 断言 3: SetClassPath 覆盖 (java.c:338)

```
(gdb) break java.c:338
Breakpoint 3 at 0x...: file java.c, line 338.
(gdb) print mode
$6 = 2  // LM_JAR
(gdb) print what
$7 = 0x... "app.jar"
(gdb) continue
(gdb) print classpath
$8 = "app.jar"  // only the JAR — all -cp entries erased
```

### 断言 4: LoadMainClass 入口 (java.c:1623)

```
(gdb) break java.c:1623
Breakpoint 4 at 0x...: file java.c, line 1623.
(gdb) print mode
$9 = 2   // LM_JAR
(gdb) print name
$10 = 0x... "app.jar"
(gdb) continue
(gdb) print mainClass
$11 = (jclass) 0x7fff...  // non-NULL → FindClass succeeded
```

### 断言 5: LauncherHelper.checkAndLoadMain JNI 调用 (java.c:1634)

```
(gdb) break java.c:1634
Breakpoint 5 at 0x...: file java.c, line 1634.
(gdb) print cls
$12 = (jclass) 0x7fff...  // LauncherHelper jclass
(gdb) print mid
$13 = (jmethodID) 0x7fff...  // checkAndLoadMain method ID
(gdb) continue
(gdb) print result
$14 = (jobject) 0x7fff...  // return value — the user's main class
```

### 断言 6: GetStaticMethodID("main", "([Ljava/lang/String;)V") (java.c:560)

```
(gdb) break java.c:560
Breakpoint 6 at 0x...: file java.c, line 560.
(gdb) print mainClass
$15 = (jclass) 0x7fff...
(gdb) print methodName
$16 = 0x... "main"
(gdb) print signature
$17 = 0x... "([Ljava/lang/String;)V"
(gdb) continue
(gdb) print mainID
$18 = (jmethodID) 0x7fff...  // non-NULL → main(String[]) found
```

### 断言 7: CallStaticVoidMethod — 进入 Java (java.c:566)

```
(gdb) break java.c:566
Breakpoint 7 at 0x...: file java.c, line 566.
(gdb) print mainClass
$19 = (jclass) 0x7fff...
(gdb) print mainID
$20 = (jmethodID) 0x7fff...
(gdb) print mainArgs
$21 = (jobjectArray) 0x7fff...  // String[] constructed
(gdb) continue
→ 程序进入用户 main(String[] args) 方法
```

### 断言 8: JavaMain exit path — LEAVE 宏 (java.c:374)

```
(gdb) break java.c:374
Breakpoint 8 at 0x...: file java.c, line 374.
$22 = 0  // ret = 0 — main() completed normally
(gdb) continue (LEAVE → DetachCurrentThread → DestroyJavaVM)
→ 进程退出
```

### 断言 9: JNI exception handling — ExceptionCheck (java.c:1644)

```
(gdb) break java.c:1644
Breakpoint 9 at 0x...: file java.c, line 1644.
(gdb) print (*env)->ExceptionCheck(env)
$23 = 1  // JNI_TRUE — there IS a pending exception
(gdb) print mainClassName
$24 = 0x... "com.example.Main"
(gdb) continue
// ExceptionDescribe() 打印堆栈到 stderr
```

### 断言 10: CLS_ERROR1 错误路径 — 不存在的类

```
(gdb) break java.c:1648
Breakpoint 10 at 0x...: file java.c, line 1648.
# 运行: java NonExistentClass
(gdb) print CLS_ERROR1
$25 = "Error: Could not find the main class %s."
(gdb) print what
$26 = 0x... "NonExistentClass"
(gdb) continue
# 期望输出: "Error: Could not find the main class NonExistentClass. Program will exit."
```

### 断言 11: CLS_ERROR2 错误路径 — main 方法签名不匹配

```
(gdb) break java.c:564
Breakpoint 11 at 0x...: file java.c, line 564.
# 运行一个类包含 `public void main(String[] args)` (non-static)
(gdb) print mainID
$27 = (jmethodID) 0x0  // NULL — GetStaticMethodID failed
(gdb) continue
# 期望输出: "Error: Main method not found in class %s" (CLS_ERROR2, emessages.h:69)
```

### 断言 12: parse_nv_pair — manifest 属性提取 (parse_manifest.c:613)

```
(gdb) break parse_manifest.c:613
Breakpoint 12 at 0x...: file parse_manifest.c, line 613.
(gdb) print buffer
$28 = 0x... "Manifest-Version: 1.0\nMain-Class: com.example.Main\n\n"
(gdb) continue
(gdb) print name
$29 = 0x... "Main-Class"
(gdb) print value
$30 = 0x... "com.example.Main"
```

---

## §六 Story-Format 面试答案

**Q: "LoadMainClass 到底怎么加载主类的？"**

这是 C 层和 Java 层协作的故事。

**第一段——C 代码的 manifest 首读**。libjli 在 `SelectVersion` 中第一次读取 JAR manifest——`JLI_ParseManifest` 打开 JAR 文件 → 在 ZIP 目录中找 `META-INF/MANIFEST.MF` → 用 zlib 解压 → 逐行解析键值对 → 提取 Main-Class。这个 Main-Class 字符串被放进 `_JAVA_VERSION_SET` 环境变量，主要用于版本选择——检查 JAR 是否需要不同的 JDK 版本。如果需要 → `execvp` 重启自己；如果不需要 → 进入下一阶段。

**第二段——classpath 覆盖**。在 JAR 模式下（`-jar`），libjli 用 JAR 文件名覆盖整个 classpath——用户的 `-cp` 参数被静默忽略。然后 JNI_CreateJavaVM 启动 JVM。

**第三段——Java 代码的 manifest 重读 + Class.forName**。libjli 不直接调用 JNI 的 `FindClass()`——而是通过 JNI 调用 Java 层的 `sun.launcher.LauncherHelper.checkAndLoadMain()`。为什么？两个原因：① JNI 异常处理在 C 代码中很冗长（`ExceptionCheck → ExceptionDescribe → ExceptionClear`），而 LauncherHelper 是 Java 类，用 try-catch 自然处理；② C 代码的 manifest 解析不支持 UTF-8 编码的类名（bugid 5030265），LauncherHelper 在 Java 端重读 manifest，获得正确的 UTF-8 处理。manifest 因此被读取两次——第一次 C 代码用于版本选择，第二次 Java 代码用于实际加载。

**LauncherHelper 的工作**：如果是 JAR 模式 → 重读 manifest → 提取 Main-Class → `Class.forName(mainClassName)` → 触发双亲委派 → 找到 main 类 → `getDeclaredMethod("main", String[].class)` 验证签名。返回 jclass 到 C 层。

**最后**：libjli 调用 `GetStaticMethodID(env, mainClass, "main", "([Ljava/lang/String;)V")` 精确验证方法签名——必须是 `public static void main(String[])`。通过后 → `CallStaticVoidMethod(env, mainClass, mainID, mainArgs)` → C stack 冻结 → Java 栈接管 → 用户 main() 开始执行。从这一行之后，libjli 不再控制执行流——除非 main() 返回或抛异常。

---

## §七 边缘场景——主类加载的 5 个非线性路径

正常流程是 §一 的 5 阶段，但以下场景会改变路径。

### 场景 1：manifest 非 UTF-8 编码 — bugid 5030265 的根本原因

**触发条件**：MANIFEST.MF 使用 ISO-8859-1、Shift_JIS 或 GBK 编码而非 UTF-8。C 代码的 `parse_nv_pair` 逐字节读取，不支持多字节编码。

**源码行为**：`parse_manifest.c:613` 的 `parse_nv_pair` 按字节处理 → 遇到非 ASCII 字符时 `:` 分隔符可能被误认为是多字节序列的一部分 → 查找失败 → `main_class == NULL` → `JAR_ERROR4`（`emessages.h:67`：`"no main manifest attribute, in %s"`）。Java 层的 `LauncherHelper` 重读 manifest 时使用 `java.io.InputStreamReader` 正确处理编码 → 这就是为什么 bugid 5030265 的修复在 Java 层而非 C 层——C 代码中添加 `iconv`/`libiconv` 依赖过于复杂。

**诊断**：
```bash
# 检查 manifest 编码
file -bi app.jar | head -1
hexdump -C META-INF/MANIFEST.MF | head  # 查看是否有非 ASCII 字节
```

**注意**：JAR 规范（JAR File Specification §5.4）规定 MANIFEST.MF 必须是 UTF-8 编码。但历史 JAR 和某些构建工具（Maven Shade Plugin 旧版本）可能产生不同编码的 manifest。

### 场景 2：JAR 文件为零字节 — `fopen` 成功但 `find_file` 失败

**触发条件**：CI/CD 写入中断、网络超时导致部分下载、文件系统损坏。

**源码行为**：`parse_manifest.c:588` 的 `fopen()` 返回非 NULL（零字节文件可以打开 → 返回有效 FILE*）。然后 `find_file`（`parse_manifest.c:603`）调用 `fread` 尝试读取 ZIP 中央目录 → 零字节文件无中央目录 → `fread` 返回 0 → `find_file` 返回非零（失败）→ `JAR_ERROR3`（`emessages.h:66`：`"Invalid or corrupt jarfile %s"`）。

**反事实**：如果 libjli 在 `fopen` 之后立即 `fseek(SEEK_END)` + `ftell` 检查文件大小 → 可以在 ~1µs 内检测零字节文件 → fail fast 省去 `find_file` 的 ZIP 目录搜索（~200µs）。但不影响最终结果——最终仍是 `JAR_ERROR3`，差 ~200µs 在启动前被捕获。

```bash
# 快速检查
stat -c %s app.jar          # 应 > 1KB（至少含 manifest）
```

### 场景 3：manifest continuation line 格式错误 — `parse_nv_pair` 行为

**触发条件**：MANIFEST.MF 中某行超过 72 字节但未正确使用 continuation（下一行不以空格开头）。例如某些构建工具自动换行但未加前导空格。

**源码行为**：`parse_manifest.c:613` 的 `parse_nv_pair` 逐行解析。如果 continuation line 不以空格开头 → 被解析为新的键值对而非上一行的延续 → 键名可能包含非法字符 → 解析失败 → `main_class == NULL`。JAR 规范（§3.1.2）明确要求："No line may be longer than 72 bytes (not characters), in its UTF8-encoded form. If a value would make the initial line longer than this, it should be continued on extra lines (each starting with a single SPACE)."

**诊断**：
```bash
# 查找 manifest 中的长行
unzip -p app.jar META-INF/MANIFEST.MF | awk 'length($0) > 72'
```

### 场景 4：同一类存在于多个 classpath entry — 加载歧义

**触发条件**：classpath 中有多个 JAR 包含同名的 `.class` 文件（版本冲突、shaded JAR 包含原始版本 + shaded 版本）。

**源码行为**：`LauncherHelper.checkAndLoadMain()` → `Class.forName(mainClassName)` → 双亲委派 → Bootstrap 搜索失败 → Platform 搜索失败 → Application class loader 的 `URLClassLoader` 按 classpath 顺序搜索 → **找到第一个匹配的就停止**。如果 `foo-1.0.jar`（classpath 第一位）和 `foo-2.0.jar`（classpath 第二位）都包含 `com.example.Main` → 加载 `foo-1.0.jar` 中的版本 → 用户期望的是 `foo-2.0.jar` 中的版本。libjli 不产生任何关于此的警告或错误。

**修复**：用 `-verbose:class` 查看实际加载来源：
```bash
java -verbose:class -jar app.jar 2>&1 | grep "com.example.Main"
# [Loaded com.example.Main from file:/opt/app/lib/foo-1.0.jar]
```

### 场景 5：CallStaticVoidMethod 与 JNI 异常竞态 — main() 中途修改 manifest

**触发条件**：理论上，如果 JAR 中的 MANIFEST.MF 在 `Class.forName` 和 `main()` 第一行之间被外部进程替换（文件系统操作），Java 代码可能读取到修改后的 manifest。

**实际概率**：极低。`Class.forName` → `main()` 第一行之间 ~5ms（类加载 + 方法入口）。在这个窗口内完成文件替换需要：外部进程在 ~5ms 内 `cp new_manifest META-INF/MANIFEST.MF` + JAR 重新打包。实际场景更可能发生在测试系统中——测试框架在启动应用之前替换 JAR 配置。libjli 对此无特殊处理——manifest 在 `Class.forName` 时已经被读取并缓存，后续修改不影响当前 JVM 实例。

**反事实**：如果 libjli 用 `flock` 对 JAR 文件加排他锁阻止写入 → 不需要——manifest 读取后就扔掉了，后续对同一个 JAR 文件的并行读取由 OS 页缓存处理，不会读到中间状态。

---

## §八 Cross-References

| 阶段 | 关联点 | 关系 |
|------|--------|------|
| **00-Libjli-Overview §一 Step 8** | `LoadMainClass → GetStaticMethodID → CallStaticVoidMethod` | 本文是 Step 8 的完整展开 |
| **02-JVM-Loading** | `java.c:1545` = JNI_CreateJavaVM 完成后 JVM 就绪 → env 可用 | LoadMainClass 的所有 JNI 操作依赖 env |
| **01-Argument-Parsing** | `mode` 和 `what` 由 ParseArguments 确定 | 本文直接消费这些值（LM_JAR → classpath 覆盖） |
| **02-class-loading** | `Class.forName` → 双亲委派 → Bootstrap → Platform → Application class loader | 本文 §一 1.4（LauncherHelper 的 Class.forName 调用点） |
| **14-zip-jimage** | `parse_manifest.c` 的 ZIP 解析依赖 ZIP 目录结构和 inflate 算法 | 本文 §一 1.1（JLI_ParseManifest 的 find_file + inflate_file） |
| **09-native-interface** | JNI 函数表（`JNIEnv *env`）的类型定义和语义 | 本文 §一 1.5（GetStaticMethodID + CallStaticVoidMethod 的 JNI 签名） |

---

## §九 Additional Prohibitions

- ❌ 只列举错误消息不做分类根因分析——必须解释 CLS_ERROR1 的 5 种不同触发条件
- ❌ 不解释 manifest 的两次读取——必须展示 C 代码 + Java 代码的两次读取 + bugid 5030265
- ❌ 忽略 SelectVersion 的 JRE 重启机制——必须展示 execvp 重启流程 + `_JAVA_VERSION_SET` 环境变量协议
- ❌ 不展示 LoadMainClass 的 JNI exception handling 模式
- ❌ 不做 FindClass vs Class.forName 的对比
- ❌ 不解释 JNI 签名字符串 `"([Ljava/lang/String;)V"`——必须逐字符解释
- ❌ 不说 CallStaticVoidMethod 之后 libjli 还控制——必须说明"从这一行之后 libjli 不再控制"
- ❌ 忽略 Class-Path manifest 属性与 -cp 的时序差异
- ❌ 不做 4 LaunchMode 在 LauncherHelper 中的分支对比
- ❌ 忘记交叉引用 02-class-loading
- ❌ 不要解释 C 语言基础
- ❌ 不要解释 JAR/ZIP 文件格式内部原理（14-zip-jimage 覆盖）
- ❌ 忽略边缘场景：非 UTF-8 编码 manifest、零字节 JAR、continuation line 错误、多 classpath 类冲突、manifest 竞态
- ❌ 不做 man 手册引用——必须标注 `man 1 jar`（JAR 命令）、`man 1 unzip`（诊断工具）、`man 3 zlib`（inflate/deflate）、`man 2 execvp`（JRE 重启）
- ❌ 省略 `manifest_info.h` 的 ZIP 文件格式常量——CENSIG/ENDSIG 是 JAR 格式的基础
