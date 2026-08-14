# 01. ciObject 镜像体系 — JIT 怎么看到 Java 类？

> 🔴 Deep | 11 KP 中的 3 个核心机制
> 读者处境: C2 编译 `String.length()`——它需要知道 String 的 `value` 字段在哪 (offset)。不能直接读 InstanceKlass——多了 C++ 虚函数和锁。ci 层是纯净的编译器镜像。

> ⚠️ 写作期修正(2026-08-13, vol-02/12-ci/01 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准):
> - **"JIT 编译运行在 safepoint 中" 错**: 编译在编译线程并发跑,GC 时只是阻塞,编译状态跨 GC 存活;GC 安全靠双通道引用——oop→JNI local handle(ciObject.cpp:53-59,GC 重定位),Metadata(Metaspace 不移动)→裸指针;类注释 ciObject.hpp:40-44 "GC and compilation can proceed independently"
> - **"ciObject 与 Klass 无继承关系/零虚函数" 半对**: ci 层有自己的层级(ciBaseObject→ciObject/ciMetadata);is_interface() 在 ciKlass 是 virtual,但 ciInstanceKlass 版本=ciFlags 位测试(内联,ciInstanceKlass.hpp:231→ciFlags.hpp:59)——"零虚函数"指热路径查询降级为快照位读
> - **"多次编译同一个 Klass 返回同一个 ciKlass" 只对 well-known 类成立**: 工厂 per-编译(ciEnv 构造 ciEnv.cpp:131);全局共享部分=vmSymbols 全部 ciSymbol+基本类型 ciType+WK_KLASSES_DO 的 well-known ciInstanceKlass(ciObjectFactory.cpp:123-206,ciEnv::_Object 等静态);ident 分段 _shared_ident_limit(:204)
> - **"oop→ciObject 映射 GrowableArray" 半对**: 两个缓存——_ci_metadata 排序数组(Metadata 指针不移动,find_sorted 二分,ciObjectFactory.cpp:292-335)+_non_perm_bucket[61] 哈希桶(oop 会移动不能排序,get :238-259)
> - **"unique_concrete_method / DFA / _implementors 列表" 编造**: 真实=①implementor() 三态指针 _implementor(ciInstanceKlass.hpp:70-74: NULL/一个/自身=多个,nof_implementors :165;懒计算+备忘 ciInstanceKlass.cpp:599;**共享类假设无唯一实现者** :604);②unique_concrete_subklass(ciInstanceKlass.cpp:370)=up_cast_abstract(:376),无 "DFA" 概念
> - **"is_c1_compilable 检查方法大小/MDO 充足" 错**: =Method access_flags 的两个位(is_not_c1_compilable,method.hpp:949),ciMethod 构造抄取(ciMethod.cpp:88-89);方法大小=_code_size 快照(:82),内联规模决策用
> - **"is_constant=final+static" 太粗**: 完整判定(ciField.cpp:257-291)=①static final(排除 System.in/out/err 按偏移,:261-270)或 @Stable(FoldStableValues,:257-258)→true;②非 static final 需信任名单 trust_final_non_static_fields(:216: java.lang.invoke/sun.invoke 包/匿名类/装箱类/String/Atomic*FieldUpdater/TrustFinalNonStaticFields flag);③CallSite.target 特例(:281-286);否则 false
> - **"is_subtype_of 查缓存 subtype list" 错**: 直接转发 Klass::is_subtype_of(ciKlass.cpp:68-80,VM_ENTRY_MARK 进 VM;VM 侧是 super_check_offset 指针比较,06 域)
> - **缺机制(大纲无)**: ①共享类(CDS)快照特殊处理 update_if_shared(ciInstanceKlass.hpp:109-113)——归档类 _init_state 旧值,is_initialized/is_linked 查询时 compute_shared_init_state 现算(11 域呼应);②hotswap 检查 Dependencies::check_evol_method(ciMethod.cpp:102-110,redefine 过的方法两 compilable 置 false);③依赖登记: ciEnv 持 Dependencies(ciEnv.hpp:57/313),validate_compile_task_dependencies(ciEnv.cpp:933)——编译假设失效→nmethod 作废(22 域);④unloaded 镜像语义 is_loaded()=handle()!=NULL||is_classless(ciObject.hpp:138),编译器必须处理"缺失";⑤解释器计数快照(ciMethod.cpp:137-148,"commensurate with the MDO");⑥lazy 字段体系(_super/_java_mirror/_nonstatic_fields/compute_nonstatic_fields,ciInstanceKlass.hpp:63-68/:105)
> - **实证**: 12-ci-inlining-demo.txt(PrintCompilation+PrintInlining: CiDemo::work 内联树 String::length(11 bytes)→coder→isLatin1;接口调用 ShapeHolder.shape()→Square.area() 内联,依据 \-> TypeProfile (87426/87426 counts)=CiDemo$Square;tier3→%tier4→made not entrant :32/39/40);编译链对照 08-interpreter-counterdemo.txt

