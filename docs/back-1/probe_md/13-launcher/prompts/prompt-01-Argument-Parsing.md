# PROMPT: 请撰写 01-Argument-Parsing.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

JDK 11 生产环境——工程师加了 `-XX:+UseZGC` 尝试降低延迟。ZGC 在 JDK 11 中是实验性特性（需要 `-XX:+UnlockExperimentalVMOptions` 前置），但直接被 libjli 的 `ParseArguments` 当作 JVM 选项透传到 `AddOption("-XX:+UseZGC", NULL)` → 选项进入 `options[]` 数组 → 传递给 `JNI_CreateJavaVM`（`java.c:1545`）→ JVM 内部 `Arguments::parse()` 不拒绝（实验性选项被接受但语义不完整）→ 1s 预热后 C2 开始编译 → ZGC 的 `ZBarrierSetC2::emit_barrier_stub()` 触发 NullPointerException → SIGSEGV → hs_err 没有明确指出 ZGC 原因（只显示 SIGSEGV in ZBarrierSetC2::emit_barrier_stub）。

**核心问题**：应该在哪里拦截 `-XX:+UseZGC`（缺少 `-XX:+UnlockExperimentalVMOptions`）——libjli 还是 libjvm？libjli 能做吗？它是否有足够的信息知道 ZGC 需要 UnlockExperimentalVMOptions？

**答案**：libjli 不能——它只做字符串匹配分类（`java.c:1307` 的 `while (*arg == '-')` 循环），不知道 `-XX:` 选项的语义约束。拦截必须在 libjvm 的 `Arguments::parse()` 中。但 libjli 可以改进：在 `AddOption()` 中对已知危险选项（`-XX:+UseZGC` on JDK < 15）打印 stderr warning → early warning without blocking。

**诊断命令**（直接写进 §〇）：
```bash
# 1. 查看传给了 JNI_CreateJavaVM 的完整选项 list
java -XX:+PrintCommandLineFlags -XX:+UseZGC -XX:+UnlockExperimentalVMOptions -version

# 2. 查看所有 XX 选项的默认值和状态
java -XX:+PrintFlagsFinal -version | grep -i zgc

# 3. 验证选项是否被 AddOption 收集（GDB 断点）
gdb -ex "break java.c:1545" -ex "run" -ex "print args.nOptions" -ex "print args.options[0].optionString" \
    --args java -XX:+UseZGC -jar app.jar
```

**反事实**：如果 libjli 在每个 `AddOption` 调用时检查选项合法性 → libjli 需要维护 libjvm 的所有选项约束 → 两份代码同步维护 → 总是过时（libjvm 添加新选项 libjli 不知道）。正确的分层：libjli 只分类和透传（transport layer），libjvm 做验证（semantic layer）。

**`-XX:-UseZGC` 排除确认**：`-XX:-UseZGC` → exclude ZGC → retry。如果 crash 停止 → ZGC 确认为根因 → 三种路径：(a) 添加 `-XX:+UnlockExperimentalVMOptions`（生产环境有风险），(b) 升级到 JDK 15+（ZGC production-ready），或 (c) 完全移除 ZGC flag。

---

## §一 Task + Narrative + Callouts

### Task

Reading this prompt, you will produce a document that explains `ParseArguments(java.c:1296-1503)` — a ~300-line C function that is NOT "split by space" but a STATE MACHINE distinguishing 4 categories of arguments: **JVM options** (`-Xms`, `-XX:+UseG1GC` → `AddOption` → `options[]` → `JNI_CreateJavaVM`), **launcher options** (`-jar`, `-cp`, `-m`, `--source` → set `mode` + `what`), **application arguments** (`Main arg1 arg2` → preserved in `argv` for `main(String[] args)`), and **properties** (`-Dfoo=bar` → `AddOption` → `options[]`). A misclassification → JVM receives wrong options → crash or silent failure.

### Beginner Callout Boxes（文档中必须出现的 3 个 callout 框）

1. **LaunchMode** — `java.h:231` 的枚举。`LM_CLASS(1)` = `-cp` 或直接类名，`LM_JAR(2)` = `-jar`，`LM_MODULE(3)` = `-m` 模块模式，`LM_SOURCE(4)` = 源代码文件。ParseArguments 的第一个任务就是检测 `mode` —— 因为模式决定了后续 300 lines 的控制流走向（`-cp` 在 `LM_JAR` 下无用，`-m` 禁止和 `-jar` 同时出现）。

