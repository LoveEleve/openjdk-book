# 01. JVMTI Agent 怎么工作？— Agent 架构与事件系统

> **前置依赖**:[36-attach/02 — 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](openjdk/vol-02/36-attach/02-jdk-attach.md):agent 的加载链(`-agentpath`/attach/DCmd 三通道、`Agent_OnLoad`/`Agent_OnAttach` 两符号)已拆;[27-jni/02 — JNI GetIntField 200 cycles → 怎么做到 30 cycles?— JNI Fast Path](openjdk/vol-02/27-jni/02-jni-fast-path.md):函数表接口(`jni_NativeInterface` 结构)的先例;[39-runtime-monitoring/01 — JVM 的后台线程做什么?— ServiceThread](openjdk/vol-02/39-runtime-monitoring/01-service-thread.md):JVMTI 延迟事件的 ServiceThread 队列
> → **后续**:[02-redefine-classes — 怎么不重启 JVM 替换一个类的字节码?— RedefineClasses](02-redefine-classes.md)
> 关联域: 36-attach(加载通道)、27-jni(接口先例)、39-runtime-monitoring(延迟事件)、21-shared-runtime(异常发布)

## 一个"从外面看 JVM"的窗口

前面的域都是 JVM 内部机制。本篇换一个角度: **外部程序怎么合法地观察、修改一个运行中的 JVM**?JVMTI(Java Virtual Machine Tool Interface)就是答案——profiler、调试器、agent 都挂在它上面。`java -agentpath:libagent.so` 启动时,JVM 把 agent 库加载进来,agent 拿到一个"环境"(jvmtiEnv)来调用 JVMTI 函数,注册事件回调后 JVM 在触发点调用 agent。本篇拆三件事: **agent 与 env 怎么建立**(§1)、**能力(capability)怎么声明**(§2)、**事件怎么分派**(§3-§5)。

## 1. Agent 装载 — 每个 agent 一个 JvmtiEnv

### 1.1 加载点: create_vm_init_agents

`-agentpath:` 参数在启动早期就被处理。`Threads::create_vm_init_agents`(thread.cpp:4209-4229)遍历 agent 列表,`lookup_agent_on_load`(:4174,按 `AGENT_ONLOAD_SYMBOLS={"Agent_OnLoad"}` 在库符号里找入口)后直接调用:

```cpp
// thread.cpp:4206-4229(截取核心,逐字)
// Create agents for -agentlib:  -agentpath:  and converted -Xrun
// Invokes Agent_OnLoad
// Called very early -- before JavaThreads exist
void Threads::create_vm_init_agents() {
  extern struct JavaVM_ main_vm;
  AgentLibrary* agent;

  JvmtiExport::enter_onload_phase();

  for (agent = Arguments::agents(); agent != NULL; agent = agent->next()) {
    OnLoadEntry_t  on_load_entry = lookup_agent_on_load(agent);

    if (on_load_entry != NULL) {
      // Invoke the Agent_OnLoad function
      jint err = (*on_load_entry)(&main_vm, agent->options(), NULL);
      if (err != JNI_OK) {
        vm_exit_during_initialization("agent library failed to init", agent->name());
      }
    } else {
      vm_exit_during_initialization("Could not find Agent_OnLoad function in the agent library", agent->name());
    }
  }
  JvmtiExport::enter_primordial_phase();
}
```

两个关键点: ①**时机**——调用点在 `create_vm` 里**早于 `vm_init_globals()`**(thread.cpp:3800 vs :3809),注释明写 "Called very early -- before JavaThreads exist";②**phase 由 agent 装载驱动**——调用前 `enter_onload_phase()`,全部 agent 初始化完才 `enter_primordial_phase()`。所以 Agent_OnLoad 里的 `GetPhase` 返回 **ONLOAD**(JVM 侧 `JvmtiEnvBase::_phase` 静态量,由 `set_phase` 维护,jvmtiEnvBase.hpp:77-79)。

