// npcmail — throwaway email identities on your own domain, built for AI agents.
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { CliError, fail, isTty } from "./output";
import { cmdSetup, cmdTeardown } from "./setup";
import { cmdTokenUrl } from "./token";
import { cmdUpdate, maybeNotifyUpdate } from "./update";
import { cmdNew, cmdLs, cmdRm } from "./commands/identities";
import { cmdInbox, cmdRead, cmdOtp } from "./commands/messages";
import { cmdStatus, cmdConfig } from "./commands/service";

declare const NPCMAIL_VERSION: string;
const VERSION = typeof NPCMAIL_VERSION !== "undefined" ? NPCMAIL_VERSION : "dev";

const AGENT_NOTES = `
Notes for agents:
  <address> can be bare ("jane.moreau") — the configured domain is appended.
  otp prints the bare code/link on stdout: CODE=$(npcmail otp jane.moreau --wait 90)
  otp --json always includes the full message — extract manually when "code" is null.
  Exit codes: 0 ok · 1 error · 2 usage · 3 not found · 4 nothing arrived before --wait.
  Any address on the domain receives mail without prior creation (catch-all);
  identities appear automatically on first received message.

Docs: https://github.com/boatri/npcmail
`;

function nonNegativeInt(value: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) throw new InvalidArgumentError("expected a non-negative number");
  return n;
}

type GlobalOpts = { json?: boolean };

function json(cmd: Command): boolean {
  return Boolean((cmd.optsWithGlobals() as GlobalOpts).json);
}

const program = new Command()
  .name("npcmail")
  .description("throwaway email identities on your own domain — NPCs with inboxes, built for AI agents")
  .version(VERSION, "-v, --version", "print the npcmail version")
  .option("--json", "machine-readable JSON output on stdout")
  .addHelpText("after", AGENT_NOTES)
  .configureHelp({ showGlobalOptions: true })
  .exitOverride();

program
  .command("setup")
  .description("provision npcmail on your Cloudflare account (one time; idempotent re-runs upgrade the worker)")
  .argument("[domain]", "domain on your Cloudflare account")
  .option("--domain <domain>", "domain on your Cloudflare account")
  .option("--worker-name <name>", "Cloudflare worker name", "npcmail")
  .option("--retention-days <days>", "days to keep messages (0 = forever)", nonNegativeInt, 30)
  .option("--force", "override the existing-email safety checks")
  .action(async (domainArg: string | undefined, opts, cmd: Command) => {
    await cmdSetup({
      domain: opts.domain ?? domainArg,
      workerName: opts.workerName,
      retentionDays: opts.retentionDays,
      force: Boolean(opts.force),
      json: json(cmd),
    });
  });

program
  .command("teardown")
  .description("remove what setup created (catch-all + worker; --delete-data also drops the D1 database)")
  .option("--delete-data", "also delete the D1 database with all stored mail")
  .option("--yes", "confirm the teardown")
  .action(async (opts, cmd: Command) => {
    await cmdTeardown({ deleteData: Boolean(opts.deleteData), yes: Boolean(opts.yes), json: json(cmd) });
  });

program
  .command("token-url")
  .description("print (or open) the prefilled Cloudflare token-creation URL")
  .option("--open", "open the URL in your browser")
  .action((opts, cmd: Command) => {
    cmdTokenUrl({ json: json(cmd), open: Boolean(opts.open) });
  });

program
  .command("new")
  .description("create an identity with a random human name (jane.moreau@yourdomain.com)")
  .option("--first <name>", "use this first name")
  .option("--last <name>", "use this last name")
  .option("--label <text>", "attach a label (what this identity is for)")
  .action(async (opts, cmd: Command) => {
    await cmdNew({ first: opts.first, last: opts.last, label: opts.label, json: json(cmd) });
  });

program
  .command("ls")
  .alias("list")
  .description("list identities")
  .option("--limit <n>", "maximum identities to list", nonNegativeInt)
  .action(async (opts, cmd: Command) => {
    await cmdLs({ json: json(cmd), limit: opts.limit });
  });

program
  .command("rm")
  .alias("delete")
  .description("delete an identity and all its messages")
  .argument("<address>", "identity address (bare local part works)")
  .action(async (address: string, _opts, cmd: Command) => {
    await cmdRm(address, { json: json(cmd) });
  });

program
  .command("inbox")
  .alias("emails")
  .description("list an identity's messages")
  .argument("<address>", "identity address (bare local part works)")
  .option("--wait <seconds>", "wait up to N seconds for a message to arrive", nonNegativeInt)
  .option("--since <iso>", "only messages received after this ISO timestamp")
  .option("--limit <n>", "maximum messages to list", nonNegativeInt)
  .action(async (address: string, opts, cmd: Command) => {
    await cmdInbox(address, { json: json(cmd), since: opts.since, limit: opts.limit, wait: opts.wait });
  });

program
  .command("read")
  .description("show a full message (latest for an address, or by message id)")
  .argument("<target>", "address or message id")
  .action(async (target: string, _opts, cmd: Command) => {
    await cmdRead(target, { json: json(cmd) });
  });

program
  .command("otp")
  .alias("code")
  .description("extract the latest verification code or link (bare value on stdout)")
  .argument("<address>", "identity address (bare local part works)")
  .option("--wait <seconds>", "wait up to N seconds for a code to arrive", nonNegativeInt)
  .option("--since <iso>", "only messages received after this ISO timestamp (default with --wait: 2 minutes ago)")
  .action(async (address: string, opts, cmd: Command) => {
    await cmdOtp(address, { json: json(cmd), since: opts.since, wait: opts.wait });
  });

program
  .command("status")
  .description("service health and counts")
  .action(async (_opts, cmd: Command) => {
    await cmdStatus({ json: json(cmd) });
  });

program
  .command("config")
  .description("show the current configuration")
  .action((_opts, cmd: Command) => {
    cmdConfig({ json: json(cmd) });
  });

program
  .command("update")
  .description("update the CLI to the latest version")
  .action(async (_opts, cmd: Command) => {
    await cmdUpdate(VERSION, { json: json(cmd) });
  });

// No command → help, exit 2 (usage).
program.action(() => {
  program.outputHelp();
  process.exitCode = 2;
});

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } finally {
    const cmdName = program.args[0];
    const jsonMode = process.argv.includes("--json");
    await maybeNotifyUpdate(VERSION, cmdName, jsonMode);
  }
}

// Invoked by src/cli/main.ts (the build entrypoint); importing this module
// never executes a command.
export function run(): void {
  main().catch((e: unknown) => {
    if (e instanceof CommanderError) {
      // help/version are success; everything else commander reports is usage
      process.exitCode = e.code === "commander.helpDisplayed" || e.code === "commander.version" ? 0 : 2;
    } else if (e instanceof CliError) {
      fail(e.message);
      process.exitCode = e.exitCode;
    } else {
      fail(e instanceof Error ? (isTty ? e.stack ?? e.message : e.message) : String(e));
      process.exitCode = 1;
    }
  });
}
