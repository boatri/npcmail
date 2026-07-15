// Server-side long-poll cap for /otp, kept under common gateway timeouts.
// Clients chain requests to honor longer waits.
export const OTP_LONG_POLL_CAP_SECONDS = 25;

// Bodies are truncated before storage: D1 caps rows around 2 MB while Email
// Routing accepts far larger messages, and no OTP needs a megabyte of HTML.
export const MAX_BODY_BYTES = 262_144;

export function appendDomain(input: string, domain: string): string {
  const s = input.trim().toLowerCase();
  return s.includes("@") ? s : `${s}@${domain}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
