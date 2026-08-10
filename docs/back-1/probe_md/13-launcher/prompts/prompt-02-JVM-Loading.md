# PROMPT: 请撰写 02-JVM-Loading.md

## §〇 Production Scenario（必须真实出现在文档 §〇 中）

生产环境多版本 JDK 共存。`/etc/alternatives/java` 指向 JDK 11 但 `$JAVA_HOME` 还在 JDK 8。运行 `java -jar app.jar` → `Error: could not find libjava.so`（`emessages.h:98`）。libjli 用 `/proc/self/exe` 找到的是 JDK 11 的 `java`，但搜索 JRE 时被 `JAVA_HOME` 的 JDK 8 路径干扰——因为 `java_md_solinux.c:543` 先用 `$JAVA_HOME`，不成功后回退到 `/proc/self/exe`。`JAVA_HOME` 的 JDK 8 没有 `libjava.so` → 默认错误消息。但真正的 root cause 不是"缺少文件"——是 `JAVA_HOME` 指向错误版本。

**核心问题**：`java_md_solinux.c:535-543` 的 `GetApplicationHome` 先用 `getenv("JAVA_HOME")`——如果设置了，直接用。这是生产环境最常见的故障点：`JAVA_HOME` 指向旧版本 JDK。为什么先检查 `JAVA_HOME`？性能优化——跳过 `readlink("/proc/self/exe")` + 向上遍历目录，节省 5-10 个系统调用。代价：`JAVA_HOME` 不正确时 → JRE 找不到 → 沉默或错误消息不明确。`JAVA_HOME` 检查失败后回退到 `/proc/self/exe`——但如果 `JAVA_HOME` 指向一个"几乎正确"的 JDK（目录结构完整但版本不匹配），这个回退永远不会触发。

**三步诊断**（直接写进 §〇）：

```bash
# 1. 确认 java 二进制实际位置 vs JAVA_HOME
readlink -f /proc/self/exe                            # 实际运行的 java
echo $JAVA_HOME                                        # 环境变量指向的 JDK
ls $JAVA_HOME/lib/libjava.so 2>&1                      # JAVA_HOME 的 JRE 锚点文件是否存在

# 2. 手动模拟 libjli 的 JRE 搜索路径
JAVA_BIN=$(dirname $(readlink -f /proc/self/exe))
JRE_ROOT=$(dirname $JAVA_BIN)                          # ../bin → ..
ls $JRE_ROOT/lib/libjava.so                            # /proc/self/exe 的 JRE
ls $JRE_ROOT/lib/server/libjvm.so                      # JVM 库

# 3. GDB 断点验证 GetJREPath 的搜索决策
gdb -ex "break java_md_solinux.c:543" \
    -ex "run" \
    -ex "print JAVA_HOME" \
    -ex "print jrepath" \
    --args java -jar app.jar
```

**反事实**：如果 libjli 从不检查 `JAVA_HOME`，而是始终用 `/proc/self/exe` → 启动时间 +~0.1ms（5-10 个系统调用），但"找不到 libjava.so"这类生产故障消失率 ~60%。HotSpot 团队的取舍是值得质疑的——为 ~0.1ms 牺牲了故障可诊断性。JDK 9+ 的模块系统引入了 `--jdk-home` 显式参数作为妥协。

---

## §一 Task + Narrative + Callouts

### Task

Reading this prompt, you will produce a document that traces the COMPLETE path from "libjli needs to find and load libjvm.so" to "the three JNI function pointers are filled in InvocationFunctions". `dlopen` 不是"加载一个 .so"。它是 JVM 的入口门——`RTLD_NOW + RTLD_GLOBAL` 两个标志定义了整个 JVM 的符号可见性。libjli 的 `LoadJavaVM` 做了比"打开文件"多得多的事情：查找 JRE、读 `jvm.cfg`、解析别名、验证 `libjvm.so` 存在（`stat()`）、`dlopen`、`dlsym` 三个 JNI 函数指针——所有在调用 `JNI_CreateJavaVM` 之前。

### Beginner Callout Boxes（文档中必须出现的 5 个 callout 框）

1. **dlopen(libjvm, RTLD_NOW|RTLD_GLOBAL)**: `RTLD_NOW` = 立即解析所有未定义符号 → 任何符号缺失 → 立即失败（fail-fast）。`RTLD_GLOBAL` = `libjvm.so` 的符号对所有后续 `dlopen` 的库可见（`-agentlib` 加载需要）。对应源码：`java_md_solinux.c:571`。为什么不是 `RTLD_LAZY`？因为 JVM 内部崩溃（运行 1 小时后 cold code path 调用缺失符号）比启动慢更致命。`RTLD_NOW` → `dlopen` 报错 → 错误信息包含缺失的符号名 → 立即知道原因。

2. **dlsym(handle, "JNI_CreateJavaVM")**: 从已加载的 `libjvm.so` 中找函数地址。返回 `void*` → 转换为 `CreateJavaVM_t` 函数指针类型（`java.h:79`：`typedef jint (JNICALL *CreateJavaVM_t)(JavaVM **pvm, void **env, void *args);`）。对应源码：`java_md_solinux.c:624`。`dlsym` 在共享库的符号表中做二分查找（GNU hash → O(log n)），而不是逐字节扫描字符串。

3. **jvm.cfg**: JRE 配置文件，位于 `<jre>/lib/jvm.cfg`。列出可用的 JVM 变种（`-server`、`-client`、`-minimal`）。格式：`-server KNOWN` 或 `-client ALIASED_TO -server`。对应源码：`java.c:2039-2083`（`ReadKnownVMs` 解析）。`KNOWN` = 可用，`ALIASED_TO` = 别名映射，`IGNORE` = 跳过。JDK 9+ 只有 server VM → 文件内容简化为一行 `-server KNOWN`。注意：jvm.cfg 机制即将废弃（`java.c:2037-2038` 注释明确说明：`"the mechanism will be removed in the future"`）。