2. **Wildcard expansion** — `java -cp 'lib/*.jar'` 中的 `*` 不是 shell glob —— 它是 libjli 在 `SetClassPath(java.c:997)` 中调用的 `JLI_WildcardExpandClasspath()`（`wildcard.c:303`）展开的。内部：`opendir()` + `readdir()` 枚举目录 → `isJarFileName()` 筛选 `.jar`/`.JAR` 后缀（`wildcard.c:222-231`）→ `qsort()` 按字母排序（`wildcard.c:210`）→ `:` 分隔符 join。注意：manifest `Class-Path` 属性不支持通配符（`wildcard.c:70-71`）。

3. **JVM option vs application arg** — 分类的核心。`AddOption()`（`java.c:932`）将 JVM 选项 push 到全局 `options[]` 数组，该数组在 `InitializeJVM(java.c:1524-1531)` 中转为 `JavaVMInitArgs.options` → 传给 `JNI_CreateJavaVM`。不以 `-` 开头的参数 = 应用参数 → 原样保留在 `argv` 中传给 `main(String[] args)`。以 `-` 开头但不在已知列表中的 → 被 `AddOption` 透传（libjli 不知道的 `-XX:` 选项直接透传给 JVM，JVM 自己验证）。

---

## §二 Environment

Same as prompt-00 §二. OpenJDK 11 slowdebug, Linux x86_64.

Source roots:
- `src/java.base/share/native/libjli/` — `ParseArguments`, `AddOption`, `SetClassPath`, `GetOpt` in `java.c`
- `src/java.base/share/native/libjli/args.c` — `JLI_AddArgsFromEnvVar`, args consolidation
- `src/java.base/share/native/libjli/wildcard.c` — `JLI_WildcardExpandClasspath`, `isJarFileName`

Key data structures (in `java.h`):
- `LaunchMode` enum (`java.h:231`): `LM_UNKNOWN=0, LM_CLASS=1, LM_JAR=2, LM_MODULE=3, LM_SOURCE=4`
- `InvocationFunctions` (`java.h:83-87`): three JNI function pointers
- `JavaVMOption` (`jni.h`): `{ char *optionString; void *extraInfo; }`
- `JavaVMInitArgs` (`jni.h`): `{ jint version; jint nOptions; JavaVMOption *options; jboolean ignoreUnrecognized; }`

Global state (in `java.c`):
- `static JavaVMOption *options = 0` — JVM option accumulator
- `static int numOptions = 0`, `static int maxOptions = 0` — option array tracking
- `static jlong threadStackSize = 0`, `static jlong maxHeapSize = 0`, `static jlong initialHeapSize = 0`

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|-------|----------------|------|
| 1 | `java.c` | `src/java.base/share/native/libjli/java.c` | ~2415 | `ParseArguments`(:1296), `AddOption`(:932), `SetClassPath`(:985), `GetOpt`(:? local), `checkMode` | 参数分类 + 分发 |
| 2 | `args.c` | `src/java.base/share/native/libjli/args.c` | ~715 | `JLI_AddArgsFromEnvVar`, `JLI_List` operations | @argfile 展开 + 环境变量合并 |
| 3 | `wildcard.c` | `src/java.base/share/native/libjli/wildcard.c` | ~394 | `JLI_WildcardExpandClasspath`(:303), `isJarFileName`(:222), `WildcardIterator_for/next/close` | Classpath 通配符 `*` → dir scan |
| 4 | `java.h` | `src/java.base/share/native/libjli/java.h` | ~278 | `LaunchMode`(:231), `InvocationFunctions`(:83), `ARG_CHECK` macro | 数据结构 |
| 5 | `emessages.h` | `src/java.base/share/native/libjli/emessages.h` | ~123 | `ARG_ERROR1` 到 `ARG_ERROR17`（参数错误消息） | 错误消息宏 |

**跨模块说明**：`ParseArguments` 是 `JLI_Launch` 中的第 4 步（`java.c:333`），在 `LoadJavaVM` 之后执行。为什么在这个顺序？因为 ParseArguments 调用 `AddOption` 收集 JVM 选项 → 这些选项必须在 `JNI_CreateJavaVM`（`java.c:1545`）之前就准备好。`JLI_Launch` 先 dlopen libjvm 拿到函数指针 → 再解析参数 → 再调用 CreateJavaVM。

---

## §四 Deep Dive Question Groups（≥8，EXACT questions + answer directions）

### 4.1 ★★★ ParseArguments entry — ~300 lines of classification as a state machine

