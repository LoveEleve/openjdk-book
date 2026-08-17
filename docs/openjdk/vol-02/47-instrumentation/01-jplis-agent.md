# 01. JPLIS Agent → JVMTI ClassFileLoadHook — bytecode 转换管道

> **前置依赖**:[28-jvmti/01 — JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md):JVMTI environment、capability 与 event callback;[40-launcher/01 — java MyApp 在命令行后发生了什么事？— 启动流程](openjdk/vol-02/40-launcher/01-launch-flow.md):`-javaagent` 进入 JVM 前的 launcher 链路;[36-attach/02 — 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](openjdk/vol-02/36-attach/02-jdk-attach.md):`agentmain` 的 attach 入口
> → **后续**:[47-instrumentation/02 — redefine/retransform + 重入保护](02-agent-entry.md)
> 关联域: 28-jvmti(ClassFileLoadHook)、27-jni(native/Java 桥)、16-classloading(defineClass)

`-javaagent:myagent.jar` 看起来是 Java API,底层却由一个原生 JVMTI agent 托起来。JDK 把这层桥称为 **JPLIS**(Java Programming Language Instrumentation Services):原生 `libinstrument` 读取 agent JAR manifest,创建 `JPLISAgent` 和 JVMTI environment,等 VMInit 后创建 Java `InstrumentationImpl`,调用 agent 的 `premain`,再通过 `ClassFileLoadHook` 把每次类文件字节交给 Java transformer。

真正的链路不是大纲里的“OnLoad 直接启用 ClassFileLoadHook”。JDK 11 分两阶段:

1. OnLoad 阶段只创建 agent、解析 manifest、记录 premain 数据并启用 VMInit;
2. VMInit 阶段才创建 `InstrumentationImpl`、安装 ClassFileLoadHook、调用 premain。

---

## 1. `Agent_OnLoad` — 先解析 JAR,不立即调用 premain

### 每个 `-javaagent` 都创建独立 JPLISAgent

`DEF_Agent_OnLoad`(InvocationAdapter.c:131-149):

```c
// InvocationAdapter.c:131-149(截取核心,逐字)
/*
 *  This will be called once for every -javaagent on the command line.
 *  Each call to Agent_OnLoad will create its own agent and agent data.
 *
 *  The argument tail string provided to Agent_OnLoad will be of form
 *  <jarfile>[=<options>]. The tail string is split into the jarfile and
 *  options components. The jarfile manifest is parsed and the value of the
 *  Premain-Class attribute will become the agent's premain class.
 */
JNIEXPORT jint JNICALL
DEF_Agent_OnLoad(JavaVM *vm, char *tail, void * reserved) {
    JPLISInitializationError initerror  = JPLIS_INIT_ERROR_NONE;
    jint                     result     = JNI_OK;
    JPLISAgent *             agent      = NULL;

    initerror = createNewJPLISAgent(vm, &agent);
```

一条 `-javaagent` 对应一次 OnLoad,也对应一份独立 agent 数据。`tail` 的文本格式就是:

`agent.jar[=options]`

`parseArgumentTail` 把 jar 路径和 options 分开;options 不存在时是 `NULL`,不是空字符串。

### `createNewJPLISAgent`: 从 JavaVM 取 JVMTI 1.1 environment

`createNewJPLISAgent`(JPLISAgent.c:204-223):

```c
// JPLISAgent.c:204-223(截取核心,逐字)
JPLISInitializationError
createNewJPLISAgent(JavaVM * vm, JPLISAgent **agent_ptr) {
    JPLISInitializationError initerror       = JPLIS_INIT_ERROR_NONE;
    jvmtiEnv *               jvmtienv        = NULL;
    jint                     jnierror        = JNI_OK;

    *agent_ptr = NULL;
    jnierror = (*vm)->GetEnv(  vm,
                               (void **) &jvmtienv,
                               JVMTI_VERSION_1_1);
    if ( jnierror != JNI_OK ) {
        initerror = JPLIS_INIT_ERROR_CANNOT_CREATE_NATIVE_AGENT;
    } else {
        JPLISAgent * agent = allocateJPLISAgent(jvmtienv);
        if ( agent == NULL ) {
            initerror = JPLIS_INIT_ERROR_ALLOCATION_FAILURE;
        } else {
            initerror = initializeJPLISAgent(  agent,
                                               vm,
                                               jvmtienv);
```

这里没有自己构造 JVMTI 函数表,而是调用 `JavaVM::GetEnv(..., JVMTI_VERSION_1_1)` 拿 environment。随后用 JVMTI allocator 分配 `JPLISAgent`,再初始化 native 状态。

---

## 2. manifest — Premain-Class、Boot-Class-Path 与 capability

### OnLoad 读取 Premain-Class

InvocationAdapter.c:158-186 的关键逻辑是:

