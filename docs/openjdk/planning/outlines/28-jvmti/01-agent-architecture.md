# 01. JVMTI Agent 怎么工作？— Agent 架构与事件系统

> 🔴 Deep | 2 KP 中的 Agent 基础
> 读者处境: `java -agentpath:libagent.so` 启动时 JVM 加载 agent。agent 注册事件回调→JVM 在触发点时调用 agent→agent 获得 JVMTI 环境(env)来操作 JVM。

### 1. "Agent 装载 — JvmtiEnv 创建"

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

场景: agent 说 "我要接收 METHOD_ENTRY 事件"。JVM 在每个方法入口检查 event bit→如果设置→dispatch to agent。

**事件分发** (`jvmtiEventController.hpp:40-150 + jvmtiImpl.cpp:事件dispatch`):
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

**Capability 两阶段** (`jvmtiEnv.cpp:capability handling`):
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

> → [02-redefine-classes.md](02-redefine-classes.md)
