# 03. 地址链变成人话 —— FrameName、Java 方法与类型后缀

> **前置依赖**：[02 —— ELF 符号解析与 demangle](./02-symbol-resolution.md)、[AP-3 VMStructs/CodeCache](../03-jvm-integration/03-vmstructs-stackwalk.md)
> → **后续**：调用栈存储、去重与内存分配
>
> 场景：采样器和栈行走器拿到的是 `jmethodID`、native 名字、线程 ID 和各种 `BCI_*` 特殊帧，但输出层需要一份人类可读、可过滤、可携带类型语义的统一名字。
>
> 本篇基于当前 async-profiler 源码，重点讨论 `FrameName` 如何把不同来源的帧身份翻译成输出层能消费的字符串。这里讲的是“帧身份 → 显示名字”的统一翻译层，不重新讲地址归属、栈行走或输出格式本身；结论以 `src/frameName.cpp`、`src/frameName.h`、`src/vmEntry.h` 与 demangle 相关实现为准。

## 先把真正的困惑摆出来：采样器手里拿到的根本不是方法名

走到这一层，async-profiler 手里已经有了调用链，但这并不等于它已经有了“人能看懂的栈”。`ASGCT_CallFrame` 只有两个核心字段：`bci` 和 `method_id`。看起来像一个 Java 方法，其实远没有这么简单。

`method_id` 有时真的是 `jmethodID`，可 `bci` 也可能把它解释成完全不同的东西：native 符号名、分配对象的类、锁对象的类、线程 ID、PC 地址、错误字符串、CPU 号……`src/vmEntry.h:41-53` 里这一组 `BCI_*` 定义，实际上已经在告诉你：同一个 `ASGCT_CallFrame` 结构，承载的是好几个世界的身份。

这也是为什么“地址链变成人话”并不是把 `jmethodID` 简单打印一下那么轻松。输出层真正需要的是一套统一答案：

- 如果这是 Java 方法，它应该显示成哪种类名、方法名、签名格式？
- 如果这是 native 符号，需不需要 demangle，要不要带库名？
- 如果这是线程帧、错误帧、CPU 帧、分配帧、锁帧，它该长成什么名字？
- 如果这是解释器/JIT/inlined/C1 路径，同一个方法名后面要不要保留类型语义？
- 如果用户开启了 simple/dotted/normalize/annotate 样式，最终名字又该怎么变？

最直觉的失败方案有两个。

第一个，是直接把 `jmethodID`、native 名字或内部标记原样交给 flamegraph/JFR/OTLP。这样虽然“最省事”，但输出层就得各自重新理解：这是 Java 还是 native，这个 ID 要不要查 JVMTI，这个名字要不要 demangle，这个线程帧到底叫什么。等于把解释负担到处复制。

第二个，是把 Java 命名、native 命名、线程名、style 变换、类型后缀分散在不同输出器里：collapsed 自己拼一套，flamegraph 自己拼一套，OTLP 再拼一套。这样看似更灵活，实际上会把“同一个帧身份到底叫什么”这件事拆成多份实现，最后很容易出现术语漂移和显示不一致。

当前实现的选择，是把这些职责压到同一层：`FrameName`。它不是“字符串美化器”，而是输出阶段的统一翻译层。采样器、walker、ELF 解析、classMap、JVMTI、demangle、thread name map 负责把身份尽量保存轻量；`FrameName` 则在真正需要展示和过滤时，把这些轻量身份统一翻译成不同消费者都能理解的名字。

```text
ASGCT_CallFrame
  → jmethodID / BCI_* / native symbol / thread id
    → classMap / JVMTI / demangle / thread_names
      → javaClassName / javaMethodName / decodeNativeSymbol / typeSuffix
        → style / include / exclude
          → flamegraph / collapsed / OTLP / text output 消费的名字
```

