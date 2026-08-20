# 42-core-native/01-jni-system 重写规划

> 基于 `OpenJDK 11u / Linux / x86_64 / libjava + HotSpot`
> 目标：解释 `System.getProperties()`、路径/编码工具函数这些看起来像 Java API 的行为，为什么背后需要一层 libjava native 工具骨架；同时把 JNI 工具函数、平台编码初始化、一次性系统属性采集收成一条“Java 世界前的翻译层”主线

## 1. 选题判断

现稿已有较强事实基础：
- `JNU_ThrowByName` 与异常封装
- `JNU_NewStringPlatform` / `InitializeEncoding`
- `Java_java_lang_System_initProperties`
- `GetJavaProperties`
- `os::native_path` 与 `canonicalize`

但当前正文仍偏“JNI 工具函数一节 + 系统属性一节 + 路径机制一节”并列。真正该打穿的读者困惑更集中：

**为什么 Java 层一个看起来很普通的 `System.getProperties()`、一个 native 抛异常、一次路径转换，背后需要专门一层 libjava 工具骨架？这些逻辑为什么不直接散落在各个 native 方法里，或者全交给 HotSpot？libjava 到底承担的是“系统调用采集器”、还是“JNI 辅助库”、还是“Java 世界前的一层翻译器”？**

这才是本篇最该回答的问题。

## 2. 一句话顿悟

**libjava 的价值不是“替 JVM 再写一遍 JNI 封装”，而是把‘操作系统世界的原始数据和错误语义’翻译成‘Java 世界能消费的对象、字符串、异常和属性表’。`JNU_ThrowXxx` 把 native 错误统一翻成 Java 异常，`JNU_NewStringPlatform` 把平台字节串按 `sun.jnu.encoding` 翻成 Java `String`，`System.initProperties` 则在启动早期一次性把 OS/用户/locale/路径信息采进 Java Properties。它既不是 HotSpot 的一部分，也不是普通业务 native 方法，而是一层 Java 世界前的共用翻译器。**

## 3. 总图

