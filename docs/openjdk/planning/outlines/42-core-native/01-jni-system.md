# 01. JNI 工具层 + 系统属性 — libjava.so 的骨架

> 🔴 Deep | JNI exception/string/field + System properties
> 读者处境: JVM 启动后 `System.getProperties()` 返回 `os.name=Linux`、`user.home=/root` 等 ~30 个属性——这些值在 Java 层作为 key-value 存储，但是**采集自 C 层的 /proc、/etc、环境变量**。`System.setOut(new PrintStream(file))` 怎么把 Java FileOutputStream→fd 映射到 C 层 standard stream？

### 1. "jni_util — JNI 工具基础层"

场景: 所有 libjava.so native 方法(Class/System/Process/ObjectStream) 在出错时调用 `JNU_ThrowByName(env, "java/lang/NullPointerException", msg)`——这是 JNI exception 管道的统一入口。`JNU_NewStringPlatform` 做 JVM internal UTF-8→Java String 转换。

**JNI 工具函数** (`jni_util.c:51-200 + jni_util.h`):
```
JNU_ThrowByName(env, "java/lang/NullPointerException", msg) — line 51
JNU_ThrowNullPointerException(env, msg)                   — line 64
JNU_ThrowOutOfMemoryError(env, msg)                       — line 76
JNU_ThrowIOException(env, msg)                            — line 130
JNU_ThrowClassNotFoundException(env, msg)                 — line 118
JNU_ThrowNoSuchMethodException(env, msg)                  — line 112
// ~15 predefined exception helpers — 全部调用 (*env)->ThrowNew()

JNU_NewStringPlatform(env, char* str):
  → JNU_GetDefaultEncoding() — 获取 sun.jnu.encoding 系统编码
  → (*env)->NewStringUTF(env, str) — UTF-8 编码 Java String

JNU_GetFieldByName(env, &fieldID, class, name, sig):
  → (*env)->GetFieldID(env, class, name, sig) — 缓存 fieldID 避免重复 JNI lookup
[C++: jni_util.c:1512行——JNI 1.2 标准的薄包装器——所有 JNI 错误处理集中于此]
```
- 源码: `jni_util.c:51-200` (JNU_ThrowXxx helpers) + `jni_util.h:40-200` (JNU_NewString/JNU_GetField 声明) + `jni_util.c:300-500` (JNU_NewStringPlatform→encoding)

- 关键设计: **~15 exception wrappers** — 全部调用 `(*env)->ThrowNew(env, cls, msg)`——但这不是简单的 alias——`JNU_ThrowNullPointerException` 会先检查 `msg` 是否非空→`(*env)->ExceptionCheck()` 确保不覆盖已有异常。**field lookup cache** — `JNU_GetFieldByName` 内部有 static cache 避免每 native call 重复 `GetFieldID`(JNI 中 GetFieldID 每次都要扫描 class→expensive)。

### 2. "System properties — C→Java 映射"

场景: `System.getProperty("os.name")` — 值来自 `java_props_md.c:407` (GetJavaProperties())——在 JVM 启动时采集自 `/proc/version`(/etc/os-release)、`uname(2)`、`getenv("HOME")` 等。

**System.initProperties + java_props_md** (`System.c:200-400 + java_props_md.c:50-600`):
```
Java_java_lang_System_initProperties(env, props):
  → GetJavaProperties(&sprops) → 调用 java_props_md.c:407 获取 ~30 properties
    • os.name/os.arch/os.version — uname(2)→utssname.sysname/machine/release
    • java.home — GetApplicationHome(域40 的 JRE 路径逻辑)
    • user.home — getenv("HOME") → /root
    • file.encoding — nl_langinfo(CODESET) → UTF-8
    • sun.jnu.encoding — setlocale(LC_CTYPE) → ANSI_X3.4-1968 or UTF-8
    • java.class.version — JDK class 文件版本号 → 55.0 (JDK 11)
    • sun.boot.library.path — java.home/lib(amd64/server) → dlopen 搜索路径
  → 每个 property→(*env)->SetObjectArrayElement(props, name, value) 填充 Java Properties
[C++: java_props_md.c:620行——采集 ~30 properties 一次性完成——JVM 启动后不变]
```
- 源码: `System.c:200-300` (initProperties → GetJavaProperties) + `java_props_md.c:50-400` (获取 os/user/java 属性) + `java_props_md.c:400-600` (获取 sun.* 和 java.* 属性)

- 关键设计: **一次性采集** — System properties 在 JVM 启动时采集一次→之后不可变(即使 OS 改了)。`sun.jnu.encoding` vs `file.encoding` — 前者是 OS locale(用于 JNI 字符串转换)→后者是 JVM 的默认 Charset(用于 Java 层 String 构造)——两者可以不同。**canonicalize_md.c** — `JVM_NativePath(char*)` 将路径标准化(去除 `./`、`../`、`//`→`/`)——所有文件路径在进入 JVM 前 normalize。

---

### 核心悬念

**"jni_util(~15 JNU_ThrowXxx wrappers + JNU_NewStringPlatform encoding 转换)→System.initProperties→java_props_md.c(uname/getenv/nl_langinfo/~30 properties 一次性采集)。这是 libjava.so 的骨架——所有其他 native 方法(JNI→Java 异常管道+系统属性)都建立在它之上。"** — 下一篇: 进程管理(fork/exec/ProcessHandle)。

> → [02-process.md](02-process.md)
