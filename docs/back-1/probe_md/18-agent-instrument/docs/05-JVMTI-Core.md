# 05-JVMTI-Core — JVMTI 核心基础设施

> **Phase**: 18-agent-instrument | **前置文档**: 01-Agent-Loading, 02-ClassFileLoadHook, 03-Attach-API | **配套文档**: 04-Redefine-Classes | **后续依赖**: 06-JDWP-Transport-Init, 07-JDWP-Commands-Events | **阅读收益**: 理解 JVMTI 300+ 函数如何通过代码生成 + 双层门控管理、事件系统零开销热路径、对象标记系统 GC 安全性

---

## §〇 生产场景 — JVMTI_ERROR_WRONG_PHASE 错误诊断

**症状**：Agent 调用 JVMTI 函数返回 `JVMTI_ERROR_WRONG_PHASE (112)`，或 `SetEventNotificationMode` 成功但事件从不触发。

```c
// Agent 代码：尝试在 Primordial phase 调用需要 Live phase 的函数
jvmtiError err = (*jvmti)->GetLoadedClasses(jvmti, &class_count, &classes);
// 返回 JVMTI_ERROR_WRONG_PHASE — GetLoadedClasses 只能在 Live phase 调用
```

**根因**：JVMTI 有严格的 phase 模型和函数可用性约束。每个 JVMTI 函数都有 `capabilities` 和 `phase` 两个维度的门控。事件系统通过 `JvmtiEventControllerPrivate::recompute_enabled` (jvmtiEventController.cpp:571) 全局计算"哪些事件真正应该发送"——涉及 3 层合并（per-env × per-thread × global）。热路径只需一次 bool 读取（~0.3ns）。

**三步诊断**：

```bash
# 1. 检查当前 JVMTI phase
# 在 agent 代码中: jvmti->GetPhase(&phase)
# Live=4, OnLoad=1, Primordial=2, Start=6

# 2. 查看事件是否被正确启用
jcmd <pid> VM.jvmti_events  # 列出所有 JVMTI 事件状态

# 3. GDB 断点验证事件控制器
gdb -ex "break jvmtiEventController.cpp:571" \
    -ex "run" \
    -ex "print any_env_thread_enabled" \
    --args java -agentlib:myagent
```

**反事实**：如果 JVMTI 没有 phase 模型——agent 可以在任何阶段调用任何函数 → Agent_OnLoad 中调用 GetLoadedClasses → 类加载器尚未初始化 → 返回空列表 → agent 以为"没有类被加载" → 但之后数百个类被加载 → agent 完全不知道。Phase 模型强制了"什么阶段能做什么"的契约，避免了 agent 在错误时机获取错误状态。

---

## §一 JVMTI 核心基础设施源码走读

### 1.1 JvmtiEnvBase — 环境基类

JvmtiEnvBase (jvmtiEnvBase.hpp:57) 是 JVMTI 基础设施的根类，每个 agent 连接创建一个实例。

```
jvmtiEnvBase.hpp:57
class JvmtiEnvBase : public CHeapObj<mtInternal> {
```

**核心成员** (jvmtiEnvBase.hpp:94-109)：

| 成员 | 类型 | 作用 |
|------|------|------|
| `_jvmti_external` | `jvmtiEnv` | 暴露给 agent 的外部接口 |
| `_next` | `JvmtiEnvBase*` | 环境链表指针 |
| `_is_retransformable` | `bool` | agent 是否支持 retransform |
| `_event_callbacks` | `jvmtiEventCallbacks` | 事件回调函数表 |
| `_tag_map` | `JvmtiTagMap* volatile` | 对象标记映射（延迟分配）|
| `_env_event_enable` | `JvmtiEnvEventEnable` | 环境级事件启用状态 |
| `_current_capabilities` | `jvmtiCapabilities` | 当前获取的能力集 |
| `_prohibited_capabilities` | `jvmtiCapabilities` | 禁止的能力集 |

**全局状态** (jvmtiEnvBase.hpp:62-67)：JvmtiEnvBase 持有静态全局变量——`_head_environment` 是所有 JvmtiEnv 链表的头节点（jvmtiEnvBase.hpp:62），`_phase` 跟踪 VM 的 JVMTI phase（jvmtiEnvBase.hpp:66）。`get_phase()` (jvmtiEnvBase.hpp:77) 是内联静态方法，返回当前 phase 值。

**链表管理** (jvmtiEnvBase.hpp:134-140)：`next_environment()` 和 `head_environment()` 提供环境遍历的基础设施。每个 env 创建时通过构造函数插入链表头部，因此遍历顺序 = env 创建顺序（即 `-agentlib` 命令行顺序）。

### 1.2 JvmtiEnv — 300+ 函数的 XSLT 代码生成

JvmtiEnv 不是手工编写的——它是从 JVMTI 规范 XML 通过 XSLT 生成的。

```
jvmtiEnv.cpp:83
JvmtiEnv::JvmtiEnv(jint version) : JvmtiEnvBase(version) {
```

**生成流程**：JVMTI 规范定义在 `jvmti.xml` 中，每个函数的 phase 约束、capability 要求、参数类型都在 XML 中声明。XSLT 处理器 `jvmtiEnter.xsl` (jvmtiEnter.xsl:471-610) 为每个 function 生成：

1. **函数签名** (jvmtiEnter.xsl:473-478)：从 XML `functionid` 和 `parameters` 生成
2. **Phase 检查** (jvmtiEnter.xsl:488-541)：根据 `@phase` 属性生成对应的 phase 门控
3. **Environment 有效性检查** (jvmtiEnter.xsl:543-556)：验证 `JvmtiEnv_from_jvmti_env(env)->is_valid()`
4. **Capability 检查** (jvmtiEnter.xsl:558)：注入 `capabilities/required` 检查
5. **Thread transition** (jvmtiEnter.xsl:562-604)：根据 `@callbacksafe` 决定是否需要线程转换

以 `live` phase 函数为例（jvmtiEnter.xsl:489-506）：

```xml
<!-- jvmtiEnter.xsl:489 -->
<xsl:when test="count(@phase)=0 or contains(@phase,'live')">
  if(!JvmtiEnv::is_vm_live()) {
    return JVMTI_ERROR_WRONG_PHASE;
  }
  Thread* this_thread = Thread::current_or_null();
```

**Phase 值定义** (jvmtiEnvBase.hpp:71-75)：`ONLOAD=1 < PRIMORDIAL=2 < LIVE=4 < START=6 < DEAD=8`。Phase 是递增的生命周期——越靠后的阶段，agent 可以调用的函数越多。

### 1.3 recompute_enabled — 事件启用全局计算引擎

这是 JVMTI 事件系统最核心的函数。当任何 agent 调用 `SetEventNotificationMode` 或注册/注销事件回调时，触发全局重新计算。

```
jvmtiEventController.cpp:571
void JvmtiEventControllerPrivate::recompute_enabled() {
  assert(Threads::number_of_threads() == 0 || JvmtiThreadState_lock->is_locked(), ...);
```

**三层合并流程** (jvmtiEventController.cpp:571-650)：

**第 1 层：Per-Env 合并** (jvmtiEventController.cpp:583-586)：

```cpp
// jvmtiEventController.cpp:583
JvmtiEnvIterator it;
for (JvmtiEnvBase* env = it.first(); env != NULL; env = it.next(env)) {
  any_env_thread_enabled |= recompute_env_enabled(env);
}
```

遍历所有 JvmtiEnv，对每个 env 调用 `recompute_env_enabled`——它合并该 env 的全局事件启用 (`_event_user_enabled`) 和回调存在性 (`_event_callback_enabled`)，产生 `_event_enabled`。结果通过 `|=` 累加到 `any_env_thread_enabled`。

**第 2 层：Thread State 创建** (jvmtiEventController.cpp:590-596)：

```cpp
// jvmtiEventController.cpp:590
if ((any_env_thread_enabled & THREAD_FILTERED_EVENT_BITS) != 0 &&
    (was_any_env_thread_enabled & THREAD_FILTERED_EVENT_BITS) == 0) {
  for (JavaThreadIteratorWithHandle jtiwh; JavaThread *tp = jtiwh.next(); ) {
    JvmtiThreadState::state_for_while_locked(tp);
  }
}
```

如果有线程过滤事件首次被启用，为所有已存在的 Java 线程创建 `JvmtiThreadState`。这是延迟创建策略——线程状态仅在需要时才分配。

**第 3 层：Per-Thread 合并** (jvmtiEventController.cpp:599-601)：

```cpp
// jvmtiEventController.cpp:599
for (JvmtiThreadState *state = JvmtiThreadState::first();
     state != NULL; state = state->next()) {
  any_env_thread_enabled |= recompute_thread_enabled(state);
}
```

