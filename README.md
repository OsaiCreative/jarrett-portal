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
whose date has passed leaves the live sections and moves into the Archive.
Nothing is deleted.
