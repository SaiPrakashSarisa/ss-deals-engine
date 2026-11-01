# Approval workflow

A person creates a deal, saves it as a draft, and sends it for review. An admin reviews it in a later task. This note covers the draft half only. There is no approval screen and no Telegram post yet.

## What the person does

The deals home at `/deals` has two buttons: New deal and My deals.

`/deals/new` is the form, in this order: product page URL, title, price, old price, offer, up to three highlights, short link, where it was found, notes, and an optional image. Required fields are the URL, title, and price. The legend is `* required`.

Pasting or leaving the URL field asks `POST /api/deals/check-url`. The banner is one of:

- OK, when the link is a product page and nothing blocks a new draft.
- Already in the queue, when a draft, a deal waiting for review, an approved deal, or a scheduled deal already exists for that product.
- Already posted, when it was published before and the new price is not lower, or the earlier price is unknown.
- Posted before; allowed because the price is lower, with both prices, when the new price is below the last posted price.

Save draft and Send for review stay disabled until the banner is OK or the lower-price case. The server repeats those checks and rejects a blocked create with 409.

Save draft stores status `draft`. Send for review moves that draft to `pending_approval` and records the price. The person then lands on My deals.

`/deals/mine` lists only that person's deals. Badges are Draft, Waiting for review, Approved, Scheduled, Posted, Rejected, Could not post, and Sent back. Sent back is a draft that has a review note. A draft, including one that was sent back, opens again at `/deals/new?id=` and can be sent again. Rejected deals stay closed.

## What the server stores

The product row uses source `amazon` and the ASIN as `external_id`. The affiliate link is the canonical tagged URL (`tag_appended`, `structure_ok`), plus the short link when one was given. The deal stores prices in paise and leaves `old_price_verified` false. Notes from the form are `clerk_notes`. The review note is empty until an admin writes one later.

Sending for review requires the title and product link, sets `submitted_at`, and inserts `price_snapshots` with origin `clerk_entered`. Create, update, submit, image upload, and image removal each write an audit row. The audit details do not include the notes text.

An image is optional. It is checked from its bytes, re-encoded, and stored outside the database. Only a signed-in reader of that deal can fetch it.

## What is left for later

An admin's review queue will live under `/admin`. That task can approve, reject, or send a deal back with a review note. It can also set `old_price_verified`. Publishing to Telegram is a separate later task. This workflow does not call Telegram or a retailer.
