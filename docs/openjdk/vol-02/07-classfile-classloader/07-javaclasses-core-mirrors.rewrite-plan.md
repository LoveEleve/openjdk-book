# 07-classfile-classloader/07-javaclasses-core-mirrors 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 HotSpot 为什么要为少数核心 Java 类建立一套启动期偏移协议与 native 镜像访问器，以及这些镜像如何把 Java 对象、VM 元数据和 JIT/GC 的高频路径绑在一起

## 1. 选题判断

现稿素材极其丰富，但明显按 `String` / `Thread` / `Class` 三个对象分段堆叠，容易变成“核心类字段巡礼”。

真正的读者困惑：

**既然 HotSpot 已经有普通字段表、反射和 `FieldStream`，为什么还要专门维护一套 `javaClasses` 模块，为 `String`、`Thread`、`Class` 这类核心对象缓存偏移并提供 native 访问器？启动时为什么要先算 `String`/`Class` 的偏移，再算其它 29 个镜像？JIT、GC、线程系统到底消费的是哪一层：Java 对象本身、`java_lang_Xxx` 镜像类，还是普通 `Klass`/反射元数据？**

## 2. 一句话顿悟

**`javaClasses` 不是“给 Java 类做反射”，而是 HotSpot 与少数核心 Java 对象之间的启动期偏移契约：JVM 在启动时用类元数据一次性验证并缓存字段偏移，随后解释器、JIT、GC 和线程系统都只通过 `java_lang_Xxx` 这套内联访问器直接读写对象，不再走 Java 反射或运行时字段查找。`Class` 镜像更进一步，把 injected fields、双向 `klass ↔ mirror` 指针和可变大小静态字段区折叠成一个特殊对象。**

## 3. 总图

```text
核心 Java 对象（String / Thread / Class / ...）
  │
  ├─ Java source/classfile layout
  │
  ├─ 启动时 offset contract
  │    ├─ PART1: java.lang.String / java.lang.Class 先算
  │    ├─ PART2: 其余 well-known classes 后算
  │    ├─ ordinary fields -> find_local_field
  │    └─ injected fields -> InjectedField + AllFieldStream
  │
  ├─ `java_lang_Xxx` mirror accessor
  │    ├─ static int offset caches
  │    ├─ inline obj_field/int_field/address_field/metadata_field accessors
  │    └─ startup mismatch -> vm_exit_during_initialization
  │
  └─ Consumers
       ├─ C2 / GraphKit（String value/coder）
       ├─ GC / StringDedup
       ├─ Thread runtime / jstack / currentThread
       └─ Class mirrors / static fields / Klass linkage
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么 JVM 不直接反射读取 `String.value`

目标约 1000 字。

- 从 `"hello".length()`、`Thread.currentThread()`、`jstack`、String dedup 开场
- 指出这些高频路径不可能每次走 Java 反射/字段查找
- 提出核心问题：JVM 如何把 Java 对象字段变成可被 native/JIT 零反射访问的稳定协议
- 回收前文：FieldInfo / injected fields / `Klass._java_mirror` 都已经准备好材料

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：

1. 每次需要时再按名字查字段 → 热路径成本无法接受
2. 把所有字段偏移硬编码到 VM 里 → JDK 布局漂移时会静默错读
3. 所有核心对象都统一走普通反射 API → JIT/GC/线程系统拿不到低成本直接访问

引出：启动时按真实类布局算偏移、校验后缓存成 `java_lang_Xxx` 协议。

### 第三节：javaClasses 模式——不是 Java 反射，而是启动期偏移契约

目标约 2000 字。

- `BASIC_JAVA_CLASSES_DO_PART1/PART2` 和 `BASIC_JAVA_CLASSES_DO`
- per-class `AllStatic` mirror helper + static offset caches
- `compute_offset` / `compute_optional_offset`
- “most offsets are hardwired for performance” 与 startup-computed offsets 的边界
- ordinary fields 与 injected fields 两条 offset 发现路径
- mismatch 直接 `vm_exit_during_initialization`
- 这是“启动时算一次，运行时零反射”，不是“运行时动态反射拿字段”

### 第四节：为什么 `String` 和 `Class` 要先算，其他镜像后算

目标约 1500 字。

- `resolve_well_known_classes` 中优先计算 `java_lang_String::compute_offsets()` 与 `java_lang_Class::compute_offsets()`
- String/Class 是后续异常、反射、镜像修复和大量 VM 路径的基础
- `JavaClasses::compute_offsets()` 只算 PART2
- `AbstractAssembler::update_delayed_values()` 的时序意义：解释器/assembler 早于 bulk offset 计算，需要延迟常量补丁
- 切记不要过度泛化成“所有 JIT 代码在这里同步重写”

### 第五节：String——三个位移为什么能撑起编码、去重和 JIT

目标约 2200 字（核心拆解层）。

- `value_offset` / `hash_offset` / `coder_offset`
- backing store 永远是 `byte[]`，Latin-1 与 UTF-16 由 `coder` 决定
- `length()` 的镜像逻辑：数组长度右移 `coder`
- `GraphKit::load_String_length` / `load_String_value` / `load_String_coder`
- 纠偏：JIT 直接消费的是 `value`/`coder` 等关键偏移，不要泛化成“JIT 对 String 所有字段都做同级别直读”
- StringDedup 路径如何只用镜像访问器操作 `value`、`hash`、`coder`
- 说明 `hash` 缓存被 Java 与 VM 共用

### 第六节：Thread——为什么 `eetop` 是 JavaThread*，而不是 OS thread id

目标约 2100 字（核心拆解层）。

- `THREAD_FIELDS_DO` 的 12 个偏移
- `thread()` / `set_thread()` 直接把 `_eetop_offset` 解释为 `JavaThread*`
- 初始线程/附着线程为什么必须在 Java 构造器前绑定 eetop
- 退出时 `set_thread(..., NULL)` 与 `threadStatus=TERMINATED`
- `is_alive()` 的真实含义：判 `eetop != NULL`
- `jstack` / `print_on()` 的三种 id：
  - `#id` = Java `tid`
  - `tid=` = `JavaThread*` 地址
  - `nid=` = OS 线程 id
