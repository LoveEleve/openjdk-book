# 07. javaClasses：核心 Java 对象为什么要和 JVM 签一份“偏移契约”

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文聚焦 `javaClasses` 这套 VM-side 核心镜像访问器，说明它怎样把少数 Java 对象升级成 JVM 可直接读写的协议对象。
> **前置依赖**：[01 — ClassFile 解析](01-classfile-parser.md)：injected fields 与类布局在 parser 阶段如何进入元数据；[03 — Symbol 与 StringTable](03-symbol-string-table.md)：`String` 的 compact storage 与 `create_from_unicode` 背景；[04 — SystemDictionary](04-system-dictionary.md)：well-known 类如何被缓存；[06 — JPMS Modules](06-jpms-modules.md)：`ModuleEntry` 持有 `java.lang.Module` 镜像是第一条 mirror 边；[06-oops/02 — Klass 层次](../06-oops/02-klass-hierarchy.md)：`Klass::_java_mirror` 是镜像的反向入口
> → **后续**：[09-memory-core/01 — Universe + CollectedHeap](../09-memory-core/01-universe-heap.md)
> 关联域：06-oops、07-classfile-classloader、09-memory-core、16-code-cache

## 为什么 JVM 不直接反射读取 `String.value`

如果只从 Java 语言的角度看，一个对象的字段访问有很多现成办法：

- 直接调用 Java 方法
- 通过反射拿 `Field`
- 通过类元数据按名字查字段

所以很自然会问：为什么 HotSpot 还要单独维护一套 `javaClasses` 模块，为 `String`、`Thread`、`Class` 这类核心对象缓存偏移，并提供 `java_lang_String::value(...)`、`java_lang_Thread::thread(...)` 这样的 native 访问器？

答案在于它们的使用频率和使用场景都已经高到不允许“每次访问时再想一遍字段在哪”。

比如：

- C2 优化 `"hello".length()` 时，不可能每次再去做反射或名字查找
- String dedup 在 GC 路径上，需要快速拿到 `value` 数组、`coder` 和缓存 `hash`
- `Thread.currentThread()` 和 `Thread.isAlive()` 的 VM 路径，必须直接把 Java `Thread` 对象与 `JavaThread*` 互相定位
- `jstack` 打印线程信息时，需要在 safepoint/诊断路径上直接读 `name`、`tid`、`threadStatus`
- `java.lang.Class` 自己还扮演着 mirror，对 JVM 来说它既是普通 Java 对象，又是类元数据的宿主

这些路径有一个共同要求：

```text
启动时验证一次对象布局
  → 之后高频路径直接按偏移访问
  → 不再走 Java 反射或运行时字段查找
```

本文真正的问题是：

**为什么 HotSpot 不把这些高频对象继续当普通 Java 对象看待，而要给它们单独建立一套“启动期偏移契约 + native 镜像访问器”？这套契约为什么要先算 `String`/`Class`，后算其他类？`String`、`Thread`、`Class` 三类对象又各自暴露了哪种不同层次的镜像关系？**

先把全篇主线画出来：

```text
核心 Java 对象（String / Thread / Class / ...）
  │
  ├─ Java class layout
  │
  ├─ 启动期 offset contract
  │    ├─ PART1: String / Class 先算
  │    ├─ PART2: 其余 well-known classes 后算
  │    ├─ ordinary field -> find_local_field
  │    └─ injected field -> InjectedField + AllFieldStream
  │
  ├─ `java_lang_Xxx` mirror helper
  │    ├─ static int offset caches
  │    ├─ inline obj/int/address/metadata field accessors
  │    └─ mismatch -> startup fail fast
  │
  └─ Consumers
       ├─ C2 / GraphKit
       ├─ GC / StringDedup
       ├─ Thread runtime / jstack
       └─ Class mirror / static fields / Klass linkage
```

一句话先记住：

**`javaClasses` 不是 JVM 版反射，而是 HotSpot 与少数核心 Java 对象之间的启动期偏移契约：启动时按真实类布局算偏移，运行时所有高频路径都只走 `java_lang_Xxx` 这套 native 访问器。**

---

## 一、三个看似更简单的方案，为什么都不够

