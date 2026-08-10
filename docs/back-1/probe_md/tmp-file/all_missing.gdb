set pagination off
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap
set $cm = $g1h->_cm

echo === THREAD ===\n
python print("sizeof(JavaThread)=%d" % gdb.parse_and_eval("sizeof(JavaThread)"))
python print("sizeof(OSThread)=%d" % gdb.parse_and_eval("sizeof(OSThread)"))
python print("sizeof(Thread)=%d" % gdb.parse_and_eval("sizeof(Thread)"))
echo \n

echo === GC SUB ===\n
python print("sizeof(G1CMBitMap)=%d" % gdb.parse_and_eval("sizeof(G1CMBitMap)"))
python print("sizeof(G1Policy)=%d" % gdb.parse_and_eval("sizeof(G1Policy)"))
python print("sizeof(G1RemSet)=%d" % gdb.parse_and_eval("sizeof(G1RemSet)"))
python print("sizeof(G1CardTable)=%d" % gdb.parse_and_eval("sizeof(G1CardTable)"))
python print("sizeof(G1BlockOffsetTable)=%d" % gdb.parse_and_eval("sizeof(G1BlockOffsetTable)"))
python print("sizeof(G1BarrierSet)=%d" % gdb.parse_and_eval("sizeof(G1BarrierSet)"))
python print("sizeof(G1Allocator)=%d" % gdb.parse_and_eval("sizeof(G1Allocator)"))
python print("sizeof(G1CollectionSet)=%d" % gdb.parse_and_eval("sizeof(G1CollectionSet)"))
echo \n

echo === INTERPRETER ===\n
python print("sizeof(Template)=%d" % gdb.parse_and_eval("sizeof(Template)"))
python print("sizeof(DispatchTable)=%d" % gdb.parse_and_eval("sizeof(DispatchTable)"))
python print("sizeof(TemplateTable)=%d" % gdb.parse_and_eval("sizeof(TemplateTable)"))
echo \n

echo === MEMORY ===\n
python print("sizeof(CodeHeap)=%d" % gdb.parse_and_eval("sizeof(CodeHeap)"))
python print("sizeof(FreeRegionList)=%d" % gdb.parse_and_eval("sizeof(FreeRegionList)"))
python print("sizeof(G1HeapRegionTable)=%d" % gdb.parse_and_eval("sizeof(G1HeapRegionTable)"))
python print("sizeof(WorkGang)=%d" % gdb.parse_and_eval("sizeof(WorkGang)"))
echo \n

echo === OOPS ===\n
python print("sizeof(InstanceKlass)=%d" % gdb.parse_and_eval("sizeof(InstanceKlass)"))
python print("sizeof(ConstantPool)=%d" % gdb.parse_and_eval("sizeof(ConstantPool)"))
python print("sizeof(Klass)=%d" % gdb.parse_and_eval("sizeof(Klass)"))
python print("sizeof(Method)=%d" % gdb.parse_and_eval("sizeof(Method)"))
python print("sizeof(ConstMethod)=%d" % gdb.parse_and_eval("sizeof(ConstMethod)"))
echo \n

echo === MISC ===\n
python print("sizeof(ReferenceProcessor)=%d" % gdb.parse_and_eval("sizeof(ReferenceProcessor)"))
python print("sizeof(VMThread)=%d" % gdb.parse_and_eval("sizeof(VMThread)"))
python print("sizeof(CompilerThread)=%d" % gdb.parse_and_eval("sizeof(CompilerThread)"))
echo \n

echo === COUNTS ===\n
python print("num_regions=%d" % gdb.parse_and_eval("$g1h->num_regions()"))
python print("num_mutex=%d" % gdb.parse_and_eval("(int)Mutex::_num_locks"))
echo done
quit
