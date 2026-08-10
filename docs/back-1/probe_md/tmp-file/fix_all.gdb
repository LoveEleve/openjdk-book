set pagination off
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap
set $cm = $g1h->_cm

echo === 10-interpreter ===\n
python print("sizeof(Template)=%d" % gdb.parse_and_eval("(int)sizeof(Template)"))
python print("sizeof(DispatchTable)=%d" % gdb.parse_and_eval("(int)sizeof(DispatchTable)"))
python print("sizeof(StubQueue)=%d" % gdb.parse_and_eval("(int)sizeof(StubQueue)"))
python print("number_of_codes=%d" % gdb.parse_and_eval("(int)Bytecodes::number_of_codes"))
python print("dispatch_length=%d" % gdb.parse_and_eval("(int)DispatchTable::length"))
python print("code_size=%d" % gdb.parse_and_eval("(long)(AbstractInterpreter::code()->code_end() - AbstractInterpreter::code()->code_start())"))
echo \n

echo === 11-universe2_init ===\n
python print("sizeof(TypeArrayKlass)=%d" % gdb.parse_and_eval("(int)sizeof(TypeArrayKlass)"))
python print("WK_klasses_len=%d" % gdb.parse_and_eval("(int)SystemDictionary::_well_known_klasses->_length"))
python print("metaspace_committed=%d KB" % (int)(gdb.parse_and_eval("(long)MetaspaceUtils::committed_bytes()") / 1024))
echo \n

echo === 12-javaClasses ===\n
python print("sizeof(InstanceKlass)=%d" % gdb.parse_and_eval("(int)sizeof(InstanceKlass)"))
python print("sizeof(ConstantPool)=%d" % gdb.parse_and_eval("(int)sizeof(ConstantPool)"))
echo \n

echo === 13-tail ===\n
python print("sizeof(ReferenceProcessor)=%d" % gdb.parse_and_eval("(int)sizeof(ReferenceProcessor)"))
python print("sizeof(JNIHandleBlock)=%d" % gdb.parse_and_eval("(int)sizeof(JNIHandleBlock)"))
python print("soft_ref_clock=%ld" % (long)(gdb.parse_and_eval("ReferenceProcessor::_soft_ref_timestamp_clock")))
echo \n

echo === 14-Stage5-8 ===\n
python print("CICompilerCount=%d" % gdb.parse_and_eval("CICompilerCount"))
python print("_c1_count=%d" % gdb.parse_and_eval("CompileBroker::_c1_count"))
python print("_c2_count=%d" % gdb.parse_and_eval("CompileBroker::_c2_count"))
python print("sizeof(CompilerThread)=%d" % gdb.parse_and_eval("(int)sizeof(CompilerThread)"))
python print("sizeof(CompileTask)=%d" % gdb.parse_and_eval("(int)sizeof(CompileTask)"))
python print("sizeof(VMThread)=%d" % gdb.parse_and_eval("(int)sizeof(VMThread)"))
echo \n

echo === OOM preallocate objects ===\n
python print("_out_of_memory_error_java_heap=0x%lx" % (long)(gdb.parse_and_eval("Universe::_out_of_memory_error_java_heap")))
python print("_fully_initialized=%d" % gdb.parse_and_eval("Universe::_fully_initialized"))
python print("_init_completed=%d" % gdb.parse_and_eval("is_init_completed()"))
echo \n

echo === Module loading estimate ===\n
python print("total_loaded_classes=%d" % gdb.parse_and_eval("ClassLoader::_num_boot_classes"))
quit
