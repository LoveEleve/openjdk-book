# 02. 怎么不重启 JVM 替换一个类的字节码？— RedefineClasses

> 🔴 Deep | 2 KP 中的类热更新
> 读者处境: 生产环境出 bug——不想重启 JVM。JVMTI RedefineClasses 允许运行时替换字节码: parse new class→merge constant_pool→失效旧 nmethod→重新编译新方法。

### 1. "RedefineClasses — 全流程"

场景: agent 传 new class bytes→JVM 替换旧类的所有实例(metamorposis)。

**RedefineClasses 流程** (`jvmtiRedefineClasses.cpp:200-800`):
```
1. ClassFileParser re-parse new class bytes
2. compare old vs new constant_pool(merge identical entries, add new entries)
3. MethodComparator: 逐字节码比较每个方法
   - 字节码完全一致→方法保留(keep nmethod)
   - 字节码不同→方法需要新版本(need new compilation)
4. 更新 InstanceKlass:
   - replace vtable entries(新方法入口)
   - replace itable entries(接口方法)
5. 失效旧 nmethod (make_not_entrant) — GC 清理
6. 通知 agent: CLASS_FILE_LOAD_HOOK event
```
- 源码: `jvmtiRedefineClasses.cpp:200-800` + `methodComparator.cpp:40-200`
- 关键设计: 不是重新创建一个新 java.lang.Class 实例——而是**原地替换**旧 InstanceKlass 的 metadata。所有现有的 oop/引用仍然有效——它们指向的 class 对象不变——但 class 的 method/vtable/constant pool 已更新
- [C++: `ClassFileParser` parse new class 和旧 class 在同一个类加载器中→new InstanceKlass→merge旧InstanceKlass 的 annotations/fields→替换旧Klass的vtable。所有旧编译的方法→mark not_entrant→CompileBroker 收到通知可能重新编译新方法]

### 2. "MethodComparator — 旧方法≈新方法？"

**MethodComparator** (`methodComparator.hpp:40-80 + methodComparator.cpp:50-300`):
```
逐字节码比较:
  if (old_bytecodes[i] == new_bytecodes[i]) → 继续(method unchanged)
  else → 方法已变→需要新编译
  特殊处理:
    - ldc 指令: 比较 constant_pool entry 是否等效(new CP可能有不同的index)
    - branch 指令: 比较 jump target 对应的 bytecode 是否相同
```
- 源码: `methodComparator.cpp:50-300` + `relocator.cpp:40-200` 字节码重定位
- 关键设计: 逐字节码比较——不是为了判定"方法语义相同"(impossible in general)→而是为了决定"是否保留已有的 nmethod"。保守:遇到无法比较的→标记"方法已变"→失效 nmethod

### 3. "relocator — 字节码重写"

**Relocator** (`relocator.hpp:40-80 + relocator.cpp:40-200`):
```
修正新字节码中的引用:
  - constant_pool index changed→update ldc/invokevirtual index
  - line_number_table→新字节码偏移→调整
  - exception_table→新handler位置→调整
```
- 源码: `relocator.cpp:40-200`

---

### 核心悬念

**"RedefineClasses 原地替换 InstanceKlass metadata——MethodComparator 保留不变的方法的 nmethod——失效已变的方法→触发重编译。"** — 下一篇: 辅助设施。

> → [03-auxiliary.md](03-auxiliary.md)
