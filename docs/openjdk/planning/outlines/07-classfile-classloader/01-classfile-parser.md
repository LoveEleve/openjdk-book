# 01. ClassFileParser — .class 二进制怎么变成 InstanceKlass？

> 🔴 Deep | 15 KP 中的 2 个核心机制
> 读者处境: 你写过 `javac Hello.java`——JVM 怎么把 Hello.class 的二进制变成可用的类？答案不是黑盒——是 6463 行的 parse 函数。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/07-classfile-classloader/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 169 行,第 3 批第一篇,06 域悬念桥接指向):
> - **parseClassFile 函数不存在**(编造): 实际入口链=KlassFactory::create_from_stream(klassFactory.cpp:166-226,先过 JVMTI ClassFileLoadHook :184-188)→ClassFileParser 构造(:5879,内部 parse_stream :5995-5997+post_process_parsed_stream)→create_instance_klass;**解析在构造函数里完成**;parse_stream :6074-6308 是主干
> - **"源码链"行号全漂移**: magic 校验 :6084(非 :700)/常量池 parse_constant_pool :406、调用 :6125(非 :1200)/字段 parse_fields :1541(非 :2800)/方法 parse_methods :2959(非 :3500)/属性 parse_classfile_attributes :3440(非 :4800)/**无 parse_annotations 函数**(注解收集在属性解析里,create_combined_annotations 合并)/allocate_instance_klass :5572(非 :6000)
> - **FieldLayoutBuilder 编造**(不存在): 实际字段布局在 ClassFileParser::layout_fields(classFileParser.cpp:3934,:6411 调用);06-03 已讲字段布局,07-01 只引用不再展开
> - **FieldAllocationType 五类桶**: oop/byte(boolean,byte,char)/short/word(int)/double(对齐 long/double),static+nonstatic 各一套(classFileParser.cpp:1453-1466,fac->update :1676)——"六桶"是错的
> - **常量池 tag 数**: parse_constant_pool_entries(:126)switch 处理 **15 种 tag**(Class/Fieldref/Methodref/InterfaceMethodref/String/MethodHandle/MethodType/Dynamic/InvokeDynamic/Integer/Float/Long/Double/NameAndType/Utf8);规范 17 种里的 Module/Package **jdk11u 无 JVM_CONSTANT_Module**(不经过此 switch);Long/Double 双槽 :256-266(index++ "see JVM book p. 98");Utf8→verify_legal_utf8 :298-301+**SymbolTable 批量分配**(lookup_only :314+new_symbols :323-329,06-06 的 SymbolTable 直接服务于此);版本门槛 MethodHandle/MethodType/InvokeDynamic≥51、Dynamic≥55(verifier.hpp:40-42)
> - **第一遍交叉引用**: parse_constant_pool :406 起逐槽校验(Fieldref 的 klass/name_and_type 合法 :446-455),ClassIndex→unresolved_klass_at_put :490、StringIndex→unresolved_string_at_put :499——**只登记不解析**(06-04 运行期解析主题)
> - **parse_fields**(:1541 起): FieldInfo **六槽**(fieldInfo.hpp:69 field_slots=6: access/name/sig/constantvalue+offset 32 位高低两槽=12 字节);injected fields=JavaClasses::get_injected(:1575-1578,CLASS_INJECTED_FIELDS javaClasses.hpp:1562+: java.lang.Class 的 klass/array_klass/oop_size 等,JVM 隐藏字段);字段属性 parse_field_attributes :1295(ConstantValue/synthetic/泛型签名/注解)
> - **parse_method**(:2344): <clinit> 51 起必须显式 static(45.x 自动补,:2366-2379,否则 "Method <clinit> is not static")、接口禁 <init>(:2381-2383);Code 属性 :2467 起(native/abstract 禁 Code、双 Code 报错;max_stack/max_locals/code_length 45.2 兼容 1+1+2 :2485-2492;code_start=cfs->current() **不拷贝** :2502);StackMapTable 原始字节留 Verifier(parse_stackmap_table,下一篇)
> - **类级属性**: parse_classfile_attributes :3440;SourceFile/InnerClasses/Synthetic/Signature/EnclosingMethod/注解;BootstrapMethods :3596(Java 7)/NestMembers :3627/NestHost :3640(JDK 11)
> - **post_process_parsed_stream**(:6310 起): 传递接口 compute_transitive_interfaces :6378、vtable 大小 :6394(klassVtable::compute_vtable_size_and_num_mirandas,06-02)、itable 大小 :6405、layout_fields :6411
> - **fill_instance_klass**(:5598): _loader_data->add_class(ik) 挂 CLD :5609;apply_parsed_class_metadata :5632 把 cp/fields/methods 从 parser **所有权转移**给 InstanceKlass(断言 :5635 起全 NULL);析构 :6015 负责失败回收;_klass_to_deallocate 交 CLD safepoint 处理
> - **ClassFileStream**(classFileStream.hpp): get_u1/u2/u4_fast :95-120(Bytes::get_Java_u2/u4 大端读取,x86 自动字节交换);guarantee_more :88;at_eos :141;parse_constant_pool_entries 用局部按值拷贝 :138 助编译器优化
> - **版本校验** verify_class_version :4881-4930(45.* 全放行/65535 preview 需 --enable-preview/未来版本 UnsupportedClassVersionError "compiled by a more recent version of the Java Runtime")
> - 悬念指向 02-verifier-stackmap.md(标题 "02. Verifier + StackMapTable — 字节码验证");实证: materials/commands/07-classfile-javap.txt(javap -v 常量池/Code/BootstrapMethods)+07-classfile-header-load.txt(hexdump cafe babe 0000 003d 0040 + class+load 日志: 平台类 shared objects file 走 CDS、应用类 file: 走解析)

### 1. ClassFile 结构 — 四个魔数后的世界

场景: `ClassLoader::load_classfile("Hello.class")` → `os::read(fd, buf, len)` 读入 4KB → 前 4B 是 `0xCAFEBABE`。后面跟着版本号/常量池/访问标志/类名/父类/接口/字段/方法/属性——全部从二进制字节提取。

**入口与总流程**(替代原 "parseClassFile:500-520" 章节):
- 入口链: `KlassFactory::create_from_stream`(klassFactory.cpp:166-226,过 JVMTI ClassFileLoadHook :184-188)→ `ClassFileParser` 构造(classFileParser.cpp:5879,**构造内 parse_stream :5995-5997 + post_process_parsed_stream**)→ `create_instance_klass`
- parse_stream(:6074-6308)顺序: magic(:6084)→ minor/major(:6090-6091)→ verify_class_version(:4881-4930)→ cp_size+ConstantPool::allocate(:6102-6121)+parse_constant_pool(:6125)→ access_flags+verify_legal_class_modifiers(:6130-6149)→ this_class_index+名字核对(:6162-6212)→ parse_super_class(:6252)→ parse_interfaces(:6259)→ parse_fields(:6268)→ parse_methods(:6277)→ parse_classfile_attributes(:6293)→ create_combined_annotations(:6300)→ at_eos(:6303,"Extra bytes at the end of class file")
- [C++: ClassFileStream(classFileStream.hpp)——包装 `(u1*)bytecode` 的 reader。`get_u1_fast()` 读 1B; `get_u2_fast()`/`get_u4_fast()`(classFileStream.hpp:102-112)用 `Bytes::get_Java_u2/u4` 大端读取(x86 自动字节交换);`guarantee_more(n)`(:88-91)声明边界;`at_eos()`(:141)]
- 错误处理: `classfile_parse_error`(classFileError.cpp:36 起)抛 ClassFormatError;magic 错→"Incompatible magic value";版本不兼容→UnsupportedClassVersionError;文件名与类名不符→NoClassDefFoundError "wrong name"

**常量池解析** (`parse_constant_pool_entries`,classFileParser.cpp:126-400):
- 槽 0 保留(index 从 1 开始,:151);局部按值拷贝 ClassFileStream(:138)助编译器优化
- switch 处理 15 种 tag(Module/Package 不经过此 switch);Long/Double 占 2 个 index(:256-266)
- Utf8: verify_legal_utf8(:298-301)+SymbolTable 批量分配(lookup_only :314、new_symbols :323-329)
- 版本门槛: MethodHandle/MethodType/InvokeDynamic ≥51、Dynamic ≥55(verifier.hpp:40-42)
- 第一遍交叉引用校验(parse_constant_pool,:406-500): Fieldref/Methodref 索引合法(:446-455);ClassIndex→unresolved_klass_at_put(:490)、StringIndex→unresolved_string_at_put(:499)——**只登记不解析**

### 2. 字段 + 方法 + 属性解析

**parse_fields** (`classFileParser.cpp:1541-1740`):
- 每字段四元组(access_flags/name_index/signature_index/attributes_count)→校验(修饰符/名字/签名,:1552-1564)→parse_field_attributes(:1295 起: ConstantValue/synthetic/泛型签名/注解)
- FieldInfo 六槽(fieldInfo.hpp:69 field_slots=6: access/name/sig/constantvalue+offset 高低两槽=12 字节);fac->update 按类型分五类桶(FieldAllocationType :1453-1466)
- injected fields(JavaClasses::get_injected,:1575-1578)——java.lang.Class 的 klass 等 JVM 隐藏字段
- 字段布局(offset 计算)在 layout_fields(:3934,:6411 调用)——06-03 已讲,本域不重复

**parse_methods** (`classFileParser.cpp:2959`):
- 预分配 Array<Method*>,逐个 parse_method(:2344): <clinit> 51 起必须 static(:2366-2379)、接口禁 <init>(:2381-2383)
- Code 属性(:2467 起): native/abstract 禁 Code、双 Code 报错;max_stack/max_locals/code_length(45.2 以下 1+1+2 字节,:2485-2492);code_start 取指针不拷贝(:2502);exception_table;内嵌 LineNumberTable/LocalVariableTable/StackMapTable(原始字节留 Verifier)

**attributes** (`parse_classfile_attributes`,classFileParser.cpp:3440):
- SourceFile/SourceDebugExtension/InnerClasses/Synthetic/Signature/EnclosingMethod/注解;BootstrapMethods(:3596,Java 7);NestHost/NestMembers(:3640/:3627,JDK 11 嵌套类访问)
- post_process_parsed_stream(:6310): 传递接口(:6378)、vtable 大小(:6394)、itable 大小(:6405)、layout_fields(:6411)
- fill_instance_klass(:5598): add_class 挂 CLD(:5609)、apply_parsed_class_metadata 所有权转移(:5632)、析构回收(:6015)

---

### 核心悬念

**"4 个魔数 `CAFEBABE` → ClassFileParser 6463 行 → InstanceKlass——JVM 最大的单个函数。"** — 从二进制字节 extract constant pool/fields/methods——每个 section 按 JVM Spec §4 的固定格式解析。解析后的 InstanceKlass 还不是可用的类——还要经过 Verifier (下一篇)。

> → [02-verifier-stackmap.md](02-verifier-stackmap.md)
