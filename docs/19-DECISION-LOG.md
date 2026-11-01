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

## 2026-11-01 — Integrity follow-ups

### A deal and its link share a product

`UNIQUE(id, product_id)` on `affiliate_links` and `deals` lets a composite foreign key check the pair, which a foreign key on `id` alone cannot. `deals(link_id, product_id)` references `affiliate_links(id, product_id)`. `publications(deal_id, product_id)` references `deals(id, product_id)`. The original single-column foreign keys remain, so each id still has to exist.

### updated_at is maintained by a trigger

`set_updated_at()` runs `BEFORE UPDATE` on `users`, `deals`, `publications`, and `settings`, and assigns `updated_at = now()`. Drizzle Kit does not emit triggers, so that SQL is in migration `0002` with the composite keys. The application does not have to remember the column.
