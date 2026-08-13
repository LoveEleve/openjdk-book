# 04. SystemDictionary — 类的"全球电话号码本"

> 🔴 Deep | 15 KP 中的 1 个核心机制
> 读者处境: `new String()`——JVM 去哪找 String 类？不是 classpath 扫描——是 SystemDictionary 的 hashtable O(1) lookup。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/07-classfile-classloader/04 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 ~140 行):
> - **行号全漂移**: resolve_instance_class_or_null 实际 :629 起(非 :200-800);入口 resolve_or_null :244(数组→resolve_array_class_or_null/对象 L; 剥壳/普通);load_instance_class :1403;define_instance_class :1555;add_to_hierarchy :1804;check_constraints :2093;update_dictionary :2160
> - **"三步走"严重简化**: 真实六步=①dictionary->find(带 protection domain,:643-646)②非 parallelCapable 拿**类加载器对象锁**(ObjectLocker,:655-668,与 Java 层 define 同锁)③锁内 find_class 复查(:678-686)④placeholder super_load_in_progress→handle_parallel_super_load(:690-712)⑤LOAD_INSTANCE 占位+加载+定义(见下)⑥清理占位(:834-840)+protection domain 校验(:854-866,is_valid_protection_domain/validate_protection_domain)
- **"Step 2: ClassLoader::load_classfile" 简化**: load_instance_class(:1403): bootstrap→**模块可见性检查**(:1407-1445,module 未初始化只许 java.base/初始化后限 append path)→CDS load_shared_class→ClassLoader::load_class→find_or_define_instance_class(:1481);用户 loader→**JavaCalls::call_virtual 调 Java 层 loadClass**(:1519-1530)——双亲委派在 Java 层(05 篇主题)
- **"Step 3: allocate KlassID→dictionary()->add_klass→update ClassLoaderData" 错**: define_instance_class(:1555)=check_constraints(:1577)→注册 classes Vector(loader_addClass,:1580-1587)→Compile_lock+add_to_hierarchy(:1593-1599)→update_dictionary(:1600-1603)→eager_initialize(:1605);"allocate KlassID" 编造;add_klass 是 Dictionary 成员(dictionary.cpp:297)不是 define 步骤
- **"Dictionary::find: Hashtable<Symbol*, Klass*>" 错**: Dictionary : **Hashtable<InstanceKlass*, mtClass>**(dictionary.hpp:42),key=类名 Symbol,value=InstanceKlass;per-loader(每个 ClassLoaderData 一张,backpointer _loader_data :50);find 带 protection domain 过滤(dictionary.cpp:334-345)
- **constraints 机制错**(大纲"同一 loader 下不同版本 jar→LinkageError"不准): 真实两层=①**同 loader 重复定义**(dictionary 复查,"attempted duplicate class definition"→LinkageError,:2115-2127,:2153)②**LoaderConstraintTable(全局表**,Hashtable<InstanceKlass*> loaderConstraints.hpp:35,JVMS 5.3.4): check_or_update(loaderConstraints.cpp:286-313)同 (name,loader) 已记录类不同→"loader constraint violation"(:2131-2138)
- **PlaceholderTable 大纲未提(核心机制)**: Hashtable<Symbol*>(placeholders.hpp:37);LOAD_INSTANCE/LOAD_SUPER 两种占位;bootstrap 不拿对象锁→在 SystemDictionary_lock wait 等第一请求者(:755-765)/双锁等待(double_lock_wait);check_seen_thread 检测循环→ClassCircularityError(:759-762,:796-800);RedefineClasses 靠占位符判断定义中(:729-731)
- **record_dependency(:821-824)**: 定义 loader 在发起 loader 存活期不被卸载(非双亲委派依赖)——大纲未提
- 悬念指向 05-classloader-hierarchy.md(标题 "05. ClassLoader — 双亲委派与三层加载")✓;实证: materials/commands/07-classfile-dictionary-log.txt(双 URLClassLoader 同名 Shared 加载两次: class+load 日志两行 + la==lb false/same name true/instance== false)

### 1. SystemDictionary — 全局类解析

场景: `new #2`——#2=CONSTANT_Class, name="java/lang/String", loader=Bootstrap。JVM: "我加载过 String 吗？"——`SystemDictionary::resolve_instance_class_or_null(Symbol* name, Handle class_loader, TRAPS)`。

**resolve_or_null / resolve_instance_class_or_null**(替代原 "systemDictionary.cpp:200-800"):
- 入口 resolve_or_null(systemDictionary.cpp:244-256): 数组/对象剥壳/普通三路分派
- 六步流程(见 ⚠️ 上): 查字典(带 pd)→对象锁→复查→占位符协调→加载/定义→保护域
- [C++: PlaceholderTable(placeholders.hpp:37)LOAD_INSTANCE/LOAD_SUPER 占位;bootstrap 等待第一请求者/循环→ClassCircularityError]

**constraints 机制**(替代原 "systemDictionary.cpp:900-1200"):
- check_constraints(systemDictionary.cpp:2093 起): ①同 loader 重复定义→LinkageError ②LoaderConstraintTable(loaderConstraints.hpp:35)全局约束 check_or_update(loaderConstraints.cpp:286-313)→"loader constraint violation"
- record_dependency(:821): 定义 loader 存活依赖
- [C++: 双亲委派在 Java 层 loadClass(systemDictionary.cpp:1519-1530),SystemDictionary 只做解析协调]

### 2. Dictionary — per-ClassLoader

**Dictionary::find**(替代原 "dictionary.cpp:50-200";Dictionary : Hashtable<InstanceKlass*>,dictionary.hpp:42):
- per-loader: 每个 ClassLoaderData 一张;find 带 protection domain 过滤(dictionary.cpp:334-345)
- [C++: ProtectionDomainEntry 绑定 CodeSource(路径+证书);resolve 尾部 validate_protection_domain(:866)]

---

### 核心悬念

**"同一个 `java/lang/String`——Bootstrap loader 下是 `String`——自定义 loader 下不是同一个类。"** — SystemDictionary + per-loader Dictionary 实现 Java 的类型隔离和类版本控制。而真正"找类"的动作(loadClass/双亲委派)在 Java 层。下一个: ClassLoader——双亲委派。

> → [05-classloader-hierarchy.md](05-classloader-hierarchy.md)
