import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sleep } from "../shared/constants";
import { SCHEMA_STATEMENTS } from "../shared/schema";
import { CfClient } from "./cf";
import { readConfigFile, writeConfig, type NpcmailConfig } from "./config";
import { promptForToken, verifyTokenScopes } from "./token";
import { step, ok, warn, die, printJson, bold, cyan } from "./output";

export interface SetupFlags {
  domain?: string;
  workerName: string;
  retentionDays: number;
  force: boolean;
  json: boolean;
}

type Zone = Awaited<ReturnType<CfClient["findZone"]>>;

async function resolveCloudflareToken(domain: string, priorCfg: NpcmailConfig | null): Promise<string> {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? priorCfg?.cfToken;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    die(
      "no Cloudflare API token available (CLOUDFLARE_API_TOKEN env, or saved config).\n" +
        "Non-interactive session detected. Get a one-click token-creation URL with:\n" +
        "  npcmail token-url --json\n" +
        "have the user create the token there, then re-run setup with CLOUDFLARE_API_TOKEN set.",
      2,
    );
  }
  return promptForToken(domain);
}

// npcmail takes over ALL email for the domain (catch-all). If the domain
// already receives real email, proceeding would break it — refuse loudly.
async function assertDomainSafeToTakeOver(cf: CfClient, zone: Zone, flags: SetupFlags): Promise<void> {
  step(`preflight: checking the domain is safe to take over`);

  const mx = await cf.listMxRecords(zone.id);
  const foreignMx = mx.filter((r) => !/mx\d*\.cloudflare\.net$/i.test(r.content));
  if (foreignMx.length > 0) {
    const list = foreignMx.map((r) => `  ${r.name} → ${r.content}`).join("\n");
    if (!flags.force) {
      die(
        `${zone.name} already has MX records pointing at another mail provider:\n${list}\n` +
          `Enabling npcmail would REPLACE them and break existing email for this domain.\n` +
          `npcmail is designed for domains that don't receive email. Use a different domain,\n` +
          `or re-run with --force if you are certain this email setup is unused.`,
      );
    }
    warn(`--force: existing MX records will be replaced by Cloudflare Email Routing`);
  }

  // The safety decision must not silently pass when the read fails.
  let catchAll: Awaited<ReturnType<CfClient["getCatchAll"]>> | null = null;
  try {
    catchAll = await cf.getCatchAll(zone.id);
  } catch (e) {
    if (!flags.force) {
      die(
        `could not read the current catch-all rule for ${zone.name} ` +
          `(${e instanceof Error ? e.message : e}).\n` +
          `This check protects an existing email setup from being overwritten. ` +
          `Fix the token/API issue, or re-run with --force to skip the check.`,
      );
    }
    warn(`--force: skipping catch-all safety check (read failed)`);
    return;
  }

  const action = catchAll?.actions?.[0];
  const isOurs = action?.type === "worker" && action.value?.[0] === flags.workerName;
  if (catchAll?.enabled && !isOurs) {
    if (!flags.force) {
      die(
        `${zone.name} already has an enabled catch-all rule ` +
          `(action: ${action?.type ?? "unknown"}${action?.value ? " → " + action.value.join(",") : ""}).\n` +
          `npcmail needs the catch-all. Re-run with --force to replace it, or use another domain.`,
      );
    }
    warn(`--force: existing catch-all rule will be replaced`);
  }
}

async function ensureDatabase(cf: CfClient, accountId: string): Promise<{ uuid: string }> {
  step(`ensuring D1 database ${bold("npcmail")}`);
  const existing = (await cf.listD1(accountId)).find((d) => d.name === "npcmail");
  const db = existing ?? (await cf.createD1(accountId, "npcmail"));
  if (existing) step(`reusing existing D1 database (${db.uuid})`);
  step(`applying schema`);
  for (const stmt of SCHEMA_STATEMENTS) {
    await cf.d1Query(accountId, db.uuid, stmt);
  }
  return db;
}

// Reuse the service token from an existing config for the same domain so
// previously configured clients keep working across re-runs.
function resolveServiceToken(priorCfg: NpcmailConfig | null, domain: string): string {
  return priorCfg && priorCfg.domain === domain && priorCfg.token
    ? priorCfg.token
    : randomBytes(32).toString("hex");
}

function loadWorkerBundle(): string {
  // dist/worker.js ships alongside dist/cli.js in the npm package.
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "worker.js"), "utf8");
}

async function deployWorker(
  cf: CfClient,
  accountId: string,
  domain: string,
  apiToken: string,
  dbId: string,
  flags: SetupFlags,
): Promise<string> {
  step(`deploying worker ${bold(flags.workerName)}`);
  await cf.uploadWorker(accountId, flags.workerName, loadWorkerBundle(), [
    { type: "d1", name: "DB", id: dbId },
    { type: "secret_text", name: "API_TOKEN", text: apiToken },
    { type: "plain_text", name: "DOMAIN", text: domain },
    { type: "plain_text", name: "RETENTION_DAYS", text: String(flags.retentionDays) },
  ]);

  step(`enabling workers.dev URL`);
  const subdomain = await cf.getWorkersSubdomain(accountId, domain.split(".")[0] ?? "npcmail");
  await cf.enableWorkerSubdomain(accountId, flags.workerName);
  return `https://${flags.workerName}.${subdomain}.workers.dev`;
}

