# 01. Flag 定义体系 — 一个宏,三次展开

> **前置依赖**:[02-assembler/04 — MacroAssembler 运行时](openjdk/vol-02/02-assembler/04-x86-macroassembler-runtime.md):UseAESIntrinsics/UseCompressedOops 等开关——本篇讲它们从哪来
> → **后续**:[02 — flag 解析与管理](02-flag-processing-and-management.md)
> 关联域: 04-logging、38-perfdata、35-dcmd

## -XX:+UseG1GC 是怎么"变成" C++ bool 的

启动参数 `-XX:+UseG1GC` 在 JVM 里就是一个普通的 C++ 全局 bool 变量 `UseG1GC`——而且它在**编译期**就存在了,不是运行时解析出来的。整个 flag 体系的核心是一个**巨型宏 + 三次展开**:同一行声明,展开成变量、元数据表、约束注册。这篇拆这个体系。

## 1. 一个 flag 的三次展开

### 1.1 场景:一行声明,变成三份代码

所有 runtime flag 声明在 `RUNTIME_FLAGS` 这个巨型宏里(globals.hpp:213-226)——注意它**不是**大纲想象的 "PRODUCT_FLAG(bool, UseG1GC, true)" 单宏,而是 **14 个参数**的统一宏:

```cpp
// globals.hpp:213-226(截取核心,逐字)
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
                      writeable) \
```

每个 flag 用**分类前缀**声明,比如 `lp64_product`(64 位才有的 product flag):

```cpp
// globals.hpp:228-230、244-249(截取核心,逐字)
  lp64_product(bool, UseCompressedOops, false,                              \
          "Use 32-bit object references in 64-bit VM. "                     \
          "lp64_product means flag is always constant in 32 bit VM")        \
  ...
  lp64_product(intx, ObjectAlignmentInBytes, 8,                             \
          "Default object alignment in bytes, 8 is minimum")                \
          range(8, 256)                                                     \
          constraint(ObjectAlignmentInBytesConstraintFunc,AtParse)          \
```

同一行 `product(...)`/`diagnostic(...)`/`manageable(...)` 声明,由调用方(宏参数)决定展开成什么。**第一次展开:变量**(globals.cpp:58-96,`VM_FLAGS(MATERIALIZE_...)`):

```cpp
// globals.hpp:2767-2769(截取核心,逐字)
#define MATERIALIZE_PRODUCT_FLAG(type, name, value, doc)      type name = value;
#define MATERIALIZE_PD_PRODUCT_FLAG(type, name, doc)          type name = pd_##name;
#define MATERIALIZE_DIAGNOSTIC_FLAG(type, name, value, doc)   type name = value;
```

`MATERIALIZE_PRODUCT_FLAG(bool, UseG1GC, true, doc)` 展开成 `bool UseG1GC = true;`——**flag 就是普通全局变量**。**第二次展开:JVMFlag 元数据表**(jvmFlag.cpp:818-832 的 `flagTable[]`):

```cpp
// jvmFlag.cpp:769-776(截取核心,逐字)
#define RUNTIME_PRODUCT_FLAG_STRUCT(     type, name, value, doc) { #type, XSTR(name), &name,         NOT_PRODUCT_ARG(doc) JVMFlag::Flags(JVMFlag::DEFAULT | JVMFlag::KIND_PRODUCT) },
#define RUNTIME_PD_PRODUCT_FLAG_STRUCT(  type, name,        doc) { #type, XSTR(name), &name,         NOT_PRODUCT_ARG(doc) JVMFlag::Flags(JVMFlag::DEFAULT | JVMFlag::KIND_PRODUCT | JVMFlag::KIND_PLATFORM_DEPENDENT) },
#define RUNTIME_DIAGNOSTIC_FLAG_STRUCT(  type, name, value, doc) { #type, XSTR(name), &name,         NOT_PRODUCT_ARG(doc) JVMFlag::Flags(JVMFlag::DEFAULT | JVMFlag::KIND_DIAGNOSTIC) },
#define RUNTIME_MANAGEABLE_FLAG_STRUCT(  type, name, value, doc) { #type, XSTR(name), &name,         NOT_PRODUCT_ARG(doc) JVMFlag::Flags(JVMFlag::DEFAULT | JVMFlag::KIND_MANAGEABLE) },
```

