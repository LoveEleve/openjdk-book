# 02. redefine + retransform + 重入保护 — 运行时字节码修改

> **前置依赖**:[47-instrumentation/01 — JPLIS Agent → JVMTI ClassFileLoadHook — bytecode 转换管道](01-jplis-agent.md):OnLoad/VMInit 两阶段、ClassFileLoadHook、`InstrumentationImpl` 与 transformer manager 已经拆开;[36-attach/02 — 怎么在运行时动态加载 JVMTI agent?— JDK Attach API + loadAgent](openjdk/vol-02/36-attach/02-jdk-attach.md):`VirtualMachine.loadAgent` 的 attach 通道;[28-jvmti/01 — JVMTI Agent 怎么工作？— Agent 架构与事件系统](openjdk/vol-02/28-jvmti/01-agent-architecture.md):`RedefineClasses`/`RetransformClasses` 的 JVMTI capability
> → **后续**:[26-g1-gc/05 — Mixed GC + 策略预测](openjdk/vol-02/26-g1-gc/05-mixed-gc-policy.md)
> 关联域: 28-jvmti(Redefine/Retransform)、16-classloading(已加载类)、27-jni(native 桥)

premain 只能影响"未来要加载的类"。但生产环境里的热修复、APM 的运行时插桩,都要对**已经加载进 JVM 的类**动手。JDK 提供两条路径:

- `redefineClasses`:直接给新字节码,原样替换,不经过 transformer;
- `retransformClasses`:从类的初始字节重新跑一遍 transformer 链。

两者都落到 JVMTI 的 `RedefineClasses`/`RetransformClasses`,但语义完全不同。而它们共享一个看不见的底层问题——**重入**:transform 过程中若再触发类加载,会递归进同一 agent。本篇把这三件事一起讲清。

---

## 1. redefine — 直接替换,不经过 transformer

### native 侧把 `ClassDefinition` 拆成 JVMTI 结构

`redefineClasses`(JPLISAgent.c:1208-1237)先找 `ClassDefinition` 的 getter method ID,再在循环里逐个取出 class 和字节码:

```c
// JPLISAgent.c:1208-1237(截取核心,逐字)
void
redefineClasses(JNIEnv * jnienv, JPLISAgent * agent, jobjectArray classDefinitions) {
    jvmtiEnv*   jvmtienv                        = jvmti(agent);
    jboolean    errorOccurred                   = JNI_FALSE;
    jclass      classDefClass                   = NULL;
    jmethodID   getDefinitionClassMethodID      = NULL;
    jmethodID   getDefinitionClassFileMethodID  = NULL;
...
    if (!errorOccurred) {
        classDefClass = (*jnienv)->FindClass(jnienv, "java/lang/instrument/ClassDefinition");
        errorOccurred = checkForThrowable(jnienv);
        jplis_assert(!errorOccurred);
    }

    if (!errorOccurred) {
        getDefinitionClassMethodID = (*jnienv)->GetMethodID(    jnienv,
                                                classDefClass,
                                                "getDefinitionClass",
                                                "()Ljava/lang/Class;");
```

Java 侧 `Instrumentation.redefineClasses` 传入的是 `ClassDefinition` 对象,每个绑定"要改的类"和"新字节码"。native 侧通过 `getDefinitionClass`/`getDefinitionClassFile` 两个方法把它们取出。

### 核心是 `jvmtienv` 上的 `RedefineClasses`

循环填好 `jvmtiClassDefinition` 数组后,调用 JVMTI `RedefineClasses`(JPLISAgent.c:1284-1339):