遍历所有 JvmtiThreadState，对每个线程调用 `recompute_thread_enabled`——它合并该线程上所有 env 的 `JvmtiEnvThreadEventEnable._event_user_enabled`，产生线程级的 `_thread_event_enable`。

**Delta 写入布尔门控** (jvmtiEventController.cpp:604-649)：

```cpp
// jvmtiEventController.cpp:604
jlong delta = any_env_thread_enabled ^ was_any_env_thread_enabled;
if (delta != 0) {
  JvmtiExport::set_should_post_class_file_load_hook(
    (any_env_thread_enabled & CLASS_FILE_LOAD_HOOK_BIT) != 0);
  // ... 20+ 个类似的门控设置
}
```

只对翻转的位更新——未变化的事件不触碰。每个事件位对应一个 `JvmtiExport::_should_post_*` 静态布尔变量。热路径只需一次 bool 读取（~0.3ns），无需任何遍历或位运算。

### 1.4 事件启用位图类体系

JvmtiEventController 定义了 4 层位图类 (jvmtiEventController.hpp:78-171)：

| 类 | 位置 | 作用 |
|----|------|------|
| **JvmtiEventEnabled** | :78 | 64-bit 位掩码，每个位对应一个事件 |
| **JvmtiEnvThreadEventEnable** | :107 | 每 env×线程 的事件启用 |
| **JvmtiThreadEventEnable** | :130 | 每线程的事件启用（跨 env 合并） |
| **JvmtiEnvEventEnable** | :151 | 每 env 的事件启用（含 callback 标志） |

**JvmtiEventEnabled** (jvmtiEventController.hpp:78-95)：核心位图，`_enabled_bits` 是 `jlong`（64位）。`bit_for(event_type)` 将事件类型映射到位位置：

```
CLASS_FILE_LOAD_HOOK_BIT = ((jlong)1 << (EVENT_CFLH - TOTAL_MIN_EVENT_TYPE_VAL))
```

**JvmtiEnvThreadEventEnable** (jvmtiEventController.hpp:107-118)：持有两个位图——`_event_user_enabled`（agent 显式设置的）和 `_event_enabled`（合并后的真正启用）。这个区分允许在 agent 禁用某个事件后，不影响其他 agent 的启用状态。

**JvmtiEnvEventEnable** (jvmtiEventController.hpp:151-171)：三张位图——`_event_user_enabled`（用户设置）、`_event_callback_enabled`（回调存在）、`_event_enabled`（合并结果）。事件真正启用的条件是：有回调 AND（全局启用 OR 某线程启用）。

### 1.5 JvmtiThreadState — 线程级状态管理

```
jvmtiThreadState.hpp:77
class JvmtiThreadState : public CHeapObj<mtInternal> {
```

**核心成员** (jvmtiThreadState.hpp:80-122)：

| 成员 | 作用 |
|------|------|
| `_thread` | 关联的 JavaThread |
| `_class_being_redefined` | 正在 redefine 的 Klass* |
| `_class_load_kind` | load/redefine/retransform 种类 |
| `_thread_event_enable` | 线程级事件启用位图 |
| `_head_env_thread_state` | JvmtiEnvThreadState 链表头 |
| `_next/_prev` | 全局线程状态双向链表 |

**延迟分配机制**：JvmtiThreadState 不会在 JavaThread 创建时分配——`JavaThread::jvmti_thread_state()` 返回 NULL 表示"此线程从未被 agent 引用过"。只有在线程第一次被 agent 需要时才通过 `state_for()` 或 `state_for_while_locked()` 分配。

```
jvmtiThreadState.hpp:135
bool is_enabled(jvmtiEvent event_type) {
  return _thread_event_enable.is_enabled(event_type);
}
```

**事件收集器** (jvmtiThreadState.hpp:118-122)：`_dynamic_code_event_collector`、`_vm_object_alloc_event_collector`、`_sampled_object_alloc_event_collector`——三个事件收集器用于批量发送事件，减少 JNI 边界跨越。

### 1.6 JvmtiTagMap — GC 安全的对象标记

```
jvmtiTagMap.cpp:739
void JvmtiTagMap::set_tag(jobject object, jlong tag) {
  MutexLocker ml(lock());
  oop o = JNIHandles::resolve_non_null(object);
  JvmtiTagHashmap* hashmap = _hashmap;
  JvmtiTagHashmapEntry* entry = hashmap->find(o);
```

**set_tag 流程** (jvmtiTagMap.cpp:739-768)：

1. 获取互斥锁保护 hashmap（多线程安全）
2. `JNIHandles::resolve_non_null(object)` 将 jobject 解析为 oop
3. 在 hashmap 中查找 oop——如果存在且 tag=0 → 删除条目（移除标记）；如果存在且 tag≠0 → 更新；如果不存在且 tag≠0 → 创建新条目
4. 释放锁

**weak_oops_do — GC 交互** (jvmtiTagMap.cpp:3318-3334)：

```
jvmtiTagMap.cpp:3318
void JvmtiTagMap::weak_oops_do(BoolObjectClosure* is_alive, OopClosure* f) {
  assert(SafepointSynchronize::is_at_safepoint(),
         "must be executed at a safepoint");
  if (JvmtiEnv::environments_might_exist()) {
    JvmtiEnvIterator it;
    for (JvmtiEnvBase* env = it.first(); env != NULL; env = it.next(env)) {
      JvmtiTagMap* tag_map = env->tag_map_acquire();
      if (tag_map != NULL && !tag_map->is_empty()) {
        tag_map->do_weak_oops(is_alive, f);
      }
    }
  }
}
```

`weak_oops_do` 在 safepoint 中被 GC 调用。它遍历所有 env 的 TagMap，调用 `do_weak_oops` (jvmtiTagMap.cpp:3336-3400+)。

**do_weak_oops 详细流程** (jvmtiTagMap.cpp:3336-3400+)：

```
jvmtiTagMap.cpp:3362
for (int pos = 0; pos < size; ++pos) {
  JvmtiTagHashmapEntry* entry = table[pos];
  while (entry != NULL) {
    if (!is_alive->do_object_b(entry->object_raw())) {
      // 对象被 GC 回收 → 移除条目
      hashmap->remove(prev, pos, entry);
      destroy_entry(entry);
      if (post_object_free) {
        JvmtiExport::post_object_free(env(), tag);
      }
    } else {
      f->do_oop(entry->object_addr());  // 更新 oop 引用
      // 如果对象移动到新位置 → 重新 hash
    }
  }
}
```

三种操作：
1. **对象被回收** (jvmtiTagMap.cpp:3370)：`is_alive->do_object_b()` 返回 false → 从 hashmap 移除 → 发送 OBJECT_FREE 事件
2. **对象被移动** (jvmtiTagMap.cpp:3387)：`f->do_oop()` 更新 `entry->object_addr()` → 如果 hash 位置变化 → 移动到新 bucket
3. **对象未变化**：保持原样

### 1.7 JvmtiManageCapabilities — 4 组能力管理

```
jvmtiManageCapabilities.hpp:31
class JvmtiManageCapabilities : public AllStatic {
```

**4 组 capability** (jvmtiManageCapabilities.hpp:39-42)：

| 组 | 静态变量 | 含义 |
|----|----------|------|
| `always_capabilities` | :39 | 始终可用，无需 agent 请求 |
| `onload_capabilities` | :40 | OnLoad 或 OnAttach 时可请求 |
| `always_solo_capabilities` | :41 | 始终可用但仅一个 env 能独占 |
| `onload_solo_capabilities` | :42 | OnLoad 时可请求且仅一个 env 能独占 |

**add_capabilities** (jvmtiManageCapabilities.hpp:71-74)：

```
static jvmtiError add_capabilities(
    const jvmtiCapabilities *current,
    const jvmtiCapabilities *prohibited,
    const jvmtiCapabilities *desired,
    jvmtiCapabilities *result);
```

参数设计揭示设计意图：
- `current`：当前已获取的能力
- `prohibited`：禁止的能力（由 JVM 启动参数设置）
- `desired`：agent 请求的能力
- `result`：输出实际获取的能力

**Solo capabilities 机制** (jvmtiManageCapabilities.hpp:45-46)：`always_solo_remaining_capabilities` 和 `onload_solo_remaining_capabilities` 跟踪尚未被独占的能力。某些能力（如 `can_generate_breakpoint_events`）只能由一个 agent 获取——因为解释器中的断点表是全局的，多个 agent 的断点无法共存。

### 1.8 JvmtiRawMonitor — Agent 内部线程同步

```
jvmtiRawMonitor.hpp:39
class JvmtiRawMonitor : public ObjectMonitor {
```

RawMonitor 是 JVMTI 最容易被忽视但设计意图最鲜明的子系统之一。它与 JVM 标准 synchronized 机制完全独立，不给 agent 内部线程同步引入 safepoint 风险。

