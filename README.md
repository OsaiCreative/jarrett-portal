# Jarrett Adams — Opportunity Portal

Private command center for the *Redeeming Justice* visibility work. Live at
https://jarrett-portal-production.up.railway.app (sign-in required).

## How it runs

- `index.html` — the whole portal (content + scripts).
- `server.js` — small Node server, no dependencies. Serves the portal only to
  signed-in users and stores everyone's progress (status pills, checklist ticks,
  who changed what) in `/data/state.json` on a Railway volume. One dated
  snapshot per day is kept for 30 days in the same folder.
- Railway deploys automatically on every push to `main` (GitHub:
  `OsaiCreative/jarrett-portal`), building from the `Dockerfile`.

## Railway variables

| Variable | What it is |
|---|---|
| `PORTAL_USERS` | JSON of sign-in names → display name + password hash |
| `SESSION_SECRET` | Random string that signs login cookies. Changing it signs everyone out. |
| `DATA_DIR` | `/data` (the mounted volume) |

If `PORTAL_USERS` or `SESSION_SECRET` is missing, the server refuses to show
the portal rather than serving it openly.

## Adding a person or changing a password

1. `node hash-password.js "their new password"` — prints a `scrypt$…` hash.
2. In Railway → jarrett-portal → Variables, edit `PORTAL_USERS` and add or
   replace that person's entry, e.g.
   `"carla":{"name":"Carla","hash":"scrypt$…"}`.
3. Railway redeploys; the new password works immediately.

Sign-in names are not case-sensitive. Sessions last 30 days. After 8 wrong
passwords from one network, sign-in pauses for 15 minutes.

## Daily auto-expiry

Every time the page opens (and just after midnight if left open), anything
whose date has passed — events, Act Now cards, checklist tasks — is removed
from the page. To bring something back, give it a new date in index.html.

## Outreach autopilot

`/outreach` shows what the autopilot is doing. It drafts and sends pitch
emails to the podcast and book-influencer entries on its own, weekdays 9 to 4,
five a day by default, and marks each one submitted in the portal.

It is off until these Railway variables are set:

| Variable | What it is |
|---|---|
| `OUTREACH_MODE` | `dry` writes drafts and logs them without sending. `live` sends. Anything else is off. |
| `ANTHROPIC_API_KEY` | Lets the server write drafts with Claude. |
| `OUTREACH_WEBHOOK_URL` | The n8n webhook from `../jarrett-outreach-sender.n8n.json`. |
| `OUTREACH_WEBHOOK_SECRET` | Long random string. Must match the Header Auth credential on that webhook. |

It never writes to tier 1 shows (those go through PRH), anything on the
"Don't pitch" list, the kids' series list before Jarrett's sign-off, an entry
someone has already marked working or beyond, or the same address twice. It
only uses contact emails the team has entered on the page. Edit
`outreach-profile.txt` to change the facts a draft is allowed to state.
