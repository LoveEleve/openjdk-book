# PROMPT: 请撰写 04-SymbolTable.md

## ⚠️ 关键：本 prompt 是导航地图，不是预制答案。你必须亲自读源码。

- §四 答案方向是"指引"。不能直接抄到文档里。
- **必须逐个读取 §三 列出的源文件**，基于源码理解来写。
- 源码是证据（20%），分析洞察是正文（80%）。

## §〇 Production Scenario

两个 ClassLoader 同时加载 `"java/lang/Object"` → Thread A 和 B 同时 `SymbolTable::lookup("java/lang/Object", 19, THREAD)` → `lookup_dynamic(bucket[hash%20011])` → 遍历单向链表 → `e->hash()==hash` 快速过滤 → `sym->equals(name, len)` memcmp → 找到同一 Symbol* → `increment_refcount()` → 返回。两个 ClassLoader 获得完全相同的 C++ Symbol 对象——Arena 分配的不可变 Symbol 全网共享，零冗余。

**反事实**：如果每次加载类都创建新 Symbol（不共享）→ 10K classes × 平均 100 sym/class × 50B/Symbol → 50MB 额外内存 → 纯浪费。

## §一 Task + Narrative + Beginner Callouts

### Task

深度分析 SymbolTable 的 4 层内部设计：HashtableBucket 8B 指针 → HashtableEntry 24B 节点 → dual bump-pointer (Arena 360KB for Symbol + block allocator for entry) → refcount / PERM_REFCOUNT=-1 生命周期。

### Interview

"SymbolTable 继承 RehashableHashtable<Symbol*, mtSymbol>: `_buckets[20011]` 每个是 8B 的 `HashtableEntry*` 头指针。HashtableEntry 精确 24 bytes: `_hash`(4B)+padding(4B)+`_next`(8B)+`_literal`(8B)。双重 bump-pointer: Arena 360KB (`Amalloc_4`) 存 Symbol 对象本身 → `PERM_REFCOUNT=-1` 标记 bootstrap ClassLoader 永久 Symbol；block allocator 每次分配 512*24B=12KB 块存 HashtableEntry 节点。插入用头插法: `add_entry()`: `entry->set_next(bucket)` + `_buckets[index].set_entry(entry)` (release_store/load_acquire) → O(1)。查找: `bucket(index)` (load_acquire) → 遍历 → `e->hash()==hash` 过滤 → `sym->equals()` memcmp。为什么不需要锁？插入只在类加载时（classLoading_lock 保护），读取只遍历单向链表——无修改无竞态。refcount=0 标记 dead → `buckets_unlink()` 在 safepoint 批量删除 → 延迟清理（Arena 不支持单个释放）。hash 算法: `java_lang_String::hash_code` → bucket 深度超 `rehash_count=100` → 触发 SipHash 降级防 hash flooding。"

### Callouts（≥7，§一 inline）

1. **HashtableEntry 24B**: _hash(4B)+padding(4B to align _next to 8B)+_next(8B)+_literal(8B)=24B。padding 是 C++ 自然对齐的结果。
2. **PERM_REFCOUNT=-1**: bootstrap ClassLoader 的 Symbol refcount=-1 → `increment/decrement_refcount` 检测 `_refcount>=0` → 永久跳过。0xFFFF as signed short。
3. **dual bump-pointer**: Arena(360KB, `Amalloc_4`) for Symbol objects + block allocator (`NEW_C_HEAP_ARRAY2` 512 entries × 24B) for HashtableEntry nodes。
4. **release_store/load_acquire**: `get_entry()`=`load_acquire`, `set_entry()`=`release_store` → lock-free read 的关键。release 保证 entry 所有字段对后续 acquire 可见。
5. **head insertion + double lookup**: `add_entry` 头插法 O(1)。`basic_add` 分配前做第二次 lookup 防 race: 两个线程同时 intern 同一符号 → 后到者发现已存在 → 丢弃新创建。
6. **SipHash fallback**: bucket 深度 > `rehash_count=100` → `_needs_rehashing` → `AltHashing::halfsiphash_32` 替换 `String.hashCode` → 防 hash flooding DoS。
7. **ATOMIC_SHORT_PAIR**: `_refcount` + `_length` 打包在 32-bit word → 一次原子操作同时更新两个字段。

