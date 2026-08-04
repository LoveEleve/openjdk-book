# 14.3 ResolvedMethodTable —— invokedynamic 的方法解析缓存

> **本文定位**：ResolvedMethodTable 全线——从 JVM 业务作用（invokedynamic / MethodHandles 的性能关键）到 `Hashtable<ClassLoaderWeakHandle, mtClass>` 内部结构、`compute_hash` 四元组设计、`basic_add` + `unlink` + `adjust_method_entries`。这是三个 Table 中最简单的一个——没有 ConcurrentHashTable、没有 auto-rehash、没有 CDS 共享表——但它承载了 JDK 7+ invokedynamic 的性能。
>
> **前置依赖**：[ch09/07 Metaspace 背景知识](../ch09/07-metaspace.md) + [14.1 SymbolTable](01-symbol-table.md) + [14.2 StringTable](02-string-table.md)——已理解 Hashtable 基类、弱引用概念。
>
> **JDK 版本**：本文基于 **JDK 11u** 源码。

---

## 1. ResolvedMethodTable 在 JVM 中的作用

### 1.1 invokedynamic 需要缓存

JDK 7 引入 `invokedynamic` 后，方法解析不再是类加载时一次性完成——`invokedynamic` 的调用目标由 **bootstrap method** 在运行时动态计算。每次调用都重新走 bootstrap 是灾难性的性能退化。

**ResolvedMethodTable 缓存已解析的结果**——`Method*` → `ResolvedMethodName` oop 的映射。下次同一个 `Method*` 来解析，直接从表中返回缓存的 oop，不需要再调用 bootstrap method。

### 1.2 典型场景

| 场景 | Java 代码 | invokedynamic 调用 | 缓存效果 |
|------|----------|-------------------|---------|
| Lambda | `list.forEach(x -> ...)` | `LambdaMetafactory.metafactory()` → 生成 `ResolvedMethodName` | 同一个 lambda 被多次执行——第二次起走缓存 |
| 字符串拼接 | `"a" + obj`（JDK 9+） | `StringConcatFactory.makeConcat()` → 生成 `ResolvedMethodName` | 同一个拼接表达式——缓存命中了 |
| MethodHandles | `MethodHandles.lookup().findVirtual(...)` | `MethodHandleNatives.resolve()` → 生成 `ResolvedMethodName` | 频繁的反射调用——走缓存 |

### 1.3 面试常问

> **"invokedynamic 的性能靠什么保证？"**

答：ResolvedMethodTable 缓存 + `LambdaForm` 编译。第一次调用 invokedynamic 时 bootstrap method 计算目标方法 → 生成 `ResolvedMethodName` → 缓存到 ResolvedMethodTable。后续调用直接从表中取——不再调用 bootstrap。加上 JIT 将 LambdaForm 编译为原生代码后，lambda 的性能与普通方法调用无异。

### 1.4 与其他两个 Table 的定位对比

| | SymbolTable | StringTable | ResolvedMethodTable |
|---|---|---|---|
| 缓存什么 | C++ Symbol* | Java String oop | ResolvedMethodName oop |
| 为什么需要 | 类名/方法名去重 | 字符串常量池 | invokedynamic 性能 |
| 访问频率 | 类加载时（中等） | intern 调用时（低-中） | invokedynamic 每次调用时（高！） |
| entry 数量 | 50K-100K | 1K-50K | 通常几百到几千 |
| 是否能 GC | refcount 管理 | 弱引用 | 弱引用 |

---

## 2. 内部结构

### 2.1 最简实现——普通 Hashtable

```cpp
/* === src/hotspot/share/prims/resolvedMethodTable.hpp === */

class ResolvedMethodTable : public Hashtable<ClassLoaderWeakHandle, mtClass> {
  static ResolvedMethodTable* _the_table;
  static int _oops_removed;  // GC unlink 统计
  static int _oops_counted;
};
```

**没有** `RehashableHashtable`（不需要 rehash）、**没有** `ConcurrentHashTable`（不需要高并发）、**没有** `OopStorage`（弱引用由 `ClassLoaderWeakHandle` 管理）。纯粹就是一个简单的 Hashtable——bucket 数组 + entry 链表。

### 2.2 ResolvedMethodEntry

```cpp
class ResolvedMethodEntry : public HashtableEntry<ClassLoaderWeakHandle, mtClass> {
  oop object()            { return literal().resolve(); }           // 安全读取（保持 alive）
  oop object_no_keepalive() { return literal().peek(); }            // 快速 peek（只在 safepoint 或临时使用）
};
```

`ClassLoaderWeakHandle` 是一个 per-CLD 的弱引用——它内部包含一个指向 `ResolvedMethodName` oop 的弱引用，当 oop 所在类被卸载时自动失效。

### 2.3 创建——`_table_size` = 1007

