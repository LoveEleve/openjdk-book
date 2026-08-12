# 02. Verifier 与 StackMapTable — 字节码验证

> **前置依赖**:[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):解析把字节变成 InstanceKlass,但字节码本身未检查,StackMapTable 原始字节也在这里被留住;[42-core-native/03 — ClassLoader + I/O + TimeZone](openjdk/vol-02/42-core-native/03-class-io.md):libverify 是老验证器的宿主
> → **后续**:[03 — SymbolTable + StringTable](03-symbol-string-table.md)
> 关联域: 06-oops(类型系统)、13-jit(验证过的字节码才进 JIT)、27-jni

## 解析通过,不代表字节码安全

ClassFileParser 只做**格式**检查: 每个 section 符合规范、索引在界内。但字节码本身——`invokevirtual` 的参数类型对不对、跳转目标是否合法、操作栈会不会多算一个值——它一概不管。一个恶意构造的 .class 完全可以通过解析,却在运行时把 String 当成 int 用、或者让类型系统崩溃。Verifier 就是这最后一道防线。这一篇拆验证的三件事: 何时验、怎么验、以及 javac 提前写进文件里的 StackMapTable 如何把验证从"推导"变成"核对"。

## 1. 时机与入口: 链接时验证,不是加载时

### verify_code: link_class_impl 里的一道门

常见说法是"类加载时验证"——jdk11u 里实际发生在**链接阶段**。`InstanceKlass::link_class_impl`(instanceKlass.cpp:710 起)在重写字节码(`rewrite_class`)之前先过一道门(instanceKlass.cpp:790-793,截取核心,逐字):

```cpp
// instanceKlass.cpp:790-796(截取核心,逐字)
          bool verify_ok = verify_code(throw_verifyerror, THREAD);
          if (!verify_ok) {
            return false;
          }
```

`verify_code`(instanceKlass.cpp:686-691)转调 `Verifier::verify`(verifier.cpp:140)——验证的时机在"类第一次被使用、准备链接"时,而不是读入字节时。**验证失败 = 链接失败**;链接失败只在首次使用时才显现。

### 谁验、验谁: bootstrap 信任,remote 全验

验证策略由两个开关决定(globals.hpp:561-564): `BytecodeVerificationRemote=true`(非 bootstrap 类加载器加载的类一律验证)、`BytecodeVerificationLocal=false`(bootstrap 类默认**不验证**——JDK 自己信任自己);`-Xverify` 可以整体开关。`Verifier::verify`(:140 起)做分发: 类版本 ≥ 50(Java 6,`STACKMAP_ATTRIBUTE_MAJOR_VERSION`,verifier.hpp:39)走新验证器 `ClassVerifier::verify_class`(verifier.cpp:603,截取核心,逐字):

```cpp
// verifier.cpp:603-620(截取核心,逐字)
void ClassVerifier::verify_class(TRAPS) {
  log_info(verification)("Verifying class %s with new format", _klass->external_name());

  Array<Method*>* methods = _klass->methods();
  int num_methods = methods->length();

  for (int index = 0; index < num_methods; index++) {
    // Check for recursive re-verification before each method.
    if (was_recursively_verified())  return;

    Method* m = methods->at(index);
    if (m->is_native() || m->is_abstract() || m->is_overpass()) {
      // If m is native or abstract, skip it.  It is checked in class file
      // parser that methods do not override a final method.  Overpass methods
      // are trusted since the VM generates them.
      continue;
    }
    verify_method(methodHandle(THREAD, m), CHECK_VERIFY(this));
```

- **native/abstract/overpass 方法跳过**: native 没有字节码、abstract 没有实现、overpass(默认方法桥接)是 VM 生成的,信任;
- **逐方法验证**,`-Xlog:verification=info` 能看到全过程([实证],materials/commands/07-classfile-verification-log.txt):

