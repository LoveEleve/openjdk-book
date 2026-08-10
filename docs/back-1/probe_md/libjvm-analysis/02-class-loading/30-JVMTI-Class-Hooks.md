# JVMTI Class Hooks — APM/AOP/诊断的类加载入口

> 纯源码分析，基于 OpenJDK 11 slowdebug
> 源文件：`prims/jvmtiExport.cpp`(JvmtiClassFileLoadHookPoster) + `prims/jvmtiEventController.cpp` + `prims/jvmtiEnv.cpp`
> 方法论：程序 = 数据结构 + 算法

---

## 生产场景：APM Agent 升级后全类 VerifyError

```
你的 APM agent (NewRelic/Datadog/AppDynamics) 使用 ClassFileLoadHook 向每个方法
注入计时字节码。升级 agent 版本后，应用启动时所有类崩溃：

Exception in thread "main" java.lang.VerifyError: Expecting a stackmap frame
  at com.acme.UserService.<init>(UserService.java:15)
  ... (200+ similar errors)

根因：新版 agent 向字节码中插入了方法调用指令，但未更新 StackMapTable 帧。
Verifier 检查字节码时发现栈帧与 StackMapTable 声明不一致 → VerifyError。

没有一个错误消息提到 "agent" 或 "JVMTI" — 你只能在禁用 agent 后才能定位。
```

JVMTI 的 `ClassFileLoadHook` 是 **100% 的 APM (NewRelic/Datadog/AppDynamics)、AOP (AspectJ)、诊断 agent (BTrace/Byteman) 的入口点**。它在 ClassFileParser 之前拿到原始字节，可以任意修改。

---

## 一、3 个 Hook + 1 个回调注册

### 1.1 时间线：一个类从字节到就绪

```
Agent JAR 加载
  └─ Agent_OnLoad() → SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_CLASS_FILE_LOAD_HOOK)
  └─ 注册 3 个回调: ClassFileLoadHook / ClassLoad / ClassPrepare

类加载全流程 + JVMTI hooks:
┌──────────────────────────────────────────────────────────────────────┐
│ 1. SystemDictionary::load_instance_class()                           │
│      └─ ClassLoader::load_class() → 读取 .class 字节                  │
│         └─ ★ ClassFileLoadHook: post_all_envs()                      │
│            → 所有注册 agent 收到原始 byte[]                            │
│            → agent 可修改/替换 → 修改后的 byte[] 传给 ClassFileParser  │
│                                                                      │
│ 2. ClassFileParser::parseClassFile()                                 │
│      └─ 使用★可能已被修改★的字节解析                                   │
│                                                                      │
│ 3. InstanceKlass::link_class_impl()                                  │
│      └─ verify → prepare → resolve(惰性)                             │
│                                                                      │
│ 4. ★ ClassLoad: post_class_load()                                    │
│      └─ Agent 收到: 类已成功加载                                       │
│                                                                      │
│ 5. ★ ClassPrepare: post_class_prepare()                              │
│      └─ Agent 收到: 类已链接完成，可用于 instrumentation               │
│      └─ Agent 可在此添加 breakpoint / 修改字节码 / 安装 MethodEntry     │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 3 个 Hook 的精确时机

| Hook | 触发时机 | 用途 | 源码位置 |
|------|---------|------|---------|
| **ClassFileLoadHook** | ClassLoader 读取 bytes 后，ClassFileParser 解析前 | ★ 字节码修改（APM/AOP 核心）| `jvmtiExport.cpp:836` |
| **ClassLoad** | 类加载成功（InstanceKlass 创建完成）| 统计/监控类加载量 | `jvmtiEventController.cpp` |
| **ClassPrepare** | 链接完成，类可接受 instrumentation | ★ 添加断点/MethodEntry | `jvmtiEventController.cpp` |

### 1.3 回调注册：ClassLoadCallbackHandler

Agent 在 `Agent_OnLoad()` 中注册回调：

```cpp
// Agent 侧（libinstrument.so 抽象）:
jvmtiError JvmtiEnv::SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_CLASS_FILE_LOAD_HOOK, NULL);

// JVMTI 内部：jvmti.cpp:90
struct JvmtiEventCallbacks {
  jvmtiEventClassFileLoadHook ClassFileLoadHook;  // ★ 字段名
  jvmtiEventClassLoad         ClassLoad;
  jvmtiEventClassPrepare      ClassPrepare;
  jvmtiEventVMInit            VMInit;
  jvmtiEventVMDeath           VMDeath;
  // ... 共 ~30 个事件回调
};
```

---

## 二、ClassFileLoadHook — 字节码转换协议

### 2.1 数据结构：JvmtiClassFileLoadHookPoster

文件：`prims/jvmtiExport.cpp:836`

```cpp
class JvmtiClassFileLoadHookPoster : public StackObj {
  Symbol*            _h_name;                     // 类名 ("java/lang/String")
  Handle             _class_loader;               // 加载器
  Handle             _h_protection_domain;
  unsigned char**    _data_ptr;                   // ★ 字节码指针的指针（可被替换）
  unsigned char**    _end_ptr;                    // ★ 结束指针的指针
  jint               _curr_len;                   // 当前字节码长度
  unsigned char*     _curr_data;                  // ★ 当前字节码数据
  JvmtiCachedClassFileData** _cached_class_file_ptr; // 原始字节码缓存（retransform用）
  Klass*             _class_being_redefined;      // retransform场景的类
  JvmtiClassLoadKind _load_kind;                  // load/redefine/retransform
  bool               _has_been_modified;          // ★ 是否有 agent 修改了字节码

