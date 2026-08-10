set pagination off
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap
echo === 11 ===\n
python print("meta=%d KB" % (int)(gdb.parse_and_eval("(size_t)MetaspaceUtils::committed_bytes()") / 1024))
echo === 12 ===\n
python print("sizeof(InstanceKlass)=%d" % gdb.parse_and_eval("sizeof(InstanceKlass)"))
python print("sizeof(ConstantPool)=%d" % gdb.parse_and_eval("sizeof(ConstantPool)"))
echo === 13 ===\n
python print("sizeof(ReferenceProcessor)=%d" % gdb.parse_and_eval("sizeof(ReferenceProcessor)"))
echo === 14 ===\n
python print("CICompilerCount=%d" % gdb.parse_and_eval("CICompilerCount"))
python print("sizeof(VMThread)=%d" % gdb.parse_and_eval("sizeof(VMThread)"))
echo === OOM ===\n
python print("fully_initialized=%d" % gdb.parse_and_eval("Universe::_fully_initialized"))
quit
