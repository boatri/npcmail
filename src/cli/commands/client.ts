import { ApiClient } from "../api";
import { resolveConfig } from "../config";
import { die } from "../output";

export function requireClient(): ApiClient {
  const cfg = resolveConfig();
  if (!cfg) {
    die(
      `npcmail is not configured. Run:\n` +
        `  npcmail setup --domain yourdomain.com\n` +
        `or set NPCMAIL_URL, NPCMAIL_TOKEN and NPCMAIL_DOMAIN env vars.`,
      2,
    );
  }
  return new ApiClient(cfg);
}

export function fmtAge(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