4. **InvocationFunctions**: `java.h:83-87` 的结构体——三个 JNI 函数指针的容器。`struct { CreateJavaVM_t *CreateJavaVM; GetDefaultJavaVMInitArgs_t *GetDefaultJavaVMInitArgs; GetCreatedJavaVMs_t *GetCreatedJavaVMs; }`。`dlsym` 填充这三个函数指针（`java_md_solinux.c:624-642`）。三个符号是 JNI Invocation API 规范定义的——任何 JVM 实现（包括 GraalVM）必须导出。第一个在启动流中使用，后两个供 `jcmd`/`jstat` 等诊断工具使用（通过 JNI `AttachCurrentThread`）。

5. **stat()**: POSIX 系统调用——验证文件是否存在，不打开它（不消耗文件描述符）。比 `access()` 更精确（`access` 只检查权限，不检查是否是目录、设备文件等）。对应源码：`java_md_solinux.c:504`（验证 `libjvm.so` 存在）。成本：~1 次系统调用（~200ns）。`stat` 失败 → `CFG_ERROR8`（`emessages.h:88`：`"Error: missing '%s' JVM at '%s'."`）或 `JRE_ERROR1`（`emessages.h:98`：`"Error: could not find libjava.so"`）。

---

## §二 Environment

Same as prompt-00 §二. OpenJDK 11 slowdebug, Linux x86_64.

Source roots:
- `src/java.base/share/native/libjli/` — `ReadKnownVMs`, `CheckJvmType` in `java.c`
- `src/java.base/unix/native/libjli/` — `SetExecname`, `CreateExecutionEnvironment`, `LoadJavaVM`, `GetJREPath`, `GetJVMPath` in `java_md_solinux.c`
- `src/java.base/unix/native/libjli/` — `GetApplicationHome`, `TruncatePath`, `GetExecName` in `java_md_common.c`

Key binaries:
- `build/linux-x86_64-normal-server-slowdebug/jdk/bin/java` — `/proc/self/exe` 指向的二进制
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 被 dlopen 加载的 HotSpot VM
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/jvm.cfg` — JVM 配置文件

Key global state (in `java_md_solinux.c`):
- `static char *execname = NULL` — `/proc/self/exe` 的 `readlink` 结果（`java_md_solinux.c:704` 设置）
- `static const char *JavaHome = NULL` — 缓冲区，存储 JRE 根目录路径

---

## §三 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|-------|----------------|------|
| 1 | `java_md_solinux.c` | `src/java.base/unix/native/libjli/java_md_solinux.c` | ~1100 | `SetExecname`(:660), `CreateExecutionEnvironment`(:303), `LoadJavaVM`(:564), `GetJREPath`(:516), `GetJVMPath`(:490) | Linux JVM loading implementation — /proc/self/exe, dlopen, dlsym, stat |
| 2 | `java_md_common.c` | `src/java.base/unix/native/libjli/java_md_common.c` | ~250 | `GetExecName`(:166), `TruncatePath`(:50), `GetApplicationHome`(:74) | Cross-Unix helpers for path resolution — 目录遍历、路径截断 |
| 3 | `java.c` | `src/java.base/share/native/libjli/java.c` | ~1400 | `ReadKnownVMs`(:2084), `CheckJvmType`(:677), `LoadJavaVM` (caller at :300) | jvm.cfg processing + dispatch — JVM 类型选择 |
| 4 | `java.h` | `src/java.base/share/native/libjli/java.h` | ~350 | `InvocationFunctions` struct(:83), `jvmtype` variable, `jvmpath` variable | Data structures — 函数指针容器 + 路径缓冲定义 |
| 5 | `emessages.h` | `src/java.base/share/native/libjli/emessages.h` | ~100 | `JRE_ERROR1`(:91), `CFG_ERROR1-8`(:81-88), `DLL_ERROR1-4` | JVM loading 错误消息宏 |

**跨模块说明**：`java.c` 的 `LoadJavaVM`（`:300`）是调用点——它调用平台特定的 `java_md_solinux.c:564` 的 `LoadJavaVM()` 实现。前者的职责是：接收 `jvmpath` + 填充 `InvocationFunctions`。后者的职责是：用 `dlopen` 加载 `libjvm.so` → `dlsym` 三个 JNI 符号 → 填充函数指针 → 返回 `JNI_TRUE`/`JNI_FALSE`。平台特定层做 dirty work，跨平台层做 orchestration。

---

## §四 Deep Dive Question Groups（≥8，EXACT questions + answer directions）

### 4.1 ★★★ /proc/self/exe — the zero-config bootstrap

```
问题：
  ① Linux 内核如何提供 /proc/self/exe？它的机制是什么？
      答案方向: Linux 内核为每个进程在 /proc/<pid>/exe 创建一个符号链接——指向可执行文件
      的绝对路径。readlink("/proc/self/exe", buf, PATH_MAX) 返回路径。成本：1 次 readlink
      系统调用（~100ns）。内核维护的是 inode 引用——即使原始文件被删除，/proc/self/exe
      仍然有效（标记 (deleted)）。对应源码：java_md_solinux.c:687-689。
      
      追问: 如果 java 是通过符号链接触发的（/usr/bin/java → /opt/jdk/bin/java）？
      → /proc/self/exe 指向最终目标（/opt/jdk/bin/java），不指向中间符号链接。
      这是 libjli 精度的关键——它总是知道"真正的" java 二进制在哪里。

  ② Counterfactual: 用 argv[0] 而不是 /proc/self/exe 会怎样？
      答案方向: 如果 java 在 $PATH 中（只写了 "java" 而非绝对路径）→ argv[0] 只包含
      "java" → 无法解析完整路径。如果 shell 脚本用 exec ./java → argv[0] 是 "./java" →
      相对路径 → 无法向上找 JRE 根目录。Windows 的 java_md.c 确实使用 argv[0] +
      SearchPath() API，因为 Windows 没有 /proc/self/exe 等价物。
