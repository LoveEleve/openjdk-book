# 13.1 LatestMethodCache —— 6 个单槽方法缓存

> **本文定位**：`LatestMethodCache` 全线——为什么类还没加载就创建 6 个空缓存、`init()` 启动填充 + `get_method()` 快速查找、`method_idnum` 而非 `Method*` 保证 RedefineClasses 安全、为什么单槽即最优。
>
> **前置依赖**：[ch09/07 Metaspace 背景知识](../ch09/07-metaspace.md)——理解 Method*、Klass*、`method_idnum`。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码。

---

## 0. 它是什么——JVM 内部调用 Java 方法的加速通道

### 0.1 问题：C++ 侧要高频调用几个固定 Java 方法

JVM 的 C++ 代码（GC、类加载、栈回溯、权限检查）经常需要调用特定的 Java 方法：

```
GC 分配带 finalize() 的对象时 → 要调 java.lang.ref.Finalizer.register(Object)
类加载时                  → 要调 java.lang.ClassLoader.addClass(Class)
栈回溯时                  → 要调 java.lang.StackStreamFactory$AbstractStackWalker.doStackWalk(...)
```

朴素做法是每次现查——用方法名和签名在 Klass[^1] 的方法数组里逐个比对，找到对应的 `Method*`[^1]。这是 **O(n) 的数组遍历 + 字符串比较**，而这些方法调用频率极高（每个带 finalize 的对象一次、每个类一次、每次栈回溯一次）。

[^1]: `Klass` 是 HotSpot 中"类"的元数据对象（Java 类的内部表示，存在 Metaspace），`Method*` 是"方法"的元数据对象。关于 Klass 类体系（InstanceKlass、ArrayKlass 等）及其相关结构的完整讲解在后续文章中展开，此处只需知道"类有方法数组、方法可以用名字+签名查到"即可。

### 0.2 解法：启动时查一次，运行时 O(1) 取回

`LatestMethodCache` 就是为这 6 个"高频、固定"的 Java 方法准备的**单槽缓存**：

```
朴素方案（每次调用现查）:
  方法名+签名 → Klass::find_method → Method*
  ↑ 每次调用都是 O(n) 的方法数组扫描 + 字符串比较

LatestMethodCache 方案:
  启动时: find_method 查一次 → init(klass, idnum)   ← 一次性成本
  运行时: get_method() → method_with_idnum(idnum)   ← O(1) 数组下标
```

### 0.3 使用模式——一行拿到 Method* 直接调用

调用方（如 `InstanceKlass::register_finalizer`，instanceKlass.cpp:1235-1236）的用法：

```cpp
methodHandle mh (THREAD, Universe::finalizer_register_method());  // 一行取缓存
JavaCalls::call(&result, mh, &args, CHECK_NULL);                  // 直接调 Java 方法
```

`Universe::finalizer_register_method()` 只是 `_finalizer_register_cache->get_method()` 的静态封装（universe.hpp:331）。**调用方无感知**——它拿到的是和现查完全一样的 `Method*`，只是不用每次付出查找成本。

### 0.4 为什么是"6 个"

只有 JVM 内部**自己需要高频调用**、且**方法固定不变**的 Java 方法才值得缓存：

```
哪些方法入选（universe.cpp:953-987 逐个硬编码）:
  GC 路径:  Finalizer.register
  类加载:   ClassLoader.addClass
  安全:     ProtectionDomain.impliesCreateAccessControlContext
  异常:     Unsafe.throwIllegalAccessError / throwNoSuchMethodError
  栈回溯:   AbstractStackWalker.doStackWalk
```

选型标准：调用频率高 + 候选方法唯一（第 5 节展开）——这两条不满足的 Java 方法不走缓存，运行时正常解析。

---

## 1. 为什么类还没加载就创建缓存

### 1.1 创建时机

在 `universe_init()`（`universe.cpp:713-720`）中，堆刚建好、null ClassLoaderData 刚初始化——类**还没有**被加载：

```cpp
// We have a heap so create the Method* caches before
// Metaspace::initialize_shared_spaces() tries to populate them.
Universe::_finalizer_register_cache = new LatestMethodCache();
Universe::_loader_addClass_cache    = new LatestMethodCache();
Universe::_pd_implies_cache         = new LatestMethodCache();
Universe::_throw_illegal_access_error_cache = new LatestMethodCache();
Universe::_throw_no_such_method_error_cache = new LatestMethodCache();
Universe::_do_stack_walk_cache = new LatestMethodCache();
```

每个 `new LatestMethodCache()` 创建的是一个**空壳**：

```cpp
LatestMethodCache() { _klass = NULL; _method_idnum = -1; }
```

`_klass=NULL` 表示"还没有缓存任何类的方法"。`_method_idnum=-1` 是无效 ID。