```c
// InvocationAdapter.c:158-186(截取核心,逐字)
        /*
         * Parse <jarfile>[=options] into jarfile and options
         */
        if (parseArgumentTail(tail, &jarfile, &options) != 0) {
            fprintf(stderr, "-javaagent: memory allocation failure.\n");
            return JNI_ERR;
        }
...
        attributes = readAttributes(jarfile);
        if (attributes == NULL) {
            fprintf(stderr, "Error opening zip file or JAR manifest missing : %s\n", jarfile);
            free(jarfile);
            if (options != NULL) free(options);
            return JNI_ERR;
        }

        premainClass = getAttribute(attributes, "Premain-Class");
        if (premainClass == NULL) {
            fprintf(stderr, "Failed to find Premain-Class manifest attribute in %s\n",
                jarfile);
```

因此 `Premain-Class` 缺失不是“agent 不生效但应用继续”,而是 OnLoad 初始化失败。JVM 启动最终会被中止。

### manifest capability 映射到 JVMTI 能力

`convertCapabilityAttributes`(InvocationAdapter.c:104-129):

```c
// InvocationAdapter.c:104-129(截取核心,逐字)
void
convertCapabilityAttributes(const jarAttribute* attributes, JPLISAgent* agent) {
    /* set redefineClasses capability */
    if (getBooleanAttribute(attributes, "Can-Redefine-Classes")) {
        addRedefineClassesCapability(agent);
    }

    /* create an environment which has the retransformClasses capability */
    if (getBooleanAttribute(attributes, "Can-Retransform-Classes")) {
        retransformableEnvironment(agent);
    }

    /* set setNativeMethodPrefix capability */
    if (getBooleanAttribute(attributes, "Can-Set-Native-Method-Prefix")) {
        addNativeMethodPrefixCapability(agent);
    }

    /* for retransformClasses testing, set capability to use original method order */
    if (getBooleanAttribute(attributes, "Can-Maintain-Original-Method-Order")) {
        addOriginalMethodOrderCapability(agent);
    }
}
```

`Can-Retransform-Classes` 不是简单 boolean 字段。为它开启时,JPLIS 会准备一个具备 retransform capability 的独立 environment,后续可重转换 transformer 与普通 transformer 分流。下一篇再拆这层。

### Boot-Class-Path 和 premain 数据只在 OnLoad 记录

OnLoad 还会处理 `Boot-Class-Path`,再调用 `recordCommandLineData(agent, premainClass, options)` 把 agent 类名和参数拷进 native agent。此时 **Java agent class 尚未加载,premain 也尚未执行**。OnLoad 只是把 VMInit 阶段需要的数据准备好。

---

## 3. 初始化阶段 — OnLoad 只装 VMInit callback

### `initializeJPLISAgent` 先区分 ONLOAD/LIVE phase

`initializeJPLISAgent`(JPLISAgent.c:280-310):

```c
// JPLISAgent.c:280-310(截取核心,逐字)
    jvmtierror = (*jvmtienv)->SetEnvironmentLocalStorage(
                                            jvmtienv,
                                            &(agent->mNormalEnvironment));
...
    jvmtierror = (*jvmtienv)->GetPhase(jvmtienv, &phase);
...
    if (phase == JVMTI_PHASE_LIVE) {
        return JPLIS_INIT_ERROR_NONE;
    }

    if (phase != JVMTI_PHASE_ONLOAD) {
        return JPLIS_INIT_ERROR_FAILURE;
    }

    /* now turn on the VMInit event */
    if ( jvmtierror == JVMTI_ERROR_NONE ) {
        jvmtiEventCallbacks callbacks;
        memset(&callbacks, 0, sizeof(callbacks));
        callbacks.VMInit = &eventHandlerVMInit;

        jvmtierror = (*jvmtienv)->SetEventCallbacks( jvmtienv,
                                                     &callbacks,
                                                     sizeof(callbacks));
```

这是对大纲最重要的纠偏: **OnLoad 时 callback table 里先放的是 VMInit,不是 ClassFileLoadHook。** 如果 agent 在 LIVE phase 动态创建,就不再等 VMInit;如果是正常 `-javaagent` ONLOAD phase,则启用 VMInit 事件。

### VMInit 时才把 agent JAR 加到 system class path

`eventHandlerVMInit`(InvocationAdapter.c:586-623)先取 environment,随后 `appendClassPath(agent, agent->mJarfile)`,把 agent JAR 加到 system class loader 搜索路径,然后调用 `processJavaStart`。

这也修正了一个常见过度推断:agent JAR 加到 system class path 意味着 agent 类能由 system loader 找到,**不等于应用类天然可以依赖 agent 内部类型**。模块边界、类加载时序和可见性仍然会约束双向访问。

---

## 4. VMInit → InstrumentationImpl → premain

### `processJavaStart` 的真实顺序

`processJavaStart`(JPLISAgent.c:382-421):

