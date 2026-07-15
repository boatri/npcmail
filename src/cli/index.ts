#!/usr/bin/env node
// npcmail — throwaway email identities on your own domain, built for AI agents.
import { CliError, fail, isTty } from "./output";
import { cmdSetup, cmdTeardown } from "./setup";
import { cmdTokenUrl } from "./token";
import { cmdNew, cmdLs, cmdRm, cmdInbox, cmdRead, cmdOtp, cmdStatus, cmdConfig } from "./commands";

declare const NPCMAIL_VERSION: string;
const VERSION = typeof NPCMAIL_VERSION !== "undefined" ? NPCMAIL_VERSION : "dev";

const HELP = `npcmail v${VERSION} — throwaway email identities on your own domain

USAGE
  npcmail <command> [args] [flags]

SETUP (one-time)
  setup --domain <domain>     provision everything on your Cloudflare account
        [--worker-name npcmail] [--retention-days 30] [--force]
        (no CLOUDFLARE_API_TOKEN? setup opens a prefilled token-creation
         page in your browser and prompts for the result — one approval)
  token-url [--open]          print/open the prefilled Cloudflare token URL
  teardown [--delete-data] --yes   remove what setup created

IDENTITIES
  new  [--first x --last y] [--label text]   create identity (random human name)
  ls   [--limit N]                           list identities
  rm   <address>                             delete identity + its messages

MAIL
  inbox <address> [--wait N] [--since ISO] [--limit N]   list messages
  read  <address | message-id>                           show full message
  otp   <address> [--wait N] [--since ISO]               extract verification code/link

SERVICE
  status                       service health + counts
  config                       show current configuration

FLAGS
  --json      machine-readable output on stdout (works on every command)
  --help      this help
  --version   version

NOTES FOR AGENTS
  · <address> can be bare ("jane.moreau") — the configured domain is appended.
  · otp prints the bare code/link on stdout: CODE=$(npcmail otp jane.moreau --wait 90)
  · exit codes: 0 ok · 1 error · 2 usage · 3 not found · 4 nothing arrived before --wait
  · any address on the domain receives mail without prior creation (catch-all);
    identities appear automatically on first received message.
`;

interface Parsed {
  cmd: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

// Flags that never take a value — the token after them stays positional.
const BOOLEAN_FLAGS = new Set(["json", "help", "version", "force", "yes", "delete-data", "open"]);

function parseArgv(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd: positional[0], positional: positional.slice(1), flags };
}

function flagStr(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagNum(p: Parsed, name: string): number | undefined {
  const v = flagStr(p, name);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new CliError(`--${name} expects a number, got "${v}"`, 2);
  return n;
}

function flagBool(p: Parsed, name: string): boolean {
  return p.flags.has(name);
}

async function main(): Promise<void> {
  const p = parseArgv(process.argv.slice(2));
  const json = flagBool(p, "json");

  if (flagBool(p, "version")) {
    process.stdout.write(VERSION + "\n");
    return;
  }
  if (!p.cmd || flagBool(p, "help") || p.cmd === "help") {
    process.stdout.write(HELP);
    if (!p.cmd) process.exitCode = 2;
    return;
  }

  switch (p.cmd) {
    case "setup":
      await cmdSetup({
        domain: flagStr(p, "domain") ?? p.positional[0],
        workerName: flagStr(p, "worker-name") ?? "npcmail",
        retentionDays: flagNum(p, "retention-days") ?? 30,
        force: flagBool(p, "force"),
        json,
      });
      break;
    case "teardown":
      await cmdTeardown({ deleteData: flagBool(p, "delete-data"), yes: flagBool(p, "yes"), json });
      break;
    case "token-url":
      cmdTokenUrl({ json, open: flagBool(p, "open") });
      break;
    case "new":
      await cmdNew({ first: flagStr(p, "first"), last: flagStr(p, "last"), label: flagStr(p, "label"), json });
      break;
    case "ls":
    case "list":
      await cmdLs({ json, limit: flagNum(p, "limit") });
      break;
    case "rm":
    case "delete":
      await cmdRm(p.positional[0], { json });
      break;
    case "inbox":
    case "emails":
      await cmdInbox(p.positional[0], {
        json,
        since: flagStr(p, "since"),
        limit: flagNum(p, "limit"),
        wait: flagNum(p, "wait"),
      });
      break;
    case "read":
      await cmdRead(p.positional[0], { json });
      break;
    case "otp":
    case "code":
      await cmdOtp(p.positional[0], { json, since: flagStr(p, "since"), wait: flagNum(p, "wait") });
      break;
    case "status":
      await cmdStatus({ json });
      break;
    case "config":
      cmdConfig({ json });
      break;
    default:
      fail(`unknown command: ${p.cmd}`);
      process.stderr.write(HELP);
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  if (e instanceof CliError) {
    fail(e.message);
    process.exitCode = e.exitCode;
  } else {
    fail(e instanceof Error ? (isTty ? e.stack ?? e.message : e.message) : String(e));
    process.exitCode = 1;
  }
});