*关键设计（斜体）：* *`FrameName` 的角色不是“帮输出层顺手美化名字”，而是把 profiler 内部那套轻量帧身份统一翻译成外部消费者能读懂的语言，并把类型语义、过滤规则和样式变换集中收口在同一层。*[模式: 统一身份翻译层 + 延迟命名]

先记住这句总领：输出层消费的不是 `jmethodID`，也不是裸地址，而是 `FrameName` 翻译之后的“人话身份”。后面所有细节，都是在解释这层翻译为什么必须集中存在。

## 第一层：为什么 `FrameName` 必须在输出阶段统一出场，而不能在热路径里顺手完成

`FrameName` 的构造函数位于 `src/frameName.cpp:77-96`。它会保存 style、cache epoch、cache age、thread name map，复制 include/exclude 规则，并且从 `Profiler::instance()->classMap()->collect(_class_names)` 一次性收集 classMap（`src/frameName.cpp:92-95`）。

这一步看起来只是初始化，但它已经说明 `FrameName` 的位置：它属于输出/消费阶段，而不属于采样热路径。真正的采样热路径只保存轻量身份，不在信号上下文里做 JVMTI 名字查询、demangle、大量字符串拼接或样式裁剪。

这是一个必须讲透的结构性约束。最直觉的失败方案，就是“既然最后总要显示名字，不如在采样时就一并把名字算好”。问题在于，采样时最忌讳的正是这些昂贵而且不稳定的动作：JVMTI 查方法名、类名规范化、demangle、线程名拼接、style 变换，全都不应该出现在最热的记录链路里。更何况，不同输出格式对名字的要求还不完全一样，提前在热路径里固定死，后面反而更难灵活消费。

所以 `FrameName` 的第一层意义，就是延迟：先把身份留轻，等真的有消费者要名字时，再集中翻译。这样做不只是为了性能，也是为了把命名策略从采样路径里隔离出来。

### 为什么 classMap 要先收一份，而不是每个分配/锁帧临时去查

构造函数里最值得注意的一点，是 `classMap()->collect(_class_names)`。这说明某些不是 `jmethodID` 的 Java 相关身份——比如分配对象类、锁对象类这类特殊 `BCI_*` 帧——不会在每次命名时重新向 profiler 去一层层追索，而是先从 classMap 拉一份字典到本地（`src/frameName.cpp:95`）。

这不是说 `FrameName` 可以绕过 JVMTI 一切都本地解决，而是在告诉你：命名阶段也在尽量避免重复查询。不同来源的身份，会各自选择最合适的补全来源：

- Java 方法走 JVMTI；
- 分配/锁这类 class-based 特殊帧走 classMap；
- native 名字走 demangle；
- 线程帧走 thread name map。

这也正是 `FrameName` 看起来像“总出口”的原因：它不是把所有解析都自己做完，而是把不同来源的补全动作统一调度到同一层。

## 第二层：Java 帧为什么不能直接叫“方法名”，而必须在 `javaMethodName()` 里重新补全类、方法和签名

当 `FrameName::name()` 遇到默认分支，也就是普通 Java 帧时，真正干活的是 `javaMethodName(jmethodID method)`（`src/frameName.cpp:151-193`）。这一段逻辑非常典型：

1. 先判断 `jmethodID` 是否 stale；
2. 用 JVMTI `GetMethodName` 取方法名和签名；
3. 用 `GetMethodDeclaringClass` 找声明类；
4. 用 `GetClassSignature` 拿类描述符；
5. 再调用 `javaClassName()` 把 descriptor 转成人类可读类名；
6. 最后按 style 决定是否带签名（`src/frameName.cpp:152-177`）。

这说明 `jmethodID` 对输出层来说并不是方法名，它只是一个可以进一步追索真实方法身份的句柄。若只把它想成“某个已经知道名字的方法”，就会低估这里真正补的那几层信息：声明类是谁，类名该用 descriptor 还是 dotted 形式，签名要不要展示，出错时又该怎样明确暴露给用户。