### 1.1 每次需要时再按名字查字段

最自然的做法是：

```text
想读 String.value
  → 通过 Klass / 字段表查 value
  → 取 offset
  → 再读对象
```

这在功能上当然可行，但对于高频路径来说代价太重：

- JIT 生成机器码时没法把偏移直接嵌成常量
- GC 路径上每次还要走一遍名字匹配和字段描述查找
- 线程系统里 `currentThread` / `isAlive` 这种极短路径会被元数据访问放大

HotSpot 希望的是：

```text
偏移在启动时算好
  → 后续所有读写都像访问普通结构体字段一样直接
```

### 1.2 把所有偏移都硬编码进 VM

另一种极端是：既然这些核心类很重要，就把 `String.value`、`Thread.eetop`、`Class.klass` 的偏移全写死在 C++ 源码里。

这又会立刻产生另一个问题：VM 和 JDK class layout 紧耦合，但 layout 不是永远不变。只要 Java 侧字段次序、插入方式、注入字段或构建条件有变化，硬编码偏移就可能静默错读。

这种错比“启动时报错”更可怕，因为它会变成运行时任意行为异常。

### 1.3 统一走 Java 反射 API

再退一步，既然 Java 本身有 `Field` 和反射，不如都通过 Java API 来访问。

这对 `String`、`Thread`、`Class` 这样的对象尤其不合适：

- 解释器、JIT、GC 和线程系统都在 C++ 世界
- 很多路径发生在 JVM 启动早期或 safepoint/GC 期间
- 反射自身还依赖 `Class` / `String` 等核心对象工作正常

换句话说，**这些对象既是 Java 世界的普通对象，又是 VM 自己运行机制的一部分。** 这就要求 JVM 有一套不依赖 Java 反射的直接协议。

所以 HotSpot 选的是中间路线：

```text
不在运行时每次动态查字段
也不盲目永久硬编码所有偏移
而是在启动时用真实类布局算偏移，算错即启动失败
```

这就是 offset contract 的本质。

---

## 二、javaClasses 模式：不是 Java 反射，而是启动期偏移契约

### 2.1 每个核心类一个 `AllStatic` helper，不保存对象，只保存协议

`javaClasses.hpp:50-87` 定义了 well-known Java classes 的列表，分成两批：

- `BASIC_JAVA_CLASSES_DO_PART1`：`java_lang_Class`、`java_lang_String`
- `BASIC_JAVA_CLASSES_DO_PART2`：其余 29 个左右的核心镜像类

这些 helper 都是 `AllStatic` 风格，不保存实例对象，而是保存：

- 若干个 `static int offset`
- 一组静态访问器
- 一些初始化状态位

例如 `java_lang_String` 只声明了：

```cpp
static int value_offset;
static int hash_offset;
static int coder_offset;
static bool initialized;
```

这就说明 `javaClasses` 的目标从来不是“建一份 Java 对象副本”，而是建立一份 VM 可直接消费的访问协议。

### 2.2 `compute_offset` 是启动时一次性验证真实布局

普通字段偏移不是盲写常量，而是在启动期用已加载类的元数据查出来。`compute_offset` 在 `javaClasses.cpp:118-143` 中：

- 要求拿到 `InstanceKlass*`
- 用 `find_local_field(name, signature, &fd)` 找本地字段
- 校验 static/non-static 是否符合预期
- 成功则取 `fd.offset()`
- 失败直接 `vm_exit_during_initialization`

所以这里的合同不是：

```text
“我猜 String 的 coder 在 offset N”
```

而是：

```text
“启动时我用真实类布局核一次；核不通，整个 VM 拒绝继续跑”
```

这就是为什么这套设计更像“启动期偏移契约”，而不是“反射查字段”。

### 2.3 ordinary fields 与 injected fields 有两条不同路径

不是所有字段都能靠 `find_local_field` 找到。`java.lang.Class` 等核心类有 injected fields，它们在 parser 阶段被 JVM 注入，不是普通 Java 源码字段。

因此 `javaClasses` 有两套 offset 发现路径：

```text
ordinary field
  → compute_offset
  → find_local_field(name, signature)

injected field
  → InjectedField::compute_offset
  → AllFieldStream + internal-field filtering
```

