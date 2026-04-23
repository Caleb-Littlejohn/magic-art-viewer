export async function onRequestGet(context) {
  const { env } = context;
  try {
    const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
      .bind('last_sync')
      .first();
    return Response.json({ last_sync: row?.value ?? null });
  } catch {
    return Response.json({ last_sync: null });
  }
}
