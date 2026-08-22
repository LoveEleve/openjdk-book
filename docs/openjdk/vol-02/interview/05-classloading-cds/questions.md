# 05 · 类加载、链接与 CDS：深度题目

## 1. 为什么 ClassFileParser 不能边读边填 InstanceKlass？

一段 hostile class bytes 进入 HotSpot 后，为什么要经过 parser-owned 临时元数据、派生形状计算和最终 ownership handoff，而不是先分配 InstanceKlass 再逐字段填充？

回答必须覆盖：

- ClassFileStream 的边界检查与 parser 的局部校验分别保护什么；
- constant pool 为什么不能全部 eager resolve；
- superclass/interfaces 为什么必须早于普通 Methodref 解析；
- `parse_stream`、`post_process_parsed_stream`、`allocate_instance_klass`、`fill_instance_klass` 的所有权顺序；
- 中途抛出 ClassFormatError 时哪些对象仍由 parser 负责回收。

追问：JVMTI ClassFileLoadHook 修改字节发生在 parser 前还是 parser 中？CDS shared class 为什么不走普通 parser path？

源码入口：`share/classfile/klassFactory.cpp:163`、`share/classfile/classFileParser.cpp:534`、`share/classfile/classFileParser.cpp:584`、`share/classfile/classFileParser.cpp:1947`。

## 2. 为什么同一个类名可以对应多个 Klass？

`java/lang/String` 只有一个 Symbol，为什么两个 ClassLoader 仍能定义两个互不兼容的同名类？SystemDictionary 的真正 key 是什么？

回答必须覆盖：

- Symbol 唯一化与 Klass 身份的区别；
- defining loader 与 initiating loader 的区别；
- ClassLoaderData dictionary、PlaceholderTable、LoaderConstraintTable 各自处理什么状态；
- protection domain 为什么影响已加载类是否可以复用；
- 什么时候不同 loader 必须隔离，什么时候 loader constraint 又要求类型一致。

追问：如果 dictionary 只保存 defining loader 自己定义的类，委派模型会在哪一步失败？如果把“加载中”也塞进 Dictionary，会破坏哪些并发协议？

源码入口：`share/classfile/systemDictionary.cpp:244`、`share/classfile/systemDictionary.cpp:257`、`share/classfile/systemDictionary.cpp:1021`、`share/classfile/placeholders.cpp:83`、`share/classfile/loaderConstraints.cpp:74`。

## 3. 为什么 CDS 不是缓存 class 文件？

`-Xshare:dump` 为什么要先正常加载/链接类，再 freeze metaspace、清理不可共享状态、压实对象并按 `mc/rw/ro/md` 分区，而不是缓存 `.class` 或序列化 InstanceKlass？

回答必须覆盖：

- class bytes 与运行时元数据对象图之间的成本差异；
- 固定地址映射对嵌入指针和 compressed klass base 的意义；
- ArchiveCompactor 的浅拷贝、旧新地址表和引用重定位；
- `ro`、`rw`、`mc`、`md` 的页权限/运行时 patch 语义；
- freeze 同时解决一致快照和避免 dump 期间 Metaspace 触发 GC 的约束。

追问：如果允许 dump 期间继续分配，哪个地址映射或 region 边界会先失效？如果允许任意地址加载，为什么不能仅靠一次全量重定位解决？

源码入口：`share/memory/metaspaceShared.cpp:1632`、`share/memory/metaspaceShared.cpp:1333`、`share/memory/metaspaceShared.cpp:1079`、`share/memory/metaspaceShared.cpp:1180`。

## 4. mmap 成功后，为什么共享类还不是“已加载”？

归档已经映射到内存，为什么还要 clone C++ vtable、恢复运行时入口、接入 shared dictionary、恢复 `java_mirror` 和执行轻量 link？

回答必须覆盖：

- 文件校验、地址对位和内容校验是三层不同门槛；
- dump 时不能跨进程保存的 vtable、method entry、native entry、mirror 等运行期状态；
- `initialize_shared_spaces` 的接线职责；
- `SystemDictionaryShared::load_shared_class` 与 `InstanceKlass::restore_unshareable_info` 的分工；
- 已 rewritten 的 shared class 为什么不重跑完整 verifier/rewriter，而只做必要 constraints 检查。

追问：如果 shared path table 还没映射，为什么不能在 header 校验阶段完成它的校验？如果 superclass/interface 不是 dump 时的同一对象，为什么不能仅按名字接受？

源码入口：`share/memory/filemap.cpp:1316`、`share/memory/metaspaceShared.cpp:2033`、`share/memory/metaspaceShared.cpp:2100`、`share/classfile/systemDictionary.cpp:1270`。

## 5. 自定义 ClassLoader 为什么需要字节指纹，builtin loader 却有专门路径？

对 bootstrap/platform/app loader，HotSpot 可以使用共享字典快速接入；对自定义 loader，为什么还必须比较当前 ClassFileStream 的长度与 CRC32？

回答必须覆盖：