```
[0.021s][info][verification] Verifying class Hello with new format
[0.021s][info][verification] Verifying method Hello.<init>(Ljava/lang/String;)V
[0.021s][info][verification] End class verification for: Hello
```

### 老验证器还在: 一个 dlsym 的距离

jdk11u 并没有删掉老验证器——它叫 `inference_verify`(verifier.cpp:274-322),但实现**不在 hotspot**: 通过 dlsym 从 libjava 里找 `VerifyClassCodesForMajorVersion`/`VerifyClassCodes` 函数(verifier.cpp:66-89,即 42 域见过的 libverify 的 check_code.c)。它有双重身份: **class 版本 < 50(Java 5 及更早)的类直接走老验证器**(verifier.cpp:198-201);版本 ≥ 50 的类先走新验证器,失败时若版本 < 51 且 `FailOverToOldVerifier` 开启(默认 true,globals.hpp:518)才回退(`NOFAILOVER_MAJOR_VERSION`=51,verifier.cpp:58)——51 起不允许回退,新验证器失败就是失败。

**关键设计 (斜体)**: *"链接时验证"不是顺手为之: 类加载可能发生多次(不同 loader 加载同一字节),而链接每个类只做一次;把验证放在链接,字节码的检查与"这个类真的会被用"绑定。bootstrap 类的豁免同理——信任边界划在"JDK 自己的字节码"上,省下每次启动验证几百个核心类的开销。*

## 2. verify_method: 线性扫描与帧的旅程

### 帧: 局部变量 + 操作栈的类型数组

每个方法的验证核心是一个 `StackMapFrame`(stackMapFrame.hpp:43-61,截取核心,逐字):

```cpp
// stackMapFrame.hpp:43-61(截取核心,逐字)
class StackMapFrame : public ResourceObj {
 private:
  int32_t _offset;
  ...
  int32_t _locals_size;  // number of valid type elements in _locals
  int32_t _stack_size;   // number of valid type elements in _stack

  int32_t _stack_mark;   // Records the size of the stack prior to an
                         // instruction modification, to allow rewinding
                         // when/if an error occurs.

  int32_t _max_locals;
  int32_t _max_stack;

  u1 _flags;
  VerificationType* _locals; // local variable type array
  VerificationType* _stack;  // operand stack type array
```

"帧" = **局部变量类型数组 + 操作栈类型数组**,`VerificationType` 是类型描述(union 打包: Symbol 指针或编码数据,verificationType.hpp:48-56)。流传的 "OperationStack" 类并不存在——数据流分析用的就是 StackMapFrame 自己。`verify_method`(verifier.cpp:630 起)的初始化(verifier.cpp:647-658,截取核心,逐字):

```cpp
// verifier.cpp:647-658(截取核心,逐字)
  // Initial stack map frame: offset is 0, stack is initially empty.
  StackMapFrame current_frame(max_locals, max_stack, this);
  // Set initial locals
  VerificationType return_type = current_frame.set_locals_from_arg(
    m, current_type(), CHECK_VERIFY(this));

  int32_t stackmap_index = 0; // index to the stackmap array

  u4 code_length = m->code_size();

  // Scan the bytecode and map each instruction's start offset to a number.
  char* code_data = generate_code_data(m, code_length, CHECK_VERIFY(this));
```

- `set_locals_from_arg` 按方法签名初始化局部变量区(参数的类型,`this` 在最前);
- `generate_code_data`(verifier.cpp:1763-1784)先扫一遍字节码,标记每个指令的起始偏移,其中 **`new` 指令的偏移标成 `NEW_OFFSET`**——这个标记后面要用来校验 Uninitialized 类型;
- 然后异常表、局部变量表逐项检查(:666-673),读取 StackMapTable(:675-683)。

### 线性扫描: 每条指令前的"对表"