phase 全序列(create_vm 时间线): **ONLOAD**(agent 装载,thread.cpp:4213)→ **PRIMORDIAL**(agent 之后,:4228)→ **START**(initPhase2 后,`enter_start_phase` :4002 + `post_vm_start` :4005)→ **LIVE**(initPhase3 后,`enter_live_phase` :4029 + `post_vm_initialized` :4032)→ **DEAD**(退出前,`post_vm_death` 内 set_phase,jvmtiExport.cpp:716)。枚举值是历史遗产: ONLOAD=1/PRIMORDIAL=2/START=6/LIVE=4/DEAD=8(jvmti.xml:11213-11385)——**非递增排列**(LIVE=4 < START=6),通用大小比较不可靠;源码里只用它做"early phase"判定(`get_phase() <= JVMTI_PHASE_PRIMORDIAL`,jvmtiExport.cpp:998-1000)——只有对 PRIMORDIAL 的比较是安全的。

### 1.2 JvmtiEnv: 生成类的壳 + 手写的体

大纲说结构在 `jvmtiEnv.hpp:40-120`——**这个文件在源码树里不存在**(jvmtiEnv.cpp 头部的 include 是 `"jvmtifiles/jvmtiEnv.hpp"` 即构建产物)。真相分两层:

**壳是构建期生成的**: `class JvmtiEnv` 由 XSLT 模板 `jvmtiHpp.xsl` 从 jvmti.xml(14993 行,规范本体)生成:

```xml
// jvmtiHpp.xsl:54-63(截取核心,逐字)
class JvmtiEnv : public JvmtiEnvBase {

private:
    
    JvmtiEnv(jint version);
    ~JvmtiEnv();

public:

    static JvmtiEnv* create_a_jvmti(jint version);
```

生成的类只有: 私有构造/析构 + `create_a_jvmti` 工厂 + **逐一生成的接口方法声明**(jvmti.xml 定义 154 个 `<function>`,jvmtiHpp.xsl:85-95 每个生成一句 `jvmtiError MethodName(...)`)。所有状态都在手写的基类 `JvmtiEnvBase`(jvmtiEnvBase.hpp:57,655 行):

```cpp
// jvmtiEnvBase.hpp:94-105(截取核心,逐字)
  jvmtiEnv _jvmti_external;
  jint _magic;
  jint _version;  // version value passed to JNI GetEnv()
  JvmtiEnvBase* _next;
  bool _is_retransformable;
  const void *_env_local_storage;     // per env agent allocated data.
  jvmtiEventCallbacks _event_callbacks;
  jvmtiExtEventCallbacks _ext_event_callbacks;
  JvmtiTagMap* volatile _tag_map;
  JvmtiEnvEventEnable _env_event_enable;
  jvmtiCapabilities _current_capabilities;
  jvmtiCapabilities _prohibited_capabilities;
```

大纲代码块里的 `_capabilities/_callbacks/_event_controller` 三个成员都是**编造的**——真实成员: 能力是 `_current_capabilities`/`_prohibited_capabilities` 两个集合,回调是 `_event_callbacks`,事件使能是 `_env_event_enable`(JvmtiEnvEventEnable,§3),没有 `_event_controller` 指针——事件控制器是 AllStatic 类。`_jvmti_external` 是 agent 拿到的那个**不透明结构体**(函数表指针,见 §1.3),`_magic`(0x71EE)用于校验 env 有效,`_next` 串起**多 agent 链表**(头 `_head_environment`,jvmtiEnvBase.cpp:62;`JvmtiEnvIterator` 遍历,jvmtiEnvBase.hpp:318-337)。

### 1.3 agent 手里的 jvmtiEnv: 函数表接口(与 JNI 同构)

agent 的 `jvmtiEnv*` 不是 C++ 对象——和 JNI 一样是**函数表**: `jvmtiEnv` 是指向 `jvmtiInterface_1_` 的指针(JDK 的 jvmti.h:1022-1828,按编号槽位排列函数指针,空缺槽位标 RESERVED——8 个)。agent 里必须写 `(*jvmti_env)->Function(jvmti_env, ...)`(编译错误直接暴露真相: "`*jvmti` is a pointer; did you mean to use `->`?")。JvmtiEnvBase 构造时把这个结构挂在 `_jvmti_external` 上:

```cpp
// jvmtiEnvBase.cpp:217-221(截取核心,逐字)
#ifdef JVMTI_TRACE
  _jvmti_external.functions = TraceJVMTI != NULL ? &jvmtiTrace_Interface : &jvmti_Interface;
#else
  _jvmti_external.functions = &jvmti_Interface;
#endif
```

`jvmti_Interface`(struct jvmtiInterface_1_)也是构建期生成物——`jvmtiEnter.xsl` 从 jvmti.xml 为每个函数生成一个 **C wrapper**(`extern "C"` 的 `jvmti_XXX`),再填进表:

```
wrapper(jvmti_XXX) 的固定骨架(jvmtiEnter.xsl:471-599 生成):
  ① phase 检查     —— 函数声明的 phase 不符 → JVMTI_ERROR_WRONG_PHASE
  ② 线程转换       —— 非 Java 线程 → UNATTACHED_THREAD(部分 callbacksafe 函数
                      放宽到 Named 线程);否则 ThreadInVMfromNative + VM_ENTRY_BASE
                      (进 VM 状态)
  ③ env 校验       —— JvmtiEnv_from_jvmti_env(env)(jvmtiEnvBase.hpp:157-159:
                      指针减 _jvmti_external 偏移)+ _magic 检查 → INVALID_ENVIRONMENT
  ④ 能力检查       —— 函数声明的 required capability 缺失 → MUST_POSSESS_CAPABILITY
  ⑤ 调真正的 C++ 方法: err = jvmti_env->SetEventNotificationMode(...)
```

所以一次 agent 调用 = 表指针间接调用 → wrapper(状态转换/校验)→ C++ JvmtiEnv 方法。**每个 agent 拿到的 env 都指向同一个函数表**,但 wrapper 通过 `JvmtiEnv_from_jvmti_env(env)` 还原出各自对应的 JvmtiEnv 对象——这也是多 agent 共存的基础。

*关键设计: 接口与实现分离。函数表(接口)由规范 jvmti.xml 单一来源生成,保证 154 个函数的结构与规范同步;wrapper 把"进 VM 状态、校验 env/能力/phase"这些**每次调用都必做**的检查集中生成,手写代码只写机制。与 JNI 的 jni_NativeInterface(27-jni/02)同构,但 JVMTI 的 wrapper 带 phase/能力语义——因为 JVMTI 是"工具接口",它假设调用者可能在任何阶段、以任何能力状态来调用。*

## 2. Capability — 44 位的能力声明

### 2.1 结构: 44 位,位域声明 + 字节处理

大纲说"~100 个 bit 的 bitset"——实际 **44 个 capability**(jvmti.xml 里 `<capabilityfield>` 元素数,jvmtiHpp.xsl:49 生成的 `JVMTI_INTERNAL_CAPABILITY_COUNT` 就是它)。jvmtiCapabilities 是 JDK 侧 jvmti.h:669-720 里的**位域结构体**(每个能力一个 bit + 尾部填充位);JVM 内部按字节处理,`CAPA_SIZE = (44+7)/8 = 6` 字节(jvmtiManageCapabilities.cpp:31)。

### 2.2 四个集合 + 两阶段

`JvmtiManageCapabilities`(AllStatic,jvmtiManageCapabilities.hpp:31-83)维护**四个静态能力集合**:

```cpp
// jvmtiManageCapabilities.hpp:35-42(截取核心,逐字)
  // these four capabilities sets represent all potentially
  // available capabilities.  They are disjoint, covering
  // the four cases: (OnLoad vs OnLoad+live phase) X
  // (one environment vs any environment).
  static jvmtiCapabilities always_capabilities;
  static jvmtiCapabilities onload_capabilities;
  static jvmtiCapabilities always_solo_capabilities;
  static jvmtiCapabilities onload_solo_capabilities;
```

- **always_**: 任何 agent 任何阶段可拿(24 个: can_get_bytecodes/can_tag_objects/can_redefine_classes/can_generate_compiled_method_load_events 等,init 见 jvmtiManageCapabilities.cpp:70-101;其中 2 个 CPU 时间能力受 `os::is_thread_cpu_time_supported` 条件化);
- **onload_**: **只有 ONLOAD 阶段(启动 agent)可拿**,如 can_pop_frame/can_force_early_return/can_generate_single_step_events/can_generate_method_entry_events 等(:103-125)——这就是"两阶段"的精确含义: **LIVE 阶段 attach 的 agent 少一批能力**,而启动 agent 在 ONLOAD 声明的能力**永久保留**(add 时从 onload 集合转移到 always,见下);
- **solo 两个集合**: 全 VM 只有一个 agent 能拿(独占),如 can_suspend/can_generate_sampled_object_alloc_events/can_generate_field_access_events(:128-146)。

### 2.3 AddCapabilities 流程