```
问题：
  ① ParseArguments(java.c:1296-1503) 不是顺序扫描而是状态机——状态是什么？
       答案方向: java.c:1302 → int mode = LM_UNKNOWN。整个 ParseArguments 是一个
       "mode discovery" 过程：while 循环（java.c:1307）处理所有 `-` 开头的参数 →
       检测 `-jar`/`-m`/`--source` → 设 mode → 继续扫描剩余的 JVM 选项 → 直到第一个
       非 `-` 参数 → 提取 `what`（类名/jar 文件名/模块名，java.c:1476-1478）→ 退出循环 →
       根据 mode + what 做 post-processing（java.c:1480-1503）。

  ② 分类的优先级是什么？`-jar` 和 `-m` 同时存在怎么办？
       答案方向: java.c:1317 checkMode(mode, LM_JAR, arg) 检查 mode 是否 ≠ LM_UNKNOWN
       且 ≠ LM_JAR → 如果是 → 报错 "mutually exclusive arguments"。`-jar` 优先于
       后续的 `-cp`——即使用户指定了 `-cp foo:bar`，`java.c:338` 的 if (mode == LM_JAR)
       会用 `SetClassPath(what)` 覆盖用户 classpath（JAR 文件名成为 classpath）。
       `-m` 和 `-jar` 是互斥的 → checkMode 报错。

  ③ 如果一个参数不以 `-` 开头，它在什么情况下会被识别为类名？
       答案方向: java.c:1476-1477 → `if (*pwhat == NULL && --argc >= 0) { *pwhat = *argv++; }`
       第一个非 `-` 参数 = `what`（目标名称）。java.c:1485-1491 → 如果 mode 仍为
       LM_UNKNOWN → 默认设 mode = LM_CLASS（或如果 what 是 .java 文件 → mode = LM_SOURCE）。
       如果 `-cp` 已指定但类名在后面 → mode 在 `-cp` 检测时已设为 LM_CLASS。
```

### 4.2 ★★★ LaunchMode selection — 4 modes, 4 execution paths

```
问题：
  ① 4 个 LaunchMode 对应的 JLI_Launch 后续行为分别是什么？
       答案方向:
         LM_CLASS: java.c:338-340 → SetClassPath（如果 -cp 或 CLASSPATH 环境变量指定）
           → java.c:523 LoadMainClass(env, mode, what) → 直接 FindClass(what)
         LM_JAR: java.c:338 → SetClassPath(what) — 用 JAR 文件名覆盖 classpath
           → java.c:523 LoadMainClass(env, mode, what) → LauncherHelper 读 JAR manifest 的 Main-Class
         LM_MODULE: java.c:338-340 → SetClassPath（如果有 -cp 则保留）
           → java.c:523 LoadMainClass(env, mode, what) → FindClass(module's main class)
         LM_SOURCE: java.c:1497-1504 → AddOption("--add-modules=ALL-DEFAULT")
           → *pwhat = SOURCE_LAUNCHER_MAIN_ENTRY → 调整 argv 以包含源文件名
           → 最终由 jdk.compiler 模块编译 + 执行

  ② 如果 mode == LM_JAR，`-cp` 被指定了但被忽略——这是 bug 还是设计？
       答案方向: java.c:338 `if (mode == LM_JAR) SetClassPath(what);` — 这是有意的设计。
       JAR 文件规范说 JAR 应该是自包含的：所有依赖通过 manifest Class-Path 指定。
       如果 libjli 同时使用 -cp 和 JAR classpath → 类加载顺序变成非确定性 →
       同一个类名可能从两个路径加载 → 行为取决于路径顺序 → 生产隐患。
       追问: 如果确实需要额外的 classpath？→ 用 manifest 的 Class-Path 属性，或不用 -jar
       而用 `java -cp app.jar:dependency.jar com.example.Main`。
```

### 4.3 ★★★ JVM option vs application arg — the boundary

```
问题：
  ① AddOption(java.c:932) 收集了哪些 JVM 选项？它如何区分 JVM 选项和应用参数？
       答案方向: AddOption 不区分——任何传给它的字符串都被加到 options[] 数组。
       区分发生在 ParseArguments 的调用流中：
         java.c:976-981 → 识别 "-Xms" / "-Xmx" → AddOption → 还提取数值到 initialHeapSize/maxHeapSize
         java.c:954-966 → 识别 "-Xss" → AddOption → 提取 threadStackSize
         java.c:1472 → else 分支：所有未被特定 if 匹配的 "-*" 参数 → AddOption(arg, NULL)
         java.c:1345-1347 → "-cp" / "-classpath" → SetClassPath(value)（NOT AddOption — 走不同的路）
       应用参数（不含 `-` 前缀）→ 不在 while 循环中处理 → 保留在 argv 中 → 传给 main(String[] args)。

  ② 如果传了一个未知的 `--my-app-flag=value` 会怎样？
       答案方向: java.c:1307 `while (*arg == '-')` → 进循环 → java.c:1472 else 分支
       → AddOption("--my-app-flag=value", NULL) → 成为 JVM 选项 → JNI_CreateJavaVM 收到
       → JVM 的 Arguments::parse() 发现 `--my-app-flag` 不是已知选项 → 
       ignoreUnrecognized = JNI_FALSE (java.c:1531) → JNI_CreateJavaVM 返回 JNI_EINVAL
       → java.c:1547 返回 JNI_FALSE → java.c:429 JVM_ERROR1。
       追问: 如果 ignoreUnrecognized = JNI_TRUE → JNI_CreateJavaVM 忽略未知选项 → JVM 启动成功。
       但 HotSpot 生产环境设为 JNI_FALSE 以 fail-fast 方式暴露配置错误。
```

