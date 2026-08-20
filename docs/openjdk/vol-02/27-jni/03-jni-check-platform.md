# 03. JNI 调用参数错了——JVM 怎么检测?— JNI Check + 平台层

> **前置依赖**:[27-jni/01 — jobject 在 JVM 内部怎么存的?— JNI Handle 系统](openjdk/vol-02/27-jni/01-handle-system.md):JNIHandleBlock 的 `_planned_capacity` 字段在这里埋了伏笔;[27-jni/02 — JNI GetIntField 正常 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](openjdk/vol-02/27-jni/02-jni-fast-path.md):函数表替换机制与 `CheckJNICalls` 条件;[20-vm-operations/02 — 谁在后台周期性干活?— PeriodicTask、WatcherThread 与启动序列](openjdk/vol-02/20-vm-operations/02-background-init.md):JniPeriodicCheckerTask 已在后台任务清单里讲过
> → **后续**:[30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md)
> 关联域: 28-jvmti(工具接口用同一张函数表)、42-core-native(JNI 系统另一侧)、04-logging

JNI 规范里,传 NULL 给该传引用的函数、跨线程用 JNIEnv、带着异常继续调 JNI——全是**未定义行为**: release 版 JVM 不检查,错了就错着(可能崩、可能静默错值)。但开发期需要另一副眼睛:`-Xcheck:jni` 打开后,JVM 给**每一个 JNI 调用**加装检查,错了当场警告甚至 abort。本篇要回答的核心问题:

1. `-Xcheck:jni` 怎么做到"插进所有调用"——是改每个函数,还是换方式接管?
2. 它查什么?
3. 为什么 02 篇的快路径在检查模式下必须失效?

答案会反复落到一句话:**`-Xcheck:jni` 不修改任何 JNI 函数,而是用一张平行函数表整体替换——`jni_functions()` 返回 checked 表,`env->functions` 的 200 多个槽全指向 checked_jni_xxx wrapper。release 下 `CheckJNICalls=false`,函数表原样不动,零开销。**

---

## 1. 开场困惑——"JNI 错了怎么检查"

JNI 是 C 代码和 JVM 之间的桥,而 C 没有类型系统的运行时保护。`env->GetIntField(env, wrong_type_obj, fieldID)` 这种调用,传错对象类型、传错字段 ID、传 NULL,都是开发期最常见的错误。

问题在 **错误的一侧没有反馈**: release 版 JVM 直接按参数读内存,参数错了就走到错误地址——可能 SIGSEGV,可能读到错值不声不响。对开发来说,最可怕的是第二种:不错崩,但错值已经污染了后续逻辑。

JVM 因此提供了 `-Xcheck:jni` 开发期模式。它不做静态分析(那是编译期的事),而是在**运行时**给每个 JNI 调用加检查。核心设计决策是:检查逻辑以什么方式进入每个 JNI 函数?

---

## 2. 两个朴素方案为什么都不对

### 方案一:编译期静态检查

既然要检查参数,那在 native 代码编译时检查不就行了?比如检查 `GetIntField` 的参数类型。

但 JNI 的参数正确性是**运行时**状态决定的:对象是哪个类的实例、fieldID 是否指向该类的字段、handle 是否还有效——这些必须在"对象存在、类已加载"的运行时才能确认。C 编译期连堆里的对象是哪个类的都不知道,静态检查无从谈起。

### 方案二:在每个 JNI 函数里手动加 if 分支

另一个朴素思路:在每个函数入口手动加 `if (CheckJNICalls) { validations... }`。但这有两个问题: ①污染每个函数的实现,几十个函数每个都要改;②release 下这个 if 虽然在,但分支判断仍会执行——虽然一次预测好的分支几乎零成本,但函数体被塞进一坨条件代码,与 JNI 函数"薄、快"的定位矛盾。

正确方案是:**把检查逻辑整个放在一张平行函数表里,启动时一次性决定用哪张。** release 下 `env->functions` 直接指向原始表,检查代码永远不执行。

---

## 3. 整表替换——不是宏,是平行函数表

### jni_functions() 的读入口

`jni_functions()`(jni.cpp:3875-3881)是 JNI 函数表的读入口:

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