- builtin loader 的身份和 classpath/module path 可由运行时约束确认；
- 自定义 loader 可能为同名类提供任意字节，类名不足以确认定义相同；
- shared dictionary 中 UNREGISTERED 条目的作用；
- `acquire_class_for_current_thread` 如何在锁下防止同一个归档 Klass 被竞争取得；
- 最终仍要汇入统一 `load_shared_class(InstanceKlass*)`，而不是绕过类加载语义。

追问：如果只比较 class name，不比较 CRC，会产生什么类型安全问题？如果先把 Klass 绑定到 ClassLoaderData，再做完整校验，会留下什么失败回滚问题？

源码入口：`share/classfile/systemDictionaryShared.cpp:585`、`share/classfile/systemDictionaryShared.cpp:628`、`share/classfile/systemDictionaryShared.cpp:530`。

## 6. 为什么 CDS 的“直接复用”仍然保留一小段 link？

共享类已经在 dump 时完成验证、重写和大量链接，为什么运行时还要进入 `InstanceKlass::link_class`？

回答必须覆盖：

- dump 时能固化的结构与当前 JVM 才能决定的约束边界；
- shared rewritten class 的轻量 link 分支；
- `check_verification_constraints` 延迟验证的来源和目的；
- ClassFileLoadHook、模块/包可见性、super/interface identity 对复用资格的影响；
- “不重跑”不等于“不验证”。

追问：如果删掉运行时 constraints 检查，哪类跨 loader/classpath 变化会被错误放行？如果所有 shared class 都重新 verifier，CDS 的主要收益还剩多少？

源码入口：`share/oops/instanceKlass.cpp:787`、`share/classfile/systemDictionaryShared.cpp:808`、`share/classfile/systemDictionary.cpp:1183`。

## 7. Parser、Verifier、Link 与 Initialize 为什么必须是四个状态？

类已经被 parser 读成 InstanceKlass，为什么还可能没有 verified、linked，更没有 initialized？为什么一次 `new` 或一次静态字段访问会把它推进到初始化，而不是类加载完成就立刻执行 `<clinit>`？

回答必须覆盖：

- loaded、linked、initialized 之间的状态边界；
- verifier 为什么属于 linking，而不是 parser；
- superclass/interface 的递归 linking 与初始化顺序差异；
- `<clinit>` 的线程安全、重复进入和异常后状态；
- 为什么“类已经能被找到”不等于“类初始化副作用已经发生”。

追问：两个线程同时触发同一个类初始化时谁执行 `<clinit>`？初始化失败后后续线程看到什么？如果只在首次主动使用时初始化，为什么仍要先完成 link？

源码入口：`share/oops/instanceKlass.cpp:710`、`share/oops/instanceKlass.cpp:891`、`share/classfile/verifier.cpp:620`。

## 8. StackMapTable 为什么是 verifier 的输入，而不是安全证明的替代品？

既然 class file 已经带了 StackMapTable，为什么 verifier 还要逐条模拟字节码？一个错误的 frame、错误的 branch target 或未初始化对象状态是如何被拒绝的？

回答必须覆盖：

- parser 只验证属性结构，verifier 维护 locals/operand stack 的抽象状态；
- StackMapTable 为控制流汇合点提供预期状态；
- transfer function 仍必须检查 opcode 的栈效果、类型约束和异常边界；
- `uninitializedThis`/`ITEM_Uninitialized` 与构造函数安全规则；
- split verifier 与旧 verifier 的版本/实现边界。

追问：如果删除 StackMapTable，verifier 能否退回全量数据流推导？代价是什么？如果只读 StackMapTable、不模拟 opcode，哪类伪造字节码会漏过去？

源码入口：`share/classfile/verifier.cpp:620`、`share/classfile/verifier.cpp:630`、`share/classfile/stackMapTableFormat.hpp:44`。

## 9. JPMS 为什么不是 ClassLoader 的“多一个 if”？

类已经被 loader 找到，为什么仍可能因为 readability、exports、opens 或模块 patch 失败？`ModuleEntry`、`PackageEntry` 和 Java reflection 的检查为什么必须分层？

回答必须覆盖：

- loader visibility、module readability、package export/open 的先后关系；
- `ModuleEntry` 记录 reads/open/patched 等模块状态，而 package export 属于 PackageEntry 层；
- VM linkage 的 `Reflection::verify_class_access` 与 Java reflection 的 `verifyModuleAccess` 不是同一调用点；
- `--add-reads`、`--add-exports`、`--add-opens` 改变的不是同一个门；
- `Module.isExported` 不等价于完整的 caller readability 检查。

追问：模块 A reads B 但 B 不 export 目标包时，静态链接和深反射分别会怎样？open module 是否自动创造 read edge？`ALL-UNNAMED` 为什么不是“所有模块无限制可见”？

源码入口：`share/classfile/moduleEntry.cpp:115`、`share/classfile/packageEntry.cpp:44`、`share/runtime/reflection.cpp:491`、`java.base/share/classes/java/lang/Module.java:603`。
