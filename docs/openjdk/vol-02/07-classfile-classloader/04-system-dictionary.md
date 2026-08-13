# 04. SystemDictionary — 类的"全球电话号码本"

> **前置依赖**:[07-classfile-classloader/01 — ClassFile 解析](openjdk/vol-02/07-classfile-classloader/01-classfile-parser.md):InstanceKlass 怎么从字节里诞生;[07-classfile-classloader/03 — SymbolTable + StringTable](openjdk/vol-02/07-classfile-classloader/03-symbol-string-table.md):类名是 Symbol,查名字要过 SymbolTable
> → **后续**:[05 — ClassLoader](05-classloader-hierarchy.md)(双亲委派在 Java 层)
> 关联域: 06-oops(ClassLoaderData)、25-gc、11-cds(共享类)

## 名字到类的第一道闸门

`new String()` 的字节码是 `new #2`——#2 是常量池里的类引用,内容是名字 "java/lang/String"。JVM 拿着这个名字问的第一个问题是: **"这个加载器下,我定义过这个类吗?"** 回答这个问题的就是 SystemDictionary——类解析的总入口(静态工具类): 存储层面是**每个加载器一张 Dictionary**,另配全局的约束表与占位符表。这一篇拆名字到类的完整旅程: 解析入口、占位符与并发、字典查找与约束,以及两个加载器各带一份同名类文件的实证。

## 1. 解析入口: 一个名字怎么变成 Klass

### resolve_or_null: 三种名字三种路

字节码/反射里的类引用最终都汇到 `SystemDictionary::resolve_or_null`(systemDictionary.cpp:244-256,截取核心,逐字):

```cpp
// systemDictionary.cpp:244-256(截取核心,逐字)
Klass* SystemDictionary::resolve_or_null(Symbol* class_name, Handle class_loader, Handle protection_domain, TRAPS) {
  if (FieldType::is_array(class_name)) {
    return resolve_array_class_or_null(class_name, class_loader, protection_domain, THREAD);
  } else if (FieldType::is_obj(class_name)) {
    ResourceMark rm(THREAD);
    // Ignore wrapping L and ;.
    TempNewSymbol name = SymbolTable::new_symbol(class_name->as_C_string() + 1,
                                   class_name->utf8_length() - 2, CHECK_NULL);
    return resolve_instance_class_or_null(name, class_loader, protection_domain, THREAD);
  } else {
    return resolve_instance_class_or_null(class_name, class_loader, protection_domain, THREAD);
  }
}
```

数组名(`[Ljava/lang/String;`)走数组解析;带 `L...;` 包装的对象名剥壳后和普通名一样走 `resolve_instance_class_or_null`。**解析入口只认名字 + 加载器 + 保护域三元组**——同一个名字配不同的加载器,是两个不同的解析请求。

### resolve_instance_class_or_null: 查、锁、占位、加载、验

主流程在 `resolve_instance_class_or_null`(systemDictionary.cpp:629-830),比流传的"三步走"复杂得多:

1. **先查字典**(:653): `dictionary->find(d_hash, name, protection_domain)`——per-loader 字典,带保护域匹配;命中直接返回;
2. **拿类加载器对象锁**(:678): 非 bootstrap、非 parallelCapable 的加载器,解析必须先持有 `ObjectLocker`——注释点明原因: 类加载器在 Java 层用对象锁防并发 define,这里必须同一把锁,否则等待者看不到已加载结果;
3. **锁内复查**(:694): 持锁后 `find_class` 再查一次(可能别的线程刚加载完);
4. **占位符检查**(:701-713): 若 PlaceholderTable 里有此类的 **LOAD_SUPER 占位**(父类加载中),走 `handle_parallel_super_load`——并行加载器下,父类可能由别的线程正在加载,这里协调等待;
5. **占位、加载、定义**(:792-859): 自己放 LOAD_INSTANCE 占位 → `load_instance_class` 实际加载 → 若**定义加载器不是发起加载器**,`check_constraints` + `record_dependency` + `update_dictionary`(详见 §3);
6. **清理占位 + 保护域**(:859-889): 移除 LOAD_INSTANCE 占位、通知等待者;最后校验 `protection_domain`(null 直接返回,否则 `is_valid_protection_domain`/`validate_protection_domain`)。

**关键设计 (斜体)**: *"查→锁→再查→占位→加载"是教科书式的双重检查加锁,但锁有两把: **类加载器对象锁**(Java 层同步)和 **SystemDictionary_lock**(内部表锁)。占位符表是第三层保险——它专门处理"bootstrap 加载器不拿对象锁"和"parallelCapable 并发加载"两种无法用对象锁同步的情况。*

## 2. PlaceholderTable: 占位符与并发协调

占位符表是 `Hashtable<Symbol*>`(placeholders.hpp:37),key 是类名,value 是 `PlaceholderEntry`——记录"谁正在加载这个类、加载到哪一步"。两种状态位(placeholders.hpp 的枚举):

- **LOAD_INSTANCE**: 类本身的加载进行中。bootstrap 加载器不拿对象锁,靠它在 SystemDictionary_lock 上 `wait()` 等第一个请求者完成(:768);传统但破坏对象锁的加载器同理(`double_lock_wait`);如果**同一线程再次遇到自己的 LOAD_INSTANCE 占位**(`check_seen_thread`),说明出现了循环加载——直接抛 `ClassCircularityError`(:759,:813);
- **LOAD_SUPER**: 父类加载进行中。并行加载器解析子类时发现父类正被别的线程加载,协调等待并复用结果(:690-712)。

