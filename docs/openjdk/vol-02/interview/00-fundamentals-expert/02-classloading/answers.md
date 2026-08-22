# 02 · 类加载、链接与字节码：专家级答案

## 1. 什么是双亲委派？为什么要双亲委派？

**标准答案**

双亲委派的表面规则是：一个类加载请求先交给父加载器，只有父加载器加载失败，当前加载器才自己去定义这个类。

**进程 / OS 视角**

从进程角度看，双亲委派不是“问谁先加载”的礼貌问题，而是在同一个 JVM 进程里保证**类型身份不混乱**。同一个字节流如果被两个不同 loader 定义，就会得到两个彼此不相等的 `Klass`，哪怕类名完全一样。也就是说，双亲委派解决的不是“查找效率”，而是“同名类在同一加载域里只能有一个定义结果”。

**HotSpot 实现视角**

真正要把这题答深，必须把 **initiating loader** 和 **defining loader** 拆开：

- **initiating loader**：发起这次类解析请求的 loader；
- **defining loader**：最终真正定义这个类的 loader。

委派模型保证的是：在某个 initiating loader 的视角下，某个类名最终只能绑定到一个类结果。HotSpot 的 `SystemDictionary` 正是按 `(name, initiating loader, protection domain)` 这一组信息组织类解析，而不是只用类名做全局哈希。

再进一步，真正持有类元数据生命周期的也不是 Java 层的 `ClassLoader` 对象，而是 VM 侧的 `ClassLoaderData`。CLD 管着 dictionary、`_klasses` 链、metaspace、handles 和 package/module 表，所以“双亲委派”在 Java API 层只是入口协议，在 VM 里真正决定类身份和生命周期的是 CLD + `SystemDictionary`。

**演进边界**

- JDK 8 时，把双亲委派画成三层箭头图（App → Ext → Bootstrap）还能勉强讲通；
- JDK 9+ 以后，`BuiltinClassLoader` 会先按 package/module owner 路由，所以“沿父链逐层找”已经不是完整事实。
- `parent == null` 也不等于“没有父”——它通常意味着切到 bootstrap 的 VM 路径，而不是停止委派。

**收束句**

双亲委派真正保护的不是“谁先加载”，而是**同一个名字在同一个加载域里只能对应一个类身份**。

## 2. JDK 有哪几种 ClassLoader？

**标准答案**

常见回答是三种：Bootstrap、Platform（JDK 9 之前叫 Extension）和 AppClassLoader。

**进程 / OS 视角**

从进程视角看，这三者并不是三个平级服务线程或三段独立内存，而是 JVM 内部三种不同的“类定义来源”。它们共享一个进程、共享一个堆、共享一套 GC，但每个 loader 拥有自己的类定义域和可见性边界。

**HotSpot 实现视角**

这题想答到位，关键不在于名字，而在于两层区分：

1. **Java API 层**：你在 `ClassLoader.getParent()` 上能看到的父链；
2. **VM 实现层**：真正持有类元数据和模块表的 `ClassLoaderData`。

Bootstrap 在 Java 侧通常表现为 `null`，但在 VM 里并不等于“没有东西”——它有自己的 singleton `ClassLoaderData`。Platform/App 则是 Java 对象与 CLD 成对出现。JDK 9 之后，`BuiltinClassLoader` 的 package/module 路由让 Platform Loader 并不只是“App 的父”，它还承担模块级别的可见性和搜索路径职责。

**演进边界**

- JDK 8 的面试里很多人还会说 ExtClassLoader，这在 JDK 9+ 已被 PlatformClassLoader 替代；
- JDK 9+ 模块系统下，“由哪个 loader 加载”已经和“这个包属于哪个模块”强绑定，不能只按旧版 classpath 逻辑理解。

**收束句**

ClassLoader 的种类本身不重要，重要的是：**每个 loader 定义了一个类身份边界，而 VM 用 `ClassLoaderData` 把这个边界落实成真正的元数据仓库。**

## 3. 什么是打破双亲委派？

**标准答案**

打破双亲委派通常指子加载器不再无条件先问父，而是自己先尝试加载，再决定是否委派给父。

**进程 / OS 视角**