**为什么需要 RawMonitor — 与 ObjectMonitor 的本质区别**：

```
jvmtiRawMonitor.cpp:102-127
// The raw monitor subsystem is entirely distinct from normal
// java-synchronization or jni-synchronization.  raw monitors are not
// associated with objects.
```

| 维度 | ObjectMonitor | JvmtiRawMonitor |
|------|-------------|-----------------|
| **safepoint** | 需要——进入/退出需要 safepoint check | 不需要——`lock_without_safepoint_check()` |
| **偏向锁** | 支持 biased locking 快速路径 | 不支持——直接 CAS 竞争 |
| **关联对象** | 每个 Java 对象有 ObjectMonitor | 无 Java 对象关联，独立生命周期 |
| **递归计数** | `_recursions` 字段 | 同字段复用 (`_recursions`) |
| **wait/notify** | 基于 `_WaitSet` + park/unpark | 同机制复用 (`ObjectWaiter` + `ParkEvent`) |
| **使用场景** | Java/JNI 同步 | Agent 内部线程同步 |

设计初衷在源码注释中坦承：RawMonitor 借用了 ObjectMonitor 的数据结构但操作语义极度简化（jvmtiRawMonitor.cpp:116: "the operators are degenerate and extremely simple"）。作者明确标注这是待重构的技术债——理想实现应直接基于 park-unpark，不应依赖 ObjectMonitor（jvmtiRawMonitor.cpp:112-113）。

**数据结构** (jvmtiRawMonitor.hpp:39-62)：

JvmtiRawMonitor 继承自 ObjectMonitor，新增两个字段：

| 字段 | 类型 | 作用 |
|------|------|------|
| `_magic` | `int` | 魔数 = `'T'<<24\|'I'<<16\|'R'<<8\|'M'`，防 use-after-free（jvmtiRawMonitor.hpp:43-44） |
| `_name` | `char*` | 调试名，仅 ASSERT 构建保留（jvmtiRawMonitor.cpp:58-61） |

继承自 ObjectMonitor 的核心字段：

| 字段 | 来源 | 作用 |
|------|------|------|
| `_owner` | ObjectMonitor | 当前持有线程指针（CAS 竞争） |
| `_recursions` | ObjectMonitor | 重入计数 |
| `_EntryList` | ObjectMonitor | 入口等待队列（等待获取锁的线程） |
| `_WaitSet` | ObjectMonitor | 条件等待队列（wait 中的线程） |
| `_waiters` | ObjectMonitor | 等待线程计数 |

**is_valid() 安全校验** (jvmtiRawMonitor.cpp:74-100)：

```cpp
// jvmtiRawMonitor.cpp:82-99
// 用字节安全读取 _magic（不对齐的情况下也安全）
switch (sizeof(_magic)) {
  case 2: value = Bytes::get_native_u2((address)&_magic); break;
  case 4: value = Bytes::get_native_u4((address)&_magic); break;
  case 8: value = Bytes::get_native_u8((address)&_magic); break;
}
return value == JVMTI_RM_MAGIC;
```

Agent 可能传递已 destroy 的 monitor 指针——`is_valid()` 通过魔数校验在每次 API 调用入口防御 use-after-free 攻击。

**核心算法：SimpleEnter/SimpleExit/SimpleWait/SimpleNotify** (jvmtiRawMonitor.cpp:129-268)

这四个方法实现 RawMonitor 的核心同步语意，不经过 ObjectMonitor 的标准路径。

**SimpleEnter — 自旋 CAS 竞争** (jvmtiRawMonitor.cpp:129-153)：

```
jvmtiRawMonitor.cpp:129
int JvmtiRawMonitor::SimpleEnter(Thread * Self) {
  for (;;) {
    if (Atomic::replace_if_null(Self, &_owner)) return OS_OK;  // :131
    ObjectWaiter Node(Self);                                     // :135
    Self->_ParkEvent->reset();                                   // :136
    Node.TState = ObjectWaiter::TS_ENTER;                        // :137
    RawMonitor_lock->lock_without_safepoint_check();             // :139
    Node._next = _EntryList; _EntryList = &Node;                 // :140-141
    if (_owner == NULL && Atomic::replace_if_null(Self, &_owner)) { // :143
      _EntryList = Node._next; RawMonitor_lock->unlock(); return OS_OK; // :144-146
    }
    RawMonitor_lock->unlock();                                   // :148
    while (Node.TState == ObjectWaiter::TS_ENTER) {              // :149
      Self->_ParkEvent->park();                                  // :150  ← pthread_cond_timedwait 或 futex()
    }
  }
}
```

流程：
1. **快速路径**：CAS `_owner←Self` 成功 → 立即返回（:131）
2. **慢路径**：在全局 `RawMonitor_lock` 保护下将 `ObjectWaiter` 节点插入 `_EntryList`（:139-141），再次 CAS 尝试（:143-145）
3. **阻塞等待**：`ParkEvent::park()` 底层调用 `pthread_cond_timedwait`（:150 行，man 3 pthread_cond_timedwait），或 Linux futex(2) 的 `FUTEX_WAIT`
4. **被唤醒**：TState 变为 `TS_RUN` 后退出循环

**SimpleExit — 唤醒 EntryList 头部等待者** (jvmtiRawMonitor.cpp:155-181)：

```
jvmtiRawMonitor.cpp:155
int JvmtiRawMonitor::SimpleExit(Thread * Self) {
  OrderAccess::release_store(&_owner, (void*)NULL);              // :157 释放写屏障
  if (_EntryList == NULL) return OS_OK;                          // :159 无等待者
  RawMonitor_lock->lock_without_safepoint_check();               // :162
  w = _EntryList; _EntryList = w->_next;                         // :163-165 摘取头部
  RawMonitor_lock->unlock();                                     // :167
  ParkEvent * ev = w->_event;                                    // :174 提取 ParkEvent
  OrderAccess::loadstore();                                       // :175 内存屏障
  w->TState = ObjectWaiter::TS_RUN;                              // :176 标记可运行
  ev->unpark();                                                  // :178 唤醒  ← pthread_cond_signal 或 futex(FUTEX_WAKE)
  return OS_OK;
}
```

`release_store` (jvmtiRawMonitor.cpp:157) 保证 `_owner=NULL` 对所有 CPU 可见后才访问 `_EntryList`。`OrderAccess::loadstore()` (jvmtiRawMonitor.cpp:175) 保证从 `w->_event` 读取发生在 `w->TState=TS_RUN` 之前——防止等待线程在 ParkEvent 地址仍不确定时被唤醒。

**SimpleWait — 条件等待** (jvmtiRawMonitor.cpp:183-239)：

流程：释放锁 → 在 `_WaitSet` 上等待 → 被 notify 或超时后重新获取锁。

```
jvmtiRawMonitor.cpp:196
SimpleExit(Self);                       // 释放锁（降低 _recursions 到 0）
if (millis <= 0) {
  Self->_ParkEvent->park();             // :201 无限等待
} else {
  ret = Self->_ParkEvent->park(millis); // :203 超时等待
}
// 超时后被自行从 WaitSet 移除（:211-230 双重检查锁定）
SimpleEnter(Self);                      // :234 重新获取锁
```

超时后的自清理（jvmtiRawMonitor.cpp:211-230）使用双重检查锁定（DCL）——先用非原子读检查 `Node.TState == TS_WAIT`，确认仍是等待状态后再加锁从 `_WaitSet` 移除。

**SimpleNotify — 基本与 NotifyAll 区别** (jvmtiRawMonitor.cpp:241-268)：

```
jvmtiRawMonitor.cpp:241
int JvmtiRawMonitor::SimpleNotify(Thread * Self, bool All) {
  // 方案 B：直接在 WaitSet 头部移除 + unpark（注释 :247-250）
  for (;;) {
    w = _WaitSet; _WaitSet = w->_next;           // :255-257
    w->TState = ObjectWaiter::TS_RUN;            // :261
    if (!All) break;                              // :263 false=只通知一个
  }
}
```

代码注释权衡了两种方案（jvmtiRawMonitor.cpp:245-250）：(A) 将线程从 WaitSet 转移到 EntryList；(B) 直接从 WaitSet 移除并 unpark。选择方案 B，虽然导致更多上下文切换，但实现简单。对已废弃的 RawMonitor 来说可接受。

**public API 层** — 与 JvmtiEnv 的桥梁：

| 方法 | 位置 | 调用关系 |
|------|------|---------|
| `raw_enter()` | jvmtiRawMonitor.cpp:271 | JvmtiEnv::RawMonitorEnter → this->raw_enter |
| `raw_exit()` | jvmtiRawMonitor.cpp:348 | JvmtiEnv::RawMonitorExit → this->raw_exit |
| `raw_wait()` | jvmtiRawMonitor.cpp:367 | JvmtiEnv::RawMonitorWait → this->raw_wait |
| `raw_notify()` | jvmtiRawMonitor.cpp:413 | JvmtiEnv::RawMonitorNotify → this->raw_notify |
| `raw_notifyAll()` | jvmtiRawMonitor.cpp:422 | JvmtiEnv::RawMonitorNotifyAll → this->raw_notifyAll |

