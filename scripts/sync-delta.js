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
 *   1. Read previous cards.json (the cached snapshot) → id → change key + name.
 *   2. Download the fresh bulk, slim it, find rows whose change key differs.
 *   3. Write cards-delta.sql (INSERT OR REPLACE) — or nothing if no changes.
 *   4. Overwrite cards.json / cards-meta.json so the next run diffs against today.
 *
 * Prices are excluded from the change key (VOLATILE_FIELDS in scryfall.js).
 * Scryfall re-prices the whole corpus every night, so treating a price move as
 * a card change made every run rewrite all ~111k rows — a full refresh wearing
 * a delta's clothes. Prices still ride along whenever a card changes for a real
 * reason; pass --with-prices to deliberately refresh them corpus-wide.
 *
 * `card_names` rows are rebuilt only for cards whose name actually changed (in
 * practice: just the new printings), since that DELETE is by far the most
 * expensive statement in the file.
 *
 * Exit codes: 0 = success (delta may or may not have been written),
 *             1 = failure. The workflow only runs wrangler if cards-delta.sql
 *             exists, so "no changes" is a clean no-op.
 *
 * Refuses to write a delta larger than --max-changes (default 25000) — see the
 * guard in main() for why.
 *
 * Usage: node scripts/sync-delta.js [--force] [--with-prices] [--max-changes=N]
 */

const path = require('path');
const fs   = require('fs');
const {
  BULK_DATA_URL, BULK_TYPE,
  httpGet, fetchBulkCards,
  esc, cardTuple, cardNameRows, changeKey,
} = require('./scryfall');

const CARDS_PATH = path.join(__dirname, '..', 'cards.json');
const META_PATH  = path.join(__dirname, '..', 'cards-meta.json');
const DELTA_PATH  = path.join(__dirname, '..', 'cards-delta.sql');

const BATCH = 25; // rows / ids per statement — D1 has a per-statement size limit