## §二 Standard Environment

Source: `symbolTable.hpp:101` (class), `symbolTable.cpp:209` (lookup_dynamic), `symbolTable.cpp:75` (initialize_symbols), `symbol.cpp:272` (refcount), `hashtable.hpp:121` (Bucket), `hashtable.hpp:44` (Entry), `hashtable.inline.hpp:99` (add_entry), `symbol.hpp:104` (Symbol class)

Key constants: SymbolTableSize=20011, symbol_alloc_arena_size=360K, PERM_REFCOUNT=-1, rehash_count=100

## §三 Source Files

| # | File | Role |
|---|------|------|
| 1 | `symbolTable.hpp` | 类声明 + create_table + lookup/probe |
| 2 | `symbolTable.cpp` | lookup_dynamic + basic_add + refcount cleanup |
| 3 | `symbol.hpp` | Symbol class + _refcount + _identity_hash |
| 4 | `symbol.cpp` | increment/decrement_refcount + operator new |
| 5 | `hashtable.hpp` | HashtableBucket + HashtableEntry + BasicHashtable |
| 6 | `hashtable.inline.hpp` | add_entry + get_entry (release/acquire) |

## §四 Deep Dive Question Groups（≥6）

### 4.1 ★★★ HashtableEntry 24B 精确布局
问：为什么 HashtableEntry 是 24 bytes 而不是 20？padding 从哪来？
答案方向: `_hash`=unsigned int=4B, 下一个是 `_next`=pointer=8B → 需要 4B 对齐 → compiler 插入 4B padding → _hash(4)+pad(4)+_next(8)+_literal(8)=24B。如果 `_hash` 是 8B (jlong) → 无 padding → 还是 24B。
追问: 为什么 `SymbolTable()` 构造参数 `entry_size=sizeof(HashtableEntry)`？→ `new_entry()` 用 `_entry_size` 做 bump-pointer `_first_free_entry += 24`。

### 4.2 ★★★ dual bump-pointer
问：Arena 和 block allocator 分别存什么？为什么需要两个分配器？
答案方向: Arena(360KB, `Amalloc_4`) → Symbol 对象（变长: `sizeof(Symbol) + utf8_length`）。block allocator (12KB blocks) → HashtableEntry 节点（固定 24B）。不同生命周期: Symbol 可能被多个 entry 引用（同一个 Symbol 在多个 ClassLoader 间共享），entry 仅属于 SymbolTable。不同分配策略: Arena 不可单个释放（永久 Symbol），block allocator 有 `_free_list` 回收 deleted entry。
追问: `c_heap=true` 的 Symbol 走 C-Heap？→ `Symbol::operator new(len, THREAD)` → `AllocateHeap(mtSymbol)` → 可被单个释放 → 对应普通 ClassLoader。
反事实: 只用一个分配器 → 需要支持可变大小 + 可能释放 → 复杂度增加 → Arena 的简单性丧失。

### 4.3 ★★★ PERM_REFCOUNT 永久 Symbol
问：`_refcount=-1` 的 Symbol 如何被识别为永久？为什么 bootstrap ClassLoader 的 Symbol 必须永久？
答案方向: `increment_refcount`: `if (_refcount >= 0) Atomic::inc` → negative skip。`decrement_refcount`: `if (_refcount >= 0) Atomic::add(-1)`。Bootstrap ClassLoader symbol 永不被卸载（JVM 生命周期内始终需要 `java/lang/Object` 等核心类名）。
追问: `refcount=0` 时什么时候真正删除？→ `buckets_unlink()` 在 safepoint 调用 → `entry->literal()->refcount()==0` → delete entry + delete Symbol (C-Heap only, Arena skip)。

### 4.4 ★★★ lock-free read with release/acquire
问：`get_entry()` (load_acquire) 和 `set_entry()` (release_store) 如何保证并发安全？
答案方向: 写入: `new_entry→set_next(old_head)` → `_buckets[index].set_entry(new_entry)` (release_store)。读取: `bucket(index)` → `get_entry()` (load_acquire) → 遍历单向链表。release/acquire 配对保证: 读线程看到 new_entry 时必然也看到 new_entry 的所有初始化字段。头插法保证已有 entry 的 `_next` 不变 → 遍历安全。

