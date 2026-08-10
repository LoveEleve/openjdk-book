set pagination off
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap

echo === HeapRegionManager ===\n
python print("sizeof(HeapRegionManager)=%d" % gdb.parse_and_eval("sizeof(HeapRegionManager)"))
python print("sizeof(HeapRegion)=%d" % gdb.parse_and_eval("sizeof(HeapRegion)"))
python print("sizeof(G1HeapRegionTable)=%d" % gdb.parse_and_eval("sizeof(G1HeapRegionTable)"))
python print("sizeof(FreeRegionList)=%d" % gdb.parse_and_eval("sizeof(FreeRegionList)"))
echo \n

echo === Counts ===\n
python print("num_committed=%d" % gdb.parse_and_eval("$g1h->_hrm._num_committed"))
python print("allocated=%d" % gdb.parse_and_eval("$g1h->_hrm._allocated_heapregions_length"))
python print("free_list_count=%s" % str(gdb.parse_and_eval("$g1h->_hrm._free_list._count")))
echo \n

echo === Region[0] ===\n
python r0 = gdb.parse_and_eval("$g1h->_hrm._regions._data[0]")
python print("Region[0] type=%s" % str(r0["_type"]))
python print("Region[0] bottom=%s" % r0["_bottom"])
python print("Region[0] end=%s" % r0["_end"])
echo \n

echo === Region[1] ===\n
python r1 = gdb.parse_and_eval("$g1h->_hrm._regions._data[1]")
python print("Region[1] type=%s" % str(r1["_type"]))
python print("Region[1] bottom=%s" % r1["_bottom"])
echo \n

echo === GrainBytes/GrainWords ===\n
python print("GrainBytes=%d" % gdb.parse_and_eval("(size_t)HeapRegion::GrainBytes"))
python print("GrainWords=%d" % gdb.parse_and_eval("(size_t)HeapRegion::GrainWords"))
echo \n

echo === available_map ===\n
python am = gdb.parse_and_eval("$g1h->_hrm._available_map._map._map")
python print("available_map _map size=%s" % str(am.type.sizeof))
quit