**raw_enter 的外部挂起防御** (jvmtiRawMonitor.cpp:271-344)：

```
jvmtiRawMonitor.cpp:277
JavaThread * jt = (JavaThread *)THREAD;
jt->SR_lock()->lock_without_safepoint_check();               // :279
while (jt->is_external_suspend()) {                          // :280 自旋等待
  jt->SR_lock()->unlock(); jt->java_suspend_self();           // :281-282
  jt->SR_lock()->lock_without_safepoint_check();              // :283
}
Contended = Atomic::cmpxchg(THREAD, &_owner, (void*)NULL);   // :286
jt->SR_lock()->unlock();
```

线程在被外部挂起期间不能进入 monitor——否则挂起者看到"已挂起的线程"正持有 monitor 会违反一致性。`SR_lock()` 保护这段临界区。

**JvmtiPendingMonitors — OnLoad 阶段的延迟 monitor** (jvmtiRawMonitor.hpp:68-105)：

```
jvmtiRawMonitor.hpp:68
class JvmtiPendingMonitors : public AllStatic {
```

在 Agent_OnLoad 阶段 JVM 尚未完全初始化，raw monitor 无法正常工作。`JvmtiPendingMonitors::enter()` (jvmtiRawMonitor.hpp:80) 将 monitor 加入缓存列表。VM 完成初始化后调用 `transition_raw_monitors()` (jvmtiRawMonitor.cpp:35-51)，将缓存列表中的所有 monitor 转入真正的 `raw_enter()`。

### 1.9 JvmtiImpl 扩展 API — GetExtensionFunctions/GetExtensionEvents

```
jvmtiExtensions.hpp:39
class JvmtiExtensions : public AllStatic {
```

JVMTI 规范允许实现注册规范外函数和事件。HotSpot 注册了一个扩展函数和一个扩展事件——这是一个刻意极简的实现，旨在证明 API 的可用性。

**注册流程** (jvmtiExtensions.cpp:58-91)：

`JvmtiExtensions::register_extensions()` 在 VM 初始化时调用，创建两个 `GrowableArray`：

```
jvmtiExtensions.cpp:59-60
_ext_functions = new (...) GrowableArray<jvmtiExtensionFunctionInfo*>(1,true);
_ext_events   = new (...) GrowableArray<jvmtiExtensionEventInfo*>(1,true);
```

**扩展函数：IsClassUnloadingEnabled** (jvmtiExtensions.cpp:37-50)：

```cpp
// jvmtiExtensions.cpp:37
static jvmtiError JNICALL IsClassUnloadingEnabled(const jvmtiEnv* env, ...) {
  *enabled = (jboolean)ClassUnloading;   // :48 全局标志
  return JVMTI_ERROR_NONE;
}
```

唯一的扩展函数，返回 `ClassUnloading` 全局标志（由 `-noclassgc` 设置）。参数声明在 jvmtiExtensions.cpp:63-65：

```
static jvmtiParamInfo func_params[] = {
  { "IsClassUnloadingEnabled", JVMTI_KIND_OUT, JVMTI_TYPE_JBOOLEAN, JNI_FALSE }
};
```

**扩展事件：EXT_EVENT_CLASS_UNLOAD** (jvmtiExtensions.cpp:79-90)：

```cpp
// jvmtiExtensions.cpp:83
static jvmtiExtensionEventInfo ext_event = {
  EXT_EVENT_CLASS_UNLOAD,                    // :84 extension_event_index
  "com.sun.hotspot.events.ClassUnload",      // :85 id
  "CLASS_UNLOAD event",                      // :86 short_description
  2, event_params                            // :87-88
};
```

`EXT_EVENT_CLASS_UNLOAD = JVMTI_MIN_EVENT_TYPE_VAL - 1` (jvmtiEventController.hpp:78)，是事件枚举中唯一低于标准事件索引的存在。它提供的类卸载事件在标准 JVMTI 事件中没有对应项——标准事件中 ClassUnload 虽存在但不支持 Enable/Disable。

**JvmtiExtensions::get_functions() — 分配语义** (jvmtiExtensions.cpp:96-180)：

```
jvmtiExtensions.cpp:102
ResourceTracker rt(env);                                  // 栈对象，析构自动释放
jvmtiError err = rt.allocate(                             // :105-107
  _ext_functions->length() * sizeof(jvmtiExtensionFunctionInfo),
  (unsigned char**)&ext_funcs);
```

`ResourceTracker` (jvmtiEnvBase.hpp:607-618) 是栈对象（StackObj）。析构函数自动释放所有通过它在 env 的 `_env_thread_local_storage` 中分配的内存——如果整个函数成功则转移所有权给 agent（由 agent 负责 `Deallocate`），如果函数返回错误则析构函数自动清理——防止内存泄漏。

每个 `jvmtiExtensionFunctionInfo` 字段（id, short_description, params, errors）都需要独立的 `rt.allocate()` + `strcpy`——因为扩展函数结构是扁平 C 结构体，字符串需要独立分配（jvmtiExtensions.cpp:113-174）。

**JvmtiExtensions::get_events()** (jvmtiExtensions.cpp:185-252)：与 get_functions() 完全对称的结构——分配结构体数组 → 逐字段复制 → 返回计数和指针。

**JvmtiExtensions::set_event_callback()** (jvmtiExtensions.cpp:256-284)：

```
jvmtiExtensions.cpp:267
for (int i=0; i<_ext_events->length(); i++) {
  if (_ext_events->at(i)->extension_event_index == extension_event_index) {
     event = _ext_events->at(i);    // :269 找到匹配的扩展事件
     break;
  }
}
if (event == NULL) return JVMTI_ERROR_ILLEGAL_ARGUMENT; // :277
JvmtiEventController::set_extension_event_callback(env, extension_event_index, callback); // :280-281
```

验证 `extension_event_index` 在注册范围内后，委托给 `JvmtiEventControllerPrivate::set_extension_event_callback` (jvmtiEventController.cpp:590-603) 更新 `JvmtiEnvEventEnable::_event_callback_enabled` 并触发 `recompute_enabled()`。

**JvmtiImpl 中的 ResourceTracker 模式** (jvmtiEnvBase.hpp:607-618)：

扩展 API 的返回数据结构需要在 env 生命周期内有效——这是 ResourceTracker 的核心职责。对比传统的 C 风格 "allocate + caller must free" 模式，ResourceTracker 提供了一种两阶段提交：分配 → 成功则输出指针（所有权转移），失败则析构函数自动释放所有分配——无需调用者跟踪每个 `goto error_cleanup` 分支。

### 1.10 7 个 Beginner Callout 框

> **1. JvmtiEnv 的 XSLT 代码生成**：JVMTI 规范定义了 ~300 个函数。`jvmtiEnter.xsl` 从规范 XML 生成每个函数的实现骨架——包括 phase 检查、capability 检查、环境有效性检查、线程转换。这避免了手工维护 300+ 函数签名的一致性问题。函数骨架模板在 jvmtiEnter.xsl:471-610。每个生成函数开头自动注入 `if(!JvmtiEnv::is_vm_live()) return JVMTI_ERROR_WRONG_PHASE;`。

> **2. Phase 门控**：每个 JVMTI 函数有 `phase` 约束——定义在规范 XML 的 `@phase` 属性中，代码生成时注入到函数开头。Phase 检查逻辑在 jvmtiEnter.xsl:488-541：`live` 函数检查 `JvmtiEnv::is_vm_live()`，`onload` 函数检查 `get_phase()==JVMTI_PHASE_ONLOAD`，`start` 函数检查 `get_phase(env)==JVMTI_PHASE_START`。Phase 值：ONLOAD(1) < PRIMORDIAL(2) < LIVE(4) < START(6) < DEAD(8)。

> **3. 事件启用位图**：`JvmtiEventEnabled` (jvmtiEventController.hpp:78) 是一个 64-bit 位掩码——每个位对应一个 JVMTI 事件。`CLASS_FILE_LOAD_HOOK_BIT = ((jlong)1 << (EVENT_CFLH - TOTAL_MIN_EVENT_TYPE_VAL))`。位图通过 `|` 和 `&` 操作合并——O(1) 检查是否有任何 agent 启用了某个事件。64 位足够覆盖所有 JVMTI 事件类型（当前约 50 个事件）。

