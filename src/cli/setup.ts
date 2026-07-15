import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CfClient } from "./cf";
import { SCHEMA_STATEMENTS } from "../shared/schema";
import { readConfigFile, writeConfig, configPath, type NpcmailConfig } from "./config";
import { step, ok, warn, die, printJson, bold, cyan } from "./output";

export interface SetupFlags {
  domain?: string;
  workerName: string;
  retentionDays: number;
  force: boolean;
  json: boolean;
}

function loadWorkerBundle(): string {
  // dist/worker.js ships alongside dist/cli.js in the npm package.
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "worker.js"), "utf8");
}

export async function cmdSetup(flags: SetupFlags): Promise<void> {
  const domain = flags.domain?.toLowerCase();
  if (!domain) die("--domain is required (a domain on your Cloudflare account, e.g. --domain example.com)", 2);

  const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!cfToken) {
    die(
      "CLOUDFLARE_API_TOKEN env var is required.\n" +
        "Create a token at dash.cloudflare.com → My Profile → API Tokens → Create Custom Token with:\n" +
        "  Account → Workers Scripts → Edit\n" +
        "  Account → D1 → Edit\n" +
        "  Account → Email Routing Addresses → Edit\n" +
        "  Zone → Email Routing Rules → Edit   (your domain)\n" +
        "  Zone → DNS → Edit                   (your domain)\n" +
        "  Zone → Zone → Read                  (your domain)",
      2,
    );
  }

  const cf = new CfClient(cfToken);

  step(`verifying Cloudflare API token`);
  await cf.verifyToken();

  step(`looking up zone ${bold(domain)}`);
  const zone = await cf.findZone(domain);
  const accountId = zone.account.id;

  // ---- safety preflight ----------------------------------------------------
  // npcmail takes over ALL email for the domain (catch-all). If the domain
  // already receives real email, enabling Email Routing would break it.
  step(`preflight: checking the domain is safe to take over`);
  const mx = await cf.listMxRecords(zone.id);
  const foreignMx = mx.filter((r) => !/mx\d*\.cloudflare\.net$/i.test(r.content));
  const routing = await cf.emailRoutingStatus(zone.id).catch(() => ({ enabled: false }));

  if (foreignMx.length > 0) {
    const list = foreignMx.map((r) => `  ${r.name} → ${r.content}`).join("\n");
    if (!flags.force) {
      die(
        `${domain} already has MX records pointing at another mail provider:\n${list}\n` +
          `Enabling npcmail would REPLACE them and break existing email for this domain.\n` +
          `npcmail is designed for domains that don't receive email. Use a different domain,\n` +
          `or re-run with --force if you are certain this email setup is unused.`,
      );
    }
    warn(`--force: existing MX records will be replaced by Cloudflare Email Routing`);
  }

  if (routing.enabled) {
    const catchAll = await cf.getCatchAll(zone.id).catch(() => null);
    const action = catchAll?.actions?.[0];
    const isOurs = action?.type === "worker" && action.value?.[0] === flags.workerName;
    if (catchAll?.enabled && !isOurs && !flags.force) {
      die(
        `${domain} already has Email Routing enabled with a catch-all rule ` +
          `(action: ${action?.type ?? "unknown"}${action?.value ? " → " + action.value.join(",") : ""}).\n` +
          `npcmail needs the catch-all. Re-run with --force to replace it, or use another domain.`,
      );
    }
    if (catchAll?.enabled && !isOurs) warn(`--force: existing catch-all rule will be replaced`);
  }

  // ---- D1 -------------------------------------------------------------------
  step(`ensuring D1 database ${bold("npcmail")}`);
  const existing = (await cf.listD1(accountId)).find((d) => d.name === "npcmail");
  const db = existing ?? (await cf.createD1(accountId, "npcmail"));
  if (existing) step(`reusing existing D1 database (${db.uuid})`);

  step(`applying schema`);
  for (const stmt of SCHEMA_STATEMENTS) {
    await cf.d1Query(accountId, db.uuid, stmt);
  }

  // ---- API token for the service --------------------------------------------
  // Reuse the token from an existing config for the same domain so previously
  // configured clients keep working across re-runs.
  const prior = readConfigFile();
  const apiToken =
    prior && prior.domain === domain && prior.token ? prior.token : randomBytes(32).toString("hex");

  // ---- worker ----------------------------------------------------------------
  step(`deploying worker ${bold(flags.workerName)}`);
  const source = loadWorkerBundle();
  await cf.uploadWorker(accountId, flags.workerName, source, [
    { type: "d1", name: "DB", id: db.uuid },
    { type: "secret_text", name: "API_TOKEN", text: apiToken },
    { type: "plain_text", name: "DOMAIN", text: domain },
    { type: "plain_text", name: "RETENTION_DAYS", text: String(flags.retentionDays) },
  ]);

  step(`enabling workers.dev URL`);
  const subdomain = await cf.getWorkersSubdomain(accountId, domain.split(".")[0] ?? "npcmail");
  await cf.enableWorkerSubdomain(accountId, flags.workerName);
  const url = `https://${flags.workerName}.${subdomain}.workers.dev`;

  // ---- email routing ---------------------------------------------------------
  if (!routing.enabled) {
    step(`enabling Email Routing on ${domain} (adds MX + SPF records)`);
    await cf.enableEmailRouting(zone.id);
  } else {
    step(`Email Routing already enabled`);
  }

  step(`pointing catch-all at the worker`);
  await cf.setCatchAllToWorker(zone.id, flags.workerName);

  // ---- verify ----------------------------------------------------------------
  step(`verifying deployment (worker may take a few seconds to propagate)`);
  let healthy = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${url}/v1/health`, {
        headers: { authorization: `Bearer ${apiToken}` },
      });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // propagation in progress
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!healthy) {
    warn(`worker deployed but ${url}/v1/health did not respond yet; it may need another minute`);
  }

  const cfg: NpcmailConfig = {
    url,
    token: apiToken,
    domain,
    workerName: flags.workerName,
    accountId,
    zoneId: zone.id,
    d1Id: db.uuid,
  };
  const cfgPath = writeConfig(cfg);

  ok(`npcmail is live on ${bold(domain)}`);
  ok(`API: ${cyan(url)}`);
  ok(`config written to ${cfgPath} (contains the API token)`);

  if (flags.json) {
    printJson({
      ok: true,
      domain,
      url,
      workerName: flags.workerName,
      d1Id: db.uuid,
      configPath: cfgPath,
      healthy,
    });
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
  const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!cfToken) die("CLOUDFLARE_API_TOKEN env var is required for teardown", 2);
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
