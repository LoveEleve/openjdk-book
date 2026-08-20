# 02. Verifier 与 StackMapTable：为什么 parser 成功后类还不能执行

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文聚焦 HotSpot 11u 的 linking/verifier 路径，不把 split verifier、old verifier 或 StackMapTable 的当前实现外推成所有 JVM 的唯一方案。
> **前置依赖**：[01 — ClassFile 解析](01-classfile-parser.md)：parser 已把字节流变成 `InstanceKlass`，并保留了 `StackMapTable` 的原始字节；[42-core-native/03 — ClassLoader + I/O + TimeZone](../42-core-native/03-class-io.md)：`defineClass` 把字节交给 VM 的入口
> → **后续**：[03 — SymbolTable + StringTable](03-symbol-string-table.md)
> 关联域：06-oops、13-jit、27-jni

## parser 成功，为什么类还不能执行

上一篇已经把 `.class` 字节流安全地变成了 `InstanceKlass`。到那一步为止，HotSpot 已经知道：

- class file 头和各个 section 的格式基本正确
- 常量池条目在索引和 tag 上能自圆其说
- 字段、方法、属性都被读进了 parser-owned 元数据，再移交给 `InstanceKlass`

但这些都还不足以让方法立刻执行。

因为 parser 解决的是“这段字节像不像一个 class file”，而 verifier 要解决的是另一件更危险的事：

```text
沿任意可达控制流走到某一条字节码时
局部变量表和操作数栈里的类型状态
到底是不是合法的吗？
```

举几个 parser 阶段不会真正打穿的问题：

- 一个 `invokevirtual` 调用前，栈上压着的是 `String` 还是 `int`
- 一条 `goto` 是否跳进了半条指令中间
- 构造函数是否在 `this` 还未初始化时就返回
- 两条不同分支在汇合点把同一个局部槽位理解成了不兼容的类型
- `new` 产生的未初始化对象是否真的对应某条 `new` 指令，而不是伪造的 offset

这些问题只看 class file 结构和常量池索引是看不出来的。它们属于**控制流上的抽象执行状态**。

所以本文真正的问题是：

**为什么 HotSpot 要在 linking 时再跑一次 verifier？它验证的到底不是字节流本身，而是什么状态？StackMapTable 又怎样把旧式“在汇合点自己推理类型”改成“在关键 offset 处按表核对”，却仍然不能替代逐条模拟字节码？**

先把全程画出来：

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
  │    ├─ 递归 link super / interfaces
  │    ├─ verify_code() -> Verifier::verify
  │    │    ├─ 按 local/remote policy 决定是否要验证
  │    │    ├─ 按 major version 决定 split 还是 old verifier
  │    │    └─ 逐方法 verify_method()
  │    │         ├─ current_frame = locals + operand stack
  │    │         ├─ 线性模拟每条字节码
  │    │         ├─ 在关键 offset 处核对 StackMapTable
  │    │         └─ 出错即 VerifyError / ClassFormatError
  │    ├─ rewrite_class
  │    ├─ link_methods
  │    ├─ initialize vtable / itable
  │    └─ class becomes linked
  │
  └─ execute / JIT
       └─ only after verified + rewritten + linked
