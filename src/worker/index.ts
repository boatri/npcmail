import PostalMime from "postal-mime";
import { extractOtp, htmlToText } from "../shared/otp";
import { generateName, capitalize } from "../shared/names";
import type { Identity, MessageFull, MessageSummary, OtpResult } from "../shared/types";

export interface Env {
  DB: D1Database;
  API_TOKEN: string;
  DOMAIN: string;
  RETENTION_DAYS: string;
  VERSION?: string;
}

const VERSION = "0.1.0";

// ---------- helpers ----------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

function unauthorized(): Response {
  return err("missing or invalid bearer token", 401);
}

function normalizeAddress(input: string, domain: string): string {
  const s = decodeURIComponent(input).trim().toLowerCase();
  return s.includes("@") ? s : `${s}@${domain}`;
}

interface IdentityRow {
  address: string;
  first_name: string | null;
  last_name: string | null;
  label: string | null;
  registered: number;
  created_at: string;
  message_count?: number;
  last_message_at?: string | null;
}

function rowToIdentity(r: IdentityRow): Identity {
  return {
    address: r.address,
    firstName: r.first_name,
    lastName: r.last_name,
    label: r.label,
    registered: r.registered === 1,
    createdAt: r.created_at,
    messageCount: r.message_count ?? undefined,
    lastMessageAt: r.last_message_at ?? undefined,
  };
}

interface MessageRow {
  id: string;
  address: string;
  from_addr: string | null;
  from_name: string | null;
  to_addr: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  otp_code: string | null;
  otp_link: string | null;
  received_at: string;
}

function snippet(text: string | null): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

function rowToSummary(r: MessageRow): MessageSummary {
  return {
    id: r.id,
    address: r.address,
    from: r.from_addr,
    fromName: r.from_name,
    subject: r.subject,
    snippet: snippet(r.text_body),
    otpCode: r.otp_code,
    otpLink: r.otp_link,
    receivedAt: r.received_at,
  };
}

