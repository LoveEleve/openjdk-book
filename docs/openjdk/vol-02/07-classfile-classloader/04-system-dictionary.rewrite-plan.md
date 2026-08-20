# 07-classfile-classloader/04-system-dictionary 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么同一个 Symbol 名字并不天然对应唯一类，以及 SystemDictionary 如何用 initiating loader、dictionary、placeholder、loader constraint 和 dependency 共同把“名字到类”的解析做对

## 1. 选题判断

现稿已经抓到了“同名类在不同加载器下是不同类”和“占位符协调并发”的核心素材，但仍偏流程罗列和组件对比，容易把 `SystemDictionary` 误解成一个单纯的“全局类名哈希表”。

真正的读者困惑是：

**既然 `SymbolTable` 已经保证 `java/lang/String` 这个名字在 VM 里只有一个 Symbol，为什么类解析还不能简单做成“名字 -> 类”的全局映射？JVM 到底拿什么作为一次类解析请求的真正 key？不同 ClassLoader 可以定义同名类，而 loader constraint 又为何能要求某些同名类必须一致？PlaceholderTable、Dictionary 和 dependency 分别在解决哪一种并发/一致性问题？**

## 2. 一句话顿悟

**SystemDictionary 不是一张“全局名字到类”的电话本，而是两层机制：第一层用 initiating loader 对应的 `ClassLoaderData` dictionary 维护“这个加载域里，名字现在指向哪个 `InstanceKlass`”；第二层再用 PlaceholderTable 处理加载中状态、用 LoaderConstraintTable 处理跨 loader 链接一致性、用 protection-domain cache 处理访问授权、用 record_dependency 处理 defining loader 生命周期。名字相同只说明 Symbol 相同，不说明类身份相同。**

## 3. 总图