这再次说明 `javaClasses` 不是一层统一“字段查找工具”，而是一套专门处理 well-known class layout 契约的工具箱。

### 2.4 有些偏移运行时算，有些偏移仍然硬编码验证

头文件注释已经点得很清楚：most offsets are hardwired for performance，而部分偏移会在启动时计算。

所以不能把这套系统写成任何一边的绝对命题：

- 不是“所有偏移都动态发现”
- 也不是“所有偏移都硬编码在 VM 里”

更准确是：**HotSpot 对少数布局敏感的核心字段建立了经启动验证的偏移缓存，并保留少量硬编码/验证路径以满足 bootstrap 和性能需求。**

### 2.5 failure mode 设计成“启动即死”，而不是运行时慢慢错

`compute_offset` / `InjectedField::compute_offset` 找不到字段或静态性不匹配时，直接 `vm_exit_during_initialization`。

这不是粗暴，而是有意设计的失败模式。对于这类核心契约，HotSpot 宁愿在启动期明确失败，也不接受“运行了半小时之后某个 GC/线程/JIT 路径突然按错偏移”的隐蔽错误。

---

## 三、为什么 `String` 和 `Class` 要先算，其他镜像后算

### 3.1 PART1 与 PART2 不是为了排版，而是时序依赖

`SystemDictionary::resolve_well_known_classes()` 在 `systemDictionary.cpp:2012-2015` 中明确：

```cpp
java_lang_String::compute_offsets();
java_lang_Class::compute_offsets();
```

紧接着才是：

```cpp
Universe::initialize_basic_type_mirrors();
Universe::fixup_mirrors();
```

也就是说，`String` 和 `Class` 的偏移不是随便先算，而是它们后面马上会被大量使用：

- `String` 是异常、日志、类加载等路径的基础对象
- `Class` 是 mirror 建立和修复的基础对象

### 3.2 bulk compute 只覆盖 PART2

`JavaClasses::compute_offsets()` 在 `javaClasses.cpp:4475-4482` 中明确写着：String 和 Class 已经在 `resolve_well_known_classes()` 里算过，这里只对 `PART2` 批量执行 `DO_COMPUTE_OFFSETS`。

这说明整体时序是：

```text
先保证 String/Class 可以安全被 VM 高频使用
再把其余 well-known classes 的 offset contract 一次性补齐
```

### 3.3 `update_delayed_values()` 的意义主要在解释器/assembler 侧

bulk compute 完成后立刻调用：

```cpp
AbstractAssembler::update_delayed_values();
```

这说明至少有一部分早生成的解释器/assembler 常量需要在 offset 最终就绪后补丁/刷新。

这里要谨慎表述：它能证明“生成的解释器代码关注这些 offset 并允许延迟补值”，但不应该被夸张成“所有 JIT 机器码都会在这里统一重写”。本文最好把这个意义限定在**启动时序与延迟常量补丁**上。

---

## 四、String：三个偏移为什么能撑起编码、去重和 JIT

### 4.1 `value`、`coder`、`hash` 就是 String mirror contract 的核心

`java_lang_String` 最核心的三个偏移是：

- `value_offset`
- `hash_offset`
- `coder_offset`

它们对应的是：

```text
value  -> backing byte[]
hash   -> Java String 的缓存 hash
coder  -> LATIN1 / UTF16 选择位
```

这里要特别强调一个 JDK 9+ 之后的事实：**String 的 backing store 永远是 `byte[]`。** Latin-1 时一个字符一字节，UTF-16 时数组长度翻倍，逻辑长度要再按 `coder` 缩回去。

### 4.2 `length()` 的核心其实就是“数组长度右移 coder 位”

`javaClasses.inline.hpp:74-87` 的 `java_lang_String::length` 逻辑很直接：

- 先取 `value` 数组长度
- 若 `coder == UTF16`，右移一位
- 否则原样返回

这不是“模拟 Java `String.length()` 方法”，而是 mirror 协议本身已经把长度计算缩成了：

```text
array.length >> coder
```

### 4.3 C2 直接消费的是 `value` / `coder` 这套 contract

`GraphKit::load_String_length()` 在 `graphKit.cpp:3887-3893` 中直接：