```cpp
// resolvedMethodTable.hpp:55-57
enum Constants { _table_size = 1007 };

ResolvedMethodTable::ResolvedMethodTable()
  : Hashtable<ClassLoaderWeakHandle, mtClass>(_table_size, sizeof(ResolvedMethodEntry)) { }
```

1007 个 bucket。

---

## 3. compute_hash——CLD 感知的四元组

### 3.1 源码

```cpp
/* === src/hotspot/share/prims/resolvedMethodTable.cpp:81-87 === */

unsigned int ResolvedMethodTable::compute_hash(Method* method) {
  unsigned int hash = method->method_holder()->class_loader_data()->identity_hash();
  hash = (hash * 31) ^ method->klass_name()->identity_hash();
  hash = (hash * 31) ^ method->name()->identity_hash();
  hash = (hash * 31) ^ method->signature()->identity_hash();
  return hash;
}
```

### 3.2 为什么四元组

| 分量 | 作用 | 例子 |
|------|------|------|
| CLD hash | 区分不同 class loader | AppClassLoader vs BootClassLoader |
| klass_name | 区分不同类 | `java/util/ArrayList` vs `java/util/LinkedList` |
| name | 区分不同方法 | `forEach` vs `add` |
| signature | 区分重载方法 | `forEach(Consumer)` vs `add(Object)` |

**为什么需要 CLD hash？** 同一个方法在同一个类中、被不同 class loader 分别加载——ResolvedMethodName 对应的是"哪个 loader 看到的这个方法"，所以 key 必须包含 CLD 身份。

### 3.3 与 SymbolTable hash 的区别

- SymbolTable：hash 仅基于 UTF8 字符串内容（`hash_symbol(name, len)`）
- StringTable：hash = `java.lang.String.hashCode()`（基于字符内容）
- ResolvedMethodTable：hash = 四元组（CLD+klass+name+sig）

因为"已解析的方法"的含义依赖于**谁**解析的——同一个方法名在不同 CLD 下解析到不同目标。

---

## 4. lookup + basic_add——双重检查锁

### 4.1 lookup

```cpp
oop ResolvedMethodTable::lookup(int index, unsigned int hash, Method* method) {
  for (ResolvedMethodEntry* p = bucket(index); p != NULL; p = p->next()) {
    if (p->hash() == hash) {
      oop target = p->object_no_keepalive();  // peek 弱引用
      if (target != NULL && java_lang_invoke_ResolvedMethodName::vmtarget(target) == method) {
        return p->object();  // 安全读取 + keep alive
      }
    }
  }
  return NULL;
}
```

注意 `object_no_keepalive()` vs `object()`：
- `object_no_keepalive()` = `literal().peek()`——快速读弱引用，不保证 gc 安全
- `object()` = `literal().resolve()`——安全读弱引用，保证 gc 期间不被清空
- 查找时用 peek（快），找到后再用 resolve（安全）

### 4.2 basic_add

```cpp
oop ResolvedMethodTable::basic_add(Method* method, Handle rmethod_name) {
  assert_locked_or_safepoint(ResolvedMethodTable_lock);

  unsigned int hash = compute_hash(method);
  int index = hash_to_index(hash);

  // ① double-check：可能有其他线程在持锁前已经添加
  oop entry = lookup(index, hash, method);
  if (entry != NULL) return entry;

  // ② 创建弱引用 + 添加到 bucket 链表
  ClassLoaderWeakHandle w = ClassLoaderWeakHandle::create(rmethod_name);
  ResolvedMethodEntry* p = (ResolvedMethodEntry*) new_entry(hash, w);
  add_entry(index, p);

  return rmethod_name();
}
```

与 SymbolTable 的同款 double-check lock 模式——lock-free 预查（在调用方）→ 持锁 → double-check → add。

### 4.3 find_method——给 invokedynamic 使用的主入口

```cpp
oop ResolvedMethodTable::find_method(Method* method) {
  oop entry = _the_table->lookup(method);  // 无锁预查
  return entry;
}
```

`find_method` 是 lock-free 的——只查不添加。如果返回 NULL，调用方（`LinkResolver` 或 `MethodHandles`）负责调用 `add_method` 持锁添加。

```cpp
oop ResolvedMethodTable::add_method(const methodHandle& m, Handle resolved_method_name) {
  MutexLocker ml(ResolvedMethodTable_lock);
  // 处理 redefineClasses 中可能变旧的方法
  if (method->is_old()) {
    method = holder->method_with_idnum(method->method_idnum());
  }
  method->method_holder()->set_has_resolved_methods();
  return _the_table->basic_add(method, resolved_method_name);
}
```

---

## 5. ClassLoaderWeakHandle——per-CLD 弱引用

`ClassLoaderWeakHandle` 是 HotSpot 内部封装的 per-CLD 弱引用——与 StringTable 的 `WeakHandle<vm_string_table_data>` 不同：

