export interface Identity {
  address: string;
  firstName: string | null;
  lastName: string | null;
  label: string | null;
  registered: boolean;
  createdAt: string;
  messageCount?: number;
  lastMessageAt?: string | null;
}

export interface MessageSummary {
  id: string;
  address: string;
  from: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  otpCode: string | null;
  otpLink: string | null;
  receivedAt: string;
}

export interface MessageFull extends MessageSummary {
  to: string | null;
  textBody: string | null;
  htmlBody: string | null;
  /** html converted to readable text; present only when textBody is empty */
  textFromHtml?: string | null;
}

export interface OtpResult {
  /** true when a message matched (even if no code/link was auto-detected) */
  found: boolean;
  code: string | null;
  link: string | null;
  messageId?: string;
  from?: string | null;
  subject?: string | null;
  receivedAt?: string;
  /** the full message, so callers can extract what the heuristics missed */
  message?: MessageFull;
}

export interface HealthResult {
  ok: boolean;
  service: string;
  version: string;
  domain: string;
  identities: number;
  messages: number;
}
