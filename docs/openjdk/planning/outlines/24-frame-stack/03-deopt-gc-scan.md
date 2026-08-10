# 03. deopt 怎么从编译帧重建解释器帧？— Deopt 重建 + GC 扫描

> 🟡 Working | 3 KP 中的辅助基础设施
> 读者处境: deopt 决定已做——需要通过 vframeArray 从编译帧提取所有内联信息→分配新帧→复制局部变量→重建监视器→切解释器。GC 同时需要扫描栈上的 oop——用 OopMap 精确标注。

### 1. "vframeArray — deopt 的核心数据结构"

场景: C2 编译的帧被 deopt——6 层内联需要解为 6 个解释器帧。vframeArray 存的是中间表示——在 C-heap 非栈上。

**vframeArray 结构** (`vframeArray.hpp:40-80`):
```cpp
class vframeArray: public CHeapObj<mtCompiler> {
  int _frames;                    // 内联深度(帧数)
  frame _original;                // 原始编译帧(用作 sp 基准)
  frame _caller;                  // caller 帧
  vframeArrayElement* _elements;  // 每元素=一个 scope 的 locals/exprs/monitors
};
```
- 源码: `vframeArray.hpp:40-80` 全结构
- 关键设计: vframeArray 在 C-heap 分配——不在栈上——因为 deopt unpack 发生在帧格式未知时(不能 new local arrays on stack)。先填满 vframeArray 的所有 elements(每个 scope 的 locals/expressions/monitors)→然后应用这些到真实栈帧

**vframeArray::fill_in** (`vframeArray.cpp:80-250`):
```
从编译帧填充 vframeArray:
  1. compiledVFrame::top() — 递归遍历内联树(从最内到最外)
  2. 对每个 scope:
     a) locals → from ScopeValue → StackValueCollection
     b) expressions → from scope expressions
     c) monitors → from scope MonitorValue → saved lock state
  3. 存储到 vframeArrayElement
```
- 源码: `vframeArray.cpp:80-250` fill_in 主逻辑
- [C++: ScopeValue → StackValue 的转换: Location::on_stack → copy bytes from compile frame stack; Location::in_reg → copy from saved register; Location::constant → store constant oop。Location 编码是 2-byte packed(where_type:2bit + offset:14bit=栈偏移或reg number)]

### 2. "StackValue — 栈上值的类型安全提取"

场景: deopt 需要从编译帧中复制局部变量 A(int)→解释器帧 local[0]。StackValue 确保值是 int 而非错误读取了 8 bytes。

**StackValue 5 种类型** (`stackValue.hpp:35-70`):
```cpp
class StackValue {
  BasicType _type; // T_INT/T_FLOAT/T_LONG/T_DOUBLE/T_OBJECT/T_CONFLICT
  union {
    intptr_t _integer_value;  // int/boolean/byte/char/long(lower 64 bits)
    Handle   _handle_value;   // oop reference
  };
};
```
- 源码: `stackValue.hpp:35-70` + `stackValue.cpp:creation from ScopeValue`
- 关键设计: T_CONFLICT 表示同一 slot 在某些路径是 int 在某些路径是 oop——deopt 时无法确定→标记为冲突→垃圾回收用保守扫描(不回收)
- [C++: `union` 设计: intptr_t 和 Handle 共享内存——同一 slot 不可能同时是 int 和 oop——类型分派在 scope 解析时确定。`create_stack_value(ScopeValue*, frame*, thread)` 根据 ScopeValue::is_location()/is_object()/is_constant_oop() dispatch]

**StackValueCollection** (`stackValueCollection.hpp`):
```cpp
class StackValueCollection : public ResourceObj {
  GrowableArray<StackValue*> _values;
  int size();
  StackValue* at(int i);
  void add(StackValue* val);
};
```
- 源码: `stackValueCollection.hpp:30-50`

### 3. "MonitorChunk — deopt 的 off-stack 监视器"

场景: deopt 时如果 compiled frame 有 `synchronized(this) {}`——需要在新的解释器帧中重建这个监视器。MonitorChunk 分配 off-stack 监视器并链接到帧。

**MonitorChunk 链** (`monitorChunk.hpp:32-60`):
```cpp
class MonitorChunk {
  int        _number_of_monitors;
  BasicLock  _monitors[0]; // 柔性数组, 实际大小 = number_of_monitors×sizeof(BasicLock)
  MonitorChunk* _next;     // 链到下一个 MonitorChunk
};
```
- 源码: `monitorChunk.hpp:32-60` + `monitorChunk.cpp:allocation`
- 关键设计: _monitors[0] 是 C 柔性数组(flexible array)——实际分配大小 = header + n×sizeof(BasicLock)。MonitorChunk 链用于 "一个方法中多层嵌套 synchronized"——每层一个 BasicLock——通过 MonitorChunk 链管理
- [C++: MonitorChunk 分配在 C-heap——因为 deopt 栈帧已经重建好了, 不能再在帧中分配。JavaThread::_monitor_chunks 指向链头→unpack 后清理时批量释放]

### 4. "GC 怎么扫描栈上的 oop？" — RegisterMap + OopMap

场景: Young GC 扫描线程栈——compiled frame 的 rsi 寄存器存了一个 oop→GC 需要标记它。registerMap 记录哪些寄存器保存了 callee-saved oop。

**RegisterMap 结构** (`registerMap.hpp:35-80`):
```cpp
class RegisterMap {
  intptr_t _location[RegisterImpl::number_of_registers]; // 每个寄存器的恢复值
  // _location[i] valid = register i has been saved
  void set_location(VMReg reg, intptr_t* loc);
  intptr_t* location(VMReg reg);
};
```
- 源码: `registerMap_x86.hpp:30-60` x86 特定寄存器映射
- [x86: x86_64 callee-saved registers(rbx/rbp/rdi/rsi/r12-r15) 在 compiled frame 的 prologue 中 push 到栈上。RegisterMap::_location[i] 指向 frame 上推入该寄存器值的位置→GC 从这个位置读值→如果是 oop→mark]
- 关键设计: RegisterMap 和 OopMap 配合——OopMap 说 "slot 5 是 oop"，RegisterMap 说 "slot 5 对应寄存器 rsi 在帧中的位置是 [rbp-40]"→GC dereference [rbp-40]→读值→mark if oop

---

### 核心悬念

**"vframeArray + StackValue + MonitorChunk 三件套让 deopt 能从编译帧完整重建解释器帧。RegisterMap + OopMap 让 GC 精确扫描栈上的 oop。"** — 下一篇: 域25 GC Framework——JVM 的垃圾回收基础架构。

> → 域25 GC Framework
