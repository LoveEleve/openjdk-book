# 01. 恶意字节码怎么被拦下？— ClassVerifier 类型检查引擎

> **前置依赖**:[07-classfile-classloader/02 — Verifier 与 StackMapTable](openjdk/vol-02/07-classfile-classloader/02-verifier-stackmap.md):验证的时机(链接时)、入口(Verifier::verify → verify_class → verify_method)、StackMapTable 格式与帧匹配语义已拆——本篇承接"类型检查引擎"本身;[08-interpreter/01 — Bytecode 定义表](openjdk/vol-02/08-interpreter/01-bytecodes-definition.md):验证器逐条迭代字节码用的就是那张表;[06-oops/02 — 对象到类的桥](openjdk/vol-02/06-oops/02-klass-hierarchy.md):可赋值性检查要问类层次
> → **后续**:[44-class-verification/02 — VerificationType 类型系统](02-verification-type.md):本篇的类型编码只开了头,下一篇拆完整体系
> 关联域: 07-classfile(解析/StackMapTable)、08-interpreter(字节码表)、13-jit(验证过的字节码才进 JIT)、24-frame(帧概念复用)

## 一个字节之差: 被拦与放行

把 `Bad.add` 方法字节码里 `iload_0`(0x1A)改成 `aload_0`(0x2A)——把 int 当引用用。同一个类文件(08-verifier-demo.txt): **默认验证开启 → `VerifyError: Bad local variable type`,异常详情直指 "Type integer (current frame, locals[0]) is not assignable to reference type";`-Xverify:none` → 加载成功、照常算出 3**。类型混淆攻击就是这么防的: 验证器在链接时逐指令模拟类型流,任何"栈顶类型与指令要求不符"都当场拒绝。这一篇拆检查引擎本身: 类型怎么编码、可赋值性怎么判定、new 出来的对象怎么被追踪、错误怎么变成那条详细异常。

## 1. 引擎骨架: 承接 07-02

07-02 拆过: 链接时 `verify_code` → `Verifier::verify`(verifier.cpp:140)→ 类版本 ≥ 50 走 `ClassVerifier::verify_class`(:603)→ 逐方法 `verify_method`(:630)→ `StackMapTable` 构造(:677)→ 线性扫描中逐指令 `verify_stackmap_table` 对表(:1858)。本篇在这条链上继续往下挖三层: 类型编码、可赋值性、Uninitialized 生命周期——它们是"对表"和"模拟"的原料。大纲这次的行号全对(140/603/630/677/1858),说明 07-02 写作期已经把 verifier.cpp 验证过一轮;本篇不再重复入口叙述,直接进类型系统。

## 2. VerificationType: 一个 union 装下所有类型

### 编码: Symbol 指针或压缩数据

帧里的每个槽是一个 `VerificationType`——**真 union**(verificationType.hpp:48-62,截取核心,逐字):

```cpp
// verificationType.hpp:48-62(截取核心,逐字)
class VerificationType {
  private:
    // Least significant bits of _handle are always 0, so we use these as
    // the indicator that the _handle is valid.  Otherwise, the _data field
    // contains encoded data (as specified below).  Should the VM change
    // and the lower bits on oops aren't 0, the assert in the constructor
    // will catch this and we'll have to add a descriminator tag to this
    // structure.
    union {
      Symbol*   _sym;
      uintptr_t _data;
    } _u;
```

引用类型直接存 `Symbol*`(名字指针,低 2 位天然为 0 可当标志);非引用类型把数据压缩进 `_data`。编码规则(verificationType.hpp:62-112,截取核心,逐字):