- 读 `String.value`
- 取数组长度
- 读 `String.coder`
- 用右移处理 UTF-16

这就是 offset contract 给 JIT 的真正礼物：**在代码生成时直接把偏移嵌进去，把 Java 方法调用和字段查找都消掉。**

这里表述要收紧到“value/coder 等关键偏移被 C2 直接消费”。不要泛化成“JIT 对 String 的所有字段都做同等直读”。当前最直接、最清楚的证据是长度和字符串优化路径对 `value`/`coder` 的直接使用。

### 4.4 String dedup 也只走镜像访问器

String dedup 路径在 `stringDedupTable.cpp:345-393` 中只通过：

- `java_lang_String::value`
- `java_lang_String::is_latin1`
- `java_lang_String::hash`
- `java_lang_String::set_hash`
- `java_lang_String::set_value`

来完成 dedup 工作。

也就是说，GC 并不是“看懂 Java String 类”，而是消费了 `java_lang_String` 这套已经启动校验好的 offset contract。

这进一步说明 `javaClasses` 的价值：**同一组字段偏移被解释器、JIT 和 GC 共享。**

---

## 五、Thread：为什么 `eetop` 是 `JavaThread*`，而不是 OS 线程 ID

### 5.1 `eetop` 的名字最容易误导人

`THREAD_FIELDS_DO` 把很多 Thread 相关字段都列了出来，其中最特别的是：

```text
eetop
tid
threadStatus
```

这三个字段最容易被误混成“一堆线程 id”。

### 5.2 `eetop` 的真实语义是 `JavaThread*`

`java_lang_Thread::thread()` / `set_thread()` 在 `javaClasses.cpp:1641-1648` 里的定义非常直接：

```cpp
return (JavaThread*)java_thread->address_field(_eetop_offset);
...
java_thread->address_field_put(_eetop_offset, (address)thread);
```

所以 `eetop` 不是 native OS thread id，也不是 Java 层的 `long tid`。它就是：

```text
Java Thread 对象 <-> VM JavaThread* 的镜像握手指针
```

### 5.3 为什么必须在 Java Thread 构造器前绑定 `eetop`

`create_initial_thread` 的注释在 `thread.cpp:1088-1102` 中已经把因果说透了：不能先走普通 Java `Thread` 构造流程，因为构造器内部会调用 `Thread.currentThread()`。

因此 VM 必须先：

- 分配 Thread 对象
- `set_thread(thread_oop, JavaThread*)`
- `thread->set_threadObj(thread_oop)`

然后才让 Java 侧构造逻辑继续。

这说明 `eetop` 不是一个“附加诊断字段”，而是 Thread 对象进入 JVM 运行协议的前提。

### 5.4 `is_alive()` 的语义其实就是 `eetop != NULL`

`java_lang_Thread::is_alive` 直接实现成：

```cpp
JavaThread* thr = java_lang_Thread::thread(java_thread);
return (thr != NULL);
```

这也是现稿最应该强调的一个“不是字段的字段”：`isAlive` 在 VM 侧不是去分析 Java 层 `threadStatus`，而是直接看 mirror 中是否还绑定着一个 `JavaThread*`。

线程退出时，VM 先把状态设成 `TERMINATED`，再 `set_thread(threadObj(), NULL)`。一旦 `eetop` 清空，`is_alive()` 立刻翻成 false。

### 5.5 `#id`、`tid=`、`nid=` 是三种完全不同的身份

`JavaThread::print_on()` 在 `thread.cpp:3011-3026` 中输出线程头时，三种常见 ID 的来源完全不同：

- `#<n>`：`java_lang_Thread::thread_id(thread_oop)`，即 Java 层 `tid` 字段
- `tid=0x...`：VM `Thread*` / `JavaThread*` 自身地址（来自 `Thread::print_on`）
- `nid=0x...`：OS/native thread id（来自 `OSThread::thread_id()`）

所以一定要把最常见的误解拆开：

```text
eetop != tid != nid
```

- `eetop` 是 mirror 中的 `JavaThread*`
- Java `tid` 是 Java 层线程 id 字段
- `nid` 是 OS/native 线程 id

这也是为什么“命名别猜”在 Thread 镜像上尤其重要。