- 纠偏：不要把 `eetop`、Java tid、native nid 混成一个“线程 id”

### 第七节：Class——镜像为什么是 injected fields + 双向指针 + 可变大小对象

目标约 2400 字（核心拆解层）。

- `CLASS_INJECTED_FIELDS` 与 `may_be_java=false`
- `JavaClasses::get_injected` + parser 注入 + `InjectedField::compute_offset`
- ordinary fields 与 injected fields 两条 offset 路径不同
- `mirror -> Klass`: `java_lang_Class::as_Klass` / `set_klass`
- `Klass -> mirror`: `Klass::_java_mirror`
- 纠偏：mirror 的 injected `klass` 字段不是普通对象头里的 Klass 指针，不要混为 compressed class pointer 机制
- `InstanceMirrorKlass::instance_size`、`oop_size`、`static_oop_field_count`
- trailing static-field storage 与 base Class layout 的区别
- `create_mirror` 的发布顺序和 fixup list
- primitive/basic type mirrors 与 array/class mirrors 的差异

### 第八节：消费者视角——为什么这套镜像访问器必须是同一套

目标约 1500 字。

- 解释器/JIT/GC/线程系统都消费 `java_lang_Xxx` 访问器
- 好处：一致的 offset 契约、一次性校验、内联访问
- 风险：JVM 与 JDK 布局强耦合，所以失败模式设计成启动即死
- 再次强调：不是 Java reflection，而是 VM 自己的 offset contract

### 第九节：误解澄清与收网

目标约 1100 字。

至少回答：

