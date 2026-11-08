# Decision log

## 2026-10-31 — Foundation

### PostgreSQL over MongoDB

Deal records have to be unique. PostgreSQL unique constraints and transactions enforce that in the database, including under concurrent writers. MongoDB would leave the same rules to application code.

### pg-boss over Redis and BullMQ

Background jobs will use pg-boss in a later task. The queue lives in PostgreSQL, so the platform does not gain a second datastore. Redis and BullMQ stay out.

### Modular monolith with separate API and worker processes

One TypeScript codebase runs as two processes. The API serves HTTP. The worker runs background work. They share PostgreSQL and can be restarted independently. Splitting into networked services is not justified at this size.

### Drizzle for migrations

Drizzle ORM and drizzle-kit own the SQL migrations. The first migration creates only `app_meta` (`key`, `value`) for process metadata. Business tables are intentionally absent.

### No scraping of retail sites

Product and price data will come from official affiliate APIs and feeds. The platform will not scrape Amazon, Flipkart, or other retail sites.

## 2026-10-31 — Quick-post bot

### Standalone owner bot instead of the posting API

The quick-post tool is an interim way for the owner to publish a deal to Telegram. It lives in `apps/quickpost` and does not read or write PostgreSQL. A later task can replace it with the real posting pipeline.

### Long polling instead of a webhook

The bot uses grammY long polling. It does not need a public URL.

### Affiliate links are rebuilt from the ASIN

The bot accepts an amazon.in product URL, keeps the ASIN, and rebuilds `https://www.amazon.in/dp/<ASIN>?tag=<AMAZON_TAG>`. It drops every other query parameter. It does not fetch the product page.

## 2026-11-01 — Phase 1 data model

### Money is integer paise

Deal prices and price snapshots are `integer` paise. Floating point is not used for money. One rupee is 100 paise.

### Active deals and in-flight posts are partial unique indexes

A product may have at most one deal in `draft`, `pending_approval`, `approved`, or `scheduled`. A channel may have at most one `queued`, `publishing`, or `uncertain` publication per product. `UNIQUE(channel_id, deal_id)` stops the same deal being posted twice to one channel. A published publication does not block a later deal; that comparison is not a constraint.

### The repost rule lives in application code

A new deal for a product that was already published is allowed only when the new price is strictly below the price shown on the latest published post. If that posted price is null, the repost is refused until an owner overrides it. The check needs the latest row and a fail-closed branch for unknown history, which a unique index cannot express. `evaluateRepost` owns it. Status transitions stay in `canTransition` for the same reason: the database stores the enum, and the workflow graph stays in code.

### Images are paths

`deals.image_path` and `deals.image_mime` point at a file outside PostgreSQL. The database does not store image bytes.

### Direct publish is a flag only

`users.can_publish_directly` defaults to false and has no behaviour yet.

### Quick-post history will be imported later

`apps/quickpost` still does not use this database. A later task will copy `posted.json` into `publications` with `origin = 'quickpost_import'` and `posted_price_paise` null.

### Schema layout

Business tables are Drizzle modules under `apps/server/src/db/schema`. `drizzle.config.ts` reads that folder's `index.ts`. `src/lib/schema.ts` re-exports it so the existing database client stays on the same import. `app_meta` is unchanged. `audit_log.actor_user_id` is not a foreign key, so an audit row can outlive the user it names.

## 2026-11-01 — Shared core package

### Pure deal helpers live in @ss-deals/core

Amazon URL handling, rupee parsing, Indian grouping, forbidden-word checks, and the Telegram HTML caption formatter are pure functions. The quick-post bot and the later web app both need them, so they live in `packages/core` (`@ss-deals/core`). That package has no Telegram client, I/O, environment access, network, or database. The bot imports it. The formatter still takes whole rupees. `rupeesToPaise` and `paiseToRupees` convert whole rupees and whole paise, because the database stores integer paise and one rupee is 100 paise. The quick-post image builds this package so production Node can load the compiled ESM.

