# 01. 一个 `-XX:` 参数为什么同时是变量、表项和校验点？— Flag 定义体系

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论
> **前置依赖**：[02-assembler/04 — MacroAssembler 运行时](../02-assembler/04-x86-macroassembler-runtime.md)：`UseCompressedOops`、`UseAESIntrinsics`、`UseStackBanging` 等开关在代码生成里如何被消费
> → **后续**：[02 — flag 解析与管理](02-flag-processing-and-management.md)：命令行字符串如何真正写入这些 flag
> 关联域：04-logging、35-dcmd、38-perfdata

## 先看一个很容易被低估的问题

命令行里写：

```text
-XX:+UseG1GC
```

大多数人对它的直觉是：

- 这是启动参数
- JVM 解析字符串
- 然后把某个开关设成 `true`

这个理解只对了一半。

在 HotSpot 里，`UseG1GC` 并不是“启动时临时解析出来的键值对”。它在**编译期**就已经是一个普通的 C++ 全局变量了。

但事情又不只如此。

同一个 `UseG1GC` 还同时具有另外几种身份：

- `PrintFlagsFinal` 能把它的名字、类型、默认值和来源打印出来
- `jcmd VM.flags`、SA、管理接口能在运行时找到它
- JVM 启动阶段会对它做范围或约束检查
- 它还有分类：`product`、`diagnostic`、`manageable`、`experimental` 等

所以一个 `-XX:` 参数至少同时活在三套世界里：

```text
代码世界
  → 它是一个能被 C++ 直接读取的变量

元数据世界
  → 它在一张 JVMFlag 表里有名字、类型、文档和分类

校验世界
  → 它可能有取值范围、约束函数和不同的检查时机
```

如果这三套信息分别手写，问题会立刻出现：

- 变量名改了，表项忘了改
- 文档改了，约束忘了改
- 某个平台不存在这个 flag，但表里还挂着它
- 某个 flag 能被工具看到，但代码里其实没有同名变量

HotSpot 解决这个问题的办法不是运行时读一份 JSON 配置，而是更老派、也更强硬：

**用一套统一声明，在编译期把同一条 flag 文本展开成变量、元数据表项和约束挂载点。**

所以本篇真正要回答的不是“宏怎么展开”，而是：

**为什么同一条 `-XX:` 参数声明，既能变成代码里的全局变量，又能出现在 `PrintFlagsFinal` 里，还能在正确时机接受约束检查，而且这三者不会失同步？**

先把整条生命线画出来：

```text
同一条 flag 声明
    │
    ├─ 编译期展开成 C++ 全局变量
    ├─ 编译期展开成 JVMFlag 元数据表项
    ├─ 编译期挂上 range/constraint 元数据
    │
    ▼
运行期命令行解析
    │
    ├─ 找到对应 JVMFlag 表项
    ├─ 按类型写入真正变量
    ├─ 记录值来源 Origin
    └─ 按阶段做范围和约束检查
```

一句话先记住：

**HotSpot 的 flag 体系不是“运行期动态创建配置项”，而是“编译期先把实体造好，运行期再决定给这些实体赋什么值”。**

---

## 一、统一声明：为什么一条 flag 能同时变成三份代码

### 1.1 如果只有全局变量，会漏掉什么

最简单的设计是：

```cpp
bool UseG1GC = true;
```

然后命令行解析时，看到 `-XX:+UseG1GC` 就把它改成 `true`。

这种设计当然能跑，但它会立刻失去很多能力：

- 你没法统一遍历所有 flag
- 工具无法知道有哪些 flag、它们叫什么、是什么类型
- 文档字符串和代码变量没有统一来源
- 你没法给“这个参数只能在 8~256 之间”这样的规则提供统一挂载点
- 平台相关 flag 和架构相关 flag 也难以统一隔离

所以 HotSpot 需要的不是一堆彼此独立的全局变量，而是一条统一声明，后面能把这条声明重放到多个语境里。