```

### 4.2 ★★★ TruncatePath + GetApplicationHome — walking up from /bin/java

```
问题：
  ① TruncatePath(java_md_common.c:50) 做了什么？
      答案方向: 从右向左找到最后一个 "/bin/" 子串 → 截断（*p = '\0'）→ 剩余 = JRE 根目录。
      源码（java_md_common.c:56-58）:
        p = findLastPathComponent(buf, "/bin/");
        *p = '\0';
      然后 java_md_solinux.c:532 → 验证 lib/libjava.so 是否存在 → 如果存在 → JRE 确认成功。
      如果不存在 → 向上目录继续搜索（最多搜索 5 层 hardcoded limit）。

  ② GetApplicationHome 的完整搜索策略是什么——不只是 /bin/java？
      答案方向: java_md_common.c:87 → GetApplicationHome 从已知路径开始：
      1. 先用 getenv("JAVA_HOME")（java_md_solinux.c:535-543）→ 如果设置了且 libjava.so 存在 → 返回
      2. 如果 JAVA_HOME 为空/无效 → 用 GetExecName() 获取可执行文件路径 → TruncatePath("/bin/")
      3. 如果 TruncatePath 找到的根目录没有 libjava.so → 向上走到 /usr 或 / 停止（最多 5 层）
      这是 3 层回退策略：JAVA_HOME → /proc/self/exe → 目录树向上遍历。
```

### 4.3 ★★★ $JAVA_HOME preference — the conflict vector

```
问题：
  ① 为什么 GetApplicationHome 先用 $JAVA_HOME 而不是始终用 /proc/self/exe？
      答案方向: 性能优化——跳过 readlink("/proc/self/exe") + TruncatePath + 向上遍历目录，
      节省 5-10 个系统调用（readlink + 2-5× stat + 1-2× openat）。在 2000 年代服务器上
      这 ~0.1ms 是真实开销。但今天（2020s），0.1ms 不值得牺牲正确性。
      
      追问: 如果 JAVA_HOME 指向一个"几乎正确"的 JDK（目录结构完整但版本不匹配）？
      → java_md_solinux.c:535-543 的检查是：getenv("JAVA_HOME") → stat(libjava.so)
      → 如果 libjava.so 存在 → 认为 JAVA_HOME 正确 → 使用 JAVA_HOME 的 JRE。
      libjli 不检查 libjava.so 的版本——它只检查文件存在。如果 JAVA_HOME 的 JDK 8 有
      libjava.so 但 libjvm.so 缺少某些符号 → dlopen 成功但 dlsym 某个符号失败 →
      DLL_ERROR2 ("Error: failed JNI_CreateJavaVM, because ...")。

  ② 生产环境如何防止 JAVA_HOME 污染？
      答案方向: 
      1. Never set JAVA_HOME in system profiles (/etc/profile 或 /etc/environment)
      2. Use shell wrapper scripts that unset JAVA_HOME: `env -u JAVA_HOME java -jar app.jar`
      3. Use absolute path to java: `/opt/jdk11/bin/java -jar app.jar` → libjli 通过 /proc/self/exe 定位
      4. JDK 9+: 模块系统的 `--jdk-home` 显式参数提供确定性
```

### 4.4 ★★★ jvm.cfg + ReadKnownVMs — version selection

```
问题：
  ① jvm.cfg 的格式和 ReadKnownVMs 的解析逻辑是什么？
      答案方向: 
      格式（java.c:2039-2083 注释）:
        -server KNOWN\n
        -client ALIASED_TO -server\n
        -minimal IGNORE\n
      ReadKnownVMs(java.c:2084) 读取文件 → 逐行解析 → 构建 knownVMs[] 数组（java.c:166:
      static jvmtype_t knownVMs[]）。每个 entry: type 字符串（server/client）、isKnown（KNOWN）、
      isAlias（ALIASED_TO）、aliasTo 目标类型。
      
      追问: 如果一个类型被 ALIASED_TO 另一个不存在的类型怎么办？→ CheckJvmType 跟随别名链
      → 如果链接目标不存在 → CFG_ERROR4 "Error: No known VMs. (check for corrupt jvm.cfg file)"。
      
  ② CheckJvmType(java.c:677) 如何检测别名循环？
      答案方向: java.c:770-777 → while (alias) 循环 → loopCount++ → 
      如果 loopCount >= knownVMsCount → 检测到循环 → 报告 CFG_ERROR1（emessages.h:81）:
      "Error: Corrupt jvm.cfg file; cycle in alias list." 这是最坏情况——jvm.cfg 
      损坏但文件本身可读 → libjli 解析时发现逻辑错误。

  ③ Counterfactual: 如果 jvm.cfg 只解析一次并缓存会怎样？
      答案方向: 如果 JRE 在 mid-execution 切换（SelectVersion 选择了不同 JRE）→
      缓存的 jvm.cfg 过时 → wrong VM type loaded → potential crash。ReadKnownVMs 在
      CreateExecutionEnvironment 中调用（java_md_solinux.c:346），每次 JLI_Launch 都重新读取。
      开销：一次 fopen + fgets 循环 ~0.05ms——可忽略 vs 正确性。
