"""Unit checks never run browsers, auctions or production code."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('retention430_metrics', Path(__file__).resolve().parents[2] / 'scripts/retention430_metrics.py')
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)


class RetentionEvidenceTests(unittest.TestCase):
    def test_matching_rejects_different_counts_config_and_cache_state(self):
        off = {'prebidVersion':'11.34.0','pacing':'long','policy':'bounded','cache':False,
               'inputWithoutCacheSha256':'same','final':{'counts':{'gam':240,'bidder':480,'responses':600,'rendered':240},
               'dispatchesByCode':{'A':120,'B':120},'wireByCode':{'bidder:A':120,'bidder:B':120}}}
        import copy
        on = copy.deepcopy(off);on['cache'] = True
        self.assertTrue(metrics.matched_pair(off,on)['matched'])
        for path in [('pacing',), ('inputWithoutCacheSha256',), ('final','counts','gam'), ('final','wireByCode','bidder:A')]:
            changed = copy.deepcopy(on);target = changed
            for key in path[:-1]:target = target[key]
            target[path[-1]] = 'different'
            with self.assertRaises(AssertionError):metrics.matched_pair(off,changed)
        with self.assertRaises(AssertionError):metrics.matched_pair(on,off)

    def test_heap_shape_uses_metadata_order_and_does_not_count_arrays(self):
        fields = ['edge_count','self_size','type']
        heap = {'snapshot':{'meta':{'node_fields':fields,'node_types':[[],[],['object','array']],
                'edge_fields':['name_or_index','to_node','type'],'edge_types':[[],[],['property','element']]}},
                'strings':['adId','adUnitCode','auctionId','responseTimestamp','ttl'],
                'nodes':[5,48,0,5,80,1], 'edges':sum(([i,0,0] for i in range(5)),[])*2}
        result = metrics.heap_objects(heap)
        self.assertEqual(result['nodes'],2);self.assertEqual(result['bidShapedObjects'],1)
        self.assertEqual(result['bidShapedSelfBytes'],48);self.assertEqual(result['selfBytes'],128)
        heap['nodes'][0] = 20
        with self.assertRaises(ValueError):metrics.heap_objects(heap)

    def test_cpu_groups_are_exclusive_and_unknown_frames_are_not_called_prebid(self):
        frames = [{'url':'https://local/prebid.js'},{'url':'https://local/ads.min.js'},
                  {'url':'retention430-browser-fixture.js'},{'functionName':'(garbage collector)'},
                  {'functionName':'(idle)'},{'url':'','functionName':'unknown'}]
        profile = {'nodes':[{'id':i+1,'callFrame':frame} for i,frame in enumerate(frames)],
                   'samples':[1,2,3,4,5,6],'timeDeltas':[1000]*6}
        result = metrics.cpu_samples(profile)
        self.assertEqual(result['sampledMs'],dict.fromkeys(['nativePrebid','frozenRuntime','fixture','garbageCollector','idle','browserOrUnattributed'],1))
        profile['timeDeltas'].pop()
        with self.assertRaises(ValueError):metrics.cpu_samples(profile)


if __name__ == '__main__':unittest.main()