```cpp
// verificationType.hpp:62-112(截取核心,逐字)
    enum {
      // Bottom two bits determine if the type is a reference, primitive,
      // uninitialized or a query-type.
      TypeMask           = 0x00000003,

      // Topmost types encoding
      Reference          = 0x0,        // _sym contains the name
      Primitive          = 0x1,        // see below for primitive list
      Uninitialized      = 0x2,        // 0x00ffff00 contains bci
      TypeQuery          = 0x3,        // Meta-types used for category testing

      // Utility flags
      ReferenceFlag      = 0x00,       // For reference query types
      Category1Flag      = 0x01,       // One-word values
      Category2Flag      = 0x02,       // First word of a two-word value
      Category2_2ndFlag  = 0x04,       // Second word of a two-word value

      // special reference values
      Null               = 0x00000000, // A reference with a 0 sym is null

      // Primitives categories (the second byte determines the category)
      Category1          = (Category1Flag     << 1 * BitsPerByte) | Primitive,
      Category2          = (Category2Flag     << 1 * BitsPerByte) | Primitive,
      Category2_2nd      = (Category2_2ndFlag << 1 * BitsPerByte) | Primitive,

      // Primitive values (type descriminator stored in most-signifcant bytes)
      Bogus              = (ITEM_Bogus      << 2 * BitsPerByte) | Primitive,
      Boolean            = (ITEM_Boolean    << 2 * BitsPerByte) | Category1,
      Byte               = (ITEM_Byte       << 2 * BitsPerByte) | Category1,
      Short              = (ITEM_Short      << 2 * BitsPerByte) | Category1,
      Char               = (ITEM_Char       << 2 * BitsPerByte) | Category1,
      Integer            = (ITEM_Integer    << 2 * BitsPerByte) | Category1,
      Float              = (ITEM_Float      << 2 * BitsPerByte) | Category1,
      Long               = (ITEM_Long       << 2 * BitsPerByte) | Category2,
      Double             = (ITEM_Double     << 2 * BitsPerByte) | Category2,
      Long_2nd           = (ITEM_Long_2nd   << 2 * BitsPerByte) | Category2_2nd,
      Double_2nd         = (ITEM_Double_2nd << 2 * BitsPerByte) | Category2_2nd,

      // Used by Uninitialized (second and third bytes hold the bci)
      BciMask            = 0xffff << 1 * BitsPerByte,
      BciForThis         = ((u2)-1),   // A bci of -1 is an Unintialized-This
```

**关键设计 (斜体)**: *一个 uintptr_t(64 位平台下 64 位)的低位被切成几段: 低 2 位是"顶层类别"(引用/基本/未初始化/查询),第二字节是"类别"(1 槽/2 槽首字/2 槽次字),高字节区存基本类型 descriminator(注释原话 "type descriminator stored in most-signifcant bytes")。long/double 的"第二字"是独立类型(`Long_2nd`/`Double_2nd`)——双槽值在帧里占两个槽位,验证器显式跟踪次槽,这是 07-02 提过的"long/double 占两个 slot"的机械实现。查询类型(Category1Query 等)不是真实类型,是给 `pop_stack` 用的"我要一个 1 槽值"的通配符。*

## 3. is_assignable_from: 可赋值性的判定树

### 主判定

帧匹配(`is_assignable_to`)和操作码模拟(`pop_stack`)的底层都收敛到同一个判定(verificationType.hpp:267-298,截取核心,逐字):

```cpp
// verificationType.hpp:267-298(截取核心,逐字)
  bool is_assignable_from(
      const VerificationType& from, ClassVerifier* context,
      bool from_field_is_protected, TRAPS) const {
    if (equals(from) || is_bogus()) {
      return true;
    } else {
      switch(_u._data) {
        case Category1Query:
          return from.is_category1();
        case Category2Query:
          return from.is_category2();
        case Category2_2ndQuery:
          return from.is_category2_2nd();
        case ReferenceQuery:
          return from.is_reference() || from.is_uninitialized();
        case Boolean:
        case Byte:
        case Char:
        case Short:
          // An int can be assigned to boolean, byte, char or short values.
          return from.is_integer();
        default:
          if (is_reference() && from.is_reference()) {
            return is_reference_assignable_from(from, context,
                                                from_field_is_protected,
                                                THREAD);
          } else {
            return false;
          }
      }
    }
  }
```