### 1.2 `RUNTIME_FLAGS(...)`：真正的主清单

这个主清单的核心就是 `RUNTIME_FLAGS(...)` 巨型宏，定义在 `globals.hpp:213-226`：

```cpp
#define RUNTIME_FLAGS(develop, \
                      develop_pd, \
                      product, \
                      product_pd, \
                      diagnostic, \
                      diagnostic_pd, \
                      experimental, \
                      notproduct, \
                      manageable, \
                      product_rw, \
                      lp64_product, \
                      range, \
                      constraint, \
                      writeable)
```

第一次看会觉得它像一个难读的预处理器技巧。

但如果先问“为什么要这么写”，结构就清楚了。

`RUNTIME_FLAGS` 不是一个“会自己展开成代码”的宏体，它更像是一张**统一声明清单**。

这张清单里每一行 flag 都写成：

```text
分类前缀(type, name, default, doc)
  + 可选 range(...)
  + 可选 constraint(...)
```

例如：

- `lp64_product(bool, UseCompressedOops, false, ...)`
- `lp64_product(intx, ObjectAlignmentInBytes, 8, ...)`
  + `range(8, 256)`
  + `constraint(...)`

所以这里的 14 个宏参数，本质上是在给“同一张清单的多次重放”预留挂钩。

### 1.3 这不是一个宏，而是三次重放同一张清单

同一条 flag 声明至少会在三类地方被重放：

1. 生成真正的 C++ 变量
2. 生成 `JVMFlag` 元数据表
3. 由专门的 range/constraint 展开过程生成可供后续检查阶段消费的范围与约束记录

这是本篇最重要的结构判断：

**flag 定义体系的核心不是某个单独宏，而是“同一张清单，被不同参数宏反复解释”。**

所以阅读时不要问“这个宏展开后是什么”，而要问：

```text
这张清单现在是被拿来生成什么？
- 变量？
- 表项？
- 约束？
```

这就把预处理器技巧翻译回了设计问题。

---

## 二、第一次展开：先把 flag 变成真正的 C++ 变量

### 2.1 编译期就有变量，不等运行期解析

HotSpot 在 `globals.cpp:58-96` 用第一套展开参数把统一清单变成真正的变量。

其中最直接的宏是：

```cpp
// globals.hpp:2767-2769
#define MATERIALIZE_PRODUCT_FLAG(type, name, value, doc)    type name = value;
#define MATERIALIZE_PD_PRODUCT_FLAG(type, name, doc)        type name = pd_##name;
#define MATERIALIZE_DIAGNOSTIC_FLAG(type, name, value, doc) type name = value;
```

于是：

```text
product(bool, UseG1GC, true, ...)
```

在这一轮展开里，会变成：

```cpp
bool UseG1GC = true;
```

也就是说，在 HotSpot 代码里：

- `UseG1GC`
- `UseCompressedOops`
- `UseAESIntrinsics`
- `ObjectAlignmentInBytes`

这些都是**普通全局变量**。

C++ 代码直接读它们，不需要先查表再取值。

### 2.2 为什么这是编译期存在，而不是运行期创建

这条边界非常重要。

运行期解析只是决定：

- 是否把默认值覆盖
- 覆盖后的来源是什么（命令行、ergonomic、管理接口…）

它不会在运行时“新建”一个 `UseG1GC` 变量。

变量本身在链接后的 JVM 二进制里早就存在了。

这带来一个关键收益：

**编译器能对这些变量做完整的类型检查和引用检查。**

如果某个 flag 定义消失，而代码里还在读 `UseAVX`，编译期就会报错，而不是等到运行期工具查不到才暴露问题。

### 2.3 `product_pd` 和 `lp64_product`：不是所有变量都跨平台共享

如果所有 flag 都无条件出现在所有平台，就会出现奇怪的问题：

- ARM 上为什么也有 `UseAVX`
- 32 位 VM 上为什么也有只对 64 位有意义的压缩 oop 参数