从进程视角看，“打破双亲委派”不是违反规则，而是在同一个 JVM 进程里**主动制造新的类身份隔离层**。最常见的场景不是炫技，而是为了让应用容器、插件系统、JDBC 驱动、热部署这类场景在一个进程里装下多个版本的同名类。

**HotSpot 实现视角**

最典型的两种方式：

- 覆写 `loadClass()`，直接先走 `findClass()`；
- 借助 `Thread.currentThread().getContextClassLoader()`，让上层框架指定由哪个 loader 去做定义。

JDBC SPI、Tomcat/Web 容器、热部署框架基本都属于这种情况。Java 侧看起来是“子类自己加载”，VM 侧本质上就是多出一个新的 `ClassLoaderData` 和 dictionary，让同名类可以在不同域里共存。

所以打破双亲委派的重点不是“顺序改了”，而是：**它让同一个类名在一个进程里出现多个合法但互不相等的类定义。**

面试里如果只答“为了 SPI、容器、热部署，所以要打破双亲委派”，层次还不够。真正能拉开差距的是补一句：**打破双亲委派带来的根本后果，是 class identity 变化。** 同名类在不同 loader 下不是“一个类的两个版本”，而是两个不同的类型；`instanceof`、方法参数匹配、字段访问和强制转换都以这个身份边界为准。这也是为什么容器/插件体系必须把 loader 边界设计得很小心——不是怕加载顺序错，而是怕同名类在错误的 loader 里被定义，导致看起来“类名一样、字节码一样”，运行时却互相不可赋值。

**演进边界**

- JDK 9+ 模块系统后，`ContextClassLoader` 仍然很重要，因为很多 SPI 场景不能只靠模块读边解决；
- 但打破双亲委派并不意味着绕过 `SystemDictionary`，最终类结果还是要回到 VM 的 dictionary/CLD 里登记。

**收束句**

打破双亲委派，真正打破的不是“流程”，而是**默认只有一套类身份层次的假设**。

## 4. `NoClassDefFoundError` 和 `ClassNotFoundException` 的区别？

**标准答案**

`ClassNotFoundException` 是异常，通常发生在显示加载类时没找到；`NoClassDefFoundError` 是错误，通常表示类在运行时无法被定义或链接。

**进程 / OS 视角**

从进程角度看，前者更像“按名字查资源失败”，后者更像“这次运行里类身份世界已经不一致了，JVM 没法继续假装这个类是可用的”。

**HotSpot 实现视角**

- `ClassNotFoundException` 通常来自 `Class.forName()`/`ClassLoader.loadClass()` 这类显式查找；
- `NoClassDefFoundError` 往往出现在链接、初始化或依赖展开阶段，比如：
  - 类之前是能找到的，但定义过程中静态初始化失败；
  - 依赖类在运行时缺失；
  - 一个类的字节流存在，但其 super/interface 无法正确解析。

所以 `NoClassDefFoundError` 的严重性更高，它意味着“这个类的可用性已经被当前运行状态破坏”，而不是简单“按名字没查到”。

**演进边界**

- 模块系统之后，类“能找到但不能访问”的错误路径也更多，某些场景下会走 `IllegalAccessError` 而不是 `ClassNotFoundException`。

**收束句**

一个是“查找失败”，一个是“运行时定义/链接世界失效”，它们压根不是同一级的问题。

## 5. 什么是 `String.intern()`？常量池在哪？

**标准答案**

`String.intern()` 会返回一个字符串常量池中的规范实例，使相同内容的字符串共享一份对象。

**进程 / OS 视角**

真正拉开差距的是你能不能指出：JDK 8 之后，所谓“字符串常量池”不再意味着“方法区里放着一堆 String 对象”。

在进程里，字符串对象本身住在 Java heap 上，常量池/去重表只存到它们的引用或索引关系。也就是说，进程地址空间里你能看到的是堆上的 `String` 对象和 Metaspace 里的 `ConstantPool` 元数据，而不是一个神秘的“常量池内存区”。

**HotSpot 实现视角**

必须分开说两件事：

- **运行时常量池**：跟着 `ConstantPool`，属于类元数据，住在 Metaspace；
- **StringTable**：对 `String` 对象做 canonicalization 的表，表本身是 VM 结构，`String` 对象在 Java heap 上。