> **4. recompute_enabled 的三层合并**：`JvmtiEventControllerPrivate::recompute_enabled` (jvmtiEventController.cpp:571) 遍历所有 JvmtiEnv × 所有 JvmtiThreadState，计算每个事件的"真正应该发送"标志。(1) 合并所有 env 的全局事件启用 → `any_env_thread_enabled`，(2) 为线程过滤事件创建缺失的 JvmtiThreadState，(3) 合并每个线程的 per-env 事件启用 → `universal_global_event_enabled`，(4) 将 delta 写入 `JvmtiExport::_should_post_*` 布尔门控。任何 env 注册/注销事件时触发重新计算。

> **5. JvmtiTagMap 的 GC 安全**：`JvmtiTagMap` (jvmtiTagMap.cpp) 是 `jobject → jlong` 的哈希映射。`jobject` 是 JNI weak global reference——GC 可能移动对象或回收对象。`weak_oops_do` (jvmtiTagMap.cpp:3318) 在 safepoint 中被 GC 调用，遍历所有 TagMap 执行三种操作：(a) 对象被回收 → 移除条目 + 发送 OBJECT_FREE 事件，(b) 对象被移动 → 更新 oop 引用 + 重新 hash，(c) 对象未变化 → 保持。这保证了 tag 在 GC 后仍然有效。

> **6. Capability 管理**：JVMTI capabilities 分为 4 组（jvmtiManageCapabilities.hpp:39-42）：(1) `always_capabilities`——始终可用（如 GetEnv, GetPhase），(2) `onload_capabilities`——Agent_OnLoad 或 Agent_OnAttach 时可请求（如 can_redefine_classes），(3) `always_solo_capabilities`——始终可用但仅一个 env 能独占，(4) `onload_solo_capabilities`——仅 OnLoad 阶段且仅一个 env 能独占（如 can_generate_breakpoint_events）。`add_capabilities` (jvmtiManageCapabilities.hpp:71) 检查 agent 的 phase 是否允许请求该 capability。

> **7. RawMonitor — Agent 专用的同步机制**：`JvmtiRawMonitor` (jvmtiRawMonitor.hpp:39) 继承 ObjectMonitor，核心操作（SimpleEnter/SimpleExit/SimpleWait/SimpleNotify）使用 ParkEvent park/unpark 机制——底层为 futex(2) 或 pthread_cond(3)。与 Java synchronized 完全独立：无 safepoint 检查、无偏向锁、无关联 Java 对象。Agent 内部线程同步使用 CreateRawMonitor/EnterRawMonitor/WaitRawMonitor/NotifyRawMonitor——错误调用返回 `JVMTI_ERROR_NOT_MONITOR_OWNER` 而非 JVM 内部 IllegalMonitorStateException。is_valid() 通过魔数校验（JVMTI_RM_MAGIC = 0x5449524d）防御 use-after-free。

### 1.11 Mermaid 架构分层图

```mermaid
graph TB
    subgraph "Agent Layer"
        A1[Agent 1<br/>-agentlib:agent1]
        A2[Agent 2<br/>-agentpath:agent2]
        A3[Agent N<br/>Attach API]
    end

    subgraph "JvmtiEnv Layer"
        E1[JvmtiEnv 1<br/>jvmtiEnvBase.hpp:57]
        E2[JvmtiEnv 2]
        E3[JvmtiEnv N]
        EBase[JvmtiEnvBase<br/>_head_environment 链表]
        EIter[JvmtiEnvIterator<br/>jvmtiEnvBase.hpp:318]
    end

    subgraph "Gate Layer"
        PG[Phase Gate<br/>jvmtiEnter.xsl:489]
        CG[Capability Gate<br/>jvmtiEnter.xsl:558]
        EV[Env Valid Gate<br/>jvmtiEnter.xsl:543]
    end

    subgraph "Event Controller Layer"
        EC[JvmtiEventController<br/>recompute_enabled :571]
        JEE[JvmtiEventEnabled<br/>64-bit bitmask :78]
        JETE[JvmtiEnvThreadEventEnable<br/>per-env×thread :107]
        JTE[JvmtiThreadEventEnable<br/>per-thread :130]
        JEEE[JvmtiEnvEventEnable<br/>per-env :151]
        EXP[JvmtiExport<br/>_should_post_* booleans]
    end

    subgraph "State & Tag Layer"
        JTS[JvmtiThreadState<br/>jvmtiThreadState.hpp:77]
        JETS[JvmtiEnvThreadState<br/>per-env×thread]
        TM[JvmtiTagMap<br/>set_tag :739]
        WOD[weak_oops_do<br/>:3318 GC 安全]
        MC[JvmtiManageCapabilities<br/>4 组 capability]
    end

    A1 --> E1
    A2 --> E2
    A3 --> E3
    E1 --> EBase
    E2 --> EBase
    E3 --> EBase
    EBase --> EIter
    EIter --> EC
    E1 --> PG
    E1 --> CG
    E1 --> EV
    PG --> EC
    CG --> EC
    EC --> JEE
    JEE --> JETE
    JEE --> JTE
    JEE --> JEEE
    JEEE --> EXP
    EC --> JTS
    JTS --> JETS
    E1 --> TM
    TM --> WOD
    EC --> MC
```

### 1.12 面试 Story Format 答案

"JVMTI isn't a monolithic API—it's a layered infrastructure. At the bottom, `JvmtiEnvBase` at jvmtiEnvBase.hpp:57 is a CHeapObj that holds a `JvmtiEnv` pointer, a `JvmtiEventController` (through the facade), and a per-env `JvmtiTagMap`. The 300+ JVMTI functions are generated from a specification file via XSLT—`jvmtiEnter.xsl` produces each function with injected phase checks and capability checks. Each function call goes through two gates: capability check (did the agent request this capability?) and phase check (is the VM in the right phase?). The event system is the most complex part: `JvmtiEventControllerPrivate::recompute_enabled` at jvmtiEventController.cpp:571 is the global recomputation engine. It merges three levels: per-environment event enables (`JvmtiEnvEventEnable`), per-thread event enables (`JvmtiThreadEventEnable`), and the intersection (`JvmtiEnvThreadEventEnable`). The result sets global booleans like `_should_post_class_file_load_hook`—a single bool read in the hot path that gates the entire CFLH pipeline. The `JvmtiTagMap` at jvmtiTagMap.cpp is a per-env hash map from `jobject` to `jlong` tag—it survives GC through `weak_oops_do` callbacks that update oop references when objects move."

---

## §二  Standard Environment — 源文件索引、构建与环境

### 2.1 Source Roots

本节涵盖的所有源文件的绝对路径与行数范围（`src/hotspot/share/prims/`）：

| 文件 | 行数 | 关键内容 |
|------|------|---------|
| `jvmtiEnvBase.hpp` (:1-655) | 655 | JvmtiEnvBase 类定义、_phase 全局状态、ResourceTracker、JvmtiEnvIterator、JvmtiMonitorClosure |
| `jvmtiEnvBase.cpp` (:1-XXX) | ~800 | JvmtiEnvBase 实现 |
| `jvmtiEnv.hpp` (:1-XX) | ~50 | JvmtiEnv 派生类声明（XSLT 生成函数在此声明） |
| `jvmtiEnv.cpp` (:1-XXX) | ~4000+ | JvmtiEnv 300+ 函数的 XSLT 生成实现 + 少量手写方法 |
| `jvmtiEventController.hpp` (:1-200+) | 200+ | 4 层位图类 + JvmtiEventController facade |
| `jvmtiEventController.cpp` (:1-700+) | 700+ | recompute_enabled 三层合并引擎 + 位图管理 |
| `jvmtiThreadState.hpp` (:1-180+) | 180+ | JvmtiThreadState 延迟分配 + JvmtiEnvThreadState |
| `jvmtiThreadState.cpp` (:1-XXX) | ~500 | 线程状态生命周期管理 |
| `jvmtiTagMap.hpp` (:1-XXX) | ~100 | JvmtiTagMap + JvmtiTagHashmap 声明 |
| `jvmtiTagMap.cpp` (:1-3500+) | 3500+ | GC-safe 对象标记 hashmap 完整实现 |
| `jvmtiManageCapabilities.hpp` (:1-80+) | 80+ | 4 组 capability 定义 + add_capabilities |
| `jvmtiManageCapabilities.cpp` (:1-XXX) | ~200 | capability 检查实现 |
| `jvmtiRawMonitor.hpp` (:1-107) | 107 | JvmtiRawMonitor 类定义（继承 ObjectMonitor）+ JvmtiPendingMonitors |
| `jvmtiRawMonitor.cpp` (:1-430) | 430 | SimpleEnter/Exit/Wait/Notify + raw_enter raw_exit raw_wait raw_notify |
| `jvmtiExtensions.hpp` (:1-61) | 61 | JvmtiExtensions 静态类声明 |
| `jvmtiExtensions.cpp` (:1-285) | 285 | GetExtensionFunctions/GetExtensionEvents/SetExtensionEventCallback |
| `jvmtiImpl.hpp` (:1-XXX) | ~300 | GrowableCache, JvmtiBreakpoint, JvmtiBreakpoints 等 |
| `jvmtiExport.hpp` (:1-XXX) | ~200 | JvmtiExport::_should_post_* 静态布尔门控声明 |
| `jvmtiExport.cpp` (:1-XXX) | ~3000 | 事件发送 dispatch + CFLH 两遍遍历 |
| `jvmtiTrace.hpp` / `jvmtiTrace.cpp` (:1-150+ / :1-500+) | ~650 | JVMTI 跟踪/日志输出 |

