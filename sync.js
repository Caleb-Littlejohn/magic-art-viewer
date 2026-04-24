/**
 * sync.js — Download Scryfall unique_artwork bulk data and write cards.json.
 *
 * Usage:
 *   node sync.js           — skips if DB is already up to date
 *   node sync.js --force   — always re-downloads and re-writes
 */

'use strict';

const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');

const CARDS_PATH    = path.join(__dirname, 'cards.json');
const META_PATH     = path.join(__dirname, 'cards-meta.json');
const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const BULK_TYPE     = 'default_cards';

// ─── HTTP helper (follows one level of redirect) ─────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'MagicArtViewer/1.0 (local sync)', 'Accept': 'application/json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return resolve(httpGet(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      let received = 0;
      res.on('data', chunk => {
        chunks.push(chunk);
        received += chunk.length;
        process.stdout.write(`\r  Downloaded ${(received / 1024 / 1024).toFixed(1)} MB...`);
      });
      res.on('end', () => {
        process.stdout.write('\n');
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// ─── Card field helpers ───────────────────────────────────────────────────────

function getImageUri(card, size) {
  // Non-DFC cards have top-level image_uris
  if (card.image_uris?.[size]) return card.image_uris[size];
  if (card.card_faces) {
    // Match by illustration_id to pick the correct face for this unique_artwork entry
    if (card.illustration_id) {
      const face = card.card_faces.find(f => f.illustration_id === card.illustration_id);
      if (face?.image_uris?.[size]) return face.image_uris[size];
    }
    // Fallback to front face
    return card.card_faces[0]?.image_uris?.[size] ?? null;
  }
  return null;
}

function pickFields(card) {
  return {
    id:               card.id,
    name:             card.name,
    set:              card.set              || null,
    set_name:         card.set_name         || null,
    collector_number: card.collector_number || null,
    artist:           card.artist           || null,
    illustration_id:  card.illustration_id  || null,
    released_at:      card.released_at      || null,
    color_identity:   card.color_identity   || [],
    type_line:        card.type_line        || null,
    frame_effects:    card.frame_effects    || [],
    border_color:     card.border_color     || 'black',
    promo:            card.promo            || false,
    promo_types:      card.promo_types      || [],
    foil:             Boolean(card.foil),
    nonfoil:          Boolean(card.nonfoil),
    image_uris: {
      normal: getImageUri(card, 'normal'),
      large:  getImageUri(card, 'large'),
    },
    purchase_uris: card.purchase_uris?.tcgplayer
      ? { tcgplayer: card.purchase_uris.tcgplayer }
      : null,
  };
}

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
  const SKIP_LAYOUTS = new Set(['art_series', 'token', 'double_faced_token', 'emblem', 'plane', 'phenomenon', 'scheme', 'vanguard']);
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
