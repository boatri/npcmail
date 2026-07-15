import { convert } from "html-to-text";
import { sleep } from "../../shared/constants";
import type { MessageFull, MessageSummary } from "../../shared/types";
import { die, printJson, table, bold, cyan, dim, green, isTty } from "../output";
import { requireClient, fmtAge } from "./client";

// Purpose-built email HTML → terminal text (tables, links, wrapping).
function renderHtml(html: string): string {
  return convert(html, {
    wordwrap: 100,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim();
}

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
    await sleep(3000);
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
  // UUID prefix (8 hex + hyphen + 4 hex); generated local parts are
  // firstname.lastname so a bare address can never match this shape.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(target)) {
    msg = await client.getMessage(target);
  } else {
    const res = await client.listMessages(target, { limit: 1, full: true });
    const first = res.messages[0];
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
      `\n${msg.textBody?.trim() || (msg.htmlBody ? renderHtml(msg.htmlBody) : dim("(empty body)"))}\n`,
  );
}

export async function cmdOtp(
  address: string | undefined,
  flags: { json: boolean; since?: string; wait?: number },
): Promise<void> {
  if (!address) die("usage: npcmail otp <address> [--wait N] [--since ISO]", 2);
  const client = requireClient();

  // Waiting without --since means "the code I'm expecting now", not one from
  // last week: default the window to shortly before this invocation so a
  // stale message can't satisfy the wait instantly.
  let since = flags.since;
  if (flags.wait && !since) {
    since = new Date(Date.now() - 120_000).toISOString();
  }

  const res = flags.wait
    ? await client.otpWait(address, { since, waitSeconds: flags.wait })
    : await client.otpOnce(address, { since });

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
