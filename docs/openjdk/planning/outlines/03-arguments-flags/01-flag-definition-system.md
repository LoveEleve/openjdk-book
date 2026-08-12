# 01. Flag 定义体系 — 一个宏,三次展开

> 🔴 Deep | flag 定义/展开/分类/约束
> 读者处境: `-XX:+UseG1GC` 怎么变成 C++ bool?——编译期的宏展开体系。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/03-arguments-flags/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"PRODUCT_FLAG(bool, UseG1GC, true)(globals.hpp:100)" 编造**——实际是 `RUNTIME_FLAGS` **14 参巨型宏**(globals.hpp:213-226:develop/develop_pd/product/product_pd/diagnostic/diagnostic_pd/experimental/notproduct/manageable/product_rw/lp64_product/range/constraint/writeable),flag 用**分类前缀**声明(如 lp64_product UseCompressedOops@228)
> - **展开不是"5 份代码"**,是三次: ① 变量(MATERIALIZE_*,globals.hpp:2767-2769,globals.cpp:58-96)② JVMFlag 表(flagTable,jvmFlag.cpp:818-832,条目={#type,XSTR(name),&name,doc,KIND_*})③ range/constraint 注册
> - **不是 GLOBALS_EXTENSION**——是三套宏集合: VM_FLAGS(globals.hpp:2691)/RUNTIME_OS_FLAGS(globals_linux.hpp:31)/ARCH_FLAGS(globals_x86.hpp:106,UseAVX@112 range(0,99))
> - **Origin 是 9 级不是 5 级**(jvmFlag.hpp:35-46): DEFAULT=0/COMMAND_LINE=1/ENVIRON_VAR=2/CONFIG_FILE=3/MANAGEMENT=4/ERGONOMIC=5/ATTACH_ON_DEMAND=6/INTERNAL=7/JIMAGE_RESOURCE=8(无"ARG",COMMAND_LINE=1)
> - jvmFlag 在 share/runtime/flags/(jdk11u 重构目录);约束三阶段 AtParse/AfterErgo/AfterMemoryInit(jvmFlagConstraintList.hpp:54-61)

### 1. "一个 flag 的三次展开"

**声明**(`globals.hpp:213-226` + 示例 `228-230`/`244-249`):
```
RUNTIME_FLAGS(develop, develop_pd, product, product_pd, diagnostic, diagnostic_pd,
              experimental, notproduct, manageable, product_rw, lp64_product,
              range, constraint, writeable)(213-226)
  lp64_product(bool, UseCompressedOops, false, ...)(228)
  lp64_product(intx, ObjectAlignmentInBytes, 8, ...) range(8,256) constraint(...,AtParse)(244-249)
展开 1-变量: MATERIALIZE_PRODUCT_FLAG(type,name,value,doc) = "type name = value;"(2767-2769)
  globals.cpp:58-96: VM_FLAGS(MATERIALIZE_...) + RUNTIME_OS_FLAGS(...) + ARCH_FLAGS(...) + MATERIALIZE_FLAGS_EXT
展开 2-表: flagTable[](jvmFlag.cpp:818-832) = { #type, XSTR(name), &name, doc, Flags(KIND_*) }
  JVMFlag::flags = flagTable(jvmFlag.cpp:894);KIND_* 分类位(769-816)
展开 3: range/constraint 由调用方参数接收(第 4 节)
[C++: "同一文本不同参数重放"——RUNTIME_FLAGS 本体无逻辑,展开逻辑全在调用方参数(globals.cpp MATERIALIZE_*/jvmFlag.cpp *_STRUCT)]
```
- 关键设计: **一行声明,三次展开,三者永不失同步**;类型检查在编译期("为什么不用 JSON config"的答案)。

### 2. "三套宏集合:全局/OS/架构"

**作用域隔离**(`globals.cpp:58-96` + `globals_x86.hpp:106-115`):
```
VM_FLAGS(globals.hpp:2691): 全局所有平台
RUNTIME_OS_FLAGS(globals_linux.hpp:31): OS 相关(linux/windows/solaris 各自定义)
ARCH_FLAGS(globals_x86.hpp:106): 架构相关——UseAVX(product(intx,UseAVX,3,"Highest supported AVX...") range(0,99),112-115)
ARM 编译时 globals_arm.hpp 定义自己的 ARCH_FLAGS——UseAVX 在编译期不存在
```
- 关键设计: **谁定义宏谁拥有 flag**——平台隔离在编译期,零运行时开销;不存在的 flag 不可能被引用。

### 3. "分类与 Origin"

**两个正交维度**(`jvmFlag.cpp:769-816` + `jvmFlag.hpp:35-69`):
```
KIND_*(分类): PRODUCT/DIAGNOSTIC/EXPERIMENTAL/MANAGEABLE/PLATFORM_DEPENDENT/ARCH/C1/C2/JVMCI...
  → diagnostic 需 -XX:+UnlockDiagnosticVMOptions
Origin(来源,9 级,低 4 位 VALUE_ORIGIN_BITS): DEFAULT=0/COMMAND_LINE=1/ENVIRON_VAR=2/CONFIG_FILE=3/
  MANAGEMENT=4/ERGONOMIC=5/ATTACH_ON_DEMAND=6/INTERNAL=7/JIMAGE_RESOURCE=8(jvmFlag.hpp:35-46)
  → 覆盖优先级: 用户显式(COMMAND_LINE) > ergonomic 自适应(ERGONOMIC);PrintFlagsFinal 显示 {command line}/{ergonomic}
```
- 关键设计: **分类决定"谁能改",Origin 决定"谁能覆盖"**——9 级来源让"自动调整 vs 用户指定"的博弈可预测、可追溯。

### 4. "约束与范围:三道启动关卡"

**ConstraintType**(`jvmFlagConstraintList.hpp:54-61`):
```
AtParse(0): 参数解析时(Arguments::parse_argument)——纯值合法性(如 ObjectAlignmentInBytes 8-256)
AfterErgo(1): apply_ergo 后(Threads::create_vm)——跨 flag 关系(依赖自适应结果)
AfterMemoryInit(2): universe_init 后(Metaspace::global_initialize 后)——heap 相关约束
约束函数签名 bool (*)(JVMFlag*, JVMFlagOrigin)——返回 false → 拒绝 + 报错
```
- 关键设计: **每类约束挑最早可行的时机**——早失败早报错 vs 依赖状态晚检查。

---

### 核心悬念

**"一次声明、三次展开、三套宏集合、9 级 Origin、三道关卡——flag 的定义体系到齐。但 `-XX:+UseG1GC` 从命令行字符串到 `bool UseG1GC=true` 还差一步:字符串解析、+/- 前缀、=value 语法、JVMFlag::set 分派。"** — 下一篇: flag 解析与管理。

> → [02-flag-processing-and-management.md](02-flag-processing-and-management.md)
