# 00-Tag-Level-Selection-Configuration — -Xlog 字符串 → `log_is_enabled()` 全链路

> **阶段**：[23-logging]
> **前置**：[01-jvm-startup]（create_vm 阶段 LogConfiguration 初始化时机）
> **配套**：[01-Output-Pipeline]（LogOutput::write()/LogFileOutput 输出路径）、[02-Message-Composition]（log_debug 宏展开 → LogTarget/LogMessage 消息构造）
> **后续依赖本文**：[24-utilities]（malloc/arena 分配器日志输出依赖 logging 配置体系）
> **阅读收益**：追踪 `-Xlog:gc+class*=debug` 从命令行字符串到运行时 `log_is_enabled()` 布尔判断的完整 5 阶段数据流——理解 X-MACRO 的编译期 enum 和字符串同步、LogTagSetMapping 模板驱动的编译期全局 tagset 注册、LogSelection 的解析引擎与 wildcard 匹配逻辑、LogSelectionList 的逗号分隔多选择器优先级覆盖、ConfigurationLock 的 Semaphore 互斥保护、VM.log DCMD 的运行时动态重配置、以及 fuzzy_match/suggest_similar_matching 两层智能纠错机制

---

## §〇 生产场景 — 三个线上故障 + 三步诊断 + 反事实

### 场景 1：GC 日志淹没磁盘（Level 配错）

线上 `-Xlog:gc*=trace:file=gc.log::filesize=100M,filecount=5`。但 gc.log 在以 50MB/s 的速度增长——`trace` 级别的每个 safepoint GC 日志（每 10ms 一次 young GC，~500 字节/trace 行 = 50KB/s per safepoint）叠加了所有带有 gc 标签的子系统（gc+heap, gc+phases, gc+remset, gc+plab...共 20+ 个 tagset）。

**源码根因**：`LogSelection::selects()` (logSelection.cpp:161-171) 带 wildcard 时仅检查选择器的 tags 都是 LogTagSet 的子集即可匹配，不要求 tag 数量对等。`LogLevel::type` 中 `trace` 是 `LOGGING_LOG_LEVEL` 中最低最详尽的级别（logLevel.hpp:32-33 "extensive/noisy"），搭配通配符后匹配了所有含 gc 子标签的 tagset。

**诊断与修复**：
```bash
# 1. 查看当前配置
jcmd <pid> VM.log list
# 发现 gc*=trace → 改为
jcmd <pid> VM.log output="file=gc.log" what="gc=info"
# 仅将纯 gc tagset（无子标签）设为 info 级别
```

### 场景 2：JIT 日志神秘消失（Tag 精确匹配陷阱）

线上配置 `-Xlog:jit=debug` 期望看到 JIT 编译日志。但没有任何输出。

**源码根因**：HotSpot 的 JIT 编译日志实际使用多标签组合（如 `jit+compilation` 或 `jit+inlining`），而 `-Xlog:jit=debug` 不带通配符时只精确匹配恰好 1 个 tag 为 `jit` 的 LogTagSet——`LogSelection::selects()` (logSelection.cpp:162) 中 `_ntags != ts.ntags()` 直接返回 false。

**修复**：`-Xlog:jit*=debug` —— 加上通配符，`selects()` 只检查 selection 的 tag 是否为 tagset 的子集而不要求数量相等（logSelection.cpp:161-171）。

### 场景 3：动态日志调整的竞态（ConfigurationLock）

运维通过 `jcmd <pid> VM.log what="gc=info"` 调整日志级别，但调整前后几毫秒内仍有部分 gc 日志行以旧级别输出。

**源码根因**：`ConfigurationLock` (logConfiguration.cpp:55-78) 是基于 `Semaphore(1)` 的互斥锁，`configure_output()` (logConfiguration.cpp:216-274) 在锁保护下遍历所有 LogTagSet 逐个更新 `set_output_level()`。在遍历过程中，前一半 LogTagSet 已更新为新级别，后一半还是旧级别——其他线程并发调用 `log_is_enabled()` (logTagSet.hpp:114) 读取 `_output_list.is_level(level)` 时可能看到不一致的中间状态。

**设计权衡**：这不是 bug，而是设计权衡——日志配置调整不要求全局原子性（那需要 stop-the-world safepoint），代价是"过渡期几毫秒的不一致"。更新完成后 `notify_update_listeners()` (logConfiguration.cpp:602-607) 通知注册的回调。

### 三步诊断

```bash
# 1. 查看当前日志配置
jcmd <pid> VM.log list
# 输出: 每个 output 编号 + 当前 selections + decorators

# 2. 列出所有可用 tag 和 tagset（确认自己想要的那个 tagset 叫什么）
java -Xlog:help 2>&1 | grep -A 100 "Described tag sets"
# 或
jcmd <pid> VM.log list | grep "Available log tags"

# 3. 动态调整（不用重启 JVM）
jcmd <pid> VM.log what="gc+class*=debug" output="file=gc.log" decorators="uptime,level,tags"
```

### 反事实：Wildcard 全选 vs 全精确的两种极端

如果 LogSelection 不做 wildcard/exact 区分，所有选择器都按子集匹配（即默认 wildcard=true）→ `-Xlog:gc=debug` 会匹配 gc+class、gc+heap 等所有含 gc 的 tagset → 输出量爆炸，无法精确过滤。如果所有选择器都按精确匹配（默认 wildcard=false）→ `-Xlog:gc*=debug` 这个语法完全不存在 → JIT 日志需要记住所有排列组合才能配置（`-Xlog:jit+compilation=debug,jit+inlining=debug,...`）。`*` wildcard 是一个设计权衡：给用户提供"精确 vs 宽泛"两种模式的选择权。

---

## §一 Tag-Level-Selection-Configuration 源码全链路

> **这不是 -Xlog 使用手册 — 这是 `-Xlog:gc+class*=debug` 字符串如何变成运行时 `log_is_enabled()` 布尔判断的内核级文档。**

### 1.1 编译期：X-MACRO 双重展开 — Tag 枚举与字符串同步

Before `main()`—before any C++ constructor runs—GCC has already expanded `LOG_TAG_LIST` X-MACRO:

```cpp
// logTag.hpp:199-205 — enum 展开
enum type {
  __NO_TAG,
#define LOG_TAG(name) _##name,
  LOG_TAG_LIST
#undef LOG_TAG
  Count
};
// 展开后:
// enum type { __NO_TAG, _add, _age, _alloc, ... _gc, _jit, ... Count };

// logTag.cpp:31-36 — _name[] 字符串数组展开
const char* LogTag::_name[] = {
  "", // __NO_TAG
#define LOG_TAG(name) #name,
  LOG_TAG_LIST
#undef LOG_TAG
};
// 展开后:
// const char* LogTag::_name[] = { "", "add", "age", "alloc", ... "gc", "jit", ... };
```

**X-MACRO 并排展开对比**：

| 位置 | `#define LOG_TAG(name)` | `LOG_TAG(gc)` 展开结果 |
|------|------------------------|----------------------|
| logTag.hpp:201 (enum) | `_##name` | `_gc` (枚举值，整型下标) |
| logTag.cpp:33 (_name[]) | `#name` | `"gc"` (const char*，字符串字面量) |

关键：枚举值的序号与字符串数组的下标严格一一对应。`LogTag::name()` (logTag.hpp:207-209) 做 `return _name[tag]`——O(1) 数组索引直接获取字符串名。添加新 tag 只需在 `LOG_TAG_LIST` (logTag.hpp:34-174) 加一行 `LOG_TAG(tagname)`，两个位置自动同步。

> **Counterfactual** — 如果 LOG_TAG_LIST 产生 tag 枚举值但字符串名称用手工维护的 switch-case 映射，则添加新 tag 需要改两处：enum + switch 添加 case。一旦漏改 switch → name() 对合法 enum 值返回空字符串或崩溃。fuzzy_match() 的 similarity 计算依赖 strcmp → 空字符串会导致不可预测的匹配建议。生产环境已多处发生"tag 有值但名称缺失"的 bug（enum 改了 switch 漏了）。X-MACRO 的"一处添加、两处展开"从根本上杜绝此类 bug。但代价：LOG_TAG_LIST 只能是一维宏调用（每个 tag 一行），不能给每个 tag 附加任意元数据（如注释/分组），只能靠行尾 `/* comment */`。

`MAX_TAGS = 5` (logTag.hpp:197) 表示单条 log 消息最多附加 5 个 tag 用于分类。

`LOG_TAGS_EXPANDED` 宏 (logTag.hpp:181-182) 和 `LOG_TAGS()` (logTag.hpp:185) 将 log 调用中的 tag 参数展开为带前缀的枚举值：
```cpp
// LOG_TAGS(gc, class) 展开为:
// PREFIX_LOG_TAG(gc), PREFIX_LOG_TAG(class), PREFIX_LOG_TAG(_NO_TAG), ...
// → LogTag::_gc, LogTag::_class, LogTag::__NO_TAG, ...
```

### 1.2 静态初始化：LogTagSetMapping 模板驱动编译期 TagSet 注册

C++ 静态初始化顺序执行时，`LogTagSetMapping<LogTag::_gc, LogTag::_class, ...>::_tagset` 的静态成员 (logTagSet.hpp:156-157) 在模板实例化时调用 `LogTagSet` 构造函数：

