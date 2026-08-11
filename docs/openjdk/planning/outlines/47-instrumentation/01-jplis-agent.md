# 01. JPLIS Agent → JVMTI ClassFileLoadHook — bytecode 转换管道

> 🔴 Deep | -javaagent → JVMTI → transform
> 读者处境: `java -javaagent:myagent.jar -jar app.jar` — JVM 在 main 之前创建 JPLISAgent→获取 JVMTI env→注册 ClassFileLoadHook→每次 `ClassLoader.defineClass`→JVMTI 回调→agent transform()→修改 bytecode→JVM load modified bytes。**整个 APM/Profiler/Spring AOP ecosystem 的基础——没有这个管道就没有 bytecode manipulation**。

### 1. "JPLISAgent 初始化 — JVMTI env + ClassFileLoadHook"

场景: JVM 启动→`JPLISAgent_OnLoad`→createNewJPLISAgent→acquire JVMTI env→set event callbacks→ClassFileLoadHook→register callback→后续所有 defineClass 都触发 transform。

**Agent 初始化** (`InvocationAdapter.c:149-250 + JPLISAgent.c:200-500`):
```
createNewJPLISAgent(vm, &agent) (InvocationAdapter.c:149):
  → 分配 JPLISAgent 结构 + 初始化各字段
  → (*vm)->GetEnv(vm, (void**)&jvmti, JVMTI_VERSION) → acquire JVMTI env
  → addCapabilities(agent) → enable ClassFileLoadHook + redefine/retransform
  → setEventCallbacks: VMInit, VMDeath, ClassFileLoadHook (JPLISAgent.c:306)

ClassFileLoadHook callback:
  → JVMTI event: jvmtiEventClassFileLoadHook(jvmti, jni, class_being_redefined,
         loader, name, protection_domain, class_data_len, class_data,
         new_class_data_len, new_class_data)
  → JPLISAgent::transformClassFile → call Java agent's transform() (JNI)
  → return modified bytecode (new_class_data)
[C++: JPLISAgent.c:1604行——JPLIS = Java Programming Language Instrumentation Services——Wily Technology 2003 贡献]
```
- 源码: `InvocationAdapter.c:149-200` (createNewJPLISAgent→JVMTI env) + `JPLISAgent.c:306-320` (setEventCallbacks→ClassFileLoadHook)

- 关键设计: **JVMTI ClassFileLoadHook 是 JVMTI 事件 62** — 在 ClassLoader.defineClass 的 `JVM_DefineClass` 中触发——时机在字节码解析**之前**——agent 收到的 `class_data` 是原始 .class 字节。**返回 NULL 表示"不修改"** — agent 可以 skip transform→null→JVM 用原始字节。**Can-Retransform-Classes MANIFEST attribute** — agent 声明此能力→JVM 用 `retransformableEnvironment`(有 retransform capability) 绑定到 agent。

### 2. "premain → Java agent class"

场景: JPLISAgent 创建后→解析 agent JAR→META-INF/MANIFEST.MF→Premain-Class→load class→call `premain(String agentArgs, Instrumentation inst)`→agent 中 register transformer→JVM continue→main。

**premain 调用** (`InvocationAdapter.c:155-230`):
```
loadAgentAndCallPremain(agent, jarfile):
  → JarFacade: open jar→read MANIFEST.MF→getAttribute("Premain-Class") (line 183)
  → addToSystemClassLoaderSearch→append agent jar to classpath
  → FindClass(premainClass)→LoadClass→getMethod("premain", "(Ljava/lang/String;Ljava/lang/instrument/Instrumentation;)V")
  → CallStaticVoidMethod(premain, agentArgs, instrumentationObject) → Java agent code executes
  → agent 在 premain() 中调 inst.addTransformer(new MyTransformer())
  → 返回 C→JVM 继续→main() 调用
[C++: InvocationAdapter.c:155-230——Java agent 类加载后 premain 执行——与 main() 在同一个 JVM invocation 中]
```
- 源码: `InvocationAdapter.c:155-200` (loadAgent→MANIFEST parse) + `InvocationAdapter.c:200-230` (premain → JNI call)

- 关键设计: **agent JAR 也在 system class loader 的搜索路径** — `addToSystemClassLoaderSearch`(agent jar)→agent 类和 app class 使用同一个 ClassLoader→agent 可以访问 app 的类(反之不行——app 不能依赖 agent)。**premain 在 main 之前** — `JPLISAgent_OnLoad` 在 JVM 的 `LoadMainClass` 之前执行→agent 可以在任何 app class 加载前注册 transformer。

---

### 核心悬念

**"JPLISAgent: createNewJPLISAgent→JVMTI env→ClassFileLoadHook callback→loadAgent→MANIFEST Premain-Class→premain→register transformer→every defineClass→JVMTI ClassFileLoadHook→agent.transform()→modified bytecode。所有 Java agent 的基石——APM/Profiler/Spring AOP/Byte Buddy/ASM。"** — 下一篇: redefine/retransform + 重入保护。

> → [02-agent-entry.md](02-agent-entry.md)
