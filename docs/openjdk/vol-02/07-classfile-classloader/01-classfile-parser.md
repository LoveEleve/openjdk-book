# 01. ClassFile 解析 — .class 字节怎么变成 InstanceKlass

> **前置依赖**:[06-oops/06 — Symbol 与注解](openjdk/vol-02/06-oops/06-symbol-annotations-aux.md):InstanceKlass 的字段表/方法表/Symbol 在这里是"从哪来的"问题的起点;[42-core-native/03 — ClassLoader + I/O + TimeZone](openjdk/vol-02/42-core-native/03-class-io.md):defineClass1 把字节交给 VM 的入口
> → **后续**:[02 — Verifier + StackMapTable](02-verifier-stackmap.md)
> 关联域: 06-oops(对象模型/常量池)、11-cds(共享归档绕开解析)、27-jni

## 从字节到元数据

`javac Hello.java` 产出一个 1090 字节的 Hello.class——前 4 字节 `cafe babe`,之后是版本号、常量池、字段、方法、属性,全部按 JVM 规范 §4 的固定格式排列。JVM 解析这个文件的地方是 `classFileParser.cpp`(6463 行,share/classfile/),而驱动它的是 `ClassFileParser` 这个"读字节机器"。这一篇跟着一次类定义走完解析全程: 入口链、常量池、字段/方法/属性,以及 InstanceKlass 怎么从 parser 里"出生"。

## 1. 入口与总流程: 构造函数里把文件读完

### 从 defineClass 到 parse_stream

42 域的 `JVM_DefineClassWithSource` 把字节交给 VM 后,真正干活的是 `KlassFactory::create_from_stream`(klassFactory.cpp:166-226): 先过 **JVMTI ClassFileLoadHook**(host_klass 为空时,klassFactory.cpp:184-188——代理可以改写类字节),然后构造 `ClassFileParser`,再调 `create_instance_klass`。**解析发生在构造函数里**(classFileParser.cpp:5995-5997,截取核心,逐字):

```cpp
// classFileParser.cpp:5995-5997(截取核心,逐字)
  parse_stream(stream, CHECK);

  post_process_parsed_stream(stream, _cp, CHECK);
```

`parse_stream`(classFileParser.cpp:6074-6308)是解析主干,顺序与类文件格式逐节对应: magic → 版本 → 常量池 → access_flags → this_class → super_class → interfaces → fields → methods → 类级属性 → 收尾检查(截取核心,逐字):

```cpp
// classFileParser.cpp:6081-6093(截取核心,逐字)
  stream->guarantee_more(8, CHECK);  // magic, major, minor
  // Magic value
  const u4 magic = stream->get_u4_fast();
  guarantee_property(magic == JAVA_CLASSFILE_MAGIC,
                     "Incompatible magic value %u in class file %s",
                     magic, CHECK);

  // Version numbers
  _minor_version = stream->get_u2_fast();
  _major_version = stream->get_u2_fast();
```

- **magic**: `JAVA_CLASSFILE_MAGIC = 0xCAFEBABE`(classFileParser.cpp:93)。它不携带任何信息,是"身份检查"——读 4 字节,不对就直接 `Incompatible magic value %u`;[实证] 里 Hello.class 的头 8 字节 `cafe babe 0000 003d`(materials/commands/07-classfile-header-load.txt): 003d = 61 = JDK 17 的 class 文件版本;
- **版本**: `verify_class_version`(:4881-4930)放行 `45.*`(Java 1.1 起的怪胎兼容),拒绝 preview 特性版本(需要 `--enable-preview`)、拒绝比当前 JVM 更新的 major(`UnsupportedClassVersionError: compiled by a more recent version of the Java Runtime`)、拒绝 `45` 以下的旧版本;
- **读取原语**: 全部经 `ClassFileStream`(classFileStream.hpp)——`get_u2_fast`/`get_u4_fast` 调 `Bytes::get_Java_u2/u4`(classFileStream.hpp:101-112)做**大端读取**(class 文件是 big-endian,x86 上自动字节交换);带 `_fast` 后缀的版本不做越界检查,由调用方先 `guarantee_more(n)` 声明"我要读 n 字节"(classFileStream.hpp:88-91);文件读完 `at_eos` 必须是真——多出任何字节都是 `Extra bytes at the end of class file`(:6314-6316)。