### 4.4 ★★ AddOption — the JVM option collector with doubling array

```
问题：
  ① AddOption 的扩容策略是什么？为什么这样设计？
       答案方向: java.c:938-950 → 如果 numOptions >= maxOptions：
         • 首次分配：maxOptions = 4, options = JLI_MemAlloc(4 * sizeof(JavaVMOption))
         • 后续扩容：maxOptions *= 2, 重新 JLI_MemAlloc, memcpy 旧数据, JLI_MemFree 旧数组
         这是一个经典的 ×2 倍增策略——摊销 O(1) 插入时间。首次 4 是合理的预估（大多数
         Java 启动只有 ~5-20 个 JVM 选项）。追问: 如果 options 有 1000+ 条目（大量 -D 属性）？
         → 最终扩容 ~8 次（4→8→16→32→64→128→256→512→1024），每次 memcpy ~N 大小 → 总 memcpy ~2N。

  ② AddOption 对 -Xss/-Xmx/-Xms 的特殊处理是什么？
       答案方向: java.c:954-981 → 除了 AddOption（存字符串到 options[] 数组），还提取数值：
         -Xss → threadStackSize（+ 下限检查 STACK_SIZE_MINIMUM=64KB，java.c:212）
         -Xmx → maxHeapSize
         -Xms → initialHeapSize
       这些值后被 ShowSettings(java.c:1912-1927) 用于诊断输出。libjli 做浅层解析（提取值
       用于打印），libjvm 做深层解析（实际分配堆内存）。这是 dual-parsing 模式——libjli
       提取可显式值但没有 VM 语义知识（不知道 G1 的最小堆大小）。
```

### 4.5 ★★★ Wildcard expansion — opendir not glob

```
问题：
  ① 为什么 libjli 在启动时展开通配符而不是延迟到类加载时？
       答案方向: wildcard.c:303 JLI_WildcardExpandClasspath() → opendir(dirname) →
       readdir → isJarFileName(name) → 只匹配 .jar/.JAR 后缀 → qsort 字母排序 →
       join with ':' 分隔符。启动时展开的好处：
       (1) 类加载器不需要知道通配符——它只看到完整路径列表
       (2) 类加载时每次 FindClass 不需要 readdir——1000 个 JAR 的目录每次 FindClass
       都要 O(n) 扫描 → 慢 1000×
       (3) 启动时一次性枚举 + 排序 → 类加载行为确定（classpath 顺序固定）
       追问: Shell 不是已经展开 `*.jar` 了吗？→ Shell 用 glob 不是 JAR-specific 的，
       可能包含非 JAR 文件（.zip, .txt）。libjli 的 isJarFileName 精确匹配 .jar/.JAR

  ② 通配符展开的开销有多大？
       答案方向: opendir 枚举 1000 个 JAR 需要 ~2ms（readdir × 1000）。这是大 classpath
       启动慢的一个根因。Java 9+ 的模块系统（jmod/jimage）设计动机之一就是消除
       通配符展开的需要——模块系统通过 module-info.class 声明依赖，不需要运行时扫描目录。
```

### 4.6 ★★ Classpath construction — `-jar` vs `-cp`

```
问题：
  ① SetClassPath(java.c:985) 如何将 classpath 传给 JVM？
       答案方向: java.c:985-1009 → 接收 classpath 字符串 → 先调用 JLI_WildcardExpandClasspath
       → 将展开后的路径格式化为 `-Djava.class.path=<value>` 字符串 → AddOption(def, NULL)
       → 作为 JVM 系统属性传给 JNI_CreateJavaVM。注意：这是一个 "-D" 属性——不是单独的
       classpath 参数。JVM 的 ClassLoader 在初始化时读取 `System.getProperty("java.class.path")`。

  ② 如果在 `-jar` 模式下设置了 `-cp`，同时 CLASSPATH 环境变量也存在——哪个生效？
       答案方向: java.c:338 if (mode == LM_JAR) SetClassPath(what) — 覆盖一切。
       甚至之前的 CLASSPATH 环境变量（java.c:322-324，在 ParseArguments 之前处理的）
       也被覆盖。jar 文件名成为 classpath。但—classpath/-cp 仍然会尝试 SetClassPath(value)
       （java.c:1346-1347），只是随后被 java.c:338 覆盖。
       追问: 为什么不直接报错"jar 模式不接受 -cp"？→ 向后兼容——某些脚本可能无意识地同时使用。
       libjli 选择 silently ignore 而不是 break existing scripts。
```