### 为什么 stale / jvmtiError 必须显式暴露，而不是静默吞掉

`javaMethodName()` 遇到 `JVMTI_ERROR_INVALID_METHODID` 时，会写成 `[stale_jmethodID]`；其他 JVMTI 错误则写成 `[jvmtiError N]`（`src/frameName.cpp:179-185`）。这看起来像一个小分支，但其实非常重要。

因为这里对应着另一个失败方案：查询失败时直接返回空串，或者退化成一个模糊占位符。那样输出层当然“更整齐”，但读者就会失去诊断线索，不知道是方法身份本身失效了，还是命名过程遇到了别的 JVMTI 边界。

当前实现更在意可诊断性：如果名字补不出来，就明确告诉你“是 stale 了”还是“是 JVMTI 错了”。这和本卷其他地方一脉相承：宁可显式暴露降级语义，也不静默伪装成成功。

### `javaClassName()` 为什么不是单纯去掉 `L` 和 `;`

`javaClassName()`（`src/frameName.cpp:195-249`）做的事情比“trim 掉 class descriptor 的外壳”更丰富。它不仅要处理 `Ljava/lang/Object;` 这种普通类，还要处理数组、基本类型数组、多维数组，以及后续的 style 变换。

这一步说明“类名长什么样”也不是 JVM descriptor 的自然属性，而是输出策略的一部分。比如：

- 数组要转成 `int[]`、`byte[]`、`Foo[][]` 这类人类表示；
- `STYLE_SIMPLE` 可能去掉包名；
- `STYLE_DOTTED` 会把 `/` 变成 `.`；
- `STYLE_NORMALIZE` 还会裁掉匿名/数字后缀一类噪音（`src/frameName.cpp:222-247`）。

所以如果文章把这一层轻描淡写成“Java 帧 = 类名 + 方法名”，读者就会错过一个关键点：Java 帧真正进入输出层之前，类名本身也要经过一轮规范化和样式裁剪。

## 第三层：为什么 native 帧和特殊 `BCI_*` 帧也必须被统一拉进同一条命名链

如果 `FrameName` 只处理普通 Java 方法，事情反而简单。但它真正麻烦、也真正有价值的地方，在于它还要统一处理 native 符号名、分配帧、锁帧、线程帧、地址帧、错误帧和 CPU 帧。

### native 符号为什么不是“上一章已经解析过了”，这里仍然要再管一次

`decodeNativeSymbol()`（`src/frameName.cpp:115-136`）会根据 style 决定要不要带库名，再判断符号是否需要 demangle；如果需要，就交给 `Demangle::demangle(name, _style & STYLE_SIGNATURES)`，并在必要时把结果与库名拼成 `library\`symbol` 的形式；否则就保留原始名字。

这里最容易犯的误解，是觉得 native 名字在上一章做完 ELF + demangle 以后，这一层只是“顺手拼一下字符串”。其实并不是。上一章解决的是“这个地址对应什么名字”；这一层解决的是“这个名字最终该怎样以某种 style 被输出”。库名要不要带、demangle 后要不要保留完整签名、原始名字和 demangled 名字如何拼接，这些都属于最终显示策略，不是前一层地址归属能替代的。

`Demangle::demangle()` 里还能看到一个很关键的边界：它会先识别 Rust 符号，再尝试 Rust demangle；否则退到 C++ demangle；如果不要求 full signature，还会剪掉参数列表（`src/demangle.cpp:88-101`）。这说明 native 名字的“人话化”也不是一刀切，而是依赖语言 ABI 和 style 选择。

### 特殊 `BCI_*` 帧为什么更说明 `FrameName` 是统一翻译层

`FrameName::name()` 里最能暴露本质的，其实是那些 `BCI_*` 分支（`src/frameName.cpp:251-326`）。这里很清楚地告诉你：同一套命名器要同时处理多种世界。