### 4.5 ★★★ lookup 三步过滤
问：`lookup_dynamic` 为什么先 hash 后 memcmp？效率对比？
答案方向: Step1: `e->hash()==hash` → 4B 整数比较 O(1)。Step2: `sym->equals(name,len)` → 逐字节 memcmp O(len)。hash 快速淘汰 99%+ 不匹配 → 减少 memcmp 调用。如果直接用 memcmp → 每个 entry 都是 O(len) → 100 entries × 50B = 5KB 逐字节比较 → 慢 100×。
追问: `sym->equals` 从后往前比较？→ `while(l-->0) str[l]!=byte_at(l)` → 反向遍历可能是编译器优化的结果或特殊意图。

### 4.6 ★★★ SipHash fallback
问：什么时候从 `java_lang_String::hash_code` 切换到 SipHash？如何触发？
答案方向: `lookup_dynamic` 中 `count >= rehash_count && !needs_rehashing()` → `check_rehash_table(count)`: 此 bucket 深度 >100 → `_needs_rehashing=true` → 新建表 → 全部 re-insert 用 `AltHashing::halfsiphash_32(seed, data, len)`。SipHash 是密码学哈希，抗碰撞攻击——防止攻击者构造大量 hash 相同符号 → 某 bucket 深度→O(n) → DoS。
追问: seed 从哪来？→ `_seed = AltHashing::compute_seed()` → 随机生成，每次 rehash 换种子。

### 4.7 ★★★ basic_add 的 double lookup 防 race
问：两个线程同时 intern 同一符号，basic_add 如何保证只有一个 Symbol 对象？
答案方向: Thread A: lookup → NULL → allocate_symbol → new_entry → add_entry(头插) → return Thread B: lookup → NULL → allocate_symbol → basic_add → 第二次 lookup (protected by classLoading_lock?) → 找到 A 的 entry → 返回 A 的 Symbol → 丢弃 B 的 Symbol (decrement_refcount → 0 → delete)。

## §六 不要写成→应该写成

| 不要写成 | 应该写成 |
|---------|---------|
| "SymbolTable 哈希表" | "HashtableBucket[20011] 每个 8B 指针→HashtableEntry 单向链表→hash 32bit+next 64bit+literal 64bit=24B/entry" |
| "Arena bump-pointer" | "`initialize_symbols(360*K)`→`new Arena(mtSymbol,360*1024)`: _hwm→max, `Amalloc_4` 原子自增 4B 对齐; block allocator: `NEW_C_HEAP_ARRAY2` 512×24B blocks" |
| "refcount 回收" | "`increment_refcount`: `if(_refcount>=0)Atomic::inc`; `decrement_refcount`: `if(>=0)Atomic::add(-1)`; refcount=0→dead→`buckets_unlink()` safepoint cleanup" |
| "不需要锁" | "release_store (set_entry) + load_acquire (get_entry) → lock-free read; insert only during classLoading_lock → no concurrent writes" |

## §八 Prohibited（≥8）
❌ 不画 Entry 24B 布局 → ❌ 不展示 dual allocator → ❌ 不提 PERM_REFCOUNT → ❌ 不画 release/acquire → ❌ 不展示 lookup_dynamic → ❌ 不提 SipHash → ❌ 不说 double lookup → ❌ 不写 GDB

## §九 Required（≥8）
✅ ★ HashtableEntry 24B 分解图 ✅ ★ dual allocator ASCII 图 ✅ ★ PERM_REFCOUNT vs refcount 对比表 ✅ ★ release_store/load_acquire 时序图 ✅ ★ Mermaid lookup 流程图 ✅ ★ SipHash fallback 触发条件 ✅ ★ 面试 Story ✅ ★ GDB 7 断点

## §十 GDB

断言 1: create_table→`print _the_table->table_size()`(20011)
断言 2: Arena→`print _arena->_hwm, _arena->_max`
断言 3: entry→`print sizeof(HashtableEntry)` (24)
断言 4: lookup→`print sym->utf8_length(), sym->refcount()`
断言 5: PERM_REFCOUNT→检查 bootstrap sym `_refcount==-1`
断言 6: add_entry→break `set_entry` before/after release_store
断言 7: freelist→`print _free_list` (recycled entries)

路径: `docs/04-SymbolTable.md`