```cpp
// jvmtiManageCapabilities.cpp:233-250(截取核心,逐字)
jvmtiError JvmtiManageCapabilities::add_capabilities(const jvmtiCapabilities *current,
                                                     const jvmtiCapabilities *prohibited,
                                                     const jvmtiCapabilities *desired,
                                                     jvmtiCapabilities *result) {
  // check that the capabilities being added are potential capabilities
  jvmtiCapabilities temp;
  get_potential_capabilities(current, prohibited, &temp);
  if (has_some(exclude(desired, &temp, &temp))) {
    return JVMTI_ERROR_NOT_AVAILABLE;
  }

  // add to the set of ever acquired capabilities
  either(&acquired_capabilities, desired, &acquired_capabilities);

  // onload capabilities that got added are now permanent - so, also remove from onload
  both(&onload_capabilities, desired, &temp);
  either(&always_capabilities, &temp, &always_capabilities);
  exclude(&onload_capabilities, &temp, &onload_capabilities);
```

四步: ①desired ⊆ potential 否则 `NOT_AVAILABLE`;②记入"曾经获得"集合;③**onload 集合的能力被获得后转入 always(永久化)**——LIVE 阶段就永远可见了;④solo 集合中被拿走的位从 remaining 集合删除(:257-259)。最后 `either(current, desired, result)` 并 `update()`。

**update()**(:292-364)是能力系统的"副作用出口": 根据当前所有 agent 的能力**重算 JvmtiExport 的全局标志**——`set_can_post_method_entry(avail.can_generate_method_entry_events)`(:356)、`set_can_post_interpreter_events`(:332,六个解释器事件取或)、`set_can_hotswap_or_post_breakpoint`(:333,redefine/retransform/breakpoint 取或)等。**能力本身只是位;它影响的全局开关是这些 JvmtiExport 标志**——解释器/编译代码的热点检查都读它们(§4)。

*关键设计: 能力声明与实际启用分离。agent 声明一堆能力,VM 不会为此开启任何数据收集;真正的工作量由"事件使能(§3)+ 调用具体函数"两级触发。反过来,能力集合的存在让 VM 可以静态回答"这个 agent 能不能干 X"——wrapper 第④步的检查就是用它。*

### 2.4 实证: 缺能力直接 99

[实证](materials/commands/28-jvmti-agent-demo.txt)(素材 A): agent 在 AddCapabilities **之前**调 `SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_METHOD_ENTRY, NULL)` → 返回 **99 (MUST_POSSESS_CAPABILITY)**。这里有两级能力检查: ①**事件级**——每个事件在 jvmti.xml 里声明自己的 required 能力(MethodEntry 要求 `can_generate_method_entry_events`,jvmti.xml:12308),生成成 `JvmtiUtil::has_event_capability`(jvmtiEnter.xsl:168-193 的事件→能力映射表),在 jvmtiEnv.cpp:536 检查——SetEventNotificationMode 的 99 正是这里;②**函数级**——带 `<required>` 的函数(如 SuspendThread 要求 can_suspend)在 wrapper 里检查(jvmtiEnter.xsl:452-468 `get_capabilities()->xxx == 0`)。AddCapabilities 后重试 → 0。能力位本身在 `GetCapabilities` 里可见(`current.can_generate_method_entry_events=1`)。

## 3. 事件系统 — bitset 与"真启用"重算

### 3.1 事件全集: 34 + 1,装进一个 jlong

jvmti.xml 定义 **34 个标准事件**(MethodEntry/MethodExit/Exception/ClassLoad...),枚举值 50-86 有跳号(jvmti.h:397-430,MIN=50=VM_INIT,MAX=86=SAMPLED_OBJECT_ALLOC),外加 1 个扩展事件 ClassUnload(值为 49,MIN-1)。**全范围 49-86 共 38 个槽,恰好装进一个 64 位 jlong**——`JvmtiEventEnabled` 就是 `jlong _enabled_bits`(jvmtiEventController.hpp:78-95),`bit_for(event) = 1 << (event - TOTAL_MIN_EVENT_TYPE_VAL)`(jvmtiEventController.inline.hpp:40-42)。整个使能状态是纯位运算,重算一次 64 位与/或即可。

### 3.2 SetEventNotificationMode → 三级使能