`CheckJNICalls` 为真时返回 checked 表,否则返回原始表。**一张函数表,两个出口**——这就是"整体更换"的机制主语。

### jni_functions_check() 的三件事

`jni_functions_check()`(jniCheck.cpp:2304-2323)干三件事:

1. 把原始函数表存进 `unchecked_jni_NativeInterface`(:2306),下面的 wrapper 通过 `UNCHECKED()` 回调它;
2. **断言 checked 表与原始表结构一致**(:2311-2314,"Mismatched JNINativeInterface tables, check for new entries")——JNI 规范加了新函数而 checked 表漏建,启动时直接暴露;
3. 返回 checked 表。

### 等价于一个编译开关的分层

`CheckJNICalls` 是 product flag(globals.hpp:913,默认 false),由 `-Xcheck:jni` 置位(arguments.cpp:2863-2868)。注意 `INCLUDE_JNI_CHECK`:如果这个 VM 编译时就没带检查支持,`-Xcheck:jni` 会警告"JNI CHECKING is not supported in this VM"。

所以完整图景是三层:

- **release**: `CheckJNICalls=false`,`env->functions` 指向 `&jni_NativeInterface`(200 多个普通函数),零开销;
- **检查开启**: `CheckJNICalls=true`,`env->functions` 全部槽指向 checked_jni_xxx wrapper;
- **编译禁用**: `INCLUDE_JNI_CHECK=0`,连 checked 表都不存在,命令行直接警告。

这也解释了 02 篇 `quicken_jni_functions` 五条件里赫然有 `!CheckJNICalls`:快路径 stub 与 checked wrapper 不可能同时在一个函数表槽上——**检查优先于优化**。

---

## 4. wrapper 四段——检查、回调、收尾

### 骨架

每个 checked 函数都是同一个模板(`JNI_ENTRY_CHECKED` 宏,jniCheck.cpp:91-104 + 函数体)。以 `checked_jni_DefineClass`(jniCheck.cpp:545-558)为例:

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

四段结构:

1. **入口检查**(宏内): `Thread::current_or_null()` 为空或不是 Java 线程 → fatal "Using JNIEnv in non-Java thread" + abort;`env` 与 `thr->jni_environment()` 不符 → fatal "Using JNIEnv in the wrong thread";然后 `VM_ENTRY_BASE` 建立 handle 标记。注释(:82-84)说明为什么用 `JNI_ENTRY_CHECKED` 而不是 QUICK/LEAF:出错时要能创建 handle 打印栈。**注意与普通 `JNI_ENTRY` 的区别: 宏里没有 `ThreadInVMfromNative`,不做整函数的状态转换**——需要摸堆的校验点各自用 `IN_VM` 局部转换。
2. **functionEnter**(jniCheck.cpp:222-228): `in_critical()` 时警告 "Calling other JNI functions in the scope of Get/ReleasePrimitiveArrayCritical..."(critical 区内禁止调其他 JNI)+ `check_pending_exception`(:184-197: 有挂起异常→警告 "JNI call made with exception pending";该查未查→警告 "JNI call made without checking exceptions when required to")。
3. **参数校验**(IN_VM 包裹): 校验要摸堆,必须先转 VM 状态。
4. **回调真实函数** `UNCHECKED()->xxx` 后 `functionExit` 收尾。

### IN_VM 的讲究

`IN_VM`(jniCheck.cpp:63-68)是本节的关键细节。wrapper 收到调用时线程还在 **native 状态**(JNI 调用方;`JNI_ENTRY_CHECKED` 不像 `JNI_ENTRY` 那样自动转换),而校验函数要 `resolve` handle、读 Klass——必须在 VM 状态摸堆。`IN_VM` 就是 `ThreadInVMfromNative` 的局部包装: 进 VM → 校验 → 回 native → 调真实函数。

错误报告同样分两态: VM 态直接 `ReportJNIFatalError`(打印 "FATAL ERROR in native method: ..." + `print_jni_stack` + `os::abort(true)`);native 态用 `NativeReportJNIFatalError` 包一层 IN_VM。

### 本地引用泄漏检查