```

一句话先记住：

**parser 只证明“这段字节在格式上像一个类”；verifier 要证明“沿控制流执行时，类型状态始终合法且可在汇合点收敛”；StackMapTable 只是把汇合点的目标状态预先写进文件，供 verifier 在关键 offset 处核对。**

---

## 一、三个看似更简单的办法，为什么都不够

### 1.1 只做 parser 格式检查

最省事的方案就是相信 parser：

```text
索引合法
属性长度合法
常量池 tag 对得上
→ 那就执行吧
```

这样的问题在于，parser 看到的是字节布局，没真正追踪“执行到这里时，栈顶此刻应该是什么类型”。

例如一个方法的控制流完全可能在格式上成立，却在语义上出现这样的状态：

```text
分支 A 把局部 1 当成 int
分支 B 把局部 1 当成 String
两条路径在同一 offset 汇合
```

只做格式检查，你直到运行时真正走到那一条路径，才会发现类型状态已经自相矛盾。那时解释器和 JIT 都已经建立在一段不可信字节码之上，代价太晚。

### 1.2 每次执行时动态检查类型安全

另一个极端是：不提前验证，解释器每次执行字节码时现场检查当前 locals 和 operand stack 的类型是否正确。

这会把 bytecode verification 从“一次性 linking 成本”变成“每次执行的热路径成本”。不仅解释器要付出代价，JIT 也拿不到“这段字节码已经满足基本类型安全前提”的保证，很多优化都失去基础。

HotSpot 需要的是：

```text
在第一次真正链接这个类时
把类型安全这道门一次过掉
后续解释和编译都站在已经验证过的前提上
```

### 1.3 让 StackMapTable 完全替代字节码模拟

第三个看法最容易迷惑人：既然 javac 已经把 frame 写进了 `StackMapTable`，那 verifier 直接读表不就行了？

不行，因为表只告诉你“在某些关键 offset，编译器认为局部变量表和操作数栈应当是什么状态”。它不替你回答：

- `invokevirtual` 到底要弹出多少参数
- `newarray` 的长度参数是不是 int
- `return` 的返回值能不能赋给方法声明的返回类型
- `ITEM_Uninitialized` 给出的 offset 是不是真的指向一条 `new`
- branch target 是否正好落在指令边界上

这些都必须通过逐条模拟字节码的 transfer function 才能检查。

正确的组合不是三选一，而是：

```text
parser 负责格式
verifier 负责控制流上的类型状态
StackMapTable 负责给 join-point 提供目标状态
```

这就是本文的主线。

---

## 二、时机与策略：为什么验证属于 linking，而不是 parsing

### 2.1 在 HotSpot 11u 里，验证发生在 `link_class_impl`

`InstanceKlass::link_class_impl` 的核心顺序在 `instanceKlass.cpp:787-844`：

```cpp
if (!is_linked()) {
  if (!is_rewritten()) {
    bool verify_ok = verify_code(throw_verifyerror, THREAD);
    if (!verify_ok) {
      return false;
    }
    rewrite_class(CHECK_false);
  }
  link_methods(CHECK_false);
  vtable().initialize_vtable(true, CHECK_false);
  itable().initialize_itable(true, CHECK_false);
  set_init_state(linked);
}
```

源码注释在 `instanceKlass.cpp:844-846` 说得很直白：重写必须发生在 verification 之后、方法第一次执行之前。

这说明几个重要边界：

```text
parser success   ≠ linked
loaded           ≠ rewritten
verified         在 rewrite 之前
linked           在 method link + vtable/itable init 之后
```

所以常见的“类加载时验证”是一种压缩说法。更精确地说，**验证发生在类 linking 阶段**。

### 2.2 类可以先被定义/loaded，再在首次 linking 时验证

上一篇已经说明，`ClassFileParser` 和 `define_instance_class()` 会把类送到 loaded 状态。但 loaded 不等于 linked。`InstanceKlass` 里 `is_loaded()` 和 `is_linked()` 本来就是不同状态。

这意味着一个类可以：

```text
已经有了 InstanceKlass
已经进入系统字典或类层次
但还没通过 verifier
也还没 rewrite / link methods
```

这正是“parser 成功不代表类可执行”的最具体体现。

### 2.3 为什么把验证放在 linking 更合适

把验证放在 linking 而不是 parser 阶段，有三个收益：

1. **把字节码安全检查绑定到“这个类真的要被使用”**。被装载却从不真正链接/执行的类，可以延后支付这部分成本。
2. **让定义、类层次、依赖加载和验证边界更清晰**。parser 只负责从 bytes 到 metadata；verifier 负责控制流上的类型安全。
3. **保证 rewrite 和 method linking 建立在 verified bytecode 前提上**。之后的 cp-cache 索引改写、method entry linking 和 JIT 都不必重复怀疑字节码类型安全。

### 2.4 local/remote policy：不是所有类都无条件验证

验证策略的默认值在 `globals.hpp:561-564`：

- `BytecodeVerificationRemote = true`
- `BytecodeVerificationLocal = false`

配合 `Verifier::should_verify_for(...)`，HotSpot 默认倾向于：

```text
非 bootstrap / 非本地可信来源 → 验证
bootstrap / 本地可信来源      → 默认可跳过验证
```

`-Xverify` 还能整体改变策略：

- `-Xverify` / `-Xverify:all`：local 和 remote 都开
- `-Xverify:remote`：只开 remote
- `-Xverify:none`：两者都关

但这里也别写过头：`-Xverify:none` 不等于 parser 里所有 class-file 检查都消失。版本检查、结构检查等 parser 级约束仍然存在。它只是关闭 bytecode verifier 那一层的类型状态检查路径。

### 2.5 新旧两套验证器并存，但边界很硬

`Verifier::verify` 在 `verifier.cpp:176-203` 中的分流是：

```text
major < 50  → old/inference verifier
major >= 50 → split/new verifier
              └─ 如果 FailOverToOldVerifier 且 major < 51
                 split 失败时可回退 old verifier