**关键设计 (斜体)**: *"读 2 字节→校验→读 2 字节→校验"的节奏贯穿整个 parse_stream: 每个 section 开头先 guarantee_more 声明边界,读到的东西立刻校验(索引合法性/修饰符合法性/名字合法性),错误就地抛 ClassFormatError。`_fast` 读取器与 guarantee_more 的配合,让 6463 行代码里几乎不需要重复的越界检查。*

### 一个常被忽略的前提: 解析器不是唯一来源

[实证] 的类加载日志里有个细节(materials/commands/07-classfile-header-load.txt):

```
[0.013s][info][class,load] java.lang.Object source: shared objects file
[0.022s][info][class,load] Hello source: file:/data/tmp/opencode/cf/
```

平台类从 **CDS 共享归档**(`shared objects file`)直接恢复,只有应用类走 `file:/...` 的完整解析。ClassFileParser 是"从字节造类"的路径,而 CDS 归档在构建期跑过一次解析、运行时把结果直接搬进内存(11-cds 域的领土)。同一个 InstanceKlass,两条来源——解析器是"慢路径",归档是"快路径"。

## 2. 常量池: 15 种 tag 的 switch

### 条目解析: 一个 tag 一个 case

`parse_constant_pool_entries`(classFileParser.cpp:126-403)把常量池从字节变成 ConstantPool 的槽位。开头有个小技巧(:138): **把 ClassFileStream 按值拷贝一份局部副本**(`const ClassFileStream cfs1 = *stream;`,让 `_current` 能进寄存器),注释说得很直白(:133-137,原文 "It helps the C++ compiler to optimize this function")。然后 `for (index = 1; index < length; index++)` 从 1 开始——**槽 0 保留**(:151 注释 "Index 0 is unused"),每个条目按 tag 分发:

- **引用型**: `Class`→`klass_index_at_put`、`Fieldref`/`Methodref`/`InterfaceMethodref`→class_index+name_and_type_index 两个 u2、`String`→string_index、`NameAndType`→name+signature。规范的 17 种标签里还剩 `Module`/`Package` 两种,**不经过这个 switch**——它们只被 Module 属性引用,而 module-info 类根本不走标准解析: ACC_MODULE 在 `verify_legal_class_modifiers` 里直接抛 `NoClassDefFoundError: not a class because access_flag ACC_MODULE is set`(:4828-4838);
- **数字型**: `Integer`/`Float` 各 4 字节,`Long`/`Double` 各 8 字节且**占两个槽位**(:260-264,截取核心,逐字):

```cpp
// classFileParser.cpp:256-265(截取核心,逐字)
      case JVM_CONSTANT_Long: {
        // A mangled type might cause you to overrun allocated memory
        guarantee_property(index + 1 < length,
                           "Invalid constant pool entry %u in class file %s",
                           index,
                           CHECK);
        cfs->guarantee_more(9, CHECK);  // bytes, tag/access_flags
        const u8 bytes = cfs->get_u8_fast();
        cp->long_at_put(index, bytes);
        index++;   // Skip entry following eigth-byte constant, see JVM book p. 98
```

- **版本门槛**: `MethodHandle`/`MethodType`/`InvokeDynamic` 要求 class 文件版本 ≥ 51(Java 7,`Verifier::INVOKEDYNAMIC_MAJOR_VERSION`),`Dynamic`(condy)要求 ≥ 55(Java 11)——旧版本文件里出现新 tag 直接 parse_error;
- **Utf8 不走普通路径**: 读长度+字节后,先 `verify_legal_utf8`(:298-301)验格式,然后**查 SymbolTable**(:310-316,截取核心,逐字):

```cpp
// classFileParser.cpp:313-319(截取核心,逐字)
        unsigned int hash;
        Symbol* const result = SymbolTable::lookup_only((const char*)utf8_buffer,
                                                        utf8_length,
                                                        hash);
        if (result == NULL) {
          names[names_count] = (const char*)utf8_buffer;
```

没命中就攒进 `names[]` 批处理数组,攒满 `SymbolTable::symbol_alloc_batch_size` 个一次性 `new_symbols`(:323-329)——**字符串去重在这里就开始了**(06-06 的 SymbolTable 与 refcount 直接服务于此)。这是常量池解析里唯一一次"查表"——常量池里的名字当场变成 Symbol 指针。

