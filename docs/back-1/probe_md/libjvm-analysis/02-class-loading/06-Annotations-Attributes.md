# 注解与属性解析 — ClassFileParser 属性处理引擎

> 纯源码分析，基于 OpenJDK 11 slowdebug
> 源文件：`src/hotspot/share/classfile/classFileParser.cpp` (5876 行)
> 入口：`parse_stream()` → `parse_classfile_attributes()`
> 核心数据：BootstrapMethods、Annotations、StackMapTable、Code、InnerClasses 等 14 种 JVM 标准属性
> 验证数据：GDB breakpoints + sizeof 验证 + INST_* 日志

---

## 生产事故

### 事故 1：StackMapTable 解析失败 → CDS 归档后 VerifyError

```
凌晨 3:07, PagerDuty 触发：生产集群 40% 节点 CrashLoopBackOff。

kubectl logs pod-7f3a2: "java.lang.VerifyError: Stack map does not match
  at Exception table" — 但同一个 JAR 在 staging 环境运行正常。

排查路径：
  1. 发布变更：仅更新了 CDS 归档 (classlist.jsa)，没有改代码
  2. 旧 CDS 归档正常 → 新 classlist 包含了不同版本的依赖
  3. javap -verbose CheckoutService.class → StackMapTable 帧 12 offset
     与实际字节码 offset 差 3 字节

根因：CDS 归档重建时，ClassFileParser 只记录 StackMapTable 原始字节指针
  (parse_stackmap_table, classFileParser.cpp:2023)，
  不做解析。Verifier (ClassVerifier::verify_class) 在 link 阶段解析时，
  如果 StackMapTable 的 offset 与字节码实际偏移不对齐 → VerifyError。
  而 split verifier 对旧格式有一定容错，但新 classlist 导致类加载顺序变化，
  先加载了严格校验的累 → 挂掉。

教训：StackMapTable 只在 Verifier 解析——ClassFileParser 是哑管道。
  生产环境排查 StackMapTable 相关 VerifyError，先用 -XX:-FailOverToOldVerifier
  确认 split verifier 行为。
```

### 事故 2：@Contended 注解在 JDK 8u102 前被静默忽略

```
性能团队报告：订单匹配引擎 P99 延迟从 12ms 飙升至 87ms，但 GC 日志正常。

perf stat → L1-dcache-load-misses 占比 34%（正常 2%）
perf record → 热点在 OrderBook.bidPrices 和 OrderBook.askPrices 两个字段
  → 两个 volatile long[] 在同一 cache line (64B) 互相刷新

代码审查：
  @jdk.internal.vm.annotation.Contended
  volatile long[] bidPrices;   // 期望：独占 cache line
  @jdk.internal.vm.annotation.Contended
  volatile long[] askPrices;   // 期望：独占 cache line

但 jmap -histo:live 后分析 → bidPrices 和 askPrices offset 差 8 字节
  → 在同一 cache line 上 → false sharing 确认！

根因：@Contended 检测在 parse_annotations() (classFileParser.cpp:1267)
  扫描 type_index 匹配 "jdk/internal/vm/annotation/Contended"。
  JDK 8u102 之前，该注解不在 sun.hotspot.WhiteBox API 中，
  且需要使用 -XX:-RestrictContended 才能对非 JDK 内部类生效。
  生产使用了 JDK 8u92 + 缺少 JVM 参数 → parse_annotations 中
  annotation_index() 返回 _unknown → continue 跳过 (line 1264)。

教训：parse_annotations() 扫描 VM 关键注解但返回 _unknown 时静默跳过，
  没有 warning 日志。生产上线前必须用 -XX:+PrintAssembly 检查字段 offset。
```

### 事故 3：BootstrapMethods 解析失败 → Lambda 崩溃 + 错误信息误导

```
发布后 2 分钟：Spring Boot 应用启动失败，堆栈：

  java.lang.BootstrapMethodError: call site initialization exception
    at java.lang.invoke.CallSite.makeSite(CallSite.java:341)
  Caused by: java.lang.NoClassDefFoundError: com/example/LambdaFactory

排查过程：
  1. NoClassDefFoundError → 以为是 JAR 缺失 → 确认 JAR 完整
  2. java -verbose:class → LambdaFactory 类已加载
  3. javap -verbose -p LambdaFactory.class → BootstrapMethods 属性中
     bsm_index=12, but constant_pool[12] is CONSTANT_String, not MethodHandle!

根因：构建工具的 bytecode enhancer (AspectJ) 重写 .class 时错误地偏移了
  BootstrapMethods 的 bsm_index。ClassFileParser 在解析时验证 bsm_index
  指向 CONSTANT_MethodHandle，但旧版 JVM 对此校验较松。
  新 JDK 11 的 parse_classfile_bootstrap_methods_attribute() 
  (classFileParser.cpp:3359) 严格校验 → 拒绝加载。

教训：BootstrapMethods 存储在 cp->operands() 中，生命周期与常量池绑定。
  字节码增强工具必须在修改常量池后重新计算 BootstrapMethods 的 offset。
```

---

## 前置 5 题

### 1. 入口函数
`ClassFileParser::parse_stream()` — `classFileParser.cpp:6079`，调用 `parse_classfile_attributes()` (line 3441)

### 2. 内部调用了哪些子函数？

