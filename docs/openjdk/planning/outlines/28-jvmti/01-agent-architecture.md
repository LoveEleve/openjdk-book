# 01. JVMTI Agent 怎么工作？— Agent 架构与事件系统

> 🔴 Deep | 2 KP 中的 Agent 基础
> 读者处境: `java -agentpath:libagent.so` 启动时 JVM 加载 agent。agent 注册事件回调→JVM 在触发点时调用 agent→agent 获得 JVMTI 环境(env)来操作 JVM。

### 1. "Agent 装载 — JvmtiEnv 创建"
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **`jvmtiEnv.hpp:40-120` 不存在(重要)**: jvmtiEnv.hpp 是构建产物(jvmtifiles/,jvmtiEnv.cpp:34 include);源码树真实=手写 **jvmtiEnvBase.hpp(655 行,类 JvmtiEnvBase 在 :57)+ jvmtiEnv.cpp(3733 行)**;`class JvmtiEnv` 由 **jvmtiHpp.xsl:54-63** 从 jvmti.xml(14993 行)构建期生成——私有构造/析构+create_a_jvmti+逐函数方法声明
> - **类代码块编造**: `_capabilities/_callbacks/_event_controller` 不存在;真实成员(jvmtiEnvBase.hpp:94-105)= `_jvmti_external`(函数表指针)/`_magic`(0x71EE 校验)/`_version`/`_next`(多 agent 链表,_head_environment jvmtiEnvBase.cpp:62)/`_event_callbacks`/`_tag_map`/**`_env_event_enable`(JvmtiEnvEventEnable)**/`_current_capabilities`/`_prohibited_capabilities`;无 _event_controller——事件控制器是 AllStatic
> - **"Agent_OnLoad 在 VM_init_globals 阶段调用(VMThread 尚未启动)" 错(重要)**: create_vm_init_agents(thread.cpp:4209-4229)在 create_vm 里**早于 vm_init_globals()**(:3800 vs :3809),注释 "Called very early -- before JavaThreads exist";phase=调用前 enter_onload_phase(:4213),全部 agent 后 enter_primordial_phase(:4228);全序列 ONLOAD=1/PRIMORDIAL=2/START=6(:4002+post_vm_start :4005)/LIVE=4(:4029+post_vm_initialized :4032)/DEAD=8(jvmtiExport.cpp:716)——非递增
> - **agent 侧调用语法 = 函数表**(`(*jvmti_env)->Func(jvmti_env,...)`,与 JNI 同构): jvmtiEnv 是指向 jvmtiInterface_1_(jvmti.h:1022-1828)的指针,`_jvmti_external.functions=&jvmti_Interface`(jvmtiEnvBase.cpp:217-221);表由 jvmtiEnter.xsl 生成,每函数一个 C wrapper(phase 检查→线程转换 UNATTACHED_THREAD/ThreadInVMfromNative→env magic 校验 JvmtiEnv_from_jvmti_env :544-556→函数级 required 能力检查 :452-468→调 C++ 方法)
> - **数字**: jvmti.xml **154 个函数/34 个标准事件/44 个 capabilityfield**(大纲"~100 bit 能力"错)

场景: JVM 启动 parse `-agentpath`→load .so→find `Agent_OnLoad`→create JvmtiEnv→pass to agent。

**JvmtiEnv 结构** (`jvmtiEnv.hpp:40-120 + jvmtiEnvBase.hpp:40-200`):
```cpp
class JvmtiEnv : public JvmtiEnvBase {
  jvmtiCapabilities _capabilities;  // 启用的能力集
  JvmtiEventCallbacks _callbacks;   // 事件回调函数指针
  JvmtiEventController* _event_controller;
};
```
- 源码: `jvmtiEnv.hpp:40-120` + `jvmtiEnvBase.hpp:40-200`
- 关键设计: 每个 agent 有一个 JvmtiEnv——多 agent 可共存(jvmtiEnv list)。Agent_OnLoad 在 VM_init_globals 阶段调用(VMThread 尚未启动)→agent 必须在 safepoint 前完成初始化
- [C++: `jvmtiCapabilities` 是 ~100 个 bit 的 bitset——agent 在 OnLoad 中声明需要的能力(can_tag_objects/can_generate_breakpoint_events/...)。JVM 据此决定是否开启相关数据收集(如开启 can_tag_objects→JVM 需要维护 tag map)。如果 agent 声明了 JVM 不支持的能力→返回错误]

