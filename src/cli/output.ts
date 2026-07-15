// Output contract: stable JSON (or bare values) on stdout for agents,
// colors/progress on stderr for humans.
import pc from "picocolors";
import Table from "cli-table3";

export const isTty = process.stdout.isTTY === true;

export const bold = pc.bold;
export const dim = pc.dim;
export const red = pc.red;
export const green = pc.green;
export const yellow = pc.yellow;
export const cyan = pc.cyan;

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function step(msg: string): void {
  process.stderr.write(dim("• ") + msg + "\n");
}

export function ok(msg: string): void {
  process.stderr.write(green("✓ ") + msg + "\n");
}

export function warn(msg: string): void {
  process.stderr.write(yellow("! ") + msg + "\n");
}

export function fail(msg: string): void {
  process.stderr.write(red("✗ ") + msg + "\n");
}

export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function die(message: string, exitCode = 1): never {
  throw new CliError(message, exitCode);
}

export function table(rows: string[][], header: string[]): string {
  const t = new Table({
    head: header.map((h) => (isTty ? pc.bold(pc.white(h)) : h)),
    style: { head: [], border: isTty ? ["dim"] : [] },
    wordWrap: true,
  });
  t.push(...rows);
  return t.toString();
}
