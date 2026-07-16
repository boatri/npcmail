import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type NpcmailMode = "catch-all" | "strict";

export interface NpcmailConfig {
  url: string;
  token: string;
  domain: string;
  workerName?: string;
  accountId?: string;
  zoneId?: string;
  d1Id?: string;
  /**
   * "catch-all" (default): any address receives; identities are lazy.
   * "strict": only provisioned addresses receive; unknown recipients are
   * rejected at SMTP (550) so the domain doesn't look accept-all to verifiers.
   */
  mode?: NpcmailMode;
  /** Cloudflare API token saved by setup so teardown/upgrades don't re-ask */
  cfToken?: string;
}

export function configDir(): string {
  return process.env.NPCMAIL_CONFIG_DIR ?? join(homedir(), ".config", "npcmail");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfigFile(): NpcmailConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as NpcmailConfig;
  } catch {
    return null;
  }
}

// Env vars override the config file so agents can run stateless.
export function resolveConfig(): NpcmailConfig | null {
  const file = readConfigFile();
  const url = process.env.NPCMAIL_URL ?? file?.url;
  const token = process.env.NPCMAIL_TOKEN ?? file?.token;
  const domain = process.env.NPCMAIL_DOMAIN ?? file?.domain;
  if (!url || !token || !domain) return null;
  return { ...file, url, token, domain };
}

export function writeConfig(cfg: NpcmailConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const p = configPath();
  // mode on write, not chmod-after: no world-readable window for the tokens
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(p, 0o600); // in case the file already existed with wider perms
  return p;
}