### 1.2 为什么不等类加载后再创建

源码注释（universe.cpp:712-713）给出了直接原因：

```cpp
// We have a heap so create the Method* caches before
// Metaspace::initialize_shared_spaces() tries to populate them.
```

**原因：CDS 时序**。CDS 加载（`MetaspaceShared::initialize_shared_spaces()`）会通过 `serialize()`（universe.hpp:67-69）把 `_klass` 反序列化填充进这些缓存——因此缓存对象必须先于 CDS 加载存在。非 CDS 场景（默认）下，缓存由 `universe_post_init()` → `initialize_known_methods()` 填充（§2.2）。

> CDS 本身（dump/load 机制、共享归档格式）不在本书讲解范围——面试/生产使用率低，此处只需知道"缓存必须先于 CDS 加载创建"这一时序约束。

---

## 2. 内部机制

### 2.1 两个字段

```cpp
/* === src/hotspot/share/memory/universe.hpp === */

class LatestMethodCache : public CHeapObj<mtClass> {
  Klass*  _klass;         // 缓存的是哪个类的方法
  int     _method_idnum;  // 该方法的 ID（不是 Method* 指针！）
};
```

这个缓存记录的内容是"**哪个类的哪个方法**"——由 `_klass`（类）+ `_method_idnum`（方法 ID）两个字段共同标识。注意：**这不是 hash 表，也不是多条目缓存**——整个对象只有这一对字段（单槽），没有条目数组、没有 hash 计算、没有多槽竞争。为什么单槽就够了（§5），为什么不直接存 `Method*` 指针（§3）。

### 2.2 init()——首次使用时填充

```cpp
/* === src/hotspot/share/memory/universe.cpp:1333-1346（简化展示核心逻辑） === */

void LatestMethodCache::init(Klass* k, Method* m) {
  _klass = k;                       // 记录方法所属的类
  _method_idnum = m->method_idnum(); // 记录方法的 ID
}
```

核心逻辑：存 `_klass`、从传入的 `Method*` 上取 ID 存 `_method_idnum`。

**谁调 init()？** `universe_post_init()` → `initialize_known_methods()`（universe.cpp:953-987）。

`universe_post_init()` 是 JVM 初始化主流程 `init_globals()`（init.cpp:141）的一部分，位于 `universe_init()` 之后、`compileBroker_init()` 之后：

```
init_globals()（init.cpp:101）
├─ universe_init()              ← 创建堆、6 个缓存空壳（ch10 主线）
├─ interpreter_init() / 编译器相关
├─ universe2_init()             ← 加载原始类（注释："loads primordial classes"）
├─ compileBroker_init()
├─ universe_post_init()         ← 填充缓存：initialize_known_methods()
└─ stubRoutines_init2()
```

源码注释要求它必须晚于编译器初始化：

```cpp
// Initialization after compiler initialization
bool universe_post_init();  // must happen after compiler_init
```

**为什么必须这么晚？** `initialize_known_methods()` 需要 Finalizer、ClassLoader 等核心类**已加载并链接**，而类加载依赖解释器和编译器（compileBroker）先就绪。于是"创建"和"填充"天然分成两段：

```
universe_init：       创建空壳（类还没加载，只能 new 空对象）
        ↓ 中间隔着解释器、编译器、类加载阶段
universe_post_init：  填充缓存（核心类已加载，能查到 Method*）
```

创建只需要 C 堆可用；填充必须等类加载完成——这就是"空壳创建 + 延迟填充"两段式的完整原因链。

`initialize_known_method` 内部用 `link_class_or_fail` 确保类已链接，对应的 `Method*` 可查找。

辅助函数 `initialize_known_method`（universe.cpp:932-951）封装了"链接类 → 查找方法 → init 缓存"的通用模式（`Symbol` 是方法名/签名的内部表示，此处只需知道它是"方法名字符串"即可）：

```cpp
void initialize_known_method(LatestMethodCache* method_cache,
                             InstanceKlass* ik,
                             const char* method,
                             Symbol* signature,
                             bool is_static, TRAPS) {
  TempNewSymbol name = SymbolTable::new_symbol(method, CHECK);   // 方法名 → 内部 Symbol
  Method* m = NULL;
  // The klass must be linked before looking up the method.
  if (!ik->link_class_or_fail(THREAD) ||                          // ① 类必须已链接
      ((m = ik->find_method(name, signature)) == NULL) ||         // ② 按名字+签名找方法
      is_static != m->is_static()) {                              // ③ 静态性必须匹配
    vm_exit_during_initialization(...);                           // 任一失败 = JVM 无法启动
  }
  method_cache->init(ik, m);
}
```