### 1. ci 层是什么 — 为什么需要镜像？

场景: JIT 编译器 (C1/C2) 运行在 safepoint 中——它需要读 Klass/Method/Field 的元数据——但 Klass 是 C++ 虚基类——每次 `klass->is_interface()` 是虚函数 dispatch。**编译器中大量重复调用——虚函数开销不可接受。且 Klass 可能被 GC 改变 (class redefine)。**

**ciObject 镜像** (`ciObject.hpp + ciKlass.hpp + ciMethod.hpp`):
- ciKlass: Klass 的编译器镜像——is_interface() 是普通 inline 方法——在 ciKlass 构造时一次性从 Klass 读取——存为 bool——后续全部 inline 查
- ciMethod: 方法镜像——bytecode/exception handler/vtable index——ciMethod 构造时一次性提取
- ciField: 字段镜像——offset/type/is_volatile/constant value——存为简单值
- [C++: ciObject 不是 oop——是 C2 的 C++ 对象——不需要 GC 扫描。在编译的 safepoint 中创建——编译后随 ciEnv destroy 释放。与 Klass 无继承关系——是纯数据 copy——零虚函数]
- [C++: ciObjectFactory 持有 `oop→ciObject` 映射——`GrowableArray<ciObject*>`。所以同一个 Klass 在多次编译中——总是返回同一个 ciKlass——`ciObjectFactory::get_metadata(klass)`→lookup→如果已有→return；没有→create ciKlass

### 2. ciKlass + ciMethod — 编译器的数据视图

**ciKlass** (`ciKlass.hpp.cpp` + `ciInstanceKlass.hpp.cpp`):
- `ciKlass::is_subtype_of(ciKlass* other)`: super class check——在 ci 层做——不调 Klass 虚函数——查缓存 subtype list
- `ciInstanceKlass::unique_concrete_method(ciMethod*)`: DFA (Dynamic Frequent Access)——在子类中查找单个具体实现的虚方法——inline 的前提
- [C++: DFA——若一个 interface 方法在所有子类中只有一个实现——可以 devirtualize 为 direct call——跳过 vtable。ciKlass 的 `_implementors` 列表记录——构造时从 SystemDictionary::find 获取]

**ciMethod** (`ciMethod.hpp.cpp`):
- `method_data()`: 返回 ciMethodData——MDO 的编译器端——invocation_counter/backedge_counter——决定编译层次
- `blocks()`: ciMethodBlocks——bytecode 基本块——从 bytecode 构建 CFG——ciTypeFlow 输入
- `instructions_size()`: Method 的 bytecode 长度——C2 的编译规模估算 (size_threshold)
- [C++: `ciMethod::is_c1_compilable()` / `is_c2_compilable()`——检查方法大小、MDO profiling 是否充足——返回 true→加入编译队列。ciMethod 构造时从 Method 一次性提取——后续编译中 CI 只查 ciMethod——不回头查 Method]

**ciField** (`ciField.hpp.cpp`):
- `is_constant()`: 字段是否 final+static——JIT 可以直接用常量值替代 field access
- `constant_value()`: 常量的 ciConstant——int/float/String/Class
- [C++: `ciField::will_link(method, bci)`——检查字段是否有链接错误 (NoSuchFieldError/IllegalAccessError)——预检——避免 JIT 编译后才发现链接失败——浪费编译]

---

### 核心悬念

**"C2 编译 `String.length()`——需要 value 字段 offset (is_constant=false)——ciField 在构造时一次性从 InstanceKlass::FieldInfo 提取 offset→存为 int→后续全部 inline 读——零虚函数、零锁、零 GC 干扰。"** — ciObjectFactory 缓存所有 ciObject——同一个 Klass 多次编译——返回同一个 ciKlass——减少镜像创建开销。下一个: ciTypeFlow——C2 怎么从字节码推导类型。

> → [02-ci-typeflow-escape.md](02-ci-typeflow-escape.md)
