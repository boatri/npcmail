import type { Email } from "postal-mime";
import { MAX_HEADERS_BYTES } from "./constants";
import type { MailHeader, Threading } from "./types";

export interface ReceivedHeaders extends Threading {
  headers: MailHeader[];
}

function capped(headers: MailHeader[]): MailHeader[] {
  const kept: MailHeader[] = [];
  let size = 0;
  for (const h of headers) {
    size += h.name.length + h.value.length;
    if (size > MAX_HEADERS_BYTES) break;
    kept.push(h);
  }
  return kept;
}

export function fromParsed(email: Pick<Email, "headers" | "messageId" | "inReplyTo" | "references">): ReceivedHeaders {
  return {
    headers: capped(email.headers.map((h) => ({ name: h.originalKey, value: h.value }))),
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: email.references ?? null,
  };
}

export function fromRaw(raw: Headers): ReceivedHeaders {
  const headers: MailHeader[] = [];
  raw.forEach((value, name) => headers.push({ name, value }));
  return {
    headers: capped(headers),
    messageId: raw.get("message-id"),
    inReplyTo: raw.get("in-reply-to"),
    references: raw.get("references"),
  };
}