验证主体是 `RawBytecodeStream` 从偏移 0 开始的**线性扫描**(verifier.cpp:687 起): 每读一条指令,先把当前帧与 StackMapTable 里同偏移的预计算帧**比对/同步**(`verify_stackmap_table`,verifier.cpp:1858),然后按操作码模拟——`push_stack`/`pop_stack` 维护类型栈(:767-867),引用类型的可赋值性检查在 `StackMapFrame::is_assignable_to`(stackMapFrame.cpp:158,底层用 `VerificationType::is_assignable_from`,verificationType.hpp:267——如 Object 的子类可以赋给 Object,反之不行)。

帧匹配的语义写在 `match_stackmap` 的注释里(stackMapTable.cpp:78-87,逐字):

```cpp
// stackMapTable.cpp:78-123(截取核心,逐字)
// Match and/or update current_frame to the frame in stackmap table with
// specified offset and frame index. Return true if the two frames match.
//
// The values of match and update are:                  _match__update
//
// checking a branch target:                             true   false
// checking an exception handler:                        true   false
// linear bytecode verification following an
// unconditional branch:                                 false  true
// linear bytecode verification not following an
// unconditional branch:                                 true   true
```

- **match=true**: 当前帧必须**可赋值给**预计算帧(`is_assignable_to`,:104-107)——类型不匹配就是 VerifyError;
- **update=true**: 用预计算帧**替换**当前帧(copy_locals/copy_stack,:109-121)。

这就是"check 而非 inference"的机制: 分支汇合点(jump target/异常处理器)的类型状态**直接取 javac 预计算的帧**,验证器只做核对,不需要自己从所有前驱推导类型。旧式推理验证器要在汇合点自己推导类型、路径越多开销越大;StackMapTable 把它变成线性扫描加常数次比较。

**关键设计 (斜体)**: *把"类型推导"从运行时挪到编译期是 StackMapTable 的整个赌注: javac 知道每个分支点该是什么类型,把它写进文件;JVM 只验不推。代价是文件变大、验证器要信任这些帧——所以每一帧都要重新走一遍可赋值性检查,预计算帧只是"跳板",不是"免检"。*

### 操作码模拟: 一个 case 一个规则

模拟是巨大的 switch: `_new` 推入 `uninitialized_type(bci)`(verifier.cpp:1652-1654,截取核心,逐字)——new 出的对象在 `<init>` 调用前是"未初始化"类型:

```cpp
// verifier.cpp:1652-1654(截取核心,逐字)
          type = VerificationType::uninitialized_type(bci);
          current_frame.push_stack(type, CHECK_VERIFY(this));
```

`newarray` 先 `pop_stack(integer_type())` 吃掉数组长度再推数组类型;`invokevirtual`/`invokespecial`/`invokestatic`/`invokeinterface`/`invokedynamic` 统一走 `verify_invoke_instructions`(verifier.cpp:2491)——按方法签名依次弹出实参并逐个做类型检查、最后推入返回类型。类型不匹配时的错误信息精确到字节码偏移与类型来源(`ErrorContext`/`TypeOrigin`,verifier.hpp:97-147): "Expecting a stackmap frame at branch target %d"、 "Bad type on operand stack" 这类 VerifyError 就是这么来的。

## 3. StackMapTable: 写在文件里的帧

### 七种 frame 的紧凑编码

StackMapTable 属性从 class 版本 50 起成为**强制项**(Java 6 起): 含分支的方法必须携带,缺失直接 VerifyError。每个条目是一个 `frame_type` 字节 + 按类型不同的后续字段(stackMapTableFormat.hpp:159-165 的宏枚举了七种):

| frame_type | 帧类型 | 附加字段 |
|---|---|---|
| 0-63 | same_frame | offset_delta = frame_type+1 |
| 64-127 | same_locals_1_stack_item | offset_delta = frame_type-63, + 1 个类型项 |
| 247 | same_locals_1_stack_item_extended | u2 偏移 + 1 个类型项 |
| 248-250 | chop_frame | u2 偏移,chop 掉 251-frame_type 个局部变量 |
| 251 | same_frame_extended | u2 偏移 |
| 252-254 | append_frame | u2 偏移 + (frame_type-251) 个类型项 |
| 255 | full_frame | u2 偏移 + 完整局部变量表 + 操作栈 |

