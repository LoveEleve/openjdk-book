# PROMPT: 请撰写 03-Main-Class-Loading.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

Spring Boot fat JAR: `java -jar app.jar` → `Error: Could not find the main class org.springframework.boot.loader.JarLauncher. Program will exit.`（`emessages.h:68`，`CLS_ERROR1`）。JAR 的 `META-INF/MANIFEST.MF` 明确写着 `Main-Class: org.springframework.boot.loader.JarLauncher`，但加载失败。

**Root cause**: Spring Boot fat JAR 的嵌套 JAR 布局——`lib/` 目录下的 JAR 由 Spring Boot Launcher 加载，不在 Java classpath 中。`LoadMainClass` 找不到 `JarLauncher` 因为它在嵌套 JAR 里。但 libjli 的 `FindClass` 只检查 JVM 的标准 classpath——而不检查 Spring Boot 的自定义 Launcher classpath。Spring Boot 的 fat JAR 结构是：`app.jar/Boot-INF/lib/*.jar`（嵌套 JAR 在 fat JAR 内部），而 `JarLauncher` 的 `.class` 文件也在 `app.jar` 内部的嵌套 JAR 中。JVM 的 `java.class.path` 只包含 `app.jar` 本身——libjli 不知道内部嵌套 JAR 的存在 → `Class.forName("org.springframework.boot.loader.JarLauncher")` → `ClassNotFoundException`。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 检查 JAR manifest 中的 Main-Class 属性
unzip -p app.jar META-INF/MANIFEST.MF | grep "Main-Class:"

# 2. 确认主类是否在 JAR 根或嵌套 JAR 中
jar tf app.jar | grep "JarLauncher.class"
# 如果输出为空 → Main-Class 指向的类不在 JAR 文件系统中
# 如果输出为 Boot-INF/lib/spring-boot-loader.jar → 类在嵌套 JAR 内

# 3. GDB 断点验证 LoadMainClass 的失败路径
gdb -ex "break java.c:523" \
    -ex "run" \
    -ex "print mode" \
    -ex "print what" \
    -ex "continue" \
    -ex "print mainClass" \
    --args java -jar app.jar
