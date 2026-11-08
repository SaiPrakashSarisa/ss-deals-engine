# API specification

The HTTP API is the Fastify process in `apps/server`. This note covers sign-in, deal drafts, and admin review. Publishing is a later task.

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

## Deals

Every deal route requires a signed-in session. `POST`, `PATCH`, and `DELETE` also need an allowed `Origin`, the same check as sign-in. A person sees and changes only deals they created. An admin can read any deal by id, including its image, and still sees only their own deals on `GET /api/deals`. Editing and sending for review stay with the person who created the draft.

The server never requests the pasted URL or any Amazon page. It parses the link locally, stores money as integer paise, and forces `old_price_verified` to false. The deal title is stored on `deals.title`. `products.title` keeps the latest known title and is not returned on deal screens.

| Method   | Path                      | Body                             | Success                                     |
| -------- | ------------------------- | -------------------------------- | ------------------------------------------- |
| `GET`    | `/api/deals/config`       | none                             | `200` `{ "shortLinkHosts", "maxUploadMb" }` |
| `POST`   | `/api/deals/check-url`    | `{ "url", "price?", "dealId?" }` | `200` URL check                             |
| `POST`   | `/api/deals`              | deal fields                      | `201` `{ "deal" }`                          |
| `GET`    | `/api/deals`              | none                             | `200` `{ "deals" }`                         |
| `GET`    | `/api/deals/:id`          | none                             | `200` `{ "deal" }`                          |
| `PATCH`  | `/api/deals/:id`          | deal fields                      | `200` `{ "deal" }`                          |
| `POST`   | `/api/deals/:id/submit`   | none                             | `200` `{ "deal" }`                          |
| `POST`   | `/api/deals/:id/withdraw` | none                             | `200` `{ "deal" }`                          |
| `POST`   | `/api/deals/:id/image`    | one multipart file               | `200` `{ "deal" }`                          |
| `GET`    | `/api/deals/:id/image`    | none                             | image bytes                                 |
| `DELETE` | `/api/deals/:id/image`    | none                             | `204`                                       |

`GET /api/deals/config` is for a signed-in person. `shortLinkHosts` is the server's `SHORT_LINK_HOSTS`. `maxUploadMb` is the upload limit in megabytes. The deal form uses these instead of a fixed host list. An anonymous call is `401`.

`GET /api/deals?status=` filters the caller's own list. An unknown status is `400`.

Deal fields: `productUrl` (required), `title` (required, max 200), `price` (required, whole rupees), `oldPrice` (optional, must be higher than the price), `offer` (max 120), `highlights` (0 to 3 strings, max 80 each), `shortLink` (optional https link on `SHORT_LINK_HOSTS`), `sourceNote` (max 120), `clerkNotes` (max 300). Invalid fields return `400` `{ "error", "fields" }`.

`POST /api/deals` creates a `draft`. It upserts the Amazon product (`external_id` is the ASIN) and an affiliate link (`verification` `tag_appended`, `validation_status` `structure_ok`, tagged with `AMAZON_TAG`). It refuses with `409` when that product already has a deal in `draft`, `pending_approval`, `approved`, or `scheduled`, or when the last published price is missing or is not higher than the new price. A missing earlier price tells the person to ask an admin. Each create writes `audit_log` action `deal.create`.

`POST /api/deals/check-url` returns `{ "ok", "asin", "problems", "code", "activeDeal", "repost", "previousPricePaise", "newPricePaise", "taggedUrl" }`. `code` is `ok`, `editing`, `invalid`, `in_queue`, `posted_lower`, `posted_blocked`, `posted_unknown_price`, or `awaiting_price`. When `dealId` is the signed-in person's active deal for that product, the check ignores that deal and returns `editing` instead of `in_queue`. Another person's active deal is still `in_queue`. A repost still has to be a lower price: `posted_lower` when it is, and `posted_blocked` when it is not. The check inserts nothing.

A deal object includes `editable`. It is true only when the caller created that deal and it is still a `draft`.

`PATCH` updates only the creator's own `draft`. Any other status is `409`. A deal the caller cannot read is `404`. An admin who did not create the draft gets `403`.

`POST /api/deals/:id/withdraw` moves the creator's own `pending_approval` deal back to `draft` and writes `audit_log` action `deal.withdraw`. Any other status is `409`. Someone who did not create the deal gets `403` when they can read it, and `404` when they cannot. The deal can then be edited and sent for review again. The repost rule is checked again on update and on submit.

`POST /api/deals/:id/submit` moves `draft` to `pending_approval`, sets `submitted_at`, and writes a `price_snapshots` row with origin `clerk_entered`. The title and product link must still be present. A second submit, or a submit from any other status, is `409`.

Images accept one JPEG, PNG, or WebP file. The type is taken from magic bytes. The file is re-encoded to a maximum 1600px edge with metadata removed, stored under `UPLOAD_DIR` with a random name, and recorded on the deal. Replacing or deleting an image removes the previous file. `GET` returns the bytes only to someone who can read that deal, with `Cache-Control: private, no-store`. Files are not served from a public directory. A non-image is `400`. A file over `MAX_UPLOAD_MB` is `413`.

