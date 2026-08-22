# 05 · 类加载、链接与 CDS：专家答案锚点

## 1. ClassFileParser 的核心是不变量：失败时 ownership 仍可判定

ClassFileParser 面对的是不可信、可变长、带内部索引的输入。它不能在输入尚未证明合法前，把半成品暴露成 InstanceKlass；否则失败回滚会同时涉及 CLD 链表、Method/ConstMethod、ConstantPool、字段数组、接口数组和注解元数据。

正确分层是：

```text
ClassFileStream
  → parse_stream：格式与局部结构
  → post_process_parsed_stream：布局和派生形状
  → allocate_instance_klass：按形状分配外壳
  → fill_instance_klass：一次性交接 ownership
```

`constant_pool` 不是“读完立即把所有引用解析成 Klass*”。加载阶段必须知道 superclass/interfaces，因为它们决定继承关系和布局；普通 Methodref、Fieldref、String、MethodHandle 可以保留 unresolved 状态，等真正使用时再解析。这样把加载成本和首次使用成本分开，也避免加载一个永远不执行的类时触发无关依赖。

JVMTI ClassFileLoadHook 在 `share/classfile/klassFactory.cpp:163` 附近、构造 parser 之前可能替换输入，所以 parser 的事实来源是“经过 hook 后的 bytes”，不是调用者最初传入的数组。普通 CDS shared class 则绕过普通 bytes-to-Klass 构造，走 `share/classfile/systemDictionary.cpp:1270` 附近的 archive 恢复与接线路径。

专家级答案必须指出：这里保护的不是“解析速度”，而是**所有权可证明性**。任何失败点都必须能回答“哪些对象还归 parser，哪些已经归 Klass”，否则析构与回滚就无法可靠实现。

## 2. 类身份至少包含名字与加载域

`SymbolTable` 只负责把名字 canonicalize 成一个 Symbol；它不负责定义 Java 类型身份。类身份至少要结合名字和 defining loader，实际解析过程还涉及 initiating loader、protection domain、模块和约束。`SystemDictionary::resolve_or_null` 的名字规范化入口在 `share/classfile/systemDictionary.cpp:244`，placeholder 与 loader constraint 的协作分别可从 `share/classfile/placeholders.cpp:83` 和 `share/classfile/loaderConstraints.cpp:74` 进入。

因此：

```text
(name, loader A) → Klass A
(name, loader B) → Klass B
```

两个 Klass 可以同名但不相等。`ClassLoaderData` 的 dictionary 记录的是某个加载域视角下可用的类结果，不仅仅是“这个 loader 亲手定义的类”，因为委派可能由 parent 定义、child 使用。

`PlaceholderTable` 记录加载中的动作和等待关系，避免把“尚未定义”伪装成可返回 Klass；`LoaderConstraintTable` 在签名、字段或方法解析要求类型一致时施加跨 loader 一致性；protection domain 则决定当前访问条件下是否能复用已有类。

如果把全局 key 简化成 `name -> Klass`，会破坏同名隔离；如果 dictionary 只记录 defining loader，会让 initiating loader 后续无法复用委派得到的结果；如果把 loading 状态塞进 Dictionary，会混淆“可返回结果”和“正在进行的动作”，导致并发加载、循环继承和等待唤醒难以表达。

## 3. CDS 缓存的是运行时形态，不是输入字节

缓存 `.class` 只省掉 I/O，仍需重复 parser、验证、符号处理、元数据分配、字节码重写和链接。逐对象序列化 InstanceKlass 又会引入对象图 ID、地址回填、页权限恢复和跨版本布局兼容问题。

JDK 11u 的 dump 端从 `MetaspaceShared::preload_and_dump`（`share/memory/metaspaceShared.cpp:1632`）按 classlist 真正加载并尽量链接类，再由 `VM_PopulateDumpSharedSpace::doit`（`:1333`）在 VM 线程执行：

```text
freeze metaspace
  → collect loaded classes
  → remove unshareable info
  → rewrite nofast bytecodes / fingerprints
  → ArchiveCompactor shallow copy
  → relocate embedded/external references
  → write mc/rw/ro/md and heap regions
```

