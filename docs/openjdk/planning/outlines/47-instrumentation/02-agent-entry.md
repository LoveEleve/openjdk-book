# 02. redefine + retransform + 重入保护 — 运行时字节码修改

> 🟡 Working | redefineClasses(已加载类) + retransformClasses(重新触发transform) + Reentrancy
> 读者处境: 不是所有 agent 在 premain 时注册——`VirtualMachine.loadAgent(agentJar)` 在运行时动态 attach agent→调 agentmain。`instrumentation.redefineClasses(classDef)` 直接在内存中替换已加载类的字节码。`retransformClasses` 重新触发所有注册 transformer 的 transform 链——用于"applicator"型 agent(如 APM 在方法中插入计时)。

### 1. "redefineClasses vs retransformClasses"

场景: 生产 JVM 需要热修复(无需重启)→`Instrumentation.redefineClasses(new ClassDefinition(MyClass.class, newBytes))`→JVMTI RedefineClasses→JVM 在 safepoint 替换类的字节码→不改变已存在对象(但影响新方法调用)。

**redefineClasses + retransformClasses** (`InstrumentationImplNativeMethods.c:50-120 + JVMTI`):
```
redefineClasses(classDefs[]):
  → JVMTI: jvmtiEnv->RedefineClasses(num, classDefs)
  → JVM in safepoint: 每个 class redefine:
      • 替换 constant pool + method bytecodes + field layout
      • 不改变 object instances(已存在对象保持原类)
      • 新方法调用使用新 bytecode——旧方法(如果删了)→NoSuchMethodError
      • 限制: 不能添加/删除/修改字段, 不能修改 class hierarchy(超类/接口/签名)
  → JVMTI: ClassFileLoadHook NOT triggered(直接替换, 不经过 transformer)

retransformClasses(classes[]):
  → JVMTI: jvmtiEnv->RetransformClasses(num, classes)
  → JVM in safepoint: 从原始 bytecode 开始
  → 依次调所有 registered transformers(按 registration 顺序):
      t1.transform(original) → modified1
      t2.transform(modified1) → modified2
      t3.transform(modified2) → final bytecode
  → JVM 用 final bytecode redefine class
[C++: InstrumentationImplNativeMethods.c:189行——redefine 不触发 ClassFileLoadHook, retransform 触发所有 transformer]
```
- 源码: `InstrumentationImplNativeMethods.c:50-100` (redefineClasses native) + `InstrumentationImplNativeMethods.c:100-160` (retransformClasses native)

- 关键设计: **redefine vs retransform 的根本区别** — redefine 直接用新的 bytecode(不经过 transformer)——适合热修复(已知新 bytecode 内容)。retransform 从原始 bytecode 重新触发所有 transformer——适合"applicator" agent(如 APM 每次 class load 自动插入方法计时)——用户不需要提供新 bytecode——agent 的 transformer 产生。**redefine 的限制** — 不能改类结构(字段/超类/接口)——只能改变方法体——因为 JVM 在 safepoint 中 redefine 没有时间重新计算 object layout。

### 2. "premain vs agentmain — 两种入口"

场景: `-javaagent:agent.jar` → `premain(agentArgs, inst)` 在 main 之前。`VirtualMachine.loadAgent(agentJar)` → `agentmain(agentArgs, inst)` 在运行时。

**AgentMain 动态加载** (`InvocationAdapter.c:250-400`):
```
agentmain load:
  → Attach API(域36): jdk.attach.VirtualMachine.loadAgent(pid, agentJar)
  → target JVM: Attach Listener receive → loadAgent
  → InvocationAdapter → createNewJPLISAgent(vm, &agent) (same as premain)
  → MANIFEST: getAttribute("Agent-Class") (vs premain 用 "Premain-Class")
  → load class → call agentmain(String agentArgs, Instrumentation inst)
  → after agentmain: agent can redefineClasses/retransformClasses already-loaded classes
[C++: InvocationAdapter.c:250-400——agentmain 和 premain 共用同一套 JPLISAgent 初始化——仅 MANIFEST 属性名不同]
```
- 源码: `InvocationAdapter.c:250-350` (agentmain entry → MANIFEST Agent-Class) + `InvocationAdapter.c:350-400` (agentmain → JNI call)

- 关键设计: **agentmain 可以操作已加载类** — premain 时还没有 app class→只能注册 transformer 等未来类。agentmain 时所有 app class 已加载→可以 `retransformClasses` 所有已加载类→重新触发 transform→用调用 `redefineClasses` 热修复。

### 3. "Reentrancy — 防止递归"

场景: Agent A transform→trigger classify→JVM defineClass→ClassFileLoadHook→Agent B transform→Agent B 内调 redefineClasses→又触发 Agent A transform→死循环！

**Reentrancy 保护** (`Reentrancy.c:47-110`):
```
checkReentrancy(jvmtiEnv, thread):
  → (*jvmtiEnv)->GetThreadLocalStorage(jvmtiEnv, thread, &data) — 读 JVMTI TLS
  → if data != NULL → 已在 agent 中→return true(递归检测)
  → (*jvmtiEnv)->SetThreadLocalStorage(thread, (void*)1) → 标记"inside agent"
  → return false(首次进入)

releaseReentrancy(jvmtiEnv, thread):
  → confirmingTLSSet(jvmtiEnv, thread, NULL) → 清空 TLS→释放重入令牌

在每个 transformer entry 调用点:
  if (checkReentrancy(jvmtiEnv, thread)) → return NULL(skip transform)
  ... do transform ...
  releaseReentrancy(jvmtiEnv, thread)
[C++: Reentrancy.c:165行——用 JVMTI thread-local storage 做 per-thread 重入检测——非全局锁——不同线程可并行执行]
```
- 源码: `Reentrancy.c:50-100` (tryToAcquireReentrancyToken) + `Reentrancy.c:100-150` (releaseReentrancyToken)

- 关键设计: **per-thread TLS(不是全局锁)** — 每个线程在自己的 JVMTI thread-local storage 中存一个 bit: 0=在 agent 外, 1=在 agent 内(处理中)。同一 agent 的不同线程可并行(各自 TLS 独立)——只有同一线程的递归调用被阻止。`confirmingTLSSet` 在 set 后 re-fetch 验证(针对 JVMTI TLS set-to-0 的已知 bug——某些 JVMTI 实现 failed to set NULL)。**重入→return NULL(skip transform)** — 不是 crash 或 throw——agent 的 transformer 在重入时无声跳过——不干扰 class loading。

---

### 核心悬念

**"redefineClasses(JVMTI RedefineClasses→直接替换bytecode不经过transformer)→retransformClasses(原始bytecode→all transformers chain→final bytecode)。premain(-javaagent before main)→agentmain(VirtualMachine.loadAgent runtime→可操作已加载类)。Reentrancy: per-agent token→递归检测→跳过transform。"** — 下一篇: 域48 Utilities。

> → 域48 Utilities
