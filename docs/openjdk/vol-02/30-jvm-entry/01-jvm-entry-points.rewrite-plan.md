# 30-jvm-entry/01-jvm-entry-points 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 `System.currentTimeMillis()` 这条从 Java 到 C++ 的调用链——JDK 的 libjava 怎么找到 JVM 函数、运行时怎么解析、进门时入口宏怎么选

## 1. 选题判断

现稿已有很强事实基础：
- `jvm.h` 三段结构 + 182 个 JNIEXPORT 函数
- `System.c` 注册表 + ELF 链接期符号
- `NativeLookup::lookup` 动态解析 + `set_native_function`
- `JVM_ENTRY` / `JVM_LEAF` 家族宏

但现稿仍偏"接口面一节 + JDK 接法一节 + 解析一节 + 进门宏一节"的机制并列。真正该打穿的读者困惑更集中：

**`System.currentTimeMillis()` 是 Java 代码，为什么最终能跑到 C++ 的 `os::javaTimeMillis()`？中间的桥是什么？JDK 的 libjava 怎么找到 JVM 函数——是运行时查表还是编译期定好的？JVM 侧进门时 JVM_ENTRY 和 JVM_LEAF 怎么选？**

## 2. 一句话顿悟

**`System.currentTimeMillis()` 的调用链是: Java 方法 → native 方法表 → JVM_CurrentTimeMillis 函数地址。JDK 侧 libjava 在编译期直接取 `&JVM_CurrentTimeMillis`，运行时由 ELF 动态链接器解析 libjvm.so 的导出符号；首次调用时 `NativeLookup::lookup` 做一次动态解析并把入口写进 Method，后续直达。进门时 JVM_LEAF 三行完事——因为不碰堆、不创建引用、不抛异常。**

## 3. 总图

```text
Java: System.currentTimeMillis()
  ↓ native 方法表
JDK 侧: System.c 注册表
  ↓ RegisterNatives
  JVM_CurrentTimeMillis (编译期取址 &JVM_CurrentTimeMillis)
  ↓ ELF 动态链接器
  libjvm.so 导出的 JVM_CurrentTimeMillis
  ↓ JVM_LEAF
  os::javaTimeMillis()
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——"Java 代码怎么跑到 C++"

目标约 1000 字。

- 从 `System.currentTimeMillis()` 是 Java 方法但实现是 C++ 切入
- 点出：这不是 JNI（用户 native 代码），而是 JDK 自身的 JVM_* 通道
- 埋主线：编译期定址 + ELF 链接 + 运行时一次解析

### 第二节：两个朴素方案为什么都不对

目标约 1200 字。

必须推演：
1. 每次调用都通过 JNI 函数表动态查找（每次都要查表，慢）
2. 把 JVM 函数直接硬编码进 Java 运行时（无法版本隔离）

结论：
- 编译期取址 + ELF 链接 + 一次运行时解析，兼顾性能与隔离

### 第三节：接口面——jvm.h 的声明与 jvm.cpp 的实现

目标约 1800 字。

- `jvm.h` 三段结构（jvm.h:38-55）
- 182 个 JNIEXPORT 函数，`JVM_INTERFACE_VERSION 6`（:66）
- `jvm.cpp` 实现（JVM_CurrentTimeMillis :271, JVM_StartThread :2857）
- 与 JNI 函数表的区别：JVM_* 不是 `env->` 调用，是直接函数调用

### 第四节：JDK 侧怎么接上——编译期取址 + ELF 链接

目标约 1800 字。

- `System.c` 注册表（System.c:25-48）
- `RegisterNatives` 把 `(void *)&JVM_CurrentTimeMillis` 写进方法表
- libjava.so 的 UND 符号 `JVM_CurrentTimeMillis@SUNWprivate_1.1`
- `jvm_sym.ver` 导出四族：`JNI_*; JVM_*; jio_*; AsyncGetCallTrace`

### 第五节：运行时解析——NativeLookup::lookup

目标约 1500 字。

- `NativeLookup::lookup`（nativeLookup.cpp:527-546）
- `has_native_function()` 检查，`set_native_function()` 固化入口
- 注册的本质：把动态查找提前、把入口固定为编译期已知的 JVM_* 符号
- `-verbose:jni` 打印的解析日志

### 第六节：进门——JVM_ENTRY 家族

目标约 2000 字。

- `JVM_ENTRY`（interfaceSupport.inline.hpp:558-565）：带状态转换 + HandleMark
- `JVM_LEAF`（:588-592）：`block_if_vm_exited` + `NoHandleMark`，不碰堆
- `JVM_CurrentTimeMillis` 三行（jvm.cpp:271-274）
- 选哪个宏的判据：碰不碰堆

### 第七节：误解澄清与收网

目标约 1200 字。

至少回答：
1. JVM_* 和 JNI 函数表的关系
2. 注册是不是每次启动都做
3. JVM_LEAF 为什么不需要状态转换
4. `jvm_sym.ver` 导出的是哪些族
5. `JVM_ENTRY` 和 `JVM_QUICK_ENTRY` 的差异

## 5. 失败方案必须写进正文

1. 每次调用都通过 JNI 函数表动态查找
2. 把 JVM 函数直接硬编码进 Java 运行时

## 6. 证据清单

- `src/hotspot/share/include/jvm.h:38-55`：三段结构注释
- `src/hotspot/share/include/jvm.h:59`：函数声明起始
- `src/hotspot/share/include/jvm.h:66`：`JVM_INTERFACE_VERSION 6`
- `src/hotspot/share/prims/jvm.cpp:271-274`：`JVM_CurrentTimeMillis`
- `src/hotspot/share/prims/jvm.cpp:357`：`JVM_StartThread`（实际 :2857）
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:558-565`：`JVM_ENTRY`
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:588-592`：`JVM_LEAF`
- `src/hotspot/share/runtime/interfaceSupport.inline.hpp:578-585`：`JVM_QUICK_ENTRY`
- `src/hotspot/share/prims/nativeLookup.cpp:527-546`：`NativeLookup::lookup`
- `src/hotspot/jvm_sym.ver`：导出符号

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦 JVM_* 入口，不展开 JavaCalls（02 篇已安排）
- 不展开 System.c 的完整 JDK 注册流程
- 不展开 ELF 动态链接器细节
- 下一篇若讲 JavaCalls，应自然承接"JVM 内部怎么调 Java 方法"

## 8. 完成后 review

- 删除代码后，能否复述"编译期取址 + ELF 链接 + 一次运行时解析"
- 是否讲清 JVM_* 与 JNI 函数表的区别
- 是否讲清 JVM_ENTRY 与 JVM_LEAF 的选型判据
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验