---

## 六、Class：镜像为什么是 injected fields + 双向指针 + 可变大小对象

### 6.1 `java.lang.Class` 是镜像模式里最特别的对象

`String` 和 `Thread` 主要是“按偏移快速访问已有字段”。`Class` 则进一步承担了 VM 元数据的镜像宿主角色。

这让它同时具备三种额外复杂性：

1. 有一批 Java 源码里没有的 injected fields
2. 与 `Klass` 有双向指针绑定
3. 其对象大小本身还是 variable-sized 的

### 6.2 injected fields 不是普通 Java 源码字段

`CLASS_INJECTED_FIELDS` 在 `javaClasses.hpp:216-223` 中列出了 `klass`、`array_klass`、`oop_size`、`static_oop_field_count`、`protection_domain`、`signers`、`source_file` 等字段。

它们全部是 `may_be_java=false`。这意味着：

- parser 会为这些字段注入 internal field metadata
- `InjectedField::compute_offset` 会忽略普通 Java 字段，只看 internal field
- 这些字段不是“恰好同名的 Java 源码字段”在 VM 中被顺手利用

所以文章绝不能把它们写成“Class 里本来就有这些 Java 字段，只是 VM 也在用”。对 JDK 11u 的 `java.lang.Class`，这不对。

### 6.3 `mirror -> Klass` 与 `Klass -> mirror` 是两条不同方向的链

镜像关系有两个方向：

- `java_lang_Class::as_Klass` / `set_klass`：从 Java mirror 到 HotSpot `Klass`
- `Klass::_java_mirror`：从 `Klass` 到 Java mirror

这两条链不能合并成“Class 对象头里就有个 Klass 指针”。

特别要纠偏的一点是：`java_lang_Class::klass` 这个 injected field是通过 `metadata_field` 访问的镜像字段，不是普通对象头中的 Klass 指针槽位。对象头的 Klass 指针决定“这个对象本身是 `java.lang.Class` 的实例”；而 injected `klass` 字段决定“这个 mirror 代表哪个类”。

这两个位置和语义完全不同。

### 6.4 `create_mirror` 的发布顺序是一种事务协议

`create_mirror` 先：

- 分配 `java.lang.Class` mirror 对象
- `set_klass(mirror, k)` 建立 mirror -> Klass
- 计算 `static_oop_field_count`
- 初始化普通/静态/安全相关字段

只有在可能抛异常的步骤都成功后，才：

```cpp
k->set_java_mirror(mirror);
```

如果中途初始化 mirror 字段失败，代码会把 mirror 中的 `klass` 清掉，避免 GC 通过这个半成品 mirror 跟到一个将被回滚的 `Klass`。

所以 `Class` 镜像的双向绑定不是“顺手互相设个指针”，而是带着发布顺序要求的事务式协议。

### 6.5 variable-sized mirror 指的是“固定头 + inline trailing static-field storage”

`InstanceMirrorKlass::instance_size(k)` 会在 base `java.lang.Class` 对象大小之外，再加上目标类的 `static_field_size()`。这说明 mirror 大小不是统一常量。

这里最常见的误解是把它讲成：“Class 有个数组字段保存静态字段”。

更准确的是：

```text
base java.lang.Class 布局
  +
inline trailing storage for represented class's static fields
```

也就是说，静态字段区是紧跟在 mirror 对象后面的内联对象空间，不是另一个单独分配的数组对象。GC 通过 `static_oop_field_count` 只扫描这段 trailing 区里的 oop 部分；`oop_size` 记录整个 mirror 对象的最终大小。

### 6.6 fixup list 与 basic type mirrors 说明镜像也有启动时序问题

在 `java.lang.Class` 自己还没准备好之前，有些类已经先被加载出来了。这些类没法立刻分配 mirror，只能先挂进 `_fixup_mirror_list`。

等 `String` / `Class` offset 先算完、basic type mirrors 初始化好之后，`Universe::fixup_mirrors()` 再统一回填之前积压的普通 class mirrors。

这解释了为什么 `String` / `Class` 必须先算偏移：**mirror 自己就是后续镜像修复与静态字段布局的基础设施。**

---

