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
const { BULK_DATA_URL, BULK_TYPE, SKIP_LAYOUTS, httpGet, pickFields } = require('./scripts/scryfall');

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

  const downloadUri = entry.download_uri;
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

  // 3. Download bulk file
  console.log(`\nDownloading ${downloadUri}`);
  const raw = await httpGet(downloadUri);

  // 4. Parse JSON
  console.log('Parsing JSON...');
  const cards = JSON.parse(raw);
  console.log(`  Parsed ${cards.length.toLocaleString()} cards.`);

  // Drop non-game card layouts
  const filtered = cards.filter(c => !SKIP_LAYOUTS.has(c.layout));
  console.log(`  Kept ${filtered.length.toLocaleString()} after filtering non-game layouts.`);

  // 5. Extract only the fields we need
  console.log('Writing cards.json...');
  const slim = filtered.map(pickFields);
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