规则树: 相同类型/自身是 bogus(未知)→ 通过;**查询类型**按类别匹配(指令要求"栈顶是引用"用 ReferenceQuery 检查);**Boolean/Byte/Char/Short 接受任何 int**(验证器的宽化——字节码层面 int 和 boolean 都是 32 位值);引用对引用 → 进 `is_reference_assignable_from`;其余(基本对引用等)→ 拒绝。实证里的 "Type integer ... is not assignable to reference type" 就发生在 ReferenceQuery 分支: `aload` 模拟走 `verify_aload`(verifier.cpp:2832-2837),`get_local(index, reference_check(), ...)` 要求局部变量槽是引用类别,integer 不是 → false → "Bad local variable type"。

### 引用对引用: 会触发类解析

is_reference_assignable_from(verificationType.cpp:79-116,截取核心,逐字):

```cpp
// verificationType.cpp:79-116(截取核心,逐字)
bool VerificationType::is_reference_assignable_from(
    const VerificationType& from, ClassVerifier* context,
    bool from_field_is_protected, TRAPS) const {
  InstanceKlass* klass = context->current_class();
  if (from.is_null()) {
    // null is assignable to any reference
    return true;
  } else if (is_null()) {
    return false;
  } else if (name() == from.name()) {
    return true;
  } else if (is_object()) {
    // We need check the class hierarchy to check assignability
    if (name() == vmSymbols::java_lang_Object()) {
      // any object or array is assignable to java.lang.Object
      return true;
    }

    if (DumpSharedSpaces && SystemDictionaryShared::add_verification_constraint(klass,
              name(), from.name(), from_field_is_protected, from.is_array(),
              from.is_object())) {
      // If add_verification_constraint() returns true, the resolution/check should be
      // delayed until runtime.
      return true;
    }

    return resolve_and_check_assignability(klass, name(), from.name(),
          from_field_is_protected, from.is_array(), from.is_object(), THREAD);
  } else if (is_array() && from.is_array()) {
    VerificationType comp_this = get_component(context, CHECK_false);
    VerificationType comp_from = from.get_component(context, CHECK_false);
    if (!comp_this.is_bogus() && !comp_from.is_bogus()) {
      return comp_this.is_component_assignable_from(comp_from, context,
                                          from_field_is_protected, CHECK_false);
    }
  }
  return false;
}
```

规则: null → 任何引用;同为 null → 拒绝;同名 → 通过;**目标是 Object → 全通过**;**目标是数组 → 组件类型递归**(`is_component_assignable_from`,基本类型组件必须完全相同);其余 → **`resolve_and_check_assignability` 解析类层次判子类/接口关系**。

**关键设计 (斜体)**: *注意最后一步会触发类解析——07-02 说 StackMapTable 的类型项"只认名字不解析"(构造时不解析),但**可赋值性检查需要类层次,躲不开解析**。区分两层: 读类型项时只取名字(验证器不主动触发加载),判子类时按需解析(可能触发加载,也可能被 CDS 的 verification constraint 推迟到运行时——DumpSharedSpaces 分支)。验证器的"惰性解析"在这里体现。*

## 4. Uninitialized: new 出来的对象,一生只有一段

### new: 推入带 bci 的未初始化类型

`new` 指令模拟时推入的不是类本身,而是 `uninitialized_type(bci)`(07-02 提过,verifier.cpp:1652-1654)——类型编码的 `Uninitialized` 段(0x00ffff00)装的是 **new 指令的 bci**。帧里的 Uninitialized 类型因此"记得"自己从哪条 new 来——验证器能区分两个不同 new 产生的未初始化对象,也能在 `<init>` 调用时精确替换。

### <init>: 全帧替换与 try 块约束

`invokespecial <init>` 走 `verify_invoke_init`(verifier.cpp:2371 起),三件事(verifier.cpp:2371-2420,截取核心,逐字):

