import PostalMime, { type Email } from "postal-mime";
import { MAX_BODY_BYTES } from "../shared/constants";
import { capitalize } from "../shared/names";
import { extractOtp } from "../shared/otp";
import type { Env } from "./env";

function truncate(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.length > MAX_BODY_BYTES ? s.slice(0, MAX_BODY_BYTES) : s;
}

function nowIso(): string {
  return new Date().toISOString();
}

// A parse failure must never lose mail: fall back to headers-only storage so
// the caller can at least see that something arrived and from whom.
async function parseMessage(message: ForwardableEmailMessage): Promise<Pick<Email, "text" | "html" | "subject" | "from">> {
  try {
    return await PostalMime.parse(message.raw);
  } catch (e) {
    console.error(`postal-mime parse failed for message to ${message.to}: ${e instanceof Error ? e.message : e}`);
    return {
      text: "(npcmail: could not parse this message body)",
      html: undefined,
      subject: message.headers.get("subject") ?? undefined,
      from: { name: "", address: message.from },
    };
  }
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const parsed = await parseMessage(message);
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

  const textBody = truncate(parsed.text);
  const htmlBody = truncate(parsed.html);
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
      parsed.from?.name || null,
      to,
      subject,
      textBody,
      htmlBody,
      otp.code,
      otp.link,
      nowIso(),
    )
    .run();

  // Retention pruning piggybacks on ingest — no cron trigger needed. A prune
  // failure must not reject the already-stored message (sender would retry
  // and duplicate it), so it only logs.
  try {
    const days = parseInt(env.RETENTION_DAYS || "30", 10);
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
      await env.DB.prepare(`DELETE FROM messages WHERE received_at < ?`).bind(cutoff).run();
    }
  } catch (e) {
    console.error(`retention prune failed: ${e instanceof Error ? e.message : e}`);
  }
}