```cpp
// logTag.hpp:156-157 — 静态成员定义（触发构造函数调用）
template <LogTagType T0, LogTagType T1, LogTagType T2, LogTagType T3, LogTagType T4, LogTagType GuardTag>
LogTagSet LogTagSetMapping<T0, T1, T2, T3, T4, GuardTag>::_tagset(
    &LogPrefix<T0, T1, T2, T3, T4>::prefix, T0, T1, T2, T3, T4);

// logTagSet.cpp:42-56 — 构造函数源码（头插法 + 默认级别设置）
LogTagSet::LogTagSet(PrefixWriter prefix_writer, LogTagType t0, LogTagType t1,
                     LogTagType t2, LogTagType t3, LogTagType t4)
    : _next(_list), _write_prefix(prefix_writer) {  // ← 保存旧的 _list 为 _next
  _tag[0] = t0; _tag[1] = t1; _tag[2] = t2; _tag[3] = t3; _tag[4] = t4;
  for (_ntags = 0; _ntags < LogTag::MaxTags && _tag[_ntags] != LogTag::__NO_TAG; _ntags++) {}
  _list = this;       // ← 头插法：将自己设为新的链表头 (line 51)
  _ntagsets++;        // ← 全局计数器 +1 (line 52)
  _output_list.set_output_level(&StdoutLog, LogLevel::Default);  // ← 默认 Warning+Error→stdout (line 55)
}
```

**构造流程**：
1. `_next = _list` — 保存旧链表头（logTagSet.cpp:43 初始化列表）
2. 将 5 个 tag 参数存入 `_tag[]` 数组（logTagSet.cpp:44-48）
3. 计数有效 tag 到 `_ntags`（logTagSet.cpp:49）
4. `_list = this` — 将自己插入链表头部（logTagSet.cpp:51）
5. `_ntagsets++` — 全局计数器递增（logTagSet.cpp:52）
6. 默认所有 tagset 向 stdout 输出 Warning 和 Error（logTagSet.cpp:55，`LogLevel::Default = Warning`，logLevel.hpp:64）

**全局状态**：
```cpp
// logTagSet.cpp:37-38
LogTagSet*  LogTagSet::_list      = NULL;  // 全局链表头指针
size_t      LogTagSet::_ntagsets  = 0;     // 全局 tagset 数量
```

模板实例化是由编译器在"被使用时"自动完成的，不需要手动注册。任何新的 tag 组合一旦在代码中出现（通过 `log_debug(gc, class)(...)` 宏），编译器就会生成对应的 `LogTagSetMapping` 模板实例化 → 触发静态成员 `_tagset` 的构造。`STATIC_ASSERT(GuardTag == LogTag::__NO_TAG)` (logTagSet.hpp:142) 确保用户不会传入超过 5 个有效 tag。

> **Counterfactual** — 如果 LogTagSet 不做模板化编译期生成，而是运行时由 LogConfiguration::initialize() 动态创建所有可能的 tag 组合，则 100 个 tag（Count≈100），MaxTags=5 → 理论组合数 = C(100,1)+C(100,2)+C(100,3)+C(100,4)+C(100,5) ≈ 92 亿个组合，实际有用的只有几百个（代码中实际被引用的），运行时创建所有组合完全不可行。编译器只创建模板实际被实例化的组合（惰性生成）——只有代码中用到的组合才消耗静态初始化时间和内存。如果没有模板机制，每个 TagSet 需要手动宏注册（类似 logTagSetDescriptions.cpp 的结构），新增 tag 组合需要修改多处，维护负担随子系统增长线性增长。

**ODR 保证**：C++ One Definition Rule 规定同一模板实例化在所有翻译单元中只有一个定义。链接器会合并重复实例化，保证每个 tag 组合只有一个 `LogTagSet`。

### 1.3 命令行入口：parse_command_line_arguments() 按 `:` 分割

```cpp
// logConfiguration.cpp:330-401
bool LogConfiguration::parse_command_line_arguments(const char* opts) {
  char* copy = os::strdup_check_oom(opts, mtLogging);  // :330-331

  // Split the option string to its colon separated components.  // :333
  char* substrings[4] = {0};  // :335 — 4 fields: what, output, decorators, output_options
  for (int i = 0; i < 4; i++) {
    substrings[i] = str;                    // :337
    char* next = strpbrk(str, ":\"");       // :340 — 找冒号或引号
    while (next != NULL && *next == '"') {  // :350 — 跨过引号内的冒号
      char* end_quote = strchr(next + 1, '"');
      next = strpbrk(end_quote + 1, ":\"");
    }
    if (next != NULL) { *next = '\0'; str = next + 1; }  // :361-363
    else { break; }
  }

  char* what = substrings[0];           // :370 — "gc+class*=debug"
  char* output = substrings[1];         // :371 — "file=gc.log"
  char* decorators = substrings[2];     // :372 — "uptime,level,tags"
  char* output_options = substrings[3]; // :373
  bool success = parse_log_arguments(output, what, decorators, output_options, &ss);  // :376
```

**分割示例**：`"gc+class*=debug:file=gc.log:uptime,level,tags"` → `substrings[0]="gc+class*=debug"`, `substrings[1]="file=gc.log"`, `substrings[2]="uptime,level,tags"`, `substrings[3]=NULL`.

注意 Windows 路径特殊处理（logConfiguration.cpp:342-349）：跳过 `C:\...` 和 `file=C:\...` 中的冒号。

错误输出逐行写入 `logging` tagset 的 log（logConfiguration.cpp:378-396），级别 `success ? Warning : Error`。

### 1.4 选择器解析：LogSelection::parse_internal() 逐步拆解

`parse_log_arguments()` → `LogSelectionList::parse("gc+class*=debug")` → `LogSelection::parse()` 调用 `parse_internal()`：

```cpp
// logConfiguration.cpp:403-414
bool LogConfiguration::parse_log_arguments(const char* outputstr, const char* selectionstr, ...) {
  if (outputstr == NULL || strlen(outputstr) == 0) outputstr = "stdout";  // :409-411
  LogSelectionList selections;
  if (!selections.parse(selectionstr, errstream)) return false;               // :414 (→ logSelectionList.cpp:58)

// logSelectionList.cpp:58-90 — 按 ',' 分割多个 selection
bool LogSelectionList::parse(const char* str, outputStream* errstream) {
  if (str == NULL || strcmp(str, "") == 0) str = "all";  // :60-62 — 默认表达式
  char* copy = os::strdup_check_oom(str, mtLogging);
  for (char *comma_pos = copy, *cur = copy; success && comma_pos != NULL; cur = comma_pos + 1) {
    if (_nselections == MaxSelections) { ... success = false; break; }  // :66-73 — MaxSelections=256
    comma_pos = strchr(cur, ',');                                        // :75
    if (comma_pos != NULL) *comma_pos = '\0';                           // :77
    LogSelection selection = LogSelection::parse(cur, errstream);        // :80
    _selections[_nselections++] = selection;                             // :85
  }
```

`LogSelection::parse()` (logSelection.cpp:154-159) 是包裹函数——复制字符串后调用 `parse_internal()`，解析完后释放副本。核心解析在 `parse_internal()` (logSelection.cpp:72-152)：

**Step 1** — 解析 `=` 提取 Level（logSelection.cpp:74-91）：
```cpp
char* equals = strchr(str, '=');  // :75
if (equals != NULL) {
  const char* levelstr = equals + 1;
  level = LogLevel::from_string(levelstr);  // :78 → logLevel.cpp:36-43 O(n) strcasecmp 查找
  if (level == LogLevel::Invalid) {
    // fuzzy match for helpful error message
    LogLevelType match = LogLevel::fuzzy_match(levelstr);  // :82 → logLevel.cpp:45-59
    // output "Invalid level 'xxx'. Did you mean 'yyy'?"
    return LogSelection::Invalid;
  }
  *equals = '\0';  // :90 — 就地截断字符串，str 现在只剩 "gc+class*"
}
```

**Step 2** — 检测特殊字符串 `"all"`（logSelection.cpp:97-99）：
```cpp
if (strcmp(str, "all") == 0) {
  return LogSelection(tags, true, level);  // tags 全为 __NO_TAG, wildcard=true
}
```

**Step 3** — 检测 `*` 通配符后缀（logSelection.cpp:102-107）：
```cpp
char* asterisk_pos = strchr(str, '*');  // :103
if (asterisk_pos != NULL && asterisk_pos[1] == '\0') {  // :104 — '*' 必须在末尾
  wildcard = true;
  *asterisk_pos = '\0';  // :106 — 就地截断，去掉 '*'
}
```

**Step 4** — 按 `+` 分割 tag 并 lookup（logSelection.cpp:110-138）：
```cpp
char* cur_tag = str;
do {
  plus_pos = strchr(cur_tag, '+');          // :113
  if (plus_pos != NULL) *plus_pos = '\0';   // :115 — 就地截断
  LogTagType tag = LogTag::from_string(cur_tag);  // :117 → logTag.cpp:38-45
  if (tag == LogTag::__NO_TAG) {
    // fuzzy match for helpful error message
    LogTagType match = LogTag::fuzzy_match(cur_tag);  // :121 → logTag.cpp:47-61
    // output "Invalid tag 'xxx'. Did you mean 'yyy'?"
    return LogSelection::Invalid;
  }
  if (ntags == LogTag::MaxTags) { ... return Invalid; }  // :129-135
  tags[ntags++] = tag;
  cur_tag = plus_pos + 1;
} while (plus_pos != NULL);
```

**Step 5** — 重复 tag 检测（logSelection.cpp:140-149）：双重循环检查 tags[] 中是否有重复值。

**Step 6** — 构造 LogSelection 对象（logSelection.cpp:151）：
```cpp
return LogSelection(tags, wildcard, level);  // → 调用构造函数 :39-51
```

