import { OTP_LONG_POLL_CAP_SECONDS, sleep } from "../shared/constants";
import type { OtpResult } from "../shared/types";
import type { Env } from "./env";
import { json, err, parseLimit } from "./http";
import { rowToFull, rowToSummary, type MessageRow } from "./rows";

function latestMessageQuery(withOtpOnly: boolean, since: string | null): { sql: string; bindings: string[] } {
  const conds = ["address = ?"];
  const bindings: string[] = [];
  if (since) {
    conds.push("received_at > ?");
    bindings.push(since);
  }
  if (withOtpOnly) conds.push("(otp_code IS NOT NULL OR otp_link IS NOT NULL)");
  return {
    sql: `SELECT * FROM messages WHERE ${conds.join(" AND ")} ORDER BY received_at DESC LIMIT 1`,
    bindings,
  };
}

export async function handleListMessages(address: string, url: URL, env: Env): Promise<Response> {
  const limit = parseLimit(url.searchParams.get("limit"), 50, 200);
  const since = url.searchParams.get("since");
  const full = url.searchParams.get("full") === "1";
  const conds = ["address = ?"];
  const bindings: (string | number)[] = [address];
  if (since) {
    conds.push("received_at > ?");
    bindings.push(since);
  }
  bindings.push(limit);
  const rows = await env.DB.prepare(
    `SELECT * FROM messages WHERE ${conds.join(" AND ")} ORDER BY received_at DESC LIMIT ?`,
  )
    .bind(...bindings)
    .all<MessageRow>();
  const results = rows.results ?? [];
  return json({ messages: full ? results.map(rowToFull) : results.map(rowToSummary) });
}

export async function handleGetMessage(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`).bind(id).first<MessageRow>();
  if (!row) return err("message not found", 404);
  return json(rowToFull(row));
}

// The heuristic extraction is a hint, not a gate: returns as soon as ANY
// qualifying message exists (preferring one with an extracted code/link) and
// includes the full message so the caller can extract what the regexes missed.
export async function handleOtp(address: string, url: URL, env: Env): Promise<Response> {
  const since = url.searchParams.get("since");
  const rawWait = parseInt(url.searchParams.get("wait") ?? "0", 10);
  const wait = Number.isNaN(rawWait) ? 0 : Math.min(Math.max(rawWait, 0), OTP_LONG_POLL_CAP_SECONDS);
  const deadline = Date.now() + wait * 1000;
  const preferred = latestMessageQuery(true, since);
  const fallback = latestMessageQuery(false, since);

  do {
    let row = await env.DB.prepare(preferred.sql).bind(address, ...preferred.bindings).first<MessageRow>();
    row ??= await env.DB.prepare(fallback.sql).bind(address, ...fallback.bindings).first<MessageRow>();
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
    // 2s between D1 reads balances latency against read volume on free tier.
    if (Date.now() < deadline) await sleep(2000);
  } while (Date.now() < deadline);

  return json({ found: false, code: null, link: null } satisfies OtpResult);
}