### 4.7 ★ -version / -showversion — 提前退出，不启动 JVM

```
问题：
  ① 为什么 -version 在 ParseArguments 中处理而不等 JNI_CreateJavaVM 之后再打印？
       答案方向: java.c:1391-1397 → -version / --version → printVersion = JNI_TRUE →
       return JNI_TRUE。ParseArguments 返回后，JLI_Launch 的后续步骤（java.c:333 之后）
       检查 ret 值并短路。版本信息来自 _fVersion（java.c:243 — JLI_Launch 的 fullversion
       参数），这是在 main() 中已经解析好的字符串——不需要 dlopen libjvm.so 就能拿到。
       反事实: 如果 -version 等到 JNI_CreateJavaVM 之后 → 浪费 ~2s 启动时间只为打印
       一个版本字符串。这就是为什么这些 flag 在 libjli 中处理——0.0001s vs 2s。

  ② -showversion 和 -version 的区别？
       答案方向: -version → 打印版本后 exit。java.c:1392 → printVersion = JNI_TRUE,
       return JNI_TRUE（短路，不启动 JVM）。-showversion → 先打印版本但不退出，
       继续启动 JVM 运行应用。java.c:1399 → showVersion = JNI_TRUE（return 0，继续执行）。
       在 JavaMain 中（java.c:458-464），如果 showVersion → PrintJavaVersion(env, showVersion)
       在 JNI_CreateJavaVM 之后打印 JVM 内部的 java.version 属性（更完整的信息）。
```

### 4.8 ★★★ JVM option alias / backward compatibility

```
问题：
  ① ParseArguments 如何处理旧的选项别名（如 -mx → -Xmx）？
       答案方向: java.c:1451-1457 → 旧式选项 `-mx512m`, `-ms512m`, `-ss512k`, `-oss512k`
       → 检测 JLI_StrCCmp(arg, "-mx") → 分配新字符串 → sprintf(tmp, "-X%s", arg+1)
       → AddOption(tmp, NULL) → 将 `-mx512m` 转换为 `-Xmx512m`。JVM 只看到标准化后的
       `-X` 前缀选项。这是 libjli 的另一层价值——向后兼容的选项规范化。

  ② 哪些旧式选项被完全废弃了？
       答案方向: java.c:1458-1462 → `-checksource`, `-cs`, `-noasyncgc` →
       JLI_ReportErrorMessage(ARG_WARN, arg) → 打印警告但不阻塞启动。这些在
       JDK 1.1 时代存在的选项现在已无效果——libjli 打印 stderr 给用户迁移时间。

  ③ `-Djava.class.path=` 选项在命令行上与 `-cp` 有什么区别？
       答案方向: java.c:1469-1470 → `-Djava.class.path=foo:bar` → 被当作普通 JVM
       选项（AddOption）→ 但先检查 `_have_classpath = JNI_TRUE` → 这是为了防止
       LM_UNKNOWN 模式下自动 `SetClassPath(".")`（java.c:1488-1490）。`-cp` 走
       SetClassPath → 调用 JLI_WildcardExpandClasspath（通配符展开）。
       `-Djava.class.path=` 不走 SetClassPath → 不通配符展开。区别在此。
```

---

## §五 Article Structure

