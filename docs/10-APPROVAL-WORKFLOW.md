# Approval workflow

A person creates a deal, saves it as a draft, and sends it for review. An admin then reviews it at `/admin`. This note covers that path. Publishing to Telegram is still a later task.

## What the person does

The deals home at `/deals` has two buttons: New deal and My deals.

`/deals/new` is the form, in this order: product page URL, title, price, old price, offer, up to three highlights, short link, where it was found, notes, and an optional image. Required fields are the URL, title, and price. The legend is `* required`.

Pasting or leaving the URL field asks `POST /api/deals/check-url`. The banner is one of:

- OK, when the link is a product page and nothing blocks a new draft.
- Editing your deal, when the form is saving changes to that person's own active deal for the product.
- Already in the queue, when a draft, a deal waiting for review, an approved deal, or a scheduled deal already exists for that product and it is not the deal being edited.
- Already posted, when it was published before and the new price is not lower, or the earlier price is unknown.
- Posted before; allowed because the price is lower, with both prices, when the new price is below the last posted price.

Save draft and Send for review stay disabled until the banner is OK, Editing your deal, or the lower-price case. The server repeats those checks and rejects a blocked create or update with 409. Editing a deal that was posted before still has to use a lower price.

Save draft stores status `draft`. Send for review moves that draft to `pending_approval` and records the price. The person then lands on My deals. Save changes stays on the edit form.

`/deals/mine` lists only that person's deals. Badges are Draft, Waiting for review, Approved, Scheduled, Posted, Rejected, Could not post, and Sent back. Sent back is a draft that has a review note. Each card has a Preview button. The preview shows the image, or a placeholder, and the same post text the form builds. It says "Preview - the admin may change it", shows the status, and shows the review note when one is saved. A draft, including one that was sent back, opens at `/deals/[id]/edit` with the saved fields, the current image, and a read-only product link. A deal that is waiting for review asks for confirmation, leaves the queue, and then opens that form. If an admin has already acted, the screen says "This deal was already reviewed." and the list refreshes. Rejected deals stay closed. Opening a deal the person cannot edit shows "You can't edit this deal". `/deals/new?id=` redirects to the edit page.

## What the server stores

The product row uses source `amazon` and the ASIN as `external_id`. The affiliate link is the canonical tagged URL (`tag_appended`, `structure_ok`), plus the short link when one was given. The deal stores prices in paise. The person form leaves `old_price_verified` false. An admin can turn it on from the review page when the old price is higher than the price. Notes from the form are `clerk_notes`. The review note stays empty until an admin sends the deal back.

Sending for review requires the title and product link, sets `submitted_at`, and inserts `price_snapshots` with origin `clerk_entered`. Create, update, submit, withdraw, image upload, and image removal each write an audit row. Withdraw moves `pending_approval` back to `draft`. The audit details do not include the notes text.

An image is optional. It is checked from its bytes, re-encoded, and stored outside the database. Only a signed-in reader of that deal can fetch it.

## What the admin does

`/admin` lists deals waiting for review, oldest first, with counts for Waiting for review, Approved, Sent back, Posted, and Rejected. Other statuses are filters on the same page. Posted deals are read-only.

`/admin/deals/[id]` is the review page. The admin can correct the title, prices, offer, highlights, short link, source note, link-preview flag, and verified old price while the deal is waiting or approved. A scheduled deal has to be unscheduled before those fields can change. Save, image upload, and image removal send `updatedAt`. A stale save says "This deal changed. Reload to see the latest version." The right column shows the caption from the server preview, refreshed after each save, with forbidden-word warnings and the character count out of 900.

Approve stores that caption as the current content draft. Send back asks for a note and returns the deal to the creator, who sees the note on My deals and in the preview. Reject asks for a reason. Reopen puts a rejected deal back in the queue. Unapprove returns an approved deal to the queue. Publish now opens one dialog: confirm, then a spinner, then posted, failed, or not confirmed. Schedule opens a dialog for the next 7 days in India time. A scheduled deal shows the time, a countdown, and why it is waiting, and it cannot be edited until it is unscheduled. The chosen time stays as it was. A gap or a retry waits without changing it. Only a full day moves the time, and the card says it was moved because the daily limit was full. Pause, the daily limit, and the minimum gap can hold that post. A post that is more than the late window behind its time because the server was off or publishing was paused returns to approved with the note "Missed its scheduled time (the server was off or paused)". An admin can start a new draft for a product whose earlier posted price is missing after confirming it was not posted recently. Anyone else still sees that an admin has to check it. When a product was posted or submitted before, the form can copy the earlier title, highlights, short link, source note, preview setting, and image. It does not copy the price, the old price, the offer, or the verified flag.

If the creator withdraws the deal first, the action says "This deal was withdrawn or changed." The server does not fetch the product page. Telegram is called only by the publisher, after the publication row is committed.

## What is left for later

The publishing screen and the quick-post history import are separate steps. This workflow does not fetch a retailer page.
