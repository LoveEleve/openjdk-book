# 01. JNI 工具层 + 系统属性 — libjava.so 的骨架

> 🔴 Deep | JNI exception/string/field + System properties
> 读者处境: JVM 启动后 `System.getProperties()` 返回 `os.name=Linux`、`user.home=/root` 等 ~30 个属性——这些值在 Java 层作为 key-value 存储，但是**采集自 C 层的 /proc、/etc、环境变量**。`System.setOut(new PrintStream(file))` 怎么把 Java FileOutputStream→fd 映射到 C 层 standard stream？
>
> ⚠️ 写作期修正(2026-08-12, vol-02/42-core-native/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **JNU_NewStringPlatform 机制错**: 不是 "JNU_GetDefaultEncoding→NewStringUTF"(JNU_GetDefaultEncoding 不存在);真实=按全局 fastEncoding 分派(jni_util.c:860-876: FAST_UTF_8/8859_1/646_US/CP1252 快速路径+NO_ENCODING_YET 抛 InternalError+newStringJava 慢路径);fastEncoding 由 InitializeEncoding(:793-836)在 System.initProperties 里用 sun.jnu.encoding 设置(System.c:291-294,注释 "platform native encoding for strings has not been set up yet");newStringUTF8(:765-780)是"ASCII 扫描+按字节构造"优化器非严格 UTF-8 解码
> - **JNU_GetFieldByName "static cache" 编造**: 无缓存,每次 GetObjectClass+GetFieldID(:1253-1310)
> - **"user.home — getenv(HOME)" 错**: 实为 getpwuid(getuid())->pw_dir(java_props_md.c:569-574);user.name=pw_name;user.dir=getcwd(:601-606)
> - **JVM_NativePath "标准化" 错**: hotspot 侧 jvm.cpp:697-701 → os::native_path,**Unix 是 no-op 原样返回**(os_posix.cpp:1486-1488);canonicalize_md.c 是 java.io.File 的 getCanonicalPath 服务(canonicalize :190: 先 realpath 整条 :202-204,失败逐段缩回重试 :218-240;collapsible :49)——非"所有路径进 JVM 前 normalize"
> - JNU_ThrowXxx 行号 ✓: ThrowByName :51-57/NullPointer :62-64/OutOfMemory :74-76/NoSuchMethod :110-112/ClassNotFound :116-118/IO :128-130;带 errno 变体 JNU_ThrowByNameWithLastError :164-180(defaultDetail 兜底);jni_util.c 1512 行 ✓;java_props_md.c 620 行 ✓
> - 属性链路 ✓: Java_java_lang_System_initProperties System.c:166 起(GetJavaProperties :177、InitializeEncoding :294、file.encoding :377= sun.jnu.encoding、sun.jnu.encoding :384);GetJavaProperties 一次性采集(static sprops+user_dir 缓存 :407-414);os 三件套 uname/ARCHPROPNAME(:480-497);setlocale(LC_ALL,"")+ParseLocale+编码 nl_langinfo(CODESET)(:268-279,:515);Mac sun_jnu_encoding 硬编码 UTF-8(:542-546);file/path/line separator :608-610
> - 悬念指向 02-process ✓(标题 "02. 进程管理 — Runtime.exec() 的 fork+exec+wait")

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
