# PROMPT: 请撰写 00-Libjli-Overview.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

凌晨 3 点 CI/CD pipeline 报错，发布阻塞：

```
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

`emessages.h:60` 的 `JVM_ERROR1` — 这是 libjli 触发的。你需要从 `JLI_Launch` 源码中判断：是 `dlopen(libjvm.so)` 失败（`java_md_solinux.c:571` 返回 NULL）？还是 `JNI_CreateJavaVM` 返回错误（`java.c:1545` 返回非 JNI_OK）？还是 `LoadMainClass` 找不到主类（`java.c:523` 返回 NULL → `CLS_ERROR1`）？还是 `FindClass` 失败（`CLS_ERROR1` in `emessages.h:68`）？

`JVM_ERROR1` 在 `java.c:429` 处打印 —— `if (!InitializeJVM(...)) { JLI_ReportErrorMessage(JVM_ERROR1); }`。`InitializeJVM` 内部只有一处返回 `JNI_FALSE`：`java.c:1545` 的 `ifn->CreateJavaVM()` 返回非 `JNI_OK`。所以"JVM_ERROR1"错误 = `JNI_CreateJavaVM()` 失败。但如果是 `LoadJavaVM()` 失败（`java.c:300` 返回 `JNI_FALSE`），错误是 `DLL_ERROR1`（`emessages.h` 的 DLL 宏），不是 `JVM_ERROR1`。如果是 `LoadMainClass` 失败（`java.c:523` 返回 NULL），错误是 `CLS_ERROR1`（`emessages.h:68`），也不是 `JVM_ERROR1`。

**反事实诊断**：如果日志只有 `JVM_ERROR1` 没有 `DLL_ERROR1` → `dlopen` 成功 → libjvm.so 找到且符号解析成功 → `JNI_CreateJavaVM` 被调用了 → 是 JVM 内部初始化失败（堆大小超限、模块系统错误、OOME）。如果日志有 `DLL_ERROR1` + `DLL_ERROR2` → `dlopen` 或 `dlsym` 失败 → libjvm.so 不存在或损坏。如果日志有 `CLS_ERROR1` → JVM 启动成功但 `FindClass` 找不到主类。

**诊断命令**（直接写进 §〇）：
```bash
# 1. 确认 libjvm.so 存在
stat $(dirname $(readlink -f /proc/self/exe))/../lib/server/libjvm.so

# 2. 确认 libjli.so 依赖完整
ldd $(dirname $(readlink -f /proc/self/exe))/../lib/jli/libjli.so

# 3. 检查虚拟内存限制（是否小于 -Xmx）
ulimit -v

