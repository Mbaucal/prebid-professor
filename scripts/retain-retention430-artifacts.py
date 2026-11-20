"""Bound raw-disk use after metrics extraction, without changing the experiment.

Only finalized case JSON files authorize deletion of their own redundant heaps.
Representative default/bounded OFF and steady bounded ON heaps stay available.
Every raw byte stream has a hash receipt before any deletion.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time


def digest(path):
    hasher=hashlib.sha256()
    with path.open('rb') as source:
        while chunk:=source.read(1024*1024):hasher.update(chunk)
    return hasher.hexdigest()


def retain(folder):
    receipt_path=folder/'artifact-retention.json'
    if receipt_path.exists():receipt=json.loads(receipt_path.read_text())
    else:receipt={'schemaVersion':1,'startedAtUTC':datetime.now(timezone.utc).isoformat(),
        'helperSha256':digest(Path(__file__)),'rule':'Retain default/bounded long OFF r1 and steady bounded ON; delete only completed-case redundant raw heaps after saved metric validation and hashing.',
        'limitation':'Artifact hashing/deletion IO may overlap profiling. CPU timings remain descriptive rather than a precise controlled benchmark.',
        'files':{}}
    for raw in sorted(folder.glob('*.json')):
        try:case=json.loads(raw.read_text())
        except (json.JSONDecodeError,OSError):continue
        if not isinstance(case,dict) or raw.stem!=case.get('case') or 'heapObjects' not in case.get('final',{}):continue
        assert case['noDuplicateGam'] and case['noDuplicateBidderRequests'] and case['noResentSubmittedBid']
        assert not case['errors'] and not case['blockedUnexpectedRequests']
        assert 'heapObjects' in case['afterWarmup']
        preserve=(case['pacing']=='long' and case['policy'] in ['default','bounded'] and case['cache'] is False and case['repeat']==1) or (case['pacing']=='steady' and case['cache'] is True)
        for phase in ['warmup','final']:
            name=case['case']+'-'+phase+'.heapsnapshot'
            if name in receipt['files']:continue
            path=folder/name
            assert path.is_file(),('Completed case is missing raw heap before receipt',name)
            entry={'sha256':digest(path),'bytes':path.stat().st_size,'retained':preserve,
                   'caseMetricsSha256':digest(raw),'completedAtUTC':datetime.now(timezone.utc).isoformat()}
            receipt['files'][name]=entry
            # Persist proof before deletion; never use a broad directory cleanup.
            temporary=receipt_path.with_suffix('.tmp')
            temporary.write_text(json.dumps(receipt,indent=2)+'\n');temporary.replace(receipt_path)
            if not preserve:path.unlink()
    return receipt


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path)
    parser.add_argument('--watch',action='store_true');args=parser.parse_args()
    folder=args.directory.resolve()
    while True:
        receipt=retain(folder)
        if not args.watch or (folder/'summary.json').is_file():break
        time.sleep(.5)
    print(json.dumps({'files':len(receipt['files']),'retained':sum(row['retained'] for row in receipt['files'].values())}))
