# Admin interface

`apps/web` is the internal desk for two people: an owner and a clerk. It is a Next.js app on port 3001. The browser talks only to that origin. Next.js proxies `/api/auth/*` to the Fastify API (`API_URL`, default `http://127.0.0.1:3000`). The session cookie is `HttpOnly`, so page scripts cannot read it.

## Pages

| Path     | Who            | What is on the page                                                                                                                                 |
| -------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login` | signed out     | Username and password. Errors stay on the form. The button stays disabled while the request is in flight. Too many attempts shows the wait message. |
| `/`      | signed in      | Sends an owner to `/owner` and a clerk to `/clerk`.                                                                                                 |
| `/owner` | owner          | Placeholder: Review queue coming in T6. A clerk receives 403.                                                                                       |
| `/clerk` | owner or clerk | Placeholder: New deal form coming in T5.                                                                                                            |

Someone who is not signed in is sent to `/login`.

## Shell

The signed-in pages share a top bar: the name SS Deals, the person's username, their role, and Log out. Under that, the owner sees Review queue and New deal. The clerk sees New deal only. Controls are large and the colours are teal `#0F766E`, amber `#F59E0B`, slate text, and an off-white background.

## Run

From the repo root, with Postgres and the API up:

```bash
pnpm dev:web
```

Open `http://localhost:3001`. Create the two accounts with the API scripts (they prompt for a password and refuse one on the command line):

```bash
pnpm --filter @ss-deals/server user:create --username OWNER --role owner
pnpm --filter @ss-deals/server user:create --username CLERK --role clerk
```

`user:set-password` and `user:deactivate` take `--username`. Changing a password or deactivating an account signs that person out.

Compose publishes the site on `127.0.0.1:3001`. Set `WEB_BIND` to a LAN or Tailscale address when the desk should be reachable from another machine on that network. Do not publish it on the public internet.
