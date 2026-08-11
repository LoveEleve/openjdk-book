# 域 47: Instrumentation — 知识规划

> 源码: java.instrument/share/native/libinstrument/ | ~22文件/~4828行 | 🟡 普通域(2篇)

## 01 逐源提取

| Source File | Inferred Mechanism | Confidence |
|------------|-------------------|------------|
| JPLISAgent.c (1604行) | **JPLIS Agent 初始化**: JVM_OnLoad→JPLISAgent init→acquire JVMTI env→set ClassFileLoadHook callback→transform bytecode before class load. premain/agentmain 调用"Java agent→JPLISAgent→JVMTI→bytecode hook | High |
| InvocationAdapter.c (986行) | **Agent 调用**: premain(instrumentation, agentArgs) / agentmain(instrumentation, agentArgs) → JNI call from C→Java agent class→return. 加载 agent JAR→find META-INF/MANIFEST.MF→Premain-Class/Agent-Class | High |
| InstrumentationImplNativeMethods.c (189行) | **Instrumentation JNI**: addTransformer/removeTransformer→JPLISAgent management, getAllLoadedClasses→JVM_GetAllLoadedClasses, redefineClasses→JVMTI RedefineClasses, retransformClasses→JVMTI RetransformClasses | High |
| JavaExceptions.c (419行) | **异常处理**: throwInstrumentationException→ThrowNew Java exception, 映射 JVMTI error codes→Java exceptions | Medium |
| Reentrancy.c (165行) | **重入保护**: check/release reentrancy token→防止 transformer 递归调用 agent(agent A transform→agent B retransform→agent A deadlock) | Medium |
| JarFacade.c (140行) | **JAR manifest 解析**: open JAR→read META-INF/MANIFEST.MF→extract Premain-Class/Agent-Class/Can-Retransform-Classes | Medium |
| Utilities.c (110行) | **工具函数**: strdup, list_remove, pointer comparison | Low |

*7 知识点*

## 02 聚合

### P1 (≥5文件)
| KP | 出现文件 |
|----|---------|
| JPLIS Agent 生命周期 | JPLISAgent.c, InvocationAdapter.c, InstrumentationImplNativeMethods.c, JavaExceptions.c, Reentrancy.c |

### P2 (2-4文件)
| KP | 出现文件 |
|----|---------|
| JAR manifest 解析 | JarFacade.c, InvocationAdapter.c |
| Retransform + ClassFileLoadHook | JPLISAgent.c, InstrumentationImplNativeMethods.c |

### P3 (=1文件)
| KP | 出现文件 |
|----|---------|
| 重入保护 | Reentrancy.c |
| 工具函数 | Utilities.c |

## 03 深度分类

### 🔴 Deep (1 KP)
| KP | 为什么 🔴 |
|----|---------|
| JPLISAgent → JVMTI ClassFileLoadHook | `-javaagent:myagent.jar` 的完整管道——JVM 启动→create JPLISAgent→acquire JVMTI env→set ClassFileLoadHook callback→load agent JAR→call premain→agent register transformer→every ClassLoader.defineClass→JVMTI ClassFileLoadHook→agent's transform()→modified bytecode→JVM load。这是所有 Java agent(APM/Profiler/Class rewriting) 的入口——没有这个管道→Spring AOP/Byte Buddy/ASM agent 都无法工作 |

### 🟡 Working (2 KP)
| KP | 为什么 🟡 |
|----|---------|
| redefineClasses / retransformClasses | modify already-loaded classes via JVMTI——不同于 transform(在 class load 前) |
| premain vs agentmain | premain: `-javaagent` JVM flag→before main(); agentmain: `VirtualMachine.loadAgent()`→runtime dynamic attach |

### 🟢 Surface (2 KP)
| KP | 为什么 🟢 |
|----|---------|
| JAR manifest 解析 | 简单的 key-value parse |
| 重入保护 + 异常处理 | 基础设施——确保 agent 调用在单一线程中不递归 |

## 04 聚类 — 2篇

| 篇 | 标题 | 核心问题 |
|:--:|------|------|
| 1 | JPLIS Agent → JVMTI ClassFileLoadHook | "`-javaagent:myagent.jar`→JPLISAgent 怎么注册 ClassFileLoadHook→每次 defineClass 时 transform bytecode？" |
| 2 | Agent 入口 + redefine/retransform | "premain vs agentmain？redefineClasses 和 retransformClasses 有什么区别？重入保护怎么防止递归？" |