```c
// JPLISAgent.c:1284-1339(截取核心,逐字)
                for (i = 0; i < numDefs; i++) {
                    jclass      classDef    = NULL;

                    classDef = (*jnienv)->GetObjectArrayElement(jnienv, classDefinitions, i);
                    errorOccurred = checkForThrowable(jnienv);
...
                    classDefs[i].klass = (*jnienv)->CallObjectMethod(jnienv, classDef, getDefinitionClassMethodID);
...
                    targetFiles[i] = (*jnienv)->CallObjectMethod(jnienv, classDef, getDefinitionClassFileMethodID);
...
                    classDefs[i].class_byte_count = (*jnienv)->GetArrayLength(jnienv, targetFiles[i]);
...
                    classDefs[i].class_bytes = (unsigned char*)(*jnienv)->GetByteArrayElements(jnienv, targetFiles[i], NULL);
...
                }

                if (!errorOccurred) {
                    jvmtiError  errorCode = JVMTI_ERROR_NONE;
                    errorCode = (*jvmtienv)->RedefineClasses(jvmtienv, numDefs, classDefs);
                    if (errorCode == JVMTI_ERROR_WRONG_PHASE) {
                        /* insulate caller from the wrong phase error */
                        errorCode = JVMTI_ERROR_NONE;
                    } else {
                        errorOccurred = (errorCode != JVMTI_ERROR_NONE);
```

注意这里用的是 `jvmti(agent)`(普通 environment),不是 retransform environment。字节码来自 agent 显式提供,`RedefineClasses` 不会回调 transformer。这就是 redefine 与 retransform 的根本区别: **redefine 把 agent 给的字节码直接喂给 VM。**

---

## 2. retransform — 独立 environment,从初始字节重跑 transformer

### `retransformClasses` 走 retransformerEnv

`retransformClasses`(JPLISAgent.c:1120-1203):

```c
// JPLISAgent.c:1120-1123,1182-1203(截取核心,逐字)
retransformClasses(JNIEnv * jnienv, JPLISAgent * agent, jobjectArray classes) {
    jvmtiEnv *  retransformerEnv     = retransformableEnvironment(agent);
    jboolean    errorOccurred        = JNI_FALSE;
    jvmtiError  errorCode            = JVMTI_ERROR_NONE;
...
    if (!errorOccurred) {
        errorCode = (*retransformerEnv)->RetransformClasses(retransformerEnv,
                                                            numClasses, classArray);
        errorOccurred = (errorCode != JVMTI_ERROR_NONE);
    }
...
    if (errorCode != JVMTI_ERROR_NONE) {
        createAndThrowThrowableFromJVMTIErrorCode(jnienv, errorCode);
    }

    mapThrownThrowableIfNecessary(jnienv, redefineClassMapper);
}
```

和 redefine 不同,retransform 用的不是 `jvmti(agent)`,而是 `retransformableEnvironment(agent)` 返回的独立 environment。这个 environment 专门带 `can_retransform_classes` capability。

### `retransformableEnvironment` 惰性创建,带 retransform capability

`retransformableEnvironment`(JPLISAgent.c:1009-1062):

```c
// JPLISAgent.c:1009-1062(截取核心,逐字)
jvmtiEnv *
retransformableEnvironment(JPLISAgent * agent) {
    jvmtiEnv *          retransformerEnv     = NULL;
    jint                jnierror             = JNI_OK;
    jvmtiCapabilities   desiredCapabilities;
    jvmtiEventCallbacks callbacks;
    jvmtiError          jvmtierror;

    if (agent->mRetransformEnvironment.mJVMTIEnv != NULL) {
        return agent->mRetransformEnvironment.mJVMTIEnv;
    }
    jnierror = (*agent->mJVM)->GetEnv(  agent->mJVM,
                               (void **) &retransformerEnv,
                               JVMTI_VERSION_1_1);
...
    desiredCapabilities.can_retransform_classes = 1;
...
    jvmtierror = (*retransformerEnv)->AddCapabilities(retransformerEnv, &desiredCapabilities);
...
    callbacks.ClassFileLoadHook = &eventHandlerClassFileLoadHook;

    jvmtierror = (*retransformerEnv)->SetEventCallbacks(retransformerEnv,
                                                        &callbacks,
                                                        sizeof(callbacks));
...
        agent->mRetransformEnvironment.mJVMTIEnv = retransformerEnv;
        agent->mRetransformEnvironment.mIsRetransformer = JNI_TRUE;
```

这个 environment 惰性创建、复用。它把 `mIsRetransformer` 置真,于是它的 `ClassFileLoadHook` 回调时,`eventHandlerClassFileLoadHook` 会以 `is_retransformer=TRUE` 调 `transformClassFile`。也就是说 **retransform 时的 ClassFileLoadHook 走的是 retransform environment 的 callback**,普通类加载走的是 normal environment 的 callback。