Creating a draft and uploading an image are each limited to 30 times per person per hour. Over the limit is `429` with `Retry-After`.

`AMAZON_TAG` is required. `SHORT_LINK_HOSTS` defaults to `amzn.to,link.amazon`. `UPLOAD_DIR` defaults to `./uploads`. `MAX_UPLOAD_MB` defaults to 5.

## Admin review

Admin review routes require a signed-in session with the admin role (`owner`). Anonymous requests receive `401`. Non-admin (`clerk`) requests receive `403`. Responses never include password hashes, session tokens, or other private user fields.

| Method | Path                   | Query / Params                                                                                                                               | Success                                                           |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/api/admin/deals`     | `status=pending_approval\|approved\|sent_back\|draft\|rejected\|published\|failed` (default `pending_approval`), `page`, `pageSize` (max 50) | `200` `{ "counts": { ... }, "items": [ ... ] }`                   |
| `GET`  | `/api/admin/deals/:id` | `id` (deal UUID)                                                                                                                             | `200` Deal detail with preview, duplicate, repost, and image info |

`GET /api/admin/deals`:

- `status`: filters by status. Defaults to `pending_approval`. `sent_back` means `draft` with a review note. An unrecognized status is `400`.
- `page`: 1-based page number (default 1).
- `pageSize`: items per page (default 20, max 50).
- `counts`: total count of deals for each status in the database (`pending_approval`, `approved`, `draft`, `rejected`, `published`, `failed`, `scheduled`), plus `sent_back` for drafts whose `review_note` is set. A draft that was never submitted, and a draft withdrawn before review, are not in `sent_back`.
- `items`: array of deals. Each item: `id`, `title`, `price` (rupees), `oldPrice` (rupees, or null), `oldPriceVerified`, `hasImage`, `createdBy` (display name, falling back to username), `sourceNote`, `submittedAt`, `status`, `updatedAt`.
- Ordering: `pending_approval` is ordered oldest first (`submittedAt` ascending, fallback `createdAt`); other statuses are ordered newest first (`updatedAt` descending, `createdAt` descending).

`GET /api/admin/deals/:id`:

- Returns all deal fields in whole rupees (not paise): `id`, `status`, `title`, `price`, `oldPrice`, `oldPriceVerified`, `highlights`, `offer`, `sourceNote`, `clerkNotes`, `reviewNote`, `rejectedReason`, `createdBy` (display name, falling back to username), `createdById`, `submittedAt`, `reviewedAt`, `createdAt`, `updatedAt` (the timestamp for concurrency control on later edits).
- Product and link fields: `asin`, `productAsin`, `productUrl`, `taggedUrl`, `taggedLink`, `shortLink`, `shortUrl`.
- Image info: `hasImage`, `image` (`{ url, mime }` or null), `imageUrl`, `imageMime`.
- `duplicate`:
  - `hasActiveDeal` / `activeDeal`: boolean, whether another active deal (`draft`, `pending_approval`, `approved`, `scheduled`) exists for the same product.
  - `repost`: `{ allowed: boolean, reason: 'first_post' | 'price_lower' | 'price_not_lower' | 'previous_price_unknown' }` from `evaluateRepost`, comparing deal price with the latest published publication's `posted_price_paise`.
  - `previousPostedPriceRupees` / `previousPostedPricePaise`.
- `preview`: the caption from `buildDealPreview` in `apps/server/src/modules/review/preview.ts`. It calls `formatPost` from `@ss-deals/core` with the same inputs as the deal form (`linkStyle: 'text'`, short link only when the host is allowed). `verified` is true only when `oldPriceVerified` is true and the old price is higher than the price, which adds the percent-off line. The result includes `html`, `caption` (the same text), `characterCount`, `warnings`, and `forbiddenWords`.
- `previewEnabled` is included so a later edit can send it back.

Edits and decisions are allowed only for an admin. Each write sends the `updatedAt` from the detail. If that value is stale, the response is `409` with `This deal changed. Reload to see the latest version.` A state-changing request also needs an allowed `Origin`.

| Method   | Path                             | Body                                                                                                         | Success                                       |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `PATCH`  | `/api/admin/deals/:id`           | Title, price, old price, offer, highlights, short link, source note, preview, verified flag, and `updatedAt` | `200` the updated detail                      |
| `POST`   | `/api/admin/deals/:id/image`     | Multipart image plus an `updatedAt` field                                                                    | `200` the updated detail                      |
| `DELETE` | `/api/admin/deals/:id/image`     | `{ "updatedAt" }`                                                                                            | `200` the updated detail                      |
| `POST`   | `/api/admin/deals/:id/approve`   | `{ "updatedAt" }`                                                                                            | `200` status `approved`                       |
| `POST`   | `/api/admin/deals/:id/send-back` | `{ "updatedAt", "note" }` note required, max 300                                                             | `200` status `draft`, `reviewNote` set        |
| `POST`   | `/api/admin/deals/:id/reject`    | `{ "updatedAt", "reason" }` reason required, max 300                                                         | `200` status `rejected`, `rejectedReason` set |
| `POST`   | `/api/admin/deals/:id/reopen`    | `{ "updatedAt" }`                                                                                            | `200` status `pending_approval`               |
| `POST`   | `/api/admin/deals/:id/unapprove` | `{ "updatedAt" }`                                                                                            | `200` status `pending_approval`               |

`PATCH` and the image routes accept a deal only while it is `pending_approval` or `approved`. Any other status is `409`. Field limits match the person-facing form, including an https short link on `SHORT_LINK_HOSTS`. `oldPriceVerified` is stored true only when an old price is present and higher than the price. Clearing the old price forces the flag false. A changed price inserts `price_snapshots` with origin `owner_entered`.

Approve moves `pending_approval` to `approved`, checks the active-deal rule and `evaluateRepost` again, and stores one current `content_drafts` row (`source` `template`, `body_html` the shared caption). Send back moves `pending_approval` to `draft` and saves `review_note`. Reject moves `pending_approval` or `approved` to `rejected`. Reopen moves `rejected` to `pending_approval` and clears `rejected_reason`. Unapprove moves `approved` to `pending_approval`. Any other transition is `409`. If the creator has withdrawn the deal, the action is `409` with `This deal was withdrawn or changed.`

Editing an approved deal writes a new current content draft so the stored caption matches the fields. Every change writes `audit_log`. The audit details do not include the note or the reason text.

## Publishing

Publishing routes use the same admin session and `Origin` check. The bot token is never returned. `PUBLISHING_ENABLED` defaults to false. When it is true, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL` (`@username`) are required at startup.