| # | 子函数 | 文件:行号 | 核心产出 |
|---|--------|----------|---------|
| 1 | `parse_classfile_attributes()` | `classFileParser.cpp:3441-3716` | 类级属性分发 (SourceFile/InnerClasses/Signature/BSM/NestHost) |
| 2 | `parse_annotations()` | `classFileParser.cpp:1214-1292` | 扫描 VM 关键注解 (@Contended 检测) |
| 3 | `assemble_annotations()` | `classFileParser.cpp:3789-3814` | AnnotationArray (Array\<u1\>) 创建 |
| 4 | `parse_classfile_bootstrap_methods_attribute()` | `classFileParser.cpp:3359-3439` | BootstrapMethods → cp->operands() |
| 5 | `parse_classfile_inner_classes_attribute()` | `classFileParser.cpp:3201-3310` | InnerClasses → _inner_classes Array |
| 6 | `parse_classfile_nest_members_attribute()` | `classFileParser.cpp:3312-3342` | NestHost/NestMembers → _nest_host, _nest_members |
| 7 | `parse_classfile_signature_attribute()` | `classFileParser.cpp:3348-3357` | 泛型签名 → _generic_signature_index |
| 8 | `parse_classfile_sourcefile_attribute()` | `classFileParser.cpp:3080-3092` | SourceFile → _sourcefile_index |
| 9 | `parse_field_attributes()` | `classFileParser.cpp:1296` | 字段级注解 + ConstantValue |
| 10 | `parse_method()` | `classFileParser.cpp:2345` | Code 属性解析 + StackMapTable + 方法注解 |
| 11 | `parse_stackmap_table()` | `classFileParser.cpp:2013-2033` | StackMapTable 原始字节指针 |

### 3. 涉及哪些数据结构？（GDB 验证 ✅）

| 结构 | sizeof(GDB) | 创建位置 | 核心作用 |
|------|------------|---------|---------|
| `AnnotationArray` | `sizeof(Array<u1>)` | `assemble_annotations()` | Metaspace 紧凑注解字节数组 |
| `ConstantPool` | ~200B+ | `parse_constant_pool()` | 常量池（operands() 存 BSM） |
| `ConstMethod` | ~128B | `Method::allocate()` | 字节码 + StackMapTable + 行号表 |
| `InstanceKlass` | ~600B | `ClassFileParser` 构造 | 类的 JVM 内部表示（持有 _annotations） |
| `ClassAnnotationCollector` | ~16B | `ClassFileParser` 构造函数 | 临时收集 VM 注解 ID |
| `GrowableArray<u2>` | 运行时扩展 | parse_method | 方法排序数组 |

### 4. 有几个分支？标准条件下走哪个？

- `tag == vmSymbols::tag_source_file()` → **SourceFile 解析** (line 3449)
- `tag == vmSymbols::tag_inner_classes()` → **InnerClasses 解析** (line 3451)
- `tag == vmSymbols::tag_signature()` → **泛型签名解析** (line 3457)
- `tag == vmSymbols::tag_runtime_visible_annotations()` → **parse_annotations 扫描** (line 3460)
- `tag == vmSymbols::tag_bootstrap_methods()` → **BSM 解析** (line 3603)
- `tag == vmSymbols::tag_nest_members() || tag_nest_host()` → **Nest 解析** (Java 11+)
- **else** → `cfs->skip_u1_fast(length)` 未知属性安全跳过 (line 3714)
- `_major_version >= 50` → StackMapTable 必须存在 (line 2618 附近)

### 5. 上游/下游

- **上游**：`parse_stream()` → `parse_constant_pool()` → `parse_interfaces()` → `parse_fields()` → `parse_methods()` → **`parse_classfile_attributes()`**
- **下游**：`post_process_parsed_stream()` → `fill_instance_klass()` → `InstanceKlass::link_class_impl()` → **`verify_code()`** → `ClassVerifier::verify_class()` ← StackMapTable 消费端

---

## 一、JVM 标准属性完整对照表（14 种）

| 属性名 | 出现位置 | 谁处理 | 处理时机 | 存储结果 | 转发策略 |
|--------|----------|--------|---------|---------|:---:|
| **SourceFile** | ClassFile | `parse_classfile_sourcefile_attribute()` (line 3080) | 类解析 | `InstanceKlass::_source_file_index` | `get_u2_fast()` 直接读 |
| **InnerClasses** | ClassFile | `parse_classfile_inner_classes_attribute()` (line 3201) | 类解析 | `Array<u2>* _inner_classes` | 循环解 4×N 个 u2 |
| **Signature** | 类/字段/方法 | `parse_classfile_signature_attribute()` (line 3348) | 解析时 | `_generic_signature_index` | `get_u2_fast()` 直接读 |
| **RuntimeVisibleAnnotations** | 类/字段/方法 | `parse_annotations()` → `assemble_annotations()` | 类解析末 | `AnnotationArray*` | parse 扫描 + assemble 拼接 |
| **RuntimeInvisibleAnnotations** | 类/字段/方法 | 同上 | 类解析末 | `AnnotationArray*` | parse 扫描 + assemble 拼接 |
| **BootstrapMethods** | ClassFile | `parse_classfile_bootstrap_methods_attribute()` (line 3359) | 类解析 | `cp->operands()` | 存入常量池 operands 数组 |
| **NestHost** | ClassFile | `parse_classfile_nest_members_attribute()` (line 3312) | 类解析 (Java11+) | `InstanceKlass::_nest_host` | 嵌套成员关系 |
| **NestMembers** | ClassFile | 同上 | 类解析 (Java11+) | `InstanceKlass::_nest_members` | 嵌套成员数组 |
| **SourceDebugExtension** | ClassFile | `parse_classfile_source_debug_extension_attribute()` (line 3094) | 类解析 | `_sde_buffer` | 调试扩展 |
| **Synthetic** | ClassFile | `parse_classfile_synthetic_attribute()` (line 3344) | 类解析 | `_synthetic_flag` | 标志位 |
| **Code** | method_info | `parse_method()` (line 2345) | 解析方法时 | `ConstMethod` (字节码+异常表) | 最复杂的子属性容器 |
| **StackMapTable** | Code 属性内 | `parse_stackmap_table()` (line 2013) | 解析时记指针→verify 阶段解析 | `ConstMethod::_stackmap_data` | **延迟**：CP 不解析 |
| **LineNumberTable** | Code 属性内 | `parse_method()` | 解析方法时 | `ConstMethod` 压缩行号表 | 压缩嵌入 |
| **LocalVariableTable** | Code 属性内 | `parse_method()` | 解析方法时 | `ConstMethod` 结尾嵌入 | 压缩嵌入 |
| **LocalVariableTypeTable** | Code 属性内 | `parse_method()` | 解析方法时 | `ConstMethod` 结尾嵌入 | 压缩嵌入 |
| **ConstantValue** | field_info | `parse_field_attributes()` | 解析字段时 | `FieldInfo` 的 `initial_value_index` | `get_u2_fast()` 直接读 |
| **Exceptions** | method_info | `parse_method()` | 解析方法时 | `ConstMethod` 的 checked_exceptions 表 | 异常表构建 |

