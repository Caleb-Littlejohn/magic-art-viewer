'use strict';

/**
 * generate-sql.js — reads cards.json and writes cards-import.sql
 * for import into a Cloudflare D1 database.
 *
 * Usage: node scripts/generate-sql.js
 */

const fs   = require('fs');
const path = require('path');

const CARDS_PATH = path.join(__dirname, '..', 'cards.json');
const META_PATH  = path.join(__dirname, '..', 'cards-meta.json');
const SQL_PATH   = path.join(__dirname, '..', 'cards-import.sql');

const BATCH = 25; // rows per INSERT statement — D1 has a per-statement size limit

function esc(v) {
  if (v == null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

console.log('Reading cards.json...');
const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
console.log(`  ${cards.length.toLocaleString()} cards loaded.`);

let meta = {};
try { meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { /* optional */ }

const out = fs.createWriteStream(SQL_PATH, { encoding: 'utf8' });

// ─── Schema ───────────────────────────────────────────────────────────────────

out.write(`-- Magic Art Viewer — D1 import
-- Generated: ${new Date().toISOString()}
-- Cards: ${cards.length.toLocaleString()}

DROP TABLE IF EXISTS card_names;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS meta;

CREATE TABLE cards (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  set_code         TEXT,
  set_name         TEXT,
  collector_number TEXT,
  artist           TEXT,
  illustration_id  TEXT,
  released_at      TEXT,
  color_identity   TEXT,
  type_line        TEXT,
  frame_effects    TEXT,
  border_color     TEXT,
  promo            INTEGER DEFAULT 0,
  promo_types      TEXT,
  image_normal     TEXT,
  image_large      TEXT,
  tcgplayer        TEXT
);

CREATE TABLE card_names (
  face_name TEXT NOT NULL,
  card_id   TEXT NOT NULL
);
CREATE INDEX idx_card_names ON card_names (face_name);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

`);

// ─── Cards ────────────────────────────────────────────────────────────────────

const cardNameRows = [];

for (let i = 0; i < cards.length; i += BATCH) {
  const batch = cards.slice(i, i + BATCH);
  const rows = batch.map(c =>
    `(${esc(c.id)},${esc(c.name)},${esc(c.set)},${esc(c.set_name)},` +
    `${esc(c.collector_number)},${esc(c.artist)},${esc(c.illustration_id)},` +
    `${esc(c.released_at)},${esc(JSON.stringify(c.color_identity || []))},` +
    `${esc(c.type_line)},${esc(JSON.stringify(c.frame_effects || []))},` +
    `${esc(c.border_color)},${c.promo ? 1 : 0},` +
    `${esc(JSON.stringify(c.promo_types || []))},` +
    `${esc(c.image_uris?.normal)},${esc(c.image_uris?.large)},` +
    `${esc(c.purchase_uris?.tcgplayer)})`
  );
  out.write(`INSERT INTO cards VALUES\n${rows.join(',\n')};\n\n`);

  // Collect searchable names
  for (const c of batch) {
    cardNameRows.push([c.name.toLowerCase(), c.id]);
    if (c.name.includes(' // ')) {
      for (const face of c.name.split(' // ')) {
        cardNameRows.push([face.trim().toLowerCase(), c.id]);
      }
    }
  }

  if ((i / BATCH) % 20 === 0) process.stdout.write(`\r  Cards: ${i.toLocaleString()} / ${cards.length.toLocaleString()}...`);
}
process.stdout.write(`\r  Cards: ${cards.length.toLocaleString()} / ${cards.length.toLocaleString()} done.\n`);

// ─── Card names ───────────────────────────────────────────────────────────────

for (let i = 0; i < cardNameRows.length; i += BATCH) {
  const batch = cardNameRows.slice(i, i + BATCH);
  const rows = batch.map(([face, id]) => `(${esc(face)},${esc(id)})`);
  out.write(`INSERT INTO card_names VALUES\n${rows.join(',\n')};\n\n`);

  if ((i / BATCH) % 20 === 0) process.stdout.write(`\r  Names:  ${i.toLocaleString()} / ${cardNameRows.length.toLocaleString()}...`);
}
process.stdout.write(`\r  Names:  ${cardNameRows.length.toLocaleString()} / ${cardNameRows.length.toLocaleString()} done.\n`);

// ─── Meta ─────────────────────────────────────────────────────────────────────

const syncTime = meta.last_sync || new Date().toISOString();
out.write(`INSERT INTO meta VALUES ('last_sync', ${esc(syncTime)});\n`);

out.end(() => {
  const sizeMB = (fs.statSync(SQL_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\nDone! cards-import.sql written (${sizeMB} MB)`);
  console.log(`Next: npx wrangler d1 import magic-art-cards cards-import.sql`);
});