# 4. trace JVM 启动过程
strace -e openat java -Xms128m -jar app.jar 2>&1 | grep ENOENT
```

---

## §一 Task + Narrative + Callouts

### Task

Reading this prompt, you will produce a document that traces EVERY step from `bash$ java -jar app.jar` to `main()` execution — with exact source file:line references for each step. This is the STORY of the `java` command, not a reference manual. Each section opens with WHY (the reason that step exists), not WHAT (the function name). Each section pastes 3-5 lines of actual source code from `java.c` / `java_md_solinux.c`, not paraphrases. Each section ends with a counterfactual question: "What if we skipped this step?"

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框，使用 > [!TIP] 或 ▍标记，exact text as below）

1. **dlopen** — POSIX 系统调用。把 `.so` 文件加载到进程地址空间。不同于静态链接——代码段可以被多个进程共享。`dlopen(libjvm.so)` 成功后，libjvm.so 的 ~20MB 代码段只需一份物理页，所有 `java` 进程共享。对应源码：`java_md_solinux.c:571`。

2. **dlsym** — POSIX 系统调用。根据函数名字符串在已加载的共享库中查找函数地址。返回函数指针。`dlsym(handle, "JNI_CreateJavaVM")` 返回 `JNI_CreateJavaVM` 的入口地址（`java_md_solinux.c:624`）。类型定义在 `java.h:79`：`typedef jint (JNICALL *CreateJavaVM_t)(JavaVM **pvm, void **env, void *args);`

3. **/proc/self/exe** — Linux 内核为每个进程创建的符号链接——指向实际可执行文件的绝对路径。不需要 `$PATH` 或 `$JAVA_HOME`。即使 `java` 是符号链接，`/proc/self/exe` 也指向最终目标。对应源码：`java_md_solinux.c:687-689`，`int len = readlink(self, buf, PATH_MAX);`

4. **JNI** — Java Native Interface。`09-native-interface` 阶段已详细分析。这里 libjli 使用 JNI 来调用 `JNI_CreateJavaVM`（`java.c:1545`）和 `FindClass`、`GetStaticMethodID`（`java.c:560`）、`CallStaticVoidMethod`（`java.c:566`）。JNI 函数表（`JNINativeInterface_`）在 `JNI_CreateJavaVM` 内部被初始化。

5. **LaunchMode** — `java.h:231` 的枚举：`LM_CLASS(1)` = 普通类加载（`-cp` 或无参数），`LM_JAR(2)` = `-jar` 模式，`LM_MODULE(3)` = `-m` 模块模式，`LM_SOURCE(4)` = 源代码模式（`--source`）。决定 `LoadMainClass` 的行为和 classpath 构造逻辑。定义：`enum LaunchMode { LM_UNKNOWN = 0, LM_CLASS, LM_JAR, LM_MODULE, LM_SOURCE };`

---

## §二 Environment

OpenJDK 11 slowdebug build, Linux x86_64.

Source roots:
- `src/java.base/share/native/libjli/` — 跨平台 launcher 核心逻辑
- `src/java.base/unix/native/libjli/` — Linux/Solaris 平台特定实现

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/bin/java` — C 入口，`main()` → 调用 `JLI_Launch()`
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/jli/libjli.so` — JLI_Launch 所在动态库
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 被 dlopen 加载的 HotSpot VM

Build commands:
```bash
cd openjdk11 && make jdk
```

GDB setup:
```bash
gdb --args java -Xms8g -jar app.jar
(gdb) break JLI_Launch
(gdb) break LoadJavaVM
(gdb) break InitializeJVM
(gdb) break LoadMainClass
(gdb) run
```

Verify environment:
```bash
ldd $(which java)                          # java 依赖 libjli.so
nm -D $JAVA_HOME/lib/jli/libjli.so | grep JLI  # libjli 导出符号
```

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|-------|----------------|------|
| 1 | `java.c` | `src/java.base/share/native/libjli/java.c` | ~2415 | `JLI_Launch`(:220), `LoadJavaVM`(:300 site), `ParseArguments`(:1296), `JavaMain`(:405), `InitializeJVM`(:1522), `LoadMainClass`(:1623), `SelectVersion`(:1056), `AddOption`(:932), `SetClassPath`(:985), `SetJavaCommandLineProp`(:1833) | 主入口 + 全流程编排 |
| 2 | `java_md_solinux.c` | `src/java.base/unix/native/libjli/java_md_solinux.c` | ~879 | `SetExecname`(:660), `CreateExecutionEnvironment`(:304), `LoadJavaVM`(:564→dlopen + dlsym), `GetJREPath`(:516), `GetJVMPath`(:490), `CallJavaMainInNewThread`(:772→pthread_create) | Linux 平台特定：JVM 发现/加载/线程创建 |
| 3 | `java_md_common.c` | `src/java.base/unix/native/libjli/java_md_common.c` | ~371 | `GetExecName`(:166), `TruncatePath`(:50), `GetApplicationHome`(:74) | Cross-Unix helpers |
| 4 | `java.h` | `src/java.base/share/native/libjli/java.h` | ~278 | `InvocationFunctions` struct(:83), `LaunchMode` enum(:231), `JavaMainArgs` struct(:242) | 共享数据结构 + JLI_Launch 签名 |
| 5 | `emessages.h` | `src/java.base/share/native/libjli/emessages.h` | ~123 | `JVM_ERROR1`(:60), `CLS_ERROR1`(:68), `JAR_ERROR2`(:65), `JAR_ERROR3`(:66), `DLL_ERROR1`, `DLL_ERROR2` | 错误消息宏定义 |

**跨模块说明**：`java.c` 是跨平台核心——所有平台的 `JLI_Launch` 逻辑相同。`java_md_solinux.c` 实现 Linux/Solaris 特有部分：`dlopen/dlsym`、`/proc/self/exe` 读取、`pthread_create`。两者的分界线在 `LoadJavaVM`：`java.c:300` 调用平台特定的 `LoadJavaVM()`（在 `java_md_solinux.c:564` 实现），后者做 `dlopen + dlsym` 的 dirty work。

---

## §四 Deep Dive Question Groups（≥8，EXACT questions + answer directions）

### 4.1 ★★★ JLI_Launch entry — the 12-parameter function

```
问题：
  ① 为什么 JLI_Launch(java.c:220) 有 12 个参数而不是只有 (argc, argv)？
       答案方向: 因为 `java` 命令可以用不同入口点场景调用：Windows (WinMain)、MacOS
       (NSApplicationMain)、Linux (main → JLI_Launch)。每个平台在 main() 中做了不同预处理——
       解析了版本号字符串(fullversion/dotversion)、程序名(pname/lname)、java预定义参数(jargv)、
       classpath通配符开关(cpwildcard)、Windows专用的 javaw 标志。这些预处理结果通过 JLI_Launch
       参数传入，避免跨平台重复。
       追问: 哪个参数是平台 main() 计算的？→ jargv（编译时 java args）、
       appclassv（预定义 classpath）、fullversion/dotversion（版本字符串）。

  ② 12 个参数中哪几个是"遗留未使用"的？
       答案方向: java.c:225 dotversion 标注 "UNUSED dot version defined"、
       java.c:230 ergo 标注 "unused"。
