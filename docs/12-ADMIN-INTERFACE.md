# Admin interface

`apps/web` is the internal desk for two people: an owner and a clerk. It is a Next.js app on port 3001. The browser talks only to that origin. Next.js proxies `/api/auth/*` to the Fastify API (`API_URL`, default `http://127.0.0.1:3000`). The session cookie is `HttpOnly`, so page scripts cannot read it.

## Pages

| Path               | Who        | What is on the page                                                                                                                                 |
| ------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`           | signed out | Username and password. Errors stay on the form. The button stays disabled while the request is in flight. Too many attempts shows the wait message. |
| `/`                | signed in  | Sends an admin to `/admin` and everyone else to `/deals`.                                                                                           |
| `/admin`           | admin      | Placeholder: Review queue coming in T6. Anyone else receives 403: "You don't have access to this page."                                             |
| `/deals`           | signed in  | Deals home. The form will live at `/deals/new` and a person's own list at `/deals/mine`.                                                            |
| `/account`         | signed in  | Change password. The current sign-in stays. Other sessions are signed out.                                                                          |
| `/owner`, `/clerk` | signed in  | Redirect to `/admin` and `/deals`.                                                                                                                  |

Someone who is not signed in is sent to `/login`. The screen does not use the words owner or clerk.

## Shell

The signed-in pages share a top bar: the name SS Deals, the person's display name, Account, and Log out. An admin also sees a small Admin label. Under that, an admin sees Review queue and New deal. Everyone else sees New deal and My deals. Controls are large and the colours are teal `#0F766E`, amber `#F59E0B`, slate text, and an off-white background.

## Run

From the repo root, with Postgres and the API up:

```bash
pnpm dev:web
```

Open `http://localhost:3001`. Create the two accounts with the API scripts (they prompt for a password and refuse one on the command line):

```bash
pnpm --filter @ss-deals/server user:create --username OWNER --role owner --name "Full Name"
pnpm --filter @ss-deals/server user:create --username CLERK --role clerk
```

`--name` is optional. `user:set-name --username NAME --name "Full Name"` changes the name shown in the top bar. `user:set-password` and `user:deactivate` take `--username`. Changing a password from the command line, or deactivating an account, signs that person out. Changing a password from the Account page signs out the other sessions only.

Compose publishes the site on `127.0.0.1:3001`. Set `WEB_BIND` to a LAN or Tailscale address when the desk should be reachable from another machine on that network. Do not publish it on the public internet.
