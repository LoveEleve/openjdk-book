# 06. Symbol 与注解 — 让字符串全 JVM 只有一份

> **前置依赖**:[03 — InstanceKlass 与数组](03-instanceklass-arrayklass.md):字段表 FieldInfo 与 FieldStream 的关联;[04 — 常量池与方法](04-constantpool-method.md):Method 是 CompiledICHolder 的一半
> → **后续**:[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md)
> 关联域: 11-cds(Symbol 共享归档)、48-utilities(哈希表)

## "java/lang/String" 的 10000 次出现

类名、方法名、字段签名、字符串常量——JVM 里到处是相同的字节串。`ClassFileParser` 每解析一个类都要读到 "java/lang/String" 之类的名字;如果每次读到一个就新建一份字符串内存,垃圾会堆积成山。答案是 **Symbol + SymbolTable**: 内容相同就共享同一个对象,全 JVM 只有一个 "java/lang/String"。这篇收尾 06 域: Symbol 的存储与引用计数、SymbolTable 的查表与回收,以及剩下的辅助元数据(注解、字段遍历、inline cache 辅助对象)。

## 1. Symbol: 内容即对象

Symbol 是"字符串内容跟在对象本体后面"的一次性分配(symbol.hpp:110-115,逐字):

```cpp
// symbol.hpp:110-115(逐字)
  ATOMIC_SHORT_PAIR(
    volatile short _refcount,  // needs atomic operation
    unsigned short _length     // number of UTF8 characters in the symbol (does not need atomic op)
  );
  short _identity_hash;
  jbyte _body[2];
```

- `_body[2]` 是**柔性数组**——实际字节按长度分配在对象尾部(`operator new(size, len)`,symbol.hpp:133-135),`byte_size(length)` 就是"结构 + 多余字节"(symbol.hpp:122-125)。读内容 = `base()` 直接指 `_body` 起始,零指针跳转;
- **没有存 hash 的字段**: `identity_hash()` 是动态算的(symbol.hpp:151-155)——地址位、长度、头两个字节混合出 32 位值,不占存储;
- `_length` 是 unsigned short,所以单符号最长 `2^16-1` 字节(symbol.hpp:117-120)。

**引用计数**: `increment_refcount`/`decrement_refcount` 用 **Atomic::inc/add**(symbol.cpp:277-289)——多线程安全,不需要调用者额外同步;`_refcount == -1`(PERM_REFCOUNT)标记**永久符号**(CDS 归档里只读共享,不可回收,symbol.hpp:99-101)。

**转 C 字符串**: `as_C_string()` 返回**以 `\0` 结尾**的副本(注释原文 "null-terminated UTF-8 string",symbol.hpp:206-208)——分配在资源区或调用方给的 buffer,不修改 Symbol 本身。

**关键设计 (斜体)**: *"内容即对象"让一次分配同时得到头和字节,共享时整块共享,GC 时整块回收;immutable 意味着指针可以随便共享,`refcount` 只回答一个问题——"还有人用吗"。*

## 2. SymbolTable: intern 与回收

查表入口是 `SymbolTable`——注意它的实现(symbolTable.hpp:101,逐字):

```cpp
// symbolTable.hpp:101(逐字)
class SymbolTable : public RehashableHashtable<Symbol*, mtSymbol> {
```

**不是**无锁的并发哈希表(jdk11u 没有 ConcurrentHashTable 版的 SymbolTable)——是经典哈希表 + 一把全局锁: 插入/查找都持 `SymbolTable_lock`(symbolTable.cpp:329-330 "Grab SymbolTable_lock first")。查表流程: 算 hash → 定位桶 → 逐个比较(长度+字节相等)→ 命中返回已有 Symbol;未命中则新建并插入。

- [C++: CDS 归档里的共享符号先查: `lookup_shared` 优先(symbolTable.cpp:236-249),命中就直接用归档里的只读 Symbol(refcount=-1)——启动期热符号零创建]
- [C++: 符号的删除发生在 **GC 周期**: `SymbolTable::unlink`(symbolTable.cpp:147-155)遍历桶,把 `refcount() == 0` 的 Symbol 摘掉(:131)——不是"定期 rehash",是跟随 Metaspace 回收的清扫]

