# 02. 验证器的类型宇宙 — VerificationType 类型系统

> **前置依赖**:[44-class-verification/01 — ClassVerifier 类型检查引擎](01-verifier.md):union 编码与 is_assignable_from 判定树已拆,本篇补上类型系统的另一半——文件格式与内部实现的映射;[07-classfile-classloader/02 — Verifier 与 StackMapTable](openjdk/vol-02/07-classfile-classloader/02-verifier-stackmap.md):StackMapTable 的文件格式是输入的来源
> → **后续**:[11-cds/01 — 序列化 1000+ 核心类到 archive](openjdk/vol-02/11-cds/01-cds-overview-dump.md):第 4 批收官,第 5 批从 CDS 开始(大纲的"下一域 45 Math"是错的——45 域早已在第 1 批完结)
> 关联域: 07-classfile(StackMapTable)、44-01(验证引擎)、06-oops(Symbol)、13-jit(验证结果消费)

## 文件里的 9 个 tag,内存里的 16 个类型

StackMapTable 文件里只有 9 种验证类型 tag(ITEM_Top..Uninitialized),但验证器内存里的 `VerificationType` 远不止这些: 扩展的 Boolean/Byte/Short/Char、双槽的 `Long_2nd`/`Double_2nd`、以及那个神秘的 `Bogus`。这一篇拆两个世界的映射: 文件 tag 怎么变成内部类型、`Top` 在实现里到底是什么、双槽的次槽怎么跟踪、以及 `is_assignable_from` 面对这些类型时的完整语义。

[实证:] 带 long 局部变量的方法,StackMapTable 的 append 帧原始字节是 `fd 00 05 04 04 04`(LongVar.class): `fd`=append、`00 05`=偏移差、**`04`=number_of_locals(4 个槽)**、`04 04`=两个 ITEM_Long 类型项——槽数是类型项数的两倍,正是 long 的双槽(次槽在文件里**不写类型项**,隐式 Top;javap 显示 `locals = [ long, long ]`,08-verificationtype-javap.txt)。而验证器解析时把 4 个槽展开成 Long/Long_2nd/Long/Long_2nd——文件与内存的差异就在这一篇的 §2。

## 1. 两个世界: 文件的 9 个 tag,内部的扩展类型

### 文件 tag: 9 种(verificationType.hpp:36-46)

```cpp
// verificationType.hpp:35-46(截取核心,逐字)
  // As specifed in the JVM spec
  ITEM_Top = 0,
  ITEM_Integer = 1,
  ITEM_Float = 2,
  ITEM_Double = 3,
  ITEM_Long = 4,
  ITEM_Null = 5,
  ITEM_UninitializedThis = 6,
  ITEM_Object = 7,
  ITEM_Uninitialized = 8,
  ITEM_Bogus = (uint)-1
```

这是 StackMapTable 里每个类型项的第一个字节(规范 §4.10.1)。其中 **ITEM_Object 带常量池索引、ITEM_Uninitialized 带 new 指令偏移**(07-02 拆过 parse_verification_type)。

### 内部类型: 扩展集合

验证器内存里还有文件里不存在的类型(verificationType.hpp:60-68,截取核心,逐字):

```cpp
// verificationType.hpp:60-68(截取核心,逐字)
    enum {
      // These rest are not found in classfiles, but used by the verifier
      ITEM_Boolean = 9, ITEM_Byte, ITEM_Short, ITEM_Char,
      ITEM_Long_2nd, ITEM_Double_2nd
    };
```

- **Boolean/Byte/Short/Char**: **方法签名转类型时使用**(change_sig_to_verification_type,stackMapFrame.cpp:115-118)——签名里的 `B`/`C`/`S`/`Z` 参数/返回类型映射成精确类型而非一律 int;注意 `i2b`/`i2c`/`i2s` 等转换指令的模拟推的是 integer_type(verifier.cpp:1481-1488),窄化类型只来自签名;
- **Long_2nd/Double_2nd**: 双槽值的次槽(下一节);
- **Bogus**: `(uint)-1`,文件里没有的哨兵(错误/未知的占位)。

**关键设计 (斜体)**: *文件格式是"对外契约"(最小 tag 集),内部类型是"工作状态"(更多精度)。契约不能破坏,精度可以加——加的类型全部在验证器内部,永远不出现在文件里。*

## 2. Top 与 Bogus: 实现里是同一个东西

大纲常写 "Top=未使用 slot, Bogus=错误 sentinel,两者不同"——**在 HotSpot 实现里这是错的**: `top_type()` 就是 `bogus_type()` 的别名(verificationType.hpp:130-131,截取核心,逐字):

```cpp
// verificationType.hpp:130-131(截取核心,逐字)
  static VerificationType bogus_type() { return VerificationType(Bogus); }
  static VerificationType top_type() { return bogus_type(); } // alias
```

而文件里的 ITEM_Top 经 `from_tag` 也直接变成 bogus(verificationType.cpp:33-45,截取核心,逐字):

```cpp
// verificationType.cpp:33-45(截取核心,逐字)
VerificationType VerificationType::from_tag(u1 tag) {
  switch (tag) {
    case ITEM_Top:     return bogus_type();
    case ITEM_Integer: return integer_type();
    case ITEM_Float:   return float_type();
    case ITEM_Double:  return double_type();
    case ITEM_Long:    return long_type();
    case ITEM_Null:    return null_type();
    default:
      ShouldNotReachHere();
      return bogus_type();
  }
}
```

**三个入口(文件 tag 0、top_type() 工厂、bogus_type() 工厂)都落到同一个 Bogus 编码**。Bogus 在 `is_assignable_from` 里是"自己放行"的(44-01 的 `equals(from) || is_bogus()`——**目标是 bogus 时任何源都通过**): 未初始化槽、未知槽、双槽错位等"不该参与检查"的场景,都用 bogus 表示"我不确定/我不参与"。大纲的"Top 与 Bogus 不同"是概念层区分,实现层已经合并——写作时以代码为准。

