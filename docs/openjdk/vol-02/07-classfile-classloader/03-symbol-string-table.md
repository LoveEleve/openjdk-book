# 03. SymbolTable 与 StringTable：为什么 JVM 需要两张完全不同的 intern 表

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64` 讨论。本文只讨论 HotSpot 11u 中 `SymbolTable` / `StringTable` 的实现边界，不把它们外推成所有 JVM 的唯一 canonicalization 方案。
> **前置依赖**：[06-oops/06 — Symbol 与辅助元数据](../06-oops/06-symbol-annotations-aux.md)：`Symbol` 的结构、refcount 与共享语义已经建立；[01 — ClassFile 解析](01-classfile-parser.md)：常量池 `Utf8` 在解析时已经走过一次 `SymbolTable` 路径
> → **后续**：[04 — SystemDictionary](04-system-dictionary.md)
> 关联域：06-oops、25-gc、11-cds

## 同样叫 intern，为什么不能只做一张表

HotSpot 里有两类“相同内容只保留一份”的需求：

```text
java/lang/String
<init>
([Ljava/lang/String;)V
```

这类内容属于类名、方法名和描述符。它们是 VM 元数据的一部分，被常量池、Klass、Method、verifier 和链接逻辑反复引用。

另一类则是 Java 世界的字符串对象：

```java
"abc".intern()
```

这里需要唯一化的不是某个元数据名字，而是一个真正的 `java.lang.String` 对象。

表面看，这两类需求都可以概括成一句话：

```text
同样内容只存一份
```

于是很自然会问：既然目标一样，为什么 HotSpot 不做一张统一的 intern 表？为什么一个叫 `SymbolTable`，一个叫 `StringTable`，而且结构、锁语义、回收方式全都不同？

答案不在“字符串”这个词，而在“对象到底归谁管”。

- `SymbolTable` 管的是 `Symbol`，它是 Metaspace/native metadata，不是 Java heap 对象
- `StringTable` 管的是 `java.lang.String`，它是 Java heap 对象，会被 GC 移动、回收、弱处理

这两种对象的所有权和生命周期完全不同，于是 intern 表也必须长成不同形状。

先把全文主线画出来：

```text
同内容唯一化
  │
  ├─ SymbolTable
  │    ├─ 对象：Symbol（metadata atom）
  │    ├─ 持有：强引用 + refcount
  │    ├─ 查找：probe 无锁，miss 后 SymbolTable_lock
  │    ├─ 删除：GC/safepoint unlink refcount==0
  │    └─ 共享：CDS shared symbol table
  │
  └─ StringTable
       ├─ 对象：java.lang.String（heap object）
       ├─ 持有：WeakHandle + OopStorage
       ├─ 查找：shared table -> local concurrent table -> do_intern
       ├─ 死亡：GC 先把 weak slot 清 NULL
       ├─ 结构清理：后台并发删除 dead node
       └─ 共享：CDS shared string table
```

一句话先记住：

**决定 intern 表结构的，不是“这是不是字符串”，而是“谁拥有对象、谁负责回收”。`SymbolTable` 只能自己记账；`StringTable` 必须把对象生死交给 GC。**

---

## 一、三个看似更简单的方案，为什么都行不通

### 1.1 一张统一强引用表同时管 Symbol 和 String

第一个直觉是把两者都做成：

```text
内容 -> 强引用对象
```

这对 `Symbol` 看起来很自然，因为 `Symbol` 本来就不是堆对象；它没有一个 Java heap GC 能替它判断是否还有持有者。

但如果 `StringTable` 也强持有 `java.lang.String`，就意味着：

```text
只要 intern 过
  → 表里始终有强引用
  → 外部代码即使不再引用它
  → 这个 String 也不会因为普通可达性消失
```

这会把 Java heap 字符串的生命周期错误地延长成“只要进过 intern 表就近乎永久”。这和 HotSpot 11u 想要的语义不符：interned String 不是天生永久对象。

### 1.2 一张统一弱引用表同时管 Symbol 和 String

那反过来，全部做成弱引用呢？

这对 `String` 看起来合理，但对 `Symbol` 就失去根基。

`Symbol` 不在 Java heap，上层也没有一个堆对象 GC 能帮你回答“这份 metadata atom 是否已经无人持有”。如果把 `Symbol` 也弱化：

- 谁来判断它是否还被常量池、Klass、Method 或 parser 持有？
- 谁来在卸载或回收时把它从表里安全移除？
- 哪个 collector 能替 Metaspace/native symbol 追踪普通 reachability？

答案是：HotSpot 只能自己用 refcount 记账。对 `Symbol` 来说，弱引用不是一种现成可借用的所有权模型。

### 1.3 所有 intern 都走同一把全局锁哈希表

第三个方案是忽略对象差异，统一用一张简单哈希表 + 一把全局锁。

这对 `SymbolTable` 是可接受的，因为：

- 名字查找虽然频繁，但命中路径很短
- 删除只在 safepoint/GC cleanup 阶段发生
- 插入通常发生在类加载等较低频路径

但 `String.intern()` 是 Java 代码可主动触发的热点路径。它要面对：

- 大量并发调用
- 与 GC 弱处理协作
- 死节点延迟清理
- 可能的扩容/rehash 背景工作

如果仍用“所有查找/插入都围着一把全局锁”的模型，用户代码可以直接把 intern 变成锁竞争热点。

所以这篇真正的总判断是：

```text
intern 的语义相同
并不意味着对象所有权、删除时机、并发负载相同
```

这就是两张表分家的根源。

---

## 二、SymbolTable：为什么 Metaspace 名字适合强引用 + refcount

### 2.1 SymbolTable 管的是不可变 metadata atom，而不是 Java 对象

`SymbolTable` 处理的是 `Symbol`。上一篇已经说明，`Symbol` 是 VM 内部的 canonical metadata name：

- 类名
- 方法名
- 字段名
- 描述符
- 签名

它们不是 Java heap 上的 `String` 对象，也不受 Java 可达性分析直接支配。

因此 `SymbolTable` 的核心任务不是“保存一堆字符串”，而是：

```text
维护一组可共享、不可变、需要稳定身份的元数据名字 atom
```

### 2.2 查找路径通常无锁，但这不等于 Symbol 永不删除

`SymbolTable::lookup(const char*, int, TRAPS)` 在 `symbolTable.cpp:319-334` 中的路径非常直接：

```cpp
unsigned int hashValue = hash_symbol(name, len);
int index = the_table()->hash_to_index(hashValue);

Symbol* s = the_table()->lookup(index, name, len, hashValue);
if (s != NULL) return s;

MutexLocker ml(SymbolTable_lock, THREAD);
return the_table()->basic_add(index, (u1*)name, len, hashValue, true, THREAD);
```

也就是说：

```text
先 probe
  → 命中就返回
  → miss 才拿 SymbolTable_lock 并插入
```

所以把 `SymbolTable` 描述为“读路径完全无锁”只能算缩写；更精确的是：**普通 probe 路径通常不持 `SymbolTable_lock`，插入路径才拿锁。**

更重要的是，不要把“probe 无锁”误解成“Symbol 永远不删除”。`symbolTable.cpp:297-302` 的注释给出了真正的前提：删除不会与正常执行期的 mutator lookup 并发发生，因为动态 Symbol 的 unlink 只发生在 safepoint/GC cleanup 阶段。

也就是说，lookup 的简单性依赖的是删除时机协议，而不是“这张表里的对象从不被回收”。

### 2.3 miss 后为什么还要锁内 duplicate recheck

如果两个线程同时对同一个新名字 miss：

```text
线程 A：probe miss
线程 B：probe miss
线程 A：准备插入
线程 B：也准备插入
```

就需要锁内再次确认，防止同内容 `Symbol` 被创建两份。

`basic_add` 会在锁内重查一遍 bucket，再决定是否创建新的 `Symbol`。这和 parser 里常量池 `Utf8` intern 的批量路径是同一套 canonicalization 原则：**无锁读取负责快，锁内复查负责正确。**

### 2.4 refcount 是 Symbol 的所有权账本

因为 `Symbol` 不归 Java heap GC 管，HotSpot 只能自己记录“还有谁在用它”。

`symbol.cpp:277-289` 中的 `increment_refcount()` / `decrement_refcount()` 使用原子操作维护这件事。`PERM_REFCOUNT` 表示永久/共享 symbol，不走普通动态项的回收逻辑。

所以 `SymbolTable` 的持有模型是：

```text
表里存的就是强引用 Symbol*
谁拿到 Symbol，谁通过 refcount 体现持有关系
refcount==0 只是表明“已无人持有”，不是立刻 delete
```

### 2.5 `unlink` 与 `rehash` 绝不是一回事

这是最常被混讲的地方。

`unlink` 在 `symbolTable.cpp:124-158`：

```text
遍历桶
  → refcount()==0
  → 删除 Symbol 与 entry
```

`rehash` 在 `symbolTable.cpp:182-204`：

```text
构造新表
  → 用新 seed 重新挂接现有活条目
  → 替换旧表
```

前者是**生命周期清理**，后者是**表结构维护**。如果把两者都说成“SymbolTable 清理”，读者会以为 bucket 深了就顺手把死 symbol 回收了，或者 refcount 归零会通过 rehash 被动消失。这两种理解都不对。

### 2.6 SymbolTable 适合全局锁的根本原因

现在可以收束 `SymbolTable` 的核心约束：

```text
对象不是 heap oop
GC 不替它判断所有权
删除时机可收束到 safepoint/GC cleanup
命中路径极短
```

这让 HotSpot 可以接受：

- probe 常态下不拿全局锁
- miss 时拿 `SymbolTable_lock`
- 生命周期用 refcount 管
- 清理靠 safepoint unlink

如果强行把它改成 `StringTable` 那种弱引用并发表，反而会失去本来最简单可靠的所有权模型。

---

## 三、StringTable：为什么 Java String 必须是弱引用并发 canonical table

### 3.1 `StringTable` 存的不是 value bytes，而是 Java heap 对象

`StringTableHash` 的 typedef 在 `stringTable.hpp:42-43`：

```cpp
typedef ConcurrentHashTable<WeakHandle<vm_string_table_data>,
                            StringTableConfig, mtSymbol> StringTableHash;
```

这行定义就已经暴露了和 `SymbolTable` 的根本分叉：

- key 的比较逻辑仍然基于字符串内容
- 但表中真正保存的 value 不是 `String` 本身的原地值，而是 `WeakHandle`

`StringTable` 还拥有自己的 `OopStorage* _weak_handles`，定义在 `stringTable.hpp:71`，构造时初始化于 `stringTable.cpp:185-188`。

这说明 `StringTable` 从一开始就不是“另一个普通字符串哈希表”，而是：

```text
一个针对 Java heap String 对象的、由弱句柄支撑的 canonical object table
```

### 3.2 intern 的入口链先问 shared table，再问活表，再决定插入

`JVM_InternString` 在 `jvm.cpp:3501-3509` 中 resolve JNI `jstring` 后调用 `StringTable::intern`。

`StringTable::intern(Handle, jchar*, int, TRAPS)` 的主链在 `stringTable.cpp:312-328`：

```text
1. 用 java_lang_String::hash_code 计算 shared-table hash
2. lookup_shared
3. 若启用 alt hash，重算本地表 hash
4. do_lookup
5. 仍未命中才 do_intern
```

这条三段式顺序很重要：

```text
CDS shared string table
  → local concurrent table
  → create/insert
```

也就是说，`StringTable` 不是每次都直接去本地并发表插入；CDS archived string table 在最前面就是一次命中路径优化。

### 3.3 `do_lookup` 会把“节点还在、对象已死”识别出来

因为 value 是 `WeakHandle`，所以 `do_lookup` 面对的并不总是“节点在，值就活着”。lookup helper 在比较时会先 `peek()`；若得到 `NULL`，就把该节点视为 dead entry。

这是一件 `SymbolTable` 根本不需要处理的事：`Symbol*` 在表中时，value 不存在“因为 GC 已经清了 referent 而节点暂存”的中间态；而 `StringTable` 必须接受这种中间态。

所以 `StringTable` 的查找逻辑天然比 `SymbolTable` 多一层判断：

```text
命中 bucket 中的某个 node
  → 先看 weak handle 还指不指向活 String
  → 再谈内容相等与返回对象
```

### 3.4 “并发”要讲准：不是“完全无锁”，而是 mostly concurrent

`ConcurrentHashTable` 的文件头注释就说得很清楚：这是一个“mostly concurrent-hashtable”，读侧接近 wait-free，插入使用 CAS，删除在 bucket 级别互斥。

所以“StringTable 是并发无锁表”太粗。更准确的说法是：

```text
读侧尽量无阻塞
更新/删除不是完全无锁
bucket 级别存在并发控制
后台 grow / bulk delete 也要通过表的并发任务协议运行
```

这条修正很重要，因为 intern 读者最容易把 “ConcurrentHashTable” 自动脑补成“任何操作都 lock-free”。HotSpot 11u 的实现并没有做这种承诺。

### 3.5 为什么 `StringTable` 不能像 SymbolTable 一样强持有对象

现在可以把核心问题说死：

如果 `StringTable` 强持有 interned `String`，那么表本身就成了这些对象的强 owner，GC 无法仅凭普通 reachability 回收它们。可 HotSpot 11u 明确不想让 interned String 天生永久化。

所以 `StringTable` 必须把“对象生死”让给 GC，只保留“canonical node”这个结构性存在。也因此，它必须由 `WeakHandle + OopStorage` 支撑，而不能只是一张 `oop*` 哈希表。

---

## 四、intern miss：为什么要先建 Java String，再建弱句柄节点

### 4.1 miss 之后，不是立刻往表里塞原始字节

`do_intern` 在 `stringTable.cpp:354-381`。如果调用方没有传现成 String，就会：

```cpp
string_h = java_lang_String::create_from_unicode(name, len, CHECK_NULL);
```

也就是说，intern miss 不是“先插一段字符内容，再惰性创建对象”。它先创建真正的 Java `String` 对象，然后再让表去 canonicalize 这个对象身份。

这和 `SymbolTable` 很不一样：`SymbolTable` 的 canonical 项本身就是 intern 的最终实体；而 `StringTable` 的 canonical 项最终必须是一个 Java heap `String` 对象。

### 4.2 `create_from_unicode` 的 backing store 永远是 `byte[]`

`java_lang_String::create_from_unicode` 与 `basic_create` 在 `javaClasses.cpp:240-285` 中实现了 JDK 9+ compact strings 语义：

```text
如果全是 Latin-1
  → byte[] 长度 = len
  → coder = LATIN1
否则
  → byte[] 长度 = len << 1
  → coder = UTF16
```

这里要特别强调：**String 的 value 仍然统一是 `byte[]`，只是在 coder 上区分 Latin-1 与 UTF-16。**

因此不能把 intern miss 讲成“创建 `char[]` 再入表”的旧版 Java 叙事。

### 4.3 dedup 发生在 intern 之前，但不等于 intern

`do_intern` 中有一段非常关键的注释：

```cpp
// Deduplicate the string before it is interned. Note that we should never
// deduplicate a string after it has been interned.
Universe::heap()->deduplicate_string(string_h());
```

这说明两件事：

1. `deduplicate_string` 是 intern 路径中的一步
2. 但它不等于 intern 自己的语义

`intern` 保证的是：

```text
同内容返回同一个 Java String 对象身份
```

`deduplicate_string` 关注的是：

```text
是否可以共享/优化 backing storage
```

这两者不能混成一句“intern 就是 dedup”。否则会误把对象身份 canonicalization 和底层字符存储去重说成同一件事。

### 4.4 `get_insert_lazy`：查重或插入，不保证当前线程新对象一定被采用

`do_intern` 最终用的是：

```cpp
_local_table->get_insert_lazy(THREAD, lookup, stc, stc, &rehash_warning);
```

这意味着并发下当前线程刚创建的 String 并不一定会成为表里的 canonical 对象。如果另一个线程更早为同内容成功插入了对象，那么当前线程会拿回那个已有对象。

所以 intern miss 的真正语义是：

```text
必要时先构造候选 String
  → 再与表协商谁成为 canonical object
```

而不是“new 一个 String 之后，它一定入表并成为唯一对象”。

### 4.5 hash 也不是永远只用 `String.hashCode()`

`StringTable::intern` 的第一步固定使用 `java_lang_String::hash_code` 去查 shared table，因为 CDS archived string table 的 hash 必须与 Java 语义一致。

但本地表若 `_alt_hash` 打开，会切到 `hash_string(..., true)`，即 `AltHashing::halfsiphash_32`。因此更准确的说法是：

```text
shared table / 默认路径 → Java String hashCode 兼容 hash
本地表在 rehash 防碰撞模式下 → alt hash
```

不能把 `StringTable` 简化成“始终用 `String.hashCode()` 的哈希表”。

---

## 五、弱引用与 GC 协作：为什么字符串不会被 StringTable 永远钉住

### 5.1 `WeakHandle` 先让 GC 判生死，表自己不做强拥有者

`WeakHandle` 的注释写得很直白：它指向一个由 `OopStorage` 管理的 oop 槽，若该值变成 `NULL`，说明 referent 已被 GC 清掉。

因此 `StringTable` 的 ownership 分工是：

```text
StringTable node
  → 保留一个 weak handle
GC
  → 负责判断这个 String 是否还活着
```

这就是为什么 interned String 不会仅因为“还在表里”就永远活着。

### 5.2 GC 清理的第一步不是删节点，而是把 weak slot 清 NULL

`StringTable::unlink_or_oops_do` 在 `stringTable.cpp:402-417` 中调用：

```cpp
_weak_handles->weak_oops_do(&stiac, tmp);
```

`OopStorage::weak_oops_do` 的契约是：若 `is_alive` 判定对象死亡，则把槽位中的 `oop` 设为 `NULL`。

这一步是 interned String 生命周期里最容易被忽略的细节。HotSpot 并不是在 GC 那一刻就同步把哈希节点也摘掉，而是先做：

```text
弱槽清 NULL
```

所以对象死亡和表结构清理是两件分开的事。

### 5.3 节点还在，但已经是 dead entry

一旦 weak slot 被清成 `NULL`，lookup 和 cleanup 逻辑就会把该节点视为 dead entry。`peek() == NULL` 正是 dead-entry 判断的依据。

这意味着表里存在这样一种中间状态：

```text
hash-table node 还在
但它指向的 String 已经死了
```

这在 `SymbolTable` 中几乎不会出现，因为 `Symbol*` 节点的删除与对象生死是同一步 unlink 清理；而在 `StringTable` 中，这是正常状态机的一部分。

### 5.4 生命周期是三段，而不是一步删除

所以一个 interned String 的生命周期更准确地说是：

```text
1. miss 时创建 String，对应节点插入表（弱持有）
2. 外部强引用消失后，GC 在 weak_oops_do 中把槽清 NULL
3. 后续并发维护再把 dead node 从 hash 表结构中摘掉
```

也就是说：

- **对象死亡** 由 GC 及时判断
- **表节点死亡** 由后续维护渐进处理

这正是“GC 清理的是对象存活，后台维护清理的是表结构”的准确分工。

---

## 六、后台维护：为什么 StringTable 需要 service thread，而 SymbolTable 不需要

### 6.1 `check_concurrent_work()` 只做决策，不做真正清理

`StringTable::check_concurrent_work()` 在 `stringTable.cpp:520-537` 检查三个条件：

```text
dead_factor > load_factor
load_factor > PREF_AVG_LIST_LEN
dead_factor > CLEAN_DEAD_HIGH_WATER_MARK
```

任何一个条件满足，就调用 `trigger_concurrent_work()`。

这里要强调：**它不会自己立刻删除 dead node。** 它只是说“现在值得让后台线程来维护这张表了”。

### 6.2 真正工作在线程后台完成

`trigger_concurrent_work()` 通过 `Service_lock` 把 `_has_work` 设为 true，并唤醒 service thread。之后 service thread 在 `serviceThread.cpp` 中检查到 `StringTable::has_work()`，再调用 `StringTable::do_concurrent_work(jt)`。

这种设计很重要，因为：

- mutator/GC 路径只负责记录“该清理/扩容了”
- 真正 grow 或 bulk delete 放到后台线程执行
- 避免在普通 intern 调用或 GC 弱处理路径里把整张表的结构维护做完

### 6.3 后台优先 grow，而不是只清死项

`concurrent_work()` 在 `stringTable.cpp:539-550` 中的策略是：

```text
若负载高且表还没到上限
  → 优先 grow
否则
  → clean_dead_entries
```

注释明确写了：prefer growing, since that also removes dead items。

这说明 grow、rehash、clean 不是三件完全平行的事。对于 StringTable 来说：

- grow 可以同时缓解负载并顺手把 dead entries 清掉
- clean_dead_entries 更像“空间还能忍，但 dead node 太多，需要专门打扫”

### 6.4 为什么 SymbolTable 不需要这套 service-thread 维护

对照前面 `SymbolTable` 的约束，就能看出差异：

```text
SymbolTable
  → 删除在 safepoint unlink
  → 对象不是 heap oop
  → 没有“node 还在但 referent 已死”的弱槽中间态
  → 负载维护是 rehash/safepoint 语义

StringTable
  → 弱槽先被 GC 清 NULL
  → dead node 可暂留
  → intern 是 Java 代码可触发的热点路径
  → 需要把结构维护摊给后台线程
```

这就是为什么 `StringTable` 需要 service thread，而 `SymbolTable` 不需要一个“平时在线并发表结构维护”的后台角色。

---

## 七、两张表放在一起看：同样叫 intern，真正不同的是所有权

现在把两张表的关键对照压缩成一张图：

```text
SymbolTable
  对象：Symbol（metadata）
  所有权：HotSpot 自己记账
  持有方式：强引用 + refcount
  删除语义：GC/safepoint unlink
  并发模型：probe 通常无锁，miss 后全局锁插入

StringTable
  对象：java.lang.String（heap oop）
  所有权：GC 判断生死
  持有方式：WeakHandle + OopStorage
  删除语义：GC 先清 weak slot，后台再删 dead node
  并发模型：mostly concurrent table + service-thread maintenance
```

这里最容易犯的四个误解，逐一澄清：

1. **StringTable 和 SymbolTable 只是 value 类型不同吗？** 不是。它们的对象生死判定者不同，因此清理协议、并发模型和持有方式都不同。
2. **SymbolTable probe 无锁，是否表示 Symbol 永不删除？** 不是。动态 Symbol 会在 safepoint/GC cleanup unlink，只是不与正常 lookup 并发删除。
3. **`intern` 是否等于 dedup？** 不是。intern 关心 canonical object identity；dedup 关心 backing storage 去重。
4. **interned String 死亡后是否立刻从表里消失？** 不是。对象先死，weak slot 先清 NULL，节点之后再被后台结构清理摘除。

如果再往深一层总结：

**HotSpot 不是在设计两张“字符串表”，而是在设计两套“canonicalization + 生命周期”协议。**

---

## 八、收网：谁拥有对象，谁决定 intern 表长什么样

回到开头的问题：为什么 HotSpot 不能只有一张 intern 表？

因为“相同内容只保留一份”只是需求表面；真正决定数据结构的是对象归谁管。

```text
Symbol
  → 不归 Java heap GC 管
  → HotSpot 自己用 refcount 记账
  → SymbolTable 可以强持有并在 safepoint unlink

String
  → 归 Java heap GC 管
  → 表不能成为强 owner
  → StringTable 只能弱持有并与 GC/后台清理协作
```

三句话收束本篇：

- **`SymbolTable` 的核心问题是如何共享不可变 metadata 名字，因此它选择强引用 + refcount + safepoint unlink。**
- **`StringTable` 的核心问题是如何 canonicalize Java heap 对象而不篡改其 GC 生命周期，因此它选择 `WeakHandle` + OopStorage + 并发表维护。**
- **同样叫 intern，真正决定实现的不是“字符串内容”，而是“谁拥有对象、谁负责回收”。**

下一篇沿着这个结论继续：名字唯一不等于类唯一。即使同一个 Symbol 只保存一份，`java/lang/String` 这个名字在不同 `ClassLoader` 下仍然可以代表不同类。SystemDictionary 就是“名字到类”关系真正开始分叉的地方。

> → [04 — SystemDictionary](04-system-dictionary.md)