注意 `is_static` 参数——6 个缓存中，`_finalizer_register_cache` 和两个 Unsafe 异常方法是 `is_static=true`，`addClass` / `impliesCreateAccessControlContext` / `doStackWalk` 是 `is_static=false`（实例方法）。查找时连静态性都校验，防止链接错方法。

### 2.3 get_method()——快速查找

`get_method()` 三步，正常路径都是 O(1)：

```cpp
Method* LatestMethodCache::get_method() {
  if (klass() == NULL) return NULL;           // ① 还没被 init——返回 NULL
  InstanceKlass* ik = InstanceKlass::cast(klass());
  Method* m = ik->method_with_idnum(method_idnum());  // ② + ③
  assert(m != NULL, "sanity check");
  return m;
}
```

① `_klass == NULL` 检查——O(1)。

② `method_with_idnum(idnum)` 内部实现（`instanceKlass.cpp:3964-3980`）：

```cpp
Method* InstanceKlass::method_with_idnum(int idnum) {
  Method* m = NULL;
  // 快速路径：idnum 直接作为数组下标
  if (idnum < methods()->length()) {
    m = methods()->at(idnum);        // O(1) 数组下标
  }
  // 退回路径：idnum != 下标时线性扫描（redefine 后可能发生）
  if (m == NULL || m->method_idnum() != idnum) {
    for (int index = 0; index < methods()->length(); ++index) {
      m = methods()->at(index);
      if (m->method_idnum() == idnum) return m;   // O(n) 线性扫描
    }
    return NULL;
  }
  return m;
}
```

正常路径（无 redefine）：`idnum == 数组下标` → 一次 `at()` 返回——O(1)。redefine 后如果 idnum 被重新分配导致下标错位，走线性扫描 fallback——O(n)。但由于 redefine 极少发生，实际运行时几乎总是 O(1) 快速路径。

### 2.4 运行时调用模式

**init() 只在启动时调用一次**（`universe_post_init()` → `initialize_known_methods()`），运行时没有调用方会调 init()。运行时的调用模式是：

```
启动时（universe_post_init）:
  initialize_known_methods() → 6 个缓存全部 init() → _klass 非 NULL，_method_idnum 就绪

运行时（如 InstanceKlass::register_finalizer）:
  Universe::finalizer_register_method() → get_method() → 直接返回有效 Method* → JavaCalls::call
```

`get_method()` 返回 NULL 的唯一场景是缓存未被 init。正常启动流程（`universe_post_init` 全部成功，失败则 `vm_exit_during_initialization`）之后不会发生；这是为 **bootstrapping 期间**的防御性检查——例如 `jvm.cpp:1171-1177` 的 `is_authorized`：

```cpp
// For bootstrapping, if pd implies method isn't in the JDK, allow
// this context to revert to older behavior.
if (Universe::protection_domain_implies_method() == NULL) {
  return true;
}
```

---

## 3. 为什么用 idnum 不用 Method* 指针

这是 LatestMethodCache 设计的核心考量。

### 3.1 Method* 指针的问题

`Method*` 是一个指针——指向 Metaspace 中 Method 对象的地址。当 JVMTI 的 `RedefineClasses` 替换类的方法时：

1. 旧方法对象被标记为 `is_old()`
2. 新方法对象被创建（**不同的地址**）
3. 新方法**继承旧方法的 `method_idnum`**

如果缓存存的是 `Method*` 指针，redefine 后它指向旧对象（`is_old() == true`）——调用会得到过期的方法。

### 3.2 idnum 的解决方案

redefine 时，**idnum 值不变，但持有它的 Method* 对象换了**。jvmtiRedefineClasses.cpp:966 有显式代码保证这一点：

```cpp
// Take current and original idnum from the old_method
k_new_method->set_method_idnum(old_num);
```

新方法被强制赋予旧方法的 idnum。`method_with_idnum(idnum)` 在 InstanceKlass 内部按 idnum 查找——总是返回当前有效版本（新地址的 Method*）。

```cpp
// redefine 前:
_klass = Finalizer_klass（示例：任意持有者类）
_method_idnum = 5
→ get_method() → Finalizer_klass->method_with_idnum(5) → old_Method* (地址 0x1000)

// redefine 后:
_klass = Finalizer_klass (不变)
_method_idnum = 5 (不变)
→ get_method() → Finalizer_klass->method_with_idnum(5) → new_Method* (地址 0x2000) ← 不同地址，但 idnum 相同
```

缓存不用更新——idnum 不变，`method_with_idnum` 自动返回持有该 idnum 的最新 Method 对象。

---

## 4. 6 个缓存逐一讲解

### 4.1 `_finalizer_register_cache`

```
缓存方法: java.lang.ref.Finalizer.register(Object)
init 时机: universe_post_init(), Finalizer 类链接后
调用场景: 分配带 finalize() 的对象时立即注册到 Finalizer 队列
          （instanceKlass.cpp:1248 allocate_instance → register_finalizer；
           RegisterFinalizersAtInit 关闭时走此路径）
频率:     每个带 finalize() 的对象 1 次
```

