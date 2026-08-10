# Template & DispatchTable — 解释器的数据结构

> OpenJDK 11 slowdebug, GDB 验证
> 覆盖：Template(32B, ×239) + DispatchTable(20480B, 256入口) + TemplateTable(1B, 静态)

---

## 零、GDB 验证

```
sizeof(Template)        = 32
sizeof(DispatchTable)   = 20480  (= 256 × 80B)
sizeof(TemplateTable)   = 1      (全静态方法类)
Bytecodes::number_of_codes = 239
DispatchTable::length   = 256
code_size               = 165856 B ≈ 162KB
```

---

## 一、Template (32B) — 一条字节码的"配方"

```cpp
class Template {
    Bytecodes::Code _bytecode;  // 字节码编号 (0~255)
    int             _flags;     // bc_can_trap / bc_can_osr / ...
    TosState        _tos_in;    // 输入时栈顶类型 (itos/atos/...)
    TosState        _tos_out;   // 输出时栈顶类型
    address         _gen;       // 生成函数指针 → TemplateInterpreterGenerator::generate_xxx
};

// 例: iconst_0 的 Template
Template {
    _bytecode = Bytecodes::_iconst_0,
    _flags    = bc_can_osr,         // 可在循环中被 OSR
    _tos_in   = vtos,               // void → 不需要输入
    _tos_out  = itos,               // 输出 int 到栈顶
    _gen      = &generate_return_entry_for(itos, 0)
};
```

**为什么 32 字节？**
→ Template 是"静态配方"——不需要存储运行时状态。32B = 4(Code) + 4(flags) + 4×3(TosState×3) + 8(pointer) + alignment = 32B。

---

## 二、DispatchTable (20480B) — 字节码→入口 O(1) 分派

```
struct DispatchTable {
    address _table[256];  // 256 个入口地址
};
// 256 × 8B (pointer) = 2048B ... but sizeof says 20480B?

// 实际结构更复杂 — 每个入口不是简单的 address，而是 EntryPoint:
struct EntryPoint {
    address _entry[10];   // 10 种 TOS 状态各一个入口
};
// EntryPoint = 10 × 8B = 80B
// DispatchTable = 256 × 80B = 20480B ✅

运行时使用：
  opcode = next_bytecode()
  ep = _active_table[opcode]
  entry = ep.entry(tos_state)   // 根据当前栈顶类型选择入口
  jmp entry
```

**为什么每个字节码有 10 个入口？**
→ 因为字节码执行前，栈顶类型可能是 int/float/Object/long/... (10 种 TOS 状态)
→ 不同类型的"下一步"操作不同（int 存在 eax，float 在 xmm0）
→ 所以每种 TOS 状态需要不同的入口代码

---

## 三、TemplateTable (1B) — 全静态方法

```
sizeof(TemplateTable) = 1 (GDB) → 这个类没有实例数据！

class TemplateTable : AllStatic {
    static Template* template_for(Bytecodes::Code code); // 查表
    // 所有 239 条字节码的生成函数都是静态方法
    static void iload();
    static void aload_0();
    static void iconst_0();
    // ... 239 个静态方法
};
// sizeof=1 是因为 C++ 不允许空类大小为 0
```

---

## 四、数据流：从字节码到机器码

```
Java 字节码 iconst_0
        ↓
TemplateTable::template_for(_iconst_0)     → 找到 Template
        ↓
template._gen()                              → 调用生成函数
        ↓
TemplateInterpreterGenerator::generate_xxx() → 生成机器码
        ↓
_code->alloc(20)                             → 写入 StubQueue
        ↓
_normal_table[_iconst_0] = entry             → 注册到分派表
        ↓
运行时: jmp _active_table[opcode]            → O(1) 分派
```

---

## 五、总结

| 结构 | sizeof | 本质 |
|------|--------|------|
| Template | 32B×239 | 字节码→生成函数的"配方表" |
| DispatchTable | 20480B | 256×(10入口)=O(1)分派 |
| TemplateTable | 1B | 零实例数据，全静态方法 |
