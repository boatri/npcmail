import { ApiClient } from "./api";
import { resolveConfig, configPath } from "./config";
import { die, printJson, table, bold, dim, green, yellow, cyan, isTty } from "./output";
import type { MessageFull, MessageSummary } from "../shared/types";

export function requireClient(): ApiClient {
  const cfg = resolveConfig();
  if (!cfg) {
    die(
      `npcmail is not configured. Run:\n` +
        `  CLOUDFLARE_API_TOKEN=... npcmail setup --domain yourdomain.com\n` +
        `or set NPCMAIL_URL, NPCMAIL_TOKEN and NPCMAIL_DOMAIN env vars.`,
      2,
    );
  }
  return new ApiClient(cfg);
}

function fmtAge(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---- identities -------------------------------------------------------------

export async function cmdNew(flags: { first?: string; last?: string; label?: string; json: boolean }): Promise<void> {
  const client = requireClient();
  const identity = await client.createIdentity(flags);
  if (flags.json) {
    printJson(identity);
  } else {
    process.stdout.write(identity.address + "\n");
    if (isTty) {
      process.stderr.write(
        dim(`identity created — ${identity.firstName} ${identity.lastName}`) +
          (identity.label ? dim(` (${identity.label})`) : "") +
          "\n",
      );
    }
  }
}

export async function cmdLs(flags: { json: boolean; limit?: number }): Promise<void> {
  const client = requireClient();
  const { identities } = await client.listIdentities(flags.limit ?? 100);
  if (flags.json) {
    printJson({ identities });
    return;
  }
  if (identities.length === 0) {
    process.stdout.write(dim("no identities yet — create one with: npcmail new\n"));
    return;
  }
  const rows = identities.map((i) => [
    cyan(i.address),
    i.label ?? "",
    i.registered ? "" : yellow("implicit"),
    String(i.messageCount ?? 0),
    fmtAge(i.lastMessageAt),
    fmtAge(i.createdAt).replace(" ago", ""),
  ]);
  process.stdout.write(table(rows, ["ADDRESS", "LABEL", "", "MSGS", "LAST MAIL", "AGE"]) + "\n");
}

export async function cmdRm(address: string | undefined, flags: { json: boolean }): Promise<void> {
  if (!address) die("usage: npcmail rm <address>", 2);
  const client = requireClient();
  const res = await client.deleteIdentity(address);
  if (flags.json) printJson(res);
  else process.stdout.write(`deleted ${res.deleted}\n`);
}

// ---- messages ---------------------------------------------------------------

export async function cmdInbox(
  address: string | undefined,
  flags: { json: boolean; since?: string; limit?: number; wait?: number },
): Promise<void> {
  if (!address) die("usage: npcmail inbox <address> [--wait N] [--since ISO] [--limit N]", 2);
  const client = requireClient();

  let messages: MessageSummary[] = [];
  const deadline = Date.now() + (flags.wait ?? 0) * 1000;
  for (;;) {
    const res = await client.listMessages(address, { since: flags.since, limit: flags.limit });
    messages = res.messages;
    if (messages.length > 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (flags.json) {
    printJson({ address: client.normalizeAddress(address), messages });
    return;
  }
  if (messages.length === 0) {
    process.stdout.write(dim("inbox empty\n"));
    process.exitCode = flags.wait ? 4 : 0;
    return;
  }
  const rows = messages.map((m) => [
    dim(m.id.slice(0, 8)),
    m.from ?? "-",
    (m.subject ?? "(no subject)").slice(0, 60),
    m.otpCode ? green(m.otpCode) : m.otpLink ? green("link") : "",
    fmtAge(m.receivedAt),
  ]);
  process.stdout.write(table(rows, ["ID", "FROM", "SUBJECT", "OTP", "WHEN"]) + "\n");
}

export async function cmdRead(target: string | undefined, flags: { json: boolean }): Promise<void> {
  if (!target) die("usage: npcmail read <address | message-id>", 2);
  const client = requireClient();

  let msg: MessageFull;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(target)) {
    msg = await client.getMessage(target);
  } else {
    const res = await client.listMessages(target, { limit: 1, full: true });
    const first = res.messages[0] as MessageFull | undefined;
    if (!first) die(`no messages for ${client.normalizeAddress(target)}`, 3);
    msg = first;
  }

  if (flags.json) {
    printJson(msg);
    return;
  }
  process.stdout.write(
    `${bold("From:")}    ${msg.fromName ? `${msg.fromName} <${msg.from}>` : msg.from}\n` +
      `${bold("To:")}      ${msg.to ?? msg.address}\n` +
      `${bold("Date:")}    ${msg.receivedAt}\n` +
      `${bold("Subject:")} ${msg.subject ?? "(no subject)"}\n` +
      (msg.otpCode ? `${bold("Code:")}    ${green(msg.otpCode)}\n` : "") +
      (msg.otpLink ? `${bold("Link:")}    ${cyan(msg.otpLink)}\n` : "") +
      `\n${msg.textBody?.trim() || msg.textFromHtml || dim("(empty body)")}\n`,
  );
}

export async function cmdOtp(
  address: string | undefined,
  flags: { json: boolean; since?: string; wait?: number },
): Promise<void> {
  if (!address) die("usage: npcmail otp <address> [--wait N] [--since ISO]", 2);
  const client = requireClient();
  const res = flags.wait
    ? await client.otpWait(address, { since: flags.since, waitSeconds: flags.wait })
    : await client.otpOnce(address, { since: flags.since });

  if (flags.json) {
    printJson(res);
    if (!res.found) process.exitCode = 4;
    return;
  }
  if (!res.found) {
    die(`no message arrived for ${client.normalizeAddress(address)}${flags.wait ? ` after ${flags.wait}s` : ""}`, 4);
  }
  if (!res.code && !res.link) {
    // A message DID arrive — the heuristics just couldn't spot a code in it.
    // Point the caller at the content instead of pretending nothing happened.
    die(
      `message ${res.messageId} arrived ("${res.subject ?? "no subject"}" from ${res.from ?? "?"}) ` +
        `but no code/link was auto-detected.\nRead it and extract manually:\n` +
        `  npcmail read ${res.messageId}   (or re-run with --json for the full message)`,
      4,
    );
  }
  // Bare value on stdout so agents/scripts can do CODE=$(npcmail otp jane.doe --wait 60)
  process.stdout.write((res.code ?? res.link ?? "") + "\n");
  if (isTty) {
    process.stderr.write(
      dim(`from ${res.from ?? "?"} — "${res.subject ?? ""}" at ${res.receivedAt}`) +
        (res.code && res.link ? dim(`\nlink: ${res.link}`) : "") +
        "\n",
    );
  }
}

// ---- status / config ----------------------------------------------------------

export async function cmdStatus(flags: { json: boolean }): Promise<void> {
  const client = requireClient();
  const health = await client.health();
  if (flags.json) {
    printJson(health);
    return;
  }
  process.stdout.write(
    `${green("●")} ${bold("npcmail")} v${health.version} on ${cyan(health.domain)}\n` +
      `  identities: ${health.identities}\n` +
      `  messages:   ${health.messages}\n`,
  );
}

export function cmdConfig(flags: { json: boolean }): void {
  const cfg = resolveConfig();
  if (!cfg) die(`no config found (looked at ${configPath()} and NPCMAIL_* env vars)`, 3);
  if (flags.json) {
    printJson({ ...cfg, configPath: configPath() });
    return;
  }
  process.stdout.write(
    `config: ${configPath()}\n` +
      `domain: ${cfg.domain}\nurl:    ${cfg.url}\ntoken:  ${cfg.token.slice(0, 8)}…${dim(" (full value in config file)")}\n`,
  );
}