**LogSelection 构造函数** (logSelection.cpp:39-51)：
```cpp
LogSelection::LogSelection(const LogTagType tags[LogTag::MaxTags], bool wildcard, LogLevelType level)
    : _ntags(0), _wildcard(wildcard), _level(level), _tag_sets_selected(0) {
  while (_ntags < LogTag::MaxTags && tags[_ntags] != LogTag::__NO_TAG) {
    _tags[_ntags] = tags[_ntags]; _ntags++;   // :41-44 — 拷贝 tag 数组
  }
  for (LogTagSet* ts = LogTagSet::first(); ts != NULL; ts = ts->next()) {  // :46
    if (selects(*ts)) _tag_sets_selected++;    // :47-49 — 统计此 selection 匹配多少 tagset
  }
}
```

**为什么用就地修改（`*equals = '\0'`）而非 `strtok()`**：`strtok()` 有线程不安全的全局静态状态。`parse_internal()` 在 `os::strdup_check_oom()` 创建的堆副本上操作（logSelection.cpp:155），修改安全，解析完后 `os::free(copy)` 释放（logSelection.cpp:157）。

**LogTag::from_string() 实现** (logTag.cpp:38-45)：
```cpp
LogTagType LogTag::from_string(const char* str) {
  for (uint i = 0; i < LogTag::Count; i++) {
    if (strcasecmp(str, _name[i]) == 0) {     // POSIX strcasecmp, man 3 strcasecmp
      return static_cast<LogTagType>(i);
    }
  }
  return __NO_TAG;
}
```

`strcasecmp` 而非 `strcmp`——命令行大小写不应有语义，"GC" 和 "gc" 输入歧义不值得让用户重启 JVM。O(Count) 线性扫描，对于 ~100 个 tag 仅在配置阶段发生（启动或 jcmd）。

> **Counterfactual** — 如果 from_string() 不做 strcasecmp 而用 strcmp 做大小写敏感匹配，则用户写 `-Xlog:GC=debug` 会得到 "Invalid tag 'GC'" 错误 + fuzzy suggestion "Did you mean 'gc'?"——错误消息正确引导了用户但 JVM 命令行是 C 代码（非交互式），用户没有第二次编辑机会，`-Xlog:GC=debug` 导致整个 JVM 启动失败。1 次写错 → 1 次 JVM 失败 → 修改 → 1 次 JVM 成功需要 3 步；strcasecmp 只需 1 步（用户随意大小写直接成功）。代价是 from_string() 每次调用需要 strcasecmp（O(n) per char，对短字符串可忽略），但对 100 个 tag 仅在配置解析阶段发生（启动时 + jcmd 时），不在热路径。

### 1.5 多选择器组合：LogSelectionList

`LogSelectionList` (logSelectionList.hpp:38-63) 存储最多 `MaxSelections = 256` 个 `LogSelection`。逗号分隔的 selection 字符串 `"gc=debug,gc+class=trace"` 被 `parse()` 分割后逐个创建 `LogSelection` 存入数组。

### 1.6 配置分发：configure_output() 持有 ConfigurationLock 全遍历

`parse_log_arguments()` 获取 `ConfigurationLock` (logConfiguration.cpp:423)，然后调用 `configure_output()`：

```cpp
// logConfiguration.cpp:216-274
void LogConfiguration::configure_output(size_t idx, const LogSelectionList& selections,
                                        const LogDecorators& decorators) {
  assert(ConfigurationLock::current_thread_has_lock(), ...);  // :217
  LogOutput* output = _outputs[idx];                           // :219
  output->_reconfigured = true;                                // :221
  size_t on_level[LogLevel::Count] = {0};                      // :223
  bool enabled = false;                                        // :225

  // ★ 第一轮遍历：设置级别 + 累计装饰器
  for (LogTagSet* ts = LogTagSet::first(); ts != NULL; ts = ts->next()) {  // :226
    LogLevelType level = selections.level_for(*ts);  // :227 → LogSelectionList::level_for
    // 跳过未被选中也不输出的 tagset
    if (!ts->has_output(output) && (level == LogLevel::NotMentioned || level == LogLevel::Off)) {
      on_level[LogLevel::Off]++; continue;  // :230-233
    }
    if (level != LogLevel::Off) {
      ts->update_decorators(decorators);  // :237-239 — 确保装饰器在设置级别前就绪
    }
    if (level != LogLevel::NotMentioned) {
      ts->set_output_level(output, level);  // :243 — 写入新级别
    } else {
      level = ts->level_for(output);  // :246 — 复用旧级别
    }
    if (level != LogLevel::Off) enabled = true;  // :249-252
    on_level[level]++;  // :255 — 统计各级别 tagset 数量
  }

  output->set_decorators(decorators);  // :259 — 设置 output 的装饰器

  // ★ 第二轮遍历：清理不再被任何 output 使用的装饰器
  for (LogTagSet* ts = LogTagSet::first(); ts != NULL; ts = ts->next()) {  // :262
    ts->update_decorators();  // :263 — 无参数调用 = 只保留活跃 output 的装饰器
  }

  if (!enabled && idx > 1) {  // :266-269
    delete_output(idx); return;  // 删除未使用的 output（stdout/stderr 除外）
  }
  output->update_config_string(on_level);  // :272
}
```

**为什么需要两轮遍历**：第一轮设定新配置，装饰器累计跨所有 output。第二轮在确认哪些装饰器没有被任何 output 使用后清理——避免 tagset 持有无用装饰器引用。如果把两轮合并为一轮 → tagset 顺序依赖——已设为 off 的 output 的装饰器被误删时可能影响其他 output 仍在使用的装饰器。

**LogSelectionList::level_for()** (logSelectionList.cpp:92-101) — 最后匹配胜出：
```cpp
LogLevelType LogSelectionList::level_for(const LogTagSet& ts) const {
  LogLevelType level = LogLevel::NotMentioned;
  for (size_t i = 0; i < _nselections; i++) {
    if (_selections[i].selects(ts)) level = _selections[i].level();  // 覆盖!
  }
  return level;
}
```

> **Counterfactual** — 如果 level_for() 的语义是"首次匹配胜出"而非"最后匹配胜出"，则 `-Xlog:all=debug,gc=trace` 中 all 先匹配 → level=debug，gc 后匹配 → 但被忽略 → gc 得不到 trace 级别。用户必须把更具体的 selection 放在前面："-Xlog:gc=trace,all=debug"——这与直觉（specific overrides general）相反。Java 日志配置的习惯是"更具体的规则写在更宽泛的规则之后"（类似 log4j logger 层次）——最后匹配胜出的设计更自然。

设计：`"-Xlog:all=trace,gc=error"` 中 `all` 匹配所有设为 trace，后一个 `gc=error` 覆盖 gc 相关的设为 error。"后覆盖先"的设计允许精确的"排除"模式——`-Xlog:all=debug,gc=off` 意味着"所有 tagset 都用 debug 但不输出 gc 相关的"。

### 1.7 运行时判定：`log_is_enabled()` → `LogTagSet::is_level()` 零开销布尔检查

```cpp
// logTagSet.hpp:114-116 — 内联函数，编译后可被内联到调用点
bool is_level(LogLevelType level) const {
  return _output_list.is_level(level);  // 一次 LogOutputList 内部数组查找
}
```

這是运行时 `log_is_enabled(level, tags...)` 宏调用的核心——一个内联的布尔检查，无锁、无虚拟函数调用、只需一次 `LogOutputList` 数组查找。对于 MaxTags=5、~200 个 tagset 的典型规模，一次 `log_is_enabled()` 调用约 10-20 个 CPU 周期。

### 1.8 模糊匹配与智能建议

两层模糊匹配系统：

**第一层** — 即时纠错 (parse_internal, logSelection.cpp:79-86, 118-126)：当 tag/level 无法精确匹配时，调用 `fuzzy_match()` 做字符串相似度计算：
- `LogTag::fuzzy_match()` (logTag.cpp:47-61)：遍历所有已知 tag 名，调用 `StringUtils::similarity()` 计算得分，阈值 `best=0.5`
- `LogLevel::fuzzy_match()` (logLevel.cpp:45-59)：阈值 `best=0.4`（level 只有 5 个有效值，名称短，单字符错误占比大）

**第二层** — selection 级建议 (`suggest_similar_matching`, logSelection.cpp:283-351)：当整个 selection 不匹配任何 tagset 时，遍历所有 LogTagSet 计算 Sørensen-Dice 相似系数，收集 top-5 建议。

**Sørensen-Dice 相似系数** (logSelection.cpp:236-248)：
```cpp
double LogSelection::similarity(const LogSelection& other) const {
  size_t intersecting = 0;
  for (size_t i = 0; i < _ntags; i++)
    for (size_t j = 0; j < other._ntags; j++)
      if (_tags[i] == other._tags[j]) { intersecting++; break; }
  return 2.0 * intersecting / (_ntags + other._ntags);  // :247
}
```

**三级排序策略** (SimilarityComparator, logSelection.cpp:256-279)：1) similarity 降序 → 2) ntags 升序 → 3) tag_sets_selected 降序。

`suggestion_cap = 5` (logSelection.cpp:281) 和 `similarity_requirement = 0.3` (logSelection.cpp:282) 控制建议数量和最低相似度阈值。

> **Counterfactual** — 如果无模糊匹配建议，则 JVM 直接输出 "Invalid tag 'aaaa'" 不做任何建议，用户看到错误消息后需要手动查看 jcmd VM.log list 来查找可用名称——额外步骤增加了调试摩擦。JVM 的配置语言是 C 代码（非交互式 REPL），用户必须重启才能修正配置。第一层即时纠错让大小写/拼写错误在首次尝试就被纠正而非触发"修改配置→重启→再试"的循环。模糊匹配机制使得"用错大小写时仍然可用"——这是在用户体验和解析复杂度之间的合理折中。

