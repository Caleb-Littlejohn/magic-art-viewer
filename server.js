'use strict';

const path    = require('path');
const fs      = require('fs');
const express = require('express');

const PORT       = process.env.PORT || 3000;
const CARDS_PATH = path.join(__dirname, 'cards.json');
const META_PATH  = path.join(__dirname, 'cards-meta.json');

// ─── Load data into memory ────────────────────────────────────────────────────

if (!fs.existsSync(CARDS_PATH)) {
  console.error('cards.json not found. Run: npm run sync');
  process.exit(1);
}

console.log('Loading cards.json...');
const allCards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));

// Build a Map: lowercased name → [card, ...]  (already sorted by released_at from sync)
const cardsByName = new Map();

function addToIndex(name, card) {
  const key = name.toLowerCase();
  if (!cardsByName.has(key)) cardsByName.set(key, []);
  cardsByName.get(key).push(card);
}

for (const card of allCards) {
  // Index by full name (e.g. "Bonecrusher Giant // Stomp")
  addToIndex(card.name, card);
  // Also index each face name individually for split/adventure/MDFC lookups
  if (card.name.includes(' // ')) {
    for (const faceName of card.name.split(' // ')) {
      addToIndex(faceName.trim(), card);
    }
  }
}
console.log(`Loaded ${allCards.length.toLocaleString()} cards (${cardsByName.size.toLocaleString()} unique names).`);

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

app.use(express.static(__dirname));

// GET /api/cards?name=Lightning+Bolt
app.get('/api/cards', (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Query parameter "name" is required.' });

  const cards = cardsByName.get(name.toLowerCase());
  if (!cards || cards.length === 0) {
    return res.status(404).json({ error: `No cards found for "${name}".` });
  }

  res.json(cards);
});

// GET /api/sync-status
app.get('/api/sync-status', (_req, res) => {
  try {
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    res.json({ last_sync: meta.last_sync ?? null });
  } catch {
    res.json({ last_sync: null });
  }
});

app.listen(PORT, () => {
  console.log(`Magic Art Viewer → http://localhost:${PORT}`);
});