```

### 4.2 ★★ SelectVersion — choosing the JDK version

```
问题：
  ① SelectVersion(java.c:1056) 做什么？为什么在 CreateExecutionEnvironment 之前运行？
       答案方向: JAR 可能有不同版本要求（META-INF/MANIFEST.MF 中的 Created-By: 11）。
       SelectVersion 读取 JAR manifest → 提取版本 → 与当前 JRE 版本对比 → 如果不匹配 →
       选择正确的 JRE。它在 CreateExecutionEnvironment 之前运行是因为：如果版本不匹配，
       需要找到另一个 JRE 的路径 → 覆盖 jrepath → CreateExecutionEnvironment 使用正确的 JRE。
       追问: 如果选择了错误的 JRE 版本会怎样？→ ClassFormatError: Incompatible magic value
       在 FindClass 时——但 FindClass 在 JNI_CreateJavaVM 之后（java.c:523），意味着浪费了
       2s 启动时间才失败。

  ② 如果 MANIFEST.MF 中没有 Created-By 会发生什么？
       答案方向: SelectVersion 返回 main_class（从 manifest 提取），不改变版本选择。
       JLI_Launch 继续使用 /proc/self/exe 定位的 JRE。
```

### 4.3 ★★★ CreateExecutionEnvironment — finding the JRE

```
问题：
  ① 为什么用 /proc/self/exe 而不是 $JAVA_HOME？
       答案方向: /proc/self/exe 是内核保证的，永远指向实际运行中的二进制文件的绝对路径。
       $JAVA_HOME 可能：(a) 未设置（Docker 环境常见）；(b) 设置错误（stale 指向旧 JDK）；
       (c) 指向不同 JDK（多版本共存）。java_md_solinux.c:687-689 的 readlink("/proc/self/exe")
       不依赖任何环境变量。但代码也检查 $JAVA_HOME（java_md_solinux.c:530-550）——如果
       JAVA_HOME 存在且有效，用它作为 shortcut 跳过 /proc/self/exe 解析节省 ~5 个系统调用。
       
       追问: 如果 $JAVA_HOME 和 /proc/self/exe 指向不同 JDK 怎么办？
       → /proc/self/exe 优先——代码在 SetExecname 之后，GetJREPath 的 GetApplicationHome()
       基于 execname（全局变量，已在 java_md_solinux.c:704 被设为 /proc/self/exe 结果）。

  ② GetApplicationHome 的 TruncatePath 如何找到 JRE 根目录？
       答案方向: java_md_common.c:56-58 → p = findLastPathComponent(buf, "/bin/"); *p = '\0';
       截断 "/bin/java" → 得到 JRE 根目录。然后 java_md_solinux.c:532 验证 lib/libjava.so
       是否存在 → 不存在 → JRE_ERROR1 "Error: Could not find Java SE Runtime Environment."
```

### 4.4 ★★★ LoadJavaVM — dlopen(libjvm.so) + dlsym(JNI symbols)

```
问题：
  ① RTLD_NOW + RTLD_GLOBAL 意味着什么？为什么不用 RTLD_LAZY？
       答案方向: java_md_solinux.c:571 — RTLD_NOW: 立即解析所有未定义符号，任何缺失 →
       立即返回 NULL。RTLD_LAZY: 符号在首次使用时解析 → JVM 启动更快（跳过 ~200ms 的符号
       解析）但可能在运行时崩溃（"undefined symbol" error during operation）。
       RTLD_GLOBAL: libjvm.so 的符号对所有后续 dlopen 的库可见 → 这是 -agentlib 和 JNI
       agent 库能工作的前提。
       追问: 为什么 HotSpot 选 RTLD_NOW 而不是 RTLD_LAZY？→ 因为 JVM 崩溃比启动慢更致命。
       如果 libjvm.so 缺符号：RTLD_NOW → dlopen 报错 → 错误信息包含缺失的符号名 →
       立即知道原因。RTLD_LAZY → 可能在运行 1 小时后某个 cold code path 调用缺失符号 →
       突然崩溃 → 无法定位。

  ② dlsym 的三个 JNI 符号分别是什么？
       答案方向: java_md_solinux.c:624 → "JNI_CreateJavaVM" → ifn->CreateJavaVM；
       :630 → "JNI_GetDefaultJavaVMInitArgs" → ifn->GetDefaultJavaVMInitArgs；
       :637 → "JNI_GetCreatedJavaVMs" → ifn->GetCreatedJavaVMs。
       这三个是 JNI Invocation API 规范定义的——任何 JVM 实现（包括 GraalVM）必须导出。
       类型在 java.h:79-81：
         CreateJavaVM_t — jint (*)(JavaVM **pvm, void **env, void *args)
         GetDefaultJavaVMInitArgs_t — jint (*)(void *args)
         GetCreatedJavaVMs_t — jint (*)(JavaVM **vmBuf, jsize bufLen, jsize *nVMs)
