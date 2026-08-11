# 02. VerificationType — 类型 lattice + 兼容性判断

> 🟡 Working | 9种验证类型(Top/Integer/Float/.../Object/Uninitialized)
> 读者处境: StackMapTable 中每个 slot 有一个 `VerificationType`——Top/Integer/Float/Long/Double/Null/UninitializedThis/Object/Uninitialized。verifier 检查 `current_type.is_assignable_from(expected_type)` → 类型兼容→通过; 不兼容→VerifyError。

### 1. "9 种验证类型 — ITEM_* 枚举"

场景: bytecode `iconst_0`→push ITEM_Integer on stack。`aconst_null`→push ITEM_Null。`new Object()`→push ITEM_Uninitialized→`invokespecial <init>`→change to ITEM_Object(Reference to Object)。

**9种类型** (`verificationType.hpp:35-47`):
```
ITEM_Top              = 0 — unused slot (栈底部/未初始化的局部变量)
ITEM_Integer          = 1 — int/boolean/byte/char/short (JVM spec 全部映射到 int)
ITEM_Float            = 2 — float
ITEM_Double           = 3 — double (占 2 slots: slot N=Double, slot N+1=Top)
ITEM_Long             = 4 — long (占 2 slots)
ITEM_Null             = 5 — null (可赋值给任何 Reference 类型)
ITEM_UninitializedThis = 6 — this before <init> 调用(构造器前)
ITEM_Object           = 7 — 具体引用类型(Object, String, MyClass...)
ITEM_Uninitialized    = 8 — new 分配但未调用 <init>(构造器前)
ITEM_Bogus            = (uint)-1 — 无效类型(sentinel)
[C++: verificationType.hpp:35-47——9+1种类型对应 JVM Spec §4.10.1]
```
- 源码: `verificationType.hpp:35-47` (ITEM_* enum) + `verificationType.cpp:33-50` (VerificationType::from_tag)

- 关键设计: **Top vs Bogus** — Top=未使用 slot(Long/Double 的第二个 slot), Bogus=错误/未初始化的 sentinel——两者不同但都被视作"不参与类型检查"。**UninitializedThis→Object 转换** — 构造器 `<init>` 调用后→verifier 将当前帧中所有 UninitializedThis 替换为当前 class 的 Object 类型→之后可正常使用 this。

### 2. "类型兼容性 — is_assignable_from"

场景: `astore_1`(store Reference to local var 1)→local var 1 当前类型=my.package.MyClass→astore 栈顶=java.lang.Object→is_assignable_from(Object, MyClass)→true(supertype)。如果栈顶=Integer→false→VerifyError。

**类型兼容检查** (`verificationType.hpp:267-320`):
```
is_assignable_from(from, context, from_field_is_protected, CHECK):
  actual == Top? → true (Top is compatible with everything)
  actual == Bogus? → false

  expected == actual category? → check via class hierarchy:
    Integer == Integer? → true
    Object expected, actual Object? → resolved_class(expected).is_subclass_of(actual)
    Null → true (Null assignable to any Reference)
    Uninitialized → 只能赋值给 Uninitialized(同一条 new 指令, bci 必须相同)
    UninitializedThis → 只能用于自身 class 的 <init> 中
[C++: verificationType.hpp:267——is_assignable_from 是 inline 方法(header-only)——用于 StackMapFrame 的每 slot 类型比对(stackMapFrame.cpp:151)]
```
- 源码: `verificationType.hpp:267-300` (is_assignable_from inline) + `stackMapFrame.cpp:151` (调用点——逐 slot 比对 from→to types) + `verificationType.cpp:33-50` (from_tag → VerificationType)<

- 关键设计: **Null 的灵活性** — null 可赋值给任何 Object 类型→`aconst_null; astore_1`→无论 local var 1 原类型→Null 兼容。**Uninitialized 的限制** — `new Foo; astore_1; aload_1; invokevirtual bar()`→VerifyError——因为 `<init>` 未调用→对象处于 uninitialized 状态→不能 invokevirtual。

---

### 核心悬念

**"VerificationType: 9种类型(Top/Integer/Float/Long/Double/Null/UninitializedThis/Object/Uninitialized)→from_tag 转换→is_assignable_from 逐 slot 类型检查→类型不兼容→VerifyError。Top=unused slot, Null=any Reference, Uninitialized=构造器前不可用。"** — 下一篇: 域45 Math Library。

> → 域45 Math Library