```
§〇 生产场景 — ZGC on JDK 11 crash：应该在哪里拦截实验性选项？
  ★ 真实崩溃：SIGSEGV in ZBarrierSetC2::emit_barrier_stub
  ★ 为什么 libjli 不能拦截：libjli 没有 XX 选项语义知识
  ★ 正确的分层：libjli = transport layer, libjvm = semantic layer
  ★ 3 条诊断命令（PrintCommandLineFlags / PrintFlagsFinal / GDB）

§一 ★★★ ParseArguments 状态机：4 类参数分类
  ❓ ParseArguments 不是 "split by space" — 它是状态机，状态 = mode
  ❓ 为什么分类必须在 libjli 层而不是 libjvm 层？
  1.1 ParseArguments 的 3 个阶段：
      Phase 1 (flag detection): while (*arg == '-') → 检测 -jar/-m/--source → set mode
      Phase 2 (option collection): 剩余 `-` 参数 → AddOption 或 SetClassPath
      Phase 3 (post-processing): 第一个 non-`-` 参数 = what → mode defaulting (LM_UNKNOWN → LM_CLASS)
  1.2 ★ Mermaid: ParseArguments 分类决策树
      4 LaunchMode 分支 + 每类 option 的处理路径
  1.3 ★ 面试 Story Format 答案 — "-Xms8g 是怎么到达 JNI_CreateJavaVM 的？"
      从 bash command line → ParseArguments 的 while 循环 → AddOption → options[] 数组 →
      JavaVMInitArgs → JNI_CreateJavaVM。完整路径的 narrative。

§二 ★★★ 4 个 LaunchMode 的完整执行路径
  ❓ 为什么 LM_JAR 覆盖 -cp？为什么 LM_MODULE 禁止 -jar？
  2.1 LM_CLASS: SetClassPath → LoadMainClass(className) → FindClass
  2.2 LM_JAR:  SetClassPath(jarfile) → LoadMainClass via manifest → FindClass
  2.3 LM_MODULE: SetClassPath + resolve module path → FindClass(module's main)
  2.4 LM_SOURCE: AddOption("--add-modules=ALL-DEFAULT") → compile → execute
  2.5 对比表：每个 mode 的 classpath 来源 + main class 发现方式 + 错误消息

§三 ★★★ JVM option vs application arg 的精确边界
  ❓ -Xms vs --my-app-flag：前者进 options[]，后者进 argv。怎么区分的？
  ❓ 如果分类错了 —— -Xms 被当作应用参数 → 会发生什么？
  3.1 JVM option pipeline: bash argument → AddOption → options[] → JavaVMInitArgs → JNI_CreateJavaVM
  3.2 Application arg pipeline: bash argument → *pwhat → preserved in argc/argv → main(String[] args)
  3.3 Counterfactual: 如果 libjli 不分类 → JVM 会把 `javac` 当作 class name → FindClass("javac") → ClassNotFoundException

§四 ★★ AddOption：JVM 选项的 collector
  ❓ ×2 扩容算法为什么 initialSize=4？
  ❓ 为什么 -Xms/-Xmx 在 AddOption 中也要解析一遍？
  4.1 AddOption 源码（java.c:932-982）— 扩容 + special -Xss/-Xmx/-Xms parsing
  4.2 AddOption 的数据流：从 AddOption → options[] → InitializeJVM → JNI_CreateJavaVM
  4.3 Counterfactual: 如果 AddOption 没有扩容 —— options[] 越界写 → heap corruption → SIGSEGV

§五 ★★★ Wildcard expansion：opendir 不是 glob
  ❓ 为什么 libjli 在启动时展开 *.jar 而不是让类加载器自己读目录？
  ❓ 展开 1000 个 JAR 需要多久？这对启动时间有什么影响？
  5.1 JLI_WildcardExpandClasspath 源码（wildcard.c:303-320）
  5.2 isJarFileName（wildcard.c:222-231）— 只匹配 .jar/.JAR
  5.3 排序（qsort at wildcard.c:210）— 为什么排序？→ 启动行为确定性
  5.4 与 shell glob 的对比 —— shell 不限制 .jar 后缀

§六 ★★ Classpath construction 的优先级
  ❓ CLASSPATH 环境变量 vs -cp 选项 vs -jar 覆盖 → 谁赢？
  6.1 CLASSPATH 环境变量处理（java.c:322-324）— 在 ParseArguments 之前
  6.2 ParseArguments 中的 -cp 处理（java.c:1345-1347）— SetClassPath(value)
  6.3 JLI_Launch 的 mode==LM_JAR 覆盖（java.c:338-340）
  6.4 优先级链：-jar > -cp > CLASSPATH 环境变量 > "." (default)

§七 ★★ 选项别名的向后兼容
  ❓ -mx512m 和 -Xmx512m 的区别？libjli 怎么转换的？
  ❓ 哪些废弃选项 libjli 只是 warn 不 block？
  7.1 旧式选项 → -X 标准化（java.c:1451-1457）
  7.2 完全废弃选项的 ARG_WARN（java.c:1458-1462）
  7.3 -verbosegc → -verbose:gc（java.c:1433-1434）

§八 ★ GDB 断点验证 — 5 断点参数分类 trace
  断言 1: ParseArguments(java.c:1296) 入口 — 打印 argc + argv
  断言 2: mode detection — 检测 -jar flag (java.c:1317)
  断言 3: AddOption 调用 — 打印 optionString (java.c:932)
  断言 4: SetClassPath 调用 — 打印 classpath value (java.c:985)
  断言 5: ParseArguments 出口 — 打印 mode + what + options 数组大小

§九 Cross-reference
  ❓ 02-class-classloading — FindClass 从 classpath 中查找类 → 02
  ❓ 04-system-preload — system property 的初始化 → 04
  ❓ 18-agent-instrument — -javaagent 参数 → 18
  ❓ 14-zip-jimage — JAR 文件的 ZIP 解析 → 14
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because ParseArguments must first know the LaunchMode before it can process classpath options, the first ~50 lines are a mode detection state machine..."

2. **3-5 lines source code per claim** — paste relevant C code from `java.c` / `wildcard.c` / `args.c`, do not describe it.

3. **Mermaid** — ParseArguments classification decision tree (state machine). Show the while loop, the 4 LaunchMode branches (LM_CLASS, LM_JAR, LM_MODULE, LM_SOURCE), option types (JVM option → AddOption, launcher option → mode change, application arg → what), and exit flows (`-version` early exit, error exits, normal flow).

4. **GDB session** — 5 breakpoints with exact file:line numbers:
   - `ParseArguments` entry (java.c:1296) — print argc + first argv
   - `-jar` detection (java.c:1317) — check mode before/after
   - `-cp` processing (java.c:1345) — watch SetClassPath call
   - `AddOption` call (java.c:932) — print optionString + numOptions
   - `ParseArguments` exit (java.c:1503+) — print final mode + what + options[] count

5. **3 Beginner callout boxes** — the exact text from §一: LaunchMode, Wildcard expansion, JVM option vs application arg.

6. **Cross-reference** — at LoadMainClass: "→ 02-class-loading" for FindClass behavior from the constructed classpath. At AddOption: "→ 04-system-preload" for how -D properties are consumed by SystemDictionary.

7. **Story-format interview answer** — at §一末尾: "`-Xms8g` 从 bash 命令行是怎么到达 JNI_CreateJavaVM 的？" — narrative of the full pipeline: bash → ParseArguments while loop → JLI_StrCCmp("-Xms") → AddOption("-Xms8g") → extract initialHeapSize → push to options[] → JavaVMInitArgs.options → JNI_CreateJavaVM.

8. **4 LaunchMode comparison table** — classpath source, main class discovery, error messages per mode.

---

## §七 Output Format

- Markdown file, named `01-Argument-Parsing.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/13-launcher/`
- 元信息头：

```
> **阶段**：[13-launcher]
> **前置**：[00-Libjli-Overview]（理解 JLI_Launch 的 8 步全链路和参数在何时被解析）
> **配套**：[02-JVM-Loading]（classpath 路径如何影响 JVM 启动）、[03-Main-Class-Loading]（ParseArguments 的 mode + what 如何被 LoadMainClass 使用）
> **后续依赖本文**：[02-class-classloading]（FindClass 从 classpath 中查找类——classpath 来源是本文的核心输出）
> **阅读收益**：理解 ParseArguments 的 ~300 行状态机如何区分 4 类参数（JVM options / launcher options / application args / properties）——从 LaunchMode 的 4 个分支到 AddOption 的 ×2 扩容到 WildcardExpansion 的 opendir 展开到选项别名向后兼容；掌握 "JVM 选项 vs 应用参数" 的分类边界和分类错误的 3 种灾难性后果
```

- 目标行数: 300+ lines

---

## §八 Prohibited (≥8)

- ❌ 只列举哪些选项存在不做分类原理 — 必须解释 parseArguments 的 while loop 状态机如何做 mode discovery
- ❌ 忽略 LaunchMode 对后续行为的影响 — 必须展示 4 个 LaunchMode 各自触发不同的 classpath 构造和 LoadMainClass 逻辑
- ❌ 不解释 AddOption 的扩容算法 — 必须展示 java.c:938-950 的 ×2 倍增 + initialSize=4 的设计理由
- ❌ 把 AddOption 当作纯 collector — 必须展示它对 -Xss/-Xmx/-Xms 的额外解析及其原因（ShowSettings 诊断输出）
- ❌ 忽略 wildcard expansion 的代价 — 必须给出 1000 JAR = ~2ms 的量化数据 + 与 shell glob 的对比
- ❌ 不提 -jar 模式下 classpath 的覆盖 — 必须展示 java.c:338 如何覆盖之前的所有 classpath 设置
- ❌ 不做 JVM option vs application arg 的错误案例 — 至少一个案例：未知 `--my-app-flag` 被 AddOption → JNI_CreateJavaVM → JNI_EINVAL → JVM_ERROR1
- ❌ 忽略旧式选项别名兼容 — 必须展示 java.c:1451-1457 的 `-mx → -Xmx` 转换
- ❌ 不做 GDB 断点 trace — 至少 5 个断点 trace ParseArguments 的完整执行
- ❌ 忘记交叉引用 02-class-loading — classpath 是类加载的核心输入，必须在 LoadMainClass 点引用 02
- ❌ 不要解释 C 语言基础（argc parsing, string comparison）

---

## §九 Required (≥8)

- ✅ **★ Mermaid ParseArguments 分类决策树** — while loop + 4 LaunchMode 分支 + 每类 option 的路径
- ✅ **★ 4 LaunchMode 对比表** — classpath source / main class discovery / error messages / 使用场景
- ✅ **★ 3 Beginner Callout 框** — exact text from §一
- ✅ **★ AddOption 源码展示** — java.c:932-982 全量（扩容 + special parsing）
- ✅ **★ Wildcard expansion 源码展示** — wildcard.c:177-231（opendir/readdir/isJarFileName）
- ✅ **★ JVM option vs application arg 的完整数据流** — bash → ParseArguments → AddOption → options[] → JavaVMInitArgs → JNI_CreateJavaVM
- ✅ **★ 面试 Story Format 答案** — §一末尾，单段叙事："-Xms8g 是怎么到达 JNI_CreateJavaVM 的"
- ✅ **★ 分类错误的 3 种灾难** — 透传未知 flag 导致 JVM 拒绝启动 / -Xms 被当作类名 / -jar + -cp 同时使用导致 classpath 被覆盖
- ✅ **★ GDB 断点 ≥5 条** — 精确到 file:line, 每断点有预期变量值
- ✅ **★ 交叉引用** — 00-Libjli-Overview（JLI_Launch 的调用链）、02-class-classloading（FindClass 消耗 classpath）、04-system-preload（-D 属性的系统消费）

---

## §十 GDB Verification (≥8 assertions)

```
断言 1: ParseArguments 入口 (java.c:1296)
  (gdb) break java.c:1296
  (gdb) print argc → 期望: 命令行参数数量（含 -jar app.jar）
  (gdb) print argv[0] → 期望: 第一个参数（通常是 -jar 或 -cp）
  (gdb) print *pmode → 期望: LM_UNKNOWN (0)

