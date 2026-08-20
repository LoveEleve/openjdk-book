# 07-classfile-classloader/01-classfile-parser 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 `.class` 字节如何被安全地读入、局部校验、组装成 parser-owned metadata graph，再事务式移交给 `InstanceKlass`

## 1. 选题判断

现稿素材密度很高，但仍基本按 `parse_stream` 的源码顺序展开，容易把“读取顺序”误当成“理解顺序”。

真正的读者困惑不是“class file 格式有哪些 section”，而是：

**为什么 HotSpot 能把一段不可信、可变长度、互相引用的 `.class` 字节流安全地变成 `InstanceKlass`？它怎么一边做边界检查，一边避免把所有常量都立刻解析成直接指针；又怎么保证解析失败时，不会把一半挂到 `ClassLoaderData`、另一半还留在 parser 手里？**

## 2. 一句话顿悟

**`ClassFileParser` 不是一个边读边往 `InstanceKlass` 里填字段的“构造器”，而是一个事务式中间层：先把 hostile byte stream 解码成 parser-owned 临时元数据，再在 `post_process_parsed_stream()` 中计算类的派生形状，最后只在 `fill_instance_klass()` 阶段统一移交所有权；若中途失败，parser 析构函数按“要么全给 klass、要么全回收”的规则兜底。**

## 3. 总图