所以 `intern()` 的本质不是“把字符串塞进方法区”，而是“到 StringTable 里找/放一份共享的 Java heap `String` 对象”。这也是为什么 JDK 7 以后，“字符串常量池在堆上”这句话才是对的，而不是“在方法区里”。

这里还要再钉死三层身份，不然很容易滑回经典面试口水题：

1. **class 文件/运行时常量池里的字符串项**——这还是符号/字面量层的描述，不是 heap `String` 对象；
2. **StringTable 条目**——这是 JVM 用来 canonicalize Java `String` 对象的表；
3. **heap 上真正的 `String` 对象**——Java 代码能拿到、能 `==`/`equals` 的对象实体。

也就是说，`ldc "abc"` 命中的是常量池里的字符串字面量项，但它要变成一个真正可交给 Java 世界使用的 `String` 对象，还要走 StringTable 这条 materialize / 查重路径。面试里问“`new String("abc")` 创建几个对象”时，真正能把人和人拉开差距的，不是背“一个还是两个”，而是说明**常量池项、StringTable 条目、heap String 对象这三层什么时候各自出现**。只要这三层能讲清，题目就不再是八股。

**演进边界**

- JDK 6/7 前，很多教材会说 intern 进 PermGen；
- JDK 7 起字符串池迁到堆；
- JDK 8 以后再说“常量池都在方法区里”就会混淆 `ConstantPool` 和 `StringTable`。

**收束句**

`intern()` 真正做的不是“搬位置”，而是**给 Java heap 上的字符串对象建立一套全局规范身份。**

## 6. 什么是字节码？`javap -c` 能看到什么？

**标准答案**

字节码是 JVM 执行 Java 方法时使用的中间指令集。`javap -c` 可以反汇编方法，看到每条字节码指令和它的操作数。

**进程 / OS 视角**

从进程视角看，字节码本身并不直接执行在 CPU 上。它是类文件里的静态描述，真正进入运行时后，会先由解释器逐条执行，或者在热点路径上被 C1/C2 编译成机器码。所以 `javap -c` 展示的是“解释器/JIT 的共同输入”，不是“CPU 会直接跑的指令”。

**HotSpot 实现视角**

字节码在 HotSpot 里至少有三种重要角色：

- 给 `ClassFileParser` 和 verifier 做格式/类型安全校验；
- 给解释器做模板分派；
- 给 C1/C2 做 IR 构建输入。

`javap -v` 还能看到 `StackMapTable`、局部变量表、异常表等额外信息。像 `long/double` 占两个 slot、StackMapTable 中的 append/full 帧，都是 verifier 的直接输入，而不是解释器随手忽略的注释。

**演进边界**

- JDK 8 以后，invokedynamic、LambdaForm、MethodHandle 等字节码语义越来越重要，不再只是“classical OO”指令集合。

**收束句**

字节码不是“伪汇编”，而是**类加载、验证、解释执行和 JIT 编译共同依赖的事实源。**

## 7. 为什么 `long` 和 `double` 占两个 slot？

**标准答案**

JVM 规范规定 `long` 和 `double` 是 64 位值，在局部变量表和操作数栈里各占两个 slot。

**进程 / OS 视角**

从今天 64 位机器的直觉看，“一个值占两个 slot”很反直觉，因为寄存器和栈槽通常已经是 64 位了。但 JVM 规范的 slot 概念不是“当前机器字长”，而是抽象执行模型。它允许 JVM 在不同平台上用统一的操作数栈规则解释字节码。

**HotSpot 实现视角**

在 HotSpot verifier 里，这不是一个抽象说明，而是一个显式类型系统：

- 文件格式里，`long`/`double` 的第二槽通常表现为 `Top`；
- 内存里的 `VerificationType` 则用 `Long_2nd`/`Double_2nd` 显式跟踪次槽。

这样做的原因是：如果第二槽只是一个模糊的 `Top`，验证器就更难保证“双槽值”的完整性。显式的 `2nd` 类型让“long/double 必须成对出现”变成可检查的约束。

**演进边界**

- 这是 JVM 规范级约束，不因 32 位或 64 位平台而改变；
- HotSpot 只是在内部把这个约束做得更显式。

**收束句**

`long`/`double` 占两个 slot，考的不是字长，而是**你能不能区分 JVM 规范的抽象执行模型和今天硬件寄存器宽度。**