每个 flag 在 `flagTable[]`(818 行起)里生成一个条目:`{类型字符串, 名字, 指向变量的指针, 文档, KIND_* 分类}`——`JVMFlag::flags` 指向这张表(jvmFlag.cpp:894),jcmd/PrintFlagsFinal/SA 全靠它。**第三次展开:范围与约束**(`range(8, 256)`/`constraint(...)` 行由调用方的 RANGE/CONSTRAINT 参数接收,第 4 节讲)。

- [C++: 宏体系的核心技巧是"**同一文本,不同参数重放**":RUNTIME_FLAGS 本体不含任何展开逻辑,展开逻辑全在调用方的参数里——globals.cpp 传 MATERIALIZE_* 得到变量,jvmFlag.cpp 传 *_STRUCT 得到表。加一个新 flag = 改一行;漏了哪个展开,编译期直接报错(类型检查在编译期,这正是"为什么不用运行时 JSON config"的答案)]

**关键设计 (斜体)**: *"一行声明,三次展开"让 flag 的三种身份永远同步:① C++ 变量(代码直接读);② JVMFlag 表(工具可见,含类型/文档/分类);③ 约束注册(合法性检查)。三者从同一行文本生成,不可能失同步。类型安全在编译期强制:`-XX:UseG1GC=hello` 在 JVMFlag::set_bool 处失败,而不是运行时才炸。*

## 2. 三套宏集合:全局/OS/架构

### 2.1 场景:UseAVX 为什么只存在于 x86

flag 按作用域分成三套,globals.cpp 里依次展开(58-96):

```cpp
// globals.cpp:58-96(截取核心,逐字)
VM_FLAGS(MATERIALIZE_DEVELOPER_FLAG, \
         ...
         MATERIALIZE_LP64_PRODUCT_FLAG, \
         IGNORE_RANGE, \
         IGNORE_CONSTRAINT, \
         IGNORE_WRITEABLE)

RUNTIME_OS_FLAGS(MATERIALIZE_DEVELOPER_FLAG, \
                 ...
                 IGNORE_WRITEABLE)

ARCH_FLAGS(MATERIALIZE_DEVELOPER_FLAG, \
           ...
           IGNORE_WRITEABLE)
```

三套宏的**定义方**不同:
- `VM_FLAGS`(globals.hpp:2691)——全局(所有平台)
- `RUNTIME_OS_FLAGS`(globals_linux.hpp:31)——OS 相关(linux/windows/solaris 各自定义)
- `ARCH_FLAGS`(globals_x86.hpp:106)——**架构相关**:

```cpp
// globals_x86.hpp:106-115(截取核心,逐字)
#define ARCH_FLAGS(develop, \
                   product, \
                   diagnostic, \
                   experimental, \
                   notproduct, \
                   range, \
                   constraint, \
                   writeable) \
  ...
  product(intx, UseAVX, 3,                                                  \
          "Highest supported AVX instructions set on x86/x64")              \
          range(0, 99)                                                      \
```

`UseAVX` 只写在 x86 的 ARCH_FLAGS 里——ARM 平台编译时,**ARCH_FLAGS 由 arm 的 globals_arm.hpp 定义,根本不含 UseAVX**,所以 ARM 的 JVM 里没有这个变量也没有这个表项。平台隔离是**编译期**的,零运行时开销。jvmFlag.cpp 的表生成同样按三套宏展开(818-839+),ARCH 表项带 `KIND_ARCH` 位(812-816)。

**关键设计 (斜体)**: *"谁定义宏,谁就拥有这些 flag"——平台文件定义 ARCH_FLAGS/RUNTIME_OS_FLAGS 的内容,share 的代码只负责展开。加平台 flag = 改平台文件;跨平台共享 = 写 VM_FLAGS。这比"运行时读配置文件"的方案好在:不存在的 flag 在编译期就不存在,不可能出现"ARM 上 UseAVX 未定义"的运行时错误。*

## 3. 分类与 Origin:这个 flag 从哪来、谁能改

### 3.1 场景:PrintFlagsFinal 里的 Origin 列

flag 的**分类前缀**(product/diagnostic/...)变成 `KIND_*` 位(KIND_DIAGNOSTIC/KIND_MANAGEABLE/KIND_ARCH/KIND_PLATFORM_DEPENDENT 等,jvmFlag.cpp:769-816),决定"谁需要解锁才能改"(diagnostic 要 `-XX:+UnlockDiagnosticVMOptions`)。而 **Origin(值来源)是另一个维度**(jvmFlag.hpp:35-46):