HotSpot 通过分类前缀在定义阶段就把这种歧义切掉了。

例如：

- `product_pd`：平台相关默认值
- `lp64_product`：只在 LP64/64 位环境下成立

这意味着：

```text
同样是“product flag”
  ├─ 有些是所有平台共享的
  ├─ 有些默认值依赖平台
  └─ 有些变量只在 64 位 VM 里存在
```

所以定义体系不仅负责“造变量”，还负责在编译期决定这些变量该不该存在，以及默认值来自哪里。

### 2.4 失败方案：运行期拿 Map 代替全局变量

一个现代配置系统常见的替代方案是：

```text
HashMap<String, Object> flags
```

代码里需要时：

```text
lookup("UseG1GC")
```

这看起来灵活，但会损失：

- 编译期类型安全
- 编译期引用检查
- 平台隔离
- 对热路径 flag 的直接访问成本

HotSpot 反而选择最“老派”的方式：先把变量造出来，再围绕这些变量生成元数据和约束系统。

这正是 JVM 工程风格的一贯特点：

**运行时的灵活性，要建立在编译期实体稳定存在的前提上。**

---

## 三、第二次展开：再把同一条声明变成 `JVMFlag` 表项

### 3.1 只有变量还不够，工具根本不知道它们叫什么

假设 HotSpot 只做了第一轮展开，代码里当然能直接读 `UseG1GC`。

但这时如果你问：

- `PrintFlagsFinal` 怎么知道有哪些 flag
- `jcmd VM.flags` 怎么列出 flag 名称
- Serviceability Agent 怎么知道某个 flag 的地址和类型
- 文档字符串从哪里来

就会发现仅有全局变量还不够。

你还需要一张可遍历的表。

### 3.2 `flagTable[]`：运行时工具看到的是这张表

`jvmFlag.cpp:769-816` 定义了生成表项的宏。例如：

```cpp
#define RUNTIME_PRODUCT_FLAG_STRUCT(type, name, value, doc) \
  { #type, XSTR(name), &name, NOT_PRODUCT_ARG(doc) \
    JVMFlag::Flags(JVMFlag::DEFAULT | JVMFlag::KIND_PRODUCT) },
```

这说明每个表项至少保存：

- 类型字符串
- 名字字符串
- 指向真实变量的地址
- 文档字符串
- 一组 `Flags` 位

随后 `jvmFlag.cpp:818-832` 生成 `flagTable[]`。

所以在工具视角里，一个 flag 不是单独的全局变量，而是：

```text
{ 类型, 名字, 变量地址, 文档, 分类位 }
```

这就是为什么 `PrintFlagsFinal` 能列出：

- `UseG1GC`
- 它是 `bool`
- 默认值是什么
- 这是 `product` 还是 `diagnostic`
- 当前来源是不是 command line / ergonomic

### 3.3 变量和表项为什么不会失同步

因为它们来自同一条统一声明。

如果你手写：

```cpp
bool UseG1GC = true;
```

再手写：

```cpp
{"UseG1GC", &UseG1GC, ...}
```

只要重命名时漏掉一处，就会失同步。

而在 HotSpot 里，变量和表项都从同一行 `product(bool, UseG1GC, true, doc)` 生成。

因此：

- 名字不会一处改了另一处忘记改
- 类型不会变量和表项各写一遍
- 文档字符串天然附着在同一条声明上

这就是“统一声明，多次解释”的最大价值。

### 3.4 分类前缀进入的是 `KIND_*`，不是值来源

`product`、`diagnostic`、`manageable` 这些前缀在这里首先进入的是 `KIND_*` 位。

它们回答的是：

```text
这个 flag 属于什么类别？
```

而不是：

```text
这个值当前是从哪里来的？
```

这两个问题必须分开。下面第五节会讲第二个维度——Origin。

这里先把第一个维度记住：

**分类前缀首先决定“这是哪类 flag”，并体现在元数据表的 `KIND_*` 上。**

