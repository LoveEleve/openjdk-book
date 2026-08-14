# 03. JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层

> **前置依赖**:[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md):JNIHandleBlock 的 `_planned_capacity` 字段在这里埋了伏笔;[27-jni/02 — JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](openjdk/vol-02/27-jni/02-jni-fast-path.md):函数表替换机制与 `CheckJNICalls` 条件;[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JniPeriodicCheckerTask 已在后台任务清单里讲过
> → **后续**:[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](01-jvm-entry-points.md)
> 关联域: 28-jvmti(工具接口用同一张函数表)、42-core-native(JNI 系统另一侧)、04-logging

## 传错参数是未定义行为——但可以"帮你看见"

JNI 规范里,传 NULL 给该传引用的函数、跨线程用 JNIEnv、带着异常继续调 JNI——全是**未定义行为**: release 版 JVM 不检查,错了就错着(可能崩、可能静默错值)。但开发期需要另一副眼睛:`-Xcheck:jni` 打开后,JVM 给**每一个 JNI 调用**加装检查,错了当场警告甚至 abort。这篇拆这套检查器: 它怎么"插"进所有调用、查什么、报错长什么样,以及它和 02 篇的函数表有什么关系。

## 1. 不是宏,是整表替换

大纲式的直觉是"宏替换,release 展开为空"——机制其实更系统: **jniCheck 是一整张独立的 JNI 函数表,`-Xcheck:jni` 时整体替换**。回到 02 篇的函数表机制——`jni_functions()`(jni.cpp:3876-3881)是表的读入口:

```cpp
// jni.cpp:3875-3881(截取核心,逐字)
// Returns the function structure
struct JNINativeInterface_* jni_functions() {
#if INCLUDE_JNI_CHECK
  if (CheckJNICalls) return jni_functions_check();
#endif // INCLUDE_JNI_CHECK
  return &jni_NativeInterface;
}
```

`jni_functions_check()`(jniCheck.cpp:2304-2323)干三件事: ①把原始函数表存进 `unchecked_jni_NativeInterface`(:2306,下面的 wrapper 通过 `UNCHECKED()` 回调它);②**断言 checked 表与原始表结构一致**(:2311-2314,"Mismatched JNINativeInterface tables, check for new entries"——JNI 规范加了新函数而 checked 表漏建,启动时直接暴露);③返回 checked 表。`CheckJNICalls` 是 product flag(globals.hpp:913,默认 false),由 `-Xcheck:jni` 置位(arguments.cpp:2868)。所以: **release 下不替换、零开销;检查开启时,`env->functions` 的 200 多个槽全部指向 checked_jni_xxx wrapper**——02 篇 `quicken_jni_functions` 的 5 个条件里 `!CheckJNICalls` 正因如此: 快路径 stub 与 checked wrapper 不可能同时在一个函数表槽上,检查优先。

## 2. wrapper 的骨架: 检查、回调、收尾

每个 checked 函数都是同一个模板(JNI_ENTRY_CHECKED 宏,jniCheck.cpp:91-104 + 函数体):

```cpp
// jniCheck.cpp:545-558(截取核心,逐字)
JNI_ENTRY_CHECKED(jclass,
  checked_jni_DefineClass(JNIEnv *env,
                          const char *name,
                          jobject loader,
                          const jbyte *buf,
                          jsize len))
    functionEnter(thr);
    IN_VM(
      jniCheck::validate_object(thr, loader);
    )
    jclass result = UNCHECKED()->DefineClass(env, name, loader, buf, len);
    functionExit(thr);
    return result;
JNI_END
```

四段: ①**入口检查**(宏内): `Thread::current_or_null()` 为空或不是 Java 线程 → `fatal_using_jnienv_in_nonjava`("Using JNIEnv in non-Java thread")+ abort;`env` 与 `thr->jni_environment()` 不符 → fatal "Using JNIEnv in the wrong thread";然后 `VM_ENTRY_BASE` 建立 handle 标记(注释 :82-84: 用 JNI_ENTRY_CHECKED 而不是 QUICK/LEAF,是"为了出错时能创建 handle"打印栈)——**注意与普通 `JNI_ENTRY` 的区别: 宏里没有 `ThreadInVMfromNative`,不做整函数的状态转换**,需要摸堆的校验点各自用 `IN_VM` 局部转换(见下);②**functionEnter**(jniCheck.cpp:222-228): `in_critical()` 时警告 "Calling other JNI functions in the scope of Get/ReleasePrimitiveArrayCritical..."(critical 区内禁止调其他 JNI)+ `check_pending_exception`(:184-197: 有挂起异常→警告 "JNI call made with exception pending";该查未查→警告 "JNI call made without checking exceptions when required to");③**参数校验**(IN_VM 包裹,因为校验要摸堆,必须先转 VM 状态——校验函数内部还有 `ASSERT_OOPS_ALLOWED` 断言把关);④**回调真实函数** `UNCHECKED()->xxx` 后 `functionExit` 收尾。

**IN_VM 的讲究**(jniCheck.cpp:63-68): wrapper 收到调用时线程还在 **native 状态**(JNI 调用方;JNI_ENTRY_CHECKED 不像 JNI_ENTRY 那样自动转换),而校验函数要 `resolve` handle、读 Klass——必须在 VM 状态摸堆。`IN_VM` 就是 `ThreadInVMfromNative` 的局部包装(17-04 的通道): 进 VM → 校验 → 回 native → 调真实函数。错误报告同样分两态: VM 态直接 `ReportJNIFatalError`(hpp:36-40: 打印 "FATAL ERROR in native method: ..." + `print_jni_stack` + `os::abort(true)`);native 态用 `NativeReportJNIFatalError`(:146-150)包一层 IN_VM。

## 3. 查什么: 八个维度

| 维度 | 检查点 | 失败表现 |
|---|---|---|
| 线程存在性/类型 | JNI_ENTRY_CHECKED(:95-98) | fatal "Using JNIEnv in non-Java thread" |
| JNIEnv 归属线程 | :100-102 | fatal "Using JNIEnv in the wrong thread" |
| 引用有效性 | `validate_handle`(:443)→`validate_object`(:469-475) | fatal "Bad global or local ref passed to JNI" |
| methodID/类匹配 | `validate_jmethod_id`(:453-466)→`Method::checked_resolve_jmethod_id`(method.cpp:2191-2202: 空/NULL、`JNIMethodBlock::_free_method` 标记、loader 存活) | fatal "Wrong object class or methodID passed to JNI call" |
| 字段 ID 类型 | `checkStaticFieldID`(:256)/`checkInstanceFieldID`(:284): 静态/实例匹配 + 持有者类继承链 + 字段类型 | fatal "Non-static field ID passed to JNI"/"Static field ID passed to JNI"/类型不匹配 |
| 挂起异常 | `check_pending_exception`(:184-197) | 警告 "JNI call made with exception pending" |
| 本地引用泄漏 | `functionExit`(:239-252) | 警告 "JNI local refs: N, exceeds capacity: M" |
| Critical 区内调用 | `functionEnter`(:222-228) | 警告 "Calling other JNI functions in the scope of ..." |

**本地引用泄漏检查**值得展开——它就是 01 篇 `JNIHandleBlock::_planned_capacity` 字段的用途: `PushLocalFrame(capacity)`/`EnsureLocalCapacity(capacity)` 的 checked 版本成功后调用 `add_planned_handle_capacity`(jniCheck.cpp:202-207),把容量记为 `capacity + 当前存活数 + 32`;`functionExit` 时数一遍 `active_handles()` 的存活引用,超过计划容量就警告"JNI local refs: N, exceeds capacity: M"并重置计数(只警告一轮)。[实证:](planning/outlines/00-jvm-tools/materials/commands/27-jni-check-demo.txt) 循环 2000 次 `NewLocalRef` 不删除,`-Xcheck:jni` 下每 32 个触发一次警告(33/66/99...);**同样的代码不带 `-Xcheck:jni`,输出 0 条警告**——release 完全静默。挂起异常检查同理: `FindClass` 失败后不查异常继续调 JNI,checked 版当场打出 "WARNING in native method: JNI call made with exception pending" + JNI 栈,无 flag 时照跑不误。

## 4. 平台层: 函数表在哪、谁声明的

函数表本身的组织在 02 篇已拆(函数指针数组、启动时替换),这里补两块拼图: 结构 `JNINativeInterface_` 定义在 JDK 侧的 `jni.h:214`(`struct JNINativeInterface_ {`),**实例 `jni_NativeInterface` 在 jni.cpp:3528**(`struct JNINativeInterface_ jni_NativeInterface = { ... }`,几十行逐个赋 `jni_xxx` 指针,到 :3806 收尾);同名的 `jniExport.hpp` 另有用途——它不是 JNI 函数声明,而是 **JVMTI 接口的导出器**(`JniExportedInterface::GetExportedInterface`,按版本返回 JVMTI 接口,jniExport.hpp:28-38)。`jni_functions()` 是表的主要读入口(上面引过),`jni_functions_nocheck()` 绕过检查(jniCheck.cpp:2306 用它保存原始表)。每实例一张表,native 代码通过 `JNIEnv*->functions` 间接调用——**这正是 02 篇快路径与本文 checked 表能"换槽"的前提**: 调用方永远不直接引用函数地址,替换对调用方透明。

**jniPeriodicChecker 澄清**: 大纲说它"定期检查全局引用泄漏"——不对。它就是 20-02 任务清单里的 `JniPeriodicCheckerTask`(jniPeriodicChecker.cpp:33-37,间隔 10ms,`CheckJNICalls` 时才注册),干的事是 `os::run_periodic_checks`——Linux 上是 `DO_SIGNAL_CHECK` 一组**信号处理器完整性检查**(os_linux.cpp:5381-5394),防止用户程序覆盖 JVM 的关键信号处理器;**泄漏检查在 functionExit,不在周期任务里**。

## 核心悬念

jniCheck 拆完: 它不碰任何 JNI 函数,靠一张**平行函数表**整体替换(`jni_functions_check` 保存原始表、断言结构一致);每个 wrapper 四段式——入口查线程/env、functionEnter 查挂起异常与 critical 区、IN_VM 参数校验(引用/methodID/数组/字段类型)、回调后 functionExit 数本地引用;fatal 直接 "FATAL ERROR in native method" + JNI 栈 + abort,警告类的问题(异常/泄漏)只打 WARNING 继续跑。`-Xcheck:jni` 一开,02 篇的快路径立刻让位——检查优先于优化。而"函数表可以整体换掉"这个能力还有更野的用法: 工具接口(JVMTI)不只查,还**改**——`copy_jni_function_table` 在 safepoint 里原子替换槽,挂钩子、拦字段访问(02 篇的 `can_post_field_access` 条件就是它)。下一域换主角: 不是 C 调 Java,是 Java 自己调 JVM——`System.currentTimeMillis()` 这类入口怎么走。

> → [30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](01-jvm-entry-points.md)
