# ch11 LatestMethodCache 写作规划

## ch11 目标

读者读完本篇后能回答以下核心问题：

1. **`LatestMethodCache` 为什么在类还没加载时就创建？** ——它是延迟缓存：`universe_init` 时创建空壳（`_klass=NULL`），首次使用时通过 `init()` 填充，之后 `get_method()` 走快速查找
2. **为什么用 `method_idnum` 而不是直接存 `Method*` 指针？** ——因为 RedefineClasses 可能替换方法对象。用 idnum + `method_with_idnum()` 确保总是拿到最新版本的 Method
3. **6 个缓存各自解决什么问题？** ——分别缓存 finalizer 注册、类加载器 addClass、保护域 implies、非法访问/无此方法异常抛出、栈回溯回调
4. **为什么 1 个槽就够了？** ——这 6 个场景各自对应的类和方法是固定的（Object、ClassLoader、ProtectionDomain 等），不存在竞争——1 槽命中率接近 100%

**不要求掌握的**（源码细节，查源码即可）：
- `method_with_idnum` 的内部实现（线性搜索 vs 二分） / CDS 序列化机制细节

---

## 定位：universe_init 中的 6 个最新方法缓存

ch09-ch10 讲完了堆初始化。ch11 承接 `universe_init` 中的 6 个 `LatestMethodCache` 创建——位于 `ClassLoaderData::init_null_class_loader_data()` 之后、`MetaspaceShared::initialize_shared_spaces()` 之前（`universe.cpp:713-720`）。

源码注释说得很清楚：
```cpp
// We have a heap so create the Method* caches before
// Metaspace::initialize_shared_spaces() tries to populate them.
```

**这些类还没有加载**——`LatestMethodCache` 在此时的角色是"预留槽位"，等类加载完成后被填充。

---

## 理解顺序

```
读者的疑问：类都没加载，缓存什么？

  ↓ 回答：
  (1) LatestMethodCache 是什么 → _klass + _method_idnum 两个字段
  (2) init() 怎么工作 → 首次使用时填充 _klass + _method_idnum
  (3) get_method() 怎么工作 → klass->method_with_idnum(cached_idnum)
  (4) 为什么用 idnum 不用 Method* → RedefineClasses 安全性
  (5) 6 个缓存各自的作用 → 逐一讲解
  (6) 1 槽够用吗？ → 统计证明 + 面试常问
```

---

## 文章结构（1 篇）

### 01 — 全部 6 个缓存

- [ ] **01-latest-method-cache.md**
  | 定位: LatestMethodCache 全线——机制 + 6 个场景

  **Section 1. 为什么类没加载就创建缓存**（回答核心疑问）
  - 创建时机：`universe_init` 中 `new LatestMethodCache()` → `_klass=NULL, _method_idnum=-1`
  - 为什么此时创建：缓存需要在方法首次被调用前就存在——之后 `javaClasses.cpp` 在类链接阶段填充它们，如果缓存不存在就无法初始化。且此时堆已就绪（`Method*` 分配需要堆），是创建 CHeapObj 子类的最早可行时机
  - 延迟填充：类链接完成时通过 `init(klass, method)` 填充

  **Section 2. 内部机制**
  - 两个字段：`_klass`（哪个类）+ `_method_idnum`（哪个方法 ID）
  - `init(Klass* k, Method* m)`：`_klass = k` + `_method_idnum = m->method_idnum()`
  - `get_method()`：`klass->method_with_idnum(_method_idnum)` → 总是最新 Method
  - RedefineClasses 安全：`method_with_idnum` 返回替换后的新方法（idnum 在 redefine 后保持不变，新方法继承旧 idnum）
  - `get_method()` 首先检查 `_klass == NULL` → 说明还没被 init 过（首次使用前），返回 NULL 让调用方走完整查找路径

  **Section 3. 为什么用 idnum 不用 Method* 指针**
  - RedefineClasses 替换方法时旧 Method* 可能变成 `is_old()` 或 `is_deleted()`
  - idnum 在 redefine 后保持不变（新方法继承 idnum）
  - `method_with_idnum(idnum)` → 总是返回当前有效的 Method*
  - 这是 LatestMethodCache 设计的核心考虑之一

  **Section 4. 6 个缓存逐一讲解**

  缓存从"空壳创建"到"首次填充"的时间线——谁在什么时候调 `init()`：

  | 缓存 | `init()` 调用位置 | 触发时机 |
  |------|-----------------|---------|
  | `_finalizer_register_cache` | `javaClasses.cpp` 中 `Finalizer_klass` 链接完成时 | 类链接阶段 |
  | `_loader_addClass_cache` | `javaClasses.cpp` 中 `ClassLoader_klass` 链接完成时 | 类链接阶段 |
  | `_pd_implies_cache` | `javaClasses.cpp` 中 `ProtectionDomain_klass` 链接完成时 | 类链接阶段 |
  | `_throw_illegal_access_error_cache` | 同 `Unsafe_klass` 链接 | 类链接阶段 |
  | `_throw_no_such_method_error_cache` | 同 `Unsafe_klass` 链接 | 类链接阶段 |
  | `_do_stack_walk_cache` | `javaClasses.cpp` 中 `StackWalker` 相关类链接完成时 | 类链接阶段 |

  关键时间线：`universe_init` 创建空壳 → 类加载完成 → `javaClasses.cpp` 确认类已链接 → `init(klass, method)` 填充缓存 → 之后 `get_method()` 走快速路径

  **Section 5. 为什么 1 个槽就够了**

  - 缓存的 key 是类 + 方法——对于这 6 个场景，调用的类和方法是**固定的**：
    `_finalizer_register_cache` 永远缓存 `Object.registerFinalizer`，
    `_loader_addClass_cache` 永远缓存 `ClassLoader.addClass`，等等
  - 不存在"同一个缓存里不同类的方法竞争"的问题
  - 每个缓存只服务于一个特定的方法调用点
  - **1 槽命中率 ≈ 100%**——首次 miss 后全命中了

  **Section 6. 测试验证**
  - 用 GDB/print 检查缓存初始状态（NULL, -1）
  - 首次调用后检查缓存是否被填充
  - 验证 `get_method()` 返回值

---

## 写作进度

| 篇 | 状态 | 日期 |
|----|------|------|
| 01 | — | — |

---

## 与前后章节的连接

```
ch09-ch10 堆初始化 --→ ch11 LatestMethodCache
                       |
                       +- 6 个单槽缓存
                       +- 延迟填充 + idnum 安全
                       +- 1 槽命中的统计证据

                       ↓
                   interpreter_init（已归档）
```