### 1.9 运行时重配置：VM.log DCMD

`LogDiagnosticCommand` (logDiagnosticCommand.cpp:30-46) 定义 7 个 `DCmdArgument`：`_output`, `_output_options`, `_what`, `_decorators`, `_disable`, `_list`, `_rotate`。

`execute()` (logDiagnosticCommand.cpp:64-97) 处理逻辑：
1. `_disable` → `LogConfiguration::disable_logging()`
2. `_output || _what || _decorators` → `LogConfiguration::parse_log_arguments(...)`——与命令行解析完全相同！
3. `_list` → `LogConfiguration::describe(output())`
4. `_rotate` → `LogConfiguration::rotate_all_outputs()`
5. 无参数 → 打印帮助

`registerCommand()` (logDiagnosticCommand.cpp:59-62) 注册到 `DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean`——可从 jcmd、JMX Attach API、JMX MBean 三个入口访问。在 `LogConfiguration::post_initialize()` (logConfiguration.cpp:86) 中调用注册——此时诊断命令框架已就绪。

> **Counterfactual** — 如果无 DCMD 只能重启修改配置，则生产环境中 JVM 重启代价巨大（session 丢失 + 预热消耗 + 安全审批）。线上问题排查（如"GC 日志太吵"）需要随时调整日志级别来定位根因。没有 VM.log → 需要 kill -3（线程 dump）但不改变日志级别 → 或者依赖额外的 JMX 管理工具（JMX 代理通常不部署在生产环境）。VM.log 与 -Xlog 相同的代码路径 (parse_log_arguments()) → 零代码重复、行为一致——设计极简。

### 1.10 Mermaid：-Xlog 字符串从命令行到 tagset 级别设置的 5 阶段数据流图

```mermaid
sequenceDiagram
    participant Main as JVM Main Thread
    participant LogCfg as LogConfiguration
    participant LogSel as LogSelection
    participant LogTS as LogTagSet
    participant LogOL as LogOutputList

    Note over Main,LogOL: 阶段 1: 编译期 (Compile-time)
    rect rgb(240,248,255)
    Main->>Main: LOG_TAG_LIST X-MACRO 展开<br/>logTag.hpp:199-205 → enum _gc, _jit, ...<br/>logTag.cpp:31-36 → _name[] = "gc", "jit", ...
    end

    Note over Main,LogOL: 阶段 2: 静态初始化 (Static Init)
    rect rgb(255,245,238)
    Main->>LogTS: LogTagSetMapping<_gc,_class>::_tagset 实例化<br/>logTagSet.hpp:156-157
    LogTS->>LogTS: LogTagSet() 构造函数<br/>logTagSet.cpp:42-56<br/>头插法链入 _list<br/>_ntagsets++<br/>默认 Warning+Error→stdout
    end

    Note over Main,LogOL: 阶段 3: 命令行解析 (Command-line Parsing)
    rect rgb(240,255,240)
    Main->>LogCfg: parse_command_line_arguments("gc+class*=debug")<br/>logConfiguration.cpp:330
    LogCfg->>LogCfg: 按 : 分割为 substrings[4]<br/>logConfiguration.cpp:336-367
    LogCfg->>LogCfg: parse_log_arguments(output, what, decorators, output_options)<br/>logConfiguration.cpp:376
    LogCfg->>LogSel: LogSelectionList::parse("gc+class*=debug")<br/>logSelectionList.cpp:58
    LogSel->>LogSel: parse_internal() 就地解析<br/>logSelection.cpp:72-152<br/>Step1: strchr('=') → level=Debug<br/>Step2: strcmp("all") → false<br/>Step3: strchr('*') → wildcard=true<br/>Step4: strchr('+') → tags[_gc,_class]<br/>Step5: 重复检测<br/>Step6: 构建 LogSelection
    end

    Note over Main,LogOL: 阶段 4: 配置分发 (Configuration Distribution)
    rect rgb(255,240,245)
    LogCfg->>LogCfg: ConfigurationLock lock;<br/>logConfiguration.cpp:423<br/>Semaphore::wait() — futex(2)<br/>logConfiguration.cpp:62
    LogCfg->>LogCfg: configure_output(idx, selections, decorators)<br/>logConfiguration.cpp:216
    loop 全遍历所有 LogTagSet (O(ntagsets))
        LogCfg->>LogSel: level_for(*ts)<br/>logSelectionList.cpp:92-101
        LogSel->>LogSel: selects(ts) 逐个检查<br/>logSelection.cpp:161-171<br/>wildcard=true: 子集匹配<br/>wildcard=false: 精确匹配
        LogSel-->>LogCfg: level
        LogCfg->>LogTS: set_output_level(output, level)<br/>logTagSet.hpp:101
        LogTS->>LogOL: _output_list.set_output_level(output, level)
    end
    LogCfg->>LogTS: 第二轮遍历: update_decorators() 清理未使用装饰器<br/>logConfiguration.cpp:262-264
    LogCfg->>LogCfg: notify_update_listeners()<br/>logConfiguration.cpp:456 → logConfiguration.cpp:602-607
    end

    Note over Main,LogOL: 阶段 5: 运行时判定 (Runtime Check)
    rect rgb(250,240,255)
    Main->>LogTS: log_is_enabled(Debug, gc, class) 宏调用
    LogTS->>LogTS: LogTagSetMapping<_gc,_class>::tagset()
    LogTS->>LogTS: is_level(Debug)<br/>logTagSet.hpp:114-116
    LogTS->>LogOL: _output_list.is_level(level)<br/>内联 bool 检查
    LogOL-->>LogTS: true/false
    LogTS-->>Main: 布尔值 (零开销)
    end
```

### Interview Story Format

`-Xlog:gc+class*=debug` 进入 JVM 后被 `parse_command_line_arguments()` 按冒号分割为 4 段。`what` 段 `gc+class*=debug` 由 `LogSelection::parse()` 解析：先定位 `=` 提取 level=Debug，再定位 `*` 提取 wildcard=true，然后按 `+` 分割 tag 字符串为 `['gc','class']` 查找 `LogTag::from_string()` 转为枚举值 `[_gc,_class]`。构造的 `LogSelection` 遍历全局 LogTagSet 链表调用 `selects()`：wildcard=true 时只检查这个 selection 的两个 tag 都是 tagset 的子集——因此 `gc+class+sweep` 的 tagset 也能匹配（它包含 gc 和 class）。`selects()` 纯内联、无分支预测失败路径——对于 ~200 个 tagset、~MaxTags=5 tags 的典型规模，一次 `selects()` 调用约 10-20 个 CPU 周期。`configure_output()` 持有 Semaphore 锁遍历所有 tagset 更新 output_level，更新完成后 `notify_update_listeners()` 触发回调。运行时 `log_is_enabled(Debug, gc, class)` 最终调用 `LogTagSetMapping<_gc,_class>::tagset().is_level(Debug)`——一次 `bool` 字段读取，零开销。

---

## §二 Source Files Table

