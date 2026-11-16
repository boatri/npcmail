// D1 schema. Statements are idempotent (IF NOT EXISTS) so setup can re-run safely;
// addMissingColumns brings a database created by an older release up to date.
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS identities (
    address TEXT PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    label TEXT,
    registered INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    from_addr TEXT,
    from_name TEXT,
    to_addr TEXT,
    subject TEXT,
    text_body TEXT,
    html_body TEXT,
    otp_code TEXT,
    otp_link TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT,
    headers TEXT,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_address_received ON messages (address, received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_received ON messages (received_at)`,
];

const ADDED_MESSAGE_COLUMNS = ["message_id", "in_reply_to", "refs", "headers"];

export function addMissingColumns(existing: string[]): string[] {
  return ADDED_MESSAGE_COLUMNS.filter((c) => !existing.includes(c)).map(
    (c) => `ALTER TABLE messages ADD COLUMN ${c} TEXT`,
  );
}