1. javaClasses 是否等于“JVM 版反射”
2. 所有 offset 是否都运行时动态查找
3. 所有 offset 是否都完全硬编码
4. `eetop` 是否是 OS/native 线程 id
5. `jstack` 里的 `#id`、`tid=`、`nid=` 是否是一回事
6. `java_lang_Class::klass` 是否就是对象头 Klass 指针
7. injected fields 是否等价于普通 Java 源码字段
8. variable-sized mirror 是否等于“Class 有个数组字段保存静态字段”

## 5. 失败方案必须写进正文

1. 每次需要时按名字查字段
2. 把所有偏移静态硬编码到 VM
3. 统一走 Java 反射 API 访问核心对象

## 6. 证据清单

- `javaClasses.hpp:34-41,50-87,93-99`：偏移契约与 mirror lists
- `javaClasses.cpp:118-169`：`compute_offset` / `compute_optional_offset`
- `javaClasses.cpp:200-209`：`java_lang_String::compute_offsets`
- `javaClasses.cpp:1545-1561`：`java_lang_Class::compute_offsets`
- `systemDictionary.cpp:2012-2015`：String/Class 提前计算 offsets
- `javaClasses.cpp:4475-4482`：PART2 bulk compute
- `assembler.cpp:283`：`update_delayed_values`
- `javaClasses.inline.hpp:52-87`：String value/hash/coder/length/is_latin1 accessors
- `javaClasses.cpp:240-285`：compact string allocation / `byte[]`
- `graphKit.cpp:3887-3918`：C2 direct String offset use
- `stringDedupTable.cpp:345-393`：String dedup through mirror accessors
- `javaClasses.hpp:347-436`、`javaClasses.cpp:1614-1771`：Thread offsets/accessors/status
- `thread.cpp:1088-1102,1229-1234,1885-1890,3011-3026`：initial binding, attach, teardown, jstack print
- `jvm.cpp:2987-2992,3139-3144`：`isAlive` / `currentThread`
- `osThread.cpp:41-42`：native thread id print
- `javaClasses.hpp:216-223,1530-1569`：`CLASS_INJECTED_FIELDS` / `ALL_INJECTED_FIELDS` / `may_be_java`
- `javaClasses.cpp:90-114,4558-4578`：`get_injected` / `InjectedField::compute_offset`
- `classFileParser.cpp:1562-1566,1684-1721`：injected fields appended during parsing
- `javaClasses.cpp:1390-1402,1470-1509`：mirror -> Klass / array_klass / primitive_type
- `klass.hpp:138-139,259-273`、`klass.cpp:50-61`：`Klass::_java_mirror`
- `instanceMirrorKlass.cpp:41-60`、`instanceMirrorKlass.hpp:67-80`、`instanceMirrorKlass.inline.hpp:36-78`：variable-sized mirrors and GC scanning
- `javaClasses.cpp:894-969,1272-1291,1373-1386`：`create_mirror`, `oop_size`, `static_oop_field_count`, primitive/basic type mirrors
- `universe.cpp:464-534`：basic type mirrors and fixup list timing

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- javaClasses 是 VM-side offset/access contract，不是 Java reflection 替身
- 部分偏移运行时计算，部分偏移硬编码验证，不能写成绝对的一边
- `String` 的 JIT 直接消费重点是 `value`/`coder` 等关键偏移，不泛化成“所有字段一视同仁”
- `eetop` / Java `tid` / native `nid` 必须严格区分
- `java_lang_Class::klass` 是 injected metadata field，不是对象头里的 Klass 指针
- variable-sized mirror 指 base `java.lang.Class` layout + inline trailing static-field storage，不是数组/附加对象
- fixup list / basic type mirrors 的时序必须和 `Class_klass` 的可用性绑定

## 8. 完成后 review

- 删除代码后能否复述“启动期 offset contract → mirror accessors → String/Thread/Class 三类代表性消费者”
- 是否纠正了 `eetop`、`tid`、`nid`、镜像 Klass 指针、注入字段可见性、variable-sized mirror 等常见误解
- 是否把 Java 对象、native mirror helper、JIT/GC/线程系统三层真正分开
- 是否说明 String/Class 的早算时序与 PART2 bulk compute 的差异
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
