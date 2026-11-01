# Security guidelines

This desk is for two people on a private network. These rules are what the sign-in code does today.

## Passwords

Node's `crypto.scrypt` hashes passwords with a random salt. The hash string records the scrypt parameters. Comparison uses `timingSafeEqual`. Unknown users still run scrypt so the response is not a faster "no such user" path. The login error text is the same for an unknown user, a wrong password, and an inactive user. Plaintext passwords are not stored, not logged, and not accepted on the user-admin command line. New passwords must be 12 to 1024 characters.

## Sessions

The cookie value is 32 random bytes, encoded as base64url. The `sessions.id` column is the SHA-256 hash of that value. A session ends when it is revoked, when it has been idle for 12 hours, or 7 days after it was created, whichever comes first. Activity moves the idle deadline forward and stops at the 7-day mark. Deactivating a user or setting a new password from the command line revokes that user's sessions. Changing a password while signed in checks the current password and revokes every session except the one that made the change. That route allows 5 failures per username and IP in 15 minutes.

The cookie is `HttpOnly` and `SameSite=Lax`. `COOKIE_SECURE` defaults to false so local `http://localhost:3001` works. Set it to true only behind HTTPS. `ALLOWED_ORIGIN` defaults to `http://localhost:3001`. A browser opened at `http://127.0.0.1:3001` sends a different origin, so add that origin to the list before using it. Every state-changing request must send a matching `Origin` or it is rejected.

## Abuse and headers

Login allows 5 failures per username and IP, and 20 failures per IP, in a 15-minute window. The next attempt is HTTP 429. Failures wait 250ms before responding. Bodies over 16 KiB are rejected. Responses send nosniff, `X-Frame-Options: DENY`, a `default-src 'none'` content security policy, and the usual lock-down headers. `Strict-Transport-Security` is sent only when `COOKIE_SECURE` is true.

Logs redact passwords, including `currentPassword` and `newPassword`, plus cookies and session tokens. The guard routes under `/api/auth/test/` are not registered when `NODE_ENV=production`.

## Network

Compose binds Postgres, the API, and the web app to `127.0.0.1` unless `WEB_BIND` is set for the web port. `WEB_BIND` is for a LAN or Tailscale address, not a public one. The API trusts `X-Forwarded-For` so the Next.js proxy can pass the browser address into the rate limit. On this private deploy that header is not a public authentication boundary.
