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
}

export interface OtpResult {
  found: boolean;
  code: string | null;
  link: string | null;
  messageId?: string;
  from?: string | null;
  subject?: string | null;
  receivedAt?: string;
}

export interface HealthResult {
  ok: boolean;
  service: string;
  version: string;
  domain: string;
  identities: number;
  messages: number;
}

export interface ApiError {
  error: string;
}
