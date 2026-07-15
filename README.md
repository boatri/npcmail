# npcmail

**Throwaway email identities on your own domain — NPCs with inboxes, built for AI agents.**

`npcmail` turns any domain you own into an unlimited supply of realistic, disposable email
identities (`jane.moreau@yourdomain.com`), with a CLI that creates them, reads their mail, and
extracts verification codes — designed so an AI agent can sign up for services on your behalf
and complete email verification without any third-party temp-mail service.

```console
$ npcmail new
anna.kaminski@yourdomain.com

$ npcmail otp anna.kaminski --wait 90
847291
```

Everything runs on **your Cloudflare account**: Email Routing receives the mail, a Worker
parses and stores it in D1, and the CLI talks to that Worker. No servers, no third party
holding your mail, free-tier friendly.

## Why

Services increasingly block well-known disposable-email domains. Your own domain isn't on
any blocklist, and addresses like `anna.kaminski@` look like people, not tokens. Existing
temp-mail products run on *their* domains with *their* web UIs; npcmail is self-hosted and
agent-first.

## Setup (one command)

Requirements: a domain on Cloudflare **that is not used for email** (npcmail takes over all
inbound mail via a catch-all), and a Cloudflare API token (scopes below).

```bash
CLOUDFLARE_API_TOKEN=... npx npcmail setup --domain yourdomain.com
```

This provisions everything: a D1 database, the Worker (bundled with the CLI — no wrangler,
no repo checkout), Email Routing MX/SPF records, a catch-all route to the Worker, and a
generated API token. Config lands in `~/.config/npcmail/config.json`. Re-running setup is
safe (idempotent) and is also how you upgrade the Worker after a new npcmail release.

### API token scopes

Create at dash.cloudflare.com → My Profile → API Tokens → *Create Custom Token*:

| Scope | Permission | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Zone (your domain) | DNS | Edit |
| Zone (your domain) | Email Routing Rules | Edit |
| Zone (your domain) | Zone | Read |

### Safety: what if the domain already has things on it?

`setup` preflights before touching anything:

- **Existing MX records pointing at another mail provider → hard refusal.** Enabling
  Email Routing would break your real email. Use another domain (or `--force` if you're
  certain the old mail setup is dead).
- **Existing Email Routing catch-all → refusal** unless it already points at npcmail
  (or `--force`).
- Existing DNS records (websites, etc.) are never modified — npcmail only adds the
  Email Routing MX/SPF records and never touches A/CNAME/etc.
- `npcmail teardown --yes` removes the catch-all and the Worker (add `--delete-data`
  to also drop the D1 database).

## CLI

```
IDENTITIES
  new  [--first x --last y] [--label text]   create identity (random human name)
  ls   [--limit N]                           list identities
  rm   <address>                             delete identity + its messages

MAIL
  inbox <address> [--wait N] [--since ISO] [--limit N]   list messages
  read  <address | message-id>                           full message
  otp   <address> [--wait N] [--since ISO]               verification code/link

SERVICE
  status      health + counts
  config      current configuration
```

### Agent usage

Everything supports `--json` for stable machine-readable output on stdout
(progress goes to stderr):

```bash
ADDRESS=$(npcmail new)                        # bare address on stdout
# ... agent signs up somewhere with $ADDRESS ...
CODE=$(npcmail otp "$ADDRESS" --wait 120)     # blocks until the code arrives
```

- Bare `jane.moreau` works everywhere an `<address>` is expected — the domain is appended.
- **Any** address on the domain receives mail (catch-all): agents can invent
  `signup-acme@yourdomain.com` on the fly without calling `new` first; the identity
  appears automatically on first message (`ls` marks these `implicit`).
- `otp` prints the bare code (or verification link if there's no code) on stdout.
- Exit codes: `0` ok · `1` error · `2` usage · `3` not found · `4` nothing arrived before `--wait`.
- Stateless mode (no config file): set `NPCMAIL_URL`, `NPCMAIL_TOKEN`, `NPCMAIL_DOMAIN`.

## HTTP API

The Worker exposes a small bearer-token API if you'd rather skip the CLI:

```
GET    /v1/health
POST   /v1/identities                     {"first"?, "last"?, "label"?}
GET    /v1/identities
GET    /v1/identities/{address}
DELETE /v1/identities/{address}
GET    /v1/identities/{address}/messages?since=&limit=&full=1
GET    /v1/identities/{address}/otp?since=&wait=25      (long-poll)
GET    /v1/messages/{id}
```

`Authorization: Bearer <token>` — the token is in `~/.config/npcmail/config.json`.

## How it works

```
inbound email → Cloudflare Email Routing (catch-all)
             → Email Worker (postal-mime parse, OTP extraction)
             → D1 (identities + messages)
             ← HTTP API ← CLI (npcmail / npcm)
```

- OTP extraction runs at ingest: codes (`847291`, `123 456`, `7GX4KQ`) are matched near
  signal words with URL/year/price exclusions; verification links are scored above
  unsubscribe/social links. Both are stored per message.
- Messages are pruned after 30 days by default (`setup --retention-days N`, `0` = keep forever).
- Receive-only by design: npcmail never sends email, so your domain can't be abused
  for outbound spam.

## Development

```bash
bun install
bun test              # OTP extraction tests
bun run typecheck
bun run build         # dist/worker.js + dist/cli.js
```

## License

MIT
