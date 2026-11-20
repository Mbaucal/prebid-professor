"""Create a compact, reviewable receipt from a complete MBA-430 local matrix."""
import argparse
import hashlib
import json
from pathlib import Path
from retention430_metrics import matched_pair


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compact(source):
    report=json.loads(source.read_text())
    parameters=report['parameters']
    assert not parameters['quick'] and parameters['phase']=='all','Receipt requires the full profile and render matrix.'
    versions=parameters['versions']
    assert len(set(versions))==2 and set(versions)=={'11.11.0','11.34.0'}
    runs=report['runs'];by_case={row['case']:row for row in runs}
    retention_path=source.parent/'artifact-retention.json'
    retention=json.loads(retention_path.read_text()) if retention_path.exists() else None
    assert len(by_case)==len(runs)
    expected=len(versions)*(parameters['repetitions']*4+7)
    assert len(runs)==expected,(len(runs),expected)
    pairs=[]
    for version in versions:
        for policy in ['default','bounded']:
            for repeat in range(1,parameters['repetitions']+1):
                prefix=f'{version}-long-{policy}'
                pairs.append(matched_pair(by_case[f'{prefix}-off-r{repeat}'],by_case[f'{prefix}-on-r{repeat}']))
        pairs.append(matched_pair(by_case[f'{version}-cap20-default-off-r1'],by_case[f'{version}-cap20-default-on-r1']))
        pairs.append(matched_pair(by_case[f'{version}-steady-bounded-off-r1'],by_case[f'{version}-steady-bounded-on-r1']))
    late=report['lateRender']
    assert len(late)==len(versions)*10 and all(row['passed'] for row in late)
    cases=[]
    def raw_receipt(case,suffix,metrics):
        path=source.parent/(case+suffix)
        entry=retention['files'].get(path.name) if retention and suffix.endswith('.heapsnapshot') else None
        if path.exists():
            result={'sha256':sha(path),'retained':True,'bytes':path.stat().st_size}
            if entry:assert entry['sha256']==result['sha256'] and entry['caseMetricsSha256']==sha(metrics)
            return result
        assert entry and entry['retained'] is False and entry['caseMetricsSha256']==sha(metrics),('Missing raw artifact without verified extraction',path.name)
        return {key:entry[key] for key in ['sha256','retained','bytes']}
    for row in runs:
        raw=source.parent/(row['case']+'.json')
        assert json.loads(raw.read_text())==row,('Per-case receipt differs',row['case'])
        if row['pacing']=='steady' and row['cache']:
            for key in ['trackedAuctions','trackedBids']:
                assert row['afterWarmup']['cache'][key]==row['final']['cache'][key],('Wrapper occupancy did not reach steady state',key)
        samples=[]
        for observation in row['samples']:
            cache=observation['cache']
            samples.append({'index':observation['index'],'at':observation['at'],
                'counts':observation['counts'],'nativePool':observation['nativePool'],'eventCount':observation['eventCount'],
                'heapUsedBytesAfterGC':observation['heapAfterGC']['usedSize'],'dom':observation['dom'],
                'performanceSeconds':observation['performance'],
                'wrapper':None if cache is None else {key:cache[key] for key in ['trackedAuctions','trackedBids','counters']}})
        cases.append({key:row[key] for key in ['case','prebidVersion','cache','policy','testOnlySettings','pacing','repeat',
            'opportunities','warmupOpportunities','inputWithoutCacheSha256','programSha256','cpu','measuredWallSeconds',
            'virtualElapsedMs','noDuplicateGam','noDuplicateBidderRequests','noResentSubmittedBid','errors','blockedUnexpectedRequests']}|
            {'rawReceiptSha256':sha(raw),'samples':samples,'heapObjectsAfterWarmup':row['afterWarmup']['heapObjects'],
             'heapObjectsFinal':row['final']['heapObjects'],'finalDispatchesByCode':row['final']['dispatchesByCode'],
             'finalWireByCode':row['final']['wireByCode'],'assertedExpectedPrimarySequence':True,
             'rawProfiles':{suffix:raw_receipt(row['case'],suffix,raw) for suffix in
                ['-warmup.heapsnapshot','-final.heapsnapshot','.cpuprofile']}})
    render=[]
    for row in late:
        if row['case']=='ttl-buffer-10-selection':
            render.append({'case':row['case'],'prebidVersion':row['prebidVersion'],'passed':True,
                           'meaning':row['meaning'],'counts':row['state']['counts'],
                           'cachedResponseAgeSecondsAtNextTarget':row['cachedResponseAgeSecondsAtNextTarget']})
        else:
            render.append({key:row[key] for key in ['case','prebidVersion','delaySeconds','originalBidTTLSeconds',
                'ttlBufferSeconds','testOnlyPolicy','testOnlySuppressExpiredRender','renderedCreativeElements','passed']}|
                {'before':row['before'],'counts':row['state']['counts'],'renderEvents':row['state']['renders']})
    native={version:{key:value for key,value in report['nativeBuilds'][version].items() if key!='packages'} for version in versions}
    return {'schemaVersion':1,'scope':report['scope'],'baseCommit':report['baseCommit'],'runtime':report['runtime'],
        'nativeBuilds':native,'parameters':parameters,'environment':report['environment'],'harnessSha256':report['harnessSha256'],
        'fullSummarySha256':sha(source),'artifactRetention':retention,
        'matchedPairs':pairs,'runs':cases,'lateRender':render,
        'limits':report['limits']+([retention['limitation']] if retention else [])}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('summary',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(compact(args.summary),indent=2)+'\n')
    print(args.output)
