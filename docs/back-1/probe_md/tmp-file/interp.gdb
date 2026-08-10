set pagination off
echo === Interpreter ===\n
python print("InterpreterCodeSize=%d" % gdb.parse_and_eval("InterpreterCodeSize"))
python print("code_start=0x%lx" % (long)(gdb.parse_and_eval("(long)AbstractInterpreter::code()->code_start()")))
python print("code_end=0x%lx" % (long)(gdb.parse_and_eval("(long)AbstractInterpreter::code()->code_end()")))
python print("code_size=%d bytes (%.1f KB)" % (int)(gdb.parse_and_eval("(long)(AbstractInterpreter::code()->code_end() - AbstractInterpreter::code()->code_start())"), (float)(gdb.parse_and_eval("(long)(AbstractInterpreter::code()->code_end() - AbstractInterpreter::code()->code_start())") / 1024.0)))
echo \n
echo === DispatchTable ===\n
python print("sizeof(DispatchTable)=%d" % gdb.parse_and_eval("sizeof(DispatchTable)"))
python print("dispatch_length=%d" % gdb.parse_and_eval("(int)DispatchTable::length"))
echo \n
echo === TemplateTable ===\n
python print("sizeof(Template)=%d" % gdb.parse_and_eval("sizeof(Template)"))
python print("number_of_codes=%d" % gdb.parse_and_eval("(int)Bytecodes::number_of_codes"))
echo \n
echo === StubQueue ===\n
python print("sizeof(StubQueue)=%d" % gdb.parse_and_eval("sizeof(StubQueue)"))
quit
