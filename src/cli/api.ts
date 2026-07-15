import { appendDomain, OTP_LONG_POLL_CAP_SECONDS } from "../shared/constants";
import type { Identity, MessageFull, MessageSummary, OtpResult, HealthResult } from "../shared/types";
import type { NpcmailConfig } from "./config";
import { CliError } from "./output";

function query(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== false) sp.set(k, String(v === true ? 1 : v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export class ApiClient {
  constructor(private cfg: NpcmailConfig) {}

  normalizeAddress(input: string): string {
    return appendDomain(input, this.cfg.domain);
  }

  private identityPath(address: string, sub?: string): string {
    return `/v1/identities/${encodeURIComponent(this.normalizeAddress(address))}${sub ? `/${sub}` : ""}`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.cfg.url.replace(/\/+$/, "") + path;
    if (process.env.NPCMAIL_DEBUG) process.stderr.write(`npcmail-debug: ${method} ${url}\n`);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new CliError(
        `cannot reach npcmail service at ${this.cfg.url} (${e instanceof Error ? e.message : e})`,
      );
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new CliError(`unexpected non-JSON response (${res.status}) from ${url}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new CliError(msg, res.status === 404 ? 3 : 1);
    }
    return data as T;
  }

  health(): Promise<HealthResult> {
    return this.req("GET", "/v1/health");
  }

  createIdentity(opts: { first?: string; last?: string; label?: string }): Promise<Identity> {
    return this.req("POST", "/v1/identities", opts);
  }

  listIdentities(limit = 100): Promise<{ identities: Identity[] }> {
    return this.req("GET", `/v1/identities${query({ limit })}`);
  }

  deleteIdentity(address: string): Promise<{ deleted: string }> {
    return this.req("DELETE", this.identityPath(address));
  }

  listMessages(
    address: string,
    opts?: { since?: string; limit?: number },
  ): Promise<{ messages: MessageSummary[] }>;
  listMessages(
    address: string,
    opts: { since?: string; limit?: number; full: true },
  ): Promise<{ messages: MessageFull[] }>;
  listMessages(
    address: string,
    opts: { since?: string; limit?: number; full?: boolean } = {},
  ): Promise<{ messages: MessageSummary[] | MessageFull[] }> {
    return this.req(
      "GET",
      this.identityPath(address, "messages") +
        query({ since: opts.since, limit: opts.limit, full: opts.full }),
    );
  }

  getMessage(id: string): Promise<MessageFull> {
    return this.req("GET", `/v1/messages/${id}`);
  }

  // One server-side long-poll round (the worker caps the wait).
  otpOnce(address: string, opts: { since?: string; wait?: number } = {}): Promise<OtpResult> {
    return this.req("GET", this.identityPath(address, "otp") + query({ since: opts.since, wait: opts.wait }));
  }

  // Chains long-polls to honor arbitrary --wait durations.
  async otpWait(address: string, opts: { since?: string; waitSeconds: number }): Promise<OtpResult> {
    const deadline = Date.now() + opts.waitSeconds * 1000;
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0) return { found: false, code: null, link: null };
      const res = await this.otpOnce(address, {
        since: opts.since,
        wait: Math.min(remaining, OTP_LONG_POLL_CAP_SECONDS),
      });
      if (res.found) return res;
      if (Date.now() >= deadline) return res;
    }
  }
}