```

### 4.5 ★★★ GetJVMPath — constructing the libjvm.so path

```
问题：
  ① GetJVMPath(java_md_solinux.c:490-511) 如何拼接 libjvm.so 的完整路径？
      答案方向:
      格式字符串: "%s/lib/%s/%s/libjvm.so" = jrepath + arch + jvmtype (aliased) + "libjvm.so"
      具体步骤:
        1. java_md_solinux.c:496 → 获取 arch 名称: GetArchPath(jrepath, arch) 
           → Linux x86_64 返回 "amd64"
        2. java_md_solinux.c:499 → JLI_Snprintf(jvmpath, jvmpathsize, 
           "%s/lib/%s/" JVM_DLL, jrepath, jvmtype)
           → 例如: /opt/jdk11/lib/amd64/server/libjvm.so
        3. java_md_solinux.c:504 → stat(jvmpath, &s) → 验证文件存在
        4. 如果 stat 失败 → 返回 JNI_FALSE → 调用者即报 CFG_ERROR8
      
      追问: JVM_DLL 宏是什么？→ java_md_solinux.c:41 
      → Linux: "libjvm.so", macOS: "libjvm.dylib", Windows: "jvm.dll"
      → 平台无关的代码通过宏获得平台正确的库名。

  ② 为什么 path 中需要 arch 组件？
      答案方向: 同一 JRE 安装可能包含多个架构的 libjvm.so（例如: /lib/amd64/server/libjvm.so
      和 /lib/i386/server/libjvm.so）。GetArchPath 通过读取 <jre>/lib/ 下不同 amd64/i386 
      子目录中的 jvm.cfg 来确定当前架构。这是 Java "Write Once, Run Anywhere" 在 launcher 
      层面的体现——同一个 JDK 安装可以服务 32-bit 和 64-bit 进程。
```

### 4.6 ★★★ dlopen(libjvm.so, RTLD_NOW|RTLD_GLOBAL) — the big moment

```
问题：
  ① RTLD_NOW + RTLD_GLOBAL 的组合为什么是 HotSpot 的唯一正确选择？
      答案方向: java_md_solinux.c:571 → dlopen(jvmpath, RTLD_NOW | RTLD_GLOBAL)
      
      RTLD_NOW 的必要性:
      - libjvm.so 依赖 ~30 个系统库（libc, libm, libpthread, libdl, libstdc++...）
      - 任何一个缺失 → dlopen 立即返回 NULL → 错误信息包含缺失符号名 → 在启动时报错
      - 如果 RTLD_LAZY → 符号在首次使用时解析 → 可能在 C2 编译线程中触发（运行 1 小时后）
        → 突然 SIGSEGV → 无法定位根因
      
      RTLD_GLOBAL 的必要性:
      - libjvm.so 的符号添加到全局符号表 → 所有后续 dlopen 的库（-agentlib instrument）
        可以找到 JVM 函数（例如 JNI_GetCreatedJavaVMs）
      - 如果 RTLD_LOCAL → -agentlib 的 agent 库无法通过 dlsym(RTLD_DEFAULT, "JNI_*")
        找到 JVM 函数 → instrument agent 无法工作
      
      追问: Solaris 版本的 dlopen 参数不同？→ java_md_solinux.c:571-585 有 #ifdef __solaris__
      → RTLD_NOW → RTLD_LAZY（Solaris 的 RTLD_NOW 有已知 bug）→ 加上 RTLD_GLOBAL。
      Linux 上的 RTLD_NOW 是稳定的。

  ② dlopen 失败后 libjli 的错误消息质量如何？
      答案方向: java_md_solinux.c:571-619 → 如果 dlopen 返回 NULL:
        1. :577-585 → dlerror() 获取详细错误（例如: "libjvm.so: cannot open shared object file: No such file or directory"）
        2. :618-619 → JLI_ReportErrorMessage(DLL_ERROR1, ...) 打印 "Error: dl failure on line %d"
        3. :619 → JLI_ReportErrorMessage(DLL_ERROR2, ...) 打印 "Error: failed %s, because %s" + dlerror 内容
      dlerror() 提供了 libjli 无法自己生成的诊断信息——包括缺失的符号名或路径。
```

### 4.7 ★★★ dlsym 三个 JNI 函数指针 — InvocationFunctions 填充

```
问题：
  ① dlsym 的三个字符串分别是什么？类型签名是什么？
      答案方向: java.h:79-87 定义:
        typedef jint (JNICALL *CreateJavaVM_t)(JavaVM **pvm, void **env, void *args);
        typedef jint (JNICALL *GetDefaultJavaVMInitArgs_t)(void *args);
        typedef jint (JNICALL *GetCreatedJavaVMs_t)(JavaVM **vmBuf, jsize bufLen, jsize *nVMs);
      java_md_solinux.c 中的 dlsym:
        :624 → dlsym(libjvm, "JNI_CreateJavaVM") → ifn->CreateJavaVM
        :630 → dlsym(libjvm, "JNI_GetDefaultJavaVMInitArgs") → ifn->GetDefaultJavaVMInitArgs
        :637 → dlsym(libjvm, "JNI_GetCreatedJavaVMs") → ifn->GetCreatedJavaVMs
      
      追问: 为什么需要 dlsym 而不是直接链接？→ 因为 libjli.so 不知道 libjvm.so 在哪个路径——
      直到运行时才能确定（/proc/self/exe → JRE 搜索 → jvm.cfg → 路径拼接）。直接链接 =
      编译时固定路径 → 失去运行时选择 -server vs -client 的能力。

  ② 如果 dlsym 失败了（符号不存在）会怎样？
      答案方向: java_md_solinux.c:626-629 → 如果任何一个 dlsym 返回 NULL:
        → (*envFunc)(JNI_FALSE, "%s", "Error: Could not find JVM symbol ...") 
        → dlclose(libjvm) → 返回 JNI_FALSE
      → caller (java.c:300-304) 检查返回值 → JLI_ReportErrorMessage(JRE_ERROR1)
      → print "Error: could not find libjava.so"（这里错误消息不精确：实际上是找到了 libjvm.so，
      但缺少 JNI 符号——但复用同一个 JRE_ERROR1 宏）