```

### 4.5 ★★★ JVMInit → JavaMain — thread creation

```
问题：
  ① 为什么要在新线程中启动 JVM 而不是在 primordial 线程中运行？
       答案方向: java.c:202-204 注释："Running Java code in primordial thread caused many
       problems. We will create a new thread to invoke JVM. See 6316197 for more information."
       3 个原因：(1) primordial 线程的栈可能被 JVM 启动过程不可预测地修改；(2) 可以设自定义
       栈大小——java_md_solinux.c:782 pthread_attr_setstacksize(&attr, stack_size)；
       (3) 可以关闭 guard page 节省内存——:784 pthread_attr_setguardsize(&attr, 0)。
       追问: 如果 pthread_create 失败（OOM 或 LWP 耗尽）？→ java_md_solinux.c:791-798：
       退回到当前线程中直接调用 JavaMain(args) —— "This will likely fail later in
       JavaMain as JNI_CreateJavaVM needs to create quite a few new threads, anyway,
       just give it a try.." 这是一种乐观的回退策略。

  ② ThreadJavaMain 做了什么？
       答案方向: java_md_solinux.c:764-766 — 一个薄的 adapter：
         static void* ThreadJavaMain(void* args) {
             return (void*)(intptr_t)JavaMain(args);
         }
       它把 void* 类型的 pthread_create 回调适配到 JavaMain 的 int 返回值。
       JavaMain 是 java.c:405 的静态函数——所有 Java 进程的真正主循环。
```

### 4.6 ★★★ LoadMainClass — the first Java class

```
问题：
  ① 为什么 LoadMainClass(java.c:1623) 不直接调用 FindClass()？
       答案方向: 它通过 JNI 调用 Java 层的 sun.launcher.LauncherHelper.checkAndLoadMain()
       (java.c:1634-1640)。原因: FindClass() 返回 NULL 时需要通过 `(*env)->ExceptionCheck()`
       检查 JNI 异常——这在 C 代码中很冗长。LauncherHelper 是 Java 类，在 Java 端处理异常
       + 产生正确的错误消息（UTF-8 编码的类名、manifest 的重新解析）。
       追问: 这是 Java 通过 JNI 调用 Java 来避免 JNI 的复杂性——LauncherHelper 内部调用
       Class.forName() → 反射 → 最终走 bootstrap loader 的 FindClass。启动完成后，
       LauncherHelper 的类对象被缓存（helperClass 静态变量，java.c:1550）。

  ② LoadMainClass 如何区分 JAR 模式和 CLASS 模式？
       答案方向: java.c:1634-1640 — 根据 mode 参数（1=LM_CLASS, 2=LM_JAR, 3=LM_MODULE,
       4=LM_SOURCE）。LM_JAR 时，LauncherHelper 重新打开 JAR、读 manifest 的 Main-Class
       属性（UTF-8 正确处理——这是 java.c:498-504 注释中 bugid 5030265 的修复），
       然后调用 Class.forName(mainClassName)。

  ③ bugid 5030265 是什么？
       答案方向: java.c:498-504 — C 代码中的 manifest 解析不支持 UTF-8 编码的类名。
       SelectVersion 的 parse_manifest.c 提取的 main_class 被放到环境变量 _JAVA_VERSION_SET
       中（java.c:1206-1208），但 LoadMainClass 忽略它——调用 Java 层 LauncherHelper 重读
       manifest，获得正确的 UTF-8 处理。所以 manifest 被两次读取：第一次 C 代码（SelectVersion），
       第二次 Java 代码（LoadMainClass）。
```

### 4.7 ★★ CallStaticVoidMethod — entry into Java land

```
问题：
  ① java.c:566 CallStaticVoidMethod 调用前后——C stack vs JVM stack 的关系？
       答案方向: CallStaticVoidMethod 是 libjli 的执行终点。调用前，C stack 上有 JavaMain
       → LoadMainClass → InitializeJVM → ... 的帧。调用后 JVM 执行用户 main() 的 Java 代码——
       C stack 冻结（不再使用），JVM 在解释器/编译后的代码中运行。libjli 再也不会恢复控制，
       除非 main() return 或抛异常。
       追问: 如果 main() 抛异常？→ java.c:572 `ret = (*env)->ExceptionOccurred(env) == NULL ? 0 : 1;`
       → 返回 1 → LEAVE() → DetachCurrentThread + DestroyJavaVM → exit。

  ② 为什么 GetStaticMethodID 的签名是 "([Ljava/lang/String;)V"？
       答案方向: JNI 类型签名格式—— `[` = array, `L` = object type, `java/lang/String` = 类名,
       `V` = void。所以 `([Ljava/lang/String;)V` = "takes a String[] and returns void"。
       这正是 `public static void main(String[] args)` 的签名。
