# 02. Verifier + StackMapTable — 字节码验证

> 🔴 Deep | 15 KP 中的 1 个核心机制
> 读者处境: ClassFileParser 解析完——但这个 .class 的字节码是真的正确还是恶意构造？Verifier 是最后一道防线。
>
> ⚠️ 写作期修正(2026-08-12, vol-02/07-classfile-classloader/02 已按真实源码成文,本大纲为规划期产物,机制描述以文章为准;本文 ~210 行):
> - **"Verifier::verify_class(verifier.cpp:100-400)" 错**: 静态入口是 `Verifier::verify`(verifier.cpp:140);真正干活的是 `ClassVerifier::verify_class`(:603,遍历 methods 跳 native/abstract/overpass 逐个 `verify_method` :630)
> - **"verify_method→verify_code" 编造**: verify_code 函数不存在;verify_method(:630)内部 = SignatureVerifier 验签名+StackMapFrame 初始化(:648,set_locals_from_arg :651)+generate_code_data(:658,每条指令偏移,new 标 NEW_OFFSET)+异常表(:666)/局部变量表(:672)检查+StackMapTable 读取(:675-683)+RawBytecodeStream 线性扫描逐指令模拟+verify_stackmap_table(:1858)
> - **"OperationStack stack(max_stack)" 编造**: 真实数据结构=`StackMapFrame`(stackMapFrame.hpp:43-61,_locals/_stack=VerificationType 数组,_stack_mark 支持回退);数据流分析用的就是它自己
> - **"common_super_type(T1,T2)" 名错**: 真实=StackMapFrame::is_assignable_to(stackMapFrame.cpp:158)+VerificationType::is_assignable_from(verificationType.hpp:267);帧合并=StackMapTable::match_stackmap(stackMapTable.cpp:71-123: match=true→is_assignable_to 比较 :104-107、update=true→copy_locals/copy_stack 用预计算帧替换当前帧 :109-121;match/update 四组合注释 :78-87)
> - **"加载时就拒绝" 错**: 验证在**链接阶段**(InstanceKlass::verify_code :686→link_class_impl :790,在 rewrite_class :793 之前);策略=BytecodeVerificationLocal=false/Remote=true(globals.hpp:561-564,**bootstrap 类默认不验证**)
> - **老验证器并未移除**: inference_verify(verifier.cpp:274)=dlsym libjava 的 VerifyClassCodesForMajorVersion/VerifyClassCodes(:66-89,libverify check_code.c,42-03 呼应);**class 版本 <50 直接走老验证器**(:198-201);≥50 走新验证器,失败时仅 <51 可 failover(NOFAILOVER_MAJOR_VERSION=51 :58,FailOverToOldVerifier 默认 true globals.hpp:518)
> - **frame_type 编码 247 错**: 实际 247=**same_locals_1_stack_item_extended**(stackMapTableFormat.hpp:407),**251=same_frame_extended**(:276);0-63=same_frame(:229)/64-127=same_locals_1_stack_item(:334)/248-250=chop_frame(251-tag,:484)/252-254=append_frame(tag-251,:555)/255=full_frame(:660);**7 种帧非 6 种**
> - **"ITEM_NewObject(offset)" 名错**: 规范枚举是 **ITEM_Uninitialized=8**(verificationType.hpp:45,后跟 bci=new 指令偏移);ITEM_Top=0/Integer=1/Float=2/Double=3/Long=4/Null=5/UninitializedThis=6/Object=7(verificationType.hpp:36-46)
> - 类型项读取: StackMapReader::parse_verification_type(stackMapTable.cpp:184-218): Object→校验 cpool 索引是 klass 类+**取名字不触发解析**(:189-199)、Uninitialized→校验 offset 是 new 指令(NEW_OFFSET 标记,:205-214)
> - 操作码模拟: new→verify_cp_class_type+push uninitialized_type(bci)(verifier.cpp:1652-1654);newarray 先 pop 长度;invoke 五兄弟统一 verify_invoke_instructions(:2491)
> - STACKMAP_ATTRIBUTE_MAJOR_VERSION=50(verifier.hpp:39)——StackMapTable 从 class 版本 50 起强制(含分支方法缺失→VerifyError)
> - 行号全漂移(大纲 :100-400/:500-1200/:40-300/:30-150 均不成立);"四步验证"简化(无此分步);"O(2^n)/快 2-3x" 无源码依据不写
> - 悬念指向 03-symbol-string-table.md ✓(标题待写时以 03 大纲为准);实证: materials/commands/07-classfile-verification-log.txt(-Xlog:verification=info "Verifying class ... with new format" 逐方法)+07-classfile-stackmap-javap.txt(javap StackMapTable: frame_type=253 append/16 same/250 chop)

