import { describe, expect, test } from "bun:test";
import { extractOtp, htmlToText } from "../src/shared/otp";

describe("extractOtp — codes", () => {
  test("classic 6-digit code in body", () => {
    const r = extractOtp(
      "Verify your email",
      "Welcome!\n\nYour verification code is 482913. It expires in 10 minutes.",
      null,
    );
    expect(r.code).toBe("482913");
  });

  test("code in subject line", () => {
    const r = extractOtp("583201 is your Airbnb verification code", "Enter the code to continue.", null);
    expect(r.code).toBe("583201");
  });

  test("split code like 123 456", () => {
    const r = extractOtp("Your login code", "Use code 123 456 to sign in.", null);
    expect(r.code).toBe("123456");
  });

  test("4-digit PIN", () => {
    const r = extractOtp("Your PIN", "Your one-time PIN is 8241.", null);
    expect(r.code).toBe("8241");
  });

  test("alphanumeric code", () => {
    const r = extractOtp("Confirm your account", "Enter this code: 7GX4KQ", null);
    expect(r.code).toBe("7GX4KQ");
  });

  test("ignores years and prices", () => {
    const r = extractOtp(
      "Welcome to Acme",
      "Since 2019 we've helped 10000 customers. Copyright 2026 Acme Inc.",
      null,
    );
    expect(r.code).toBeNull();
  });

  test("ignores numbers inside URLs", () => {
    const r = extractOtp(
      "Verify your account",
      "Click to verify: https://acme.com/verify/847291/confirm?y=2026 — this link expires soon.",
      null,
    );
    expect(r.code).toBeNull();
    expect(r.link).toBe("https://acme.com/verify/847291/confirm?y=2026");
  });

  test("html-only email", () => {
    const r = extractOtp(
      "Your code",
      null,
      `<html><body><p>Your verification code:</p><h1 style="color:#333">941 element</h1><h2>552918</h2></body></html>`,
    );
    expect(r.code).toBe("552918");
  });

  test("no false positive on plain newsletters", () => {
    const r = extractOtp(
      "Weekly digest",
      "This week: 12 new posts, 384 comments. Top story got 4821 upvotes.",
      null,
    );
    expect(r.code).toBeNull();
  });
});

describe("extractOtp — links", () => {
  test("verification link in text", () => {
    const r = extractOtp(
      "Confirm your email",
      "Almost there!\nConfirm: https://app.example.com/confirm?token=abc123def456\nThanks!",
      null,
    );
    expect(r.link).toBe("https://app.example.com/confirm?token=abc123def456");
  });

  test("prefers verify link over unsubscribe", () => {
    const html = `
      <a href="https://x.com/unsubscribe?u=1">unsubscribe</a>
      <a href="https://x.com/account/verify?token=zzz">Verify email</a>
      <img src="https://x.com/logo.png">
    `;
    const r = extractOtp("Verify", null, html);
    expect(r.link).toBe("https://x.com/account/verify?token=zzz");
  });

  test("no link when nothing qualifies", () => {
    const r = extractOtp("Hi", "Check our homepage https://example.com/pricing", null);
    expect(r.link).toBeNull();
  });

  test("decodes &amp; in hrefs — multi-param links stay intact", () => {
    const html = `<a href="https://x.com/verify?token=abc&amp;uid=42&amp;sig=zz9">Verify email</a>`;
    const r = extractOtp("Verify", null, html);
    expect(r.link).toBe("https://x.com/verify?token=abc&uid=42&sig=zz9");
  });
});

describe("htmlToText", () => {
  test("strips tags, styles, decodes entities", () => {
    const text = htmlToText(
      `<html><head><style>.a{color:red}</style></head><body><h1>Hello &amp; welcome</h1><p>line one</p><p>line two</p></body></html>`,
    );
    expect(text).toContain("Hello & welcome");
    expect(text).toContain("line one");
    expect(text).not.toContain("color:red");
  });
});