# mainClass == NULL → CLS_ERROR1 路径 → ExceptionDescribe() 输出
```

**反事实**：如果 libjli 在 `SelectVersion` 阶段（`java.c:1114-1115`）也检查 JAR 内部是否包含 Main-Class 的 `.class` 文件 → 可以在 `JNI_CreateJavaVM` 之前（~2s 启动时间）就提前报错 → fail fast。libjli 用 `parse_manifest.c` 已经有 ZIP 解析能力——通过 `find_file()` + `inflate_file()` 可以检查 manifest。检查 `.class` 文件也同理——但需要 C 代码理解 JAR 内部路径的 `.class` → 包名映射（`org/springframework/boot/loader/JarLauncher.class`），这增加复杂度。

---

## §一 Task + Narrative + Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE path from "JVM is initialized and ready" to "`CallStaticVoidMethod(env, mainClass, mainID, mainArgs)` enters `main()`". `LoadMainClass` 不是"调用 FindClass"。它是 5 个阶段的序列：1) 读 JAR manifest 找 Main-Class 属性 → 2) 启动 JVM → 3) 通过 `LauncherHelper` 间接调 `FindClass` → 4) 验证 `main(String[])` 存在 → 5) 调用它。每个阶段都可能失败——manifest 损坏、`ClassNotFoundException`、没有 `main` 方法——错误消息的质量递减（"没有 main 方法" 是最模糊的）。

### Beginner Callout Boxes（文档中必须出现的 4 个 callout 框）

1. **JAR manifest**: `META-INF/MANIFEST.MF`。键值对文本文件。例如：`Main-Class: com.example.Main`。libjli 在 `JNI_CreateJavaVM` 之前通过 `JLI_ParseManifest()`（`parse_manifest.c:577`）解析它来决定加载哪个类。manifest 在 libjli 中被读取两次：第一次（C 代码 `SelectVersion`，`java.c:1114`）提取 Main-Class 用于版本选择 → 结果放入环境变量 `_JAVA_VERSION_SET`；第二次（Java 代码 `LauncherHelper.checkAndLoadMain()`）重新读取获得正确的 UTF-8 处理——这是 `java.c:498-504` 注释中 bugid 5030265 的修复。

2. **LauncherHelper.checkAndLoadMain()**: Java 层 helper。调用 `Class.forName(mainClassName)` → 检查 `main(String[])` 方法存在 → 返回 `Method` 对象（`java.lang.reflect.Method`）。libjli 不直接调用 Java 方法——通过 JNI `CallStaticVoidMethod` 执行 `main()`。对应源码：`java.c:1634-1640`（JNI 调 Java）、`LauncherHelper.java`（Java 端实现）。为什么用 `LauncherHelper`？因为 `FindClass` 返回 NULL 时需要通过 `ExceptionCheck() → ExceptionDescribe() → ExceptionClear()` 处理 JNI 异常——这在 C 代码中很冗长。`LauncherHelper` 是 Java 类，在 Java 端处理异常 + 产生正确的错误消息（UTF-8 编码的类名）。

3. **FindClass vs Class.forName**: `FindClass` 是 JNI 函数——在系统类加载器（bootstrap class loader）中搜索。`Class.forName` 使用当前线程的上下文类加载器（application class loader）。`LauncherHelper` 用 `Class.forName` 因为它能更好地处理错误消息——抛出 `ClassNotFoundException` 带描述性消息，而 JNI 的 `FindClass` 返回 NULL 只有模糊的 JNI 异常。但 JNI 的 `FindClass` 更基础——在 `LauncherHelper` 类本身的加载中就必须用到。

4. **JNI exception handling**: `FindClass` 返回 NULL → 必须调用 `(*env)->ExceptionCheck()` → `(*env)->ExceptionDescribe()` → `(*env)->ExceptionClear()`。遗漏任何一步 → JVM 处于不一致状态 → 后续 JNI 调用崩溃。对应源码：`java.c:1623-1650`（`LoadMainClass` 中的 exception handling 模式）。三步模式在 JNI 规范中是强制要求的——"pending exception" 状态下调用大多数 JNI 函数会导致未定义行为。

---

## §二 Environment

Same as prompt-00 §二. OpenJDK 11 slowdebug, Linux x86_64.

Source roots:
- `src/java.base/share/native/libjli/` — `SelectVersion`, `LoadMainClass`, `JavaMain`, `InitializeJVM` in `java.c`；`JLI_ParseManifest` in `parse_manifest.c`
- `src/java.base/share/classes/sun/launcher/` — `LauncherHelper.java`（Java 层 helper）
- `src/java.base/unix/native/libjli/` — pthread_create + JNI 调用 in `java_md_solinux.c`

Key data structures (in `manifest_info.h`):
- `manifest_info` struct — `char *manifest_version`, `char *main_class`, `char **class_path`, `jlong class_path_count`
- `manifest_attribute` struct — `char *name`, `char *value`, `manifest_attribute *next`

Key JNI types (in `jni.h`):
- `jclass` — 已加载的 Java 类的引用
- `jmethodID` — Java 方法的引用（来自 `GetStaticMethodID`）
- `jobjectArray` — Java 对象数组（`String[]`）
- `JNIEnv *env` — JNI 函数表指针（由 `JNI_CreateJavaVM` 返回）

Key Java code:
- `LauncherHelper.java:checkAndLoadMain()` — Java 端 main class 发现 + 验证
- `LauncherHelper.java:showSettings()` — `-XshowSettings` 输出
- `LauncherHelper.java:printHelpMessage()` — `--help` 输出

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

## §四 Deep Dive Question Groups（≥8，EXACT questions + answer directions）

### 4.1 ★★★ JLI_ParseManifest — reading META-INF/MANIFEST.MF

```
问题：
  ① JLI_ParseManifest(parse_manifest.c:577) 的 4 步流程是什么？
    答案方向: Step 1: 打开 JAR 文件 → fopen(jarfile, "rb")（parse_manifest.c:588）
      → 失败 → JAR_ERROR2 "Unable to access jarfile %s"（emessages.h:65）
      Step 2: 在 ZIP 目录中定位 META-INF/MANIFEST.MF 条目 → find_file()（parse_manifest.c:603）
      → 失败 → JAR_ERROR3 "Invalid or corrupt jarfile %s"（emessages.h:66）
      Step 3: 解压 manifest 内容 → inflate_file()（parse_manifest.c:607）
      → 失败 → JAR_ERROR3
      Step 4: 逐行解析键值对 → parse_nv_pair()（parse_manifest.c:613）
      → 提取 Main-Class, Class-Path, Created-By 等属性 → 存储在 manifest_info 结构体中
      
      追问: Counterfactual — 如果 JAR 没有 manifest（例如 Maven 默认创建的 lightweight JAR）？
      → parse_manifest.c:609-620 → 返回 NULL → SelectVersion 返回 main_class = NULL
      → JLI_Launch 报 "no main manifest attribute, in %s"（JAR_ERROR4, emessages.h:67）

  ② parse_nv_pair 如何解析 "Main-Class: com.example.Main" 这一行？
    答案方向: parse_manifest.c 的键值对解析是 NAME:VALUE 格式。
      "Main-Class: com.example.Main" → parse 成 name="Main-Class", value="com.example.Main"
      存储到 manifest_info.main_class。
      "Class-Path: lib/dep.jar lib/util.jar" → parse 成 name="Class-Path",
      value="lib/dep.jar lib/util.jar" → 后续 split by whitespace → manifest_info.class_path[]。
      注意：manifest 规范要求每行 < 72 字节，超过需要 continuation line（后续行以空格开头）。
      parse_manifest.c 能正确处理 continuation line。
```

### 4.2 ★★★ SelectVersion — manifest-based JRE version selection

```
问题：
  ① SelectVersion(java.c:1056) 做什么？为什么它在 CreateExecutionEnvironment 之前运行？
      答案方向: SelectVersion 读取 JAR manifest → 提取版本信息 → 与当前 JRE 版本对比 →
      如果不匹配 → 选择正确的 JRE。它在 CreateExecutionEnvironment 之前运行是因为：
      如果版本不匹配 → 需要找到另一个 JRE 的路径 → 覆盖 jrepath →
      CreateExecutionEnvironment 使用正确的 JRE 去加载 libjvm.so。
      
      版本信息来源：manifest 中的 Created-By 属性（例如 "Created-By: 11 (Oracle Corporation)"）
      或专门的 JRE-Version 属性。如果 JAR 需要 JDK 17 但系统只有 JDK 11 →
      SelectVersion 尝试找到 JDK 17 的 java 可执行文件 → 调用 exec 重启自己。
      
      追问: 如果选择了错误的 JRE 版本会怎样？→ ClassFormatError: Incompatible magic value
      在 FindClass 时——但 FindClass 在 JNI_CreateJavaVM 之后（java.c:523），意味着浪费了
      ~2s 启动时间才失败。这就是为什么版本选择必须在 CreateExecutionEnvironment 之前完成。

  ② SelectVersion 的 JRE 重启机制是什么？
      答案方向: java.c:1168-1213 → 如果需要的 JRE 版本 ≠ 当前 JRE → SelectVersion
      构建 execvp 参数 → 设置 _JAVA_VERSION_SET 环境变量 → execvp(new_java_path, new_args)
      → 新进程读取 _JAVA_VERSION_SET → 直接使用指定 JRE → 重新运行 ParseArguments。
      这是完全重启——原进程被 exec 替换，所有状态丢失。开销：~10ms fork + exec。
      但由于 libjli 阶段 < 50ms，这比启动错误的 JVM（~2s）后失败要快得多。
