# 02. Verifier + StackMapTable — 字节码验证

> 🔴 Deep | 15 KP 中的 1 个核心机制
> 读者处境: ClassFileParser 解析完——但这个 .class 的字节码是真的正确还是恶意构造？Verifier 是最后一道防线。

### 1. Verifier — 四步验证

场景: 你从互联网下载了一个 .class——它的字节码把 String 当 int 传给了方法。JVM 必须拒绝——不是运行时抛 ClassCastException——是加载时就拒绝。

**Verifier::verify_class** (`verifier.cpp:100-400`):
- 四步: 1) Check Magic/Version→2) Check Constants→3) Bytecode Verification→4) StackMapTable Check
- [C++: partial verification——每条方法独立验证。`ClassVerifier::verify_class()`→遍历 methods→`verify_method(m)`→`verify_code(m)``。如果类 A 引用类 B——B 的验证推迟到 B 被加载时]
- [JVM Spec: §4.10 Verification of class Files — 字节码验证的完整规则。为什么需要验证？— javac 可能生成错误的字节码 (compiler bug)→恶意 .class 可以绕过 Java 安全模型]

**bytecode verification** (`verifier.cpp:500-1200`):
- 控制流分析: 从 method bytecode→建立 basic blocks (跳转目标/异常handler/return 为block边界)→数据流分析——模拟每条指令对操作栈+局部变量的影响→check 每点类型一致
- [C++: 操作栈模拟——从 BCI=0 开始——`OperationStack stack(max_stack)`——每个 slot 存 VerificationType。iload_1: push int→stack depth+1, type=int。aload_0: push ref→depth+2, types=int+ref。invokevirtual(String.length:()I): pop ref (receiver)→pop→check type match→push int(return)]
- [C++: 类型推导——merging来自不同路径的栈/局部变量类型——branch target——来自两个前驱的类型→取 `common_super_type(T1, T2)`——如果无共同父类→VerifyError]

### 2. StackMapTable — Java 6+ 的类型状态快照

**StackMapTable** (`stackMapTable.cpp:40-300` + `stackMapFrame.hpp:30-150`):
- Java 6+ 引入: .class 文件中 StackMapTable 属性预计算了每个分支点的正确类型状态——JVM 只 check 不 inference
- 旧验证 (Java 5-): inference-based——所有路径全遍历→O(2^n)。新验证 (Java 6+): check-based——逐帧 verify→O(n)
- [JVM Spec: §4.7.4 The StackMapTable Attribute — frame_type 编码: 0-63=same_frame; 64-127=same_locals_1_stack_item; 247=same_frame_extended; 248-250=chop_frame(移除 k 个局部变量); 251=same_frame_extended; 252-254=append_frame(增加 k 个); 255=full_frame(完整栈+局部变量描述)]
- [C++: `StackMapFrame`——每种 frame_type 有 `VerificationType` 数组描述栈和局部变量。`ITEM_Top`(unused slot)/`ITEM_Integer`/`ITEM_Float`/`ITEM_Long`(占 2 slots)/`ITEM_Double`(占 2 slots)/`ITEM_Null`/`ITEM_UninitializedThis`/`ITEM_Object(class_index)`/`ITEM_NewObject(offset)`]

---

### 核心悬念

**"StackMapTable 把验证从 O(2^n) 降为 O(n)。"** — 旧验证: 所有路径的类型组合→指数。新验证: javac 在 .class 中 pr-计算类型状态——JVM 逐帧 check——线性。Java 6 类加载因此快 2-3x。下一篇: Symbol + String——"java/lang/String" 怎么只存一次。

> → [03-symbol-string-table.md](03-symbol-string-table.md)