```

### 4.8 ★★★ libjsig preloading — signal chain bootstrap

```
问题：
  ① 什么是 libjsig，为什么要在 JVM 热身前加载它？
      答案方向: java_md_solinux.c:1027-1038 → 检查 LD_PRELOAD 中的 libjsig.so →
      如果存在 → dlsym 找到 JVM_begin_signal_chain_for_JVM → 调用 → 在 JVM 自己的信号
      处理器之前建立 JSIG 链。这确保 signal chaining 在 JVM 热身前正确初始化——
      否则 async-profiler 的 SIGPROF 可能和 JVM 的 SIGSEGV handler 冲突。
      
      追问: 为什么 libjsig 不在 dlopen libjvm.so 时自动加载？→ 因为 signal chain 必须
      在 JVM 注册自己的信号处理器之前初始化（java_md_solinux.c:1034 明确注释：
      "Ensure that signal chaining is initialized before the JVM starts up any
      signal handling, so that the JVM's signal handlers can be chained with 
      any application- or agent-installed signal handlers."）

  ② Counterfactual: 如果 libjsig 未预加载，信号冲突的后果是什么？
      答案方向: 
      - JVM 用 SIGSEGV 做 NullPointerException 检测 → 信号处理器在 JVM 内部
      - 如果应用也注册了 SIGSEGV handler（例如 async-profiler）→ 后者覆盖前者 →
        NullPointerException 变成 segfault crash → hs_err 文件可能记录为
        "Internal Error (signalHandling.cpp:45), pid=..., tid=...,
        problematic frame: V [libjvm.so+...]"
      - 如果 async-profiler 先注册，JVM 后注册 → JVM 的 handler 覆盖 profiler →
        profiler 无法采样 → 静默失效
```

---

## §五 Article Structure

```
§〇 生产场景 — 多版本 JDK 冲突：JAVA_HOME 指向 JDK 8 但 /proc/self/exe 是 JDK 11
  ★ 真实错误消息（emessages.h:98: "could not find libjava.so"）
  ★ 三步诊断：JAVA_HOME vs /proc/self/exe vs stat libjava.so
  ★ 三步诊断命令（readlink + ls + GDB 断点）
  ★ 反事实：如果 libjli 从不检查 JAVA_HOME → 故障消失率 ~60%

§一 ★★★ JVM Loading 全链路源码走读
  ❓ dlopen 不是 "加载一个 .so"——它是 JVM 的入口门
  ❓ LoadJavaVM 做了比 "打开文件" 多得多的事情
  1.1 /proc/self/exe → readlink (java_md_solinux.c:687-689)
  1.2 TruncatePath → GetApplicationHome (java_md_common.c:56-58 / java_md_solinux.c:530-543)
       ├─ JAVA_HOME shortcut (java_md_solinux.c:535-543) — the conflict vector
       ├─ /proc/self/exe based search (java_md_solinux.c:545-559)
       └─ Upward directory traversal (最多 5 层)
  1.3 jvm.cfg → ReadKnownVMs (java.c:2084) → knownVMs[] 数组
  1.4 JVM type selection → CheckJvmType (java.c:677) — 别名链 + 循环检测
  1.5 GetJVMPath → 路径拼接 (java_md_solinux.c:490-511) → stat 验证
  1.6 dlopen(libjvm.so, RTLD_NOW|RTLD_GLOBAL) (java_md_solinux.c:571)
       ├─ RTLD_NOW: 立即解析所有符号 → fail-fast
       ├─ RTLD_GLOBAL: 全局符号可见 → -agentlib 工作的前提
       └─ dlerror() 错误诊断
  1.7 dlsym × 3 → InvocationFunctions 填充 (java_md_solinux.c:624-642)
       ├─ "JNI_CreateJavaVM" → ifn->CreateJavaVM
       ├─ "JNI_GetDefaultJavaVMInitArgs" → ifn->GetDefaultJavaVMInitArgs
       └─ "JNI_GetCreatedJavaVMs" → ifn->GetCreatedJavaVMs
  1.8 ★ libjsig preloading (java_md_solinux.c:1027-1038) — signal chain bootstrap
  1.9 ★ Mermaid: JRE path resolution tree — 从 /proc/self/exe 到 dlopen
       Lanes: Process / OS / Filesystem / JVM
       完整路径发现 + 加载 + 符号解析
  1.10 ★ 面试 Story Format 答案 — "java 是如何找到 libjvm.so 的？"
       因为没有 JAVA_HOME 环境变量 java 也能启动——从 /proc/self/exe 的全路径发现故事

§二 ★★★ JRE 路径发现的 3 层回退策略
  ❓ JAVA_HOME vs /proc/self/exe vs 向上遍历 → 谁的优先级高？
  ❓ 为什么 JAVA_HOME 优先却最不可靠？
  2.1 Layer 1: JAVA_HOME — fast but dangerous
  2.2 Layer 2: /proc/self/exe — reliable kernel-guaranteed path
  2.3 Layer 3: Upward directory traversal — last resort for exotic layouts
  2.4 优先级链的可视化 + 每层失败 → 下层的触发条件

§三 ★★★ jvm.cfg 解析 + JVM 类型选择
  ❓ 什么是 KNOWN / ALIASED_TO / IGNORE？
  ❓ 别名循环检测的工作原理？
  3.1 jvm.cfg 格式规范（java.c:2039-2083 注释）
  3.2 ReadKnownVMs 的逐行解析（java.c:2084-2100）
  3.3 CheckJvmType — 别名链遍历 + 循环检测（java.c:677-777）
  3.4 JDK 9+ jvm.cfg 退化——为什么机制即将废弃