```

### 4.3 ★★★ SetClassPath for JAR — the overwrite

```
问题：
  ① 当 mode == LM_JAR 时，classpath 如何被覆盖？
      答案方向: java.c:338-340 → if (mode == LM_JAR) SetClassPath(what)
      → 这用 JAR 文件名**覆盖**整个 classpath——只包含 JAR 文件本身。
      用户的 -cp 参数**被忽略**。然后 JAR manifest 中的 Class-Path 属性 →
      进入 java.class.path 系统属性的末尾。这只是 JAR 中额外的依赖 JAR——
      主 JAR 本身仍然是 classpath 中唯一的根元素。
      
      追问: 如果 JAR 的 Class-Path manifest 属性指向本地不存在的文件？
      → 类加载器静默忽略——不存在的 Class-Path 条目不报错。MANIFEST.MF 只声明依赖，
      不验证依赖存在。这可能导致运行时 ClassNotFoundException（延迟失败，不是启动失败）。

  ② 为什么 -jar 模式下 classpath 的覆盖是"有意的设计"？
      答案方向: JAR 文件规范说 JAR 应该是自包含的——所有依赖通过 manifest Class-Path 指定。
      如果 libjli 同时使用 -cp 和 JAR classpath → 类加载顺序变成非确定性 →
      同一个类名可能从两个路径加载 → 行为取决于路径顺序 → 生产隐患。
      java.c:338 选择 silently ignore -cp 而不是报错——向后兼容：某些脚本可能无意识地同时使用
      -cp 和 -jar，libjli 不 break existing scripts。
```

### 4.4 ★★★ LauncherHelper.checkAndLoadMain() — the Java-side helper

```
问题：
  ① LauncherHelper.checkAndLoadMain() 的完整流程是什么？
      答案方向: LauncherHelper.java 接收 (boolean useStderr, int mode, String what)。
      mode: 1=CLASS(类名), 2=JAR(文件), 3=MODULE(模块名), 4=SOURCE(源文件)。
      
      如果是 JAR (mode=2):
        1. 打开 JAR 文件 → 读 META-INF/MANIFEST.MF → 提取 Main-Class 属性
        2. 将 Main-Class 中的 "." 替换为 "/" → 去验证 .class 文件存在
        3. Class.forName(mainClassName) — 加载主类
        4. mainClass.getDeclaredMethod("main", String[].class) — 查找 main 方法
        5. mainMethod.setAccessible(true)
        6. 返回 mainClass（Method 对象被缓存在 helperMethod 静态字段）
      
      如果是 CLASS (mode=1):
        1. 直接 Class.forName(what) — what 是类名
        2. 相同的 main 方法验证

  ② 为什么用 Class.forName 而非 JNI 的 FindClass？
      答案方向: Class.forName 抛出 ClassNotFoundException 带有描述性异常消息——
      LauncherHelper 可以捕获并格式化为自然的错误消息：
        "Can't find main(String[]) method in class: com.example.Main"
        "Error: Main method is not static in class com.example.Main, please define the main method as: public static void main(String[] args)"
      JNI 的 FindClass 返回 NULL ——只有模糊的异常消息（ExceptionDescribe() 输出到 stderr
      但不返回字符串）。LauncherHelper 通过 Java 反射可以产生多语言、用户友好的错误。
