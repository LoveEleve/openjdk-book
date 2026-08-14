# 03. 编译的"一次性生命"怎么收场？— ciObjectFactory + ciReplay

> **前置依赖**:[12-ci/01 — JIT 怎么看到 Java 类？— ciObject 镜像体系](01-ci-overview-mirror.md):镜像与工厂的创建侧已拆完,本篇补生命周期(释放)与回放;[12-ci/02 — 编译器怎么知道"类型"与"逃逸"？— ciTypeFlow + bcEscapeAnalyzer](02-ci-typeflow-escape.md):ciMethodData 是 profile 数据的编译期快照;[16-code-cache/02 — nmethod 结构 — 一段编译方法里装了什么](openjdk/vol-02/16-code-cache/02-nmethod-structure.md):编译的产物,生命周期终点
> → **后续**:[13-jit-framework/01 — CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md):编译任务从哪来、谁排队
> 关联域: 22-deopt(依赖与回放的关联)、25-gc(编译线程与 GC)

## 编译是一场"用过即弃"的会话

前两篇讲了编译器怎么通过 ci 镜像看世界、怎么推导类型与逃逸。这一篇回答三个收尾问题: **编译结束后,成百上千个 ci 对象去哪了?** 出 bug 时,**怎么让一次编译原样重来?** 以及一直被引用的 **ciMethodData(profile 的编译器视图)到底怎么建**。前两个问题答案都短: 一次编译 = 一个 ciEnv = 一块 Arena,拆完即焚;要重现 = 把编译输入录下来回放。第三个问题揭开 01 篇那个 `TypeProfile (87426/87426) = CiDemo$Square` 的原料来源。

## 1. 生命周期: 一块 Arena,拆完即焚

01 篇说过,ci 对象活在编译专属的 Arena(`_ciEnv_arena`,C 堆、mtCompiler)里;ci 镜像由 `ciObjectFactory` 保证同一次编译内唯一。收尾动作在 `ciEnv::~ciEnv`(ciEnv.cpp:215):

```cpp
// ciEnv.cpp:215-223(截取核心,逐字)
ciEnv::~ciEnv() {
  GUARDED_VM_ENTRY(
      CompilerThread* current_thread = CompilerThread::current();
      _factory->remove_symbols();
      // Need safepoint to clear the env on the thread.  RedefineClasses might
      // be reading it.
      current_thread->set_env(NULL);
  )
}
```

只有两件事: ① `remove_symbols()`——归还本次编译新建的符号引用计数(01 篇说过,非 SID 符号建完要 `decrement_refcount`);② `set_env(NULL)`——清掉编译线程上的 ciEnv 指针。**没有"遍历所有 ciObject 逐个释放"**——大纲的说法不存在: 所有 ci 对象都分配在 Arena 里,Arena 随 ciEnv 析构一次性释放,不需要逐个 delete。oop 镜像的 JNI handle 也随编译线程的 handle block 一起清理;Metadata 引用本就不是 ci 的财产(Metaspace 管)。**注意注释**: 清 env 指针要在 safepoint 语境下做——"RedefineClasses might be reading it"——类重定义时 VM 可能正通过这个指针读取编译上下文,不能裸着清。

**关键设计 (斜体)**: *整个 ci 层的生命周期就是"一次编译 = 一个 ciEnv = 一块 Arena": 构造时建工厂、编译中镜像随用随建、析构时 Arena 整体回收——没有引用计数、没有逐个析构、没有跨编译缓存(well-known 例外,01 篇)。简洁的前提是 per-编译隔离: 镜像的快照可能过期(01 篇依赖机制兜底),所以绝不跨编译复用。*

## 2. 录制: 把编译输入写进文件

镜像生命周期虽短,但"这一次编译到底看到了什么"值得留下——JIT bug 最头疼的是**不可重现**: 方法在特定 profile 下编出错代码,下次编译 profile 变了,错误消失。ciReplay 的答案: 把编译输入完整录制,之后用录制的输入原样重编。录制有**三条途径**:

1. **崩溃自动录**(DumpReplayDataOnError,product flag,默认 true,globals.hpp:2071)——编译器线程在编译中崩溃时,VM 自动写 `replay_pid%p.log`(ciReplay.hpp:59-61);
2. **CompileCommand 指定录**(实证)——`-XX:CompileCommand=option,CiDemo::work,DumpReplay` 让 CiDemo::work 每次编译都落一份 `replay_pid%p_compid%d.log`(compile.cpp:899-900: `directive->DumpReplayOption` → `env()->dump_replay_data(_compile_id)`);
3. **SA 从 core 提取**(ciReplay.hpp:41-57)——只有 core 文件也能用 Serviceability Agent 挖出编译线程的 CI 状态。