### 2.2 构建命令与 Binary Paths

```bash
# libjvm.so 构建目标（包含所有 JVMTI 核心代码）
# make 定位：grep -rn "BUILD_LIBRARY" make/ | grep -i "jvm"
make hotspot

# 产物路径
# libjvm.so: build/linux-x86_64-server-release/hotspot/variant-server/libjvm/objs/
# JVMTI 源文件编译为 .o 后链接到 libjvm.so

# 验证 JVMTI 符号已链接
nm build/linux-x86_64-server-release/hotspot/variant-server/libjvm/objs/libjvm.so \
  | grep "recompute_enabled\|raw_enter\|weak_oops_do\|get_functions"
```

### 2.3 Syscall 与 Library 速查表

| 操作 | 系统调用/库函数 | man 来源 | 参数 | 返回值 |
|------|---------------|---------|------|--------|
| CAS 原子操作 | `cmpxchg` (inline asm) | — | `cmpxchg(val, addr)` | 旧值（竞争失败）或原值 |
| Park 阻塞 | `futex` | `man 2 futex` | `FUTEX_WAIT, uaddr, val` | 0 成功；EAGAIN（*uaddr≠val），EINTR（信号中断） |
| Unpark 唤醒 | `futex` | `man 2 futex` | `FUTEX_WAKE, uaddr, n` | 唤醒的线程数 |
| mutex 锁 | `pthread_mutex_lock` | `man 3 pthread_mutex_lock` | `&mutex` | 0 成功；EDEADLK（死锁检测），EINVAL |
| mutex 解锁 | `pthread_mutex_unlock` | `man 3 pthread_mutex_unlock` | `&mutex` | 0 成功；EPERM（非持有者解锁） |
| dlopen | `dlopen` | `man 3 dlopen` | `path, flags` | 句柄；NULL → dlerror() |
| mmap | `mmap` | `man 2 mmap` | `addr, len, prot, flags, fd, offset` | 成功返回地址；失败返回 MAP_FAILED，errno=ENOMEM/ENFILE |
| 线程创建 | `pthread_create` | `man 3 pthread_create` | `&tid, attr, func, arg` | 0 成功；EAGAIN（资源不足），EPERM |
| sem 等待 | `sem_wait` | `man 3 sem_wait` | `&sem` | 0 成功；EINTR（信号中断） |
| 内存分配 | `mmap` (CHeap) | `man 2 mmap` | `MAP_ANONYMOUS\|MAP_PRIVATE` | 成功返回地址 |
| 信号处理 | `sigaction` | `man 2 sigaction` | `signum, &act, &oldact` | 0 成功；EINVAL |

### 2.4 Key Component 文件 map

```mermaid
graph LR
    subgraph "JVMTI Core Infrastructure"
        EB[jvmtiEnvBase.hpp:57<br/>JvmtiEnvBase<br/>_head_environment 链表]
        EI[jvmtiEnvBase.hpp:318<br/>JvmtiEnvIterator]
        ENV[jvmtiEnv.cpp<br/>XSLT 代码生成 300+ 函数]
        EC[jvmtiEventController.cpp:571<br/>recompute_enabled 全局计算引擎]
        EBITS[jvmtiEventController.hpp:78<br/>64-bit 事件位图]
        TS[jvmtiThreadState.hpp:77<br/>线程状态延迟分配]
        TM[jvmtiTagMap.cpp:739<br/>GC-safe 对象标记]
        MC[jvmtiManageCapabilities.hpp:31<br/>4 组能力管理]
        RM[jvmtiRawMonitor.cpp:129<br/>SimpleEnter/Exit/Wait/Notify]
        EXT[jvmtiExtensions.cpp:58<br/>扩展函数和事件注册]
    end
```

---

## §三  Source Files Table — 核心源文件清单

本节以 README 规划中列出的完整文件列表为准，按功能模块分组罗列所有核心源文件：

### 3.1 Environment & Core

| 文件 | 行数 | 核心内容 |
|------|------|---------|
| `jvmtiEnv.cpp` | ~4000+ | 300+ JVMTI 函数的 XSLT 生成实现；CreateRawMonitor/DestroyRawMonitor/RawMonitorEnter/RawMonitorExit/RawMonitorWait/RawMonitorNotify/RawMonitorNotifyAll |
| `jvmtiEnvBase.cpp` | ~800 | JvmtiEnvBase 环境基类实现；_head_environment 链表操作；ResourceTracker 析构清理 |
| `jvmtiEnvBase.hpp` | 655 | JvmtiEnvBase 类声明 + _phase 全局状态 + JvmtiEnvIterator |
| `jvmtiEnv.hpp` | ~50 | JvmtiEnv 派生类声明 |
| `jvmtiExport.cpp` | ~3000 | 事件 dispatch + CFLH 两遍遍历 (jvmtiExport.cpp:910-932)；post_class_file_load_hook 触发 |
| `jvmtiExport.hpp` | ~200 | _should_post_* 静态布尔门控声明 |

### 3.2 Event System

| 文件 | 行数 | 核心内容 |
|------|------|---------|
| `jvmtiEventController.cpp` | 700+ | recompute_enabled (jvmtiEventController.cpp:571) 三层合并引擎；recompute_env_enabled + recompute_thread_enabled |
| `jvmtiEventController.hpp` | 200+ | JvmtiEventEnabled/JvmtiEnvThreadEventEnable/JvmtiThreadEventEnable/JvmtiEnvEventEnable 4 层位图类 |
| `jvmtiThreadState.cpp` | ~500 | 线程状态生命周期管理；延迟分配 state_for() |
| `jvmtiThreadState.hpp` | 180+ | JvmtiThreadState 类（_class_being_redefined, _thread_event_enable, _head_env_thread_state） |
| `jvmtiEnvThreadState.cpp` | ~200 | JvmtiEnvThreadState 每 env×thread 事件启用状态 |

### 3.3 Data & Extension

| 文件 | 行数 | 核心内容 |
|------|------|---------|
| `jvmtiTagMap.cpp` | 3500+ | GC-safe 对象标记 hashmap；set_tag (jvmtiTagMap.cpp:739)；weak_oops_do (jvmtiTagMap.cpp:3318) |
| `jvmtiTagMap.hpp` | ~100 | JvmtiTagMap + JvmtiTagHashmap 声明 |
| `jvmtiManageCapabilities.cpp` | ~200 | 4 组 capability 检查实现 |
| `jvmtiManageCapabilities.hpp` | 80+ | always_capabilities/onload_capabilities/always_solo/onload_solo 定义 |
| `jvmtiExtensions.cpp` | 285 | GetExtensionFunctions/GetExtensionEvents/SetExtensionEventCallback |
| `jvmtiExtensions.hpp` | 61 | JvmtiExtensions 静态类声明 |

### 3.4 Raw Monitor

| 文件 | 行数 | 核心内容 |
|------|------|---------|
| `jvmtiRawMonitor.cpp` | 430 | SimpleEnter/SimpleExit/SimpleWait/SimpleNotify (jvmtiRawMonitor.cpp:129-268)；raw_enter/raw_exit/raw_wait/raw_notify/raw_notifyAll |
| `jvmtiRawMonitor.hpp` | 107 | JvmtiRawMonitor 类声明（继承 ObjectMonitor）；JvmtiPendingMonitors OnLoad 缓存 |

### 3.5 Trace, ClassFile, CodeBlob

| 文件 | 行数 | 核心内容 |
|------|------|---------|
| `jvmtiTrace.cpp` | ~500 | JVMTI 跟踪/日志输出；TRACE_JVMTI 宏 |
| `jvmtiTrace.hpp` | ~150 | 跟踪级别定义 |
| `jvmtiClassFileReconstituter.cpp` | ~1000 | 类文件字节码重组（用于 RetransformClasses） |
| `jvmtiGetLoadedClasses.cpp` | ~50 | GetLoadedClasses 简单实现（遍历 ClassLoaderDataGraph） |
| `jvmtiCodeBlobEvents.cpp` | ~500 | 编译后代码事件（DynamicCodeGenerated/CompiledMethodLoad） |

---

