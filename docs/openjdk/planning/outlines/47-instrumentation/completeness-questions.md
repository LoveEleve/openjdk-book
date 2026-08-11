# 域 47 Instrumentation — 全视角提问验证

> 🟡 普通域 | 5 身份 | 8 问

## 1. Java 开发者 (2问)

1. `-javaagent:myagent.jar` → agent 的 premain() 和 main() 谁先执行？agent 的类加载器是什么？
2. `instrumentation.addTransformer(transformer)` 注册后——所有后续 `ClassLoader.defineClass` 都会调 transformer——但已加载的类不触发 transform——怎么让 agent 也处理已加载类？

## 2. SRE/运维 (2问)

3. `VirtualMachine.loadAgent(pid, agentJar)` → JVM 在运行时 attach agent——需要重启 JVM 吗？对正在运行的线程有影响吗？
4. `redefineClasses` 不能改字段/超类/接口——只改方法体——这意味着热修复不能修 field bug(如 `private int size` 忘记初始化)——有什么 workaround？

## 3. 框架开发者 (2问)

5. 多个 transformer 的调用链——`retransformClasses` 触发 transformer 1→2→3 链——如果 transformer 2 throw exception→transformer 3 还会被调用吗？transform 1 的结果会被丢弃吗？
6. APM agent(如 SkyWalking) 在 premain 时注册 transformer——如果 agent JAR 损坏(premain 抛异常)→JVM 会 crash 还是跳过 agent 继续启动？

## 4. 安全研究者 (1问)

7. Can-Retransform-Classes MANIFEST 属性——恶意 agent 能不能声明此属性后在运行时修改 JVM 核心类(如 java.lang.String)的 bytecode？

## 5. 性能工程师 (1问)

8. ClassFileLoadHook 在每次 defineClass 时触发——大型应用(classpath 5000+类)→5000 次 JVMTI callback→性能 overhead 有多少？transformer return null(不修改)的 overhead vs 修改 bytecode 的 overhead 比较？
