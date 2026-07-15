// D1 schema. Statements are idempotent (IF NOT EXISTS) so setup can re-run safely.
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
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_address_received ON messages (address, received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_received ON messages (received_at)`,
];
