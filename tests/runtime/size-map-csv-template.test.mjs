import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import sizeMaps from '../../shared/inventory/size-maps.json' with { type: 'json' };
import { sizeMapsTemplateCsv } from '../../src/shared/size-map-csv-template.ts';
import { applyFlexibleSizeMapCsv, previewFlexibleSizeMapCsv } from '../../worker/size-map-compat.ts';
import { applyCsvImport, previewCsvImport } from '../../worker/imports.ts';
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

test('the ad-units example in the CSV import panel imports after the size-map template', async () => {
  // The panel's ad-units example names its maps by name; they must be maps the size-map template creates.
  const panel = readFileSync(new URL('../../src/components/BulkImportPanel.tsx', import.meta.url), 'utf8');
  const adUnitsCsv = panel.match(/'ad-units': \{[\s\S]*?csv: `([^`]*)`/)[1];
  const store = workspaceStore();
  try {
    const schema = readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8');
    store.sqlite.exec(schema.split('INSERT OR IGNORE INTO publishers')[0]);
    store.sqlite.exec(`
      INSERT INTO publishers (id, name, domain, gam_path) VALUES ('test-site', 'Example', 'example.com', '/123/example/');
      INSERT INTO publisher_configs (id, publisher_id, config_json) VALUES ('config', 'test-site', '{"enablePrebid":false}');
    `);
    const request = (kind, csv) => new Request('https://example.com/csv', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, csv }),
    });
    assert.equal((await applyFlexibleSizeMapCsv(request('size-maps', sizeMapsTemplateCsv), store.env, 'test-site')).status, 200);
    const { preview } = await (await previewCsvImport(request('ad-units', adUnitsCsv), store.env, 'test-site')).json();
    assert.deepEqual(preview.rows.filter((row) => row.errors.length).map((row) => [row.key, row.errors]), []);
    assert.equal(preview.createCount, 3);
    const response = await applyCsvImport(request('ad-units', adUnitsCsv), store.env, 'test-site');
    assert.equal(response.status, 200, await response.clone().text());
    const keys = store.sqlite.prepare('SELECT code, size_map_key FROM ad_units ORDER BY sort_order').all().map((row) => [row.code, row.size_map_key]);
    assert.deepEqual(keys, [['Billboard', 'Billboard'], ['P1', 'P'], ['InFeed_1', 'InFeed']]);
    assert(keys.every(([, key]) => Object.hasOwn(sizeMaps, key)));
  } finally {
    store.close();
  }
});
