// Strict-mode routing-rule management for identity create/delete. No-ops in
// catch-all mode. Needs the Cloudflare token + zone id from config, so these
// run in the CLI (the worker only ever holds a D1 binding, never a CF token).
import { CfClient } from "../cf";
import { resolveConfig } from "../config";
import { CliError, warn } from "../output";

const RULE_CAP = 200; // Cloudflare's per-zone Email Routing rule limit

function strictClient(): { cf: CfClient; zoneId: string; workerName: string } | null {
  const cfg = resolveConfig();
  if (cfg?.mode !== "strict") return null;
  const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? cfg.cfToken;
  if (!cfToken || !cfg.zoneId) {
    throw new CliError(
      "strict mode needs the Cloudflare token and zone id from config to manage routing rules.\n" +
        "Re-run `npcmail setup --domain <domain> --strict`, or set CLOUDFLARE_API_TOKEN.",
      2,
    );
  }
  return { cf: new CfClient(cfToken), zoneId: cfg.zoneId, workerName: cfg.workerName ?? "npcmail" };
}

// Create the address's routing rule BEFORE the address is handed out, so a
// verifier probing it sees a real mailbox (not a 550). Returns true if a rule
// was provisioned (strict mode), false in catch-all mode.
export async function provisionRule(address: string): Promise<boolean> {
  const s = strictClient();
  if (!s) return false;
  const rules = await s.cf.listAddressRules(s.zoneId);
  if (rules.some((r) => r.matchers.some((m) => m.value?.toLowerCase() === address.toLowerCase()))) return true;
  if (rules.length >= RULE_CAP) {
    throw new CliError(
      `this domain is at Cloudflare's ${RULE_CAP}-rule limit for strict mode.\n` +
        `Delete unused identities (npcmail rm <addr>) to free slots, or set up a second domain.`,
    );
  }
  if (rules.length >= RULE_CAP - 20) {
    warn(`approaching the ${RULE_CAP}-rule limit (${rules.length + 1}/${RULE_CAP}) — rm unused identities to free slots`);
  }
  await s.cf.createAddressRule(s.zoneId, address, s.workerName);
  return true;
}

// Free the rule slot when an identity is deleted. Best-effort: a failed rule
// delete shouldn't fail the whole `rm` (the identity is already gone).
export async function deprovisionRule(address: string): Promise<void> {
  const s = strictClient();
  if (!s) return;
  try {
    await s.cf.deleteAddressRule(s.zoneId, address);
  } catch (e) {
    warn(`identity deleted, but could not remove its routing rule: ${e instanceof Error ? e.message : e}`);
  }
}