### 第一遍交叉引用: 只登记,不解析

条目读完还有**第一遍校验**(`parse_constant_pool`,classFileParser.cpp:406-500): 逐槽检查引用型条目的目标是否合法(Fieldref 的 klass 索引必须在界内且是 Class 类、NameAndType 的 name/signature 必须是 Symbol),并把 `ClassIndex`/`StringIndex` 换成**未解析形式**——`unresolved_klass_at_put`(:490,槽里放进名字 Symbol 和一个序号)、`unresolved_string_at_put`(:499)。注意: **这里不解析任何东西**——类引用、方法引用都只是"登记在案",等字节码执行到 `new`/`invokevirtual` 时才真正解析(06-04 的常量池解析主题)。[实证] 的 javap 输出能看到登记后的样子(materials/commands/07-classfile-javap.txt):

```
   #1 = Methodref          #2.#3          // java/lang/Object."<init>":()V
   #2 = Class              #4             // java/lang/Object
   #3 = NameAndType        #5:#6          // "<init>":()V
```

**关键设计 (斜体)**: *常量池解析分两阶段: 加载期"登记"(字节→槽位,全部就地校验),运行期"解析"(槽位→直接指针,逐条目按需)。两阶段分离让"加载一个类"的成本与"用到一个类"的成本解耦——只加载不使用的类,没碰过的 Methodref 永远停留在未解析状态。*

## 3. 字段、方法与 InstanceKlass 的诞生

### parse_fields: 字段变成 FieldInfo,并按类型分桶

`parse_fields`(classFileParser.cpp:1541 起)读每个字段的四元组(access_flags/name_index/signature_index/attributes_count),逐项校验(修饰符/名字/签名合法性,:1601/:1609/:1616),属性交给 `parse_field_attributes`(ConstantValue、synthetic、泛型签名、注解,:1295 起,调用在 :1626)。每个字段最终填进 `FieldInfo`(六槽: access/name/sig/constantvalue + 32 位 offset 分高低两槽,共 12 字节——06-03 讲过字段表布局),并做一件关键的事(:1673-1677,截取核心,逐字):

```cpp
// classFileParser.cpp:1673-1677(截取核心,逐字)
    const BasicType type = cp->basic_type_for_signature_at(signature_index);

    // Remember how many oops we encountered and compute allocation type
    const FieldAllocationType atype = fac->update(is_static, type);
    field->set_allocation_type(atype);
```

`fac->update` 按字段类型把字段分进**五类分配桶**(oop、byte/boolean/char、short、int、long/double,static 与 nonstatic 各一套,`FieldAllocationType`,classFileParser.cpp:1453-1466)——**这就是 06-03 字段布局的输入**: 后续 `layout_fields`(classFileParser.cpp:3934,:6411 调用)按桶排偏移,顺序由 `FieldsAllocationStyle` 标志决定(globals.hpp:940,默认 1): **默认是 longs/doubles、ints、shorts/chars、bytes、最后 oops 加填充**(注释 classFileParser.cpp:4072)——oop 字段排最后,只有 `FieldsAllocationStyle=0` 才是 oops 在前(注释 :4067),而少数硬编码偏移的核心类(java.lang.Class/ClassLoader/Reference 等)固定走 style 0(:4038-4043);static 字段的偏移另算(`fac->count[STATIC_*]` 汇总成 static_field_size,:3966-3975),实际落在 InstanceMirrorKlass 的静态区。注意资料里流传的 "FieldLayoutBuilder" 在 jdk11u 里并不存在——布局就在 `ClassFileParser::layout_fields` 里。parse_fields 还会追加 **injected fields**(:1563-1566,`JavaClasses::get_injected`——JVM 内部注入的隐藏字段,如 `java.lang.Class` 的 klass 指针,Java 层看不到)。

### parse_methods: Code 属性的读取

`parse_methods`(classFileParser.cpp:2959)按方法数预分配 `Array<Method*>`,逐个 `parse_method`(:2344 起)。方法名的两个特殊成员在这里被盯死: `<clinit>` 只允许 static——class 文件版本 51 起必须显式 static,45.x 老版本自动补 static(classFileParser.cpp:2366-2379,否则 `classfile_parse_error("Method <clinit> is not static")`)、接口不能有 `<init>`(:2381-2383)。每个方法的属性逐个检查,`Code` 是重头戏(:2467-2472,截取核心,逐字):