§四 ★★★ dlopen + dlsym 的完整执行序列
  ❓ RTLD_NOW + RTLD_GLOBAL 为什么是不可替换的组合？
  ❓ 如果 dlsym 失败——错误消息的不精确性
  4.1 dlopen 源码（java_md_solinux.c:571-619）— 错误处理 + dlerror
  4.2 dlsym 源码（java_md_solinux.c:624-642）— 三个符号 + 失败处理
  4.3 InvocationFunctions 结构体（java.h:83-87）— 填充前 → 填充后
  4.4 为什么不是静态链接 libjvm → 失去运行时选择 jvmtype 的能力

§五 ★★ 5 Beginner Callout 框
  5.1 dlopen — 共享库加载 + RTLD_NOW/RTLD_GLOBAL 语义
  5.2 dlsym — 函数名字符串 → 函数指针
  5.3 jvm.cfg — JRE 配置文件 + KNOWN/ALIASED_TO/IGNORE
  5.4 InvocationFunctions — 三个 JNI 函数指针的结构体
  5.5 stat() — POSIX 文件验证（不打开）

§六 ★ GDB 断点验证 — 6 断点完整 JVM loading trace
  断言 1: /proc/self/exe readlink (java_md_solinux.c:689)
  断言 2: JAVA_HOME 读取 + 判断 (java_md_solinux.c:543)
  断言 3: GetJVMPath 路径拼接 (java_md_solinux.c:490)
  断言 4: stat(libjvm.so) 验证 (java_md_solinux.c:504)
  断言 5: dlopen(libjvm.so) 执行 (java_md_solinux.c:571)
  断言 6: dlsym("JNI_CreateJavaVM") 返回 (java_md_solinux.c:624)
  断言 7: InvocationFunctions 验证 (java.c:300 — LoadJavaVM 返回后)
  断言 8: ReadKnownVMs 解析 (java.c:2084)
  断言 9: libjsig preload (java_md_solinux.c:1034)

§七 ★ Cross-Reference
  ❓ 00-Libjli-Overview — JLI_Launch 的 8 步全链路 + LoadJavaVM 是第 3 步
  ❓ 01-Argument-Parsing — ParseArguments 的 classpath 构造流程
  ❓ 03-Main-Class-Loading — LoadMainClass 使用 JVM env（在 InitializeJVM 后）
  ❓ 01-jvm-startup §一 — java.c:1545 = JNI_CreateJavaVM 入口 = 01 的 §一
  ❓ 18-agent-instrument — -agentlib 需要 RTLD_GLOBAL 全局符号可见性
  ❓ 19-signal-chaining — libjsig preloading 的 signal chain bootstrap
