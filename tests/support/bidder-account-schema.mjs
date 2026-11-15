import {readFileSync} from 'node:fs';
const migration = readFileSync(new URL('../../migrations/0007_bidder_accounts.sql',import.meta.url),'utf8');

/** Existing local fixtures start with the original immutable schema. Apply the
 * reviewed additive migration, including fixtures reopened after a lost reply. */
export function applyBidderAccountSchema(sqlite) {
  if (!sqlite.prepare('PRAGMA table_info(bidders)').all().some(column=>column.name==='account_json')) sqlite.exec(migration);
}
export async function applyBidderAccountD1Schema(db) {
  const {results}=await db.prepare('PRAGMA table_info(bidders)').all();
  if (!results.some(column=>column.name==='account_json')) await db.prepare(migration).run();
}