| # | File | Full Path | Lines | Core Functions | Role |
|---|------|-----------|:----:|-------|------|
| 1 | **logTag.hpp** | `src/hotspot/share/logging/logTag.hpp` | 221 | `LOG_TAG_LIST` X-MACRO(:1-174), `LogTag::type` enum(:199-205), `MAX_TAGS=5`(:197), `name()`(:207), `from_string()`(:211), `fuzzy_match()`(:212), `list_tags()`(:213) | Tag 枚举系统核心——所有 100+ 标签的定义和名称映射 |
| 2 | **logTag.cpp** | `src/hotspot/share/logging/logTag.cpp` | 87 | `_name[]` 初始化(:31-36), `from_string()`(:38-45), `fuzzy_match()`(:47-61), `TagSorter` 排序器(:70-80), `list_tags()`(:82-87) | Tag 名称映射实现 + 模糊匹配 + 排序展示 |
| 3 | **logTag_ext.hpp** | `src/hotspot/share/logging/logTag_ext.hpp` | 48 | `LOG_TAG_LIST_EXT`(:35-46) — probe_* 扩展标签 | 子系统级标签扩展机制（插桩模块）|
| 4 | **logTagSet.hpp** | `src/hotspot/share/logging/logTagSet.hpp` | 159 | `LogTagSet` class(:39-133), `LogTagSetMapping` template(:136-149), `_tagset` 静态成员实例化(:156-157) | TagSet 核心类 + 模板实例化绑定 |
| 5 | **logTagSet.cpp** | `src/hotspot/share/logging/logTagSet.cpp` | 180 | Constructor(:42-56), `update_decorators()`(:58), `log()`(:75-87), `label()`(:89), `vwrite()`(:110-139), `describe_tagsets()`(:143), `list_all_tagsets()`(:156-178) | TagSet 构造链入全局链表 + 消息输出 + 展示 |
| 6 | **logTagSetDescriptions.hpp** | `src/hotspot/share/logging/logTagSetDescriptions.hpp` | 36 | `LogTagSetDescription` struct(:29-32), extern `tagset_descriptions[]`(:34) | TagSet→描述映射结构声明 |
| 7 | **logTagSetDescriptions.cpp** | `src/hotspot/share/logging/logTagSetDescriptions.cpp` | 42 | `LOG_TAG_SET_DESCRIPTION_LIST` macro(:32-34), `tagset_descriptions[]`(:39-42) | 具体描述注册表（可扩展）|
| 8 | **logLevel.hpp** | `src/hotspot/share/logging/logLevel.hpp` | 82 | `LOG_LEVEL_LIST` X-MACRO(:45-50), `LogLevel::type` enum(:54-66), `name()`(:68), `from_string()`(:73), `fuzzy_match()`(:74) | 日志级别枚举定义 |
| 9 | **logLevel.cpp** | `src/hotspot/share/logging/logLevel.cpp` | 59 | `_name[]` 初始化(:29-34), `from_string()`(:36-43), `fuzzy_match()`(:45-59) | 级别名称映射 + 模糊匹配实现 |
| 10 | **logSelection.hpp** | `src/hotspot/share/logging/logSelection.hpp` | 74 | `LogSelection` class(:35-72), `parse()`(:50), `selects()`(:61), `consists_of()`(:62), `suggest_similar_matching()`(:68), `similarity()`(:71) | 选择器核心——单条 selection 的定义和匹配 |
| 11 | **logSelection.cpp** | `src/hotspot/share/logging/logSelection.cpp` | 351 | Constructor(:36-51), `parse_internal()`(:72-152), `parse()`(:154-159), `selects()`(:161-171), `consists_of()`(:182-189), `describe()`(:225-234), `similarity()`(:236-248), `suggest_similar_matching()`(:283-351) | 选择器解析引擎 + 模糊建议算法 |
| 12 | **logSelectionList.hpp** | `src/hotspot/share/logging/logSelectionList.hpp` | 65 | `LogSelectionList` class(:38-63), `MaxSelections=256`(:40), `parse()`(:56), `level_for()`(:57), `verify_selections()`(:62) | Selection 列表容器（逗号分隔组合）|
| 13 | **logSelectionList.cpp** | `src/hotspot/share/logging/logSelectionList.cpp` | 101 | `verify_selections()`(:33-55), `parse()`(:58-90), `level_for()`(:92-101) | Selection 列表解析 + 优先级排序查找 |
| 14 | **logConfiguration.hpp** | `src/hotspot/share/logging/logConfiguration.hpp` | 128 | `LogConfiguration` class(:39-126), `initialize()`(:91), `configure_output()`(:79), `parse_command_line_arguments()`(:109), `parse_log_arguments()`(:112), `Listener` callback(:44-53) | 配置管理核心声明 |
| 15 | **logConfiguration.cpp** | `src/hotspot/share/logging/logConfiguration.cpp` | 607 | `ConfigurationLock`(:55-78), `initialize()`(:103-111), `post_initialize()`(:80-101), `configure_output()`(:216-274), `parse_command_line_arguments()`(:330-401), `parse_log_arguments()`(:403-458), `describe()`(:493-497), `print_command_line_help()`(:499-582), `Listener`(:591-607) | 配置分发核心实现 + 锁 + 帮助文本 |
| 16 | **logDiagnosticCommand.hpp** | `src/hotspot/share/logging/logDiagnosticCommand.hpp` | 69 | `LogDiagnosticCommand` class(:38-67), `DCmdArgs` (output, output_options, what, decorators, disable, list, rotate)(:40-46), `name()="VM.log"`(:55), `registerCommand()`(:51) | VM.log DCMD 声明 |
| 17 | **logDiagnosticCommand.cpp** | `src/hotspot/share/logging/logDiagnosticCommand.cpp` | 97 | Constructor(:30-46), `registerCommand()`(:59-62), `execute()`(:64-97) | DCMD 注册 + 运行时命令执行 |

---

## §三 Standard Environment

OpenJDK 11 slowdebug, 64-bit Linux (TencentOS Server 4.2, RHEL-like)。

Source roots:
- `src/hotspot/share/logging/` — 36 个源文件，本文档覆盖 17 个
- `make/hotspot/lib/CompileJvm.gmk:153` — BUILD_LIBJVM 编译入口，logging/ 编译为 libjvm.so 的一部分

Build:
```bash
cd /data/workspace/openjdk-cut-new
bash configure --with-debug-level=slowdebug --disable-warnings-as-errors
make jdk
```

Key binary:
- `build/linux-x86_64-normal-server-slowdebug/jdk/lib/server/libjvm.so` — 所有 logging/ 源文件编译在此

Syscall 速查表（本文档覆盖的 logging 配置路径不直接涉及 syscall；配置存储于进程内存，输出路径见 doc-01）：

| 功能 | syscall | man | 相关文件 |
|------|---------|-----|---------|
| 互斥锁（Semaphore::wait） | `futex(2)` | `man 2 futex` | logConfiguration.cpp:62 |
| 命令行解析后的错误输出 | `write(2)` | `man 2 write` | logConfiguration.cpp:378 |

全局状态：

| 变量 | 定义位置 | 说明 |
|------|---------|------|
| `LogTagSet::_list` | logTagSet.cpp:37 | 全局 tagset 链表头指针 |
| `LogTagSet::_ntagsets` | logTagSet.cpp:38 | 全局 tagset 数量 |
| `LogConfiguration::_outputs` | logConfiguration.cpp:42 | 输出对象数组 |
| `LogConfiguration::_n_outputs` | logConfiguration.cpp:43 | 输出数量（初始 2: stdout+stderr）|
| `ConfigurationLock::_semaphore` | logConfiguration.cpp:72 | 配置互斥信号量 (1) |
| `LogTag::_name[]` | logTag.cpp:31 | Log 标签字符串表 |

---

## §四 7 个 Beginner Callout 框

> **1. X-MACRO（X-宏）模式**
> 
> `#define LOG_TAG_LIST \ LOG_TAG(gc) \ LOG_TAG(jit) \ ...` (logTag.hpp:34-174) 用同一个宏名 `LOG_TAG` 在不同位置 `#define` 和 `#undef` 产生不同展开效果——在 enum 中展开为枚举值 `_gc, _jit, ...` (logTag.hpp:200-204)，在 `_name[]` 初始化中展开为字符串 `"gc", "jit", ...` (logTag.cpp:31-36)。这保证 enum 值和字符串名称永远同步——添加新 tag 只需在 LOG_TAG_LIST 加一行，编译器自动生成对应的枚举值和字符串映射。Source: logTag.hpp:199-204 + logTag.cpp:31-36。

> **2. Static Initialization Order Fiasco（静态初始化顺序问题）**
> 
> `LogTagSetMapping::_tagset` 是模板类的静态成员（logTagSet.hpp:143），其构造函数 `LogTagSet::LogTagSet()` 把自己链入全局 `_list` 链表（logTagSet.cpp:51）。所有 tagset 的构造必须在 `LogConfiguration::initialize()` 之后、`configure_output()` 之前完成，否则 `configure_output()` 遍历链表时可能遗漏或访问未初始化的内存。HotSpot 通过 "LogTagSetMapping 模板在 log.hpp 的 Log 模板类中被引用" 来确保每个 tagset 的静态成员在当前翻译单元被实例化——但不同翻译单元之间的跨文件依赖只能依赖链接器的静态初始化排序。Source: logTagSet.hpp:151-157 + logTagSet.cpp:40-56。

> **3. Wildcard vs Exact Matching**
> 
> `LogSelection::selects()` (logSelection.cpp:161-171) 中 `_wildcard` 决定匹配策略：wildcard=true 时只要求 selection 的所有 tag 都是 tagset 的子集（`ts.contains(tag)`）→ 1-tag selection `gc*` 匹配所有包含 gc 的 tagset（gc+heap, gc+class, gc+phases 等）。wildcard=false 时额外要求 `_ntags == ts.ntags()`（tag 数量相等）→ 2-tag selection `gc+class` 只匹配恰好包含 gc 和 class 两个 tag 的 tagset，不匹配 gc+class+heap。这是 `-Xlog:gc=info`（精确匹配）和 `-Xlog:gc*=info`（通配匹配）语义差异的根源。

> **4. Level Hierarchy（日志级别继承）**
> 
> `LogLevel::type` (logLevel.hpp:54-66) 定义了 `Off(0), Trace(1), Debug(2), Info(3), Warning(4), Error(5)` 六个级别。`Off` 是明确关闭输出的级别；`Default = Warning` 表示新建的 LogTagSet 默认输出 Warning 和 Error 到 stdout（logTagSet.cpp:55）；`Unspecified = Info` 表示 `-Xlog:gc` 不写 `=level` 时默认 Info 级别（logLevel.hpp:65）。级别不构成继承关系——不存在 "Debug 级别自动包含 Info" 的设计；TagSet 的 `is_level(level)` 只判断这个 level 是否被配置为输出，不判断是否 "高于" 某级别。这使得 "只输出 Warning 但不输出 Info" 成为可能。

> **5. ConfigurationLock — Semaphore(1) 非递归锁**
> 
> 配置修改必须串行化——两个线程同时调用 `jcmd VM.log` 或启动阶段的多线程日志配置不能交错。`ConfigurationLock` (logConfiguration.cpp:55-78) 使用 `Semaphore _semaphore(1)` 实现互斥：构造时 `wait()` 获取，析构时 `signal()` 释放。关键约束：线程持有锁期间绝不能 block（被注释明确警告），否则所有日志配置被永久阻塞。`configure_output()` (logConfiguration.cpp:216-274) 持有锁遍历全局 tagset 链表更新级别，然后调用 `notify_update_listeners()` (logConfiguration.cpp:602-607) 触发回调。Source: logConfiguration.cpp:55-78。

