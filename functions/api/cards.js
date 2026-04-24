export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const name = (url.searchParams.get('name') || '').trim();

  if (!name) {
    return Response.json({ error: 'Query parameter "name" is required.' }, { status: 400 });
  }

  let results;
  try {
    ({ results } = await env.DB.prepare(`
      SELECT c.* FROM cards c
      JOIN card_names cn ON cn.card_id = c.id
      WHERE cn.face_name = ?
      ORDER BY c.released_at ASC
    `).bind(name.toLowerCase()).all());
  } catch (e) {
    return Response.json({ error: 'Database error.' }, { status: 500 });
  }

  if (!results || results.length === 0) {
    return Response.json({ error: `No cards found for "${name}".` }, { status: 404 });
  }

  // Filter out digital/online-only promos (MTGO, Arena)
  const ONLINE_SETS = new Set(['med', 'me2', 'me3', 'me4', 'vma', 'tpr', 'ako', 'anb', 'ana', 'xana']);
  const filtered = results.filter(c => {
    const pt = JSON.parse(c.promo_types || '[]');
    if (pt.includes('mtgo') || pt.includes('arena') || pt.includes('digital')) return false;
    if (ONLINE_SETS.has((c.set_code || '').toLowerCase())) return false;
    return true;
  });

  if (filtered.length === 0) {
    return Response.json({ error: `No cards found for "${name}".` }, { status: 404 });
  }

  const cards = filtered.map(c => ({
    id: c.id,
    name: c.name,
    set: c.set_code,
    set_name: c.set_name,
    collector_number: c.collector_number,
    artist: c.artist,
    illustration_id: c.illustration_id,
    released_at: c.released_at,
    color_identity: JSON.parse(c.color_identity || '[]'),
    type_line: c.type_line,
    frame_effects: JSON.parse(c.frame_effects || '[]'),
    border_color: c.border_color,
    promo: Boolean(c.promo),
    promo_types: JSON.parse(c.promo_types || '[]'),
    foil: c.foil === 1 || c.foil === true,
    nonfoil: c.nonfoil === 1 || c.nonfoil === true,
    image_uris: {
      normal: c.image_normal || null,
      large:  c.image_large  || null,
    },
    purchase_uris: c.tcgplayer ? { tcgplayer: c.tcgplayer } : null,
  }));

  return Response.json(cards, {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}