async function ensureEmailRouting(cf: CfClient, zone: Zone, workerName: string): Promise<void> {
  const routing = await cf.emailRoutingStatus(zone.id).catch(() => ({ enabled: false }));
  if (!routing.enabled) {
    step(`enabling Email Routing on ${zone.name} (adds MX + SPF records)`);
    await cf.enableEmailRouting(zone.id);
  } else {
    step(`Email Routing already enabled`);
  }
  step(`pointing catch-all at the worker`);
  await cf.setCatchAllToWorker(zone.id, workerName);
}

async function waitForHealth(url: string, apiToken: string): Promise<boolean> {
  step(`verifying deployment (worker may take a few seconds to propagate)`);
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${url}/v1/health`, {
        headers: { authorization: `Bearer ${apiToken}` },
      });
      if (res.ok) return true;
    } catch {
      // propagation in progress
    }
    await sleep(3000);
  }
  return false;
}

export async function cmdSetup(flags: SetupFlags): Promise<void> {
  const domain = flags.domain?.toLowerCase();
  if (!domain) die("--domain is required (a domain on your Cloudflare account, e.g. --domain example.com)", 2);

  const priorCfg = readConfigFile();
  const cfToken = await resolveCloudflareToken(domain, priorCfg);
  const cf = new CfClient(cfToken);
  await verifyTokenScopes(cf, domain);

  step(`looking up zone ${bold(domain)}`);
  const zone = await cf.findZone(domain);

  await assertDomainSafeToTakeOver(cf, zone, flags);
  const db = await ensureDatabase(cf, zone.account.id);
  const apiToken = resolveServiceToken(priorCfg, domain);
  const url = await deployWorker(cf, zone.account.id, domain, apiToken, db.uuid, flags);
  await ensureEmailRouting(cf, zone, flags.workerName);
  const healthy = await waitForHealth(url, apiToken);
  if (!healthy) {
    warn(`worker deployed but ${url}/v1/health did not respond yet; it may need another minute`);
  }

  const cfgPath = writeConfig({
    url,
    token: apiToken,
    domain,
    workerName: flags.workerName,
    accountId: zone.account.id,
    zoneId: zone.id,
    d1Id: db.uuid,
    cfToken,
  });

  ok(`npcmail is live on ${bold(domain)}`);
  ok(`API: ${cyan(url)}`);
  ok(`config written to ${cfgPath} (contains the API token)`);

  if (flags.json) {
    printJson({ ok: true, domain, url, workerName: flags.workerName, d1Id: db.uuid, configPath: cfgPath, healthy });
  } else {
    process.stdout.write(
      `\nTry it:\n` +
        `  npcmail new                     # create an identity\n` +
        `  npcmail otp <address> --wait 60 # wait for a verification code\n`,
    );
  }
}

export interface TeardownFlags {
  deleteData: boolean;
  json: boolean;
  yes: boolean;
}

export async function cmdTeardown(flags: TeardownFlags): Promise<void> {
  const cfg = readConfigFile();
  if (!cfg?.zoneId || !cfg.accountId || !cfg.workerName) {
    die("no npcmail config found (nothing to tear down). Config is created by `npcmail setup`.", 3);
  }
  const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? cfg.cfToken;
  if (!cfToken) die("no Cloudflare API token (CLOUDFLARE_API_TOKEN env or saved config) for teardown", 2);
  if (!flags.yes) {
    die(
      `teardown will disable the ${cfg.domain} catch-all, delete the ${cfg.workerName} worker` +
        (flags.deleteData ? ", and DELETE the D1 database with all stored mail" : " (D1 data is kept; add --delete-data to remove it)") +
        `.\nRe-run with --yes to confirm.`,
      2,
    );
  }

  const cf = new CfClient(cfToken);
  step(`disabling catch-all on ${cfg.domain}`);
  await cf.disableCatchAll(cfg.zoneId).catch((e) => warn(`could not disable catch-all: ${e.message}`));
  step(`deleting worker ${cfg.workerName}`);
  await cf.deleteWorker(cfg.accountId, cfg.workerName).catch((e) => warn(`could not delete worker: ${e.message}`));
  if (flags.deleteData && cfg.d1Id) {
    step(`deleting D1 database`);
    await cf.deleteD1(cfg.accountId, cfg.d1Id).catch((e) => warn(`could not delete D1: ${e.message}`));
  }
  ok(`teardown complete. Email Routing itself was left enabled (harmless); disable it in the dashboard if you want.`);
  if (flags.json) printJson({ ok: true, domain: cfg.domain, dataDeleted: flags.deleteData });
}
