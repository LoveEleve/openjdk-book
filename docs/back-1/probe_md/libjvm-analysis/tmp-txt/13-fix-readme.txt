Fix 3 gaps + 4 line-number errors in 13-launcher/README.md (~510 lines). Edit existing file only.

## Gap 1: §四 doc plan — problem-framed questions + full paths

### Fix 00-Libjli-Overview (line ~388):
Change core question from: "java MyClass 到 JNI_CreateJavaVM 的完整调用链"
To: "凌晨 3 点发布系统报 `Error: Could not create the Java Virtual Machine` → CI/CD 阻塞 → 你需要从 `JLI_Launch()` 源码定位：是 `dlopen(libjvm.so)` 失败，还是 `JNI_CreateJavaVM()` 返回错误？"

Add source file paths with full repo paths:
- `src/java.base/share/native/libjli/java.c` (JLI_Launch, LoadJavaVM, LoadMainClass)
- `src/java.base/unix/native/libjli/java_md_solinux.c` (dlopen, dlsym, /proc/self/exe)
- `src/java.base/unix/native/libjli/java_md_common.c` (GetExecName, TruncatePath)

### Fix 01-Argument-Parsing (line ~396):
Change core question from: "ParseArguments() 如何区分 JVM 选项、启动器选项和应用参数"
To: "生产多版本 JDK 共存——`-XX:+UseZGC` 被识别为 JVM 选项但 JDK 11 不支持 ZGC → 应该早失败还是传给 JVM 让它失败？`ParseArguments()` 的分类逻辑是什么？"

Add source paths: `src/java.base/share/native/libjli/java.c` (ParseArguments, AddOption), `src/java.base/share/native/libjli/args.c`, `src/java.base/share/native/libjli/wildcard.c`

### Fix 02-JVM-Loading (line ~402):
Change core question from: description to problem-framed.
Add source paths.

### Fix 03-Main-Class-Loading (line ~409):
Add source paths: `src/java.base/share/native/libjli/manifest_info.h`, `src/java.base/share/native/libjli/parse_manifest.c`

---

## Gap 2: §五 interview Q1/Q2/Q4 — rewrite as stories

### Q1 (line 422): Replace the dense source trace with:

**Story format**: 
"分两段。第一段是 libjli（~0.05s）：`JLI_Launch()` 解析你的命令行 → 分离 `-Xms8g`（JVM 标志）和 `app.jar`（你的应用）→ 通过 `/proc/self/exe` 找到 JRE 安装路径 → `dlopen(libjvm.so)` → `dlsym("JNI_CreateJavaVM")` → 调用。第二段是 libjvm（~2s）：`JNI_CreateJavaVM()` 内部，[01-jvm-startup §一] 详细解释——创建堆、加载 Object 类、启动编译线程。最后 libjli 重新接管：`LoadMainClass()` → `FindClass(mainClassName)` → `CallStaticVoidMethod()` → 进入 `main()`。两段总计约 2.05 秒，libjli 占 2% 时间但 100% 的启动错误信息。"

Add Mermaid diagram showing the 13/01 responsibility split with libjli → JNI_CreateJavaVM → libjvm boundary.

### Q2 (line 423): Add WHY narrative.
Prepend: "因为没有 JAVA_HOME 环境变量 `java` 也能启动。秘密是 `/proc/self/exe`——Linux 内核为每个进程提供的符号链接，指向实际的可执行文件。libjli 从它出发向上遍历目录找 `lib/libjava.so` → 确认这是 JRE → 拼出 `lib/<arch>/server/libjvm.so` 路径 → `stat()` 验证文件存在 → `dlopen()` 加载。"

Then keep the source trace but make it 40% shorter.

### Q4 (line 425): Add quantified performance implication.
Add: "`opendir` 枚举 1000 个 JAR 需要 ~2ms——这就是大 classpath 启动慢的根因之一。这也是 Java 9+ 模块系统的动机——不再需要通配符展开就能找到所有模块。"

---

## Gap 3: §六 JNI_CreateJavaVM failure — concrete diagnostics (line 438)

Replace vague diagnostics with:
"诊断命令：
1. `ulimit -v` — 检查虚拟内存限制是否小于请求的堆大小
2. `ldd $(dirname $(readlink -f /proc/self/exe))/../lib/jli/libjli.so` — 检查 libjli 的依赖是否完整
3. `java -Xlog:modules=debug -version 2>&1 \| grep ERROR` — 检查模块系统加载错误
4. `strace -e openat java -Xms128m -jar app.jar 2>&1 \| grep ENOENT` — 找出缺失的文件"

---

## Line number corrections

| Location | Stated | Actual from source |
|----------|--------|--------------------|
| JLI_Launch() at java.c | 219 | **220** |
| dlsym at java_md_solinux.c | 623 | **624** |
| SelectVersion() at java.c | 1055 | **1056** |
| ParseArguments() at java.c | 1295 | **1296** |