## 七、消费者视角：为什么这套镜像访问器必须是一套统一协议

到这里，把 `String`、`Thread`、`Class` 放在一起看，会发现它们的共同点不是“都是核心类”，而是：它们都被多条 VM 子系统共享消费。

```text
String
  → JIT / GraphKit
  → StringDedup / GC
  → string creation / hash cache

Thread
  → currentThread / isAlive
  → thread bootstrap / attach / teardown
  → jstack / diagnostics

Class
  → Klass ↔ mirror 双向关系
  → static field storage
  → protection_domain / signers / module 等 VM 私有状态
```

如果这些子系统各自按名字查字段、各自缓存偏移、各自维护一套 mirror 语义，布局变化时会形成多份不一致契约。`javaClasses` 的价值就在于：**用一套启动校验好的 offset/access contract，让 JIT、GC、线程系统和类镜像全都站在同一组偏移之上。**

这也解释了为什么它的失败模式必须是启动即死。因为一旦 contract 不一致，受影响的不是单个 API，而是多个 VM 子系统的共同基础。

---

## 八、误解澄清：八个最容易写过头的判断

1. **javaClasses 是否等于“JVM 版反射”？** 不是。它不是运行时动态字段查询，而是启动期偏移契约和 native 访问器集合。
2. **所有 offset 是否都运行时动态查找？** 不是。有运行时计算的 cached offset，也有硬编码并做验证的路径。
3. **所有 offset 是否都完全硬编码？** 也不是。像 `String`、`Thread`、`Class` 这类关键字段明确通过 startup lookup + validation 缓存。
4. **`eetop` 是否是 OS/native 线程 id？** 不是。它是 `JavaThread*` 镜像指针。
5. **`jstack` 里的 `#id`、`tid=`、`nid=` 是否是一回事？** 不是。分别对应 Java `tid` 字段、VM thread 对象地址、OS 线程 id。
6. **`java_lang_Class::klass` 是否就是对象头里的 Klass 指针？** 不是。对象头里的 Klass 指针说明“这个对象是 `java.lang.Class` 实例”；injected `klass` 字段说明“它代表哪个类”。
7. **injected fields 是否等价于普通 Java 源码字段？** 不是。对 `may_be_java=false` 的字段，VM 用的是内部注入字段，不是普通源字段。
8. **variable-sized mirror 是否等于“Class 里有个数组字段存静态字段”？** 不是。它是 base mirror 布局后跟的 inline trailing static-field storage。

---

## 九、收网：核心镜像的本质，是一次启动期校验，换来全 VM 的零反射访问

回到开头的问题：为什么 HotSpot 要给少数核心 Java 类单独建立 `javaClasses` 这一层？

因为这些对象不是普通业务对象，它们同时处在两套世界的交界面：

```text
Java heap object
  <->
VM metadata / thread runtime / GC / JIT consumer
```

而这类交界面如果每次都靠名字查找、Java 反射或临时推断，会把最核心的高频路径拖慢，甚至在布局漂移时悄悄错读。

所以 HotSpot 选的是一条很明确的路线：

```text
启动时用真实类布局校验偏移
  → 成功则缓存到 `java_lang_Xxx` helper
  → 运行时所有高频路径只走这套访问器
  → 失败则启动即死，不留隐患
```

三句话收束全文：

- **`javaClasses` 不是 JVM 版反射，而是 JVM 与少数核心 Java 对象之间的启动期 offset/access 契约。**
- **`String`、`Thread`、`Class` 三个例子分别代表了压缩编码/JIT、线程镜像桥接、以及 injected fields + 双向 mirror + 可变大小对象三种契约复杂度。**
- **这套契约的真正价值不是“字段访问更快”这么简单，而是让 JIT、GC、线程系统和类镜像共用同一套经过启动验证的对象布局事实。**

下一篇进入这条镜像链更底层的舞台：这些 mirror 对象、基础类型镜像、空数组和最早的一批核心对象，最终都是在 `Universe` 和 `CollectedHeap` 诞生之后才可能出现。也就是 JVM 启动里的“宇宙大爆炸”阶段。

> → [09-memory-core/01 — Universe + CollectedHeap](../09-memory-core/01-universe-heap.md)