- `BCI_NATIVE_FRAME`：按 native 符号去走 `decodeNativeSymbol()`；
- `BCI_ALLOC` / `BCI_ALLOC_OUTSIDE_TLAB` / `BCI_LOCK` / `BCI_PARK`：从 `_class_names` 里取 class symbol，再跑 `javaClassName()`，必要时追加 `_[k]` / `_[i]` 一类后缀；
- `BCI_THREAD_ID`：从 thread map 里把 tid 变成人类线程名；
- `BCI_ADDRESS`：输出原始地址字符串；
- `BCI_ERROR`：显式包成 `[error]` 风格；
- `BCI_CPU`：输出 `[CPU-N]`（`src/frameName.cpp:257-303`）。

这说明 `FrameName` 真正统一的并不是“Java 方法命名”这一件事，而是“任何一个帧身份最终该长成什么样”。如果不把这些特殊帧统一拉进来，后面的 flamegraph、collapsed、OTLP 等消费者就还得各自分辨“这是不是线程帧”“这是不是错误帧”“这个名字要不要再包方括号”。

所以这里要记住一句话：`FrameName` 不是 Java 命名器，它是帧身份统一翻译器。

## 第四层：为什么同一个方法名还要带 `_[j]`、`_[i]`、`_[0]` 这些类型后缀

很多人第一次看到 `_[j]`、`_[i]`、`_[0]` 这类后缀时，会觉得它们只是显示细节，甚至像多余装饰。但 `typeSuffix()`（`src/frameName.cpp:138-149`）的存在，恰恰说明“同一个方法名属于什么执行世界”也是输出语义的一部分。

开启 `STYLE_ANNOTATE` 时，它会给：

- interpreted 帧追加 `_[0]`；
- JIT compiled 帧追加 `_[j]`；
- inlined 帧追加 `_[i]`；
- C1 compiled 帧追加 `_[1]`（`src/frameName.cpp:139-145`）。

这里必须打掉一个常见失败方案：既然最终都只是“某个方法名”，那不如统一显示成同一个名字，后缀省掉算了。问题在于，输出层有时真的需要知道“这是解释执行、JIT、C1，还是 inline 结果”。如果全压成相同名字，后续消费者就失去了一层非常重要的执行形态语义。

当然，这也不意味着所有输出层都必须把类型语义内嵌进名字本身。比如 flamegraph 和 OTLP 常常会关闭 annotate，因为它们可以通过其他结构表达类型（`src/profiler.cpp:1298`、`src/profiler.cpp:1440`）。这恰恰进一步证明：后缀不是颜色本身，也不是展示唯一方案，而是一种“名字里可携带的类型语义编码”。

所以更准确的说法是：`typeSuffix()` 让 `FrameName` 生成的不只是“一个可读字符串”，而是一个在必要时还能携带执行形态语义的名字。

## 第五层：为什么 style、include/exclude 和缓存也必须挂在 `FrameName` 这一层

到这里，`FrameName` 已经做了 Java 命名、native 名字恢复和特殊帧翻译。看起来已经够重了，为什么 style、include/exclude 和缓存还要继续放在这里？

答案也很一致：因为这些规则都作用在“最终名字”这一层，而不是作用在底层身份上。

### 过滤为什么不能在更底层用原始身份提前做掉

`FrameName` 构造时会复制 `_include` / `_exclude`，并提供 `excludeTrace(CallTrace* trace)` 之类逻辑（`src/frameName.cpp:92-93、366-403`）。这意味着 include/exclude 的判断对象，最终仍然是翻译后的 frame name，而不是某个 JVM 内部 ID 或某个原始地址值。

如果过滤发生得更底、更早，输出层就得共享同一种底层身份语义：到底按 `jmethodID` 过滤，还是按 demangled 名字过滤，还是按线程显示名过滤？这会让过滤规则与底层实现过度耦合。放在 `FrameName` 这一层，则可以统一在“人类可读名字已经形成之后”再做判断。

