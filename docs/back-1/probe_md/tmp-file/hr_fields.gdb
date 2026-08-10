set pagination off
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap

echo === HeapRegionManager Fields ===\n
print $g1h->_hrm._num_committed
print $g1h->_hrm._allocated_heapregions_length
echo \n

echo === Sizes via Python ===\n
python print("sizeof(G1HeapRegionTable)=%d" % gdb.parse_and_eval("sizeof(G1HeapRegionTable)"))
python print("sizeof(FreeRegionList)=%d" % gdb.parse_and_eval("sizeof(FreeRegionList)"))
python print("sizeof(HeapRegionSetCount)=%d" % gdb.parse_and_eval("sizeof(HeapRegionSetCount)"))
python print("sizeof(CHeapBitMap)=%d" % gdb.parse_and_eval("sizeof(CHeapBitMap)"))
echo \n

echo === FreeList counts ===\n  
python print("_free_list._count=%d" % gdb.parse_and_eval("$g1h->_hrm._free_list._count"))
echo \n

echo === Region[0] details ===\n
set $r0 = $g1h->_hrm._regions._data[0]
printf "Region[0] type=%d, bottom=0x%lx, end=0x%lx\n", $r0->_type, (long)$r0->_bottom, (long)$r0->_end
quit