## 2026-11-01 — Integrity follow-ups

### A deal and its link share a product

`UNIQUE(id, product_id)` on `affiliate_links` and `deals` lets a composite foreign key check the pair, which a foreign key on `id` alone cannot. `deals(link_id, product_id)` references `affiliate_links(id, product_id)`. `publications(deal_id, product_id)` references `deals(id, product_id)`. The original single-column foreign keys remain, so each id still has to exist.

### updated_at is maintained by a trigger

`set_updated_at()` runs `BEFORE UPDATE` on `users`, `deals`, `publications`, and `settings`, and assigns `updated_at = now()`. Drizzle Kit does not emit triggers, so that SQL is in migration `0002` with the composite keys. The application does not have to remember the column.

## 2026-11-01 — Web sign-in

### Two roles, one cookie session

The desk has an owner and a clerk. Passwords use Node's built-in scrypt. Sessions live in Postgres. The cookie carries a random token and the database stores only its SHA-256 hash. Idle time is 12 hours and the session cannot last more than 7 days. The web app is a separate Next.js process on port 3001 and proxies auth calls so the browser has one origin and cannot read the `HttpOnly` cookie.

### The owner can open the clerk pages

`requireRole` on the API is exact: an owner token does not pass a clerk-only guard. The web pages are different. `/admin` is limited to the admin role and returns 403 for anyone else. Deal pages are open to both people. The nav hides Review queue from anyone who is not an admin.

### People are shown by name

`users.display_name` is an optional name of at most 60 characters. The profile returns it, and falls back to the username. The screen says Admin for that role and shows no role word for anyone else. `/owner` and `/clerk` redirect to `/admin` and `/deals`. Changing a password from the Account page checks the current password, requires a different password of at least 12 characters, and revokes every other session.

### Test guard routes stay out of production

`GET /api/auth/test/*` is registered only when `NODE_ENV` is not `production`, so the role guards can be exercised without shipping them in the production process.

## 2026-11-01 — Deal drafts

### The product title stays on the product

A draft also writes `products.title` when it creates or updates the Amazon product. That column is the latest known title. Deal screens do not read it.

### Each deal keeps its own title

`deals.title` is required and 1 to 200 characters. Creating or editing a draft writes that column. A later deal for the same ASIN does not change an earlier deal's title. The migration backfills existing rows from `products.title`, and uses `Untitled` only when that title is missing.

### The form never fetches Amazon

`POST /api/deals/check-url` and draft creation use `parseAmazonProductUrl` from `@ss-deals/core`. The server does not request the pasted URL or any Amazon page. The tagged link is built with `AMAZON_TAG`.

### Clerk prices are not verified

`old_price_verified` is always false on create and update from this form. The post preview therefore shows an old price as "Listed at". An admin can change the flag in a later task.

### Each person lists only their own deals

`GET /api/deals` is the caller's list, including for an admin. An admin can still `GET /api/deals/:id` and the image for any deal. A person who cannot read a deal gets 404. Only the creator can edit a draft.

### Images stay behind the session

Uploads are JPEG, PNG, or WebP, detected from magic bytes, re-encoded with `sharp` to at most 1600px, and stored under `UPLOAD_DIR`. They are returned only by `GET /api/deals/:id/image`. They are not public files. Replacing an image deletes the previous file.

### Draft and upload limits

Each person can create 30 drafts and upload 30 images per hour. Field errors are returned per field. An active deal for the same product, or a repost that is not a lower price, is rejected before a new draft is stored. A missing previous posted price is refused until an admin looks at it.

## 2026-11-01 — Preview, edit, and withdraw

### Editing a deal is not a second deal in the queue

`POST /api/deals/check-url` accepts the deal being edited. When that deal is the signed-in person's active deal for the product, the check ignores it and returns `editing`. The form says "Editing your deal" and does not say the product is already in the queue. Another person's active deal is still a conflict. The lower-price rule for a product that was posted before still applies to the edited price, on the check and again on update and submit.