- `WeakHandle<vm_string_table_data>`：全局 OopStorage 管理（StringTable）
- `ClassLoaderWeakHandle`：与 class loader 生命周期绑定——CLD 卸载时自动失效

`ClassLoaderWeakHandle::create(rmethod_name)` 创建一个弱引用指向 `ResolvedMethodName` oop。当 CLD 被 GC 时，OopStorage 自动清空弱引用，ResolvedMethodTable 的 entry 变 dead。

---

## 6. unlink——GC 清理死 entry

### 6.1 清理流程

```cpp
void ResolvedMethodTable::unlink() {
  _oops_removed = 0;
  _oops_counted = 0;
  for (int i = 0; i < _the_table->table_size(); ++i) {
    ResolvedMethodEntry** p = _the_table->bucket_addr(i);
    ResolvedMethodEntry* entry = _the_table->bucket(i);
    while (entry != NULL) {
      _oops_counted++;
      oop l = entry->object_no_keepalive();
      if (l != NULL) {
        p = entry->next_addr();         // 活着——保留
      } else {
        _oops_removed++;
        entry->literal().release();      // 释放弱引用
        *p = entry->next();              // 从链表中摘除
        _the_table->free_entry(entry);   // 释放 entry 内存
      }
      entry = (ResolvedMethodEntry*)make_ptr(*p);  // 继续下一个
    }
  }
}
```

与 SymbolTable unlink 的区别：
- SymbolTable：检查 `Symbol::refcount() == 0`（引用计数）
- ResolvedMethodTable：检查 `literal().peek() == NULL`（弱引用已死）

### 6.2 触发时机

GC 后的 safepoint 中——与 SymbolTable unlink 同时。由 `SystemDictionary` 的 GC 路径触发。

---

## 7. adjust_method_entries——RedefineClasses 支持

### 7.1 问题

JVMTI 的 `RedefineClasses` 可以运行时替换类的字节码——替换后旧方法被标记为 `is_old()`。ResolvedMethodTable 中缓存了旧方法的 `ResolvedMethodName`——需要更新为新方法。

### 7.2 实现

```cpp
void ResolvedMethodTable::adjust_method_entries(bool * trace_name_printed) {
  assert(SafepointSynchronize::is_at_safepoint(), "only called at safepoint");
  for (int i = 0; i < _the_table->table_size(); ++i) {
    for (ResolvedMethodEntry* entry = _the_table->bucket(i);
         entry != NULL; entry = entry->next()) {
      oop mem_name = entry->object_no_keepalive();
      if (mem_name == NULL) continue;                    // 已死——跳过

      Method* old_method = (Method*)mem_name_holder->vmtarget(mem_name);
      if (old_method->is_old()) {
        Method* new_method;
        if (old_method->is_deleted()) {
          new_method = Universe::throw_no_such_method_error();  // 方法已删——替换为 throw NSME
        } else {
          new_method = old_method->get_new_method();             // 方法已替换——用新方法
        }
        ResolvedMethodName::set_vmtarget(mem_name, new_method);
      }
    }
  }
}
```

遍历所有 entry → 检查 `is_old()` → 替换为 `get_new_method()` 或 NSME。仅在 safepoint 中执行——保证遍历期间没有并发修改。

---

## 8. 诊断——无独立 jcmd 命令

与 SymbolTable 和 StringTable 不同，JDK 11 没有 `jcmd VM.resolved_method_table` 命令。可以通过以下间接方式观测：

- **JFR** `jdk.ClassLoaderStatistics`：每 ~1s 采集 per-CLD chunkSize/blockSize，含 `_block_sz`（含 ResolvedMethodName 对象）
- **jcmd VM.metaspace show-loaders**：每个 CLD 的 Class 空间的 used（含 ResolvedMethodName 对象）
- 源码中的 `log_debug(membername, table)` 日志：`-Xlog:membername+table=debug` 可以观察 entry 的 insert/remove

---

## 9. 三个 Table 总结

```
SymbolTable             StringTable              ResolvedMethodTable
──────────────────────────────────────────────────────────────────────
Hashtable              ConcurrentHashTable       Hashtable (最简单)
+ Arena                + OopStorage              1007 buckets
refcount GC            弱引用 GC                 弱引用 GC
互斥锁                 无锁读 + CAS 写            互斥锁
支持 rehash (换hash)    自动 rehash (扩容)        不支持 rehash
CDS 共享表              CDS 共享表               无 CDS
~20011 buckets         ~65536 buckets            ~1007 buckets
~50K entries           ~1K-50K entries           ~几百-几千 entries
类名/方法名去重         字符串常量池               invokedynamic 缓存

诊断: jcmd symboltable   诊断: jcmd stringtable    诊断: 无独立命令 (JFR间接)
```

下一篇（14.4）对比三个 Table 的 CDS 差异、锁模型和生命周期。