---

## 四、第三次展开：范围、约束和检查时机

### 4.1 并不是所有错误都该在 parse 阶段报

一些 flag 只需要检查纯数值范围：

- `ObjectAlignmentInBytes` 在 `8..256` 之间

但另一些约束依赖更晚才知道的运行时状态：

- 自适应（ergonomic）调整之后的结果
- 堆相关内存初始化之后的值
- 多个 flag 组合后的关系

如果所有约束都在命令行 parse 的那一刻强行检查，会出现两种错误：

1. 太早报错：某些值稍后还会被 ergonomics 调整
2. 太晚报错：明明只是一个简单越界，却浪费了很长启动路径

所以 HotSpot 把检查时机分层。

### 4.2 `AtParse / AfterErgo / AfterMemoryInit`

`jvmFlagConstraintList.hpp:54-61` 定义了三个约束检查时机；而范围与约束的记录本身并不是直接塞进 `flagTable[]`，而是由 `jvmFlagRangeList.cpp`、`jvmFlagConstraintList.cpp` 这类专门列表在展开时收集起来，后续再按阶段执行。

```cpp
enum ConstraintType {
  AtParse         = 0,
  AfterErgo       = 1,
  AfterMemoryInit = 2
};
```

它们分别回答：

```text
AtParse
  → 解析参数时立刻能判断的约束

AfterErgo
  → 等自适应调整完成后再判断

AfterMemoryInit
  → 等内存子系统建立完成后再判断
```

这不是“查三次”，而是“每类约束找最早能准确认定的时机”。

### 4.3 `range()` 与 `constraint()` 的角色不同

`range(min, max)` 更像静态边界：

- 值是不是落在基本数值区间内

`constraint(func)` 则更像动态规则：

- 当前平台下这个值是否合理
- 与其他 flag 的组合是否冲突
- 某些运行时状态建立后它是否仍成立

所以统一声明不仅提供变量和表项，还把“这个值什么时候、用哪类逻辑检查”也一起挂上。

### 4.4 失败方案：所有约束都写在解析函数里

如果把所有检查直接手写进参数解析：

- 解析逻辑会和 flag 语义强耦合
- 跨 flag 和平台依赖会不断膨胀
- 检查时机难以分层
- 解析代码会变成越来越大的条件泥球

而当前体系把“值是什么”和“什么时候能检查它”都留在统一声明及其派生元数据里，运行时框架只负责在合适阶段遍历并调用。

这使得 parse 系统和约束系统保持解耦。

---

## 五、三套宏集合：为什么 `UseAVX` 在非 x86 平台根本不存在

### 5.1 全局、OS、架构三层来源

`globals.cpp:58-96` 会依次展开：

- `VM_FLAGS`
- `RUNTIME_OS_FLAGS`
- `ARCH_FLAGS`

三套集合对应三类边界：

```text
VM_FLAGS
  → 所有平台共享的全局 flag

RUNTIME_OS_FLAGS
  → 和 Linux/Windows/Solaris 这类 OS 相关的 flag

ARCH_FLAGS
  → 和 x86、ARM、AArch64 等架构绑定的 flag
```

### 5.2 `UseAVX` 为什么不是“在 ARM 上也存在，只是永远关闭”

`UseAVX` 定义在 `globals_x86.hpp` 的 `ARCH_FLAGS` 里。

这意味着在非 x86 平台上，它不是“值为 false”，而是根本没有这条定义。

这是一种很重要的编译期隔离：

- x86 代码可以引用 `UseAVX`
- ARM 平台不会因为这条 flag 被生成多余变量和表项
- 平台不支持的 flag 在编译期就消失，而不是运行期再判空

这正是 HotSpot flag 定义体系里最容易被低估的一点：

**平台隔离不是靠运行时判断，而是靠“谁拥有那套宏定义”在编译期决定。**

### 5.3 失败方案：平台共享一张全集 flag 表

