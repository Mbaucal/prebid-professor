"""Pure summaries for MBA-430; measurements are observations, never serving policy."""
from collections import Counter


def heap_objects(snapshot):
    """Count post-GC nodes and bid-shaped own-property objects; not retained bytes.

    CDP self_size excludes referenced strings/arrays/documents. Shape matching is
    diagnostic rather than attribution to a package or an exact memory budget.
    """
    meta = snapshot['snapshot']['meta']
    node_fields, edge_fields = meta['node_fields'], meta['edge_fields']
    nodes, edges, strings = snapshot['nodes'], snapshot['edges'], snapshot['strings']
    width, edge_width = len(node_fields), len(edge_fields)
    if not width or not edge_width or len(nodes) % width or len(edges) % edge_width:
        raise ValueError('Malformed CDP heap dimensions')
    nt, size, count = (node_fields.index(key) for key in ('type', 'self_size', 'edge_count'))
    et, name = (edge_fields.index(key) for key in ('type', 'name_or_index'))
    node_types, edge_types = meta['node_types'][nt], meta['edge_types'][et]
    types, shape_count, shape_bytes, cursor = Counter(), 0, 0, 0
    identity = {'adId', 'adUnitCode', 'auctionId', 'responseTimestamp', 'ttl'}
    for offset in range(0, len(nodes), width):
        kind = node_types[nodes[offset + nt]]
        types[kind] += 1
        props = set()
        end = cursor + nodes[offset + count] * edge_width
        if end > len(edges):
            raise ValueError('Heap edge count exceeds available edges')
        if kind == 'object':
            for edge in range(cursor, end, edge_width):
                if edge_types[edges[edge + et]] == 'property':
                    props.add(strings[edges[edge + name]])
            if identity <= props:
                shape_count += 1
                shape_bytes += nodes[offset + size]
        cursor = end
    if cursor != len(edges):
        raise ValueError('Heap edge count leaves unowned edges')
    return {'nodes': len(nodes) // width, 'nodeTypes': dict(types),
            'selfBytes': sum(nodes[offset + size] for offset in range(0, len(nodes), width)),
            'bidShapedObjects': shape_count, 'bidShapedSelfBytes': shape_bytes,
            'limitation': 'Own-property shape count and self_size after GC; not exclusive native retained size.'}


def cpu_samples(profile):
    """Exclusive sampling attribution by the executing frame's URL."""
    nodes = {node['id']: node['callFrame'] for node in profile['nodes']}
    samples, deltas = profile.get('samples', []), profile.get('timeDeltas', [])
    if len(samples) != len(deltas):
        raise ValueError('CPU samples/timeDeltas differ')
    totals = Counter()
    for node, elapsed in zip(samples, deltas):
        frame = nodes[node]
        url, function = frame.get('url', ''), frame.get('functionName', '')
        if 'prebid.js' in url:
            group = 'nativePrebid'
        elif 'ads.min.js' in url:
            group = 'frozenRuntime'
        elif 'retention430-browser-fixture.js' in url:
            group = 'fixture'
        elif function == '(garbage collector)':
            group = 'garbageCollector'
        elif function == '(idle)':
            group = 'idle'
        else:
            group = 'browserOrUnattributed'
        totals[group] += elapsed
    return {'sampledMs': {key: value / 1000 for key, value in totals.items()},
            'samples': len(samples), 'limitation': 'Sampled lab CPU, including instrumentation; not a production latency benchmark.'}


def matched_pair(off, on):
    """Reject a cache comparison with unequal opportunities or native demand."""
    for key in ('prebidVersion', 'pacing', 'policy', 'inputWithoutCacheSha256'):
        if off[key] != on[key]:
            raise AssertionError('Unmatched cache comparison: ' + key)
    for key in ('dispatchesByCode', 'wireByCode', 'counts'):
        if off['final'][key] != on['final'][key]:
            raise AssertionError('Unequal opportunity/demand/render denominator: ' + key)
    if off['cache'] is not False or on['cache'] is not True:
        raise AssertionError('Pair must compare explicit cache OFF and ON')
    return {'matched': True, 'prebidVersion': off['prebidVersion'], 'pacing': off['pacing'], 'policy': off['policy'],
            'gamRequests': off['final']['counts']['gam'], 'nativeBidderRequests': off['final']['counts']['bidder'],
            'nativeBidResponses': off['final']['counts']['responses'], 'successfulRenders': off['final']['counts']['rendered']}
