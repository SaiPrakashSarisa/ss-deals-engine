# Telegram quick-post bot

`apps/quickpost` is an interim tool. The owner DMs a bot, checks a formatted preview, and confirms. The bot then posts to one Telegram channel. It does not use PostgreSQL, and it does not fetch or scrape Amazon pages.

## Configure

Copy the quick-post variables from `.env.example` into `.env`. `.env` is gitignored. Do not commit the bot token.

| Variable             | Required | Default                                        |
| -------------------- | -------- | ---------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | yes      | none                                           |
| `TELEGRAM_CHANNEL`   | yes      | none (`@name` or a numeric id such as `-100…`) |
| `OWNER_TELEGRAM_ID`  | yes      | none                                           |
| `AMAZON_TAG`         | yes      | none                                           |
| `DAILY_POST_LIMIT`   | no       | `8`                                            |
| `DATA_DIR`           | no       | `./data`                                       |
| `TZ`                 | no       | `Asia/Kolkata`                                 |
| `LOG_LEVEL`          | no       | `info`                                         |
| `NODE_ENV`           | no       | `development`                                  |

The process exits on startup when a required value is missing or invalid. Logs never include the bot token. Find the owner id by DMing `/whoami`. That command answers anyone. Every other message from someone else is ignored.

## Run

From the repo root, after `pnpm install`:

```bash
pnpm --filter @ss-deals/quickpost dev
```

`dev` loads `../../.env` when that file exists and long-polls Telegram. There is no public URL.

Compose starts this bot only with the `quickpost` profile, so a normal `docker compose up` does not need Telegram credentials:

```bash
docker compose --profile quickpost up --build quickpost
```

The container stores `posted.json` in the `quickpost_data` volume. SIGTERM and SIGINT stop polling and flush logs.

Check the package on its own:

```bash
pnpm --filter @ss-deals/quickpost test
pnpm --filter @ss-deals/quickpost typecheck
```

`pnpm lint` at the repo root includes this package.

## Message format

Send one deal per message. `/start` and `/help` show the same rules to the owner.

```text
https://www.amazon.in/dp/B0XXXXXXXXXX
title: Product name
price: 1,499
old: 2,999
verified: yes
- Highlight
- Highlight
```

`title` and `price` are required. `price` is a positive whole number of rupees: `1499`, `1,499`, or `₹1,499`. `old` is optional and must be higher than `price`. `verified` is `yes` or `no` (default `no`). Up to three lines that start with `-` become bullets.

The link must be a full `amazon.in`, `www.amazon.in`, or `m.amazon.in` product URL with `/dp/<ASIN>` or `/gp/product/<ASIN>`. The ASIN is 10 letters or digits. Short links such as `amzn.to` are rejected with: `Please paste the full amazon.in product link`. The posted link is always `https://www.amazon.in/dp/<ASIN>?tag=<AMAZON_TAG>`. Other query parameters, fragments, and any tag already on the pasted URL are dropped.

## Preview and posting

The bot replies with the channel caption in Telegram HTML, plus **Post to channel** and **Cancel**. Nothing is posted until Post is tapped. A preview expires after 30 minutes. Tapping Post twice does not publish twice. Cancel publishes nothing.

The caption is:

- the title in bold, with one leading emoji
- the whole line `₹{price} when posted (may change)` in bold
- when `old` is set and `verified` is `yes`: the old price struck through and the rounded percent lower (`round((old - price) / old * 100)`)
- when `old` is set and `verified` is not `yes`: `Listed at ₹{old}`, with no percentage
- up to three bullets
- two italic disclosure lines: the affiliate-commission sentence, then `As an Amazon Associate I earn from qualifying purchases.`

Amounts use Indian grouping (`1,49,999`). User text is HTML-escaped. The caption must stay under 900 characters. These phrases in the title or highlights produce a warning to the owner: hurry, last chance, loot, lowest ever, limited time. The warning is not part of the channel post.

The channel message uses the same caption, an inline button `🛒 Check deal on Amazon`, and link preview options that point at the tagged URL (`prefer_large_media` and `show_above_text`).

## Limits and the local log

`DATA_DIR/posted.json` stores each attempt: ASIN, timestamp, and `message_id` (or `uncertain`). Writes are atomic.

If that ASIN was logged in the last 14 days, the bot asks for a second confirmation before posting. Uncertain entries count. At the daily limit (calendar day in `TZ`), the bot asks for an override instead of posting.

A Telegram 429 waits for `retry_after` and tries that send once more. If it is still limited, the owner is told and nothing is logged. A timeout or an unknown response is not retried. The owner is told to check the channel, and the ASIN is logged as `uncertain`.

Previews live in memory. Restarting the bot drops them. The post log survives on disk.