## 8. 类加载过程分几步？

**标准答案**

常见说法是：加载（Loading）→ 验证（Verification）→ 准备（Preparation）→ 解析（Resolution）→ 初始化（Initialization）。

**进程 / OS 视角**

如果只背这五步，面试官通常不会满意。真正要讲的是：这不是五个无关标签，而是 JVM 把“字节流 → 可执行 Java 类型”拆成五个不同的控制点。

- 加载：先把字节流读进来；
- 验证：保证这份字节流的类型状态不会在运行时把 VM 打穿；
- 准备：静态变量分配与零值；
- 解析：把符号引用按需接成直接引用；
- 初始化：真正执行 `<clinit>`，让类的静态副作用发生。

从进程角度看，前四步都还没有让“用户 Java 代码”真正开始跑，只是在建立一个安全、可用的类型世界。

**HotSpot 实现视角**

HotSpot 里这几步分散在：

- `ClassFileParser`：把 hostile byte stream 变成 parser-owned 元数据图；
- `define_instance_class`：让类进入 loaded 状态；
- `verify_code` / `ClassVerifier::verify_method`：在 link 期做逐方法类型证明；
- `rewrite_class` / `link_methods` / vtable/itable：把类推进到 linked；
- `initialize_impl`：真正执行 `<clinit>` 并设置初始化状态。

所以“类加载过程”并不是一条 Java API 层的流水线，而是一条跨 parser、SystemDictionary、verifier、linker 和 `<clinit>` 执行器的 VM 内链路。

**演进边界**

- JDK 9+ 的模块系统让“能加载到类”与“能合法访问这个类”彻底拆开，所以现在答类加载过程时最好主动补一句：加载成功不代表模块访问就会成功。

**收束句**

类加载过程真正考的是：**你能不能把“字节流被读到”和“类真的变得可执行”这两件事分开。**
## 9. 什么时候触发类初始化？

**标准答案**

主动使用一个类时会触发初始化，例如：`new`、访问静态字段、调用静态方法、反射强制初始化等；而仅仅拿到 `Class` 对象、定义数组类型、`loadClass` 并不一定触发初始化。

**进程 / OS 视角**

类初始化本质上是在 JVM 里执行一段特殊的方法——`<clinit>`。所以“类是否初始化”并不是一个布尔标记，而是一段真实代码有没有被执行过、其副作用是否已经发生。这也是为什么类初始化要受线程安全保护：一个类的 `<clinit>` 只能有一个线程执行，其他线程等待它结束。

**HotSpot 实现视角**

HotSpot 用 `InstanceKlass::initialize_impl` 维护初始化状态机：从 `loaded`/`linked` 到 `being_initialized`，再到 `fully_initialized` 或失败状态。触发时机由“主动引用”决定：

- `new` 一个对象
- 访问或赋值静态字段（非常量字段）
- 调用静态方法
- `Class.forName(..., true, loader)`
- 反射强制初始化

而像 `ClassLoader.loadClass`、定义数组类、读取编译期常量的静态 final 字段，不一定触发 `<clinit>`。这就是“加载”和“初始化”必须分开的原因。

**演进边界**

- JDK 9+ 模块系统会在“能否访问类”与“是否触发初始化”之间再加一层访问门槛。

**收束句**

类初始化真正考的是：**你能不能把“类存在了”和“类的静态副作用已经发生”分开。**

## 10. 静态块、实例块、构造器、父类的执行顺序？

**标准答案**

顺序是：父类静态块 → 子类静态块 → 父类实例块 / 父类构造器 → 子类实例块 / 子类构造器。

**进程 / OS 视角**

这不是语法糖问题，而是“类级副作用”和“对象级副作用”分属两个阶段：类初始化阶段执行静态块和静态字段初始化；对象创建阶段执行实例块和构造器。父类优先，是因为子类对象里天然包含父类布局，父类必须先完成自己的初始化与构造。

**HotSpot 实现视角**

- 静态块和静态字段初始化都编进 `<clinit>`；
- 实例块和实例字段初始化编进 `<init>`；
- `<init>` 的第一条重要动作通常是 `invokespecial` 调父类构造器；
- verifier 用 `UninitializedThis` 保证在父类构造完成前，`this` 不会被错误使用。