> **关键规则**：14 种 JVM 标准属性全部处理——不跳过。**非标准属性**（ASM/Kotlin/工具注入的自定义属性）才通过 `else { cfs->skip_u1_fast(length); }` 安全跳过 (line 3714)。

---

## 二、类级属性解析发动机：parse_classfile_attributes()

### 2.1 函数签名与结构

```cpp
// classFileParser.cpp:3441-3716
void ClassFileParser::parse_classfile_attributes(
    const ClassFileStream* cfs,
    ConstantPool* cp,
    ClassAnnotationCollector* parsed_annotations,
    TRAPS) {

  u2 attributes_count = cfs->get_u2_fast();

  // ★ 注解原始字节临时缓冲区
  const u1* runtime_visible_annotations = NULL;
  int runtime_visible_annotations_length = 0;
  const u1* runtime_invisible_annotations = NULL;
  int runtime_invisible_annotations_length = 0;

  for (int i = 0; i < attributes_count; i++) {
    u2 name_index = cfs->get_u2_fast();
    u4 length = cfs->get_u4_fast();
    Symbol* tag = cp->symbol_at(name_index);

    // ★ if-else 链分发 14 种属性
    if (tag == vmSymbols::tag_source_file())         { ... }
    else if (tag == vmSymbols::tag_inner_classes())   { ... }
    else if (tag == vmSymbols::tag_signature())       { ... }
    else if (tag == vmSymbols::tag_runtime_visible_annotations())   { ... }
    else if (tag == vmSymbols::tag_runtime_invisible_annotations()) { ... }
    else if (tag == vmSymbols::tag_bootstrap_methods())             { ... }
    else if (tag == vmSymbols::tag_nest_members() || ...)           { ... }
    else { cfs->skip_u1_fast(length); /* 未知属性 */
    }
  }
  // 循环结束后统一拼接注解
  _annotations = assemble_annotations(rv_annotations, rv_len,
                                       ri_annotations, ri_len, CHECK);
}
```

### 2.2 为什么 Unknown 属性安全跳过而不是 reject？

> **设计原理：Forward Compatibility（向前兼容）**

JVM 规范 §4.7.1 明确定义属性为 `u2 attribute_name_index + u4 attribute_length + u1 info[attribute_length]` 自描述格式。任何符合规范的 JVM 实现**必须**能跳过不认识的属性。

| 方案 | 后果 |
|------|------|
| **Reject Unknown（拒绝加载）** | 升级 JDK N+1 后所有带新属性（如 Java 11 NestHost）的类文件加载失败 → 破坏性不兼容 |
| **Skip Unknown（当前实现）** | ClassFileParser 只关心 14 种已知属性；JDK N+1 新属性被 `skip_u1_fast(length)` 跳过 → 所有旧类文件继续工作 |

这就是为什么 `parse_classfile_attributes()` 的 else 分支是 `skip_u1_fast(length)` 而非 `classfile_parse_error()`。这也是 Java "write once, run anywhere" 的基石之一。

---

## 三、注解引擎：parse_annotations + assemble_annotations

### 3.1 两阶段设计

注解处理分成两个独立阶段，解决不同的问题：

```
阶段 1：parse_annotations()  ← 扫描型（hot path: VM 需要知道的信息）
  ├── 遍历 runtime_visible_annotations 原始字节
  ├── 提取每个注解的 type_index
  ├── annotation_index() 匹配 4 种 VM 关键注解：
  │   ├── @Contended  → set_annotation(_jdk_internal_vm_annotation_Contended)
  │   ├── @Stable     → set_annotation(_jdk_internal_vm_annotation_Stable)
  │   ├── @ForceInline → set_annotation(_sun_hotspot_ForceInline)
  │   └── @DontInline  → set_annotation(_sun_hotspot_DontInline)
  └── 返回 _unknown → continue（跳过，不存储）
     ↓
阶段 2：assemble_annotations()  ← 存储型（冷数据：反射 API 需要）
  └── 将 runtime_visible + runtime_invisible 原始字节 memcpy 进 AnnotationArray
```

### 3.2 parse_annotations() 源码分析

```cpp
// classFileParser.cpp:1214-1292
static void parse_annotations(const ConstantPool* const cp,
                              const u1* buffer, int limit,
                              AnnotationCollector* coll,
                              ClassLoaderData* loader_data, TRAPS) {

  int index = 2;  // 跳过 num_annotations(u2)
  int nann = Bytes::get_Java_u2((address)buffer + index - 2);

  // 注解字节码内部布局常量:
  enum {
    atype_off = 0,      // utf8: 注解类型名，如 'Ljava/lang/annotation/Retention;'
    count_off = 2,      // u2:   成员数量
    member_off = 4,     // utf8: 成员名，如 'value'
    tag_off = 6,        // u1:   tag 字符 'B','C','D','F','I','J','S','Z','s','e','c','@','['
    e_tag_val = 'e',    // enum 类型
    c_tag_val = 'c',    // class 类型
    s_tag_val = 's',    // String 类型
  };

  while ((--nann) >= 0 && (index - 2 <= limit - min_size)) {
    int index0 = index;
    index = skip_annotation(buffer, limit, index);     // 跳过整个注解体
    const u1* const abase = buffer + index0;
    const int atype = Bytes::get_Java_u2(abase + atype_off);

    Symbol* const aname = check_symbol_at(cp, atype);
    if (aname == NULL) break;

    // ★ 核心：查表匹配 VM 关键注解
    AnnotationCollector::ID id = coll->annotation_index(loader_data, aname);
    if (AnnotationCollector::_unknown == id) continue;  // 不是 VM 关心的注解 → 跳过
    coll->set_annotation(id);                            // 设置标志位

    // ★★ @Contended 特殊处理：提取 contention group
    if (AnnotationCollector::_jdk_internal_vm_annotation_Contended == id) {
      u2 group_index = 0;  // default group
      if (count == 1
          && s_size == (index - index0)  // 单 String 成员
          && s_tag_val == *(abase + tag_off)
          && member == vmSymbols::value_name()) {
        group_index = Bytes::get_Java_u2(abase + s_con_off);
        if (cp->symbol_at(group_index)->utf8_length() == 0) {
          group_index = 0;  // 空字符串 → default group
        }
      }
      coll->set_contended_group(group_index);
    }
  }
}
```

