# 07-classfile-classloader/02-verifier-stackmap 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 parser 成功后类仍不能执行，以及 StackMapTable 如何把控制流汇合点的类型状态从运行时推理改成按表核对

## 1. 选题判断

现稿已经抓到了“解析通过不代表字节码安全”，但主体仍偏事实堆叠：入口、两套验证器、栈帧、frame_type 编码并列陈述，尚未把核心困惑打穿。

真正的读者困惑：

**既然 `ClassFileParser` 已经读完整个 `.class` 并做了大量检查，为什么 HotSpot 还不能直接执行方法？Verifier 到底在阻止什么？它为什么要在链接时而不是读字节时工作？StackMapTable 又为什么没有把验证器变成单纯的“读表器”，而仍然要逐条模拟字节码？**

## 2. 一句话顿悟

**Parser 只证明“这段字节在格式上像一个类”，Verifier 要证明“沿任意控制流执行时，局部变量表和操作数栈的类型状态始终合法且可在汇合点收敛”。StackMapTable 不是替 verifier 做完工作，而是把汇合点的目标状态预写进 class file，使新验证器在关键 offset 处做 assignability 核对，而不再像老验证器那样全程从前驱路径推导。**

## 3. 总图

```text
.class bytes
  │
  ├─ ClassFileParser
  │    └─ 证明 section / 索引 / 属性格式基本合法
  │
  ├─ define_instance_class
  │    └─ class becomes loaded
  │
  ├─ link_class_impl
  │    ├─ recursively link super / interfaces
  │    ├─ verify_code() -> Verifier::verify
  │    │    ├─ choose local/remote policy
  │    │    ├─ choose split verifier or old verifier
  │    │    └─ per-method verify_method()
  │    │         ├─ current_frame = locals + operand stack state
  │    │         ├─ linear bytecode simulation
  │    │         ├─ StackMapTable checks at targets/checkpoints
  │    │         └─ VerifyError / ClassFormatError on mismatch
  │    ├─ rewrite_class
  │    ├─ link_method / vtable / itable
  │    └─ class becomes linked
  │
  └─ execute / JIT
       └─ only after verification + rewriting + method linking
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么 parser 成功后类还不能执行

目标约 1000 字。

- 举“把 `String` 当 `int` 用”“跳进半条指令”“构造函数没初始化 `this` 就返回”的事故例子
- 指出 parser 只保证 class-file 结构像样，不保证控制流上的类型状态安全
- 提出 verifier 真正要回答的问题：沿所有可达路径，当前帧是否合法
- 回收前文：StackMapTable bytes 只是被保留下来，尚未语义验证

### 第二节：三个朴素方案为什么都不够

目标约 1800 字。

至少推演：

1. 只做 parser 格式检查 → 操作数栈/局部变量类型错误仍可潜伏到执行期
2. 每次解释执行时再动态做类型合法性检查 → 太晚且成本太高，JIT 也拿不到可信字节码前提
3. 让 StackMapTable 完全替代字节码模拟 → 失去对 opcode 语义、分支、构造器初始化、新建对象来源等细节检查

引出：链接时验证 + 逐条模拟 + 关键汇合点对表，是三者组合而不是三选一。

### 第三节：时机与策略——为什么验证属于 linking，而不是 parsing

目标约 1800 字。

- `link_class_impl` 中 `verify_code()` 在 rewrite 之前
- class can be parsed/defined/loaded but not yet linked
- `BytecodeVerificationRemote/Local`、`-Xverify:*` 边界
- bootstrap/remote 的信任策略
- old/new verifier 的版本分流与 fallback 边界：<50 old、50 split+可回退、>=51 split 且不可回退
- shared classes / special bootstrap classes / generated classes 的跳过边界

### 第四节：`verify_method()`——验证器眼中的方法是什么

目标约 2000 字（核心拆解层）。

- `current_frame` = locals + operand stack + flags
- `set_locals_from_arg()`：参数、`this`、`uninitialized_this`
- `generate_code_data()`：标记 instruction start，特别是 `NEW_OFFSET`
- exception table / LVT / StackMapTable 准备
- 当前帧是“沿当前可达路径推进的抽象执行状态”，不是 JVM 真实解释器栈帧
- 这一步建立后，验证器才有资格谈“此时此刻栈顶应该是什么类型”

### 第五节：线性扫描——为什么 verifier 仍然要逐条模拟字节码

目标约 2200 字（核心拆解层）。

- `RawBytecodeStream` 从头线性扫描
- 每条指令前设置 offset/mark
- opcode-specific 规则：load/store、array op、branch、return、new/newarray/invoke
- `pop_stack(expected_type)` 与 assignability
- `verify_return_value`、constructor return must initialize `this`
- `verify_invoke_instructions`：签名弹栈 + `<init>` 特判 + receiver assignability
- 说明 StackMapTable 没有替代这些 transfer functions

### 第六节：StackMapTable——它把“汇合点推理”变成“关键点核对”

目标约 2200 字（核心拆解层）。

- frame count = 0 的缺省情况也存在，不能写成“Java 6+ 方法一律有表”
- 七种 frame family 的紧凑编码：same / append / chop / full 等
- verification type items：普通一字节 tag + `ITEM_Object` / `ITEM_Uninitialized` 带参数
- `ITEM_Object` 只取 CP 类名，不在这里触发完整类解析
- `ITEM_Uninitialized` 必须回指 `new` 指令的 offset，靠 `NEW_OFFSET` 校验
- `verify_stackmap_table` 不是“每条指令都强制比对”
  - 只有当前 bci 恰好存在 table frame 时才 `match_stackmap`
  - branch target / exception handler 必须精确有 frame
  - unconditional branch 后是 update without match
- 关键顿悟：StackMapTable 把 join state 的来源从“运行时自己合并所有前驱”改成“读取编译器给出的目标状态再核对 assignability”

### 第七节：控制流汇合为什么离不开 assignability，而不是简单相等

目标约 1500 字。

- `StackMapFrame::is_assignable_to`
- `VerificationType::is_assignable_from`
- null、Object、数组组件类型、子类关系
- 为什么 target frame 要求的是“当前流入状态可赋值到它”，而不是字节级相等
- 这也解释 StackMapTable 为什么只是 checkpoint，不是免检凭证

### 第八节：错误与边界——什么时候是 `VerifyError`，什么时候是 `ClassFormatError`

目标约 1300 字。

- `ErrorContext` / `TypeOrigin`
- missing stack map vs bad stack map vs bad operand stack vs bad return type
- new verifier failover 到 old verifier 的边界
- parser 阶段的格式错与 verifier 阶段的类型/控制流错的界线
- 强调：shared/rewritten classes 跳过新 verifier 是因为字节码已被改写，不适合再用原始 verifier 逻辑

### 第九节：收网与误解澄清

目标约 1000 字。

至少回答：

1. parser 成功是否意味着类可执行
2. 验证是在加载时还是链接时
3. StackMapTable 是否 Java 6+ 所有方法都必须携带
4. verifier 是否“每条指令都对一次 StackMapTable”
5. StackMapTable 是否替代了字节码模拟
6. branch target 检查是相等还是 assignability
7. old verifier 在 JDK 11u 是否完全消失
8. verifier 成功后是否还要 rewrite/link methods

## 5. 失败方案必须写进正文

1. 只做 parser 格式检查
2. 执行期再动态检查字节码类型安全
3. 让 StackMapTable 完全替代字节码模拟

## 6. 证据清单

- `instanceKlass.cpp:777-844`：link_class_impl 中 verify/rewrite/link 顺序
- `instanceKlass.cpp:686-691`：verify_code
- `verifier.cpp:140-216`：Verifier::verify 分流与结果
- `globals.hpp:518,561-564`：FailOverToOldVerifier、BytecodeVerificationRemote/Local
- `arguments.cpp:2804-2820`：`-Xverify` 对应开关
- `verifier.cpp:91-118`：should_verify_for / local vs remote
- `verifier.cpp:181-203`：old/new verifier 和 major version/fallback 边界
- `verifier.cpp:249-271`：special skip classes / shared / generated class 边界
- `verifier.cpp:603-620`：verify_class 逐方法和 skip native/abstract/overpass
- `verifier.cpp:638-678`：verify_method 初始化 current_frame / code_data / stackmap
- `stackMapFrame.hpp:43-63`：frame 结构
- `stackMapFrame.cpp:76-127`：set_locals_from_arg
- `verifier.hpp:356-360`、`verifier.cpp:1763-1783`：NEW_OFFSET / generate_code_data
- `verifier.cpp:687-711`：线性扫描骨架
- `verifier.cpp:1519-1723`：branch/new/newarray/multianewarray representative cases
- `verifier.cpp:2491-2741`：verify_invoke_instructions
- `verifier.cpp:2881-2897`：verify_return_value
- `verifier.cpp:1858-1892`：verify_stackmap_table
- `stackMapTable.cpp:71-141`：match_stackmap / check_jump_target
- `stackMapTable.cpp:155-167`：missing StackMapTable -> frame_count 0
- `stackMapTable.cpp:184-218`：parse_verification_type, ITEM_Object, ITEM_Uninitialized
- `stackMapTable.cpp:225-441`：七种 frame family 解析
- `stackMapTableFormat.hpp:158-165`：frame families 枚举
- `verificationType.hpp:264-298`、`verificationType.cpp:79-116`：assignability
- `verifier.hpp:97-223`、`verifier.cpp:431-489,1978-2009`：TypeOrigin / ErrorContext / 错误报告
- `classFileParser.cpp:2012-2031,2617-2628,2855-2863`：parser 保留 StackMapTable raw bytes 的边界
- `java.base/share/native/libjava/verify_stub.c:28-48`：old verifier bridge
- `java.base/share/native/libverify/check_code.c:771-924`：old verifier 主体验证与版本 API

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- parser 保留 StackMapTable raw bytes，不在 parser 阶段完整解码 frame 语义
- split verifier 由 major version >= 50 选择，但“StackMapTable 必须存在”要按 control-flow 需求限定，不能写成无条件强制
- old verifier 仍然存在，但 major >= 51 不允许 failover
- verifier 的 StackMapTable 使用是“关键点核对 + 状态更新”，不是每条指令都做 table equality compare
- JIT/解释执行都依赖 verified+rewritten bytecode；本文不展开 C1/C2 consumption
- shared/rewrite 后的类之所以跳过新 verifier，是因为字节码已改写，不适配原始 verifier 逻辑

## 8. 完成后 review

- 删除代码后能否复述“parser success != executable class → linking verify → current_frame linear simulation → StackMapTable join-point checking”
- 是否修正了 StackMapTable 强制性、逐条对表、完全替代推理等常见误解
- 是否把 local/remote policy、新旧 verifier 分流、fallback 边界说清
- 是否把 NEW_OFFSET / uninitialized object 的关系讲透
- 是否明确 verifier 成功后仍要 rewrite/link methods
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
