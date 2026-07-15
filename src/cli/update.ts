// Update check ("check now, notify next run" — the Vercel/update-notifier
// architecture) and self-update. The check never blocks a command: it reads
// the cache from a previous run for the notice, and refreshes the cache in
// the background at most once per day.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { die, printJson, dim, bold, ok, step } from "./output";

const REGISTRY_DIST_TAGS = "https://registry.npmjs.org/-/package/npcmail/dist-tags";
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  lastCheck: number;
  latest: string;
}

function cacheFile(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "npcmail", "update-check.json");
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(cache));
  } catch {
    // read-only home directories are survivable — just no notice
  }
}

function newerThan(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_DIST_TAGS, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const tags = (await res.json()) as { latest?: string };
    return tags.latest ?? null;
  } catch {
    return null;
  }
}

function suppressed(json: boolean): boolean {
  return (
    json ||
    Boolean(process.env.NPCMAIL_NO_UPDATE_CHECK) ||
    Boolean(process.env.NO_UPDATE_NOTIFIER) ||
    Boolean(process.env.CI) ||
    process.env.NODE_ENV === "test" ||
    process.stderr.isTTY !== true
  );
}

// Called at the end of every command. Prints the notice from the previous
// run's cache, then refreshes the cache if stale — without delaying exit by
// more than the time an already-resolved fetch takes.
export function maybeNotifyUpdate(currentVersion: string, command: string | undefined, json: boolean): Promise<void> {
  if (suppressed(json) || command === "update" || currentVersion === "dev") return Promise.resolve();

  const cache = readCache();
  if (cache && newerThan(cache.latest, currentVersion)) {
    process.stderr.write(
      dim(`\nnpcmail ${currentVersion} → ${cache.latest} available\n`) + dim(`run: npcmail update\n`),
    );
  }

  if (!cache || Date.now() - cache.lastCheck > CHECK_TTL_MS) {
    return fetchLatest().then((latest) => {
      if (latest) writeCache({ lastCheck: Date.now(), latest });
    });
  }
  return Promise.resolve();
}

type InstallMethod = "bun" | "pnpm" | "yarn" | "npx" | "npm";

// The package manager owns the installed files — never self-replace, shell
// out to the right one. Detection walks the resolved (symlink-free) path of
// the running entrypoint.
function detectInstallMethod(): InstallMethod {
  let real = process.argv[1] ?? "";
  try {
    real = realpathSync(real);
  } catch {
    // fall through with the raw path
  }
  if (real.includes("/_npx/") || real.includes(join(".bun", "install", "cache"))) return "npx";
  if (real.includes(join(".bun", "install", "global"))) return "bun";
  if ((process.env.PNPM_HOME && real.startsWith(process.env.PNPM_HOME)) || real.includes("/pnpm/")) return "pnpm";
  if (real.includes("/.yarn/") || real.includes(join(".config", "yarn", "global"))) return "yarn";
  return "npm";
}

const UPDATE_COMMANDS: Record<Exclude<InstallMethod, "npx">, [string, string[]]> = {
  bun: ["bun", ["add", "-g", "npcmail@latest"]],
  pnpm: ["pnpm", ["add", "-g", "npcmail@latest"]],
  yarn: ["yarn", ["global", "add", "npcmail@latest"]],
  npm: ["npm", ["install", "-g", "npcmail@latest"]],
};

export async function cmdUpdate(currentVersion: string, flags: { json: boolean }): Promise<void> {
  const method = detectInstallMethod();
  if (method === "npx") {
    if (flags.json) printJson({ method, updated: false, note: "ephemeral npx run — npx npcmail@latest always fetches the latest" });
    else process.stdout.write("you're running via npx — there's nothing to update.\nnpx npcmail@latest always gets the latest version.\n");
    return;
  }

  const latest = await fetchLatest();
  if (latest && !newerThan(latest, currentVersion)) {
    if (flags.json) printJson({ method, from: currentVersion, to: latest, updated: false, note: "already up to date" });
    else ok(`already up to date (${currentVersion})`);
    return;
  }

  const [cmd, args] = UPDATE_COMMANDS[method];
  step(`updating via ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: flags.json ? "pipe" : "inherit" });
  if (res.status !== 0) {
    die(
      `update failed (exit ${res.status ?? "?"}). Run it yourself:\n  ${cmd} ${args.join(" ")}`,
    );
  }
  writeCache({ lastCheck: Date.now(), latest: latest ?? currentVersion });

  if (flags.json) {
    printJson({ method, from: currentVersion, to: latest ?? "latest", updated: true });
  } else {
    ok(`updated ${currentVersion} → ${latest ?? "latest"}`);
    process.stdout.write(
      `${bold("note:")} the worker on your domain updates separately — run:\n` +
        `  npcmail setup --domain <yourdomain>   # re-deploys the worker from the new version\n`,
    );
  }
}