```

这组版本边界非常关键：

- `STACKMAP_ATTRIBUTE_MAJOR_VERSION = 50`，即 Java 6 起进入 split verifier 时代
- `NOFAILOVER_MAJOR_VERSION = 51`，即 Java 7 起 split 失败不再允许回退 old verifier

所以“jdk11u 还保留 old verifier 吗？”答案是：**保留，但它主要服务老 class version 和少数允许 failover 的边界。**

### 2.6 有些类会跳过新 verifier

`verifier.cpp` 里还有几类特殊跳过边界：

- 某些 bootstrap 核心类
- shared classes，因为其字节码已被 rewrite 成 verifier 不再理解的形式
- 特定 generated / special-accessor 类

这再次说明 verifier 不是“所有类无脑按一条路径过一遍”，而是建立在 class 来源、版本和当前状态之上的策略分流。

到这里先收一个总判断：**验证的时机是 linking，验证的必要性受策略控制，验证器的实现受 class major version 约束。**

---

## 三、`verify_method()`：验证器眼中的方法，不是字节串而是一张帧状态图

### 3.1 `current_frame` 才是 verifier 真正操作的对象

`verify_method()` 在 `verifier.cpp:647-678` 中的初始化说明了一切：

```cpp
StackMapFrame current_frame(max_locals, max_stack, this);
VerificationType return_type = current_frame.set_locals_from_arg(
  m, current_type(), CHECK_VERIFY(this));
char* code_data = generate_code_data(m, code_length, CHECK_VERIFY(this));
...
StackMapTable stackmap_table(&reader, &current_frame, max_locals, max_stack,
                             code_data, code_length, CHECK_VERIFY(this));
```

也就是说，验证器面对的方法不是“一个 `u1* code` 指针”，而是：

```text
current_frame
  = 当前 offset 下的局部变量类型数组
  + 当前 offset 下的操作数栈类型数组
  + 一些与构造器/初始化相关的 flags