[实证:](planning/outlines/00-jvm-tools/materials/commands/12-ci-replay-demo.txt) 用 DumpReplay 跑 CiDemo,生成 3 个 replay 文件(compid76/77/78 = CiDemo::work 的三次编译)。文件结构(`dump_replay_data_unsafe`,ciEnv.cpp:1231): Jvmti 状态 3 行 → `# 123 ciObject found` → **每个 ciMetadata 的完整快照** → compile 行。快照行就是"编译输入全集":

- `ciInstanceKlass java/util/Iterator 1 1 53 100 8 ...`——类的布局信息(01 篇 ciInstanceKlass 快照字段的逐项序列化);
- `staticfield java/lang/System in Ljava/io/InputStream; java/io/BufferedInputStream`——**静态字段的值**(ciField is_constant 的原料);
- `ciMethod CiDemo work (Ljava/lang/String;LCiDemo$ShapeHolder;)J 9 486889 1 0 -1`——方法 + 四个计数/状态 + instructions_size(按 dump_replay_data 的格式,ciMethod.cpp:1335-1347: invocation raw=9、backedge raw=486889、解释器调用=1、throwout=0、_instructions_size=-1 未算);
- `ciMethodData CiDemo work (sig)J 2 108223 orig 80 158 237 ... data 38 0x90007 ... oops 2 14 CiDemo$ShapeHolder 21 CiDemo$Square methods 0`——**MDO 的完整镜像**(dump_replay_data,ciMethodData.cpp:673): 状态与里程、`orig` 段(MDO 头部原始字节,前两个值 158/237 就是调用计数)、`data` 段(profile 原始字节)、`oops` 段(profile 里的类指针,按 **偏移+类名** 成对: 偏移 14 处 CiDemo$ShapeHolder、偏移 21 处 CiDemo$Square——01 篇 PrintInlining 里 `TypeProfile = CiDemo$Square` 的同一个数据!);
- `compile CiDemo work (sig)J 5 4 inline 5 0 -1 CiDemo work ... 1 14 java/lang/String length ()I ...`——本次编译的任务参数(entry_bci=5、comp_level=4)**连同内联决策树**(dump_compile_data,ciEnv.cpp:1203)——回放时连"内联了谁"都还原。

## 3. 回放: debug 构建的确定性重现

回放入口:`-XX:+ReplayCompiles -XX:ReplayDataFile=replay_pidXXX.log`。但先说清**边界**: `ReplayCompiles` 是 **develop flag**(globals.hpp:2048),ciReplay.hpp:36 的注释也明说 "NOTE: these replay functions only exist in debug version of VM"——**回放只能在 debug 构建里用**;release 构建能录(实证),不能放。这符合它的定位: 这是 JVM 工程师调试自己的工具,不是用户功能。

流程(ciReplay.hpp:72-79): `ReplayCompiles` 开启后,主线程启动处直接进回放模式(jni.cpp:4050 `if (ReplayCompiles) ciReplay::replay(thread)`,debug 构建)→ `ciReplay::replay`(ciReplay.cpp:1037)→ `replay_impl`(:1074)用 `CompileReplay` 读 replay 文件并 `process`——把录制的编译任务放上编译队列——编译完 VM 退出(没有业务代码要跑)。编译过程本身**照常走工厂**建镜像,差别在于: `ciReplay::initialize` 钩子在镜像构造时被调,用录制值覆盖关键字段。以 ciMethodData 为例(ciReplay.cpp:1115):

```cpp
// ciReplay.cpp:1135-1161(截取核心,逐字)
    if (rec->_data_length != 0) {
      assert(m->_data_size + m->_extra_data_size == rec->_data_length * (int)sizeof(rec->_data[0]) ||
             m->_data_size == rec->_data_length * (int)sizeof(rec->_data[0]), "must agree");

      // Write the correct ciObjects back into the profile data
      ciEnv* env = ciEnv::current();
      for (int i = 0; i < rec->_classes_length; i++) {
        Klass *k = rec->_classes[i];
        // In case this class pointer is is tagged, preserve the tag bits
        intptr_t status = 0;
        if (k != NULL) {
          status = ciTypeEntries::with_status(env->get_metadata(k)->as_klass(), rec->_data[rec->_classes_offsets[i]]);
        }
        rec->_data[rec->_classes_offsets[i]] = status;
      }
      for (int i = 0; i < rec->_methods_length; i++) {
        Method *m = rec->_methods[i];
        *(ciMetadata**)(rec->_data + rec->_methods_offsets[i]) =
          env->get_metadata(m);
      }
      // Copy the updated profile data into place as intptr_ts
#ifdef _LP64
      Copy::conjoint_jlongs_atomic((jlong *)rec->_data, (jlong *)m->_data, rec->_data_length);
#else
      Copy::conjoint_jints_atomic((jint *)rec->_data, (jint *)m->_data, rec->_data_length);
#endif
    }
```

