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
inbound mail via a catch-all).

```bash
npx npcmail setup --domain yourdomain.com
```

With no Cloudflare token available, setup starts a one-time OAuth-style flow: it opens the
Cloudflare dashboard with the custom-token form **prefilled with exactly the 5 permissions
npcmail needs** — you review, click *Continue to summary* → *Create Token*, paste it back,
and forget about it (it's saved to config; you're never asked again). Non-interactive
sessions (AI agents) get the same URL from `npcmail token-url --json` to hand to their human.

Already have a token? `CLOUDFLARE_API_TOKEN=... npx npcmail setup --domain yourdomain.com`
works too. Either way, setup verifies each required permission with live probes before
touching anything, and tells you precisely which one is missing if any.

Setup provisions everything: a D1 database, the Worker (bundled with the CLI — no wrangler,
no repo checkout), Email Routing MX/SPF records, a catch-all route to the Worker, and a
generated service token. Config lands in `~/.config/npcmail/config.json`. Re-running setup
is safe (idempotent) and is also how you upgrade the Worker after a new npcmail release.

### API token scopes

The prefilled form (and manual creation at dash.cloudflare.com → My Profile → API Tokens)
uses this minimal set:

| Scope | Permission | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Zone (your domain) | DNS | Edit |
| Zone (your domain) | Email Routing Rules | Edit |
| Zone (your domain) | Zone | Read |

Tokens are needed only by `setup`/`teardown` — day-to-day commands authenticate to your
worker with the service token from the config file and never touch the Cloudflare API.

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
  update      update the CLI to the latest version
```

### Staying up to date

npcmail checks npm for new versions at most once a day (3s timeout, cached, never blocks
a command) and prints a two-line notice on stderr when one exists. It stays silent in CI,
non-TTY sessions, `--json` mode, and under `NO_UPDATE_NOTIFIER`/`NPCMAIL_NO_UPDATE_CHECK`.

`npcmail update` upgrades via whichever package manager installed it (npm/bun/pnpm/yarn).
The worker on your domain updates separately: re-run `npcmail setup --domain <yourdomain>`
after updating — it re-deploys the bundled worker idempotently.

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
- **The heuristics are a hint, not a gate.** `otp` returns as soon as *any* new message
  arrives; with `--json` the full message is always included (`message.textBody` /
  `message.textFromHtml`), so if `code` is null the agent reads the content and extracts
  the code itself — the reliable path is always one call away:

  ```jsonc
  // npcmail otp jane.moreau --since $TS --wait 120 --json
  {
    "found": true,          // a message arrived
    "code": "847291",       // heuristic hit — null if it missed
    "link": null,
    "message": { "subject": "...", "textBody": "...", "textFromHtml": "..." }
  }
  ```
- `otp --wait` without `--since` only accepts messages received in the last 2 minutes,
  so a stale code from an earlier signup can never satisfy a fresh wait. Pass `--since`
  explicitly to control the window, or omit both to inspect the latest stored message.
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
bun test
bun run typecheck
bun run build         # dist/worker.js + dist/cli.js
```

### Releasing (maintainers)

```bash
npm version patch   # or minor / major — bumps, commits, tags
git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which publishes to npm via
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) (GitHub OIDC — no
tokens stored) and creates a GitHub release with generated notes.

## License

MIT