**关键设计 (斜体)**: *一把全局锁换简单正确性——SymbolTable 的访问频率虽高但每次操作极短,锁竞争可接受;对比字符串常量池(StringTable)在 jdk11u 用了并发哈希,是因为 Java 字符串的 intern 是用户可触发的热点,而 Symbol 只在类加载路径出现。*

## 3. Annotations: 字节数组,不是对象

注解在 JVM 里**不是对象**,就是原样的字节数组:

```cpp
// annotations.hpp:38(逐字)
typedef Array<u1> AnnotationArray;
```

每个类的注解存四份(annotations.hpp:44-55): 类注解/字段注解 × 普通/类型注解(`_class_annotations`、`_fields_annotations`、`_class_type_annotations`、`_fields_type_annotations`)。内容由 ClassFileParser 解析 class 文件注解属性时填充(`parse_annotations`,classFileParser.cpp:1213,格式注释 "annotations := do(nann:u2) {annotation}"),与 class 文件里的注解结构一致: u2 数量 + 每个注解(type_index + element_value 对)。

**关键设计 (斜体)**: *注解只在反射(`getAnnotations`)时才被解释——运行时行为不需要它们。原样存字节,省掉"解析成对象"的成本和内存;要读时现解,不要时整块跟着类回收。*

## 4. FieldStream: 遍历本类字段

03 篇讲过字段表 FieldInfo(每字段 6 个 u2);遍历它用 `FieldStreamBase`(fieldStreams.hpp:40)。注意它的边界(fieldStreams.hpp:102-109):

```cpp
// fieldStreams.hpp:102-109(截取核心,逐字)
  FieldStreamBase(InstanceKlass* klass) {
    _fields = klass->fields();
    _constants = klass->constants();
    _index = 0;
    _limit = klass->java_fields_count();
    init_generic_signature_start_slot();
    assert(klass == field_holder(), "");
  }
```

**遍历的是本类声明的字段**(`java_fields_count()`),**不含父类**——父类字段在父类自己的表里。这与 03 篇讲的方法表同构: 每个 Klass 只装自己声明的,继承的东西靠父类链找。

## 5. CompiledICHolder: inline cache 的辅助对象

编译代码的调用点要做"单态优化"——记住上次的接收者类型与方法,下次直接跳。`CompiledICHolder` 就是这个缓存的辅助对象(compiledICHolder.hpp:33 注释 "A `CompiledICHolder*` is a helper object for the inline cache implementation"),它的字段(:51-54,截取核心,逐字):

```cpp
// compiledICHolder.hpp:51-54(截取核心,逐字)
  Metadata* _holder_metadata;
  Klass*    _holder_klass;    // to avoid name conflict with oopDesc::_klass
  CompiledICHolder* _next;
  bool _is_metadata_method;
```

注意被缓存的不只是 Method——是 `Metadata*`(方法或类,靠 `_is_metadata_method` 区分)加接收者 Klass。编译代码里"校验接收者类型 + 跳转目标"的两个关键值,就放在这个对象里,随 nmethod 一起存活。

**关键设计 (斜体)**: *inline cache 把"每次查 vtable"变成"一次类型比较 + 直接跳"——把解析成本从每次调用摊到调用点的生命周期;miss 时再去查表并回填。缓存的不是数据,是"上一次的答案"。*

## 核心悬念

域 06 六篇收官: 对象头(mark word 五种身份)→ Klass 家族与 vtable/itable → InstanceKlass 的字段表/方法表/引用类与数组的两副面孔 → 常量池解析与 Method 四入口 → Access API 的 barrier 旁听 → 本篇的 Symbol 去重与辅助元数据。对象模型这一侧已经完整: 对象怎么表示、类怎么组织、方法怎么找到、引用怎么被 GC 保护。

但所有这些元数据都是**从哪来的**?`java.lang.String` 的 InstanceKlass、ConstantPool、Method、Symbol——它们最初只是 .class 文件里的字节。下一篇进入第 3 批: ClassFile 解析——.class 的字节怎么一步步变成 InstanceKlass。

> → [07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md)
