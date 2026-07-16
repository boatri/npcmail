import { die, printJson, table, cyan, dim, yellow, isTty } from "../output";
import { requireClient, fmtAge } from "./client";
import { provisionRule, deprovisionRule } from "./rules";

export async function cmdNew(flags: { first?: string; last?: string; label?: string; json: boolean }): Promise<void> {
  const client = requireClient();
  const identity = await client.createIdentity(flags);
  // Strict mode: create the routing rule before returning the address, so it
  // receives mail (and passes RCPT probes) the moment the caller uses it.
  const strict = await provisionRule(identity.address);
  if (flags.json) {
    printJson({ ...identity, ...(strict ? { propagationSeconds: 120 } : {}) });
    return;
  }
  process.stdout.write(identity.address + "\n");
  if (isTty) {
    process.stderr.write(
      dim(`identity created — ${identity.firstName} ${identity.lastName}`) +
        (identity.label ? dim(` (${identity.label})`) : "") +
        "\n",
    );
    if (strict) {
      process.stderr.write(
        yellow("! ") + dim("strict mode: allow ~1-2 min for the routing rule to propagate before first use\n"),
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
  process.stdout.write(table(rows, ["ADDRESS", "LABEL", "STATE", "MSGS", "LAST MAIL", "AGE"]) + "\n");
}

export async function cmdRm(address: string | undefined, flags: { json: boolean }): Promise<void> {
  if (!address) die("usage: npcmail rm <address>", 2);
  const client = requireClient();
  const res = await client.deleteIdentity(address);
  await deprovisionRule(res.deleted); // strict mode: free the rule slot
  if (flags.json) printJson(res);
  else process.stdout.write(`deleted ${res.deleted}\n`);
}