```

### 4.8 ★★★ The 13/01 responsibility split — where libjli ends and libjvm begins

```
问题：
  ① 13-launcher 和 01-jvm-startup 的精确分界线在哪里？
       答案方向: java.c:1545 — `r = ifn->CreateJavaVM(pvm, (void **)penv, &args);`
       这一行调用之前 = libjli 的领域（~0.05s）：解析参数、找 JRE、dlopen libjvm.so、
       设置 InvocationFunctions。这一行调用内部 = libjvm 的领域（~2s）：Threads::create_vm()、
       Universe::genesis()、interpreter_init()、系统类预加载、编译线程启动。
       这一行调用之后 = libjli 再次接管：LoadMainClass（java.c:523）→ FindClass →
       CallStaticVoidMethod（java.c:566）。
       
       追问: 所以 libjli → libjvm → libjli 是两次 handoff？→ 是的。第一次：libjli 交控制
       给 libjvm 做 JNI_CreateJavaVM。第二次：libjvm 返回后 libjli 调用 LoadMainClass →
       CallStaticVoidMethod → 最终交控制给 Java main()。libjli 是"中介"——它在 libjvm 和
       Java 应用之间来回穿梭。

  ② 这 8 个步骤各占多少时间？哪些是启动瓶颈？
       答案方向:
         Step 1 (SelectVersion): ~0.5ms — manifest 读取
         Step 2 (CreateExecutionEnvironment): ~1ms — /proc/self/exe + stat() checks
         Step 3 (LoadJavaVM/dlopen): ~20ms — dlopen + dlsym
         Step 4 (ParseArguments): ~1ms — 字符串比较
         Step 5 (Set properties): ~0.5ms
         Step 6 (JVMInit→pthread_create): ~0.5ms
         Step 7 (JNI_CreateJavaVM): ~2000ms — ★ 99% 的启动时间
         Step 8 (LoadMainClass + CallStaticVoidMethod): ~5-20ms
       JNI_CreateJavaVM 是绝对的瓶颈——libjli 的所有工作加起来 < 50ms，而 VM 初始化 ~2s。
```

---

## §五 Article Structure

```
§〇 生产场景 — 凌晨3点 CI/CD 阻塞：JVM_ERROR1 三段诊断
  ★ 真实错误消息（emessages.h:60）
  ★ 三段诊断：DLL_ERROR1（dlopen 失败）vs JVM_ERROR1（CreateJavaVM 失败）vs CLS_ERROR1（FindClass 失败）
  ★ 4 条诊断命令（stat / ldd / ulimit / strace）

§一 ★★★ JLI_Launch 全链路追踪（8 步源码走读）
  ❓ java MyClass 和 main() 之间的 0.05 秒发生了什么？
  ❓ 为什么 libjli 用 12 个参数，不是一个 (argc, argv)？
  1.1 Step 1: SelectVersion(java.c:1056) — 版本选择 + manifest 首读
  1.2 Step 2: CreateExecutionEnvironment(java_md_solinux.c:304) — JRE 路径发现
      ├─ SetExecname → /proc/self/exe (java_md_solinux.c:687-689)
      ├─ GetApplicationHome → TruncatePath("/bin/") (java_md_common.c:56-58)
      ├─ ReadKnownVMs → jvm.cfg (java.c:2084)
      └─ GetJVMPath → 拼接 lib/server/libjvm.so (java_md_solinux.c:490)
  1.3 Step 3: LoadJavaVM(java_md_solinux.c:564) — dlopen(libjvm.so)
      ├─ dlopen(jvmpath, RTLD_NOW + RTLD_GLOBAL) (:571)
      ├─ dlsym("JNI_CreateJavaVM") (:624)
      ├─ dlsym("JNI_GetDefaultJavaVMInitArgs") (:630)
      └─ dlsym("JNI_GetCreatedJavaVMs") (:637)
  1.4 Step 4: ParseArguments(java.c:1296) — 参数分类（详见 prompt-01）
  1.5 Steps 5-7: Set properties + SetClassPath (java.c:338-348)
  1.6 Step 8: JVMInit → pthread_create → JavaMain (java_md_solinux.c:772-786)
  1.7 ★ Mermaid: libjli↔libjvm 责任边界序列图
      Lanes: Shell, libjli, libjvm, Java
      从 bash$ java 到 main()
  1.8 ★ 面试 Story Format 答案 — "java MyClass 和 main() 之间发生了什么？"
      两段答案。第一段 libjli（~0.05s）。第二段 libjvm（~2s）。
      详见 README §五 Q1 的故事模板。