调用链(jvmtiEnv.cpp:521-585): 校验 event 合法 → **能力检查**(§2.4)→ 特殊事件钩子(CLASS_FILE_LOAD_HOOK 记 `record_class_file_load_hook_enabled` :540-542;SAMPLED_OBJECT_ALLOC 启停 `ThreadHeapSampler` :544-550)→ `JvmtiEventController::set_user_enabled`(event_thread 为 NULL 是全局,非 NULL 是线程级 :551/:581)。

使能状态分三级(每级都是 64 位 bitset):

| 级别 | 结构 | 语义 |
|---|---|---|
| env 级 | `JvmtiEnvEventEnable`(jvmtiEventController.hpp:151-171): `_event_user_enabled`/`_event_callback_enabled`/`_event_enabled` | 用户开关、回调存在性、**计算后真启用** |
| env×thread 级 | `JvmtiEnvThreadEventEnable`(:107-118)+`JvmtiThreadEventEnable`(:130-139) | 线程过滤事件的 per-thread 开关 |
| 全局 | `JvmtiEventController::_universal_global_event_enabled`(:194) | 所有 env×thread 的并集 |

"真启用"(computed enabled)= **用户开启 & 回调存在 & phase 允许**: `recompute_env_enabled`(jvmtiEventController.cpp:412-446)里 `now_enabled = callback_bits & user_bits`,再按 phase 过滤(PRIMORDIAL/ONLOAD 只留 EARLY_EVENT_BITS;DEAD 清零);线程级 `recompute_env_thread_enabled`(:452-499)再并上线程开关。任何变更(SetEventCallbacks/SetEventNotificationMode/线程启停)都触发 `recompute_enabled()`(:571-657):

```
recompute_enabled()(jvmtiEventController.cpp:571-657):
  for 每个 env:  recompute_env_enabled(env)         → env._event_enabled
  for 每个线程:  recompute_thread_enabled(state)     → 线程级 + interp_only(§4)
  有变化 → 重写 JvmtiExport::should_post_* 静态标志(jvmtiEventController.cpp:606-626)
        → 更新 _universal_global_event_enabled(:649)
```

**发布端的检查全部读 JvmtiExport 的静态 bool**(如 `should_post_class_load`),不碰任何 bitset——事件控制器把"算好的结论"烫成一个个全局标志,热点代码读一个字节。这是整个系统的性能核心。

*关键设计: "user 开了"≠"会发"。回调没设、phase 不允许、能力缺失,任何一个不满足都不发。重算是"整体快照"式的——任何状态变化全量重算三级 bitset,而不是增量维护;代价是 O(env×thread),收益是结论永远一致、且发布路径只有一个布尔判断。*

[实证](materials/commands/28-jvmti-agent-demo.txt)(素材 C): `-XX:TraceJVMTI=ec`(product flag,globals.hpp:1008;COMPILER2 构建的 release 也带 JVMTI_TRACE,jvmtiTrace.hpp:31-38)直接看到重算过程: `[*] # set event callbacks` → `[ALL] # user enabled event MethodEntry` → `[-] # Enabling event VMInit` + `recompute enabled - before 0 / after 2`(十六进制 bitset: VMInit 在 Live 前是唯一可发事件)→ `[-] # VM live` → 每个线程 `# Enabling event ...` + `# Entering interpreter only mode`。

## 4. 事件发布 — MethodEntry 的真相: 同步回调,不是延迟队列

### 4.1 大纲的"延迟分派"是错的

大纲说 MethodEntry "allocate JvmtiDeferredEvent → 加入 per-thread 队列 → ServiceThread 后来分发"。**错**——JvmtiDeferredEvent/Queue(jvmtiImpl.hpp:454-549)只服务 **4 类编译代码事件**(COMPILED_METHOD_LOAD/UNLOAD、DYNAMIC_CODE_GENERATED、CLASS_UNLOAD),类头注释明写:

```cpp
// jvmtiImpl.hpp:443-453(截取核心,逐字)
/**
 * When a thread (such as the compiler thread or VM thread) cannot post a
 * JVMTI event itself because the event needs to be posted from a Java
 * thread, then it can defer the event to the Service thread for posting.
 * The information needed to post the event is encapsulated into this class
 * and then enqueued onto the JvmtiDeferredEventQueue, where the Service
 * thread will pick it up and post it.
 *
 * This is currently only used for posting compiled-method-load and unload
 * events, which we don't want posted from the compiler thread.
 */
```