```

### 4.5 ★★★ GetStaticMethodID("main", "([Ljava/lang/String;)V") — signature verification

```
问题：
  ① JNI 签名字符串 "([Ljava/lang/String;)V" 的含义是什么？
      答案方向: JNI 类型签名格式（JNI spec §3.2.2）:
        (           → 参数开始
        [           → 数组
        Ljava/lang/String; → String 类型
        )           → 参数结束
        V           → 返回类型: void
      完整含义: "takes a String[] and returns void" — 正是 public static void main(String[] args)
      
      追问: 如果类的 main 方法签名错误（例如 main() 无参数、main(String args) 不是数组）？
      → GetStaticMethodID 返回 NULL → java.c:560-565 → 切换错误消息：
        "Error: Main method not found in class %s"（CLS_ERROR2, emessages.h:69）
      或如果 main 方法存在但不是 static：
        "Error: Main method is not static in class %s"
      这不同于 ClassNotFoundException——类被找到了，但 main 方法签名错误。

  ② 为什么 JNI 用字符串签名而不是 C 类型？
      答案方向: JNI 是 C 和 Java 之间的互操作层——C 类型系统和 Java 类型系统不直接对应。
      字符串签名是 JNI 规范定义的通用描述语言——独立于平台 ABI。
      同一签名在 x86_64 和 ARM64 上产生相同的 FindClass/GetStaticMethodID 行为。
      但签名在运行时不验证类型安全性——如果签名错误匹配 → 调用时 stack corruption
      （Java stack frame 被 C 代码破坏）→ SIGSEGV。
```

### 4.6 ★★★ CallStaticVoidMethod — the irreversible transition

```
问题：
  ① 从 CallStaticVoidMethod(java.c:566) 之后 libjli 还做什么？
      答案方向: 从这一行之后，libjli 不再控制执行流。CallStaticVoidMethod(env, mainClass, mainID, mainArgs)
      进入 Java 的 main() 方法。C 调用栈在此暂停——JVM 栈接管。如果 main() 返回：
      → CallStaticVoidMethod 返回 → JavaMain 继续 → java.c:572 检查异常 →
      java.c:374-380 LEAVE() 宏 → (*vm)->DetachCurrentThread(vm) →
      (*vm)->DestroyJavaVM(vm) → return ret。如果 main() 抛出异常：
      → java.c:572 ExceptionOccurred() != NULL → ret = 1 → ExceptionDescribe() →
      LEAVE() → DestroyJavaVM → exit(1)。libjli 永远不会"返回"到 bash——JVM 退出 = 进程退出。
      
      追问: CallStaticVoidMethod 的 C stack 和 Java stack 如何共存？
      → JNI 通过调用约定管理。C stack 上有 JavaMain → LoadMainClass → InitializeJVM 的帧。
      JNI_CreateJavaVM 创建了 Java 栈内存区域（独立于 C stack）。CallStaticVoidMethod 内部
      保存 C 寄存器 → 切换栈指针到 Java 栈 → 执行解释的/编译后的 Java 代码 → 返回后恢复 C 栈。

  ② 如果 main() 是守护线程启动的——JVM 何时退出？
      答案方向: 如果还有其他非守护线程运行 → JVM 继续存活直到所有非守护线程退出 →
      DestroyJavaVM 会阻塞。这就是为什么 jetty/tomcat/spring-boot-web 的主线程 main() 返回
      但 JVM 不退出——HTTP 请求处理线程仍在运行。DestroyJavaVM 内部调用
      Threads::destroy_vm() → 等待所有非守护线程完成 → 执行 shutdown hooks →
      释放堆 → return。如果线程是守护线程 → DestroyJavaVM 不等待。
```

### 4.7 ★★★ Class-Path manifest attribute — the second-class classpath

```
问题：
  ① JAR manifest 的 Class-Path 属性和命令行 -cp 有什么本质区别？
      答案方向: 时序差异：
      - -cp / lib/* 通配符在 ParseArguments 中展开（JNI_CreateJavaVM 之前）
        → java.class.path 系统属性在 JVM 启动时已包含完整路径
        → 类加载器在初始化时就能看到所有 classpath entry
      - Class-Path manifest 属性在 JVM 内通过 URLClassLoader /
        LauncherHelper 设置（JNI_CreateJavaVM 之后）→ 附加在 java.class.path 末尾
        → 可能在启动中引起类加载顺序问题（同一个类从不同路径加载的先后）
      
      追问: Class-Path 属性支持通配符吗？→ 不支持。wildcard.c:70-71 注释明确说明：
      "Class-Path wildcard expansion is NOT supported in manifest."

  ② Class-Path 属性的一个 JAR 路径解析基准是什么？
      答案方向: 相对于 JAR 文件的位置（而不是当前工作目录）。
      例如: app.jar 在 /opt/myapp/ → Class-Path: lib/dep.jar → 解析为 /opt/myapp/lib/dep.jar
      而不是 $PWD/lib/dep.jar。这是为了可移植性——JAR 可以被移动到任何目录运行。
```

### 4.8 ★★★ JavaMain exit path — what happens after main() returns

```
问题：
  ① JavaMain 的退出序列是什么？每一步可能失败的后果是什么？
      答案方向: java.c:405 的 JavaMain 函数。退出路径（java.c:374-380）:
        1. (*env)->ExceptionOccurred(env) → 检查 main() 是否抛异常
          → 如果抛 → ret = 1 → ExceptionDescribe() 打印堆栈到 stderr
        2. LEAVE() 宏 → (a) 释放所有 JNI 局部引用
          → (b) (*vm)->DetachCurrentThread(vm) → 从 JVM 线程列表移除当前线程
          → (c) (*vm)->DestroyJavaVM(vm) → 等待所有非守护线程 → shutdown hooks → 释放堆
        3. return ret → 进程退出码
        
       追问: 如果 DestroyJavaVM 被调用时还有非守护线程在运行？
       → DestroyJavaVM 内部阻塞等待这些线程完成。如果某个线程死循环 →
       JVM 永远不会退出 → 需要 SIGTERM/kill -9。这就是为什么服务器 Java 程序
       需要 graceful shutdown 机制（Spring Boot 的 @PreDestroy 等）。

   ② 反事实：如果 DestroyJavaVM 不等待非守护线程会怎样？
      答案方向: Thread.stop() 杀线程在 synchronized 块中间 → monitor 保持锁定 →
       下一个线程尝试获取 → 无限等待 → 生产死锁。真实场景：Spring Boot 应用的
       @Async 任务在写 DB → 事务永远不提交 → 连接池泄漏 → 应用无响应 →
       SIGTERM → DestroyJavaVM 挂起 → Docker 容器超时 → kill -9 → 数据丢失。
       Docker 的 10s 超时常比 DestroyJavaVM 的优雅关闭更短 → 被杀线程泄漏
       文件描述符和 DB 连接。
```

---

## §五 Article Structure

```
§〇 生产场景 — Spring Boot fat JAR: Main-Class 在嵌套 JAR 中 → CLS_ERROR1
  ★ 真实错误消息（emessages.h:68: "Could not find the main class %s"）
  ★ Root cause: libjli 只检查标准 classpath，不知道嵌套 JAR
  ★ 三步诊断：unzip manifest → jar tf check → GDB 断点
  ★ 反事实：如果 libjli 在 SelectVersion 阶段就检查 .class 文件存在 → fail fast before JVM

§一 ★★★ LoadMainClass 5 阶段完整源码走读
  ❓ LoadMainClass 不是 "调用 FindClass"——它是 5 阶段的序列
  ❓ 为什么 libjli 不直接调用 FindClass 而是通过 Java 层 helper？
  1.1 阶段 1: JLI_ParseManifest — 读 META-INF/MANIFEST.MF (parse_manifest.c:577)
       ├─ fopen JAR (parse_manifest.c:588) → JAR_ERROR2
       ├─ find_file META-INF/MANIFEST.MF (parse_manifest.c:603) → JAR_ERROR3
       ├─ inflate_file 解压 (parse_manifest.c:607) → JAR_ERROR3
       └─ parse_nv_pair 提取 Main-Class (parse_manifest.c:613)
  1.2 阶段 2: SelectVersion — 版本选择 + JRE 重启 (java.c:1056-1213)
       ├─ manifest 版本检查 (Created-By / JRE-Version)
       ├─ JRE 不匹配 → execvp 重启
       └─ _JAVA_VERSION_SET 环境变量传递
  1.3 阶段 3: SetClassPath for JAR — classpath 覆盖 (java.c:338-340)
       ├─ mode == LM_JAR → SetClassPath(what) — 覆盖所有之前的 classpath
       └─ Class-Path manifest 属性附加到 java.class.path 末尾
  1.4 阶段 4: LauncherHelper.checkAndLoadMain() — Java 层 helper
       ├─ JAR mode: 重读 manifest → GetMainClassName → Class.forName
       ├─ CLASS mode: 直接 Class.forName(what)
       └─ 验证 main(String[]) 存在 → 返回 jclass
  1.5 阶段 5: GetStaticMethodID("main", "([Ljava/lang/String;)V") — 签名验证
  1.6 ★ Mermaid: manifest → ParseManifest → SelectVersion → SetClassPath → 
      JNI_CreateJavaVM → LauncherHelper.checkAndLoadMain() → GetStaticMethodID → 
      CallStaticVoidMethod
      Lanes: libjli (C) / libjvm / LauncherHelper (Java) / user main()
  1.7 ★ 面试 Story Format 答案 — "LoadMainClass 到底怎么加载主类的？"
      从 manifest 第一次读取（C 代码）到 Java 层第二次读取到 Class.forName 到
      main 方法验证到 CallStaticVoidMethod 的全叙事

§二 ★★★ JLI_ParseManifest 的 ZIP 处理
  ❓ manifest 解析为什么需要 ZIP 目录查找 + inflate 解压？
  ❓ 如果 JAR 没有 manifest → JAR_ERROR4 vs JAR_ERROR2 vs JAR_ERROR3 的区别？
  2.1 ZIP 目录结构 + find_file 算法
  2.2 inflate_file — zlib 解压 manifest 内容
  2.3 parse_nv_pair — Key:Value 解析 + continuation line 处理
  2.4 Manifest attribute extraction — Main-Class, Class-Path, Created-By

§三 ★★★ SelectVersion 的版本选择 + 重启机制
  ❓ JAR 的版本要求如何表达？Created-By: 11 和 JRE-Version 有什么区别？
  ❓ execvp 重启的成本是多少？(~10ms vs ~2s 错误 JVM 启动)
  3.1 Version extraction from manifest
  3.2 JRE version comparison logic
  3.3 execvp restart flow (java.c:1168-1213)
  3.4 _JAVA_VERSION_SET environment variable protocol

§四 ★★★ LauncherHelper.checkAndLoadMain 的 4 种 mode 策略
  ❓ CLASS vs JAR vs MODULE vs SOURCE — LauncherHelper 的 4 个分支
  ❓ 为什么有 LauncherHelper 而不是直接 JNI FindClass？
  4.1 CLASS mode: Class.forName(className) + main method check
  4.2 JAR mode: manifest 重读 + UTF-8 修复 + Class.forName(Main-Class)
  4.3 MODULE mode: ModuleFinder + ModuleLayer + FindClass 在模块中
  4.4 SOURCE mode: jdk.compiler compile + Class.forName
  4.5 对比表：4 个 mode 的主类发现方式 + 错误消息 + 适用场景

§五 ★★★ GetStaticMethodID + CallStaticVoidMethod — 进入 Java
  ❓ JNI 方法签名字符串的完整语法是什么？
  ❓ CallStaticVoidMethod 前后——C stack vs Java stack 的关系？
  5.1 GetStaticMethodID("main", "([Ljava/lang/String;)V") 源码（java.c:560）
  5.2 JNI 签名字符串语法的完整解释
  5.3 CallStaticVoidMethod 源码（java.c:566）— 进入 Java 之后 libjli 不再控制
  5.4 Exception handling after main() returns (java.c:572)

§六 ★★ Class-Path manifest 属性
  ❓ Class-Path 和 -cp 的时序差异如何影响类加载顺序？
  ❓ Class-Path 不支持通配符——为什么？
  6.1 Class-Path 解析源码
  6.2 与 -cp 的时序对比（manifest 属性附加在 java.class.path 末尾）
  6.3 路径相对于 JAR 位置（不是 $PWD）

§七 ★★ JavaMain 退出路径
  ❓ main() 返回后——LEAVE() 宏做了什么？
  ❓ DestroyJavaVM 何时阻塞？非守护线程的影响？
  7.1 LEAVE 宏源码（java.c:370-380）
  7.2 DetachCurrentThread + DestroyJavaVM
  7.3 非守护线程 = JVM 不退出 → DestroyJavaVM 阻塞
  7.4 返回值：ExceptionOccurred ? 1 : 0

§八 ★ 4 Beginner Callout 框
  8.1 JAR manifest — META-INF/MANIFEST.MF 的格式和作用
  8.2 LauncherHelper.checkAndLoadMain() — Java 层 helper 的原理
  8.3 FindClass vs Class.forName — JNI 和 Java 反射的区别
  8.4 JNI exception handling — ExceptionCheck + ExceptionDescribe + ExceptionClear

§九 ★ GDB 断点验证 — 6 断点完整 main class loading trace
  断言 1: JLI_ParseManifest 入口 (parse_manifest.c:577)
  断言 2: SelectVersion 入口 (java.c:1056)
  断言 3: SetClassPath 覆盖 (java.c:338)
  断言 4: LoadMainClass 入口 (java.c:1623)
  断言 5: GetStaticMethodID 调用 (java.c:560)
  断言 6: CallStaticVoidMethod 调用 (java.c:566)
  断言 7: LauncherHelper.checkAndLoadMain 的 JNI 调 (java.c:1634)
  断言 8: JavaMain exit path — LEAVE (java.c:374)

§十 ★ Cross-Reference
  ❓ 00-Libjli-Overview — JLI_Launch 的 8 步全链路 + LoadMainClass 是第 8 步
  ❓ 01-Argument-Parsing — mode + what 如何由 ParseArguments 确定
  ❓ 02-JVM-Loading — dlopen libjvm.so + JNI_CreateJavaVM 是 LoadMainClass 的前提
  ❓ 02-class-loading — FindClass 的双亲委派 + 类加载器体系
  ❓ 14-zip-jimage — ZIP/JAR 文件格式解析（parse_manifest.c 的 find_file + inflate_file）
  ❓ 09-native-interface — JNI 函数表 + JNIEnv 的类型定义
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because the manifest may contain UTF-8 encoded class names that C code's parse_manifest.c cannot correctly handle, LoadMainClass ignores the main_class extracted by SelectVersion and calls the Java-side LauncherHelper to re-read the manifest..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from `parse_manifest.c` / `java.c` / `LauncherHelper.java`, do not describe it.

3. **Mermaid** — manifest → ParseManifest → SelectVersion → SetClassPath → JNI_CreateJavaVM → LauncherHelper.checkAndLoadMain() → GetStaticMethodID → CallStaticVoidMethod → user main(). 5 lanes: libjli (C) / Filesystem / libjvm / LauncherHelper (Java) / user code. Annotate every handoff with file:line.

4. **GDB session** — 6-8 breakpoints with exact file:line numbers:
   - `JLI_ParseManifest` entry (parse_manifest.c:577)
   - `SelectVersion` entry (java.c:1056)
   - `SetClassPath` JAR override (java.c:338)
   - `LoadMainClass` entry (java.c:1623)
   - `LauncherHelper.checkAndLoadMain` JNI call (java.c:1634)
   - `GetStaticMethodID("main", ...)` (java.c:560)
   - `CallStaticVoidMethod` call (java.c:566)
   - `JavaMain` exit path — LEAVE macro (java.c:374)

   Each with expected variable values to verify.

5. **4 Beginner callout boxes** — the exact text from §一: JAR manifest, LauncherHelper.checkAndLoadMain(), FindClass vs Class.forName, JNI exception handling.

6. **Cross-reference at three points**:
   - At `JLI_ParseManifest` → "→ 14-zip-jimage (ZIP/JAR file format and parsing)"
   - At `LauncherHelper.checkAndLoadMain` → "→ 02-class-loading (FindClass + 双亲委派)"
   - At `CallStaticVoidMethod` → "→ the boundary between C and Java — from here, Java code takes over"

7. **Story-format interview answer** — at §一末尾: "LoadMainClass 到底怎么加载主类的？" — narrative from README §五 Q6 template: manifest → SelectVersion → SetClassPath → LauncherHelper → FindClass → GetStaticMethodID → CallStaticVoidMethod。Two layers of manifest reading（C + Java），why bugid 5030265 matters。

8. **bugid 5030265 explanation** — java.c:498-504 的注释必须被解释：manifest 被两次读取——第一次 C 代码（SelectVersion）不支持 UTF-8，第二次 Java 代码（LauncherHelper）正确处理 UTF-8。为什么 C 代码不修复而在 Java 层再做一遍？→ 因为 C 代码中 UTF-8 处理太复杂（需要 iconv/libiconv 依赖）。

---

## §七 Output Format

- Markdown file, named `03-Main-Class-Loading.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/13-launcher/`
- 元信息头：

```
> **阶段**：[13-launcher]
> **前置**：[00-Libjli-Overview]（理解 JLI_Launch 的 8 步全链路和 LoadMainClass 在第 8 步的位置）、[02-JVM-Loading]（JNI_CreateJavaVM 完成后 JVM 就绪，env 可用）、[02-class-loading]（理解 FindClass 的双亲委派机制和类加载器体系）
> **配套**：[01-Argument-Parsing]（mode 和 what 由 ParseArguments 确定——本文直接消费这些值）
> **后续依赖本文**：[04-system-preload]（LoadMainClass 是 JVM 生命周期中第二次 Java 类加载——第一次是系统类预加载）、[14-zip-jimage]（JAR/ZIP 文件解析的底层实现）
> **阅读收益**：追踪从 JAR manifest 到 CallStaticVoidMethod 的完整 5 阶段加载链——理解 JLI_ParseManifest 的 4 步 ZIP 解析流程、SelectVersion 的版本选择 + execvp 重启机制、SetClassPath 的 -jar 覆盖逻辑、LauncherHelper.checkAndLoadMain() 的 Java 层 4 mode 策略、GetStaticMethodID 的 JNI 签名字符串语法、CallStaticVoidMethod 的不可逆转移；掌握 "Could not find or load main class" 的 5 种根因分类和诊断 workflow
```

- 目标行数: 300+ lines

---

## §八 Prohibited (≥8)

- ❌ 只列举错误消息不做分类根因分析 — 必须解释 CLS_ERROR1 的 5 种不同触发条件（ClassNotFoundException / manifest damage / Wrong classpath / Signature mismatch / Module error）
- ❌ 不解释 manifest 的两次读取 — 必须展示 C 代码 SelectVersion + Java 代码 LauncherHelper 的两次读取 + bugid 5030265 的 UTF-8 原因
- ❌ 忽略 SelectVersion 的 JRE 重启机制 — 必须展示 execvp 重启流程 + _JAVA_VERSION_SET 环境变量协议
- ❌ 不展示 LoadMainClass 的 JNI exception handling 模式 — 必须展示 ExceptionCheck → ExceptionDescribe → ExceptionClear 的三步
- ❌ 不做 FindClass vs Class.forName 的对比 — 必须解释为什么 LauncherHelper 用 Class.forName 而非 JNI FindClass
- ❌ 不解释 JNI 签名字符串 "([Ljava/lang/String;)V" — 必须逐字符解释类型签名语法
- ❌ 不说 CallStaticVoidMethod 之后 libjli 还控制 — 必须说明"从这一行之后 libjli 不再控制" + main() 返回后的 LEAVE 退出路径
- ❌ 忽略 Class-Path manifest 属性与 -cp 的时序差异 — 必须展示 "Class-Path 在 JVM 启动后附加到 java.class.path 末尾" vs "-cp 在 JVM 启动前解析"
- ❌ 不做 4 LaunchMode 在 LauncherHelper 中的分支对比 — 必须展示 CLASS/JAR/MODULE/SOURCE 各自的主类发现策略
- ❌ 忘记交叉引用 02-class-loading — 类加载器体系是 FindClass 行为的核心定义，必须在 LauncherHelper 点引用 02
- ❌ 不要解释 C 语言基础
- ❌ 不要解释 JAR/ZIP 文件格式内部原理（14-zip-jimage 覆盖）

---

## §九 Required (≥8)

- ✅ **★ Mermaid manifest → CallStaticVoidMethod 全链序列图** — 5 lanes: libjli (C) / Filesystem / libjvm / LauncherHelper (Java) / user code — manifest → ParseManifest → SelectVersion → SetClassPath → JNI_CreateJavaVM → LauncherHelper.checkAndLoadMain() → GetStaticMethodID → CallStaticVoidMethod
- ✅ **★ JLI_ParseManifest 的 4 步流程源码展示** — fopen → find_file → inflate_file → parse_nv_pair，每步含错误处理 + JAR_ERROR2/3/4 触发条件
- ✅ **★ SelectVersion 的 execvp 重启源码** — java.c:1168-1213 + _JAVA_VERSION_SET 环境变量协议
- ✅ **★ LauncherHelper.checkAndLoadMain() 的 4 mode 分支** — CLASS / JAR / MODULE / SOURCE 各自动态 + 对比表
- ✅ **★ 4 Beginner Callout 框** — exact text from §一: JAR manifest, LauncherHelper, FindClass vs Class.forName, JNI exception handling
- ✅ **★ GetStaticMethodID + CallStaticVoidMethod 源码** — java.c:560-572 的完整序列 + JNI 签名语法解释
- ✅ **★ 面试 Story Format 答案** — §一末尾，叙事："LoadMainClass 到底怎么加载主类的？"——从 C 代码 manifest 首读到 Java 层重读到 FindClass 到 CallStaticVoidMethod
- ✅ **★ 5 种 CLS_ERROR1 根因分析** — manifest 损坏 / Class-Path 缺失 / main 方法不存在 / 嵌套 JAR 无法访问 / 版本不匹配 — 每种带源码触发行
- ✅ **★ GDB 断点 ≥6 条** — 精确到 file:line，每断点有预期变量值，覆盖 manifest → LoadMainClass → CallStaticVoidMethod
- ✅ **★ 交叉引用** — 00-Libjli-Overview（LoadMainClass 在 JLI_Launch 中的位置）、02-class-loading（FindClass 双亲委派）、14-zip-jimage（ZIP/JAR 解析）、09-native-interface（JNI 函数表）

---

## §十 GDB Verification (≥9 assertions)

```
断言 1: JLI_ParseManifest 入口 (parse_manifest.c:577)
  (gdb) break parse_manifest.c:577
  (gdb) print jarname → 期望: JAR 文件路径（例如 "app.jar" 或绝对路径）
  (gdb) print readonly → 期望: JNI_FALSE
  (gdb) continue
  (gdb) print info->main_class → 期望: Main-Class 属性值（例如 "com.example.Main"）

断言 2: SelectVersion 入口 (java.c:1056)
  (gdb) break java.c:1056
  (gdb) print argc → 期望: 命令行参数数量
  (gdb) print argv[0] → 期望: 第一个命令行参数
  (gdb) continue
  (gdb) print *main_class → 期望: 从 manifest 提取的 Main-Class 字符串 或 NULL

断言 3: parse_nv_pair — manifest 属性提取 (parse_manifest.c:613)
  (gdb) break parse_manifest.c:613
  (gdb) print buffer → 期望: 解压后的 manifest 文本内容
  (gdb) continue
  (gdb) print name → 期望: "Main-Class"（第一个解析的属性名）
  (gdb) print value → 期望: 类名（例如 "com.example.Main"）

断言 4: SetClassPath 覆盖（JAR 模式）(java.c:338)
  (gdb) break java.c:338
  (gdb) print mode → 期望: LM_JAR (2)
  (gdb) print what → 期望: JAR 文件名
  (gdb) continue
  (gdb) print classpath → 期望: 只包含 JAR 文件路径

断言 5: LoadMainClass 入口 (java.c:1623)
  (gdb) break java.c:1623
  (gdb) print mode → 期望: 2 (LM_JAR) 或 1 (LM_CLASS) 或 3 (LM_MODULE) 或 4 (LM_SOURCE)
  (gdb) print what → 期望: JAR 文件名 或 类名 或 模块名
  (gdb) continue
  (gdb) print mainClass → 期望: 非 NULL（FindClass 成功返回 jclass）

断言 6: LauncherHelper.checkAndLoadMain JNI 调用 (java.c:1634)
  (gdb) break java.c:1634
  (gdb) print cls → 期望: LauncherHelper 的 jclass
  (gdb) print mid → 期望: checkAndLoadMain 方法的 jmethodID
  (gdb) continue
  (gdb) print result → 期望: jclass 返回值（非 NULL = 主类已加载）

断言 7: GetStaticMethodID("main", "([Ljava/lang/String;)V") (java.c:560)
  (gdb) break java.c:560
  (gdb) print mainClass → 期望: 有效的 jclass handle（非 NULL）
  (gdb) print methodName → 期望: "main"
  (gdb) print signature → 期望: "([Ljava/lang/String;)V"
  (gdb) continue
  (gdb) print mainID → 期望: 非 NULL（main 方法存在且签名匹配）

断言 8: CallStaticVoidMethod — 进入 Java (java.c:566)
  (gdb) break java.c:566
  (gdb) print mainClass → 期望: jclass handle（非 NULL）
  (gdb) print mainID → 期望: jmethodID handle（非 NULL）
  (gdb) print mainArgs → 期望: jobjectArray（String[] 已构造）
  (gdb) continue
  → 程序进入用户 main(String[] args) 方法

断言 9: JavaMain exit path — LEAVE 宏 (java.c:374)
  (gdb) break java.c:374
  (gdb) print ret → 期望: 0（正常完成）或 1（main() 抛异常）
  (gdb) continue (LEAVE → DetachCurrentThread → DestroyJavaVM)
  → 进程退出

断言 10: JNI exception handling — ExceptionCheck 后 (java.c:1644)
  (gdb) break java.c:1644
  (gdb) print (*env)->ExceptionCheck(env) → 期望: JNI_TRUE（有 pending exception）
  (gdb) continue
  (gdb) print mainClassName → 期望: 引发异常的类名
  (gdb) continue (ExceptionDescribe → 打印堆栈到 stderr)

断言 11: CLS_ERROR1 错误路径 — 故意用不存在的类触发
  (gdb) break java.c:1648
  运行: java NonExistentClass
  (gdb) print CLS_ERROR1 → 期望: "Error: Could not find the main class %s."
  (gdb) print what → 期望: "NonExistentClass"
  (gdb) continue
  期望输出: "Error: Could not find the main class NonExistentClass. Program will exit."

断言 12: CLS_ERROR2 错误路径 — main 方法签名不匹配
  (gdb) break java.c:564
  运行一个类包含 `public void main(String[] args)` (non-static)
  (gdb) print mainID → 期望: NULL（GetStaticMethodID 失败）
  (gdb) continue
  期望输出: CLS_ERROR2 "Error: Main method not found in class %s"
```

---

## §十一 与 prompt-00、prompt-01、prompt-02 的连续性

本文是 13-launcher 的四篇核心文档中的第四篇。连续性要求：

1. **从 prompt-00 承接**：00 的 §一 中 Step 8 是 `LoadMainClass → GetStaticMethodID → CallStaticVoidMethod`——本文是 Step 8 的完整展开。本文 §一 应引用 00 的 §一 Step 8 作为起点。

2. **从 prompt-01 承接**：01 的 `ParseArguments` 确定了 `mode` 和 `what` 的值——本文的 `LoadMainClass` 直接消费这些值。`mode == LM_JAR` → classpath 被覆盖（java.c:338），`mode == LM_CLASS` → 直接用类名。本文 §四 应引用 01 的 LaunchMode 枚举定义。

3. **从 prompt-02 承接**：02 的 `JNI_CreateJavaVM` 调用成功后 JVM 就绪——`env` 指针可用——本文的所有 JNI 操作依赖 `env`。本文 §一 应标注 "在 JNI_CreateJavaVM 成功返回后"。

4. **向 02-class-loading 过渡**：本文的 `FindClass` / `Class.forName` 调用触发双亲委派——02-class-loading 定义了这个委派链。本文 §四 中 `LauncherHelper` 的 `Class.forName` 调用处必须引用 02-class-loading。

5. **向 04-system-preload 过渡**：`LoadMainClass` 是 JVM 生命周期中第二次 Java 类加载——第一次是系统类预加载（Object、String、Class...），发生在 JNI_CreateJavaVM 内部。本文 §一 中应提及这个时序。

6. **向 14-zip-jimage 过渡**：`parse_manifest.c` 的 ZIP 解析依赖 ZIP 目录结构和 inflate 算法——14-zip-jimage 定义了这些底层实现。本文 §二 中应引用 14 的 ZIP 格式说明。
