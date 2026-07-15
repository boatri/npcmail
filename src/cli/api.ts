import type { NpcmailConfig } from "./config";
import type { Identity, MessageFull, MessageSummary, OtpResult, HealthResult } from "../shared/types";
import { CliError } from "./output";

export class ApiClient {
  constructor(private cfg: NpcmailConfig) {}

  get domain(): string {
    return this.cfg.domain;
  }

  normalizeAddress(input: string): string {
    const s = input.trim().toLowerCase();
    return s.includes("@") ? s : `${s}@${this.cfg.domain}`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.cfg.url.replace(/\/+$/, "") + path;
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
    return this.req("GET", `/v1/identities?limit=${limit}`);
  }

  getIdentity(address: string): Promise<Identity> {
    return this.req("GET", `/v1/identities/${encodeURIComponent(this.normalizeAddress(address))}`);
  }

  deleteIdentity(address: string): Promise<{ deleted: string }> {
    return this.req("DELETE", `/v1/identities/${encodeURIComponent(this.normalizeAddress(address))}`);
  }

  listMessages(
    address: string,
    opts: { since?: string; limit?: number; full?: boolean } = {},
  ): Promise<{ messages: MessageSummary[] | MessageFull[] }> {
    const params = new URLSearchParams();
    if (opts.since) params.set("since", opts.since);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.full) params.set("full", "1");
    const qs = params.toString();
    return this.req(
      "GET",
      `/v1/identities/${encodeURIComponent(this.normalizeAddress(address))}/messages${qs ? "?" + qs : ""}`,
    );
  }

  getMessage(id: string): Promise<MessageFull> {
    return this.req("GET", `/v1/messages/${id}`);
  }

  // One server-side long-poll round (server caps at ~25s).
  otpOnce(address: string, opts: { since?: string; wait?: number } = {}): Promise<OtpResult> {
    const params = new URLSearchParams();
    if (opts.since) params.set("since", opts.since);
    if (opts.wait) params.set("wait", String(opts.wait));
    const qs = params.toString();
    return this.req(
      "GET",
      `/v1/identities/${encodeURIComponent(this.normalizeAddress(address))}/otp${qs ? "?" + qs : ""}`,
    );
  }

  // Client-side loop chaining long-polls to honor arbitrary --wait durations.
  async otpWait(address: string, opts: { since?: string; waitSeconds: number }): Promise<OtpResult> {
    const deadline = Date.now() + opts.waitSeconds * 1000;
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0) return { found: false, code: null, link: null };
      const res = await this.otpOnce(address, {
        since: opts.since,
        wait: Math.min(remaining, 25),
      });
      if (res.found) return res;
      if (Date.now() >= deadline) return res;
    }
  }
}
