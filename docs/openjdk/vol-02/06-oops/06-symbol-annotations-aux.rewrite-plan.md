# 06-oops/06-symbol-annotations-aux 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释 HotSpot 为什么把重复的元数据名字做成全局 canonical atom，却把注解保留为声明级 raw bytes；并说明 FieldStream 与 CompiledICHolder 如何为特定使用场景构造局部视图

## 1. 选题判断

现稿覆盖了 Symbol、SymbolTable、Annotations、FieldStream、CompiledICHolder，但整体仍是五张事实卡片并排放置。读者可以记住若干类名，却不容易回答它们为什么被设计成完全不同的存储形态。

真正的读者困惑：

**类名、方法名、字段签名在 JVM 里反复出现，为什么要全局去重并让相同内容共享同一个 Symbol？注解也是字节数据，为什么不进入 SymbolTable，而是按类、字段、方法各自保存 raw bytes？字段遍历器和 compiled inline cache helper 又为什么不建立一个覆盖所有继承字段和调用状态的万能表？**

## 2. 一句话顿悟

**HotSpot 只把“高重复、需要按内容比较、可安全共享”的元数据名字 canonicalize 成不可变 Symbol；注解是声明级、结构丰富、低频消费的属性，于是保留为拥有者私有的 raw byte array；FieldStream 和 CompiledICHolder 则在紧凑基础数据之上按具体调用场景构造局部视图和短生命周期 helper，而不是扩张成一张全局万能表。**

## 3. 总图