```text
Class bytes
  │
  ├─ KlassFactory::create_from_stream
  │    ├─ JVMTI ClassFileLoadHook 可改写字节
  │    └─ 构造 ClassFileParser
  │
  ├─ ClassFileParser constructor
  │    ├─ parse_stream()              → 按格式读取 + 局部校验 + parser-owned 元数据
  │    └─ post_process_parsed_stream()→ 解析部分超类/接口 + 计算派生形状
  │
  ├─ create_instance_klass()
  │    ├─ allocate_instance_klass()   → 按派生形状分配原始 InstanceKlass
  │    └─ fill_instance_klass()       → 挂入 CLD、移交 metadata、建 mirror、默认方法等
  │         ├─ set_klass_to_deallocate(ik)  rollback armed
  │         ├─ apply_parsed_class_metadata()
  │         ├─ clear parser fields / assert NULL
  │         ├─ set_klass_to_deallocate(NULL)
  │         └─ set_klass(ik)
  │
  └─ 后续 define / link 阶段
       ├─ define_instance_class() → loaded
       └─ link_class_impl()       → verify + rewrite + method link
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么 `.class` 解析不是“读一个文件，new 一个类”

目标约 1000 字。

- hostile byte stream：长度可错、索引可错、属性可重复、版本可错、结尾可多垃圾字节
- parser 还没确认类合法前，不能把半成品直接暴露为 `InstanceKlass`
- 先提出三大障碍：边界安全、交叉引用时机、失败回滚
- 回收上篇钩子：Symbol、FieldInfo、AnnotationArray、Method 都是在这里第一次被“生产”

### 第二节：三个朴素方案为什么会把类加载写成事故现场

目标约 1800 字。

至少推演：

1. 边读字节边直接填 `InstanceKlass` → 失败后回滚困难
2. 常量池一读取就全部解析成直接指针 → 把加载成本和使用成本绑死，还会过早触发类/字符串解析
3. 读完 class bytes 后再散落多处补派生信息 → 所有权边界与失败处理混乱

引出：解析期临时元数据、后处理派生形状、统一所有权交接这三步分离。

### 第三节：入口与字节安全——Parser 先把输入隔离在自己手里

目标约 1700 字。

- `SystemDictionary::resolve_from_stream` → `KlassFactory::create_from_stream`
- JVMTI ClassFileLoadHook 改写发生在 parser 构造前
- `ClassFileStream` 的职责：有界 cursor、big-endian 读取、`guarantee_more` + `*_fast`
- `at_eos()` 禁止尾部垃圾
- `_need_verify` 与 checked read / fast read 边界
- 这一步只建立“我能安全读这段字节”的前提，不等于类已经合法

### 第四节：`parse_stream()`——按格式解码，但只做局部承诺

目标约 2200 字（核心拆解层）。

- constructor 里先 `parse_stream` 再 `post_process_parsed_stream`
- 读取顺序：magic/version/cp/access_flags/this/super/interfaces/fields/methods/class attrs/eos
- 每节都是“先 `guarantee_more`，再局部校验，错误就地抛 `ClassFormatError`”
- version 验证、preview/major 边界
- 这一步创建 parser-owned 的 `_cp/_fields/_methods/...`
- 重要路标：parse_stream 解码与校验的是“局部 section 格式和基本引用合法性”，不是完整类链接

### 第五节：常量池——先登记 unresolved graph，不急着把世界都解析出来

目标约 2200 字（核心拆解层）。

- tag loop、long/double 双槽、Utf8 批量进 SymbolTable
- `Module` / `Package` 的准确边界：进 switch，作为 bad constant 记录，后续配合 `ACC_MODULE` 处理
- `parse_constant_pool()` 的第一遍交叉校验
- `ClassIndex` / `StringIndex` 转 unresolved 形式
- “加载期不等于运行期解析”：superclass/interfaces 会在加载后处理中解析，但大量 CP 符号引用仍保持 unresolved，等 `ConstantPool::*_impl` 按需解析
- 失败方案回收：不是“所有 CP 都立刻变指针”，也不是“什么都不解析”

### 第六节：字段、方法、属性——Parser 先收集原材料，再准备最终形状

目标约 2200 字。

- `parse_fields`：六个 `u2` 固定 `FieldInfo` + 可选尾部 generic signature slot，不要写成 7 槽固定结构
- `FieldAllocationCount` / `FieldAllocationType` 为 `layout_fields()` 准备输入
- injected fields 边界
- `parse_method`：先读属性和 code layout，再 `Method::allocate`；强调 `ConstMethod` 与 `Method` 分配是分开的
- Code 字节先在 stream 中定位，再复制进 `ConstMethod`
- StackMapTable raw bytes 保留给 verifier，不是此处完整解释
- class attrs：BootstrapMethods、NestHost/NestMembers、annotations 及 version gates

### 第七节：`post_process_parsed_stream()`——为什么 parser 读完字节后还不能立刻造类

目标约 1800 字。

- 解析完成后才解析/校验 superclass
- `compute_transitive_interfaces`
- 方法排序、miranda/default-method 输入、vtable/itable 大小
- `layout_fields()` 计算 field offsets、oop maps、instance/static field sizes
- `_rt` 推导决定后续具体 `InstanceKlass` 子类
- 这里产出的都是“分配 `InstanceKlass` 前必须知道的派生形状”

### 第八节：`fill_instance_klass()`——所有权移交为什么像事务提交

目标约 2300 字（核心拆解层）。

- `allocate_instance_klass()` 只分配 raw klass；`fill_instance_klass()` 才是真正的提交期
- `_loader_data->add_class(ik, publicize)` 早于 metadata handoff
- `set_klass_to_deallocate(ik)`：从这一步起 rollback armed
- `apply_parsed_class_metadata()`：move cp/fields/methods/interfaces/annotations
- clear parser fields + NULL asserts 证明 handoff 完成
- `_transitive_interfaces` 延迟到 `initialize_supers()` 后移交的原因（可能与 superclass 共享）
- 成功路径：`set_klass_to_deallocate(NULL)` → `set_klass(ik)`
- 失败路径：parser destructor 统一清理 / 把 klass 加入 CLD deallocate list

### 第九节：这还不是一个“可用”的类——define 与 link 是下一道边界

目标约 1300 字。

- `create_instance_klass()` 完成后只是 parser/klass 构造成功
- `define_instance_class()` 将状态推到 loaded
- `link_class_impl()` 才做 verify、rewrite、method link、vtable/itable init
- 所以 parser 成功 ≠ verifier 成功 ≠ linked 成功
- 为下一篇 verifier 埋钩子

### 第十节：误解澄清与收网

目标约 1000 字。

至少回答：

1. ClassFileParser 是否边读边直接构造完整 `InstanceKlass`
2. JVMTI 是否在 parser 内部改字节
3. 解析阶段是否把所有常量池引用都解析成直接指针
4. `Module`/`Package` 是否完全绕开 CP tag switch
5. `FieldInfo` 是否固定 7 槽
6. `Method` 与 `ConstMethod` 是否一次连续分配
7. parser 成功是否等于 class 已 verify/link
8. 失败后是否总是直接 delete klass

## 5. 失败方案必须写进正文

1. 边读字节边直接填 `InstanceKlass`
2. 常量池一读完就全部解析成直接指针
3. 解析完字节后分散多处补派生信息与手工清理

## 6. 证据清单

- `systemDictionary.cpp:1042,1086`：resolve_from_stream 入口
- `klassFactory.cpp:166-206`：create_from_stream、JVMTI hook 后构造 parser
- `klassFactory.cpp:110-155`：ClassFileLoadHook 改写字节
- `classFileParser.hpp:92-110`：parser-owned metadata fields 与 `_klass_to_deallocate`
- `classFileParser.cpp:5995-5997`：constructor 中 parse + post_process
- `classFileStream.hpp:34-42,88-116`：ClassFileStream 契约、bounds、big-endian、fast reads
- `classFileStream.cpp:35,76-107`：truncated/error checked reads
- `classFileParser.cpp:6080-6316`：parse_stream 总顺序与 extra bytes 检查
- `classFileParser.cpp:126-403`：parse_constant_pool_entries
- `classFileParser.cpp:338`：Module/Package bad constant 处理
- `classFileParser.cpp:406-500`：parse_constant_pool 第一遍校验与 unresolved 登记
- `constantPool.cpp:447-517,845-1109,1269-1279`：运行期按需解析对照
- `classFileParser.cpp:1541-1750`：parse_fields
- `fieldInfo.hpp:45-69`：FieldInfo 六槽布局
- `classFileParser.cpp:1567,1725`：generic signature 尾部槽位
- `classFileParser.cpp:1453-1528,1673-1677`：字段分桶与 allocation type
- `classFileParser.cpp:2344-2956,2959-3045`：parse_method/parse_methods
- `method.cpp:69-91`：Method::allocate 分离 Method/ConstMethod
- `constMethod.cpp:40-64`：ConstMethod allocate
- `constMethod.hpp:485-489`：copy code bytes
- `classFileParser.cpp:2012-2046,2858`：StackMapTable raw bytes 保留
- `classFileParser.cpp:3440-3729`：class attrs，含 BootstrapMethods/Nest/annotations
- `classFileParser.cpp:6321-6416`：post_process_parsed_stream
- `classFileParser.cpp:4580-4633`：compute_transitive_interfaces
- `classFileParser.cpp:3934-4452`：layout_fields
- `instanceKlass.cpp:344-414`：allocate_instance_klass
- `classFileParser.cpp:5571-5818`：create/fill_instance_klass
- `classFileParser.cpp:5609-5611`：add_class + rollback armed
- `classFileParser.cpp:5632-5641`：NULL asserts after metadata handoff
- `classFileParser.cpp:5706`：_transitive_interfaces 延迟移交
- `classFileParser.cpp:5812-5818`：commit
- `classFileParser.cpp:6015-6069`：destructor cleanup/deallocate list
- `classLoaderData.cpp:460-467,868-882`：add_class 与 deallocate list
- `systemDictionary.cpp:1599-1808`：define_instance_class / loaded 状态
- `instanceKlass.cpp:777-833`：link_class_impl verify/rewrite/link
- `klassFactory.cpp:45-96,224`：CDS 与 JVMTI/CDS dump 边界

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64；本文讲普通 parser path，不把 CDS 恢复 path 当作同一实现
- JVMTI 改字节发生在 parser 构造前的 `KlassFactory` 边界
- parser 期间只解析/校验当前类需要的部分依赖，不代表所有 CP 符号都变成直接引用
- parse_stream/post_process/create_instance_klass 是三阶段，不混成“构造函数一步完成类构建”
- superclass/interfaces 可能在加载期间解析，正文不能把“加载期只登记不解析”说成绝对命题
- `FieldInfo` 六槽固定结构与 generic signature 尾部槽位必须区分
- `Method` 与 `ConstMethod` 是分离分配；“连续”的只属于 `ConstMethod` 内部 code + inline tables
- parser 成功后类仍未 verify/link；下一篇 verifier 是独立边界

## 8. 完成后 review

- 删除代码后能否复述“byte stream 隔离 → parser-owned metadata → post-process 派生形状 → 事务式 handoff → define/link 后续边界”
- 是否修正了 Module/Package、super/interfaces 解析、FieldInfo 七槽、Method/ConstMethod 一次分配等常见误解
- 是否清楚区分 parse_stream、post_process_parsed_stream、fill_instance_klass 三阶段职责
- 是否把失败回滚讲成所有权事务，而不是零散 cleanup 细节堆叠
- 是否完成删码测试、禁用词、file:line、链接与版本边界检查
