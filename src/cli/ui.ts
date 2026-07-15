// Presentation facade for the provisioning flows (setup/teardown/token).
// Pretty mode renders the familiar clack installer look; plain mode (agents,
// --json, pipes) falls back to plain stderr lines so nothing decorative ever
// lands where a machine is parsing.
import * as clack from "@clack/prompts";
import { step, ok, warn, die } from "./output";

let pretty = false;

export function initUi(enabled: boolean): void {
  pretty = enabled && process.stderr.isTTY === true;
}

export function uiIntro(title: string): void {
  if (pretty) clack.intro(title);
}

export function uiOutro(message: string): void {
  if (pretty) clack.outro(message);
}

export function uiStep(msg: string): void {
  if (pretty) clack.log.step(msg);
  else step(msg);
}

export function uiOk(msg: string): void {
  if (pretty) clack.log.success(msg);
  else ok(msg);
}

export function uiWarn(msg: string): void {
  if (pretty) clack.log.warn(msg);
  else warn(msg);
}

export function uiNote(message: string, title?: string): void {
  if (pretty) clack.note(message, title);
  else process.stderr.write((title ? `${title}\n` : "") + message + "\n");
}

export interface UiSpinner {
  start(msg: string): void;
  stop(msg: string): void;
}

export function uiSpinner(): UiSpinner {
  if (pretty) {
    const s = clack.spinner();
    return { start: (msg) => s.start(msg), stop: (msg) => s.stop(msg) };
  }
  return { start: (msg) => step(msg), stop: (msg) => ok(msg) };
}

export async function uiPromptText(message: string, placeholder?: string): Promise<string> {
  if (pretty) {
    const answer = await clack.text({ message, placeholder });
    if (clack.isCancel(answer)) die("cancelled", 2);
    return String(answer).trim();
  }
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${message}: `, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  return answer;
}
