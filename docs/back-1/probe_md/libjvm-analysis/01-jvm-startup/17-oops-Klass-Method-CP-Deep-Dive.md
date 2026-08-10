# Oops 层核心 — Klass/Method/ConstantPool 完整字段

> OpenJDK 11 slowdebug, GDB 验证
> Klass(208B, 20字段) → InstanceKlass(472B, 38字段) + Method(104B, 12字段) + ConstantPool(72B, 8字段)

---

## 零、GDB 验证

```
Klass         = 208    InstanceKlass = 472    Method     = 104
ConstantPool  = 72     ConstMethod   = 56     markOopDesc = 16
oopDesc       = 16     HeapWord      = 8
```

---

## 一、oop-Klass 二分模型 — 为什么分开？

```
Java 对象 = oop(对象头+字段) + Klass(元数据)

  oop:    每个实例一份，存运行时数据
  Klass:  所有同类型实例共享一份，存"类是什么"

new Object() → oop:   markOop(8B) + Klass*(4B压缩) = 12B
                Klass: InstanceKlass(472B) — 全局唯一！
```

**为什么不用单对象模型（像 Go struct embedding）？** → 一个类的元数据（方法表、字段偏移、常量池）通常远大于实例数据（int、reference）。共享 Klass 让每实例开销极小（12B），适合百万级对象。

---

## 二、Klass (208B, 20 字段) — 所有类型的基类

| 字段 | 类型 | 作用 |
|------|------|------|
| `_layout_helper` | jint | 编码类型：InstanceKlass / ArrayKlass / TypeArrayKlass |
| `_name` | Symbol* | 类全名 "java/lang/Object" |
| `_access_flags` | AccessFlags | public / abstract / interface / ... |
| `_super` | Klass* | 父类 |
| `_subklass` | Klass* | 第一个子类 |
| `_next_sibling` | Klass* | 同级下一个子类 |
| `_next_link` | Klass* | 链接链表 |
| `_java_mirror` | OopHandle | java.lang.Class 对象 ← `Object.getClass()` 返回 |
| `_super_check_offset` | juint | 快速类型检查偏移 |
| `_secondary_super_cache` | Klass* | 辅助父类缓存 |
| `_secondary_supers` | Array<Klass*>* | 辅助父类列表 |
| `_primary_supers[8]` | Klass*[8] | 主父类数组 |
| `_modifier_flags` | jint | Class.getModifiers() 返回值 |
| `_class_loader_data` | ClassLoaderData* | 所属 ClassLoader |
| `_prototype_header` | markOop | 偏向锁原型头 |
| `_biased_lock_revocation_count` | jint | 偏向锁撤销计数 |
| `_vtable_len` | int | 虚表长度 |
| `_last_biased_lock_bulk_revocation_time` | jlong | 批量撤销时间戳 |

**为什么需要 `_secondary_supers`？** → Java 单继承 + 多接口。检查 `obj instanceof Map` 时，Map 不在主继承链上。`_secondary_supers` 缓存接口列表，加速 instanceof 检查。

---

## 三、InstanceKlass (472B, 38 字段) — Java 类的完整元数据

继承 Klass 的 20 字段 + 自身 38 字段 = ~58 字段。

### 3.1 类标识 (6 字段)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_this_class_index` | u2 | 常量池中自己类索引 |
| `_minor_version` | u2 | class 文件小版本号 |
| `_major_version` | u2 | class 文件大版本号（55=Java11） |
| `_init_state` | u1 | 初始化状态： loaded→linked→being_initialized→fully_initialized |
| `_reference_type` | u1 | 引用类型：NONE/REF_SOFT/REF_WEAK/REF_PHANTOM/REF_FINAL |
| `_misc_flags` | u2 | 位标志集合：rewritten/has_nonstatic_fields/should_verify_class/is_anonymous/... |

### 3.2 方法 + 字段 + 常量池 (8 字段)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_methods` | Array<Method*>* | **方法数组** — 所有声明的方法 |
| `_default_methods` | Array<Method*>* | 接口默认方法 |
| `_fields` | Array<u2>* | **字段数组** — access+name+sig+offset |
| `_constants` | ConstantPool* | 常量池 |
| `_method_ordering` | Array<int>* | 方法原始顺序（JVMTI 需要） |
| `_default_vtable_indices` | Array<int>* | 默认方法 vtable 索引 |
| `_nonstatic_field_size` | int | 非静态字段总大小（words） |
| `_static_field_size` | int | 静态字段总大小（words） |

