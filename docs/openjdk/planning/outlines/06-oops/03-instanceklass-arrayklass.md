# 03. ArrayKlass + ArrayOop — int[] 和 String[] 为什么是不同的 Klass？

> 🔴 Deep | 15 KP 中的 2 个数组体系机制
> 读者处境: `new int[10]` 和 `new String[10]`——JVM 内部用的是完全不同的数组 Klass——GC 的对待方式也完全不同。

### 1. ArrayKlass 层次

场景: `int[]` — 基本类型数组 — TypeArrayKlass。`String[]` — 对象数组 — ObjArrayKlass。内存布局不同——GC 的遍历行为也不同——但 Java 层面都是"数组"。

**ArrayKlass** (`arrayKlass.hpp:40-100`):
- `_dimension`: 数组维度——int[]=1, int[][] = 2, int[][][] = 3
- `_higher_dimension`: 更高维度的 ArrayKlass——int[]→int[][]→int[][][]
- `_lower_dimension`: 组件类型——int[][]→int[]
- [C++: 数组维度链——int[][][] 创建时自动创建 int[][], int[] 和 int 的 Klass。`Universe::intArrayKlassObj()` 返回全局唯一的 int[] Klass——所有 int[] 共享同一 Klass]

**ObjArrayKlass** (`objArrayKlass.hpp:35-80` + `objArrayKlass.cpp`):
- 对象数组——`obj_at(index)` → oop——**是** OOP 引用——GC **必须**遍历
- [x86: 对象数组的内存布局——[markOop(8B)][compressedKlass(4B)][length(4B)][oop1(4B)][oop2(4B)]...。每个元素是 4B compressed oop——GC 扫描时: 读 compressed oop→decode→验证 Klass→mark as live。如果元素是 null→跳过]
- [C++: `objArrayOopDesc::obj_at_put(int index, oop value)`——store oop ref——触发 GC write barrier (card mark)——G1 需要记录跨 region 引用。`obj_at(int index)`——load oop ref——decode compressed oop]

**TypeArrayKlass** (`typeArrayKlass.hpp:35-80`):
- 基本类型数组——`byte_at(index)` → jbyte——**不是** OOP——GC **不需要**遍历
- 8 种基本类型: T_BOOLEAN/T_CHAR/T_FLOAT/T_DOUBLE/T_BYTE/T_SHORT/T_INT/T_LONG——每种对应 1/2/4/8 字节元素
- [x86: 基本类型数组——[markOop(8B)][compressedKlass(4B)][length(4B)][elem1][elem2]...。GC 扫描: 读 Klass→检查 is_typeArray→**直接跳过**——没有 OOP 引用——不需要 mark。GC 只关心对象头——元素是 primitive——不管]

### 2. ArrayOop 内存布局 + 访问

**arrayOopDesc** (`arrayOop.hpp:35-75`):
- header: markOop(8B) + compressedKlass(4B) + `_length`(4B) = 16B
- 元素: 紧跟 header——`elem_offset = header_size + index * elem_size`
- [C++: `arrayOopDesc` 继承 `oopDesc`——`_mark` 和 `_metadata._klass` 在 oopDesc 中——`_length` 在 arrayOopDesc 中。`arrayOopDesc::length()` = `*(int*)((char*)this + sizeof(oopDesc))`——在 compressed class 模式下 offset=12]

**ObjArray 访问** (`objArrayOop.hpp:30-55`):
- `objArrayOopDesc::obj_at(int index)`: `(oop*)((char*)this + base_offset + index*4)` — compressed oop
- [C++: base_offset——compressed oop 模式: sizeof(oopDesc)+sizeof(int)=16-12B。`obj_at` 返回 oop——decode_heap_oop——如果 compressed oop==null→返回 null]
- [x86: array bounds check——JIT 编译时生成 `cmp index, array_length; jae ArrayIndexOutOfBounds`。C2 的 RangeCheckElimination 把不变的 bounds check 提到 loop 外]

**TypeArray 访问** (`typeArrayOop.hpp:30-60`):
- `typeArrayOopDesc::int_at(int index)`: `*(jint*)((char*)this + base_offset + index*4)` — 直接读 4B
- byte_at: 读 1B; long_at: 读 8B (需要 8B 对齐)
- [x86: `mov eax, [rbx + rcx*4 + 16]`——rbx=数组首地址, rcx=index, 4=元素大小, 16=header 大小。一条指令——no decode——直接就是 int——GC 不需要遍历——元素无 OOP]

---

### 核心悬念

**"`int[]` 和 `String[]`——同一个 JVM 数组类型——GC 对它们完全不同。"** — ObjArray 每个元素是 compressed oop——GC 需要逐个 decode+验证+标记 alive。TypeArray 元素是 primitive value——GC 直接跳过——只检查对象头。Klass 层次决定了不同的内存布局和 GC 行为。下一篇: 常量池——字节码里的 #5 怎么变成直接方法指针。

> → [04-constantpool-method.md](04-constantpool-method.md)