| Method | Path                                  | Body / query                                                                  | Success                                                                 |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/api/admin/deals/:id/publish`        | `{ "updatedAt", "override"?, "confirmUnknownPrice"? }`                        | `200` `{ "publication", "deal" }`                                       |
| `POST` | `/api/admin/publications/:id/resolve` | `{ "outcome": "posted" \| "not_posted", "messageId"? }`                       | `200` `{ "publication", "deal" }`                                       |
| `GET`  | `/api/admin/publications`             | `status` (`queued`, `publishing`, `published`, `failed`, `uncertain`), `page` | `200` `{ "items" }` newest first                                        |
| `GET`  | `/api/admin/publishing/status`        | none                                                                          | `200` `{ "enabled", "paused", "dailyLimit", "postedToday", "channel" }` |

`publish` accepts only an `approved` deal that has a current content draft. The caption is that draft. A photo whose caption is 1024 characters or more is refused before Telegram is called. The deal must pass `evaluateRepost`. A missing earlier price is allowed only when both `override` and `confirmUnknownPrice` are true. An equal or higher price is refused. The daily limit counts posts published today in Asia/Kolkata; `override` skips that limit only. `settings.publishing_paused` true refuses the post. One in-flight publication (`queued`, `publishing`, or `uncertain`) per channel and product blocks another attempt. A failed publication can be tried again. Telegram is called only after that row is committed. `ok` marks the publication and the deal `published`. `rate_limited` and `rejected` mark the publication `failed` and leave the deal `approved`. `uncertain` (timeout, 5xx, or an unreadable response) stays `uncertain` and is not retried. Resolving `posted` publishes the deal. Resolving `not_posted` marks the publication `failed` so another attempt is possible. If Telegram accepts the post and the database update then fails, the publication stays `publishing` and the error log includes the message id, never the token.

`POST /api/admin/deals/:id/schedule` takes `{ "updatedAt", "scheduledFor" }`. The time must be in the future and within 7 days. The deal moves to `scheduled` and a `queued` publication stores that time. `POST /api/admin/deals/:id/unschedule` moves it back to `approved` and deletes that queued row. Saving a scheduled deal answers `409` with "Unschedule this deal before editing it."

`POST /api/admin/publishing/pause` and `POST /api/admin/publishing/resume` store `publishing_paused`. `PATCH /api/admin/publishing/settings` takes `{ "dailyLimit", "minGapMinutes" }`. Those replace the env defaults. `GET /api/admin/publishing/status` also returns `nextScheduled`, `queued`, and `uncertain`. The worker posts one due deal at a time. It waits while paused, while the daily limit is used, and until `min_gap_minutes` have passed since the last published post. A deal more than `MAX_LATE_MINUTES` late returns to `approved`, the queue row is removed, and the review note is "Missed its scheduled time (the server was off or paused)". A rate limit waits for `retry_after`. A connection failure before the request is sent waits 1 minute, then 5 minutes. The third attempt is the last. `uncertain` is not retried. A `publishing` row older than 2 minutes becomes `uncertain` with "Server stopped while posting. Check the channel."
