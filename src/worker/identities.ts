import { generateName, capitalize } from "../shared/names";
import type { Identity } from "../shared/types";
import type { Env } from "./env";
import { json, err, parseLimit } from "./http";
import { rowToIdentity, type IdentityRow } from "./rows";

const IDENTITY_WITH_STATS = `
  SELECT i.*, COUNT(m.id) AS message_count, MAX(m.received_at) AS last_message_at
  FROM identities i LEFT JOIN messages m ON m.address = i.address`;

async function createIdentity(
  env: Env,
  opts: { first?: string; last?: string; label?: string },
): Promise<Identity | null> {
  const clean = (s: string | undefined) =>
    s ? s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30) : undefined;
  const wantFirst = clean(opts.first);
  const wantLast = clean(opts.last);
  const explicit = Boolean(wantFirst && wantLast);

  for (let attempt = 0; attempt < 30; attempt++) {
    const g = generateName();
    const first = wantFirst ?? g.first;
    const last = wantLast ?? g.last;
    // After a few collisions, disambiguate with a short number.
    const suffix = attempt >= 10 ? String(Math.floor(Math.random() * 90) + 10) : "";
    const address = `${first}.${last}${suffix}@${env.DOMAIN}`;

    const inserted = await env.DB.prepare(
      `INSERT INTO identities (address, first_name, last_name, label, registered)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(address) DO NOTHING`,
    )
      .bind(address, capitalize(first), capitalize(last), opts.label ?? null)
      .run();

    if (inserted.meta.changes === 1) {
      const row = await env.DB.prepare(`SELECT * FROM identities WHERE address = ?`)
        .bind(address)
        .first<IdentityRow>();
      return row ? rowToIdentity(row) : null;
    }
    if (explicit) return null; // the exact requested name already exists
  }
  return null;
}

export async function handleCreateIdentity(req: Request, env: Env): Promise<Response> {
  let body: { first?: string; last?: string; label?: string } = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return err("invalid JSON body", 400);
  }
  const identity = await createIdentity(env, body);
  if (!identity) {
    return err(
      body.first && body.last
        ? `identity ${body.first}.${body.last}@${env.DOMAIN} already exists`
        : "could not generate a unique identity",
      409,
    );
  }
  return json(identity, 201);
}

export async function handleListIdentities(url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url.searchParams.get("limit"), 100, 500);
  const rows = await env.DB.prepare(
    `${IDENTITY_WITH_STATS} GROUP BY i.address ORDER BY i.created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<IdentityRow>();
  return json({ identities: (rows.results ?? []).map(rowToIdentity) });
}

export async function handleGetIdentity(address: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(`${IDENTITY_WITH_STATS} WHERE i.address = ? GROUP BY i.address`)
    .bind(address)
    .first<IdentityRow>();
  if (!row) return err(`identity ${address} not found`, 404);
  return json(rowToIdentity(row));
}

export async function handleDeleteIdentity(address: string, env: Env): Promise<Response> {
  await env.DB.prepare(`DELETE FROM messages WHERE address = ?`).bind(address).run();
  const res = await env.DB.prepare(`DELETE FROM identities WHERE address = ?`).bind(address).run();
  if ((res.meta.changes ?? 0) === 0) return err(`identity ${address} not found`, 404);
  return json({ deleted: address });
}