`ArchiveCompactor::copy_and_compact`（`share/memory/metaspaceShared.cpp:1079`）的关键不是递归编码，而是建立 old-to-new location table，将对象按读写属性搬入新 region，再修正对象内部指针和外部根（内部重定位从 `:1180` 一带开始）。`ro` 追求跨 JVM 共享的只读页，`rw` 保存运行时可变内容，`mc` 保存可执行 trampoline，`md` 保存仍需运行期接线或 patch 的杂项数据。

`freeze` 同时保证两件事：对象集合和地址边界在 compaction 期间稳定；dump 线程不会在 Metaspace 紧张时触发不适合此上下文的 GC。若允许对象继续增长，旧新地址映射、region 边界和一致快照都会失效。

## 4. mmap 只恢复字节，load 还要恢复进程关系

CDS 的 load 从 `FileMapInfo::initialize`（`share/memory/filemap.cpp:1316`）开始，至少分为四层：

1. header、版本、JVM 标识、选项和路径等前提校验；
2. `mc/rw/ro/md` 按记录地址连续映射，并校验内容 checksum；
3. clone 当前进程 C++ vtable，恢复共享字典、符号/字符串表和归档堆对象接线；
4. 将候选 shared Klass 接入当前 loader、层级、模块、方法入口和类状态机。

跨进程不能直接保存的包括 C++ vtable 地址、当前解释器/适配器入口、native 方法入口、`java_mirror` 和部分运行时 resolved state。dump 时剥掉这些状态，load 时由 `restore_unshareable_info`、`Method::restore_unshareable_info` 和相关初始化路径补回来。

共享类不能按名字直接接受，因为 superclass/interface 的对象身份会影响布局和类型关系；当前解析结果必须与 archive 记录的对象一致（`share/classfile/systemDictionary.cpp:1285-1311`）。共享类已经 rewritten 时，`link_class`（`share/oops/instanceKlass.cpp:787-806`）不再重跑完整 verifier/rewriter，但仍要执行当前 JVM 才能确认的 verification constraints。这里的设计原则是：**跳过已固化的工作，不跳过当前环境必须重新确认的安全条件**。

## 5. 自定义 loader 必须证明“字节定义相同”

builtin loader 的身份、classpath/module path 和 archive 标记可以提供较强约束；自定义 loader 可以自由决定 `defineClass` 的字节，因此 `(name, loader)` 仍不足以证明 archive 中的定义就是当前输入。

对**自定义 loader 的 archive lookup 路径**，`lookup_from_stream`（`share/classfile/systemDictionaryShared.cpp:585-615`）使用归档记录的类名、class file size 和 CRC32 与当前 `ClassFileStream` 比较。这个 CRC 路径不是所有 builtin shared class 的通用校验；builtin loader 主要依赖 loader 类型、classpath/module path 和 archive 标记走专用路径。共享字典中的 UNREGISTERED 条目表示这类可由自定义 loader 依据输入流认领的候选，不是任意同名类都能拿。

`acquire_class_for_current_thread` 在 `SharedDictionary_lock` 保护下完成竞争确认和绑定，避免两个 loader/线程同时取得同一个归档 Klass。绑定发生前必须完成资格判断，否则失败时会留下错误的 ClassLoaderData 关系；绑定后还要汇入统一 `load_shared_class(InstanceKlass*)`，继续执行可见性、层级和恢复协议。

只比较名字会造成错误复用：两个自定义 loader 可以对同名类提供不同字段、方法或父类。那不是性能问题，而是类型安全和布局一致性问题。

## 6. CDS 的轻量 link 是“延迟兑现”，不是“取消验证”

dump 端可以固化 class file 解析、绝大部分验证结果、字节码重写和许多运行时元数据；但当前 JVM 的 loader、module/package 可见性、super/interface identity、ClassFileLoadHook 和部分 verification constraints 只能在 load 时确认。

因此 shared rewritten class 的 `InstanceKlass::link_class`（`share/oops/instanceKlass.cpp:787-806`）走轻量分支：不重新做完整 verifier 和 rewriter，而调用 `SystemDictionaryShared::check_verification_constraints`（`share/classfile/systemDictionaryShared.cpp:808-811`）检查 dump 时留下、运行时必须兑现的约束。若约束不成立，必须拒绝共享或抛出 VerifyError，不能为了复用 archive 放行。

如果完全删除运行时 constraints 检查，class path、loader constraint 或层级变化可能让不兼容的 shared Klass 被错误接入；如果所有类重新 parser/verifier/rewriter，CDS 就失去绕过启动期重复劳动的主要收益。

