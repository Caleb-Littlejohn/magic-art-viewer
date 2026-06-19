'use strict';

/**
 * sync-delta.js — compute a nightly delta against the previous cards.json and
 * write cards-delta.sql containing only the cards that are new or changed.
 *
 * Scryfall publishes full snapshots (no delta feed), so we diff the fresh bulk
 * against the previous snapshot ourselves. Insert/update only — cards that
 * disappear upstream are left in the DB (see README / nightly-delta.yml).
 *
 * Flow each run:
 *   1. Read previous cards.json (the cached snapshot) → id → JSON map.
 *   2. Download the fresh bulk, slim it, find rows whose serialized form changed.
 *   3. Write cards-delta.sql (INSERT OR REPLACE) — or nothing if no changes.
 *   4. Overwrite cards.json / cards-meta.json so the next run diffs against today.
 *
 * Exit codes: 0 = success (delta may or may not have been written),
 *             1 = failure. The workflow only runs wrangler if cards-delta.sql
 *             exists, so "no changes" is a clean no-op.
 *
 * Usage: node scripts/sync-delta.js [--force]
 */

const path = require('path');
const fs   = require('fs');
const {
  BULK_DATA_URL, BULK_TYPE,
  httpGet, fetchBulkCards,
  esc, cardTuple, cardNameRows,
} = require('./scryfall');

const CARDS_PATH = path.join(__dirname, '..', 'cards.json');
const META_PATH  = path.join(__dirname, '..', 'cards-meta.json');
const DELTA_PATH  = path.join(__dirname, '..', 'cards-delta.sql');

const BATCH = 25; // rows / ids per statement — D1 has a per-statement size limit

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const force = process.argv.includes('--force');

  // Stale delta from a previous run must never be reapplied by accident.
  if (fs.existsSync(DELTA_PATH)) fs.unlinkSync(DELTA_PATH);

  // 1. Fetch bulk-data index
  console.log('Fetching Scryfall bulk-data index...');
  const index = JSON.parse(await httpGet(BULK_DATA_URL));
  const entry = index.data.find(d => d.type === BULK_TYPE);
  if (!entry) throw new Error(`Could not find "${BULK_TYPE}" in bulk-data index`);
  console.log(`  Updated: ${entry.updated_at}`);

  // 2. Skip if Scryfall hasn't published a newer dump since our last sync.
  let prevMeta = {};
  if (fs.existsSync(META_PATH)) {
    try { prevMeta = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { /* malformed — treat as empty */ }
  }
  if (!force && prevMeta.bulk_updated_at === entry.updated_at) {
    console.log('Already up to date with this bulk dump — no delta. Use --force to re-diff.');
    return;
  }

  // 3. Load the previous snapshot → id → serialized slim card.
  //    On a cache miss (no cards.json) every card reads as "new", so the delta
  //    becomes a full INSERT OR REPLACE — correct, just larger that one night.
  const prevById = new Map();
  if (fs.existsSync(CARDS_PATH)) {
    const prev = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
    for (const c of prev) prevById.set(c.id, JSON.stringify(c));
    console.log(`  Previous snapshot: ${prev.length.toLocaleString()} cards.`);
  } else {
    console.log('  No previous cards.json — treating every card as new (full delta).');
  }

  // 4. Download + stream-parse + slim the fresh bulk.
  console.log(`\nDownloading ${entry.download_uri}`);
  const slim = await fetchBulkCards(entry.download_uri);
  console.log(`  ${slim.length.toLocaleString()} cards after filtering non-game layouts.`);

  // 5. Diff: keep cards whose serialized form differs from the previous snapshot.
  const changed = slim.filter(c => prevById.get(c.id) !== JSON.stringify(c));
  console.log(`  ${changed.length.toLocaleString()} new or changed cards.`);

  // 6. Always refresh the local snapshot + meta so the next diff is against today,
  //    even when nothing changed (keeps the cache key moving forward).
  fs.writeFileSync(CARDS_PATH, JSON.stringify(slim), 'utf8');
  const now = new Date().toISOString();
  fs.writeFileSync(META_PATH, JSON.stringify({ bulk_updated_at: entry.updated_at, last_sync: now }), 'utf8');

  if (changed.length === 0) {
    console.log('\nNo card changes — no SQL written.');
    return;
  }

  // 7. Emit the delta SQL.
  //    For each changed card: replace its `cards` row, and rebuild its
  //    `card_names` rows (delete-then-insert by card_id) so renames stay correct.
  const out = fs.createWriteStream(DELTA_PATH, { encoding: 'utf8' });
  out.write(`-- Magic Art Viewer — nightly delta\n-- Generated: ${now}\n-- Bulk updated: ${entry.updated_at}\n-- Changed cards: ${changed.length.toLocaleString()}\n\n`);

  const changedIds = changed.map(c => c.id);

  // Clear old name rows for the touched cards.
  for (const ids of chunk(changedIds, BATCH)) {
    out.write(`DELETE FROM card_names WHERE card_id IN (${ids.map(esc).join(',')});\n`);
  }
  out.write('\n');

  // Replace the card rows.
  for (const batch of chunk(changed, BATCH)) {
    out.write(`INSERT OR REPLACE INTO cards VALUES\n${batch.map(cardTuple).join(',\n')};\n\n`);
  }

  // Re-insert searchable name rows for the touched cards.
  const nameRows = changed.flatMap(cardNameRows);
  for (const batch of chunk(nameRows, BATCH)) {
    const rows = batch.map(([face, id]) => `(${esc(face)},${esc(id)})`);
    out.write(`INSERT INTO card_names VALUES\n${rows.join(',\n')};\n\n`);
  }

  // Bump the sync marker.
  out.write(`INSERT OR REPLACE INTO meta VALUES ('last_sync', ${esc(now)});\n`);

  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));

  const sizeKB = (fs.statSync(DELTA_PATH).size / 1024).toFixed(1);
  console.log(`\nDone! cards-delta.sql written (${sizeKB} KB, ${changed.length.toLocaleString()} cards).`);
}

main().catch(err => {
  console.error('\nDelta sync failed:', err.message);
  process.exit(1);
});