```c
// JPLISAgent.c:382-421(截取核心,逐字)
jboolean
processJavaStart(   JPLISAgent *    agent,
                    JNIEnv *        jnienv) {
    jboolean    result;
...
    if ( result ) {
        result = createInstrumentationImpl(jnienv, agent);
        jplis_assert_msg(result, "instrumentation instance creation failed");
    }

    if ( result ) {
        result = setLivePhaseEventHandlers(agent);
        jplis_assert_msg(result, "setting of live phase VM handlers failed");
    }

    if ( result ) {
        result = startJavaAgent(agent, jnienv,
                                agent->mAgentClassName, agent->mOptionsString,
                                agent->mPremainCaller);
```

顺序是:

1. 创建 Java `InstrumentationImpl`;
2. 把 callback 切到 live phase handler;
3. 调用 Java agent 的 premain。

因此 agent 在 premain 里调用 `inst.addTransformer(...)` 时,Instrumentation 对象和 native hook 基础设施已经准备好。

### Java 侧维护两套 transformer manager

`InstrumentationImpl.addTransformer`(InstrumentationImpl.java:82-105):

```java
// InstrumentationImpl.java:82-105(截取核心,逐字)
    public void
    addTransformer(ClassFileTransformer transformer) {
        addTransformer(transformer, false);
    }

    public synchronized void
    addTransformer(ClassFileTransformer transformer, boolean canRetransform) {
        if (transformer == null) {
            throw new NullPointerException("null passed as 'transformer' in addTransformer");
        }
        if (canRetransform) {
            if (!isRetransformClassesSupported()) {
                throw new UnsupportedOperationException(
                  "adding retransformable transformers is not supported in this environment");
            }
            if (mRetransfomableTransformerManager == null) {
                mRetransfomableTransformerManager = new TransformerManager(true);
            }
            mRetransfomableTransformerManager.addTransformer(transformer);
            if (mRetransfomableTransformerManager.getTransformerCount() == 1) {
                setHasRetransformableTransformers(mNativeAgent, true);
            }
        } else {
            mTransformerManager.addTransformer(transformer);
```

普通 transformer 和可重转换 transformer 并不混在一个 list。Java 侧 manager 分开,native 侧 environment 也分开。第一个 transformer 加入时,Java 会通过 native 方法告诉 JPLIS“现在确实有 transformer”,让 hook 按需启用。

---

## 5. ClassFileLoadHook — native callback 再回调 Java transform

### callback 先保存 pending exception

`eventHandlerClassFileLoadHook`(InvocationAdapter.c:625-656):

```c
// InvocationAdapter.c:625-656(截取核心,逐字)
void JNICALL
eventHandlerClassFileLoadHook(  jvmtiEnv *              jvmtienv,
                                JNIEnv *                jnienv,
                                jclass                  class_being_redefined,
                                jobject                 loader,
                                const char*             name,
                                jobject                 protectionDomain,
                                jint                    class_data_len,
                                const unsigned char*    class_data,
                                jint*                   new_class_data_len,
                                unsigned char**         new_class_data) {
    JPLISEnvironment * environment  = NULL;

    environment = getJPLISEnvironment(jvmtienv);

    /* if something is internally inconsistent (no agent), just silently return without touching the buffer */
    if ( environment != NULL ) {
        jthrowable outstandingException = preserveThrowable(jnienv);
        transformClassFile( environment->mAgent,
                            jnienv,
                            loader,
                            name,
                            class_being_redefined,
                            protectionDomain,
                            class_data_len,
                            class_data,
                            new_class_data_len,
                            new_class_data,
                            environment->mIsRetransformer);
        restoreThrowable(jnienv, outstandingException);
    }
}
```

ClassFileLoadHook 收到原始 class bytes 和可选的 `class_being_redefined`,再把它们交给 `transformClassFile`.callback 会先保存当前 pending exception,转换结束后恢复,避免 instrumentation 覆盖被插桩线程原本的异常状态。

### 返回 null 和返回新 bytes 的差别

Java `ClassFileTransformer.transform` 返回:

- `null`:不修改,继续使用当前 class bytes;
- `byte[]`:JPLIS 通过 `new_class_data_len/new_class_data` 把新字节交还 JVMTI/VM。

ClassFileLoadHook 发生在 VM 解析/定义最终 class 之前,所以 transformer 修改的是“准备被定义的 classfile bytes”,不是已解析后的 Klass 内存结构。已加载类则要走 redefine/retransform,那是下一篇的主题。

---

## 核心悬念

**JPLIS 是 Java Instrumentation API 与 JVMTI 的双向桥:** `-javaagent` 先在 OnLoad 创建 native agent、解析 manifest、启用 VMInit;VMInit 再创建 `InstrumentationImpl`、安装 live hook、调用 premain;premain 注册 transformer 后,每次 ClassFileLoadHook 都经 native callback 回到 Java transform,返回的新 byte[] 再交回 VM。**下一篇继续拆 redefine/retransform 与重入保护:** 已加载类如何重新过 transformer,为什么普通 transformer 和 retransformable transformer 必须分开。

> → [02-agent-entry.md](02-agent-entry.md)