```text
OS / C 侧原始世界
  ├─ errno / last error string
  ├─ char* 路径 / 编码串
  ├─ uname / getpwuid / getcwd / locale
  └─ 平台路径差异 / realpath 结果

libjava 工具层
  ├─ JNU_ThrowXxx           -> Java 异常
  ├─ JNU_NewStringPlatform  -> Java String
  ├─ InitializeEncoding     -> fastEncoding / jnuEncoding
  └─ GetJavaProperties      -> java_props_t 快照

Java 世界
  ├─ System.initProperties(Properties)
  ├─ java.io.File canonical path
  └─ 其他 native 方法复用同一套 JNU 辅助能力
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——为什么一个 `System.getProperties()` 背后要有一层 native 翻译器

目标约 1200 字。

- 从 `System.getProperties()` 与 `os.name/user.home/file.encoding` 切入
- 点出：这些值不是 Java 自己生成的，而是 OS 侧采集再翻译进 Java
- 埋主线：libjava 是 Java 世界前的翻译器

### 第二节：两个朴素理解为什么都不对

目标约 1800 字。

必须推演：
1. 每个 native 方法自己直接做异常、字符串、属性翻译就够了
2. 这些事情都应当由 HotSpot 统一负责，不需要 libjava 中间层

结论：
- 第一种会让异常/编码/路径语义在各 native 文件中碎片化
- 第二种混淆了 JVM 运行时职责与 JDK 原生库职责

### 第三节：异常通道——为什么 `JNU_ThrowXxx` 要收敛到单一入口

目标约 1900 字。

- `JNU_ThrowByName`
- 常见 `JNU_ThrowXxx` 薄封装
- `JNU_ThrowByNameWithLastError`
- 强调这是“统一翻译 native 错误语义”的基础设施，不是 JNI 规范本体

### 第四节：字符串与编码——为什么 `char*` 进 Java 前必须先过 `InitializeEncoding`

目标约 2200 字。

- `JNU_NewStringPlatform`
- `fastEncoding` 分派
- `newStringUTF8` 的 ASCII 快路径不是“完整 UTF-8 解码器”
- `InitializeEncoding` 设置 `sun.jnu.encoding`
- 说明平台编码是 libjava 共享前提，不是每个调用点各自猜

### 第五节：系统属性——为什么是“一次性采集 + 一次性填充”

目标约 2200 字。

- `Java_java_lang_System_initProperties`
- `GetJavaProperties`
- `static java_props_t sprops` + `user_dir` 缓存
- `uname/getpwuid/getcwd/setlocale/nl_langinfo`
- `InitializeEncoding` 在 `PUTPROP_ForPlatformNString` 之前的顺序约束

### 第六节：路径——为什么 JVM_NativePath 与 canonicalize 不是同一件事

目标约 1800 字。

- `os::native_path` 在 posix 上是 no-op
- `canonicalize_md.c` 的 `realpath()` + 逐段回退
- 说明平台路径适配、语义规范化、系统属性原样值三层边界
- 避免“所有路径进 JVM 前都会统一规范化”的误解

### 第七节：误解澄清与收网

目标约 1300 字。

至少回答：
1. `JNU_ThrowXxx` 是否属于 JNI 规范
2. `newStringUTF8` 是否等于通用 UTF-8 解码器
3. `user.home` 是否来自 `HOME` 环境变量
4. JVM_NativePath 是否在 Unix 上也做规范化
5. `System.setProperty` 是否会改动 C 层 `sprops`

## 5. 失败方案必须写进正文

1. 每个 native 方法各自手写异常/编码/属性翻译
2. 把 libjava 工具层与 HotSpot 运行时职责混成一层
3. 把平台路径适配、canonicalize、属性值采集混成同一种“路径标准化”

## 6. 证据清单

- `src/java.base/share/native/libjava/jni_util.c:51`：`JNU_ThrowByName`
- `src/java.base/share/native/libjava/jni_util.c:162`：`JNU_ThrowByNameWithLastError`
- `src/java.base/share/native/libjava/jni_util.c:765`：`newStringUTF8`
- `src/java.base/share/native/libjava/jni_util.c:787`：`InitializeEncoding`
- `src/java.base/share/native/libjava/jni_util.c:860`：`JNU_NewStringPlatform`
- `src/java.base/share/native/libjava/System.c:166`：`Java_java_lang_System_initProperties`
- `src/java.base/share/native/libjava/System.c:291`：`InitializeEncoding` 顺序约束
- `src/java.base/unix/native/libjava/java_props_md.c:407`：`GetJavaProperties`
- `src/java.base/unix/native/libjava/java_props_md.c:474`：`uname`
- `src/java.base/unix/native/libjava/java_props_md.c:518`：`setlocale` / `ParseLocale`
- `src/java.base/unix/native/libjava/java_props_md.c:543`：`sun_jnu_encoding`
- `src/java.base/unix/native/libjava/java_props_md.c:567`：`getpwuid` / `user_home`
- `src/java.base/unix/native/libjava/java_props_md.c:594`：`getcwd` / `user_dir`
- `src/hotspot/os/posix/os_posix.cpp:1486`：`os::native_path`
- `src/java.base/unix/native/libjava/canonicalize_md.c:190`：`canonicalize`
- `src/java.base/unix/native/libjava/canonicalize_md.c:202`：`realpath`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / Linux / x86_64`
- 本篇聚焦 libjava 的“工具层 + 属性层”，不扩成完整 JNI 教程
- Windows/Mac 差异只在必要处点到，不把多平台分支全部铺开
- `JVM_NativePath` 只讲平台适配角色，不展开 launcher 路径处理全链路
- 后续篇章若继续 core-native 域，应从这里接进 process / env / properties 等操作系统交界主题

## 8. 完成后 review

- 删除代码后，能否复述“libjava 是 Java 世界前的 native 翻译器”
- 是否清楚区分异常翻译、字符串编码翻译、系统属性采集三条职责
- 是否明确 `InitializeEncoding` 的顺序地位
- 是否把 JVM_NativePath 与 canonicalize 的边界讲清楚
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验
