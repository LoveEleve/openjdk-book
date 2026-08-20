# 07-classfile-classloader/03-symbol-string-table 重写规划

> 基于 `OpenJDK 11u / HotSpot / Linux / x86_64`
> 目标：解释为什么 HotSpot 需要两张完全不同的 intern 表，以及两张表的结构差异如何由对象所有权和回收语义决定

## 1. 选题判断

现稿已经抓到“两张 intern 表、两种生命周期”的核心，但仍偏“结构对比说明书”：SymbolTable 一把锁，StringTable 并发哈希，后半再补 intern 路径和 GC 清理。

真正的读者困惑是：

**既然 `SymbolTable` 和 `StringTable` 都在解决“相同内容只存一份”，为什么 HotSpot 不用一张统一的 intern 表？为什么一个选择强引用 + refcount + safepoint unlink，另一个却必须是弱引用 + OopStorage + 并发哈希 + service thread 清理？**

## 2. 一句话顿悟

**“内容相同只保留一份”只是表象；真正决定数据结构的是“谁拥有对象、谁负责回收”。`SymbolTable` 管的是 Metaspace 里的不可移动 `Symbol`，GC 不替它记账，所以只能自己用 refcount 和 safepoint unlink 管生命周期；`StringTable` 管的是 Java heap 里的 `String` 对象，GC 天生知道谁死谁活，所以表只保留 `WeakHandle`，把生死判断和大部分并发压力交给 GC 与后台维护线程。**

## 3. 总图

```text
“相同内容只存一份”
  │
  ├─ SymbolTable
  │    ├─ 对象：Symbol（Metaspace/native metadata）
  │    ├─ 持有方式：强引用 + refcount
  │    ├─ 查找：无锁 probe，miss 后 SymbolTable_lock
  │    ├─ 删除：GC/safepoint unlink，按 refcount==0
  │    └─ 共享：CDS shared symbol table
  │
  └─ StringTable
       ├─ 对象：java.lang.String（Java heap object）
       ├─ 持有方式：WeakHandle + OopStorage
       ├─ 查找：shared table -> local concurrent table -> do_intern
       ├─ 删除：GC 先清 weak slot，后台并发清 dead node
       ├─ 维护：grow / rehash / clean_dead_entries
       └─ 共享：CDS shared string table
```

## 4. 结构大纲与字数预算

### 第一节：事故开场——为什么 JVM 不能只做一张“字符串 intern 表”

目标约 1000 字。

- 先并列两个例子：`java/lang/String` 这种元数据名字 vs `"abc".intern()` 这种 Java 对象
- 表面相同点：都想要“同内容唯一”
- 实际不同点：前者不是 Java heap 对象，后者是可移动、可回收的 Java 对象
- 提出真正问题：约束不一样，为什么 intern 结构还能一样？

### 第二节：三个朴素方案为什么会失败

目标约 1800 字。

至少推演：

1. 一张统一强引用表同时管 Symbol 和 String → 堆字符串生命周期被错误延长
2. 一张统一弱引用表同时管 Symbol 和 String → Metaspace Symbol 没有 GC 弱处理语义，反而失去稳定拥有者
3. 所有 intern 都做成单线程全局锁哈希 → `String.intern()` 用户可触发热点路径会被锁竞争放大

引出：决定 intern 表结构的不是“字符串”这个词，而是对象所有权和回收语义。

### 第三节：SymbolTable——为什么 Metaspace 名字适合强引用 + refcount

目标约 2000 字。

- Symbol 不是 Java String，而是 VM 元数据 atom
- 查找路径：先 probe，miss 后 `SymbolTable_lock`，锁内 duplicate recheck
- 正确措辞：probe 路径通常无锁，不等于 Symbol 永不删除；删除只在 GC/safepoint cleanup 发生，不与 mutator lookup 并发
- `hash_symbol` 默认复用 `java_lang_String::hash_code`，必要时走 `AltHashing::halfsiphash_32`
- shared symbol table (CDS)
- unlink vs rehash 的严格区分

### 第四节：StringTable——为什么 Java String 必须是弱引用并发 canonical table

目标约 2200 字（核心拆解层）。

- `StringTableHash = ConcurrentHashTable<WeakHandle<vm_string_table_data>, ...>`
- `String.intern()` 入口：`JVM_InternString` -> `StringTable::intern`
- 三段式查找：shared table -> local table -> do_intern
- `do_lookup` 如何把 `peek()==NULL` 识别为 dead entry
- “并发”要讲准：mostly-concurrent / wait-free-ish read side，不是“完全无锁”
- value 是 `WeakHandle` 而不是 `oop` 的根本原因：不能让表成为 String 的强拥有者

### 第五节：intern miss——为什么要先建 Java String，再建弱句柄节点

目标约 1700 字。

- `do_intern`：如果调用方没带现成 String，就 `create_from_unicode`
- `CompactStrings` 与 Latin-1 / UTF-16：backing store 永远是 `byte[]`
- dedup 在 intern 之前做，且不能写成“intern 等于 dedup”
- `get_insert_lazy`：查重或插入，并发竞态下可能返回已有对象
- hash 选择：shared table 固定 Java hash，本地表可切 alt hash

### 第六节：弱引用与 GC 协作——为什么字符串不会被 StringTable 永远钉住

目标约 2200 字（核心拆解层）。

