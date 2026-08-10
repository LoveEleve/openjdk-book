set pagination off
echo === REMAINING ===\n
python print("sizeof(JVMFlag)=%d" % gdb.parse_and_eval("sizeof(JVMFlag)"))
python print("sizeof(Mutex)=%d" % gdb.parse_and_eval("sizeof(Mutex)"))
python print("sizeof(Monitor)=%d" % gdb.parse_and_eval("sizeof(Monitor)"))
python print("sizeof(ChunkPool)=%d" % gdb.parse_and_eval("sizeof(ChunkPool)"))
python print("sizeof(OopStorage)=%d" % gdb.parse_and_eval("sizeof(OopStorage)"))
python print("sizeof(Symbol)=%d" % gdb.parse_and_eval("sizeof(Symbol)"))
python print("sizeof(SymbolTable)=%d" % gdb.parse_and_eval("sizeof(SymbolTable)"))
python print("sizeof(StringTable)=%d" % gdb.parse_and_eval("sizeof(StringTable)"))
python print("sizeof(G1CMTaskQueue)=%d" % gdb.parse_and_eval("sizeof(G1CMTaskQueue)"))
python print("sizeof(G1CMRootRegions)=%d" % gdb.parse_and_eval("sizeof(G1CMRootRegions)"))
python print("sizeof(PerfData)=%d" % gdb.parse_and_eval("sizeof(PerfData)"))
echo === COUNTS ===\n
python print("num_flags=%d" % gdb.parse_and_eval("JVMFlag::numFlags"))
python print("num_mutex=%d" % gdb.parse_and_eval("(int)Mutex::_num_locks"))
python print("string_table_size=%d" % gdb.parse_and_eval("StringTable::the_table()->table_size()"))
echo === KEY VALUES ===\n
python print("_has_pending_jvmti=%d" % gdb.parse_and_eval("JvmtiExport::_should_post_single_step || JvmtiExport::_should_post_field_access || JvmtiExport::_should_post_field_modification || JvmtiExport::_should_post_class_load ? 1 : 0"))
quit
