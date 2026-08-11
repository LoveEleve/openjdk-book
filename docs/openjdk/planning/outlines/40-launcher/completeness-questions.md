# 域 40 Launcher — 全视角提问验证

> 5 身份 | 12 问 | 验证大纲是否覆盖读者真实问题

## 1. Java 应用开发者 (3问)

1. `java -cp "lib/*" MyMain` —— `*` 通配符展开在什么时候发生？是所有 jar 都匹配吗？
2. `java -jar app.jar` vs `java -cp app.jar MyMain` —— MANIFEST.MF 解析有什么不同？没有 Main-Class 属性会报什么错？
3. 为什么有时候 `java -version` 输出和实际运行的 JVM 版本不同？jvm.cfg 在哪个路径？

## 2. JVM 运维/SRE (2问)

4. jvm.cfg 中 `-server KNOWN` vs `-client IGNORE` —— 如果两个都 KNOWN，用户不指定 `-server` / `-client` 时默认选哪个？这个优先级由什么决定？
5. `JDK_JAVA_OPTIONS` 环境变量和命令行参数冲突时谁优先？`--add-opens` 为什么不能出现在 JDK_JAVA_OPTIONS 中？

## 3. 框架/工具开发者 (3问)

6. 我想在 C 程序中嵌入 JVM（像 IDE 那样）——必须自己调用 `JLI_Launch` 还是可以直接 `dlopen libjvm.so → JNI_CreateJavaVM`？两种方式的区别是什么？
7. `InvocationFunctions` 结构体中的三个函数指针 (`CreateJavaVM`/`GetDefaultJavaVMInitArgs`/`GetCreatedJavaVMs`) —— 它们是通过什么机制从 libjvm.so 获取的？
8. `@argfile` 支持嵌套引用另一个 argfile 吗？如果可以，循环引用了会怎样？

## 4. 安全研究者 (2问)

9. libjli 是纯 C 程序——在 JVM 启动前有什么攻击面？JDK_JAVA_OPTIONS 和 `@argfile` 各自能做什么？
10. `LD_LIBRARY_PATH` 劫持——如果我在 LD_LIBRARY_PATH 中放一个恶意 libjvm.so，java 命令会加载它吗？$RPATH/$ORIGIN 如何防御？

## 5. 性能工程师 (2问)

11. `java MyMain` 从敲回车到 main() 执行——libjli 阶段的开销分布：ParseArguments/read jvm.cfg/dlopen libjvm.so/JNI_CreateJavaVM 各占多少？
12. `-Xquickstart` / AppCDS / AOT 这些启动优化——它们发生在 libjli 阶段之后吗？还是在 JLI_Launch 内部就开始了？