- `WeakHandle` / `OopStorage` 的最小语义回顾
- GC 的 `weak_oops_do` 先把死 referent 的 slot 清 NULL
- 这时对象已死，但哈希节点可能仍在表里
- lookup/delete 看到 `peek()==NULL` 把它当 dead entry
- dead entry 真正摘链删除在后续 `clean_dead_entries` / grow 过程中完成
- 生命周期三阶段：intern miss 创建 -> GC 清 weak slot -> 后台并发结构清理
- 这就是“GC 清理的是对象存活，表清理的是节点结构”的严格分离

### 第七节：后台维护——为什么 StringTable 需要 service thread，而 SymbolTable 不需要

目标约 1500 字。

- `check_concurrent_work` 的三个触发条件：dead_factor、load_factor、高水位
- `trigger_concurrent_work` 唤醒 service thread
- `concurrent_work` 优先 grow，否则 `clean_dead_entries`
- grow/rehash/clean 三者边界
- 与 SymbolTable 的 safepoint unlink 形成对照：StringTable 的热点和 GC 协作要求它把维护摊到后台线程

### 第八节：两表对比与误解澄清

目标约 1400 字。

至少回答：

1. SymbolTable 和 StringTable 是否只是 value 类型不同
2. SymbolTable 读路径“无锁”是否意味着 Symbol 永不删除
3. StringTable 是否持有 interned String 的强引用
4. `intern` 是否等于 dedup
5. interned String 死亡后是否立刻从表里消失
6. StringTable 是否完全无锁
7. 两张表的 hash 是否完全一样且永远不变
8. 为什么 shared string table 与 shared symbol table 仍然要分开

### 第九节：收网与下篇钩子

目标约 900 字。

- 总图回收：intern 语义相同，但所有权不同
- 三句话总结
- 引到 `SystemDictionary`：名字唯一不等于类唯一；同名类在不同 ClassLoader 下仍可不同

## 5. 失败方案必须写进正文

1. 一张统一强引用表同时管 Symbol 和 String
2. 一张统一弱引用表同时管 Symbol 和 String
3. 所有 intern 都做成单线程全局锁哈希

## 6. 证据清单

- `jvm.cpp:3501-3509`：`JVM_InternString`
- `stringTable.hpp:42-43,71`：`StringTableHash` 与 `_weak_handles`
- `stringTable.cpp:185-188`：weak OopStorage 初始化
- `stringTable.cpp:312-328`：intern 三段式查找
- `stringTable.cpp:267-276`：`do_lookup`
- `stringTable.cpp:354-380`：`do_intern`
- `stringTable.cpp:339-342`：`WeakHandle` 节点创建
- `stringTable.cpp:365-367`：intern 前 dedup 注释
- `stringTable.cpp:520-537`：`check_concurrent_work`
- `stringTable.cpp:539-550`：`concurrent_work`
- `stringTable.cpp:402-417`：`unlink_or_oops_do`
- `stringTable.cpp:486-516`：`clean_dead_entries`
- `stringTable.cpp:226-229`：`trigger_concurrent_work`
- `serviceThread.cpp:104-123`：service thread 调度 StringTable 工作
- `stringTable.cpp:73-86`：hash 选择与 shared-table 约束
- `javaClasses.hpp:171-178`：`String.hashCode()` 对齐要求
- `javaClasses.cpp:240-285`：`create_from_unicode` / compact strings
- `weakHandle.hpp:34-40`、`weakHandle.inline.hpp:32-40`：WeakHandle 语义
- `oopStorage.hpp:37-46,129-142`：weak_oops_do 契约
- `oopStorage.inline.hpp:253-261,396-399`：GC 清 NULL 的具体语义
- `concurrentHashTable.hpp:28,76`：mostly concurrent / bucket lock 位
- `symbolTable.hpp:101-104`：SymbolTable 类型
- `symbolTable.cpp:319-334`：lookup fast path + lock insertion
- `symbolTable.cpp:500-507`：锁内 duplicate recheck
- `symbolTable.cpp:285-290`：hash_symbol
- `symbolTable.cpp:229-260`：shared symbol lookup
- `symbolTable.cpp:124-158,182-204,297-302`：unlink、rehash、lookup 与删除不并发边界
- `symbol.cpp:277-289`：原子 refcount

## 7. 必须明确的边界

- 基于 OpenJDK 11u / HotSpot / Linux / x86_64
- `StringTable` 的并发语义应描述为 mostly-concurrent / 读侧近似 wait-free，不写成“完全无锁”
- `intern` 与 `deduplicate_string` 语义不同：前者 canonical object identity，后者是 backing storage dedup
- GC 清 weak slot 与哈希节点摘链是两个阶段
- `String.hashCode()` 对齐只适用于默认/shared-table 路径；本地表 rehash 后可切 alt hash
- `SymbolTable` 的无锁 probe 依赖 safepoint cleanup 协议，不等于 Symbol 永不删除
- 不展开完整 ConcurrentHashTable 实现和 G1 string dedup 算法，只讲 intern 路径与生命周期所需边界

## 8. 完成后 review

- 删除代码后能否复述“同样叫 intern，但所有权不同，所以数据结构不同”
- 是否明确强/弱持有、GC 清 slot、后台删节点这三个层次
- 是否修正“完全无锁”“intern=dedup”“interned String 永不回收”等误解
- 是否把 SymbolTable 与 StringTable 的 hash、删除和 shared path 边界讲清
- 是否完成删码测试、禁用词、file:line、链接和版本边界检查