如果所有平台共享同一张完整 flag 集合：

- 非支持平台要携带大量无意义变量和表项
- 代码里要到处写“如果平台支持就读，否则忽略”
- 工具看到的 flag 也会充满当前平台根本不可能使用的噪声

HotSpot 选择的是：

```text
不存在的 flag，在编译期就不要存在
```

这让定义体系更接近真实能力边界。

---

## 六、分类与 Origin：它是什么 flag，和这个值从哪来，是两回事

### 6.1 `KIND_*` 解决“它是什么”

前面已经说过，`product`、`diagnostic`、`manageable` 等前缀首先决定 flag 分类。

这类信息会进入 `KIND_*` 位，决定：

- 是否默认可见
- 是否需要 unlock
- 是否属于平台相关或架构相关
- 是否允许某些管理接口修改

也就是说：

```text
KIND 解决的是 flag 身份问题
```

### 6.2 Origin 解决“这个值是谁定的”

`jvmFlag.hpp:35-46` 定义值来源枚举，例如：

- `DEFAULT`
- `COMMAND_LINE`
- `ERGONOMIC`
- `MANAGEMENT`
- `INTERNAL`
- `JIMAGE_RESOURCE`

这和分类是正交的。

同一个 `product` flag，既可能：

- 保持默认值
- 被命令行覆盖
- 被 ergonomics 自动调整
- 被某些管理路径修改

因此：

```text
分类（KIND）
  → 这个 flag 属于什么类别

来源（Origin）
  → 当前这个值是谁设置的
```

### 6.3 为什么要保留来源信息

如果没有 Origin，JVM 在做覆盖决策时会失去一层重要判断。

例如：

- 用户命令行显式写了一个值
- ergonomics 后面想给它自动调成另一个值

这时系统必须知道：

```text
当前值是 DEFAULT，还是 COMMAND_LINE？
```

只有这样才能决定谁能覆盖谁。

这也是 `PrintFlagsFinal` 的来源列为什么有价值——它不只是调试信息，而是可解释性的核心线索。

---

## 七、收网：一条 flag 的完整生命史

现在把一条 `-XX:` 参数从头走一遍：

```text
统一声明
  │
  ├─ 第一次展开：生成 C++ 变量
  ├─ 第二次展开：生成 JVMFlag 元数据表项
  ├─ 第三次展开：挂上 range/constraint 和检查时机
  │
  ▼
运行期解析命令行
  │
  ├─ 通过名字找到 JVMFlag 表项
  ├─ 按类型把值写进真实变量地址
  ├─ 记录 Origin
  └─ 在合适阶段执行约束检查
  │
  ▼
后续代码和工具同时消费同一个 flag 体系
```

所以 HotSpot 的 flag 定义体系真正解决的不是“怎么少写几行宏”，而是三个同步问题：

1. **代码同步**：C++ 直接读的变量和工具看见的名字必须是同一个 flag
2. **语义同步**：文档、分类、平台边界、约束不能各写一份
3. **时机同步**：不同约束必须在最早但正确的阶段检查

如果把这篇压缩成三句话：

- 一条 `-XX:` flag 在 HotSpot 里先是编译期实体，再是运行期可赋值参数
- 同一条声明会被展开成变量、`JVMFlag` 表项和约束挂载点，因此三种身份天然同步
- 分类 `KIND` 和来源 `Origin` 是两个独立维度：一个回答“它是什么”，一个回答“现在这个值从哪来”

到这里，flag 的“定义体系”才算闭环。

下一篇再继续追真正的运行时动作：

- 命令行字符串如何被解析
- `+UseG1GC`、`-UseBiasedLocking`、`ObjectAlignmentInBytes=16` 这类不同语法怎么分派
- `JVMFlag::set_*` 如何按类型写入真正变量
- 写入之后又是如何触发范围和约束检查

> → [02-flag-processing-and-management.md](02-flag-processing-and-management.md)