偏移不直接存,存的是**与上一帧的差**(offset_delta): 相邻帧往往只差几字节,差值塞进 frame_type 本身(0-63 的 same_frame 连偏移字段都省了)。chop/append 是 same_frame_extended 的变体——**只在局部变量表尾部增删 k 项**,不用重写整帧。[实证] 里 javac 17 对带 if/for 的方法恰好生成了三种(materials/commands/07-classfile-stackmap-javap.txt):

```
      StackMapTable: number_of_entries = 4
        frame_type = 253 /* append */
          offset_delta = 4
          locals = [ int, int ]
        frame_type = 16 /* same */
        frame_type = 2 /* same */
        frame_type = 250 /* chop */
          offset_delta = 5
```

循环体里 append 了两个局部变量(int,int,frame_type 253-251=2)、退出后 chop 掉一个(250 → 251-250=1)——帧与帧的差异就是这么被压缩的。

### 类型项: 九个 ITEM 加两个带参数的类型

每个类型项 = tag(u1)+ 可选参数:`parse_verification_type`(stackMapTable.cpp:184-218)先读 tag——`ITEM_Top=0`(未使用槽)/`Integer=1`/`Float=2`/`Double=3`/`Long=4`/`Null=5`/`UninitializedThis=6`/`Object=7`/`Uninitialized=8`(verificationType.hpp:36-46)——然后两个"带参数"的类型单独处理(截取核心,逐字):

```cpp
// stackMapTable.cpp:189-199(截取核心,逐字)
  if (tag == ITEM_Object) {
    u2 class_index = _stream->get_u2(THREAD);
    int nconstants = _cp->length();
    if ((class_index <= 0 || class_index >= nconstants) ||
        (!_cp->tag_at(class_index).is_klass() &&
         !_cp->tag_at(class_index).is_unresolved_klass())) {
      _stream->stackmap_format_error("bad class index", THREAD);
      return VerificationType::bogus_type();
    }
    return VerificationType::reference_type(_cp->klass_name_at(class_index));
```

- **ITEM_Object**: 后跟常量池索引,必须是 Class 类(或未解析类),取**名字**做引用类型(验证期间不触发解析,只认名字——解析是 06-04 的领土);
- **ITEM_Uninitialized**(规范名,流传的 "ITEM_NewObject" 是误称): 后跟 **new 指令的偏移**,校验它确实指向一条 new 指令(:205-214,靠 §2 的 `NEW_OFFSET` 标记)——防止把任意偏移标成 Uninitialized 骗过验证器;
- `Long`/`Double` 占两个槽位(和 01 篇常量池的双槽一致)。

**关键设计 (斜体)**: *StackMapTable 是"编译期预计算 + 运行期核对"的教科书: 文件里存的是增量(offset_delta、chop/append),类型项引用常量池名字而非内嵌字符串,校验时每种类型都要回查合法性。验证器可以信任方向(帧来自 javac),但每个字节都仍要自查——信任但验证。*

## 核心悬念

验证的三件事到齐: 链接时过门(link_class_impl → verify_code)、逐方法线性扫描 + 帧匹配(match_stackmap 的"check 不 inference")、StackMapTable 的七种 frame 与九个 ITEM(增量编码、Object/Uninitialized 带参)。验证通过后,`rewrite_class` 才把字节码重写成 JVM 内部形式,类正式可用。但全程有一个看不见的主角: 帧里的类型项、指令里的名字,全都以 Symbol 形式存在——"java/lang/String" 这类字符串怎么做到全 JVM 只有一份、验证时随手取用?下一篇: SymbolTable 与 StringTable。

> → [03 — SymbolTable + StringTable](03-symbol-string-table.md)
