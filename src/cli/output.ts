// Output contract: stable JSON (or bare values) on stdout for agents,
// colors/progress on stderr for humans.
export const isTty = process.stdout.isTTY === true;
const useColor = isTty && !process.env.NO_COLOR;

const wrap = (open: number, close: number) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

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

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cellWidth(cell));
    });
  }
  const lines = all.map((row, rowIdx) => {
    const line = row
      .map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - cellWidth(cell)))
      .join("  ")
      .trimEnd();
    return header && rowIdx === 0 ? bold(line) : line;
  });
  return lines.join("\n");
}

// Width ignoring ANSI escapes.
function cellWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