### 3.3 接口 + 继承 (3 字段)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_local_interfaces` | Array<Klass*>* | 直接实现的接口 |
| `_transitive_interfaces` | Array<Klass*>* | 传递实现的接口（包含父类接口） |
| `_itable_len` | int | itable 长度（words） |

### 3.4 内部类 + 注解 (3 字段)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_inner_classes` | Array<jushort>* | InnerClasses 属性 |
| `_annotations` | Annotations* | 类注解 |
| `_source_file_name_index` | u2 | 源文件名 CP 索引 |

### 3.5 包/模块 + 数组 (4 字段)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_package_entry` | PackageEntry* | 所属包 |
| `_array_name` | Symbol* | 数组类名 "[Ljava/lang/Object;" |
| `_array_klasses` | Klass* volatile | 元素类 Klass |
| `_source_debug_extension` | const char* | 调试扩展（SMAP） |

### 3.6 JNI/JVMTI (5+ 字段, 条件编译)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_jni_ids` | JNIid* | JNI 静态字段 ID |
| `_methods_jmethod_ids` | jmethodID* | JNI 方法 ID 缓存 |
| `_idnum_allocated_count` | volatile u2 | 方法 ID 分配计数 |
| `_breakpoints` | BreakpointInfo* | 断点列表 |
| `_previous_versions` | InstanceKlass* | 重定义前的版本链表 |

### 3.7 性能 + 编译 (5 字段)
| 字段 | 类型 | 作用 |
|------|------|------|
| `_dep_context` | intptr_t | 依赖追踪位图 |
| `_init_thread` | Thread* | 初始化线程（递归初始化检测） |
| `_oop_map_cache` | OopMapCache* | OopMap 缓存（根扫描用） |
| `_osr_nmethods_head` | nmethod* | OSR nmethod 链表 |
| `_is_marked_dependent` | bool | 依赖标记（去优化用） |

---

## 四、Method (104B, 12 字段) — 方法的元数据

| 字段 | 类型 | 作用 |
|------|------|------|
| `_constMethod` | ConstMethod* | 字节码/异常表/行号表 |
| `_method_data` | MethodData* | profiling 数据（触发 JIT 用） |
| `_method_counters` | MethodCounters* | 调用计数器 |
| `_access_flags` | AccessFlags | public/static/final/native/... |
| `_vtable_index` | int | **虚表索引**（≥0=vtable，<0=itable） |
| `_intrinsic_id` | u2 | 内联函数 ID（0=none, 1=_hashCode, ...） |
| `_flags` | mutable u2 | caller_sensitive/force_inline/dont_inline/hidden |
| `_from_compiled_entry` | volatile address | 编译入口点 |
| `_from_interpreted_entry` | volatile address | 解释入口点 |
| `_code` | CompiledMethod* volatile | 编译后的 nmethod |
| `_i2i_entry` | address | 解释器到解释器入口 |

---

## 五、ConstantPool (72B, 8 字段) — 常量池

| 字段 | 类型 | 作用 |
|------|------|------|
| `_tags` | Array<u1>* | 每个 CP 项的 tag（class/field/method/string/integer/...） |
| `_cache` | ConstantPoolCache* | 解释器运行时缓存 |
| `_pool_holder` | InstanceKlass* | 所属类 |
| `_operands` | Array<u2>* | invokedynamic 操作数 |
| `_resolved_klasses` | Array<Klass*>* | 已解析的类引用 |
| `_flags` | int | 位标志 |
| `_length` | int | CP 项数 |
| `_saved` | union | _version (类重定义) / _resolved_reference_length (CDS) |

---

## 六、设计决策

| 决策 | 为什么 |
|------|--------|
| Klass 基类 208B → InstanceKlass +264B | 不是浪费——57 字段全是 O(1) 访问。如果存哈希表，getfield 变两次查表 |
| `_vtable_index` 正负编码 | 一个 int 存两种含义：≥0=vtable, <0=itable（绝对值）。省一个字段但增加阅读难度 |
| `_secondary_supers` 单独数组 | 接口检查 O(n_supers) vs O(1) 缓存命中。缓存命中时无需遍历 |
| ConstantPool 只有 72B | 真正的 CP 数据在外部 Array 中——这是 JVM 对"可变大小数据"的典型设计模式 |