```cpp
// classFileParser.cpp:2467-2478(截取核心,逐字)
    if (method_attribute_name == vmSymbols::tag_code()) {
      // Parse Code attribute
      if (_need_verify) {
        guarantee_property(
            !access_flags.is_native() && !access_flags.is_abstract(),
                        "Code attribute in native or abstract methods in class file %s",
                         CHECK_NULL);
      }
      if (parsed_code_attribute) {
        classfile_parse_error("Multiple Code attributes in class file %s",
                              CHECK_NULL);
      }
```

- native/abstract 方法不允许带 Code,一个方法不允许两个 Code(都是格式错误);
- 然后读 max_stack/max_locals/code_length——**45.2 以下的老版本用 1+1+2 字节,新版本 2+2+4**(:2483-2492)——之后 code 字节直接取指针跳过(:2502,`code_start = cfs->current()` 不拷贝!);
- exception_table、以及 Code 内嵌属性(LineNumberTable/LocalVariableTable/StackMapTable——StackMapTable 的原始字节留着给 Verifier,下一篇)。

### 类级属性与 InstanceKlass 的诞生

`parse_classfile_attributes`(classFileParser.cpp:3440 起)处理类级属性: SourceFile/SourceDebugExtension/InnerClasses/Synthetic/Signature/EnclosingMethod/RuntimeVisibleAnnotations…,其中两个值得注意——**BootstrapMethods**(:3596,invokedynamic 的引导方法表,Java 7 引入)与 Java 11 的新面孔 **NestHost/NestMembers**(:3640/:3627,嵌套类访问控制)。[实证] 里 javac 17 把字符串拼接编译成 `InvokeDynamic` + BootstrapMethods(StringConcatFactory.makeConcatWithConstants,materials/commands/07-classfile-javap.txt)——拼接的"怎么拼"不在字节码里,而在引导方法的参数里。

解析收尾分两步: `post_process_parsed_stream`(:6321 起)算**传递接口**(`compute_transitive_interfaces`,:6378)、算 **itable 大小**(`klassItable::compute_itable_size`,:6405——06-02 的 itable 在这里被预定)、`layout_fields`(:6411)定字段偏移;然后 `create_instance_klass` → `InstanceKlass::allocate_instance_klass`(:5572)分配对象,`fill_instance_klass`(:5598)填内容(:5609-5612,截取核心,逐字):

```cpp
// classFileParser.cpp:5609-5612(截取核心,逐字)
  _loader_data->add_class(ik, publicize);

  set_klass_to_deallocate(ik);
```

`add_class` 把新 InstanceKlass 挂到 ClassLoaderData 的类链表上(06-03 的 CLD 仓库),`apply_parsed_class_metadata`(:5632)把常量池/字段表/方法表/内部类表**从 parser 移交**给 InstanceKlass——从这一刻起 parser 手上什么都没有了(断言 :5635 起逐一验证 NULL)。parser 是栈上临时对象,失败时析构函数负责把已分配的元数据全部回收(:6015 起),成功时它只剩一个空壳。

**关键设计 (斜体)**: *"所有权转移"是这次解析的收尾仪式: 解析器全程是临时对象,它分配的所有元数据(ConstantPool/fields/methods/annotations)要么成功移交给 InstanceKlass,要么在析构时按清单回收——失败路径不需要 InstanceKlass 知道任何清理细节。6463 行的复杂度被收敛在"要么全给我、要么全销毁"的边界里。*

## 核心悬念

一次类定义的全程到齐: KlassFactory 过 JVMTI hook → ClassFileParser 构造函数里 parse_stream 按格式逐节读(magic/版本/常量池/字段/方法/属性)→ 常量池条目全部"登记不解析"、名字当场查 SymbolTable 去重 → 字段按类型分桶、方法读 Code 属性 → fill_instance_klass 把所有权移交给 InstanceKlass 并挂上 CLD。但这还不是一个"可用"的类: 字节码本身还没被检查过——保留操作码 `0xcb`(breakpoint)这样的字节序列也会被解析成功。下一篇: Verifier 与 StackMapTable——加载的最后一道关。

> → [02 — Verifier + StackMapTable](02-verifier-stackmap.md)
