import { describe, expect, test } from "bun:test";
import PostalMime from "postal-mime";
import { MAX_HEADERS_BYTES } from "../src/shared/constants";
import { fromParsed, fromRaw } from "../src/shared/headers";
import { addMissingColumns } from "../src/shared/schema";

const reply = [
  "Received: from mail-sor-f41.google.com by mx.cloudflare.net",
  "From: Ivan <ivan@example.com>",
  "To: wei.chen@absoup.com",
  "Subject: Re: Restock order",
  "Message-ID: <CAF=abc123@mail.gmail.com>",
  "In-Reply-To: <first@absoup.com>",
  "References: <root@absoup.com>",
  " <first@absoup.com>",
  "X-Custom-Header: kept",
  "",
  "Sounds good.",
].join("\r\n");

describe("fromParsed", () => {
  test("keeps every header in received order with its original case", async () => {
    const { headers } = fromParsed(await PostalMime.parse(reply));
    expect(headers.map((h) => h.name)).toEqual([
      "Received",
      "From",
      "To",
      "Subject",
      "Message-ID",
      "In-Reply-To",
      "References",
      "X-Custom-Header",
    ]);
    expect(headers.find((h) => h.name === "X-Custom-Header")?.value).toBe("kept");
  });

  test("extracts the threading fields as received", async () => {
    const r = fromParsed(await PostalMime.parse(reply));
    expect(r.messageId).toBe("<CAF=abc123@mail.gmail.com>");
    expect(r.inReplyTo).toBe("<first@absoup.com>");
    expect(r.references).toBe("<root@absoup.com> <first@absoup.com>");
  });

  test("a message without threading headers stores nulls", async () => {
    const r = fromParsed(await PostalMime.parse("From: a@b.c\r\nSubject: hi\r\n\r\nbody"));
    expect(r).toMatchObject({ messageId: null, inReplyTo: null, references: null });
  });

  test("drops trailing headers past the size cap", () => {
    const big = "x".repeat(MAX_HEADERS_BYTES / 2);
    const r = fromParsed({
      headers: ["A", "B", "C"].map((k) => ({ key: k.toLowerCase(), originalKey: k, value: big })),
    });
    expect(r.headers.map((h) => h.name)).toEqual(["A"]);
  });
});

describe("fromRaw", () => {
  test("reads the threading fields and header list from the routing headers", () => {
    const r = fromRaw(new Headers({ "Message-ID": "<m@x>", References: "<r@x>", Subject: "s" }));
    expect(r.messageId).toBe("<m@x>");
    expect(r.inReplyTo).toBeNull();
    expect(r.references).toBe("<r@x>");
    expect(r.headers).toContainEqual({ name: "message-id", value: "<m@x>" });
  });
});

describe("addMissingColumns", () => {
  test("adds only the columns an older database lacks", () => {
    expect(addMissingColumns(["id", "address", "message_id"])).toEqual([
      "ALTER TABLE messages ADD COLUMN in_reply_to TEXT",
      "ALTER TABLE messages ADD COLUMN refs TEXT",
      "ALTER TABLE messages ADD COLUMN headers TEXT",
    ]);
  });

  test("is a no-op on a current database", () => {
    expect(addMissingColumns(["message_id", "in_reply_to", "refs", "headers"])).toEqual([]);
  });
});