```cpp
// verifier.cpp:2371-2420(截取核心,逐字)
void ClassVerifier::verify_invoke_init(
    RawBytecodeStream* bcs, u2 ref_class_index, VerificationType ref_class_type,
    StackMapFrame* current_frame, u4 code_length, bool in_try_block,
    bool *this_uninit, const constantPoolHandle& cp, StackMapTable* stackmap_table,
    TRAPS) {
  u2 bci = bcs->bci();
  VerificationType type = current_frame->pop_stack(
    VerificationType::reference_check(), CHECK_VERIFY(this));
  if (type == VerificationType::uninitialized_this_type()) {
    // The method must be an <init> method of this class or its superclass
    Klass* superk = current_class()->super();
    if (ref_class_type.name() != current_class()->name() &&
        ref_class_type.name() != superk->name()) {
      verify_error(ErrorContext::bad_type(bci,
          TypeOrigin::implicit(ref_class_type),
          TypeOrigin::implicit(current_type())),
          "Bad <init> method call");
      return;
    }
    ...
    current_frame->initialize_object(type, current_type());
    *this_uninit = true;
  } else if (type.is_uninitialized()) {
    u2 new_offset = type.bci();
    address new_bcp = bcs->bcp() - bci + new_offset;
    if (new_offset > (code_length - 3) || (*new_bcp) != Bytecodes::_new) {
      /* Unreachable?  Stack map parsing ensures valid type and new
       * instructions have a valid BCI. */
      verify_error(ErrorContext::bad_code(new_offset),
```

- **UninitializedThis**(`BciForThis`,bci=-1): 构造器里未初始化完成的 `this`——`<init>` 只能调用**本类或超类的 `<init>`**,否则拒绝;
- **普通 Uninitialized**(new 出来的): 校验 bci 处确实是一条 `new` 指令(`(*new_bcp) != Bytecodes::_new` → 拒绝)——防止伪造 bci 指向任意指令;
- 两种情况下都执行 `initialize_object(type, 目标类)`: 把帧的**局部变量区和操作栈**里所有等于该 Uninitialized 类型的槽替换成真实类(stackMapFrame.cpp:57-70,截取核心,逐字):

```cpp
// stackMapFrame.cpp:57-70(截取核心,逐字)
void StackMapFrame::initialize_object(
    VerificationType old_object, VerificationType new_object) {
  int32_t i;
  for (i = 0; i < _max_locals; i++) {
    if (_locals[i].equals(old_object)) {
      _locals[i] = new_object;
    }
  }
  for (i = 0; i < _stack_size; i++) {
    if (_stack[i].equals(old_object)) {
      _stack[i] = new_object;
    }
  }
```

**关键设计 (斜体)**: *"new 的对象在 <init> 前不是普通引用"是 Java 类型系统的一条硬规则(未初始化对象不能赋给字段/参数、不能 escape),验证器用"带 bci 的类型 + 全帧替换"实现它: 生命周期从 new 的 bci 开始,到 invokespecial <init> 那一刻,帧里所有同名未初始化槽一起"毕业"成真实类型——包括局部变量里暂时存放的副本。构造器里还有额外约束: `<init>` 调用若发生在 try 块内,要先验证所有异常处理器路径以"未完成初始化"状态结束(注释: "all catch clause paths end in a throw"),防止返回未初始化对象。*

## 5. invoke 检查: 从后往前对签名

`verify_invoke_instructions`(verifier.cpp:2491 起)的规则(verifier.cpp:2600-2655,截取核心,逐字):