// A delta bigger than this is not one night of churn — it means the previous
// snapshot was lost, so every card reads as new. Applying it would blow D1's
// daily row limits and likely fail half-applied. See the guard in main().
const MAX_CHANGES_DEFAULT = 25000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const force      = process.argv.includes('--force');
  const withPrices = process.argv.includes('--with-prices');
  const maxArg     = process.argv.find(a => a.startsWith('--max-changes='));
  const maxChanges = maxArg ? Number(maxArg.split('=')[1]) : MAX_CHANGES_DEFAULT;
  const keyOf      = c => changeKey(c, withPrices);

  // Stale delta from a previous run must never be reapplied by accident.
  if (fs.existsSync(DELTA_PATH)) fs.unlinkSync(DELTA_PATH);

  // 1. Fetch bulk-data index
  console.log('Fetching Scryfall bulk-data index...');
  const index = JSON.parse(await httpGet(BULK_DATA_URL));
  const entry = index.data.find(d => d.type === BULK_TYPE);
  if (!entry) throw new Error(`Could not find "${BULK_TYPE}" in bulk-data index`);
  console.log(`  Updated: ${entry.updated_at}`);
  if (withPrices) console.log('  --with-prices: price moves count as card changes (expect a near-full delta).');

  // 2. Skip if Scryfall hasn't published a newer dump since our last sync.
  let prevMeta = {};
  if (fs.existsSync(META_PATH)) {
    try { prevMeta = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { /* malformed — treat as empty */ }
  }
  if (!force && prevMeta.bulk_updated_at === entry.updated_at) {
    console.log('Already up to date with this bulk dump — no delta. Use --force to re-diff.');
    return;
  }

  // 3. Load the previous snapshot → id → { key, name }.
  //    On a cache miss (no cards.json) every card reads as "new", so the delta
  //    becomes a full INSERT OR REPLACE — correct, just larger that one night.
  const prevById = new Map();
  if (fs.existsSync(CARDS_PATH)) {
    const prev = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
    for (const c of prev) prevById.set(c.id, { key: keyOf(c), name: c.name });
    console.log(`  Previous snapshot: ${prev.length.toLocaleString()} cards.`);
  } else {
    console.log('  No previous cards.json — treating every card as new (full delta).');
  }

  // 4. Download + stream-parse + slim the fresh bulk.
  if (!entry.jsonl_download_uri) throw new Error('Bulk-data entry has no jsonl_download_uri — has the Scryfall API changed again?');
  console.log(`\nDownloading ${entry.jsonl_download_uri}`);
  const slim = await fetchBulkCards(entry.jsonl_download_uri);
  console.log(`  ${slim.length.toLocaleString()} cards after filtering non-game layouts.`);

  // 5. Diff. `changed` gets a replaced `cards` row; `nameDirty` (new cards and
  //    renames only) additionally gets its `card_names` rows rebuilt.
  const changed   = [];
  const nameDirty = [];
  for (const c of slim) {
    const prev = prevById.get(c.id);
    if (!prev) {                        // brand new printing
      changed.push(c);
      nameDirty.push(c);
    } else if (prev.key !== keyOf(c)) {
      changed.push(c);
      if (prev.name !== c.name) nameDirty.push(c);
    }
  }
  console.log(`  ${changed.length.toLocaleString()} new or changed cards (${nameDirty.length.toLocaleString()} needing name-row rebuilds).`);

  // 6. Guard against a "delta" that is really a full refresh. This happens when
  //    the previous snapshot is gone (evicted Actions cache, first ever run), so
  //    every card reads as new. Bail out *before* advancing the snapshot, so the
  //    next run re-diffs from the same point instead of quietly skipping past
  //    changes that were never applied to D1.
  if (maxChanges > 0 && changed.length > maxChanges) {
    throw new Error(
      `${changed.length.toLocaleString()} changed cards exceeds --max-changes=${maxChanges.toLocaleString()}.\n` +
      '  The previous snapshot was probably lost, making this a full refresh rather than a delta.\n' +
      '  Rebuild the table instead: npm run generate-sql && npm run import-d1\n' +
      '  Or, to apply it as-is anyway: npm run sync:delta -- --max-changes=0'
    );
  }

  // 7. Always refresh the local snapshot + meta so the next diff is against today,
  //    even when nothing changed (keeps the cache key moving forward).
  fs.writeFileSync(CARDS_PATH, JSON.stringify(slim), 'utf8');
  const now = new Date().toISOString();
  fs.writeFileSync(META_PATH, JSON.stringify({ bulk_updated_at: entry.updated_at, last_sync: now }), 'utf8');

  if (changed.length === 0) {
    console.log('\nNo card changes — no SQL written.');
    return;
  }

  // 8. Emit the delta SQL.
  const out = fs.createWriteStream(DELTA_PATH, { encoding: 'utf8' });
  out.write(`-- Magic Art Viewer — nightly delta\n-- Generated: ${now}\n-- Bulk updated: ${entry.updated_at}\n-- Changed cards: ${changed.length.toLocaleString()}\n-- Name rebuilds: ${nameDirty.length.toLocaleString()}\n-- Prices in change key: ${withPrices ? 'yes (--with-prices)' : 'no'}\n\n`);

  // Clear old name rows for the renamed/new cards. Without the card_id index
  // every one of these DELETEs scans all ~130k card_names rows.
  if (nameDirty.length) {
    out.write('CREATE INDEX IF NOT EXISTS idx_card_names_card_id ON card_names (card_id);\n\n');
    for (const ids of chunk(nameDirty.map(c => c.id), BATCH)) {
      out.write(`DELETE FROM card_names WHERE card_id IN (${ids.map(esc).join(',')});\n`);
    }
    out.write('\n');
  }

  // Replace the card rows.
  for (const batch of chunk(changed, BATCH)) {
    out.write(`INSERT OR REPLACE INTO cards VALUES\n${batch.map(cardTuple).join(',\n')};\n\n`);
  }

  // Re-insert searchable name rows for the cards whose names we just cleared.
  const nameRows = nameDirty.flatMap(cardNameRows);
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