> **6. LogTagSet 全局链表 vs 散列表**
> 
> 所有 tagset 以单向链表组织（`LogTagSet *_list` + `_next` 指针），每个 `LogTagSet::LogTagSet()` 构造函数执行 `_next = _list; _list = this`（头插法）。配置更新时 `configure_output()` 遍历整个链表（logConfiguration.cpp:226 for loop）。为什么不用 HashMap？在 ~200 个 tagset 的规模下，O(n) 线性扫描（每次遍历所有 tagset 做配置更新）优于 O(1) hash 查找的额外内存开销和 cache miss——配置更新不是热路径（仅在启动和 jcmd 时执行），而日志判定 `is_level()` 不走链表查找（直接读 `_output_list` 成员）。Source: logTagSet.cpp:37-56。

> **7. Listener Callback 模式**
> 
> `LogConfiguration::register_update_listener()` (logConfiguration.cpp:591-599) 允许外部注册回调，在每次日志配置变更后被 `notify_update_listeners()` (logConfiguration.cpp:602-607) 调用。注册例程在 ConfigurationLock 锁内执行（避免与配置更新并发），回调也在锁内被调用。但回调不能触发日志重配置（会死锁，注释明确警告 logConfiguration.hpp:47-49）。典型使用：`PerfData` 计数器感知日志级别变更以调整采样策略。Source: logConfiguration.hpp:43-53 + logConfiguration.cpp:591-607。

---

## §五 解析引擎与匹配算法细节

### 5.1 LogSelection::parse_internal() 6 步骤完整展开

全源码已经在 §一 1.4 展示，此处聚焦原理：

**就地修改技术**：`parse_internal()` 接收 `char* str`（堆副本），通过 `*equals = '\0'`, `*asterisk_pos = '\0'`, `*plus_pos = '\0'` 将字符串就地拆解为 token。解析完成后 `parse()` 调用 `os::free(copy)` 释放。这是典型的 C 风格零分配解析——避免 `std::string::substr()` 和 `std::vector` 的动态内存分配（在配置解析阶段不需要这些，因为调用方已提供临时副本）。

**解析顺序设计**：`=` → `all` → `*` → `+` → `from_string()` → 重复检查。每一层都在前一层截断的字符串上操作。先解析 `=` 是因为 level 不在 tag 名中；先检测 `all` 是因为它是特殊关键字（跳过所有 tag 解析）；`*` 必须在 `+` 之前检测（因为 `*` 是整个 tag 表达式的后缀，不是单独 tag 的属性）；`from_string()` 在 tag token 提取后进行。

### 5.2 LogSelection::selects() 短路逻辑分析

```cpp
// logSelection.cpp:161-171
bool LogSelection::selects(const LogTagSet& ts) const {
  if (!_wildcard && _ntags != ts.ntags()) {  // ← 短路 1: 精确匹配 + 数量不等 → false
    return false;
  }
  for (size_t i = 0; i < _ntags; i++) {      // ← 逐个 tag 检查是否被包含
    if (!ts.contains(_tags[i])) {            // ← 短路 2: 任一 tag 不在 tagset 中 → false
      return false;
    }
  }
  return true;
}
```

**复杂度分析**：外循环 O(_ntags ≤ MaxTags=5) × `contains()` (O(ntags_of_ts ≤ MaxTags=5)) → O(MaxTags^2) = O(25)，常量时间内完成。

**`LogTagSet::contains()`** (logTagSet.hpp:88-95)：
```cpp
bool contains(LogTagType tag) const {
  for (size_t i = 0; i < LogTag::MaxTags && _tag[i] != LogTag::__NO_TAG; i++) {
    if (tag == _tag[i]) return true;
  }
  return false;
}
```

这与 `LOG_TAGS()` 宏的展开互补：LogTagSet 的 `_tag[]` 数组按宏调用时的参数顺序存储 tag 枚举值，`contains()` 线性扫描——不要求用户按特定顺序指定 tag（`gc+class` 和 `class+gc` 等价）。

> **Counterfactual** — 如果 LogSelection 支持中间通配符 '*'（如 "gc+*+heap"），则 selections 匹配不需要——tag 是集合没有顺序。"gc+class" 和 "class+gc" 在 LogTagSet 中完全等价（tags[] 数组存储顺序取决于源代码中的 LOG_TAGS() 宏调用顺序，但 contains() 做线性查找不关心顺序）。用户写 "gc+*+heap" 的意图是"包含 gc 和 heap 且中间可以有其他 tag"——这默认就是 wildcard 的行为（含 gc+heap 的任何 tagset 都匹配）。`*` 尾缀只是阻止精确匹配——它不是正则表达式的通配符，而是 selection 匹配模式的二元开关。实际生产中的模糊建议引擎 (suggest_similar_matching(), logSelection.cpp:283-351) 已通过 Sørensen-Dice 系数计算相似度替代了复杂语法。

### 5.3 similarity() 的 Sørensen-Dice 系数

Sørensen-Dice 系数 = 2 × |交集| / (|A| + |B|) (logSelection.cpp:236-248)。对 tag 集合而言：
- 交集 = 两个 selection 共有的 tag 数量
- 值域 [0, 1]，越高越相似
- 完全匹配 = 1.0，无重叠 = 0.0

例如 `similarity({gc, class}, {gc, class, heap})` = 2 × 2 / (2 + 3) = 0.8。

选择 Sørensen-Dice 而非 Jaccard (|交集|/|并集|) 的原因：Dice 对交集大小更敏感，更有利于提供"既不太宽也不太少"的建议。

### 5.4 SimilarityComparator 三级排序策略

`SimilarityComparator` (logSelection.cpp:256-279) 的 `operator()`：
1. **similarity 降序** — 最相似的排在前面（logSelection.cpp:265-268）
2. **ntags 升序** — 相似度相同时，tag 更少的 selection 排在前面（logSelection.cpp:271-273）——更少的 tag 意味着匹配范围更广
3. **tag_sets_selected 降序** — tag 数相同时，匹配更多 tagset 的 selection 排在前面（logSelection.cpp:277）——覆盖面更广

### 5.5 suggestion_cap=5 和 similarity_requirement=0.3

`suggest_similar_matching()` (logSelection.cpp:283-351) 的算法：

1. **Wildcard 尝试** (logSelection.cpp:288-293)：如果当前 selection 没有 wildcard，先创建一个带 wildcard 的副本看是否匹配
2. **遍历所有 tagset** (logSelection.cpp:296-334)：对每个 tagset 生成候选 selection，计算 Sørensen-Dice 相似度
3. **Top-5 维护** (logSelection.cpp:316-333)：`nsuggestions < suggestion_cap` 时直接添加；满 5 个后替换最低分的
4. **排序输出** (logSelection.cpp:342-350)：用 `SimilarityComparator` 排序后输出 `"Did you mean any of the following? ..."`

`similarity_requirement=0.3` 意味着两个 selection 至少要有 30% 的 tag 重叠才会被建议——过滤掉"gc"被建议为"thread"的噪声。

---

## §六 配置生命周期

### 6.1 initialize() — 建立 stdout/stderr 两个基础 output

```cpp
// logConfiguration.cpp:103-111
void LogConfiguration::initialize(jlong vm_start_time) {
  LogFileOutput::set_file_name_parameters(vm_start_time);  // :104 — 设置 %p/%t 参数
  LogDecorations::initialize(vm_start_time);                // :105 — 初始化装饰器时间基准
  assert(_outputs == NULL, "Should not initialize _outputs before this function, ...");
  _outputs = NEW_C_HEAP_ARRAY(LogOutput*, 2, mtLogging);   // :107
  _outputs[0] = &StdoutLog;                                 // :108 — idx 0 = stdout
  _outputs[1] = &StderrLog;                                 // :109 — idx 1 = stderr
  _n_outputs = 2;                                           // :110
}
```

**调用时机**：在 `create_vm()` 阶段，早于任何 log 输出——确保 stdout/stderr 在 JVM 启动早期就可用（→ 交叉引用 01-jvm-startup 的 create_vm 阶段 LogConfiguration 初始化）。

全局状态初始化：
```cpp
// logConfiguration.cpp:42-46
LogOutput** LogConfiguration::_outputs = NULL;
size_t      LogConfiguration::_n_outputs = 0;
UpdateListenerFunction* LogConfiguration::_listener_callbacks = NULL;
size_t      LogConfiguration::_n_listener_callbacks = 0;
```

### 6.2 parse_command_line_arguments() — 按 `:` 分割为 4 段

已在 §一 1.3 详细展开。这是 -Xlog 命令行参数的入口点。

`parse_log_arguments()` (logConfiguration.cpp:403-458) 处理各子段：
- `outputstr` 默认 `"stdout"` (logConfiguration.cpp:409-411)
- `#N` 语法直接按索引查找 output (logConfiguration.cpp:425-430)
- 否则按名称查找 → 找不到则 `new_output()` 创建 → `add_output()` 添加 (logConfiguration.cpp:439-452)
- `ConfigurationLock` 保护下调用 `configure_output()` (logConfiguration.cpp:423, 455)
- `notify_update_listeners()` (logConfiguration.cpp:456)
- `verify_selections()` (logConfiguration.cpp:457) — 验证每个 selection 都匹配到至少一个 tagset

### 6.3 configure_output() — 全遍历分发到所有 LogTagSet

已在 §一 1.6 详细展开。总结其两轮遍历算法：
- **第一轮**：遍历所有 tagset，设置级别 + 累计装饰器（logConfiguration.cpp:226-256）
- **第二轮**：清理未被任何 output 使用的装饰器（logConfiguration.cpp:262-264）
- 如果 output 未启用且不是 stdout/stderr → 删除 (logConfiguration.cpp:266-269)