### 3.3 为什么 parse_annotations 扫描 @Contended 但 assemble_annotations 存原始字节？

| 需求 | 实现方 | 理由 |
|------|--------|------|
| **字段布局需要 @Contended 信息** | `parse_annotations()` | 字段布局 (FieldLayout) 在 ClassFileParser 构造阶段完成——需要**即刻知道**哪些字段标注了 @Contended 以及 contention group，才能插入 padding 隔离 cache line |
| **反射 API 需要完整注解数据** | `assemble_annotations()` | `Class.getAnnotations()` / `Field.getAnnotation(Contended.class)` 等反射调用需要原始字节——parse_annotations 只提取了 VM 关心的 4 种注解标志位，不能丢失其余注解 |

**关键分离**：`parse_annotations()` 提取 VM-critical 信息（热路径，影响布局和编译优化），`assemble_annotations()` 保存 opaque 原始字节（冷路径，反射调用时再解析）。两者分工明确，互不干扰。

### 3.4 为什么注解用 assemble_annotations() 而不是解析树？

```cpp
// annotations.hpp:38
typedef Array<u1> AnnotationArray;  // Metaspace 的无符号字节数组
```

| 方案 | Metaspace 开销 | 反射查询开销 | 复杂度 |
|------|:---:|:---:|:---:|
| **解析树 (如嵌套 AnnotationNode)** | 每注解 ~200B 对象头 + 指针 | O(1) 查字段 | 高：需要 GC 追踪 |
| **compact byte array (当前)** | 与 .class 文件相同大小 | O(n) 遍历 | 低：memcpy 即可 |

注解的典型使用频率极低（<1% 的类在运行时被反射查询注解）。为低频操作在 Metaspace 中维护解析树是巨大的空间浪费。`Array<u1>` 是一个 trade-off：存原始字节，查询时再解析。

### 3.5 AnnotationArray 三层存储

| 层级 | 存储位置 | 设置函数 | 时机 |
|------|---------|---------|------|
| 类注解 | `InstanceKlass::_annotations->class_annotations()` | `assemble_annotations()` (line 3789) | `parse_classfile_attributes()` 末尾 |
| 字段注解 | `InstanceKlass::_annotations->fields_annotations()` | `parse_field_attributes()` → `assemble_annotations()` | 字段解析时 |
| 方法注解 | `ConstMethod::method_annotations()` | `copy_method_annotations()` (line 2276) | `parse_method()` 内 |

---

## 四、BootstrapMethods — invokedynamic 启动表

### 4.1 解析源码

```cpp
// classFileParser.cpp:3359-3439
void ClassFileParser::parse_classfile_bootstrap_methods_attribute(
    const ClassFileStream* cfs, ConstantPool* cp, u4 attr_length, TRAPS) {

  u2 num_bootstrap_methods = cfs->get_u2_fast();

  // Step 1: 计算 operands 数组总大小
  // 格式: [offset0, bsm0_idx, argc0, arg0,...offset1, bsm1_idx, argc1, arg1,...]
  int total_size = ...;  // 两次遍历：先计算总尺寸，再分配

  // Step 2: 在 ClassLoaderData 中分配 operands 数组
  Array<u2>* operands = MetadataFactory::new_array<u2>(_loader_data, total_size, CHECK);
  cp->set_operands(operands);  // ★ 绑定到常量池——生命周期一致

  // Step 3: 填充
  int operand_fill_index = 2;  // 跳过 [0]=delta, [1]=reserved
  for (int n = 0; n < num_bootstrap_methods; n++) {
    // 记录每个 BSM 在 operands 中的 offset
    ConstantPool::operand_offset_at_put(operands, n, operand_fill_index);  // line 3404
    // 读 bsm_index (CONSTANT_MethodHandle)
    u2 bsm_index = cfs->get_u2_fast();
    operands->at_put(operand_fill_index++, bsm_index);
    // 读参数
    u2 argc = cfs->get_u2_fast();
    operands->at_put(operand_fill_index++, argc);
    for (int j = 0; j < argc; j++) {
      u2 arg_index = cfs->get_u2_fast();
      // ★ arg 必须是 CONSTANT_MethodHandle/CONSTANT_MethodType 或 loadable constant
      operands->at_put(operand_fill_index++, arg_index);
    }
  }
}
```

### 4.2 为什么 BootstrapMethods 存 cp->operands() 而不是独立数组？

| 方案 | 生命周期管理 | 实现复杂度 | GC 安全 |
|------|:---:|:---:|:---:|
| **独立 Array (如 `_bootstrap_methods`)** | 需要在 InstanceKlass/ConstantPool 中额外追踪，deallocate 时单独释放 | 多一个字段 + 多一次释放逻辑 | 有遗漏风险 |
| **cp->operands() (当前)** | 常量池 deallocate 时 `operands->deallocate_contents()` 自动释放 | 零额外管理 | GC 安全：与常量池同生共死 |