### 2. "事件系统 — SetEventNotificationMode"
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/01 已按真实源码成文):
> - **"jvmtiImpl.cpp:514-560 事件分发" 错(重要)**: JvmtiImpl.cpp 1083 行;JvmtiDeferredEvent/Queue 在 **jvmtiImpl.hpp:454-549**(cpp:947-1064),且**只服务 4 类编译代码事件**(COMPILED_METHOD_LOAD/UNLOAD/DYNAMIC_CODE_GENERATED/CLASS_UNLOAD,类头注释 :443-453 "only used for posting compiled-method-load and unload events")——**MethodEntry 不用它**
> - **"MethodEntry 走 deferred 队列→ServiceThread 分发" 编造(最重要)**: MethodEntry 是**同步回调**——解释器 notify_method_entry(interp_masm_x86.cpp:1971-2004)检查 interp_only_mode→InterpreterRuntime::post_method_entry(interpreterRuntime.cpp:1273)→JvmtiExport::post_method_entry(jvmtiExport.cpp:1508-1544)遍历 JvmtiEnvThreadState 直接调回调(:1539)
> - **漏关键机制 interp_only_mode(重要)**: 6 个解释器事件(INTERP_EVENT_BITS jvmtiEventController.cpp:96-97: 单步/方法进出/帧弹出/字段读写)任一启用→VM_EnterInterpOnlyMode(:194-245)递增 JavaThread::_interp_only_mode 计数(thread.hpp:2017-2025)+**deopt 该线程全部编译帧**;compilationPolicy.cpp:421-427 对 interp_only 线程跳过编译/OSR——方法级事件的代价=目标线程全解释执行
> - **"set _event_enabled_bits[THREAD][METHOD_ENTRY]=1" 简化**: 真实=三级 bitset(env 级 JvmtiEnvEventEnable 的 user/callback/computed + env×thread 级 + 全局 _universal_global_event_enabled),`recompute_enabled()`(:571-657)整体重算,写 JvmtiExport::should_post_* 静态标志(:606-626);**真启用=用户开&回调存在&phase 允许**(recompute_env_enabled :412-446);能力检查在 SetEventNotificationMode 内部(jvmtiEnv.cpp:536 JvmtiUtil::has_event_capability,事件→能力表由 jvmtiEnter.xsl:168-193 生成)
> - **事件数**: 34 个标准事件+1 个扩展(ClassUnload),枚举 50-86(jvmti.h:397-430),全范围 49-86=38 槽装进 jlong

场景: agent 说 "我要接收 METHOD_ENTRY 事件"。JVM 在每个方法入口检查 event bit→如果设置→dispatch to agent。

**事件分发** (`jvmtiEventController.hpp:40-150 + jvmtiImpl.cpp:514-560`):
```
SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_METHOD_ENTRY):
  → set _event_enabled_bits[THREAD][METHOD_ENTRY] = 1
  → event is now globally enabled

Thread enters method:
  → check JvmtiExport::should_post_method_entry() 
    → check bitset: is EVENT_METHOD_ENTRY set for this thread?
    → if yes: JvmtiEventController::post_method_entry(thread, method)
      → allocate JvmtiDeferredEvent
      → add to thread's deferred event queue
      → ServiceThread later dispatches to agent callback
      → agent callback: void JNICALL MethodEntry(jvmtiEnv*, JNIEnv*, jthread, jmethodID)
```
- 源码: `jvmtiEventController.hpp:40-150` + `jvmtiImpl.cpp:dispatch`
- 关键设计: 事件分派是**延迟的**(deferred)——不在触发点直接调 agent callback(agent callback 可能做 heavy work→block thread)。用 per-thread JvmtiDeferredEventQueue 缓冲→ServiceThread 后来处理。减少对 application thread 的影响

### 3. "Capability — 两阶段"
> ⚠️ 写作期修正(2026-08-16, vol-02/28-jvmti/01 已按真实源码成文):
> - **"~100 个 bit" 错**: 真实 **44 个**(jvmti.xml capabilityfield 计数;jvmtiCapabilities 位域结构 jvmti.h:669-720;JVM 内 CAPA_SIZE=(44+7)/8=6 字节 jvmtiManageCapabilities.cpp:31)
> - **四集合**: always(24 个)/onload(15 个)/always_solo(2)/onload_solo(3)(jvmtiManageCapabilities.hpp:35-42+init :70-146)——"两阶段"精确含义=**ONLOAD 独占能力**(onload 集合)vs LIVE attach 少一批;启动 agent 声明的能力 add 时转入 always 永久保留(:247-250)
> - **"Phase 2 Live 才真正启用数据收集" 错位**: 能力只是位;副作用在 **update()(:292-364)→ 重算 JvmtiExport 全局标志**(set_can_post_method_entry :356/set_can_post_interpreter_events :332 等);真正工作量由事件使能+调用具体函数触发;add_capabilities 流程(:233-267)=potential 检查→acquired→onload 转 always→solo remaining 删除→update()
> - **两级能力检查**: 事件级=SetEventNotificationMode 内 has_event_capability(jvmtiEnv.cpp:536,MethodEntry 的 required 在 jvmti.xml:12308);函数级=wrapper 生成检查(jvmtiEnter.xsl:452-468,如 SuspendThread 要求 can_suspend)
> - **实证**: 无能力时 SetEventNotificationMode → 99(MUST_POSSESS_CAPABILITY);-XX:TraceJVMTI=ec/方法名+t(均 product,globals.hpp:1008;COMPILER2 release 也带 JVMTI_TRACE jvmtiTrace.hpp:31-38)可直接观察事件控制器重算与 interp_only 进入

**Capability 两阶段** (`jvmtiEnv.cpp:536-596`):
```
Phase 1: OnLoad — agent declares needed capabilities (via AddCapabilities)
Phase 2: Live — agent requests actual capability use. 
  If declared but not yet used→JVM doesn't enable data collection
  → Enable only when agent calls SetEventNotificationMode or GetTag
```
- 关键设计: 两阶段避免 JVM 过早做昂贵的数据收集——agent 可能声明了一大堆但只用一部分。实际开/关由事件 + 功能调用触发

---

### 核心悬念

**"JVMTI Agent 通过 JvmtiEnv+capability 声明需求→事件 system 通过 bitset+deferred queue 减少对 app 线程影响。"** — 下一篇: RedefineClasses。
> ⚠️ 悬念机制描述已过期(2026-08-16): "deferred queue 减少对 app 线程影响"不对——方法级事件是**同步回调+interp_only 按线程解释执行**;deferred 队列只用于编译代码 4 类事件。正确总结见正文"核心悬念"。

> → [02-redefine-classes.md](02-redefine-classes.md)