> **Counterfactual** — 如果无 ConfigurationLock 保护，两个线程同时调用 jcmd VM.log 时：线程 1 执行 configure_output() 遍历 tagset 链表更新 set_output_level()，线程 2 同时在中间点创建一个新的 LogOutput（add_output 可能 realloc _outputs 数组）→ 线程 1 可能持有释放后的指针 → segfault。同时两个线程更新同一个 LogTagSet::_output_list → 数据竞争（logOutputList 的 set_output_level 不是线程安全的）→ 设置丢失或不一致。锁定串行化排除了所有竞态条件——并发配置是个罕见操作（仅启动时和 jcmd 时），串行化代价可接受。

> **Counterfactual** — 如果 configure_output() 只更新被 selection 选中的 tagset 而非全遍历，则先前配置 "gc=debug" 改为 "jit=debug" 时，gc 相关 tagset 需要从 debug 降为 off，但没有全遍历无法知道哪些 tagset 需要清除。需要"反向映射"（selection→tagset）和"旧状态存储"来追踪——比全遍历更复杂且容易出错。全遍历 O(ntagsets)≈O(200) 对配置变更（非热路径）完全可以接受。

### 6.4 post_initialize() — 注册 VM.log DCMD + 打印初始化完成

```cpp
// logConfiguration.cpp:80-101
void LogConfiguration::post_initialize() {
  for (size_t i = 0; i < _n_outputs; i++) {
    _outputs[i]->_reconfigured = false;  // :82-84 — 重置重新配置标志
  }
  LogDiagnosticCommand::registerCommand();  // :86 → logDiagnosticCommand.cpp:59-62
  Log(logging) log;
  if (log.is_info()) {
    log.info("Log configuration fully initialized.");    // :89
    log_develop_info(logging)("Develop logging is available.");  // :90
    LogStream info_stream(log.info());                   // :92
    describe_available(&info_stream);                     // :93
    LogStream debug_stream(log.debug());                  // :95
    LogTagSet::list_all_tagsets(&debug_stream);           // :96
    ConfigurationLock cl;                                 // :98
    describe_current_configuration(&info_stream);         // :99
  }
}
```

**调用时机**：`create_vm()` 的 stage 7 或之后，此时 DCmdFactory 已初始化。

`VM.log` 注册 (logDiagnosticCommand.cpp:59-62)：
```cpp
void LogDiagnosticCommand::registerCommand() {
  uint32_t full_visibility = DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean;
  DCmdFactory::register_DCmdFactory(new DCmdFactoryImpl<LogDiagnosticCommand>(full_visibility, true, false));
}
```

### 6.5 VM.log execute() — 运行时重配置

`LogDiagnosticCommand::execute()` (logDiagnosticCommand.cpp:64-97) — 详见 §一 1.9。

关键设计：`parse_log_arguments()` 的调用路径与命令行解析完全一致（logDiagnosticCommand.cpp:72-76）——代码复用 100%，行为完全一致。

### 6.6 finalize() — 禁用所有输出并释放

```cpp
// logConfiguration.cpp:113-118
void LogConfiguration::finalize() {
  for (size_t i = _n_outputs; i > 0; i--) {
    disable_output(i - 1);  // :114-116 — 从最后一个向前禁用
  }
  FREE_C_HEAP_ARRAY(LogOutput*, _outputs);  // :117
}
```

`disable_output()` (logConfiguration.cpp:276-292) 遍历所有 tagset 将对应 output 设为 Off，然后删除 output（stdout/stderr 除外）。

倒序遍历原因：`delete_output()` 会将最后一个 output 交换到当前位置并 shrink 数组——倒序避免了索引混乱。

### 6.7 配置变更监听器

```cpp
// logConfiguration.cpp:591-599
void LogConfiguration::register_update_listener(UpdateListenerFunction cb) {
  assert(cb != NULL, "Should not register NULL as listener");
  ConfigurationLock cl;  // :593 — 锁保护
  size_t idx = _n_listener_callbacks++;
  _listener_callbacks = REALLOC_C_HEAP_ARRAY(UpdateListenerFunction,
                                             _listener_callbacks, _n_listener_callbacks, mtLogging);
  _listener_callbacks[idx] = cb;
}

// logConfiguration.cpp:602-607
void LogConfiguration::notify_update_listeners() {
  assert(ConfigurationLock::current_thread_has_lock(), "must be called in ConfigurationLock scope");
  for (size_t i = 0; i < _n_listener_callbacks; i++) {
    _listener_callbacks[i]();
  }
}
```

**ConfigurationLock 非递归设计约束** (logConfiguration.hpp:47-49)：
```
The callback is always called with ConfigurationLock held,
hence doing log reconfiguration from the callback will deadlock.
```

在同一线程持有锁时再次获取锁 → `Semaphore::wait()` 永远阻塞 → 死锁。这是设计决策：Semaphore 是轻量级同步原语（基于 futex(2)，man 2 futex），实现递归需要额外维护 owner 线程 ID 和嵌套计数。

---

## §七 Cross-Reference

### 7.1 01-jvm-startup — create_vm 阶段 LogConfiguration 初始化

> 读者已完成 01-jvm-startup，知道 create_vm 阶段 LogConfiguration 初始化时机。本文 `parse_command_line_arguments()` (logConfiguration.cpp:330) 在 JVM 命令行解析阶段被 `Arguments::parse_each_vm_init_arg()` 调用 → 配置写入全局 `LogTagSet` 链表 → 后续 `create_vm()` 阶段 `LogConfiguration::post_initialize()` (logConfiguration.cpp:80) 注册 VM.log DCMD 并打印初始化完成的 log 信息。

### 7.2 doc-01-output-pipeline — LogOutput 的 write() 和 rotate() 机制

> 本文 `configure_output()` (logConfiguration.cpp:216) 设置 `ts->set_output_level(output, level)` (logTagSet.hpp:101) 后，运行时 `LogTagSet::log()` (logTagSet.cpp:75-80) 调用 `(*it)->write(decorations, msg)` → 进入 doc-01 主场的 LogOutput::write() 和 LogFileOutput 的 rotate 机制。本文 `disable_output()` (logConfiguration.cpp:276)、`rotate_all_outputs()` (logConfiguration.cpp:584) 最终也是委托给 LogOutput 接口。

### 7.3 doc-02-message-composition — log_debug 宏展开到 LogTarget 的完整链路

> 本文 `LOG_TAGS()` 宏 (logTag.hpp:185) 展开到 `LogTagSetMapping<_gc,_class>::tagset()` (logTagSet.hpp:146-148) 即停止。doc-02 继续展开：`log_debug(gc, class)(...)` → `LogTarget(Debug, gc, class)` → `Log<Debug, _gc, _class>::is_level()` → `LogTagSetMapping::tagset().is_level()` → 通过后进入 `LogMessage` 构造 + `LogStream` 格式化 → 调用本文 `LogTagSet::log()` 输出。

---

## §八 不要写成 → 应该写成对照表

| 不要写成 | 应该写成 |
|---------|---------|
| "LOG_TAG_LIST 是一个宏列表，定义了所有 tag" | "LOG_TAG_LIST (logTag.hpp:34) 是 X-MACRO — 同一宏 LOG_TAG 在不同位置被 #define 解引用为 enum 值 `_##name` 和字符串 `#name`，保证 enum 下标与 _name[] 索引的编译期同步，添加新 tag 只需在列表加一行" |
| "LogTag::from_string() 做大小写不敏感比较" | "from_string() (logTag.cpp:38-45) 使用 strcasecmp (POSIX, man 3 strcasecmp) 而非 strcmp，因为命令行标志无大小写语义，'GC' vs 'gc' 输入歧义不值得让用户重启 JVM 来纠正——对 100+ 个 tag 做 O(n) 线性扫描的代价仅在配置阶段发生（启动或 jcmd）" |
| "LogTagSet 有链表结构" | "LogTagSet::LogTagSet() (logTagSet.cpp:42-56) 构造函数以头插法将自身链入全局 _list (logTagSet.cpp:37)，形成编译期模板实例化自动注册的单向链表——无需手动 register_tagset() 调用，新增 tag 组合自动加入配置遍历路径" |
| "selects() 判断选择器是否匹配 tagset" | "selects() (logSelection.cpp:161-171) 首先检查 wildcard 标志：非 wildcard 模式下 _ntags != ts.ntags() 立即短路返回 false (logSelection.cpp:162)；然后逐个检查所有 selection tag 是否被 tagset 包含 (ts.contains())——此路径为 O(ntags × MaxTags)，对 MaxTags=5 的常量上限可视为 O(1)" |
| "configure_output() 遍历所有 tagset" | "configure_output() (logConfiguration.cpp:216-274) 持有 ConfigurationLock (Semaphore 互斥) 以 for-loop 遍历全局 LogTagSet 链表，对每个 ts 调用 selections.level_for() (logSelectionList.cpp:92) 确定级别，用 ts->set_output_level() (logTagSet.hpp:101) 写入 output 列表——配置变更是罕见操作（JVM 启动 + jcmd），O(200) 全遍历成本可忽略" |
| "LogSelection::parse() 解析字符串" | "parse_internal() (logSelection.cpp:72-152) 使用就地字符串修改技术（strchr(=)→\\0 截断）而非 strtok()——避免 strtok 的线程不安全全局状态。解析顺序：= → * → + → from_string()——确保每一层都能做错误检测和 fuzzy 建议" |
| "VM.log DCMD 允许运行时重配置" | "LogDiagnosticCommand::execute() (logDiagnosticCommand.cpp:64-97) 将 DCMD 的 output/what/decorators 参数直接传给 LogConfiguration::parse_log_arguments() (logConfiguration.cpp:403)——命令行 -Xlog 和运行时 jcmd 共享完全相同的解析路径（代码复用 100%），确保行为完全一致" |
| "fuzzy_match 可以纠正拼写错误" | "fuzzy_match() (logTag.cpp:47-61) 调用 StringUtils::similarity() 计算 Levenshtein-based 字符串相似度，阈值 0.5 (tag) / 0.4 (level) 平衡了纠错能力和假阳性。当 parse_internal 检测到无效 tag 时立即调用 fuzzy_match 提供 'Did you mean?' 建议——将调试摩擦从 '重启→查手册→改配置→再试' 的循环降为一次看到建议即修正" |
| "ConfigurationLock 用 Semaphore 加锁" | "ConfigurationLock (logConfiguration.cpp:55-78) 是 Semaphore(1) 非递归互斥锁的 RAII 封装——构造时 wait() 获取 (cpp:62)，析构时 signal() 释放 (cpp:67)。基于 futex(2) (man 2 futex) 用户态快速路径；设计为非递归迫使关键区短且不嵌套——持有期间不能 block，否则永久阻塞日志配置" |