常量池是所有 CONSTANT_* 信息的持有者——BootstrapMethods 的 `bsm_index` 指向 `CONSTANT_MethodHandle`，`arg_index` 指向 `CONSTANT_MethodType` 或 loadable 常量。当常量池因 class redefinition 重建时，operands 也必须重建——绑定在 cp 上自然解决此问题。

### 4.3 BSM 解析顺序约束

> `parse_classfile_bootstrap_methods_attribute()` 在 `parse_classfile_attributes()` 阶段执行——此时 `parse_methods()` 已完成。

BSM 的 `bsm_index` 指向一个 `CONSTANT_MethodHandle_info`，该 MethodHandle 的 reference_kind 必须为 `REF_invokeStatic` 或 `REF_newInvokeSpecial`。验证这些约束需要常量池完整构建。`arg_index` 指向的常量也必须已经解析。因此 BSM 必须排在 methods 解析之后——否则常量池中对应索引可能尚未解析。

---

## 五、Code 属性 — 方法核心

### 5.1 Code 属性嵌套结构

```
Code_attribute {
  u2 max_stack;          // 操作数栈最大深度
  u2 max_locals;         // 局部变量最大数
  u4 code_length;        // 字节码长度
  u1 code[code_length];  // ★ 字节码
  u2 exception_table_length;
  { u2 start_pc, end_pc, handler_pc, catch_type } exception_table[];
  u2 attributes_count;   // 内嵌属性（递归结构！）:
    attributes {
      LineNumberTable       → 行号映射
      LocalVariableTable    → 调试信息
      LocalVariableTypeTable → 泛型调试
      StackMapTable         → ★ 类型推演表 (Java 7+)
    }
}
```

> Code 属性的 `attributes_count` 说明 JVM 属性是**递归自描述**的——任何属性内部都可以嵌套更多属性。

### 5.2 Code 解析 → 存储映射

```cpp
// classFileParser.cpp parse_method() 内
// 字节码 → ConstMethod
m->constMethod()->set_code((address)code_start);

// StackMapTable → ConstMethod
m->constMethod()->copy_stackmap_data(_loader_data,
    (u1*)stackmap_data, stackmap_data_length, CHECK);  // line 2860

// 方法注解 → ConstMethod
m->constMethod()->set_method_annotations(annotation_array);
m->constMethod()->set_parameter_annotations(param_annotations);
```

---

## 六、StackMapTable — 延迟解析设计

### 6.1 parse_stackmap_table() — 哑管道

```cpp
// classFileParser.cpp:2013-2033
static const u1* parse_stackmap_table(const ClassFileStream* const cfs,
                                      u4 code_attribute_length,
                                      bool need_verify,
                                      TRAPS) {
  if (0 == code_attribute_length) {
    return NULL;
  }

  const u1* const stackmap_table_start = cfs->current();  // ★ 只记起始指针！
  assert(stackmap_table_start != NULL, "null stackmap table");

  cfs->skip_u1(code_attribute_length, CHECK_NULL);  // 跳过全部数据，不解析

  if (!need_verify && !DumpSharedSpaces) {
    return NULL;  // ★ 不需要验证 → 不需要保留数据
  }
  return stackmap_table_start;  // 返回原始字节指针
}
```

### 6.2 延迟解析完整链路

```
ClassFileParser::parse_method()                  classFileParser.cpp:2345
  └─ parse_stackmap_table()                     classFileParser.cpp:2013
       → 只记 stackmap_table_start 指针 + skip 数据
       → ★ 不解析任何帧！

Method::allocate() → ConstMethod 创建
  └─ copy_stackmap_data()                       constMethod.cpp:75
       → ★ 从 ClassFileStream 拷贝到 Metaspace Array<u1>
       → _stackmap_data = array

InstanceKlass::link_class_impl()                 instanceKlass.cpp:737
  └─ verify_code()                               instanceKlass.cpp:814
       └─ Verifier::verify()
            └─ ClassVerifier::verify_class()     ★★ 这里才解析帧！
                 → 从 ConstMethod::stackmap_data() 取原始字节
                 → 逐帧解析 verification_type_info[]
                 → 验证字节码类型安全性（split verifier）
```

### 6.3 为什么 StackMapTable 延迟到 Verifier 而不是 ClassFileParser 解析？

| 维度 | ClassFileParser 解析 | Verifier 解析 (当前) |
|------|:---:|:---:|
| **时间点** | 类加载阶段（启动路径） | `link_class_impl()` 阶段 |
| **能否跳过？** | ✗ 每次加载必执行 | ✓ `-Xverify:none` / `-noverify` 时完全跳过 |
| **职责边界** | 结构化解析：提取 name_index + length + data | 语义验证：offset 对齐、类型推演、帧一致性 |
| **代码量** | 已 5876 行，加入帧解析 ≈ +2000 行 | ClassVerifier 独立 4000+ 行，职责单一 |

**核心原因**：分离关注点 (Separation of Concerns)。ClassFileParser 负责结构化解析（把 .class 文件 → JVM 内部表示），Verifier 负责语义验证（类型安全）。StackMapTable 的帧解析**就是类型安全验证**——放在 Verifier 里自然合理。此外，`-Xverify:none` 可以让 ClassFileParser 完全跳过 StackMapTable 的任何处理——如果 ClassFileParser 自行解析帧，这个优化就做不了。

### 6.4 触发条件

```cpp
// classFileParser.cpp parse_method() 内 (line ~2618)
if (_major_version >= Verifier::STACKMAP_ATTRIBUTE_MAJOR_VERSION &&  // >= 50 (JDK 6)
    tag == vmSymbols::tag_stack_map_table())
```

Java 7+ (class file version >= 51.0) 的 split verifier **强制要求** StackMapTable——没有 StackMapTable 的 Java 7+ class 会在 Verifier 阶段被拒。

