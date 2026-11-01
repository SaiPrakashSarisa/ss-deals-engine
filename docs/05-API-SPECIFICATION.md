# API specification

The HTTP API is the Fastify process in `apps/server`. This note covers sign-in. Deal and publishing routes are later tasks.

## Authentication

Passwords are stored only as scrypt hashes in `users.password_hash`. A session cookie holds a random 32-byte token. The database stores the SHA-256 hash of that token, not the token itself.

| Method | Path                        | Body                                   | Success                                                           |
| ------ | --------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `POST` | `/api/auth/login`           | `{ "username", "password" }`           | `200` `{ "user": { "id", "username", "role" } }` and `Set-Cookie` |
| `POST` | `/api/auth/logout`          | none                                   | `204` and a cleared cookie                                        |
| `GET`  | `/api/auth/me`              | none                                   | `200` `{ "id", "username", "role", "displayName" }`               |
| `POST` | `/api/auth/change-password` | `{ "currentPassword", "newPassword" }` | `200` `{ "ok": true }`                                            |

`role` is `owner` or `clerk`. `displayName` is the person's saved name, or their username when no name is saved. A name is at most 60 characters.

The new password must be at least 12 characters and must differ from the current one. A wrong current password is `401`. The current session stays signed in. Every other session for that person is revoked. Five failed attempts for the same username and IP within 15 minutes return `429`.

Unknown users, wrong passwords, and inactive users all receive `401` and the same message: `The username or password is incorrect.` A missing username or password is `400`.

The cookie name defaults to `ssd_session`. It is `HttpOnly`, `SameSite=Lax`, and `Path=/`. `Secure` is set only when `COOKIE_SECURE=true`. The browser keeps it for the remaining absolute lifetime, at most 7 days. The server also ends the session after 12 hours without a request. Each successful authenticated request slides that idle deadline forward, never past the 7-day mark. Logout sets `revoked_at`.

`POST`, `PUT`, `PATCH`, and `DELETE` must send an `Origin` header that is listed in `ALLOWED_ORIGIN` (comma-separated). Anything else is `403`.

Five failed sign-in attempts for the same username and IP within 15 minutes return `429` with `Retry-After`. Twenty failed attempts from one IP in that window do the same, across usernames. Failures wait a short fixed time before the response.

`GET /api/auth/test/user`, `/owner`, and `/clerk` exist only when `NODE_ENV` is not `production`. They answer `401` for anonymous callers and `403` when the signed-in role does not match. Production does not register them.

Request bodies are limited to 16 KiB. Responses include nosniff, frame denial, a locked-down content security policy, and related browser headers. Logs redact cookies, session tokens, and passwords.

`GET /health` is unchanged and does not require a session.