```cpp
// jvmFlag.hpp:35-46(截取核心,逐字)
  enum Flags {
    // latest value origin
    DEFAULT          = 0,
    COMMAND_LINE     = 1,
    ENVIRON_VAR      = 2,
    CONFIG_FILE      = 3,
    MANAGEMENT       = 4,
    ERGONOMIC        = 5,
    ATTACH_ON_DEMAND = 6,
    INTERNAL         = 7,
    JIMAGE_RESOURCE  = 8,
    ...
```

**9 级来源**,不只是 "DEFAULT/ARG/ERGO" 三档:命令行、环境变量、配置文件、JMX、ergonomic 自适应、attach 请求、VM 内部……`VALUE_ORIGIN_BITS = 4`(低 4 位存 Origin)+ 高位的 KIND_* 分类(jvmFlag.hpp:47-69)。语义:**Origin 决定覆盖优先级**——用户显式设置(COMMAND_LINE)的 flag,ergonomic 自适应(ERGONOMIC=5)不能覆盖;Origin 同时是调试线索:PrintFlagsFinal 里 `{command line}`/`{ergonomic}` 标注让"这个值为什么是这个"可追溯。

**关键设计 (斜体)**: *分类(KIND_*)和来源(Origin)是两个正交维度:分类回答"这是什么 flag"(决定谁有权限改),来源回答"这个值谁定的"(决定谁能覆盖)。9 级 Origin 把"自动调整 vs 用户指定"的博弈编码成数值——这是 JVM 参数系统可预测性的根基:同一套 flag,在不同启动方式下行为一致。*

## 4. 约束与范围:三道启动关卡

### 4.1 场景:范围外的值什么时候被拒绝

每个 flag 可挂 `range(min, max)` 和 `constraint(func)`(第 1 节的 ObjectAlignmentInBytes 例子)。检查分**三个阶段**(jvmFlagConstraintList.hpp:54-61):

```cpp
// jvmFlagConstraintList.hpp:54-61(截取核心,逐字)
  enum ConstraintType {
    // Will be validated during argument processing (Arguments::parse_argument).
    AtParse         = 0,
    // Will be validated inside Threads::create_vm(), right after Arguments::apply_ergo().
    AfterErgo       = 1,
    // Will be validated inside universe_init(), right after Metaspace::global_initialize().
    AfterMemoryInit = 2
  };
```

- **AtParse**(0):参数解析时立即查——纯值合法性(如 `ObjectAlignmentInBytes` 必须在 8-256)
- **AfterErgo**(1):ergonomic 自适应调整后查——自适应可能改值,释放/引入新冲突(此时才检查跨 flag 关系)
- **AfterMemoryInit**(2):内存子系统初始化后查——heap 大小相关的约束现在才能检查(比如 UseCompressedOops 与堆大小的关系)

分三阶段的理由:某些约束依赖"更晚才确定的状态"——太早查会误报(值还没被 ergo 调整),太晚查会浪费启动时间。约束函数是 `bool (*)(JVMFlag*, JVMFlagOrigin)` 签名,返回 false → 拒绝该值并报错。

**关键设计 (斜体)**: *三阶段不是"查三次",是"每类约束挑最早可行的时机":值约束在解析时(早失败早报错),跨 flag 约束在 ergo 后(依赖自适应结果),内存约束在内存初始化后(依赖运行时状态)。这套"时机分层"让启动时的错误报告既及时又准确——这也是为什么 `-XX:ObjectAlignmentInBytes=512` 在命令行阶段就退出,而堆相关的组合错误要到启动晚期才报。*

## 核心悬念

"flag 的定义体系到齐:一次声明、三次展开(变量/表/约束)、三套宏集合(全局/OS/架构)、9 级 Origin、三道检查关卡。但 `-XX:+UseG1GC` 从**命令行字符串**到 `bool UseG1GC = true` 之间还差一步:字符串怎么被解析、`+`/`-` 前缀、`=value` 语法、`JVMFlag::set_bool`/`set_intx`/`set_ccstr`(jvmFlag.cpp:134/182/266——通过表里的 `_addr` 指针写变量)怎么分派?下一篇:flag 的解析与处理。"

> → [02-flag-processing-and-management.md](02-flag-processing-and-management.md)