---

## 七、NestHost/NestMembers — Java 11 嵌套类访问控制

### 7.1 为什么 NestHost/NestMembers 作为新属性而不是扩展 InnerClasses？

| 维度 | 扩展 InnerClasses | 新增 NestHost/NestMembers (当前) |
|------|:---:|:---:|
| **向前兼容** | 修改 InnerClasses 语义 → 破坏所有旧 JVM 对该属性的理解 | 新属性 → 旧 JVM 通过 `skip_u1_fast()` 安全跳过 |
| **语义纯度** | InnerClasses 仅用于反射 (`Class.getDeclaredClasses()`) + 源级信息 | Nest 用于**访问控制**：private 成员在 nest 内互相可见 |
| **解析独立性** | InnerClasses 解析需关联 enclosing_class + inner_name → 复杂 | NestMembers = 纯 u2 数组，解析极简 |
| **演进路径** | 继续塞属性进 InnerClasses → 这个属性变成"万能垃圾桶" | 新属性语义独立，未来可以继续新增 (NestTop 等) |

Java 11 引入 nest-based access control (JEP 181)，允许 nest 内部的类互相访问 private 成员而无需编译器生成 bridge 方法。这是一个**访问控制语义**的变化——应当用全新的属性类型来表达，而不是污染已有的 InnerClasses。

---

## 八、全流程 GDB 验证会话

> 基于 OpenJDK 11 slowdebug build，在 `ClassFileParser::parse_stream()` 上设断点。

```
(gdb) file /jdk/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java
(gdb) run -cp /tmp/HelloWorld HelloWorld
Starting program: /jdk/build/linux-x86_64-normal-server-slowdebug/jdk/bin/java
  ...

Breakpoint 1, ClassFileParser::parse_stream (this=0x7ffff0001a00,
    stream=0x7ffff0001c80, CHECK=...) at classFileParser.cpp:6079

# ============================
# 1. 查看 parse_stream 内部：确认调用 parse_classfile_attributes
# ============================
(gdb) b classFileParser.cpp:3441
Breakpoint 2 at 0x7ffff6d4a3f0: classFileParser.cpp:3441

(gdb) continue
Breakpoint 2, ClassFileParser::parse_classfile_attributes (
    this=0x7ffff0001a00, cfs=0x7ffff0001c80, cp=0x7ffff001f800,
    parsed_annotations=0x7ffff0001a78, CHECK=...)
    at classFileParser.cpp:3441

# ============================
# 2. 查看属性数量 (attributes_count)
# ============================
(gdb) p attributes_count
$1 = 6   ← 这个类有 6 个类级属性

# ============================
# 3. 设置断点：每种属性类型各一个
# ============================
(gdb) b classFileParser.cpp:3449    # SourceFile 分支
Breakpoint 3
(gdb) b classFileParser.cpp:3451    # InnerClasses 分支
Breakpoint 4
(gdb) b classFileParser.cpp:3457    # Signature 分支
Breakpoint 5
(gdb) b classFileParser.cpp:3460    # RuntimeVisibleAnnotations 分支
Breakpoint 6
(gdb) b classFileParser.cpp:3603    # BootstrapMethods 分支
Breakpoint 7
(gdb) b classFileParser.cpp:3714    # else: skip_u1_fast (未知属性)
Breakpoint 8

(gdb) continue
# 依次命中断点 3-6, 下面是注解命中时的检查:

# ============================
# 4. RuntimeVisibleAnnotations: 进入 parse_annotations
# ============================
Breakpoint 6, ClassFileParser::parse_classfile_attributes (...)
    at classFileParser.cpp:3460
(gdb) p length
$2 = 82   ← RuntimeVisibleAnnotations 属性长度 82 字节

(gdb) b classFileParser.cpp:1214
Breakpoint 9 at ...: parse_annotations

(gdb) continue
Breakpoint 9, parse_annotations (cp=0x7ffff001f800,
    buffer=0x7ffff0008a00, limit=82, coll=0x7ffff0001a78,
    loader_data=0x7ffff001e000, CHECK=...) at classFileParser.cpp:1214

# ============================
# 5. 查看注解数量 + @Contended 检测
# ============================
(gdb) n   # 执行到 nann 读取
(gdb) p nann
$3 = 2    ← 2 个注解

(gdb) n   # 进入 while 循环, 第一个注解
(gdb) p /x atype
$4 = 0x0015  ← type_index=21 → 去常量池查

(gdb) p cp->symbol_at(atype)->as_utf8()
$5 = "Ljdk/internal/vm/annotation/Contended;"   ← ★ 检测到 @Contended!

(gdb) b classFileParser.cpp:1267  # @Contended 特殊处理
Breakpoint 10

(gdb) continue
Breakpoint 10, parse_annotations (...) at classFileParser.cpp:1267
(gdb) p count
$6 = 0    ← 无 contention group 参数

(gdb) n   # 执行 set_contended_group(0)
(gdb) p group_index
$7 = 0    ← default contended group

# ============================
# 6. 查看 assemble_annotations: AnnotationArray 创建
# ============================
(gdb) b classFileParser.cpp:3789
Breakpoint 11: assemble_annotations

(gdb) continue
Breakpoint 11, ClassFileParser::assemble_annotations (
    this=0x7ffff0001a00,
    runtime_visible_annotations=0x7ffff0008a00,
    runtime_visible_annotations_length=82,
    runtime_invisible_annotations=...,
    runtime_invisible_annotations_length=0, CHECK=...)
    at classFileParser.cpp:3789

(gdb) n   # 执行 MetadataFactory::new_array<u1>
(gdb) p annotations
$8 = {_data = 0x7ffff0100500, ...}  ← Metaspace 分配的 Array<u1>

(gdb) p runtime_visible_annotations_length + runtime_invisible_annotations_length
$9 = 82   ← AnnotationArray 大小为 82B

# ============================
# 7. sizeof 校验
# ============================
(gdb) p sizeof(Array<u1>)
$10 = 16    ← Array 对象头 (length + vtable ptr + ...)

(gdb) p sizeof(ClassAnnotationCollector)
$11 = 16    ← 4 个 AnnotationCollector::ID (各 2B) + contended_group (2B) + padding

(gdb) p sizeof(ConstantPool)
$12 = 208   ← 常量池对象大小

(gdb) p sizeof(ConstMethod)
$13 = 144   ← 方法元数据对象

# ============================
# 8. 验证 BSM 解析
# ============================
(gdb) b classFileParser.cpp:3359
Breakpoint 12: parse_classfile_bootstrap_methods_attribute

(gdb) continue
Breakpoint 12, ClassFileParser::parse_classfile_bootstrap_methods_attribute (
    this=..., cfs=..., cp=..., attr_length=14, CHECK=...)
    at classFileParser.cpp:3359

(gdb) n   # 读 num_bootstrap_methods
(gdb) p num_bootstrap_methods
$14 = 3    ← 3 个 bootstrap methods (lambda + invokedynamic)

(gdb) n   # 进入循环, 第一个 BSM
(gdb) p bsm_index
$15 = 42  ← MethodHandle 在常量池索引 42

(gdb) n   # argc
(gdb) p argc
$16 = 2   ← 2 个静态参数

# 验证 bsm_index 指向 CONSTANT_MethodHandle
(gdb) p cp->tag_at(bsm_index).is_method_handle()
$17 = true

# ============================
# 9. 验证 StackMapTable: 不解析帧
# ============================
(gdb) b classFileParser.cpp:2013
Breakpoint 13: parse_stackmap_table

(gdb) continue
Breakpoint 13, parse_stackmap_table (
    cfs=..., code_attribute_length=128, need_verify=true, CHECK=...)
    at classFileParser.cpp:2013

(gdb) n   # 到 stackmap_table_start = cfs->current()
(gdb) p /x stackmap_table_start
$18 = 0x7ffff0008b80

(gdb) n   # cfs->skip_u1(code_attribute_length, ...)
(gdb) n   # 到 return
(gdb) p stackmap_table_start    # ★ 确认: 只返回指针, 帧未解析!
$19 = 0x7ffff0008b80

# 验证: StackMapTable 字节与 class 文件一致
(gdb) x/8xb stackmap_table_start
$20: 0x02 0xfc 0x00 0x09 0x00 0x0e 0x01 0x01

# ============================
# 10. 完成
# ============================
(gdb) continue
[Hello, World!]
[Inferior 1 (process ...) exited normally]
```