### retransform 会触发 transformer 链,redefine 不会

这是二者最容易混淆的点:

- `RedefineClasses`:字节码直接来自 agent,VM 用它替换,`ClassFileLoadHook` **不触发**;
- `RetransformClasses`:VM 从类的**初始字节码**出发,对每个已注册 transformer 依次调 transform,产生的最终字节码才写回类。

所以 APM 之类"applicator"型 agent 用 retransform:它不需要自己算新字节,只要注册 transformer,让已加载类也过一遍插桩逻辑。redefine 更适合热修复:agent 已经算好了完整的新 classfile。

---

## 3. premain vs agentmain — 同一套 native,不同 manifest 属性

### `Agent_OnAttach` 读的是 `Agent-Class`

`-javaagent` 走 `Agent_OnLoad`,读 `Premain-Class`;运行时 `VirtualMachine.loadAgent` 走 `Agent_OnAttach`(InvocationAdapter.c:303-352):

```c
// InvocationAdapter.c:303-352(截取核心,逐字)
DEF_Agent_OnAttach(JavaVM* vm, char *args, void * reserved) {
    JPLISInitializationError initerror  = JPLIS_INIT_ERROR_NONE;
    jint                     result     = JNI_OK;
    JPLISAgent *             agent      = NULL;
    JNIEnv *                 jni_env    = NULL;
...
    initerror = createNewJPLISAgent(vm, &agent);
    if ( initerror == JPLIS_INIT_ERROR_NONE ) {
...
        attributes = readAttributes( jarfile );
        if (attributes == NULL) {
            fprintf(stderr, "Error opening zip file or JAR manifest missing: %s\n", jarfile);
...
            return AGENT_ERROR_BADJAR;
        }

        agentClass = getAttribute(attributes, "Agent-Class");
        if (agentClass == NULL) {
            fprintf(stderr, "Failed to find Agent-Class manifest attribute from %s\n",
                jarfile);
...
            return AGENT_ERROR_BADJAR;
        }
```

`Agent_OnAttach` 的关键差异:

1. 读 `Agent-Class`,不是 `Premain-Class`;
2. 已经处于 live phase,所以不装 VMInit,而是直接 `createInstrumentationImpl` + `setLivePhaseEventHandlers`;
3. 调用 `startJavaAgent(..., agent->mAgentmainCaller)`,即 `agentmain` 而非 `premain`。

`Agent_OnAttach` 到 live 处理链在 InvocationAdapter.c:412-440:创建 `InstrumentationImpl`,装 ClassFileLoadHook handler,再 `startJavaAgent`。

### agentmain 能操作已加载类

premain 在 main 之前,应用类还没加载,只能注册 transformer 等未来类。agentmain 进来时应用类已加载,于是可以用 `retransformClasses` 让已加载类也过 transformer,或用 `redefineClasses` 热修复。这是 attach 式 agent 的核心价值: **不改启动参数,事后介入。**

---

## 4. 重入保护 — per-thread JVMTI TLS,不是全局锁

### 为什么需要重入保护

transform 回调里如果 agent 自己又触发类加载(例如加载某个辅助类),会再次进入 `ClassFileLoadHook` → `transformClassFile` → 同一 agent,形成递归。轻则重复插桩,重则死循环。

JPLIS 的解法是 `Reentrancy.c` 里的 per-thread token。

### token 是两个 sentinel,不是 0/1

`Reentrancy.c:63-64` 定义了两个 sentinel:

```c
// Reentrancy.c:63-64,105-144(截取核心,逐字)
#define JPLIS_CURRENTLY_INSIDE_TOKEN                ((void *) 0x7EFFC0BB)
#define JPLIS_CURRENTLY_OUTSIDE_TOKEN               ((void *) 0)


jboolean
tryToAcquireReentrancyToken(    jvmtiEnv *  jvmtienv,
                                jthread     thread) {
    jboolean    result      = JNI_FALSE;
    jvmtiError  error       = JVMTI_ERROR_NONE;
    void *      storedValue = NULL;

    error = (*jvmtienv)->GetThreadLocalStorage(
                                jvmtienv,
                                thread,
                                &storedValue);
    check_phase_ret_false(error);
    jplis_assert(error == JVMTI_ERROR_NONE);
    if ( error == JVMTI_ERROR_NONE ) {
        /* if this thread is already inside, just return false and short-circuit */
        if ( storedValue == JPLIS_CURRENTLY_INSIDE_TOKEN ) {
            result = JNI_FALSE;
        }
        else {
            error = confirmingTLSSet (  jvmtienv,
                                        thread,
                                        JPLIS_CURRENTLY_INSIDE_TOKEN);
            check_phase_ret_false(error);
            jplis_assert(error == JVMTI_ERROR_NONE);
            if ( error != JVMTI_ERROR_NONE ) {
                result = JNI_FALSE;
            }
            else {
                result = JNI_TRUE;
            }
        }
    }
    return result;
}
```

大纲里"0=在 agent 外、1=在 agent 内"是错的。真实实现用 `0x7EFFC0BB` 作为"inside" sentinel,`0`(NULL)作为"outside"。读 TLS 后:

- 已 inside → 返回 false(不重复进入);
- 未 inside → 写入 inside sentinel,返回 true。

### release 用 `confirmingTLSSet` 写回 NULL

`releaseReentrancyToken`(Reentrancy.c:147-165)把 token 清回 outside:

```c
// Reentrancy.c:147-165(截取核心,逐字)
void
releaseReentrancyToken(         jvmtiEnv *  jvmtienv,
                                jthread     thread)  {
    jvmtiError  error       = JVMTI_ERROR_NONE;

    error = confirmingTLSSet(   jvmtienv,
                                thread,
                                JPLIS_CURRENTLY_OUTSIDE_TOKEN);
    check_phase_ret(error);
    jplis_assert(error == JVMTI_ERROR_NONE);

}
```

`confirmingTLSSet`(Reentrancy.c:67-86)先 `SetThreadLocalStorage` 再在断言开启时重新 fetch 验证,专门绕开某个 JVMTI "set 到 0 失败"的历史 bug。

### transformClassFile 里 acquire 失败就整段跳过

`transformClassFile`(JPLISAgent.c:817-822,920-926)把重入保护和 transform 主体包在一起:

```c
// JPLISAgent.c:817-822,920-926(截取核心,逐字)
    /* only do this if we aren't already in the middle of processing a class on this thread */
    shouldRun = tryToAcquireReentrancyToken(
                                jvmti(agent),
                                NULL);  /* this thread */

    if ( shouldRun ) {
...
        /* release the token */
        releaseReentrancyToken( jvmti(agent),
                                NULL);      /* this thread */

    }

    return;
}
```

acquire 返回 false 时 `shouldRun` 为假,整个 marshal → Java transform → unmarshal 都不执行,函数直接 return。于是 **重入的那次 transform 被无声跳过**,VM 继续用当前字节码,而不是崩溃或抛异常。

这也是"per-thread 而非全局锁"的含义:不同线程各自持有独立 TLS,互不阻塞;只有**同一线程的递归**才被拦住。大纲"return NULL(skip transform)"的表述不精确——`transformClassFile` 是 void,重入时是"整段跳过、不写 `new_class_data`",等价于告诉 VM"不修改"。

---

## 核心悬念

**redefine 和 retransform 共享 JVMTI 的类重定义能力,但入口和语义完全不同:** redefine 把 agent 提供的字节码直接交给 `RedefineClasses`,不触发 transformer;retransform 通过带 `can_retransform_classes` 的独立 environment 调 `RetransformClasses`,从初始字节重跑 transformer 链。二者背后,`premain`/`agentmain` 只差一个 manifest 属性(`Premain-Class` vs `Agent-Class`);而重入保护用 per-thread 的 JVMTI TLS sentinel,把同一线程的递归 transform 无声拦下。**下一篇回到 26 域补写 Mixed GC + 策略预测:** G1 什么时候做 Young GC、什么时候做 Mixed,收集集合怎么选。

> → [26-g1-gc/05-mixed-gc-policy.md](openjdk/vol-02/26-g1-gc/05-mixed-gc-policy.md)
