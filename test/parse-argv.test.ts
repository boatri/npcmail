import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/cli/index";

describe("parseArgv", () => {
  test("command with positional and value flag", () => {
    const p = parseArgv(["otp", "jane.moreau", "--wait", "60"]);
    expect(p.cmd).toBe("otp");
    expect(p.positional).toEqual(["jane.moreau"]);
    expect(p.flags.get("wait")).toBe("60");
  });

  test("boolean flag before positional does not swallow it", () => {
    const p = parseArgv(["otp", "--json", "jane.moreau"]);
    expect(p.positional).toEqual(["jane.moreau"]);
    expect(p.flags.get("json")).toBe(true);
  });

  test("--key=value form", () => {
    const p = parseArgv(["inbox", "jane", "--since=2026-07-15T00:00:00Z"]);
    expect(p.flags.get("since")).toBe("2026-07-15T00:00:00Z");
  });

  test("value flag consumes next token", () => {
    const p = parseArgv(["new", "--label", "test account", "--json"]);
    expect(p.flags.get("label")).toBe("test account");
    expect(p.flags.get("json")).toBe(true);
  });

  test("no command", () => {
    const p = parseArgv([]);
    expect(p.cmd).toBeUndefined();
  });
});