  void post();            // 入口：post_all_envs() + copy_modified_data()
  bool has_been_modified();
};
```

### 2.2 协议：Agent 如何修改字节码

Agent 在 `ClassFileLoadHook` 回调中收到：

```c
// JNI层协议（jvmti.h）
typedef void (JNICALL *jvmtiEventClassFileLoadHook)
  (jvmtiEnv *jvmti_env,
   JNIEnv* jni_env,
   jclass class_being_redefined,    // retransform时非NULL
   jobject loader,                  // 加载器（NULL=Bootstrap）
   const char* name,                // 类名 ("java/lang/String")
   jobject protection_domain,
   jint class_data_len,             // ★ 传入字节码长度
   const unsigned char* class_data, // ★ 传入字节码数据
   jint* new_class_data_len,        // ★ Agent输出：新字节码长度
   unsigned char** new_class_data); // ★ Agent输出：新字节码数据
```

**Agent 修改/不修改的 3 种返回**：

| 操作 | new_class_data_len | new_class_data | 效果 |
|------|:---:|------|------|
| **不修改** | 不设置 | 不设置(NULL) | 原字节码不变，传给下一个 agent |
| **替换** | =新长度 | =新 byte[] | ★ 原字节码被替换 |
| **缓存(仅retransform)** | 不设置 | 不设置 | JVM 自动缓存原字节码 |

```cpp
// 标准修改流程（Agent侧）:
unsigned char* modified_data = (unsigned char*)jvmti_env->Allocate(new_len);
memcpy(modified_data, class_data, class_data_len);  // 拷贝原始字节
inject_timing_code(modified_data, new_len);          // 注入字节码
*new_class_data_len = new_len;
*new_class_data = modified_data;                    // ★ 返回修改后字节码
return JVMTI_ERROR_NONE;
```

### 2.3 post_all_envs() — 多 Agent 分发机制

```cpp
void JvmtiClassFileLoadHookPoster::post_all_envs() {
  // 第一轮：非 retransformable agents（如 premain agent）
  //   这些agent不使用retransform，不需要缓存原始字节码
  if (_load_kind != jvmti_class_load_kind_retransform) {
    for (JvmtiEnv* env : all_non_retransformable_environments) {
      if (env->is_enabled(CLASS_FILE_LOAD_HOOK))
        post_to_env(env, false);  // caching_needed=false
    }
  }

  // 第二轮：retransformable agents（如 agentmain agent）
  //   这些agent需要缓存原始字节码用于后续 retransform
  for (JvmtiEnv* env : all_retransformable_environments) {
    if (env->is_enabled(CLASS_FILE_LOAD_HOOK))
      post_to_env(env, true);   // caching_needed=true
  }
}
```

**设计要点**：
- 多个 agent 按注册顺序串行调用，每个 agent 收到的是上一个 agent 修改后的字节码
- retransformable agent 第二轮调用，非 retransformable 第一轮 — 保证 retransform 时能还原到正确版本
- 每个 agent 修改后 `_has_been_modified = true`，原始字节码被缓存到 `_cached_class_file_ptr`

---

## 三、ClassLoad / ClassPrepare — 类加载就绪通知

### 3.1 ClassLoad — 加载成功通知

```cpp
// prims/jvmtiEventController.cpp — JvmtiEventController::post_class_load()
void post_class_load(Klass* klass) {
  // JFR event: jdk.ClassLoad
  // 向所有注册 ClassLoad 事件的 agent 发送通知
  // agent 可以记录: class_name、loader、timestamp
}
```

**jcmd 内部实现**（`jcmd VM.classloader_stats`）：
- 读取 `ClassLoaderDataGraph::_head` 遍历所有 CLD
- 对于每个 CLD，统计 `_klasses` 链表长度 = 加载的类数
- 累加每个 CLD 的 `_class_count` — 这与 ClassLoad 事件记录的数据同源

### 3.2 ClassPrepare — 链接完成通知

```cpp
// prims/jvmtiEventController.cpp
void post_class_prepare(InstanceKlass* klass) {
  // 此时 klass 已链接完成：
  //   - _init_state >= linked(2)
  //   - vtable/itable 已构建
  //   - 方法入口 (_from_interpreted_entry) 已设置
  // Agent 可以安全地:
  //   - GetClassMethods()  → 遍历所有方法
  //   - SetBreakpoint()     → 在方法入口设断点
  //   - SetEventNotificationMode(JVMTI_EVENT_METHOD_ENTRY) → 开始追踪
}

