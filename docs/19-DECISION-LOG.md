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
