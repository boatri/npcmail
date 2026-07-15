import { resolveConfig, configPath } from "../config";
import { die, printJson, bold, cyan, dim, green } from "../output";
import { requireClient } from "./client";

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
    // The Cloudflare account token is far more powerful than the service
    // token and agents routinely log JSON output — never emit it.
    const { cfToken, ...rest } = cfg;
    printJson({ ...rest, cfTokenSaved: Boolean(cfToken), configPath: configPath() });
    return;
  }
  process.stdout.write(
    `config: ${configPath()}\n` +
      `domain: ${cfg.domain}\nurl:    ${cfg.url}\ntoken:  ${cfg.token.slice(0, 8)}…${dim(" (full value in config file)")}\n`,
  );
}