§二 ★★★ libjli → libjvm 的两次 handoff
  ❓ 为什么 libjli 不一次做完所有事？为什么要两次 handoff？
  2.1 Handoff 1: JNI_CreateJavaVM(java.c:1545) — C→C++→VM初始化
      → 进入 01-jvm-startup §一
  2.2 Handoff 2: CallStaticVoidMethod(java.c:566) — C→Java→用户 main()
  2.3 libjli 为什么"夹在中间"？
      — 因为 CreateJavaVM 需要 C 调用者做内存管理（options 数组的 malloc/free）
      — 因为 LoadMainClass 需要 Java 层 helper 做 UTF-8 manifest 解析
      — 因为 CallStaticVoidMethod 需要 JNI env（来自 CreateJavaVM 返回的 env）

§三 ★★ InvocationFunctions — 3 个函数指针的生命周期
  ❓ InvocationFunctions 结构体(java.h:83-87)是怎么被填满的？
  ❓ 为什么三个函数指针都不是直接调用而是通过结构体？
  3.1 填充：LoadJavaVM(java_md_solinux.c:624-642) → dlsym × 3
  3.2 使用1：InitializeJVM(java.c:1545) → ifn->CreateJavaVM(...)
  3.3 使用2：不需要 GetDefaultJavaVMInitArgs / GetCreatedJavaVMs 在普通启动流中
      但 jcmd / jstat 等工具通过 JNI AttachCurrentThread 使用 GetCreatedJavaVMs
  3.4 Counterfactual: 如果直接调用 JNI_CreateJavaVM 而不是通过函数指针？
      → 静态链接 libjvm → 失去运行时选择 jvmtype 的能力（-server vs -client）

§四 ★★★ 从 dlopen 到 JNI_CreateJavaVM 的精确数据流
  ❓ options 数组怎样从 AddOption 收集传递到 JNI_CreateJavaVM？
  ❓ JavaVMInitArgs 的 ignoreUnrecognized 为什么是 JNI_FALSE？
  4.1 AddOption(java.c:932) — 全局 options[] 数组 + ×2 扩容算法
  4.2 JavaVMInitArgs 构造(java.c:1524-1531) — version/JNI_VERSION_1_2
  4.3 传递：options → args.options → ifn->CreateJavaVM(&vm, &env, &args)
  4.4 释放：java.c:1546 JLI_MemFree(options) — 调用后 options 立即释放
      因为 JVM 已复制 options 到自己的 internal structures

§五 ★★ 5 个 Beginner Callout 框
  5.1 dlopen — 共享库加载 + 物理页共享
  5.2 dlsym — 函数名字符串 → 函数指针
  5.3 /proc/self/exe — 内核保证的二进制路径
  5.4 JNI — Java Native Interface bridge
  5.5 LaunchMode — 4 种启动模式枚举

§六 ★ GDB 断点验证 — 6 断点完整 trace
  断言 1: JLI_Launch(java.c:220) — 打印 mode=LM_UNKNOWN, what=NULL
  断言 2: SelectVersion(java.c:1056) — 打印 main_class
  断言 3: CreateExecutionEnvironment(java_md_solinux.c:304) — 打印 jrepath, jvmpath
  断言 4: LoadJavaVM/dlopen(java_md_solinux.c:571) — 打印 libjvm handle
  断言 5: InitializeJVM/CreateJavaVM call(java.c:1545) — 打印 options 数组
  断言 6: LoadMainClass(java.c:1623) — 打印 mode + what
  断言 7: CallStaticVoidMethod(java.c:566) — 打印 mainClass
  断言 8: java_md_solinux.c:786 pthread_create — 验证新线程创建
  断言 9: java.c:429 JVM_ERROR1 — 验证 "Could not create JVM" 错误路径
  断言 10: java.c:572 ExceptionOccurred — 验证 main() 抛出异常的返回码

§七 Cross-Reference
  ❓ 01-jvm-startup §一 — java.c:1545 = JNI_CreateJavaVM 入口 = 01 的 §一
  ❓ 02-class-loading — java.c:523 LoadMainClass → FindClass → 双亲委派 → 02
  ❓ 04-system-preload — JNI_CreateJavaVM 内部的系统类预加载 → 04
  ❓ 09-native-interface — JNI Env 结构体的初始化和使用 → 09
  ❓ 14-zip-jimage — manifest ZIP 解析（parse_manifest.c）→ 14
  ❓ 18-agent-instrument — -javaagent 参数传递 → 18
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY**（"Because the JVM needs to find libjvm.so before it can call JNI_CreateJavaVM, JLI_Launch's first task is..."）— not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from `java.c` / `java_md_solinux.c`, do not describe it.

