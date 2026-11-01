# Telegram quick-post bot

`apps/quickpost` is an interim tool. The owner DMs a bot, checks a formatted preview, and confirms. The bot then posts to one Telegram channel. It does not use PostgreSQL, and it does not fetch or scrape Amazon pages.

The amazon.in link toolkit, rupee parsing, Indian grouping, the forbidden-word check, and the caption formatter live in `@ss-deals/core` (`packages/core`). The bot imports that package. Caption rules below are unchanged. `formatPost` still takes whole rupees. `rupeesToPaise` and `paiseToRupees` convert those rupees for storage that uses integer paise. The bot does not call them.

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
| `SHORT_LINK_HOSTS`   | no       | `amzn.to,link.amazon`                          |
| `LINK_STYLE`         | no       | `text` (`text`, `button`, or `both`)           |
| `POST_FOOTER`        | no       | empty (max 120 characters)                     |

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

`pnpm lint`, `pnpm test`, and `pnpm typecheck` at the repo root include this package.

## Message format

Send one deal per message. `/start` and `/help` show the same rules to the owner.

```text
https://www.amazon.in/dp/B0XXXXXXXXXX
title: Product name
price: 1,499
old: 2,999
verified: yes
offer: Bank offer
short: https://amzn.to/example
preview: on
- Highlight
- Highlight
```

`title` and `price` are required. `price` is a positive whole number of rupees: `1499`, `1,499`, or `₹1,499`. `old` is optional and must be higher than `price`. `verified` is `yes` or `no` (default `no`). `offer` is optional text, at most 120 characters. `preview` is `on` or `off` (default `on`). Up to three lines that start with `-` become highlights. `POST_FOOTER` is not a message field. It is the optional italic last line configured in the environment.

The first product URL must be a full `amazon.in`, `www.amazon.in`, or `m.amazon.in` link with `/dp/<ASIN>` or `/gp/product/<ASIN>`. The ASIN is 10 letters or digits. A short link on its own is rejected with: `Please paste the full amazon.in product link`. That first product URL still becomes `https://www.amazon.in/dp/<ASIN>?tag=<AMAZON_TAG>`. Other query parameters, fragments, and any tag already on the pasted URL are dropped. Field lines, including `short:`, are not used as the product URL.

`short:` is optional. It must be an `https` URL whose host is in `SHORT_LINK_HOSTS` (a comma-separated list). The default hosts are `amzn.to` and `link.amazon`. Any other host is rejected. The bot does not request the short link. When it is accepted, the channel shows that URL instead of the tagged product URL. The owner's preview adds this line, which is not posted to the channel: `Short link not verified by the bot - make sure it came from your Associates account.`

A photo message uses the same fields in its caption. The bot keeps Telegram's `file_id` (the largest size on the message) and sends that id again. It does not download or re-upload the image, and it does not fetch Amazon pages.

## Preview and posting

The bot replies with the channel caption in Telegram HTML, plus **Post to channel** and **Cancel**. A photo preview is the same caption on that photo. Nothing is posted until Post is tapped. A preview expires after 30 minutes. Tapping Post twice does not publish twice. Cancel publishes nothing. Photo posts follow the same confirm-once, expiry, duplicate, daily-limit, and uncertain-send rules as text posts.

The caption is Telegram HTML, with blank lines between the sections below:

- `🔥 <b>{title}</b>`
- `🎁 <b>Deal Price : ₹{price}</b>`. When `old` is set and `verified` is `yes`, the same line continues with two spaces and `<s>₹{old}</s>`, and the next line is `🟢 <b>{percent}% off</b>`. The percent is `round((old - price) / old * 100)`. When `old` is set and `verified` is not `yes`, the next line is `Listed at ₹{old}`, with no strikethrough and no percentage.
- `💳 Offer: {offer}` when `offer` is set, on the next line of that price block
- up to three highlight lines, each starting with `✨ `
- `🛒 Buy Here : {link}` when `LINK_STYLE` is `text` or `both`. `{link}` is the short URL when `short:` was accepted, otherwise the tagged product URL. The URL is visible text. It is not an `<a>` label.
- `<i>{POST_FOOTER}</i>` when `POST_FOOTER` is not empty, after one blank line. An empty footer adds nothing. The footer is HTML-escaped. The caption does not use a blockquote.

Amounts use Indian grouping (`1,49,999`). User text, including the offer and the visible URL, is HTML-escaped. The caption must stay under 900 characters, and that count includes the tags. These phrases in the title or highlights produce a warning to the owner: hurry, last chance, loot, lowest ever, limited time. The warning is not part of the channel post.

`LINK_STYLE` chooses the link control. `text` is the Buy Here line and no URL button. `button` is an inline button `🛒 Check deal on Amazon` and no Buy Here line. `both` sends both. The button URL is the same URL as `{link}`.

For a text post, `preview: on` (the default) sets link preview options to that URL with `prefer_large_media` and `show_above_text`. `preview: off` sends `is_disabled: true`. Photo posts do not send link-preview options; the photo is the media.

## Limits and the local log

`DATA_DIR/posted.json` stores each attempt: ASIN, timestamp, `message_id` (or `uncertain`), `mode` (`text` or `photo`), and `link` (`tagged` or `short`). Entries written before those last two fields still load. Writes are atomic.

If that ASIN was logged in the last 14 days, the bot asks for a second confirmation before posting. Uncertain entries count. At the daily limit (calendar day in `TZ`), the bot asks for an override instead of posting.

A Telegram 429 waits for `retry_after` and tries that send once more. If it is still limited, the owner is told and nothing is logged. A timeout or an unknown response is not retried. The owner is told to check the channel, and the ASIN is logged as `uncertain`.

Previews live in memory. Restarting the bot drops them. The post log survives on disk.