```

---

## §六 Writing Requirements

1. **Every paragraph opens with WHY** — "Because libjli needs to verify that libjvm.so actually exists and is loadable before it attempts dlopen, GetJVMPath first calls stat() to confirm file existence..." — not WHAT.

2. **3-5 lines source code per claim** — paste relevant C code from `java_md_solinux.c` / `java_md_common.c` / `java.c`, do not describe it.

3. **Mermaid** — JRE path resolution tree: `/proc/self/exe` → `readlink` → `TruncatePath` → `GetApplicationHome` → `stat(lib/libjava.so)` → `GetJVMPath` → `dlopen(libjvm.so, RTLD_NOW|RTLD_GLOBAL)` → `dlsym` × 3 → `InvocationFunctions` 填充。4 lanes: Process / OS / Filesystem / JVM. Annotate every step with file:line.

4. **GDB session** — 6-9 breakpoints with exact file:line numbers:
   - `readlink("/proc/self/exe")` (java_md_solinux.c:689)
   - `getenv("JAVA_HOME")` check (java_md_solinux.c:543)
   - `ReadKnownVMs` entry (java.c:2084)
   - `GetJVMPath` path assembly (java_md_solinux.c:490)
   - `stat(jvmpath)` verification (java_md_solinux.c:504)
   - `dlopen(jvmpath)` call (java_md_solinux.c:571)
   - `dlsym("JNI_CreateJavaVM")` (java_md_solinux.c:624)
   - `libjsig` preload check (java_md_solinux.c:1034)

   Each with expected variable values to verify.

5. **5 Beginner callout boxes** — the exact text from §一: `dlopen(RTLD_NOW|RTLD_GLOBAL)`, `dlsym("JNI_CreateJavaVM")`, `jvm.cfg`, `InvocationFunctions`, `stat()`.

6. **Cross-reference at three points**:
   - At `dlopen(libjvm.so)` → "→ the JVM is now in process memory; next step is dlsym to get function pointers"
   - At `InvocationFunctions` filled → "→ 00-Libjli-Overview §一 Step 3 (LoadJavaVM completion)"
   - At `libjsig` preload → "→ 19-signal-chaining (SIGPROF / SIGSEGV handler conflicts)"

7. **Story-format interview answer** — at §一末尾: "java 是如何找到 libjvm.so 的？" — narrative from README §五 Q2 template: `/proc/self/exe` → `TruncatePath` → `lib/libjava.so` → `jvm.cfg` → `lib/<arch>/server/libjvm.so` → `stat()` → `dlopen()`. Two-segment story: "没有 JAVA_HOME 环境变量也能启动" + "有 JAVA_HOME 但可能出错"。

8. **3-layer rollback strategy visualization** — JAVA_HOME (fast/dangerous) → /proc/self/exe (reliable/kernel) → upward traversal (last resort). 每层失败 → 触发下层的条件明确展示。

---

## §七 Output Format

- Markdown file, named `02-JVM-Loading.md`
- Output path: `/data/workspace/openjdk-cut-new/probe_md/13-launcher/`
- 元信息头：

```
> **阶段**：[13-launcher]
> **前置**：[00-Libjli-Overview]（理解 JLI_Launch 的 8 步全链路和 LoadJavaVM 在第 3 步的位置）、[01-jvm-startup] §一（理解 JNI_CreateJavaVM 的作用——libjvm.so 被加载就是为了调用它）
> **配套**：[01-Argument-Parsing]（classpath 如何作为 JVM option 传入）、[03-Main-Class-Loading]（LoadMainClass 依赖 JVM env 已完成 InitializeJVM）
> **后续依赖本文**：[18-agent-instrument]（-agentlib 需要 RTLD_GLOBAL 全局符号可见性）、[19-signal-chaining]（libjsig preloading 的 signal chain bootstrap）
> **阅读收益**：追踪从 `/proc/self/exe` 到 `dlopen(libjvm.so)` 到 `dlsym` 三个 JNI 符号的完整 8 步加载链——理解 JRE 路径发现的 3 层回退策略（JAVA_HOME → /proc/self/exe → upward traversal）、jvm.cfg 的解析和别名循环检测、RTLD_NOW+RTLD_GLOBAL 的设计选择、InvocationFunctions 的填充逻辑；掌握 "could not find libjava.so" 的生产故障诊断 workflow
```

- 目标行数: 350+ lines

---

## §八 Prohibited (≥8)

- ❌ 只描述函数调用顺序不做 WHY 分析 — 每个步骤必须解释"为什么这是必要的"，不能只做 "reads /proc/self/exe → calls TruncatePath → stat"
- ❌ 不解释 JAVA_HOME vs /proc/self/exe 的优先级 — 必须展示 java_md_solinux.c:535-543 的 JAVA_HOME 检查 + 为什么它是 conflict vector
- ❌ 忽略 jvm.cfg 的解析细节 — 必须展示 KNOWN/ALIASED_TO/IGNORE 三种状态 + 循环检测
- ❌ 不解释 RTLD_NOW vs RTLD_LAZY — 这是生产环境选择的关键差异（~200ms 符号解析 vs 运行时崩溃风险）
- ❌ 不解释 RTLD_GLOBAL vs RTLD_LOCAL — 必须说明 -agentlib 如何依赖全局符号可见性
- ❌ 忽略 dlerror() 在失败路径中的角色 — dlopen 失败后 dlerror() 提供了 libjli 无法自己生成的诊断信息
- ❌ 不展示 InvocationFunctions 的结构体定义 — 必须展示 java.h:79-87 的完整 typedef
- ❌ 忘记 libjsig preloading — 必须解释 signal chaining 为什么必须在 JVM 热身前初始化
- ❌ 不做 stat() 和 access() 的对比 — 必须解释为什么 libjli 用 stat 而非 access 做文件验证
- ❌ 不做 GDB 断点 trace — 至少 6 个断点覆盖 /proc/self/exe → dlopen → dlsym 完整链
- ❌ 不要解释 C 语言基础

---

## §九 Required (≥8)

- ✅ **★ Mermaid JRE path resolution tree** — 4 lanes: Process / OS / Filesystem / JVM — `/proc/self/exe` → `readlink` → `TruncatePath` → `GetApplicationHome` → `stat(libjava.so)` → `jvm.cfg` → `GetJVMPath` → `dlopen` → `dlsym × 3`
- ✅ **★ 3-layer rollback strategy** — JAVA_HOME (fast/dangerous) → /proc/self/exe (reliable) → upward traversal (last resort) — each with trigger conditions
- ✅ **★ 5 Beginner Callout 框** — exact text from §一: dlopen, dlsym, jvm.cfg, InvocationFunctions, stat()
- ✅ **★ InvocationFunctions 结构体展示** — java.h:79-87 的完整 typedef + dlsym 的三个字符串
- ✅ **★ /proc/self/exe 源码展示** — java_md_solinux.c:687-689 的 readlink 调用 + 内核机制解释
- ✅ **★ dlopen 源码展示** — java_md_solinux.c:571-619 的完整 dlopen + dlerror 错误处理
- ✅ **★ 面试 Story Format 答案** — §一末尾，两段式叙事："没有 JAVA_HOME 也能启动" + "JAVA_HOME 的陷阱"
- ✅ **★ jvm.cfg 格式 + ReadKnownVMs 源码** — java.c:2039-2100 的格式注释 + 解析逻辑
- ✅ **★ GDB 断点 ≥6 条** — 精确到 file:line，每断点有预期变量值，覆盖 /proc/self/exe → dlopen → dlsym
- ✅ **★ 交叉引用** — 00-Libjli-Overview（LoadJavaVM 在 JLI_Launch 中的位置）、01-jvm-startup §一（JNI_CreateJavaVM 入口）、18-agent-instrument（RTLD_GLOBAL 的必要性）、19-signal-chaining（libjsig）

---

## §十 GDB Verification (≥9 assertions)

```
断言 1: /proc/self/exe readlink (java_md_solinux.c:689)
  (gdb) break java_md_solinux.c:689
  (gdb) print self → 期望: "/proc/self/exe"
  (gdb) continue
  (gdb) print buf[0]@len → 期望: ".../jdk/bin/java" 的绝对路径
  (gdb) print len → 期望: >0（readlink 成功）

断言 2: JAVA_HOME 环境变量检查 (java_md_solinux.c:535-543)
  (gdb) break java_md_solinux.c:535
  (gdb) print getenv("JAVA_HOME") → 期望: 用户设置的值 或 NULL
  (gdb) continue
  (gdb) print jrepath → 期望: 如果 JAVA_HOME 有效 → JAVA_HOME 的路径；否则来自 /proc/self/exe

