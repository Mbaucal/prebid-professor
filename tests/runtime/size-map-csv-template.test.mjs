import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import sizeMaps from '../../shared/inventory/size-maps.json' with { type: 'json' };
import { sizeMapsTemplateCsv } from '../../src/shared/size-map-csv-template.ts';
import { applyFlexibleSizeMapCsv, previewFlexibleSizeMapCsv } from '../../worker/size-map-compat.ts';
import { workspaceStore } from '../support/test-workspace-store.mjs';

test('approved CSV imports all 7 maps and 25 breakpoints without changing unrelated inventory', async () => {
  const store = workspaceStore();
  try {
    // Use the actual schema without its production sample records.
    const schema = readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8');
    store.sqlite.exec(schema.split('INSERT OR IGNORE INTO publishers')[0]);
    store.sqlite.exec(`
      INSERT INTO publishers (id, name, domain, gam_path) VALUES
        ('test-site', 'Example', 'example.com', '/123/example/'),
        ('other-site', 'Other', 'other.example.com', '/123/other/');
      INSERT INTO size_maps (id, publisher_id, name, map_json) VALUES
        ('existing', 'test-site', 'Sticky', '[{"minViewPort":[0,0],"sizes":[[300,50]]}]'),
        ('custom', 'test-site', 'Custom', '[{"minViewPort":[0,0],"sizes":[[300,250]]}]'),
        ('other', 'other-site', 'Sticky', '[{"minViewPort":[0,0],"sizes":[[320,50]]}]');
      INSERT INTO ad_units (id, publisher_id, code, size_map_key)
        VALUES ('unit', 'test-site', 'CustomUnit', 'Custom');
      INSERT INTO publisher_configs (id, publisher_id, config_json)
        VALUES ('config', 'test-site', '{"enablePrebid":false}');
    `);
    const snapshot = () => JSON.stringify({
      maps: store.sqlite.prepare("SELECT * FROM size_maps WHERE id IN ('custom', 'other') ORDER BY id").all(),
      units: store.sqlite.prepare('SELECT * FROM ad_units').all(),
      configs: store.sqlite.prepare('SELECT * FROM publisher_configs').all(),
    });
    const before = snapshot();
    const request = () => new Request('https://example.com/csv', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'size-maps', csv: sizeMapsTemplateCsv }),
    });
    assert.equal(sizeMapsTemplateCsv.split('\n').length, 26);
    assert.deepEqual(Object.keys(sizeMaps), ['Sticky', 'Billboard', 'InFeed', 'P', 'InText', 'Branding_Map', 'Under_Article']);
    const previewResponse = await previewFlexibleSizeMapCsv(request(), store.env, 'test-site');
    assert.equal(previewResponse.status, 200);
    const { preview } = await previewResponse.json();
    assert.deepEqual([preview.totalRows, preview.createCount, preview.updateCount, preview.errorCount], [7, 6, 1, 0]);
    assert.equal(store.log.batches, 0, 'preview must not write');

    const response = await applyFlexibleSizeMapCsv(request(), store.env, 'test-site');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual([result.imported, result.created, result.updated], [7, 6, 1]);
    for (const [name, breakpoints] of Object.entries(sizeMaps)) {
      const row = store.sqlite.prepare('SELECT map_json FROM size_maps WHERE publisher_id = ? AND name = ?').get('test-site', name);
      assert.deepEqual(JSON.parse(row.map_json), [...breakpoints].sort((a, b) => a.minViewPort[0] - b.minViewPort[0]), name);
    }
    assert.equal(snapshot(), before, 'custom maps, other sites, ad units and config are preserved');
    const repeated = await (await previewFlexibleSizeMapCsv(request(), store.env, 'test-site')).json();
    assert.deepEqual([repeated.preview.createCount, repeated.preview.updateCount], [0, 7]);
  } finally {
    store.close();
  }
});