```text
.class 中的字节串/属性
  │
  ├─ 名字、描述符、签名
  │    └─ SymbolTable intern
  │         └─ Symbol：不可变内容 atom
  │              ├─ 相同字节只保留一份
  │              ├─ refcount 记录持有者
  │              └─ GC/unloading 后 unlink 零引用项
  │
  ├─ 注解属性
  │    └─ AnnotationArray / ConstMethod tail
  │         ├─ 按声明者保存 raw bytes
  │         ├─ VM 只挑少数有意义的注解预看
  │         └─ 反射需要时复制/解析
  │
  ├─ 字段数组
  │    └─ FieldInfo + FieldStream
  │         ├─ JavaFieldStream：本类 Java 字段
  │         ├─ InternalFieldStream：VM 注入字段
  │         ├─ AllFieldStream：本类全部字段
  │         └─ reflection FieldStream：类层次视图
  │
  └─ compiled inline cache
       └─ CompiledICHolder
            ├─ 特定 call site 的 metadata
            ├─ receiver Klass
            └─ safepoint 延迟释放
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——同一个名字为什么值得全 JVM 共享，而同一个注解却不该全局 intern

目标约 1000 字。

- 从 `java/lang/String` 在类名、签名、方法引用中的重复出现开场
- 对比同一声明上的 annotation payload：结构丰富、消费低频、语义属于声明上下文
- 提出主问题：什么值得 canonicalize，什么应该保留 owner-local raw data
- 回收前文：ConstantPool、InstanceKlass、Method 都需要 Symbol，但它们不需要各存一份名字内容

### 第二节：三个朴素方案为什么不成立

目标约 1800 字。

至少推演：

1. 每次出现名字都独立分配一份 → 元数据膨胀、比较和生命周期重复
2. 所有元数据属性都进入全局 SymbolTable → 注解结构被错误地按单字符串 atom 拆散，声明边界丢失，低频数据污染全局表
3. 建立一张包含继承字段、反射字段、compiled IC 状态的万能表 → 结构耦合、生命周期混乱、低频场景为所有类付成本

引出：基础数据 canonicalize；复杂属性 owner-local；派生关系按使用场景建视图/helper。

### 第三节：Symbol——把重复名字压成不可变 metadata atom

目标约 2000 字。

- `Symbol` 的角色不是普通字符串，而是全局 canonical metadata name
- `_refcount` / `_length` / `_identity_hash` / `_body[2]`
- 尾随 body 的真实实现：`_body[2]` + 自定义 `byte_size`，不要称普通 C flexible array
- 不可变内容、长度上限、identity hash 不等于内容 hash
- `PERM_REFCOUNT` 与可回收 Symbol 的边界
- modified UTF-8 / raw bytes / `as_C_string` 边界只讲够用部分

### 第四节：SymbolTable——一次 intern 如何兼顾短锁、共享和延迟清扫

目标约 2200 字。

- lookup 先动态表/共享表，再在 miss 时获取 `SymbolTable_lock`
- 共享 CDS Symbol 的优先查找是启发式，不是语义要求
- 加锁后 duplicate recheck，避免并发重复创建
- lookup 返回时 refcount 语义与 `TempNewSymbol`
- refcount 归零只是“可清扫”，不是立即 delete
- `unlink`：GC/unloading 阶段按 refcount==0 移除
- `rehash`：桶不均衡时的结构维护，和死符号清扫完全不同

### 第五节：Annotations——为什么复杂属性保留为 raw byte array

目标约 2200 字（核心拆解层）。

- `AnnotationArray = Array<u1>`，不是 Java annotation object graph
- class/field declaration/type annotations 归 `Annotations`，method/parameter/default/type annotations 归 `ConstMethod` tail
- parser 只为 VM-significant annotations 做有限检查；绝大多数 payload 原样保存
- type annotations 不能写成“VM 全部预解析”，源码明确有 no need for VM parse 的边界
- visible/invisible retention 取决于 preservation policy，不写成统一丢弃
- raw bytes 在反射路径按需复制到 Java byte[]，Java 层再 decode
- 这样避免类加载阶段解析任意 annotation class/element value，也只为实际反射消费支付解析成本

### 第六节：FieldStream——紧凑字段数组之上的局部解释视图

目标约 1700 字。

- `_fields` 是当前 `InstanceKlass` 自己的紧凑 `u2` 数组，不是继承字段总表
- `FieldInfo` 是六个 `u2` 的解释视窗，generic signature slot 在尾部
- `JavaFieldStream`：当前类声明的普通 Java 字段，static/nonstatic 由调用方判断
- `InternalFieldStream`：VM 注入字段
- `AllFieldStream`：本类全部字段，仅少数场景使用
- `runtime/reflectionUtils.hpp` 另有跨类层次的反射 `FieldStream`，不能混名
- 失败方案：把所有继承字段展开进每个类的 `_fields` → 重复存储、更新和边界复杂

### 第七节：CompiledICHolder——为什么 compiled call site 需要一个短生命周期二指针 helper

目标约 2000 字（核心拆解层）。

- 它不是 cpCache，也不是 inline cache 主表，而是 C heap 上的 call-site-specific helper
- `(Method*, receiver Klass*)`：interpreted fallback / transition
- `(Klass*, Klass*)`：megamorphic itable call
- `_is_metadata_method` 决定第一个 metadata 指针如何解释
- receiver Klass 用于 IC miss/fixup 的类型核验
- nmethod metadata traversal 必须访问两个引用
- 清除 IC 后不能立即 delete，进入 InlineCacheBuffer pending list，safepoint 再释放
- 与 cpCache 的层次、所有权、生命周期和消费者明确对比

### 第八节：成本与误解澄清

目标约 1300 字。

至少回答：

1. Symbol 是不是普通 Java String
2. Symbol 的 identity hash 是否等于内容 hash
3. refcount 归零是否立即删除
4. 所有注解是否都在类加载时完整解析
5. 所有注解是否都存放在 InstanceKlass
6. JavaFieldStream 是否包含继承字段或只包含非 static 字段
7. `runtime/reflectionUtils.hpp` 的 FieldStream 是否与 `oops/fieldStreams.hpp` 同一个类型
8. CompiledICHolder 是否等于 cpCache entry
9. holder 是否从机器码移除就立即释放

### 第九节：收网与下篇钩子

目标约 900 字。

- 总图回收：canonical atom / owner-local payload / local derived view / call-site helper
- 三句话总结
- 下篇进入 class file parser：这些 Symbol、字段数组、注解 raw bytes 最初如何从 class file 进入 metaspace

## 5. 失败方案必须写进正文

1. 每个名字出现都独立分配
2. 所有 metadata payload 都全局 intern
3. 建立覆盖继承字段、反射视图、compiled IC 状态的万能表

## 6. 证据清单

- `symbol.hpp:33-42`：Symbol canonicalized string 与引用计数设计
- `symbol.hpp:99-117`：PERM_REFCOUNT、布局、长度上限
- `symbol.hpp:122-151`：byte_size、size、identity_hash
- `symbol.cpp:39-60`：body 初始化与自定义分配
- `symbol.cpp:277-289`：原子 refcount
- `symbol.cpp:112-118`：as_C_string
- `symbolTable.hpp:46-87`：TempNewSymbol
- `symbolTable.cpp:208-217`：动态表命中与 refcount
- `symbolTable.cpp:229-256`：shared/dynamic 查找
- `symbolTable.cpp:319-336`：lookup 与锁
- `symbolTable.cpp:500-514`：锁内 duplicate recheck
- `symbolTable.cpp:124-158`：unlink
- `symbolTable.cpp:182-203`：rehash
- `annotations.hpp:38-68`：AnnotationArray、Annotations 字段、CDS 边界
- `classFileParser.cpp:1212-1266`：VM-significant 注解有限解析
- `classFileParser.cpp:2769,3611`：type annotation 不由 VM 全部解析
- `classFileParser.cpp:3788-3796`：raw annotation bytes 组装/复制
- `annotations.cpp:53-72`：释放与复制到 Java byte[]
- `constMethod.hpp:187-190,436-460`：方法注解尾部存储
- `fieldStreams.hpp:32-40,102-170`：字段流边界与 FieldInfo 视图
- `fieldStreams.hpp:188-247`：Java/Internal/AllFieldStream
- `reflectionUtils.hpp:112-135`：反射 FieldStream 类层次遍历
- `compiledICHolder.hpp:33-85`：helper 字段与语义
- `compiledICHolder.cpp:33-46`：构造与生命周期计数
- `compiledIC.cpp:223-250,387-415,477-516`：holder 分配与 IC 状态
- `sharedRuntime.cpp:1633-1659`：holder 类型核验与修复
- `nmethod.cpp:1549-1562`：holder metadata traversal
- `icBuffer.cpp:209-234`：safepoint 延迟释放
- `compiledIC.hpp:32-59`：IC 状态与 holder 对比

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot；SymbolTable、Annotations 和 CompiledICHolder 布局不能外推到所有 JVM
- Symbol 内容按当前实现的 classfile/modified UTF-8 字节语义讨论，不把 `as_C_string` 写成完整转码器
- refcount 归零到 unlink/delete 之间存在延迟，且 CDS/permanent Symbol 不走普通回收路径
- 注解只讲存储、有限 VM 检查和反射 handoff，不展开完整 Java AnnotationParser 语义
- `FieldStreamBase` 与 `runtime/reflectionUtils.hpp` 的反射 FieldStream 明确分开
- CompiledICHolder 只讲 IC helper、metadata traversal 和延迟释放，不展开整个 C1/C2 inline cache 优化器
- 不把 owner-local raw bytes、canonical Symbol、派生 FieldStream 和 call-site helper 混成一个 metadata 分类

## 8. 完成后 review

- 删除代码后能否复述“名字 canonicalize、注解 owner-local、字段按视图遍历、IC 按 call site 封装”的完整链条
- 是否解释了 SymbolTable 的 unlink 与 rehash 不是一回事
- 是否明确注解不是“只在反射时解释”，而是 VM 有限预看、Java 反射完整解析
- 是否明确 `JavaFieldStream` 不包含继承字段，且不自动排除 static
- 是否解释 CompiledICHolder 与 cpCache 的层次和生命周期差异
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
