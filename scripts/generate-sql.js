'use strict';

/**
 * generate-sql.js — reads cards.json and writes cards-import.sql
 * for import into a Cloudflare D1 database.
 *
 * Usage: node scripts/generate-sql.js
 */

const fs   = require('fs');
const path = require('path');
const { cardTuple, cardNameRows, esc } = require('./scryfall');

const CARDS_PATH = path.join(__dirname, '..', 'cards.json');
const META_PATH  = path.join(__dirname, '..', 'cards-meta.json');
const SQL_PATH   = path.join(__dirname, '..', 'cards-import.sql');

const BATCH = 25; // rows per INSERT statement — D1 has a per-statement size limit

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
  foil             INTEGER DEFAULT 0,
  nonfoil          INTEGER DEFAULT 1,
  image_normal     TEXT,
  image_large      TEXT,
  tcgplayer        TEXT,
  usd              TEXT,
  usd_foil         TEXT
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

const nameRows = [];

for (let i = 0; i < cards.length; i += BATCH) {
  const batch = cards.slice(i, i + BATCH);
  const rows = batch.map(cardTuple);
  out.write(`INSERT INTO cards VALUES\n${rows.join(',\n')};\n\n`);

  // Collect searchable names
  for (const c of batch) nameRows.push(...cardNameRows(c));

  if ((i / BATCH) % 20 === 0) process.stdout.write(`\r  Cards: ${i.toLocaleString()} / ${cards.length.toLocaleString()}...`);
}
process.stdout.write(`\r  Cards: ${cards.length.toLocaleString()} / ${cards.length.toLocaleString()} done.\n`);

// ─── Card names ───────────────────────────────────────────────────────────────

for (let i = 0; i < nameRows.length; i += BATCH) {
  const batch = nameRows.slice(i, i + BATCH);
  const rows = batch.map(([face, id]) => `(${esc(face)},${esc(id)})`);
  out.write(`INSERT INTO card_names VALUES\n${rows.join(',\n')};\n\n`);

  if ((i / BATCH) % 20 === 0) process.stdout.write(`\r  Names:  ${i.toLocaleString()} / ${nameRows.length.toLocaleString()}...`);
}
process.stdout.write(`\r  Names:  ${nameRows.length.toLocaleString()} / ${nameRows.length.toLocaleString()} done.\n`);

// ─── Meta ─────────────────────────────────────────────────────────────────────

const syncTime = meta.last_sync || new Date().toISOString();
out.write(`INSERT INTO meta VALUES ('last_sync', ${esc(syncTime)});\n`);

out.end(() => {
  const sizeMB = (fs.statSync(SQL_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\nDone! cards-import.sql written (${sizeMB} MB)`);
  console.log(`Next: npx wrangler d1 import magic-art-cards cards-import.sql`);
});