## §四  边缘场景分析 — 竞态、OOM 与悬挂指针

### 4.1 多 Agent 并发能力协商竞态

**场景**：两个 agent 同时 attach——Agent A 请求 `can_redefine_classes`（标准能力，允许多 env），Agent B 同时请求 `can_generate_breakpoint_events`（solo 能力，唯一 env 独占）。

**竞态窗口**：

```
时间线：
T1: Agent A → AddCapabilities(desired={can_redefine_classes, can_generate_breakpoint_events})
T2: Agent B → AddCapabilities(desired={can_generate_breakpoint_events})
```

JvmtiManageCapabilities 中`solo_remaining` 跟踪是**非原子的**（jvmtiManageCapabilities.hpp:45-46）。如果 A 和 B 在无同步的情况下同时检查 `solo_remaining → add_capabilities`：

- A 看到 `can_generate_breakpoint_events` 未分配 → 获取 → 更新 `solo_remaining`
- B 在 A 更新 `solo_remaining` 之前也看到未分配 → 也获取

**根因**：`add_capabilities` (jvmtiManageCapabilities.hpp:71-74) 没有内部锁——依赖调用端在正确的 phase/mutex 上下文中调用。在 OnLoad/OnAttach 阶段调用（单线程初始化），race 不可能发生；但在 Attach 期间，多个 agent 可能并发 attach。

**缓解**：Attach API 的 `attach_current_thread` 串行化了 agent 初始化（`JvmtiExport::transition_pending_onload_raw_monitors` 在单一线程上下文中运行，jvmtiRawMonitor.cpp:35-51），但 solo capability 检查本身不受此保护。

### 4.2 JvmtiTagMap 内存耗尽（OOM 清理策略）

**场景**：Agent 在长时间运行的应用上标记数百万对象 → `set_tag()` 的 `create_entry` (jvmtiTagMap.cpp:752) 尝试 CHeap 分配 → malloc/mmap(2) 失败 → 抛出 `std::bad_alloc`。

**清理链**：

```
jvmtiTagMap.cpp:752 create_entry → NEW_C_HEAP_OBJ →
  → os::malloc (C_HEAP) → (失败) → vm_exit_out_of_memory
```

JVMTI spec 要求 `JVMTI_ERROR_OUT_OF_MEMORY` 返回给 agent——但当前实现直接 `vm_exit_out_of_memory()`（即 JVM 崩溃），不返回给 agent。这是已知的 spec 违反。

**GC 时的内存回收**：`weak_oops_do` (jvmtiTagMap.cpp:3318) 在 safepoint 中释放回收对象的条目——但 entry 结构体本身很小（~40 bytes/entry）。如果在两次 GC 之间 agent 疯狂 set_tag，内存压力可能超过 GC 释放速度。

**Agent 侧防御**：Agent 应设上限追踪 tag 数量，超过阈值发送 `JVMTI_EVENT_DATA_DUMP_REQUEST` 或主动调用 `SetTag(object, 0)` 清理无关标记。

### 4.3 Agent 断连后 JvmtiThreadState 悬挂指针

**场景**：Agent 在 Attach 期间注册了类加载事件 → JVM 为多个 Java 线程创建了 `JvmtiThreadState` → agent 突然断开（Attach session 超时或主动 `java.lang.instrument.Instrumentation.removeTransformer`）。

**悬挂指针链**：

```
JavaThread::_jvmti_thread_state → JvmtiThreadState (CHeap)
  → JvmtiThreadState::_head_env_thread_state → JvmtiEnvThreadState (CHeap)
  → JvmtiEnvThreadState::_event_user_enabled → (已失效的 JvmtiEnvBase 引用)
```

`JvmtiEnvBase::dispose()` 销毁 env 但不清理所有线程的 `JvmtiEnvThreadState`——它依赖线程自然消亡时清理。但活着的线程仍持有指向已释放 env 的指针。

**JvmtiEventController 防御** (jvmtiEventController.cpp:571-650)：`recompute_enabled()` 遍历所有 env 时使用 `JvmtiEnvIterator`——它包含无效但未释放的 env。`is_valid()` 检查在遍历中可能部分捕获无效 env。

### 4.4 线程状态清理时机 — ThreadEnd 回调延迟

**场景**：Java 线程终止 → `JavaThread::exit()` → `JvmtiExport::post_thread_end()` → cleanup JvmtiThreadState → **但**如果 agent 在 ThreadEnd 回调中调用 GetThreadInfo → 需要 `JvmtiThreadState` → 状态已部分清理。

**清理时序** (jvmtiThreadState.cpp)：

```
jvmtiThreadState.cpp: destroy state
  → post_thread_end() agent callback       // agent 收到通知但...
  → JvmtiEventController::thread_ended()   // 清除全局列表中的 state
  → jvmti_thread_state = NULL              // 设置 JavaThread 字段为 NULL
```

如果 agent 在 `post_thread_end()` 中调用 `GetThreadInfo(thread)` → JVMTI 需要线程的 `JvmtiThreadState` 来获取 frame count → 但 `jvmti_thread_state()` 返回 NULL（已被设为 NULL） → agent 收到 `JVMTI_ERROR_THREAD_NOT_ALIVE` → 符合 spec 但 agent 可能认为这是 bug。

### 4.5 RawMonitor destroy 后重入

`is_valid()` 魔数检查 (jvmtiRawMonitor.cpp:74-100) 不是线程安全的——如果线程 A 正在 `SimpleEnter` 中等待，线程 B 调用 `DestroyRawMonitor` → 线程 A 被 unpark 后访问 `_EntryList` → `_magic` 已被清零但因内存复用可能恰好仍有有效值。概率极低但理论上可能。

### 4.6 诊断工具使用

**strace — 捕获 Agent 的系统调用**：

```bash
# 跟踪 agent 的 JVMTI 系统调用
strace -f -e trace=futex,mmap,write,mprotect \
  java -agentlib:myagent -jar app.jar 2>&1 | grep -E "futex|mmap"

# 输出示例：
# futex(0x7f..., FUTEX_WAIT, 2, NULL) = 0     ← SimpleEnter 竞争失败阻塞
# futex(0x7f..., FUTEX_WAKE, 1) = 1           ← SimpleNotify 唤醒 1 个等待者
# mmap(NULL, 8388608, PROT_READ|PROT_WRITE...) ← TagMap hashmap 扩容
```

**jcmd — 运行时诊断**：

```bash
# 列出所有 JVMTI 事件状态
jcmd <pid> VM.jvmti_events

# 查看 JvmtiEnv 列表
jcmd <pid> VM.jvmti_environments

# 查看 agent 加载状态
jcmd <pid> VM.system_properties | grep "sun.instrument\|agent"
```

**/proc 检查**：

```bash
# 查看 JVM 进程的内存映射（验证 dlopen 加载的 agent .so）
cat /proc/<pid>/maps | grep "agent"

# 查看线程状态（RawMonitor 阻塞的线程）
cat /proc/<pid>/status | grep Threads
# 每个阻塞在 RawMonitor 上的线程状态为 S (sleeping)
ps -Lp <pid> -o pid,lwp,wchan,stat | grep -E "futex|park"
```

---

## §五 性能剖析

### 5.1 Phase 检查开销

Phase 检查是内联的静态方法调用（jvmtiEnvBase.hpp:77）：

```cpp
static jvmtiPhase get_phase() { return _phase; }
```

- **成本**: ~0.3ns — 单次静态内存读取 + 整数比较
- **位置**: 每个 JVMTI 函数入口（代码生成注入）
- **优化**: `is_vm_live()` (jvmtiEnvBase.hpp:80) 直接比较 `_phase == JVMTI_PHASE_LIVE`，比通用 phase 检查更快

### 5.2 recompute_enabled 开销

- **触发频率**: 仅在 `SetEventNotificationMode` 或 `SetEventCallbacks` 时触发
- **复杂度**: O(n_envs × n_threads) — 遍历所有 env × 所有线程状态
- **典型场景**: 3 个 env × 100 个线程 = 300 次遍历 → ~100µs
- **热路径开销**: 0 — recompute_enabled 不参与热路径；热路径只需读一个 bool（`JvmtiExport::should_post_class_file_load_hook()`）

### 5.3 TagMap set_tag 开销

- **哈希查找**: O(1) 平均 → ~100ns（内存访问主导）
- **新条目分配**: `create_entry` (jvmtiTagMap.cpp:752) 需要 CHeapObj 分配 → ~150ns
- **锁竞争**: `MutexLocker ml(lock())` (jvmtiTagMap.cpp:740) — 单 env 单锁，多线程并发 set_tag 时成为热点

### 5.4 事件门控热路径

```cpp
// jvmtiExport.hpp (典型热路径)
if (JvmtiExport::should_post_class_file_load_hook()) {
  post_class_file_load_hook(...);
}
```