断言 2: -jar flag 检测 (java.c:1317)
  (gdb) break java.c:1317
  (gdb) print arg → 期望: "-jar"
  (gdb) continue
  (gdb) print *pmode → 期望: LM_JAR (2)

断言 3: -cp flag 处理 (java.c:1345)
  (gdb) break java.c:1345
  (gdb) print arg → 期望: "-cp" 或 "-classpath" 或 "--class-path"
  (gdb) print value → 期望: classpath 字符串值
  (gdb) continue (after SetClassPath)
  (gdb) print *pmode → 期望: LM_CLASS (1)

断言 4: AddOption 调用 (java.c:932)
  (gdb) break java.c:932
  (gdb) print str → 期望: 要添加的 JVM 选项字符串
  (gdb) print numOptions → 期望: 当前已收集的选项数
  (gdb) continue
  (gdb) print numOptions → 期望: 比之前 +1

断言 5: AddOption 扩容触发 (java.c:938)
  (gdb) break java.c:938 if numOptions >= maxOptions
  (gdb) print numOptions → 期望: 等于 maxOptions（触发扩容）
  (gdb) print maxOptions → 期望: 扩容前的大小
  (gdb) continue
  (gdb) print maxOptions → 期望: 扩容前的 2 倍

断言 6: -Xms/-Xmx 特殊解析 (java.c:969 / java.c:976)
  (gdb) break java.c:969
  (gdb) print str → 期望: 以 "-Xmx" 开头的字符串
  (gdb) continue
  (gdb) print maxHeapSize → 期望: 解析出的堆大小的 jlong 值

