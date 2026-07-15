// OAuth-like token acquisition. Cloudflare has no third-party OAuth for its
// API, but the dashboard accepts "token template" URLs that prefill the whole
// custom-token form. Flow: open the URL → user clicks Continue → Create Token
// → pastes it back. One approval, stored in config, forgotten.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CfClient } from "./cf";
import { step, ok, warn, printJson, bold, cyan, die } from "./output";

// Minimal scopes npcmail actually needs (the Email Routing *settings*
// endpoints are not required — setup creates the MX/SPF records via DNS).
const PERMISSIONS = [
  { key: "workers_scripts", type: "edit" }, // deploy the worker
  { key: "d1", type: "edit" }, // create + migrate the database
  { key: "dns", type: "edit" }, // add Email Routing MX/SPF records
  { key: "email_routing_rule", type: "edit" }, // set the catch-all rule
  { key: "zone", type: "read" }, // resolve the domain to a zone
] as const;

export function tokenTemplateUrl(name = "npcmail"): string {
  const perms = encodeURIComponent(JSON.stringify(PERMISSIONS));
  return (
    `https://dash.cloudflare.com/profile/api-tokens` +
    `?permissionGroupKeys=${perms}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`
  );
}

export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // printing the URL is the fallback either way
  }
}

export function cmdTokenUrl(flags: { json: boolean; open: boolean }): void {
  const url = tokenTemplateUrl();
  if (flags.open) openInBrowser(url);
  if (flags.json) {
    printJson({
      url,
      instructions:
        "Open this URL (Cloudflare dashboard). The custom-token form is prefilled with the " +
        "5 permissions npcmail needs. Optionally restrict Zone Resources to your domain. " +
        "Click 'Continue to summary' → 'Create Token', then provide the token to npcmail " +
        "via CLOUDFLARE_API_TOKEN or `npcmail setup --domain <d>` interactive prompt.",
      permissions: PERMISSIONS,
    });
    return;
  }
  process.stdout.write(
    `${bold("Create the npcmail Cloudflare token (one time):")}\n\n` +
      `  1. Open:  ${cyan(url)}\n` +
      `     (form arrives prefilled with the 5 permissions npcmail needs)\n` +
      `  2. Optional: under "Zone Resources", restrict to your domain\n` +
      `  3. Continue to summary → Create Token → copy it\n` +
      `  4. Run:   npcmail setup --domain <yourdomain.com>  (it will prompt for the token)\n`,
  );
}

export async function promptForToken(domain: string): Promise<string> {
  const url = tokenTemplateUrl();
  step(`no CLOUDFLARE_API_TOKEN found — starting one-time browser flow`);
  process.stderr.write(
    `\n  Opening the Cloudflare dashboard with a prefilled token form.\n` +
      `  Review it (optionally restrict Zone Resources to ${bold(domain)}),\n` +
      `  then ${bold("Continue to summary → Create Token")} and paste the token below.\n\n` +
      `  URL (in case the browser didn't open):\n  ${cyan(url)}\n\n`,
  );
  openInBrowser(url);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const token = await new Promise<string>((resolve) => {
    rl.question("Paste API token: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
  if (!token) die("no token provided", 2);
  return token;
}

// Probe the token against every API surface setup needs, so a wrong
// permission is caught here with a precise message — not mid-provisioning.
export async function verifyTokenScopes(cf: CfClient, domain: string): Promise<void> {
  step(`verifying token permissions`);
  await cf.verifyToken();
  const zone = await cf.findZone(domain); // zone:read
  const probes: Array<[string, string]> = [
    ["Zone → DNS", `/zones/${zone.id}/dns_records?per_page=1`],
    ["Zone → Email Routing Rules", `/zones/${zone.id}/email/routing/rules`],
    ["Account → D1", `/accounts/${zone.account.id}/d1/database?per_page=1`],
    ["Account → Workers Scripts", `/accounts/${zone.account.id}/workers/scripts?per_page=1`],
  ];
  const missing: string[] = [];
  for (const [label, path] of probes) {
    if ((await cf.probeAccess(path)) === "denied") missing.push(label);
  }
  if (missing.length > 0) {
    die(
      `the token is missing permissions: ${missing.join(", ")}.\n` +
        `Create a correct one with: npcmail token-url`,
    );
  }
  ok(`token verified — all required permissions present`);
}
