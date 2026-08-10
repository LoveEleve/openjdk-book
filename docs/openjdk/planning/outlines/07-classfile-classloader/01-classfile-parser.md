# 01. ClassFileParser — .class 二进制怎么变成 InstanceKlass？

> 🔴 Deep | 15 KP 中的 2 个核心机制
> 读者处境: 你写过 `javac Hello.java`——JVM 怎么把 Hello.class 的二进制变成可用的类？答案不是黑盒——是 6463 行的 parse 函数。

### 1. ClassFile 结构 — 四个魔数后的世界

场景: `ClassLoader::load_classfile("Hello.class")` → `os::read(fd, buf, len)` 读入 4KB → 前 4B 是 `0xCAFEBABE`。后面跟着版本号/常量池/访问标志/类名/父类/接口/字段/方法/属性——全部从二进制字节提取。

**ClassFileParser::parseClassFile** (`classFileParser.cpp:500-520` → 入口):
- 入口参数: `ClassFileStream* stream` + `Handle class_loader` + `Symbol* class_name` + `TRAPS`
- 验证顺序: magic(4B, `0xCAFEBABE`) → minor_version(2B) → major_version(2B) → cp_count(2B) → constant_pool[1..cp_count-1] → access_flags(2B) → this_class(2B) → super_class(2B) → interfaces_count(2B) → interfaces[0..count-1] → fields_count(2B) → fields[0..count-1] → methods_count(2B) → methods[0..count-1] → attributes_count(2B) → attributes[0..count-1]
- [JVM Spec: §4 The class File Format — 整个 ClassFile 的二进制格式定义。每个 section 的 tag/length/内容格式在此定义。magic=0xCAFEBABE 的历史: James Gosling 选了 "Cafe Babe"——加了 1 个 e 避免溢出为负数]
- [C++: ClassFileStream——包装 `(u1*)bytecode` 的 reader。`get_u1()` 读 1B; `get_u2()` 读 2B (big-endian→`Bytes::get_Java_u2()` 做字节交换——x86 是 little-endian); `get_u4()` 读 4B。越界检查: `_current + n <= _buffer_end`]
- 错误处理: 每个 `get_u*` 后检查 `need_verify()`——如果越界→ClassFormatError; 版本不兼容→UnsupportedClassVersionError
- 源码链: `classFileParser.cpp:700` magic→1200 cp→2800 fields→3500 methods→4800 attributes→5200 annotations→6000 `InstanceKlass::allocate_instance_klass()`

**常量池解析** (`classFileParser.cpp:1200-2000`):
- `parse_constant_pool(cp_count, CHECK)`: cp_count-1 个条目——每类不同长度:
  - CONSTANT_Utf8: `length(u2) + bytes[length]`——modified UTF-8——`\u0000` 编码为 `0xC0 0x80`
  - CONSTANT_Integer: `value(u4)`; CONSTANT_Long: `high(u4)+low(u4)`——占 2 cp entries
  - CONSTANT_String: `string_index(u2)`——指向 CONSTANT_Utf8
  - CONSTANT_Class: `name_index(u2)`——指向 CONSTANT_Utf8
  - CONSTANT_Methodref: `class_index(u2)+name_and_type_index(u2)`
- [C++: `parse_constant_pool_entries()`——循环 cp_count 次——`switch (tag)`——JVM Spec §4.4 定义每种 tag 格式。常量池 index 从 1 开始 (index=0 表示"无引用")——Long/Double 占 2 个 index——cp_count 是条目数不是 slot 数]
- [JVM Spec: §4.4 The Constant Pool — 14 种常量类型 (UTF8/Integer/Float/Long/Double/Class/String/Fieldref/Methodref/InterfaceMethodref/NameAndType/MethodHandle/MethodType/InvokeDynamic)]

### 2. 字段 + 方法 + 属性解析

**parse_fields** (`classFileParser.cpp:2800-3100`):
- fields_count→逐个 parse: `access_flags(u2) | name_index(u2) | descriptor_index(u2) | attributes_count(u2) | attributes[]`
- 填充: `FieldInfo` 数组→`InstanceKlass::set_fields(field_info, count)`
- [C++: field offset 计算——`FieldLayoutBuilder` 按对齐要求排字段——oop 在前 (GC 需要快速扫描)→long/double (8B 对齐)→int/float (4B)→short/char (2B)→byte/boolean (1B)。static field: offset=InstanceMirrorKlass 的 static field 区域偏移]
- [C++: field descriptor——`"Ljava/lang/String;"`=String 引用; `"J"`=long; `"[[I"`=int[][]。解析: `FieldType::basic_type()`→`T_OBJECT`/`T_LONG`/`T_INT`...]

**parse_methods** (`classFileParser.cpp:3500-4200`):
- methods_count→逐个: access_flags | name_index | descriptor_index | attributes[] (Code/Exceptions/Signature/RuntimeVisibleAnnotations/...)
- Code 属性: max_stack(u2) | max_locals(u2) | code_length(u4) | code[code_length] | exception_table_length/exception_table | attributes (LineNumberTable/LocalVariableTable/StackMapTable)
- [C++: `<clinit>` (static init) 和 `<init>` (constructor)——JVM 内部 method ordering 优先——`<clinit>` index 0, `<init>` index 1。method descriptor: `"(I)Ljava/lang/String;"`=参数 int→返回 String]

**attributes** (`classFileParser.cpp:4800-5500`):
- BootstrapMethods: invokedynamic 的 bootstrap 方法数组——存到 ConstantPool
- NestHost/NestMembers: JDK11 Nest-Based Access——`Outer$Inner` 访问 Outer 的 private
- [JVM Spec: §4.7 Attributes — 28 种标准属性 (Code/Exceptions/.../NestHost/NestMembers/Record)]

---

### 核心悬念

**"4 个魔数 `CAFEBABE` → ClassFileParser 6463 行 → InstanceKlass——JVM 最大的单个函数。"** — 从二进制字节 extract constant pool/fields/methods——每个 section 按 JVM Spec §4 的固定格式解析。解析后的 InstanceKlass 还不是可用的类——还要经过 Verifier (下一篇)。

> → [02-verifier-stackmap.md](02-verifier-stackmap.md)
