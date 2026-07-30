/**
 * sync.js — Download Scryfall unique_artwork bulk data and write cards.json.
 *
 * Usage:
 *   node sync.js           — skips if DB is already up to date
 *   node sync.js --force   — always re-downloads and re-writes
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { BULK_DATA_URL, BULK_TYPE, httpGet, fetchBulkCards } = require('./scripts/scryfall');

const CARDS_PATH = path.join(__dirname, 'cards.json');
const META_PATH  = path.join(__dirname, 'cards-meta.json');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes('--force');

  // 1. Fetch bulk-data index
  console.log('Fetching Scryfall bulk-data index...');
  const index = JSON.parse(await httpGet(BULK_DATA_URL));
  const entry = index.data.find(d => d.type === BULK_TYPE);
  if (!entry) throw new Error(`Could not find "${BULK_TYPE}" in bulk-data index`);

  const downloadUri = entry.jsonl_download_uri;
  if (!downloadUri) throw new Error('Bulk-data entry has no jsonl_download_uri — has the Scryfall API changed again?');
  const updatedAt   = entry.updated_at;
  const sizeMB      = ((entry.compressed_size || entry.size || 0) / 1024 / 1024).toFixed(0);

  console.log(`  Type:    ${entry.name}`);
  console.log(`  Updated: ${updatedAt}`);
  console.log(`  Size:    ~${sizeMB} MB compressed`);

  // 2. Check if already current
  if (!force && fs.existsSync(META_PATH) && fs.existsSync(CARDS_PATH)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      if (meta.bulk_updated_at === updatedAt) {
        console.log('\nAlready up to date. Use --force to re-sync.');
        return;
      }
    } catch { /* malformed meta — continue */ }
  }

  // 3. Download + stream-parse the bulk file (slimming each card as it arrives)
  console.log(`\nDownloading ${downloadUri}`);
  const slim = await fetchBulkCards(downloadUri);
  console.log(`  Kept ${slim.length.toLocaleString()} cards after filtering non-game layouts.`);

  // 4. Write slim cards
  console.log('Writing cards.json...');
  fs.writeFileSync(CARDS_PATH, JSON.stringify(slim), 'utf8');

  // 6. Write meta
  const now = new Date().toISOString();
  fs.writeFileSync(META_PATH, JSON.stringify({ bulk_updated_at: updatedAt, last_sync: now }), 'utf8');

  const outMB = (fs.statSync(CARDS_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\nDone! ${slim.length.toLocaleString()} cards → cards.json (${outMB} MB)`);
  console.log(`Last sync: ${now}`);
}

main().catch(err => {
  console.error('\nSync failed:', err.message);
  process.exit(1);
});