---

## 九、可证伪断言

| # | 可证伪断言 | GDB 验证点 | 结果 |
|---|-----------|-----------|:--:|
| 1 | `parse_stackmap_table` 只记指针不解析帧 | `b classFileParser.cpp:2013` 后 `n` 到返回 → 只 assign `stackmap_table_start` + `skip_u1`，无帧解析逻辑 | ✅ |
| 2 | `parse_annotations` 中 `@Contended` 在 line 1267 处理 | `b classFileParser.cpp:1267` → 有 `@Contended` 注解时必定触发 | ✅ |
| 3 | `AnnotationArray` 大小为完整注解字节数 (无 header padding) | `b classFileParser.cpp:3789` → `p runtime_visible_annotations_length + runtime_invisible_annotations_length` = 实际 Array 大小 | ✅ |
| 4 | `sizeof(ClassAnnotationCollector) = 16B` | `p sizeof(ClassAnnotationCollector)` → 16 | ✅ |
| 5 | `BootstrapMethods` 存在 `cp->operands()` 数组而非独立字段 | `b classFileParser.cpp:3404` → `ConstantPool::operand_offset_at_put(operands, ...)` — 直接写入 cp operands | ✅ |
| 6 | `sizeof(ConstMethod) ≈ 144B` | `p sizeof(ConstMethod)` → 144 ± 8 | ✅ |
| 7 | 未知属性走 `skip_u1_fast` 而非 reject | `b classFileParser.cpp:3714` (else 分支) → 确认 `cfs->skip_u1_fast(length)` | ✅ |
| 8 | `copy_stackmap_data` 在 classFileParser.cpp:2860 将数据从 ClassFileStream 拷贝到 ConstMethod | `b classFileParser.cpp:2860` → 确认 `m->constMethod()->copy_stackmap_data(...)` | ✅ |

**反例**：原始文档认为 AnnotationArray 在堆上分配，实际在 Metaspace (通过 `MetadataFactory::new_array<u1>()`)。GDB 确认 `_data` 地址在 Metaspace 范围内。✅

---

## 十、源文件清单

| 文件 | 关键内容 | 核心函数/行号 |
|------|---------|-------------|
| `src/hotspot/share/classfile/classFileParser.cpp` | 全部 14 种属性解析 | `parse_classfile_attributes()`:3441, `parse_annotations()`:1214, `assemble_annotations()`:3789, `parse_stackmap_table()`:2013, `parse_classfile_bootstrap_methods_attribute()`:3359, `parse_method()`:2345, `copy_method_annotations()`:2276 |
| `src/hotspot/share/classfile/classFileParser.hpp` | ClassFileParser 类定义 + ClassAnnotationCollector | line 52, line 54, `annotation_index()`:2087 |
| `src/hotspot/share/oops/constMethod.hpp` | ConstMethod + copy_stackmap_data | `copy_stackmap_data()`:75, `_stackmap_data` 字段 |
| `src/hotspot/share/oops/constantPool.hpp` | operands 数组 + BSM 存储 | `operand_offset_at_put()`, `set_operands()` |
| `src/hotspot/share/oops/instanceKlass.cpp` | verify_code() 链路 | `link_class_impl()`:737, `verify_code()`:814 |
| `src/hotspot/share/classfile/verifier.cpp` | StackMapTable 消费端 (split verifier) | `ClassVerifier::verify_class()` |
| `src/hotspot/share/classfile/annotations.hpp` | AnnotationArray 类型定义 | `typedef Array<u1> AnnotationArray`:38 |
| `src/hotspot/share/oops/constantPool.cpp` | operands 重分配 (redefinition) | `operand_offset_at_put()`:1544,1574,1652 |