[C++:] 注意这里的设计: **录制文件里存的是类/方法的名字,回放时用当前环境的工厂重新解析**(`env->get_metadata(k)` 走正常的 ciObjectFactory 缓存)——ci 对象始终是"当前 JVM 里解析出来的对象",只是 profile 的**内容**(计数、类型、data 数组)被录制值覆盖。所以回放不是"重建一个假的 VM 世界",而是"同一次编译输入的重放": 计数/TypeProfile/内联树全按录制值,编译器的输入与崩溃那一次完全一致。`ciReplay::initialize(ciMethod*)`(:1206)同理回填方法的字段(解释器计数等),钩子在 `ciMethod`/`ciMethodData` 构造时挂上(ciMethod.cpp:152、ciMethodData.cpp:256)。

大纲说的 "ciEnv::initialize_from_replay()" 与 "ciObjectFactory::create_from_replay_data()" 都不存在——真实机制就是上面这条: 工厂照常建,`ciReplay::initialize` 覆盖。

## 4. ciMethodData: profile 的编译期快照

录制文件里最肥的块是 ciMethodData——它是 **MethodData(MDO)的 ci 翻译版**,01 篇 PrintInlining 的 `TypeProfile` 就是它提供的。两个关键事实,都与大纲说法不同:

**它不是 ciMethod 构造时创建的**。`ciMethod` 构造时 `_method_data = NULL`(ciMethod.cpp:135),真正创建在 `ensure_method_data`(ciMethod.cpp:965):

```cpp
// ciMethod.cpp:965-983(截取核心,逐字)
bool ciMethod::ensure_method_data(const methodHandle& h_m) {
  EXCEPTION_CONTEXT;
  if (is_native() || is_abstract() || h_m()->is_accessor()) {
    return true;
  }
  if (h_m()->method_data() == NULL) {
    Method::build_interpreter_method_data(h_m, THREAD);
    if (HAS_PENDING_EXCEPTION) {
      CLEAR_PENDING_EXCEPTION;
    }
  }
  if (h_m()->method_data() != NULL) {
    _method_data = CURRENT_ENV->get_method_data(h_m()->method_data());
    return _method_data->load_data();
  } else {
    _method_data = CURRENT_ENV->get_empty_methodData();
    return false;
  }
}
```

[C++:] 语义是"编译器需要 profile 时**现场要**": 方法还没有 MDO 就当场 `build_interpreter_method_data` 建一个(:971——编译期可以反过来给解释器造剖面容器,这就是 C2 第一次编译时 MDO 从无到有的路径);native/abstract/accessor 方法不需要 profile 直接放行(:967);建不出来(内存失败)用空 MDO 兜底(:980)。`load_data()`(ciMethodData.cpp:170)才真正取数: **原子拷贝** MDO 的计数器头与 data 数组进 ciEnv 的 Arena(:205-215)——源码注释明说 "Any concurrently executing threads may be changing the data as we copy it"(:181)——然后遍历把 data 里的 oop 翻译成 ci 等价物(:224-229)。所以构造只是占位(ciMethodData.cpp:40-54 全是初值: `_data(NULL)`、`_state(empty_state)`、计数器 0)。

**它要防的不是"GC 修改 MDO"**。MDO 在 Metaspace,不移动也不被 GC 改;真正的问题是**解释器还在继续写 MDO**——编译期间计数在涨、类型剖面在变。ciMethodData 是快照: 编译全程读自己这份拷贝,不受并行更新干扰,保证一次编译内看到的数据自洽(01 篇 ciMethod 的"计数快照"注释同源)。

## 核心悬念

ci 域收束了: 生命周期(一次编译 = 一个 ciEnv = 一块 Arena,析构两件事: 还符号引用、清线程 env 指针——类重定义会读它);录制(崩溃自动录/CompileCommand 显式录/SA 从 core 挖——文件里是编译输入全集: 布局、静态字段值、计数、profile 数据、内联树);回放(debug-only,工厂照常建镜像、`ciReplay::initialize` 覆盖录制值——同输入必同输出);ciMethodData(MDO 的懒建快照,TypeProfile 的原料)。一句话: **镜像层的生命是一次编译,回放层让一次编译可以重来,profile 层给编译器喂"过去"的数据。**

但还有一个问题悬着: 编译任务本身怎么诞生、怎么排队、谁在跑?`CiDemo::work` 的三次编译(compid76/77/78)是谁安排的?下一篇进入第 5 批的下一站: CompileBroker。

> → [13-jit-framework/01 — CompileBroker 编译队列](openjdk/vol-02/13-jit-framework/01-compile-broker-queue.md)
