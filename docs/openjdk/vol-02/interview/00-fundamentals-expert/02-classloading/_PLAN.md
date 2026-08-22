# 02-classloading · 类加载、链接与字节码

## 覆盖域（vol-02）

`07-classfile-classloader`（ClassFile 解析/Verifier/SystemDictionary/ClassLoader/JPMS）、`08-interpreter`（字节码定义）、`44-class-verification`（VerificationType）、`11-cds`（CDS）、`10-metaspace`（ConstantPool）

## 题目清单

1. 什么是双亲委派？为什么要？——initiating vs defining loader；`ClassLoaderData` 真正持有生命周期
2. JDK 有哪几种 ClassLoader？——Bootstrap/Platform/App；`getParent()` null ≠ 无父
3. 什么是打破双亲委派？——`ContextClassLoader`、Web 容器、JDBC SPI
4. `NoClassDefFoundError` 和 `ClassNotFoundException` 的区别？——链接失败 vs 查找失败；静态初始化失败的坑
5. 什么是 `String.intern()`？常量池在哪？——运行时常量池（Metaspace）vs StringTable（堆上）；JDK 7 变化
6. 什么是字节码？`javap -c` 能看到什么？——解释器/JIT 的公共输入；`StackMapTable` 是 verifier 依据
7. 为什么 `long`/`double` 占两个 slot？——`VerificationType::Long_2nd`/`Double_2nd`；文件 Top vs 内存 2_2nd
8. 类加载过程分几步？——解析/验证/链接/初始化；`InstanceKlass::link_class_impl` 顺序
9. 什么时候触发类初始化？——主动引用 vs 被动引用；`initialize_impl` 并发保护；`<clinit>` 线程安全
10. 静态块/实例块/构造器/父类的执行顺序？——`init`/`clinit` 与 `<init>` 的字节码顺序；父类链
11. `Class.forName` 和 `ClassLoader.loadClass` 的区别？——前者默认 initialize，后者不执行 `<clinit>`；`initialize` 语义差异
12. `new String("abc")` 创建了几个对象？——常量池/ldc + new + String 构造器的三次分配；`StringTable` 命中与未命中分支

## 回答框架提示

本组重点是"两个世界的对应"：文件里的字节码/StackMapTable 与内存里的 VerificationType/InstanceKlass。版本差异集中在 JDK 9 模块化（package/module owner 路由）和 JDK 7（StringTable 移到堆）。