```

### 3.2 初始 locals 来自方法签名，而不是来自 StackMapTable

`set_locals_from_arg()` 在 `stackMapFrame.cpp:76-127` 中根据方法签名初始化局部变量区：

- 实例方法的 slot 0 是 `this`
- 构造函数中的 `this` 初始是 `uninitialized_this`
- long/double 占两个 local slot
- 最后返回方法返回类型

这一步的重要性在于：verifier 不是一上来就靠 `StackMapTable` 得到完整初始状态。它首先必须根据方法本身的声明语义建立初始 frame。

### 3.3 `generate_code_data()` 先把“哪些 offset 是合法指令起点”标出来

`generate_code_data()` 在 `verifier.cpp:1763-1783` 中先线性扫一遍字节码，为每个 BCI 建立一个标记数组：

```text
普通指令起点 → BYTECODE_OFFSET
new 指令起点  → NEW_OFFSET
```

`NEW_OFFSET` 很关键。后面 `ITEM_Uninitialized` 要用一个 `u2 offset` 表示“这是由哪一条 `new` 创建出来的未初始化对象”，verifier 不能只信这个数字在方法范围内，它还要确认这个 offset 确实落在一条 `new` 上。

因此 `generate_code_data()` 不是多余的预处理，它建立了后续 branch target、exception handler 和 uninitialized object 校验的共同坐标系。

### 3.4 exception table、LVT、StackMapTable 也在这里先装进验证上下文

`verify_method()` 初始化阶段还会：

- 检查 exception handler 的 start/end/handler offset 是否都在合法指令边界上
- 检查 LocalVariableTable 的范围是否落在合法 code 区间
- 从 `m->stackmap_data()` 读取原始 StackMapTable bytes，构造 `StackMapReader` 与 `StackMapTable`

这里要记住一个边界：**parser 保留了 StackMapTable raw bytes，但 frame 的详细语义解码是在 verifier 阶段完成的。**

到这里 verifier 才真正拥有一张方法级“抽象执行状态机”：初始 frame、instruction-start map、异常表边界、局部变量表边界，以及可能存在的 StackMapTable。

---

## 四、线性扫描：为什么 verifier 仍然要逐条模拟字节码

### 4.1 主循环的主语是“推进当前帧”

主循环在 `verifier.cpp:687-717`：

```cpp
RawBytecodeStream bcs(m);
while (!bcs.is_last_bytecode()) {
  opcode = bcs.raw_next();
  u2 bci = bcs.bci();
  current_frame.set_offset(bci);
  current_frame.set_mark();
  stackmap_index = verify_stackmap_table(...);
  ...
}
```

看上去它是“读一条 opcode 然后 switch”，但真正的主语其实是：

```text
当前 frame 随着控制流和 opcode 语义不断被更新
```

每一条字节码都要回答：

- 从 operand stack 弹出什么类型
- 向 operand stack 压回什么类型
- 某个 local slot 现在变成了什么类型
- 是否切断了对下一条顺序指令的直接控制流

### 4.2 `pop_stack(expected_type)` 和 assignability 是最常见的验证动作

验证器的大量 case 都在做一类动作：

```text
从 current_frame 的操作数栈或 locals 中取值
  → 检查它能否赋给当前 opcode 所要求的类型
  → 成功则继续推进 frame
  → 失败则 VerifyError