## 3. 双槽的次槽: 文件 Top,内存 2_2nd

规范里 long/double 占两个槽,次槽在文件里写 ITEM_Top。但验证器把次槽转成**显式的 2_2nd 类型**: StackMapTable 解析时,每遇到 Long/Double 就在下一槽写 `to_category2_2nd()`(stackMapTable.cpp:300-307,截取核心,逐字):

```cpp
// stackMapTable.cpp:300-307(截取核心,逐字)
    VerificationType* stack = NEW_RESOURCE_ARRAY_IN_THREAD(
      THREAD, VerificationType, 2);
    u2 stack_size = 1;
    stack[0] = parse_verification_type(NULL, CHECK_VERIFY_(_verifier, NULL));
    if (stack[0].is_category2()) {
      stack[1] = stack[0].to_category2_2nd();
      stack_size = 2;
    }
```

`to_category2_2nd()`(verificationType.hpp:235-238): Long → Long_2nd、Double → Double_2nd(下一槽的 `stack[1]` 与 `stack_size = 2` 同时把栈深按双槽记)。于是内存帧里双槽是**两个可区分的类型**:

| 槽 | 文件 | 内存 |
|---|---|---|
| 首槽 | ITEM_Long/Double | Long/Double(Category2) |
| 次槽 | ITEM_Top(规范) | Long_2nd/Double_2nd(Category2_2nd) |

**关键设计 (斜体)**: *为什么内存里要显式类型而不用 Top?因为验证器要防止"次槽被当独立值用": `pop_stack(Category2Query)` 弹出首槽后,次槽必须跟着消失;若次槽是 bogus/Top,`get_local` 可能把次槽当成"未使用"而放行错误代码。显式 2_2nd 让"双槽的完整性"成为可检查的约束——`is_category2_2nd` 一测便知。*

## 4. 类型工厂与类别测试

### 工厂: 每个内部类型一个静态构造

内部类型通过静态工厂取(verificationType.hpp:130-139,截取核心,逐字):

```cpp
// verificationType.hpp:130-139(截取核心,逐字)
  static VerificationType bogus_type() { return VerificationType(Bogus); }
  static VerificationType top_type() { return bogus_type(); } // alias
  static VerificationType null_type() { return VerificationType(Null); }
  static VerificationType integer_type() { return VerificationType(Integer); }
  static VerificationType float_type() { return VerificationType(Float); }
  static VerificationType long_type() { return VerificationType(Long); }
  static VerificationType long2_type() { return VerificationType(Long_2nd); }
  static VerificationType double_type() { return VerificationType(Double); }
  static VerificationType boolean_type() { return VerificationType(Boolean); }
  static VerificationType byte_type() { return VerificationType(Byte); }
```

由于 `_data` 编码,每个基本类型就是**一个常量值**(如 Integer = `(ITEM_Integer << 16) | Category1`),工厂只是带名字的构造——模拟器里 `integer_type()` 满天飞,零分配。引用类型走 `reference_type(Symbol*)`(存指针),Uninitialized 走 `uninitialized_type(bci)`(44-01 已拆)。

### 类别测试: 栈深检查的依赖

`is_category1()/is_category2()/is_category2_2nd()`(verificationType.hpp:187-200)按 `_data` 的类别段位测试。它们支撑两类使用: ①`pop_stack(Category1Query)` 这类查询通配(44-01);②**双槽完整性**——`pop_stack` 的实现只弹一个槽(`_stack[--_stack_size]`,stackMapFrame.cpp:199),category2 首槽弹出后**次槽自然落到 `_stack_size` 之外**,成为不可见残留(下一条指令从新位置开始,残留被覆盖);想直接读次槽的操作(get_local/pop_stack 期望 2_2nd)会因类型不匹配失败——"双槽不可拆分"靠类型约束,不靠显式扣槽。

## 5. is_assignable_from 面对全部类型

44-01 拆过判定树主结构,本篇补三个边角(都在 verificationType.hpp:267-298):

- **Bogus 作为目标**: `equals(from) || is_bogus()` → 直接 true——"目标未知,不拦"(未初始化槽的放行语义);
- **Uninitialized 对 Uninitialized**: 没有专门分支——靠 **equals**(同一 new 指令的 bci 编码相同才相等);不同 new 的未初始化对象互不兼容;
- **Uninitialized 对引用**: ReferenceQuery 分支里 `from.is_reference() || from.is_uninitialized()`——未初始化对象可以出现在"要引用"的位置(它终究会成为引用),但普通 is_assignable_from(引用目标, uninitialized 源)会走到 default → false(未初始化对象不能赋给字段/方法参数——44-01 的"毕业"之前不算数)。

## 核心悬念

类型系统拆完了: 文件 9 个 tag ↔ 内部 16 个类型(Top 与 Bogus 实现合一、Boolean/Byte/Short/Char 精度扩展、Long_2nd/Double_2nd 双槽显式化)、from_tag 与工厂、类别测试与栈深、is_assignable_from 的边角语义。加上 44-01 的判定树与 07-02 的文件格式,验证器从字节到类型的完整旅程结束——**第 4 批(执行/帧)至此收官**。

下一站换赛道: 从"运行时怎么执行/验证字节码"转到"启动时怎么加速"——CDS(Class Data Sharing)把 1000+ 核心类序列化进归档文件,JVM 启动时直接映射而非重新解析。第 5 批(VM 核心)从这里开始。

> → [11-cds/01 — 序列化 1000+ 核心类到 archive](openjdk/vol-02/11-cds/01-cds-overview-dump.md)