// 时间线补充（ClassPrepare ≠ ClassLoad）:
// ClassLoad:  InstanceKlass 创建完成（State=loaded）
//             方法字节码已解析但 vtable/itable 未构建
// ClassPrepare: 链接完成（State=linked）
//              ★ 此时类"可用" — Agent 可安全地 instrumentation
```

---

## 四、生产陷阱与诊断

### 4.1 Agent 修改字节码导致 VerifyError

**症状**：
- Agent 升级后全类 VerifyError
- 错误消息只提到类名和方法，无 agent 相关信息
- 禁用 agent 后问题消失

**根因**：Agent 向字节码插入了指令但未更新 StackMapTable，或者新增了跳转但未添加对应的 stack_map_frame。

**诊断步骤**：
```bash
# Step 1: 确认是 agent 问题
java -cp app.jar Main 2>&1                              # 无 agent 启动 → 正常
java -javaagent:apm.jar -cp app.jar Main 2>&1           # 带 agent → VerifyError

# Step 2: 追踪类加载
java -javaagent:apm.jar -Xlog:class+load=debug -cp app.jar Main 2>&1 | head -50
# 观察: [class,load] ... source: __JVM_DefineClass__  ← agent 用 redefine 加载

# Step 3: 保存 agent 修改后的字节码
java -javaagent:apm.jar -XX:+TraceClassLoading \
     -XX:+UnlockDiagnosticVMOptions -XX:+PrintClassHistogram \
     -cp app.jar Main 2>&1 | grep "com.acme.UserService"

# Step 4: 用 javap 反编译查看修改后的字节码
javap -c -verbose -p UserService.class
# 检查 StackMapTable: 是否每个跳转目标都有对应的 stack_map_frame？
```

### 4.2 多 Agent 字节码修改冲突

```
顺序: Agent A → Agent B → ClassFileParser

Agent A 向每个方法开头添加:  aload_0; invokestatic #N (AgentA.traceEntry())
Agent B 向每个方法开头添加:  invokestatic #M (AgentB.logTiming())
结果字节码:  aload_0; invokestatic #N; invokestatic #M;  ← 两个 agent 按序叠加

如果 Agent B 的字节码修改错误：
  → 错误可能来自 Agent A(正确) 或 Agent B(损坏)
  → 隔离方法: 禁用 Agent A, 只保留 Agent B → 确认谁出错
```

### 4.3 ClassFileLoadHook 性能开销

| 操作 | 开销 | 优化 |
|------|:---:|------|
| 每个类都触发回调 | ~1μs/class (空回调) | 代理侧立即按包名过滤 return |
| 字节码修改 | ~500μs-5ms/class | 只修改目标类（注解/模式匹配） |
| 原始字节码缓存 | ~2KB/class 内存 | retransform agent 必须承担 |

**生产建议**：`-XX:+TraceClassLoading` 统计每类加载时间，找出 agent 开销。

---

## 五、总结

### 数据结构
- **JvmtiClassFileLoadHookPoster**(StackObj)：单个类加载事件的发布器 — `post_all_envs()` 按 retransformable 分两轮调用所有 agent
- **JvmtiEventCallbacks**：每个 JvmtiEnv 的回调表 — `ClassFileLoadHook` 函数指针存储 agent 注册的回调
- **JvmtiCachedClassFileData**：原始字节码缓存 — retransform agent 恢复原始类时使用

### 算法
- **多 Agent 串行链**：每个 agent 修改输出 → 下一个 agent 的输入 — 修改顺序 = 注册顺序
- **两轮分发**：非 retransformable 先 → retransformable 后 — 保证原始字节码缓存在第二轮
- **3 Hook 时间线**：ClassFileLoadHook(parser前) → ClassLoad(加载后) → ClassPrepare(链接后，可 instrumentation)

---

## 可证伪断言

| # | 断言 | 验证 | 预期 |
|---|------|------|:---:|
| 1 | `JvmtiClassFileLoadHookPoster` 在 `jvmtiExport.cpp:836` | 源码 | L836 |
| 2 | `post_all_envs()` 分两轮：非 retransformable → retransformable | 源码 | 两轮 for 循环 |
| 3 | Agent 修改字节码通过 `new_class_data_len`/`new_class_data` 输出 | 源码 | callback 签名 |
| 4 | `ClassPrepare` 在类链接完成后触发 | 源码 | linked state |
| 5 | Agent 字节码修改错误 → VerifyError（无 agent 提示） | 源码 | ClassFileParser 无感知修改来源 |
