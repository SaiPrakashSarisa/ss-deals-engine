# Database design

Phase 1 stores the clerk review flow in PostgreSQL. Drizzle schema modules live in `apps/server/src/db/schema`. Money is an integer number of paise. Primary keys are `uuid` values from `gen_random_uuid()`, except `settings.key`.

`app_meta` remains the process-metadata table from the foundation migration.

`created_at` and `updated_at` default to `now()` on insert. The function `set_updated_at()` runs from a `BEFORE UPDATE` trigger of the same name on `users`, `deals`, `publications`, and `settings`, and sets `updated_at = now()`. `affiliate_links` and `audit_log` store `created_at` only. `price_snapshots` stores `recorded_at`. `settings` stores `updated_at` only. `products`, `channels`, and `content_drafts` have no timestamp columns.

## Tables

| Table             | Purpose                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`           | Owner and clerk accounts. `password_hash` is empty until auth exists. `can_publish_directly` is stored and unused. `telegram_user_id` is unique when it is set; several users may leave it null. |
| `products`        | One row per retailer listing. `(source, external_id)` is unique. `external_id` is the ASIN or the other retailer's id.                                                                           |
| `affiliate_links` | The original URL, the affiliate URL, and an optional short URL for a product. `verification` records how the affiliate URL was produced.                                                         |
| `price_snapshots` | A price observation in paise. `origin` says who or what recorded it. `deal_id` is optional.                                                                                                      |
| `deals`           | A clerk submission moving through review. Holds the price, optional verified old price, highlights, offer text, notes, score, and an image path.                                                 |
| `content_drafts`  | Versioned post body for a deal. At most one row per deal has `is_current = true`.                                                                                                                |
| `channels`        | A destination. Phase 1 only defines the `telegram` platform.                                                                                                                                     |
| `publications`    | One attempt to put a deal on a channel. `posted_price_paise` is the price shown in the post. It is null for imported history whose price is unknown.                                             |
| `settings`        | JSON values keyed by name.                                                                                                                                                                       |
| `audit_log`       | Append-only actions. `actor_user_id` and `entity_id` are not foreign keys, so a row can describe a missing user or a deleted entity.                                                             |

## Rules the database enforces

**Active deal.** Partial unique index `deals_one_active_per_product` on `deals(product_id)` where `status` is `draft`, `pending_approval`, `approved`, or `scheduled`. A product can have another deal once the earlier one is `published`, `rejected`, or `failed`.

**In-flight post.** `publications` has `UNIQUE(channel_id, deal_id)`, so the same deal cannot be posted twice to the same channel. Partial unique index `publications_one_inflight_per_channel_product` on `(channel_id, product_id)` where `status` is `queued`, `publishing`, or `uncertain`. A `failed` row does not block another attempt. A `published` row does not block a later deal for that product. Whether that later deal is allowed is the repost rule, not this index.

**Prices.** `deals.price_paise` and `price_snapshots.price_paise` must be greater than zero. `old_price_paise` is null or strictly greater than `price_paise`. `old_price_verified` cannot be true when `old_price_paise` is null.

**Offer text.** `offer_text` is null or at most 120 characters.

**Current draft.** Partial unique index `content_drafts_one_current_per_deal`.

**Same product.** `affiliate_links` has `UNIQUE(id, product_id)`. `deals` has `UNIQUE(id, product_id)` and a composite foreign key `(link_id, product_id)` to `affiliate_links(id, product_id)`. `publications` has a composite foreign key `(deal_id, product_id)` to `deals(id, product_id)`. The single-column foreign keys stay. A deal cannot use a link from another product, and a publication cannot name a different product than its deal.

Foreign keys use `ON DELETE NO ACTION`. Inserts that point at a missing parent fail.

## Repost rule

`evaluateRepost` in `apps/server/src/modules/deals/repost.ts` decides whether a product that was already published may be submitted again. The new price must be strictly lower than `posted_price_paise` on the latest published post.

The rule lives in application code. It compares one new price with the latest published row, and a null historical price must fail closed so the owner can override it later. A unique index cannot express "lower than the latest known price" or tell a missing history apart from a real price.

Deal status moves live in `apps/server/src/modules/deals/status.ts` for the same reason: the legal graph is a workflow, and `published` is terminal. The database only stores the status enum.

## Money

Prices are `integer` paise. A rupee is 100 paise. The schema does not use `numeric`, `real`, or `double precision` for money.

## Images

`deals.image_path` and `deals.image_mime` are text. The file itself is stored outside PostgreSQL. Replacing an image replaces the path. The database does not hold bytes.

## Later quick-post import

A later task will load `apps/quickpost`'s `posted.json` into `publications` with `origin = 'quickpost_import'` and `posted_price_paise` null. Those rows do not satisfy the repost rule until an owner sets a price. They are history, not in-flight posts, so the partial unique index does not treat them as a block.
