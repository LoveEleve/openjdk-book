set pagination off
set $g1h = (G1CollectedHeap*)Universe::_collectedHeap
echo === ConcMark ===\n
printf "ConcGCThreads = %d\n", (int)$g1h->_cm->_num_active_tasks
echo === Card ===\n
printf "card_size_in_words = %d\n", (int)(CardTableModRefBSForCTRS::card_size_in_words)
printf "card_size = %d\n", (int)(CardTableModRefBSForCTRS::card_size_in_words * 8)
echo === CompressedOops ===\n
printf "narrow_oop_shift = %d\n", (int)Universe::narrow_oop_shift()
quit