3. **Mermaid** — 13/01 responsibility split sequence diagram. Lanes: Shell, libjli, libjvm, Java. From `bash$ java` to `main()`. Include every handoff point with file:line annotations.

4. **GDB session** — 6-10 breakpoints with exact file:line numbers:
   - `JLI_Launch` (java.c:220)
   - `SelectVersion` (java.c:1056)
   - `CreateExecutionEnvironment` (java_md_solinux.c:304)
   - `LoadJavaVM` / dlopen (java_md_solinux.c:571)
   - `JNI_CreateJavaVM` call (java.c:1545)
   - `LoadMainClass` (java.c:1623)
   - `CallStaticVoidMethod` (java.c:566)
   Each with expected variable values to verify.

5. **5 Beginner callout boxes** — the exact text from §一.

6. **Cross-reference at JNI_CreateJavaVM point** — "→ 进入 01-jvm-startup §一" with bold formatting.

7. **Story-format interview answer** — at §一末尾, use README §五 Q1's two-segment story template, formatted as a narrative answer (not a table), mermaid included.

8. **§〇 production diagnosis** — use exact error text from emessages.h:60, with 3-branch diagnosis（dlopen失败 / CreateJavaVM失败 / FindClass失败）和 4 条诊断命令.

---

## §七 Output Format

- Markdown file, named `00-Libjli-Overview.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/13-launcher/`
- 元信息头：

```
> **阶段**：[13-launcher]
> **前置**：[01-jvm-startup] §一（理解 JNI_CreateJavaVM 的作用）
> **配套**：[01-Argument-Parsing]（ParseArguments 的详细分类逻辑）、[02-class-loading]（LoadMainClass 的 FindClass 流程）
> **后续依赖本文**：[02-JVM-Loading]（libjvm.so 的完整路径定位机制）、[03-Main-Class-Loading]（manifest 解析 + main 调用链）
> **阅读收益**：追踪 `bash$ java -jar app.jar` 到 `main()` 的 8 步完整链路——从 JLI_Launch 的 12-参数入口到 dlopen(libjvm.so) 到 JNI_CreateJavaVM 到 LoadMainClass 到 CallStaticVoidMethod；理解 libjli（~0.05s）和 libjvm（~2s）的责任边界和两次 handoff；掌握 JVM_ERROR1 的三段诊断 workflow
```

- 目标行数: 400+ lines

---

## §八 Prohibited (≥8)

- ❌ 只列函数调用顺序不做 WHY 分析 — 每个步骤必须解释"为什么这是必要的"，不能只做"A calls B calls C"的源码翻译
- ❌ 忽略 12 参数签名的含义 — 必须解释每个参数是谁计算的、为什么需要 12 个
- ❌ 不解释 /proc/self/exe vs $JAVA_HOME 的优势 — 必须对比两种方式，用源码证明优先级
- ❌ 把 JNI_CreateJavaVM 的内部实现写进本文 — 那是 01-jvm-startup 的范畴；本文只写到 java.c:1545 调用点
- ❌ 忽略 pthread_create 的失败回退 — 必须提到 java_md_solinux.c:791-798 的"continue in current thread"回退逻辑
- ❌ 不做 JVM_ERROR1 的三段诊断 — §〇 必须区分 DLL_ERROR1 vs JVM_ERROR1 vs CLS_ERROR1
- ❌ 把 InvocationFunctions 当作黑盒 — 必须展示 java.h:79-87 的类型定义 + dlsym 的三个符号名
- ❌ 忘记 bugid 5030265 — 必须提到 manifest 的两次读取（C 代码 SelectVersion + Java 代码 LoadMainClass）及其 UTF-8 原因
- ❌ 不解释 RTLD_NOW vs RTLD_LAZY — 这是生产环境选择的关键差异
- ❌ 省略 5 个 beginner callout 框 — 必须出现在文档中，使用 exact text from §一
- ❌ 不要解释 C 语言基础（argc, argv, 指针运算）——这是 JVM 文档，不是 C 语言教程
- ❌ 不要深入解释 POSIX dlopen/dlsym 语义（11-os-layer 覆盖）

---

## §九 Required (≥8)

- ✅ **★ Mermaid 13/01 责任边界序列图** — 4 lanes: Shell / libjli / libjvm / Java. Annotate every handoff with file:line
- ✅ **★ 8 步 JLI_Launch 全链路源码走读** — 每步都有函数名 + 行号 + 3-5 行源码 + WHY 分析
- ✅ **★ 5 个 Beginner Callout 框** — exact text from §一, formatted as distinct callout boxes
- ✅ **★ JVM_ERROR1 三段诊断** — DLL_ERROR1 vs JVM_ERROR1 vs CLS_ERROR1 + 4 条诊断命令
- ✅ **★ InvocationFunctions 结构体展示** — java.h:79-87 的完整 typedef + dlsym 的三个字符串
- ✅ **★ /proc/self/exe 流程** — java_md_solinux.c:687-689 源码 + TruncatePath(java_md_common.c:56-58)
- ✅ **★ 面试 Story Format 答案** — § 一末尾，两段式叙事（libjli + libjvm），含 mermaid，可直接背诵
- ✅ **★ GDB 断点 ≥10 条** — 精确到 file:line，每断点有预期变量值
- ✅ **★ 交叉引用** — 01-jvm-startup §一、02-class-loading、04-system-preload、09-native-interface、14-zip-jimage、18-agent-instrument
- ✅ **★ 从 dlopen 到 JNI_CreateJavaVM 的 options 数组数据流** — AddOption → JavaVMInitArgs → CreateJavaVM 完整路径

