import { htmlToText } from "../shared/otp";
import type { Identity, MessageFull, MessageSummary } from "../shared/types";

export interface IdentityRow {
  address: string;
  first_name: string | null;
  last_name: string | null;
  label: string | null;
  registered: number;
  created_at: string;
  message_count?: number;
  last_message_at?: string | null;
}

export interface MessageRow {
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

export function rowToIdentity(r: IdentityRow): Identity {
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

function snippet(text: string | null): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

export function rowToSummary(r: MessageRow): MessageSummary {
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

export function rowToFull(r: MessageRow): MessageFull {
  return {
    ...rowToSummary(r),
    to: r.to_addr,
    textBody: r.text_body,
    htmlBody: r.html_body,
    ...(!r.text_body?.trim() && r.html_body ? { textFromHtml: htmlToText(r.html_body) } : {}),
  };
}