### 1. Verifier — 四步验证

场景: 你从互联网下载了一个 .class——它的字节码把 String 当 int 传给了方法。JVM 必须拒绝——不是运行时抛 ClassCastException——是链接时就拒绝。

**入口与时机**(替代原 "Verifier::verify_class:100-400"):
- 时机: `InstanceKlass::link_class_impl`(instanceKlass.cpp:710)里 `verify_code`(:790)在 rewrite_class(:793)之前;验证失败=链接失败
- 入口: `Verifier::verify`(verifier.cpp:140,版本分发)→版本 ≥50 走 `ClassVerifier::verify_class`(:603,跳 native/abstract/overpass)→`verify_method`(:630);<50 直接 `inference_verify`(:274,老验证器,dlsym libverify VerifyClassCodes)
- 策略: BytecodeVerificationLocal=false/Remote=true(globals.hpp:561-564);-Xverify 可调
- [C++: 验证日志 `-Xlog:verification=info`:"Verifying class X with new format"+逐方法(实证)]

**bytecode verification**(替代原 "verifier.cpp:500-1200"):
- verify_method: StackMapFrame current_frame(max_locals, max_stack)(:648)→set_locals_from_arg 初始化参数局部变量(:651)→generate_code_data 标记指令偏移(new→NEW_OFFSET,:658,:1763-1784)→异常表/局部变量表→StackMapTable 读取(StackMapStream/Reader/Table,:675-683)→RawBytecodeStream 线性扫描
- 帧匹配: 每条指令前 verify_stackmap_table(:1858)→match_stackmap(stackMapTable.cpp:71-123): match=is_assignable_to 核对、update=copy 预计算帧替换当前帧——"check 不 inference"
- 操作码模拟: push_stack/pop_stack 维护类型栈(:767-867);new→uninitialized_type(bci)(:1652-1654);invoke 统一 verify_invoke_instructions(:2491);引用可赋值 is_assignable_to(stackMapFrame.cpp:158)/is_assignable_from(verificationType.hpp:267)
- [C++: 错误上下文 TypeOrigin/ErrorContext(verifier.hpp:97-147)——错误精确到偏移与类型来源]

### 2. StackMapTable — Java 6+ 的类型状态快照

**StackMapTable**(替代原 "stackMapTable.cpp:40-300 + stackMapFrame.hpp:30-150"):
- 7 种帧(stackMapTableFormat.hpp:159-165): 0-63 same/64-127 same_locals_1_stack_item/247 same_locals_1_stack_item_extended/248-250 chop(251-tag)/251 same_frame_extended/252-254 append(tag-251)/255 full;偏移存 offset_delta 增量
- verification_type_info: tag+可选参数(Object→u2 cpool_index/Uninitialized→u2 bci);ITEM 0-8(verificationType.hpp:36-46);Long/Double 占 2 槽
- 读取: StackMapReader::parse_verification_type(stackMapTable.cpp:184-218)Object 取名字不解析、Uninitialized 校验 new 偏移
- [C++: 老验证器(推理式)在 libverify 的 check_code.c,hotspot 经 dlsym 调用;failover 边界 50/51]

---

### 核心悬念

**"StackMapTable 把验证从'推导'变成'核对'。"** — javac 编译期预计算每个分支点的类型状态写进文件,JVM 逐帧核对——线性扫描加常数次比较;每帧仍要重新走可赋值性检查(信任但验证)。验证通过后 rewrite_class 重写字节码,类才正式可用。下一篇: Symbol + StringTable——"java/lang/String" 怎么只存一次。

> → [03-symbol-string-table.md](03-symbol-string-table.md)