- **成本**: ~0.3ns — 单次 bool 读取 + 分支预测
- **分支预测**: 绝大多数情况下为 false（无 agent 启用事件）→ 预测正确率 >99.9%
- **零开销设计**: 当没有 agent 时，JVMTI 对正常执行路径的 overhead < 0.01%

---

## §六 GDB 断点验证 — 7 断点

### 断言 1: JvmtiEnv phase check

```
(gdb) break jvmtiEnv.cpp:457
Breakpoint 1 at jvmtiEnv.cpp:457 (RedefineClasses)
(gdb) run
(gdb) print JvmtiEnv::get_phase()
$1 = 4   // JVMTI_PHASE_LIVE
(gdb) continue
→ 通过 phase 检查，继续执行
```

**验证点** (jvmtiEnvBase.hpp:80)：`is_vm_live()` 返回 `_phase == JVMTI_PHASE_LIVE`。RedefineClasses 的 phase 属性是 `live`，因此在 JVMTI_PHASE_LIVE (4) 阶段通过检查。

### 断言 2: recompute_enabled 三层合并

```
(gdb) break jvmtiEventController.cpp:571
Breakpoint 2 at jvmtiEventController.cpp:571
(gdb) continue
(gdb) print/x any_env_thread_enabled
$2 = 0x2000   // CLASS_FILE_LOAD_HOOK_BIT 已设置
(gdb) continue
→ 计算完成
(gdb) print JvmtiExport::should_post_class_file_load_hook()
$3 = true
```

**验证点** (jvmtiEventController.cpp:604-609)：delta 计算 `any_env_thread_enabled ^ was_any_env_thread_enabled` 只对翻转位更新 `JvmtiExport::set_should_post_*`。

### 断言 3: JvmtiThreadState 延迟创建

```
(gdb) break JvmtiThreadState::state_for
Breakpoint 3 at jvmtiThreadState.cpp
(gdb) run
(gdb) print jt->jvmti_thread_state()
$4 = (JvmtiThreadState *) 0x0   // 首次访问，未分配
(gdb) continue
→ agent 调用 SetEventNotificationMode
(gdb) print jt->jvmti_thread_state()
$5 = (JvmtiThreadState *) 0x7fff...   // 已分配
```

**验证点** (jvmtiThreadState.hpp:77)：`JavaThread::jvmti_thread_state()` 返回 `_jvmti_thread_state` 字段——初始为 NULL，仅在需要时才分配。

### 断言 4: JvmtiTagMap set_tag

```
(gdb) break jvmtiTagMap.cpp:739
Breakpoint 4 at jvmtiTagMap.cpp:739
(gdb) continue
(gdb) print object
$6 = (jobject) 0x7fff...   // 有效的 jobject
(gdb) print tag
$7 = 42   // 非 0 tag 值
(gdb) continue
→ tag 存储完成
```

**验证点** (jvmtiTagMap.cpp:739-768)：`JNIHandles::resolve_non_null(object)` 解析 jobject → `hashmap->find(o)` 查找 → 不存在 → `create_entry(o, tag)` + `hashmap->add(o, entry)`。

### 断言 5: weak_oops_do GC 更新

```
(gdb) break jvmtiTagMap.cpp:3318
Breakpoint 5 at jvmtiTagMap.cpp:3318
(gdb) continue
→ GC 触发时调用（在 safepoint 中）
(gdb) print JvmtiEnv::environments_might_exist()
$8 = true
(gdb) print tag_map->_hashmap->_entry_count
$9 = 153   // TagMap 中有 153 个条目
(gdb) continue
→ weak_oops_do 完成：回收的对象被移除，移动的对象被更新
```

**验证点** (jvmtiTagMap.cpp:3318-3334)：遍历所有 env 的 TagMap → 对每个非空 TagMap 调用 `do_weak_oops` → 执行 GC 安全更新。

### 断言 6: Capability phase check

```
(gdb) break jvmtiManageCapabilities.cpp:add_capabilities
Breakpoint 6 at jvmtiManageCapabilities.cpp
(gdb) run
(gdb) print JvmtiEnv::get_phase()
$10 = 1   // JVMTI_PHASE_ONLOAD
(gdb) print current->can_redefine_classes
$11 = 0   // 尚未获取
(gdb) print desired->can_redefine_classes
$12 = 1   // agent 请求
(gdb) continue
→ add_capabilities 完成：can_redefine_classes 已获取
```

**验证点** (jvmtiManageCapabilities.hpp:71-74)：`add_capabilities` 在 OnLoad phase 中检查 `desired` 是否在 `onload_capabilities` 中，不在则返回错误。

### 断言 7: JvmtiEnvIterator 遍历

```
(gdb) break jvmtiExport.cpp:910
Breakpoint 7 at jvmtiExport.cpp:910 (post_all_envs)
(gdb) continue
(gdb) print it.first()
$13 = (JvmtiEnv *) 0x7fff...   // 第一个 JvmtiEnv
(gdb) print it.first()->is_retransformable()
$14 = false   // non-retransformable agent
(gdb) continue
→ 第一遍遍历完成（non-retransformable agents）
(gdb) print it.next(env)
$15 = (JvmtiEnv *) 0x7fff...   // 第二个 JvmtiEnv
```

**验证点** (jvmtiExport.cpp:910-932)：CFLH 两遍遍历——第一遍 `!env->is_retransformable()` 过滤 (jvmtiExport.cpp:916)，第二遍 `env->is_retransformable()` 过滤 (jvmtiExport.cpp:926)。

---

## §七 Cross-Reference

| 文档 | 关系 | 核心衔接点 |
|------|------|-----------|
| **01-Agent-Loading** | 上游 | JvmtiEnv 创建 (JPLISAgent 调用 GetEnv) + SetEventCallbacks 注册 |
| **02-ClassFileLoadHook** | 上游 | CFLH 事件通过 JvmtiExport::post_class_file_load_hook 调度，依赖本文的 recompute_enabled 门控 |
| **03-Attach-API** | 上游 | agentmain 通过 Attach API 创建新的 JvmtiEnv → 插入 _head_environment 链表 |
| **04-Redefine-Classes** | 上游 | RetransformClasses/RedefineClasses 依赖 JvmtiEnv::is_retransformable() 和 capability can_redefine_classes |
| **06-JDWP-Transport-Init** | 下游 | JDWP 调试协议在 JVMTI 之上构建——JDWP agent 也是一个 JvmtiEnv |
| **07-JDWP-Commands-Events** | 下游 | JDWP EventRequest 命令映射到 JVMTI SetEventNotificationMode，依赖本文的事件控制器 |

---

## §八 Writing Requirements 对照表

### 写作要求

1. **每个段落以 WHY 开头**。
2. **每个技术断言 3-5 行源码**。
3. **Mermaid** — JVMTI 架构分层图（4 层）。
4. **GDB session** — 7 个断点断言。
5. **7 个 Beginner callout 框**（§一 内，用 `> **` 块引用格式）。
6. **交叉引用** — §七 处。
7. **Story-format interview answer** — §一 末尾。
8. **"不要写成→应该写成" 对照表**：

| 不要写成 | 应该写成 |
|---------|---------|
| "JVMTI has 300+ functions" | "JvmtiEnv at jvmtiEnv.cpp declares 300+ functions generated from JVMTI specification XML via jvmtiEnter.xsl — each function skeleton includes phase check and capability check gates injected by XSLT code generation at jvmtiEnter.xsl:471-610" |
| "Events are enabled/disabled by agents" | "JvmtiEventControllerPrivate::recompute_enabled at jvmtiEventController.cpp:571 merges per-env, per-thread, and global event enables into a single 64-bit bitmask, then sets JvmtiExport::_should_post_* boolean gates — reducing the hot-path check to one bool read (~0.3ns)" |
| "JvmtiTagMap stores object tags" | "JvmtiTagMap::set_tag at jvmtiTagMap.cpp:739 stores (jobject, jlong) pairs in a hash map with JNI weak global references — weak_oops_do at jvmtiTagMap.cpp:3318 updates oop references when GC moves objects, and entries are removed when objects are collected" |
| "Capabilities control what agents can do" | "JvmtiManageCapabilities partitions capabilities into 4 groups: always_capabilities (no request needed), onload_capabilities (OnLoad or OnAttach), always_solo_capabilities (one env only), and onload_solo_capabilities (OnLoad + one env only) — add_capabilities at jvmtiManageCapabilities.hpp:71 checks the agent's current phase against the capability's group" |
| "JvmtiThreadState tracks per-thread state" | "JvmtiThreadState at jvmtiThreadState.hpp:77 is lazily allocated — JavaThread::jvmti_thread_state() returns NULL for threads never touched by an agent. It stores class_being_redefined, class_load_kind, event enables, and a JvmtiEnvThreadState linked list" |