```

例如：

- `if_icmp*` 需要两个整数
- `if_acmp*` 需要两个引用
- `newarray` 需要先弹一个 int 长度
- `areturn` 需要栈顶值可赋给方法声明的返回类型

这一层 transfer function 绝不是 `StackMapTable` 能代替的，因为它依赖每条 opcode 的具体语义。

### 4.3 `new`、`<init>` 和 `uninitialized_this` 是必须通过模拟才能抓住的语义

`new` 在 `verifier.cpp:1640-1655` 的语义不是“压一个普通引用类型”，而是：

```cpp
type = VerificationType::uninitialized_type(bci);
current_frame.push_stack(type, CHECK_VERIFY(this));
```

也就是说，`new` 产生的是一个与创建它的 `bci` 绑定的“未初始化对象类型”。

构造器调用时，`verify_invoke_instructions()` 还要验证：

- 这个未初始化对象是否真的对应某条 `new`
- `<init>` 调用后，frame 中所有对应的 uninitialized value 要被替换成已初始化类型
- 构造函数返回前，`this` 不能仍处于 uninitialized 状态

这些都是“控制流上对象初始化状态”的问题，不是 parser 或单纯 frame 表格可以提前拍脑袋给出的答案。

### 4.4 `invoke*` 的验证是“按签名弹栈”，不是“看见 Methodref 就过”

`verify_invoke_instructions()` 在 `verifier.cpp:2491-2741` 统一处理 `invokevirtual` / `invokespecial` / `invokestatic` / `invokeinterface` / `invokedynamic`。

它做的关键事包括：

- 检查 CP 引用种类是否和当前 invoke opcode 匹配
- 解析 descriptor，按签名顺序弹出参数并逐个做类型检查
- 对 `<init>` 做额外限制
- 检查 receiver 类型是否可赋给目标 holder
- 最后按返回类型把结果压栈

也就是说，verifier 并不信任“这是一个 Methodref，所以调用肯定没问题”。它要真正把签名翻译成 frame 上的出栈/入栈效果。

### 4.5 return 也不是简单看方法签名

`ireturn`、`lreturn`、`areturn`、`return` 这些指令同样依赖当前 frame 状态。`verify_return_value()` 在 `verifier.cpp:2881-2897` 中检查的是：

```text
当前栈顶的抽象类型
是否可赋给方法声明的返回类型
```

构造器还额外要求 `this` 已初始化，否则就算方法声明返回 void，也不能合法返回。

所以本节的结论必须写得很硬：**StackMapTable 没有替换掉 opcode 级 transfer function；verifier 仍然必须逐条模拟字节码对 frame 的影响。**

---

## 五、StackMapTable：它把“汇合点推理”改成“关键点核对”

### 5.1 缺失 StackMapTable 时，split verifier 看到的是空表，不是立刻报错

这是最容易被写错的地方。

`StackMapReader` 的构造函数在 `stackMapTable.cpp:155-167` 中非常直接：

```cpp
if (m->has_stackmap_table()) {
  _frame_count = _stream->get_u2(CHECK);
} else {
  _frame_count = 0;
}
```

也就是说，在 HotSpot 11u 的实现里，“没有 `StackMapTable`”首先被表示成一个**零帧表**，而不是在 parser 或 verifier 刚开始时立刻无条件报错。

真正的问题是：后面控制流走到需要 frame 的地方时，这张空表能不能提供合法 checkpoint。

因此“Java 6+ 方法一律必须携带 StackMapTable”是过强的压缩。更准确的说法是：

**major version 50+ 进入 split verifier 时代，而 verifier 在控制流汇合点/目标点需要有效 frame；缺失或不一致的 frame 会在那里失败。**

### 5.2 七种 frame family 的意义，是压缩变化，而不是复制整帧

`stackMapTableFormat.hpp:158-165` 和 `stackMapTable.cpp:225-441` 展示了七种 frame family：

```text
same_frame
same_frame_extended
same_locals_1_stack_item_frame
same_locals_1_stack_item_extended
chop_frame
append_frame
full_frame
```

这套编码的本质不是“花哨”，而是压缩相邻 checkpoint 的差异。

如果上一个 frame 和下一个 frame 只差：

- offset 变了，但 locals/stack 没变 → `same_*`
- 只多了一两个 stack item → `same_locals_1_stack_item_*`
- 只在 locals 尾部删几个槽 → `chop_frame`
- 只在 locals 尾部补几个槽 → `append_frame`
- 变化太大 → `full_frame`

这样，编译器不必为每个 checkpoint 重写整张 locals/stack 表。

### 5.3 `ITEM_Object` 与 `ITEM_Uninitialized` 都不是“随便带个 u2”

`parse_verification_type()` 在 `stackMapTable.cpp:184-218` 中处理 verification type item。

其中两个带参数项最关键：

```text
ITEM_Object
  → u2 class_index
  → 必须是 class 或 unresolved class CP 项
  → 变成 reference_type(cp->klass_name_at(index))

ITEM_Uninitialized
  → u2 offset
  → 必须落在 code_length 内
  → 且 code_data[offset] == NEW_OFFSET