---

## §十 GDB Verification (≥10 assertions)

```
断言 1: JLI_Launch(java.c:220) 入口
  (gdb) break java.c:220
  (gdb) print argc → 期望: 命令行参数数量（包括 java 本身和 -jar app.jar）
  (gdb) print mode → 期望: 0 (LM_UNKNOWN)
  (gdb) print what → 期望: 0x0 (NULL)

断言 2: SelectVersion(java.c:1056) 入口
  (gdb) break java.c:1056
  (gdb) print *pargv[0] → 期望: 命令行第一个参数
  (gdb) print main_class → 期望: 从 MANIFEST.MF 提取的 Main-Class 字符串

断言 3: CreateExecutionEnvironment(java_md_solinux.c:304) 入口
  (gdb) break java_md_solinux.c:304
  (gdb) print *pargv → 期望: 命令行参数指针
  (gdb) print jrepath → 期望: 未初始化的 char 数组

断言 4: SetExecname — /proc/self/exe readlink(java_md_solinux.c:689)
  (gdb) break java_md_solinux.c:689
  (gdb) print self → 期望: "/proc/self/exe"
  (gdb) print buf[0]@len → 期望: ".../jdk/bin/java" 的绝对路径

断言 5: GetApplicationHome — TruncatePath(java_md_common.c:56-58)
  (gdb) break java_md_common.c:56
  (gdb) print buf → 期望: 包含 "/bin/" 的可执行文件路径
  (gdb) continue
  (gdb) print *p → 期望: '\0'（截断后的位置）

断言 6: GetJVMPath(java_md_solinux.c:490) — 拼接 libjvm.so 路径
  (gdb) break java_md_solinux.c:490
  (gdb) print jrepath → 期望: 包含 "lib/libjava.so" 的 JRE 根目录
  (gdb) print jvmtype → 期望: "server"
  (gdb) continue
  (gdb) print jvmpath → 期望: ".../lib/server/libjvm.so"

断言 7: LoadJavaVM — dlopen(java_md_solinux.c:571)
  (gdb) break java_md_solinux.c:571
  (gdb) print jvmpath → 期望: libjvm.so 完整路径
  (gdb) continue
  (gdb) print libjvm → 期望: 非 NULL（dlopen 成功返回 handle）

断言 8: dlsym("JNI_CreateJavaVM")(java_md_solinux.c:624)
  (gdb) break java_md_solinux.c:624
  (gdb) continue
  (gdb) print ifn->CreateJavaVM → 期望: 非 NULL 函数指针

断言 9: InitializeJVM — CreateJavaVM 调用(java.c:1545)
  (gdb) break java.c:1545
  (gdb) print args.nOptions → 期望: ≥1（至少包含 -Djava.class.path）
  (gdb) print args.options[0] → 期望: 第一个 JavaVMOption
  (gdb) continue
  (gdb) print r → 期望: 0 (JNI_OK)

断言 10: LoadMainClass(java.c:1623)
  (gdb) break java.c:1623
  (gdb) print mode → 期望: 2 (LM_JAR) 或 1 (LM_CLASS)
  (gdb) print what → 期望: jar 文件名或类名
  (gdb) continue
  (gdb) print mainClass → 期望: 非 NULL（FindClass 成功返回 jclass）

断言 11: CallStaticVoidMethod(java.c:566)
  (gdb) break java.c:566
  (gdb) print mainClass → 期望: jclass handle（非 NULL）
  (gdb) print mainID → 期望: jmethodID handle（非 NULL）

断言 12: pthread_create(java_md_solinux.c:786)
  (gdb) break java_md_solinux.c:786
  (gdb) print tid → 期望: 新线程 ID（非 0）
  (gdb) print attr → 期望: pthread_attr_t with custom stack_size + no guard page

断言 13: JVM_ERROR1 路径(java.c:429) — 故意使 -Xmx 超大触发
  (gdb) jump java.c:430 → 跳过 InitializeJVM 调用测试错误处理
  或: java -Xmx999999g -version
  (gdb) print JVM_ERROR1 → 期望: "Error: Could not create the Java Virtual Machine...\n..."
```
