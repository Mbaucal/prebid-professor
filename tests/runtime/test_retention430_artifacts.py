"""Artifact cleanup safety: incomplete/active files are never deletion proof."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('retention430_artifacts',Path(__file__).resolve().parents[2]/'scripts/retain-retention430-artifacts.py')
artifacts=importlib.util.module_from_spec(spec);spec.loader.exec_module(artifacts)


class ArtifactRetentionTests(unittest.TestCase):
    def completed(self,folder,name,cache=True):
        case={'case':name,'pacing':'long','policy':'bounded','cache':cache,'repeat':1,
              'noDuplicateGam':True,'noDuplicateBidderRequests':True,'noResentSubmittedBid':True,
              'errors':[],'blockedUnexpectedRequests':[],'afterWarmup':{'heapObjects':{}},'final':{'heapObjects':{}}}
        (folder/(name+'.json')).write_text(json.dumps(case))
        for phase in ['warmup','final']:(folder/(name+'-'+phase+'.heapsnapshot')).write_bytes(b'known fixture heap')
        return case

    def test_only_completed_redundant_raw_heaps_are_deleted_after_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);name='completed';self.completed(folder,name)
            active=folder/'active-final.heapsnapshot';active.write_bytes(b'in progress')
            (folder/'active.json').write_text('{')
            receipt=artifacts.retain(folder)
            self.assertTrue(active.exists())
            self.assertFalse((folder/(name+'-final.heapsnapshot')).exists())
            entry=receipt['files'][name+'-final.heapsnapshot']
            self.assertFalse(entry['retained'])
            self.assertEqual(entry['sha256'],hashlib.sha256(b'known fixture heap').hexdigest())
            self.assertTrue((folder/'artifact-retention.json').is_file())

    def test_representative_heaps_and_metrics_stay_available(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);self.completed(folder,'representative',cache=False)
            receipt=artifacts.retain(folder)
            self.assertTrue((folder/'representative-final.heapsnapshot').exists())
            self.assertTrue((folder/'representative.json').exists())
            self.assertTrue(receipt['files']['representative-final.heapsnapshot']['retained'])

    def test_failed_case_cannot_authorize_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);case=self.completed(folder,'failed');case['errors']=['failure']
            (folder/'failed.json').write_text(json.dumps(case))
            with self.assertRaises(AssertionError):artifacts.retain(folder)
            self.assertTrue((folder/'failed-final.heapsnapshot').exists())


if __name__=='__main__':unittest.main()