---

## §九 边缘场景

### 场景 1：多线程同时 jcmd 配置竞态

两个运维线程（或自动化脚本 + 手动 jcmd）同时向同一 JVM 发送 `jcmd <pid> VM.log what="gc=debug"`。如果没有保护，两个 `parse_log_arguments()` 调用会交错执行 `configure_output()`——线程 A 在遍历 LogTagSet 链表更新 `set_output_level()` 中途，线程 B 也开始自己的遍历，导致两个配置互相覆盖，最终状态是某种不可预测的混合体。

**保护机制**：`ConfigurationLock` (logConfiguration.cpp:55-78) 内的 `Semaphore _semaphore(1)` 保证同一时刻只有一个线程能执行 `configure_output()`（logConfiguration.cpp:62 `wait()` 获取，cpp:67 `signal()` 释放）。第二个线程在 `Semaphore::wait()` 上阻塞（基于 futex(2), man 2 futex），直到第一个线程完成全遍历并释放锁。

**触发条件**：jcmd 的 Attach Listener 线程和 JVM 内部 DCMD 调用（通过 JMX MBean `DCmd_Source_MBean`）可能并发。registerCommand() (logDiagnosticCommand.cpp:59-62) 注册了三个入口：`DCmd_Source_Internal | DCmd_Source_AttachAPI | DCmd_Source_MBean`。

### 场景 2：configure_output() 遍历中 LogOutput 数组 realloc

`configure_output()` (logConfiguration.cpp:226-256) 持有 ConfigurationLock 遍历全局 LogTagSet 链表。但在遍历过程中，tagset 的 `set_output_level()` 逻辑仅修改已有的 `LogOutput*` 级别值，不触发 LogOutput 数组创建。配置锁串行化了所有 mutation 操作——`add_output()` (logConfiguration.cpp) 也在 ConfigurationLock 保护下执行。

**为什么安全**：`_outputs` 数组的创建/删除（`add_output`/`delete_output`）和遍历（`configure_output`）都在同一 ConfigurationLock 的保护范围内。`parse_log_arguments()` (logConfiguration.cpp:423) 在构造 ConfigurationLock 后统一处理 output 创建和配置分发，不存在遍历中途数组增长导致指针失效的窗口。

### 场景 3：LogTagSet 构造函数 ODR 违例

`LogTagSetMapping<_gc,_class>::_tagset` 的静态成员定义在头文件 logTagSet.hpp:156-157 中。两个翻译单元（比如 gc/shared/gcTrace.cpp 和 runtime/thread.cpp）都使用 `log_debug(gc, class)(...)` → 都会实例化 `LogTagSetMapping<_gc,_class>` 模板 → 都会生成 `_tagset` 静态成员定义 → 链接时存在两个定义。

**C++ ODR 保证解决**：C++ 标准 (N4659 §6.2 [basic.def.odr]/6) 规定：模板的显式特化/实例化如果有多个定义但满足 ODR（逐 token 相同），则行为如同只有单一定义。链接器使用 weak 符号合并这些重复实例化，保证每个 tag 组合只有一个 `LogTagSet` 对象的构造函数被调用。这是 C++ 模板的合法惯用模式——不构成违例。

**如果链接器不合并**：使用无 weak 符号支持的链接器或 `-fno-weak` 标志 → 链接时多重定义错误 (`multiple definition of LogTagSetMapping<_gc,_class>::_tagset`) → JVM 构建失败。HotSpot 构建系统依赖标准 ELF 链接器的 weak symbol 合并行为。

---

## §十 GDB 断点验证

### 断言 1：X-MACRO 生成 enum 值 (logTag.hpp:199-205)
```
(gdb) break 'LogTagSet::LogTagSet(ulong (*)(char*, ulong), LogTag::type, LogTag::type, ...)' 
或 break logTagSet.cpp:42
运行: java -Xlog:gc=debug -version
(gdb) print LogTag::_gc → 有效枚举值 (如 77)
(gdb) print LogTag::name(LogTag::_gc) → "gc"
(gdb) print LogTag::_name[LogTag::_gc] → "gc" (验证 enum 下标 = _name[] 索引)
```

### 断言 2：LogTagSet 全局链表构造 (logTagSet.cpp:42-56)
```
(gdb) break logTagSet.cpp:51  // _list = this
(gdb) print _ntagsets → 递增 (0, 1, 2, ...)
(gdb) print _next → 之前的 _list 值 (NULL 如果是第一个)
(gdb) print _tag[0] → 此 tagset 的第一个 tag 枚举值
```

### 断言 3：parse_command_line_arguments 分割 -Xlog 字符串 (logConfiguration.cpp:330)
```
(gdb) break logConfiguration.cpp:376  // parse_log_arguments 调用前
运行: java -Xlog:gc+class*=debug:file=gc.log -version
(gdb) print substrings[0] → "gc+class*=debug" (what)
(gdb) print substrings[1] → "file=gc.log" (output)
(gdb) print substrings[2] → NULL 或 "" (decorators)
(gdb) print substrings[3] → NULL 或 "" (output_options)
```

### 断言 4：LogSelection::parse() 拆解 * 通配符 (logSelection.cpp:104-107)
```
(gdb) break logSelection.cpp:107  // *asterisk_pos = '\0'
运行: java -Xlog:gc*=debug -version
(gdb) print asterisk_pos → 指向 "gc*" 中的 '*'
(gdb) print wildcard → true (在 break 之后)
(gdb) continue 到 LogSelection constructor (logSelection.cpp:39)
(gdb) print _ntags → 1 (只有 gc)
(gdb) print _tags[0] → LogTag::_gc
```

### 断言 5：LogSelection::selects() 匹配逻辑 (logSelection.cpp:161-171)
```
(gdb) break logSelection.cpp:162  // if (!_wildcard ...)
预先设置: -Xlog:gc=debug, 匹配到 gc+class tagset
(gdb) print _wildcard → false
(gdb) print _ntags → 1
(gdb) print ts.ntags() → 2 (gc+class)
(gdb) print _ntags != ts.ntags() → true → 函数应 return false
```

### 断言 6：configure_output() 级别设置 (logConfiguration.cpp:243)
```
(gdb) break logConfiguration.cpp:243  // ts->set_output_level(output, level)
运行: java -Xlog:gc=debug -version
(gdb) print level → 对 gc tagset = Debug(2), 其他 tagset = NotMentioned 或 Off
(gdb) print output->name() → "stdout"
(gdb) continue 几次看不同 tagset 获得什么 level
```

### 断言 7：LogTagSet::is_level() 运行时检验 (logTagSet.hpp:114)
```
(gdb) break logTagSet.hpp:114  // return _output_list.is_level(level)
在 Java 代码执行 log_info(gc)("msg") 时触发
(gdb) print level → LogLevel::Info(3) 或其他
(gdb) print this->_output_list → 查看内部级别设置
(gdb) finish → print return value
(gdb) print → true (如果 level 匹配配置) 或 false
```

### 断言 8：LogConfiguration::post_initialize() DCMD 注册 (logConfiguration.cpp:86)
```
(gdb) break logConfiguration.cpp:86  // LogDiagnosticCommand::registerCommand()
运行: java -Xlog:gc=debug -version (启动直到此断点)
(gdb) continue → 经过 registerCommand
(gdb) print LogConfiguration::_n_outputs → 2 (stdout + stderr)
(gdb) print → 确认 VM.log DCMD 已在 DCmdFactory 注册
```

### strace 验证：观察 futex(2) 调用

```bash
# strace: 观察 futex(2) 调用（Semaphore::wait/signal）
# 在另一个终端中先启动 Java 进程并获取 PID：
java -Xlog:gc=debug -version &
JAVA_PID=$!

# 附加 strace 过滤 futex 调用：
strace -e trace=futex -p $JAVA_PID 2>&1 | head -30
# 期间在第三个终端执行 jcmd $JAVA_PID VM.log list 触发配置读取
# 或执行 jcmd $JAVA_PID VM.log what="gc=info" 触发配置变更
# 预期: 看到 futex(FUTEX_WAIT_PRIVATE, ...) 和 futex(FUTEX_WAKE_PRIVATE, ...)
```

### jstack 验证：确认配置变更线程

```bash
# jstack: 确认配置变更线程（Attach Listener）
JAVA_PID=$(pgrep -f java | head -1)
jstack $JAVA_PID | grep -A 5 "Attach Listener"
# 预期输出:
# "Attach Listener" #XX daemon prio=9 ...
#   java.lang.Thread.State: RUNNABLE
#    at ... (jcmd 触发时在 DCMD 执行路径中)
```