```cpp
// verifier.cpp:2600-2655(截取核心,逐字)
  if (opcode == Bytecodes::_invokedynamic) {
    address bcp = bcs->bcp();
    if (*(bcp+3) != 0 || *(bcp+4) != 0) {
      verify_error(ErrorContext::bad_code(bci),
          "Third and fourth operand bytes of invokedynamic must be zero");
      return;
    }
  }

  if (method_name->byte_at(0) == '<') {
    // Make sure <init> can only be invoked by invokespecial
    if (opcode != Bytecodes::_invokespecial ||
        method_name != vmSymbols::object_initializer_name()) {
      verify_error(ErrorContext::bad_code(bci),
          "Illegal call to internal method");
      return;
    }
  } else if (opcode == Bytecodes::_invokespecial
             && !is_same_or_direct_interface(current_class(), current_type(), ref_class_type)
             && !ref_class_type.equals(VerificationType::reference_type(
                  current_class()->super()->name()))) {
    ...
    if (!subtype) {
      verify_error(ErrorContext::bad_code(bci),
          "Bad invokespecial instruction: "
          "current class isn't assignable to reference class.");
       return;
    }
  }
  // Match method descriptor with operand stack
  for (int i = nargs - 1; i >= 0; i--) {  // Run backwards
    current_frame->pop_stack(sig_types[i], CHECK_VERIFY(this));
  }
```

四层检查: ①**invokedynamic 的 3/4 字节必须为 0**(保留字节被篡改直接拒);②**`<init>` 只能由 invokespecial 调用**,其他 invoke 调 `<init>` → "Illegal call to internal method";③**invokespecial 的类可赋值性**(当前类必须是目标类的子类,匿名类走 host 类特例,还有间接超接口检查);④**参数按签名从后往前逐个 pop 匹配**——栈顶顺序与 descriptor 参数顺序相反,签名类型依次弹出,`pop_stack(sig_types[i], ...)` 内部就是 §3 的可赋值性判定。返回类型由调用方在检查完参数后推入。

## 6. VerifyError 是怎么变成那条详细异常的

所有 `verify_error` 调用汇聚到同一处(verifier.cpp:1978 起,截取核心,逐字):

```cpp
// verifier.cpp:1978-1993(截取核心,逐字)
void ClassVerifier::verify_error(ErrorContext ctx, const char* msg, ...) {
  stringStream ss;

  ctx.reset_frames();
  _exception_type = vmSymbols::java_lang_VerifyError();
  _error_context = ctx;
  va_list va;
  va_start(va, msg);
  ss.vprint(msg, va);
  va_end(va);
  _message = ss.as_string();
```

验证失败不立即抛——**记录 `_exception_type`(VerifyError)+ `_error_context` + `_message`,由 `Verifier::verify` 在尾部统一 `THROW_MSG_` 抛出**(verifier.cpp:239;老验证器回退也在这里: 类版本 < 51 且 FailOverToOldVerifier 时先试 `inference_verify`,:184-192)。错误现场由 `TypeOrigin`/`ErrorContext`(verifier.hpp:97/:147)承载——出错位置、类型来源(栈上/局部变量/常量池/隐式),VM 把它渲染成实证里那种详细转储: `Location: Bad.add(II)I @0: aload_0`、`Reason: Type integer (current frame, locals[0]) is not assignable to reference type`、`Current Frame: bci/flags/locals/stack`、`Bytecode` 十六进制——**错误不是"验证失败"四个字,而是可定位到指令、槽位、类型的完整现场**。

## 核心悬念

验证引擎拆完了: VerificationType 的 union 编码(顶层类别 2 位 + 类别 1 字节 + 基本类型)、is_assignable_from 的判定树(null/同名/Object/数组递归/解析类层次)、Uninitialized 的一生(bci 标记 → <init> 全帧替换 + try 块约束)、invoke 四层检查、VerifyError 的 ErrorContext 现场。加上 07-02 的入口与帧匹配,验证器的完整图景已经成形。

但 §2 只开了个头: 查询类型、类别测试、数组组件、get_component 的解析、以及那套 `_data` 编码的完整位域——44 域最后一篇把 VerificationType 类型系统整个拆开。

> → [44-class-verification/02 — VerificationType 类型系统](02-verification-type.md)