方法级事件(MethodEntry 等)**同步发布**——在触发线程上直接调 agent 回调。为什么能做到? 因为**解释器是天然的中断点**,而 JVM 用 interp_only 保证"想要方法事件的线程一定在解释执行"(§4.3)。

### 4.2 MethodEntry 全链

```
模板解释器方法入口: notify_method_entry()(interp_masm_x86.cpp:1971-2004)
  → 生成期检查 JvmtiExport::can_post_interpreter_events()(有 env 拿到解释器事件能力才生成)
  → 运行期: testl JavaThread::interp_only_mode_offset → 非 0 才 call_VM
  → InterpreterRuntime::post_method_entry(interpreterRuntime.cpp:1273-1275)
  → JvmtiExport::post_method_entry(jvmtiExport.cpp:1508-1544):
      遍历本线程的 JvmtiEnvThreadState(每 env 一个)
      → ets->is_enabled(METHOD_ENTRY) 才调
      → (*callback)(env->jvmti_external(), jem.jni_env(), jem.jni_thread(), jem.jni_methodID())
```

核心发布循环:

```cpp
// jvmtiExport.cpp:1525-1543(截取核心,逐字)
  if (state->is_enabled(JVMTI_EVENT_METHOD_ENTRY)) {
    JvmtiEnvThreadStateIterator it(state);
    for (JvmtiEnvThreadState* ets = it.first(); ets != NULL; ets = it.next(ets)) {
      if (ets->is_enabled(JVMTI_EVENT_METHOD_ENTRY)) {
        EVT_TRACE(JVMTI_EVENT_METHOD_ENTRY, ("[%s] Evt Method Entry sent %s.%s",
                                             JvmtiTrace::safe_get_thread_name(thread),
                                             (mh() == NULL) ? "NULL" : mh()->klass_name()->as_C_string(),
                                             (mh() == NULL) ? "NULL" : mh()->name()->as_C_string() ));

        JvmtiEnv *env = ets->get_env();
        JvmtiMethodEventMark jem(thread, mh);
        JvmtiJavaThreadEventTransition jet(thread);
        jvmtiEventMethodEntry callback = env->callbacks()->MethodEntry;
        if (callback != NULL) {
          (*callback)(env->jvmti_external(), jem.jni_env(), jem.jni_thread(), jem.jni_methodID());
        }
      }
    }
  }
```

回调前的两个 RAII 助手是"安全发布"的关键: `JvmtiJavaThreadEventTransition`(jvmtiExport.cpp:81-92)= ResourceMark + **ThreadToNativeFromVM**(VM→native 状态转换,回调里能自由调 JNI)+ HandleMark;`JvmtiEventMark`(:130-203)= **换一整块新的 JNIHandleBlock**(回调里产生的 local ref 隔离,返回时整体释放,:156-160/:172-179)+ **保存/恢复 JVM 异常状态**(:182-187)+ `make_walkable`(:163 帧锚可走,GC 时栈可遍历)。**回调从 jvmti_env 外部进来,又带着 JNIEnv 出去——JNI 句柄与异常语义都得是干净的**,这两层 RAII 就是干这个的。

### 4.3 interp_only_mode: 方法级事件的代价

编译代码(方法入口是机器码)无法"顺路"发方法事件,所以机制反过来: **想要方法级事件的线程,被按进解释器**。`recompute_thread_enabled` 判定(jvmtiEventController.cpp:96-97/:539-549):

```cpp
// jvmtiEventController.cpp:96-97 + 539-549(截取核心,逐字)
static const jlong  INTERP_EVENT_BITS =  SINGLE_STEP_BIT | METHOD_ENTRY_BIT | METHOD_EXIT_BIT |
                                FRAME_POP_BIT | FIELD_ACCESS_BIT | FIELD_MODIFICATION_BIT;
  // compute interp_only mode
  bool should_be_interp = (any_env_enabled & INTERP_EVENT_BITS) != 0 || has_frame_pops;
  bool is_now_interp = state->is_interp_only_mode();

  if (should_be_interp != is_now_interp) {
    if (should_be_interp) {
      enter_interp_only_mode(state);
    } else {
      leave_interp_only_mode(state);
    }
  }
```