占位符的生命周期被注释钉死: `resolve_instance_class_or_null` 开头加、结尾清(:859),"RedefineClasses 用占位符的存在判断类是否还在定义中"(:734)。

**关键设计 (斜体)**: *占位符表是"加载中"状态的显式表达: 字典里只有"已定义"的类,占位符表里是"正在定义"的类。循环加载(ClassCircularityError)和并发加载(bootstrap/parallelCapable 的等待)都靠它区分——这也解释了为什么解析流程里"查字典"要做四次(:653 加锁前、:694 加锁后、:775 等待后、:800 占位后)——每一次都可能在上一刻刚完成。*

## 3. Dictionary 与约束: per-loader 字典 + 全局约束表

### Dictionary: 每个加载器一张表

`Dictionary` 是 `Hashtable<InstanceKlass*, mtClass>`(dictionary.hpp:42)——**不是**流传的 "Hashtable<Symbol*, Klass*>"——每个 `ClassLoaderData` 持有一张(dictionary.hpp:50 有 backpointer `_loader_data`),key 是类名 Symbol,value 是 InstanceKlass 加**它所属的加载器**。查找带保护域过滤(dictionary.cpp:334-345,截取核心,逐字):

```cpp
// dictionary.cpp:334-345(逐字)
InstanceKlass* Dictionary::find(unsigned int hash, Symbol* name,
                                Handle protection_domain) {
  NoSafepointVerifier nsv;

  int index = hash_to_index(hash);
  DictionaryEntry* entry = get_entry(index, hash, name);
  if (entry != NULL && entry->is_valid_protection_domain(protection_domain)) {
    return entry->instance_klass();
  } else {
    return NULL;
  }
}
```

**同一个类名,不同加载器的字典互不相干**——这就是 Java 类型隔离的物理基础:[实证] 里两个 URLClassLoader 各带一份同名 `Shared.class`,`class+load` 日志显示同一名字被加载了两次(materials/commands/07-classfile-dictionary-log.txt):

```
[0.027s][info][class,load] Shared source: file:/data/tmp/opencode/cf/dirA/
[0.027s][info][class,load] Shared source: file:/data/tmp/opencode/cf/dirB/
la==lb:       false          ← 两个不同的 Class 对象
same name:    true
instance==:   false
```

### check_constraints: 两道检查

`check_constraints`(systemDictionary.cpp:2093-2155)在定义时拦两道(截取核心,逐字):

```cpp
// systemDictionary.cpp:2108-2137(截取核心,逐字)
    InstanceKlass* check = find_class(d_hash, name, loader_data->dictionary());
    if (check != NULL) {
      // If different InstanceKlass - duplicate class definition,
      // else - ok, class loaded by a different thread in parallel.
      ...
      if ((defining == true) || (k != check)) {
        throwException = true;
        ss.print("loader %s", loader_data->loader_name_and_id());
        ss.print(" attempted duplicate %s definition for %s. (%s)",
                 k->external_kind(), k->external_name(), k->class_in_module_of_loader(false, true));
      } else {
        return;
      }
    }
    ...
    if (throwException == false) {
      if (constraints()->check_or_update(k, class_loader, name) == false) {
        throwException = true;
        ss.print("loader constraint violation: loader %s", loader_data->loader_name_and_id());
        ss.print(" wants to load %s %s.",
                 k->external_kind(), k->external_name());
```

- **第一道: 同加载器重复定义**——字典里已有同名类且不是刚加载的同一个(并行场景正常命中)→ "attempted duplicate class definition",抛 LinkageError;
- **第二道: LoaderConstraintTable**(`Hashtable<InstanceKlass*>`,loaderConstraints.hpp:35)——**全局**约束表,记录 (类名, 加载器) 已解析到的类: `check_or_update`(loaderConstraints.cpp:286-313)发现"同一名字、同一加载器,但类对象与已记录的不同"→ "loader constraint violation"——这是 JVM 规范 §5.3.4 的加载约束: 名字在解析图里必须一致。

### record_dependency: 非双亲委派的反向依赖

发起加载器 ≠ 定义加载器时,还有一步 `record_dependency`(systemDictionary.cpp:836-840): 把定义加载器记进发起加载器的依赖——注释点明目的: **定义类加载器在发起加载器存活期间不能被卸载**,即使发起加载器已不再引用定义类。这是"类 A 由 L1 发起、由 L2 定义"场景下 GC 正确性的关键。

**关键设计 (斜体)**: *per-loader 字典实现了"同名不同类"的隔离;全局 LoaderConstraintTable 实现了"同名字必须一致"的约束——一松一紧,正是类型安全的两个支柱。而 record_dependency 补上跨加载器引用的生命周期: 解析是"用别人的类",用完了得保证别人的类还活着。*

## 核心悬念

名字到类的旅程到齐: resolve_or_null 按名字形态分派 → resolve_instance_class_or_null 的"查字典/拿锁/复查/占位/加载/验保护域"六步 → per-loader Dictionary 隔离同名类、LoaderConstraintTable 强制一致性、占位符协调并发与循环。但有一个环节还蒙着: `load_instance_class` 里,用户加载器走的是 **`JavaCalls::call_virtual` 调 Java 层的 `ClassLoader.loadClass`**(systemDictionary.cpp:1519-1530)——真正的"找类"动作在 Java 代码里,双亲委派、三层加载都是 Java 层的规矩。下一篇: ClassLoader——双亲委派与三层加载。

> → [05 — ClassLoader](05-classloader-hierarchy.md)