function rowToFull(r: MessageRow): MessageFull {
  return {
    ...rowToSummary(r),
    to: r.to_addr,
    textBody: r.text_body,
    htmlBody: r.html_body,
    ...(!r.text_body?.trim() && r.html_body ? { textFromHtml: htmlToText(r.html_body) } : {}),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- identity creation ----------

async function createIdentity(
  env: Env,
  opts: { first?: string; last?: string; label?: string },
): Promise<Identity | null> {
  const clean = (s: string | undefined) =>
    s ? s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30) : undefined;
  const wantFirst = clean(opts.first);
  const wantLast = clean(opts.last);

  for (let attempt = 0; attempt < 30; attempt++) {
    let first: string, last: string;
    if (wantFirst && wantLast && attempt === 0) {
      first = wantFirst;
      last = wantLast;
    } else {
      const g = generateName();
      first = wantFirst ?? g.first;
      last = wantLast ?? g.last;
    }
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
    if (wantFirst && wantLast && attempt === 0) {
      return null; // explicit name already exists
    }
  }
  return null;
}

// ---------- email ingest ----------

async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const parsed = await PostalMime.parse(message.raw);
  const to = message.to.toLowerCase();
  const localPart = to.split("@")[0] ?? "";
  const [firstGuess, lastGuess] = localPart.split(".");

  // Catch-all means mail can arrive for addresses nobody registered.
  // Auto-create those as unregistered identities so nothing is lost.
  await env.DB.prepare(
    `INSERT INTO identities (address, first_name, last_name, registered)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(address) DO NOTHING`,
  )
    .bind(to, capitalize(firstGuess ?? null), capitalize(lastGuess ?? null))
    .run();

  const textBody = parsed.text ?? null;
  const htmlBody = parsed.html ?? null;
  const subject = parsed.subject ?? message.headers.get("subject") ?? null;
  const otp = extractOtp(subject, textBody, htmlBody);

  await env.DB.prepare(
    `INSERT INTO messages (id, address, from_addr, from_name, to_addr, subject, text_body, html_body, otp_code, otp_link, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      to,
      parsed.from?.address ?? message.from ?? null,
      parsed.from?.name ?? null,
      to,
      subject,
      textBody,
      htmlBody,
      otp.code,
      otp.link,
      nowIso(),
    )
    .run();

  // Retention pruning piggybacks on ingest — no cron trigger needed.
  const days = parseInt(env.RETENTION_DAYS || "30", 10);
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    await env.DB.prepare(`DELETE FROM messages WHERE received_at < ?`).bind(cutoff).run();
  }
}

// ---------- HTTP API ----------

async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  if (path === "/" && method === "GET") {
    return new Response("npcmail — throwaway email identities on your own domain\n", {
      headers: { "content-type": "text/plain" },
    });
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || !env.API_TOKEN || token !== env.API_TOKEN) return unauthorized();

  // GET /v1/health
  if (path === "/v1/health" && method === "GET") {
    const ident = await env.DB.prepare(`SELECT COUNT(*) AS n FROM identities`).first<{ n: number }>();
    const msgs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    return json({
      ok: true,
      service: "npcmail",
      version: env.VERSION ?? VERSION,
      domain: env.DOMAIN,
      identities: ident?.n ?? 0,
      messages: msgs?.n ?? 0,
    });
  }

  // POST /v1/identities
  if (path === "/v1/identities" && method === "POST") {
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

  // GET /v1/identities
  if (path === "/v1/identities" && method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);
    const rows = await env.DB.prepare(
      `SELECT i.*, COUNT(m.id) AS message_count, MAX(m.received_at) AS last_message_at
       FROM identities i LEFT JOIN messages m ON m.address = i.address
       GROUP BY i.address
       ORDER BY i.created_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all<IdentityRow>();
    return json({ identities: (rows.results ?? []).map(rowToIdentity) });
  }

  // Routes under /v1/identities/{address}[/...]
  const identMatch = path.match(/^\/v1\/identities\/([^/]+)(?:\/(messages|otp))?$/);
  if (identMatch) {
    const address = normalizeAddress(identMatch[1]!, env.DOMAIN);
    const sub = identMatch[2];

    if (!sub && method === "GET") {
      const row = await env.DB.prepare(
        `SELECT i.*, COUNT(m.id) AS message_count, MAX(m.received_at) AS last_message_at
         FROM identities i LEFT JOIN messages m ON m.address = i.address
         WHERE i.address = ? GROUP BY i.address`,
      )
        .bind(address)
        .first<IdentityRow>();
      if (!row) return err(`identity ${address} not found`, 404);
      return json(rowToIdentity(row));
    }

    if (!sub && method === "DELETE") {
      await env.DB.prepare(`DELETE FROM messages WHERE address = ?`).bind(address).run();
      const res = await env.DB.prepare(`DELETE FROM identities WHERE address = ?`).bind(address).run();
      if ((res.meta.changes ?? 0) === 0) return err(`identity ${address} not found`, 404);
      return json({ deleted: address });
    }

    if (sub === "messages" && method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
      const since = url.searchParams.get("since");
      const full = url.searchParams.get("full") === "1";
      const rows = since
        ? await env.DB.prepare(
            `SELECT * FROM messages WHERE address = ? AND received_at > ? ORDER BY received_at DESC LIMIT ?`,
          )
            .bind(address, since, limit)
            .all<MessageRow>()
        : await env.DB.prepare(
            `SELECT * FROM messages WHERE address = ? ORDER BY received_at DESC LIMIT ?`,
          )
            .bind(address, limit)
            .all<MessageRow>();
      const results = rows.results ?? [];
      return json({ messages: full ? results.map(rowToFull) : results.map(rowToSummary) });
    }

    if (sub === "otp" && method === "GET") {
      const since = url.searchParams.get("since");
      // Server-side long-poll, capped below common gateway timeouts; the CLI
      // chains requests to honor longer --wait values.
      const wait = Math.min(parseInt(url.searchParams.get("wait") ?? "0", 10), 25);
      const deadline = Date.now() + wait * 1000;

      // The heuristic extraction is a hint, not a gate: return as soon as ANY
      // qualifying message exists (preferring one with an extracted code/link)
      // and include the full message so the caller can extract what the
      // heuristics missed.
      const sinceCond = since ? "AND received_at > ?" : "";
      const withOtp = `SELECT * FROM messages WHERE address = ? ${sinceCond} AND (otp_code IS NOT NULL OR otp_link IS NOT NULL) ORDER BY received_at DESC LIMIT 1`;
      const anyMsg = `SELECT * FROM messages WHERE address = ? ${sinceCond} ORDER BY received_at DESC LIMIT 1`;
      const bindings = since ? [address, since] : [address];

      do {
        let row = await env.DB.prepare(withOtp).bind(...bindings).first<MessageRow>();
        row ??= await env.DB.prepare(anyMsg).bind(...bindings).first<MessageRow>();
        if (row) {
          const result: OtpResult = {
            found: true,
            code: row.otp_code,
            link: row.otp_link,
            messageId: row.id,
            from: row.from_addr,
            subject: row.subject,
            receivedAt: row.received_at,
            message: rowToFull(row),
          };
          return json(result);
        }
        if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
      } while (Date.now() < deadline);

      return json({ found: false, code: null, link: null } satisfies OtpResult);
    }
  }

  // GET /v1/messages/{id}
  const msgMatch = path.match(/^\/v1\/messages\/([0-9a-f-]{36})$/);
  if (msgMatch && method === "GET") {
    const row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`)
      .bind(msgMatch[1]!)
      .first<MessageRow>();
    if (!row) return err("message not found", 404);
    return json(rowToFull(row));
  }

  return err(`no route: ${method} ${path}`, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handleApi(req, env);
    } catch (e) {
      return err(`internal error: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
};