6 个解释器事件(单步/方法进出/帧弹出/字段读写)任一个在该线程的任一 env 里被启用 → `enter_interp_only_mode` → **VM_EnterInterpOnlyMode VM 操作**(jvmtiEventController.cpp:194-245): 递增 `JavaThread::_interp_only_mode` 计数(thread.hpp:2017-2025)+ **把该线程栈上所有编译帧 mark_for_deoptimization 并执行 VM_Deoptimize**(:224-243)。后续该线程: 解释器不派发编译代码、编译策略跳过 OSR(compilationPolicy.cpp:421-427 注释 "If certain JVMTI events (e.g. frame pop event) are requested then the thread is forced to remain in interpreted code...skipping OSR compiles")。

*关键设计: 以"线程降速"换"事件完备"。方法级事件只能在解释器里发,与其让编译代码到处留事件钩子(每个方法入口一条分支,所有线程都付钱),不如只让**想要的线程**回解释器——其他线程零成本。interp_only 是计数而非布尔,因为事件开关可以嵌套(多个 env/多类事件)。*

[实证](materials/commands/28-jvmti-agent-demo.txt)(素材 B/D): ①`-XX:TraceJVMTI=MethodEntry+t` 看到触发点 `[main] Trg Method Entry triggered java/lang/System.getProperty`——EVT_TRIG_TRACE 在 jvmtiExport.cpp:1512-1515;②`ec` 跟踪看到 `[main] # Entering interpreter only mode`(0.026s,紧跟在 "Enabling event MethodEntry" 之后)且**每个 JavaThread 都进**(全局启用→每线程都算);③编译对照: 带 agent 时 `Jvmtidemo::fib` **零编译事件**(无 agent 时 C1→C2 两级+OSR),总编译事件 4 vs 17——interp_only 线程不派发编译代码的直接证据。

## 5. 延迟事件 — 编译代码事件的"回头补发"

那延迟队列(§4.1)什么时候用? 两类场景:

1. **编译器线程/VM 线程发事件**: nmethod 编译完成入 CodeCache 时,`nmethod::post_compiled_method_load`(nmethod.cpp:1418-1429)按调用线程分流——**没有 JavaThread 上下文(编译线程等)就把事件塞进 `ServiceThread::_jvmti_service_queue`**(serviceThread.cpp:43 `JvmtiDeferredEventQueue ServiceThread::_jvmti_service_queue`;enqueue :145-153 锁 Service_lock 并 notify),ServiceThread 在事件循环里检测队列非空→锁内 dequeue、锁外 `_jvmti_event->post()`(serviceThread.cpp:105-128;JvmtiDeferredEvent::post 在 jvmtiImpl.cpp:947-992)——**这就是 39-01 篇 ServiceThread 的 JVMTI 条件**;
2. **GenerateEvents 补发**: agent 中途 attach 错过事件,调 GenerateEvents 要 JVM 立刻补发已编译方法——`generate_compiled_method_load_events`(jvmtiCodeBlobEvents.cpp:224-250)在 CodeCache_lock 内收集事件、**锁外**(:242-248 注释 "Now post all the events outside the CodeCache_lock")用**调用线程自己的** per-thread 队列(`JvmtiThreadState::_jvmti_event_queue`,jvmtiThreadState.hpp:82;enqueue_event :419-425,post_events :427-430)同步补发。

两个队列的共性: **事件发生时不能安全调回调(持锁/非 Java 线程)→ 先入队,等"能安全发"的地方再发**。队列里的 nmethod 由 oops_do/nmethods_do 保活(jvmtiImpl.hpp:503-506,队列持有期间不被卸载)。

## 核心悬念

外部观察者进场的通道已通: **装载**(create_vm_init_agents 在 vm_init_globals 前、phase 由它驱动)、**env**(生成类壳+手写 JvmtiEnvBase,函数表接口与 JNI 同构,多 agent 链表)、**能力**(44 位、四集合、ONLOAD 独占能力两阶段语义、AddCapabilities→update 重算全局标志)、**事件**(34+1 个事件装进 jlong、三级使能快照重算、真启用=用户&回调&phase)、**发布**(方法级事件同步回调+interp_only 保证解释执行;编译事件延迟到 ServiceThread/per-thread 队列补发)。——但这里有个未解的转折: **agent 最大胆的能力是改类**。can_redefine_classes 声明后,怎么在运行中替换一个类的字节码?旧方法还在栈上、编译代码还在 CodeCache,怎么办?下一篇: RedefineClasses。

> → [02-redefine-classes — 怎么不重启 JVM 替换一个类的字节码?— RedefineClasses](02-redefine-classes.md)