### 4.2 `_loader_addClass_cache`

```
缓存方法: java.lang.ClassLoader.addClass(Class)
init 时机: universe_post_init(), ClassLoader 类链接后
调用场景: 类加载时，若 class_loader != NULL（非 bootstrap），把新类记录进
          ClassLoader 的类向量（systemDictionary.cpp:1586-1597）
          ——JVMTI FollowReferences 需要从 ClassLoader 找到它加载的所有类
频率:     每个非 bootstrap 加载的类 1 次
```

### 4.3 `_pd_implies_cache`

```
缓存方法: java.security.ProtectionDomain.impliesCreateAccessControlContext()
init 时机: universe_post_init(), ProtectionDomain 类链接后
调用场景: SecurityManager 下创建 AccessControlContext 时，用
          pd.implies(new SecurityPermission("createAccessControlContext"))
          检查授权（jvm.cpp:1186-1193）
频率:     启用 SecurityManager 时——permission check 频率
```

### 4.4 `_throw_illegal_access_error_cache`

```
缓存方法: jdk.internal.misc.Unsafe.throwIllegalAccessError()
init 时机: universe_post_init(), Unsafe 类链接后
调用场景: invokeinterface 的 itable 槽位解析到非 public 实现方法时，槽位填入
          此"抛异常方法"（klassVtable.cpp:1235-1238）
频率:     类初始化 itable 时——仅当接口方法实现非 public
```

### 4.5 `_throw_no_such_method_error_cache`

```
缓存方法: jdk.internal.misc.Unsafe.throwNoSuchMethodError()
init 时机: universe_post_init(), Unsafe 类链接后
调用场景: ① MethodHandle 引用的方法被 redefine 删除后，ResolvedMethodTable
          用此方法替换（resolvedMethodTable.cpp:137）
          ② redefine 后失效的 jmethodID 指向此方法（jvmtiRedefineClasses.cpp:3530）
频率:     redefine 删除方法 / jmethodID 失效时
```

### 4.6 `_do_stack_walk_cache`

```
缓存方法: java.lang.StackStreamFactory$AbstractStackWalker.doStackWalk(long, int, int, int)
          —— 签名 (JIIII)Ljava/lang/Object;（vmSymbols.hpp:336）
init 时机: universe_post_init(), AbstractStackWalker 类链接后
调用场景: StackWalker.walk() 内部——JVM 遍历栈帧填入数组后，回调此方法
          让 Java 侧消费帧数据（stackwalk.cpp:409-424）
频率:     栈回溯时——可能频繁
```

---

## 5. 为什么 1 个槽就够了

6 个缓存各自服务于一个**固定领域**：

```
_finalizer_register_cache:      只缓存 Finalizer.register → 永远不换
_loader_addClass_cache:         只缓存 ClassLoader.addClass → 永远不换
_pd_implies_cache:              只缓存 ProtectionDomain.impliesCreateAccessControlContext → 永远不换
_throw_illegal_access_error_cache: 只缓存 Unsafe.throwIllegalAccessError → 永远不换
_throw_no_such_method_error_cache: 只缓存 Unsafe.throwNoSuchMethodError → 永远不换
_do_stack_walk_cache:           只缓存 AbstractStackWalker.doStackWalk → 永远不换
```

每个缓存的"候选方法"只有 1 个——启动时 init 一次，之后 get_method() 永远返回该方法的最新版本，不存在多方法竞争。**单槽即最优**。

这就是为什么叫 `LatestMethodCache` 而不是 `MethodCache`——"latest" 暗示"缓存最新版本"，但实际上对它来说"只有这一个版本"。

---

## 6. 小结

```
LatestMethodCache 三个设计亮点:

1. 空壳创建 + 启动填充: _klass=NULL 表示"还没就绪"，universe_post_init 统一 init
2. idnum 代替 Method*: redefine 后缓存自动有效——不需要更新
3. 单槽即最优: 每个缓存只服务一个固定方法，运行时只读不改

六个缓存覆盖了 JVM 内部高频调用的 Java 方法:
  - finalizer 注册、类加载 addClass、保护域 impliesCreateAccessControlContext
  - 两个异常抛出方法（Unsafe）
  - 栈回溯回调

成本: 6 × (8 bytes _klass + 4 bytes _method_idnum) ≈ 72 bytes
收益: 每次调用节省 O(n) 的方法查找（n=类的方法数）
```

本文是当前卷 `universe_init()` 主线讲解的最后一篇——后续主题（解释器初始化、模板表、stubs、符号表、Metaspace 诊断）已归档至 `vol-01/archived/`。
