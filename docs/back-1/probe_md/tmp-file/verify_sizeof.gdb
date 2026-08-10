# GDB script: verify sizeof for all key JVM startup data structures
set pagination off
set print pretty on

echo === G1CollectedHeap ===\n
python print("sizeof(G1CollectedHeap) = %d" % gdb.parse_and_eval("sizeof(G1CollectedHeap)"))
echo \n

echo === HeapRegionManager ===\n
python print("sizeof(HeapRegionManager) = %d" % gdb.parse_and_eval("sizeof(HeapRegionManager)"))
echo \n

echo === HeapRegion ===\n
python print("sizeof(HeapRegion) = %d" % gdb.parse_and_eval("sizeof(HeapRegion)"))
echo \n

echo === G1ConcurrentMark ===\n
python print("sizeof(G1ConcurrentMark) = %d" % gdb.parse_and_eval("sizeof(G1ConcurrentMark)"))
echo \n

echo === G1CMTask ===\n
python print("sizeof(G1CMTask) = %d" % gdb.parse_and_eval("sizeof(G1CMTask)"))
echo \n

echo === G1RemSet ===\n
python print("sizeof(G1RemSet) = %d" % gdb.parse_and_eval("sizeof(G1RemSet)"))
echo \n

echo === G1Policy ===\n
python print("sizeof(G1Policy) = %d" % gdb.parse_and_eval("sizeof(G1Policy)"))
echo \n

echo === G1CardTable ===\n
python print("sizeof(G1CardTable) = %d" % gdb.parse_and_eval("sizeof(G1CardTable)"))
echo \n

echo === G1BarrierSet ===\n
python print("sizeof(G1BarrierSet) = %d" % gdb.parse_and_eval("sizeof(G1BarrierSet)"))
echo \n

echo === G1BlockOffsetTable ===\n
python print("sizeof(G1BlockOffsetTable) = %d" % gdb.parse_and_eval("sizeof(G1BlockOffsetTable)"))
echo \n

echo === G1HotCardCache ===\n
python print("sizeof(G1HotCardCache) = %d" % gdb.parse_and_eval("sizeof(G1HotCardCache)"))
echo \n

echo === G1Allocator ===\n
python print("sizeof(G1Allocator) = %d" % gdb.parse_and_eval("sizeof(G1Allocator)"))
echo \n

echo === G1CollectionSet ===\n
python print("sizeof(G1CollectionSet) = %d" % gdb.parse_and_eval("sizeof(G1CollectionSet)"))
echo \n

echo === G1HeapVerifier ===\n
python print("sizeof(G1HeapVerifier) = %d" % gdb.parse_and_eval("sizeof(G1HeapVerifier)"))
echo \n

echo === JavaThread ===\n
python print("sizeof(JavaThread) = %d" % gdb.parse_and_eval("sizeof(JavaThread)"))
echo \n

echo === OSThread ===\n
python print("sizeof(OSThread) = %d" % gdb.parse_and_eval("sizeof(OSThread)"))
echo \n

echo === markOopDesc ===\n
python print("sizeof(markOopDesc) = %d" % gdb.parse_and_eval("sizeof(markOopDesc)"))
echo \n

echo === oopDesc ===\n
python print("sizeof(oopDesc) = %d" % gdb.parse_and_eval("sizeof(oopDesc)"))
echo \n

echo === HeapWord ===\n
python print("sizeof(HeapWord) = %d" % gdb.parse_and_eval("sizeof(HeapWord)"))
echo \n

echo === CodeCache ===\n
python print("sizeof(CodeCache) = %d" % gdb.parse_and_eval("sizeof(CodeCache)"))
echo \n

echo ===== KEY FIELD VALUES =====\n
echo \n

# Get G1CollectedHeap singleton
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap
echo === G1CollectedHeap key fields ===\n
python print("_g1h address = 0x%lx" % gdb.parse_and_eval("$g1h"))
printf "max_capacity = %zu MB\n", $g1h->max_capacity()/1048576
printf "num_regions = %u\n", $g1h->num_regions()
printf "G1HeapRegionSize = %zu KB\n", $g1h->_hrm._grain_bytes/1024
echo \n

echo === HeapRegionManager ===\n
printf "_num_committed = %u\n", $g1h->_hrm._num_committed
printf "_grain_bytes = %zu\n", $g1h->_hrm._grain_bytes
printf "_free_list length = %zu\n", $g1h->_hrm._free_list._count
echo \n

echo === G1ConcurrentMark ===\n
printf "_cm address = 0x%lx\n", (long)$g1h->_cm
printf "ConcGCThreads = %u\n", $g1h->_cm->_num_active_tasks
printf "_finger = 0x%lx\n", (long)$g1h->_cm->_finger
echo \n

echo === Card Table ===\n
printf "card_size = %d\n", (int)CardTableModRefBSForCTRS::card_size
printf "card_shift = %d\n", (int)CardTableModRefBSForCTRS::card_shift
echo \n

echo === Universe ===\n
printf "heap_base = 0x%lx\n", (long)Universe::heap()->base()
printf "heap_size = %zu MB\n", Universe::heap()->capacity()/1048576
printf "CompressedOops: base=0x%lx, shift=%d\n", (long)Universe::narrow_oop_base(), (int)Universe::narrow_oop_shift()

quit