```text
解析请求
  = (name, initiating loader, protection domain)
  │
  ├─ 规范化名字
  │    ├─ array desc      -> resolve_array_class_or_null
  │    ├─ L...; wrapper   -> 剥壳后 resolve_instance_class_or_null
  │    └─ plain internal  -> resolve_instance_class_or_null
  │
  ├─ initiating loader 的 ClassLoaderData dictionary
  │    ├─ 按 name 查已定义/已发起的类
  │    └─ protection domain 决定当前请求是否可直接使用它
  │
  ├─ PlaceholderTable
  │    ├─ LOAD_SUPER
  │    ├─ LOAD_INSTANCE
  │    └─ DEFINE_CLASS
  │
  ├─ 实际加载结果
  │    ├─ defining loader 可能等于 initiating loader
  │    └─ 也可能不同（委派/非双亲委派）
  │
  ├─ consistency layer
  │    ├─ check_constraints / LoaderConstraintTable
  │    ├─ update_dictionary (发起加载器视图)
  │    └─ validate_protection_domain
  │
  └─ lifetime layer
       └─ record_dependency：保持 defining loader 的 CLD 在 initiating loader 存活期间不被误卸载
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么同一个名字不够定位一个类

目标约 1000 字。

- 从“两个 URLClassLoader 各加载一份 `Shared.class`”的直觉事故开场
- 说明 Symbol 唯一化只解决了“名字字节只存一份”，没有解决“类身份是否相同”
- 提出核心问题：类解析请求真正的 key 是什么
- 引出 initiating loader / defining loader / protection domain 三个不同角色

### 第二节：三个朴素方案为什么都会失败

目标约 1800 字。

至少推演：

1. 全局 `name -> Klass` 映射 → 直接破坏同名不同类的 loader 隔离
2. 每个 loader 只看自己定义过的类 → 委派/initiating loader 看不到由别的 defining loader 返回的类
3. 加载中状态直接塞进 dictionary → “已定义”与“正在定义”混淆，循环加载与并发加载难以区分

引出：
- dictionary 负责“已定义/已可用的类视图”
- placeholder 负责“正在定义中的动作状态”
- constraints / dependency / protection domain 是额外层，不是同一个哈希 key

### 第三节：名字规范化——SystemDictionary 先把“你在找什么类名”说清楚

目标约 1500 字。

- `resolve_or_null` 分三路：array、`L...;` 包装、plain internal name
- 为什么 user loader 最终收到的是外部二进制名 `java.lang.String`，而内部 dictionary 用的是 `java/lang/String`
- 不能把“名字相同”写成“请求相同”
- 解析请求的最小语义单元是规范化后的内部名 + initiating loader

### 第四节：Dictionary——为什么每个 `ClassLoaderData` 都要有自己的类视图

目标约 2000 字（核心拆解层）。

- `Dictionary` 真实类型是 `Hashtable<InstanceKlass*>`，不是 `Hashtable<Symbol*, Klass*>`
- backpointer `_loader_data` 说明它是 per-CLD dictionary
- `Dictionary::find(hash, name, protection_domain)`：先按 name 找 entry，再用 PD set 决定当前请求能否直接用
- `find_class` 与 `find` 的区别：前者不做 PD 检查
- “per-loader dictionary”要精确化成 “per-ClassLoaderData dictionary of initiating view”
- 同名类在不同 loader dictionary 中可以各有一份
- 如果 initiating loader 与 defining loader 不同，同一个 `InstanceKlass` 还会被登记进 initiating loader 的 dictionary

### 第五节：PlaceholderTable——为什么“加载中”必须有独立结构

目标约 2200 字（核心拆解层）。

- `PlaceholderTable` 也是按 `(name, loader_data)` 建 entry，但它存的是 in-progress actions，不是已定义类
- `PlaceholderEntry` 不是单 enum state，而是：
  - `_superThreadQ`
  - `_loadInstanceThreadQ`
  - `_defineThreadQ`
  - `_definer`
  - `_instanceKlass`
- `LOAD_SUPER` 的本质：当前线程的超类解析路径/circularity marker
- `LOAD_INSTANCE`：实例类加载中的协调
- `DEFINE_CLASS`：最终定义 token
- placeholder 可能与 dictionary entry 共存，不要写成“类一定只在其中一张表中存在”
- `SystemDictionary_lock` 保护 placeholder 访问

### 第六节：并发与循环加载——为什么要“查、锁、再查、占位、再查”

目标约 2200 字。

- `resolve_instance_class_or_null` 的真实顺序：
  1. 初始 dictionary.find(name, PD)
  2. 计算 loader lock / placeholder index
  3. 取 loader object lock（非 parallel-capable）
  4. 在 `SystemDictionary_lock` 下 `find_class` 复查
  5. 处理 `LOAD_SUPER`
  6. 处理 `LOAD_INSTANCE` / waiting / bootstrap wait / double_lock_wait
  7. 注册占位后再做最终 `find_class`
  8. `load_instance_class`
  9. cleanup placeholder + notify
  10. 最终 PD 验证
- 同一线程再次看到自己的 `LOAD_SUPER` / `LOAD_INSTANCE` 队列 -> `ClassCircularityError`
- bootstrap / serial loader / parallel-capable loader 三种协调差异
- `double_lock_wait` 为什么存在：某些 loader 破坏了对象锁约定

### 第七节：initiating loader 与 defining loader——为什么一个请求可能得到“别的 loader 定义的类”

目标约 1700 字。

- `load_instance_class` 对 bootstrap 和 Java `ClassLoader.loadClass` 路径的区别
- user loader 返回类后，VM 校验返回类名
- 请求者 loader 与 `k->class_loader()` 不同时，说明是委派/非双亲委派返回的 defining class
- 这时必须做三件事：constraints、dependency、update_dictionary
- 这就是“同一个类可以出现在 initiating loader 的 dictionary 中，但定义者是另一个 loader”的根本含义

### 第八节：LoaderConstraintTable 与 protection domain——一致性和访问授权不是一回事

目标约 2200 字（核心拆解层）。

- `check_constraints` 的两道检查：
  1. 当前 initiating loader dictionary 中是否已存在同名类（重复定义 vs 并行加载同一个结果）
  2. LoaderConstraintTable 的 `check_or_update`
- constraint 的触发来自签名/链接关系，不是“全局同名类一律必须相同”
- `check_or_update` 只在已有约束项时比较/补 class，不负责全局创建所有约束
- protection domain 不是 class identity 的第三个坐标
- `DictionaryEntry` 的 PD set 是“此 initiating loader/PD 是否允许使用该类”的缓存
- `validate_protection_domain` 调 Java `ClassLoader.checkPackageAccess`
- 正确区分：
  - 隔离：dictionary per loader
  - 一致性：LoaderConstraintTable
  - 访问：protection domain cache

### 第九节：`record_dependency`——为什么解析完还要补一条生命周期边

目标约 1200 字。

- 非 parent delegation 场景下，initiating loader 使用 defining loader 的类
- 仅靠普通对象引用图，不足以保证 defining loader CLD 一定在 initiating loader 存活期间保留
- `record_dependency` 只在 GC 无法天然发现的跨 loader 关系上补边
- 它不是“全局强引用定义类加载器”，而是有条件的生命周期保证
- same loader / parent loader / permanent CLD 不需要这条边

### 第十节：误解澄清与收网

目标约 1100 字。

至少回答：

1. Symbol 唯一是否意味着类唯一
2. class identity 是否由 `(loader, name, protection domain)` 三元组决定
3. Dictionary 是否是“全局电话本”
4. PD 不同是否会得到第二个同名类
5. Placeholder 是否只是一个加载中枚举
6. 并行加载是否意味着允许两个不同 `InstanceKlass` 同名共存于同一 loader
7. LoaderConstraintTable 是否为所有同名类建全局约束
8. `record_dependency` 是否让 defining loader 永不卸载

## 5. 失败方案必须写进正文

1. 全局 `name -> Klass` 映射
2. 每个 loader 只记自己定义的类
3. 把“正在定义”和“已经定义”混放进同一 dictionary

## 6. 证据清单

- `systemDictionary.cpp:244-256`：`resolve_or_null`
- `systemDictionary.cpp:264-285`：`resolve_array_class_or_null`
- `systemDictionary.cpp:629-889`：`resolve_instance_class_or_null`
- `systemDictionary.cpp:291-418`：`resolve_super_or_fail`
- `systemDictionary.cpp:1507-1541`：外部名 `ClassLoader.loadClass` 与返回类名校验
- `dictionary.hpp:42-50,117-149`：Dictionary / DictionaryEntry / protection-domain set 语义
- `dictionary.cpp:319-345,348-355`：`find` vs `find_class`
- `classLoaderData.hpp:254-255`：dictionary 保存 initiating view
- `placeholders.hpp:33-37,67-81,104-162,203-252,277-288`：PlaceholderTable / action queues / seen-thread
- `placeholders.cpp:35-50,119-171`：entry 创建、action 注册、移除与共存语义
- `systemDictionary.cpp:657-807`：loader lock / placeholder / waiting / circularity path
- `systemDictionary.cpp:488-525`：`double_lock_wait`
- `systemDictionary.cpp:527-611`：`handle_parallel_super_load`
- `systemDictionary.cpp:1625-1723`：parallel define token (`DEFINE_CLASS`)
- `systemDictionary.cpp:821-845`：initiating loader != defining loader 的 constraints/dependency/update path
- `systemDictionary.cpp:2085-2155`：`check_constraints`
- `loaderConstraints.hpp:58-95`、`loaderConstraints.cpp:189-313`：constraint semantics / `check_or_update`
- `systemDictionary.cpp:2325-2393`：signature/linking 引入的 loader constraints
- `systemDictionary.cpp:429-485,879-891`：`validate_protection_domain` 与 PD cache
- `classLoaderData.cpp:398-450`：`record_dependency`
- `dictionary.cpp:577-597`：initiating loader view 与 defining loader 区分的诊断输出

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- “SystemDictionary” 不是单一全局 name->klass map，而是 per-CLD dictionary + global helper structures
- class identity 主要依赖 initiating loader/name；protection domain 是访问授权缓存维度，不是 identity 组成部分
- placeholder 记录的是 in-progress actions，而不是已定义类或单枚举状态
- `LOAD_SUPER` 的重点是 superclass path/circularity 检查，不是“superclass 本体状态”
- loader constraints 只在相关链接关系上建立，不是全局所有同名类统一
- `record_dependency` 是条件性的 lifecycle edge，不等于永久 pin 住 defining loader
- 不在本篇展开 Java 层双亲委派细节，留给下一篇 `ClassLoader`

## 8. 完成后 review

- 删除代码后能否复述“initiating loader 视图 → placeholder 协调 → defining loader 返回 → constraints/PD/dependency 补一致性”的完整链条
- 是否纠正了“全局电话本”“三元组 identity”“placeholder 单状态”“PD 参与类身份”等误解
- 是否把 Dictionary、PlaceholderTable、LoaderConstraintTable、record_dependency 四层职责真正分开
- 是否说明同名类既可隔离，又可在特定链接关系下被强制一致
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
