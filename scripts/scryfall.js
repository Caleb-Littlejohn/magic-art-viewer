'use strict';

/**
 * scryfall.js — shared helpers for downloading Scryfall bulk data,
 * slimming cards to the fields we store, and serializing them to SQL.
 *
 * Used by sync.js, scripts/generate-sql.js, and scripts/sync-delta.js so the
 * full import and the nightly delta always produce identical row formats.
 */

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const { chain }  = require('stream-chain');
const { parser } = require('stream-json/jsonl/Parser');

const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const BULK_TYPE     = 'default_cards';

// Non-game card layouts we never want in the database.
const SKIP_LAYOUTS = new Set(['art_series', 'token', 'double_faced_token', 'emblem', 'plane', 'phenomenon', 'scheme', 'vanguard']);

// Column order for the `cards` table — must match the CREATE TABLE in generate-sql.js.
const CARD_COLUMNS = '(id,name,set_code,set_name,collector_number,artist,illustration_id,released_at,color_identity,type_line,frame_effects,border_color,promo,promo_types,foil,nonfoil,image_normal,image_large,tcgplayer,usd,usd_foil)';

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

// ─── Streaming bulk download ──────────────────────────────────────────────────

// Scryfall bulk files are gzipped JSONL (one card object per line) — too large
// to buffer, so we stream the HTTP response through gunzip and a JSONL parser,
// slimming + filtering each card as it arrives. Returns the array of slim cards
// (non-game layouts dropped).
function fetchBulkCards(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'MagicArtViewer/1.0 (local sync)', 'Accept': '*/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return resolve(fetchBulkCards(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        process.stdout.write(`\r  Downloaded ${(received / 1024 / 1024).toFixed(1)} MB...`);
      });

      const slim = [];
      const pipeline = chain([
        res,
        zlib.createGunzip(),
        parser(),
        ({ value }) => (SKIP_LAYOUTS.has(value.layout) ? null : pickFields(value)),
      ]);
      pipeline.on('data', card => { if (card) slim.push(card); });
      pipeline.on('end', () => { process.stdout.write('\n'); resolve(slim); });
      pipeline.on('error', reject);
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
    prices: {
      usd:      card.prices?.usd      || null,
      usd_foil: card.prices?.usd_foil || null,
    },
    purchase_uris: card.purchase_uris?.tcgplayer
      ? { tcgplayer: card.purchase_uris.tcgplayer }
      : null,
  };
}

// ─── Change detection ────────────────────────────────────────────────────────

// Fields Scryfall re-publishes nightly for essentially the whole corpus.
// Prices move every day, so folding them into the change key makes ~87k of
// ~111k cards read as "changed" every night and turns the nightly delta into a
// full table rewrite. Excluded by default; they still ride along in the row
// whenever a card changes for a real reason.
const VOLATILE_FIELDS = ['prices'];

// Serialized form of a slim card, used to decide whether it changed.
// withVolatile=true compares everything (see sync-delta.js --with-prices).
function changeKey(card, withVolatile = false) {
  if (withVolatile) return JSON.stringify(card);
  const stable = { ...card };
  for (const f of VOLATILE_FIELDS) delete stable[f];
  return JSON.stringify(stable);
}

// ─── SQL serialization ──────────────────────────────────────────────────────

function esc(v) {
  if (v == null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// One `(...)` VALUES tuple for a slim card, in CARD_COLUMNS order.
function cardTuple(c) {
  return `(${esc(c.id)},${esc(c.name)},${esc(c.set)},${esc(c.set_name)},` +
    `${esc(c.collector_number)},${esc(c.artist)},${esc(c.illustration_id)},` +
    `${esc(c.released_at)},${esc(JSON.stringify(c.color_identity || []))},` +
    `${esc(c.type_line)},${esc(JSON.stringify(c.frame_effects || []))},` +
    `${esc(c.border_color)},${c.promo ? 1 : 0},` +
    `${esc(JSON.stringify(c.promo_types || []))},` +
    `${c.foil ? 1 : 0},${c.nonfoil ? 1 : 0},` +
    `${esc(c.image_uris?.normal)},${esc(c.image_uris?.large)},` +
    `${esc(c.purchase_uris?.tcgplayer)},` +
    `${esc(c.prices?.usd)},${esc(c.prices?.usd_foil)})`;
}

// The searchable [face_name, card_id] rows for a card (full name + each face).
function cardNameRows(c) {
  const rows = [[c.name.toLowerCase(), c.id]];
  if (c.name.includes(' // ')) {
    for (const face of c.name.split(' // ')) {
      rows.push([face.trim().toLowerCase(), c.id]);
    }
  }
  return rows;
}

module.exports = {
  BULK_DATA_URL, BULK_TYPE, SKIP_LAYOUTS, CARD_COLUMNS,
  httpGet, fetchBulkCards, getImageUri, pickFields,
  VOLATILE_FIELDS, changeKey,
  esc, cardTuple, cardNameRows,
};