专家答案的核心判断是：

```text
CDS 不是把安全检查删掉，而是把可提前完成的检查前移，把依赖当前 JVM 世界的检查留到 load 端。
```

## 7. 类加载、链接和初始化是不同状态机

`ClassFileParser` 结束后得到的是可管理的 `InstanceKlass`，不是已经可以执行 `<clinit>` 的类。HotSpot 至少要区分：

```text
parsed/allocated → loaded → linked → being_initialized → fully_initialized
```

Verifier 属于 linking，因为它依赖完整的方法字节码、继承关系和 StackMapTable；`InstanceKlass::link_class_impl` 会递归 link superclass/interfaces，再执行 verify、rewrite、method link 和 vtable/itable 初始化，入口在 `share/oops/instanceKlass.cpp:710` 附近。初始化则由 `InstanceKlass::initialize_impl`（`:891`）协调，只有主动使用触发时才进入 `<clinit>`。

初始化不是普通函数调用：多个线程可能同时触发，但只有一个线程取得初始化执行权；其他线程等待状态变化。`<clinit>` 成功后状态变为 fully initialized；抛异常则记录失败，后续使用不会把同一个失败当成从未执行过而重新无限重试。

超类的 linking 与初始化不能混为一谈：link 阶段要先建立可执行所需的类型和方法结构；初始化有自己的递归顺序和主动使用规则。也因此“类能被找到”只说明 loader/dictionary 层有结果，不代表验证、链接和静态初始化副作用已经发生。

## 8. StackMapTable 提供 join-point 证据，不替代 verifier

Verifier 的任务是对控制流做抽象解释：当前 frame 持有 locals 与 operand stack 的类型状态，逐条执行 opcode 的 transfer function，并在 branch target/汇合点与 StackMapTable 给出的状态核对。`ClassVerifier::verify_method` 的入口在 `share/classfile/verifier.cpp:630`，方法遍历入口在 `:620` 附近。

StackMapTable 能减少 verifier 在汇合点自行推导全图的成本，但它不是可信的最终答案。Verifier 仍要检查：

- opcode 消费/产生的栈类型；
- branch target 是否落在合法指令边界；
- 方法返回类型与当前栈顶是否匹配；
- `new` 的 offset 是否真实对应创建点；
- `uninitializedThis` 是否在构造函数安全完成前被错误使用。

因此“只读 StackMapTable”会把伪造的 frame 当成事实；“完全删除 StackMapTable”在某些版本路径上可以退回更昂贵的数据流推导，但会增加验证成本，并受 split/old verifier 版本规则约束。安全性来自 parser、StackMapTable 和逐条 verifier 模拟三者的组合，不来自 class file 中某一张表的自我声明。

## 9. JPMS 在 loader visibility 之后增加 readability 与 package access

ClassLoader 负责找到/定义类，JPMS 继续问两个不同问题：源模块是否 reads 目标模块，目标 package 是否以 export/open 方式对 caller 可见。模块和包必须分层保存：`ModuleEntry` 管理 reads、open、patched 等模块级状态，`PackageEntry` 管理包级 export/open 关系；VM linkage 与 Java reflection 还分别有自己的检查路径。

因此：

```text
loadable
  ≠ readable
  ≠ exported for linkage
  ≠ open for deep reflection
```

`--add-reads` 主要改变模块可读边；`--add-exports` 主要改变命名包的链接可见性；`--add-opens` 主要改变深反射访问；`ALL-UNNAMED` 是对 unnamed modules 的限定目标集合，不是把所有模块变成无条件可见。Java `Module.isExported` 也不等于完整 caller access check，不能代替 VM 的 linkage 或 reflection 路径。

静态链接通常需要 readability 加 package export；深反射还需要 open 语义。open module 可以放宽包的反射开放规则，但不会把所有模块关系自动改成普通 read edge。专家回答必须能指出这些门分别由哪一层状态和哪条调用链判断，而不能只说“JPMS 更严格”。

## 评分锚点

- **合格**：能讲出 parser、dictionary、CDS dump/load 的主要顺序。
- **良好**：能区分 defining/initiating loader、loading/defined、dump/load 状态。
- **专家级**：能用 ownership、地址稳定性、页权限、类身份和延迟约束把三条链串起来，并能指出一个失败方案在哪个不变量上破坏。