### 缓存为什么也属于命名层，而不是采样层

`FrameName::_cache` 是 `JMethodCache`。构造时会记录 cache epoch 与最大 age，析构时则根据 `_cache_max_age` 选择清空缓存或删除过期项（`src/frameName.cpp:75-113`）。

这里又能看出一条很清楚的分层原则：缓存的是“命名结果”，不是采样帧本身。因为真正昂贵、值得复用的是 JVMTI `GetMethodName` / `GetClassSignature` 这一轮名字补全过程；而采样层更关心的是“快速保存身份”，不该被命名缓存生命周期牵住。

如果不缓存，每次输出同一个 `jmethodID` 都要重新走一遍 JVMTI 名字查询；如果永久缓存，又会积累 stale method/class 信息。所以当前实现用 epoch / age 做折中：让缓存跨 profile 适度复用，但又不会无限长胖或无限持有旧身份。

所以这一层也说明，`FrameName` 不是单个函数级的小工具，而是整个“帧命名策略”的聚合点：名字长什么样、该不该带后缀、该不该过滤、可不可以复用缓存，全都在这里收口。

*关键设计（斜体）：* *一旦把“帧身份 -> 人类名字”的责任集中到 `FrameName`，style、过滤和缓存这些只对最终名字有意义的规则，也就必须跟着集中到这一层；否则每个输出器都会长出自己的一份命名后处理。*[模式: 名字即协议 + 规则集中收口]

## 收网：`FrameName` 真正统一的不是“字符串格式”，而是不同帧世界的身份翻译

如果把整条链压成一句话，`FrameName` 真正做的事情并不是“把名字弄漂亮”，而是把 profiler 内部那套彼此异质的轻量身份——`jmethodID`、特殊 `BCI_*`、native 符号名、线程 ID——统一翻译成输出层都能消费的可读名字，并在这一层集中补上类型后缀、style 变换、过滤和缓存。

```text
ASGCT_CallFrame
  → jmethodID / BCI_* / native symbol / thread id
    → classMap / JVMTI / demangle / thread_names
      → javaClassName / javaMethodName / decodeNativeSymbol / typeSuffix
        → style / include / exclude / cache
          → flamegraph / collapsed / OTLP / text 输出可消费的名字
```

到这里，主线只发生了三件事。

第一，采样器和 walker 保留的是轻量身份，不在热路径里做重型名字恢复。

第二，`FrameName` 把 Java、native、线程、错误、CPU、分配/锁等不同世界的帧统一翻译成一套可读名字。

第三，类型后缀、style、过滤和缓存这些“只对最终名字有意义”的规则，也一起在 `FrameName` 层收口，避免每个输出器各自长出一套命名逻辑。

*关键设计（斜体）：* *`FrameName` 的真正价值不在于“把地址链变成人话”这一个动作，而在于它让 async-profiler 不同来源的帧身份在进入输出层前，先收束成同一种“可读、可过滤、可携带类型语义”的统一协议。*[模式: 统一身份翻译层 + 规则集中收口]

**本篇的一句话困惑**：采样器手里拿到的只是 `jmethodID`、native 名字和特殊 `BCI_*` 标记，为什么输出层最后却能看到统一的人类可读栈？

**本篇的一句话顿悟**：因为 `FrameName` 并不是单纯的字符串格式化器，而是把 Java、native 和特殊帧身份统一翻译成可读名字，并在这里集中补上类型后缀、style、过滤与缓存。

下一篇继续看 AP-4 的最后一层：这些被命名过或尚未命名的帧身份，怎样在不能随便 `malloc` 的信号路径里安全保存，并被后续输出格式复用。

[跨层标注：JVMTI GetMethodName/GetClassSignature；classMap 与线程名表；Rust/C++ demangle；`BCI_*` 特殊帧；FrameType/typeSuffix；flamegraph/collapsed/OTLP 输出消费]
