set pagination off
set print pretty on

set $g1h = (G1CollectedHeap*)Universe::_collectedHeap

echo === Heap ===\n
printf "heap_base = 0x%lx\n", (long)Universe::heap()->base()
printf "heap_capacity = %zu MB\n", Universe::heap()->capacity()/1048576
printf "num_regions = %u\n", $g1h->num_regions()
printf "GrainBytes = %zu KB\n", (size_t)HeapRegion::GrainBytes/1024
echo \n

echo === HeapRegionManager ===\n
printf "_free_regions count = something\n"
echo \n

echo === G1ConcurrentMark ===\n
printf "_cm address = 0x%lx\n", (long)$g1h->_cm
printf "ConcGCThreads = %u\n", $g1h->_cm->_num_active_tasks
echo \n

echo === Card Table ===\n
printf "card_size = %d\n", (int)CardTableModRefBSForCTRS::card_size
echo \n

echo === Universe ===\n
printf "CompressedOops: shift=%d\n", (int)Universe::narrow_oop_shift()
quit