### Leaving the review queue is a status move

The creator can withdraw a deal from `pending_approval` back to `draft`. The move goes through the status module. Any other status is `409`. The action is `deal.withdraw`. The screen asks for confirmation first. If an admin has already changed the deal, the request is `409` and the list refreshes.

### The preview uses the same post as the form

My deals opens a modal with `formatPost` from `@ss-deals/core`, the stored fields, and the same options the form preview uses (`verified` false, text link). The image is the signed-in `GET /api/deals/:id/image`. The modal traps focus, closes on Escape and the backdrop, locks page scroll, and returns focus to the button that opened it.

### The edit page is the same form

`/deals/[id]/edit` renders the deal form in edit mode. The product link is read-only. Save changes stays on the page. A deal the person cannot edit, including someone else's deal, shows "You can't edit this deal". The screen does not use role words. Clickable controls use a pointer cursor, and disabled controls use a not-allowed cursor.

## 2026-11-05 — Admin review API (T6a)

### Admin-only review endpoints

The admin review API lives in `apps/server/src/modules/review`. All endpoints require a signed-in session with role `owner`; non-admins receive `403` with `You do not have access to this.` and unauthenticated requests receive `401`.

### Status counts and queue ordering

`GET /api/admin/deals` returns a `counts` map for all statuses alongside the paginated `items` for the requested filter (defaulting to `pending_approval`). The queue is ordered FIFO for `pending_approval` (oldest submitted deals first) so reviewers handle items in arrival order. Other tabs (draft, approved, rejected, published, failed, scheduled) are ordered newest first. Page size is capped at 50.

### Shared post preview and duplicate inspection on detail

`GET /api/admin/deals/:id` returns all deal fields in rupees, product ASIN, tagged and short links, image info, and creator visible name (falling back to username). It embeds:

- `preview`: generated via `buildDealPreview`, which calls `formatPost` with the deal form's text link. The percent-off line is included only when the old price is verified.
- `duplicate`: evaluates whether another active deal exists for the same product, and evaluates repost legality via `evaluateRepost` against the latest published post price.
  No password hashes, sessions, or private user fields are returned.

## 2026-11-07 — Admin review decisions

### Edits keep the same limits and a fresh timestamp

An admin can change a deal only while it is waiting for review or approved. The request must send the `updatedAt` from the detail. The row is locked, the timestamp is compared in the application, and a mismatch is `409` with "This deal changed. Reload to see the latest version." Clearing the old price forces `old_price_verified` false. A new price writes `price_snapshots` with origin `owner_entered`.

### Decisions go through the status map

Approve, send back, reject, reopen, and unapprove call `assertTransition`. Unapprove is the added move from `approved` back to `pending_approval`. Approve re-checks the active-deal rule and `evaluateRepost`, then stores the shared caption as the only current content draft. A later edit of an approved deal writes the next version. A withdrawn deal answers `409` with "This deal was withdrawn or changed." Publish and schedule are not in this step.

## 2026-11-08 — Sent back is a draft with a note

`GET /api/admin/deals?status=sent_back` lists deals whose status is `draft` and whose `review_note` is set. `counts.sent_back` uses that same rule. A draft that was never submitted, and a draft the creator withdrew before review, stay out of that count and out of the admin list. Sending the deal for review again moves it to `pending_approval`, so it leaves the count even if the note is still stored.

## 2026-11-08 — Image addresses and review exits

Deal image URLs include the deal's `updatedAt` so a browser cannot keep a replaced file under the same address. `GET /api/deals/:id/image` sends `Cache-Control: private, no-cache`. After a successful send back or reject, the review page goes to `/admin` with a one-time notice (`Sent back to <name>.` or `Rejected.`) that the queue shows and then removes from the address. Approve, reopen, and unapprove stay on the deal and keep the `updatedAt` from the response.