所以这题真正该答到的是：**JVM 不认识“静态块”和“实例块”这些语法名词，它只认识 `<clinit>` 和 `<init>` 两种特殊方法。**

**演进边界**

- 编译期常量的静态 final 字段在常量折叠后，读取时可能根本不触发类初始化。

**收束句**

静态块 / 实例块 / 构造器顺序的本质，不是背口诀，而是理解 **`<clinit>` 和 `<init>` 分别属于类和对象两个生命周期阶段。**

## 11. `Class.forName` 和 `ClassLoader.loadClass` 的区别？

**标准答案**

最常见的区别是：`Class.forName` 默认会触发类初始化，而 `ClassLoader.loadClass` 通常只完成加载，不执行 `<clinit>`。

**进程 / OS 视角**

从进程视角看，这个差别的本质是：你是“只想把类型世界准备好”，还是“连它的静态副作用也一起执行”。`loadClass` 更像把类准备到可用状态；`Class.forName` 更像“把这段类型和它的初始化副作用一起点亮”。

**HotSpot 实现视角**

- `Class.forName(name, true, loader)` 会在返回前强制初始化；
- `ClassLoader.loadClass` 只返回 `Class<?>`，通常对应 loaded/linked 状态；
- 真正的初始化仍落到 `initialize_impl`；
- 这也是很多 JDBC/SPI 老代码里喜欢用 `Class.forName("com.mysql.Driver")` 的原因——它不只是要拿到 `Class`，而是要触发驱动的静态注册副作用。

**演进边界**

- JDK 9+ 模块系统下，即使 `Class.forName` 指定了初始化，也先得通过模块访问控制；
- 如果 `<clinit>` 执行失败，后续再引用该类会进入 `NoClassDefFoundError` 路径。

**收束句**

`Class.forName` 与 `loadClass` 的关键区别，不是“一个静态一个实例”，而是**一个要类型，一个要副作用。**

这里再补一个容易被面试答案讲错的边界：很多人会把 `loadClass()` 说成“只加载不链接”，这在口语里能沟通，但不够精确。更稳妥的说法是：**`loadClass()` 通常返回一个尚未触发初始化的类，但链接/解析何时完成，仍取决于后续使用路径和当前实现。** 也就是说，真正稳定的区分是“是否强制执行 `<clinit>`”，而不是把所有解析/链接时机都粗暴压成一句“forName 会、loadClass 不会”。如果在面试里能主动把这层边界说出来，说明你不是在背 API 差异，而是在区分规范层和 HotSpot 实现层的时序。 

## 12. `new String("abc")` 创建了几个对象？

**标准答案**

最常见的面试答案是：通常会涉及两个对象——字符串字面量对应的常量池对象（如果此前不存在）和 `new` 出来的那个 `String` 对象。

**进程 / OS 视角**

真正要拉开差距的是指出：这题不是在问“记忆题”，而是在考你能否区分：

- 类文件中的字面量符号
- StringTable 里的规范实例
- Java heap 上实际分配出来的 `String` 对象

所以“几个对象”取决于上下文：如果常量池里已经有 `"abc"` 的规范实例，再执行 `new String("abc")` 时，只会新建那个包装对象；如果这是第一次用到 `"abc"`，JVM 还需要先把字面量 materialize 成 heap 上的 `String`。

**HotSpot 实现视角**

`ldc "abc"` 命中的是运行时常量池中的字符串字面量路径，HotSpot 通过 `StringTable` 查找/创建规范实例。之后 `new String("abc")` 调的是 `String(String original)` 构造器，创建一个新对象，其底层 value 会共享或复制取决于版本实现（JDK 9+ Compact Strings 改成 byte[] + coder）。

所以严格说：

- **至少** 会创建 1 个新的 `String` 对象（`new` 出来的那个）
- **是否额外创建字面量对应的规范实例**，取决于这个字面量此前是否已经被 materialize

**演进边界**

- JDK 9+ `String` 的内部表示从 `char[]` 变成了 `byte[] + coder`，这题再答“共享 char[]”就会暴露版本过时。

**收束句**

这题本质上不是在考“几个对象”，而是在考你能不能把 **字面量、StringTable 和 heap 对象** 三层身份分开。 