断言 7: SetClassPath 调用 (java.c:985)
  (gdb) break java.c:985
  (gdb) print s → 期望: classpath 字符串（可能含通配符 *）
  (gdb) continue (after JLI_WildcardExpandClasspath)
  (gdb) print s → 期望: 展开后的完整路径（通配符 * 已被替换）

断言 8: ParseArguments 出口 — mode defaulting (java.c:1485)
  (gdb) break java.c:1485
  (gdb) print *pmode → 期望: LM_CLASS(1) / LM_JAR(2) / LM_MODULE(3) / LM_SOURCE(4)
  (gdb) print *pwhat → 期望: 类名 / jar 文件名 / 模块名
  (gdb) print options[0]@numOptions → 期望: 所有收集的 JVM 选项列表

断言 9: -version 提前退出 (java.c:1392)
  (gdb) break java.c:1392
  (gdb) print arg → 期望: "-version"
  (gdb) print printVersion → 期望: JNI_TRUE (1)
  (gdb) finish → ParseArguments 返回 JNI_TRUE (1)

断言 10: 旧式选项别名转换 (java.c:1455)
  (gdb) break java.c:1455
  (gdb) print arg → 期望: "-mx512m" (old-style option)
  (gdb) continue
  (gdb) print tmp → 期望: "-Xmx512m" (standardized option)
```
