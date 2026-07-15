// Minimal Cloudflare REST API client for provisioning. No wrangler dependency:
// the CLI ships a prebuilt worker bundle and uploads it directly.
import { CliError } from "./output";

const API = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export class CfClient {
  constructor(private token: string) {}

  private async req<T>(
    method: string,
    path: string,
    opts: { json?: unknown; form?: FormData; okStatuses?: number[] } = {},
  ): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.form,
    });
    const text = await res.text();
    let data: CfEnvelope<T>;
    try {
      data = JSON.parse(text) as CfEnvelope<T>;
    } catch {
      throw new CliError(`Cloudflare API returned non-JSON (${res.status}) for ${method} ${path}: ${text.slice(0, 300)}`);
    }
    if (!data.success && !(opts.okStatuses ?? []).includes(res.status)) {
      const msgs = data.errors?.map((e) => `${e.message} (code ${e.code})`).join("; ") || `HTTP ${res.status}`;
      const hint = permissionHint(data.errors ?? [], method, path);
      throw new CliError(`Cloudflare API error on ${method} ${path}: ${msgs}${hint}`);
    }
    return data.result;
  }

  verifyToken(): Promise<{ status: string }> {
    return this.req("GET", "/user/tokens/verify");
  }

  async findZone(domain: string): Promise<{ id: string; name: string; account: { id: string; name: string } }> {
    const zones = await this.req<Array<{ id: string; name: string; status: string; account: { id: string; name: string } }>>(
      "GET",
      `/zones?name=${encodeURIComponent(domain)}`,
    );
    const zone = zones[0];
    if (!zone) {
      throw new CliError(
        `zone "${domain}" not found on this Cloudflare account. The domain must be added to Cloudflare first ` +
          `(dash.cloudflare.com → Add a domain), and the API token must include this zone in its Zone Resources.`,
      );
    }
    if (zone.status !== "active") {
      throw new CliError(`zone "${domain}" exists but is not active (status: ${zone.status}). Finish nameserver setup first.`);
    }
    return zone;
  }

  listMxRecords(zoneId: string): Promise<Array<{ id: string; type: string; name: string; content: string }>> {
    return this.req("GET", `/zones/${zoneId}/dns_records?type=MX&per_page=100`);
  }

  emailRoutingStatus(zoneId: string): Promise<{ enabled: boolean; status?: string; name?: string }> {
    return this.req("GET", `/zones/${zoneId}/email/routing`);
  }

  async enableEmailRouting(zoneId: string): Promise<void> {
    try {
      await this.req("POST", `/zones/${zoneId}/email/routing/enable`, { json: {} });
      return;
    } catch {
      // Some tokens can edit routing rules + DNS but not the routing settings
      // endpoints. Fall back to creating the records Email Routing needs.
    }
    await this.createEmailRoutingDnsRecords(zoneId);
  }

  // The records Cloudflare provisions when Email Routing is enabled.
  async createEmailRoutingDnsRecords(zoneId: string): Promise<void> {
    const existing = await this.req<Array<{ type: string; content: string; name: string }>>(
      "GET",
      `/zones/${zoneId}/dns_records?per_page=100`,
    );
    const zoneName = (await this.req<{ name: string }>("GET", `/zones/${zoneId}`)).name;
    const wanted: Array<{ type: string; name: string; content: string; priority?: number }> = [
      { type: "MX", name: zoneName, content: "route1.mx.cloudflare.net", priority: 37 },
      { type: "MX", name: zoneName, content: "route2.mx.cloudflare.net", priority: 63 },
      { type: "MX", name: zoneName, content: "route3.mx.cloudflare.net", priority: 91 },
      { type: "TXT", name: zoneName, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' },
    ];
    for (const rec of wanted) {
      const already = existing.some(
        (e) => e.type === rec.type && e.content.replace(/"/g, "") === rec.content.replace(/"/g, ""),
      );
      if (already) continue;
      await this.req("POST", `/zones/${zoneId}/dns_records`, {
        json: { ...rec, ttl: 1, proxied: false },
      });
    }
  }

  getCatchAll(zoneId: string): Promise<{
    enabled: boolean;
    matchers: Array<{ type: string }>;
    actions: Array<{ type: string; value?: string[] }>;
  }> {
    return this.req("GET", `/zones/${zoneId}/email/routing/rules/catch_all`);
  }

  setCatchAllToWorker(zoneId: string, workerName: string): Promise<unknown> {
    return this.req("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      json: {
        name: "npcmail catch-all",
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [workerName] }],
      },
    });
  }

  disableCatchAll(zoneId: string): Promise<unknown> {
    return this.req("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      json: { name: "catch-all", enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
    });
  }

  async listD1(accountId: string): Promise<Array<{ uuid: string; name: string }>> {
    return this.req("GET", `/accounts/${accountId}/d1/database?per_page=100`);
  }

  async createD1(accountId: string, name: string): Promise<{ uuid: string; name: string }> {
    return this.req("POST", `/accounts/${accountId}/d1/database`, { json: { name } });
  }

  deleteD1(accountId: string, dbId: string): Promise<unknown> {
    return this.req("DELETE", `/accounts/${accountId}/d1/database/${dbId}`);
  }

  async d1Query(accountId: string, dbId: string, sql: string): Promise<unknown> {
    return this.req("POST", `/accounts/${accountId}/d1/database/${dbId}/query`, { json: { sql } });
  }

  // Permission probe: distinguishes "denied" from "endpoint says not-found/empty",
  // so scope verification doesn't false-negative on fresh accounts.
  async probeAccess(path: string): Promise<"ok" | "denied"> {
    const res = await fetch(API + path, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 401 || res.status === 403) return "denied";
    const data = (await res.json().catch(() => null)) as CfEnvelope<unknown> | null;
    if (data && !data.success) {
      const authError = (data.errors ?? []).some(
        (e) => e.code === 10000 || e.code === 9109 || /authentication|authorization/i.test(e.message),
      );
      if (authError) return "denied";
    }
    return "ok";
  }

  async workerExists(accountId: string, name: string): Promise<boolean> {
    try {
      await this.req("GET", `/accounts/${accountId}/workers/scripts/${name}/settings`);
      return true;
    } catch {
      return false;
    }
  }

  async uploadWorker(
    accountId: string,
    name: string,
    scriptSource: string,
    bindings: unknown[],
  ): Promise<void> {
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2025-06-01",
      bindings,
    };
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.set(
      "index.js",
      new File([scriptSource], "index.js", { type: "application/javascript+module" }),
    );
    await this.req("PUT", `/accounts/${accountId}/workers/scripts/${name}`, { form });
  }

  deleteWorker(accountId: string, name: string): Promise<unknown> {
    return this.req("DELETE", `/accounts/${accountId}/workers/scripts/${name}?force=true`);
  }

  // Returns the account's workers.dev subdomain, registering one derived from
  // the zone name if the account never used Workers before.
  async getWorkersSubdomain(accountId: string, desired: string): Promise<string> {
    try {
      const res = await this.req<{ subdomain: string }>("GET", `/accounts/${accountId}/workers/subdomain`);
      if (res?.subdomain) return res.subdomain;
    } catch {
      // code 10007: no subdomain yet — register one below
    }
    const base = desired.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "npcmail";
    const candidates = [base, `${base}-mail`, `${base}-${Math.floor(Math.random() * 9000) + 1000}`];
    for (const candidate of candidates) {
      try {
        const res = await this.req<{ subdomain: string }>("PUT", `/accounts/${accountId}/workers/subdomain`, {
          json: { subdomain: candidate },
        });
        return res.subdomain;
      } catch {
        // taken — try the next candidate
      }
    }
    throw new CliError(
      "could not register a workers.dev subdomain automatically. Open dash.cloudflare.com → Workers & Pages once (this claims a subdomain), then re-run setup.",
    );
  }

  async enableWorkerSubdomain(accountId: string, name: string): Promise<void> {
    await this.req("POST", `/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
      json: { enabled: true, previews_enabled: false },
    });
  }
}

function permissionHint(errors: Array<{ code: number; message: string }>, method: string, path: string): string {
  const authError = errors.some((e) => e.code === 10000 || e.code === 9109 || /authentication|authorization|permission/i.test(e.message));
  if (!authError) return "";
  let scope = "";
  if (path.includes("/d1/")) scope = "Account → D1 → Edit";
  else if (path.includes("/workers/")) scope = "Account → Workers Scripts → Edit";
  else if (path.includes("/email/routing")) scope = "Zone → Email Routing Rules → Edit (and Account → Email Routing Addresses → Edit)";
  else if (path.includes("/dns_records")) scope = "Zone → DNS → Edit";
  else if (path.includes("/zones")) scope = "Zone → Zone → Read";
  return scope
    ? `\n  → your API token is likely missing the permission: ${scope}. Edit the token at dash.cloudflare.com → My Profile → API Tokens.`
    : "";
}
