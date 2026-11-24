# Jarrett Adams Opportunity Portal

Private team board for Jarrett Adams's visibility work around *Redeeming Justice*: festivals, podcasts and media, book influencers, speaking, and the book/presence pipeline. Used by Ali (Osai Creative), Jarrett, and Carla Broadnax (Jarrett Adams Law).

Live: https://jarrett-portal-production.up.railway.app (sign-in required)

## How it's built

- `index.html` is the whole front end: styles, the content block, and the app script. No build step, no framework.
- Content lives in `window.PORTAL = {...}` (first `<script>` in the body). Keys: `actNow`, `events`, `planAhead`, `podcasts` (tiers → items), `influencers` (tiers → items), `outreachRule`, `covered` (groups, print credits), `speaking`, `pipeline`, `checklist`, `updated`.
- Every trackable item has a stable `id`. Saved statuses and ticks are keyed by it. **Never change an existing `id`**, even when renaming the title.
- Dates are `YYYY-MM-DD`. Anything whose last date (`end`, else `start`, else `due`, or `expire` for TBA items) has passed is filtered out at render time. The page reloads just after midnight.
- `server.js` (Node 22, standard library only) serves the page behind a sign-in and stores shared progress:
  - `GET /api/state`, `POST /api/update` `{kind:'s'|'t', id, value, label}`, `POST /api/merge` (fill-only), `GET /api/export`
  - Statuses: `todo`, `working`, `submitted`, `confirmed`, `passed`. Ticks are booleans.
  - Data: `$DATA_DIR/state.json` (atomic writes) plus one `state-YYYY-MM-DD.json` snapshot per day, last 30 kept. Each change records who and when (`meta`, `log`).
- `outreach.js` is the outreach autopilot, with its page at `/outreach` (`outreach.html`). It reads the podcast and influencer entries out of `window.PORTAL`, drafts a pitch with Claude (`@anthropic-ai/sdk`, the one dependency), holds it for a short while, then sends it through an n8n webhook that uses the Gmail credential. Sent entries flip to `submitted` under the name Autopilot.
  - `GET /api/outreach`, `POST /api/outreach/contact` `{id, email, name, peg, hold}`, `POST /api/outreach/cancel` `{id}`, `POST /api/outreach/pause` `{paused}`
  - Data: `$DATA_DIR/outreach.json` (contacts, every message, pause switch). Facts the drafts may use: `outreach-profile.txt`.
- Sign-in: per-person accounts in `PORTAL_USERS` (scrypt hashes from `node hash-password.js "pw"`), HMAC-signed 30-day cookie, 8 failed attempts per IP per 15 minutes. The server refuses to serve if `PORTAL_USERS` or `SESSION_SECRET` is missing.

## Deploy

- Railway project `jarrett-portal`, service `jarrett-portal`, builds from `Dockerfile` (node:22-alpine).
- Pushing `main` to GitHub (`OsaiCreative/jarrett-portal`) deploys automatically.
- Variables on Railway: `PORTAL_USERS`, `SESSION_SECRET`, `DATA_DIR=/data`. Outreach: `OUTREACH_MODE` (`off` by default, `dry` to draft without sending, `live` to send), `ANTHROPIC_API_KEY`, `OUTREACH_WEBHOOK_URL`, `OUTREACH_WEBHOOK_SECRET`, and optionally `OUTREACH_DAILY_CAP` (5), `OUTREACH_HOLD_MINUTES` (30), `OUTREACH_GAP_MINUTES` (20), `OUTREACH_TZ` (America/New_York), `OUTREACH_SIGNATURE`. Volume `portal-data` is mounted at `/data`.
- Never commit secrets, `data/`, or plaintext passwords.

## Run locally

```bash
H=$(node hash-password.js test)
PORTAL_USERS="{\"ali\":{\"name\":\"Ali\",\"hash\":\"$H\"}}" \
SESSION_SECRET=$(openssl rand -hex 32) DATA_DIR=./data PORT=8080 node server.js
# open http://localhost:8080, sign in as ali / test
```

Opening `index.html` directly as a file also works, in browser-only mode (progress stays in that browser).

## Design and copy rules

- Brand: forest `#18291F`/`#24402F`, gold `#A98736`/`#D3B66C`, parchment `#F4EDDE`, paper `#FCF9F2`. Cormorant Garamond for headings and dates, Archivo for text.
- Soft and warm: rounded panels, soft shadows, tinted pill labels. No hard rules, colored side stripes, all-caps labels, or count badges.
- Copy is plain, sentence case, and written for Jarrett and Carla. No em dashes; Ali reads them as AI filler.
- Check desktop and phone widths after any layout change.

## Outreach guardrails (apply to any email or automation work)

- Sends are automatic (Ali's decision, 2026-11-24): the autopilot emails without a person approving each message. The rules below are enforced in `eligibility()` in `outreach.js` and are the only safety net, so never loosen them without asking Ali.
- The autopilot only writes to contact emails a team member has typed in. It does not look up or guess addresses.
- A draft that fails the checks in `vet()` (wrong length, placeholder, invented shape) is held for a person, never sent.
- Anyone signed in can pause everything, cancel a waiting draft, or hold one entry from `/outreach`.
- No automatic follow-ups: the server cannot see replies, so a second email would risk nagging someone who already answered.
- Before drafting to any show or outlet, check `covered`. "Don't pitch" entries are never contacted; "New angle only" needs a real news peg.
- Tier 1 podcasts ("Massive reach") go through PRH/Convergent publicity, not direct cold email.
- Kids'-series outreach waits for Jarrett's written likeness and tone sign-off (see `pipeline`).
- Respect sending limits and keep a record of every message sent per target, so nobody double-sends.

## Related

- `../jarrett-opportunity-scout.n8n.json` and `../README.md`: the weekly n8n lead scout (Google Alerts RSS → scored digest email). Its v2 roadmap includes feeding finds into this portal.
- The n8n instance runs on Railway and already has a Gmail OAuth credential.