断言 3: TruncatePath 截断 /bin/java (java_md_common.c:56)
  (gdb) break java_md_common.c:56
  (gdb) print buf → 期望: 包含 "/bin/" 的可执行文件路径（例如 ".../jdk/bin/java"）
  (gdb) continue
  (gdb) print *p → 期望: '\0'（截断后的位置——"/bin/" 的 "/" 被替换为 '\0'）
  (gdb) print buf → 期望: ".../jdk"（JRE 根目录）

断言 4: libjava.so 锚点文件验证 (java_md_solinux.c:532)
  (gdb) break java_md_solinux.c:532
  (gdb) print buf → 期望: 拼接后的路径 ".../lib/libjava.so"
  (gdb) continue
  (gdb) print stat_result → 期望: 0（文件存在）或 -1（JRE_ERROR1 路径）

断言 5: ReadKnownVMs 解析 jvm.cfg (java.c:2084)
  (gdb) break java.c:2084
  (gdb) print jvmCfgName → 期望: ".../lib/jvm.cfg"
  (gdb) continue
  (gdb) print knownVMs[0].type → 期望: "server"
  (gdb) print knownVMs[0].isKnown → 期望: JNI_TRUE
  (gdb) print counter → 期望: ≥1（找到至少 1 个 known VM）

断言 6: GetJVMPath 路径拼接 (java_md_solinux.c:490)
  (gdb) break java_md_solinux.c:490
  (gdb) print jrepath → 期望: JRE 根目录（例如 "/opt/jdk11"）
  (gdb) print jvmtype → 期望: "server"
  (gdb) continue
  (gdb) print jvmpath → 期望: ".../lib/amd64/server/libjvm.so"

断言 7: stat(libjvm.so) 验证 (java_md_solinux.c:504)
  (gdb) break java_md_solinux.c:504
  (gdb) print jvmpath → 期望: libjvm.so 的完整路径
  (gdb) continue
  (gdb) print stat_result → 期望: 0（文件存在）→ stat 成功

断言 8: dlopen(libjvm.so) 执行 (java_md_solinux.c:571)
  (gdb) break java_md_solinux.c:571
  (gdb) print jvmpath → 期望: libjvm.so 的完整路径
  (gdb) continue
  (gdb) print libjvm → 期望: 非 NULL（dlopen 成功返回 handle）
  (gdb) print dlerror() → 期望: NULL（无错误）——如果 libjvm 为 NULL 则打印错误原因

断言 9: dlsym("JNI_CreateJavaVM") 返回验证 (java_md_solinux.c:624)
  (gdb) break java_md_solinux.c:624
  (gdb) continue
  (gdb) print ifn->CreateJavaVM → 期望: 非 NULL 函数指针
  (gdb) print ifn->GetDefaultJavaVMInitArgs → 期望: 非 NULL 函数指针
  (gdb) print ifn->GetCreatedJavaVMs → 期望: 非 NULL 函数指针

断言 10: LoadJavaVM 调用点返回验证 (java.c:300)
  (gdb) break java.c:300
  (gdb) print jvmpath → 期望: libjvm.so 的完整路径（已由 GetJVMPath 填充）
  (gdb) continue (经过 LoadJavaVM)
  (gdb) print ifn.CreateJavaVM → 期望: 非 NULL 函数指针
  (gdb) print ifn.GetDefaultJavaVMInitArgs → 期望: 非 NULL 函数指针
  (gdb) print ifn.GetCreatedJavaVMs → 期望: 非 NULL 函数指针

断言 11: libjsig preload 检查 (java_md_solinux.c:1034)
  (gdb) break java_md_solinux.c:1034
  (gdb) print getenv("LD_PRELOAD") → 期望: NULL 或包含 libjsig.so 的字符串
  (gdb) continue
  (gdb) print dlsym_result → 期望: NULL（无 LD_PRELOAD） 或 JVM_begin_signal_chain_for_JVM 的函数指针

断言 12: JRE_ERROR1 错误路径 — 故意用无效 JAVA_HOME 触发
  (gdb) break java_md_solinux.c:559
  运行: JAVA_HOME=/path/does/not/exist java -jar app.jar
  (gdb) print jrepath → 期望: 空字符串或已尝试过的无效路径
  (gdb) continue
  期望输出: "Error: Could not find Java SE Runtime Environment." (emessages.h:91)
```

---

## §十一 与 prompt-00 和 prompt-01 的连续性

本文是 13-launcher 的四篇核心文档中的第三篇。连续性要求：

1. **从 prompt-00 承接**：00 的 §一 中 Step 3 是 `LoadJavaVM(jvmpath, &ifn) → dlopen + dlsym`——本文是 Step 3 的完整展开。本文 §一 应引用 00 的 §一 Step 3 作为起点。

2. **从 prompt-01 承接**：01 的 classpath 构造逻辑依赖 libjvm.so 已成功加载（`ParseArguments` 在 `LoadJavaVM` 之后执行）——本文 §五 中应引用 ParseArguments 的调用时序。

3. **向 prompt-03 过渡**：本文的 `JNI_CreateJavaVM` 调用点（`java.c:1545`）是 03 中 `LoadMainClass` 的先决条件——本文 §七 Cross-reference 必须标注 03 的入口点。

4. **与 01-jvm-startup 的边界**：本文的终点是 `InvocationFunctions` 填充完成——下一阶段是 `InitializeJVM → JNI_CreateJavaVM`，那是 01-jvm-startup 的领域。本文 §一 末尾应明确标注：`→ 进入 01-jvm-startup §一 (JNI_CreateJavaVM 内部)`。