`functionExit`(jniCheck.cpp:239-252)数一遍 `active_handles()` 的存活引用,超过计划容量就警告。这个"计划容量"正是 01 篇 `JNIHandleBlock::_planned_capacity` 字段的用途: `PushLocalFrame(capacity)`/`EnsureLocalCapacity(capacity)` 的 checked 版本成功后调用 `add_planned_handle_capacity`(jniCheck.cpp:202-207),把容量记为 `capacity + 当前存活数 + 32`。超过就警告 "JNI local refs: N, exceeds capacity: M" 并重置计数(只警告一轮)。

---

## 5. 平台层——函数表在哪、谁声明的

函数表本身的组织在 02 篇已拆(函数指针数组、启动时替换),这里补两块拼图:

**结构声明**: `JNINativeInterface_` 定义在 JDK 侧的 `jni.h:214`(`struct JNINativeInterface_ {`);**实例** `jni_NativeInterface` 在 jni.cpp:3528(`struct JNINativeInterface_ jni_NativeInterface = { ... }`,几十行逐个赋 `jni_xxx` 指针,最后一项 `jni_GetModule` 在 :3810,闭合 `};` 在 :3811)。

**同名文件 jniExport.hpp 澄清**: 它不是 JNI 函数声明,而是 **JVMTI 接口的导出器**(`JniExportedInterface::GetExportedInterface`,按版本返回 JVMTI 接口,jniExport.hpp:28-38)。

**jniPeriodicChecker 澄清**: 它不是查 JNI 引用/函数是否泄漏的周期任务。它就是 20-02 任务清单里的 `JniPeriodicCheckerTask`(jniPeriodicChecker.cpp:33-37,间隔 10ms,`CheckJNICalls` 时才注册),干的事是 `os::run_periodic_checks`——Linux 上是 `DO_SIGNAL_CHECK` 一组**信号处理器完整性检查**(os_linux.cpp:5381-5394),防止用户程序覆盖 JVM 的关键信号处理器。**真正的检查都在 wrapper 的前后,不在周期任务里。**

---

## 6. 误解澄清与收网

1. **检查是否修改了 JNI 函数本身?** 否。`-Xcheck:jni` 用一张平行函数表整体替换 `env->functions`,`jni_xxx` 原始函数一个字不改。
2. **为什么快路径在检查模式下失效?** 因为函数表槽只有一个。`quicken_jni_functions` 五条件含 `!CheckJNICalls`:快路径 stub 和 checked wrapper 不可能并存,检查打开时快路径让位。
3. **检查是 fatal 还是 warning?** 两种都有。引用无效、methodID/fieldID 错误、跨线程用 JNIEnv → "FATAL ERROR in native method" + JNI 栈 + abort;挂起异常、critical 区调用、本地引用超量 → 只打 warning 继续跑。
4. **jniPeriodicChecker 是否检查 JNI 泄漏?** 不是。它是 `os::run_periodic_checks` 的信号处理器完整性检查,防用户程序覆盖关键信号处理器。
5. **函数表替换是否影响性能?** release 下零影响(`CheckJNICalls=false` 时检查代码一字节都不执行);检查开启时每个 JNI 调用多一套 wrapper 的前后检查——性能让位于正确性,所以 `-Xcheck:jni` 只用于开发。

把这一篇压成三句话:

- **`-Xcheck:jni` 是整表替换,不是改函数**:`jni_functions()` 按 `CheckJNICalls` 返回 checked 表或原始表,release 零开销。
- **每个 wrapper 四段式**:入口查线程/env,functionEnter 查挂起异常与 critical 区,IN_VM 校验参数,functionExit 数本地引用。
- **错误分两档**:致命问题 "FATAL ERROR in native method" + abort,可恢复问题只警告继续跑。

jniCheck 机制的核心是"函数表可以整体换掉"这个能力。它不只是被检查器用来**查**,还被工具接口(JVMTI)用来**改**——挂钩子、拦字段访问。下一域换主角: 不是 C 调 Java,是 Java 自己调 JVM——`System.currentTimeMillis()` 这类入口怎么走。

> → [30-jvm-entry/01 — System.currentTimeMillis() 怎么进入 JVM?— JVM Entry Points](openjdk/vol-02/30-jvm-entry/01-jvm-entry-points.md)