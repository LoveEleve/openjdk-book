# 27-jni/03-jni-check-platform 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 `-Xcheck:jni` 怎么通过整表替换"插进"所有 JNI 调用、查什么、以及为什么快路径在检查模式下失效

## 1. 选题判断

现稿已有很强事实基础：
- `jni_functions()` 读入口 + `CheckJNICalls` 分支
- `jni_functions_check()` 三件事（存原始表、断言结构一致、返回 checked 表）
- `JNI_ENTRY_CHECKED` 宏 + wrapper 四段结构
- `functionEnter` / `functionExit` / `IN_VM`
- 八个维度的检查项
- 平台层函数表组织
- `jniPeriodicChecker` 纠正

但现稿仍偏"表格替换一节 + wrapper 骨架一节 + 检查维度一节 + 平台层一节"的机制并列。真正该打穿的读者困惑更集中：

**JNI 传错参数是未定义行为——release 不检查、错着就崩。那 `-Xcheck:jni` 是怎么做到'插进所有调用'的？它查什么？为什么 02 篇的快路径在检查模式下必须失效？**

## 2. 一句话顿悟

**`-Xcheck:jni` 不修改任何 JNI 函数，而是用一张平行函数表整体替换——`jni_functions()` 返回 checked 表，`env->functions` 的 200 多个槽全指向 checked_jni_xxx wrapper。每个 wrapper 四段式：入口查线程/env、functionEnter 查挂起异常与 critical 区、IN_VM 校验参数、回调后 functionExit 数本地引用。release 下 `CheckJNICalls=false`，函数表原样不动，零开销。**

## 3. 总图

```text
jni_functions()
  CheckJNICalls=true  → jni_functions_check() → &checked_jni_NativeInterface
  CheckJNICalls=false → &jni_NativeInterface

checked wrapper 四段:
  1. JNI_ENTRY_CHECKED: 查线程存在性/env 归属
  2. functionEnter: 查 critical 区 + 挂起异常
  3. IN_VM { 参数校验 }: 引用/methodID/fieldID/数组
  4. UNCHECKED()->xxx → functionExit: 数本地引用
```

## 4. 结构大纲与字数预算

### 第一节：开场困惑——"JNI 错了怎么检查"

目标约 1000 字。

- 从 JNI 传错参数是未定义行为切入
- 点出：release 不检查、错着就崩
- 埋主线：`-Xcheck:jni` 靠整表替换，不是改函数

### 第二节：两个朴素方案为什么都不对

目标约 1200 字。

必须推演：
1. 编译期静态检查（JNI 参数运行时动态，编译期无法知道）
2. 在每个函数里手动加 if 分支（release 下仍有分支开销，且污染源码）

结论：
- 整表替换 + 启动时一次性决策，release 零开销

### 第三节：整表替换——不是宏，是平行函数表

目标约 2200 字。

- `jni_functions()`（jni.cpp:3875-3881）
- `jni_functions_check()` 三件事（jniCheck.cpp:2304-2323）
- CheckJNICalls 默认 false（globals.hpp:913），`-Xcheck:jni` 置位（arguments.cpp:2868）
- `!CheckJNICalls` 是 quicken 五条件之一（02 篇）
- INCLUDE_JNI_CHECK 编译开关

### 第四节：wrapper 四段

目标约 2400 字。

- `JNI_ENTRY_CHECKED` 宏（jniCheck.cpp:91-104）
- `functionEnter`（:222-228）：critical 区 + 挂起异常
- `IN_VM`（:63-68）：局部状态转换，校验摸堆
- 参数校验：validate_handle（:443）/ validate_object（:469-475）/ validate_jmethod_id（:453-466）/ checkStaticFieldID（:256）/ checkInstanceFieldID（:284）
- `functionExit`（:239-252）：本地引用计数 + `add_planned_handle_capacity`（:202-207）
- 示例：checked_jni_DefineClass（:545-558）

### 第五节：平台层——函数表在哪、谁声明的

目标约 1500 字。

- `jni_NativeInterface` 在 jni.cpp:3528-3806
- `JNINativeInterface_` 在 jni.h:214
- `jni_functions_nocheck()` 绕过检查
- `jniPeriodicChecker` 的作用不是泄漏检查（jniPeriodicChecker.cpp:33-37, os_linux.cpp:5381-5394）

### 第六节：误解澄清与收网

目标约 1200 字。

至少回答：
1. 检查是否修改了 JNI 函数本身
2. 为什么快路径在检查模式下失效
3. 检查是 fatal 还是 warning
4. jniPeriodicChecker 是否检查泄漏
5. 函数表替换是否影响性能

## 5. 失败方案必须写进正文

1. 编译期静态检查（JNI 参数运行时动态）
2. 在每个函数里手动加 if 分支（release 仍有分支开销）

## 6. 证据清单

- `src/hotspot/share/prims/jni.cpp:3875-3881`：`jni_functions()`
- `src/hotspot/share/prims/jni.cpp:3528-3806`：`jni_NativeInterface`
- `src/hotspot/share/prims/jniCheck.cpp:2304-2323`：`jni_functions_check()`
- `src/hotspot/share/prims/jniCheck.cpp:91-104`：`JNI_ENTRY_CHECKED`
- `src/hotspot/share/prims/jniCheck.cpp:545-558`：`checked_jni_DefineClass`
- `src/hotspot/share/prims/jniCheck.cpp:63-68`：`IN_VM`
- `src/hotspot/share/prims/jniCheck.cpp:222-228`：`functionEnter`
- `src/hotspot/share/prims/jniCheck.cpp:239-252`：`functionExit`
- `src/hotspot/share/prims/jniCheck.cpp:184-197`：`check_pending_exception`
- `src/hotspot/share/prims/jniCheck.cpp:202-207`：`add_planned_handle_capacity`
- `src/hotspot/share/prims/jniCheck.cpp:443`：`validate_handle`
- `src/hotspot/share/prims/jniCheck.cpp:469-475`：`validate_object`
- `src/hotspot/share/prims/jniCheck.cpp:453-466`：`validate_jmethod_id`
- `src/hotspot/share/prims/jniCheck.cpp:256`：`checkStaticFieldID`
- `src/hotspot/share/prims/jniCheck.cpp:284`：`checkInstanceFieldID`
- `src/hotspot/share/runtime/globals.hpp:913`：`CheckJNICalls` 默认 false
- `src/hotspot/share/runtime/arguments.cpp:2863-2868`：`-Xcheck:jni` 置位
- `src/hotspot/share/prims/jniPeriodicChecker.cpp:33-37`：`JniPeriodicCheckerTask`
- `src/hotspot/share/prims/jniExport.hpp:28-38`：`JniExportedInterface`

## 7. 必须明确的边界

- 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
- 本篇聚焦 `-Xcheck:jni` 的检查机制，不展开 JVMTI 动态替换（28-01 已讲）
- 不展开完整的 JNI 函数表枚举（200+ 个槽）
- 下一篇若讲 JVM Entry Points，应自然承接"函数表替换是更通用的模式"

## 8. 完成后 review

- 删除代码后，能否复述"整表替换，release 零开销"
- 是否讲清 wrapper 四段结构
- 是否讲清为什么快路径失效
- 是否讲清 jniPeriodicChecker 不查泄漏
- 是否完成删码测试、禁用词、链接、`file:line`、`git diff --check` 校验