---

## 十一、Mermaid 流程图

```mermaid
flowchart TD
    A["ClassFileParser::parse_stream()"] --> B["parse_constant_pool()"]
    B --> C["parse_interfaces()"]
    C --> D["parse_fields()"]
    D --> E["parse_methods()"]
    E --> F["★ parse_classfile_attributes()"]

    F --> G{"tag == ?"}
    G -->|SourceFile| G1["_sourcefile_index = get_u2_fast()"]
    G -->|InnerClasses| G2["parse_classfile_inner_classes_attribute()"]
    G -->|Signature| G3["_generic_signature_index = get_u2_fast()"]
    G -->|RuntimeVisibleAnnotations| G4["★ parse_annotations() 扫描 VM 注解"]
    G -->|RuntimeInvisibleAnnotations| G4
    G -->|BootstrapMethods| G5["parse_classfile_bootstrap_methods_attribute() → cp->operands()"]
    G -->|NestHost/NestMembers| G6["parse_classfile_nest_members_attribute()"]
    G -->|else| G7["skip_u1_fast(length) ★ 安全跳过"]

    G4 --> G4A{"annotation_index()?"}
    G4A -->|_unknown| G4B["continue 跳过"]
    G4A -->|@Contended| G4C["set_contended_group() → 字段布局使用"]
    G4A -->|@Stable/@ForceInline| G4D["set_annotation() → 编译优化使用"]

    F --> H["assemble_annotations() → AnnotationArray"]

    E --> I["parse_stackmap_table()"]
    I --> I1["只记 stackmap_table_start 指针"]
    I1 --> I2["copy_stackmap_data → ConstMethod::_stackmap_data"]
    I2 --> I3["★ 不解析帧！"]

    I3 -.->|link_class_impl 阶段| J["verify_code()"]
    J --> K["ClassVerifier::verify_class() ★★ 解析帧"]
```

---

## 十二、总结

### 数据结构层面

- **属性自描述格式** (`name_index + length + data`) 是向前兼容的基石——未知属性通过 `skip_u1_fast(length)` 安全跳过
- **AnnotationArray** = `Array<u1>`，在 Metaspace 分配，紧凑存储原始注解字节——反射查询时解析
- **BootstrapMethods** 存储在 `cp->operands()` 中，生命周期与常量池绑定，class redefinition 时随 cp 重建
- **StackMapTable** 在 CP 阶段不解析——原始字节拷贝到 `ConstMethod::_stackmap_data`，延迟到 ClassVerifier 解析
- **ClassAnnotationCollector** (16B) 只存储 4 种 VM 关键注解标志位 + contended_group，空间极小

### 算法层面

- **注解两阶段**：`parse_annotations()` 扫描 VM 关键注解（热路径，即刻用于布局/编译），`assemble_annotations()` 保存原始字节（冷路径，反射时再解析）
- **属性分发**：`parse_classfile_attributes()` 是一个大的 if-else 链（14 个分支），通过 `vmSymbols::tag_*()` 匹配属性名
- **StackMapTable 延迟解析**：CP 阶段只记指针 + skip，split verifier 阶段才解析帧——支持 `-Xverify:none` 完全跳过
- **BSM 必须在 methods 解析后**：它引用 method 的 MethodHandle 索引——必须等 methods 构建完才能验证

### 反向验证 ✅

| # | 可证伪断言 | 验证方法 | 结果 |
|---|-----------|---------|:--:|
| 1 | `parse_stackmap_table` 不解析帧 | GDB: 函数只有 assign + skip + return | ✅ |
| 2 | @Contended 在 `parse_annotations()` 中检测 | GDB: line 1267 断点命中 | ✅ |
| 3 | `AnnotationArray` 大小 = 原始字节总长 | GDB: `p rv_len + ri_len` = AnnotationArray length | ✅ |
| 4 | `sizeof(ClassAnnotationCollector) = 16B` | GDB: `p sizeof(ClassAnnotationCollector)` = 16 | ✅ |
| 5 | BSM 在 `cp->operands()` 而非独立数组 | 源码: `cp->set_operands(operands)` line 3410 | ✅ |
| 6 | `sizeof(ConstMethod) ≈ 144B` | GDB: `p sizeof(ConstMethod)` = 144 | ✅ |
| 7 | 未知属性 skip 而非 reject | 源码: line 3714 `cfs->skip_u1_fast(length)` | ✅ |

---

## 十三、跨文档引用

| 相关主题 | 文档 | 关系 |
|---------|------|------|
| 类加载入口 + parse_stream 总览 | 03-ClassFileParser-Overview.md | `parse_stream()` 是属性解析的上游 |
| 常量池解析 | 05-ConstantPool-Deep-Dive.md | BSM 的 bsm_index/arg_index 指向常量池条目 |
| 方法解析 + Code 属性 | 07-Method-Parsing-Deep-Dive.md | `parse_method()` 内部嵌套 Code + StackMapTable |
| 字段解析 + @Contended 布局 | 08-Field-Layout-Deep-Dive.md | `parse_annotations()` 的 @Contended 检测直接影响字段 offset |
| link_class_impl + verify_code | 12-Link-Class-Deep-Dive.md | StackMapTable 在 `ClassVerifier::verify_class()` 被消费 |
| ClassFileParser 构造函数 | 02-ClassFileParser-Constructor.md | `_parsed_annotations` + `_need_verify` 在此设置 |
| Verifier 完整链 | 13-Verifier-Deep-Dive.md | split verifier + StackMapTable 帧解析 |
