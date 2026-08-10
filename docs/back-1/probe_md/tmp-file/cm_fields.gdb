set pagination off
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap
set $cm = $g1h->_cm

echo === SIZES ===\n
python print("sizeof(G1ConcurrentMark)=%d" % gdb.parse_and_eval("sizeof(G1ConcurrentMark)"))
python print("sizeof(G1CMTask)=%d" % gdb.parse_and_eval("sizeof(G1CMTask)"))
python print("sizeof(G1CMBitMap)=%d" % gdb.parse_and_eval("sizeof(G1CMBitMap)"))
python print("sizeof(WorkGang)=%d" % gdb.parse_and_eval("sizeof(WorkGang)"))
echo \n

echo === TASK COUNTS ===\n
python print("active_tasks=%d" % gdb.parse_and_eval("$cm->_num_active_tasks"))
python print("max_tasks=%d" % gdb.parse_and_eval("$cm->_max_num_tasks"))
python print("num_concurrent=%d" % gdb.parse_and_eval("$cm->_num_concurrent_workers"))
python print("max_concurrent=%d" % gdb.parse_and_eval("$cm->_max_concurrent_workers"))
echo \n

echo === MARK STACK ===\n
python print("MarkStackSize=%d" % gdb.parse_and_eval("MarkStackSize"))
python print("MarkStackSizeMax=%d" % gdb.parse_and_eval("MarkStackSizeMax"))
python print("taskqueue_size=%d" % gdb.parse_and_eval("(size_t)(int)TASKQUEUE_SIZE"))
echo \n

echo === BITMAP INFO ===\n
python print("bitmap size=%d MB" % gdb.parse_and_eval("$cm->_prev_mark_bitmap->_bm.word_size() * sizeof(HeapWord) / 1048576"))
echo \n

echo === FINGER ===\n
python print("finger=%s" % str(gdb.parse_and_eval("$cm->_finger")))
python print("heap_start=%s" % str(gdb.parse_and_eval("$cm->_heap.start()")))
python print("heap_end=%s" % str(gdb.parse_and_eval("$cm->_heap.end()")))
quit