```

第二条尤其重要。它说明 verifier 不会接受“随便写一个 offset 就说这是未初始化对象”。这个 offset 必须回指到一条真实的 `new` 指令。

因此 StackMapTable 里的类型项不是“编译器给什么就信什么”，而是每个带参数项仍要回头走源码里的合法性检查。

### 5.4 `verify_stackmap_table()` 不是“每条指令都强制对表”

很多讲解会把 split verifier 说成：“每执行一条指令，都拿当前 frame 和 StackMapTable 比一下。”这太粗糙了。

`verify_stackmap_table()` 在 `verifier.cpp:1858-1892` 中只在两类情况下真正关心表项：

1. 当前 `bci` 恰好有 table frame
2. 当前控制流状态要求下一个可达点必须从 table 重新建立状态

如果下一条 table frame 的 offset 还没到当前 `bci`，它不会做比对；如果根本没有对应 frame，而当前控制流又不要求它，它也不会仅因为“这个 bci 没表项”就报错。

所以准确说法是：**verifier 对每条指令都维护 `current_frame`，但只在关键 offset 上与 StackMapTable 交互。**

### 5.5 四种 `match/update` 模式揭示了 StackMapTable 的真正角色

`match_stackmap` 的注释在 `stackMapTable.cpp:81-88` 写得很清楚：

```text
branch target                    → match=true,  update=false
exception handler                → match=true,  update=false
linear after unconditional branch→ match=false, update=true
linear with normal fall-through  → match=true,  update=true
```

这四种模式说明了 StackMapTable 在 verifier 里的真实位置：

- **有直接控制流前驱时**：当前 frame 必须可赋值到 table frame
- **无直接控制流前驱时**：table frame 用来重建后续当前状态
- **普通线性路径**：既核对也用它更新 current frame

所以 StackMapTable 并不是“每个点都取代表值覆盖当前状态”。它在不同控制流语境下扮演的是：

```text
checkpoint
join-point 目标状态
无前驱路径后的恢复状态
```

这就是“把推理改成核对”的精确含义：不是停止模拟字节码，而是停止在汇合点从多个前驱自己做昂贵的全量合并推理。

---

## 六、控制流汇合为什么离不开 assignability，而不是简单相等

### 6.1 verifier 检查的是“当前状态能否赋给目标状态”

`StackMapFrame::is_assignable_to` 最终会调用 `VerificationType::is_assignable_from`。这意味着 StackMapTable 匹配不是按“两个 frame 字节级完全相等”判断的。

它允许的关系包括：

- `null` 可以赋给引用类型
- 子类引用可以赋给父类引用
- 数组类型按组件类型递归检查赋值关系
- 某些 verifier 的 category 判断允许更宽泛的 primitive/slot 语义

如果把汇合点检查写成“frame 必须完全一致”，就会把 Java 类型系统中的 assignability 与 verifier 的抽象类型关系抹掉。

### 6.2 branch target 的要求是“精确 offset + 可赋值状态”

`check_jump_target()` 在 `stackMapTable.cpp:124-141` 会：

1. 计算精确 target = `bci + offset`
2. 要求该 target 在方法范围内
3. 要求 target 对应的 StackMapTable frame 存在
4. 要求当前 frame 可赋值到 target frame

这里既不是“找到一个最近的 frame 就行”，也不是“只要 offset 看起来像个 instruction boundary 就行”。控制流图上的 join-point 状态必须在精确 offset 处收敛到一个合法目标状态。

### 6.3 这也解释了为什么 StackMapTable 不是免检凭证

如果 StackMapTable 真的是“编译器已经替我把类型证明完了”，verifier 理应直接采信 table。但实际它在 branch target、handler 和线性路径上都还要重新走 assignability 检查。

所以更准确的说法是：

```text
StackMapTable 提供的是生产者给出的目标状态候选
Verifier 仍要确认当前流入状态能否赋给它
```

“信任但验证”在这里不是一句套话，而是 `match_stackmap` 的直接行为。

---

## 七、错误与边界：什么时候是 `VerifyError`，什么时候是 `ClassFormatError`

### 7.1 不是所有错误都叫 VerifyError

HotSpot 在 verifier 里区分了几类错误来源：

- 纯格式/属性结构问题 → 更像 `ClassFormatError`
- 类型状态、控制流状态、目标状态不一致 → 更像 `VerifyError`

`ErrorContext` 和 `TypeOrigin` 在 `verifier.hpp:97-223` 中把错误上下文细分成：

```text
wrong type
bad local index
bad constant pool index
missing stackmap
bad stackmap
stack overflow / underflow
flags mismatch
...
```

最终的错误信息还能带上：

- 当前 bytecode offset
- 当前 frame
- 期待类型与实际类型的来源
- StackMapTable 情况
- 异常表上下文

所以我们平时看到的 “Bad type on operand stack” 或 “Expecting a stackmap frame at branch target” 并不是统一模板文案，而是 verifier 带着上下文生成的。

### 7.2 split verifier 失败后的 old-verifier 回退有严格版本边界

`FailOverToOldVerifier` 的存在很容易被误写成“新验证器失败就自动再试一次旧验证器”。

实际条件更严格：

- 需要 `FailOverToOldVerifier` 开启
- 需要 `major_version < 51`
- 需要 split verifier 失败的是 `VerifyError` 或 `ClassFormatError`

这意味着在 JDK 11u 里：

```text
major 50  → 可能 split 后回退 old
major 51+ → split 失败就是失败
```

把这个边界说清非常重要，否则读者会误以为 old verifier 只是个“兼容兜底永远在后面”。

### 7.3 shared / rewritten classes 为什么会跳过新 verifier

shared classes 已经被 rewrite 成 verifier 不再理解的字节码形式，例如部分常量池引用已经变成了 cp-cache 相关内部形态。这不是“类太可信所以不用验”，而是“当前 verifier 预期的是原始 class bytecode 语义”。

因此 shared/re-written 的跳过边界，本质上是输入形态不再匹配 verifier 的设计前提，而不是简单的“信任级别更高”。

---

## 八、误解澄清：八个最容易写过头的判断

1. **parser 成功是否意味着类可执行？** 不是。parser 只是构造了 `InstanceKlass`；verification、rewrite、method linking、vtable/itable init 还没发生。
2. **验证是在加载时还是链接时？** 在 HotSpot 11u 里，更精确的说法是 linking 时验证，而不是 parser 读字节时验证。
3. **Java 6+ 是否所有方法都必须显式携带 `StackMapTable`？** 不是这么绝对。major 50+ 进入 split verifier 时代，但缺表首先表现为空表；真正失败发生在需要 frame 的控制流点上。
4. **verifier 是否每条指令都对一次 StackMapTable？** 不是。每条指令都维护 `current_frame`，但只有关键 offset 才与 table 交互。
5. **StackMapTable 是否替代了字节码模拟？** 没有。opcode 的 transfer function、参数弹栈、返回值检查、`new`/`<init>` 语义都仍靠 verifier 逐条模拟。
6. **branch target 检查是 frame 完全相等吗？** 不是。要求的是 assignability，不是字节级 equality。
7. **old verifier 在 JDK 11u 是否完全消失？** 没有。它仍存在于版本与 failover 边界内。
8. **verifier 成功后类就完全 ready 了吗？** 还没有。接下来还要 rewrite bytecode、link methods、初始化 vtable/itable，类才进入 linked 状态。

---

## 九、收网：验证的对象不是字节流，而是控制流上的类型状态

现在把全文压回最开始的问题：为什么 parser 成功后类还不能执行？

因为 parser 证明的是：

```text
这段字节在 section、索引、属性长度上像一个 class file
```

而 verifier 证明的是：

```text
沿任意可达控制流执行时
locals 和 operand stack 的抽象类型状态始终合法
并且在关键 offset 处可以收敛到一致目标状态
```

StackMapTable 则把 verifier 最难的那一部分——控制流汇合点的目标状态——提前写进 class file，使 HotSpot 不必像旧验证器那样在每个 join-point 从所有前驱路径自己做全量类型推导。

但它并没有让 verifier 失业：

- verifier 仍要逐条模拟 opcode 对 frame 的影响
- 仍要验证 branch target、handler、`new`/`<init>`、return 和 invoke 的语义
- 仍要检查当前状态是否可赋值到 table 给出的目标状态

三句话收束本篇：

- **parser 成功只意味着类的字节结构成立，不意味着方法的控制流类型状态安全。**
- **verifier 的核心对象是 `current_frame`，不是单纯的字节码流或常量池表。**
- **StackMapTable 把 join-point 的状态来源从运行时推理改成按表核对，但没有替代逐条模拟和 assignability 检查。**

下一篇顺着“类型名字和字符串常量在 verifier/constant pool/运行时到处出现”的问题继续：为什么 `java/lang/String`、`<init>`、`Hello` 这些内容能够在整个 JVM 中只保存一份，同时 Java 字符串的 `intern` 又走的是另一张表。

> → [03 — SymbolTable + StringTable](03-symbol-string-table.md)
